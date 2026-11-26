using System.Text.Json;
using Microsoft.Data.Sqlite;
using Zongmen.Services;
using Zongmen.Time;

namespace Zongmen.Storage;

/* ============================================================
 * 招募系统存储 (RecruitPoint / RecruitPool 两张独立表)
 * ------------------------------------------------------------
 * 方案: docs/游戏设计/招募系统-实施方案.md (§二 点数 · §三 防刷 · §九 服务端要点)
 *
 * ★ 为什么是两张独立表, 不塞 Data(Key,Value):
 *   MapWorldService 的后台 PruneExcept 会按「活跃 seed 前缀」定期 DELETE Data 表 ——
 *   塞进去会被静默清空。与 Crew / PlayerSect / WorldLedger / WorldClock 同一个坑。
 *
 * ★ 招募值为什么"惰性结算": 每个账号挂一个「每年按影响力加点」的定时任务, 要处理
 *   离线补算 / 换世重挂 / 重启恢复三套边界, 收益为零。WorldClock 已给权威时间 ⇒
 *   用 (nowTick, lastTick) 两个数随时能算出正确答案 (与 GetTileBlock「读时生成」同纪律)。
 *
 * ★ 写口纪律 (方案 §9.1):
 *   结算只走 <see cref="Settle"/> (一把锁内读-算-写); 端点不各写一份。
 *   ⚠ Settle **自己**取影响力 (IInfluence), 不接受调用方传 perYear —— 否则前端/别的端点
 *     能伪造产量。
 *
 * ★ 原子性: 扣点 (TrySpend) 与 刷新 (TryRoll) 都在同一把锁内完成「结算 + 校验 + 扣减」,
 *   并发 hire 不会各读到同一个余额再各扣一次 (那会扣成负数)。
 * ============================================================ */
public sealed record RecruitPointRow(string Account, int Round, int Points, long LastTick, int Ver);

public sealed record RecruitPoolRow(
    string Account, int Round, string SettleId, int RollNo,
    string TakenJson, string SettleJson, string PoolJson, int Ver);

public sealed class RecruitStore : IDisposable
{
    /* ---- 常量表 (方案 §2.2) —— 全部集中在这里, 调数值只改这一处 ---- */
    /// <summary>首次建档赠送 (够招 1 人)。</summary>
    public const int InitialPoints = 50;
    /// <summary>刷新一次 (换一整批候选人)。</summary>
    public const int RollCost = 30;
    /// <summary>招一人。</summary>
    public const int HireCost = 50;
    /// <summary>余额上限 = 产量 × 这个年数 (用户定案: 30 年产量)。</summary>
    public const int CapYears = 30;
    /// <summary>打探费 (默认 0; 想强堵「跑图看池」调到 = RollCost)。</summary>
    public const int EnterCost = 0;

    private const string CsTemplate = "Data Source={0};Pooling=True";

    private readonly string? _cs;
    private readonly IInfluence _influence;
    private readonly object _gate = new();
    private readonly Dictionary<string, RecruitPointRow> _points = new(StringComparer.Ordinal);
    private readonly Dictionary<string, RecruitPoolRow> _pools = new(StringComparer.Ordinal);
    private bool _loaded;

    public bool Persisted => _cs != null;

