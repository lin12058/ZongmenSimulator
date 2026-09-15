using Zongmen;
using Zongmen.Services;
using Zongmen.Web;

/* ============================================================
 * 宗门模拟器 · 山河图 — 后端统一宿主 (参考文档 StartWeb 装配)
 *   单进程: C# 默认代理前端 (web/) + /api/map/* 权威地图服务
 * ============================================================ */

/* 配置根 = exe 所在目录。CreateBuilder(args) 默认以「当前工作目录」为 ContentRoot,
   且 appsettings.json 是在 CreateBuilder 期间加载的 —— 从仓库根执行
   ./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe 时根目录并无 appsettings.json,
   于是整份配置被静默忽略 (Port/MaxSeeds/PersistEnabled 全部回落代码默认值)。
   用 WebApplicationOptions 在「配置加载之前」指定 ContentRoot, 配置即按预期生效;
   资源定位 (web/引擎脚本/db) 仍由 ZongmenPaths.FindRoot 自 exe 目录向上查找。 */
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = AppContext.BaseDirectory,
});

var options = builder.Configuration.GetSection("Zongmen").Get<ZongmenOptions>() ?? new ZongmenOptions();
var contentRoot = builder.Environment.ContentRootPath;
var webDir = ZongmenPaths.ResolveWebDir(options, contentRoot);
if (!File.Exists(Path.Combine(webDir, "index.html")))
    throw new DirectoryNotFoundException($"未找到前端目录(web/index.html): {webDir}");

builder.WebHost.UseUrls($"http://0.0.0.0:{options.Port}");
builder.Services.AddSingleton(options);
builder.Services.AddSingleton(new MapWorldService(options, contentRoot));

var app = builder.Build();

/* 前端代理在前, /api/* 与 /ws/* 自动放行给端点 */
app.UseMiddleware<StaticWebMiddleware>(webDir);
app.UseMiddleware<ApiRateLimitMiddleware>();   // R6: per-IP 限流, 保护 tile/fields 即时计算不被钉死
app.UseWebSockets();                           // WebSocket 单块接口 (设计 §三/§五)
MapEndpoints.Map(app, app.Services.GetRequiredService<MapWorldService>());
/* R11: 引擎脚本目录一并交给 WS 处理器 —— 前端按 seed 自算地形需要
   noise/mapgen-config/mapgen 三件套, 由 WS 下发 (单真源, 见 MapWsHandler.HandleScriptAsync)。 */
MapWsHandler.Map(app, app.Services.GetRequiredService<MapWorldService>(),
    ZongmenPaths.ResolveEngineJsDir(options, contentRoot));
MapEndpoints.MapDebug(app, Path.Combine(ZongmenPaths.FindRoot(contentRoot), "verify", "capture.png"));

app.Lifetime.ApplicationStarted.Register(() =>
{
    Console.WriteLine("======================================================");
    Console.WriteLine("  宗门模拟器 · 山河图后端 已启动 (C# + ClearScript V8)");
    Console.WriteLine($"  前端目录: {webDir}");
    Console.WriteLine($"  世界脚本: {ZongmenPaths.ResolveEngineJsDir(options, contentRoot)}");
    Console.WriteLine($"  数据库:   {(options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : "(仅内存, 持久化关闭)")}");
    Console.WriteLine($"  配置根:   {contentRoot}  (MaxSeeds={options.MaxSeeds})");
    Console.WriteLine($"  访问地址: http://127.0.0.1:{options.Port}");
    Console.WriteLine("======================================================");
});

app.Run();
