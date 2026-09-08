using System.Collections.Concurrent;

namespace Zongmen.Web;

/* ============================================================
 * API 限流中间件 — 保护 V8 门闩不被高频即时计算请求钉死 (R6)
 *   tile / fields 属"每次即时计算"热点 (chunk/region/comm 有持久化
 *   缓存兜底, 命中率极高, 不限流); 小地图 0.4~1.5s 轮询 + 点击
 *   连发都打这两个端点。per-IP 固定窗口计数, 超限 429。
 * ============================================================ */

public sealed class ApiRateLimitMiddleware
{
    /// <summary>窗口大小 (秒) 与窗口内每 IP 上限。默认 5s / 120 次 = 24 rps,
    /// 正常单用户小地图(≤3 rps)+连点(≤20 rps)远低于上限。</summary>
    private const int WindowSec = 5;
    private const int LimitPerIp = 120;

    private readonly RequestDelegate _next;
    private readonly ConcurrentDictionary<string, (long WindowStartTicks, int Count)> _hits = new();

    public ApiRateLimitMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var p = ctx.Request.Path.Value ?? "";
        bool isHot = p.Equals("/api/map/tile", StringComparison.OrdinalIgnoreCase)
                  || p.Equals("/api/map/fields", StringComparison.OrdinalIgnoreCase);
        if (!isHot)
        {
            await _next(ctx);
            return;
        }

        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var now = DateTime.UtcNow.Ticks;
        var window = TimeSpan.TicksPerSecond * WindowSec;
        var entry = _hits.AddOrUpdate(ip,
            _ => (now, 1),
            (_, old) => (now - old.WindowStartTicks >= window) ? (now, 1) : (old.WindowStartTicks, old.Count + 1));

        if (entry.Count > LimitPerIp)
        {
            ctx.Response.StatusCode = StatusCodes.Status429TooManyRequests;
            ctx.Response.Headers.RetryAfter = WindowSec.ToString();
            await ctx.Response.WriteAsync("rate limited: too many tile/fields requests");
            return;
        }
        try
        {
            await _next(ctx);
        }
        finally
        {
            /* 定期清理过期条目, 防 IP 字典无限增长 (每次请求只做一次廉价检查) */
            if (_hits.Count > 1024 && (now & 0x3FF) == 0) Prune(now);
        }
    }

    private void Prune(long now)
    {
        var window = TimeSpan.TicksPerSecond * WindowSec;
        foreach (var kv in _hits)
        {
            if (now - kv.Value.WindowStartTicks >= window)
                _hits.TryRemove(kv.Key, out _);
        }
    }
}
