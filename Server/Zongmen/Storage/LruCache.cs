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

    /* P (2026-09-23, 玩家放置): 逐键失效与清空 —— 玩家落点会改「某几个区域格」的
       派生内容 (区域包/足迹包/块归属映射), 必须能把对应条目踢掉。
       原实现只有 Get/Set, 于是落点后只能靠 LRU 自然淘汰 → 旧区域包继续被下发
       (客户端看着"宗门放下去没反应")。 */
    public bool Remove(string key)
    {
        lock (_lock)
        {
            if (!_map.TryGetValue(key, out var e)) return false;
            _order.Remove(e.Node);
            _map.Remove(key);
            return true;
        }
    }

    public void Clear()
    {
        lock (_lock)
        {
            _map.Clear();
            _order.Clear();
        }
    }
}
