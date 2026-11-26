using Microsoft.Data.Sqlite;
using Zongmen.Storage;

namespace Zongmen.Events;

/* ============================================================
 * 实体注册表 —— **全局 int32 id ↔ 引擎字符串 id** 的唯一映射
 * ------------------------------------------------------------
 * 用户口径：「事件挂 id，全局用统一 id」。落地形态就是这张表 + 内存双向字典：
 *   · 内存里事件/History 只认 int32（`Dictionary<int,…>`，无字符串哈希、无对象头）
 *   · 引擎 / CityState / 渲染层只认字符串 `-3_-3_0`（那是它们的既有契约）
 *   · 本类是**两者之间唯一的翻译层**，且是唯一落库的映射
 *
 * ★ 为什么不直接把 `CityState.Id` 改成 int
 *   引擎有 3 处 `id.split('_')` 反解区域格（rngDominated / roadsNear / PlaceCommit 校验）。
 *   改成 int 就必须在 C# 侧再存一份 `(i,j,k)` 三元组 —— 那是**第二个唯一真源**，
 *   而本项目反复踩的坑就是「同一事实存两处，然后漂移」。
 *   所以：字符串继续当引擎侧真源，int32 只当**事件/历史侧的句柄**。
 *
 * ★ 三条硬约束
 *   1. **号只增不复用**。`Entity` 行永不物理删除（只把 `Alive` 置 0）——
 *      History 里还留着老号的记录，复用号 = 历史事件挂到新实体身上。
 *   2. **开机必须先 `ScanExisting`**（见 `EnsureLoaded`）。否则从 1 发号会与库里活实体撞号。
 *   3. **`(Kind, Name)` 唯一**。同一实体重复 `GetOrCreate` 必须返回同一个号
 *      （唯一索引 + 内存字典双保险）；否则同一座城会有两个号，事件挂在一个、状态在另一个。
 *
 * ⚠ 本表**独立成表**，与 `CityState` / `TickJob` 同因：`PruneExcept` 只清 `Data` 表，
 *   但塞进 `Data(Key,Value)` 会在换世后被静默删掉（号空间断档且不报错）。
 * ============================================================ */
