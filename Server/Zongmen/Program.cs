using Zongmen;
using Zongmen.Events;
using Zongmen.Services;
using Zongmen.Subsystems;
using Zongmen.Subsystems.Characters;
using Zongmen.Subsystems.City;
using Zongmen.Storage;
using Zongmen.Time;
using Zongmen.Web;
using Microsoft.Extensions.Logging;

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

/* ★ 子系统装配 (2026-10-11 目录重构) ─────────────────────────────────────────
   一个子系统 = `Subsystems/<Name>/` 一个自包含文件夹 (模块 + 台账 + 执行器 + js)。
   ⚠ 必须在 MapWorldService **之前**建好: Core 要用它们的 JsvmModule 建 VM 池
     (每个 scope 一个独立 V8 实例), 并在换世 / 渲染叠加时回调它们。
   ⚠ 加子系统 = 这里多一行; Core 一行都不用改 (Core 不认识任何具体子系统类型)。 */
var engineJsDir = ZongmenPaths.ResolveEngineJsDir(options, contentRoot);
var cityJsDir = ZongmenPaths.ResolveCityJsDir(options, contentRoot);
var persistDb = options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : null;

var city = new CitySubsystem(persistDb, engineJsDir, cityJsDir);
/* ★ 角色子系统 (Subsystems/Characters): 独立 V8 (scope="characters"), 无台账 ——
   角色是 (seed,index) 的纯函数派生, 每次请求确定性重算 ⇒ 不需要 1MB 落库表。
   数据端点 /api/characters 由它自己声明 (见 CharactersSubsystem.MapEndpoints)。 */
var characters = new CharactersSubsystem(ZongmenPaths.ResolveCharactersDir(options, contentRoot));
var subsystems = new SubsystemRegistry(new ISubsystem[] { city, characters });

var worldService = new MapWorldService(options, contentRoot, subsystems);
builder.Services.AddSingleton(worldService);
builder.Services.AddSingleton(subsystems);
builder.Services.AddSingleton(city);
builder.Services.AddSingleton(city.Store);
builder.Services.AddSingleton(characters);

/* ── 世界时钟与 Tick 演化框架 (docs/游戏时钟与Tick演化框架方案.md v2.1) ──────
   形状: nextTick 落库 → 相位抖动摊批 → 解耦分批 → 消费队列 → 无状态 VM → 定序合流。
   ⚠ 三张独立表 (WorldClock / TickJob / TickPerf) 必须独立成表 ——
     塞 Data(Key,Value) 会被后台 PruneExcept **静默删掉** (同 WorldLedger/PlayerSectStore)。
   ⚠ P1 阶段: 执行器 = DemoTickExecutor (纯托管, 不碰 V8); P2 换成无状态 VM 池。 */
var tickOptions = options.Tick;
var tickDbPath = options.PersistEnabled
    ? ZongmenPaths.ResolveDbPath(options, contentRoot)
    : null;

builder.Services.AddSingleton(tickOptions);
builder.Services.AddSingleton(new WorldClockStore(tickDbPath));
builder.Services.AddSingleton(new TickJobStore(tickDbPath));
builder.Services.AddSingleton(new TickPerfStore(tickDbPath));
builder.Services.AddSingleton(new TickJobRegistry(tickOptions));
builder.Services.AddSingleton(new ConcurrentTickQueue());      // ★ 线程安全小顶堆
builder.Services.AddSingleton<TickScheduler>();
builder.Services.AddSingleton<TickPartitioner>();
builder.Services.AddSingleton(sp => new TickMetrics(
    tickOptions, sp.GetRequiredService<TickPerfStore>(),
    /* 类别名刻意短 ("tick" 而不是 Zongmen.Time.TickMetrics) —— 每 tick 一行,
       前缀越短越不占地方。 */
    sp.GetRequiredService<ILoggerFactory>().CreateLogger("tick")));
/* ★ 城市演化台账由 CitySubsystem 持有 (第三条独立表) —— 换世清空 / 渲染叠加都在它那里,
   Core 不再认识这个类型。⚠ 必须是**同一实例**: 建两个连接池会各行其是 (已由
   `AddSingleton(city.Store)` 保证)。 */
