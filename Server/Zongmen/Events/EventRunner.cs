using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Zongmen.Engine;
using Zongmen.Subsystems.City;
using Zongmen.Time;

namespace Zongmen.Events;

/* ============================================================
 * 事件执行层 —— 到期 → 调脚本 → **对比前后状态** → 写 History
 * ------------------------------------------------------------
 * 用户原话：「调用脚本后对比前后状态，给出状态的改变写入 history」。
 * 这条要求带来一个**白送的幂等性**，值得单独说：
 *
 *   diff 是 `Between(读取前, 脚本算出的后)`，不是「脚本说它改了什么」。
 *   ⇒ 如果同一事件被重放（崩在「状态已写、History 未提交」之间），
 *     脚本会读到**已经被改过的状态**，算出同样的结果，diff 变成空
 *     ⇒ 不会重复扣人口。**重复施加被 diff 本身挡住了。**
 *
 *   ⚠ 前提：脚本必须写成「看到状态已经是目标态就返回原样」（见 city-events.js 的
 *     `if (s.state === 3) return null;`）。若脚本写成 `pop *= 0.9` 这种无条件乘，
 *     重放就会扣两次 —— 责任在脚本，不在本类。
 *
 * ★ 两阶段（调研结论第 2 条）
 *   ① 收集：`heap.AdvanceTo(nowTick)` 一次性取出全部到期事件并吊销
 *   ② 执行：按 `(EntityId, EventKey)` 顺序逐个跑，**顺序与线程调度无关**
 *   绝不允许「执行 A 时立即触发 B 并当场执行」—— 那会让结果依赖遍历顺序，
 *   两台机器跑出不同世界，回放必然分歧。B 只能进①的下一次收集。
 *
 * ★ 与 TickJob 的关系
 *   同一 tick 内**先跑 job（城市演化）再跑事件** —— 事件要看到本 tick 演化后的状态。
 *   由 TickPump 的 <c>RunEventsHook</c> 在 `RunOneTick` 末尾调用。
 * ============================================================ */
public sealed class EventRunner
{
    private readonly MapWorldServiceAccessor _world;
    private readonly CityStateStore _city;
    private readonly EntityRegistry _entities;
    private readonly EventStore _store;
    private readonly EventHeap _heap;
    private readonly TickOptions _opt;
    private readonly ILogger _log;

    /// <summary>单次收集最多执行多少条（预算外的硬闸：脚本 bug 派生风暴时不许拖死 tick）。</summary>
    public int MaxPerTick { get; set; } = 256;

    /// <summary>单条事件允许派生多少个子事件（防脚本写错无限分裂）。</summary>
    public int MaxSpawnPerRun { get; set; } = 8;

    private long _runs, _failures, _spawned, _emptyDiffs, _skipped;

    public EventRunner(MapWorldServiceAccessor world, CityStateStore city, EntityRegistry entities,
                       EventStore store, TickOptions opt, ILogger log)
    {
        _world = world;
        _city = city;
        _entities = entities;
        _store = store;
        _opt = opt;
        _log = log;
        _heap = new EventHeap();
    }

    public EventHeap Queue => _heap;
    public long Runs => Interlocked.Read(ref _runs);
    public long Failures => Interlocked.Read(ref _failures);
    public long Spawned => Interlocked.Read(ref _spawned);
    /// <summary>diff 为空（事件跑了但状态没变）的次数 —— 判据用它确认「对比」真的在工作。</summary>
    public long EmptyDiffs => Interlocked.Read(ref _emptyDiffs);
    public long Skipped => Interlocked.Read(ref _skipped);

    /// <summary>★ 最小待触发 tick（`schedule_lag` 的分子）。空堆给 long.MaxValue。</summary>
    public long NextDueTick => _heap.NextDueTick;

    /// <summary>调度滞后 = 当前 tick - 最小待触发 tick。&gt;0 说明在追帧。
    /// ⚠ 监控看这个，不看队列长度 —— 队列 10 万条可能只是「未来一年的任务」。</summary>
    public long LagOf(long nowTick)
    {
        var next = _heap.NextDueTick;
        return next == long.MaxValue ? 0 : Math.Max(0, nowTick - next);
    }

