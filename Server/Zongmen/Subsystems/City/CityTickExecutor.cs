using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Zongmen.Engine;
using Zongmen.Services;
using Zongmen.Time;

namespace Zongmen.Subsystems.City;

/* ============================================================
 * 城市迭代子系统 · Tick 执行器 (docs/游戏时钟与Tick演化框架方案.md §五)
 * ------------------------------------------------------------
 * 职责: 把 tick 泵投递的一个 <see cref="TickBatch"/> 变成「世界状态的变更」。
 *   ① TownEvolve  —— 城内演化 (Verhulst 人口 / 库存 / tier / 建筑 / 事件态),
 *                     由引擎 `Subsystems/City/js/city-evo.js` 的 evolveCityJson 纯计算;
 *   ② TradeEdge   —— 城际价格套利 (搬运库存), 由同一文件的 tradeEdgesJson 算边;
 *   ③ 其它 kind   —— 本执行器**不认领** (回 not-claimed, 交给别的执行器/下一期)。
 *
 * ★ 两个 VM Scope 的分工 (2026-10-11 目录重构):
 *     · "core" (世界层) —— 只用 `citySettlementsJson` 读聚落身份表:
 *       它带 type/q/r, 且是 ext(玩家宗门) 感知的 ⇒ 归世界层所有。
 *     · "city" (本子系统) —— 演化与贸易的全部计算。**长任务在这里跑**,
 *       因此不再占住世界层的 V8 门闩 (人类请求不再被 tick 拖慢)。
 *   ⚠ 两把门闩**不嵌套持有**: 先借 core 收完清单并释放, 再借 city 建行/演化
 *     (见 EnsureInitialized)。嵌套持有会在将来任何「先 city 后 core」的路径上死锁。
 *
 * ⚠ 三条红线 (与 city-evo.js 文件头一致, 破任何一条都是静默错):
 *   R1. 绝不写 seed 纯函数层 (chunk/settleCache/townCache/siteScore/prospect/region)。
 *       演化只写 <see cref="CityStateStore"/> (独立台账) + 派生显示层 (settle 包 rev)。
 *   R2. 只走引擎的**只读**出口 (evolveCity/meta/craft/spirit/router 都是纯函数)。
 *   R3. Δ 铁律: 一切以 `job.DtTicks` 积分, 绝不写「+1 步」式演化 (漏了不报错, 只是
 *       停摆几天后人口曲线变慢, 极难发现)。
 *
 * ⚠ 为什么改的是「派生层」却仍要 MarkSettleDirty:
 *   客户端拿到的 settle 包里有聚落人口/等级 (SettleTownDto.Pop/Tier)。
 *   不推进 rev + 不作废包 ⇒ 客户端带旧 lastRevs 重拉被判「未变化」⇒
 *   **画面人口永远停在初始值** (不报错)。这是本执行器唯一会碰的写世界动作。
 * ============================================================ */
public sealed class CityTickExecutor : ITickExecutor
{
    private readonly MapWorldServiceAccessor _world;
    private readonly CityStateStore _store;
    private readonly TickOptions _opt;
    private readonly ILogger _log;

    /// <summary>本执行器认领的 job 种类 (TickExecutorHub 据此分发; 其余一律不认领)。</summary>
    public IReadOnlyList<TickJobKind> Claims { get; } = new[]
    {
        TickJobKind.TownEvolve,
        TickJobKind.TradeEdge,
    };

    /* ---- 诊断计数 (StatsJson / 判据读) ---- */
    private long _evolvedCities;
    private long _tradesSettled;
    private long _migrations;
    private long _cacheHits;
    private long _initialized;

    public string Name => "city";
    public long EvolvedCities => Interlocked.Read(ref _evolvedCities);
    public long TradesSettled => Interlocked.Read(ref _tradesSettled);
    public long Migrations => Interlocked.Read(ref _migrations);
    public long InitializedCities => Interlocked.Read(ref _initialized);
    public long CacheHits => Interlocked.Read(ref _cacheHits);

    public CityTickExecutor(MapWorldService world, CityStateStore store, TickOptions opt,
                            ILogger<CityTickExecutor> log)
    {
        /* ⚠⚠ 这里**绝不能**再注入 TickPump —— 那是一条 DI 循环:
                  TickPump → ITickExecutor → TickPump
           而且因为它走的是 factory lambda 里的 GetRequiredService, **绕过了容器的循环检测**,
           表现为**永久静默挂死** (进程活着、不监听端口、零日志), 而不是抛异常。
           2026-09-27 实测: `dotnet run` 卡在「正在生成」, 后端 8140 起不来 —— 就是这个。
           ⇒ 本类不需要 pump: 它只写自己的台账 + 派生层, 归谁调度由外层决定。 */
        _world = new MapWorldServiceAccessor(world);
        _store = store;
        _opt = opt;
        _log = log;
    }

