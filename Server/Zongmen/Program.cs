using Zongmen;
using Zongmen.Services;
using Zongmen.Web;

/* ============================================================
 * 宗门模拟器 · 山河图 — 后端统一宿主 (参考文档 StartWeb 装配)
 *   单进程: C# 默认代理前端 (web/) + /api/map/* 权威地图服务
 * ============================================================ */

var builder = WebApplication.CreateBuilder(args);

var options = builder.Configuration.GetSection("Zongmen").Get<ZongmenOptions>() ?? new ZongmenOptions();
var contentRoot = builder.Environment.ContentRootPath;
var webDir = ZongmenPaths.ResolveWebDir(options, contentRoot);
if (!File.Exists(Path.Combine(webDir, "index.html")))
    throw new DirectoryNotFoundException($"未找到前端目录(web/index.html): {webDir}");

builder.WebHost.UseUrls($"http://0.0.0.0:{options.Port}");
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(new MapWorldService(options, contentRoot));

var app = builder.Build();

/* 前端代理在前, /api/* 自动放行给端点 */
app.UseMiddleware<StaticWebMiddleware>(webDir);
MapEndpoints.Map(app, app.Services.GetRequiredService<MapWorldService>());
MapEndpoints.MapDebug(app, Path.Combine(ZongmenPaths.FindRoot(contentRoot), "verify", "capture.png"));

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine("======================================================");
    Console.WriteLine("  宗门模拟器 · 山河图后端 已启动 (C# + ClearScript V8)");
    Console.WriteLine($"  前端目录: {webDir}");
    Console.WriteLine($"  世界脚本: {ZongmenPaths.ResolveEngineJsDir(options, contentRoot)}");
    Console.WriteLine($"  数据库:   {(options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : "(仅内存, 持久化关闭)")}");
    Console.WriteLine($"  访问地址: http://127.0.0.1:{options.Port}");
    Console.WriteLine("======================================================");
});

app.Run();