    // ══ 世界绑定 ═══════════════════════════════════════════════════════

    /// <summary>载入本世事件并回灌进堆。⚠ 必须在 TickPump.BindWorld 之后调（要 round）。</summary>
    public int BindWorld(int round)
    {
        _heap.Clear();
        if (round <= 0) return 0;       // -1 / 0 = 解绑（TickPump.UnbindWorld 传 -1）
        var jobs = _store.LoadAll(round);
        var n = _heap.PushRange(jobs);
        if (_store.Skipped > 0)
            _log.LogWarning("[event] round={Round} 载入跳过 {Skipped} 行（(script,fn) 未登记，属脏数据）",
                round, _store.Skipped);
        _log.LogInformation("[event] round={Round} 载入事件 {N} 条（库中 {Rows} 行历史）",
            round, n, _store.HistoryRows);
        return n;
    }

    public void UnbindWorld() => _heap.Clear();

    // ══ 投递（业务代码 / 脚本派生的唯一入口）═══════════════════════════

    /// <summary>
    /// 挂一个事件。
    /// <param name="eventKey">-1 = 自动分配新槽；≥0 = 覆盖该槽。
    ///   同一实体同一 fn 已有事件时**改期而不新增**（防脚本每次触发都派生一条，无限膨胀）。</param>
    /// </summary>
    public EventJob Schedule(int round, int entityId, EventScript script, byte fn,
                             long atTick, int periodTicks = 0, int eventKey = -1, long nowTick = 0)
    {
        if (!EventScriptRegistry.IsRegistered(script, fn))
            throw new InvalidOperationException($"未登记的事件脚本 {script}#{fn}（拒绝投递）");
        if (entityId <= 0)
            throw new ArgumentOutOfRangeException(nameof(entityId), "实体号必须 > 0（0 是「无实体」）");

        /* 同 (entity, fn) 已在堆里 ⇒ 改期复用，不新增槽。
           ⚠ 这条是「脚本派生风暴」的唯一护栏：脚本 bug 每次触发都 spawn 同一个 fn，
             没有它就会每 tick 多一条，一天下来几万条。 */
        var existing = FindByFn(round, entityId, fn);
        if (existing != null)
        {
            existing.NextTick = atTick;
            if (periodTicks > 0) existing.PeriodTicks = periodTicks;
            existing.FailCount = 0;
            existing.Enabled = true;
            _heap.Reprioritize(existing.Ref, atTick);
            _store.Upsert(existing);
            return existing;
        }

        var key = eventKey >= 0 ? eventKey : NextEventKey(round, entityId);
        var job = new EventJob
        {
            Round = round,
            EntityId = entityId,
            EventKey = key,
            Script = script,
            Fn = fn,
            NextTick = atTick,
            PeriodTicks = periodTicks,
            Phase = nowTick > 0 ? Math.Abs(atTick - nowTick) % Math.Max(1, periodTicks) : 0,
            CreatedTick = nowTick,
            Enabled = true,
        };
        _heap.Push(job);
        _store.Upsert(job);
        return job;
    }

    public bool Cancel(int round, int entityId, int eventKey)
    {
        var key = new EventRef(round, entityId, eventKey);
        _heap.TryRemove(key, out _);
        return _store.Delete(key);
    }

    public int CancelByFn(int round, int entityId, byte fn)
    {
        var n = 0;
        foreach (var j in _heap.Snapshot())
        {
            if (j.Round != round || j.EntityId != entityId || j.Fn != fn) continue;
            if (Cancel(round, entityId, j.EventKey)) n++;
        }
        return n;
    }

    /// <summary>同实体同 fn 的现存事件（含堆内与库内）。**库也要查** ——
    /// 事件可能已被别的进程/上一次启动写进库但还没进本进程的堆（重启窗口）。</summary>
    private EventJob? FindByFn(int round, int entityId, byte fn)
    {
        foreach (var j in _heap.Snapshot())
            if (j.Round == round && j.EntityId == entityId && j.Fn == fn) return j;
        return null;
    }

    private int NextEventKey(int round, int entityId)
    {
        var max = -1;
        foreach (var j in _heap.Snapshot())
            if (j.Round == round && j.EntityId == entityId && j.EventKey > max) max = j.EventKey;
        return max + 1;
    }