    public TickRunReport Execute(TickBatch batch, long nowTick, TickMetrics metrics, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var outcomes = new List<TickOutcome>(batch.Count);

        /* 本执行器只处理 TownEvolve (城演化) 与 TradeEdge (贸易)。
           其它 kind 原样回报「未认领」, 让上层能看到「有 job 没人管」而不是静默吞掉。
           (Hub 已经分发过一次, 这里的过滤是「本类单机可用」的兜底。) */
        var mine = new List<TickJob>(batch.Count);
        foreach (var j in batch.Jobs)
        {
            if (Claims.Contains(j.Kind)) mine.Add(j);
            else outcomes.Add(new TickOutcome(j, false, "not-claimed-by-city", 0, 0, 0));
        }
        if (mine.Count == 0) return Report(nowTick, outcomes, sw, batch.Count);

        var seed = mine[0].Seed;
        var round = mine[0].Round;

        /* ① 初始化: 台账里没有的聚落先建行 (首批 job 到达时必然为空)。
           ⚠ 必须用 `cityNewStateJson` 而不是 C# 侧自造 —— 初值的所有字段 (popF/baseAge/
           builtFrac/…) 都必须与引擎演化器同一口径, 否则第一次演化就会算出不同结果。 */
        EnsureInitialized(seed, round);

        /* ② 逐 job 处理。⚠ 单个 job 失败**不得**中断整批:
           记 outcome.Fail ⇒ 泵会退避重试, 其它 job 照常推进。
           ⚠ 落库**成批**做（下方 ②b 的 PutRange）: 逐行 Put 每行开一次连接 + 一次隐式事务,
             而 PutRange 的注释明确写着「逐行各自开事务在 90 tick × 数百城的量级上会把 WAL 打满」。 */
        var pendingRows = new List<CityStateRow>(mine.Count);
        var dirtyRegions = new HashSet<(int I, int J)>();
        using (var lease = _world.LeaseScope(CityModule.CityScope, seed))
        {
            var vm = lease.Vm;
            foreach (var job in mine)
            {
                var jsSw = Stopwatch.StartNew();
                int bytesIn = 0, bytesOut = 0;
                try
                {
                    var dt = Math.Max(0, job.DtTicks);
                    string rowJson;
                    switch (job.Kind)
                    {
                        case TickJobKind.TownEvolve:
                            rowJson = EvolveOne(vm, round, job.EntityId, dt, metrics, ref bytesIn, ref bytesOut);
                            break;
                        case TickJobKind.TradeEdge:
                            rowJson = "";    // 贸易是「批级」动作 (见 Step③), 单 job 只负责触发
                            break;
                        default:
                            rowJson = "";
                            break;
                    }
                    if (rowJson.Length > 0)
                    {
                        var row = CityStateStore.FromEngineJson(round, rowJson);
                        pendingRows.Add(row);
                        var (i, j) = RegionOf(row.Id);
                        if (i.HasValue && j.HasValue) dirtyRegions.Add((i.Value, j.Value));
                    }
                    outcomes.Add(new TickOutcome(job, true, null, jsSw.Elapsed.TotalMilliseconds, bytesIn, bytesOut));
                }
                catch (Exception ex)
                {
                    outcomes.Add(new TickOutcome(job, false, $"{ex.GetType().Name}: {ex.Message}",
                        jsSw.Elapsed.TotalMilliseconds, bytesIn, bytesOut));
                    _log.LogWarning(ex, "[tick] city 处理失败 {Key}", job.Key);
                }
            }
        }

        /* ②b 落库 + 脏块通知（批级）。
           ⚠ 落库用一次事务（PutRange），不是逐行 Put。
           ⚠ 脏块通知用 **job 的 seed**（而非 `_world.CurrentSeed()`）—— 换世竞态下后者已是
             新世，会拿它给新世某块打上「内容并未变化」的脏 rev；seed 为空时直接跳过。 */
        if (pendingRows.Count > 0) _store.PutRange(pendingRows);
        if (!string.IsNullOrEmpty(seed))
            foreach (var (i, j) in dirtyRegions) _world.MarkSettleDirty(seed, i, j);

        /* ③ 贸易 (批级): 本批若有 TradeEdge, 就用**当前全部城市**重算一次价格层并结算搬运。
           ⚠ 为什么批级而不是 per-job: 贸易是城际双边动作, 边集合本身是全局的
             (arbitrageEdges 需要全部城的价); 按单城 job 去算会看到残缺的价表 ⇒
             算出的边与全量算出的不同 ⇒ 两台服务器跑出不同世界。 */
        if (mine.Exists(j => j.Kind == TickJobKind.TradeEdge))
        {
            try { SettleTrade(seed, round, metrics); }
            catch (Exception ex) { _log.LogWarning(ex, "[tick] city 贸易结算失败 (下一轮重试)"); }
        }

        return Report(nowTick, outcomes, sw, batch.Count);
    }