    public RecruitStore(string? dbPath, IInfluence influence)
    {
        _influence = influence ?? throw new ArgumentNullException(nameof(influence));
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS RecruitPoint (
                Account   TEXT    NOT NULL,
                Round     INTEGER NOT NULL,
                Points    INTEGER NOT NULL DEFAULT 0,
                LastTick  INTEGER NOT NULL DEFAULT 0,
                Ver       INTEGER NOT NULL DEFAULT 1,
                UpdatedAt INTEGER NOT NULL,
                PRIMARY KEY (Account, Round)
            );
            CREATE TABLE IF NOT EXISTS RecruitPool (
                Account    TEXT    NOT NULL,
                Round      INTEGER NOT NULL,
                SettleId   TEXT    NOT NULL,
                RollNo     INTEGER NOT NULL DEFAULT 0,
                Taken      BLOB    NOT NULL DEFAULT X'',
                SettleJson BLOB    NOT NULL DEFAULT X'',
                PoolJson   BLOB    NOT NULL DEFAULT X'',
                Ver        INTEGER NOT NULL DEFAULT 1,
                UpdatedAt  INTEGER NOT NULL,
                PRIMARY KEY (Account, Round, SettleId)
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

    private static string PKey(string account, int round) => account + "\u0001" + round;
    private static string QKey(string account, int round, string settleId)
        => account + "\u0001" + round + "\u0001" + settleId;

    /* ---------------- 影响力 / 上限 (同源, 方案 §2.1) ---------------- */

    /// <summary>每年产量 = 当前宗门影响力 (保底 1)。</summary>
    public int PerYear(string account, int round) => Math.Max(InfluenceProvider.Min, _influence.Of(account, round));

    /// <summary>余额上限 = 产量 × 30 年 (与 PerYear 同源, 影响力变了两者一起变)。</summary>
    public int CapOf(string account, int round) => PerYear(account, round) * CapYears;

    /* ---------------- 结算 ---------------- */

    /// <summary>
    /// 惰性结算: 把 (lastTick, nowTick) 之间**整年**的产量补进余额。
    /// ⚠ 余数必须留在 LastTick 上 (lastTick += years*360), 把 lastTick 直接写成 nowTick
    ///   会吞掉不足一年的零头 —— 每年都少算一点, 且完全静默。
    /// ⚠ 封顶只夹余额, **不停表**: 花掉之后靠新时间回血 (「余额上限」语义)。
    /// </summary>
    public RecruitPointRow Settle(string account, int round, long nowTick)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return SettleLocked(account, round, nowTick);
        }
    }

    private RecruitPointRow SettleLocked(string account, int round, long nowTick)
    {
        var key = PKey(account, round);
        if (!_points.TryGetValue(key, out var row))
        {
            /* 首次建档: 起始点从**现在**算, 不追补世界已过去的年份 (新账号不白拿历史产量)
               ⚠ nowTick<=0 = 世界/时钟都还没起来 (State 端点不要求世界存在)。
                 这种时候**绝不能落库**: 一旦把 LastTick 存成 0, 等世界跑起来
                 delta 就是几万 tick ⇒ 首次结算直接补到上限 (白送 300 点, 且无日志)。 */
            row = new RecruitPointRow(account, round, InitialPoints, nowTick, 1);
            if (nowTick <= 0) return row;         // 只读预览, 不建档
            _points[key] = row;
            SavePoint(row);
            return row;
        }

        var perYear = PerYear(account, round);
        var cap = perYear * CapYears;
        var delta = nowTick - row.LastTick;
        if (delta < 0) delta = 0;                        // 时钟回退 (换世/重置) 不吞点也不补点
        var years = delta / GameClock.TicksPerYear;

        if (years <= 0)
        {
            /* 不足 1 年也要处理「影响力下调导致 points > cap」: 夹断, 不补不退
               ⚠ 夹断后必须回写 _points: 不然内存缓存一直是超上限的旧值, 之后每次调用
                 都再夹一次 + 再写一次库 (返回正确、但白写库), 且任何读缓存的路径都会看到旧值。 */
            if (row.Points > cap)
            {
                row = row with { Points = cap };
                _points[key] = row;
                SavePoint(row);
            }
            return row;
        }

        var gain = (int)Math.Min(int.MaxValue, years * (long)perYear);
        var next = Math.Min(cap, row.Points + gain);
        var advanced = row.LastTick + years * GameClock.TicksPerYear;
        if (next == row.Points && advanced == row.LastTick) return row;   // 满额无事可写
        row = row with { Points = next, LastTick = advanced };
        SavePoint(row);
        return row;
    }

    /// <summary>
    /// 锁内原子「结算 → 校验 → 扣减」。返回 false ⇒ 余额不足 (row 仍是最新结算值, 供响应带回)。
    /// ⚠ 必须走这个入口扣点: 先 Settle 再在锁外判断/扣减会被并发 hire 挤成负数。
    /// </summary>
    public bool TrySpend(string account, int round, long nowTick, int cost, out RecruitPointRow row)
    {
        lock (_gate)
        {
            EnsureLoaded();
            row = SettleLocked(account, round, nowTick);
            if (cost > 0 && row.Points < cost) return false;
            if (cost > 0)
            {
                row = row with { Points = row.Points - cost };
                _points[PKey(account, round)] = row;
                SavePoint(row);
            }
            return true;
        }
    }

