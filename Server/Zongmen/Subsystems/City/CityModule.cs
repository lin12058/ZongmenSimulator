using Zongmen.Engine;

namespace Zongmen.Subsystems.City;

/* ============================================================
 * 城市迭代子系统 · V8 模块 (scope = "city")
 * ------------------------------------------------------------
 * 认领的出口 = **纯演化计算** (不需要 ext 层, 不碰渲染):
 *     cityNewStateJson / cityMetaJson / cityEvolveJson
 *     cityPriceLayerJson / cityTradeEdgesJson / cityMigrateEdgesJson
 *     cityHarvestBuildJson / cityConstantsJson
 *
 * ★ 为什么它要**独立 VM** (而不是继续借世界层那个):
 *   原先 tick 执行器复用读路径 VM ⇒ 与人类请求共用同一把 V8 `_gate`
 *   (V8 单线程, 门闩是全局的) ⇒ 演化窗口一大就明显拖慢 tile/region 请求。
 *   这正是 docs/游戏时钟与Tick演化框架方案.md §6.7 承诺的「零门闩争用」,
 *   也是 待办事项/Tick框架开发进度.md 第 17 条记的未兑现项。
 *
 * ⚠ 脚本清单与世界层**逐字节相同** (含 mapgen-server.js):
 *   骨架产出 (growTownFootprint) 同时受 ext(玩家宗门) 层影响 ⇒ 两个 VM 必须有
 *   相同的脚本 + 相同的 ext 注入, 否则演化算出的足迹与渲染画出的足迹会漂移
 *   (静默错值, 不报错)。代价 = 多一份引擎常驻内存 + 一次冷启, 换来零争用。
 *
 * ⚠ 越界出口一律**显式抛**: 渲染/落点类出口不在这里 (它们在 WorldModule)。
 *   这样「谁负责哪个出口」在代码里是可读的, 而不是散在一个巨型 switch 里。
 * ============================================================ */
public sealed class CityModule : JsvmModule
{
    public const string CityScope = "city";

    public override string Scope => CityScope;
    public override string RootMember => "CityEvo";

    private readonly string[] _files;

    public CityModule(string engineJsDir, string cityJsDir)
        => _files = JsvmBundles.WorldBacked(engineJsDir, cityJsDir);

    public override IReadOnlyList<string> Files => _files;

    /// <summary>与世界层脚本逐字节相同 (含 mapgen-server.js) ⇒ 同样接收 ext 注入
    /// (否则骨架产出漂移 —— 见文件头「两个 VM 各持一份 ext」的警告)。</summary>
    public override bool AcceptsExternalSettlements => true;

    /// <summary>与世界层同一口径的初始化 (= MapGen.init(seed))。
    /// ⚠ 少了这一步, 本 VM 里的 CFG / 骨架 memo 全是空的 ⇒ 演化会读到未初始化的常量。</summary>
    public override void OnVmReady(dynamic script, string seed) => script.MapGenServer.init(seed);

    public override string Invoke(dynamic script, dynamic root, string fn, object[] args) => fn switch
    {
        /* ---- 台账 ↔ 引擎状态快照 ---- */
        "cityNewStateJson" => (string)root.newStateJson(args[0], args[1], args[2], args[3], args[4], args[5], args[6]),
        "cityMetaJson" => (string)root.metaJson(args[0], args[1], args[2], args[3]),
        "cityEvolveJson" => (string)root.evolveCityJson(args[0], args[1], args[2], args[3]),
        /* ---- 城际贸易 (同文件另一层, 由本执行器的批级结算驱动) ---- */
        "cityPriceLayerJson" => (string)root.priceLayerJson(args[0], args[1]),
        "cityTradeEdgesJson" => (string)root.tradeEdgesJson(args[0], args[1]),
        "cityMigrateEdgesJson" => (string)root.migrateEdgesJson(args[0], args[1]),
        "cityHarvestBuildJson" => (string)root.harvestAndBuildJson(args[0], args[1]),
        "cityConstantsJson" => (string)root.constantsJson(),
        /* ---- ext 层 (玩家宗门) 注入 ----
           ⚠ 世界层与城市层各持一份 ext ⇒ **必须由同一个调用点同时注入**
             (MapWorldService 经 JsVmPool 的 onCreated 回调对所有 Scope 统一注入),
             否则玩家落点后有一边是陈旧的 (静默错位)。 */
        "setExternalSettlements" => (string)script.MapGenServer.setExternalSettlements(args[0]),
        "externalSettlementsJson" => (string)script.MapGenServer.externalSettlementsJson(),
        _ => throw new InvalidOperationException($"城市迭代模块未知 JS 函数: {fn}")
    };
}