    /// <summary>组包 (Outcomes 是只读集合 ⇒ 用 AddRange 而不是初始化器)。</summary>
    private static TickRunReport Report(long nowTick, List<TickOutcome> outcomes, Stopwatch sw, int total)
    {
        var r = new TickRunReport { TickId = nowTick, TotalMs = sw.Elapsed.TotalMilliseconds };
        r.Outcomes.AddRange(outcomes);
        r.Skipped = total - outcomes.Count(o => o.Ok || o.Error != "not-claimed-by-city");
        return r;
    }

    /* ============================================================
     * ① 初始化: 台账缺行的聚落按引擎初值建行
     *     ⚠ 两趟走, **两把门闩不嵌套持有**:
     *        趟 1 (core scope) 收「身份表」→ 释放; 趟 2 (city scope) 建行 → 释放。
     * ============================================================ */
    private void EnsureInitialized(string seed, int round)
    {
        /* 遍历当前区域格窗口 (与 v2 方案 §4.1 一致: 演化只覆盖「活跃窗口」,
           ⚠ 不做无限世界全量演化 —— 那是 O(∞) 且绝大多数城永远不会被看到)。 */
        var span = Math.Max(1, _opt.EvolveSpanRegions);
        var pending = new List<(string Id, string Type, int Q, int R, int Pop, int Tier)>();

        using (var lease = _world.LeaseScope(WorldModule.WorldScope, seed))
        {
            var vm = lease.Vm;
            for (var i = -span; i <= span; i++)
            {
                for (var j = -span; j <= span; j++)
                {
                    /* ⚠ 用 citySettlementsJson 而不是 settleJson —— 后者**不带 type/q/r**
                       (它是给前端画图的包)。用 settleJson 会让 type="" ⇒ 城被当村算
                       ⇒ K 塌到 K_MIN ⇒ 人口永远停在 30 且**不报错** (实测踩过)。 */
                    var json = vm.Call("citySettlementsJson", i, j);
                    using var d = JsonDocument.Parse(json);
                    if (!d.RootElement.TryGetProperty("settlements", out var towns) ||
                        towns.ValueKind != JsonValueKind.Array) continue;
                    foreach (var t in towns.EnumerateArray())
                    {
                        var id = t.TryGetProperty("id", out var idv) ? idv.GetString() ?? "" : "";
                        if (id.Length == 0) continue;
                        /* ⚠ 自愈: 2026-10-10 之前落库的行 **Type 全为空** (身份三字段没往返,
                           见 CityStateStore.ToEngineJson) —— 那样的行会让「城被当村算」
                           (K 塌到 K_MIN, 人口永远停在 30 且不报错) 永久化。
                           ⇒ 只把「Type 非空」当已初始化; 空 Type 的行按当前骨架重建。 */
                        var existing = _store.Get(round, id);
                        if (existing != null && !string.IsNullOrEmpty(existing.Type))
                        { Interlocked.Increment(ref _cacheHits); continue; }
                        var type = t.TryGetProperty("type", out var tyv) && tyv.ValueKind == JsonValueKind.String
                            ? tyv.GetString() ?? "" : "";
                        if (type == "poi") continue;        // 秘境不演化 (v2 Q3)
                        var q = t.TryGetProperty("q", out var qv) ? qv.GetInt32() : 0;
                        var r = t.TryGetProperty("r", out var rv) ? rv.GetInt32() : 0;
                        var pop = t.TryGetProperty("pop", out var pv) ? pv.GetInt32() : 0;
                        var tier = t.TryGetProperty("tier", out var tv) ? tv.GetInt32() : 1;
                        pending.Add((id, type, q, r, pop, tier));
                    }
                }
            }
        }
        if (pending.Count == 0) return;

        using (var lease = _world.LeaseScope(CityModule.CityScope, seed))
        {
            var vm = lease.Vm;
            /* ⚠ 成批落库（一次事务）——与演化主路径口径一致，见 Execute ②b。 */
            var rows = new List<CityStateRow>(pending.Count);
            foreach (var p in pending)
            {
                var stJson = vm.Call("cityNewStateJson", p.Id, p.Type, p.Q, p.R, p.Pop, p.Tier, 0);
                rows.Add(CityStateStore.FromEngineJson(round, stJson));
                Interlocked.Increment(ref _initialized);
            }
            if (rows.Count > 0) _store.PutRange(rows);
        }
    }

