using Zongmen.Engine;
using Zongmen.Time;

namespace Zongmen.Subsystems;

/* ============================================================
 * 子系统契约 (2026-10-11 目录重构)
 * ------------------------------------------------------------
 * 一个子系统 = `Server/Zongmen/Subsystems/<Name>/` 一个自包含文件夹, 内含:
 *     <Name>Subsystem.cs     ← 本文件契约的实现 (唯一对外接缝)
 *     <Name>Module.cs        ← V8 模块声明 (脚本清单 + 出口白名单)
 *     <Name>StateStore.cs    ← 自己的台账 (⚠ 必须独立成表, 见下)
 *     <Name>TickExecutor.cs  ← 认领自己的 job 种类
 *     js/                    ← 本子系统的引擎脚本 (无状态纯函数)
 *
 * ⚠ 三条硬约束 (破任何一条都是静默故障):
 *   ① **台账必须独立成表**。MapWorldService 的后台维护会调
 *      `SqliteVirtualContext.PruneExcept(活跃 seed 前缀)`, 那条 DELETE 的语义是
 *      「删掉所有 Key 不匹配 w:<16位>:* 的行」。状态若塞进 Data 表, 换世之后会被
 *      **静默删掉** (世界瞬间回到初始值, 且不报错)。同 WorldLedger / PlayerSectStore / CityState。
 *   ② **Core 不反向依赖子系统的类型**。Core 只通过本契约回调
 *      (OnWorldChanged / RenderOverlayJson), 不引用任何具体子系统类。
 *   ③ **子系统之间零直接引用**。跨系统协作只能经 C# 契约 + JSON 中转, 不许 A 直接 new B。
 * ============================================================ */
public interface ISubsystem
{
    /// <summary>子系统名 = 目录名 = V8 的 Scope 名。</summary>
    string Name { get; }

    /// <summary>本子系统的 V8 模块; 纯托管子系统 (不需要引擎脚本) 返回 null。</summary>
    JsvmModule? Module { get; }

    /// <summary>本子系统认领的 tick job 种类 (TickExecutorHub 据此分发, 不许重叠)。</summary>
    IReadOnlyList<TickJobKind> Claims { get; }

    /// <summary>本子系统的台账表名 (诊断 / 自检 / 备份清单用)。</summary>
    string[] Tables { get; }

    /// <summary>
    /// 换世钩子: 清空本子系统在**旧轮次**上的世态, 返回删除行数。
    /// ⚠ 必须实现「只删该轮次」而不是 Clear() —— 将来要支持同进程回看多世时,
    ///   Clear 会误删别的世。城 id `{i}_{j}_u{n}` **跨世会重名**, 不清就是跨世串味。
    /// </summary>
    int OnWorldChanged(int round) => 0;

    /// <summary>
    /// 渲染叠加: 返回该区域格内「本子系统对聚落显示的贡献」, 形如
    /// `{"&lt;城id&gt;":{"pop":123,"tier":2,"state":0}}`; 无贡献返回空串。
    ///
    /// ⚠ 这是 Core(渲染) 反向依赖子系统的**唯一**通道, 用注入的函数而不是字段
    ///   引用, 以免 Core 编译期就知道 City 这个类型。多个子系统都返回非空时
    ///   当前取**第一个非空**(合并需要 JSON 层合并语义, 等真有第二个贡献者再加)。
    /// </summary>
    string RenderOverlayJson(int round, int i, int j) => "";
}
