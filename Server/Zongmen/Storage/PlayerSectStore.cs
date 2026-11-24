using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Zongmen.Storage;

/// <summary>一位玩家在一世里立的一座聚落 (PlayerSect 表的一行 + 引擎侧要的骨架字段)。
/// 2026-09-23 起**一座玩家聚落一行** —— 主宗 (Type="sect") 与附属城镇 (town/village) 同表。</summary>
public sealed class PlayerSectEntry
{
    public string Account = "";
    public int Round;
    public int Ver;
    public long UpdatedAt;
    public string IdemKey = "";
    public string Id = "";
    public string Type = "sect";
    public int Q;
    public int R;
    public string Name = "";
    public int Pop;
    public string Owner = "";
    public int Tier = 1;
    public int State;
    public long ExpireTs;
    /// <summary>所属主宗 id (主宗自己 = "")。2026-09-23 城市扩张引入:
    /// ⚠ 服务端判定本身不必读它 (一世一宗 ⇒ 按 Account 统计等价), 它是为
    ///   「按宗门等级限制附属数量」留的**正确口径** —— 那个规则天然是 per-宗 而不是 per-账号。</summary>
    public string SectId = "";
    /// <summary>引擎侧聚落对象的原始 JSON (id/type/q/r/name/pop/owner/tier/state/expireTs)。
    /// 重放时**原样**拼给 MapGen.setExternalSettlements —— 不再二次拼装, 免得两处口径。</summary>
    public string Json = "";
    /// <summary>上一次成功提交的响应 JSON (幂等重放: 同 IdemKey 直接原样回放)。</summary>
    public string Resp = "";

    /// <summary>主宗 (= "sect") 还是附属城镇。全表的档位判定都走这里, 不散落字符串比较。</summary>
    public bool IsSect => string.Equals(Type, "sect", StringComparison.Ordinal);
}

/* ============================================================
 * 玩家聚落台账 (2026-09-23 玩家宗门放置方案 §4.3 / docs/玩家信息表设计.md)
 * ------------------------------------------------------------
 * 职责: 「本世某账号在某格立了一座什么样的聚落」的唯一权威记录。
 *   写入时机 = PlaceCommit 成功之后 (一次事务); 读取时机 = ① 配额判定
 *   ② VM (重新) 建立时把本世全部记录**重放**进引擎的 ext 层
 *   ③ 登录时把「我的宗门 + 附属城镇」回填给前端 (按钮显隐/面板)。
 *
 * 表结构 (同一个 db/zongmen.sqlite, 表 PlayerSect):
 *     PlayerSect(Account TEXT, Round INTEGER, Ver INTEGER, UpdatedAt INTEGER,
 *                IdemKey TEXT, Id TEXT, Type TEXT, Q INTEGER, R INTEGER,
 *                Name TEXT, Pop INTEGER, Owner TEXT, Tier INTEGER,
 *                SectId TEXT, Json TEXT, Resp TEXT,
 *                PRIMARY KEY(Account, Round, Id))
 *   · 主键 (Account, Round, Id) ⇒ 「一人一世 N 座」;**一人一世一宗**由
 *     CountOf(account, round) (只数 Type='sect') 在业务层守住, 不靠存储层表达
 *     (存储层无法用 PK 表达「至多一行 type='sect'」);
 *   · Id/Type/Q/R/Name/Tier **提列** (方案 §4.3 的混合式存储): 配额统计、按区域格
 *     索引、id 形态校验都要用, 从 Json 里每次反序列化既慢又没类型保证;
 *   · Json/Resp 存原文本 ⇒ 可跨版本演进而旧行仍能读 (新增字段不炸)。
 *
 * ⚠ v1 → v2 迁移 (2026-09-23 城市扩张): v1 的主键是 (Account, Round) ⇒ 一人一世
 *   只能一行, 附属城镇**无处可存**。SQLite 改不了主键 ⇒ 必须 建新表 + 搬数据 +
 *   删旧表 (整个迁移在**一个事务**里, 中途失败则旧表原样留着, 不会两头空)。
 *   迁移的识别标志 = **有没有 SectId 列** (v2 独有), 不去比 sqlite_master 里的
 *   PK 文本 (那种匹配太脆, 而且 v1 的 DDL 早就可能被人工改过)。
 *
 * ⚠ 为什么必须用**独立表**而不是往 Data(Key,Value) 里塞:
 *   与 WorldLedger 同因 —— MapWorldService 的后台维护任务会调
 *   SqliteVirtualContext.PruneExcept(活跃 seed 前缀), 那条 DELETE 的语义是
 *   「删掉所有 Key 不匹配 w:<16位>:* 的行」。玩家聚落如果塞进 Data 表, 换世之后
 *   **被静默删掉**(玩家资产凭空消失)。分表后清理任务完全够不着本表。
 *
 * ⚠ id 形态硬约束 (方案 §4.3): 前两段必须是区域格坐标的十进制整数 (`{i}_{j}_u{n}`)。
 *   引擎在 rngDominated / 骨架归属处会 `id.split('_')` 反解, 用 `p_…` 这类前缀会得
 *   NaN ⇒ 需求边池静默扫空、道路永不生成。落库前在此**断言**, 让坏数据在写入这一侧
 *   就爆掉, 而不是几天后在画面上表现为「路画不出来」。
 * ============================================================ */
