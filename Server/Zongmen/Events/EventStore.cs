using Microsoft.Data.Sqlite;

namespace Zongmen.Events;

/* ============================================================
 * 事件持久层：EventQueue（调度真源）+ History（状态差日志）
 * ------------------------------------------------------------
 * ★ 两张表的职责分界
 *   · `EventQueue` = **未来**：谁、什么时候、跑哪个脚本。行数 = 未触发事件数（有界）。
 *   · `History`    = **过去**：某 tick 某事件把某实体改成了什么。行数**随 tick 增长**。
 *   前者会被反复覆盖（NextTick 推进），后者只追加。混成一张表 ⇒ 覆盖会把历史改掉。
 *
 * ★ 为什么 History 只存 diff 不存全量
 *   全量存 CityStateRow（28 字段）≈ 120B/行；diff 通常只 2~4 个字段 ≈ 15B。
 *   100 万条事件差 100MB，且全量存会诱使人「拿最新一行当状态」⇒ 两套状态源。
 *
 * ★ 原子性（**这是本类存在的核心理由**）
 *   「写 History」与「推进 EventQueue」必须在**同一个事务**里：
 *     · 先写 History 后崩 ⇒ 事件重跑 ⇒ 状态被施加两次（瘟疫扣两遍人口）
 *     · 先推进后崩     ⇒ History 少一条 ⇒ 回放缺一段，且永远补不回来
 *   ⇒ <see cref="CommitRun"/> 是唯一的落库入口。
 *
 * ⚠ 独立成表（与 CityState / TickJob 同因）：`PruneExcept` 只清 `Data` 表，
 *   但塞进 `Data(Key,Value)` 会在换世后被静默删掉 —— 事件全部消失且不报错。
 * ============================================================ */
