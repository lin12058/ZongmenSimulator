namespace Zongmen.Time;

/// <summary>
/// **线程安全**的最小堆调度队列（`TickJob.NextTick` 为键）。
///
/// ── 为什么自实现，而不是用 .NET 内置 `PriorityQueue&lt;T,P&gt;` ─────────────────
/// 内置 `PriorityQueue` **确实不是线程安全**，也**确实没有 decrease-key**。
/// 但这两条**都不构成**「调度器必须单线程独占」的结论 —— 只能说「不能裸用内置的」。
///
/// 真正的问题是：**tick 泵不是唯一的生产者**。
///   · `commitPlace`（玩家立宗 / 拓土）从 Kestrel 请求线程来；
///   · 对账 reconcile、一次性事件插入、聚落类型变更，也都从请求线程来。
/// 若队列非线程安全，就得给「业务线程 → 泵线程」再造一条中转 `Channel` ——
/// 多一层、多一次分配，只为绕开一个 `lock`。而 `lock` 的代价：
///   临界区 = O(log n) 的指针交换（n 是 job 数，量级 1e3~1e4），
///   **绝不做 I/O、绝不做 proto 编解码、绝不碰 V8**。
///   真热点是 V8 运算（十毫秒级），不是 `lock`（纳秒级）。
///
/// ── 唯一必须守住的纪律 ──────────────────────────────────────────────
/// <see cref="AdvanceTo"/> 的「**弹出 — 校验 — 吊销**」三步必须**在同一次持锁内**完成。
/// 否则：泵线程刚取到 job A，业务线程 `Reprioritize(A, 远期)`，泵线程再按旧键取一次
/// ⇒ 同一 job 被收集两次（一次 Δt 算错的、一次正确的）。**这是本文件存在的全部理由。**
///
/// 吊销哨兵 = <see cref="RevokedTick"/>（`long.MaxValue`）。`Reprioritize` 会重设它，
/// 所以「在途」与「被吊销」不会混淆。
///
/// ── 关于 decrease-key ────────────────────────────────────────────────
/// 这里**有** `Reprioritize`（内部 `Remove` + `Push`，靠 <see cref="_index"/> 索引表定位），
/// 但**不要**为此复杂化调用方：默认路径仍是「弹出后改键再入堆」。
/// </summary>
public sealed class ConcurrentTickQueue
{
    /// <summary>吊销哨兵：job 被 <see cref="AdvanceTo"/> 收集后在堆内标记成这个值。</summary>
    public const long RevokedTick = long.MaxValue;

    // ── 同步原语 ────────────────────────────────────────────────────────
    // ⚠ 单把 lock 足够：临界区极短且无嵌套、无重入、无 await。
    //   不要换 ReaderWriterLockSlim —— 这里没有「读多写少」，全是写。
    private readonly object _lock = new();

    private readonly List<TickJob> _heap = new(1024);

    /// <summary>键 → 堆下标。支持 O(1) 定位 ⇒ Remove / Reprioritize 得以实现。</summary>
    private readonly Dictionary<JobKey, int> _index = new();

    // ── 计数（读不需要 lock：long 单字读在 64 位上是原子的；仅作观测）──
    private long _pushCount;
    private long _popCount;
    private long _peekCount;
    private long _revokeCount;

    /// <summary>
    /// ★ 无锁快速计数。**空转 tick 的第一道闸**：
    /// `AdvanceTo` 先读它，为 0 就直接返回 —— 连 `lock` 都不用进。
    /// 这是「本 tick 零成本」的最字面兑现。
    /// ⚠ 它是**提示**而非真值（并发下会读到瞬时值）：
    ///   读到 0 只可能是「真的空」（因为只减不增的路径不存在 —— Pop 后立刻重新入堆）；
    ///   读到非 0 就走慢路径持锁确认。语义安全。
    /// </summary>
    private volatile int _countHint;

    public int Count { get { lock (_lock) return _heap.Count; } }
    /// <summary>无锁计数（诊断 / 快路径判定用）。</summary>
    public int CountHint => _countHint;
    public long PushCount => Interlocked.Read(ref _pushCount);
    public long PopCount => Interlocked.Read(ref _popCount);
    /// <summary>★ 空转成本的度量：无 job 的 tick 里这个值应该只 +1。</summary>
    public long PeekCount => Interlocked.Read(ref _peekCount);
    public long RevokeCount => Interlocked.Read(ref _revokeCount);
    /// <summary>惰性删除命中数。**恒为 0**：本队列用「键索引 + 就地重排」实现，同键入堆由
    /// <see cref="Push"/> 去重 ⇒ 从不产生重复副本（旧实现的「在途副本」分支恒不可达，已删）。
    /// 保留该属性只为 /stats 与判据的形状稳定。</summary>
    public long DuplicateSuppressed => 0;

