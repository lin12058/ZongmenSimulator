namespace Zongmen.Time;

/// <summary>
/// 演化层级。层越高 = 越全局 = 越难并行 = 周期越长。
/// </summary>
public enum TickLayer
{
    /// <summary>局部：读自身 + 只读世界常量，写自身。摊批 M 个子批。可高度并行。</summary>
    L0 = 0,

    /// <summary>邻域：读 1~2 环邻域快照，写自身。按实体/边分区，块间靠快照隔离。</summary>
    L1 = 1,

    /// <summary>全局：读全图，写全局缓存。**必须串行 + 分帧**。</summary>
    L2 = 2
}

/// <summary>
/// 消费资源类型 —— 队列按**资源**划，不按业务划。
/// ⚠ 合成一条队列配 N 个 worker 是错的：V8 类 job 仍要抢 VM 独占权，队列语义会骗人。
/// </summary>
public enum TickResource
{
    /// <summary>需要 V8 虚拟机（并发度 = VM 池大小 S）。P2 起生效。</summary>
    V8 = 0,

    /// <summary>纯托管 CPU 计算（并发度 = 核数-1）。</summary>
    Cpu = 1
}

/// <summary>
/// job 种类。Layer / Resource 由 <see cref="TickJobRegistry"/> 静态声明，
/// **不从这里推断**（避免「加个枚举值就默认进了并行池」这种事故）。
///
/// ⚠ 落库存的是**字符串**（<see cref="KindNames"/>），不是这个 int：
/// 枚举增删会让历史行错读成另一个 kind。
/// </summary>
public enum TickJobKind
{
    /// <summary>[L0] 人口增长/衰减，按 dt 积分。</summary>
    PopGrowth,

    /// <summary>[L0] 宗门弟子修炼进度，按 dt 积分。</summary>
    SectCultivation,

    /// <summary>[L0] 寿元倒计时（到期即触发一次性事件）。</summary>
    Lifespan,

    /// <summary>[L1] 城镇足迹生长 + 建筑升降级（**聚合 job**：同写 townCache[stId]，必须合一个）。</summary>
    TownEvolve,

    /// <summary>[L1] 贸易边局部重估（每条边只看两端供需；不做全局最短路）。</summary>
    TradeEdge,

    /// <summary>[L1] 势力声望单轮邻域扩散（轮间靠快照隔离，多轮必须串行）。</summary>
    Reputation,

    /// <summary>[L2] 道路网重算 —— **单元素批**，走读路径 VM，分帧到月 tick。⚠ 绝不进 tick VM 池。</summary>
    RoadRework,

    /// <summary>[P1 演示] 心跳计数 —— 只用于验证「时钟 → 调度 → 执行 → 合流 → 重排」链路。</summary>
    DemoHeartbeat
}

/// <summary>job 种类 ↔ 持久化字符串（双向唯一真源）。</summary>
public static class KindNames
{
    private static readonly (TickJobKind Kind, string Name)[] All =
    {
        (TickJobKind.PopGrowth,       "popGrowth"),
        (TickJobKind.SectCultivation, "sectCultivation"),
        (TickJobKind.Lifespan,        "lifespan"),
        (TickJobKind.TownEvolve,      "townEvolve"),
        (TickJobKind.TradeEdge,       "tradeEdge"),
        (TickJobKind.Reputation,      "reputation"),
        (TickJobKind.RoadRework,      "roadRework"),
        (TickJobKind.DemoHeartbeat,   "demoHeartbeat"),
    };

    private static readonly Dictionary<TickJobKind, string> ToName =
        All.ToDictionary(x => x.Kind, x => x.Name);

    private static readonly Dictionary<string, TickJobKind> FromName =
        All.ToDictionary(x => x.Name, x => x.Kind);

    public static string Of(TickJobKind kind) =>
        ToName.TryGetValue(kind, out var n) ? n : kind.ToString();

    /// <summary>未知名字返回 false（载入时**跳过并计数**，不让一行脏数据废掉整次载入）。</summary>
    public static bool TryParse(string? name, out TickJobKind kind)
    {
        if (name is not null && FromName.TryGetValue(name, out kind)) return true;
        kind = default;
        return false;
    }

    /// <summary>枚举序（用于规范排序的确定性 tie-break）。</summary>
    public static int Ordinal(TickJobKind kind) => (int)kind;
}

/// <summary>
/// 内存态 job 的定位键 = `(Seed, Round, EntityId, Kind)`。
/// ⚠ 必须含 **Kind** —— 否则同实体不同 kind 的 job 会互相覆盖。
/// </summary>
public readonly record struct JobKey(string Seed, int Round, string EntityId, TickJobKind Kind)
{
    public override string ToString() => $"{Seed}/{Round}/{EntityId}/{KindNames.Of(Kind)}";
}

