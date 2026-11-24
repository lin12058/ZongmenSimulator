using System.Diagnostics;

namespace Zongmen.Time;

/* ============================================================
 * 多执行器分发 (2026-10-11 目录重构)
 * ------------------------------------------------------------
 * 引入理由: 「一个子系统一个执行器」之后, 不能再往 DI 里塞**单个**
 * ITickExecutor —— 那样后注册的会静默顶掉先注册的 (AddSingleton 同名服务取最后一个),
 * 表现为「某个子系统的 job 永远 not-claimed ⇒ 反复失败 ⇒ 退避停用」。
 *
 * 本类只做一件事: 按 job.Kind 把一批拆给认领它的执行器, 再把结果合流回来。
 * ⚠ 合流语义与单执行器时**逐项一致** (Outcomes 顺序 = 原批规范序的子序列),
 *   否则 TickPump 的 apply 顺序纪律被破坏 (排序键是 (Layer,EntityId,Kind))。
 * ============================================================ */
public sealed class TickExecutorHub : ITickExecutor
{
    private readonly ITickExecutor[] _execs;
    private readonly Dictionary<TickJobKind, int> _routeOf = new();

    public TickExecutorHub(IEnumerable<ITickExecutor> executors)
    {
        _execs = executors.ToArray();
        if (_execs.Length == 0) throw new InvalidOperationException("TickExecutorHub 至少要有一个执行器");

        for (var i = 0; i < _execs.Length; i++)
        {
            if (_execs[i].Claims.Count == 0)
                throw new InvalidOperationException(
                    $"执行器 {_execs[i].Name} 未声明 Claims —— 启动期就炸, 不要等到 job 到期才发现没人认领");
            foreach (var k in _execs[i].Claims)
            {
                if (_routeOf.TryGetValue(k, out var other))
                    throw new InvalidOperationException(
                        $"TickJobKind {k} 被两个执行器同时认领: {_execs[other].Name} / {_execs[i].Name} " +
                        "—— 静默二选一会让其中一个永远不跑, 所以这里显式拒绝");
                _routeOf[k] = i;
            }
        }
    }

    public string Name => "hub(" + string.Join("+", _execs.Select(e => e.Name)) + ")";

    public IReadOnlyList<TickJobKind> Claims => _routeOf.Keys.ToArray();

    public TickRunReport Execute(TickBatch batch, long nowTick, TickMetrics metrics, CancellationToken ct)
    {
        var report = new TickRunReport { TickId = batch.TickId };
        if (batch.Count == 0) return report;
        var sw = Stopwatch.StartNew();

        /* ① 分组。⚠ 分组的对象是 **job** 而不是「结果」 —— 到达顺序由线程调度决定,
             所以只有按原批规范序分组, 合流后的 apply 顺序才与到达顺序无关。 */
        List<TickJob>?[] buckets = new List<TickJob>?[_execs.Length];
        foreach (var job in batch.Jobs)
        {
            if (!_routeOf.TryGetValue(job.Kind, out var idx))
            {
                /* 没有任何执行器认领 ⇒ 显式回报, 让上层看得见「有 job 没人管」而不是静默吞掉。
                   ⚠ 这条会让 TickPump 走退避/停用 —— 正是想要的效果 (而非无声地每天重试)。 */
                report.Outcomes.Add(new TickOutcome(job, false, "not-claimed-by-any-executor", 0, 0, 0));
                continue;
            }
            (buckets[idx] ??= new List<TickJob>(batch.Count)).Add(job);
        }

        /* ② 逐执行器跑自己那一桶, 结果按**执行器序**合流。 */
        for (var i = 0; i < _execs.Length; i++)
        {
            var jobs = buckets[i];
            if (jobs is null || jobs.Count == 0) continue;
            var sub = new TickBatch
            {
                TickId = batch.TickId,
                Resource = batch.Resource,
                Layer = batch.Layer,
                Jobs = jobs,
                Serial = batch.Serial,
            };
            var r = _execs[i].Execute(sub, nowTick, metrics, ct);
            report.Outcomes.AddRange(r.Outcomes);
            report.Skipped += r.Skipped;
            if (r.BudgetExceeded) report.BudgetExceeded = true;
        }

        report.TotalMs = sw.Elapsed.TotalMilliseconds;
        return report;
    }
}
