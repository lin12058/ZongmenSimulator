using Zongmen.Services;

namespace Zongmen.Time;

/// <summary>
/// `Kind → JobSpec` 的静态注册表 —— **解耦的唯一真源**。
///
/// 每个 kind 的读写集、引擎缓存声明、层级、资源、周期都在这里**静态声明**，
/// 而不是运行时嗅探。改这里 = 改并行安全性的判定依据，所以：
///   · <c>EngineCaches</c> 宁多勿少（无法证明 key 不相交 ⇒ 按不安全处理）；
///   · 新增 kind 必须同时进 <see cref="TickJobKind"/> / <see cref="KindNames"/> / 本表。
/// </summary>
public sealed class TickJobRegistry
{
    private readonly Dictionary<TickJobKind, JobSpec> _specs;
    private readonly TickOptions _opt;

    public TickJobRegistry(TickOptions opt)
    {
        _opt = opt;

        var list = new[]
        {
            // ── L0：局部，写集天然不相交 ⇒ 高并行 ────────────────────────
            new JobSpec(
                Kind: TickJobKind.PopGrowth,
                Layer: TickLayer.L0,
                Resource: TickResource.Cpu,
                Reads: new[] { "Settle:{id}" },
                Writes: new[] { "Settle:{id}" },
                EngineCaches: Array.Empty<string>(),
                PeriodTicks: Math.Max(1, opt.L0SpreadTicks)),

            new JobSpec(
                Kind: TickJobKind.SectCultivation,
                Layer: TickLayer.L0,
                Resource: TickResource.Cpu,
                Reads: new[] { "Settle:{id}" },
                Writes: new[] { "Settle:{id}" },
                EngineCaches: Array.Empty<string>(),
                PeriodTicks: Math.Max(1, opt.L0SpreadTicks)),

            new JobSpec(
                Kind: TickJobKind.Lifespan,
                Layer: TickLayer.L0,
                Resource: TickResource.Cpu,
                Reads: new[] { "Settle:{id}" },
                Writes: new[] { "Settle:{id}" },
                EngineCaches: Array.Empty<string>(),
                // 寿元倒计时：低频，按旬（10 天）检查足够
                PeriodTicks: 10),

            // ── L1：邻域 ──────────────────────────────────────────────────
            new JobSpec(
                Kind: TickJobKind.TownEvolve,
                Layer: TickLayer.L1,
                Resource: TickResource.V8,          // 需要引擎的 growTownFootprint / spiritAt / veinNear
                Reads: new[] { "Settle:{id}", "Region:i,j" },
                Writes: new[] { "Settle:{id}" },
                /* ★ 关键：同 stId 的 job 都写同一份 CityState 台账 ⇒ 必须在分批时被识别为冲突。
                   ⚠ 2026-09-27 修正: 原为 "townCache:{id}" —— 那是**错的**。
                   townCache 是 seed 派生的**只读**纯函数缓存 (growTownFootprint 的 memo),
                   演化器既不写它也不该按它分批; 真正的写集是 CityState (独立台账),
                   故键名必须是 "cityState:{id}"。判据: city_evo 分批断言 (同 id 不同批被拆开)。 */
                EngineCaches: new[] { "cityState:{id}" },
                PeriodTicks: GameClock.TicksPerSeason),   // 90

            new JobSpec(
                Kind: TickJobKind.TradeEdge,
                Layer: TickLayer.L1,
                Resource: TickResource.Cpu,
                Reads: new[] { "Edge:{id}" },
                Writes: new[] { "Edge:{id}" },
                EngineCaches: new[] { "tradeCache:{id}" },
                PeriodTicks: GameClock.DaysPerMonth),     // 30

            new JobSpec(
                Kind: TickJobKind.Reputation,
                Layer: TickLayer.L1,
                Resource: TickResource.Cpu,
                Reads: new[] { "Settle:{id}", "Region:i,j" },
                Writes: new[] { "Settle:{id}" },
                EngineCaches: Array.Empty<string>(),
                PeriodTicks: GameClock.TicksPerSeason),   // 90
                // ⚠ 多轮扩散必须串行：本轮写、下轮读 ⇒ 靠「每 tick 一轮 + 快照隔离」

            // ── L2：全局，串行 ────────────────────────────────────────────
            new JobSpec(
                Kind: TickJobKind.RoadRework,
                Layer: TickLayer.L2,
                Resource: TickResource.V8,
                Reads: new[] { "World:roads" },
                Writes: new[] { "World:roads" },
                EngineCaches: new[] { "roadCache" },      // 单一 key ⇒ 天然串行
                PeriodTicks: GameClock.TicksPerYear,      // 360，且分帧到月
                Parallelizable: false),

            // ── P1 演示：验证链路，不做任何真实演化 ───────────────────────
            new JobSpec(
                Kind: TickJobKind.DemoHeartbeat,
                Layer: TickLayer.L0,
                Resource: TickResource.Cpu,
                Reads: new[] { "Settle:{id}" },
                Writes: new[] { "Settle:{id}" },
                EngineCaches: Array.Empty<string>(),
                PeriodTicks: Math.Max(1, opt.L0SpreadTicks)),
        };

        _specs = list.ToDictionary(s => s.Kind);
    }

