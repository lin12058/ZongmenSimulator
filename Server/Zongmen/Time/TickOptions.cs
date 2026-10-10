namespace Zongmen.Time;

/// <summary>
/// Tick 框架配置。**独立于 <see cref="ZongmenOptions"/>**，由 <see cref="ZongmenOptions.Tick"/> 挂载。
/// </summary>
public sealed class TickOptions
{
    /// <summary>总开关。关掉时 <see cref="TickPump"/> 不起作用，服务端行为与未接入前一致。</summary>
    public bool TickEnabled { get; set; } = true;

    /// <summary>
    /// 世界起始 tick（第 1 年 春 一月 一日 = 0）。
    /// ⚠ 仅在**首次创建**某世存档时生效；已有存档从 <see cref="WorldClockStore"/> 读回。
    /// </summary>
    public long InitialTick { get; set; } = 0;

    /// <summary>1 tick 对应的游戏天数（= 1，钉死；留字段只为可读性）。</summary>
    public int DaysPerTick { get; set; } = 1;

    /// <summary>
    /// 单轮泵最多补多少 tick。
    /// ⚠ 重活阻塞导致超时后，宁可世界慢下来，也不要雪崩式追补（否则每轮都补满，永远追不上）。
    /// </summary>
    public int MaxCatchUpTicks { get; set; } = 4;

    /// <summary>
    /// L0 摊批的 M：L0 的 job 周期设为 M ⇒ 每 tick 只有 1/M 到期。
    /// 建议值：30（月）或 7（旬）。⚠ 前提是所有 L0 公式都写成了 `f(state, dt)` 积分。
    /// </summary>
    public int L0SpreadTicks { get; set; } = 30;

    /// <summary>失败退避：连续失败后下次到期 = now + 这个值（**不是** Period）。</summary>
    public int FailBackoffTicks { get; set; } = 5;

    /// <summary>连续失败多少次后 `Enabled = 0`。⚠ 绝不静默停摆 —— 必须同时写日志 + 上报 /stats。</summary>
    public int MaxFails { get; set; } = 5;

    /// <summary>单 tick 的执行预算（毫秒）。超了即标记 incomplete，未完成部分顺延。</summary>
    public int TickBudgetMs { get; set; } = 300;

    /// <summary>每多少 tick 批量 UPSERT 一次脏 job 行（不能每 tick UPDATE）。</summary>
    public int FlushEveryTicks { get; set; } = 10;

    /// <summary>兜底全量对账周期（建议 360 = 1 游戏年）。</summary>
    public int ReconcileEveryTicks { get; set; } = 360;

    /// <summary>
    /// 离线是否追补。默认 **false（冻结）**：重启后从存档 tick **继续**，不按墙钟差值补。
    /// ⚠ 一次周末停机 = 数十万 tick，追补会把冷启动变成灾难。要挂机演化请走 `OfflineCatchUp` + 快进（P3）。
    /// </summary>
    public bool OfflineCatchUp { get; set; } = false;

    /// <summary>`TickVmPool` 的 S。0 = 自动（`max(1, ProcessorCount - 1)`）。⚠ 需按内存实测后拍板。</summary>
    public int TickVmPoolSize { get; set; } = 0;

    /// <summary>P2 前是否用读路径 VM 串行跑 V8 类 job（P1 只有演示执行器，用不到）。</summary>
    public bool UseReadPathVmForTick { get; set; } = false;

    /// <summary>是否启用并发执行（P1 关掉，行为=单线程串行；P2 打开）。</summary>
    public bool ConcurrentExecution { get; set; } = false;

    /// <summary>TickPerf 聚合落库周期（每多少 tick 落一行）。</summary>
    public int PerfAggregateEveryTicks { get; set; } = 30;

    /// <summary>TickPerf 内存环形缓冲容量（tick 数）。</summary>
    public int PerfRingCapacity { get; set; } = 512;

    /// <summary>演示心跳 job 的实体 id（P1 验证链路用；P2 起无人添加它，自然消失）。</summary>
    public string DemoEntityId { get; set; } = "demo_0_0";

    /// <summary>P2 城市演化的**活跃窗口**半径（区域格）。
    /// 演化只覆盖 `[-span, span]²` 区域格内的聚落 —— 无限世界全量演化是 O(∞) 且
    /// 绝大多数城永远不被玩家看到。3 ⇒ 覆盖 7×7=49 区域格 (≈ 9×9 区块 × 18 格 ≈ 160 格边长)。
    /// ⚠ 与「在线窗口」是两件事: 这里是**演化窗口**, 决定哪些城会随时间变;
    ///   玩家走到窗口外看到的是「未被演化」的初始态 (这是刻意的, 换世/换图时才有意义)。</summary>
    public int EvolveSpanRegions { get; set; } = 3;

    /// <summary>单批演化的**硬上限**城市数（防一 tick 内扫到过多城而超预算）。
    /// 超限时本批只演化前 N 座 (按 id 规范序), 其余由后续 tick 补齐 (相位抖动已把
    /// 各城的到期日错开 ⇒ 很少真的触顶)。0 = 不限。</summary>
    public int EvolveMaxCitiesPerTick { get; set; } = 0;

    /// <summary>解析后的实际 VM 池大小。</summary>
    public int EffectiveVmPoolSize =>
        TickVmPoolSize > 0 ? TickVmPoolSize : Math.Max(1, Environment.ProcessorCount - 1);

    /// <summary>Cpu 队列并发度（留一核给 Kestrel/WS）。</summary>
    public int EffectiveCpuWorkers => Math.Max(1, Environment.ProcessorCount - 1);
}
