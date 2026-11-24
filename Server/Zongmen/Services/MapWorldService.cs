using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using Zongmen.Domain;
using Zongmen.Engine;
using Zongmen.Protocol;
using Zongmen.Storage;
using Zongmen.Subsystems;

namespace Zongmen.Services;

/* ============================================================
 * 地图世界服务 — 「服务端权威」编排层
 *   JS 权威计算(引擎门锁) → JSON → protobuf → gzip
 *   → 内存/ SQLite 两级缓存 → 下发
 *   Chunk / Region / Community 持久化; Tile / 字段网格 即时计算。
 *
 * R9: chunk/region/comm 的 per-key in-flight 去重 — 并发同 key miss 只
 *     build 一次, 其余等待者 double-check 命中后直接返回。
 * T2: 区域包不再落 SQLite (历史上只写不读, 纯写放大); 会话内由
 *     _regionHot (专用大容量 LRU) + _mem 兜底, 冷回访免 A* 全量重算。
 * T4: tile 缓存新鲜度改用 VM roadVersion (roadCache 每新增道路 +1) —
 *     取代旧的「seed 全局 epoch」: 只有真有新路落成才失效旧 tile 缓存,
 *     连点小地图/流式加载不再反复整片重算。
 * T3: SQLite 整理 (Flush + PruneExcept) 移入后台定时任务, 不再依赖
 *     /stats 第 N 次请求偶发触发。
 * T11: tile/grid/region 热缓存统一 LruCache (命中即提序, 单条淘汰)。
 * W1 (rev/mask 一致性): GetTileBlock 的 mask 由调用方解析(0→All)+鉴权裁剪后传入;
 *     resp.Mask 即「客户端可视为持有」的图层位 — 客户端只更新 mask 命中位的 rev,
 *     杜绝「非全量 mask 请求后把未收到图层的 rev 记为已持有」的永久缺层。
 * W2: blockLayersJson 结果与 chunk/comm 解压产物按 key 加 LRU; tile 命中比对
 *     service 层 roadVer 免抢 V8 门闩; PruneExcept 仅在确有世界被淘汰时执行。
 * ============================================================ */

public sealed class MapWorldService : IDisposable
{
    private readonly ZongmenOptions _opt;
    private readonly JsVmPool _host;
    /* ★ 子系统注册表 (2026-10-11): Core 通过它回调子系统 (换世清空 / 渲染叠加),
       **不引用任何具体子系统类型** —— 加第二个子系统时这里一个字都不用改。 */
    private readonly SubsystemRegistry _subsystems;
    private readonly MemoryVirtualContext _mem;
    private readonly SqliteVirtualContext? _sql;
    /* W (2026-09-16): 世界种子台账 —— 种子的唯一来源。前端不再自造 seed
       (旧口径 `Date.now()%1e8` 刷新即换界), 只向服务端 "领当前世 / 换下一世"。 */
    private readonly WorldLedger _ledger;
    /* P (2026-09-23, 玩家宗门放置): 玩家宗门台账 —— 独立表 PlayerSect (见其头注释:
       塞进 Data(Key,Value) 会被后台 PruneExcept 静默删掉)。 */
    private readonly PlayerSectStore _sects;
    private string? _metaCache;
    private readonly object _metaLock = new();
    /* S4: 引擎指纹 —— 对**下发给前端的那三个脚本**按拼接顺序取 SHA256 前 16 位。
       用途: 客户端按 seed 自算地形块, 若页面长开期间服务端升级了引擎, 前端旧引擎算的
       地形与后端新引擎下发的 settle/region 坐标口径会漂移 (极端表现「建筑落海」)。
       前端把 meta 里这个值与「加载时记下的」比对即可静默回退服务端下发。
       ⚠ 不含 mapgen-server.js (它是服务端适配层, 浏览器侧拿不到, 不该参与比对)。 */
    private readonly string? _engineHash;

    /* tile/fieldGrid/region 热缓存 (不落 SQLite, 仅进程内) */
    private const int TileCacheCap = 1024;
    private const int GridCacheCap = 64;
    private const int RegionHotCap = 512;
    private const int RawCacheCap = 2048;      // chunk/comm 解压后 protobuf (免每块重复 GzUnwrap)
    private const int BlockLayersCap = 1024;   // blockLayersJson 结果 (块归属映射, 内容确定)
    private const int PackCacheCap = 512;      // C4: 解压+反序列化后的 region/settle 包
    private readonly LruCache<TileEntry> _tileCache = new(TileCacheCap);
    private readonly LruCache<string> _gridCache = new(GridCacheCap);
    private readonly LruCache<byte[]> _regionHot = new(RegionHotCap);
    private readonly LruCache<byte[]> _rawCache = new(RawCacheCap);
    private readonly LruCache<(int, int)[][]> _blockLayersCache = new(BlockLayersCap);
    /* C4: 每块请求都要按区域解 region/settle 包 (gzip→protobuf→对象), 同一区域在
       邻块/多次请求中反复出现 → 反序列化结果按 world key 加 LRU, 免重复解。
       包对象只读 (response 组装只搬运引用, 序列化后即丢) ⇒ 可安全共享。 */
    private readonly LruCache<RegionPack> _regionPackCache = new(PackCacheCap);
    private readonly LruCache<SettlePack> _settlePackCache = new(PackCacheCap);
    /* 地图人物分布 (2026-10-11 方案 v2): 每块 { 每格人数, 战力总和 }。
       ⚠ **只进进程内 LRU, 绝不落 SQLite/_mem** —— 它是 (seed, 区块) 的纯派生,
         不是「世界内容」; 一旦落库, 淘汰后 ReadSqlBackfill 会把旧包捞回来。 */
    private readonly LruCache<PeopleData> _peopleCache = new(1024);

    /// <summary>tile 缓存条目: 值 + 生成时的 VM 道路版本号 (T4) + 服务端落点世代 (P)。</summary>
    private sealed record TileEntry(byte[] Gz, long RoadVer, int PlaceVer);

    /* P (2026-09-23, 玩家宗门放置) —— 服务端「落点世代」。
       病根: tileJson 的结果同时依赖 ① 聚落集合 (place 字段) ② roadCache (onRoad),
       而 roadVer 只在**新增道路**时前进。于是「落点只让旧路消失、没让新路出现」
       (roadFail 翻转 / 被 RNG 支配裁掉) 或「四周本来就有路」时 roadVer 不动
       ⇒ 旧 tile 缓存被误判新鲜 ⇒ 点开那格看到的还是「无宗门」。
       用一个独立单调计数器把 tile 缓存与**任何一次落点**绑定 (比扫 1024 条 key 便宜)。 */
    private int _placeVer;

    /// <summary>service 层最近观测到的 roadVer (按 seed 前缀)。
    /// roadVer 只在区域包生成(内含 A*)时前进, 故 tile 缓存命中时比对这里即可免抢 V8 门闩。
    /// C2: 读→写整段加 _roadVerLock, 且单调取大 —— 并发下「旧采样值覆盖新值」会让
    /// tile 缓存误判新鲜。roadVer 在单个 VM 内只前进; VM 被 LRU 淘汰时由回调清掉本前缀
    /// (新 VM 从 0 重新计数), 故取大不会跨实例留下虚假高版本。</summary>
    private readonly ConcurrentDictionary<string, long> _roadVerCache = new();
    private readonly object _roadVerLock = new();

    /// <summary>本会话出现过的 seed 前缀 (World() 时登记) — 维护任务据此判定
    /// 「是否有已淘汰世界留下无主行」。必须在「取用/建立」时登记, 否则某个世界
    /// 若在同一维护周期内建立又被淘汰, 其前缀将不被记住 → 残留行永不清理。</summary>
    private readonly ConcurrentDictionary<string, byte> _seenSeedPrefixes = new();

    /* R9: per-key in-flight 去重门闩 (key → lock 对象); 构建完成即移除,
        移除后新 miss 会再查缓存命中, 不会重复 build */
    private readonly ConcurrentDictionary<string, object> _buildGates = new();

    /* T3: 后台维护任务 (周期 Flush + 按 seed 前缀整理 SQLite) */
    private readonly CancellationTokenSource _maintCts = new();
    private readonly Task _maintTask;

    /* T4 (2026-09-27): 世界时钟与 Tick 演化框架的挂点。
       ⚠ 用**延迟绑定**而不是构造注入: MapWorldService 在 TickPump 之前构造 (DI 顺序),
         直接构造注入会形成循环依赖 (TickPump 将来要读世界状态)。
         而 TickPump 绑定世界只需两个东西: seed 与 round —— 都来自 _ledger。
       ⚠ 未绑定时泵只空转 (不会崩), 所以即使这里一直没挂上也只是「时间不走」。 */
    private Time.TickPump? _tickPump;

    /* P2: 「应该有哪些 job」的短时缓存 (见 ProvideExpectedJobs 的注释) */
    private readonly object _expectedGate = new();
    private IReadOnlyList<(string EntityId, Time.TickJobKind Kind)>? _expectedCache;
    private long _expectedAtMs;

    /// <summary>挂上时钟泵 (Program.cs 在 DI 装配完成后调用)。挂上即**立即绑定当前世**。</summary>
    public void AttachTickPump(Time.TickPump pump)
    {
        _tickPump = pump;
        /* ★ P2 依赖倒置: 泵不知道「本世有哪些城」, 由本类提供。
           ⚠ 只在挂载时注册一次; provider 内部自有缓存与节流。 */
        pump.ExpectedJobsProvider = ProvideExpectedJobs;
        BindCurrentWorldToTick();
    }

    /// <summary>P2: 城市演化台账 => 已迁到 <see cref="Subsystems.City.CitySubsystem.Store"/>。
    /// ⚠ Core 不再持有它: 「本子系统状态由本子系统自己管」是这次目录重构的核心约束
    ///   (原先 Core 直接 new 出 CityStateStore ⇒ Core 编译期就认识 City)。</summary>