public sealed class EntityRegistry : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private const string CreateSql = """
        CREATE TABLE IF NOT EXISTS Entity (
            Id          INTEGER PRIMARY KEY,
            Kind        INTEGER NOT NULL DEFAULT 1,
            Name        TEXT    NOT NULL,
            Q           INTEGER NOT NULL DEFAULT 0,
            R           INTEGER NOT NULL DEFAULT 0,
            RegionI     INTEGER NOT NULL DEFAULT 0,
            RegionJ     INTEGER NOT NULL DEFAULT 0,
            Alive       INTEGER NOT NULL DEFAULT 1,
            CreatedTick INTEGER NOT NULL DEFAULT 0,
            UpdatedAt   INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS UX_Entity_Kind_Name ON Entity(Kind, Name);
        """;

    private readonly string? _cs;
    private readonly object _gate = new();
    private readonly EntityIdAllocator _alloc;

    private readonly Dictionary<int, string> _name = new();
    private readonly Dictionary<int, EntityKind> _kind = new();
    private readonly Dictionary<(EntityKind, string), int> _idByKey = new();
    private bool _loaded;

    private long _created;
    private long _hits;

    public EntityRegistry(string? dbPath)
    {
        _alloc = new EntityIdAllocator(dbPath);
        if (string.IsNullOrEmpty(dbPath)) { _loaded = true; return; }

        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);

        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = CreateSql;
        cmd.ExecuteNonQuery();
    }

    public bool Persisted => _cs != null;
    public int HighWater => _alloc.HighWater;
    public int Count { get { lock (_gate) { EnsureLoaded(); return _name.Count; } } }
    public long Created => Interlocked.Read(ref _created);
    public long CacheHits => Interlocked.Read(ref _hits);

    // ══ 取号 / 查名 ════════════════════════════════════════════════════

    /// <summary>
    /// 取（或创建）一个实体的 int32 号。**幂等**：同一 `(kind, engineName)` 永远返回同一个号。
    ///
    /// <paramref name="q"/>/<paramref name="r"/> 只在「引擎 id 里没有坐标」（人物 `c…`）时才有意义；
    /// 聚落的区域格**从 id 前两段反解**，不重算（重算会因计算基准漂移把一行挂到两个区域格）。
    /// </summary>
    public int GetOrCreate(EntityKind kind, string engineName, int q = 0, int r = 0, long nowTick = 0)
    {
        if (string.IsNullOrEmpty(engineName))
            throw new ArgumentException("engineName 为空 —— 拒绝为无名实体发号", nameof(engineName));

        lock (_gate)
        {
            EnsureLoaded();

            if (_idByKey.TryGetValue((kind, engineName), out var existing))
            {
                Interlocked.Increment(ref _hits);
                return existing;
            }

            var id = _alloc.Alloc();
            var (ri, rj) = SplitRegion(engineName);

            _name[id] = engineName;
            _kind[id] = kind;
            _idByKey[(kind, engineName)] = id;

            if (_cs != null)
            {
                using var c = Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO Entity(Id, Kind, Name, Q, R, RegionI, RegionJ, Alive, CreatedTick, UpdatedAt)
                    VALUES($id, $k, $n, $q, $r, $ri, $rj, 1, $t, $u)
                    ON CONFLICT(Id) DO NOTHING;
                    """;
                cmd.Parameters.AddWithValue("$id", id);
                cmd.Parameters.AddWithValue("$k", (int)kind);
                cmd.Parameters.AddWithValue("$n", engineName);
                cmd.Parameters.AddWithValue("$q", q);
                cmd.Parameters.AddWithValue("$r", r);
                cmd.Parameters.AddWithValue("$ri", ri);
                cmd.Parameters.AddWithValue("$rj", rj);
                cmd.Parameters.AddWithValue("$t", nowTick);
                cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
                cmd.ExecuteNonQuery();
            }

            Interlocked.Increment(ref _created);
            return id;
        }
    }

    /// <summary>号 → 引擎字符串 id。未知号返回 **null**（调用方必须处理：
    /// 事件挂了一个不存在的实体，说明数据被外部改坏了，不许静默当空串）。</summary>
    public string? NameOf(int id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _name.TryGetValue(id, out var n) ? n : null;
        }
    }

    public EntityKind KindOf(int id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _kind.TryGetValue(id, out var k) ? k : EntityKind.None;
        }
    }

    public bool TryGetId(EntityKind kind, string engineName, out int id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _idByKey.TryGetValue((kind, engineName), out id);
        }
    }

    /// <summary>号的全集（`ScanExisting` 与判据用）。</summary>
    public IReadOnlyCollection<int> AllIds()
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _name.Keys.ToArray();
        }
    }

    /// <summary>标记「已消亡」。⚠ **不删行、不回收号**（见类头约束 1）。
    /// 语义 = 「这个实体还活着的时候叫这个名字」，给回放与审计用。</summary>
    public bool MarkDead(int id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            if (!_name.ContainsKey(id)) return false;
            if (_cs == null) return true;
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "UPDATE Entity SET Alive=0, UpdatedAt=$u WHERE Id=$id;";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
            cmd.ExecuteNonQuery();
            return true;
        }
    }

    // ══ 开机恢复 ═══════════════════════════════════════════════════════

    /// <summary>
    /// 懒加载 + **修正号空间上界**。
    /// ⚠⚠ 少了 <see cref="EntityIdAllocator.ScanExisting"/> 这一步，从 1 起发号会与库里
    ///   活实体撞号 —— 两个实体共用一个号，事件、History、资产全部串味，且**不报错**。
    /// ⚠ `reclaimHoles: false`：本类的号**永不回收**（见类头约束 1），所以不需要扫空洞。
    /// </summary>
    private void EnsureLoaded()
    {
        if (_loaded) return;
        _loaded = true;
        if (_cs == null) return;

        using var c = Open();
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = "SELECT Id, Kind, Name FROM Entity;";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var id = r.GetInt32(0);
                var kind = (EntityKind)(byte)r.GetInt32(1);
                var name = r.GetString(2);
                _name[id] = name;
                _kind[id] = kind;
                _idByKey[(kind, name)] = id;
            }
        }

        _alloc.ScanExisting(_name.Keys.ToArray(), reclaimHoles: false);
    }

    // ══ 小工具 ═════════════════════════════════════════════════════════

    /// <summary>`-3_-3_0` → (-3,-3)；`c35184405643264` → (0,0)（人物 id 无区域格）。
    /// ⚠ 与 <c>CitySubsystem.RegionOfId</c> 同口径：前两段必须能解析成十进制整数。</summary>
    public static (int I, int J) SplitRegion(string engineName)
    {
        var p = engineName.Split('_');
        if (p.Length < 2) return (0, 0);
        var i = int.TryParse(p[0], out var a) ? a : 0;
        var j = int.TryParse(p[1], out var b) ? b : 0;
        return (i, j);
    }

    private SqliteConnection Open()
    {
        var c = new SqliteConnection(_cs);
        c.Open();
        using var p = c.CreateCommand();
        p.CommandText = "PRAGMA busy_timeout=8000;";
        p.ExecuteNonQuery();
        return c;
    }

    public void Dispose() => _alloc.Dispose();
}
