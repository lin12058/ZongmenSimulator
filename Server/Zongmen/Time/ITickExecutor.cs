using System.Diagnostics;

namespace Zongmen.Time;

/// <summary>单个 job 的执行结果。</summary>
public readonly record struct TickOutcome(
    TickJob Job,
    bool Ok,
    string? Error,
    double JsMs,
    int BytesIn,
    int BytesOut);

/// <summary>一批的执行结果。</summary>
public sealed class TickRunReport
{
    public long TickId { get; init; }
    public List<TickOutcome> Outcomes { get; } = new();
    public double TotalMs { get; set; }
    public bool BudgetExceeded { get; set; }
    public int Skipped { get; set; }
}

/// <summary>
/// 执行器抽象 —— **P1 与 P2 的分界线**。
///
/// P1 落地为 <see cref="DemoTickExecutor"/>：**纯托管、完全不碰 V8**。
///   目的很单一 —— 让「时钟 → 相位 → 收集 → 分批 → 执行 → 合流 → 重排」这条链路
///   先可验证，不把 V8 边界（`pben.js` / `CallBytes` / 复用缓冲 / spike）一起拖进来。
///
/// P2 换成 `TickVmPoolExecutor`：S 个无状态 VM + protobuf 边界。
///   ⚠ 那时**只换实现，不动 pump** —— 这正是引入这层抽象的全部理由。
/// </summary>
public interface ITickExecutor
{
    /// <summary>执行一批 job。**不得抛异常**（单个 job 失败要回成 outcome.Ok=false）。</summary>
    TickRunReport Execute(TickBatch batch, long nowTick, TickMetrics metrics, CancellationToken ct);

    /// <summary>人类可读名（/stats 与日志用）。</summary>
    string Name { get; }
}

/// <summary>
/// P1 演示执行器：不碰 V8，只记账。
///
/// ⚠ 它**必须**模拟真实的「耗时 + 字节量 + 可失败的 job」，否则 P1 的判据
///   （尤其 `check_tick_budget` / 分段计时）测不出任何东西。
/// ⚠ 它**绝不写世界** —— 红线 1 从第一天就守住。
/// </summary>
public sealed class DemoTickExecutor : ITickExecutor
{
    private readonly TickOptions _opt;
    private readonly Dictionary<string, long> _heartbeats = new(StringComparer.Ordinal);
    private readonly Random _rng;

    /// <summary>刻意失败比例（0 = 永不失败）。判据靠它验证退避与停用。</summary>
    public double FailRate { get; set; }

    /// <summary>每次 job 的模拟耗时（毫秒）。0 = 不模拟。</summary>
    public double SimulatedJsMs { get; set; } = 0.05;

    public string Name => "demo";
    public IReadOnlyDictionary<string, long> Heartbeats => _heartbeats;

    public DemoTickExecutor(TickOptions opt, int seed = 12345)
    {
        _opt = opt;
        _rng = new Random(seed);
    }

    public TickRunReport Execute(TickBatch batch, long nowTick, TickMetrics metrics, CancellationToken ct)
    {
        var report = new TickRunReport { TickId = batch.TickId };

        foreach (var job in batch.Jobs)
        {
            if (ct.IsCancellationRequested) { report.Skipped = batch.Jobs.Count - report.Outcomes.Count; break; }

            double jsMs = 0;
            var bytesIn = 0;
            var bytesOut = 0;

            try
            {
                switch (job.Kind)
                {
                    case TickJobKind.DemoHeartbeat:
                        // 真实语义：只 +dt（★ 按 Δt 积分，不是 +1）
                        _heartbeats.TryGetValue(job.EntityId, out var prev);
                        _heartbeats[job.EntityId] = prev + job.DtTicks;
                        bytesIn = 8 + job.EntityId.Length;
                        bytesOut = 16;
                        break;

                    // L0 的语义骨架（真实公式在 P2 进引擎）
                    case TickJobKind.PopGrowth:
                    case TickJobKind.SectCultivation:
                    case TickJobKind.Lifespan:
                        bytesIn = 24;
                        bytesOut = 24;
                        break;

                    default:
                        // L1/L2 在 P1 不该到期（没人投递它们）
                        report.Outcomes.Add(new TickOutcome(job, false, "not-implemented-in-p1", 0, 0, 0));
                        continue;
                }

                if (SimulatedJsMs > 0)
                {
                    // 用「忙等」模拟真实 CPU 占用（Thread.Sleep 粒度太粗，测不出分段）
                    var target = (long)(SimulatedJsMs * Stopwatch.Frequency / 1000.0);
                    metrics.AddJsMs(job.Kind, SimulatedJsMs);
                    var t0 = Stopwatch.GetTimestamp();
                    while (Stopwatch.GetTimestamp() - t0 < target) { /* spin */ }
                    jsMs = SimulatedJsMs;
                }

                var ok = FailRate <= 0 || _rng.NextDouble() >= FailRate;
                report.Outcomes.Add(new TickOutcome(
                    job, ok, ok ? null : "simulated-failure", jsMs, bytesIn, bytesOut));
            }
            catch (Exception ex)
            {
                // ⚠ 单个 job 抛异常不该废掉整批
                report.Outcomes.Add(new TickOutcome(job, false, ex.GetType().Name + ": " + ex.Message, jsMs, bytesIn, bytesOut));
            }
        }

        return report;
    }
}
