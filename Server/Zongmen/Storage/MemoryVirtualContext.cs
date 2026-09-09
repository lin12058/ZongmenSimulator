namespace Zongmen.Storage;

/// <summary>纯内存 KV (进程内缓存层)。
/// P8: 固定容量淘汰 —— 长期漫游不无限增长; 淘汰仅损失命中率(数据可确定性重建), 不影响正确性。
/// T8: 淘汰序由「插入序 FIFO」改为「访问序 LRU」—— 相机具有空间局部性,
///     命中即把 key 移到队尾, 视野内热区 chunk 不再被远处新访问条目挤掉。
///     实现为 lock + Dictionary + 双向链表 (容量 8192, 单次操作微秒级, 无争用风险)。</summary>
public sealed class MemoryVirtualContext : VirtualContext
{
    private readonly object _lock = new();
    private readonly Dictionary<string, (byte[] Value, LinkedListNode<string> Node)> _map = new();
    private readonly LinkedList<string> _lru = new();   // First = 最旧
    private readonly int _cap;

    public MemoryVirtualContext(int capacity = 8192)
    {
        _cap = capacity > 0 ? capacity : int.MaxValue;
    }

    public override byte[]? GetDataBytes(string key)
    {
        lock (_lock)
        {
            if (!_map.TryGetValue(key, out var e)) return null;
            _lru.Remove(e.Node);
            _lru.AddLast(e.Node);            // 命中 → 最近使用
            return e.Value;
        }
    }

    public override void SetData(string key, byte[]? value)
    {
        lock (_lock)
        {
            if (value == null)
            {
                if (_map.TryGetValue(key, out var e))
                {
                    _lru.Remove(e.Node);
                    _map.Remove(key);
                }
                return;
            }
            if (_map.TryGetValue(key, out var ex))
            {
                _map[key] = (value, ex.Node);
                _lru.Remove(ex.Node);
                _lru.AddLast(ex.Node);
                return;
            }
            var node = new LinkedListNode<string>(key);
            _map[key] = (value, node);
            _lru.AddLast(node);
            while (_map.Count > _cap)
            {
                var oldest = _lru.First!;
                _map.Remove(oldest.Value);
                _lru.RemoveFirst();
            }
        }
    }

    public override void DeleteByKey(string key)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var e))
            {
                _lru.Remove(e.Node);
                _map.Remove(key);
            }
        }
    }

    public override long Count() { lock (_lock) return _map.Count; }

    public override void Dispose() { }
}
