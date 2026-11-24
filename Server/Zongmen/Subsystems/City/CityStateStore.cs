using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Zongmen.Subsystems.City;

/// <summary>一座聚落的演化状态 (CityState 表的一行)。
/// 与引擎 `Subsystems/City/js/city-evo.js` 的 CityState 结构**逐字段对应** ——
/// 字段名/语义必须与那里保持一致, 否则离线对拍会以「看起来像 bug 的口径差」失败。</summary>
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

    /// <summary>八资源库存 JSON (`{"粮":123,...}`)。演化只增减这里, 绝不回写引擎骨架产出。</summary>
    public string Stock = "{}";
    /// <summary>演化新增建筑 JSON 数组。⚠ 每一项都带 `evo:1`; 骨架建筑不在本表 (它们是 seed 派生)。</summary>
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
 * 表结构 (同一个 db/zongmen.sqlite, 表 CityState):
 *     CityState(Round INTEGER, Id TEXT, Ver INTEGER, UpdatedAt INTEGER,
 *               LastEvoTick INTEGER, Pop INTEGER, PopF REAL, Tier INTEGER,
 *               State INTEGER, Stock TEXT, Built TEXT, BornTick INTEGER,
 *               Age INTEGER, FoodDebt REAL, PopBase INTEGER, BasePopF REAL,
 *               BaseAge INTEGER, BuiltFrac REAL, Kf REAL,
 *               PRIMARY KEY(Round, Id))
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
 * ============================================================ */
