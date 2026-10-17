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

    /* T3: catch-up 的**墙钟落后基准** = 绑定时刻的 (tick, 单调毫秒)。
       ⚠ 判据必须是「此刻应到 tick 比 _currentTick 大」——旧实现拿「本 tick 有没有到期 job」
         当落后信号，而 L0 摊 30 / 季 90 / 旬 10 的稀疏世界里绝大多数 tick 是空的 ⇒ 落后后
         每秒只补 1 tick，永远追不上（`MaxCatchUpTicks` 形同虚设）。 */
    private long _bindTick;
    private long _bindMonoMs;

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
    /// 返回 `(EntityId, Kind)[]`; ⚠ **未注册（null）= 「本世有哪些 job」无人知晓 ⇒ 跳过对账**,
    ///   绝不退回演示心跳 —— 那是 2026-10-11 之前的旧行为, 会造出注定失败的 job
    ///   （详见 <see cref="TickOptions.EnableDemoHeartbeat"/> 的教训）。</summary>
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

        /* ③ job：从存档载入。
           ⚠ 关掉演示心跳时, 存档里可能还留着**旧版本投下的** demo 心跳行, 两类都要处理:
             · 启用中的 ⇒ 从内存/队列就地剔掉（否则它又会走一遍 5 次失败退避, 白刷日志）;
             · 已停用的 ⇒ 从库里删掉（它既不在 expected 也不在 `Load`(只取 Enabled=1) 里
               ⇒ `Reconcile` **永远判不到它** ⇒ 会永久滞留成僵尸行）。 */
        var loaded = _jobStore.Load(seed, round);
        List<TickJob> jobs;
        if (_opt.EnableDemoHeartbeat)
        {
            jobs = loaded;
        }
        else
        {
            jobs = loaded.Where(j => j.Kind != TickJobKind.DemoHeartbeat).ToList();
            var dropped = loaded.Count - jobs.Count;
            try
            {
                var removed = _jobStore.DeleteKindRows(seed, round, KindNames.Of(TickJobKind.DemoHeartbeat));
                if (dropped > 0 || removed > 0)
                    _log.LogInformation("[tick] 清理演示心跳残留：内存丢弃 {Dropped} 条 / 库中删除 {Removed} 条"
                                      + " (seed={Seed} round={Round})", dropped, removed, seed, round);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "[tick] 清理演示心跳残留行失败（不影响演化）");
            }
        }
        _sched.EnqueueRange(jobs);

        Volatile.Write(ref _currentTick, clock.Tick);
        _lastFlushTick = clock.Tick;
        _lastReconcileTick = clock.Tick;

        /* T3: 记下 catch-up 的墙钟基准。重绑定 (重启/换世) 时归零 ⇒ 停机期间的差值不会被
           当成「落后」去补（与 OfflineCatchUp=false 的「冻结核」语义一致）。 */
        _bindTick = clock.Tick;
        _bindMonoMs = GameClock.NowMonoMs();

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

                if (_binding is null) continue;

                /* catch-up：每个墙钟秒**至少**推进 1 tick；若某 tick 超时 / GC 停顿让墙钟跑到
                   更前面，就补齐到墙钟位置，但一轮最多补 MaxCatchUpTicks（防雪崩）。
                   ⚠ 落后判据 = 墙钟（IsBehindWallClock），**不是**「本 tick 有没有到期 job」：
                     L0 摊 30 / 季 90 / 旬 10 的稀疏世界里绝大多数 tick 是空的，用 due.Count>0
                     会让落后后每秒只补 1 tick ⇒ 永远追不上（MaxCatchUpTicks 形同虚设）。 */
                var caughtUp = 0;
                do
                {
                    RunOneTick();
                    caughtUp++;
                }
                while (caughtUp < _opt.MaxCatchUpTicks
                       && !stoppingToken.IsCancellationRequested
                       && IsBehindWallClock());
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

    /// <summary>「墙钟是否已跑到世界前面」—— catch-up 的唯一判据（见 <see cref="ExecuteAsync"/>）。</summary>
    private bool IsBehindWallClock()
    {
        var expected = _bindTick + (GameClock.NowMonoMs() - _bindMonoMs) / 1000;
        return Volatile.Read(ref _currentTick) < expected;
    }

    /// <summary>跑一个 tick（推进一天）。
    /// ⚠ 无返回值 —— 「是否落后」由墙钟判定（<see cref="IsBehindWallClock"/>），不由本方法的产出决定。</summary>
    private void RunOneTick()
    {
        var b = _binding;
        if (b is null) return;

        var nowTick = Volatile.Read(ref _currentTick);
        _metrics.BeginTick(nowTick);

        var budgetExceeded = false;
        var t0 = System.Diagnostics.Stopwatch.GetTimestamp();

        var due = _sched.AdvanceTo(nowTick);

        if (due.Count > 0)
        {
            var batches = _partitioner.Partition(due, nowTick);

            /* ★★ P0 不变量：**被 AdvanceTo 收集的 job 必然在本次 RunOneTick 结束前 re-arm**
               （成功推进 / 失败退避 / 顺延）。因为 AdvanceTo 是「收集即吊销」（NextTick 置
               RevokedTick）⇒ 任何「收集了但没 apply」的 job 会永久沉在堆底、再也不到期，
               那些城永久停止演化，而对账也救不回（它还在堆里、DB 行也在 ⇒ 判为 existing）。
               apply 成功的走 CommitSuccess/CommitFailure 自行 re-arm；这里只兜
               「预算 break / 执行器抛异常」两条路径漏下的。 */
            var applied = new HashSet<JobKey>();

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

                TickRunReport report;
                try
                {
                    report = _executor.Execute(batch, nowTick, _metrics, CancellationToken.None);
                }
                catch (Exception ex)
                {
                    /* ⚠ 执行器契约是「不得抛」；真抛了也绝不能因此让本批 job 永久沉底
                       （下面 DeferUnapplied 会把这批连同后面没跑的批一起顺延）。 */
                    _log.LogError(ex, "[tick] 执行器抛异常 tick={Tick}（本 tick 未 apply 的 job 顺延）", nowTick);
                    break;
                }

                if (report.BudgetExceeded) budgetExceeded = true;

                foreach (var outcome in report.Outcomes)
                {
                    // 分段计时按**真实 kind** 归属（原实现把整批记到 batch.Jobs[0].Kind 头上）
                    using (_metrics.BeginApply(outcome.Job.Kind))
                        ApplyOutcome(outcome, nowTick, b);
                    applied.Add(outcome.Job.Key);
                }
            }

            DeferUnapplied(due, applied, nowTick, b);
        }

        _metrics.EndTick(budgetExceeded);
        Volatile.Write(ref _currentTick, nowTick + 1);

        MaybeFlush(nowTick + 1, b);
        MaybeReconcile(nowTick + 1, b);
    }

    /// <summary>
    /// ★ P0 兜底：把「已收集但未 apply」的 job 按 `nowTick + 1` 重新排回队列。
    /// 这是「收集即吊销」不变量的唯一补丁点 —— 少了它，任何一次预算 break / 执行器异常
    /// 都会让那批 job 永久停在 <see cref="ConcurrentTickQueue.RevokedTick"/> 沉底。
    /// ⚠ 退避与正常推进的 re-arm 由 <c>CommitSuccess</c>/<c>CommitFailure</c> 负责，这里只补漏。
    /// </summary>
    private void DeferUnapplied(List<TickJob> due, HashSet<JobKey> applied, long nowTick, WorldBinding b)
    {
        var deferred = 0;
        foreach (var job in due)
        {
            if (applied.Contains(job.Key)) continue;
            if (!string.Equals(job.Seed, b.Seed, StringComparison.Ordinal)) continue;  // 换世后属于别的世
            if (_sched.Queue.Reprioritize(job.Key, nowTick + 1)) deferred++;
        }
        if (deferred > 0)
            _log.LogWarning("[tick] tick={Tick} 顺延 {N} 个未执行 job（预算/异常），下个 tick 继续",
                nowTick, deferred);
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
    /// ⚠⚠ 正因为「只增删」, 对账的**输入必须可信**: <see cref="ExpectedJobs"/> 返回 null
    ///   （无 provider / provider 抛异常）时**整轮跳过** —— 拿空集去对账等于宣告
    ///   「本世不该有任何 job」, `Reconcile` 会把它们**全部删掉**（静默丢掉演化）。
    /// </summary>
    private void MaybeReconcile(long tick, WorldBinding b)
    {
        if (_opt.ReconcileEveryTicks <= 0) return;
        if (tick - _lastReconcileTick < _opt.ReconcileEveryTicks) return;
        _lastReconcileTick = tick;

        var expected = ExpectedJobs(b, tick);
        if (expected is null)
        {
            _log.LogWarning("[tick] 跳过对账 @tick={Tick}：本世「应该有哪些 job」未知"
                          + "（无 ExpectedJobsProvider 或 provider 失败）, 世界 job 表保持原样", tick);
            return;
        }

        try
        {
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
    /// 「本世应该有哪些 job」。**null = 未知** ⇒ 调用方必须跳过本轮对账。
    /// </summary>
    /// <remarks>
    /// 三种情形的语义（2026-10-11 收紧了后两种；旧行为是「一律回退到演示心跳」，实测有害）：
    ///   · provider 已注册且正常 ⇒ 返回它给出的**全集**（对账只增删不重置 ⇒ 少给一类
    ///     会让那一类的所有 job 被 Remove，静默丢掉演化）。
    ///   · provider 已注册但**抛异常** ⇒ 返回 **null**。
    ///     ⚠⚠ 旧代码在此 `list.Clear()` 后回退演示心跳，后果是**灾难级**的：期望集被换成
    ///       一个注定失败的 `demo_0_0/demoHeartbeat` ⇒ 本世**所有真实演化 job 被对账删光**
    ///       ⇒ 整世停摆，而日志只有一条 LogError（把「provider 挂了」伪装成「有 job 在跑」）。
    ///   · provider **未注册**（裸链路 / 单测）⇒ 默认返回 null；
    ///     仅当显式置 <see cref="TickOptions.EnableDemoHeartbeat"/>=true 才补演示心跳
    ///     （它只是「让 P1 链路有东西可跑」的脚手架，且生产组合根里**无人认领**这个 kind）。
    /// </remarks>
    private List<TickJob>? ExpectedJobs(WorldBinding b, long tick)
    {
        var provider = ExpectedJobsProvider;
        if (provider != null)
        {
            try
            {
                var list = new List<TickJob>();
                foreach (var (entityId, kind) in provider(b.Seed, b.Round, tick))
                {
                    if (string.IsNullOrEmpty(entityId)) continue;
                    list.Add(_registry.NewJob(b.Seed, b.Round, entityId, kind, tick));
                }
                return list;
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "[tick] ExpectedJobsProvider 失败 @tick={Tick} ⇒ 本世期望集「未知」,"
                               + " 本轮跳过对账（世界 job 表保持原样）", tick);
                return null;
            }
        }

        /* 无 provider：本世「应该有哪些 job」无人知晓。
           ⚠ 此处**绝不能**返回空集 —— 空集在对账语义里 = 「本世不该有任何 job」⇒ 全删。 */
        if (!_opt.EnableDemoHeartbeat) return null;
        if (b.Jobs.Any(j => j.Kind == TickJobKind.DemoHeartbeat)) return null;

        return new List<TickJob>
        {
            _registry.NewJob(b.Seed, b.Round, _opt.DemoEntityId, TickJobKind.DemoHeartbeat, tick)
        };
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
