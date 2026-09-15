using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace Zongmen.Storage;

/// <summary>一世 (一轮世界) 的台账行。</summary>
public sealed record WorldEntry(int Round, string Seed, long BornAt);

/* ============================================================
 * 世界种子台账 (2026-09-16 用户定案: 「seed 由服务器统一产生, 不能通过前端产生,
 *   存在 sqlite 里面」)
 * ------------------------------------------------------------
 * 病根: 旧口径的种子是**前端自己造的** (`String(Date.now() % 100000000)`) —— 刷新页面
 *   就换一界, 多端/多标签各看各的世界, 服务端只能被动接受任一字符串当 seed。
 * 现在: 种子成为**服务端资产** —— 由服务端生成 (加密随机), 落 SQLite, 客户端只**领**。
 *   于是「第几世」成了可跨进程重启、可被所有客户端共享的事实。
 *
 * 表结构 (同一个 db/zongmen.sqlite, 新表 World):
 *     World(Round INTEGER PRIMARY KEY, Seed TEXT NOT NULL, BornAt INTEGER NOT NULL)
 *   当前世 = Round 最大那行 ⇒ **不需要额外的"游标"行**, 少一个可被写坏的状态。
 *
 * ⚠ 为什么必须用**独立表**而不是往 Data(Key,Value) 里塞一行:
 *   MapWorldService 的后台维护任务会调 SqliteVirtualContext.PruneExcept(活跃 seed 前缀),
 *   那条 DELETE 的语义是「删掉所有 Key 不匹配 w:&lt;16位&gt;:* 的行」—— 台账行会被**静默删掉**
 *   (世界"忘了自己第几世")。分表后清理任务完全够不着本表。
 *
 * ⚠ 本类是**同步短连接**风格 (与 SqliteVirtualContext 一致): 调用频率极低 (开一局一次 /
 *   换一世一次 / 弹窗打开时列一次), 不值得为它引入写队列。
 * ⚠ 传 dbPath = null ⇒ 仅内存模式 (PersistEnabled=false 时的降级): 行为完全一致,
 *   只是进程重启后台账归零 (与"持久化关闭"的语义自洽)。
 * ============================================================ */
public sealed class WorldLedger : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    /// <summary>种子形态 = 8 位十进制 (无前导零)。与历史前端 Date.now()%1e8 同形 ⇒
    /// 旧 URL / 旧日志里的种子串与新的长得一样, 人眼无需区分; 也让 ?seed= 调试覆盖自然兼容。</summary>
    private const int SeedLo = 10_000_000;
    private const int SeedHi = 100_000_000;

    private readonly string? _cs;
    private readonly List<WorldEntry> _mem = new();     // 仅内存模式 / 已加载镜像
    private readonly object _gate = new();
    private bool _loaded;

    public bool Persisted => _cs != null;

    public WorldLedger(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS World (
                Round  INTEGER PRIMARY KEY,
                Seed   TEXT    NOT NULL,
                BornAt INTEGER NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    private SqliteConnection Open()
    {
        var c = new SqliteConnection(_cs);
        c.Open();
        using (var p = c.CreateCommand())
        {
            p.CommandText = "PRAGMA busy_timeout=8000;";
            p.ExecuteNonQuery();
        }
        return c;
    }

    /// <summary>当前世。库里还没有任何一世时**就地开第一世** (服务端是种子的唯一来源,
    /// 客户端不该有能力"要求一个种子" —— 它只能问"现在是哪一世")。</summary>
    public WorldEntry Current()
    {
        lock (_gate)
        {
            EnsureLoaded();
            if (_mem.Count == 0) return Append(_mem.Count + 1);
            return _mem[^1];
        }
    }

    /// <summary>另启一世: 轮次 +1 + 新种子。返回新的一世。</summary>
    public WorldEntry Next()
    {
        lock (_gate)
        {
            EnsureLoaded();
            return Append(_mem.Count == 0 ? 1 : _mem[^1].Round + 1);
        }
    }

    /// <summary>最近 n 世 (新的在前) —— 供设置弹窗展示"曾经走过哪些世界"。</summary>
    public IReadOnlyList<WorldEntry> Recent(int n)
    {
        if (n <= 0) n = 1;
        lock (_gate)
        {
            EnsureLoaded();
            var outList = new List<WorldEntry>(Math.Min(n, _mem.Count));
            for (var i = _mem.Count - 1; i >= 0 && outList.Count < n; i--) outList.Add(_mem[i]);
            return outList;
        }
    }

    public long Count()
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _mem.Count;
        }
    }

    /// <summary>调用方须持 _gate。轮次单调 +1, 种子不与本台账任何历史世重复。</summary>
    private WorldEntry Append(int round)
    {
        var existing = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in _mem) existing.Add(e.Seed);
        string seed;
        do { seed = NewSeed(); } while (existing.Contains(seed));
        var entry = new WorldEntry(round, seed, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (_cs != null)
        {
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "INSERT INTO World(Round, Seed, BornAt) VALUES($r, $s, $b);";
            cmd.Parameters.AddWithValue("$r", entry.Round);
            cmd.Parameters.AddWithValue("$s", entry.Seed);
            cmd.Parameters.AddWithValue("$b", entry.BornAt);
            cmd.ExecuteNonQuery();
        }
        _mem.Add(entry);
        return entry;
    }

    /// <summary>惰性加载全表 (一世一行, 量级 = 玩家开过多少局, 几百行内, 一次读尽最省心)。</summary>
    private void EnsureLoaded()
    {
        if (_loaded || _cs == null) { _loaded = true; return; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT Round, Seed, BornAt FROM World ORDER BY Round;";
        using var r = cmd.ExecuteReader();
        while (r.Read())
            _mem.Add(new WorldEntry(r.GetInt32(0), r.GetString(1), r.GetInt64(2)));
        _loaded = true;
    }

    /// <summary>加密随机 8 位十进制 (无前导零)。⚠ 不用 Random.Shared: 同一毫秒内两世
    /// 有可被猜到的相关性与 (理论上) 撞值风险, 而种子决定整个世界 —— 用 CSPRNG, 成本可忽略。</summary>
    private static string NewSeed()
    {
        var v = RandomNumberGenerator.GetInt32(SeedLo, SeedHi);
        return v.ToString(CultureInfo.InvariantCulture);
    }

    public void Dispose()
    {
        /* 短连接池化: 无需自己持有连接; 这里只清内存镜像 (进程退出时本来也会没) */
        lock (_gate) _mem.Clear();
    }
}