/* ⚠⚠ 这里**不能**把 TickPump 注入执行器 —— TickPump 依赖 ITickExecutor,
   构造本对象时再解析 TickPump 即成环。⚠ 因走 factory lambda ⇒ **绕过容器的循环检测**,
   结果是**永久静默挂死** (进程活着/不监听端口/零日志), 而不是抛异常。
   2026-09-27 实测: 后端卡在启动, 前端一直「正在生成」—— 就是这个环。
   ⇒ 执行器不需要 pump (pump 才是那个需要 executor 的一方)。
   ★ 多执行器由 TickExecutorHub 按 job.Kind 派发: 每个子系统一个执行器。
      ⚠ 不能直接注册多个 ITickExecutor —— 同名服务只取最后一个, 前一个认领的
        job 会永远 not-claimed 而静默停摆。 */
builder.Services.AddSingleton<ITickExecutor>(sp => new TickExecutorHub(new ITickExecutor[]
{
    new CityTickExecutor(
        sp.GetRequiredService<MapWorldService>(),
        sp.GetRequiredService<CityStateStore>(),
        tickOptions,
        sp.GetRequiredService<ILogger<CityTickExecutor>>()),
}));
builder.Services.AddSingleton<TickPump>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<TickPump>());

/* ── ★ 跨 tick 事件系统 (docs/游戏设计/跨tick事件系统-调研.md + Server/Zongmen/Events/) ──
   三张独立表:
     · `Entity`     —— 全局 int32 id ↔ 引擎字符串 id 的唯一映射（事件侧只认 int）
     · `EventQueue` —— 每个实体挂哪些事件、下次何时触发（调度真源，行数 = 未触发事件数）
     · `History`    —— 每次脚本执行的状态差（protobuf，只写变化字段；行数随 tick 增长）
   ⚠ 三张都必须**独立成表**: 塞 `Data(Key,Value)` 会被后台 `PruneExcept` 静默删掉 ——
     事件全部消失、号空间断档，且不报错（与 WorldLedger / TickJob 同一个坑）。
   ⚠ `EventRunner` 不注入 `TickPump`（用后置 hook 挂线），避免再加一个 DI 环。 */
builder.Services.AddSingleton(new EntityRegistry(tickDbPath));
builder.Services.AddSingleton(new EventStore(tickDbPath));
builder.Services.AddSingleton(sp => new EventRunner(
    new MapWorldServiceAccessor(sp.GetRequiredService<MapWorldService>()),
    sp.GetRequiredService<CityStateStore>(),
    sp.GetRequiredService<EntityRegistry>(),
    sp.GetRequiredService<EventStore>(),
    tickOptions,
    sp.GetRequiredService<ILoggerFactory>().CreateLogger("event")));

/* 小队存档: 独立 Crew 表 (不塞 Data(Key,Value) —— 会被 PruneExcept 静默清掉,
   与 WorldLedger 同一个坑)。PersistEnabled=false 时降级为仅内存。 */
builder.Services.AddSingleton(new CrewStore(
    options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : null));

/* 招募系统 (docs/游戏设计/招募系统-实施方案.md)
   · 影响力: 目前是桩 (恒 10, 保底 1)。接影响力系统时只换 InfluenceProvider 实现,
     RecruitStore 一行不改 (它只认 IInfluence 接口)。
   · 招募值与候选池 = 两张**独立表** (RecruitPoint / RecruitPool), 理由同 Crew:
     塞 Data 表会被 PruneExcept 静默删掉。 */
builder.Services.AddSingleton<IInfluence>(new InfluenceProvider());
builder.Services.AddSingleton(sp => new RecruitStore(
    options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : null,
    sp.GetRequiredService<IInfluence>()));

var app = builder.Build();

/* ★ JS 出口埋点的日志出口 (Engine/JsCallStats)。
   慢调用与异常的日志按 fn 各限流 30s 一条 —— 异常可以每秒几百次, 不限流会淹没 tick 日志。
   统计本身不受限流影响, 全量看 /api/clock/stats 的 js 字段。 */
Zongmen.Engine.JsCallStats.Attach(app.Logger);

/* 前端代理在前, /api/* 与 /ws/* 自动放行给端点 */
app.UseMiddleware<StaticWebMiddleware>(webDir);
app.UseMiddleware<ApiRateLimitMiddleware>();   // R6: per-IP 限流, 保护 tile/fields 即时计算不被钉死
app.UseWebSockets();                           // WebSocket 单块接口 (设计 §三/§五)
MapEndpoints.Map(app, app.Services.GetRequiredService<MapWorldService>());
/* 小队数据 (/api/crew): GET 取 / PUT 全量覆盖 / POST patch 增量 / DELETE 清空 */
CrewEndpoints.Map(app, app.Services.GetRequiredService<CrewStore>());

/* 只读时钟端点 (/api/clock)。⚠ 时钟是服务端资产, 前端只能读、不许自造。 */
var _pump = app.Services.GetRequiredService<TickPump>();
MapEndpoints.MapClock(app, _pump);

