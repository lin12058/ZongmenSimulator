using Zongmen.Services;

namespace Zongmen.Web;

/* ============================================================
 * API 端点 — /api/map/*
 *   chunk / region / comm / tile: gzip(protobuf) 二进制下发
 *     (设置 Content-Encoding: gzip, 客户端 fetch 透明解压)
 *   meta / fields / stats: JSON
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

        app.MapGet("/api/map/chunk", (string seed, int ca, int cb, HttpContext ctx) =>
            Binary(ctx, svc.GetChunkBytes(seed, ca, cb)));

        app.MapGet("/api/map/region", (string seed, int i, int j, HttpContext ctx) =>
            Binary(ctx, svc.GetRegionBytes(seed, i, j)));

        app.MapGet("/api/map/comm", (string seed, int ci, int cj, HttpContext ctx) =>
            Binary(ctx, svc.GetCommBytes(seed, ci, cj)));

        app.MapGet("/api/map/tile", (string seed, int q, int r, HttpContext ctx) =>
            Binary(ctx, svc.GetTileBytes(seed, q, r)));

        app.MapGet("/api/map/fields", (string seed, int q0, int q1, int r0, int r1) =>
            Results.Text(svc.GetFieldGridJson(seed, q0, q1, r0, r1), "application/json; charset=utf-8"));
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
        ctx.Response.Headers.CacheControl = "public, max-age=86400";
        return Results.Bytes(gz, "application/x-protobuf");
    }
}
