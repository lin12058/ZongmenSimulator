using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace Zongmen.Time;

/// <summary>一次 tick 内某个 kind 的分段耗时累计（诊断聚合的原材料）。</summary>
public struct TickSegment
{
    public int N;
    public double MsGzUnwrap;
    public double MsPbSer;
    public double MsXferIn;
    public double MsJs;
    public double MsXferOut;
    public double MsApply;
    public long BytesIn;
    public long BytesOut;
    public int VmDrops;
}

/// <summary>
/// 分段计时器（设计文档 §8.1）。
///
/// ⚠⚠ 为什么**必须分段**：`t_total` 变大可能是「快照传多了」（`t_pb_ser` + `t_xfer_in`），
///   也可能是「JS 真算多了」（`t_js`）。**只看 `t_total` 会朝错误方向优化**
///   —— 比如去优化 JS 算法，而瓶颈其实是快照膨胀。所以：
///   · 每段独立累计；
///   · 落 `TickPerf` 时按 `(TickFrom, TickTo, Kind)` 聚合成**一行**；
///   · `/stats` 暴露 P50/P95 而**不是平均**（平均值会被 catch-up 那几次异常值掩盖
///     —— 工程既有教训：首测含 JIT，85ms vs 中位 31ms）。
///
/// ★ 另有**每 tick 一行**的事件明细日志（<see cref="LogTick"/>）：
///   格式 `日期: #tick: 总耗时: 事件 耗时: 事件 耗时: other 耗时`。
///   事件来源是 <see cref="Engine.TickTrace"/> 的桶（JS 出口 + 门闩等待），
///   与分段表互补：表说「这一批 job 各段多少」，行说「这个 tick 每一毫秒去哪了」。
/// </summary>
public sealed class TickMetrics
{
    private readonly TickOptions _opt;
    private readonly TickPerfStore _store;
    private readonly ILogger _log;

    private readonly object _gate = new();

    /// <summary>本 tick 的分段（按 kind）。</summary>
    private readonly Dictionary<TickJobKind, TickSegment> _tickSeg = new();

    /// <summary>环形缓冲：最近 N 个 tick 的墙钟总耗时毫秒（用于 P50/P95）。</summary>
    private readonly double[] _ring;
    private int _ringPos;
    private int _ringCount;

    /// <summary>本 tick 墙钟起点（单调毫秒）。</summary>
    private long _tickStartMono;
    private long _tickIndex;

    private long _totalTicks;
    private long _incompleteTicks;

    public TickMetrics(TickOptions opt, TickPerfStore store, ILogger log)
    {
        _opt = opt;
        _store = store;
        _log = log;
        _ring = new double[Math.Max(16, opt.PerfRingCapacity)];
    }

    public long TotalTicks => Interlocked.Read(ref _totalTicks);

    /// <summary>★ 超预算的次数。⚠ 必须上报 —— 它意味着世界在变慢。</summary>
    public long IncompleteTicks => Interlocked.Read(ref _incompleteTicks);

    // ── 分段计时 API（IDisposable 作用域，保证异常路径也落账）──────────

    public Scope BeginGzUnwrap(TickJobKind kind, int bytesIn = 0) => new(this, kind, Seg.GzUnwrap, bytesIn);
    public Scope BeginPbSer(TickJobKind kind, int bytesIn = 0) => new(this, kind, Seg.PbSer, bytesIn);
    public Scope BeginXferIn(TickJobKind kind) => new(this, kind, Seg.XferIn);
    public Scope BeginJs(TickJobKind kind) => new(this, kind, Seg.Js);
    public Scope BeginXferOut(TickJobKind kind, int bytesOut = 0) => new(this, kind, Seg.XferOut, bytesOut);
    public Scope BeginApply(TickJobKind kind) => new(this, kind, Seg.Apply);

    internal enum Seg { GzUnwrap, PbSer, XferIn, Js, XferOut, Apply }

    private void Add(TickJobKind kind, Seg seg, double ms, int bytes)
    {
        lock (_gate)
        {
            if (!_tickSeg.TryGetValue(kind, out var s)) s = new TickSegment();
            s.N++;
            switch (seg)
            {
                case Seg.GzUnwrap: s.MsGzUnwrap += ms; break;
                case Seg.PbSer: s.MsPbSer += ms; break;
                case Seg.XferIn: s.MsXferIn += ms; break;
                case Seg.Js: s.MsJs += ms; break;
                case Seg.XferOut: s.MsXferOut += ms; break;
                case Seg.Apply: s.MsApply += ms; break;
            }
            if (seg is Seg.GzUnwrap or Seg.PbSer) s.BytesIn += bytes;
            if (seg == Seg.XferOut) s.BytesOut += bytes;
            _tickSeg[kind] = s;
        }
    }