    /* ============================================================
     * ② 单城演化
     * ============================================================ */
    private string EvolveOne(JsVm vm, int round, string id, int dt,
                             TickMetrics metrics, ref int bytesIn, ref int bytesOut)
    {
        var cur = _store.Get(round, id);
        if (cur == null) return "";     // 不在台账 (如刚被拆) ⇒ 跳过, 由下一轮初始化补

        var stateJson = CityStateStore.ToEngineJson(cur);
        bytesIn += stateJson.Length;

        /* 元数据 (骨架产出 + 需求表) —— 每次演化前现取。
           ⚠ 不做 C# 侧缓存: 骨架产出是 seed 纯函数, 引擎的 growTownFootprint 已 memo,
             在 C# 再存一份等于把「同一事实存两处」, 是将来对不上的根源。 */
        var metaJson = vm.Call("cityMetaJson", id, cur.Type, cur.Q, cur.R);

        using (metrics.BeginJs(TickJobKind.TownEvolve))
        {
            var outJson = vm.Call("cityEvolveJson", stateJson, metaJson, dt, KPolicyArg);
            bytesOut += outJson.Length;
            Interlocked.Increment(ref _evolvedCities);
            return outJson;
        }
    }

    /// <summary>K 基期策略 (与 city-evo.js 的 E.K_POLICY 同值; 逐城可被 JobSpec.Payload 覆盖, P2 暂用全局)。</summary>
    private const string KPolicyArg = "freeze";

    /* ============================================================
     * ③ 贸易结算 (批级): 重算全城价格层 → 算边 → 搬运库存
     *     ⚠ 只搬运**库存** (半守恒), 不动人口 —— 人口迁移在 v3 是独立层 (P2 暂未开)。
     * ============================================================ */
    private void SettleTrade(string seed, int round, TickMetrics metrics)
    {
        var rows = _store.ByRound(round);
        if (rows.Count < 2) return;

        /* 组装价格层入参: [{id,type,q,r,pop,tier,builtCount}] */
        var nodes = new List<string>(rows.Count);
        foreach (var e in rows)
        {
            nodes.Add($"{{\"id\":{JsStr(e.Id)},\"type\":{JsStr(e.Type)}," +
                      $"\"q\":{e.Q},\"r\":{e.R},\"pop\":{e.Pop}," +
                      $"\"tier\":{e.Tier},\"builtCount\":{BuiltCount(e.Built)}}}");
        }
        var nodesJson = "[" + string.Join(",", nodes) + "]";

        using var lease = _world.LeaseScope(CityModule.CityScope, seed);
        var vm = lease.Vm;
        using (metrics.BeginJs(TickJobKind.TradeEdge))
        {
            var priced = vm.Call("cityPriceLayerJson", nodesJson, "[]");
            var edges = vm.Call("cityTradeEdgesJson", priced, 40);
            using var ed = JsonDocument.Parse(edges);
            var n = ed.RootElement.GetArrayLength();
            if (n == 0) return;

            /* 结算: 由 C# 侧按边搬运 stock (引擎只算边, 不持有库存)。
               ⚠ 必须按**边**处理 (同一条边不能被重复扣), 与 v2 一致。 */
            var moved = new List<(string From, string To, string Res, double Amt)>();
            foreach (var e in ed.RootElement.EnumerateArray())
            {
                var fromId = e.GetProperty("from").GetString() ?? "";
                var toId = e.GetProperty("to").GetString() ?? "";
                var res = e.GetProperty("resource").GetString() ?? "";
                var amt = e.GetProperty("amount").GetDouble();
                if (fromId.Length == 0 || toId.Length == 0 || res.Length == 0 || amt <= 0) continue;
                moved.Add((fromId, toId, res, amt));
            }
            if (moved.Count == 0) return;

            var touched = new Dictionary<string, CityStateRow>(StringComparer.Ordinal);
            foreach (var m in moved)
            {
                var f = touched.TryGetValue(m.From, out var a) ? a : _store.Get(round, m.From);
                var t = touched.TryGetValue(m.To, out var b) ? b : _store.Get(round, m.To);
                if (f == null || t == null) continue;
                var stock = ParseStock(f.Stock);
                var tstock = ParseStock(t.Stock);
                var carry = Math.Min(m.Amt, stock.TryGetValue(m.Res, out var have) ? have : 0);
                if (carry <= 0) continue;
                stock[m.Res] = (stock.TryGetValue(m.Res, out var sv) ? sv : 0) - carry;
                tstock[m.Res] = (tstock.TryGetValue(m.Res, out var tv2) ? tv2 : 0) + carry;
                f.Stock = StockJson(stock);
                t.Stock = StockJson(tstock);
                touched[m.From] = f;
                touched[m.To] = t;
            }
            if (touched.Count > 0) _store.PutRange(touched.Values);
            Interlocked.Add(ref _tradesSettled, moved.Count);
        }
    }

