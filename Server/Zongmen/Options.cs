namespace Zongmen;

/// <summary>运行配置 (appsettings.json "Zongmen" 节)。</summary>
public sealed class ZongmenOptions
{
    public int Port { get; set; } = 8140;
    /// <summary>前端 web 目录; 留空则自动向上查找含 web/index.html 的根目录。</summary>
    public string? WebDir { get; set; }
    /// <summary>SQLite 路径; 留空默认 &lt;工程根&gt;/db/zongmen.sqlite。</summary>
    public string? DbPath { get; set; }
    /// <summary>常驻种子世界数 (LRU)。
    /// T13: 默认由 3 提到 4 — 多端/多 seed 并发观看时减少互相挤出重建 V8 的来回抖动;
    ///      仍可在 appsettings.json "Zongmen:MaxSeeds" 按内存预算调整。</summary>
    public int MaxSeeds { get; set; } = 4;
    public bool PersistEnabled { get; set; } = true;

    /// <summary>每人每世可立的宗门数上限 (P0 = 1, 方案 §六「一世 1 个」)。
    /// ⚠ 口径是**按账号**而非按世界: demo 鉴权下"任意非空账号即登录", 若按世界限制,
    ///   第一个进入的玩家就把整世锁死了 —— 显然不是本意。</summary>
    public int PlayerSectMaxPerAccount { get; set; } = 1;

    /// <summary>每座宗门可带**附属城镇**数上限; 0 = 不限 (默认)。
    /// 用户 2026-09-23: 「先不限制, 后续会根据等级来限制」⇒ 这就是那个钩子:
    ///   判定目前是 `CountTowns(account, round) >= PlayerTownMaxPerSect` (0 = 短路放行);
    ///   将来改成 `>= f(本宗 tier)` 时, 存储层已按 (Account,Round,Id) + SectId 支持多行,
    ///   结构不用再动。距离/地形/领地三条硬判据**不在这里** —— 它们在引擎里
    ///   (EXPAND_R / placeCheckJson), 本条只是"还能不能再建一座"的数量闸。</summary>
    public int PlayerTownMaxPerSect { get; set; }

    /// <summary>js 沙箱脚本目录 (noise.js/mapgen.js/mapgen-server.js)。</summary>
    public string? EngineJsDir { get; set; }
}

/// <summary>静态解析器: 定位工程根 / web / 引擎脚本 / 数据库。</summary>
public static class ZongmenPaths
{
    public static string FindRoot(string contentRoot)
    {
        var dir = new DirectoryInfo(contentRoot);
        for (var i = 0; i < 10 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "web", "index.html")))
                return dir.FullName;
        }
        // 回退: 运行目录自身即 web 父目录的形态
        return contentRoot;
    }

    public static string ResolveWebDir(ZongmenOptions o, string contentRoot)
    {
        if (!string.IsNullOrEmpty(o.WebDir) && Directory.Exists(o.WebDir)) return o.WebDir!;
        return Path.Combine(FindRoot(contentRoot), "web");
    }

    public static string ResolveEngineJsDir(ZongmenOptions o, string contentRoot)
    {
        if (!string.IsNullOrEmpty(o.EngineJsDir) && Directory.Exists(o.EngineJsDir))
            return o.EngineJsDir!;
        var root = FindRoot(contentRoot);
        var cand = Path.Combine(root, "Server", "Zongmen", "Engine", "js");
        if (Directory.Exists(cand)) return cand;
        return Path.Combine(contentRoot, "Engine", "js");
    }

    public static string ResolveDbPath(ZongmenOptions o, string contentRoot)
    {
        if (!string.IsNullOrEmpty(o.DbPath)) return Path.GetFullPath(o.DbPath);
        return Path.Combine(FindRoot(contentRoot), "db", "zongmen.sqlite");
    }
}
