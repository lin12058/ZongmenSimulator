using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Zongmen.Time;

/// <summary>时钟对外只读快照（WS 帧 7 / HTTP `/api/clock` / `/stats` 共用）。</summary>
public sealed record ClockSnapshot(
    long Tick, int Year, int Month, int Day, int Season,
    string SeasonName, string MonthName, string Desc,
    int RatePerSecond, long Pending, long TotalTicks, long IncompleteTicks, string Executor)
{
    /// <summary>客户端插值用：每秒推进 1 tick。</summary>
    public double TickRate => RatePerSecond;
}

/// <summary>
/// Tick 泵：**框架的唯一心跳**。
///
/// ```
/// loop:
///   await WaitToNextSecondBoundary()          // 单调对齐，不用 Sleep(1000) 累积漂移
///   ticks = min(应补数, MaxCatchUpTicks)      // ⚠ 超预算宁可世界慢，不雪崩式追补
///   for i in ticks:
///     due = scheduler.AdvanceTo(clock.Tick)   // 空转 = 一次 Peek
///     if due.Count == 0: clock.Tick++; continue
///     batches = partitioner.Partition(due)
///     foreach batch: execute → 合流 apply → scheduler.Commit*
///     clock.Tick++
/// ```
///
/// ⚠ **时钟推进与 job 执行解耦**：泵只宣布「第 N 天到了」，不等 job 算完。
///   P1 因为没有批间并发，执行在泵线程内联做；P2 引入 `v8Queue` / `cpuQueue` 后拆开。
///
/// ⚠ **唯一写世界的入口是合流**（本类的 <see cref="ApplyOutcome"/>）。
///   引擎内部缓存失效 / `BumpBlockRev` / `forceStaticDirty` 都在这里统一做 ——
///   脏标记只有一处来源。P2 再接 `MapWorldService`，P1 只有记账。
/// </summary>
public sealed class TickPump : BackgroundService
{
    private readonly TickOptions _opt;
    private readonly TickScheduler _sched;
    private readonly TickPartitioner _partitioner;
    private readonly TickJobRegistry _registry;
    private readonly TickJobStore _jobStore;
    private readonly WorldClockStore _clockStore;
    private readonly TickPerfStore _perfStore;
    private readonly TickMetrics _metrics;
    private readonly ITickExecutor _executor;
    private readonly ILogger<TickPump> _log;

    /// <summary>当前世（`null` = 还没绑定，泵只空转）。</summary>
    private volatile WorldBinding? _binding;

    private long _lastFlushTick;
    private long _lastReconcileTick;

    /// <summary>待合流的批（P1 = 同步执行完立刻合流，这个字典只为 P2 的异步合流预留）。</summary>
    private readonly object _joinGate = new();
    private readonly HashSet<long> _pendingTicks = new();

    public TickPump(
        TickOptions opt,
        TickScheduler sched,
        TickPartitioner partitioner,
        TickJobRegistry registry,
        TickJobStore jobStore,
        WorldClockStore clockStore,
        TickPerfStore perfStore,
        TickMetrics metrics,
        ITickExecutor executor,
        ILogger<TickPump> log)
    {
        _opt = opt;
        _sched = sched;
        _partitioner = partitioner;
        _registry = registry;
        _jobStore = jobStore;
        _clockStore = clockStore;
        _perfStore = perfStore;
        _metrics = metrics;
        _executor = executor;
        _log = log;
    }

    /// <summary>一世的内存绑定（换世时整体替换）。</summary>
    private sealed class WorldBinding
    {
        public required string Seed { get; init; }
        public required int Round { get; init; }
        public required List<TickJob> Jobs { get; init; }
    }

    /// <summary>当前 tick（未绑定世界时返回 -1）。</summary>
    public long CurrentTick => _binding is null ? -1 : Volatile.Read(ref _currentTick);

    private long _currentTick;

    public TickScheduler Scheduler => _sched;
    public TickMetrics Metrics => _metrics;

    /// <summary>P2: 「本世应该有哪些 job」的**外部提供者** (依赖倒置)。
    /// ⚠ 为什么不直接在 <see cref="ExpectedJobs"/> 里读世界:
    ///   世界状态的持有者是 MapWorldService, 而 MapWorldService 又要持有 TickPump
    ///   (借 VM / 绑世) ⇒ 直接互相引用会成环。用一个委托把「取聚落列表」推迟到运行期,
    ///   MapWorldService 在 AttachTickPump 时把自己的实现注册进来。
    /// 返回 `(EntityId, Kind)[]`; 为空/未注册 ⇒ 退回 P1 的演示心跳行为。</summary>
    public Func<string, int, long, IReadOnlyList<(string EntityId, TickJobKind Kind)>>? ExpectedJobsProvider { get; set; }

