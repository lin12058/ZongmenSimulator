using Microsoft.ClearScript.V8;

namespace Zongmen.Engine;

/* ============================================================
 * 子系统 V8 虚拟机池 (2026-10-11 目录重构)
 * ------------------------------------------------------------
 * 由旧 JsEngineHost 泛化而来: 原实现池的键是 seed (一个 seed 一个 VM, 全部子系统
 * 挤在同一 global 里); 现在键是 **(Scope, seed)**, 每个子系统一个独立 V8 实例。
 *
 * ⚠ 一个进程只服务一个 seed —— 但键里仍然带 seed: 换世/多世回归时无需改代码,
 *   且 VM 被淘汰重建后不会被上一世的观测值污染 (见 _onEvicted 的用途)。
 * ============================================================ */

/// <summary>
/// 一个 V8 实例 = 一个模块 + 一个 seed。
/// ⚠ V8 是单线程的: 所有 <see cref="Call"/> 全程持 <c>_gate</c> 串行 ——
/// 并行度只来自「多个 Scope 的多个池成员」, 不来自多线程。
/// </summary>
public sealed class JsVm : IDisposable
{
    private readonly V8ScriptEngine _engine;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly JsvmModule _module;
    /* P7: 导出根与整个 global 各取一次缓存 —— 免每次 Call 重新访问
       _engine.Script 属性 (高频 chunk/tile 调用的 DLR 属性解析开销)。 */
    private readonly dynamic _script;
    private readonly dynamic _root;

    /* C1: 在途引用计数 —— 宿主淘汰前先看它, 正在执行 JS 的 V8 引擎绝不会被 Dispose
       (Dispose 一个正在跑 Call 的 V8ScriptEngine 会直接崩进程)。
       宿主侧借出 (Enter) 时 +1, 用完 (Exit) 时 -1; 计数 >0 的 VM 不参与 LRU 淘汰。 */
    private int _inFlight;
    private int _disposed;

    public string Scope => _module.Scope;
    public string Seed { get; }
    public JsvmModule Module => _module;
    public long LastUsed { get; private set; }

    /// <summary>C1: 当前借出未归还的次数 (0 = 可安全淘汰)。</summary>
    public int InFlight => Volatile.Read(ref _inFlight);
    public void Enter() => Interlocked.Increment(ref _inFlight);
    public void Exit() => Interlocked.Decrement(ref _inFlight);

    private void ThrowIfDisposed()
    {
        if (Volatile.Read(ref _disposed) != 0)
            throw new ObjectDisposedException(nameof(JsVm), $"V8 实例已被淘汰 (scope={Scope}, seed={Seed})");
    }