    // ══ ★ 主入口：跑本 tick 到期的事件 ═════════════════════════════════

    public int RunDue(string seed, int round, long nowTick, CancellationToken ct = default)
    {
        if (string.IsNullOrEmpty(seed)) return 0;

        var due = _heap.AdvanceTo(nowTick);
        if (due.Count == 0) return 0;

        if (due.Count > MaxPerTick)
        {
            /* 超量说明有脚本在派生风暴。把溢出的部分顺延 1 tick（不是丢弃），并告警。
               ⚠ 绝不静默截断 —— 截断 = 那些城的事件永久不触发，而且没人知道。 */
            _log.LogWarning("[event] tick={Tick} 到期 {N} 条 > 上限 {Max}，溢出部分顺延",
                nowTick, due.Count, MaxPerTick);
            for (var i = MaxPerTick; i < due.Count; i++)
                _heap.Reprioritize(due[i].Ref, nowTick + 1);
            due.RemoveRange(MaxPerTick, due.Count - MaxPerTick);
        }

        var handled = new HashSet<EventRef>();
        var dirty = new HashSet<(int I, int J)>();
        var t0 = Stopwatch.GetTimestamp();

        using (var lease = _world.LeaseScope(CityModule.CityScope, seed))
        {
            var vm = lease.Vm;
            foreach (var ev in due)
            {
                if (ct.IsCancellationRequested) break;

                /* 预算闸：事件与 job 共用 TickBudgetMs。超了就顺延剩余（下面兜底会 re-arm）。 */
                var elapsedMs = (Stopwatch.GetTimestamp() - t0) * 1000.0 / Stopwatch.Frequency;
                if (elapsedMs > _opt.TickBudgetMs)
                {
                    _log.LogWarning("[event] tick={Tick} 超预算 {Elapsed:F1}ms > {Budget}ms，剩余顺延",
                        nowTick, elapsedMs, _opt.TickBudgetMs);
                    break;
                }

                try
                {
                    ExecuteOne(vm, ev, round, nowTick, dirty);
                    handled.Add(ev.Ref);
                }
                catch (Exception ex)
                {
                    handled.Add(ev.Ref);
                    FailOne(ev, nowTick, ex);
                }
            }
        }

        /* ★★ 兜底（与 TickPump.DeferUnapplied 同一纪律）：
           AdvanceTo 是「收集即吊销」⇒ 任何「收集了但没跑」的事件会永久沉在堆底、
           再也不触发，而且库里那行还在（对账也救不回）。 */
        var deferred = 0;
        foreach (var ev in due)
        {
            if (handled.Contains(ev.Ref)) continue;
            if (_heap.Reprioritize(ev.Ref, nowTick + 1)) deferred++;
        }
        if (deferred > 0)
            _log.LogWarning("[event] tick={Tick} 顺延 {N} 条未执行事件（预算/停机），下个 tick 继续",
                nowTick, deferred);

        /* 派生层通知：事件改了人口/等级 ⇒ 客户端拿到的 settle 包必须换 rev，
           否则带旧 lastRevs 重拉会被判「未变化」⇒ 画面永远停在旧值（不报错）。 */
        if (dirty.Count > 0)
        {
            foreach (var (i, j) in dirty) _world.MarkSettleDirty(seed, i, j);
        }

        return handled.Count;
    }

