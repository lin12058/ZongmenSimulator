namespace Zongmen.Events;

/* ============================================================
 * 跨 tick 事件系统 · 类型 / 脚本注册表 / 内存最小堆
 * ------------------------------------------------------------
 * 三层，与 docs/游戏设计/跨tick事件系统-调研.md 的结论一致：
 *   ① 持久层 `EventQueue` 表 —— 每个实体挂哪些事件、下次何时触发（真源）
 *   ② 调度层 本文件的 <see cref="EventHeap"/> —— 只为 O(log n) 取最小 tick（可丢，可重建）
 *   ③ 执行层 `EventRunner` —— 到期 → 调脚本 → 对比前后状态 → 写 History
 *
 * ★ 为什么事件与 `TickJob` **不合并**（尽管机制几乎一样）：
 *   `TickJob` 的 `Kind` 是编译期枚举，执行器是 C# 硬编码 switch —— 装不下「任意脚本」。
 *   而事件的本质是「(script, fn) 两个字节 + 一个状态 JSON」，必须由 JS 侧分派。
 *   强行合并会让 `TickJob` 的主键语义和 `TickJobKind` 都变形，且现有 50 行数据的
 *   演化链路要一起改 —— 收益只有省一张表。所以保持两套表、两套堆，
 *   但**由同一个 tick 泵在同一相位驱动**（见 TickPump.RunOneTick 末尾）。
 *
 * ⚠ 与 `TickJob` 共享的两个纪律（照抄，不是巧合）：
 *   1. **收集即吊销**：`AdvanceTo` 弹出后把 `NextTick` 置哨兵再入堆 ⇒ 调用方必须在
 *      本 tick 内 re-arm（成功推进 / 失败退避 / 顺延），否则事件永久沉底、再也不触发。
 *   2. **只有 apply 成功才推进 `NextTick`**：失败也推进 = 静默跳过事件。
 * ============================================================ */

/// <summary>事件脚本族。⚠ 落库码**显式固定、只增不改**（删了留空号）——
/// 与 `KindNames` 同一个教训：用 `(int)enum` 落库，插一个成员在前头就会让历史行静默错读。</summary>
public enum EventScript : byte
{
    None = 0,
    /// <summary>聚落域：城 / 镇 / 村 的天灾人祸。</summary>
    City = 1,
    /// <summary>人物域（预留；接的时候必须先解决 `c…` 号随 pop 消失的问题）。</summary>
    Character = 2,
    /// <summary>宗门域（预留）。</summary>
    Sect = 3,
}

/// <summary>City 域的脚本函数。⚠ 同样显式固定码。
/// ⚠ 语义约定：每个脚本必须**幂等可重入**（同一事件被重放两次，结果必须一致），
///   因为崩溃点可能落在「脚本已算完、History 未提交」之间。</summary>
public enum CityEventFn : byte
{
    None = 0,
    /// <summary>瘟疫爆发：人口按比例损失 + 进入事件态(state=3)，并派生「结束」事件。</summary>
    Plague = 1,
    /// <summary>瘟疫消退：解除事件态（若人口已恢复）。</summary>
    PlagueEnd = 2,
    /// <summary>丰收：库存一次性增加，人口小幅增长。</summary>
    Boom = 3,
    /// <summary>丰收结束（无状态变更，只用于演示「无变化也留 history」）。</summary>
    BoomEnd = 4,
    /// <summary>火灾：建筑损失 + 人口小幅下降。</summary>
    Fire = 5,
    /// <summary>通用空事件：不改状态，只验链路（判据与「心跳」用）。</summary>
    Tick = 6,
}

