using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Zongmen.Engine;

/* ============================================================
 * JS 出口调用埋点 —— 「每个 js 一行统计, 只打慢/错」。
 * ------------------------------------------------------------
 * ⚠ 唯一埋点是 <see cref="JsVm.Call"/>: 全仓只有那一处调 `_module.Invoke`
 *   (30 个出口全走它) ⇒ **新增 JS 出口自动被覆盖**, 出口处不用再埋一次。
 *
 * 三类信息:
 *   ① 耗时 —— 每次调用累计 exec/wait 微秒, 逐 fn 给 n/avg/max;
 *      `wait` = 等 V8 门闩的时间 (被别的请求/别的 tick 占着), 与「真算」分开。
 *   ② 报错 —— 抛异常必计 err, 并打一行 (按 fn 限流)。
 *   ③ 时间戳 —— 由 ILogger 提供, 行内不重复写。
 *
 * 日志格式 (刻意压到最短, 无中文、无字段名冗余):
 *     [js] 278.4ms cityEvolveJson
 *     [js] 278.4ms cityEvolveJson wait=180.2 ERR:TypeError: x is not a function
 *   `wait=` 只在等门闩 ≥1ms 时出现 (否则纯噪声)。
 *
 * 全量看 /api/clock/stats 的 `js` 字段 (按单次最大值降序)。
 * ============================================================ */
public static class JsCallStats
{
    /// <summary>单次执行超过这个毫秒数 ⇒ 记 slow 并尝试打一行日志。</summary>
    public const long SlowMs = 50;

    /// <summary>同一个 fn 的慢/错日志最小间隔 (毫秒) —— 防刷爆 (异常可以每秒几百次)。</summary>
    public const long QuietMs = 30_000;

    private sealed class E
    {
        public string Scope = "";
        public long N, Err, Slow;
        public long TotalUs, MaxUs, WaitUs, WaitMaxUs;
        public long LastSlowMs, LastErrMs;
    }

    private static readonly ConcurrentDictionary<string, E> Map = new(StringComparer.Ordinal);
    private static readonly double UsPerTick = 1_000_000.0 / Stopwatch.Frequency;

    private static ILogger? _log;

    /// <summary>接到宿主日志 (Program.cs 启动时一次)。未接时退回 stderr。</summary>
    public static void Attach(ILogger log) => _log = log;

    /// <summary>记一次调用。⚠ 热路径: 只有 2 次时间戳 + 几个 Interlocked。</summary>
    public static void Hit(string scope, string fn, long waitTicks, long execTicks, Exception? err)
    {
        var e = Map.GetOrAdd(fn, _ => new E { Scope = scope });

        var waitUs = (long)(waitTicks * UsPerTick);
        var execUs = (long)(execTicks * UsPerTick);

        Interlocked.Increment(ref e.N);
        Interlocked.Add(ref e.TotalUs, execUs);
        Interlocked.Add(ref e.WaitUs, waitUs);
        Bump(ref e.MaxUs, execUs);
        Bump(ref e.WaitMaxUs, waitUs);

        /* ★ 每 tick 归因 (TickTrace): 只在本 tick 的执行上下文里有桶。
           HTTP 请求触发时桶为 null ⇒ 不记 —— 否则玩家拉图的耗时会被算进 tick 账上。 */
        TickTrace.Hit(fn, execUs);
        TickTrace.Hit("wait", waitUs);

        var now = Environment.TickCount64;

        if (err is not null)
        {
            Interlocked.Increment(ref e.Err);
            if (now - Interlocked.Read(ref e.LastErrMs) < QuietMs) return;
            Interlocked.Exchange(ref e.LastErrMs, now);
            Emit($"{Ms(execUs):F1}ms {fn}" + WaitPart(waitUs) + " ERR:" + FirstLine(err));
            return;
        }

        if (execUs < SlowMs * 1000) return;
        Interlocked.Increment(ref e.Slow);
        if (now - Interlocked.Read(ref e.LastSlowMs) < QuietMs) return;
        Interlocked.Exchange(ref e.LastSlowMs, now);
        Emit($"{Ms(execUs):F1}ms {fn}" + WaitPart(waitUs));
    }

    /// <summary>逐 fn 快照 (按单次最大耗时降序)。字段名刻意短, 一个 fn 一行。</summary>
    public static IReadOnlyList<Row> Snapshot()
    {
        var rows = new List<Row>(Map.Count);
        foreach (var kv in Map)
        {
            var e = kv.Value;
            var n = Math.Max(1, Interlocked.Read(ref e.N));
            rows.Add(new Row(
                fn: kv.Key,
                scope: e.Scope,
                n: n,
                err: Interlocked.Read(ref e.Err),
                slow: Interlocked.Read(ref e.Slow),
                avgMs: Math.Round(Interlocked.Read(ref e.TotalUs) / 1000.0 / n, 2),
                maxMs: Math.Round(Interlocked.Read(ref e.MaxUs) / 1000.0, 2),
                wmaxMs: Math.Round(Interlocked.Read(ref e.WaitMaxUs) / 1000.0, 2)));
        }
        rows.Sort((a, b) => b.maxMs.CompareTo(a.maxMs));
        return rows;
    }

    public sealed record Row(string fn, string scope, long n, long err, long slow,
                            double avgMs, double maxMs, double wmaxMs);

    // ── 内部 ──────────────────────────────────────────────────────────

    private static string WaitPart(long waitUs)
        => waitUs >= 1000 ? $" wait={Ms(waitUs):F1}" : "";

    private static double Ms(long us) => us / 1000.0;

    /// <summary>异常只取第一行 —— ClearScript 的 Message 带整段 JS 调用栈, 塞进日志会淹没信息。</summary>
    private static string FirstLine(Exception ex)
    {
        var s = ex.Message;
        var i = s.IndexOfAny(new[] { '\r', '\n' });
        return (i > 0 ? s[..i] : s).Trim();
    }

    private static void Emit(string msg)
    {
        var log = _log;
        if (log is not null) log.LogWarning("[js] {Msg}", msg);
        else Console.Error.WriteLine($"[{DateTime.Now:HH:mm:ss}] [js] {msg}");
    }

    /// <summary>CAS 取最大 (无锁; 争用极低, 不用 lock 拖住热路径)。</summary>
    private static void Bump(ref long target, long v)
    {
        long cur;
        while (v > (cur = Interlocked.Read(ref target)))
            if (Interlocked.CompareExchange(ref target, v, cur) == cur) return;
    }
}