    /* ============================================================
     * 单条事件
     * ============================================================ */
    private void ExecuteOne(JsVm vm, EventJob ev, int round, long nowTick, HashSet<(int, int)> dirty)
    {
        var name = _entities.NameOf(ev.EntityId);
        if (name == null)
        {
            /* 事件挂了一个不存在的实体 ⇒ 数据被外部改坏了。
               ⚠ 立即停用 + 删行：不然它每 tick 重试一次，日志刷屏且永远失败。 */
            Stop(ev, $"[event] 实体号 {ev.EntityId} 不在 Entity 表（数据损坏），事件已停用并删除");
            Interlocked.Increment(ref _skipped);
            return;
        }

        var before = _city.Get(round, name);
        if (before == null)
        {
            /* 台账还没这一行 ⇒ 城市演化本 tick 还没跑到它。
               抛出去让 FailOne 退避重试（不是停用 —— 下一季演化就会建行）。 */
            throw new InvalidOperationException($"CityState 缺 {name} 的行（演化尚未初始化）");
        }

        var stateJson = CityStateStore.ToEngineJson(before);
        var ctxJson = BuildCtx(ev, nowTick);

        var outJson = vm.Call("eventScriptJson", (int)ev.Script, (int)ev.Fn, stateJson, ctxJson);

        /* 返回约定：
             null                    → 不改状态
             { "state": {...} }      → 新状态（必须是同一实体的 CityState）
             { "spawn": [ {fn,after,period} ] } → 派生后续事件 */
        byte[] diffBlob;
        var newNext = ComputeNext(ev, nowTick);

        if (!string.IsNullOrEmpty(outJson) && outJson != "null")
        {
            using var doc = JsonDocument.Parse(outJson);
            var root = doc.RootElement;

            if (root.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.Object)
            {
                var after = CityStateStore.FromEngineJson(round, st.GetRawText());

                /* ⚠ 身份不可变（红线 R1）：脚本改了 id 就是换了实体，那不是 diff 能表达的。 */
                if (!string.Equals(after.Id, before.Id, StringComparison.Ordinal))
                    throw new InvalidDataException(
                        $"事件脚本改写了实体 id：{before.Id} → {after.Id}（红线 R1：身份是 seed 纯函数结论）");

                var diff = CityDiff.Between(before, after);
                diffBlob = diff.Encode();

                /* ★ 顺序：先 Put 状态，再 CommitRun。
                   反过来的话「History 说有变化、状态没变」⇒ 回放整段错位。
                   而 Put 成功 / CommitRun 失败 ⇒ 事件未推进 ⇒ 下 tick 重跑 ⇒
                   diff 因为 before 已是新状态而变空 ⇒ **不会重复施加**。 */
                if (diff.Count > 0)
                {
                    _city.Put(after);
                    var (ri, rj) = EntityRegistry.SplitRegion(after.Id);
                    dirty.Add((ri, rj));
                }
            }
            else
            {
                diffBlob = Array.Empty<byte>();
            }

            SpawnFrom(root, ev, nowTick);
        }
        else
        {
            diffBlob = Array.Empty<byte>();
        }

        ev.RunCount++;
        ev.FailCount = 0;
        ev.LastRunTick = nowTick;

        var oneShot = ev.IsOneShot;
        if (oneShot) ev.Enabled = false;

        _store.CommitRun(ev, nowTick, diffBlob, newNext, oneShot);

        if (oneShot) _heap.TryRemove(ev.Ref, out _);
        else { ev.NextTick = newNext; _heap.Reprioritize(ev.Ref, newNext); }

        Interlocked.Increment(ref _runs);
        if (diffBlob.Length == 0) Interlocked.Increment(ref _emptyDiffs);

        _log.LogDebug("[event] tick={Tick} {Id}({Name}) {Script} → diff {Bytes}B{OneShot}",
            nowTick, ev.EntityId, name, EventScriptRegistry.NameOf(ev.Script, ev.Fn),
            diffBlob.Length, oneShot ? " [一次性]" : "");
    }

