namespace Zongmen.Services;

/* ============================================================
 * 宗门影响力 (招募系统方案 §2.1 / §9.5)
 * ------------------------------------------------------------
 * 招募值产量 = 「每年 = 当前宗门影响力」。影响力系统尚未上线 ⇒ 这里是一个**桩**,
 * 恒返回 10 (方案 §2.2 的 INFLUENCE_DEFAULT)。
 *
 * ★ 为什么抽成接口而不是写死常量:
 *   招募侧 (RecruitStore) 每次结算都要问「这一年的产量」; 等影响力系统上线,
 *   只换本文件的实现 (读 PlayerSect 的影响力字段), RecruitStore 一行不改。
 *
 * ⚠ 保底 1 是**硬约束**: 影响力 0 ⇒ 产量 0 ⇒ 招募值永久冻结、玩家卡死在
 *   「招不起人也刷不起池」的状态 (而且不报错, 只是点数永远不动)。
 *
 * ⚠ 只返回**当前值**, 不建历史曲线: 整段未结算时间一律按现在的值算
 *   (入口调用频繁 ⇒ 单次 delta 通常不足 1 年, 误差可忽略; 见方案 §2.1 纪律表)。
 * ============================================================ */
public interface IInfluence
{
    /// <summary>该账号在当前世的宗门影响力 (≥1)。</summary>
    int Of(string account, int round);
}

public sealed class InfluenceProvider : IInfluence
{
    /// <summary>影响力缺省值 (影响力系统未上线前的固定取值, 方案 §2.2)。</summary>
    public const int Default = 10;

    /// <summary>下限: 影响力为 0 会让招募值永久冻结 (玩家卡死), 故保底 1。</summary>
    public const int Min = 1;

    public int Of(string account, int round) => Math.Max(Min, Default);
}
