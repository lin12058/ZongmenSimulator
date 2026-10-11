using System.Text;
using Zongmen.Engine;

namespace Zongmen.Subsystems.Characters;

/* ============================================================
 * 角色子系统 · V8 模块 (scope = "characters")
 * ------------------------------------------------------------
 * ★ 认领的出口 = **角色生成** (纯数据, 不碰地图几何 / 不碰 ext 层):
 *     cultivatorBatchJson / cultivatorOneJson / cultivatorConstantsJson
 *
 * ★ 为什么用 V8 (而不是在 C# 里重写生成器):
 *   生成逻辑已有唯一真源 `Subsystems/Characters/js/chargen-core.js` —— 与 Node 侧
 *   CLI (chargen.mjs) **同一份文件**。放进 V8 = 复用而不移植, 杜绝「离线对拍通过、
 *   线上却生成出另一个人物」这种静默漂移 (对齐工程「单真源」铁律)。
 *   数据 (cultivation-base.json) 由宿主读入后注入 —— V8 沙箱没有 fs。
 *
 * ⚠ 与 City 模块的根本区别: 本模块**不载** mapgen-server.js, 故
 *   AcceptsExternalSettlements = false (见 JsvmModule 的同名属性)。
 * ============================================================ */
public sealed class CharactersModule : JsvmModule
{
    public const string CharactersScope = "characters";

    public override string Scope => CharactersScope;
    public override string RootMember => "CultivatorGen";

    private readonly string[] _files;

    /// <summary>全量修仙基础数据 (cultivation-base.json 原文)。建 VM 时注入 JS。</summary>
    private readonly string _baseJson;

    public CharactersModule(string jsDir, string dataDir)
    {
        _files = [Path.Combine(jsDir, "chargen-core.js")];
        var basePath = Path.Combine(dataDir, "cultivation-base.json");
        if (!File.Exists(basePath))
            throw new FileNotFoundException($"缺少角色基础数据: {basePath}");
        _baseJson = File.ReadAllText(basePath, Encoding.UTF8);
    }

    public override IReadOnlyList<string> Files => _files;

    /// <summary>纯数据模块 (不载 mapgen-server.js) ⇒ 不接收 ext(玩家宗门) 注入。</summary>
    public override bool AcceptsExternalSettlements => false;

    /// <summary>建 VM 时注入基础数据 (= CultivatorGen.setBase(json))。
    /// ⚠ 漏了这一步 ⇒ batchJson 抛「未初始化」⇒ /api/characters 全 500。
    ///   VM 被 LRU 淘汰后重建会再次走到这里 ⇒ 数据自动重装, 无需额外逻辑。</summary>
    public override void OnVmReady(dynamic script, string seed)
        => script.CultivatorGen.setBase(_baseJson);

    public override string Invoke(dynamic script, dynamic root, string fn, object[] args) => fn switch
    {
        /* ---- 角色生成 ---- */
        "cultivatorBatchJson" => (string)root.batchJson(args[0], args[1], args[2]),
        "cultivatorOneJson" => (string)root.oneJson(args[0], args[1]),
        "cultivatorConstantsJson" => (string)root.constantsJson(),
        _ => throw new InvalidOperationException($"角色模块未知 JS 函数: {fn}")
    };
}
