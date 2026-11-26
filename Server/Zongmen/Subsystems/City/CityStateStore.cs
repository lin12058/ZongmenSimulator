using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Zongmen.Storage;

namespace Zongmen.Subsystems.City;

/// <summary>一座聚落的演化状态 (CityState 表的一行)。
/// 与引擎 `Subsystems/City/js/city-evo.js` 的 CityState 结构**逐字段对应** ——
/// 字段名/语义必须与那里保持一致, 否则离线对拍会以「看起来像 bug 的口径差」失败。
///
/// ⚠ 内存态**仍然是 string**（`Type`/`Stock`/`Built`）—— 紧凑编码只发生在落库边界
///   (<see cref="CityStateStore"/> 的 Save / EnsureLoaded)。这样所有调用点、引擎 JSON
///   互转、判据都不用改，省下的字节全在磁盘上。</summary>
public sealed class CityStateRow
{
    public int Round;
    public string Id = "";
    public int Ver;
    public long UpdatedAt;
    public long LastEvoTick;

    /* ---- 身份 (⚠ 必须落库: 引擎的 cityMetaJson 需要 type/q/r 才能取骨架产出) ----
       ⚠ 这三个都是 seed 纯函数结论, **不做权威副本** —— 只在建行时写一次,
         之后演化绝不改它们 (改了 = 篡改 seed 派生层, 红线 R1)。 */
    public string Type = "";
    public int Q;
    public int R;

    /* ---- 人口 (pop = 展示整数; PopF = 浮点真值, Δ 铁律的载体) ---- */
    public int Pop;
    public double PopF;

    public int Tier;
    public int State;

    /// <summary>八资源库存 JSON (`{"粮":123,...}`)。演化只增减这里, 绝不回写引擎骨架产出。
    /// ⚠ 落库时拆成 8 个 INTEGER 列（键名占 JSON 的 69%，每行白烧 48B）。</summary>
    public string Stock = "{}";
    /// <summary>演化新增建筑 JSON 数组。⚠ 每一项都带 `evo:1`; 骨架建筑不在本表 (它们是 seed 派生)。
    /// ⚠ 落库时压成 varint BLOB（键名占 56%，`"q":` `"kind":` 每项重复一次）。</summary>
    public string Built = "[]";

    /* ---- Δ 铁律所需的累加器 (绝不由 tick 差反推) ---- */
    public long BornTick;
    public long Age;
    public double FoodDebt;
    public int PopBase;
    /// <summary>K 基期人口 (freeze 档首算后冻结; null 表示尚未算过)。</summary>
    public double? BasePopF;
    /// <summary>K 基期年龄 (freeze 档用来钉住 maturity; 只冻 BasePopF 会让 Δ 仍有 21 口残差)。</summary>
    public long? BaseAge;
    public double BuiltFrac;
    /// <summary>上一批实际使用的 K (审计用; 不参与演化计算)。</summary>
    public double Kf;
}