    public JsVm(JsvmModule module, string bundle, string seed)
    {
        _module = module;
        Seed = seed;
        _engine = new V8ScriptEngine();
        _engine.Evaluate(bundle);
        dynamic s = _engine.Script;
        /* ⚠ 导出根必须存在 —— 脚本清单漏了/排错序时这里就该炸, 而不是等到某个
           出口被调用时报一个看不懂的「未知 JS 函数」。 */
        object? root = s[module.RootMember];
        if (root is null)
            throw new InvalidOperationException(
                $"模块 {module.Scope} 未导出 global.{module.RootMember} (脚本清单或加载序有误)");
        _script = s;
        _root = root;
        module.OnVmReady(_script, seed);
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
            return _module.RoadVersion(_script);
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
            return _module.Invoke(_script, _root, fn, args);
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

/// <summary>
/// (Scope, seed) → <see cref="JsVm"/> 的池。每个 Scope 一个独立 V8 实例。
/// </summary>
public sealed class JsVmPool : IDisposable
{
    private readonly object _lock = new();
    private readonly Dictionary<string, JsVm> _vms = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsvmModule> _modules = new(StringComparer.Ordinal);
    private readonly int _maxVms;
    /* C1: VM 被 LRU 淘汰时的回调 (宿主据此清掉「按 seed 前缀」派生的状态,
       例如 tile 缓存的 roadVer 观测值) —— 否则新 VM 的 roadVer 从 0 重新计数,
       旧观测值会让 tile 缓存命中判断失真。 */
    private readonly Action<string>? _onEvicted;
    /* P (2026-09-23, 玩家放置): VM **新建完成**时的回调 —— 宿主在这里把本世的
       玩家宗门记录重放回引擎 ext 层 (VM 被 LRU 淘汰后重建是常态, 漏了这一步
       「玩家的宗门在服务端重启/换世/淘汰后就消失」)。回调在 VM 入表**之前**于
       锁外执行 ⇒ 里面可以安全地 vm.Call(...) (此时没人能看见这个 VM)。
       ⚠ ext 层必须对**所有 Scope** 统一注入 (两个 VM 各持一份) —— 只注入世界层
         会让城市层算出的骨架产出与渲染层不一致 (静默漂移)。 */
    private readonly Action<JsVm, JsvmModule>? _onCreated;

    public JsVmPool(IEnumerable<JsvmModule> modules, int maxVms,
                    Action<string>? onEvicted = null,
                    Action<JsVm, JsvmModule>? onCreated = null)
    {
        foreach (var m in modules) _modules[m.Scope] = m;
        /* C1: MaxVms 配 0/负数时, 原实现 while (Count > Max) 会把刚建好的实例立刻淘汰
           → 每次请求都「建了又杀」, 100% 拿到已 Dispose 的实例。 */
        _maxVms = Math.Max(_modules.Count, maxVms);
        _onEvicted = onEvicted;
        _onCreated = onCreated;
    }

    /// <summary>C1: 一次「借出」。用 using 包住整个使用期 (含 VM.Call/多条调用),
    /// 期间该 VM 不会被 LRU 淘汰 Dispose; 出口处归还计数。必须置 in-flight
    /// 计数器对 — 漏归还只会让缓存容量短暂超标, 不会崩。</summary>
    public readonly struct VmLease : IDisposable
    {
        public JsVm Vm { get; }
        internal VmLease(JsVm vm) { Vm = vm; }
        public void Dispose() => Vm.Exit();
    }

    /// <summary>借出某 Scope 的 VM (与 using 配套)。</summary>
    public VmLease Lease(string scope, string seed) => new(GetOrCreate(scope, seed));

    public JsVm GetOrCreate(string scope, string seed)
    {
        if (!_modules.TryGetValue(scope, out var module))
            throw new InvalidOperationException($"未注册的子系统 VM scope: {scope} (忘了加 JsvmModule?)");
        var key = Key(scope, seed);

        /* 注意: 不可截断 seed 再作 key —— DB 持久化键(WorldKeys.SeedPrefix)是对完整
           seed 做 SHA1, 两端口径不一致 → LRU 命中错世界, 破坏离线确定性。 */
        lock (_lock)
        {
            if (_vms.TryGetValue(key, out var vm)) { vm.Touch(); vm.Enter(); return vm; }
        }

        /* 冷启 (new V8ScriptEngine + Evaluate(bundle) + init) 可能耗时数百 ms —
           放到锁外构建, 否则会阻塞其它 Scope/seed 的取用 (含已存在的 VM)。
           double-check: 并发同 key 可能各建一个, 以「先入表者胜」收敛, 多余实例释放。 */
        var created = new JsVm(module, module.BuildBundle(), seed);
        created.Enter();                     // C1: 借出计数在入表前就置位
        /* P: 重放本世的玩家宗门 (ext 层)。放在入表**之前** = 锁外执行, 且此刻
           还没有别的线程能拿到这个 VM ⇒ 不必与并发请求抢 V8 门闩。
           回调抛异常 ⇒ 直接向上抛 (宁可这一次请求失败, 也不要一个「丢了玩家资产」
           的世界悄悄服役)。⚠ 但抛之前必须把已构造好的 V8 释放掉 —— V8ScriptEngine 持
           非托管内存且没有可靠终结器, 漏掉这一步 = 每次冷启失败泄漏一个完整 V8
           (且 `_inFlight` 永久停在 1, 永不参与 LRU 淘汰)。 */
        try
        {
            _onCreated?.Invoke(created, module);
        }
        catch
        {
            created.Exit();
            created.Dispose();
            throw;
        }
        lock (_lock)
        {
            if (_vms.TryGetValue(key, out var existing))
            {
                created.Exit(); created.Dispose();
                existing.Touch(); existing.Enter();
                return existing;
            }
            _vms[key] = created;
            EvictLocked();
            return created;
        }
    }

    private void EvictLocked()
    {
        while (_vms.Count > _maxVms)
        {
            /* T12: MaxVms 很小, 直接线性扫最旧 (O(n)) — 原 OrderBy 整体排序无必要。
               C1: 在途 (InFlight > 0) 的实例跳过 —— 正在执行 JS 的引擎被 Dispose 会崩;
                   若当前全部在途则本轮不淘汰 (容量短暂超标, 下次取用时再收)。 */
            string? oldestKey = null;
            long oldest = long.MaxValue;
            foreach (var kv in _vms)
            {
                if (kv.Value.InFlight > 0) continue;
                if (kv.Value.LastUsed < oldest) { oldest = kv.Value.LastUsed; oldestKey = kv.Key; }
            }
            if (oldestKey == null) break;
            _vms.Remove(oldestKey, out var victim);
            /* 淘汰回调按 **seed** 触发 (roadVer 观测值是按 seed 前缀存的, 与 scope 无关);
               同一 seed 的几个 scope 会各触发一次 —— 幂等的 TryRemove, 无害。 */
            _onEvicted?.Invoke(victim?.Seed ?? "");
            victim?.Dispose();
        }
    }

    private static string Key(string scope, string seed) => scope + "|" + seed;

    /// <summary>当前常驻 VM 数 (= scope 数 × 常驻 seed 数)。</summary>
    public int Count => _vms.Count;
    /// <summary>池容量 = MaxSeeds × Scope 数 (供 /api/map/stats 判定 liveSeeds 是否越界)。
    /// ⚠ liveSeeds 是**跨 Scope 的活跃 VM 总数**, 不能拿它跟 MaxSeeds(=种子数) 直接比。</summary>
    public int Capacity => _maxVms;

    /// <summary>当前常驻 VM 的 seed 列表快照 (去重), 供 SQLite 清理按 seed 前缀过滤。</summary>
    public List<string> Seeds
    {
        get
        {
            lock (_lock)
            {
                var seen = new HashSet<string>(StringComparer.Ordinal);
                var list = new List<string>();
                foreach (var vm in _vms.Values) if (seen.Add(vm.Seed)) list.Add(vm.Seed);
                return list;
            }
        }
    }

    /// <summary>已注册的 Scope 列表 (诊断/自检用)。</summary>
    public List<string> Scopes
    {
        get
        {
            lock (_lock) return new List<string>(_modules.Keys);
        }
    }

    /// <summary>
    /// 对该 seed 下**已存在**的所有 Scope VM 各执行一次注入 (不新建)。
    /// 用途: ext(玩家宗门) 层变化时把新清单推给每个独立 V8 —— 世界层 VM 的 ext 由引擎
    /// `commitPlace` 内部自更新, 但子系统 VM 不会 (它们是独立实例), 漏了就会静默漂移。
    /// ⚠ 快照后逐个调用: 期间某 VM 可能被 LRU 淘汰 ⇒ 注入方要自己吞 ObjectDisposedException
    ///   (无可厚非: 重建时 onCreated 会重新注入)。
    /// </summary>
    public void ForEachExisting(string seed, Action<JsVm> action)
    {
        List<JsVm> snapshot;
        lock (_lock) snapshot = _vms.Values.Where(v => string.Equals(v.Seed, seed, StringComparison.Ordinal)).ToList();
        foreach (var vm in snapshot)
        {
            /* 借出一次 (Enter/Exit) 以免注入途中被淘汰 Dispose —— 与 Call 的门闩配套。 */
            vm.Enter();
            try { action(vm); }
            finally { vm.Exit(); }
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
