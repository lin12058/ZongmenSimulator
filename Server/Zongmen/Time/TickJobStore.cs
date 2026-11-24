using Microsoft.Data.Sqlite;

namespace Zongmen.Time;

/// <summary>
/// `TickJob` 表的持久化：**载入 / 批量 UPSERT / 对账**（设计文档 §二）。
///
/// ⚠⚠ 为什么必须落库（对「重启全量重算」的量化反驳）：
///   1. **一次性事件是「内容」不是「派生」** —— 丢了就永远回不来（最硬的理由）；
///   2. 全量重建要「遍历全图区域格 → `settlementsFor`」⇒ 冷 V8 下是**秒级**
///      （`regionJson` 首次单区域 A* 实测 ~195.8ms，全图区域数远大于 1）；
///   3. `FailCount` 丢失 ⇒ 坏 job 重启后重新开始失败循环（重复日志、重复无效计算）；
///   4. `LastRunTick` 丢失 ⇒ 首次演化的 Δt 算错（要么按 0 天不演化，要么按巨大值跳变）。
///
/// ⚠⚠ 为什么必须**独立成表**：`PruneExcept` 只清 `Data` 表的非活跃 seed 前缀 ——
///   塞 `Data(Key,Value)` 里会被**静默删掉**。与 `WorldLedger` / `PlayerSectStore` 同理。
///
/// 表结构（照设计文档 §2.1）：
/// ```sql
/// CREATE TABLE TickJob (
///   Seed TEXT, Round INTEGER, EntityId TEXT, Kind TEXT,
///   Layer INTEGER, Resource INTEGER,
///   NextTick INTEGER, PeriodTicks INTEGER, Phase INTEGER, LastRunTick INTEGER,
///   FailCount INTEGER DEFAULT 0, Enabled INTEGER DEFAULT 1,
///   Payload BLOB,
///   PRIMARY KEY (Seed, Round, EntityId, Kind)
/// );
/// CREATE INDEX ix_tickjob_due ON TickJob (Seed, Round, Enabled, NextTick);
/// ```
///
/// ⚠ 五条设计约束（别违反）：
///   · `EntityId` **原样存取**，绝不由 C# 重算（引擎自算，C# 重算 = 批量踩坑）；
///   · `Payload` 是 **BLOB 而非 TEXT**，且 **不 gzip**（几十字节，gzip header 18B 净亏）；
///   · `Kind` 存**字符串**不存 int（枚举增删不会让历史行错读成另一个 kind）；
///   · 索引按 `(Seed, Round, Enabled, NextTick)` —— 载入时唯一要跑的查询就这个形状；
///   · 三张账分账（`WorldClock` / `TickJob` / `TickPerf` 各自独立）。
/// </summary>
public sealed class TickJobStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private readonly string? _cs;
    private readonly object _gate = new();

    /// <summary>脏行（键 → job）。⚠ 内存堆是运行时唯一真源，这里只攒「待回写」。</summary>
    private readonly Dictionary<JobKey, TickJob> _dirty = new();
    private readonly HashSet<JobKey> _deleted = new();

    private long _flushCount;
    private long _upsertedRows;
    private long _loadedRows;
    private long _skippedRows;

    public bool Persisted => _cs != null;
    public int DirtyCount { get { lock (_gate) return _dirty.Count + _deleted.Count; } }
    public long FlushCount => Interlocked.Read(ref _flushCount);
    public long UpsertedRows => Interlocked.Read(ref _upsertedRows);
    /// <summary>载入时被跳过的脏行数（`Kind` 无法解析 / 字段缺失）。⚠ 应上报 /stats，不该静默。</summary>
    public long SkippedRows => Interlocked.Read(ref _skippedRows);
    public long LoadedRows => Interlocked.Read(ref _loadedRows);

    public TickJobStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS TickJob (
                Seed        TEXT    NOT NULL,
                Round       INTEGER NOT NULL,
                EntityId    TEXT    NOT NULL,
                Kind        TEXT    NOT NULL,
                Layer       INTEGER NOT NULL,
                Resource    INTEGER NOT NULL,
                NextTick    INTEGER NOT NULL,
                PeriodTicks INTEGER NOT NULL,
                Phase       INTEGER NOT NULL DEFAULT 0,
                LastRunTick INTEGER NOT NULL DEFAULT 0,
                FailCount   INTEGER NOT NULL DEFAULT 0,
                Enabled     INTEGER NOT NULL DEFAULT 1,
                Payload     BLOB,
                PRIMARY KEY (Seed, Round, EntityId, Kind)
            );
            CREATE INDEX IF NOT EXISTS ix_tickjob_due
                ON TickJob (Seed, Round, Enabled, NextTick);
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

    // ══ ① 载入（启动 / 换世）═══════════════════════════════════════════

    /// <summary>
    /// 读回本世所有 enabled 的 job。
    /// ⚠ `Kind` 无法解析 / `NextTick` 非法的行**跳过并计数** ——
    ///   不要让一行脏数据废掉整次载入（`SkippedRows` 会上报 /stats）。
    /// </summary>
    public List<TickJob> Load(string seed, int round)
    {
        var outList = new List<TickJob>();
        if (_cs == null) return outList;

        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT EntityId, Kind, Layer, Resource, NextTick, PeriodTicks, Phase,
                   LastRunTick, FailCount, Enabled, Payload
            FROM TickJob
            WHERE Seed=$s AND Round=$r AND Enabled=1;
            """;
        cmd.Parameters.AddWithValue("$s", seed);
        cmd.Parameters.AddWithValue("$r", round);

        var skipped = 0L;
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            var entityId = r.GetString(0);
            var kindName = r.GetString(1);

            if (!KindNames.TryParse(kindName, out var kind)) { skipped++; continue; }
            if (r.IsDBNull(4)) { skipped++; continue; }

            var nextTick = r.GetInt64(4);
            if (nextTick < 0) { skipped++; continue; }

            var payload = r.IsDBNull(10) ? null : (byte[])r.GetValue(10);

            outList.Add(new TickJob
            {
                Seed = seed,
                Round = round,
                EntityId = entityId,
                Kind = kind,
                Layer = (TickLayer)r.GetInt32(2),
                Resource = (TickResource)r.GetInt32(3),
                NextTick = nextTick,
                PeriodTicks = r.GetInt32(5),
                Phase = r.GetInt64(6),
                LastRunTick = r.GetInt64(7),
                FailCount = r.GetInt32(8),
                Enabled = r.GetInt32(9) != 0,
                Payload = payload,
            });
        }

        Interlocked.Add(ref _loadedRows, outList.Count);
        if (skipped > 0) Interlocked.Add(ref _skippedRows, skipped);
        return outList;
    }

    // ══ ② 回写（不能每 tick UPDATE）════════════════════════════════════

    /// <summary>
    /// 标记脏行。**不在调用点写库** —— 内存堆是运行时唯一真源，
    /// 攒到 <see cref="Flush"/> 时一次事务内批量 UPSERT。
    /// </summary>
    public void MarkDirty(TickJob job)
    {
        lock (_gate) _dirty[job.Key] = job;
    }

    /// <summary>标记删除（`Enabled=0` / 换世清理）。</summary>
    public void MarkDeleted(JobKey key)
    {
        lock (_gate) { _dirty.Remove(key); _deleted.Add(key); }
    }

    /// <summary>
    /// 批量 UPSERT（一次事务）。⚠ 关机 / 换世必须调（挂 `ApplicationStopping`）。
    /// </summary>
    public int Flush()
    {
        List<TickJob> jobs;
        List<JobKey> deleted;

        lock (_gate)
        {
            if (_dirty.Count == 0 && _deleted.Count == 0) return 0;
            jobs = _dirty.Values.ToList();
            deleted = _deleted.ToList();
            _dirty.Clear();
            _deleted.Clear();
        }

        if (_cs == null)
        {
            Interlocked.Increment(ref _flushCount);
            Interlocked.Add(ref _upsertedRows, jobs.Count);
            return jobs.Count;
        }

        /* ⚠⚠ at-least-once: 脏集已在上面清空 ⇒ 这里任何一步抛异常都必须**把快照并回脏集**
           再抛出。否则内存里已无待写行, 调用方 MaybeFlush 打印的「下轮重试」是**假的**
           —— 丢失 NextTick / FailCount / Enabled / LastRunTick 的持久化更新。 */
        try
        {
            using var c = Open();
            using var tx = c.BeginTransaction();

            using (var cmd = c.CreateCommand())
            {
                cmd.Transaction = tx;
                cmd.CommandText = """
                    INSERT INTO TickJob(Seed, Round, EntityId, Kind, Layer, Resource,
                                        NextTick, PeriodTicks, Phase, LastRunTick,
                                        FailCount, Enabled, Payload)
                    VALUES($s, $r, $e, $k, $l, $res, $n, $p, $ph, $lr, $fc, $en, $pl)
                    ON CONFLICT(Seed, Round, EntityId, Kind) DO UPDATE SET
                        Layer       = excluded.Layer,
                        Resource    = excluded.Resource,
                        NextTick    = excluded.NextTick,
                        PeriodTicks = excluded.PeriodTicks,
                        -- ⚠ Phase 刻意**不更新**：抖动一旦定下就不许被任何回写推平
                        LastRunTick = excluded.LastRunTick,
                        FailCount   = excluded.FailCount,
                        Enabled     = excluded.Enabled,
                        Payload     = excluded.Payload;
                    """;

                var ps = cmd.Parameters;
                var pS = ps.Add("$s", SqliteType.Text);
                var pR = ps.Add("$r", SqliteType.Integer);
                var pE = ps.Add("$e", SqliteType.Text);
                var pK = ps.Add("$k", SqliteType.Text);
                var pL = ps.Add("$l", SqliteType.Integer);
                var pRes = ps.Add("$res", SqliteType.Integer);
                var pN = ps.Add("$n", SqliteType.Integer);
                var pP = ps.Add("$p", SqliteType.Integer);
                var pPh = ps.Add("$ph", SqliteType.Integer);
                var pLr = ps.Add("$lr", SqliteType.Integer);
                var pFc = ps.Add("$fc", SqliteType.Integer);
                var pEn = ps.Add("$en", SqliteType.Integer);
                var pPl = ps.Add("$pl", SqliteType.Blob);

                foreach (var j in jobs)
                {
                    pS.Value = j.Seed;
                    pR.Value = j.Round;
                    pE.Value = j.EntityId;
                    pK.Value = KindNames.Of(j.Kind);
                    pL.Value = (int)j.Layer;
                    pRes.Value = (int)j.Resource;
                    pN.Value = j.NextTick == ConcurrentTickQueue.RevokedTick ? j.NextTick - 1 : j.NextTick;
                    pP.Value = j.PeriodTicks;
                    pPh.Value = j.Phase;
                    pLr.Value = j.LastRunTick;
                    pFc.Value = j.FailCount;
                    pEn.Value = j.Enabled ? 1 : 0;
                    pPl.Value = (object?)j.Payload ?? DBNull.Value;
                    cmd.ExecuteNonQuery();
                }
            }

            if (deleted.Count > 0)
            {
                using var cmd = c.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText = "DELETE FROM TickJob WHERE Seed=$s AND Round=$r AND EntityId=$e AND Kind=$k;";
                var ps = cmd.Parameters;
                var pS = ps.Add("$s", SqliteType.Text);
                var pR = ps.Add("$r", SqliteType.Integer);
                var pE = ps.Add("$e", SqliteType.Text);
                var pK = ps.Add("$k", SqliteType.Text);
                foreach (var k in deleted)
                {
                    pS.Value = k.Seed; pR.Value = k.Round; pE.Value = k.EntityId;
                    pK.Value = KindNames.Of(k.Kind);
                    cmd.ExecuteNonQuery();
                }
            }

            tx.Commit();
        }
        catch
        {
            /* 失败 ⇒ 并回脏集 (不覆盖 flush 期间被 MarkDirty 写入的更新值), 保证下次重试。
               ⚠ 用 TryAdd / Add: 已存在的键保留新状态, 绝不回退。 */
            lock (_gate)
            {
                foreach (var j in jobs) _dirty.TryAdd(j.Key, j);
                foreach (var k in deleted) _deleted.Add(k);
            }
            throw;
        }

        Interlocked.Increment(ref _flushCount);
        Interlocked.Add(ref _upsertedRows, jobs.Count);
        return jobs.Count;
    }

    /// <summary>一次性事件：**插入后立即落库**（不等 flush 窗口 —— 它是内容不是派生）。</summary>
    public void UpsertImmediate(TickJob job)
    {
        MarkDirty(job);
        Flush();
    }

    // ══ ③ 对账（防「漏事件 ⇒ 永久缺 job」这个静默病）═══════════════════

    /// <summary>
    /// 全量对账：`expected` = 「应该有」的 job 键集合。
    ///
    /// ⚠⚠ 铁律：**只增删，不重置**。已存在行的 `NextTick` / `Phase` **绝不许被覆盖** ——
    ///   否则每年一次的兜底对账会把相位抖动全部推平回同一天，抖动就白做了。
    /// </summary>
    public ReconcileReport Reconcile(string seed, int round, IEnumerable<TickJob> expected,
                                     TickJobRegistry registry, long nowTick)
    {
        var exp = new Dictionary<JobKey, TickJob>();
        foreach (var j in expected) exp[j.Key] = j;

        var existing = Load(seed, round)
            .ToDictionary(j => j.Key);

        var added = new List<TickJob>();
        var removed = new List<JobKey>();

        foreach (var (key, e) in exp)
        {
            if (existing.ContainsKey(key)) continue;      // ★ 已存在 ⇒ 一个字段都不动
            added.Add(e);
        }

        foreach (var key in existing.Keys)
        {
            if (!exp.ContainsKey(key)) removed.Add(key);
        }

        foreach (var j in added) MarkDirty(j);
        foreach (var k in removed) MarkDeleted(k);
        Flush();

        return new ReconcileReport(added.Count, removed.Count, existing.Count);
    }

    public long Count()
    {
        if (_cs == null) { lock (_gate) return _dirty.Count; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM TickJob;";
        return Convert.ToInt64(cmd.ExecuteScalar());
    }

    /// <summary>清掉某世（换世）。</summary>
    public int DeleteWorld(string seed, int round)
    {
        if (_cs == null) return 0;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM TickJob WHERE Seed=$s AND Round=$r;";
        cmd.Parameters.AddWithValue("$s", seed);
        cmd.Parameters.AddWithValue("$r", round);
        return cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// 清掉某世某 kind 的**全部**行（不限 `Enabled`）。用于收尾清理**僵尸行**：
    /// `Enabled=0` 的停用行既不在 `expected`（provider 不再投递）也不在
    /// <see cref="Load"/>(只取 `Enabled=1`) 里 ⇒ <see cref="Reconcile"/> **永远判不到它**
    /// ⇒ 会永久滞留在表里。只有换世 (`DeleteWorld`) 才顺手清得掉。
    /// </summary>
    public int DeleteKindRows(string seed, int round, string kind)
    {
        if (_cs == null) return 0;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM TickJob WHERE Seed=$s AND Round=$r AND Kind=$k;";
        cmd.Parameters.AddWithValue("$s", seed);
        cmd.Parameters.AddWithValue("$r", round);
        cmd.Parameters.AddWithValue("$k", kind);
        return cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        try { Flush(); } catch { /* 停机路径：尽力而为 */ }
        lock (_gate) { _dirty.Clear(); _deleted.Clear(); }
    }
}

/// <summary>对账结果。</summary>
public readonly record struct ReconcileReport(int Added, int Removed, int Existing);