/* ============================================================
 * 城市演化台账 (City 子系统 · 由 Subsystems/City/CityTickExecutor 驱动)
 * ------------------------------------------------------------
 * 职责: 「本世每座聚落的演化状态」的唯一权威记录。
 *   写入时机 = 每次 TownEvolve job 出结果后 (TickPump.ApplyOutcome);
 *   读取时机 = ① 下一批演化 (取入参 state)
 *              ② 客户端拉取 (人口/等级/库存叠加显示)
 *              ③ 离线进度对拍判据
 *
 * 表结构 (同一个 db/zongmen.sqlite, 表 CityState) —— 2026-11-26 紧凑化:
 *     CityState(Round INTEGER, Id TEXT, Ver INTEGER, UpdatedAt INTEGER,
 *               LastEvoTick INTEGER, TypeCode INTEGER, Q INTEGER, R INTEGER,
 *               Pop INTEGER, PopF REAL, Tier INTEGER, State INTEGER,
 *               R0..R7 INTEGER,           -- 八资源库存 (粮木矿渔炭灵丹器)
 *               Built BLOB,               -- 演化建筑 (varint 数组)
 *               BornTick INTEGER, Age INTEGER, FoodDebt REAL, PopBase INTEGER,
 *               BasePopF REAL, BaseAge INTEGER, BuiltFrac REAL, Kf REAL,
 *               PRIMARY KEY(Round, Id))
 *     CityDict(Code INTEGER PK AUTOINCREMENT, Dom TEXT, Name TEXT, UNIQUE(Dom,Name))
 *   · 主键 (Round, Id) ⇒ 一世一座一行。⚠ **不含 Account** (与 PlayerSect 的根本区别):
 *     CityState 覆盖**全部**聚落 (含 seed 派生的 NPC 城), 只有玩家聚落才有 Account;
 *     把 Account 放主键会让所有 NPC 城撞成同一行 (或被迫用假账号)。
 *     「是不是玩家城」由 Id 形态 (`{i}_{j}_u{n}`) 判断, 那是既有约定。
 *
 * ⚠ 为什么必须是**独立表** (第三条, 前两条 = WorldLedger / PlayerSectStore):
 *   与它们同因 —— MapWorldService 的后台维护会调
 *   SqliteVirtualContext.PruneExcept(活跃 seed 前缀), 那条 DELETE 的语义是
 *   「删掉所有 Key 不匹配 w:<16位>:* 的行」。演化状态若塞进 Data 表, 换世之后
 *   **被静默删掉**(世界瞬间回到「所有城都是初始人口」, 而且不报错)。分表后够不着。
 *
 * ⚠ Ver 单调递增的用途: 客户端缓存失效 (带旧 Ver 的请求不需要重算)。与
 *   PlayerSectStore 不同, 这里 Ver 由演化推进 (每批 +1), 不只在写入时自增。
 *
 * ⚠⚠ 2026-11-26 字符串压缩 (测试库已清空, 不做迁移):
 *   · `Type`  TEXT  → `TypeCode` INTEGER (字典表 CityDict.Dom='type')
 *   · `Stock` TEXT  → `R0..R7` 8 个 INTEGER (原 JSON 键名占 69%)
 *   · `Built` TEXT  → BLOB (varint; 原 JSON 键名占 56%)
 *   三者的**内存态与引擎 JSON 形态完全不变**, 编码只在这一层做。
 * ============================================================ */