/// <summary>
/// 一个「脚本入口」的静态声明 = `(Script, Fn)` 两字节 → JS 函数名。
///
/// ★ 为什么落库存的是两个小整数而不是 `"city-events"` + `"onPlague"`：
///   · 省字节：每行 24B → 2B（100 万条事件差 22MB）
///   · 静态可校验：`verify/check_js_exports.mjs` 能扫到这个白名单；
///     存字符串函数名是**动态调用**，拼错只能在运行期炸「未知 JS 函数」
///   · 热更新不动数据：改名只改注册表，不必迁移历史行
/// </summary>
public sealed record EventScriptDef(
    EventScript Script,
    byte Fn,
    /// <summary>JS 侧函数名（日志 / 诊断用；实际调用走统一出口 <c>eventScriptJson</c>）。</summary>
    string JsName,
    string Desc,
    /// <summary>该脚本要借哪把 V8 门闩（= `JsvmModule.Scope`）。</summary>
    string VmScope);

/// <summary>`(Script, Fn)` 双向唯一真源。</summary>
public static class EventScriptRegistry
{
    public static readonly EventScriptDef[] All =
    {
        new(EventScript.City, (byte)CityEventFn.Plague,    "onPlague",    "瘟疫爆发",  "city"),
        new(EventScript.City, (byte)CityEventFn.PlagueEnd, "onPlagueEnd", "瘟疫消退",  "city"),
        new(EventScript.City, (byte)CityEventFn.Boom,      "onBoom",      "丰收",      "city"),
        new(EventScript.City, (byte)CityEventFn.BoomEnd,   "onBoomEnd",   "丰收结束",  "city"),
        new(EventScript.City, (byte)CityEventFn.Fire,      "onFire",      "火灾",      "city"),
        new(EventScript.City, (byte)CityEventFn.Tick,      "onTick",      "空事件",    "city"),
    };

    private static readonly Dictionary<(EventScript, byte), EventScriptDef> Map =
        All.ToDictionary(x => (x.Script, x.Fn));

    public static bool TryFind(EventScript script, byte fn, out EventScriptDef def)
        => Map.TryGetValue((script, fn), out def!);

    /// <summary>落库前校验：未登记的 (script, fn) **必须拒绝**，不许写进库
    /// （写进去就是一个永远不会被认识的僵尸事件，而且要到触发时才发现）。</summary>
    public static bool IsRegistered(EventScript script, byte fn) => Map.ContainsKey((script, fn));

    /// <summary>日志用的全名，如 `city/onPlague`。</summary>
    public static string NameOf(EventScript script, byte fn)
        => Map.TryGetValue((script, fn), out var d) ? $"{script.ToString().ToLowerInvariant()}/{d.JsName}"
                                                    : $"{script}#{fn}(未登记)";
}

/// <summary>事件定位键 = `(Round, EntityId, EventKey)`（与 EventQueue 主键逐列一致）。
/// ⚠ 必须含 **EventKey**：同一实体同一 tick 可能挂多个事件（瘟疫 + 火灾），
///   只用 `(Round, EntityId)` 会让后插入的静默覆盖前一个。</summary>
public readonly record struct EventRef(int Round, int EntityId, int EventKey)
{
    public override string ToString() => $"{Round}/{EntityId}#{EventKey}";
}

/// <summary>内存态事件（EventQueue 表的一行）。</summary>
public sealed class EventJob
{
    public int Round { get; init; }

    /// <summary>★ 全局统一实体 id（<see cref="EntityRegistry"/> 发的 int32，不是引擎字符串）。</summary>
    public int EntityId { get; init; }

    /// <summary>同实体内的序号。0 = 该实体的第一个事件槽。</summary>
    public int EventKey { get; init; }

    public EventScript Script { get; init; }
    public byte Fn { get; init; }

    /// <summary>★ 下次触发的**绝对** tick（不是剩余）。改期 = 赋值。</summary>
    public long NextTick { get; set; }

    /// <summary>0 = 一次性（触发后删除）；&gt;0 = 周期 tick 数。</summary>
    public int PeriodTicks { get; set; }

    /// <summary>相位（周期事件的网格对齐用；一次性为 0）。</summary>
    public long Phase { get; set; }

    public long LastRunTick { get; set; }
    public long CreatedTick { get; init; }
    public int RunCount { get; set; }
    public int FailCount { get; set; }
    public bool Enabled { get; set; } = true;