    /// <summary>P2: job 执行**成功后**的回调 (写派生层/推进区块 rev 的挂点)。
    /// ⚠ 由 TickPump 在 ApplyOutcome 里调用 ⇒ 这正是方案要求的「唯一写世界入口」。
    /// 参数 = (seed, round, job)。实现方负责幂等与线程安全。</summary>
    public Action<string, int, TickJob>? OnJobApplied { get; set; }

    // ══ 世界生命周期 ═══════════════════════════════════════════════════

    /// <summary>
    /// 绑定一世：从存档载入时钟 + job，回灌进调度器。
    /// ⚠ 这是「重启不重算」的落点 —— 全量重建是秒级，且**一次性事件会直接丢失**。
    /// </summary>
    public LoadReport BindWorld(string seed, int round)
    {
        // ① 换世：清空
        _sched.Reset();
        _metrics.SetSeed(seed);

        // ② 时钟：没有就**就地创建**（从 InitialTick 起）
        var clock = _clockStore.GetOrCreate(seed, round, _opt.InitialTick);

        // ③ job：从存档载入
        var jobs = _jobStore.Load(seed, round);
        _sched.EnqueueRange(jobs);

        Volatile.Write(ref _currentTick, clock.Tick);
        _lastFlushTick = clock.Tick;
        _lastReconcileTick = clock.Tick;

        _binding = new WorldBinding { Seed = seed, Round = round, Jobs = jobs };

        _log.LogInformation(
            "[tick] 绑定世界 seed={Seed} round={Round} tick={Tick}（{Desc}）载入 job={N} 跳过={Skipped}",
            seed, round, clock.Tick, GameClock.Describe(clock.Tick), jobs.Count, _jobStore.SkippedRows);

        return new LoadReport(seed, round, clock.Tick, jobs.Count, _jobStore.SkippedRows);
    }

    /// <summary>解绑（换世 / 停机）：**强制 flush**（时钟 + 脏 job）。</summary>
    public void UnbindWorld()
    {
        var b = _binding;
        if (b is null) return;

        foreach (var kv in _sched.Queue.Snapshot()) _jobStore.MarkDirty(kv);
        _jobStore.Flush();
        _clockStore.Save(b.Seed, b.Round, Volatile.Read(ref _currentTick));

        _binding = null;
        Volatile.Write(ref _currentTick, -1);
        _log.LogInformation("[tick] 解绑世界 seed={Seed}（已 flush）", b.Seed);
    }

