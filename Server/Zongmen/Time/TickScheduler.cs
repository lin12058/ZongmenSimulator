namespace Zongmen.Time;

/// <summary>
/// 调度器门面 = <see cref="ConcurrentTickQueue"/> + 载入/回灌 + 空转 + 合流后重排。
///
/// 这一层只做「谁该在什么时候跑」，**不碰执行**（执行在 <see cref="TickPump"/> + 执行器）。
/// 这样做的好处：判据可以直接驱动调度器，不需要起 V8、不需要起 Web 服务。
/// </summary>
public sealed class TickScheduler
{
    private readonly TickJobRegistry _registry;
    private readonly TickOptions _opt;
    private readonly ConcurrentTickQueue _queue;

    /// <summary>累计调度次数（诊断）。</summary>
    private long _advanceCalls;
    private long _emptyAdvances;
    private long _dispatched;

    public TickScheduler(TickJobRegistry registry, TickOptions opt, ConcurrentTickQueue queue)
    {
        _registry = registry;
        _opt = opt;
        _queue = queue;
    }

    public ConcurrentTickQueue Queue => _queue;
    public int PendingCount => _queue.Count;

    /// <summary>推进到 <paramref name="nowTick"/> 的收集次数（含空转）。</summary>
    public long AdvanceCalls => Interlocked.Read(ref _advanceCalls);

    /// <summary>★ 空转次数（本 tick 零到期）。这是 lazy 生效的直接度量。</summary>
    public long EmptyAdvances => Interlocked.Read(ref _emptyAdvances);

    /// <summary>累计派发的 job 数。</summary>
    public long Dispatched => Interlocked.Read(ref _dispatched);

    // ══ 投递（任意线程可调）═══════════════════════════════════════════

    /// <summary>
    /// 新增 job 并入队。⚠ 会自动落库由调用方负责（store 在 pump 侧统一 flush）。
    /// </summary>
    public TickJob Enqueue(string seed, int round, string entityId, TickJobKind kind,
                           long fromTick, byte[]? payload = null, bool immediate = false)
    {
        var job = _registry.NewJob(seed, round, entityId, kind, fromTick, payload, immediate);
        _queue.Push(job);
        return job;
    }

    /// <summary>入队一个已构造好的 job（载入回灌 / 对账用）。</summary>
    public void Enqueue(TickJob job) => _queue.Push(job);

    /// <summary>批量入队（载入回灌）。</summary>
    public int EnqueueRange(IEnumerable<TickJob> jobs) => _queue.PushRange(jobs);

    // ══ 核心：到期收集 ═════════════════════════════════════════════════

    /// <summary>
    /// lazy 的全部魔法。空转时**只做一次 Peek 级别的判断**，不做任何枚举、不做任何分配。
    /// </summary>
    public List<TickJob> AdvanceTo(long nowTick)
    {
        Interlocked.Increment(ref _advanceCalls);

        var due = _queue.AdvanceTo(nowTick);

        if (due.Count == 0)
        {
            Interlocked.Increment(ref _emptyAdvances);
            return due;
        }

        Interlocked.Add(ref _dispatched, due.Count);

        // 按规范序排序：⚠ 合流的 apply 顺序必须与到达顺序无关（到达顺序由线程调度决定）。
        due.Sort(CompareByCanonicalOrder);
        return due;
    }

    /// <summary>`(Layer, EntityId, Kind)` 全序 —— 与 <see cref="TickJob.SortKey"/> 同口径。</summary>
    public static int CompareByCanonicalOrder(TickJob a, TickJob b)
    {
        var c = ((int)a.Layer).CompareTo((int)b.Layer);
        if (c != 0) return c;
        c = string.CompareOrdinal(a.EntityId, b.EntityId);
        if (c != 0) return c;
        return ((int)a.Kind).CompareTo((int)b.Kind);
    }

    // ══ 合流后的推进（只有 apply 成功才推进）═══════════════════════════

    /// <summary>
    /// 成功：`LastRunTick = now`，`NextTick = 严格 += Period`（一次性则停用）。
    /// ⚠ 这两步**只能在这里做** —— 「失败也推进」= 静默跳过周期。
    ///
    /// ⚠⚠ **调用前 `job.NextTick` 是吊销哨兵（`long.MaxValue`）**，必须先复位再推进。
    ///   否则 `NextDue` 里的 `long.MaxValue + Period` 会**整数溢出成负数**
    ///   ⇒ `next <= nowTick` 命中兜底分支 ⇒ 又一步溢出 ⇒ 下一次到期是个随机的负数
    ///   ⇒ job 立刻被再次收集，相位彻底错乱（间隔出现 8/12/46/342 这种不规则值）。
    ///   **不报错，只是演化节奏乱掉** —— 典型静默病。
    ///   ⚠ 因为命中点恒为 `firstDue + k*Period` 且此刻 `nowTick` 本身就是命中点，
    ///     正确的下一跳就是 `nowTick + Period`（不需要读旧 `NextTick`）。
    /// </summary>
    public void CommitSuccess(TickJob job, long nowTick)
    {
        job.FailCount = 0;
        job.LastRunTick = nowTick;

        if (job.IsOneShot)
        {
            job.Enabled = false;
            _queue.TryRemove(job.Key, out _);
            return;
        }

        job.NextTick = nowTick + job.PeriodTicks;      // ★ 复位哨兵 + 严格 += Period
        _queue.Reprioritize(job.Key, job.NextTick);
    }

    /// <summary>
    /// 失败：`NextTick = now + BackoffTicks`（**不是** `+Period`，避免与正常周期撞一起）。
    /// 连续失败达上限 ⇒ `Enabled = 0` 并移出队列。⚠ 调用方**必须**同时写日志 + 上报 /stats。
    /// </summary>
    public bool CommitFailure(TickJob job, long nowTick)
    {
        job.FailCount++;

        if (job.FailCount >= _opt.MaxFails)
        {
            job.Enabled = false;
            _queue.TryRemove(job.Key, out _);
            return true;   // 已停用：调用方负责告警
        }

        job.NextTick = _registry.BackoffDue(nowTick);
        _queue.Reprioritize(job.Key, job.NextTick);
        return false;
    }

    /// <summary>一次性事件：插入后必须**立即落库**（失败也不许丢，它是「内容」不是「派生」）。</summary>
    public bool IsOneShot(TickJobKind kind) => _registry.Spec(kind).PeriodTicks <= 0;

    /// <summary>换世：清空。</summary>
    public int Reset()
    {
        _advanceCalls = 0;
        _emptyAdvances = 0;
        _dispatched = 0;
        return _queue.Clear();
    }

    /// <summary>观测快照（/stats 与判据用）。</summary>
    public object Stats() => new
    {
        pending = _queue.Count,
        peek = _queue.PeekCount,
        pushes = _queue.PushCount,
        pops = _queue.PopCount,
        revoked = _queue.RevokeCount,
        dupSuppressed = _queue.DuplicateSuppressed,
        advanceCalls = AdvanceCalls,
        emptyAdvances = EmptyAdvances,
        dispatched = Dispatched,
    };
}