    /// <summary>规格查询。未知 kind 抛（编译期/启动期就该发现，不要静默）。</summary>
    public JobSpec Spec(TickJobKind kind) =>
        _specs.TryGetValue(kind, out var s)
            ? s
            : throw new InvalidOperationException($"未注册的 TickJobKind: {kind}（忘了进 TickJobRegistry？）");

    public bool TrySpec(TickJobKind kind, out JobSpec spec) => _specs.TryGetValue(kind, out spec!);

    public IReadOnlyCollection<JobSpec> All => _specs.Values;

    /// <summary>
    /// 造一个新 job：按 spec 填层/资源、算相位、定首次到期 tick。
    ///
    /// ⚠ <paramref name="entityId"/> **原样存取**，绝不由 C# 重算 ——
    ///   玩家实体 id 形如 `{区域i}_{区域j}_u{n}` 是**引擎自算**的，
    ///   C# 重算 = 批量踩坑（`rngDominated` / `roadsNear` 要靠 `split('_')` 反解，NaN 会静默扫空）。
    /// </summary>
    public TickJob NewJob(string seed, int round, string entityId, TickJobKind kind,
                          long fromTick, byte[]? payload = null, bool immediate = false)
    {
        var spec = Spec(kind);
        var period = spec.PeriodTicks;

        long nextTick;
        long phase;
        if (immediate || period <= 0)
        {
            // 一次性事件：立即到期，相位无意义
            nextTick = Math.Max(0, fromTick);
            phase = 0;
        }
        else
        {
            // ⚠⚠ 相位必须用**线上名**（KindNames.Of）派生，绝不能用 `kind.ToString()`（枚举名）。
            //   理由：TickJobStore 落库存的是线上名，对账 / 重建时要按同一把钥匙**复现**同一相位。
            //   用枚举名 ⇒ 「代码里改个枚举成员名」就让全世界的相位漂移（且不报错）。
            var kindKey = KindNames.Of(kind);
            phase = PhaseHash.PhaseOf(seed, entityId, kindKey, period);
            nextTick = PhaseHash.FirstDueTick(seed, entityId, kindKey, period, fromTick);
        }

        return new TickJob
        {
            Seed = seed,
            Round = round,
            EntityId = entityId,
            Kind = kind,
            Layer = spec.Layer,
            Resource = spec.Resource,
            NextTick = nextTick,
            PeriodTicks = period,
            Phase = phase,
            LastRunTick = fromTick,        // ★ 首次 Δt = 0（不虚增演化）
            FailCount = 0,
            Enabled = true,
            Payload = payload,
        };
    }

    /// <summary>
    /// 周期推进：**严格** `+= PeriodTicks`。
    /// ⚠ 绝不许写 `Period ± jitter` —— 周期一旦被改，计数判据失效、演化速率漂移。
    /// ⚠⚠ **前提：`job.NextTick` 必须是真实的到期 tick，不能是吊销哨兵**
    ///   （`ConcurrentTickQueue.RevokedTick` = `long.MaxValue`）。
    ///   哨兵 + Period 会整数溢出成负数 ⇒ 静默错乱。见 `TickScheduler.CommitSuccess` 的注释。
    /// </summary>
    public long NextDue(TickJob job, long nowTick)
    {
        if (job.IsOneShot) return long.MaxValue;      // 跑完即止（由调用方 Enabled=0）

        // ★ 防御：哨兵（或任何非法值）⇒ 不回绕，直接从 nowTick 起算一个周期
        if (job.NextTick >= ConcurrentTickQueue.RevokedTick - job.PeriodTicks)
        {
            return nowTick + job.PeriodTicks;
        }

        var next = job.NextTick + job.PeriodTicks;
        // 兜底：若落后太多（如长时间停机后手动对齐），推进到 nowTick 之后的第一个相位命中点。
        if (next <= nowTick)
        {
            var ahead = job.PeriodTicks * ((nowTick - next) / job.PeriodTicks + 1);
            next += ahead;
        }
        return next;
    }

    /// <summary>失败退避：`now + BackoffTicks`（**不是** `+Period`，避免和正常周期撞一起）。</summary>
    public long BackoffDue(long nowTick) => nowTick + Math.Max(1, _opt.FailBackoffTicks);
}