    /* ============================================================
     * 落库 + 脏块通知
     * ------------------------------------------------------------
     * ⚠ 落库口径 = **批级 PutRange**（一次事务），不再逐行 Put —— 见 Execute ②b 与 EnsureInitialized。
     *   逐行 Put 每行开一次连接 + 一次隐式事务，PutRange 的注释明确写着那会把 WAL 打满。
     * ⚠ 脏块通知用 **job 的 seed**（而非 `_world.CurrentSeed()`）: 换世竞态下后者已是新世,
     *   拿它去 MarkSettleDirty 会给新世某块打上「内容并未变化」的脏 rev（且它同时会清人物缓存）。
     * ============================================================ */

    /* ---------- 小工具 ---------- */

    /// <summary>从聚落 id `{i}_{j}_u{n}` 反解区域格; 形态不合法返回 null (只跳过脏块通知, 不抛)。</summary>
    private static (int? I, int? J) RegionOf(string id)
    {
        var p = id.Split('_');
        if (p.Length < 2) return (null, null);
        var i = int.TryParse(p[0], out var a) ? a : (int?)null;
        var j = int.TryParse(p[1], out var b) ? b : (int?)null;
        return (i, j);
    }

    /// <summary>⚠ type 由建行时从引擎写入 (CityStateRow.Type), **不做反解** ——
    /// 它是 seed 纯函数结论, 反解必然错 (如"城"与"镇"从 id 看不出来), 会让
    /// craftOutput(加工业) 与骨架容量取到错档位 (静默错值, 不报错)。</summary>

    private static int BuiltCount(string builtJson)
    {
        if (string.IsNullOrEmpty(builtJson) || builtJson == "[]") return 0;
        try
        {
            using var d = JsonDocument.Parse(builtJson);
            return d.RootElement.ValueKind == JsonValueKind.Array ? d.RootElement.GetArrayLength() : 0;
        }
        catch { return 0; }
    }

    private static Dictionary<string, double> ParseStock(string stockJson)
    {
        var o = new Dictionary<string, double>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(stockJson)) return o;
        try
        {
            using var d = JsonDocument.Parse(stockJson);
            foreach (var p in d.RootElement.EnumerateObject())
                o[p.Name] = p.Value.ValueKind == JsonValueKind.Number ? p.Value.GetDouble() : 0;
        }
        catch { /* 坏 JSON ⇒ 当空库存 (不抛: 贸易不该因一行坏数据停摆) */ }
        return o;
    }

    private static string StockJson(Dictionary<string, double> o)
    {
        var sb = new System.Text.StringBuilder("{");
        var first = true;
        foreach (var kv in o)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JsStr(kv.Key)).Append(':').Append(
                kv.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
        }
        return sb.Append('}').ToString();
    }

    private static string JsStr(string s)
        => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}

/* ⚠ 为什么包一层: TickPump 与 MapWorldService 互相需要对方的引用 (pump 要读世界状态,
   world 要借 VM), 直接构造注入会成环。用 accessor 把「取用」推迟到运行期。 */
public sealed class MapWorldServiceAccessor
{
    private readonly MapWorldService _svc;
    public MapWorldServiceAccessor(MapWorldService svc) => _svc = svc;
    public JsVmPool.VmLease LeaseScope(string scope, string seed) => _svc.LeaseScope(scope, seed);
    public string SettlementsForJson(JsVm vm, int i, int j) => _svc.SettlementsForJson(vm, i, j);
    public void MarkSettleDirty(string seed, int i, int j) => _svc.MarkSettleDirty(seed, i, j);
    public string? CurrentSeed() => _svc.CurrentSeed();
    public int CurrentRound() => _svc.CurrentRound();
}