/* 招募系统 (/api/recruit/*): state / pool / roll / hire。
   ⚠ 时钟、世界种子、聚落身份全部由服务端自己查 —— 前端只给 settleId 与 slot。 */
RecruitEndpoints.Map(
    app,
    app.Services.GetRequiredService<RecruitStore>(),
    app.Services.GetRequiredService<CrewStore>(),
    app.Services.GetRequiredService<MapWorldService>(),
    _pump,
    app.Services.GetRequiredService<WorldClockStore>(),
    tickOptions);

/* ★ 跨 tick 事件系统挂线 —— **必须在 AttachTickPump 之前**：
   那一步会立刻 `BindWorld`，而 `BindWorld` 里会调 `BindEventsHook` 去载入 EventQueue。
   挂晚了 = 本世事件一条都不进内存堆 ⇒ 永远不触发，且日志里什么都看不到。 */
var _events = app.Services.GetRequiredService<EventRunner>();
_pump.BindEventsHook = _events.BindWorld;
_pump.RunEventsHook = (seed, round, tick) => _events.RunDue(seed, round, tick);

/* ★ 时钟挂到世界服务: 挂上即绑定当前世 (seed/round 来自 WorldLedger 台账)。
   ⚠ 必须在 app.Build() 之后 —— MapWorldService 是单例, 这里就是把两半接上的那一刻。 */
app.Services.GetRequiredService<MapWorldService>().AttachTickPump(_pump);
/* R11: 引擎脚本目录一并交给 WS 处理器 —— 前端按 seed 自算地形需要
   noise/mapgen-config/mapgen 三件套, 由 WS 下发 (单真源, 见 MapWsHandler.HandleScriptAsync)。 */
MapWsHandler.Map(app, app.Services.GetRequiredService<MapWorldService>(),
    ZongmenPaths.ResolveEngineJsDir(options, contentRoot),
    app.Services.GetRequiredService<TickPump>());   // 帧 7 = 世界时钟 (ClockQuery/ClockPush)
MapEndpoints.MapDebug(app, Path.Combine(ZongmenPaths.FindRoot(contentRoot), "verify", "capture.png"));
/* ★ 角色数据端点 (/api/characters) —— 由 Characters 子系统**自己声明**。
   ⚠ 放在这里而不是 MapEndpoints.cs: Web 层(Core)不该引用具体子系统类型;
     Program.cs 是组合根, 由它接线是允许的 (Core 一行未改)。 */
characters.MapEndpoints(app, worldService);

app.Lifetime.ApplicationStarted.Register(() =>
{
    var pump = app.Services.GetRequiredService<TickPump>();
    Console.WriteLine("======================================================");
    Console.WriteLine("  宗门模拟器 · 山河图后端 已启动 (C# + ClearScript V8)");
    Console.WriteLine($"  前端目录: {webDir}");
    Console.WriteLine($"  世界脚本: {ZongmenPaths.ResolveEngineJsDir(options, contentRoot)}");
    Console.WriteLine($"  数据库:   {(options.PersistEnabled ? ZongmenPaths.ResolveDbPath(options, contentRoot) : "(仅内存, 持久化关闭)")}");
    Console.WriteLine($"  配置根:   {contentRoot}  (MaxSeeds={options.MaxSeeds})");
    Console.WriteLine($"  世界时钟: {(tickOptions.TickEnabled ? $"已启用 (1 tick = 1 日, L0 摊批 M={tickOptions.L0SpreadTicks}, 执行器={app.Services.GetRequiredService<ITickExecutor>().Name})" : "已禁用")}");
    Console.WriteLine($"  子系统:   {subsystems.Describe()}");
    Console.WriteLine($"  VM:       每个子系统一个独立 V8 实例 = {string.Join(" + ", subsystems.Modules.Select(m => m.Scope))}");
    Console.WriteLine($"  访问地址: http://127.0.0.1:{options.Port}");
    Console.WriteLine("======================================================");
});

/* ⚠ 关机必须 flush 时钟与脏 job 行 (TickPump.UnbindWorld 已挂在这里的做法之外,
   再针对「泵没来得及退出」的路径补一次强制 flush)。 */
app.Lifetime.ApplicationStopping.Register(() =>
{
    try { app.Services.GetRequiredService<TickPump>().UnbindWorld(); }
    catch (Exception ex) { Console.Error.WriteLine($"[tick] 关机 flush 失败: {ex.Message}"); }
});

app.Run();
