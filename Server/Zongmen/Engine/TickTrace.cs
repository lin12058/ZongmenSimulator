namespace Zongmen.Engine;

/* ============================================================
 * 每 tick 的事件耗时桶 —— 「这个 tick 的时间花在哪些事件上」。
 * ------------------------------------------------------------
 * ⚠ 用 AsyncLocal 而不是普通静态字段: 同一个进程里 HTTP 请求 (tileJson /
 *   citySettlementsJson / chargenPool) 与 tick **并行**跑, 静态桶会把请求的耗时
 *   记到 tick 头上 —— 账面上 tick 变慢而实际什么都没干, 是最难查的那种错。
 *   AsyncLocal 只在 TickPump 的执行上下文里可见 ⇒ 请求线程拿到 null, 直接不记。
 *
 * 用法:
 *   TickMetrics.BeginTick → TickTrace.Begin()
 *   TickMetrics.EndTick   → TickTrace.Take()  (取走并清空; 无事件返回 null)
 * 记录方:
 *   JsCallStats.Hit —— 每个 JS 出口 (fn 名) + 门闩等待 (wait)
 *   其它想归因的阶段 (init/put/trade...) 直接调 Hit("名字", 微秒)
 * ============================================================ */
public static class TickTrace
{
    private static readonly AsyncLocal<Dictionary<string, long>?> Cur = new();

    /// <summary>开一个空桶 (tick 起点)。重复调用会丢弃上一个未取走的桶。</summary>
    public static void Begin() => Cur.Value = new Dictionary<string, long>(8, StringComparer.Ordinal);

    /// <summary>取走本 tick 的事件耗时 (微秒); 一条都没有则返回 null。</summary>
    public static Dictionary<string, long>? Take()
    {
        var b = Cur.Value;
        Cur.Value = null;
        return b is { Count: > 0 } ? b : null;
    }

    /// <summary>记一次事件。tick 之外 (HTTP 请求 / 后台任务) 调用是 no-op。</summary>
    public static void Hit(string name, long us)
    {
        var b = Cur.Value;
        if (b is null || us <= 0) return;
        b[name] = b.GetValueOrDefault(name) + us;
    }

    /// <summary>Stopwatch 差值 → 微秒。集中在这里，避免每个调用点各写一遍换算。</summary>
    public static long Us(long stopwatchTicks)
        => (long)(stopwatchTicks * (1_000_000.0 / System.Diagnostics.Stopwatch.Frequency));

    /// <summary>
    /// 当前桶里某事件已累计的微秒 (没有则 0)。
    /// 用途: 记「净开销 = 总 − 已经单独记过的子项」, 避免同一段时间被记两次
    /// (例: init 里调了 citySettlementsJson, 若 init 直接记总时长就会与它重复)。
    /// </summary>
    public static long Get(string name)
    {
        var b = Cur.Value;
        return b is not null && b.TryGetValue(name, out var v) ? v : 0;
    }
}