    // ══ 入队 ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 入队。**任意线程可调**（这是线程安全队列的核心收益）。
    /// 同键已存在 ⇒ 覆盖旧条目（保留新 NextTick），不产生重复。
    /// </summary>
    public void Push(TickJob job)
    {
        if (job is null) throw new ArgumentNullException(nameof(job));

        lock (_lock)
        {
            var key = job.Key;
            if (_index.TryGetValue(key, out var existing))
            {
                // 同键替换：直接改堆内对象 + 依据新键调整位置（避免删+插两次 sift）
                var old = _heap[existing];
                if (ReferenceEquals(old, job))
                {
                    SiftDown(SiftUp(existing));      // 同一个对象改了 NextTick
                }
                else
                {
                    RemoveAt(existing);
                    InsertUnchecked(job);
                }
            }
            else
            {
                InsertUnchecked(job);
            }
        }

        Interlocked.Increment(ref _pushCount);
    }

    /// <summary>批量入队（载入回灌用，一次持锁）。</summary>
    public int PushRange(IEnumerable<TickJob> jobs)
    {
        var n = 0;
        lock (_lock)
        {
            foreach (var job in jobs)
            {
                if (job is null) continue;
                var key = job.Key;
                if (_index.TryGetValue(key, out var existing)) RemoveAt(existing);
                InsertUnchecked(job);
                n++;
            }
        }
        Interlocked.Add(ref _pushCount, n);
        return n;
    }

    private void InsertUnchecked(TickJob job)
    {
        _heap.Add(job);
        var i = _heap.Count - 1;
        _index[job.Key] = i;
        SiftUp(i);
        _countHint = _heap.Count;
    }

    /// <summary>⚠ 调用方必须已持锁。</summary>
    private int SiftUp(int i)
    {
        while (i > 0)
        {
            var parent = (i - 1) >> 1;
            if (_heap[parent].NextTick <= _heap[i].NextTick) break;
            Swap(parent, i);
            i = parent;
        }
        return i;
    }

    /// <summary>⚠ 调用方必须已持锁。返回最终下标。</summary>
    private int SiftDown(int i)
    {
        var n = _heap.Count;
        while (true)
        {
            var l = (i << 1) + 1;
            var r = l + 1;
            var smallest = i;
            if (l < n && _heap[l].NextTick < _heap[smallest].NextTick) smallest = l;
            if (r < n && _heap[r].NextTick < _heap[smallest].NextTick) smallest = r;
            if (smallest == i) return i;
            Swap(i, smallest);
            i = smallest;
        }
    }

    /// <summary>⚠ 调用方必须已持锁。</summary>
    private void Swap(int a, int b)
    {
        (_heap[a], _heap[b]) = (_heap[b], _heap[a]);
        _index[_heap[a].Key] = a;
        _index[_heap[b].Key] = b;
    }

    /// <summary>⚠ 调用方必须已持锁。</summary>
    private void RemoveAt(int i)
    {
        var last = _heap.Count - 1;
        _index.Remove(_heap[i].Key);
        if (i == last) { _heap.RemoveAt(last); _countHint = _heap.Count; return; }

        _heap[i] = _heap[last];
        _index[_heap[i].Key] = i;
        _heap.RemoveAt(last);
        _countHint = _heap.Count;

        // 先向下再向上（新元素可能比父小也可能比子大）
        SiftDown(SiftUp(i));
    }

    // ══ 空转热路径 ═════════════════════════════════════════════════════

    /// <summary>
    /// 看堆顶（不移除）。**空转 tick 的全部成本 = 这里**。
    /// 语义上等价于「一次比较」，额外开销仅一次 lock 进出。
    /// </summary>
    public bool TryPeek(out TickJob job)
    {
        Interlocked.Increment(ref _peekCount);
        lock (_lock)
        {
            if (_heap.Count == 0) { job = null!; return false; }
            job = _heap[0];
            return true;
        }
    }

    /// <summary>堆顶的 NextTick（无则 <see cref="long.MaxValue"/>）。用于 P3 快进判定。</summary>
    public long PeekNextTick()
    {
        lock (_lock) return _heap.Count == 0 ? long.MaxValue : _heap[0].NextTick;
    }

    // ══ 到期收集（★ 本类的核心不变量所在）═════════════════════════════

