using Zongmen.Services;

namespace Zongmen.Web;

/* ============================================================
 * API 端点 — /api/map/*
 *   WebSocket 单块重构后 (设计 §一.3): 图数据 (chunk/region/comm)
 *   全部走 ws://…/ws/map, HTTP 不再保留任何拉图接口 (验收 §8.4)。
 *   meta / stats / tile / fields: JSON 或 gzip(protobuf)
 * ============================================================ */

public static class MapEndpoints
{
    public static void Map(WebApplication app, MapWorldService svc)
    {
        app.MapGet("/", () => Results.Redirect("/index.html"));

        app.MapGet("/api/map/meta", (string? seed) =>
            Results.Text(svc.GetMetaJson(seed ?? ""), "application/json; charset=utf-8"));

        app.MapGet("/api/map/stats", () =>
            Results.Text(svc.StatsJson(), "application/json; charset=utf-8"));

        app.MapGet("/api/map/tile", (string seed, int q, int r, HttpContext ctx) =>
            Binary(ctx, svc.GetTileBytes(seed, q, r)));

        app.MapGet("/api/map/fields", (string seed, int q0, int q1, int r0, int r1) =>
            Results.Text(svc.GetFieldGridJson(seed, q0, q1, r0, r1), "application/json; charset=utf-8"));

        /* ---- 世界种子台账 (W · 2026-09-16) ----
           种子是服务端资产: 客户端只能「领当前世 / 求下一世」, 不能自己造 —— 于是多端同世界、
           刷新不掉世、重启不换界。⚠ 这三个端点不返回任何地图数据, 不进速率限制语义边界。 */
        app.MapGet("/api/world/current", () =>
            Results.Text(svc.WorldCurrentJson(), "application/json; charset=utf-8"));

        /* POST 而非 GET: 有副作用 (轮次 +1 并落库), 不能被浏览器/代理预取或缓存重放 */
        app.MapPost("/api/world/next", () =>
            Results.Text(svc.WorldNextJson(), "application/json; charset=utf-8"));

        app.MapGet("/api/world/list", (int? n) =>
            Results.Text(svc.WorldListJson(n is > 0 and <= 200 ? n.Value : 20), "application/json; charset=utf-8"));
    }

    /* 调试钩子: 接收前端自截图 PNG, 保存到 verify/capture.png 供自动化截图验证 */
    public static void MapDebug(WebApplication app, string savePath)
    {
        app.MapPost("/api/debug/snap", async (HttpRequest req) =>
        {
            using var ms = new MemoryStream();
            await req.Body.CopyToAsync(ms);
            Directory.CreateDirectory(Path.GetDirectoryName(savePath)!);
            await File.WriteAllBytesAsync(savePath, ms.ToArray());
            return Results.Text("ok " + ms.Length);
        });
    }

    private static IResult Binary(HttpContext ctx, byte[] gz)
    {
        ctx.Response.Headers.ContentEncoding = "gzip";
        /* tile 内容依赖 VM roadVersion (新 A* 道路落成即变), 不能给固定长缓存 —
           否则浏览器/中间代理会长期复用过期 onRoad/水距。改 no-cache:
           每次条件请求校验; 服务端无 ETag, 故直接重取 (payload 很小)。 */
        ctx.Response.Headers.CacheControl = "no-cache, no-store";
        return Results.Bytes(gz, "application/x-protobuf");
    }
}