/// <summary>
/// 调度单元（内存态）。
///
/// 「lazy」的全部载体是 <see cref="NextTick"/>：**绝对** tick 号，不是「剩余天数」。
/// 这样「加一天」= `+1`，「改期」= 赋值，语义最直白且可持久化。
/// </summary>
public sealed class TickJob
{
    public string Seed { get; init; } = "";
    public int Round { get; init; }
    public string EntityId { get; init; } = "";
    public TickJobKind Kind { get; init; }

    public TickLayer Layer { get; init; }
    public TickResource Resource { get; init; }

    /// <summary>★ lazy 的载体：下次该跑的**绝对** tick。</summary>
    public long NextTick { get; set; }

    /// <summary>0 = 一次性事件（原 `TimedEvent`）；&gt;0 = 周期 tick 数。</summary>
    public int PeriodTicks { get; set; }

    /// <summary>相位（由哈希派生）。存下来**只为防漂移与可对账**，不许被对账重置。</summary>
    public long Phase { get; set; }

    /// <summary>★ 上一次实际跑的 tick。`DtTicks = nowTick - LastRunTick` 的唯一来源。</summary>
    public long LastRunTick { get; set; }

    /// <summary>连续失败次数。达 <see cref="TickOptions.MaxFails"/> 即 `Enabled=0`。</summary>
    public int FailCount { get; set; }

    public bool Enabled { get; set; } = true;

    /// <summary>该 kind 自己的 proto 参数（一次性事件的主要用途）。⚠ 不 gzip（太小，header 净亏）。</summary>
    public byte[]? Payload { get; set; }

    // ── 运行时瞬态（不落库）────────────────────────────────────────────
    /// <summary>本轮的 Δt tick 数。由 `AdvanceTo` 填，不由构造填。</summary>
    public int DtTicks { get; set; }

    /// <summary>本轮调度序号（诊断用）。</summary>
    public long ScheduleSeq { get; set; }

    public JobKey Key => new(Seed, Round, EntityId, Kind);

    /// <summary>
    /// 规范排序键 = `(Layer, SortKey, EntityId, Kind)`。
    /// ⚠ 合流的 apply 顺序必须**与到达顺序无关**（到达顺序由线程调度决定 ⇒ 不确定），
    ///   所以这里排序的对象是「job」而不是「结果」。
    /// </summary>
    public string SortKey =>
        $"{(int)Layer:D1}|{EntityId}|{(int)Kind:D2}";

    /// <summary>是否一次性事件。</summary>
    public bool IsOneShot => PeriodTicks <= 0;

    public TickJob Clone() => new()
    {
        Seed = Seed,
        Round = Round,
        EntityId = EntityId,
        Kind = Kind,
        Layer = Layer,
        Resource = Resource,
        NextTick = NextTick,
        PeriodTicks = PeriodTicks,
        Phase = Phase,
        LastRunTick = LastRunTick,
        FailCount = FailCount,
        Enabled = Enabled,
        Payload = Payload,
    };

    public override string ToString() =>
        $"{KindNames.Of(Kind)}({EntityId}) @{NextTick} dt={DtTicks} p={PeriodTicks}";
}

/// <summary>
/// Kind 的静态声明（解耦的唯一真源）。
///
/// ⚠ <see cref="Writes"/> / <see cref="Reads"/> 用「键空间」字符串，模板里 `{id}` 会被实际 id 替换：
///   `Chunk:ca,cb` / `Region:i,j` / `Settle:entityId` / `Edge:idA|idB` / `Vein:commId` / `World:*`
///
/// ⚠⚠ <see cref="EngineCaches"/> 是**最容易漏、后果最重**的字段：
///   只看 `Writes` 会得出「两个不同 stId 的城镇生长互不相干 ⇒ 可并行」——
///   事实上它们都在写引擎内部的 `townCache`，只是 key 不同。
/// </summary>
public sealed record JobSpec(
    TickJobKind Kind,
    TickLayer Layer,
    TickResource Resource,
    string[] Reads,
    string[] Writes,
    string[] EngineCaches,
    int PeriodTicks,
    /// <summary>基准周期（不含相位）= PeriodTicks；一次性事件为 0。</summary>
    bool Parallelizable = true)
{
    /// <summary>从模板展开读集。</summary>
    public IEnumerable<string> ExpandReads(string entityId) => Expand(Reads, entityId);

    /// <summary>从模板展开写集。</summary>
    public IEnumerable<string> ExpandWrites(string entityId) => Expand(Writes, entityId);

    /// <summary>从模板展开引擎缓存键。</summary>
    public IEnumerable<string> ExpandEngineCaches(string entityId) => Expand(EngineCaches, entityId);

    private static IEnumerable<string> Expand(string[] templates, string entityId)
    {
        foreach (var t in templates)
            yield return t.Replace("{id}", entityId);
    }
}