    /// <summary>
    /// 收集所有 `NextTick &lt;= nowTick` 的 job（**含 <paramref name="nowTick"/> 当天**）。
    ///
    /// ⚠ 两步（弹出 — 吊销）在**一次持锁内**完成，这是线程安全的唯一要点：
    ///   1. 弹出堆顶；
    ///   2. 记下**原到期 tick**（<see cref="TickJob.DueTick"/>，合流推进相位要用它），填 `DtTicks`，
    ///      把 `NextTick` 置为 <see cref="RevokedTick"/>（**吊销**）后重新入堆 —— 这样并行线程
    ///      此刻 `Reprioritize` 也不会让同一 job 被二次收集。
    ///   ⚠ 这里**没有**「在途副本丢弃」这一步：键索引 + 就地重排保证同键从不产生重复副本。
    ///
    /// ⚠ 收集出的 job 的 `NextTick` 推进**不在这里做** ——
    ///   必须等合流 apply 成功后才推进（§6.8），否则「失败也推进」= 静默跳过周期。
    /// ⚠⚠ **收集即吊销** ⇒ 调用方（`TickPump.RunOneTick`）**必须**在本次收集后把每个 job
    ///   re-arm（成功推进 / 失败退避 / 顺延），否则它永久沉在堆底、再也不到期。
    /// </summary>
    public List<TickJob> AdvanceTo(long nowTick)
    {
        var batch = new List<TickJob>();

        /* ★ 空转热路径：先无锁读计数。为 0 就直接返回 —— 不进 lock、不碰堆。
           这就是「避免每 Tick 都要计算」的最字面兑现：本 tick 的全部成本 = 一次 volatile 读。 */
        if (_countHint == 0)
        {
            Interlocked.Increment(ref _peekCount);
            return batch;
        }

        lock (_lock)
        {
            Interlocked.Increment(ref _peekCount);   // 慢路径也要计一次「确认堆顶」

            while (_heap.Count > 0 && _heap[0].NextTick <= nowTick)
            {
                var job = _heap[0];

                /* ⚠ 这里**没有**「在途副本」分支：本队列用「键索引 + 就地重排」实现，
                   同键入堆已由 Push/Reinsert 去重 ⇒ 从不产生重复副本（旧分支的条件
                   `NextTick == RevokedTick` 与循环条件 `NextTick <= nowTick` 互斥，恒不可达，已删）。 */

                // 弹出
                RemoveAt(0);
                Interlocked.Increment(ref _popCount);

                // ★ 吊销：先记下**原到期 tick**（合流推进相位用它，见 TickJobRegistry.NextDue），
                //   再置哨兵后重新入堆 ⇒ 此 job 现在「不可见」（在途）。
                job.DueTick = job.NextTick;
                job.DtTicks = (int)Math.Max(0, nowTick - job.LastRunTick);
                job.ScheduleSeq = Interlocked.Increment(ref _pushCount);
                job.NextTick = RevokedTick;
                InsertUnchecked(job);
                Interlocked.Increment(ref _revokeCount);

                batch.Add(job);
            }
        }

        return batch;
    }

    // ══ 重排 / 移除（合流或业务线程调用）═══════════════════════════════

    /// <summary>
    /// 重排：设定新的 `NextTick`。用于「合流后推进周期」与「失败退避」。
    /// 键不存在（已一次性完成 / 被移除）⇒ 返回 false。
    /// </summary>
    public bool Reprioritize(JobKey key, long newNextTick)
    {
        lock (_lock)
        {
            if (!_index.TryGetValue(key, out var i)) return false;
            var job = _heap[i];
            job.NextTick = newNextTick;
            SiftDown(SiftUp(i));
            return true;
        }
    }

    /// <summary>就地把 job 对象放回队列（合流后推进：改对象上的 NextTick 再调这个）。</summary>
    public bool Reinsert(TickJob job)
    {
        lock (_lock)
        {
            var key = job.Key;
            if (_index.TryGetValue(key, out var i))
            {
                _heap[i].NextTick = job.NextTick;
                SiftDown(SiftUp(i));
                return true;
            }
            InsertUnchecked(job);
            return true;
        }
    }

    /// <summary>移除（一次性事件跑完 / `Enabled=0` / 世界换世）。</summary>
    public bool TryRemove(JobKey key, out TickJob job)
    {
        lock (_lock)
        {
            if (!_index.TryGetValue(key, out var i)) { job = null!; return false; }
            job = _heap[i];
            RemoveAt(i);
            return true;
        }
    }

    /// <summary>取快照（对账 / 判据用）。**只读副本**。</summary>
    public List<TickJob> Snapshot()
    {
        lock (_lock) return _heap.ToList();
    }

    /// <summary>清空（换世）。</summary>
    public int Clear()
    {
        lock (_lock)
        {
            var n = _heap.Count;
            _heap.Clear();
            _index.Clear();
            return n;
        }
    }

    /// <summary>不变量自检（判据用）：索引表与堆必须一一对应，且堆序成立。</summary>
    public (bool Ok, string? Error) Validate()
    {
        lock (_lock)
        {
            if (_index.Count != _heap.Count)
                return (false, $"index={_index.Count} heap={_heap.Count}");

            for (var i = 0; i < _heap.Count; i++)
            {
                if (!_index.TryGetValue(_heap[i].Key, out var idx) || idx != i)
                    return (false, $"index mismatch at {i}: {_heap[i].Key}");

                var l = (i << 1) + 1;
                var r = l + 1;
                if (l < _heap.Count && _heap[l].NextTick < _heap[i].NextTick)
                    return (false, $"heap violation at {i} (left)");
                if (r < _heap.Count && _heap[r].NextTick < _heap[i].NextTick)
                    return (false, $"heap violation at {i} (right)");
            }
            return (true, null);
        }
    }
}
