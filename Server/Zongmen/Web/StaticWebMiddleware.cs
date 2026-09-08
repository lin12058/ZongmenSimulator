namespace Zongmen.Web;

/* ============================================================
 * 静态代理中间件 — C# 后端默认托管前端 (web/ 目录),
 * 等价替代旧 node server.js: 无需另启前端程序。
 * /api/* 一律放行交给 API 端点。
 * ============================================================ */

public sealed class StaticWebMiddleware
{
    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".svg"] = "image/svg+xml",
        [".ico"] = "image/x-icon",
        [".json"] = "application/json; charset=utf-8",
        [".woff2"] = "font/woff2",
        [".md"] = "text/markdown; charset=utf-8",
    };

    private readonly RequestDelegate _next;
    private readonly string _root;

    public StaticWebMiddleware(RequestDelegate next, string webRoot)
    {
        _next = next;
        _root = Path.GetFullPath(webRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        var req = ctx.Request;
        var isGet = req.Method == HttpMethods.Get || req.Method == HttpMethods.Head;
        var path = req.Path.Value ?? "/";
        if (!isGet || path.StartsWith("/api", StringComparison.OrdinalIgnoreCase))
        {
            await _next(ctx);
            return;
        }

        var rel = path.TrimStart('/');
        if (rel.Length == 0) rel = "index.html";
        var full = Path.GetFullPath(Path.Combine(_root, rel));
        if (!full.StartsWith(_root, StringComparison.OrdinalIgnoreCase))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (!File.Exists(full) && !Path.HasExtension(rel))
        {
            full = Path.Combine(_root, "index.html");   // 无扩展名路径回退首页
        }
        if (!File.Exists(full))
        {
            ctx.Response.StatusCode = StatusCodes.Status404NotFound;
            await ctx.Response.WriteAsync("not found: " + rel);
            return;
        }

        var ext = Path.GetExtension(full).ToLowerInvariant();
        var bytes = await File.ReadAllBytesAsync(full);
        ctx.Response.StatusCode = 200;
        ctx.Response.ContentType = Mime.TryGetValue(ext, out var ct) ? ct : "application/octet-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.ContentLength = bytes.Length;
        await ctx.Response.Body.WriteAsync(bytes);
    }
}
