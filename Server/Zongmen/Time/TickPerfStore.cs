using Microsoft.Data.Sqlite;

namespace Zongmen.Time;

/// <summary>TickPerf 的一行聚合。</summary>
public sealed record TickPerfRow(
    string Seed, long TickFrom, long TickTo, string Kind, int N,
    double MsGzUnwrap, double MsPbSer, double MsXferIn, double MsJs, double MsXferOut, double MsApply,
    long BytesIn, long BytesOut, int VmDrops);

/// <summary>
/// V8 运行期成本统计的持久化（**独立表 `TickPerf`**）。
///
/// ⚠ 独立成表：`PruneExcept` 够不着（同 `WorldClock` / `TickJob`）。
/// ⚠ **逐 tick 全存会写放大** ⇒ 内存环形缓冲（最近 N tick）+ 每 `PerfAggregateEveryTicks`
///   （默认 30）聚合**一行**落库。
///
/// 分段字段（§8.1）—— 缺一段就不知道该往哪优化：
///   t_gz_unwrap 解压（来源是 DB 时） / t_pb_ser 宿主侧快照序列化
///   t_xfer_in WriteBytes / **t_js 纯 JS 计算（唯一「该被优化」的一段）** / t_xfer_out ReadBytes
///   t_apply 合流 apply（含 rev / 失效 / 落库）
/// </summary>
public sealed class TickPerfStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private readonly string? _cs;
    private readonly object _gate = new();
    private long _writtenRows;

    public bool Persisted => _cs != null;
    public long WrittenRows => Interlocked.Read(ref _writtenRows);

    public TickPerfStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS TickPerf (
                Seed     TEXT    NOT NULL,
                TickFrom INTEGER NOT NULL,
                TickTo   INTEGER NOT NULL,
                Kind     TEXT    NOT NULL,
                N        INTEGER NOT NULL,
                MsGz     REAL    NOT NULL DEFAULT 0,
                MsSer    REAL    NOT NULL DEFAULT 0,
                MsXferIn REAL    NOT NULL DEFAULT 0,
                MsJs     REAL    NOT NULL DEFAULT 0,
                MsXferOut REAL   NOT NULL DEFAULT 0,
                MsApply  REAL    NOT NULL DEFAULT 0,
                BytesIn  INTEGER NOT NULL DEFAULT 0,
                BytesOut INTEGER NOT NULL DEFAULT 0,
                VmDrops  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (Seed, TickFrom, TickTo, Kind)
            );
            CREATE INDEX IF NOT EXISTS ix_tickperf_seed_tick
                ON TickPerf (Seed, TickFrom);
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

    /// <summary>批量写入聚合行（一次事务）。</summary>
    public int Write(string seed, IReadOnlyList<TickPerfRow> rows)
    {
        if (rows.Count == 0) return 0;
        if (_cs == null) { Interlocked.Add(ref _writtenRows, rows.Count); return rows.Count; }

        lock (_gate)
        {
            using var c = Open();
            using var tx = c.BeginTransaction();
            using var cmd = c.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO TickPerf(Seed, TickFrom, TickTo, Kind, N,
                                     MsGz, MsSer, MsXferIn, MsJs, MsXferOut, MsApply,
                                     BytesIn, BytesOut, VmDrops)
                VALUES($s, $tf, $tt, $k, $n, $gz, $ser, $xi, $js, $xo, $ap, $bi, $bo, $vd)
                ON CONFLICT(Seed, TickFrom, TickTo, Kind) DO UPDATE SET
                    N=excluded.N, MsGz=excluded.MsGz, MsSer=excluded.MsSer,
                    MsXferIn=excluded.MsXferIn, MsJs=excluded.MsJs,
                    MsXferOut=excluded.MsXferOut, MsApply=excluded.MsApply,
                    BytesIn=excluded.BytesIn, BytesOut=excluded.BytesOut,
                    VmDrops=excluded.VmDrops;
                """;
            var ps = cmd.Parameters;
            var pS = ps.Add("$s", SqliteType.Text);
            var pTf = ps.Add("$tf", SqliteType.Integer);
            var pTt = ps.Add("$tt", SqliteType.Integer);
            var pK = ps.Add("$k", SqliteType.Text);
            var pN = ps.Add("$n", SqliteType.Integer);
            var pGz = ps.Add("$gz", SqliteType.Real);
            var pSer = ps.Add("$ser", SqliteType.Real);
            var pXi = ps.Add("$xi", SqliteType.Real);
            var pJs = ps.Add("$js", SqliteType.Real);
            var pXo = ps.Add("$xo", SqliteType.Real);
            var pAp = ps.Add("$ap", SqliteType.Real);
            var pBi = ps.Add("$bi", SqliteType.Integer);
            var pBo = ps.Add("$bo", SqliteType.Integer);
            var pVd = ps.Add("$vd", SqliteType.Integer);

            foreach (var row in rows)
            {
                pS.Value = row.Seed; pTf.Value = row.TickFrom; pTt.Value = row.TickTo;
                pK.Value = row.Kind; pN.Value = row.N;
                pGz.Value = row.MsGzUnwrap; pSer.Value = row.MsPbSer;
                pXi.Value = row.MsXferIn; pJs.Value = row.MsJs; pXo.Value = row.MsXferOut;
                pAp.Value = row.MsApply;
                pBi.Value = row.BytesIn; pBo.Value = row.BytesOut; pVd.Value = row.VmDrops;
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
            Interlocked.Add(ref _writtenRows, rows.Count);
            return rows.Count;
        }
    }

    /// <summary>最近 N 条（/stats 与诊断用）。</summary>
    public List<TickPerfRow> Recent(string seed, int n)
    {
        var outList = new List<TickPerfRow>();
        if (_cs == null) return outList;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT TickFrom, TickTo, Kind, N, MsGz, MsSer, MsXferIn, MsJs, MsXferOut, MsApply,
                   BytesIn, BytesOut, VmDrops
            FROM TickPerf WHERE Seed=$s ORDER BY TickTo DESC LIMIT $n;
            """;
        cmd.Parameters.AddWithValue("$s", seed);
        cmd.Parameters.AddWithValue("$n", Math.Max(1, n));
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            outList.Add(new TickPerfRow(
                seed, r.GetInt64(0), r.GetInt64(1), r.GetString(2), r.GetInt32(3),
                r.GetDouble(4), r.GetDouble(5), r.GetDouble(6), r.GetDouble(7),
                r.GetDouble(8), r.GetDouble(9),
                r.GetInt64(10), r.GetInt64(11), r.GetInt32(12)));
        }
        return outList;
    }

    /// <summary>裁剪（维护任务用）：只保留最近 <paramref name="keepTicks"/> 个 tick 的行。</summary>
    public int Prune(long currentTick, long keepTicks)
    {
        if (_cs == null) return 0;
        lock (_gate)
        {
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = "DELETE FROM TickPerf WHERE TickTo < $cut;";
            cmd.Parameters.AddWithValue("$cut", currentTick - Math.Max(1, keepTicks));
            return cmd.ExecuteNonQuery();
        }
    }

    public void Dispose() { }
}
