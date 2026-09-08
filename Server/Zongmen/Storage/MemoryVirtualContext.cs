using System.Collections.Concurrent;

namespace Zongmen.Storage;

/// <summary>纯内存 KV (进程内缓存层)。
/// P8: 固定容量 + 插入序近似 FIFO 淘汰 —— 超限时淘汰最旧入队项, 长期漫游不无限增长;
///     淘汰仅损失命中率(数据可确定性重建), 不影响正确性。</summary>
public sealed class MemoryVirtualContext : VirtualContext
{
    private readonly ConcurrentDictionary<string, byte[]> _map = new();
    private readonly ConcurrentQueue<string> _order = new();
    private readonly int _cap;

    public MemoryVirtualContext(int capacity = 8192)
    {
        _cap = capacity > 0 ? capacity : int.MaxValue;
    }

    public override byte[]? GetDataBytes(string key)
        => _map.TryGetValue(key, out var v) ? v : null;

    public override void SetData(string key, byte[]? value)
    {
        if (value == null) { _map.TryRemove(key, out _); return; }
        if (_map.TryAdd(key, value))
        {
            _order.Enqueue(key);
            EvictIfOver();
        }
        else
        {
            _map[key] = value;          // 已存在: 仅更新值, 不改变淘汰序
        }
    }

    private void EvictIfOver()
    {
        while (_map.Count > _cap && _order.TryDequeue(out var k))
        {
            _map.TryRemove(k, out _);   // 队列里可能残留已被删的 key, TryRemove 失败无害
        }
    }

    public override void DeleteByKey(string key) => _map.TryRemove(key, out _);

    public override long Count() => _map.Count;

    public override void Dispose() { }
}
