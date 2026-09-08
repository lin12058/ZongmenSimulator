using Microsoft.Data.Sqlite;

namespace Zongmen.Storage;

/// <summary>
/// SQLite 持久化 KV。表 Data(Key TEXT PRIMARY KEY, Value BLOB),
/// Value 存 gzip(protobuf)。单连接 + 全局锁串行化(与参考实现一致)。
/// </summary>
public sealed class SqliteVirtualContext : VirtualContext
{
    private readonly SqliteConnection _conn;
    private readonly object _gate = new();

    public SqliteVirtualContext(string dbPath)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _conn = new SqliteConnection($"Data Source={dbPath}");
        _conn.Open();
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS Data (
                Key TEXT PRIMARY KEY,
                Value BLOB NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    private SqliteCommand Cmd(string sql, Action<SqliteCommand> bind)
    {
        var c = _conn.CreateCommand();
        c.CommandText = sql;
        bind(c);
        return c;
    }

    public override byte[]? GetDataBytes(string key)
    {
        lock (_gate)
        {
            using var c = Cmd("SELECT Value FROM Data WHERE Key=$k;",
                x => x.Parameters.AddWithValue("$k", key));
            using var r = c.ExecuteReader();
            if (!r.Read()) return null;
            return (byte[])r.GetValue(0);
        }
    }

    public override void SetData(string key, byte[]? value)
    {
        lock (_gate)
        {
            using var c = Cmd(
                "INSERT INTO Data(Key, Value) VALUES($k, $v) " +
                "ON CONFLICT(Key) DO UPDATE SET Value=$v;",
                x =>
                {
                    x.Parameters.AddWithValue("$k", key);
                    x.Parameters.AddWithValue("$v", value ?? Array.Empty<byte>());
                });
            c.ExecuteNonQuery();
        }
    }

    public override void DeleteByKey(string key)
    {
        lock (_gate)
        {
            using var c = Cmd("DELETE FROM Data WHERE Key=$k;",
                x => x.Parameters.AddWithValue("$k", key));
            c.ExecuteNonQuery();
        }
    }

    public override long Count()
    {
        lock (_gate)
        {
            using var c = Cmd("SELECT COUNT(1) FROM Data;", _ => { });
            return (long)(c.ExecuteScalar() ?? 0L);
        }
    }

    public override void Dispose() => _conn.Dispose();
}