public sealed class PlayerSectStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private const string CreateSql = """
        CREATE TABLE IF NOT EXISTS PlayerSect (
            Account   TEXT    NOT NULL,
            Round     INTEGER NOT NULL,
            Ver       INTEGER NOT NULL,
            UpdatedAt INTEGER NOT NULL,
            IdemKey   TEXT    NOT NULL DEFAULT '',
            Id        TEXT    NOT NULL,
            Type      TEXT    NOT NULL DEFAULT 'sect',
            Q         INTEGER NOT NULL,
            R         INTEGER NOT NULL,
            Name      TEXT    NOT NULL DEFAULT '',
            Pop       INTEGER NOT NULL DEFAULT 0,
            Owner     TEXT    NOT NULL DEFAULT '',
            Tier      INTEGER NOT NULL DEFAULT 1,
            SectId    TEXT    NOT NULL DEFAULT '',
            Json      TEXT    NOT NULL DEFAULT '',
            Resp      TEXT    NOT NULL DEFAULT '',
            PRIMARY KEY (Account, Round, Id)
        );
        """;

    private readonly string? _cs;
    /// <summary>每人每世的**主宗**数上限 (P0 = 1)。</summary>
    private readonly int _maxPerAccount;
    /// <summary>每座宗门可带附属城镇数上限; 0 = 不限 (默认)。
    /// 用户 2026-09-23: 「先不限制, 后续会根据等级来限制」⇒ 钩子留在这里。</summary>
    private readonly int _townMaxPerSect;
    private readonly List<PlayerSectEntry> _mem = new();     // 惰性全量镜像 (行数 = 玩家数×(1+附属), 很小)
    private readonly object _gate = new();
    private bool _loaded;

    public bool Persisted => _cs != null;
    public int MaxPerAccount => _maxPerAccount;
    public int TownMaxPerSect => _townMaxPerSect;

    public PlayerSectStore(string? dbPath, int maxPerAccount = 1, int townMaxPerSect = 0)
    {
        _maxPerAccount = Math.Max(1, maxPerAccount);
        _townMaxPerSect = Math.Max(0, townMaxPerSect);
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        EnsureSchema(init);
    }

    /* ---------- 建表 / 迁移 ---------- */

    private static bool TableExists(SqliteConnection c, string name)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=$n LIMIT 1;";
        cmd.Parameters.AddWithValue("$n", name);
        return cmd.ExecuteScalar() != null;
    }

    private static bool HasColumn(SqliteConnection c, string table, string col)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = $"PRAGMA table_info({table});";
        using var r = cmd.ExecuteReader();
        while (r.Read())
            if (string.Equals(r.GetString(1), col, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static void EnsureSchema(SqliteConnection c)
    {
        /* v1 识别 = 表在但**没有 SectId 列**。整个迁移在一个事务里:
           中途任何一步失败 ⇒ 回滚 ⇒ 旧表原样可用 (不会出现「新版空表 + 数据在
           改名后的表里」这种半死状态)。 */
        if (TableExists(c, "PlayerSect") && !HasColumn(c, "PlayerSect", "SectId"))
        {
            using var tx = c.BeginTransaction();
            using (var m = c.CreateCommand())
            {
                m.Transaction = tx;
                m.CommandText = """
                    ALTER TABLE PlayerSect RENAME TO PlayerSect_v1;
                    CREATE TABLE PlayerSect (
                        Account   TEXT    NOT NULL,
                        Round     INTEGER NOT NULL,
                        Ver       INTEGER NOT NULL,
                        UpdatedAt INTEGER NOT NULL,
                        IdemKey   TEXT    NOT NULL DEFAULT '',
                        Id        TEXT    NOT NULL,
                        Type      TEXT    NOT NULL DEFAULT 'sect',
                        Q         INTEGER NOT NULL,
                        R         INTEGER NOT NULL,
                        Name      TEXT    NOT NULL DEFAULT '',
                        Pop       INTEGER NOT NULL DEFAULT 0,
                        Owner     TEXT    NOT NULL DEFAULT '',
                        Tier      INTEGER NOT NULL DEFAULT 1,
                        SectId    TEXT    NOT NULL DEFAULT '',
                        Json      TEXT    NOT NULL DEFAULT '',
                        Resp      TEXT    NOT NULL DEFAULT '',
                        PRIMARY KEY (Account, Round, Id)
                    );
                    INSERT INTO PlayerSect(Account, Round, Ver, UpdatedAt, IdemKey, Id, Type, Q, R,
                                           Name, Pop, Owner, Tier, SectId, Json, Resp)
                        SELECT Account, Round, Ver, UpdatedAt, IdemKey, Id, Type, Q, R,
                               Name, Pop, Owner, Tier, '', Json, Resp
                        FROM PlayerSect_v1;
                    DROP TABLE PlayerSect_v1;
                    """;
                m.ExecuteNonQuery();
            }
            tx.Commit();
            Console.WriteLine("[PlayerSectStore] 表结构 v1 → v2 迁移完成 (主键改为 (Account,Round,Id), 加 SectId)");
        }
        using var cmd = c.CreateCommand();
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

    /// <summary>本世全部聚落 (重放给引擎用)。</summary>
    public IReadOnlyList<PlayerSectEntry> ByRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var outList = new List<PlayerSectEntry>();
            foreach (var e in _mem) if (e.Round == round) outList.Add(e);
            return outList;
        }
    }

    /// <summary>本账户在本世的**主宗** (按 Account 取 Type='sect' 那一行)。
    /// 「拓土」的锚点就是它 —— 判据要用它的 q/r, 所以这里返回整行而不是只回首 id。</summary>
    public PlayerSectEntry? Find(string account, int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            foreach (var e in _mem)
                if (e.Round == round && e.IsSect &&
                    string.Equals(e.Account, account, StringComparison.Ordinal)) return e;
            return null;
        }
    }

    /// <summary>本账户在本世的**全部**聚落 (主宗在前, 附属城镇随后; 按 id 序)。</summary>
    public IReadOnlyList<PlayerSectEntry> ByAccount(string account, int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var outList = new List<PlayerSectEntry>();
            foreach (var e in _mem)
                if (e.Round == round && string.Equals(e.Account, account, StringComparison.Ordinal))
                    outList.Add(e);
            /* 主宗排第一: 前端的「本宗面板」直接取 [0] 当本宗, 锚点/回宗按钮都靠它 */
            outList.Sort((a, b) =>
            {
                var c = (a.IsSect ? 0 : 1).CompareTo(b.IsSect ? 0 : 1);
                return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
            });
            return outList;
        }
    }

    /// <summary>按幂等键找那一行 (同键重发要回放**同一座**的响应)。
    /// ⚠ v2 起一个账号有多行 ⇒ 不能再用 (Account,Round) 当唯一键。</summary>
    public PlayerSectEntry? FindByIdemKey(string account, int round, string idemKey)
    {
        if (string.IsNullOrEmpty(idemKey)) return null;
        lock (_gate)
        {
            EnsureLoaded();
            foreach (var e in _mem)
                if (e.Round == round && string.Equals(e.Account, account, StringComparison.Ordinal) &&
                    string.Equals(e.IdemKey, idemKey, StringComparison.Ordinal)) return e;
            return null;
        }
    }

    /// <summary>按主键取一行 (幂等回放要按**具体那一座**找, 不能再拿账号当唯一键)。</summary>
    public PlayerSectEntry? FindById(string account, int round, string id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            foreach (var e in _mem)
                if (e.Round == round && string.Equals(e.Account, account, StringComparison.Ordinal) &&
                    string.Equals(e.Id, id, StringComparison.Ordinal)) return e;
            return null;
        }
    }

    /// <summary>本账户在本世已立的**主宗**数 (配额判定用; 附属城镇不计)。</summary>
    public int CountOf(string account, int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var e in _mem)
                if (e.Round == round && e.IsSect &&
                    string.Equals(e.Account, account, StringComparison.Ordinal)) n++;
            return n;
        }
    }

    /// <summary>本账户在本世的**附属城镇**数 (按 Account; 一世一宗 ⇒ 与 per-宗 等价)。
    /// ⚠ 将来「按等级限制」要按**具体那座主宗**数时, 换成按 SectId 过滤即可 ——
    ///   v2 表已经带这个列, 不需要再改结构。</summary>
    public int CountTowns(string account, int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var e in _mem)
                if (e.Round == round && !e.IsSect &&
                    string.Equals(e.Account, account, StringComparison.Ordinal)) n++;
            return n;
        }
    }

    /// <summary>本世玩家聚落总数 (诊断/展示用)。</summary>
    public int CountRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var e in _mem) if (e.Round == round) n++;
            return n;
        }
    }

    /// <summary>本世**附属城镇**总数 (诊断/验证脚本用; 与 CountRound 配对报数)。</summary>
    public int CountTownsRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var n = 0;
            foreach (var e in _mem) if (e.Round == round && !e.IsSect) n++;
            return n;
        }
    }

    /// <summary>本世已占用的区域格 (i,j) 集合 —— 服务端域检查时用来把"别的玩家的聚落"
    /// 也算进领地, 免得两个玩家把宗门贴在一起 (引擎侧 ext 层已含全部记录, 这里只是
    /// 给 C# 侧做一次快速前置判定, 不用它也能对)。</summary>
    public IReadOnlyList<(int I, int J)> RegionsOfRound(int round)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var list = new List<(int, int)>();
            foreach (var e in _mem) if (e.Round == round) list.Add((RegionOf(e.Q), RegionOf(e.R)));
            return list;
        }
    }

    /// <summary>区域格坐标 (与引擎 regionSeedOf 的**晶格**口径一致: floor(q/REGION_M))。
    /// ⚠ 仅用于统计/索引; 引擎侧的权威归属是 id 前两段, 不重算。</summary>
    private const int RegionM = 18;
    private static int RegionOf(int v) => (int)Math.Floor(v / (double)RegionM);

    /* ---------- 写 ---------- */

    /// <summary>落库 (按 (Account,Round,Id) 覆盖) 并同步内存镜像。返回落库后的行。</summary>
    public PlayerSectEntry Put(PlayerSectEntry e)
    {
        ValidateId(e.Id, e.Round);
        lock (_gate)
        {
            EnsureLoaded();
            e.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            for (var i = 0; i < _mem.Count; i++)
            {
                if (_mem[i].Round == e.Round &&
                    string.Equals(_mem[i].Account, e.Account, StringComparison.Ordinal) &&
                    string.Equals(_mem[i].Id, e.Id, StringComparison.Ordinal))
                {
                    e.Ver = _mem[i].Ver + 1;
                    _mem[i] = e;
                    Save(e);
                    return e;
                }
            }
            e.Ver = 1;
            _mem.Add(e);
            Save(e);
            return e;
        }
    }

    /// <summary>幂等重放用: 只更新 Resp 列 (同 IdemKey 重复提交时不该再写业务字段)。
    /// ⚠ 必须按 Id 定位 —— v2 里一个账号有多行, 拿 (Account,Round) 找会改错行
    /// (表现 = 幂等回放把附属城镇的响应记到主宗头上)。</summary>
    public void PutResp(string account, int round, string id, string idemKey, string resp)
    {
        lock (_gate)
        {
            EnsureLoaded();
            for (var i = 0; i < _mem.Count; i++)
            {
                if (_mem[i].Round != round ||
                    !string.Equals(_mem[i].Account, account, StringComparison.Ordinal) ||
                    !string.Equals(_mem[i].Id, id, StringComparison.Ordinal)) continue;
                _mem[i].IdemKey = idemKey;
                _mem[i].Resp = resp;
                Save(_mem[i]);
                return;
            }
        }
    }

    /// <summary>拆除一座 (按 Id)。不存在返回 false。</summary>
    public bool Remove(string account, int round, string id)
    {
        lock (_gate)
        {
            EnsureLoaded();
            for (var i = 0; i < _mem.Count; i++)
            {
                if (_mem[i].Round != round ||
                    !string.Equals(_mem[i].Account, account, StringComparison.Ordinal) ||
                    !string.Equals(_mem[i].Id, id, StringComparison.Ordinal)) continue;
                _mem.RemoveAt(i);
                if (_cs != null)
                {
                    using var c = Open();
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = "DELETE FROM PlayerSect WHERE Account=$a AND Round=$r AND Id=$i;";
                    cmd.Parameters.AddWithValue("$a", account);
                    cmd.Parameters.AddWithValue("$r", round);
                    cmd.Parameters.AddWithValue("$i", id);
                    cmd.ExecuteNonQuery();
                }
                return true;
            }
            return false;
        }
    }

    private void Save(PlayerSectEntry e)
    {
        if (_cs == null) return;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO PlayerSect(Account, Round, Ver, UpdatedAt, IdemKey, Id, Type, Q, R,
                                   Name, Pop, Owner, Tier, SectId, Json, Resp)
            VALUES($a, $r, $v, $u, $ik, $id, $ty, $q, $rr, $nm, $pp, $ow, $ti, $se, $js, $rs)
            ON CONFLICT(Account, Round, Id) DO UPDATE SET
                Ver=$v, UpdatedAt=$u, IdemKey=$ik, Type=$ty, Q=$q, R=$rr,
                Name=$nm, Pop=$pp, Owner=$ow, Tier=$ti, SectId=$se, Json=$js, Resp=$rs;
            """;
        cmd.Parameters.AddWithValue("$a", e.Account);
        cmd.Parameters.AddWithValue("$r", e.Round);
        cmd.Parameters.AddWithValue("$v", e.Ver);
        cmd.Parameters.AddWithValue("$u", e.UpdatedAt);
        cmd.Parameters.AddWithValue("$ik", e.IdemKey);
        cmd.Parameters.AddWithValue("$id", e.Id);
        cmd.Parameters.AddWithValue("$ty", e.Type);
        cmd.Parameters.AddWithValue("$q", e.Q);
        cmd.Parameters.AddWithValue("$rr", e.R);
        cmd.Parameters.AddWithValue("$nm", e.Name);
        cmd.Parameters.AddWithValue("$pp", e.Pop);
        cmd.Parameters.AddWithValue("$ow", e.Owner);
        cmd.Parameters.AddWithValue("$ti", e.Tier);
        cmd.Parameters.AddWithValue("$se", e.SectId);
        cmd.Parameters.AddWithValue("$js", e.Json);
        cmd.Parameters.AddWithValue("$rs", e.Resp);
        cmd.ExecuteNonQuery();
    }

    private void EnsureLoaded()
    {
        if (_loaded || _cs == null) { _loaded = true; return; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText =
            "SELECT Account, Round, Ver, UpdatedAt, IdemKey, Id, Type, Q, R, Name, Pop, Owner, Tier, SectId, Json, Resp " +
            "FROM PlayerSect ORDER BY Round, Account, Id;";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            _mem.Add(new PlayerSectEntry
            {
                Account = r.GetString(0),
                Round = r.GetInt32(1),
                Ver = r.GetInt32(2),
                UpdatedAt = r.GetInt64(3),
                IdemKey = r.GetString(4),
                Id = r.GetString(5),
                Type = r.GetString(6),
                Q = r.GetInt32(7),
                R = r.GetInt32(8),
                Name = r.GetString(9),
                Pop = r.GetInt32(10),
                Owner = r.GetString(11),
                Tier = r.GetInt32(12),
                SectId = r.GetString(13),
                Json = r.GetString(14),
                Resp = r.GetString(15),
            });
        }
        _loaded = true;
    }

    /// <summary>id 形态硬约束: `{区域i}_{区域j}_u{n}` (前两段是有符号十进制整数)。
    /// 违反即抛 —— 详见类头注释 (坏 id 会让需求边池静默扫空, 属「无异常无日志」故障)。</summary>
    public static void ValidateId(string id, int round)
    {
        if (string.IsNullOrEmpty(id)) throw new InvalidDataException("PlayerSect.Id 为空");
        var parts = id.Split('_');
        if (parts.Length < 3)
            throw new InvalidDataException($"PlayerSect.Id 形态非法 (需 {{i}}_{{j}}_u{{n}}): {id}");
        if (!int.TryParse(parts[0], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _) ||
            !int.TryParse(parts[1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _))
            throw new InvalidDataException(
                $"PlayerSect.Id 前两段必须是区域格整数 (引擎会 split('_') 反解, 非数会得 NaN " +
                $"⇒ 道路静默不生成): {id}  (Round={round})");
        if (parts[2].Length == 0 || parts[2][0] != 'u')
            throw new InvalidDataException($"PlayerSect.Id 第三段必须是 u{{n}}: {id}");
    }

    /// <summary>把本世的记录拼成引擎 setExternalSettlements 要的 JSON 数组。</summary>
    public string JsonArrayForRound(int round)
    {
        var rows = ByRound(round);
        var sb = new StringBuilder("[");
        for (var i = 0; i < rows.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(string.IsNullOrEmpty(rows[i].Json) ? BuildJson(rows[i]) : rows[i].Json);
        }
        sb.Append(']');
        return sb.ToString();
    }

    /// <summary>引擎侧聚落对象的 JSON (与 mapgen.placeSettlement 的产物同形状)。</summary>
    public static string BuildJson(PlayerSectEntry e)
    {
        using var ms = new MemoryStream();
        using (var w = new Utf8JsonWriter(ms))
        {
            w.WriteStartObject();
            w.WriteString("id", e.Id);
            w.WriteString("type", e.Type);
            w.WriteNumber("q", e.Q);
            w.WriteNumber("r", e.R);
            w.WriteString("name", e.Name);
            w.WriteNumber("pop", e.Pop);
            w.WriteString("owner", e.Owner);
            w.WriteNumber("tier", e.Tier);
            w.WriteNumber("state", e.State);
            w.WriteNumber("expireTs", e.ExpireTs);
            w.WriteEndObject();
        }
        return Encoding.UTF8.GetString(ms.ToArray());
    }

    public void Dispose()
    {
        lock (_gate) _mem.Clear();
    }
}
