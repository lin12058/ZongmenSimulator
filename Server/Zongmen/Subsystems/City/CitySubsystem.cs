using System.Text;
using System.Text.Json;
using Zongmen.Engine;
using Zongmen.Time;

namespace Zongmen.Subsystems.City;

/* ============================================================
 * 城市迭代子系统 (Subsystems/City/)
 * ------------------------------------------------------------
 * 本类是本子系统对外的**唯一接缝**: 模块声明 + 台账 + 认领的 job + 渲染叠加。
 *
 * ★ 台账归属: `CityStateStore` 由本类**持有** (而不是让 MapWorldService 持有)。
 *   之前它在 MapWorldService 里 new 出来再注册进 DI, 结果是「Core 编译期就认识 City」
 *   —— 加第二个子系统时 Core 又要多认识一个类型。现在 Core 只通过 ISubsystem 回调。
 *
 * ⚠ 换世清空 (OnWorldChanged) 的语义是「只删该轮次」而不是 Clear():
 *   城 id 形态 `{区域i}_{区域j}_u{n}` **跨世会重名** ⇒ 不清就是「新世第 0 天的城
 *   带着上一世演化了几十年的人口继续跑」(不报错)。而 Clear 会在将来支持
 *   同进程回看多世时误删别的世。
 * ============================================================ */
public sealed class CitySubsystem : ISubsystem, IDisposable
{
    public string Name => "city";

    /// <summary>本子系统的 V8 模块 (独立 VM, scope = "city")。</summary>
    public JsvmModule? Module { get; }

    public IReadOnlyList<TickJobKind> Claims { get; } =
        new[] { TickJobKind.TownEvolve, TickJobKind.TradeEdge };

    public string[] Tables => ["CityState"];

    /// <summary>演化台账 (执行器读写; 换世清空由本类负责)。</summary>
    public CityStateStore Store { get; }

    public CitySubsystem(string? dbPath, string engineJsDir, string cityJsDir)
    {
        Store = new CityStateStore(dbPath);
        Module = new CityModule(engineJsDir, cityJsDir);
    }

    /// <summary>换世: 清掉上一世的城市状态 (见文件头的跨世串味说明)。</summary>
    public int OnWorldChanged(int round) => Store.RemoveRound(round);

    /// <summary>渲染叠加 `{"&lt;城id&gt;":{pop,tier,state}}` —— 骨架 ⊕ 建筑计划里「计划」的输入。
    /// ⚠ 只取**本区域格**的城 (按 id 前两段 = 区域格索引筛): 台账是全世界的,
    ///   整份塞进去会让每个区域包多传几百条无关记录 (且 VM 侧白解析)。
    /// ⚠ 无当前世 / 台账为空 / 该格无城 ⇒ 返回空串 ⇒ 引擎原样吐骨架 (零变化路径)。</summary>
    public string RenderOverlayJson(int round, int i, int j)
    {
        if (round <= 0) return "";
        var rows = Store.ByRound(round);
        if (rows.Count == 0) return "";
        var sb = new StringBuilder(64);
        sb.Append('{');
        var first = true;
        foreach (var r in rows)
        {
            var (ri, rj) = RegionOfId(r.Id);
            if (ri != i || rj != j) continue;
            if (r.Pop <= 0) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JsonSerializer.Serialize(r.Id)).Append(":{\"pop\":").Append(r.Pop)
              .Append(",\"tier\":").Append(r.Tier)
              .Append(",\"state\":").Append(r.State).Append('}');
        }
        if (first) return "";
        return sb.Append('}').ToString();
    }

    /// <summary>从聚落 id `{区域i}_{区域j}_u{n}` 反解区域格; 形态不合法返回
    /// (int.MinValue, int.MinValue) (与「区域格索引恒 >= 0」的口径一致, 不会误命中)。</summary>
    private static (int I, int J) RegionOfId(string id)
    {
        var p = id.Split('_');
        if (p.Length < 2) return (int.MinValue, int.MinValue);
        var i = int.TryParse(p[0], out var a) ? a : int.MinValue;
        var j = int.TryParse(p[1], out var b) ? b : int.MinValue;
        return (i, j);
    }

    public void Dispose() => Store.Dispose();
}
