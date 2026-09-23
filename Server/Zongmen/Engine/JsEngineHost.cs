using System.Text;
using Microsoft.ClearScript.V8;

namespace Zongmen.Engine;

/* ============================================================
 * 虚引擎层 — ClearScript V8 沙箱
 *   每个 seed 世界一个独立 V8 实例 (确定性世界状态/缓存互不干扰),
 *   LRU 淘汰; 实例内加载「原封不动」的 noise.js + mapgen.js 与
 *   适配层 mapgen-server.js (window = globalThis 注入)。
 * ============================================================ */

public sealed class JsWorldVm : IDisposable
{
    private readonly V8ScriptEngine _engine;
    private readonly SemaphoreSlim _gate = new(1, 1);
    /* P7: MapGenServer dynamic 句柄每 VM 只取一次缓存, 免每次 Call 重新
       访问 _engine.Script 属性 (高频 chunk/tile 调用的 DLR 属性解析开销) */
    private readonly dynamic _svc;
    /* C1: 在途引用计数 — 宿主淘汰前先看它, 正在执行 JS 的 V8 引擎绝不会被 Dispose
       (Dispose 一个正在跑 Call 的 V8ScriptEngine 会直接崩进程)。
       宿主侧借出 (Enter) 时 +1, 用完 (Exit) 时 -1; 计数 >0 的 VM 不参与 LRU 淘汰。 */
    private int _inFlight;
    private int _disposed;
    public string Seed { get; }
    public long LastUsed { get; private set; }