    // ── 运行时瞬态（不落库）──
    /// <summary>被收集时的**原到期 tick**（合流推进相位要用它，不能用哨兵值）。</summary>
    public long DueTick { get; set; }

    public EventRef Ref => new(Round, EntityId, EventKey);
    public bool IsOneShot => PeriodTicks <= 0;

    public override string ToString()
        => $"{EventScriptRegistry.NameOf(Script, Fn)}({EntityId}#{EventKey}) @{NextTick} p={PeriodTicks}";
}

/// <summary>
/// 事件最小堆（按 <see cref="EventJob.NextTick"/>）。
///
/// 与 `ConcurrentTickQueue` 同构，但**键更小**（`EventRef` 是 3 个 int，无字符串），
/// 所以这里不需要去重策略的复杂分支：同 ref 二次 Push 直接替换。
///
/// ⚠ 唯一必须守住的纪律：`AdvanceTo` 的「弹出 — 记 DueTick — 吊销 — 回插」四步在
///   **同一次持锁内**完成。否则业务线程刚改期，泵线程又按旧键收集一次 ⇒ 同一事件跑两遍。
/// </summary>
public sealed class EventHeap
{
    public const long RevokedTick = long.MaxValue;

    private readonly object _lock = new();
    private readonly List<EventJob> _heap = new(256);
    private readonly Dictionary<EventRef, int> _index = new();

    private long _pushCount, _popCount, _revokeCount;
    private volatile int _countHint;

    public int Count { get { lock (_lock) return _heap.Count; } }
    public int CountHint => _countHint;
    public long PushCount => Interlocked.Read(ref _pushCount);
    public long PopCount => Interlocked.Read(ref _popCount);
    public long RevokeCount => Interlocked.Read(ref _revokeCount);

    /// <summary>★ 最小 tick（空堆给 <see cref="long.MaxValue"/>）。Scheduler 的 `schedule_lag` 靠它。</summary>
    public long NextDueTick { get { lock (_lock) return _heap.Count == 0 ? long.MaxValue : _heap[0].NextTick; } }

    public void Push(EventJob job)
    {
        ArgumentNullException.ThrowIfNull(job);
        lock (_lock)
        {
            var key = job.Ref;
            if (_index.TryGetValue(key, out var existing))
            {
                var old = _heap[existing];
                if (ReferenceEquals(old, job)) SiftDown(SiftUp(existing));
                else { RemoveAt(existing); InsertUnchecked(job); }
            }
            else InsertUnchecked(job);
        }
        Interlocked.Increment(ref _pushCount);
    }

    public int PushRange(IEnumerable<EventJob> jobs)
    {
        var n = 0;
        lock (_lock)
        {
            foreach (var j in jobs)
            {
                if (j is null || !j.Enabled) continue;
                var key = j.Ref;
                if (_index.TryGetValue(key, out var existing)) RemoveAt(existing);
                InsertUnchecked(j);
                n++;
            }
        }
        Interlocked.Add(ref _pushCount, n);
        return n;
    }

    private void InsertUnchecked(EventJob job)
    {
        _heap.Add(job);
        var i = _heap.Count - 1;
        _index[job.Ref] = i;
        SiftUp(i);
        _countHint = _heap.Count;
    }

    private int SiftUp(int i)
    {
        while (i > 0)
        {
            var parent = (i - 1) >> 1;
            if (_heap[parent].NextTick <= _heap[i].NextTick) break;
            Swap(parent, i);
            i = parent;
        }
        return i;
    }

    private int SiftDown(int i)
    {
        var n = _heap.Count;
        while (true)
        {
            var l = (i << 1) + 1;
            var r = l + 1;
            var smallest = i;
            if (l < n && _heap[l].NextTick < _heap[smallest].NextTick) smallest = l;
            if (r < n && _heap[r].NextTick < _heap[smallest].NextTick) smallest = r;
            if (smallest == i) return i;
            Swap(i, smallest);
            i = smallest;
        }
    }

