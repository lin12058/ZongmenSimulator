using Microsoft.Data.Sqlite;

namespace Zongmen.Storage;

/// <summary>
/// SQLite 持久化 KV。表 Data(Key TEXT PRIMARY KEY, Value BLOB), Value 存 gzip(protobuf)。
/// P6: 去掉「单连接 + 全局锁串行化」——每次操作使用短连接(池化), 并发读互不阻塞;
///     PRAGMA WAL(库级持久) 使读与写可并行; 批量写(SetDataDeferred)由后台 writer
///     每 ~250ms 事务式落库, 统计/退出前 Flush 排空 → 冷生成不再同步写盘。
/// P8: PruneExcept(seedPrefixes) 只保留活跃 seed 前缀, 清理历史世界缓存行
///     (所有行均可按 seed 确定性重建, 属安全缓存清理)。
/// </summary>
public sealed class SqliteVirtualContext : VirtualContext
{
    private static readonly string CsTemplate = "Data Source={0};Pooling=True";

    private readonly string _cs;
    private readonly object _flushLock = new();
    private readonly System.Collections.Concurrent.ConcurrentQueue<(string Key, byte[] Value)> _pending = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _writer;
    private volatile bool _disposed;

    public SqliteVirtualContext(string dbPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using (var init = Open())
        {
            using var cmd = init.CreateCommand();
            cmd.CommandText = """
                CREATE TABLE IF NOT EXISTS Data (
                    Key TEXT PRIMARY KEY,
                    Value BLOB NOT NULL
                );
                PRAGMA journal_mode=WAL;
                """;
            cmd.ExecuteNonQuery();
        }
        _writer = Task.Run(WriterLoopAsync);
    }

    /* 每操作一个短连接 (池化), 不再共享连接 + lock(_gate) */
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

    public override byte[]? GetDataBytes(string key)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT Value FROM Data WHERE Key=$k;";
        cmd.Parameters.AddWithValue("$k", key);
        using var r = cmd.ExecuteReader();
        if (!r.Read()) return null;
        return (byte[])r.GetValue(0);
    }

    public override void SetData(string key, byte[]? value)
    {
        if (_disposed) return;
        _pending.Enqueue((key, value ?? Array.Empty<byte>()));
    }

    /// <summary>批量异步落库的入队口 (MapWorldService.Store 调用)。</summary>
    public void SetDataDeferred(string key, byte[]? value)
    {
        if (_disposed) return;
        _pending.Enqueue((key, value ?? Array.Empty<byte>()));
    }

    /// <summary>把积压写入一次性事务提交 (统计前 / Dispose 前调用)。</summary>
    public void Flush()
    {
        if (_disposed || _pending.IsEmpty) return;
        var batch = new List<(string Key, byte[] Value)>();
        lock (_flushLock)
        {
            while (_pending.TryDequeue(out var item)) batch.Add(item);
        }
        if (batch.Count == 0) return;
        try
        {
            using var c = Open();
            using var tx = c.BeginTransaction();
            foreach (var (key, val) in batch)
            {
                using var cmd = c.CreateCommand();
                cmd.Transaction = tx;
                cmd.CommandText =
                    "INSERT INTO Data(Key, Value) VALUES($k, $v) " +
                    "ON CONFLICT(Key) DO UPDATE SET Value=$v;";
                cmd.Parameters.AddWithValue("$k", key);
                cmd.Parameters.AddWithValue("$v", val);
                cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
        catch (Exception ex)
        {
            /* 写失败(如瞬时 DB 忙) → 退回队列由下轮 writer 重试, 不阻塞请求路径 */
            lock (_flushLock)
            {
                foreach (var it in batch) _pending.Enqueue(it);
            }
            Console.Error.WriteLine("[SqliteVirtualContext] Flush 失败, 稍后重试: " + ex.Message);
        }
    }

    public override void DeleteByKey(string key)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "DELETE FROM Data WHERE Key=$k;";
        cmd.Parameters.AddWithValue("$k", key);
        cmd.ExecuteNonQuery();
    }

    /// <summary>清理活跃 seed 前缀之外的全部历史行 (seed 前缀形如 "w:0123456789abcdef:")。</summary>
    public long PruneExcept(IReadOnlyCollection<string> seedPrefixes)
    {
        if (seedPrefixes == null || seedPrefixes.Count == 0) return 0;
        var sb = new System.Text.StringBuilder("DELETE FROM Data WHERE NOT (");
        var idx = 0;
        foreach (var p in seedPrefixes)
        {
            if (idx > 0) sb.Append(" OR ");
            sb.Append("Key LIKE $p").Append(idx);
            idx++;
        }
        sb.Append(')');
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = sb.ToString();
        idx = 0;
        foreach (var p in seedPrefixes)
            cmd.Parameters.AddWithValue("$p" + idx++, p + "%");
        return cmd.ExecuteNonQuery();
    }

    public override long Count()
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(1) FROM Data;";
        return (long)(cmd.ExecuteScalar() ?? 0L);
    }

    private async Task WriterLoopAsync()
    {
        try
        {
            while (!_cts.IsCancellationRequested)
            {
                await Task.Delay(250, _cts.Token).ConfigureAwait(false);
                Flush();
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[SqliteVirtualContext] 后台 writer 退出: " + ex.Message);
        }
    }

    public override void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cts.Cancel();
        try { Flush(); } catch { /* 落库尽力而为 */ }
        try { _writer.Wait(2000); } catch { /* 忽略 */ }
        _cts.Dispose();
    }
}
