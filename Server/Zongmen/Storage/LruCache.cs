namespace Zongmen.Storage;

/// <summary>
/// 轻量线程安全 LRU 缓存 (T11): 字典 + 双向链表, 命中即移到队尾,
/// 超限只淘汰最旧 1 条 — 替代 ConcurrentDictionary「Take(Cap/4) 全量遍历
/// 批量删」的粗淘汰 (O(n) 且并发取键有竞态)。容量级都很小, 锁开销可忽略。
/// </summary>
public sealed class LruCache<V> where V : class
{
    private readonly object _lock = new();
    private readonly int _cap;
    private readonly Dictionary<string, (V Value, LinkedListNode<string> Node)> _map = new();
    private readonly LinkedList<string> _order = new();   // First = 最旧

    public LruCache(int cap) => _cap = cap > 0 ? cap : 1;

    public V? Get(string key)
    {
        lock (_lock)
        {
            if (!_map.TryGetValue(key, out var e)) return null;
            _order.Remove(e.Node);
            _order.AddLast(e.Node);          // 命中 → 移到队尾 (最近使用)
            return e.Value;
        }
    }

    public void Set(string key, V value)
    {
        lock (_lock)
        {
            if (_map.TryGetValue(key, out var e))
            {
                _map[key] = (value, e.Node);
                _order.Remove(e.Node);
                _order.AddLast(e.Node);
                return;
            }
            var node = new LinkedListNode<string>(key);
            _map[key] = (value, node);
            _order.AddLast(node);
            while (_map.Count > _cap)
            {
                var oldest = _order.First!;
                _map.Remove(oldest.Value);
                _order.RemoveFirst();
            }
        }
    }

    public int Count { get { lock (_lock) return _map.Count; } }
}