public sealed class CityStateStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    /// <summary>
    /// 八资源固定顺序 —— 与引擎 `city-evo.js` 的 `E.RES_ORDER` **逐字一致**。
    /// ⚠ 引擎加资源必须同步这里: 解析到未知键会**抛异常**(宁可炸也不静默丢数据),
    ///   而不是默默少存一个。
    /// </summary>
    private static readonly string[] ResOrder = { "粮", "木", "矿", "渔", "炭", "灵", "丹", "器" };

    /* Built 的 varint tag */
    private const byte BuiltJson = 0;   // [tag][utf8 json…]   兜底：结构不符时原样存
    private const byte BuiltBin = 1;    // [tag][count][7×varint]×

    private const string CreateSql = """
        CREATE TABLE IF NOT EXISTS CityState (
            Round       INTEGER NOT NULL,
            Id          TEXT    NOT NULL,
            Ver         INTEGER NOT NULL DEFAULT 0,
            UpdatedAt   INTEGER NOT NULL DEFAULT 0,
            LastEvoTick INTEGER NOT NULL DEFAULT 0,
            TypeCode    INTEGER NOT NULL DEFAULT 0,
            Q           INTEGER NOT NULL DEFAULT 0,
            R           INTEGER NOT NULL DEFAULT 0,
            Pop         INTEGER NOT NULL DEFAULT 0,
            PopF        REAL    NOT NULL DEFAULT 0,
            Tier        INTEGER NOT NULL DEFAULT 1,
            State       INTEGER NOT NULL DEFAULT 0,
            R0          INTEGER NOT NULL DEFAULT 0,
            R1          INTEGER NOT NULL DEFAULT 0,
            R2          INTEGER NOT NULL DEFAULT 0,
            R3          INTEGER NOT NULL DEFAULT 0,
            R4          INTEGER NOT NULL DEFAULT 0,
            R5          INTEGER NOT NULL DEFAULT 0,
            R6          INTEGER NOT NULL DEFAULT 0,
            R7          INTEGER NOT NULL DEFAULT 0,
            Built       BLOB    NOT NULL DEFAULT X'',
            BornTick    INTEGER NOT NULL DEFAULT 0,
            Age         INTEGER NOT NULL DEFAULT 0,
            FoodDebt    REAL    NOT NULL DEFAULT 0,
            PopBase     INTEGER NOT NULL DEFAULT 0,
            BasePopF    REAL    NULL,
            BaseAge     INTEGER NULL,
            BuiltFrac   REAL    NOT NULL DEFAULT 0,
            Kf          REAL    NOT NULL DEFAULT 0,
            PRIMARY KEY (Round, Id)
        );
        CREATE INDEX IF NOT EXISTS IX_CityState_Round ON CityState(Round);
        CREATE TABLE IF NOT EXISTS CityDict (
            Code INTEGER PRIMARY KEY AUTOINCREMENT,
            Dom  TEXT NOT NULL,
            Name TEXT NOT NULL,
            UNIQUE (Dom, Name)
        );
        """;

    private readonly string? _cs;
    private readonly object _gate = new();
    private readonly Dictionary<(int Round, string Id), CityStateRow> _mem = new();
    private bool _loaded;

    /* 字典缓存: (Dom, Name) ↔ Code。Dom = 'type' | 'build' | 'terrain' */
    private readonly Dictionary<(string Dom, string Name), int> _dictFwd = new();
    private readonly Dictionary<(string Dom, int Code), string> _dictRev = new();

    public bool Persisted => _cs != null;

    public CityStateStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = CreateSql;
        cmd.ExecuteNonQuery();
        LoadDict(init);
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

    /* ---------- 字典 ---------- */

    private void LoadDict(SqliteConnection c)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT Code, Dom, Name FROM CityDict;";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            var code = r.GetInt32(0);
            var dom = r.GetString(1);
            var name = r.GetString(2);
            _dictFwd[(dom, name)] = code;
            _dictRev[(dom, code)] = name;
        }
    }

    /// <summary>名字 → 码。空名给 0（0 = 未设置）。新词**就地入库**并缓存。</summary>
    private int DictCode(string dom, string name)
    {
        if (string.IsNullOrEmpty(name)) return 0;
        if (_dictFwd.TryGetValue((dom, name), out var c)) return c;
        if (_cs == null) { _dictFwd[(dom, name)] = 0; return 0; }
        using var conn = Open();
        using (var ins = conn.CreateCommand())
        {
            ins.CommandText = "INSERT INTO CityDict(Dom, Name) VALUES($d, $n) ON CONFLICT(Dom, Name) DO NOTHING;";
            ins.Parameters.AddWithValue("$d", dom);
            ins.Parameters.AddWithValue("$n", name);
            ins.ExecuteNonQuery();
        }
        using var sel = conn.CreateCommand();
        sel.CommandText = "SELECT Code FROM CityDict WHERE Dom=$d AND Name=$n;";
        sel.Parameters.AddWithValue("$d", dom);
        sel.Parameters.AddWithValue("$n", name);
        var code = Convert.ToInt32(sel.ExecuteScalar() ?? 0);
        _dictFwd[(dom, name)] = code;
        _dictRev[(dom, code)] = name;
        return code;
    }

    /// <summary>码 → 名字。0 / 未知码给空串。</summary>
    private string DictName(string dom, int code)
        => code != 0 && _dictRev.TryGetValue((dom, code), out var n) ? n : "";

    /* ---------- 读 ---------- */

    /// <summary>取一座聚落的演化状态; 不存在返回 null (调用方据此用 cityNewStateJson 初始化)。</summary>
    public CityStateRow? Get(int round, string id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _mem.TryGetValue((round, id), out var e) ? Clone(e) : null;
        }
    }

    /// <summary>本世全部演化状态 (离线对拍 / 客户端全量拉取用)。</summary>
    public IReadOnlyList<CityStateRow> ByRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var list = new List<CityStateRow>();
            foreach (var kv in _mem) if (kv.Key.Round == round) list.Add(Clone(kv.Value));
            list.Sort((a, b) => string.CompareOrdinal(a.Id, b.Id));
            return list;
        }
    }

    /// <summary>本世已建立演化状态的聚落数 (诊断/对拍报数用)。</summary>
    public int CountRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var kv in _mem) if (kv.Key.Round == round) n++;
            return n;
        }
    }

    /// <summary>某轮累计演化 tick 之和 (断点续跑的自查量; 应当 ≈ 轮次 × 已过季数 × 城数)。</summary>
    public long SumLastEvoTick(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            long n = 0;
            foreach (var kv in _mem) if (kv.Key.Round == round) n += kv.Value.LastEvoTick;
            return n;
        }
    }

    /* ---------- 写 ---------- */

    /// <summary>落库一行 (按 (Round,Id) 覆盖) 并同步内存镜像。
    /// ⚠ Ver 由调用方从**入参 state** 带进来 (演化器每次 +1) —— 这里不再自增,
    ///   否则「同一批重放两次」会让 Ver 跳号, 客户端缓存失效判断失去意义。</summary>
    public CityStateRow Put(CityStateRow e)
    {
        if (string.IsNullOrEmpty(e.Id)) throw new InvalidDataException("CityState.Id 为空");
        lock (_gate)
        {
            EnsureLoaded();
            e.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _mem[(e.Round, e.Id)] = Clone(e);
            Save(e);
            return e;
        }
    }

    /// <summary>批量落库 (一个 tick 批的落库口径: **一次事务**写完整个批)。
    /// ⚠ 必须成批: 逐行各自开事务在 90 tick × 数百城的量级上会把 WAL 打满;
    ///   而且批中途失败会留下「半批已演化」的不一致状态。</summary>
    public void PutRange(IEnumerable<CityStateRow> rows)
    {
        var list = new List<CityStateRow>();
        foreach (var r in rows)
        {
            if (string.IsNullOrEmpty(r.Id)) throw new InvalidDataException("CityState.Id 为空");
            list.Add(r);
        }
        if (list.Count == 0) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_gate)
        {
            EnsureLoaded();
            foreach (var r in list) { r.UpdatedAt = now; _mem[(r.Round, r.Id)] = Clone(r); }
            if (_cs == null) return;
            using var c = Open();
            using var tx = c.BeginTransaction();
            using var cmd = c.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = UpsertSql;
            BindUpsert(cmd);                    // 预热参数名 (AddWithValue 一次即可复用)
            foreach (var r in list) { BindRow(cmd, r); cmd.ExecuteNonQuery(); }
            tx.Commit();
        }
    }

    /* ---------- 事件钩子 (打仗 / 天灾 …) ---------- */

    /// <summary>对某城施加一次「人口冲击」—— **事件系统接入演化的唯一写入口** (预留)。
    /// 事件层 (战乱 / 瘟疫 / 天灾 …) 只调本方法, 不直接改 Pop/PopF, 免得绕过内存镜像、
    /// 落库与 Ver 失效。返回施加后的行; 该城尚未初始化时返回 null (调用方先确保已建行)。
    ///   · <paramref name="deltaPop"/> 人口增减 (可负); 结果夹到 &gt;= 1。
    ///   · <paramref name="newState"/> null = 不改; 传 1 = 被毁 (建筑全灭), 3 = 事件态
    ///     (灾荒/战乱 —— 建筑按 FAMINE_CAP 折减, 且持续到人口恢复才解除)。
    /// ⚠ 刻意**不动 PopBase**: 事件态判据 (pop &lt; PopBase×0.7) 与恢复判据 (×0.9) 都
    ///   相对它 ⇒ 保持原基准, state=3 才会「持续到真正恢复」而不是下一次 tick 就解。 </summary>
    public CityStateRow? ApplyShock(int round, string id, int deltaPop, int? newState)
    {
        lock (_gate)
        {
            EnsureLoaded();
            if (!_mem.TryGetValue((round, id), out var cur)) return null;
            var e = Clone(cur);
            var p = e.Pop + deltaPop;
            if (p < 1) p = 1;
            e.Pop = p;
            e.PopF = p;                        // 浮点真值同步 (否则下一批从旧 popF 续跑)
            if (newState.HasValue) e.State = newState.Value;
            e.Ver += 1;                        // 客户端缓存失效 (settle 包按 Ver/rev 走)
            e.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _mem[(round, id)] = Clone(e);
            Save(e);
            return e;
        }
    }

    /// <summary>清空某一世 (换世时调用; 与 PlayerSectStore 的换世口径一致)。
    /// 返回删除行数。</summary>
    public int RemoveRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var k in new List<(int, string)>(_mem.Keys)) if (k.Item1 == round) { _mem.Remove(k); n++; }
            if (_cs == null) return n;
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM CityState WHERE Round=$r;";
            cmd.Parameters.AddWithValue("$r", round);
            cmd.ExecuteNonQuery();
            return n;
        }
    }

    /// <summary>清空全部 (诊断/测试用; 线上不调)。</summary>
    public int Clear()
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = _mem.Count;
            _mem.Clear();
            if (_cs == null) return n;
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM CityState;";
            cmd.ExecuteNonQuery();
            return n;
        }
    }

    /* ---------- 落库编码 ---------- */

    private const string UpsertSql = """
        INSERT INTO CityState(Round, Id, Ver, UpdatedAt, LastEvoTick, TypeCode, Q, R, Pop, PopF, Tier, State,
                              R0, R1, R2, R3, R4, R5, R6, R7, Built,
                              BornTick, Age, FoodDebt, PopBase, BasePopF, BaseAge, BuiltFrac, Kf)
        VALUES($ro, $id, $v, $u, $lt, $ty, $q, $rr, $pp, $pf, $ti, $st,
               $r0, $r1, $r2, $r3, $r4, $r5, $r6, $r7, $bl,
               $bt, $ag, $fd, $pb, $bpf, $ba, $bf, $kf)
        ON CONFLICT(Round, Id) DO UPDATE SET
            Ver=$v, UpdatedAt=$u, LastEvoTick=$lt, TypeCode=$ty, Q=$q, R=$rr,
            Pop=$pp, PopF=$pf, Tier=$ti, State=$st,
            R0=$r0, R1=$r1, R2=$r2, R3=$r3, R4=$r4, R5=$r5, R6=$r6, R7=$r7, Built=$bl,
            BornTick=$bt, Age=$ag, FoodDebt=$fd, PopBase=$pb,
            BasePopF=$bpf, BaseAge=$ba, BuiltFrac=$bf, Kf=$kf;
        """;

    private static readonly string[] ParamNames =
    {
        "$ro", "$id", "$v", "$u", "$lt", "$ty", "$q", "$rr",
        "$pp", "$pf", "$ti", "$st",
        "$r0", "$r1", "$r2", "$r3", "$r4", "$r5", "$r6", "$r7", "$bl",
        "$bt", "$ag", "$fd", "$pb", "$bpf", "$ba", "$bf", "$kf",
    };

    private static void BindUpsert(SqliteCommand cmd)
    {
        foreach (var n in ParamNames) cmd.Parameters.AddWithValue(n, DBNull.Value);
    }

    private void BindRow(SqliteCommand cmd, CityStateRow r)
    {
        var ps = cmd.Parameters;
        ps["$ro"].Value = r.Round;
        ps["$id"].Value = r.Id;
        ps["$v"].Value = r.Ver;
        ps["$u"].Value = r.UpdatedAt;
        ps["$lt"].Value = r.LastEvoTick;
        ps["$q"].Value = r.Q;
        ps["$rr"].Value = r.R;
        ps["$pp"].Value = r.Pop;
        ps["$pf"].Value = r.PopF;
        ps["$ti"].Value = r.Tier;
        ps["$st"].Value = r.State;
        ps["$bt"].Value = r.BornTick;
        ps["$ag"].Value = r.Age;
        ps["$fd"].Value = r.FoodDebt;
        ps["$pb"].Value = r.PopBase;
        ps["$bpf"].Value = (object?)r.BasePopF ?? DBNull.Value;
        ps["$ba"].Value = (object?)r.BaseAge ?? DBNull.Value;
        ps["$bf"].Value = r.BuiltFrac;
        ps["$kf"].Value = r.Kf;
        /* ⚠ TypeCode / 8 个资源 / Built 是**非静态**的 (要查字典 / 要解析 JSON)，
           所以不能在 BindUpsert 里预热，必须每行算。 */
        BindEncoded(cmd, r);
    }

    private void BindEncoded(SqliteCommand cmd, CityStateRow r)
    {
        var ps = cmd.Parameters;
        ps["$ty"].Value = DictCode("type", r.Type);
        var st = SplitStock(r.Stock);
        ps["$r0"].Value = st[0]; ps["$r1"].Value = st[1]; ps["$r2"].Value = st[2]; ps["$r3"].Value = st[3];
        ps["$r4"].Value = st[4]; ps["$r5"].Value = st[5]; ps["$r6"].Value = st[6]; ps["$r7"].Value = st[7];
        ps["$bl"].Value = EncodeBuilt(r.Built);
    }

    private void Save(CityStateRow r)
    {
        if (_cs == null) return;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = UpsertSql;
        BindUpsert(cmd);
        BindRow(cmd, r);
        cmd.ExecuteNonQuery();
    }

    /// <summary>八资源 JSON → 8 个 long。
    /// ⚠ 出现 `RES_ORDER` 之外的键就**抛** —— 引擎加了资源却没同步本表 = 静默丢数据，
    ///   那是被查询时才发现「矿怎么永远是 0」的坑。宁可当场炸。</summary>
    private static long[] SplitStock(string json)
    {
        var v = new long[8];
        if (string.IsNullOrEmpty(json) || json == "{}") return v;
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object) return v;
        foreach (var p in doc.RootElement.EnumerateObject())
        {
            var i = Array.IndexOf(ResOrder, p.Name);
            if (i < 0)
                throw new InvalidDataException(
                    $"CityState.Stock 出现未知资源键 '{p.Name}' —— 引擎 RES_ORDER 改了但 CityStateStore.ResOrder 没同步");
            if (p.Value.ValueKind == JsonValueKind.Number)
                v[i] = (long)Math.Round(p.Value.GetDouble());
        }
        return v;
    }

    /// <summary>8 个 long → 八资源 JSON。全 0 给 `{}`（与引擎默认形态一致，别写 8 个 0 撑大）。</summary>
    private static string JoinStock(long v0, long v1, long v2, long v3, long v4, long v5, long v6, long v7)
    {
        ReadOnlySpan<long> v = stackalloc long[] { v0, v1, v2, v3, v4, v5, v6, v7 };
        var any = false;
        for (var i = 0; i < 8; i++) if (v[i] != 0) { any = true; break; }
        if (!any) return "{}";
        var sb = new StringBuilder(96);
        sb.Append('{');
        var first = true;
        for (var i = 0; i < 8; i++)
        {
            if (v[i] == 0) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(ResOrder[i]).Append("\":").Append(v[i].ToString(CultureInfo.InvariantCulture));
        }
        sb.Append('}');
        return sb.ToString();
    }

    /* ---- Built: varint BLOB ----
       格式: [tag=1][count][ { zig(q), zig(r), kindCode, terrainCode, tier, lv, evo } × count ]
       ⚠ 任何一项的字段集合不符（引擎加了字段 / 少了字段）⇒ 整串退回 [tag=0][utf8 json]，
         保证「编码器不认识的结构」原样往返，绝不会丢字段。 */

    private byte[] EncodeBuilt(string json)
    {
        if (string.IsNullOrEmpty(json) || json == "[]")
            return new[] { BuiltBin, (byte)0 };
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) throw new InvalidDataException();
            var arr = doc.RootElement;
            var n = arr.GetArrayLength();
            if (n > 255) throw new InvalidDataException();      // 建筑数不会到 255，超了就退回 JSON
            var buf = new List<byte>(n * 9 + 2) { BuiltBin, (byte)n };
            foreach (var it in arr.EnumerateArray())
            {
                if (it.ValueKind != JsonValueKind.Object) throw new InvalidDataException();
                var cnt = 0;
                foreach (var _ in it.EnumerateObject()) cnt++;
                if (cnt != 7) throw new InvalidDataException();
                var q = it.GetProperty("q").GetInt32();
                var r = it.GetProperty("r").GetInt32();
                var kind = it.GetProperty("kind").GetString() ?? "";
                var terr = it.GetProperty("terrain").GetString() ?? "";
                var tier = it.GetProperty("tier").GetInt32();
                var lv = it.GetProperty("lv").GetInt32();
                var evo = it.GetProperty("evo").GetInt32();
                PutU(buf, Zig(q));
                PutU(buf, Zig(r));
                PutU(buf, (ulong)DictCode("build", kind));
                PutU(buf, (ulong)DictCode("terrain", terr));
                PutU(buf, (ulong)tier);
                PutU(buf, (ulong)lv);
                PutU(buf, (ulong)evo);
            }
            return buf.ToArray();
        }
        catch
        {
            var raw = Encoding.UTF8.GetBytes(json);
            var o = new byte[raw.Length + 1];
            o[0] = BuiltJson;
            raw.CopyTo(o, 1);
            return o;
        }
    }

    private string DecodeBuilt(byte[] blob)
    {
        if (blob.Length == 0) return "[]";
        if (blob[0] == BuiltJson)
            return Encoding.UTF8.GetString(blob, 1, blob.Length - 1);
        if (blob[0] != BuiltBin) return "[]";
        var p = 1;
        var n = blob[p++];
        if (n == 0) return "[]";
        var sb = new StringBuilder(n * 48 + 4);
        sb.Append('[');
        for (var i = 0; i < n; i++)
        {
            if (i > 0) sb.Append(',');
            var q = UnZig(GetU(blob, ref p));
            var r = UnZig(GetU(blob, ref p));
            var kc = (int)GetU(blob, ref p);
            var tc = (int)GetU(blob, ref p);
            var tier = (int)GetU(blob, ref p);
            var lv = (int)GetU(blob, ref p);
            var evo = (int)GetU(blob, ref p);
            sb.Append("{\"q\":").Append(q.ToString(CultureInfo.InvariantCulture))
              .Append(",\"r\":").Append(r.ToString(CultureInfo.InvariantCulture))
              .Append(",\"kind\":").Append(JsStr(DictName("build", kc)))
              .Append(",\"terrain\":").Append(JsStr(DictName("terrain", tc)))
              .Append(",\"tier\":").Append(tier.ToString(CultureInfo.InvariantCulture))
              .Append(",\"lv\":").Append(lv.ToString(CultureInfo.InvariantCulture))
              .Append(",\"evo\":").Append(evo.ToString(CultureInfo.InvariantCulture))
              .Append('}');
        }
        sb.Append(']');
        return sb.ToString();
    }

    private static void PutU(List<byte> b, ulong v)
    {
        while (v >= 0x80) { b.Add((byte)(v | 0x80)); v >>= 7; }
        b.Add((byte)v);
    }

    private static ulong GetU(byte[] b, ref int p)
    {
        ulong v = 0; var shift = 0;
        while (true)
        {
            var x = b[p++];
            v |= (ulong)(x & 0x7F) << shift;
            if ((x & 0x80) == 0) return v;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("Built varint 溢出");
        }
    }

    private static ulong Zig(int v) => (ulong)((v << 1) ^ (v >> 31));
    private static int UnZig(ulong v) => (int)((v >> 1) ^ (ulong)-(long)(v & 1));

    private void EnsureLoaded()
    {
        if (_loaded || _cs == null) { _loaded = true; return; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText =
            "SELECT Round, Id, Ver, UpdatedAt, LastEvoTick, TypeCode, Q, R, Pop, PopF, Tier, State, " +
            "R0, R1, R2, R3, R4, R5, R6, R7, Built, " +
            "BornTick, Age, FoodDebt, PopBase, BasePopF, BaseAge, BuiltFrac, Kf FROM CityState;";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            var e = new CityStateRow
            {
                Round = r.GetInt32(0),
                Id = r.GetString(1),
                Ver = r.GetInt32(2),
                UpdatedAt = r.GetInt64(3),
                LastEvoTick = r.GetInt64(4),
                Type = DictName("type", r.GetInt32(5)),
                Q = r.GetInt32(6),
                R = r.GetInt32(7),
                Pop = r.GetInt32(8),
                PopF = r.GetDouble(9),
                Tier = r.GetInt32(10),
                State = r.GetInt32(11),
                Stock = JoinStock(r.GetInt64(12), r.GetInt64(13), r.GetInt64(14), r.GetInt64(15),
                                  r.GetInt64(16), r.GetInt64(17), r.GetInt64(18), r.GetInt64(19)),
                Built = DecodeBuilt((byte[])r.GetValue(20)),
                BornTick = r.GetInt64(21),
                Age = r.GetInt64(22),
                FoodDebt = r.GetDouble(23),
                PopBase = r.GetInt32(24),
                BasePopF = r.IsDBNull(25) ? null : r.GetDouble(25),
                BaseAge = r.IsDBNull(26) ? null : r.GetInt64(26),
                BuiltFrac = r.GetDouble(27),
                Kf = r.GetDouble(28),
            };
            _mem[(e.Round, e.Id)] = e;
        }
        _loaded = true;
    }

    private static CityStateRow Clone(CityStateRow e) => new()
    {
        Round = e.Round, Id = e.Id, Ver = e.Ver, UpdatedAt = e.UpdatedAt, LastEvoTick = e.LastEvoTick,
        Type = e.Type, Q = e.Q, R = e.R,
        Pop = e.Pop, PopF = e.PopF, Tier = e.Tier, State = e.State, Stock = e.Stock, Built = e.Built,
        BornTick = e.BornTick, Age = e.Age, FoodDebt = e.FoodDebt, PopBase = e.PopBase,
        BasePopF = e.BasePopF, BaseAge = e.BaseAge, BuiltFrac = e.BuiltFrac, Kf = e.Kf,
    };

    /// <summary>把一行转成 city-evo.js 的 `evolveCityJson` 入参 JSON。
    /// ⚠ 字段名必须与 city-evo.js 的 CityState **逐字一致** (那边靠 `s.popF` 等直接读键)。</summary>
    public static string ToEngineJson(CityStateRow e)
    {
        var sb = new StringBuilder(512);
        sb.Append('{');
        sb.Append("\"id\":").Append(JsStr(e.Id));
        /* ⚠ 身份三字段必须往返: EvolveOne 每批要用它们调 cityMetaJson 取骨架产出。
           漏了 type ⇒ 城被当村算 (K 塌到 K_MIN, 人口永远停在 30 且不报错);
           漏了 q/r ⇒ 加工业档位与灵力溢价全按原点算。2026-10-10 实测踩过。 */
        sb.Append(",\"type\":").Append(JsStr(e.Type));
        sb.Append(",\"q\":").Append(e.Q.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"r\":").Append(e.R.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"pop\":").Append(e.Pop.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"popF\":").Append(Num(e.PopF));
        sb.Append(",\"tier\":").Append(e.Tier.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"state\":").Append(e.State.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"stock\":").Append(string.IsNullOrEmpty(e.Stock) ? "{}" : e.Stock);
        sb.Append(",\"built\":").Append(string.IsNullOrEmpty(e.Built) ? "[]" : e.Built);
        sb.Append(",\"upg\":[]");
        sb.Append(",\"bornTick\":").Append(e.BornTick.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"lastEvoTick\":").Append(e.LastEvoTick.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"ver\":").Append(e.Ver.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"age\":").Append(e.Age.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"foodDebt\":").Append(Num(e.FoodDebt));
        sb.Append(",\"popBase\":").Append(e.PopBase.ToString(CultureInfo.InvariantCulture));
        sb.Append(",\"basePopF\":").Append(e.BasePopF.HasValue ? Num(e.BasePopF.Value) : "null");
        sb.Append(",\"baseAge\":").Append(e.BaseAge.HasValue ? e.BaseAge.Value.ToString(CultureInfo.InvariantCulture) : "null");
        sb.Append(",\"builtFrac\":").Append(Num(e.BuiltFrac));
        sb.Append(",\"Kf\":").Append(Num(e.Kf));
        sb.Append('}');
        return sb.ToString();
    }

    /// <summary>把 city-evo.js 的演化输出 JSON 解析回一行 (字段名逐字对应)。
    /// ⚠ 解析失败必须**抛**而不是吞: 一个静默的默认值会让整城人口归零且不报错。</summary>
    public static CityStateRow FromEngineJson(int round, string json)
    {
        using var doc = JsonDocument.Parse(json);
        var r = doc.RootElement;
        var e = new CityStateRow
        {
            Round = round,
            Id = r.GetProperty("id").GetString() ?? "",
            /* 身份三字段 (引擎自 newCityState 起逐批带下; 缺则留空, 由 EnsureInitialized 自愈) */
            Type = r.TryGetProperty("type", out var tyv) && tyv.ValueKind == JsonValueKind.String
                ? tyv.GetString() ?? "" : "",
            Q = r.TryGetProperty("q", out var qv) && qv.ValueKind == JsonValueKind.Number ? qv.GetInt32() : 0,
            R = r.TryGetProperty("r", out var rv) && rv.ValueKind == JsonValueKind.Number ? rv.GetInt32() : 0,
            Pop = r.GetProperty("pop").GetInt32(),
            PopF = r.GetProperty("popF").GetDouble(),
            Tier = r.GetProperty("tier").GetInt32(),
            State = r.GetProperty("state").GetInt32(),
            Stock = r.GetProperty("stock").GetRawText(),
            Built = r.GetProperty("built").GetRawText(),
            BornTick = GetLong(r, "bornTick"),
            LastEvoTick = GetLong(r, "lastEvoTick"),
            Ver = r.GetProperty("ver").GetInt32(),
            Age = GetLong(r, "age"),
            FoodDebt = GetDouble(r, "foodDebt"),
            PopBase = r.TryGetProperty("popBase", out var pb) && pb.ValueKind == JsonValueKind.Number ? pb.GetInt32() : 0,
            BasePopF = r.TryGetProperty("basePopF", out var bp) && bp.ValueKind == JsonValueKind.Number ? bp.GetDouble() : null,
            BaseAge = r.TryGetProperty("baseAge", out var ba) && ba.ValueKind == JsonValueKind.Number ? ba.GetInt64() : null,
            BuiltFrac = GetDouble(r, "builtFrac"),
            Kf = GetDouble(r, "Kf"),
        };
        if (string.IsNullOrEmpty(e.Id)) throw new InvalidDataException("CityState 演化输出缺 id");
        return e;
    }

    private static long GetLong(JsonElement r, string k)
        => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : 0;
    private static double GetDouble(JsonElement r, string k)
        => r.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : 0;

    private static string Num(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
        return v.ToString("R", CultureInfo.InvariantCulture);
    }

    private static string JsStr(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public void Dispose() { /* 连接按操作开关, 无长持有资源 */ }
}
