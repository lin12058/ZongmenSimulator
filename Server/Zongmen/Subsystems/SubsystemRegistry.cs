using Zongmen.Engine;
using Zongmen.Time;

namespace Zongmen.Subsystems;

/* ============================================================
 * 子系统注册表 —— 「加了哪些子系统」的唯一真源。
 * ------------------------------------------------------------
 * 用途: ① 一次性把各子系统的 V8 模块交给 JsVmPool (每个 Scope 一个独立实例)
 *       ② 换世时遍历调用 OnWorldChanged
 *       ③ 渲染时遍历取叠加
 *       ④ /stats 与自检脚本报「本进程装了哪些子系统 / 各有哪些表」
 *
 * ⚠ 新加子系统 = 新建一个目录 + 在这里多一行。Core 一行都不用改。
 * ============================================================ */
public sealed class SubsystemRegistry : IDisposable
{
    public IReadOnlyList<ISubsystem> All { get; }

    public SubsystemRegistry(IEnumerable<ISubsystem> all)
    {
        All = all.ToArray();
        /* 启动期对账: 重的 Scope 会让 JsVmPool 静默错路由, 所以这里先炸。
           (与「编译期不报的都必须在启动期报」同一原则。) */
        var scopes = new HashSet<string>(StringComparer.Ordinal);
        foreach (var s in All)
            if (s.Module is not null && !scopes.Add(s.Module.Scope))
                throw new InvalidOperationException($"子系统 {s.Name} 的 VM Scope 重复: {s.Module.Scope}");
    }

    /// <summary>全部 V8 模块 (交给 JsVmPool 建池)。</summary>
    public JsvmModule[] Modules => All.Where(s => s.Module is not null).Select(s => s.Module!).ToArray();

    /// <summary>换世: 逐子系统清空旧轮次的世态。⚠ 单个子系统抛异常不阻断其它 (但留痕)。</summary>
    public int ClearWorld(int round)
    {
        var n = 0;
        foreach (var s in All)
        {
            try { n += s.OnWorldChanged(round); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[subsys] {s.Name} 换世清理失败: {ex.GetType().Name}: {ex.Message}");
            }
        }
        return n;
    }

    /// <summary>渲染叠加: 第一个非空者胜 (见 ISubsystem.RenderOverlayJson 的注释)。</summary>
    public string OverlayJson(int round, int i, int j)
    {
        foreach (var s in All)
        {
            string json;
            try { json = s.RenderOverlayJson(round, i, j); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[subsys] {s.Name} 渲染叠加失败 ({i},{j}): {ex.Message}");
                continue;
            }
            if (!string.IsNullOrEmpty(json)) return json;
        }
        return "";
    }

    /// <summary>诊断串: `city[city](CityState) → townEvolve+tradeEdge`。</summary>
    public string Describe() =>
        All.Count == 0
            ? "(无子系统)"
            : string.Join(" | ", All.Select(s =>
                $"{s.Name}[{s.Module?.Scope ?? "托管"}]({string.Join(",", s.Tables)}) → {string.Join("+", s.Claims)}"));

    /// <summary>退出时释放子系统的台账。
    /// ⚠ 必须由本类持有并显式释放: 用 `AddSingleton(instance)` 注册的外部实例
    ///   容器**不会**代为 Dispose (它只释放自己创建的), 漏了就是退出时不 flush。</summary>
    public void Dispose()
    {
        foreach (var s in All)
        {
            try { (s as IDisposable)?.Dispose(); }
            catch (Exception ex) { Console.Error.WriteLine($"[subsys] {s.Name} 释放失败: {ex.Message}"); }
        }
    }
}