public sealed class CityStateStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private const string CreateSql = """
        CREATE TABLE IF NOT EXISTS CityState (
            Round       INTEGER NOT NULL,
            Id          TEXT    NOT NULL,
            Ver         INTEGER NOT NULL DEFAULT 0,
            UpdatedAt   INTEGER NOT NULL DEFAULT 0,
            LastEvoTick INTEGER NOT NULL DEFAULT 0,
            Type        TEXT    NOT NULL DEFAULT 'town',
            Q           INTEGER NOT NULL DEFAULT 0,
            R           INTEGER NOT NULL DEFAULT 0,
            Pop         INTEGER NOT NULL DEFAULT 0,
            PopF        REAL    NOT NULL DEFAULT 0,
            Tier        INTEGER NOT NULL DEFAULT 1,
            State       INTEGER NOT NULL DEFAULT 0,
            Stock       TEXT    NOT NULL DEFAULT '{}',
            Built       TEXT    NOT NULL DEFAULT '[]',
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
        """;

    private readonly string? _cs;
    private readonly object _gate = new();
    private readonly Dictionary<(int Round, string Id), CityStateRow> _mem = new();
    private bool _loaded;

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

    /// <summary>批量落库 (一个 tick 批的落库口径: **一次事务**写完整个批)。    /// ⚠ 必须成批: 逐行各自开事务在 90 tick × 数百城的量级上会把 WAL 打满;
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
            BindUpsert(cmd, list[0]);           // 预热参数名 (AddWithValue 一次即可复用)
            foreach (var r in list)
            {
                cmd.Parameters["$ro"].Value = r.Round;
                cmd.Parameters["$id"].Value = r.Id;
                cmd.Parameters["$v"].Value = r.Ver;
                cmd.Parameters["$u"].Value = r.UpdatedAt;
                cmd.Parameters["$lt"].Value = r.LastEvoTick;
                cmd.Parameters["$ty"].Value = r.Type;
                cmd.Parameters["$q"].Value = r.Q;
                cmd.Parameters["$rr"].Value = r.R;
                cmd.Parameters["$pp"].Value = r.Pop;
                cmd.Parameters["$pf"].Value = r.PopF;
                cmd.Parameters["$ti"].Value = r.Tier;
                cmd.Parameters["$st"].Value = r.State;
                cmd.Parameters["$sk"].Value = r.Stock;
                cmd.Parameters["$bl"].Value = r.Built;
                cmd.Parameters["$bt"].Value = r.BornTick;
                cmd.Parameters["$ag"].Value = r.Age;
                cmd.Parameters["$fd"].Value = r.FoodDebt;
                cmd.Parameters["$pb"].Value = r.PopBase;
                cmd.Parameters["$bpf"].Value = (object?)r.BasePopF ?? DBNull.Value;
                cmd.Parameters["$ba"].Value = (object?)r.BaseAge ?? DBNull.Value;
                cmd.Parameters["$bf"].Value = r.BuiltFrac;
                cmd.Parameters["$kf"].Value = r.Kf;
                cmd.ExecuteNonQuery();
            }
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

    /* ---------- 序列化: 与 city-evo.js 的 CityState 结构互转 ---------- */

    private const string UpsertSql = """
        INSERT INTO CityState(Round, Id, Ver, UpdatedAt, LastEvoTick, Type, Q, R, Pop, PopF, Tier, State,
                              Stock, Built, BornTick, Age, FoodDebt, PopBase, BasePopF, BaseAge,
                              BuiltFrac, Kf)
        VALUES($ro, $id, $v, $u, $lt, $ty, $q, $rr, $pp, $pf, $ti, $st, $sk, $bl, $bt, $ag, $fd, $pb, $bpf, $ba, $bf, $kf)
        ON CONFLICT(Round, Id) DO UPDATE SET
            Ver=$v, UpdatedAt=$u, LastEvoTick=$lt, Type=$ty, Q=$q, R=$rr,
            Pop=$pp, PopF=$pf, Tier=$ti, State=$st,
            Stock=$sk, Built=$bl, BornTick=$bt, Age=$ag, FoodDebt=$fd, PopBase=$pb,
            BasePopF=$bpf, BaseAge=$ba, BuiltFrac=$bf, Kf=$kf;
        """;

    private static void BindUpsert(SqliteCommand cmd, CityStateRow r)
    {
        foreach (var n in new[] { "$ro", "$id", "$v", "$u", "$lt", "$ty", "$q", "$rr",
                                  "$pp", "$pf", "$ti", "$st", "$sk",
                                  "$bl", "$bt", "$ag", "$fd", "$pb", "$bpf", "$ba", "$bf", "$kf" })
            cmd.Parameters.AddWithValue(n, DBNull.Value);
    }

    private void Save(CityStateRow r)
    {
        if (_cs == null) return;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = UpsertSql;
        cmd.Parameters.AddWithValue("$ro", r.Round);
        cmd.Parameters.AddWithValue("$id", r.Id);
        cmd.Parameters.AddWithValue("$v", r.Ver);
        cmd.Parameters.AddWithValue("$u", r.UpdatedAt);
        cmd.Parameters.AddWithValue("$lt", r.LastEvoTick);
        cmd.Parameters.AddWithValue("$ty", r.Type);
        cmd.Parameters.AddWithValue("$q", r.Q);
        cmd.Parameters.AddWithValue("$rr", r.R);
        cmd.Parameters.AddWithValue("$pp", r.Pop);
        cmd.Parameters.AddWithValue("$pf", r.PopF);
        cmd.Parameters.AddWithValue("$ti", r.Tier);
        cmd.Parameters.AddWithValue("$st", r.State);
        cmd.Parameters.AddWithValue("$sk", r.Stock);
        cmd.Parameters.AddWithValue("$bl", r.Built);
        cmd.Parameters.AddWithValue("$bt", r.BornTick);
        cmd.Parameters.AddWithValue("$ag", r.Age);
        cmd.Parameters.AddWithValue("$fd", r.FoodDebt);
        cmd.Parameters.AddWithValue("$pb", r.PopBase);
        cmd.Parameters.AddWithValue("$bpf", (object?)r.BasePopF ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$ba", (object?)r.BaseAge ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$bf", r.BuiltFrac);
        cmd.Parameters.AddWithValue("$kf", r.Kf);
        cmd.ExecuteNonQuery();
    }

    private void EnsureLoaded()
    {
        if (_loaded || _cs == null) { _loaded = true; return; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText =
            "SELECT Round, Id, Ver, UpdatedAt, LastEvoTick, Type, Q, R, Pop, PopF, Tier, State, Stock, Built, " +
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
                Type = r.GetString(5),
                Q = r.GetInt32(6),
                R = r.GetInt32(7),
                Pop = r.GetInt32(8),
                PopF = r.GetDouble(9),
                Tier = r.GetInt32(10),
                State = r.GetInt32(11),
                Stock = r.GetString(12),
                Built = r.GetString(13),
                BornTick = r.GetInt64(14),
                Age = r.GetInt64(15),
                FoodDebt = r.GetDouble(16),
                PopBase = r.GetInt32(17),
                BasePopF = r.IsDBNull(18) ? null : r.GetDouble(18),
                BaseAge = r.IsDBNull(19) ? null : r.GetInt64(19),
                BuiltFrac = r.GetDouble(20),
                Kf = r.GetDouble(21),
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
