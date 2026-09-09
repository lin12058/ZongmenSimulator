using System.Collections.Concurrent;

namespace Zongmen.Web;

/* ============================================================
 * 静态代理中间件 — C# 后端默认托管前端 (web/ 目录),
 * 等价替代旧 node server.js: 无需另启前端程序。
 * /api/* 一律放行交给 API 端点。
 *
 * R2: 小文件内存缓存 + ETag/Last-Modified + 304 Not Modified ——
 *     不再每次 File.ReadAllBytesAsync 全量读盘, 浏览器可缓存校验,
 *     热启动/频繁刷新免去重复传输。
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

    /* R2: 已读文件缓存 — 以 fullPath 为键; mtime/长度变化即失效重读。
       前端脚本总共几 MB 以内, 内存占用可忽略; 上限 64 项防止目录枚举膨胀。 */
    private const long CacheMaxFileBytes = 8 * 1024 * 1024;
    private const int CacheMaxItems = 64;
    private static readonly ConcurrentDictionary<string, CachedFile> FileCache = new();

    private sealed record CachedFile(byte[] Bytes, DateTime LastWriteUtc, long Length, string Etag);

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
        /* /ws 升级握手 (WebSocket 单块接口) 与非 GET 一律放行交给端点 */
        if (!isGet || path.StartsWith("/api", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/ws", StringComparison.OrdinalIgnoreCase)
            || ctx.WebSockets.IsWebSocketRequest)
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
        ctx.Response.ContentType = Mime.TryGetValue(ext, out var ct) ? ct : "application/octet-stream";

        var cached = GetCached(full);
        ctx.Response.Headers.ETag = cached.Etag;
        ctx.Response.Headers.LastModified = cached.LastWriteUtc.ToUniversalTime().ToString("R");
        /* no-cache = 浏览器可缓存, 但每次需条件请求校验 → ETag 命中直接 304, 免去重复传输 */
        ctx.Response.Headers.CacheControl = "no-cache";

        /* 条件请求: If-None-Match (ETag) 优先, 其次 If-Modified-Since */
        if (IsNotModified(ctx.Request, cached))
        {
            ctx.Response.StatusCode = StatusCodes.Status304NotModified;
            return;
        }

        ctx.Response.StatusCode = 200;
        ctx.Response.ContentLength = cached.Bytes.Length;
        if (req.Method == HttpMethods.Head) return;      // HEAD: 只回头不回体
        await ctx.Response.Body.WriteAsync(cached.Bytes);
    }

    private static CachedFile GetCached(string full)
    {
        var fi = new FileInfo(full);
        var lastWrite = fi.LastWriteTimeUtc;
        var length = fi.Length;
        if (FileCache.TryGetValue(full, out var c)
            && c.LastWriteUtc == lastWrite && c.Length == length)
        {
            return c;
        }
        /* R2: 小文件内存缓存 (≤8MB), 避免热路径反复读盘; 超过则每次直读不缓存 */
        byte[] bytes;
        if (length <= CacheMaxFileBytes)
        {
            bytes = File.ReadAllBytes(full);
            var etag = MakeEtag(lastWrite, length);
            var entry = new CachedFile(bytes, lastWrite, length, etag);
            FileCache[full] = entry;
            if (FileCache.Count > CacheMaxItems) TrimCache();
            return entry;
        }
        bytes = File.ReadAllBytes(full);
        return new CachedFile(bytes, lastWrite, length, MakeEtag(lastWrite, length));
    }

    private static void TrimCache()
    {
        /* 超限时随机淘汰一半, 简单避免长期运行下条目无限累积 */
        var victim = FileCache.Keys.Take(FileCache.Count / 2).ToList();
        foreach (var k in victim) FileCache.TryRemove(k, out _);
    }

    private static string MakeEtag(DateTime lastWriteUtc, long length)
        => $"\"{lastWriteUtc.ToFileTimeUtc():x}-{length:x}\"";

    private static bool IsNotModified(HttpRequest req, CachedFile cached)
    {
        if (req.Headers.TryGetValue("If-None-Match", out var inm))
        {
            foreach (var v in inm)
            {
                if (string.Equals(v, cached.Etag, StringComparison.Ordinal)) return true;
            }
            return false;    // 有 If-None-Match 但不匹配 → 必须 200
        }
        if (req.Headers.TryGetValue("If-Modified-Since", out var ims) &&
            DateTimeOffset.TryParse(ims.ToString(), out var since))
        {
            var file = new DateTimeOffset(cached.LastWriteUtc).ToUniversalTime();
            // HTTP 规定: 只当文件时间 ≤ 提供时间才可 304 (秒级精度)
            if (file <= since.AddSeconds(1)) return true;
        }
        return false;
    }
}