    /// <summary>P2: 提供「本世应该有哪些 job」= 演化窗口内每座聚落 × {TownEvolve, TradeEdge}。
    /// ⚠ 这是**对账**的输入 ⇒ 必须是全集: 少给一类, 那一类的全部 job 会被判定为「不该有」
    ///   而被 Remove (静默停止演化)。故这里枚举**两个** kind, 不做任何「按需省略」。
    /// ⚠ 结果做短时缓存 (默认 60s): 对账每 360 tick 才跑一次, 但枚举会扫窗口内全部区域格;
    ///   缓存对**对账**安全 (只增删 job 集合, 不重置其 NextTick/Phase), 城变多时也稳。</summary>
    private IReadOnlyList<(string EntityId, Time.TickJobKind Kind)> ProvideExpectedJobs(string seed, int round, long tick)
    {
        var now = Environment.TickCount64;
        lock (_expectedGate)
        {
            if (_expectedCache != null && now - _expectedAtMs < 60_000) return _expectedCache;
        }
        var list = new List<(string, Time.TickJobKind)>();
        try
        {
            var span = Math.Max(1, _opt.Tick.EvolveSpanRegions);
            using var lease = World(seed);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = -span; i <= span; i++)
            {
                for (var j = -span; j <= span; j++)
                {
                    string json;
                    /* ⚠ 必须用 citySettlementsJson (带 type) 而不是 settleJson (不带 type):
                       这里靠 type 过滤 poi, 用 settleJson 会因 type=="" 而不过滤 ⇒
                       给秘境也排演化 job (白跑, 且秘境没有足迹/资源 ⇒ 逻辑上无意义)。 */
                    try { json = lease.Vm.Call("citySettlementsJson", i, j); }
                    catch { continue; }
                    using var d = JsonDocument.Parse(json);
                    if (!d.RootElement.TryGetProperty("settlements", out var towns) ||
                        towns.ValueKind != JsonValueKind.Array) continue;
                    foreach (var t in towns.EnumerateArray())
                    {
                        var id = t.TryGetProperty("id", out var idv) ? idv.GetString() ?? "" : "";
                        if (id.Length == 0 || !seen.Add(id)) continue;
                        var type = t.TryGetProperty("type", out var tyv) && tyv.ValueKind == JsonValueKind.String
                            ? tyv.GetString() ?? "" : "";
                        if (type == "poi") continue;      // 秘境不演化 (v2 Q3)
                        list.Add((id, Time.TickJobKind.TownEvolve));
                        list.Add((id, Time.TickJobKind.TradeEdge));
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[tick] ExpectedJobs 枚举失败: {ex.GetType().Name}: {ex.Message}");
            return _expectedCache ?? Array.Empty<(string, Time.TickJobKind)>();
        }
        lock (_expectedGate) { _expectedCache = list; _expectedAtMs = Environment.TickCount64; }
        return list;
    }

    /// <summary>
    /// 把**当前世**绑定到时钟泵 (启动 / 换世后都要调)。
    /// ⚠ 拿不到当前世 ⇒ 什么都不做 (不造一个假世界)。时钟是服务端资产, 与种子同级。
    /// </summary>
    public void BindCurrentWorldToTick()
    {
        var pump = _tickPump;
        if (pump is null) return;
        try
        {
            var cur = _ledger.Current();
            /* ★ 换世清空各子系统的世态 (依赖倒置: Core 不认识 City, 由注册表遍历)。
               ⚠ 清的是「上一世」的状态 —— 与新世的实体 id 可能同名
                 (城 id 是 `{区域i}_{区域j}_u{n}`, 跨世会重复!) ⇒ 不清就是**跨世串味**:
                 新世第 0 天的一座城带着上一世演化了几十年的人口继续跑。
               ⚠ 各子系统必须实现「只删该轮次」而不是全清 —— 万一将来支持
                 同时保留多世 (回看/回滚), 全清会误删别的世。 */
            var removed = _subsystems.ClearWorld(cur.Round);
            if (removed > 0)
                Console.WriteLine($"[tick] 换世清空子系统世态: 第 {cur.Round} 世 {removed} 行 (避免跨世串味)");
            lock (_expectedGate) { _expectedCache = null; _expectedAtMs = 0; }
            pump.BindWorld(cur.Seed, cur.Round);
        }
        catch (Exception ex)
        {
            /* ⚠ 不让时钟绑定失败拖垮 HTTP 装配 —— 但必须**留下痕迹**,
               否则「时间不走」会变成一个无声的谜。 */
            Console.Error.WriteLine($"[tick] 绑定当前世失败: {ex.GetType().Name}: {ex.Message}");
        }
    }

    public MapWorldService(ZongmenOptions opt, string contentRoot, SubsystemRegistry subsystems)
    {
        _opt = opt;
        _subsystems = subsystems;
        var jsDir = ZongmenPaths.ResolveEngineJsDir(opt, contentRoot);
        var cityJsDir = ZongmenPaths.ResolveCityJsDir(opt, contentRoot);
        _engineHash = ComputeEngineHash(jsDir);
        _mem = new MemoryVirtualContext();
        if (opt.PersistEnabled)
            _sql = new SqliteVirtualContext(ZongmenPaths.ResolveDbPath(opt, contentRoot));
        /* 台账与地图缓存**同库不同表**: 同库 ⇒ 一次备份/清理覆盖全部世界资产;
           不同表 ⇒ 后台 PruneExcept(只清 Data 表的非活跃 seed 前缀) 够不着它 (见 WorldLedger 头注释)。
           持久化关闭时传 null ⇒ 台账退回仅内存 (世界仍是服务端产生, 只是重启即归零)。 */
        _ledger = new WorldLedger(opt.PersistEnabled ? ZongmenPaths.ResolveDbPath(opt, contentRoot) : null);
        /* P: 玩家宗门台账 —— 同样必须独立成表 (理由见 PlayerSectStore 头注释)。
           ⚠ 必须在 _host 之前构造: _host 的 onCreated 回调会读它 (虽然回调到运行时才触发,
             但先建好更不容易出错)。 */
        _sects = new PlayerSectStore(
            opt.PersistEnabled ? ZongmenPaths.ResolveDbPath(opt, contentRoot) : null,
            opt.PlayerSectMaxPerAccount,
            opt.PlayerTownMaxPerSect);
        /* ★ P2 城市演化台账**不在这里**了 —— 它归 Subsystems/City 所有 (见 CitySubsystem)。
           本类只在换世时经注册表回调 ClearWorld, 在渲染时回调 OverlayJson。 */
        /* C1: 传淘汰回调 —— VM 被 LRU 淘汰时清掉「按 seed 前缀」的 roadVer 观测值,
           否则新 VM 的 roadVer 从 0 重新计数会与旧观测值冲突 (tile 缓存判新鲜失准)。
           P: 再传**新建回调** —— VM 重建后必须把本世的玩家宗门重放回引擎 ext 层,
           否则「服务端重启 / 换世 / VM 被 LRU 淘汰」之后玩家的宗门就消失了。 */
        /* ★ VM 池: 世界层 + 各子系统各一个**独立 V8 实例** (Scope 为键)。
           ⚠ 容量 = MaxSeeds × Scope 数 —— 一个 seed 要占 N 个 VM, 按 MaxSeeds 配
             会把同一 seed 的其它 Scope 立刻淘汰 (「建了又杀」, 100% 拿到已 Dispose 的实例)。 */
        var worldModule = new WorldModule(jsDir, cityJsDir);
        var modules = new List<JsvmModule> { worldModule };
        modules.AddRange(_subsystems.Modules);
        _host = new JsVmPool(modules, Math.Max(1, opt.MaxSeeds) * modules.Count,
            seed => { _roadVerCache.TryRemove(WorldKeys.SeedPrefix(seed), out _); },
            (vm, _) => InjectPlayerSects(vm, vm.Seed));
        _maintTask = Task.Run(MaintenanceLoopAsync);
    }

    /// <summary>P: 把本世的玩家宗门记录重放进引擎 ext 层 (VM 新建时调用一次)。
    /// ⚠ 每个 **Scope** 各有一份 ext (世界层 / 城市层是两个独立 V8) ⇒ 本回调会被
    ///   每个 Scope 各调一次 —— 这正是我们要的 (两份必须一致)。
    /// ⚠ 失败必须**抛** —— 宁可这一次请求失败, 也不要一个"丢了玩家资产"的世界悄悄服役。 </summary>
    private void InjectPlayerSects(JsVm vm, string seed)
    {
        /* ⚠ 只有载了 mapgen-server.js 的世界/城市 VM 才有 setExternalSettlements。
           纯数据子系统 (如 characters) 没有该出口 ⇒ 若在此无条件调用, 建 VM 即抛
           「未知 JS 函数」⇒ 该子系统所有请求失败 (且只在首次建 VM 时暴露, 极易漏测)。 */
        if (!vm.Module.AcceptsExternalSettlements) return;
        var e = _ledger.Find(seed);
        var json = e == null ? "[]" : _sects.JsonArrayForRound(e.Round);
        var r = vm.Call("setExternalSettlements", json);
        if (e != null && e.Round > 0)
        {
            using var d = JsonDocument.Parse(r);
            Console.WriteLine($"[MapWorldService] 世界 {seed} (第 {e.Round} 世) 重放玩家宗门 " +
                              d.RootElement.GetProperty("n").GetInt32() + $" 座 [{vm.Scope}]");
        }
    }

    /// <summary>★ ext (玩家宗门) 变了 ⇒ 把新清单推给**所有已存在的 Scope VM**。
    /// 病根: 世界层 VM 的 ext 由引擎 commitPlace 在内部自更新, 但**子系统 VM 不会**
    ///   (它们是独立实例) —— 漏了这一步, City VM 的骨架产出 (growTownFootprint) 与
    ///   渲染层看到的骨架会漂移, 表现为「演化算出的足迹与画出来的不一样」(不报错)。
    /// ⚠ 不新建 VM: 尚未创建的 Scope 会在创建时经 onCreated 拿到最新 ext。</summary>
    private void ReinjectExternalSettlements(string seed)
    {
        var e = _ledger.Find(seed);
        var json = e == null ? "[]" : _sects.JsonArrayForRound(e.Round);
        _host.ForEachExisting(seed, vm =>
        {
            try { vm.Call("setExternalSettlements", json); }
            catch (Exception ex)
            {
                /* 期间被淘汰 ⇒ ObjectDisposedException, 无害 (重建时会重新注入)。留痕不静默。 */
                Console.Error.WriteLine($"[subsys] ext 重注入失败 [{vm.Scope}]: {ex.GetType().Name}: {ex.Message}");
            }
        });
    }

    /// <summary>C2: 观测到 roadVer 后写入 (单调取大, 不覆盖更新的值)。</summary>
    private void ObserveRoadVer(string prefix, long ver)
    {
        lock (_roadVerLock)
        {
            if (_roadVerCache.TryGetValue(prefix, out var cur) && cur >= ver) return;
            _roadVerCache[prefix] = ver;
        }
    }

    /// <summary>C1: 借出世界 VM (借出期内在途计数 >0, LRU 不会 Dispose 它)。
    /// ⚠ 调用方必须用 using 包住整个使用期, 否则容量会短暂超标。</summary>
    private JsVmPool.VmLease World(string seed)
    {
        _seenSeedPrefixes.TryAdd(WorldKeys.SeedPrefix(seed), 0);   // P3: 登记已用过的世界
        return _host.Lease(WorldModule.WorldScope, seed);
    }

    /* ---------------- P2: 城市演化执行器 (TickVmPoolExecutor) 的公开接入面 ----------------
       执行器**不是**本类的成员 (它在 Time/ 下), 但世界 VM 的所有权在这里 ⇒ 它必须经本类
       借出 VM。这里只开**最小**的三件事, 不给执行器任何绕过缓存纪律的通道:
         ① LeaseWorld    —— 借用 VM (与 using 配套; 期间 LRU 不淘汰);
         ② CurrentSeed/Round —— 当前世的身份 (执行器据此决定往哪张账上写);
         ③ MarkLayersDirty —— 演化改动了某块的内容后**必须**通知 (见下 ⚠)。
       ⚠ 为什么不能只靠 BumpBlockRev: 世界内容有三条路径送出去 —— chunk(区块)/region(区域)/
         settle(聚落) —— 演化改的是 settle 层。少了这一步, 客户端带旧 lastRevs 重拉会被
         判「未变化」⇒ **永久陈旧** (不报错, 只是画面上人口永远不变)。 */

    /// <summary>当前世的 seed (无当前世时返回 null)。</summary>
    public string? CurrentSeed()
    {
        try { return _ledger.Count() == 0 ? null : _ledger.Current().Seed; }
        catch { return null; }
    }

    /// <summary>当前世的轮次 (无当前世时返回 0)。</summary>
    public int CurrentRound()
    {
        try { return _ledger.Count() == 0 ? 0 : _ledger.Current().Round; }
        catch { return 0; }
    }

    /// <summary>借出某 Scope 的 VM。**世界层之外的调用者一律走这里** ——
    /// 子系统执行器要的就是「自己那一个独立 V8」, 而不是世界层那把被人类请求占着的门闩。
    /// ⚠ 与 <see cref="World"/> 同样登记 seed 前缀 (PruneExcept 按它判定活跃世界)。</summary>
    public JsVmPool.VmLease LeaseScope(string scope, string seed)
    {
        _seenSeedPrefixes.TryAdd(WorldKeys.SeedPrefix(seed), 0);
        return _host.Lease(scope, seed);
    }

    /// <summary>借出世界层 VM (供 TickPump 侧 / 判据宿主用; 新代码优先用 LeaseScope)。</summary>
    public JsVmPool.VmLease LeaseWorld(string seed) => World(seed);

    /// <summary>读某区域格的聚落列表 (演化器遍历世界用)。
    /// ⚠ 只在**世界层** VM 上可用 (citySettlementsJson 归 WorldModule)。</summary>
    public string SettlementsForJson(JsVm vm, int i, int j)
        => vm.Call("settleJson", i, j);

    /// <summary>演化改动了某区域格的聚落层 ⇒ 作废该区域的**落库** settle/region 包 + 推进脏块 rev。
    /// ⚠ 只用 BumpBlockRev 是**不够**的 (与 ApplyPlaceChange 同理): settle 包是落库的,
    ///   不清 _mem/SQLite 会在缓存淘汰后经 ReadSqlBackfill 把**旧人口**的包捞回来,
    ///   画面上表现为「演化一会儿又跳回原值」。故这里复用同一套 EvictWithGate + Bump。
    /// ⚠ 必须由**调用方**保证在 tick 泵线程外调用时的线程安全 (EvictWithGate 自带 per-key 门闩)。</summary>
    public void MarkSettleDirty(string seed, int i, int j)
    {
        EvictWithGate(seed, i, j);
        BumpBlockRev(seed, i, j, TileMask.Settle | TileMask.Poi);
        /* ★ 图层5（人物分布）的**第二处**钩子：它以 (seed, 区块) 缓存在进程内 _peopleCache 里，
           而它的输入（聚落人口）**会随 tick 演化** ⇒ 光作废落库包是不够的，进程内 LRU 也必须清，
           否则热力图永远显示旧人数（BumpBlockRev 只解决「客户端带旧 rev 重拉」，服务端 Get
           仍会命中旧 LRU 包）。区块格与区域格不是一一对应（无 O(1) 逆映射）⇒ 无法按键精确失效，
           这里整清（容量仅 1024，且只有用户开热力图时才有热度，重建按需懒发生）。 */
        _peopleCache.Clear();
    }

    /* ---------------- 区块 ---------------- */
    public byte[] GetChunkBytes(string seed, int ca, int cb)
    {
        var key = WorldKeys.Chunk(seed, ca, cb);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);      // T8: 库命中回填 _mem
        if (hit != null) return hit;

        /* R9: 同 key 并发 miss 合并 — 只 build 一次 */
        return BuildOnce(key, () =>
        {
            using var lease = World(seed);
            var gz = BuildChunk(lease.Vm, ca, cb);
            Store(key, gz);
            return gz;
        });
    }

    private byte[] BuildChunk(JsVm vm, int ca, int cb)
    {
        var json = vm.Call("chunkJson", ca, cb);
        using var d = JsonDocument.Parse(json);
        var root = d.RootElement;
        var count = root.GetProperty("count").GetInt32();
        var pn = root.GetProperty("pn").GetInt32();
        var p = new ChunkPayload
        {
            Ca = root.GetProperty("ca").GetInt32(),
            Cb = root.GetProperty("cb").GetInt32(),
            Count = count,
            Pn = pn,
        };
        /* P5: 单段定宽缓冲解包。JS 布局 (全小端):
             地块段 n×11B = [cq u8][cr u8][tiles u8][elev u16][hash u16][neigh u32]
             精灵段 pn×13B = [pdx f32][pdy f32][psp u8][ph u16][pe u16] */
        const int tileBytes = 11;   // 地块段每格字节数 (精灵段长度由 pn 与 raw 总长校验)
        var raw = B64(root, "d");
        int o = 0;
        p.Cq = Slice(raw, o, count); o += count;
        p.Cr = Slice(raw, o, count); o += count;
        p.Tiles = Slice(raw, o, count); o += count;
        p.Elev = Slice(raw, o, count * 2); o += count * 2;
        p.Hash = Slice(raw, o, count * 2); o += count * 2;
        p.Neigh = Slice(raw, o, count * 4); o += count * 4;
        if (o != count * tileBytes) throw new InvalidDataException("chunk 地块段长度不符");
        p.Pdx = Slice(raw, o, pn * 4); o += pn * 4;
        p.Pdy = Slice(raw, o, pn * 4); o += pn * 4;
        p.Psp = Slice(raw, o, pn); o += pn;
        p.Ph = Slice(raw, o, pn * 2); o += pn * 2;
        p.Pe = Slice(raw, o, pn * 2); o += pn * 2;
        if (o != raw.Length) throw new InvalidDataException("chunk 缓冲长度不符");
        var proto = ProtoCodec.SerToByte(p);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 区域包 ---------------- */
    public byte[] GetRegionBytes(string seed, int i, int j)
    {
        var key = WorldKeys.Region(seed, i, j);
        /* 区域包含 A* 道路且 tileJson 的 onRoad 依赖 VM roadCache 热状态:
           若直接命中 SQLite 旧行, VM 不执行生成 → 道路缓存与画面/详情不一致。
           故区域包总是经 JS 生成(确定性, 与历史字节一致)。
           T2: 会话内由 _regionHot (大容量专用 LRU) + _mem 兜底; 不再落 SQLite —
           区域行历史上只写不读, 落库纯写放大 (冷回访本来就须重跑 A* 保证语义)。 */
        var hit = _regionHot.Get(key) ?? _mem.GetDataBytes(key);
        if (hit != null) return hit;

        var gz = BuildOnce(key, () =>
        {
            using var lease = World(seed);
            var g = BuildRegion(lease.Vm, i, j);
            _regionHot.Set(key, g);
            _mem.SetData(key, g);
            return g;
        });
        /* 区域包含 A*(roadsNear) → 可能使 roadCache 前进; 刷新 service 层 roadVer,
           使后续 tile 缓存命中无需再进 V8 门闩 (T4 语义不变: 版本变则旧 tile 失效)。 */
        using (var lease = World(seed)) ObserveRoadVer(WorldKeys.SeedPrefix(seed), lease.Vm.RoadVersion());
        return gz;
    }

    private byte[] BuildRegion(JsVm vm, int i, int j)
    {
        var json = vm.Call("regionJson", i, j);
        using var d = JsonDocument.Parse(json);
        var r = d.RootElement;
        var pack = new RegionPack
        {
            I = i, J = j,
            Region = new RegionInfoDto
            {
                Q = r.GetProperty("region").GetProperty("q").GetInt32(),
                R = r.GetProperty("region").GetProperty("r").GetInt32(),
                X = F(r.GetProperty("region"), "x"),
                Y = F(r.GetProperty("region"), "y"),
                Biome = r.GetProperty("region").GetProperty("biome").GetInt32(),
                Name = r.GetProperty("region").GetProperty("name").GetString() ?? "",
            },
        };
        foreach (var s in r.GetProperty("settlements").EnumerateArray())
        {
            pack.Settlements.Add(new SettlementDto
            {
                Id = s.GetProperty("id").GetString() ?? "",
                Type = s.GetProperty("type").GetString() ?? "",
                Q = s.GetProperty("q").GetInt32(),
                R = s.GetProperty("r").GetInt32(),
                X = F(s, "x"),
                Y = F(s, "y"),
                Name = s.GetProperty("name").GetString() ?? "",
                Pop = s.GetProperty("pop").GetInt32(),
                /* WebSocket 单块接口 (设计 §3.4): 实体骨架字段 */
                Owner = s.TryGetProperty("owner", out var ow) && ow.ValueKind == JsonValueKind.String
                    ? ow.GetString() ?? "" : "",
                Tier = s.TryGetProperty("tier", out var tr) ? tr.GetInt32() : 0,
                State = s.TryGetProperty("state", out var stt) ? stt.GetInt32() : 0,
                ExpireTs = s.TryGetProperty("expireTs", out var ex) ? ex.GetInt64() : 0,
                /* B5/D15: 区域包已不再携带城镇足迹 (mapgen-server.settlementJson 只发骨架)。
                   这里保留 TryGetProperty 读取仅为兼容旧持久化区域包 (_mem/SQLite 里可能仍有);
                   新包读出即空 —— 真正的足迹由 GetTileBlock 的 needSettle 分支用 settle 包
                   覆盖 (settle 包是唯一权威, 落库且可演化), 故区域包携带足迹纯属冗余。 */
                Style = s.TryGetProperty("style", out var sy) && sy.ValueKind == JsonValueKind.String
                    ? sy.GetString() ?? "" : "",
                StyleName = s.TryGetProperty("styleName", out var sn) && sn.ValueKind == JsonValueKind.String
                    ? sn.GetString() ?? "" : "",
                Buildings = ReadBuildings(s, "buildings"),
                Resources = ReadResources(s, "resources"),
            });
        }
        foreach (var rd in r.GetProperty("roads").EnumerateArray())
        {
            var ptsJson = rd.GetProperty("pts");
            var ptsBytes = new byte[ptsJson.GetArrayLength() * 4];
            var k = 0;
            foreach (var pt in ptsJson.EnumerateArray())
            {
                var b = BitConverter.GetBytes(pt.GetSingle());
                ptsBytes[k++] = b[0]; ptsBytes[k++] = b[1];
                ptsBytes[k++] = b[2]; ptsBytes[k++] = b[3];
            }
            pack.Roads.Add(new RoadDto
            {
                Key = rd.GetProperty("key").GetString() ?? "",
                X0 = F(rd, "x0"), Y0 = F(rd, "y0"),
                X1 = F(rd, "x1"), Y1 = F(rd, "y1"),
                Pts = ptsBytes,
            });
        }
        var proto = ProtoCodec.SerToByte(pack);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 群落包 ---------------- */
    public byte[] GetCommBytes(string seed, int ci, int cj)
    {
        var key = WorldKeys.Comm(seed, ci, cj);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);      // T8: 库命中回填 _mem
        if (hit != null) return hit;

        return BuildOnce(key, () =>
        {
            using var lease = World(seed);
            var gz = BuildComm(lease.Vm, ci, cj);
            Store(key, gz);
            return gz;
        });
    }

    private byte[] BuildComm(JsVm vm, int ci, int cj)
    {
        var json = vm.Call("commJson", ci, cj);
        using var d = JsonDocument.Parse(json);
        var r = d.RootElement;
        var pack = new CommunityPack
        {
            Ci = ci, Cj = cj,
            Exists = r.GetProperty("exists").GetBoolean(),
        };
        if (pack.Exists)
        {
            pack.Q = r.GetProperty("q").GetInt32();
            pack.R = r.GetProperty("r").GetInt32();
            pack.X = F(r, "x");
            pack.Y = F(r, "y");
            pack.Element = r.GetProperty("element").GetInt32();
            pack.Spirit = F(r, "spirit");
            foreach (var v in r.GetProperty("veins").EnumerateArray())
            {
                pack.Veins.Add(new VeinDto
                {
                    Name = v.GetProperty("name").GetString() ?? "",
                    Element = v.GetProperty("element").GetInt32(),
                    Variant = v.TryGetProperty("variant", out var va) && va.ValueKind == JsonValueKind.String
                        ? va.GetString() ?? "" : "",
                    Level = v.GetProperty("level").GetInt32(),
                    Q = v.GetProperty("q").GetInt32(),
                    R = v.GetProperty("r").GetInt32(),
                    X = F(v, "x"),
                    Y = F(v, "y"),
                });
            }
        }
        var proto = ProtoCodec.SerToByte(pack);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 城镇足迹包 (Phase3: 建筑足迹会演化 → 独立持久化) ---------------- */
    /// <summary>取城镇足迹包字节 (gzip(protobuf))。落 SQLite 并支持冷回读 (T8 回填 _mem),
    /// 与 chunk/comm 同一套两级缓存语义 — 建筑足迹是「后续会演化」的数据, 必须持久化。</summary>
    public byte[] GetSettleBytes(string seed, int i, int j)
    {
        var key = WorldKeys.Settle(seed, i, j);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);
        if (hit != null) return hit;

        return BuildOnce(key, () =>
        {
            using var lease = World(seed);
            var gz = BuildSettle(lease.Vm, seed, i, j);
            Store(key, gz);
            return gz;
        });
    }

    private byte[] BuildSettle(JsVm vm, string seed, int i, int j)
    {
        /* ★ b 方案 (2026-10-10): 城镇足迹 = **骨架 ⊕ 建筑计划**。
           计划由引擎按 (pop/tier/state) 纯派生 —— 人口涨则建筑增多/升级, 人口跌或
           灾荒则外圈建筑消失。overlay 为空 (无演化台账) 时引擎原样吐骨架 ⇒ 与旧的
           settleJson 逐字节等同 (未演化世界零变化)。
           ⚠ 复用同一解析器: citySettlePlanJson 的输出结构与 settleJson 逐字段相同。 */
        var overlay = SettleOverlayJson(i, j);
        using var d = JsonDocument.Parse(vm.Call("citySettlePlanJson", i, j, overlay));
        var root = d.RootElement;
        var pack = new SettlePack
        {
            I = i, J = j,
        };
        foreach (var t in root.GetProperty("towns").EnumerateArray())
        {
            pack.Towns.Add(new SettleTownDto
            {
                Id = t.GetProperty("id").GetString() ?? "",
                Style = t.TryGetProperty("style", out var sy) && sy.ValueKind == JsonValueKind.String
                    ? sy.GetString() ?? "" : "",
                StyleName = t.TryGetProperty("styleName", out var sn) && sn.ValueKind == JsonValueKind.String
                    ? sn.GetString() ?? "" : "",
                Buildings = ReadBuildings(t, "buildings"),
                Resources = ReadResources(t, "resources"),
            });
        }
        return GZipCodec.Compress(ProtoCodec.SerToByte(pack));
    }

    /// <summary>为某区域格 (i,j) 的聚落构造「建筑计划 overlay」: `{"&lt;id&gt;":{pop,tier,state}}`。
    /// ★ 实现已**下移到子系统** (CitySubsystem.RenderOverlayJson): 台账归 City 所有,
    ///   让 Core 直接读它就是「Core 编译期认识 City」—— 那正是这次重构要拆掉的耦合。
    /// ⚠ 无当前世 / 无子系统贡献 ⇒ 返回空串 ⇒ 引擎原样吐骨架 (零变化路径)。</summary>
    private string SettleOverlayJson(int i, int j)
    {
        int round;
        try { round = _ledger.Count() == 0 ? 0 : _ledger.Current().Round; }
        catch { return ""; }
        if (round <= 0) return "";
        return _subsystems.OverlayJson(round, i, j);
    }

    private static List<BuildingDto> ReadBuildings(JsonElement e, string name)
    {
        var list = new List<BuildingDto>();
        if (!e.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var b in arr.EnumerateArray())
        {
            /* C12: 逐字段 TryGetProperty —— 原 GetProperty 在缺字段时抛 JsonException,
               且异常会中断整个 TileRequest (一个坏元素废掉整块响应)。
               同文件其它可选字段早已用 TryGetProperty, 这里属漏改。 */
            list.Add(new BuildingDto
            {
                Q = b.TryGetProperty("q", out var bq) ? bq.GetInt32() : 0,
                R = b.TryGetProperty("r", out var br) ? br.GetInt32() : 0,
                Kind = b.TryGetProperty("kind", out var bk) && bk.ValueKind == JsonValueKind.String
                    ? bk.GetString() ?? "" : "",
                Terrain = b.TryGetProperty("terrain", out var te) && te.ValueKind == JsonValueKind.String
                    ? te.GetString() ?? "" : "",
                Tier = b.TryGetProperty("tier", out var ti) ? ti.GetInt32() : 0,
                Lv = b.TryGetProperty("lv", out var lv) ? lv.GetInt32() : 0,
            });
        }
        return list;
    }

    private static List<ResourceQuantDto> ReadResources(JsonElement e, string name)
    {
        var list = new List<ResourceQuantDto>();
        if (!e.TryGetProperty(name, out var arr) || arr.ValueKind != JsonValueKind.Array) return list;
        foreach (var r in arr.EnumerateArray())
        {
            list.Add(new ResourceQuantDto       // C12: 同上, 缺字段不再抛异常
            {
                Resource = r.TryGetProperty("resource", out var rr) && rr.ValueKind == JsonValueKind.String
                    ? rr.GetString() ?? "" : "",
                Amount = r.TryGetProperty("amount", out var am) ? am.GetInt32() : 0,
            });
        }
        return list;
    }

    /* R9: per-key 构建门闩 (chunk/region/comm 共用) */
    private byte[] BuildOnce(string key, Func<byte[]> build)
    {
        var gate = _buildGates.GetOrAdd(key, _ => new object());
        lock (gate)
        {
            try
            {
                /* double-check: 等待期间可能已被并发请求 build 完成 */
                if (_mem.GetDataBytes(key) is byte[] memHit) return memHit;
                return build();
            }
            finally
            {
                _buildGates.TryRemove(key, out _);
            }
        }
    }

    /* ---------------- WebSocket 单块统一接口 (设计 §3/§4) ----------------
     * GetTileBlock(i, j, mask, lastRevs): 一个块 = 一个 TileResponse,
     * 内含 chunk/region/settle/poi/comm 五个独立子消息, mask 按位选层。
     * 主块坐标系 = 区块格 (方案 A): i,j 即 chunk (ca,cb);
     * 块覆盖的 region/comm 格由 JS blockLayersJson 权威给出。
     * Revs: 按块的图层版本 (对齐 roadVer 思路)。当前世界确定性无事件,
     * rev 恒 1; 客户端带 lastRevs 且未变化时该层子消息缺省 (响应最小化)。
     * 未来建筑事件只需 BumpBlockRev 后让客户端重拉该块即可。 */
    private sealed class BlockRevs
    {
        public int Chunk = 1, Region = 1, Settle = 1, Poi = 1, Comm = 1, People = 1;
        public int ByBit(int bit) => bit switch
        {
            0 => Chunk, 1 => Region, 2 => Settle, 3 => Poi, 4 => Comm, _ => People
        };
        public void Bump(uint mask)
        {
            /* C5: 原子自增 —— 原 int++ 在多线程并发 Bump 时会丢计数,
               客户端带旧 rev 重拉时可能被判「未变化」而收不到新数据。 */
            if ((mask & (uint)TileMask.Chunk) != 0) System.Threading.Interlocked.Increment(ref Chunk);
            if ((mask & (uint)TileMask.Region) != 0) System.Threading.Interlocked.Increment(ref Region);
            if ((mask & (uint)TileMask.Settle) != 0) System.Threading.Interlocked.Increment(ref Settle);
            if ((mask & (uint)TileMask.Poi) != 0) System.Threading.Interlocked.Increment(ref Poi);
            if ((mask & (uint)TileMask.Comm) != 0) System.Threading.Interlocked.Increment(ref Comm);
            /* 人物层: 它的输入（聚落人口）会随 tick 演化 ⇒ MarkSettleDirty 已在那一侧同时清掉
               进程内 _peopleCache（**rev + LRU 两处都要挂才算闭环**：只 Bump rev 只解决「客户端
               带旧 rev 重拉」，服务端 Get 仍会命中旧 LRU 包）。此处保留位号以便将来前端改为
               「按 rev 变化重拉已加载块」时再补 Bump。 */
            if ((mask & (uint)TileMask.People) != 0) System.Threading.Interlocked.Increment(ref People);
        }
    }

    /* C5 显式契约 (勿删): 块级 rev 是「客户端缓存有效性」的唯一凭据。
       任何会让某块某图层内容发生变化的服务端改动 (改足迹 / 建筑演化 / 实体状态迁移 /
       道路版本前进 …) **必须** 调用 BumpBlockRev(seed, i, j, 图层位), 否则:
         · 客户端带着旧 lastRevs 重拉 → Need(bit) 判 false → 服务端缺省下发该层
         → 永久陈旧 (不报错、不抛异常, 只在画面上「改了没反应」)。
       当前实现只在服务端「按需计算」时前进 (世界确定性无事件态), 故尚无调用者 —— 
       接入事件/演化系统时, 这是第一处必须挂上的钩子。 */
    private readonly ConcurrentDictionary<string, BlockRevs> _blockRev = new();

    /// <summary>事件钩子: 置某块某图层脏, 客户端下次带旧 rev 重拉时才会收到该层数据。
    /// 调用约束见上方「C5 显式契约」。键内含 seed 前缀, 由维护任务按活跃世界裁剪。</summary>
    public void BumpBlockRev(string seed, int i, int j, TileMask layers)
    {
        var revs = _blockRev.GetOrAdd("blk:" + WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j,
                                      _ => new BlockRevs());
        revs.Bump((uint)layers);
    }

    /// <summary>
    /// 构造单块响应。mask 为「已解析、已鉴权」的图层位 (由调用方完成 0→All 归一与
    /// 未登录裁剪); 本方法按字面语义处理, 不再自行把 0 当 All。
    /// 语义约定: resp.Mask = 本次「客户端可视为持有」的图层位
    ///   = mask 中「已下发数据」或「rev 命中(客户端本就持有)」的位。
    ///   恒等于入参 mask —— 因为 Need(bit)=true 时会下发, Need=false 时客户端已持有。
    /// 客户端据此只更新 mask 命中位的 rev (未命中位保持 0 = 未持有), 从根上避免
    /// 「非全量 mask 请求后把未收到图层的 rev 记为已持有」导致的永久缺层。
    /// </summary>
    public TileResponse GetTileBlock(string seed, int i, int j, uint mask, List<int>? lastRevs)
    {
        mask &= (uint)TileMask.All;
        var revs = _blockRev.GetOrAdd("blk:" + WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j,
                                      _ => new BlockRevs());
        int[] revArr = [revs.Chunk, revs.Region, revs.Settle, revs.Poi, revs.Comm, revs.People];
        var resp = new TileResponse { I = i, J = j, Mask = mask, Revs = [.. revArr] };

        /* 图层是否需要下发: mask 命中 且 (客户端未持有 或 rev 已变化) */
        bool Need(int bit)
        {
            if ((mask & (1u << bit)) == 0) return false;
            var lr = lastRevs != null && bit < lastRevs.Count ? lastRevs[bit] : 0;
            return lr <= 0 || lr != revArr[bit];
        }
        bool needChunk = Need(0), needRegion = Need(1), needSettle = Need(2),
             needPoi = Need(3), needComm = Need(4);
        /* 图层5 人物分布 = (seed,块) 的**纯函数**, 内容永不变化 ⇒ **不走 rev 去重**:
           只要 mask 要它, 每一发都带上。理由: 该层在前端是「热力图开关」的临时数据 ——
           关掉开关客户端就丢数据, 但 lastRevs[5] 仍记着旧 rev ⇒ 再次打开时服务端按
           rev「未变化」缺省下发 ⇒ 热力图**第二次打开永久空白** (且不报错)。
           代价 = 每块一次 LRU 命中 + 小载荷; 且仅在用户开启热力图时发生 (mask 不带该位
           则一个字节都不算 —— Need 之外再单独判 mask, 见下)。 */
        bool wantPeople = (mask & (uint)TileMask.People) != 0;
        if (!needChunk && !needRegion && !needSettle && !needPoi && !needComm && !wantPeople)
            return resp;   // 全层 rev 未变: 最小响应 (验收 §8.6)

        /* C1: 借出覆盖整个块构建期 (期间本 VM 不会被 LRU 淘汰; 内层各 GetXxxBytes
           再各借一次, 计数嵌套累加, 各自归还)。 */
        using var vm = World(seed);
        if (needChunk)
            resp.Chunk = UnwrapCached(WorldKeys.Chunk(seed, i, j), GetChunkBytes(seed, i, j));

        /* 块归属映射: 仅在需要 region/settle/poi/comm 层时向 JS 取一次 (结果走 LRU) */
        ((int, int)[] regions, (int, int)[] comms)? layers =
            (needRegion || needSettle || needPoi || needComm) ? GetBlockLayers(vm.Vm, seed, i, j) : null;

        /* 图层1/2/3 共用区域包: 聚落实体从 RegionPack.settlements 拆出 */
        if (needRegion || needSettle || needPoi)
        {
            var settleGroups = new List<EntityGroup>();
            var poiGroups = new List<EntityGroup>();
            /* Phase3: 城镇足迹以 settle 包 (落 SQLite, 会演化) 为权威 —
               同时取包即完成「生成并落库」, 冷回读走 _mem/SQLite 两级缓存。 */
            var plans = new Dictionary<string, SettleTownDto>();
            if (needSettle)
            {
                foreach (var (ri, rj) in layers!.Value.regions)
                {
                    var sp = SettlePackOf(seed, ri, rj);
                    foreach (var t in sp.Towns) plans[t.Id] = t;
                }
            }
            foreach (var (ri, rj) in layers!.Value.regions)
            {
                var pack = RegionPackOf(seed, ri, rj);
                if (needRegion)
                {
                    resp.Regions.Add(new RegionData
                    {
                        I = ri, J = rj, Info = pack.Region, Roads = pack.Roads,
                    });
                }
                if (needSettle)
                {
                    var items = new List<PlaceEntity>();
                    foreach (var s in pack.Settlements)
                    {
                        if (s.Type == "poi") continue;
                        var e = ToEntity(s);
                        if (plans.TryGetValue(s.Id, out var plan))
                        {
                            e.Style = plan.Style; e.StyleName = plan.StyleName;
                            e.Buildings = plan.Buildings; e.Resources = plan.Resources;
                        }
                        items.Add(e);
                    }
                    if (items.Count > 0) settleGroups.Add(new EntityGroup { I = ri, J = rj, Items = items });
                }
                if (needPoi)
                {
                    var items = new List<PlaceEntity>();
                    foreach (var s in pack.Settlements)
                    {
                        if (s.Type != "poi") continue;
                        items.Add(ToEntity(s));
                    }
                    if (items.Count > 0) poiGroups.Add(new EntityGroup { I = ri, J = rj, Items = items });
                }
            }
            if (needSettle && settleGroups.Count > 0) resp.Settle = new SettleData { Groups = settleGroups };
            if (needPoi && poiGroups.Count > 0) resp.Poi = new PoiData { Groups = poiGroups };
        }

        /* 图层4: 群落包原样嵌入 (CommunityPack protobuf) */
        if (needComm)
        {
            foreach (var (ci, cj) in layers!.Value.comms)
                resp.Comms.Add(UnwrapCached(WorldKeys.Comm(seed, ci, cj), GetCommBytes(seed, ci, cj)));
        }

        /* 图层5: 地图人物分布 (纯派生, 不落库; 不走 rev 去重 —— 见上方 wantPeople 注释) */
        if (wantPeople)
            resp.People = BuildPeopleLayer(seed, i, j);
        return resp;
    }

    /* ============================================================
     * 图层5: 地图人物分布 (2026-10-11 方案 v2)
     * ------------------------------------------------------------
     * 两段拼接 (**两个独立 V8**, 刻意不合并):
     *   ① 落人格「谁在哪一格 / 这一格几个人」→ 核心 VM (有骨架 + 地形)
     *   ② 战力合计「这一格有多少战力」       → characters VM (有六维与资源)
     * ⚠ 纯派生 ⇒ **绝不落库、绝不进 _mem/SQLite** (落库后淘汰回读会把旧包捞回来);
     *   只进进程内 LRU, 键含 seed 前缀。
     * ⚠ 抛异常就让它抛 —— 吞成空层会被客户端当成「这地方本来就没人才」(静默错误)。
     * ============================================================ */
    private PeopleData BuildPeopleLayer(string seed, int ca, int cb)
    {
        /* ⚠ 本文件唯一一处与子系统的**字符串耦合**: 人物战力归 characters 子系统
           (只有它的 V8 载了 chargen-core.js)。值 = CharactersModule.CharactersScope。
           为什么不写类型引用: Core(Services) 不许引用具体子系统类型 (ISubsystem 契约)。 */
        const string CharactersVmScope = "characters";

        var key = "ppl:" + WorldKeys.SeedPrefix(seed) + ":" + ca + ":" + cb;
        var hit = _peopleCache.Get(key);
        if (hit != null) return hit;

        string tilesJson;
        using (var core = LeaseScope(WorldModule.WorldScope, seed))
            tilesJson = core.Vm.Call("peopleBlockJson", ca, cb);

        var tiles = new List<PeopleTileDto>();
        var pairs = new List<long>();      // 扁平 [base,n, base,n, …]
        using (var d = JsonDocument.Parse(tilesJson))
        {
            foreach (var t in d.RootElement.GetProperty("tiles").EnumerateArray())
            {
                var n = t.GetProperty("n").GetInt32();
                tiles.Add(new PeopleTileDto
                {
                    Q = t.GetProperty("q").GetInt32(),
                    R = t.GetProperty("r").GetInt32(),
                    N = n,
                });
                pairs.Add(t.GetProperty("base").GetInt64());
                pairs.Add(n);
            }
        }

        if (tiles.Count > 0)
        {
            /* 传扁平数组而不是 [[base,n],…] 嵌套: 字符串拼接最省事, JS 侧按 2 步长解。
               ⚠ 这里**不超发**: 只有 tiles.Count>0 才去借 characters VM (纯海区块零开销)。 */
            var sb = new StringBuilder("[");
            for (var i = 0; i < pairs.Count; i += 2)
            {
                if (i > 0) sb.Append(',');
                sb.Append('[').Append(pairs[i]).Append(',').Append(pairs[i + 1]).Append(']');
            }
            sb.Append(']');

            string sumsJson;
            using (var ch = LeaseScope(CharactersVmScope, seed))
                sumsJson = ch.Vm.Call("powerSumsJson", seed, sb.ToString());

            using var sd = JsonDocument.Parse(sumsJson);
            var si = 0;
            foreach (var s in sd.RootElement.GetProperty("sums").EnumerateArray())
            {
                if (si >= tiles.Count) break;
                tiles[si++].Ps = s.GetInt64();
            }
        }

        var data = new PeopleData { Tiles = tiles };
        _peopleCache.Set(key, data);
        return data;
    }

    private static PlaceEntity ToEntity(SettlementDto s) => new()
    {
        Id = s.Id, Type = s.Type, Q = s.Q, R = s.R, X = s.X, Y = s.Y,
        Name = s.Name, Pop = s.Pop, Owner = s.Owner,
        Tier = s.Tier, State = s.State, ExpireTs = s.ExpireTs,
        Style = s.Style, StyleName = s.StyleName,
        Buildings = s.Buildings, Resources = s.Resources,
    };

    /* 块归属映射: (regions[], comms[]) — JS 权威 (blockLayersJson)
       结果仅依赖 (seed,i,j) 且内容确定 (region/comm 归属映射与事件无关),
       故按 seedprefix:i:j 加 LRU, 免每次块请求重跑 V8 + JSON 解析。 */
    private ((int, int)[] regions, (int, int)[] comms) GetBlockLayers(JsVm vm, string seed, int i, int j)
    {
        var key = WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j;
        var cached = _blockLayersCache.Get(key);
        if (cached != null) return (cached[0], cached[1]);

        using var d = JsonDocument.Parse(vm.Call("blockLayersJson", i, j));
        var r = d.RootElement;
        var regions = ReadPairs(r.GetProperty("regions"));
        var comms = ReadPairs(r.GetProperty("comms"));
        _blockLayersCache.Set(key, [regions, comms]);
        return (regions, comms);
    }

    private static (int, int)[] ReadPairs(JsonElement arr)
    {
        var outp = new (int, int)[arr.GetArrayLength()];
        var n = 0;
        foreach (var p in arr.EnumerateArray())
        {
            var it = p.EnumerateArray().GetEnumerator();
            it.MoveNext(); var a = it.Current.GetInt32();
            it.MoveNext(); var b = it.Current.GetInt32();
            outp[n++] = (a, b);
        }
        return outp;
    }

    private static byte[] GzUnwrap(byte[] gz) => GZipCodec.Decompress(gz);

    /* chunk/comm 子消息嵌入 TileResponse 前必须解压成原始 protobuf, 而同一 key
       在多块/多次请求中重复出现 (邻块共享、视野反复) → 解压结果按 key 缓存,
       免每块重复 GzUnwrap。内容按 (seed,坐标) 确定, 缓存只损失命中率不影响正确性。 */
    private byte[] UnwrapCached(string key, byte[] gz)
    {
        var raw = _rawCache.Get(key);
        if (raw != null) return raw;
        raw = GzUnwrap(gz);
        _rawCache.Set(key, raw);
        return raw;
    }

    private static T DesFromGz<T>(byte[] gz) => ProtoCodec.DesFromByte<T>(GzUnwrap(gz));

    /* C4: region/settle 包的「解压 + 反序列化」结果按 world key 缓存。
       每块请求都要按 4~6 个区域解包, 同一区域在邻块/反复视野里重复出现;
       旧实现是「解压结果只缓存字节级 raw, protobuf 反序列化每次都重做」。
       包对象此后只被读取 (response 只搬引用, 序列化完即弃) ⇒ 共享安全。 */
    private RegionPack RegionPackOf(string seed, int i, int j)
    {
        var key = WorldKeys.Region(seed, i, j);
        var p = _regionPackCache.Get(key);
        if (p != null) return p;
        p = DesFromGz<RegionPack>(GetRegionBytes(seed, i, j));
        _regionPackCache.Set(key, p);
        return p;
    }

    private SettlePack SettlePackOf(string seed, int i, int j)
    {
        var key = WorldKeys.Settle(seed, i, j);
        var p = _settlePackCache.Get(key);
        if (p != null) return p;
        p = DesFromGz<SettlePack>(GetSettleBytes(seed, i, j));
        _settlePackCache.Set(key, p);
        return p;
    }

    /* T8: SQLite 命中后回填 _mem, 同一 key 后续读取不再走库 */
    private byte[]? ReadSqlBackfill(string key)
    {
        if (_sql == null) return null;
        var v = _sql.GetDataBytes(key);
        if (v != null) _mem.SetData(key, v);
        return v;
    }

    /* ---------------- 单格详情 (不落库) ---------------- */
    /* T4: 进程内热缓存 — key = "t:<seedprefix>:<q>:<r>", 值带 VM roadVersion。
       tileJson 的 onRoad 语义与 VM roadCache 相关 (点击零 A*, 只读已生成道路)。
       仅当 roadCache 真有新路落成 (roadVersion 前进) 时旧条目失效重算;
       区域包缓存命中/流式补齐不再整片作废 tile 缓存。
       P1: 命中路径比对 service 层 _roadVerCache (区域包生成时刷新) → 免抢 V8 门闩。 */
    public byte[] GetTileBytes(string seed, int q, int r)
    {
        var cacheKey = "t:" + WorldKeys.SeedPrefix(seed) + ":" + q + ":" + r;
        /* P: 落点世代先取样 —— 生成的中间态若恰好跨过一次落点, 旧世代号会让它
           在下次请求被判"过期"而重算 (用**取样时**的世代号盖章, 不用生成后的)。 */
        var pv0 = Volatile.Read(ref _placeVer);
        var cached = _tileCache.Get(cacheKey);
        if (cached != null && cached.PlaceVer == pv0)
        {
            /* P1: 命中路径优先比对 service 层 roadVer (区域包生成时刷新), 免每次
               抢 V8 门闩取 RoadVersion — tile 是高频路径(小地图轮询+点击连发)。
               首次无记录时才进 V8 取一次; roadVer 只在区域包生成时前进, 故此后
               命中即无锁直返。 */
            var prefix = WorldKeys.SeedPrefix(seed);
            if (_roadVerCache.TryGetValue(prefix, out var known))
            {
                if (cached.RoadVer == known) return cached.Gz;
            }
            else
            {
                using var l0 = World(seed);
                var v0 = l0.Vm.RoadVersion();
                ObserveRoadVer(prefix, v0);
                if (cached.RoadVer == v0) return cached.Gz;
            }
        }

        string json;
        long ver;
        using (var lease = World(seed))
        {
            json = lease.Vm.Call("tileJson", q, r);
            ver = lease.Vm.RoadVersion();  // 取生成后版本: 若生成途中恰好新路落成, 下次请求会按新版本重算
        }
        ObserveRoadVer(WorldKeys.SeedPrefix(seed), ver);
        using var d = JsonDocument.Parse(json);
        var rt = d.RootElement;
        var f = rt.GetProperty("f");
        var tq = new TileQuery
        {
            Q = q, R = r,
            E = F(f, "e"), M = F(f, "m"), T = F(f, "t"),
            Biome = f.GetProperty("biome").GetInt32(),
            Disp = f.GetProperty("disp").GetInt32(),
            Variant = f.GetProperty("variant").GetInt32(),
            RegionI = rt.GetProperty("region").GetProperty("i").GetInt32(),
            RegionJ = rt.GetProperty("region").GetProperty("j").GetInt32(),
            RegionName = rt.GetProperty("region").GetProperty("name").GetString() ?? "",
            RegionBiome = rt.GetProperty("region").GetProperty("biome").GetInt32(),
            OnRoad = rt.GetProperty("onRoad").GetBoolean(),
        };
        if (rt.TryGetProperty("vein", out var v) && v.ValueKind == JsonValueKind.Object)
        {
            tq.HasVein = true;
            tq.VeinElement = v.GetProperty("element").GetInt32();
            tq.VeinVariant = v.TryGetProperty("variant", out var vv) && vv.ValueKind == JsonValueKind.String
                ? vv.GetString() ?? "" : "";
            tq.VeinLevel = v.GetProperty("level").GetInt32();
            tq.VeinD = v.GetProperty("d").GetInt32();
            tq.VeinName = v.GetProperty("name").GetString() ?? "";
        }
        if (rt.TryGetProperty("place", out var pl) && pl.ValueKind == JsonValueKind.Object)
        {
            tq.PlaceType = pl.GetProperty("type").GetString() ?? "";
            tq.PlaceName = pl.GetProperty("name").GetString() ?? "";
            tq.PlacePop = pl.GetProperty("pop").GetInt32();
        }
        /* 去水距离: 原算法陆上 4 环无水的 -1 → 255 (无符号便于 wire) */
        var wd = rt.GetProperty("waterD").GetInt32();
        tq.WaterD = wd < 0 ? 255 : wd;
        var proto = ProtoCodec.SerToByte(tq);
        var gz = GZipCodec.Compress(proto);

        _tileCache.Set(cacheKey, new TileEntry(gz, ver, pv0));
        return gz;
    }

    /* ---------------- 字段网格 / 元信息 (JSON) ---------------- */
    /* R8: 小地图同窗口重复轮询(0.4~1.5s)直接命中, 免每次占 V8 门闩 */
    public string GetFieldGridJson(string seed, int q0, int q1, int r0, int r1)
    {
        var cacheKey = "g:" + WorldKeys.SeedPrefix(seed) + ":" + q0 + ":" + q1 + ":" + r0 + ":" + r1;
        var hit = _gridCache.Get(cacheKey);
        if (hit != null) return hit;

        string json;
        using (var lease = World(seed)) json = lease.Vm.Call("fieldGridJson", q0, q1, r0, r1);
        _gridCache.Set(cacheKey, json);
        return json;
    }

    public string GetMetaJson(string seed)
    {
        lock (_metaLock)
        {
            if (_metaCache != null) return _metaCache;
        }
        string json;
        using (var lease = World(seed)) json = lease.Vm.Call("metaJson");
        json = InjectEngineHash(json);
        lock (_metaLock)
        {
            _metaCache ??= json;
        }
        return json;
    }

    /* S4: 把引擎指纹拼进 meta。metaJson 由 JS 的 JSON.stringify 产出, 必以 '}' 收尾 ——
       直接把尾括号替换成 ,"engineHash":"…"} (注入失败就原样返回, 前端按「无字段」处理)。 */
    private string InjectEngineHash(string json)
    {
        if (string.IsNullOrEmpty(_engineHash)) return json;
        var t = json.TrimEnd();
        if (t.Length < 2 || t[^1] != '}') return json;
        return t[..^1] + ",\"engineHash\":\"" + _engineHash + "\"}";
    }

    /* S4: 引擎指纹 = SHA256(noise.js | mapgen-config.js | mapgen.js) 前 8 字节的十六进制。
       进程内算一次 (引擎文件运行期不变)。任何缺失/IO 异常都返回 null ⇒ 自动退回「不握手」。 */
    private static string? ComputeEngineHash(string jsDir)
    {
        try
        {
            using var sha = System.Security.Cryptography.SHA256.Create();
            using var ms = new MemoryStream();
            foreach (var f in new[] { "noise.js", "mapgen-config.js", "mapgen.js" })
            {
                var p = Path.Combine(jsDir, f);
                if (!File.Exists(p)) return null;
                var b = File.ReadAllBytes(p);
                ms.Write(b, 0, b.Length);
            }
            ms.Position = 0;
            return Convert.ToHexString(sha.ComputeHash(ms).AsSpan(0, 8)).ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }

    /* ---------------- 世界种子台账 (W · 2026-09-16) ----------------
       种子的唯一来源。三个出口都是**只读/幂等语义明确**的小 JSON, 与地图数据无关
       (不拉图 ⇒ 不违反「HTTP 不再保留任何拉图接口」的约定)。
         GET  /api/world/current → 当前世; 库里一世都没有时由服务端**就地开第一世**
         POST /api/world/next    → 另启一世 (轮次 +1 + 新种子), 持久化后返回
         GET  /api/world/list    → 最近 n 世 (设置弹窗里"曾经走过哪些世界")
       ⚠ 客户端拿到 seed 后仍按老协议把它带在 TileRequest.Seed 里 —— 协议一字未改,
         变的只是「这个字符串从哪来」(服务端发, 而不是前端 Date.now() 造)。 */
    public string WorldCurrentJson() => WorldJson(_ledger.Current(), "current");

    public string WorldNextJson() => WorldJson(_ledger.Next(), "next");

    public string WorldListJson(int n) => JsonSerializer.Serialize(new
    {
        persisted = _ledger.Persisted,
        total = _ledger.Count(),
        rounds = _ledger.Recent(n).Select(e => new { round = e.Round, seed = e.Seed, bornAt = e.BornAt }),
    });

    private string WorldJson(WorldEntry e, string kind) => JsonSerializer.Serialize(new
    {
        kind,
        round = e.Round,
        seed = e.Seed,
        bornAt = e.BornAt,
        persisted = _ledger.Persisted,     // false = PersistEnabled 关掉时的仅内存降级
    });

    public string StatsJson()
    {
        /* P6: 先排空批量落库队列, 计数才反映真实落库进度。
           T3: 历史行清理已移入后台维护任务, 不再依赖 /stats 偶发触发。 */
        _sql?.Flush();
        return System.Text.Json.JsonSerializer.Serialize(new
        {
            liveSeeds = _host.Count,       // 跨 Scope 的活跃 VM 总数
            maxSeeds = _opt.MaxSeeds,      // 便于验证 appsettings.json 是否真的生效
            /* ⚠ liveSeeds 的上界是「池容量 = MaxSeeds × Scope 数」, **不是** MaxSeeds ——
               一个 seed 现在占多个 VM (世界层 + 各子系统各一个独立 V8)。w2 的
               「LRU 有界」判据必须拿这个比, 否则会假红。 */
            poolCapacity = _host.Capacity,
            dbRows = _sql?.Count() ?? 0,
            memRows = _mem.Count(),
            /* W: 台账对账用 —— ⚠ 只读 Count(), 不调 Current(): 别让一次探活就把第一世开出来 */
            worldRounds = _ledger.Count(),
            ledgerPersisted = _ledger.Persisted,
            /* P: 玩家宗门对账 (验证脚本用) */
            playerSects = _ledger.Count() == 0 ? 0 : _sects.CountRound(_ledger.Current().Round),
            /* P2-α (城市扩张): 主宗数 / 附属城镇数分开报 —— 验证脚本的「本世是否干净」闸要它 */
            playerTowns = _ledger.Count() == 0 ? 0 : _sects.CountTownsRound(_ledger.Current().Round),
            placeVer = Volatile.Read(ref _placeVer),
            /* T4 (世界时钟): 时钟指标。⚠ 时钟与种子同级是服务端资产 ——
               /stats 是它唯一的对账出口 (前端另有 /api/clock 只读端点)。
               ⚠ 未绑定时 tick=-1, 不该被误读成「世界第 -1 天」。 */
            tick = _tickPump?.CurrentTick ?? -1,
            tickPendingJobs = _tickPump?.Scheduler.PendingCount ?? 0,
            tickIncomplete = _tickPump?.Metrics.IncompleteTicks ?? 0,
            tickMsP50 = _tickPump is null ? 0 : Math.Round(_tickPump.Metrics.P50Ms, 3),
            tickMsP95 = _tickPump is null ? 0 : Math.Round(_tickPump.Metrics.P95Ms, 3),
            tickExecutor = _tickPump?.Snapshot().Executor ?? "",
        });
    }

    /* ============================================================
     * 玩家宗门放置 (2026-09-23 方案 §2.3 判据链 / §3.3 七步同步序列 / §4.3 落库)
     * ------------------------------------------------------------
     * 分工:
     *   判据 1/2/3/4/9 (本世 / 登录 / 配额 / 坐标 / 名字) —— 服务端自身状态, 在此;
     *   判据 5/6/7 (深海 / 灵脉 / 领地)           —— 引擎 (placeCheckJson / domainCheck)。
     * ⚠ PlaceCommit 必须**重新跑**一遍全部判据: 前端的 PlaceCheck 只是给用户看的提示,
     *   它可被篡改/过期 (用户在别处又放了一座, 或世界换了)。写路径绝不信客户端结论。
     * ============================================================ */

    /// <summary>坐标合法范围。世界半径 = SPIRIT_R_TILES(500) × 2 ≈ 1000 格,
    /// 取 2000 足够宽松; 真正的作用是把 int 极值挡在引擎之外 (A* / 缓存 key 会溢出)。</summary>
    private const int PlaceCoordMax = 2000;

    /// <summary>名字长度上限 (1~12 字符, 按 UTF-16 单元计)。</summary>
    private const int PlaceNameMax = 12;

    /// <summary>两次「贵的提交」之间的最小间隔 (ms)。一次 = ~450ms 同步 A* (25 区域格),
    /// 700ms 意味着稳态吞吐 ≤1.5 次/秒 (V8 占用 ≤70%), 已足够宽裕。</summary>
    private const int PlaceCommitMinGapMs = 700;

    /// <summary>上次真正进引擎的提交时刻 (TickCount64)。0 = 从未提交过。</summary>
    private long _lastPlaceCommitMs;

    public PlaceCheckResponse PlaceCheck(
        string seed, string? account, bool authed, int q, int r, string? excludeId,
        string? type, uint seq)
    {
        var cur = _ledger.Current();
        return CheckCore(cur, seed, account, authed, q, r, excludeId, type, seq);
    }

    /// <summary>归一化聚落类型: null/空 = "sect" (立宗), 其余转小写原样返回。
    /// ⚠ **不在 C# 里做白名单校验** —— 「town/village 才是合法的扩张类型」这条规则
    ///   的真源是引擎 mapgen-config.js 的 EXPAND_TYPES (判定只在一处; 同 DOMAIN_R 的规矩)。
    ///   引擎对非白名单类型回 reason='bad_type'。</summary>
    private static string NormalizeKind(string? type)
    {
        var t = (type ?? "").Trim().ToLowerInvariant();
        return t.Length == 0 ? "sect" : t;
    }

    /// <summary>扩张半径 (格; 引擎 CFG.EXPAND_R)。惰性从引擎 meta 读一次并缓存 ——
    /// C# 侧**不镜像**这个常数, 这里只做搬运 (引擎改了配置, 重启即生效)。
    /// 0 = 该引擎版本没有这个概念 ⇒ 一切都退化为「立宗档」(不发锚点)。</summary>
    private int _expandR = -1;
    private int ExpandR(string seed)
    {
        if (_expandR >= 0) return _expandR;
        int v;
        using (var lease = World(seed))
        using (var d = JsonDocument.Parse(lease.Vm.Call("metaJson")))
            v = d.RootElement.TryGetProperty("expandR", out var el) ? el.GetInt32() : 0;
        _expandR = v;
        return v;
    }

    /* ⚠ account 必须可空: 未登录会话走的就是 null 这条路 (判据 2 拦它)。
       判据 2 之后编译器已把 account 收窄为非空 (IsNullOrEmpty 带 NotNullWhen(false))。 */
    private PlaceCheckResponse CheckCore(
        WorldEntry cur, string seed, string? account, bool authed,
        int q, int r, string? excludeId, string? type, uint seq)
    {
        var kind = NormalizeKind(type);
        /* 扩张档 = 不是立宗。锚点 (本宗) 与半径都从**服务端状态**推出来:
           前端只报"我想建哪种", 不报坐标 —— 否则改一个数字就能把附属城镇甩到天边。 */
        var expand = !string.Equals(kind, "sect", StringComparison.Ordinal);
        var resp = new PlaceCheckResponse
        {
            Q = q, R = r, Seq = seq, Type = kind,
            QuotaMax = _sects.MaxPerAccount, TownMax = _sects.TownMaxPerSect,
        };

        /* 判据 1: 必须是**当前世** (世界可按 seed 确定性重建, 但玩家资产按「第几世」记 ——
           在已退场的一世里大兴土木, 记录会永远读不回来) */
        if (!string.Equals(seed, cur.Seed, StringComparison.Ordinal))
        {
            resp.Reason = "world_stale";
            resp.Err = "该世界已退场, 请刷新后领当前世";
            return resp;
        }
        if (!authed || string.IsNullOrEmpty(account))                  // 判据 2: 登录
        {
            resp.Reason = "need_login";
            resp.Err = "卜居需要先登录";
            return resp;
        }
        if (Math.Abs((long)q) > PlaceCoordMax || Math.Abs((long)r) > PlaceCoordMax)   // 判据 4: 坐标
        {
            resp.Reason = "bad_coord";
            return resp;
        }
        /* 判据 3: 配额 —— **分两档** (立宗按账号数, 拓土按附属数), 且拓土必须有本宗当锚点 */
        if (expand)
        {
            var main = _sects.Find(account, cur.Round);
            resp.Towns = _sects.CountTowns(account, cur.Round);
            resp.Quota = resp.Towns;
            resp.QuotaMax = _sects.TownMaxPerSect;
            if (main == null)
            {
                resp.Reason = "no_sect";
                resp.Err = "尚未立宗, 无处拓土";
                return resp;
            }
            resp.AnchorQ = main.Q;
            resp.AnchorR = main.R;
            resp.HasAnchor = true;
            if (_sects.TownMaxPerSect > 0 && resp.Towns >= _sects.TownMaxPerSect)
            {
                resp.Reason = "quota_exceeded";
                resp.Err = "附属城镇已达上限";
                return resp;
            }
        }
        else
        {
            var used = _sects.CountOf(account, cur.Round);
            resp.Quota = used;
            resp.QuotaMax = _sects.MaxPerAccount;
            resp.Towns = _sects.CountTowns(account, cur.Round);
            if (used >= _sects.MaxPerAccount)
            {
                resp.Reason = "quota_exceeded";
                resp.Err = "此世已立宗门";
                return resp;
            }
        }
        /* 判据 5/6/7 + 扩张: 引擎 (深海 / 灵脉 / 领地 / 距本宗太远) —— 一次 V8 往返全算完 */
        var modeJson = expand
            ? JsonSerializer.Serialize(new { type = kind, aq = resp.AnchorQ, ar = resp.AnchorR, maxR = ExpandR(seed) })
            : JsonSerializer.Serialize(new { type = kind });
        string json;
        using (var lease = World(cur.Seed))
            json = lease.Vm.Call("placeCheckJson", q, r, excludeId ?? "", modeJson);
        using var d = JsonDocument.Parse(json);
        var rt = d.RootElement;
        if (rt.TryGetProperty("expand", out var exEl))
        {
            resp.MaxR = exEl.TryGetProperty("maxR", out var mr) ? mr.GetInt32() : 0;
            /* 引擎在「不设上限」时回 dist = -1 ⇒ 夹到 0 (哨兵语义见 DTO 注释: 不用 -1) */
            var dv = exEl.TryGetProperty("dist", out var dd) ? dd.GetInt32() : 0;
            resp.AnchorDist = dv > 0 ? dv : 0;
        }
        resp.RegionI = rt.GetProperty("regionI").GetInt32();
        resp.RegionJ = rt.GetProperty("regionJ").GetInt32();
        resp.Deep = rt.GetProperty("deep").GetBoolean();
        resp.OnVein = rt.GetProperty("onVein").GetBoolean();
        resp.VeinD = rt.GetProperty("veinD").GetInt32();
        resp.Spirit = F(rt, "spirit");
        resp.SpiritMin = F(rt, "spiritMin");
        resp.Biome = rt.GetProperty("biome").GetInt32();
        resp.Elev = F(rt, "elev");
        if (rt.TryGetProperty("blocker", out var bl) && bl.ValueKind == JsonValueKind.Object)
        {
            resp.Blocker = new PlaceBlockDto
            {
                Id = bl.GetProperty("id").GetString() ?? "",
                Type = bl.GetProperty("type").GetString() ?? "",
                Tier = bl.GetProperty("tier").GetInt32(),
                Q = bl.GetProperty("q").GetInt32(),
                R = bl.GetProperty("r").GetInt32(),
                Dist = bl.GetProperty("dist").GetInt32(),
                Need = bl.GetProperty("need").GetInt32(),
            };
        }
        if (rt.TryGetProperty("near", out var near) && near.ValueKind == JsonValueKind.Array)
        {
            foreach (var n in near.EnumerateArray())
            {
                resp.Near.Add(new PlaceDomainDto
                {
                    Id = n.GetProperty("id").GetString() ?? "",
                    Type = n.GetProperty("type").GetString() ?? "",
                    Tier = n.GetProperty("tier").GetInt32(),
                    Q = n.GetProperty("q").GetInt32(),
                    R = n.GetProperty("r").GetInt32(),
                    Dist = n.GetProperty("dist").GetInt32(),
                    Need = n.GetProperty("need").GetInt32(),
                    Name = n.TryGetProperty("name", out var nm) && nm.ValueKind == JsonValueKind.String
                        ? nm.GetString() ?? "" : "",
                });
            }
        }
        resp.Ok = rt.GetProperty("can").GetBoolean();
        resp.Reason = resp.Ok ? "" : (rt.GetProperty("reason").GetString() ?? "too_close");
        return resp;
    }

    public PlaceCommitResponse PlaceCommit(
        string seed, string? account, bool authed, int q, int r, string? name, int tier,
        string? type, string? idemKey, uint seq)
    {
        var resp = new PlaceCommitResponse { Seq = seq, IdemKey = idemKey ?? "" };
        var cur = _ledger.Current();
        var kind = NormalizeKind(type);
        var expand = !string.Equals(kind, "sect", StringComparison.Ordinal);

        /* 判据 1: 本世 */
        if (!string.Equals(seed, cur.Seed, StringComparison.Ordinal))
        {
            resp.Reason = "world_stale";
            resp.Err = "该世界已退场, 请刷新后领当前世";
            return resp;
        }
        /* 本账号在本世的**主宗** —— 扩张档它是锚点, 立宗档它是"原地重建"的豁免对象。 */
        var main = _sects.Find(account ?? "", cur.Round);
        /* 幂等: 同 IdemKey 直接回放上次响应 —— 同步重算 ~450ms 期间用户狂点确认键的兜底。
           ⚠ 必须放在**任何写动作之前**: 否则第二次提交会把第一座的配额/落点又算一遍。
           ⚠ v2 起一个账号有多行 ⇒ 按 (Account,Round,IdemKey) 在**全部行**里找,
             不能再拿 (Account,Round) 当唯一键 (那会把附属城镇的回放记到主宗头上)。 */
        if (!string.IsNullOrEmpty(idemKey))
        {
            var replayRow = _sects.FindByIdemKey(account ?? "", cur.Round, idemKey);
            if (replayRow != null && !string.IsNullOrEmpty(replayRow.Resp))
            {
                try
                {
                    var replay = JsonSerializer.Deserialize<PlaceCommitResponse>(replayRow.Resp);
                    if (replay != null) { replay.Seq = seq; return replay; }
                }
                catch { /* 回放失败则照常重做 */ }
            }
        }

        /* 判据 2~7: 与 check 同一份实现 (不做两套判据!)
           ⚠ excludeId 只在**立宗档**传 (原地重建时豁免自己那座);
             扩张档**必须为空** —— 本宗正是那条"领地"约束的来源, 豁免了就等于
             "可以贴着自己的宗门建", 10 格辖域会退化成"哪都能建"。 */
        var chk = CheckCore(cur, seed, account, authed, q, r,
                            expand ? null : main?.Id, kind, seq);
        if (!chk.Ok)
        {
            resp.Reason = chk.Reason;
            resp.Err = chk.Err;
            return resp;
        }
        /* 判据 9: 名字 1~12 字 (在动引擎之前判 —— 别把坏名字写进 ext 层) */
        var n2 = (name ?? "").Trim();
        if (n2.Length < 1 || n2.Length > PlaceNameMax)
        {
            resp.Reason = "bad_name";
            resp.Err = $"{KindLabel(kind)}名需 1~{PlaceNameMax} 字";
            return resp;
        }
        var t2 = Math.Clamp(tier, 1, 3);

        /* ⑧ 全局提交闸 (只卡**贵的那条路**)。
           为什么是全局而非每账号: demo 鉴权下「任意非空账号即登录」⇒ 每账号限流挡不住
           「换账号刷」; 而这条路的成本是 ~450ms 的**同步 A*** —— 一次几座就会把 V8 门闩
           占满, 连带 Chunk/Region 请求全部排队。
           为什么放在这里而不是传输层: 上面的幂等回放与配额拒绝都**不碰 V8**, 不该被闸
           误伤 (放传输层会把「狂点确认键」的第二次也挡掉)。
           ⚠ 用 Interlocked 而不是 lock: 高频失败路径上不要引入争用。 */
        var nowMs = Environment.TickCount64;
        var last = Interlocked.Read(ref _lastPlaceCommitMs);
        if (last != 0 && nowMs - last < PlaceCommitMinGapMs)
        {
            resp.Reason = "too_frequent";
            resp.Err = "卜居过于频繁, 请稍候再试";
            return resp;
        }
        Interlocked.Exchange(ref _lastPlaceCommitMs, nowMs);

        /* 步 1~6: 引擎侧落点 + 清派生状态 + 同步重算受影响区域道路 + roadVer+1
           (一次 V8 调用, 全程持锁 —— 见 mapgen-server.js commitPlace 的头注释)
           ⚠ 扩张档的 aq/ar/maxR 由服务端填 (取自上面那份台账), 前端给不了;
             引擎侧 commitPlace 的步 0 还会**独立复判**一次 (白名单 + 半径)。 */
        var optsJson = expand
            ? JsonSerializer.Serialize(new
            {
                type = kind, tier = 1, name = n2, owner = account ?? "",
                aq = main!.Q, ar = main!.R, maxR = ExpandR(seed),
            })
            : JsonSerializer.Serialize(new
            {
                type = "sect", tier = t2, name = n2, owner = account ?? "", maxR = 0,
            });
        string json;
        using (var lease = World(seed))
            json = lease.Vm.Call("commitPlace", q, r, optsJson);
        using var d = JsonDocument.Parse(json);
        var rt = d.RootElement;
        /* 引擎侧的二次校验可能否掉本次 (too_far / bad_type) ⇒ 必须显式处理,
           否则会把 null 当成功继续往下走 (静默落库一条不存在的聚落)。 */
        if (!rt.TryGetProperty("ok", out var okEl) || okEl.GetInt32() != 1)
        {
            resp.Reason = rt.TryGetProperty("reason", out var rEl)
                ? (rEl.GetString() ?? "bad_type") : "bad_type";
            resp.Err = "落点未通过引擎复判";
            return resp;
        }
        var stEl = rt.GetProperty("st");
        var st = new SettlementDto
        {
            Id = stEl.GetProperty("id").GetString() ?? "",
            Type = stEl.GetProperty("type").GetString() ?? "sect",
            Q = stEl.GetProperty("q").GetInt32(),
            R = stEl.GetProperty("r").GetInt32(),
            X = F(stEl, "x"),
            Y = F(stEl, "y"),
            Name = stEl.GetProperty("name").GetString() ?? "",
            Pop = stEl.GetProperty("pop").GetInt32(),
            Owner = stEl.TryGetProperty("owner", out var ow) && ow.ValueKind == JsonValueKind.String
                ? ow.GetString() ?? "" : "",
            Tier = stEl.GetProperty("tier").GetInt32(),
            State = stEl.GetProperty("state").GetInt32(),
            ExpireTs = stEl.GetProperty("expireTs").GetInt64(),
        };
        var regions = ReadPairs(rt.GetProperty("regions"));
        var blocks = ReadPairs(rt.GetProperty("blocks"));
        var roadVer = rt.GetProperty("roadVer").GetInt64();
        var ms = rt.GetProperty("ms").GetInt32();
        var nRoad = rt.GetProperty("nRoad").GetInt32();

        /* 步 7: 落库 (独立表 PlayerSect, 见 PlayerSectStore 头注释)
           SectId: 主宗自己留空; 附属城镇记住它挂在哪座主宗上 —— 将来「按宗门等级限制
           附属数量」要用它数, 而这正是**唯一正确**的口径 (per-宗 而不是 per-账号)。 */
        var row = new PlayerSectEntry
        {
            Account = account ?? "", Round = cur.Round, IdemKey = idemKey ?? "",
            Id = st.Id, Type = st.Type, Q = st.Q, R = st.R, Name = st.Name,
            Pop = st.Pop, Owner = st.Owner, Tier = st.Tier, State = st.State, ExpireTs = st.ExpireTs,
            SectId = expand ? (main?.Id ?? "") : "",
        };
        row.Json = PlayerSectStore.BuildJson(row);
        _sects.Put(row);

        /* 缓存失效 + 脏块 Bump + roadVer 观测 + tile 世代前进 */
        ApplyPlaceChange(seed, regions, blocks, roadVer);

        resp.Ok = true;
        resp.Sect = st;
        resp.RegionI = rt.GetProperty("regionI").GetInt32();
        resp.RegionJ = rt.GetProperty("regionJ").GetInt32();
        resp.RoadVer = roadVer;
        resp.Ms = ms;
        resp.Roads = nRoad;
        resp.Towns = _sects.CountTowns(account ?? "", cur.Round);
        resp.Places = _sects.CountOf(account ?? "", cur.Round) + resp.Towns;
        foreach (var (ca, cb) in blocks) resp.Blocks.Add(new BlockRef { Ca = ca, Cb = cb });

        /* 幂等回放记录 (放最后: 只有真正成功才记; 按**这一座**的 id 落, 见 store 注释) */
        try { _sects.PutResp(account ?? "", cur.Round, st.Id, idemKey ?? "",
                             JsonSerializer.Serialize(resp)); }
        catch (Exception ex) { Console.Error.WriteLine("[MapWorldService] 幂等响应落库失败: " + ex.Message); }
        return resp;
    }

    /// <summary>类型 → 中文标签 (只用于文案; 白名单校验不在这里)。</summary>
    private static string KindLabel(string kind) => kind switch
    {
        "town" => "城镇",
        "village" => "村落",
        "fishing" => "渔村",
        _ => "宗门",
    };

    /// <summary>登录时回填「我的聚落」(主宗 + 附属城镇) —— 见 LoginResponse.MyPlaces 的注释。
    /// 无持久化 / 该账号在本世还没立宗 ⇒ 空列表 (前端照常显示「尚未择地立宗」)。
    /// ⚠ 只回**当前世**的资产: 退场世的数据绝不能漏出去 (前端会当真)。</summary>
    public (List<SettlementDto> Places, int TownMax) MyPlaces(string? account)
    {
        var outList = new List<SettlementDto>();
        if (!string.IsNullOrEmpty(account))
        {
            var cur = _ledger.Current();
            foreach (var e in _sects.ByAccount(account, cur.Round))
            {
                outList.Add(new SettlementDto
                {
                    Id = e.Id, Type = e.Type, Q = e.Q, R = e.R,
                    Name = e.Name, Pop = e.Pop, Owner = e.Owner, Tier = e.Tier,
                    State = e.State, ExpireTs = e.ExpireTs,
                });
            }
        }
        return (outList, _sects.TownMaxPerSect);
    }

    /// <summary>一次落点的服务端缓存失效 (方案 §3.4/§3.6 明确要求的那一套)。
    /// ⚠ 四件事缺一不可, 少任何一件都是**静默故障** (不报错、只表现为"放下去没反应"):
    ///   ① 区域包 / 足迹包按键作废 (内存三级 + **SQLite** —— settle 包是落库的,
    ///      只清 _mem 会在被淘汰后经 ReadSqlBackfill 把旧包捞回来);
    ///   ② blockLayersJson 结果整表作废 (它现在依赖 ext 层, 见 mapgen-server 的同名注释);
    ///   ③ 脏块 BumpBlockRev (让下次请求携带旧 rev ⇒ 服务端重发可变图层);
    ///   ④ roadVer 观测 + tile 世代前进 (tileJson 的 onRoad/place 都变了)。
    /// ⚠ **只做 ③ 是不够的**: 前端对**已加载**的块不会自动重拉 (main.js updateStreaming
    ///   的入队条件是 `!chunkData.has(key)`), 所以PlaceCommitResponse.Blocks 也必须回给前端。 </summary>
    private void ApplyPlaceChange(
        string seed, (int, int)[] regions, (int, int)[] blocks, long roadVer)
    {
        foreach (var (i, j) in regions)
        {
            EvictWithGate(seed, i, j);
        }
        _blockLayersCache.Clear();

        const TileMask hot = TileMask.Region | TileMask.Settle | TileMask.Poi | TileMask.Comm;
        foreach (var (ca, cb) in blocks) BumpBlockRev(seed, ca, cb, hot);

        ObserveRoadVer(WorldKeys.SeedPrefix(seed), roadVer);
        Interlocked.Increment(ref _placeVer);
    }

    /* 按键作废 + 与 BuildOnce 的 per-key 门闩互斥:
       若此刻正有一条 GetRegionBytes 在算这个 key, 我们**等它算完再删** ——
       否则它的产物会在我们删完之后被写回缓存 (旧包复活)。 */
    private void EvictWithGate(string seed, int i, int j)
    {
        var rk = WorldKeys.Region(seed, i, j);
        var sk = WorldKeys.Settle(seed, i, j);
        foreach (var key in new[] { rk, sk })
        {
            var gate = _buildGates.GetOrAdd(key, _ => new object());
            lock (gate)
            {
                _regionHot.Remove(key);
                _regionPackCache.Remove(key);
                _settlePackCache.Remove(key);
                _mem.DeleteByKey(key);
                _sql?.DeleteDeferred(key);
            }
            /* ⚠ 刻意**不** TryRemove 这个 gate: 留着它作为「后续 build 的会合点」,
               下一次 BuildOnce 用同一把锁, 就与本次作废形成全序。 */
        }
    }

    /* T3: 后台维护 — 周期排空写队列 + 清理「非活跃 seed」的历史缓存行
       (世界可按 seed 确定性重建, 属安全缓存清理)。不依赖 /stats 请求节奏。 */
    private async Task MaintenanceLoopAsync()
    {
        try
        {
            while (!_maintCts.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMinutes(2), _maintCts.Token).ConfigureAwait(false);
                try
                {
                    _sql?.Flush();
                    if (_sql != null && _host.Count > 0)
                    {
                        var prefixes = new List<string>();
                        foreach (var seed in _host.Seeds)
                            prefixes.Add("w:" + WorldKeys.SeedPrefix(seed) + ":");
                        /* P3: 仅当「确有某个曾出现过的世界已被淘汰」时才清理 —
                           否则 DELETE ... NOT(...LIKE OR...) 每 2 分钟白扫全表。
                           _seenSeedPrefixes 在 World() 处登记; 一旦某前缀不再活跃
                           (= 该世界被 LRU 淘汰), 才有无主行需要删除。 */
                        bool stale = false;
                        foreach (var p in _seenSeedPrefixes.Keys)
                            if (!prefixes.Contains(p)) { stale = true; break; }
                        if (stale)
                        {
                            _sql.PruneExcept(prefixes);
                            _seenSeedPrefixes.Clear();      // 已淘汰者的行已删, 记忆重置为当前活跃集
                        }
                        foreach (var p in prefixes) _seenSeedPrefixes.TryAdd(p, 0);
                    }
                    /* C5: _blockRev 无别的淘汰路径 (每块一条 key), 长期漫游不同 seed 会线性增长
                       → 按活跃 seed 前缀裁剪。被裁掉的只是「脏标记」, 通知客户端下一次
                       全量拉取即可自愈, 不影响正确性。 */
                    if (_host.Count > 0)
                    {
                        var live = new List<string>();
                        foreach (var seed in _host.Seeds) live.Add("blk:" + WorldKeys.SeedPrefix(seed) + ":");
                        foreach (var k in _blockRev.Keys)
                        {
                            var keep = false;
                            for (var li = 0; li < live.Count; li++)
                                if (k.StartsWith(live[li], StringComparison.Ordinal)) { keep = true; break; }
                            if (!keep) _blockRev.TryRemove(k, out _);
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[MapWorldService] 维护任务异常(下轮重试): " + ex.Message);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private void Store(string key, byte[] gz)
    {
        _mem.SetData(key, gz);
        _sql?.SetDataDeferred(key, gz);     // P6: 冷生成异步批量落库, 不阻塞请求路径
    }

    private static byte[] B64(JsonElement e, string name)
        => Convert.FromBase64String(e.GetProperty(name).GetString() ?? "");

    private static byte[] Slice(byte[] src, int offset, int len)
    {
        if (len <= 0) return [];
        var dst = new byte[len];
        Buffer.BlockCopy(src, offset, dst, 0, len);
        return dst;
    }

    private static float F(JsonElement e, string name)
        => e.GetProperty(name).GetSingle();

    public void Dispose()
    {
        _maintCts.Cancel();
        try { _maintTask.Wait(1000); } catch { /* 忽略 */ }
        _host.Dispose();
        _sql?.Flush();              // P6: 退出前排空批量写入, 尽量落库
        _sql?.Dispose();
        _ledger.Dispose();
        _sects.Dispose();
        /* ★ 子系统台账的释放交给注册表 —— Core 不认识具体子系统类型。
           ⚠ 必须在 _sql.Dispose() **之前**: 各子系统用的是独立的连接串 (同库不同表),
             但它们自己 flush; 这里只保证「先关子系统, 再关地图缓存」。 */
        _subsystems.Dispose();
        _mem.Dispose();
        _maintCts.Dispose();
    }
}
