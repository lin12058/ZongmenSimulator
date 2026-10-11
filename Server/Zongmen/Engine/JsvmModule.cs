using System.Text;

namespace Zongmen.Engine;

/* ============================================================
 * 子系统 V8 模块契约 (2026-10-11 目录重构 · 一个子系统一个虚拟机)
 * ------------------------------------------------------------
 * 一个 JsvmModule = 一个 V8 实例的**全部静态声明**:
 *     ① 脚本组成与加载序   ② 导出根成员名   ③ 出口白名单 (Invoke)
 * 子系统把自己的模块交给 <see cref="JsVmPool"/>, 池按 <see cref="Scope"/> 各建
 * 一个**独立 V8 实例** ⇒ 一个子系统的长任务不再占住另一个子系统的门闩。
 *
 * ⚠ 为什么必须显式声明而不是运行时嗅探 (两条都是静默故障):
 *   · **bundle 序即加载序** —— mapgen.js 在加载时捕获 global.NoiseLib /
 *     global.MapGenConfig; city-evo.js 在加载时 `var MG = global.MapGen`。
 *     排错序 = 静默跑旧参数 (mapgen) 或直接抛错 (city-evo)。
 *   · **出口必须逐个列进 Invoke** —— 漏一个就是运行期
 *     `未知 JS 函数` (编译期不报)。原先这个白名单是 JsEngineHost.Call 的 switch。
 *
 * ⚠ V8 单线程: 每个 VM 自带一把门闩 ⇒ 同一 Scope 内的调用串行, 跨 Scope 并行。
 *   并行度只来自「多 Scope」, 不是「多线程进同一个 V8」。
 * ============================================================ */
public abstract class JsvmModule
{
    /// <summary>VM 标识 (= 子系统名)。同 Scope 的调用共用一个 V8 实例与一把门闩。</summary>
    public abstract string Scope { get; }

    /// <summary>脚本**绝对路径**清单, 顺序即加载序。</summary>
    public abstract IReadOnlyList<string> Files { get; }

    /// <summary>导出根成员名 (e.g. "MapGenServer" / "CityEvo")。VM 建好后常驻缓存, 免每次调用重解析 DLR 属性。</summary>
    public abstract string RootMember { get; }

    /// <summary>VM 建好后调一次 (init(seed) 等一次性准备)。</summary>
    public virtual void OnVmReady(dynamic script, string seed) { }

    /// <summary>
    /// 出口白名单。⚠ 新增 JS 出口必须在对应模块的 Invoke 里加 case,
    /// 否则运行期抛「未知 JS 函数」(编译期不报)。
    /// </summary>
    public abstract string Invoke(dynamic script, dynamic root, string fn, object[] args);

    /// <summary>道路版本号 (只有世界层 MapGenServer 有)。其它模块被调即抛, 不做静默 0。</summary>
    public virtual long RoadVersion(dynamic script)
        => throw new NotSupportedException($"模块 {Scope} 不提供 roadVersion");

    /// <summary>
    /// 本模块是否需要接收 ext(玩家宗门) 层注入。
    /// ⚠ 默认 <c>false</c>, 只有载了 <c>mapgen-server.js</c> 的世界层 / 城市层为 true。
    /// 病根: <see cref="JsVmPool"/> 的 onCreated 回调会对**每一个**新建 VM 调
    ///   `setExternalSettlements` (见 MapWorldService.InjectPlayerSects)。纯数据子系统
    ///   (如 characters) 没有这个出口 ⇒ 建 VM 即抛「未知 JS 函数」⇒ 该子系统所有请求失败。
    /// 用显式契约而不是「在 switch 里加个空 case 兜住」: 后者会让「谁该收到 ext」不可读,
    ///   且新增子系统仍会踩同一个坑 (静默 vs 显式)。
    /// </summary>
    public virtual bool AcceptsExternalSettlements => false;

    /// <summary>
    /// 拼装 bundle。
    /// ⚠ 头部三行别名必须**先于**所有脚本: mapgen.js / city-evo.js 都按
    ///   `global.X` 取依赖, 少了别名在 Node 侧静默取到 undefined。
    /// </summary>
    public string BuildBundle()
    {
        var sb = new StringBuilder();
        sb.AppendLine("'use strict';");
        sb.AppendLine("var window = globalThis; var global = window; var self = window;");
        foreach (var p in Files)
        {
            if (!File.Exists(p)) throw new FileNotFoundException($"缺少世界脚本: {p}");
            sb.AppendLine($"/* ==== {Path.GetFileName(p)} ==== */");
            sb.AppendLine(File.ReadAllText(p, Encoding.UTF8));
        }
        return sb.ToString();
    }
}

/// <summary>
/// 「世界层 + 城市迭代」共享 bundle 的构造器 —— 供 <see cref="WorldModule"/> 与
/// <c>Zongmen.Subsystems.City.CityModule</c> 复用。
///
/// ⚠⚠ 两个模块**刻意载同一份脚本清单** (含 mapgen-server.js 与 city-evo.js):
///   · 骨架产出 (growTownFootprint) 同时受 ext (玩家宗门) 层影响 ⇒ 两个 VM 必须
///     有**逐字节相同的脚本 + 相同的 ext 注入**, 否则演化算出的足迹与渲染画出的
///     足迹会漂移 (静默错值, 不报错)。
///   · 代价 = 多一份引擎常驻内存 + 一次冷启; 换来的是 tick 与人类请求**零门闩争用**
///     (兑现 docs/游戏时钟与Tick演化框架方案.md §6.7 与
///      待办事项/Tick框架开发进度.md 第 17 条)。
/// ============================================================ */
public static class JsvmBundles
{
    public static string[] WorldBacked(string engineJsDir, string cityJsDir) =>
    [
        Path.Combine(engineJsDir, "noise.js"),
        Path.Combine(engineJsDir, "mapgen-config.js"),
        Path.Combine(engineJsDir, "mapgen.js"),
        Path.Combine(engineJsDir, "mapgen-server.js"),
        Path.Combine(cityJsDir, "city-evo.js"),
    ];
}