    /// <summary>退回点数 (hire 在 Crew 侧被拒时用; 夹在 [0, cap] 内)。</summary>
    public RecruitPointRow AddPoints(string account, int round, long nowTick, int delta)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var row = SettleLocked(account, round, nowTick);
            var cap = CapOf(account, round);
            var next = Math.Max(0, Math.Min(cap, row.Points + delta));
            if (next == row.Points) return row;
            row = row with { Points = next };
            _points[PKey(account, round)] = row;
            SavePoint(row);
            return row;
        }
    }

    /* ---------------- 池子 ---------------- */

    public RecruitPoolRow? GetPool(string account, int round, string settleId)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _pools.TryGetValue(QKey(account, round, settleId), out var r) ? r : null;
        }
    }

    /// <summary>
    /// 锁内原子「结算 → 校验余额 → 扣点 → rollNo+1 → 生成新池 → 覆盖快照」。
    /// ⚠ 生成委托**在锁内**执行: rollNo 与快照必须成对落库, 否则连点两次刷新会
    ///   两个请求各生成一份池子, 后写的赢而扣了两次点。
    /// </summary>
    public bool TryRoll(
        string account, int round, long nowTick, string settleId, string settleJson,
        Func<int, string> genPool,
        out RecruitPointRow points, out RecruitPoolRow? pool)
    {
        lock (_gate)
        {
            EnsureLoaded();
            points = SettleLocked(account, round, nowTick);
            pool = null;
            if (points.Points < RollCost) return false;

            var key = QKey(account, round, settleId);
            _pools.TryGetValue(key, out var cur);
            var rollNo = (cur?.RollNo ?? -1) + 1;
            var poolJson = genPool(rollNo);

            pool = new RecruitPoolRow(account, round, settleId, rollNo, "[]", settleJson, poolJson, 1);
            _pools[key] = pool;
            SavePool(pool);

            points = points with { Points = points.Points - RollCost };
            _points[PKey(account, round)] = points;
            SavePoint(points);
            return true;
        }
    }

    /// <summary>首次打探: 没有池子就生成 rollNo=0 并落库 (免费、幂等 —— 与 GetTileBlock 同性质)。</summary>
    public RecruitPoolRow EnsurePool(
        string account, int round, string settleId, string settleJson, Func<int, string> genPool)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var key = QKey(account, round, settleId);
            if (_pools.TryGetValue(key, out var hit) && !string.IsNullOrEmpty(hit.PoolJson)) return hit;
            var row = new RecruitPoolRow(account, round, settleId, 0, "[]", settleJson, genPool(0), 1);
            _pools[key] = row;
            SavePool(row);
            return row;
        }
    }

    /// <summary>标记某格已被招走 (幂等: 已记过就原样返回)。
    /// ⚠ rollNo ≥ 0 时校验池子批次: 招人的这几百毫秒里如果换了批 (另一个标签页点了刷新),
    ///   slot 指向的已经是**另一个人**, 标下去会白瞎一个候选 ⇒ 批次不符就不标。</summary>
    public RecruitPoolRow? MarkTaken(string account, int round, string settleId, int slot, int rollNo = -1)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var key = QKey(account, round, settleId);
            if (!_pools.TryGetValue(key, out var row)) return null;
            if (rollNo >= 0 && row.RollNo != rollNo) return row;
            var taken = ParseTaken(row.TakenJson);
            if (!taken.Contains(slot)) taken.Add(slot);
            taken.Sort();
            row = row with { TakenJson = JsonSerializer.Serialize(taken) };
            _pools[key] = row;
            SavePool(row);
            return row;
        }
    }

    /// <summary>读 Taken 列 (容错: 坏 JSON 当空表, 不让一条脏行废掉整个池子)。</summary>
    public static List<int> ParseTaken(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new List<int>();
        try { return JsonSerializer.Deserialize<List<int>>(json) ?? new List<int>(); }
        catch { return new List<int>(); }
    }

    /* ---------------- 落库 ---------------- */

    private void SavePoint(RecruitPointRow r)
    {
        if (_cs == null) return;
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO RecruitPoint(Account, Round, Points, LastTick, Ver, UpdatedAt)
            VALUES($a, $r, $p, $t, $v, $u)
            ON CONFLICT(Account, Round) DO UPDATE SET
                Points=$p, LastTick=$t, Ver=$v, UpdatedAt=$u;
            """;
        cmd.Parameters.AddWithValue("$a", r.Account);
        cmd.Parameters.AddWithValue("$r", r.Round);
        cmd.Parameters.AddWithValue("$p", r.Points);
        cmd.Parameters.AddWithValue("$t", r.LastTick);
        cmd.Parameters.AddWithValue("$v", r.Ver);
        cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        cmd.ExecuteNonQuery();
    }

    private void SavePool(RecruitPoolRow r)
    {
        if (_cs == null) return;
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO RecruitPool(Account, Round, SettleId, RollNo, Taken, SettleJson, PoolJson, Ver, UpdatedAt)
            VALUES($a, $r, $s, $n, $k, $sj, $pj, $v, $u)
            ON CONFLICT(Account, Round, SettleId) DO UPDATE SET
                RollNo=$n, Taken=$k, SettleJson=$sj, PoolJson=$pj, Ver=$v, UpdatedAt=$u;
            """;
        cmd.Parameters.AddWithValue("$a", r.Account);
        cmd.Parameters.AddWithValue("$r", r.Round);
        cmd.Parameters.AddWithValue("$s", r.SettleId);
        cmd.Parameters.AddWithValue("$n", r.RollNo);
        /* ⚠ 三列都是 JSON / 短文本 ⇒ 落库前 gzip (短串 BlobCodec 自动退回原文)。
           PoolJson 单个 17KB 里 49% 是键名, 压缩后约 4KB。 */
        cmd.Parameters.AddWithValue("$k", BlobCodec.Pack(r.TakenJson));
        cmd.Parameters.AddWithValue("$sj", BlobCodec.Pack(r.SettleJson));
        cmd.Parameters.AddWithValue("$pj", BlobCodec.Pack(r.PoolJson));
        cmd.Parameters.AddWithValue("$v", r.Ver);
        cmd.Parameters.AddWithValue("$u", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        cmd.ExecuteNonQuery();
    }

    private void EnsureLoaded()
    {
        if (_loaded) return;
        if (_cs == null) { _loaded = true; return; }
        /* ⚠ _loaded 只能在**读成功之后**置位。先置后读的话, 一次锁表 / IO 异常就会把
           "已加载" 钉死成空缓存 ⇒ 该账号下一次 Settle 被当成新档发 50 点, 并**覆盖**
           库里的真实余额 (静默扣掉玩家攒的招募值)。异常向上抛 (500) 比静默重置安全。 */
        using (var c = Open())
        {
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT Account, Round, Points, LastTick, Ver FROM RecruitPoint;";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var row = new RecruitPointRow(r.GetString(0), r.GetInt32(1), r.GetInt32(2), r.GetInt64(3), r.GetInt32(4));
                    _points[PKey(row.Account, row.Round)] = row;
                }
            }
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT Account, Round, SettleId, RollNo, Taken, SettleJson, PoolJson, Ver FROM RecruitPool;";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var row = new RecruitPoolRow(r.GetString(0), r.GetInt32(1), r.GetString(2), r.GetInt32(3),
                        BlobCodec.FromField(r.GetValue(4)), BlobCodec.FromField(r.GetValue(5)),
                        BlobCodec.FromField(r.GetValue(6)), r.GetInt32(7));
                    /* 坏行 (PoolJson 空) 不载入 ⇒ 下次打探自然重生成, 不必人工修库 */
                    if (string.IsNullOrEmpty(row.PoolJson)) continue;
                    _pools[QKey(row.Account, row.Round, row.SettleId)] = row;
                }
            }
        }
        _loaded = true;
    }

    public void Dispose()
    {
        lock (_gate) { _points.Clear(); _pools.Clear(); }
    }
}