    /// <summary>记一次 VM 丢弃（用于判断池是否抖动）。</summary>
    public void CountVmDrop(TickJobKind kind)
    {
        lock (_gate)
        {
            if (!_tickSeg.TryGetValue(kind, out var s)) s = new TickSegment();
            s.VmDrops++;
            _tickSeg[kind] = s;
        }
    }

    /// <summary>为一个 kind 手工累加一次 JS 段耗时（当执行器自己知道时）。</summary>
    public void AddJsMs(TickJobKind kind, double ms)
    {
        lock (_gate)
        {
            if (!_tickSeg.TryGetValue(kind, out var s)) s = new TickSegment();
            s.N++;
            s.MsJs += ms;
            _tickSeg[kind] = s;
        }
    }

    // ── tick 边界 ─────────────────────────────────────────────────────

    public void BeginTick(long tick)
    {
        lock (_gate)
        {
            _tickIndex = tick;
            _tickStartMono = GameClock.NowMonoMs();
            _tickSeg.Clear();
        }

        /* ★ 本 tick 的事件桶。⚠ 必须在这里重置 —— 上一 tick 若有异常没能走到
           EndTick.Take(), 遗留的桶会被 Begin 直接覆盖掉 (不会跨 tick 串账)。 */
        Engine.TickTrace.Begin();
    }

    /// <summary>
    /// 结束本 tick：算总耗时、进环形缓冲、判断是否超预算、按周期聚合落库、
    /// 打一行「本 tick 事件耗时」。
    /// </summary>
    public void EndTick(bool budgetExceeded)
    {
        List<TickPerfRow>? toWrite = null;
        double elapsed;
        long tick;

        lock (_gate)
        {
            elapsed = GameClock.NowMonoMs() - _tickStartMono;
            tick = _tickIndex;
            _ring[_ringPos] = elapsed;
            _ringPos = (_ringPos + 1) % _ring.Length;
            if (_ringCount < _ring.Length) _ringCount++;

            Interlocked.Increment(ref _totalTicks);
            if (budgetExceeded) Interlocked.Increment(ref _incompleteTicks);

            var period = Math.Max(1, _opt.PerfAggregateEveryTicks);
            if (_tickIndex > 0 && _tickIndex % period == 0 && _tickSeg.Count > 0)
            {
                var from = _tickIndex - period + 1;
                toWrite = new List<TickPerfRow>(_tickSeg.Count);
                foreach (var (kind, s) in _tickSeg)
                {
                    toWrite.Add(new TickPerfRow(
                        TickFrom: from, TickTo: _tickIndex,
                        KindCode: KindNames.Code(kind), N: s.N,
                        MsGzUnwrap: s.MsGzUnwrap, MsPbSer: s.MsPbSer,
                        MsXferIn: s.MsXferIn, MsJs: s.MsJs, MsXferOut: s.MsXferOut,
                        MsApply: s.MsApply,
                        BytesIn: s.BytesIn, BytesOut: s.BytesOut, VmDrops: s.VmDrops));
                }
            }
        }

        /* ★ 每 tick 一行事件明细。
           ⚠ 只在**本 tick 真的调过 JS** 时打 —— 空 tick 只有调度开销, 每秒一条纯噪声,
             会把超预算那几行淹掉 (tick 速率是 1/s, 全打就是 3600 行/小时)。 */
        var ev = Engine.TickTrace.Take();
        if (ev is not null) LogTick(tick, elapsed, ev);

        if (toWrite is not null)
        {
            // ⚠ 落库在锁外（临界区里绝不做 I/O）
            try { _store.Write(toWrite); } catch { /* 统计失败不该拖垮时钟 */ }
        }
    }

