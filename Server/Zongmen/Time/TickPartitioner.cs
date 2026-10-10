namespace Zongmen.Time;

/// <summary>
/// 一个执行批。
///
/// 批的语义：批内 job 已按规范序排列，**批与批之间**才谈并行。
/// ⚠ 批内的 job **不保证**能并行 —— 它们只是「互相独立」，但同一个 `TickVm` 内部仍是串行
///   （V8 `_gate` 是事实）。所以 `v8Queue` 的并发度 = **VM 个数**，不是批个数。
/// </summary>
public sealed class TickBatch
{
    /// <summary>本批的调度编号（= 收集时的 tick）。合流器靠它判断「本 tick 的批都齐了没」。</summary>
    public long TickId { get; init; }

    public TickResource Resource { get; init; }
    public TickLayer Layer { get; init; }

    /// <summary>批内 job（已按 `(Layer, EntityId, Kind)` 规范序）。</summary>
    public List<TickJob> Jobs { get; init; } = new();

    /// <summary>是否已按不可并行处理（单元素批 / 含 L2）。</summary>
    public bool Serial { get; init; }

    public int Count => Jobs.Count;

    public override string ToString() =>
        $"Batch(tick={TickId}, res={Resource}, layer={Layer}, n={Count}, serial={Serial})";
}

/// <summary>
/// 第一步「解耦计算」：把到期 job 切成互不干扰的批。
///
/// ⚠ 解耦的主手段**不是**「让全局计算并行」，而是「让全局计算少发生」（三层频率）。
///   本类只管「已经到期的这批 job 里，哪些能放一起」。
///
/// 可分性判据（四个条件全满足才放同一批）：
///   · `Writes(a) ∩ Writes(b) = ∅`      —— 写集不相交
///   · `Writes(a) ∩ Reads(b)  = ∅`      —— 无 RAW
///   · `Reads(a)  ∩ Writes(b) = ∅`      —— 无 WAR
///   · `EngineCacheKey(a) ∩ EngineCacheKey(b) = ∅`  —— ★ 引擎缓存键也不许撞
///
/// ⚠ 最后一条最容易漏：两个不同 `stId` 的城镇生长，「写集」看着互不相干，
///   但都在写引擎内部的 `townCache`，只是 key 不同。无法证明 key 不相交 ⇒ **按不安全处理**。
/// </summary>
public sealed class TickPartitioner
{
    private readonly TickJobRegistry _registry;
    private readonly TickOptions _opt;

    public TickPartitioner(TickJobRegistry registry, TickOptions opt)
    {
        _registry = registry;
        _opt = opt;
    }

    /// <summary>
    /// 把一批到期 job 切成若干执行批。
    /// ⚠ 先按 `(Resource, Layer)` 分桶 —— V8 与 Cpu **绝不混队列**。
    /// </summary>
    public List<TickBatch> Partition(List<TickJob> due, long tickId)
    {
        var batches = new List<TickBatch>();
        if (due.Count == 0) return batches;

        // ① 按 (Resource, Layer) 分桶（规范序已在上游排好，桶内保持有序）
        var buckets = due
            .GroupBy(j => (j.Resource, j.Layer))
            .OrderBy(g => (int)g.Key.Resource)
            .ThenBy(g => (int)g.Key.Layer);

        foreach (var bucket in buckets)
        {
            var jobs = bucket.ToList();
            var (res, layer) = bucket.Key;

            // ② L2 或不可并行 kind ⇒ 单元素批（**固定规范序**，绝不并行）
            var spec = _registry.Spec(jobs[0].Kind);
            if (layer == TickLayer.L2 || !spec.Parallelizable || !_opt.ConcurrentExecution)
            {
                foreach (var j in jobs)
                    batches.Add(new TickBatch
                    {
                        TickId = tickId, Resource = res, Layer = layer,
                        Jobs = new List<TickJob> { j }, Serial = true,
                    });
                continue;
            }

            // ③ 贪心聚批
            foreach (var j in jobs)
            {
                var placed = false;
                foreach (var b in batches)
                {
                    if (b.Resource != res || b.Layer != layer || b.Serial) continue;
                    if (!CanJoin(j, b)) continue;
                    b.Jobs.Add(j);
                    placed = true;
                    break;
                }
                if (!placed)
                    batches.Add(new TickBatch
                    {
                        TickId = tickId, Resource = res, Layer = layer,
                        Jobs = new List<TickJob> { j },
                    });
            }
        }

        // ④ 每批内部仍按规范序执行（并行的是「批与批」，不是批内）
        foreach (var b in batches) b.Jobs.Sort(TickScheduler.CompareByCanonicalOrder);

        // ⑤ 批与批之间也定序（合流顺序必须与到达顺序无关）
        batches.Sort((a, b) =>
        {
            var c = ((int)a.Layer).CompareTo((int)b.Layer);
            if (c != 0) return c;
            c = ((int)a.Resource).CompareTo((int)b.Resource);
            if (c != 0) return c;
            return string.CompareOrdinal(a.Jobs[0].EntityId, b.Jobs[0].EntityId);
        });

        return batches;
    }

    /// <summary>job 能否加入已有批（四条件）。</summary>
    public bool CanJoin(TickJob job, TickBatch batch)
    {
        var jw = KeySet(_registry.Spec(job.Kind).ExpandWrites(job.EntityId));
        var jr = KeySet(_registry.Spec(job.Kind).ExpandReads(job.EntityId));
        var jc = KeySet(_registry.Spec(job.Kind).ExpandEngineCaches(job.EntityId));

        foreach (var other in batch.Jobs)
        {
            var ow = KeySet(_registry.Spec(other.Kind).ExpandWrites(other.EntityId));
            var orReads = KeySet(_registry.Spec(other.Kind).ExpandReads(other.EntityId));
            var oc = KeySet(_registry.Spec(other.Kind).ExpandEngineCaches(other.EntityId));

            if (jw.Overlaps(ow)) return false;           // W/W
            if (jw.Overlaps(orReads)) return false;      // W/R（RAW）
            if (jr.Overlaps(ow)) return false;           // R/W（WAR）
            if (jc.Overlaps(oc)) return false;           // ★ 引擎缓存键
        }
        return true;
    }

    private static HashSet<string> KeySet(IEnumerable<string> keys) =>
        new(keys, StringComparer.Ordinal);
}