    /// <summary>C1: 当前借出未归还的次数 (0 = 可安全淘汰)。</summary>
    public int InFlight => Volatile.Read(ref _inFlight);
    public void Enter() => Interlocked.Increment(ref _inFlight);
    public void Exit() => Interlocked.Decrement(ref _inFlight);

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref _disposed) != 0)
            throw new ObjectDisposedException(nameof(JsWorldVm), $"V8 实例已被淘汰 (seed={Seed})");
    }

    public JsWorldVm(string seed, string bundle)
    {
        Seed = seed;
        _engine = new V8ScriptEngine();
        _engine.Evaluate(bundle);
        _svc = _engine.Script.MapGenServer;
        Call("init", seed);       // MapGen.init(seed)
        Touch();
    }

    public void Touch() => LastUsed = DateTime.UtcNow.Ticks;

    /// <summary>T4: 当前 VM 的道路版本号 (roadCache 每新增道路 +1)。
    /// 供 tile 缓存做新鲜度校验 — 只有真有新路落成才需要失效旧 onRoad 结果。</summary>
    public long RoadVersion()
    {
        ThrowIfDisposed();
        Touch();
        _gate.Wait();
        try
        {
            ThrowIfDisposed();      // C1: 排队期间可能已被淘汰
            return Convert.ToInt64((double)_svc.roadVersion());
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>线程安全: 串行执行 JS 函数并返回其 JSON 字符串结果。</summary>
    public string Call(string fn, params object[] args)
    {
        ThrowIfDisposed();
        Touch();
        _gate.Wait();
        try
        {
            ThrowIfDisposed();      // C1: 排队期间可能已被淘汰
            return fn switch
            {
                "init" => (string)_svc.init(args[0]),
                "chunkJson" => (string)_svc.chunkJson(args[0], args[1]),
                "regionJson" => (string)_svc.regionJson(args[0], args[1]),
                "settleJson" => (string)_svc.settleJson(args[0], args[1]),
                "commJson" => (string)_svc.commJson(args[0], args[1]),
                "blockLayersJson" => (string)_svc.blockLayersJson(args[0], args[1]),
                "tileJson" => (string)_svc.tileJson(args[0], args[1]),
                "fieldGridJson" => (string)_svc.fieldGridJson(args[0], args[1], args[2], args[3]),
                "metaJson" => (string)_svc.metaJson(),
                /* ---- 玩家宗门放置 (2026-09-23 方案 §2.4) ----
                   ⚠ 每个 JS 出口都必须在这里有 case: 漏了就是运行期
                   `InvalidOperationException: 未知 JS 函数` (编译期不报)。 */
                "placeCheckJson" => (string)_svc.placeCheckJson(args[0], args[1], args[2]),
                "commitPlace" => (string)_svc.commitPlace(args[0], args[1], args[2]),
                "setExternalSettlements" => (string)_svc.setExternalSettlements(args[0]),
                "externalSettlementsJson" => (string)_svc.externalSettlementsJson(),
                "removeExternalSettlement" => (string)_svc.removeExternalSettlement(args[0]),
                "domainCheckJson" => (string)_svc.domainCheckJson(args[0], args[1], args[2]),
                "_countVeins" => (string)_svc._countVeins(),
                _ => throw new InvalidOperationException($"未知 JS 函数: {fn}")
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;   // C1: 幂等
        _engine.Dispose();
    }
}

public sealed class JsEngineHost : IDisposable
{
    private readonly object _lock = new();
    private readonly Dictionary<string, JsWorldVm> _vms = new();
    private readonly int _maxSeeds;
    private readonly string _bundle;
    /* C1: VM 被 LRU 淘汰时的回调 (宿主据此清掉「按 seed 前缀」派生的状态,
       例如 tile 缓存的 roadVer 观测值) —— 否则新 VM 的 roadVer 从 0 重新计数,
       旧观测值会让 tile 缓存命中判断失真。 */
    private readonly Action<string>? _onEvicted;
    /* P (2026-09-23, 玩家放置): VM **新建完成**时的回调 —— 宿主在这里把本世的
       玩家宗门记录重放回引擎 ext 层 (VM 被 LRU 淘汰后重建是常态, 漏了这一步
       「玩家的宗门在服务端重启/换世/淘汰后就消失」)。回调在 VM 入表**之前**于
       锁外执行 ⇒ 里面可以安全地 vm.Call(...) (此时没人能看见这个 VM)。 */
    private readonly Action<JsWorldVm>? _onCreated;

    public JsEngineHost(string jsDir, int maxSeeds, Action<string>? onEvicted = null,
                        Action<JsWorldVm>? onCreated = null)
    {
        /* C1: MaxSeeds 配 0/负数时, 原实现 while (Count > MaxSeeds) 会把刚建好的
           实例立刻淘汰 → 每次请求都「建了又杀」, 100% 拿到已 Dispose 的实例。 */
        _maxSeeds = Math.Max(1, maxSeeds);
        _onEvicted = onEvicted;
        _onCreated = onCreated;
        var sb = new StringBuilder();
        sb.AppendLine("'use strict';");
        sb.AppendLine("var window = globalThis; var global = window; var self = window;");
        foreach (var f in new[] { "noise.js", "mapgen-config.js", "mapgen.js", "mapgen-server.js" })
        {
            var p = Path.Combine(jsDir, f);
            if (!File.Exists(p)) throw new FileNotFoundException($"缺少世界脚本: {p}");
            sb.AppendLine($"/* ==== {f} ==== */");
            sb.AppendLine(File.ReadAllText(p, Encoding.UTF8));
        }
        _bundle = sb.ToString();
    }

    /// <summary>C1: 一次「借出」。用 using 包住整个使用期 (含 VM.Call/多条调用),
    /// 期间该 VM 不会被 LRU 淘汰 Dispose; 出口处归还计数。必须置 in-flight
    /// 计数器对 — 漏归还只会让缓存容量短暂超标, 不会崩。</summary>
    public readonly struct VmLease : IDisposable
    {
        public JsWorldVm Vm { get; }
        internal VmLease(JsWorldVm vm) { Vm = vm; }
        public void Dispose() => Vm.Exit();
    }

    /// <summary>C1: 借出世界 VM (与 using 配套)。</summary>
    public VmLease Lease(string seed) => new(GetOrCreate(seed));

    public JsWorldVm GetOrCreate(string seed)
    {
        // 注意: 不可截断 seed 再作 key —— 此前 [..80] 会让「前 80 字符相同」的不同种子
        // 命中同一 VM, 而 DB 持久化键(WorldKeys.SeedPrefix)是对完整 seed 做 SHA1,
        // 两端口径不一致 → LRU 命中错世界, 破坏离线确定性。key 与 init(seed) 均用完整字符串。
        lock (_lock)
        {
            if (_vms.TryGetValue(seed, out var vm)) { vm.Touch(); vm.Enter(); return vm; }
        }

        /* 冷启 (new V8ScriptEngine + Evaluate(bundle) + init) 可能耗时数百 ms —
           放到锁外构建, 否则会阻塞其它 seed 的取用 (含已存在的 VM)。
           double-check: 并发同 seed 可能各建一个, 以「先入表者胜」收敛, 多余实例释放。 */
        var created = new JsWorldVm(seed, _bundle);
        created.Enter();                     // C1: 借出计数在入表前就置位
        /* P: 重放本世的玩家宗门 (ext 层)。放在入表**之前** = 锁外执行, 且此刻
           还没有别的线程能拿到这个 VM ⇒ 不必与并发请求抢 V8 门闩。
           回调抛异常 ⇒ 直接向上抛 (宁可这一次请求失败, 也不要一个「丢了玩家资产」
           的世界悄悄服役)。 */
        _onCreated?.Invoke(created);
        lock (_lock)
        {
            if (_vms.TryGetValue(seed, out var existing))
            {
                created.Exit(); created.Dispose();
                existing.Touch(); existing.Enter();
                return existing;
            }
            _vms[seed] = created;
            EvictLocked();
            return created;
        }
    }

    private void EvictLocked()
    {
        while (_vms.Count > _maxSeeds)
        {
            /* T12: MaxSeeds 很小, 直接线性扫最旧 (O(n)) — 原OrderBy整体排序 (O(n·logn)) 无必要。
               C1: 在途 (InFlight > 0) 的实例跳过 —— 正在执行 JS 的引擎被 Dispose 会崩;
                   若当前全部在途则本轮不淘汰 (容量短暂超标, 下次取用时再收)。 */
            string? oldestKey = null;
            long oldest = long.MaxValue;
            foreach (var kv in _vms)
            {
                if (kv.Value.InFlight > 0) continue;
                if (kv.Value.LastUsed < oldest)
                {
                    oldest = kv.Value.LastUsed;
                    oldestKey = kv.Key;
                }
            }
            if (oldestKey == null) break;
            _vms.Remove(oldestKey, out var victim);
            _onEvicted?.Invoke(oldestKey);
            victim?.Dispose();
        }
    }

    public int LiveSeeds => _vms.Count;

    /// <summary>当前常驻(活跃)VM 的 seed 列表快照, 供 SQLite 清理按 seed 前缀过滤。</summary>
    public List<string> Seeds
    {
        get
        {
            lock (_lock)
            {
                return new List<string>(_vms.Keys);
            }
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var vm in _vms.Values) vm.Dispose();
            _vms.Clear();
        }
    }
}