    private void Swap(int a, int b)
    {
        (_heap[a], _heap[b]) = (_heap[b], _heap[a]);
        _index[_heap[a].Ref] = a;
        _index[_heap[b].Ref] = b;
    }

    private void RemoveAt(int i)
    {
        var last = _heap.Count - 1;
        _index.Remove(_heap[i].Ref);
        if (i == last) { _heap.RemoveAt(last); _countHint = _heap.Count; return; }
        _heap[i] = _heap[last];
        _index[_heap[i].Ref] = i;
        _heap.RemoveAt(last);
        _countHint = _heap.Count;
        SiftDown(SiftUp(i));
    }

    /// <summary>
    /// 收集 `NextTick &lt;= nowTick` 的事件，并**立即吊销**（置哨兵后回插）。
    /// ⚠ 返回的列表按 `(EntityId, EventKey)` 排好序 ——
    ///   执行顺序必须与「入堆先后 / 线程调度」无关，否则两台机器跑出不同世界。
    /// ⚠ 调用方必须在本 tick 结束前 re-arm 每一个，否则它永久沉底。
    /// </summary>
    public List<EventJob> AdvanceTo(long nowTick)
    {
        var batch = new List<EventJob>();
        if (_countHint == 0) return batch;

        lock (_lock)
        {
            while (_heap.Count > 0 && _heap[0].NextTick <= nowTick)
            {
                var job = _heap[0];
                RemoveAt(0);
                Interlocked.Increment(ref _popCount);

                job.DueTick = job.NextTick;
                job.NextTick = RevokedTick;
                InsertUnchecked(job);
                Interlocked.Increment(ref _revokeCount);

                batch.Add(job);
            }
        }

        batch.Sort(static (a, b) =>
        {
            var c = a.EntityId.CompareTo(b.EntityId);
            if (c != 0) return c;
            c = a.EventKey.CompareTo(b.EventKey);
            return c != 0 ? c : a.Fn.CompareTo(b.Fn);
        });
        return batch;
    }

    /// <summary>改期（成功推进 / 失败退避）。键已不存在 ⇒ false。</summary>
    public bool Reprioritize(EventRef key, long newNextTick)
    {
        lock (_lock)
        {
            if (!_index.TryGetValue(key, out var i)) return false;
            _heap[i].NextTick = newNextTick;
            SiftDown(SiftUp(i));
            return true;
        }
    }

    /// <summary>移除（一次性事件跑完 / 停用 / 取消）。</summary>
    public bool TryRemove(EventRef key, out EventJob job)
    {
        lock (_lock)
        {
            if (!_index.TryGetValue(key, out var i)) { job = null!; return false; }
            job = _heap[i];
            RemoveAt(i);
            return true;
        }
    }

    public bool Contains(EventRef key) { lock (_lock) return _index.ContainsKey(key); }

    public List<EventJob> Snapshot() { lock (_lock) return _heap.ToList(); }

    public int Clear()
    {
        lock (_lock)
        {
            var n = _heap.Count;
            _heap.Clear();
            _index.Clear();
            _countHint = 0;
            return n;
        }
    }

    /// <summary>不变量自检（判据用）。</summary>
    public (bool Ok, string? Error) Validate()
    {
        lock (_lock)
        {
            if (_index.Count != _heap.Count) return (false, $"index={_index.Count} heap={_heap.Count}");
            for (var i = 0; i < _heap.Count; i++)
            {
                if (!_index.TryGetValue(_heap[i].Ref, out var idx) || idx != i)
                    return (false, $"index mismatch at {i}: {_heap[i].Ref}");
                var l = (i << 1) + 1;
                var r = l + 1;
                if (l < _heap.Count && _heap[l].NextTick < _heap[i].NextTick) return (false, $"heap violation at {i} (left)");
                if (r < _heap.Count && _heap[r].NextTick < _heap[i].NextTick) return (false, $"heap violation at {i} (right)");
            }
            return (true, null);
        }
    }
}