    /// <summary>派生后续事件。⚠ 每条 `after` 至少 1 tick —— `after=0` 会在同一 tick
    /// 再次到期，与「两阶段」冲突（那是同一个 tick 内级联，回放必分歧）。</summary>
    private void SpawnFrom(JsonElement root, EventJob ev, long nowTick)
    {
        if (!root.TryGetProperty("spawn", out var arr) || arr.ValueKind != JsonValueKind.Array) return;

        var n = 0;
        foreach (var item in arr.EnumerateArray())
        {
            if (n >= MaxSpawnPerRun)
            {
                _log.LogWarning("[event] {Ref} 派生超过 {Max} 条，其余丢弃（脚本可能写错了）",
                    ev.Ref, MaxSpawnPerRun);
                break;
            }
            if (item.ValueKind != JsonValueKind.Object) continue;

            var fn = item.TryGetProperty("fn", out var f) && f.ValueKind == JsonValueKind.Number
                ? (byte)f.GetInt32() : (byte)0;
            if (!EventScriptRegistry.IsRegistered(ev.Script, fn))
            {
                _log.LogWarning("[event] {Ref} 派生未登记的函数 {Script}#{Fn}，已忽略",
                    ev.Ref, ev.Script, fn);
                continue;
            }

            var after = item.TryGetProperty("after", out var a) && a.ValueKind == JsonValueKind.Number
                ? a.GetInt64() : 1;
            if (after < 1) after = 1;
            var period = item.TryGetProperty("period", out var p) && p.ValueKind == JsonValueKind.Number
                ? p.GetInt32() : 0;

            Schedule(ev.Round, ev.EntityId, ev.Script, fn, nowTick + after, period, -1, nowTick);
            n++;
            Interlocked.Increment(ref _spawned);
        }
    }

    private void FailOne(EventJob ev, long nowTick, Exception ex)
    {
        ev.FailCount++;
        var disabled = ev.FailCount >= _opt.MaxFails;

        if (disabled)
        {
            ev.Enabled = false;
            _log.LogError(ex, "[event] {Ref} 连续失败 {N} 次已停用：{Script}",
                ev.Ref, ev.FailCount, EventScriptRegistry.NameOf(ev.Script, ev.Fn));
            _heap.TryRemove(ev.Ref, out _);
            ev.NextTick = long.MaxValue;      // 不落一个假的到期时间进库
            _store.MarkFailed(ev);
        }
        else
        {
            ev.NextTick = nowTick + Math.Max(1, _opt.FailBackoffTicks);
            _heap.Reprioritize(ev.Ref, ev.NextTick);
            _log.LogWarning(ex, "[event] {Ref} 失败（{N}/{Max}）：{Script}，退避至 {Next}",
                ev.Ref, ev.FailCount, _opt.MaxFails, EventScriptRegistry.NameOf(ev.Script, ev.Fn), ev.NextTick);
            _store.MarkFailed(ev);
        }
        Interlocked.Increment(ref _failures);
    }

    private void Stop(EventJob ev, string why)
    {
        ev.Enabled = false;
        _log.LogWarning("{Why}", why);
        _heap.TryRemove(ev.Ref, out _);
        _store.Delete(ev.Ref);
    }

    /// <summary>一次性事件 next 无意义；周期事件严格 `DueTick + Period`（用**原**到期 tick，
    /// 不能用被吊销后的哨兵值 —— 那会整数溢出成负数，随机到期）。</summary>
    private static long ComputeNext(EventJob ev, long nowTick)
    {
        if (ev.IsOneShot) return long.MaxValue;
        var due = ev.DueTick == EventHeap.RevokedTick ? nowTick : ev.DueTick;
        var period = Math.Max(1, ev.PeriodTicks);
        var next = due + period;
        /* 追帧：落后太多时不要一次补几十个周期，跳到 now 之后第一位。
           ⚠ 与 TickJobRegistry.NextDue 同口径。 */
        while (next <= nowTick) next += period;
        return next;
    }

    private static string BuildCtx(EventJob ev, long nowTick)
    {
        return $"{{\"tick\":{nowTick},\"entityId\":{ev.EntityId},\"eventKey\":{ev.EventKey}," +
               $"\"script\":{(int)ev.Script},\"fn\":{ev.Fn},\"runCount\":{ev.RunCount}," +
               $"\"period\":{ev.PeriodTicks}}}";
    }

    // ══ 观测 ═══════════════════════════════════════════════════════════

    public object Stats(long nowTick) => new
    {
        pending = _heap.Count,
        nextDue = _heap.NextDueTick == long.MaxValue ? -1 : _heap.NextDueTick,
        lag = LagOf(nowTick),
        pushes = _heap.PushCount,
        pops = _heap.PopCount,
        revoked = _heap.RevokeCount,
        runs = Runs,
        failures = Failures,
        spawned = Spawned,
        emptyDiffs = EmptyDiffs,
        skipped = Skipped,
        historyRows = _store.HistoryRows,
        committed = _store.Committed,
        entities = _entities.Count,
    };
}
