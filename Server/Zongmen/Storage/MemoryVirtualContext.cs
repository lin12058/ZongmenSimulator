using System.Collections.Concurrent;

namespace Zongmen.Storage;

/// <summary>纯内存 KV (进程内缓存层, 与参考实现 MemoryContext 一致)。</summary>
public sealed class MemoryVirtualContext : VirtualContext
{
    private readonly ConcurrentDictionary<string, byte[]> _map = new();

    public override byte[]? GetDataBytes(string key)
        => _map.TryGetValue(key, out var v) ? v : null;

    public override void SetData(string key, byte[]? value)
    {
        if (value == null) { _map.TryRemove(key, out _); return; }
        _map[key] = value;
    }

    public override void DeleteByKey(string key) => _map.TryRemove(key, out _);

    public override long Count() => _map.Count;

    public override void Dispose() { }
}