    // ══ 主循环 ═══════════════════════════════════════════════════════

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_opt.TickEnabled)
        {
            _log.LogInformation("[tick] TickEnabled=false，时钟不启动");
            return;
        }

        _log.LogInformation("[tick] 时钟启动：1 tick = 1 日，360 日 = 1 年，执行器={Executor}",
            _executor.Name);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var wait = GameClock.MsToNextSecondBoundary(GameClock.NowMonoMs());
                await Task.Delay(wait, stoppingToken);

                // catch-up 预算：最多补 MaxCatchUpTicks
                var caughtUp = 0;
                while (caughtUp < _opt.MaxCatchUpTicks && !stoppingToken.IsCancellationRequested)
                {
                    var advanced = RunOneTick();
                    caughtUp++;
                    if (!advanced) break;      // 没落后 ⇒ 本秒已对齐，不必再补
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                // ⚠ 泵绝不允许因单次异常退出 —— 世界会**永久停滞**且不报错
                _log.LogError(ex, "[tick] 泵循环异常（已吞，继续下一轮）");
            }
        }

        UnbindWorld();
        _log.LogInformation("[tick] 时钟停止于 tick={Tick}（{Total} 次推进，{Incomplete} 次超预算）",
            CurrentTick, _metrics.TotalTicks, _metrics.IncompleteTicks);
    }

    /// <summary>跑一个 tick。返回 true 表示「确实落后了，还需要补」。</summary>
    private bool RunOneTick()
    {
        var b = _binding;
        if (b is null) return false;

        var nowTick = Volatile.Read(ref _currentTick);
        _metrics.BeginTick(nowTick);

        var budgetExceeded = false;
        var t0 = System.Diagnostics.Stopwatch.GetTimestamp();

        var due = _sched.AdvanceTo(nowTick);

        if (due.Count > 0)
        {
            var batches = _partitioner.Partition(due, nowTick);
            foreach (var batch in batches)
            {
                // 预算闸：超预算就中断本 tick 剩余批（它们保持「在途」，下个 tick 继续）
                var elapsedMs = (System.Diagnostics.Stopwatch.GetTimestamp() - t0) * 1000.0
                                / System.Diagnostics.Stopwatch.Frequency;
                if (elapsedMs > _opt.TickBudgetMs)
                {
                    budgetExceeded = true;
                    _log.LogWarning("[tick] tick={Tick} 超预算 {Elapsed:F1}ms > {Budget}ms，剩余批顺延",
                        nowTick, elapsedMs, _opt.TickBudgetMs);
                    break;
                }

                var report = _executor.Execute(batch, nowTick, _metrics, CancellationToken.None);
                if (report.Skipped > 0) budgetExceeded = true;

                using (_metrics.BeginApply(batch.Jobs[0].Kind))
                {
                    foreach (var outcome in report.Outcomes) ApplyOutcome(outcome, nowTick, b);
                }
            }
        }

        _metrics.EndTick(budgetExceeded);
        Volatile.Write(ref _currentTick, nowTick + 1);

        MaybeFlush(nowTick + 1, b);
        MaybeReconcile(nowTick + 1, b);

        // 「本秒是否落后」：对齐后 nowTick 应该 ≈ 出生时刻 + 经过秒数
        return due.Count > 0;
    }

    // ══ 合流：唯一写世界的入口 ═════════════════════════════════════════

    /// <summary>
    /// 应用单个 job 结果。
    ///
    /// ⚠ 顺序纪律：**只有 apply 成功才推进 `NextTick`**。失败 ⇒ 退避（`now + BackoffTicks`）。
    ///   「失败也推进」= 静默跳过周期，是典型的静默病。
    ///
    /// ⚠ P2 在这里挂三件（本方法就是那个唯一的挂载点）：
    ///   ① 写 `WorldState` / 落库 settle 包；
    ///   ② 影响可变图层 ⇒ `BumpBlockRev(seed, ca, cb, 该层位)`；
    ///   ③ 改了引擎派生 ⇒ `InvalidateEngineCache` + `forceStaticDirty()`。
    /// </summary>
    private void ApplyOutcome(TickOutcome outcome, long nowTick, WorldBinding b)
    {
        var job = outcome.Job;

        if (outcome.Ok)
        {
            _sched.CommitSuccess(job, nowTick);
            _jobStore.MarkDirty(job);

            /* ★ P2 的唯一写世界挂点: 执行器已经算完并落库, 这里只做「派生层通知」。
               ⚠ 回调**不得抛** —— 抛了会把已验证的成功 job 拖成失败 (退避重试 ⇒ 演化做两遍)。
                 所以这里吞异常并留痕 (与「绝不静默」原则一致: 留痕 = 不静默)。 */
            var hook = OnJobApplied;
            if (hook != null)
            {
                try { hook(b.Seed, b.Round, job); }
                catch (Exception ex) { _log.LogError(ex, "[tick] OnJobApplied 失败 {Key} (已吞, 不影响 job 提交)", job.Key); }
            }
        }
        else
        {
            var disabled = _sched.CommitFailure(job, nowTick);
            _jobStore.MarkDirty(job);

            if (disabled)
            {
                // ⚠ 绝不静默停摆：停用必须留下明确痕迹
                _log.LogError(
                    "[tick] job 连续失败 {Fails} 次已停用：{Key} err={Err}",
                    job.FailCount, job.Key, outcome.Error);
            }
            else
            {
                _log.LogWarning("[tick] job 失败（{Fails}/{Max}）：{Key} err={Err}，退避至 {Next}",
                    job.FailCount, _opt.MaxFails, job.Key, outcome.Error, job.NextTick);
            }
        }
    }

    // ══ 节流：flush / reconcile ═══════════════════════════════════════

    private void MaybeFlush(long tick, WorldBinding b)
    {
        if (tick - _lastFlushTick < Math.Max(1, _opt.FlushEveryTicks)) return;
        _lastFlushTick = tick;

        try
        {
            var n = _jobStore.Flush();
            _clockStore.Save(b.Seed, b.Round, tick);
            if (n > 0) _log.LogDebug("[tick] flush {N} 行 @tick={Tick}", n, tick);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "[tick] flush 失败 @tick={Tick}（下轮重试）", tick);
        }
    }

    /// <summary>
    /// 兜底对账（默认每 360 tick = 1 游戏年）。
    /// ⚠ 对账**只增删，不重置** —— 已有行的 `NextTick` / `Phase` 绝不被覆盖，
    ///   否则每年一次的兜底会把相位抖动全部推平回同一天。
    /// ⚠ P1 的「应该有哪些 job」还是空集合（真实来源在 P2：引擎聚落集合 + PlayerSect 台账）。
    /// </summary>
    private void MaybeReconcile(long tick, WorldBinding b)
    {
        if (_opt.ReconcileEveryTicks <= 0) return;
        if (tick - _lastReconcileTick < _opt.ReconcileEveryTicks) return;
        _lastReconcileTick = tick;

        try
        {
            var expected = ExpectedJobs(b, tick);
            var report = _jobStore.Reconcile(b.Seed, b.Round, expected, _registry, tick);

            // ⚠ 新补上的 job 必须回灌进堆（只落库不调度 = 永久漏事件）
            if (report.Added > 0)
            {
                var have = _sched.Queue.Snapshot().Select(j => j.Key).ToHashSet();
                foreach (var j in expected.Where(j => !have.Contains(j.Key)))
                    _sched.Enqueue(j);
            }

            if (report.Added > 0 || report.Removed > 0)
                _log.LogInformation("[tick] 对账 @tick={Tick}：+{Added} -{Removed}（存量 {Existing}）",
                    tick, report.Added, report.Removed, report.Existing);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "[tick] 对账失败 @tick={Tick}", tick);
        }
    }

    /// <summary>
    /// 「本世应该有哪些 job」。
    /// P1 只给演示心跳；P2 由 <see cref="ExpectedJobsProvider"/> (MapWorldService 注册)
    /// 给出「每聚落 × 每 kind」。⚠ 对账**只增删不重置** ⇒ 这里返回的必须是**全集**,
    /// 少给一类会导致那一类的所有 job 被 Remove (静默丢掉演化)。
    /// </summary>
    private List<TickJob> ExpectedJobs(WorldBinding b, long tick)
    {
        var list = new List<TickJob>();

        var provider = ExpectedJobsProvider;
        if (provider != null)
        {
            try
            {
                foreach (var (entityId, kind) in provider(b.Seed, b.Round, tick))
                {
                    if (string.IsNullOrEmpty(entityId)) continue;
                    list.Add(_registry.NewJob(b.Seed, b.Round, entityId, kind, tick));
                }
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "[tick] ExpectedJobsProvider 失败, 本轮回退到演示心跳");
                list.Clear();
            }
        }

        // 演示心跳：若从未投递过，保底补一个（让 P1 的链路始终有东西可跑）
        if (!b.Jobs.Any(j => j.Kind == TickJobKind.DemoHeartbeat) &&
            !list.Any(j => j.Kind == TickJobKind.DemoHeartbeat))
        {
            list.Add(_registry.NewJob(b.Seed, b.Round, _opt.DemoEntityId,
                TickJobKind.DemoHeartbeat, tick));
        }
        return list;
    }

    // ══ 对外只读 ═══════════════════════════════════════════════════════

    public ClockSnapshot Snapshot()
    {
        var b = _binding;
        var tick = Math.Max(0, Volatile.Read(ref _currentTick));
        var d = GameClock.ToDate(tick);

        return new ClockSnapshot(
            Tick: tick,
            Year: d.Year, Month: d.Month, Day: d.Day, Season: d.Season,
            SeasonName: GameClock.SeasonNames[d.Season],
            MonthName: GameClock.MonthNames[d.Month - 1],
            Desc: GameClock.Describe(tick),
            RatePerSecond: 1,
            Pending: _sched.PendingCount,
            TotalTicks: _metrics.TotalTicks,
            IncompleteTicks: _metrics.IncompleteTicks,
            Executor: _executor.Name);
    }

    public object Stats() => new
    {
        enabled = _opt.TickEnabled,
        bound = _binding is not null,
        seed = _binding?.Seed,
        round = _binding?.Round ?? 0,
        tick = CurrentTick,
        describe = CurrentTick >= 0 ? GameClock.Describe(CurrentTick) : "",
        executor = _executor.Name,
        scheduler = _sched.Stats(),
        metrics = _metrics.Snapshot(),
        jobRows = _jobStore.Count(),
        loadedRows = _jobStore.LoadedRows,
        skippedRows = _jobStore.SkippedRows,
        dirtyRows = _jobStore.DirtyCount,
        perfRows = _perfStore.WrittenRows,
    };
}

/// <summary>绑定结果（日志与判据用）。</summary>
public readonly record struct LoadReport(string Seed, int Round, long Tick, int Jobs, long Skipped);
