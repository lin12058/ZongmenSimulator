namespace Zongmen.Engine;

/* ============================================================
 * 世界层模块 (scope = "core") —— 原 JsEngineHost.Call 的白名单在此。
 * ------------------------------------------------------------
 * 认领的出口 = **地图/几何/落点/渲染**:
 *   chunk / region / settle / comm / blockLayers / tile / fieldGrid / meta
 *   placeCheck / commitPlace / domainCheck / expandCheck / ext 层三件套
 *   + 城市迭代里**依赖世界几何或 ext 层**的两个渲染出口:
 *       citySettlementsJson (带 type/q/r 的聚落身份表; ext 感知)
 *       citySettlePlanJson  (骨架 ⊕ 建筑计划的渲染拼合; ext 感知)
 *
 * ⚠ 后两个**刻意留在这里**而不是 City 模块: 它们要 MapGen 骨架 + ext 层,
 *   而 ext 层是「玩家宗门」这类**世界资产**, 归世界层所有。放 City 侧会让两个
 *   VM 各持一份 ext ⇒ 玩家落点后必然有一边是陈旧的 (静默错位, 不报错)。
 *
 * ⚠ 纯演化出口 (newState/meta/evolveCity/priceLayer/tradeEdges/migrateEdges/
 *   harvestBuild/constants) 在 Zongmen.Subsystems.City.CityModule —— 它们不需要
 *   ext, 且是长任务, 必须走独立 VM 才能不占住本模块的门闩。
 * ============================================================ */
public sealed class WorldModule : JsvmModule
{
    public const string WorldScope = "core";

    public override string Scope => WorldScope;
    public override string RootMember => "MapGenServer";

    private readonly string[] _files;
    /// <summary>世界层脚本目录 (供前端自算/指纹等外部读取)。</summary>
    public string EngineJsDir { get; }

    public WorldModule(string engineJsDir, string cityJsDir)
    {
        EngineJsDir = engineJsDir;
        _files = JsvmBundles.WorldBacked(engineJsDir, cityJsDir);
    }

    public override IReadOnlyList<string> Files => _files;

    /// <summary>载 mapgen-server.js ⇒ 接收 ext(玩家宗门) 注入。</summary>
    public override bool AcceptsExternalSettlements => true;

    /// <summary>地图引擎初始化 (= MapGen.init(seed))。</summary>
    public override void OnVmReady(dynamic script, string seed) => script.MapGenServer.init(seed);

    public override long RoadVersion(dynamic script)
        => Convert.ToInt64((double)script.MapGenServer.roadVersion());

    public override string Invoke(dynamic script, dynamic root, string fn, object[] args) => fn switch
    {
        "chunkJson" => (string)root.chunkJson(args[0], args[1]),
        "regionJson" => (string)root.regionJson(args[0], args[1]),
        "settleJson" => (string)root.settleJson(args[0], args[1]),
        "commJson" => (string)root.commJson(args[0], args[1]),
        "blockLayersJson" => (string)root.blockLayersJson(args[0], args[1]),
        "tileJson" => (string)root.tileJson(args[0], args[1]),
        "fieldGridJson" => (string)root.fieldGridJson(args[0], args[1], args[2], args[3]),
        "metaJson" => (string)root.metaJson(),
        /* ---- 玩家宗门放置 (2026-09-23 方案 §2.4) ---- */
        "placeCheckJson" => (string)root.placeCheckJson(args[0], args[1], args[2], args[3]),
        "commitPlace" => (string)root.commitPlace(args[0], args[1], args[2]),
        "setExternalSettlements" => (string)root.setExternalSettlements(args[0]),
        "externalSettlementsJson" => (string)root.externalSettlementsJson(),
        "removeExternalSettlement" => (string)root.removeExternalSettlement(args[0]),
        "domainCheckJson" => (string)root.domainCheckJson(args[0], args[1], args[2]),
        "expandCheckJson" => (string)root.expandCheckJson(args[0], args[1], args[2], args[3], args[4]),
        "_countVeins" => (string)root._countVeins(),
        /* ---- 城市迭代的**渲染侧**出口 (留在世界层, 理由见文件头) ----
           ⚠ 它们定义在 city-evo.js (导出在 global.CityEvo), 不在 MapGenServer 上。 */
        "citySettlementsJson" => (string)script.CityEvo.settlementsJson(args[0], args[1]),
        "citySettlePlanJson" => (string)script.CityEvo.settlePlanJson(args[0], args[1], args[2]),
        /* ---- 地图人物分布 (2026-10-11 方案 v2): **落人格** (骨架/地形侧) ----
           ⚠ 与「战力/小队」分家: 那两个在 CharactersModule (另一个 V8, 有六维)。
             本层只回 { q, r, n, base } —— 谁在哪一格、这一格几个人。 */
        "peopleBlockJson" => (string)root.peopleBlockJson(args[0], args[1]),
        "peopleAtJson" => (string)root.peopleAtJson(args[0], args[1]),
        _ => throw new InvalidOperationException($"世界层模块未知 JS 函数: {fn}")
    };
}
