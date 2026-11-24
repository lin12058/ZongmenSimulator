namespace Zongmen.Time;

/// <summary>
/// 相位派生：把「同一个周期」的一批 job 打散到周期内的不同 tick 上。
///
/// 病在哪：L1 的周期是 30（月）/ 90（季）。若所有 job 的相位都是 0，
/// 那第 30、60、90… 天会有**全部** job 同时到期 ⇒ 峰值决定队列深度与 VM 池大小，
/// 均值不决定任何东西。一个 tick 卡死，其余 29 个 tick 全空转。
///
/// 解法：`Phase = hash(seed | entityId | kind) % PeriodTicks`，
///       首次 `NextTick = 起点 + Phase`，之后**严格** `+= PeriodTicks`。
///
/// ⚠⚠ 三条铁律（漏了都是静默病）：
///   1. **抖相位，不抖周期**。`NextTick += Period` 是常量；一旦写成 `Period ± jitter`
///      周期就被改了 ⇒ 计数判据（`check_tick_lazy`）失效、演化速率漂移。
///   2. **绝不用运行时 RNG**（`Random.Shared` / `Guid.NewGuid()`）。否则重启后相位变，
///      同 seed + 同起 tick 两跑结果不一致 ⇒ 无法定位问题，也违反「世界可确定性重建」。
///   3. **对账时不许重置已有行的 Phase**。每年一次的兜底对账若重置 Phase，
///      会把一个周期内散布的 job 全部推平回同一天 —— 抖动白做。
///
/// ⚠ 相位要**同时掺 seed / entityId / kind**：
///   - 只掺 entityId ⇒ 不同世界负载分布完全相同（无害但掩盖 bug）；
///   - 只掺 kind     ⇒ 同 kind 全部同相位 = 完全没打散。
/// </summary>
public static class PhaseHash
{
    private const uint FnvOffsetBasis = 2166136261u;
    private const uint FnvPrime = 16777619u;

    /// <summary>FNV-1a 32 位（字节流）。</summary>
    public static uint Fnv1a32(ReadOnlySpan<byte> data)
    {
        var h = FnvOffsetBasis;
        foreach (var b in data)
        {
            h ^= b;
            h *= FnvPrime;
        }
        return h;
    }

    /// <summary>FNV-1a 32 位（UTF-8 字符串）。</summary>
    public static uint Fnv1a32(string s)
    {
        var h = FnvOffsetBasis;
        // 手写 UTF-8，避免在热路径上分配 byte[]
        foreach (var ch in s)
        {
            if (ch < 0x80)
            {
                h ^= ch; h *= FnvPrime;
            }
            else if (ch < 0x800)
            {
                h ^= (uint)(0xC0 | (ch >> 6)); h *= FnvPrime;
                h ^= (uint)(0x80 | (ch & 0x3F)); h *= FnvPrime;
            }
            else
            {
                h ^= (uint)(0xE0 | (ch >> 12)); h *= FnvPrime;
                h ^= (uint)(0x80 | ((ch >> 6) & 0x3F)); h *= FnvPrime;
                h ^= (uint)(0x80 | (ch & 0x3F)); h *= FnvPrime;
            }
        }
        return h;
    }

    /// <summary>
    /// mix32（Murmur3 的 finalizer）：把 FNV 的低位雪崩开。
    /// ⚠ 必须做这一步 —— FNV 的**低位**质量差，而 `% PeriodTicks` 只取低位。
    ///   不做雪崩 ⇒ 相邻 entityId 的相位呈等差，桶分布歪斜。
    /// </summary>
    public static uint Mix32(uint h)
    {
        h ^= h >> 16;
        h *= 0x85EBCA6Bu;
        h ^= h >> 13;
        h *= 0xC2B2AE35u;
        h ^= h >> 16;
        return h;
    }

    /// <summary>派生一个 32 位确定性哈希：`seed | entityId | kind`。</summary>
    public static uint Derive(string seed, string entityId, string kind)
    {
        var h = FnvOffsetBasis;

        Accumulate(ref h, seed);
        Accumulate(ref h, 0x1F);          // unit separator，防「a|b」与「ab|」撞
        Accumulate(ref h, entityId);
        Accumulate(ref h, 0x1F);
        Accumulate(ref h, kind);

        return Mix32(h);
    }

    private static void Accumulate(ref uint h, string s)
    {
        foreach (var ch in s)
        {
            if (ch < 0x80) { h ^= ch; h *= FnvPrime; }
            else if (ch < 0x800)
            {
                h ^= (uint)(0xC0 | (ch >> 6)); h *= FnvPrime;
                h ^= (uint)(0x80 | (ch & 0x3F)); h *= FnvPrime;
            }
            else
            {
                h ^= (uint)(0xE0 | (ch >> 12)); h *= FnvPrime;
                h ^= (uint)(0x80 | ((ch >> 6) & 0x3F)); h *= FnvPrime;
                h ^= (uint)(0x80 | (ch & 0x3F)); h *= FnvPrime;
            }
        }
    }

    private static void Accumulate(ref uint h, byte b)
    {
        h ^= b;
        h *= FnvPrime;
    }

    /// <summary>
    /// 相位：`[0, periodTicks)` 内的确定性偏移。
    /// `periodTicks &lt;= 1` ⇒ 恒 0（周期 1 或一次性事件没有「抖动」的空间）。
    /// </summary>
    public static long PhaseOf(string seed, string entityId, string kind, int periodTicks)
    {
        if (periodTicks <= 1) return 0;
        return Derive(seed, entityId, kind) % (uint)periodTicks;
    }

    /// <summary>
    /// 首次到期 tick：在 `fromTick` 之后（含）的第一个「落在相位上」的 tick。
    /// 语义 = 「不早于 fromTick 的第一个相位命中点」。
    /// </summary>
    public static long FirstDueTick(string seed, string entityId, string kind,
                                    int periodTicks, long fromTick)
    {
        if (periodTicks <= 0) return fromTick;    // 一次性事件：立即到期

        var phase = PhaseOf(seed, entityId, kind, periodTicks);
        // 归一化到 period 内的位置
        var pos = fromTick % periodTicks;
        if (pos < 0) pos += periodTicks;

        var delta = (phase - pos + periodTicks) % periodTicks;
        return fromTick + delta;
    }

    /// <summary>
    /// 二次派生：把某个 chunk 内的 job 再摊一层（用于超大批量时的二级分散）。
    /// </summary>
    public static long PhaseOf2(string seed, string entityId, string kind, int slots)
    {
        if (slots <= 1) return 0;
        var h = Derive(seed, entityId, kind) ^ 0x9E3779B9u;
        return Mix32(h) % (uint)slots;
    }
}
