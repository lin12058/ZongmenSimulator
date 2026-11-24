using Microsoft.Data.Sqlite;

namespace Zongmen.Time;

/// <summary>某一世的时钟存档。</summary>
public sealed record WorldClockRow(string Seed, int Round, long Tick, long BornMonoMs, long LastSaveUnixMs);

/// <summary>
/// 世界时钟的持久化（**独立表 `WorldClock`**）。
///
/// ⚠⚠ 为什么必须独立成表，而不是塞 `Data(Key,Value)`：
///   `MapWorldService` 的后台维护任务会调 `SqliteVirtualContext.PruneExcept(活跃 seed 前缀)`，
///   那条 DELETE 的语义是「删掉所有 Key 不匹配 `w:&lt;16位&gt;:*` 的行」——
///   时钟行会被**静默删掉**：世界「忘了自己第几天」，重启后从第 1 年起跳。
///   分表后清理任务完全够不着本表。这与 `WorldLedger` / `PlayerSectStore` 是同一个理由。
///
/// ⚠ 本类是**同步短连接**风格（与 `WorldLedger` 一致）：调用频率 = 每 `FlushEveryTicks` 一次
///   （默认 10 秒一次），不值得为它引入写队列。
///
/// ⚠ 时钟是**服务端资产**，与种子同级：前端只能读，不许自造（对齐既有「种子绝不回落前端造」）。
/// </summary>
public sealed class WorldClockStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";

    private readonly string? _cs;
    private readonly object _gate = new();
    private readonly Dictionary<string, WorldClockRow> _mem = new(StringComparer.Ordinal);

    /// <summary>单调时基的「出生时刻」。⚠ 用它换算只用于离线判定，不用于追补 tick（见 TickOptions.OfflineCatchUp）。</summary>
    private readonly Dictionary<string, long> _bornMono = new(StringComparer.Ordinal);

    public bool Persisted => _cs != null;

    public WorldClockStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS WorldClock (
                Seed         TEXT    NOT NULL,
                Round        INTEGER NOT NULL,
                Tick         INTEGER NOT NULL,
                BornMonoMs   INTEGER NOT NULL,
                LastSaveUnixMs INTEGER NOT NULL,
                PRIMARY KEY (Seed, Round)
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

    /// <summary>
    /// 取某世的时钟。没有就**就地创建**（首次进入本世），种子照抄调用方给的（种子台账是唯一来源）。
    /// </summary>
    public WorldClockRow GetOrCreate(string seed, int round, long initialTick)
    {
        lock (_gate)
        {
            var key = Key(seed, round);
            if (_mem.TryGetValue(key, out var row)) return row;

            var now = GameClock.NowMonoMs();
            var fresh = new WorldClockRow(
                Seed: seed,
                Round: round,
                Tick: initialTick,
                BornMonoMs: now,
                LastSaveUnixMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            if (_cs != null)
            {
                using var c = Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = """
                    INSERT OR IGNORE INTO WorldClock(Seed, Round, Tick, BornMonoMs, LastSaveUnixMs)
                    VALUES($s, $r, $t, $b, $u);
                    """;
                cmd.Parameters.AddWithValue("$s", seed);
                cmd.Parameters.AddWithValue("$r", round);
                cmd.Parameters.AddWithValue("$t", fresh.Tick);
                cmd.Parameters.AddWithValue("$b", fresh.BornMonoMs);
                cmd.Parameters.AddWithValue("$u", fresh.LastSaveUnixMs);
                cmd.ExecuteNonQuery();

                // ⚠ 可能存在并发/前次进程已写入的行 ⇒ 读回真值，绝不假设 fresh 是权威
                row = ReadRow(c, seed, round) ?? fresh;
            }
            else
            {
                row = fresh;
            }

            _mem[key] = row;
            _bornMono[key] = row.BornMonoMs;
            return row;
        }
    }

    public WorldClockRow? Find(string seed, int round)
    {
        lock (_gate)
        {
            var key = Key(seed, round);
            if (_mem.TryGetValue(key, out var row)) return row;
            if (_cs == null) return null;
            using var c = Open();
            var r = ReadRow(c, seed, round);
            if (r != null) { _mem[key] = r; _bornMono[key] = r.BornMonoMs; }
            return r;
        }
    }

    /// <summary>
    /// 落库（UPSERT）。⚠ 每 tick 都调会写放大 ⇒ 由 `TickPump` 按 `FlushEveryTicks` 节流，
    /// 且**换世 / 关机时必须强制 flush**（挂 `ApplicationStopping`）。
    /// </summary>
    public void Save(string seed, int round, long tick)
    {
        lock (_gate)
        {
            var key = Key(seed, round);
            if (!_mem.TryGetValue(key, out var row))
            {
                var nowMono = GameClock.NowMonoMs();
                row = new WorldClockRow(seed, round, tick, nowMono, 0);
            }

            var born = _bornMono.TryGetValue(key, out var b) ? b : row.BornMonoMs;
            var stamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _mem[key] = row with { Tick = tick, BornMonoMs = born, LastSaveUnixMs = stamp };
            _bornMono[key] = born;

            if (_cs == null) return;
            using var c = Open();
            using var cmd = c.CreateCommand();
            cmd.CommandText = """
                INSERT INTO WorldClock(Seed, Round, Tick, BornMonoMs, LastSaveUnixMs)
                VALUES($s, $r, $t, $b, $u)
                ON CONFLICT(Seed, Round) DO UPDATE SET
                    Tick = excluded.Tick,
                    LastSaveUnixMs = excluded.LastSaveUnixMs;
                """;
            cmd.Parameters.AddWithValue("$s", seed);
            cmd.Parameters.AddWithValue("$r", round);
            cmd.Parameters.AddWithValue("$t", tick);
            cmd.Parameters.AddWithValue("$b", born);
            cmd.Parameters.AddWithValue("$u", stamp);
            cmd.ExecuteNonQuery();
        }
    }

    private static WorldClockRow? ReadRow(SqliteConnection c, string seed, int round)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            SELECT Seed, Round, Tick, BornMonoMs, LastSaveUnixMs
            FROM WorldClock WHERE Seed=$s AND Round=$r;
            """;
        cmd.Parameters.AddWithValue("$s", seed);
        cmd.Parameters.AddWithValue("$r", round);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return new WorldClockRow(r.GetString(0), r.GetInt32(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4));
    }

    /// <summary>删掉除给定 seed 之外的所有行（维护任务用）。⚠ 与 `PruneExcept` 不同：本表**独立**，需要自己裁剪。</summary>
    public int PruneExcept(string? keepSeed)
    {
        lock (_gate)
        {
            var removed = 0;
            if (_cs != null)
            {
                using var c = Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = keepSeed is null
                    ? "DELETE FROM WorldClock;"
                    : "DELETE FROM WorldClock WHERE Seed<>$s;";
                if (keepSeed is not null) cmd.Parameters.AddWithValue("$s", keepSeed);
                removed = cmd.ExecuteNonQuery();
            }
            var keys = _mem.Keys.ToList();
            foreach (var k in keys)
            {
                if (keepSeed is not null && !k.StartsWith(keepSeed + "|", StringComparison.Ordinal)) continue;
                if (keepSeed is null || !_mem[k].Seed.Equals(keepSeed, StringComparison.Ordinal))
                {
                    _mem.Remove(k); _bornMono.Remove(k);
                }
            }
            return removed;
        }
    }

    private static string Key(string seed, int round) => $"{seed}|{round}";

    public void Dispose()
    {
        lock (_gate) { _mem.Clear(); _bornMono.Clear(); }
    }
}