public sealed class EventStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private const string CreateSql = """
        CREATE TABLE IF NOT EXISTS EventQueue (
            Round       INTEGER NOT NULL,
            EntityId    INTEGER NOT NULL,
            EventKey    INTEGER NOT NULL,
            ScriptId    INTEGER NOT NULL,
            FnId        INTEGER NOT NULL,
            NextTick    INTEGER NOT NULL,
            PeriodTicks INTEGER NOT NULL DEFAULT 0,
            Phase       INTEGER NOT NULL DEFAULT 0,
            LastRunTick INTEGER NOT NULL DEFAULT 0,
            CreatedTick INTEGER NOT NULL DEFAULT 0,
            RunCount    INTEGER NOT NULL DEFAULT 0,
            FailCount   INTEGER NOT NULL DEFAULT 0,
            Enabled     INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (Round, EntityId, EventKey)
        );
        CREATE INDEX IF NOT EXISTS IX_EventQueue_Due ON EventQueue(NextTick);

        CREATE TABLE IF NOT EXISTS History (
            Round    INTEGER NOT NULL,
            Seq      INTEGER NOT NULL,
            Tick     INTEGER NOT NULL,
            EntityId INTEGER NOT NULL,
            ScriptId INTEGER NOT NULL,
            FnId     INTEGER NOT NULL,
            EventKey INTEGER NOT NULL,
            Diff     BLOB    NOT NULL,
            PRIMARY KEY (Round, Seq)
        );
        CREATE INDEX IF NOT EXISTS IX_History_Entity ON History(Round, EntityId, Tick);
        """;

    private readonly string? _cs;
    private readonly object _gate = new();

    /// <summary>本世已用的最大 Seq（启动时从库读一次，之后只增）。</summary>
    private readonly Dictionary<int, long> _seq = new();

    private long _historyRows, _committed, _skipped;

    public EventStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = CreateSql;
        cmd.ExecuteNonQuery();
    }

    public bool Persisted => _cs != null;
    public long HistoryRows => Interlocked.Read(ref _historyRows);
    public long Committed => Interlocked.Read(ref _committed);
    /// <summary>载入时因 (script,fn) 未登记 / 数据损坏被跳过的行数。⚠ 必须能被看到。</summary>
    public long Skipped => Interlocked.Read(ref _skipped);

    // ══ 载入 ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 读本世**启用中**的事件。
    /// ⚠ `(ScriptId, FnId)` 未登记的行**跳过并计数**（不抛）：一行脏数据不该废掉整次启动，
    ///   但也绝不许静默 —— 调用方把 <see cref="Skipped"/> 打进日志。
    /// </summary>
    public List<EventJob> LoadAll(int round)
    {
        var list = new List<EventJob>();
        if (_cs == null) return list;

        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT EntityId, EventKey, ScriptId, FnId, NextTick, PeriodTicks, Phase,
                   LastRunTick, CreatedTick, RunCount, FailCount, Enabled
            FROM EventQueue WHERE Round=$r ORDER BY EntityId, EventKey;
            """;
        cmd.Parameters.AddWithValue("$r", round);

        long skipped = 0;
        using var rd = cmd.ExecuteReader();
        while (rd.Read())
        {
            var script = (EventScript)(byte)rd.GetInt32(2);
            var fn = (byte)rd.GetInt32(3);
            if (!EventScriptRegistry.IsRegistered(script, fn)) { skipped++; continue; }

            var job = new EventJob
            {
                Round = round,
                EntityId = rd.GetInt32(0),
                EventKey = rd.GetInt32(1),
                Script = script,
                Fn = fn,
                NextTick = rd.GetInt64(4),
                PeriodTicks = rd.GetInt32(5),
                Phase = rd.GetInt64(6),
                LastRunTick = rd.GetInt64(7),
                CreatedTick = rd.GetInt64(8),
                RunCount = rd.GetInt32(9),
                FailCount = rd.GetInt32(10),
                Enabled = rd.GetInt32(11) != 0,
            };
            if (job.Enabled) list.Add(job);
        }

        /* Seq 起点：本世已有历史的最后一条。⚠ 必须在同一个连接里读，
           否则「换世 + 并发写」会让 Seq 从 1 重来 ⇒ 主键冲突 / 覆盖旧历史。 */
        _seq[round] = ReadMaxSeq(c, round);
        using (var n = c.CreateCommand())
        {
            n.CommandText = "SELECT COUNT(*) FROM History WHERE Round=$r;";
            n.Parameters.AddWithValue("$r", round);
            Interlocked.Exchange(ref _historyRows, Convert.ToInt64(n.ExecuteScalar() ?? 0L));
        }

        Interlocked.Exchange(ref _skipped, skipped);
        return list;
    }

    // ══ 调度写入（新增 / 取消 / 改期）══════════════════════════════════

    /// <summary>新增或覆盖一条事件（按主键 upsert）。⚠ 新事件**必须立即落库** ——
    /// 它是「内容」不是「派生」，丢了就永远不触发。</summary>
    public void Upsert(EventJob job)
    {
        if (!EventScriptRegistry.IsRegistered(job.Script, job.Fn))
            throw new InvalidOperationException(
                $"拒绝落库未登记的事件脚本 {job.Script}#{job.Fn}（会在触发时才发现，那时已经晚了）");
        if (_cs == null) return;

        lock (_gate)
        {
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = UpsertSql;
            BindEvent(cmd, job);
            cmd.ExecuteNonQuery();
        }
    }

    public bool Delete(EventRef key)
    {
        if (_cs == null) return false;
        lock (_gate)
        {
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM EventQueue WHERE Round=$r AND EntityId=$e AND EventKey=$k;";
            cmd.Parameters.AddWithValue("$r", key.Round);
            cmd.Parameters.AddWithValue("$e", key.EntityId);
            cmd.Parameters.AddWithValue("$k", key.EventKey);
            return cmd.ExecuteNonQuery() > 0;
        }
    }

    public int DeleteRound(int round)
    {
        if (_cs == null) return 0;
        lock (_gate)
        {
            using var c = Open();
            using var tx = c.BeginTransaction();
            using var cmd = c.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = "DELETE FROM EventQueue WHERE Round=$r; DELETE FROM History WHERE Round=$r;";
            cmd.Parameters.AddWithValue("$r", round);
            var n = cmd.ExecuteNonQuery();
            tx.Commit();
            _seq.Remove(round);
            return n;
        }
    }

    public int CountRound(int round)
    {
        if (_cs == null) return 0;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM EventQueue WHERE Round=$r;";
        cmd.Parameters.AddWithValue("$r", round);
        return Convert.ToInt32(cmd.ExecuteScalar() ?? 0);
    }

    // ══ ★ 唯一落库入口：History + EventQueue 同事务 ═════════════════════

    /// <summary>
    /// 一次事件触发的**原子**提交：追加 History + 推进/删除 EventQueue。
    ///
    /// <param name="isOneShot">true ⇒ 删行（一次性跑完）；false ⇒ 更新 NextTick/RunCount。</param>
    /// <returns>本次 History 的 Seq。一次性事件的调用方应同时把 job 从堆里移除。</returns>
    public long CommitRun(EventJob job, long tick, byte[] diff, long newNextTick, bool isOneShot)
    {
        var round = job.Round;
        lock (_gate)
        {
            /* ⚠⚠ Seq 必须**懒初始化**，不能只靠 `LoadAll` 里那一次：
               本方法可能在 LoadAll **之前**被调用（重启后先写后读；或该 round 从未载入）。
               只靠 LoadAll 的话这里会从 1 发号 ⇒ 与库里已有的 `(Round,Seq)` 主键
               **直接冲突**（SQLite Error 19）⇒ 整条提交失败、NextTick 推不动、每 tick 重试。
               实测复现：open → commit（不 load）⇒ seq=1 撞已有行。 */
            if (_cs == null)
            {
                var mem = (_seq.TryGetValue(round, out var v0) ? v0 : 0) + 1;
                _seq[round] = mem;
                Interlocked.Increment(ref _historyRows);
                Interlocked.Increment(ref _committed);
                return mem;
            }

            using var c = Open();
            var seq = _seq.TryGetValue(round, out var cached) ? cached + 1 : ReadMaxSeq(c, round) + 1;
            _seq[round] = seq;

            {
                using var tx = c.BeginTransaction();

                using (var h = c.CreateCommand())
                {
                    h.Transaction = tx;
                    h.CommandText = """
                        INSERT INTO History(Round, Seq, Tick, EntityId, ScriptId, FnId, EventKey, Diff)
                        VALUES($r, $s, $t, $e, $sc, $fn, $k, $d);
                        """;
                    h.Parameters.AddWithValue("$r", round);
                    h.Parameters.AddWithValue("$s", seq);
                    h.Parameters.AddWithValue("$t", tick);
                    h.Parameters.AddWithValue("$e", job.EntityId);
                    h.Parameters.AddWithValue("$sc", (int)job.Script);
                    h.Parameters.AddWithValue("$fn", (int)job.Fn);
                    h.Parameters.AddWithValue("$k", job.EventKey);
                    h.Parameters.AddWithValue("$d", diff);
                    h.ExecuteNonQuery();
                }

                using (var q = c.CreateCommand())
                {
                    q.Transaction = tx;
                    if (isOneShot)
                    {
                        q.CommandText = "DELETE FROM EventQueue WHERE Round=$r AND EntityId=$e AND EventKey=$k;";
                    }
                    else
                    {
                        q.CommandText = """
                            UPDATE EventQueue SET NextTick=$n, LastRunTick=$t, RunCount=$rc, FailCount=0, Enabled=1
                            WHERE Round=$r AND EntityId=$e AND EventKey=$k;
                            """;
                        q.Parameters.AddWithValue("$n", newNextTick);
                        q.Parameters.AddWithValue("$t", tick);
                        q.Parameters.AddWithValue("$rc", job.RunCount);
                    }
                    q.Parameters.AddWithValue("$r", round);
                    q.Parameters.AddWithValue("$e", job.EntityId);
                    q.Parameters.AddWithValue("$k", job.EventKey);
                    q.ExecuteNonQuery();
                }

                tx.Commit();
            }

            Interlocked.Increment(ref _historyRows);
            Interlocked.Increment(ref _committed);
            return seq;
        }
    }

    /// <summary>库里本世已用的最大 Seq（0 = 还没有历史）。⚠ Seq 发号的唯一库侧依据。</summary>
    private static long ReadMaxSeq(SqliteConnection c, int round)
    {
        using var q = c.CreateCommand();
        q.CommandText = "SELECT COALESCE(MAX(Seq), 0) FROM History WHERE Round=$r;";
        q.Parameters.AddWithValue("$r", round);
        return Convert.ToInt64(q.ExecuteScalar() ?? 0L);
    }

    /// <summary>失败时只更新退避位（**不写 History** —— 没成功就没有「状态改变」可记）。</summary>
    public void MarkFailed(EventJob job)
    {
        if (_cs == null) return;
        lock (_gate)
        {
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                UPDATE EventQueue SET NextTick=$n, FailCount=$f, Enabled=$en
                WHERE Round=$r AND EntityId=$e AND EventKey=$k;
                """;
            cmd.Parameters.AddWithValue("$n", job.NextTick);
            cmd.Parameters.AddWithValue("$f", job.FailCount);
            cmd.Parameters.AddWithValue("$en", job.Enabled ? 1 : 0);
            cmd.Parameters.AddWithValue("$r", job.Round);
            cmd.Parameters.AddWithValue("$e", job.EntityId);
            cmd.Parameters.AddWithValue("$k", job.EventKey);
            cmd.ExecuteNonQuery();
        }
    }

    // ══ 历史读取（回放 / 判据）═════════════════════════════════════════

    /// <summary>按 Seq 升序读一段历史。`entityId &lt; 0` = 不按实体筛。</summary>
    public List<HistoryRecord> ReadHistory(int round, int entityId = -1, long fromSeq = 0, int limit = 1000)
    {
        var list = new List<HistoryRecord>();
        if (_cs == null) return list;

        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = entityId < 0
            ? "SELECT Seq, Tick, EntityId, ScriptId, FnId, EventKey, Diff FROM History WHERE Round=$r AND Seq>$f ORDER BY Seq LIMIT $l;"
            : "SELECT Seq, Tick, EntityId, ScriptId, FnId, EventKey, Diff FROM History WHERE Round=$r AND EntityId=$e AND Seq>$f ORDER BY Seq LIMIT $l;";
        cmd.Parameters.AddWithValue("$r", round);
        if (entityId >= 0) cmd.Parameters.AddWithValue("$e", entityId);
        cmd.Parameters.AddWithValue("$f", fromSeq);
        cmd.Parameters.AddWithValue("$l", limit);

        using var rd = cmd.ExecuteReader();
        while (rd.Read())
        {
            list.Add(new HistoryRecord(
                Seq: rd.GetInt64(0),
                Tick: rd.GetInt64(1),
                EntityId: rd.GetInt32(2),
                Script: (EventScript)(byte)rd.GetInt32(3),
                Fn: (byte)rd.GetInt32(4),
                EventKey: rd.GetInt32(5),
                Diff: (byte[])rd.GetValue(6)));
        }
        return list;
    }

    private const string UpsertSql = """
        INSERT INTO EventQueue(Round, EntityId, EventKey, ScriptId, FnId, NextTick, PeriodTicks, Phase,
                               LastRunTick, CreatedTick, RunCount, FailCount, Enabled)
        VALUES($r, $e, $k, $sc, $fn, $n, $p, $ph, $lt, $ct, $rc, $fc, $en)
        ON CONFLICT(Round, EntityId, EventKey) DO UPDATE SET
            ScriptId=$sc, FnId=$fn, NextTick=$n, PeriodTicks=$p, Phase=$ph,
            LastRunTick=$lt, RunCount=$rc, FailCount=$fc, Enabled=$en;
        """;

    private static void BindEvent(SqliteCommand cmd, EventJob job)
    {
        cmd.Parameters.AddWithValue("$r", job.Round);
        cmd.Parameters.AddWithValue("$e", job.EntityId);
        cmd.Parameters.AddWithValue("$k", job.EventKey);
        cmd.Parameters.AddWithValue("$sc", (int)job.Script);
        cmd.Parameters.AddWithValue("$fn", (int)job.Fn);
        cmd.Parameters.AddWithValue("$n", job.NextTick);
        cmd.Parameters.AddWithValue("$p", job.PeriodTicks);
        cmd.Parameters.AddWithValue("$ph", job.Phase);
        cmd.Parameters.AddWithValue("$lt", job.LastRunTick);
        cmd.Parameters.AddWithValue("$ct", job.CreatedTick);
        cmd.Parameters.AddWithValue("$rc", job.RunCount);
        cmd.Parameters.AddWithValue("$fc", job.FailCount);
        cmd.Parameters.AddWithValue("$en", job.Enabled ? 1 : 0);
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

    public void Dispose() => SqliteConnection.ClearAllPools();
}

/// <summary>History 的一行。<see cref="Diff"/> 为空数组 = 「事件触发了，但状态没变」。</summary>
public sealed record HistoryRecord(
    long Seq,
    long Tick,
    int EntityId,
    EventScript Script,
    byte Fn,
    int EventKey,
    byte[] Diff);