    /* 单行 JSON —— 程序直接 JSON.parse / jq, 不用切字符串:
         {"ts":"2026-11-26T21:24:19.094","tick":75650,"ms":3.04,"ev":{"citySettlementsJson":1.5,"cityPriceLayerJson":0.4},"other":0.8}
       · ILogger 前缀仍会带「日期 级别 类别」(info: tick[0]) ⇒ 解析时取第一个 '{' 之后的部分。
       · 事件名 = JS 出口名 (与 JsvmModule.Invoke 的 case 同名, 可直接 grep 代码)。
       · 数值单位统一 ms、保留 2 位, 不加 "ms" 后缀 (键名已表达)。
       · `other` = 总耗时 − 已归因 (init 的 49 格 C# 循环 / 落库 / 标脏 / 调度)。
       · `wait` 也出现在 ev 里: 等 V8 门闩的时间 (被别的请求占着, 零计算量)。 */
    private void LogTick(long tick, double elapsedMs, Dictionary<string, long> ev)
    {
        var events = new Dictionary<string, double>(ev.Count, StringComparer.Ordinal);
        long accountedUs = 0;
        foreach (var kv in ev.OrderByDescending(k => k.Value))
        {
            accountedUs += kv.Value;
            events[kv.Key] = Math.Round(kv.Value / 1000.0, 2);
        }

        var other = Math.Round(elapsedMs - accountedUs / 1000.0, 2);
        if (other < 0) other = 0;

        var line = System.Text.Json.JsonSerializer.Serialize(new
        {
            ts = DateTime.Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff"),
            tick,
            ms = Math.Round(elapsedMs, 2),
            ev = events,
            other,
        });

        _log.LogInformation("{Line}", line);
    }

    /// <summary>最近一次 tick 的总耗时（毫秒）。</summary>
    public double LastTickMs
    {
        get
        {
            lock (_gate)
            {
                if (_ringCount == 0) return 0;
                var i = (_ringPos - 1 + _ring.Length) % _ring.Length;
                return _ring[i];
            }
        }
    }

    /// <summary>P50（毫秒）。⚠ 与 P95 都用「排序后取分位」，不用平均。</summary>
    public double P50Ms => Percentile(0.50);
    public double P95Ms => Percentile(0.95);

    private double Percentile(double q)
    {
        double[] copy;
        int n;
        lock (_gate)
        {
            n = _ringCount;
            if (n == 0) return 0;
            copy = _ring.Take(n).ToArray();
        }
        Array.Sort(copy);
        var idx = (int)Math.Clamp(Math.Round((n - 1) * q), 0, n - 1);
        return copy[idx];
    }

    /// <summary>JS 段占总耗时的比例 —— 「该不该优化 JS」的直接依据。</summary>
    public double JsMsShare
    {
        get
        {
            lock (_gate)
            {
                double js = 0, all = 0;
                foreach (var s in _tickSeg.Values)
                {
                    js += s.MsJs;
                    all += s.MsGzUnwrap + s.MsPbSer + s.MsXferIn + s.MsJs + s.MsXferOut + s.MsApply;
                }
                return all <= 0 ? 0 : js / all;
            }
        }
    }

    /// <summary>本 tick 的跨堆拷贝量（bytes）。</summary>
    public (long In, long Out) CurrentBytes
    {
        get
        {
            lock (_gate)
            {
                long i = 0, o = 0;
                foreach (var s in _tickSeg.Values) { i += s.BytesIn; o += s.BytesOut; }
                return (i, o);
            }
        }
    }

    private string? _pendingSeed;

    /// <summary>设置落库用的 seed（每世一次）。</summary>
    public void SetSeed(string seed)
    {
        lock (_gate) _pendingSeed = seed;
    }

    /// <summary>/stats 快照（对齐现有 `StatsJson` 风格：扁平 camelCase）。</summary>
    public object Snapshot() => new
    {
        totalTicks = TotalTicks,
        incompleteTicks = IncompleteTicks,
        tickMsLast = Math.Round(LastTickMs, 3),
        tickMsP50 = Math.Round(P50Ms, 3),
        tickMsP95 = Math.Round(P95Ms, 3),
        jsMsShare = Math.Round(JsMsShare, 4),
        bytesIn = CurrentBytes.In,
        bytesOut = CurrentBytes.Out,
    };

    /// <summary>分段计时作用域。<c>using</c> 保证异常路径也能落账。</summary>
    public readonly struct Scope : IDisposable
    {
        private readonly TickMetrics _m;
        private readonly TickJobKind _kind;
        private readonly Seg _seg;
        private readonly int _bytes;
        private readonly long _t0;

        internal Scope(TickMetrics m, TickJobKind kind, Seg seg, int bytes = 0)
        {
            _m = m; _kind = kind; _seg = seg; _bytes = bytes;
            _t0 = Stopwatch.GetTimestamp();
        }

        public void Dispose()
        {
            var ms = (Stopwatch.GetTimestamp() - _t0) * 1000.0 / Stopwatch.Frequency;
            _m.Add(_kind, _seg, ms, _bytes);
        }
    }
}
