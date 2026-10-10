using System.Diagnostics;

namespace Zongmen.Time;

/// <summary>
/// 游戏时钟的**唯一真源**（纯函数，无状态，可单测）。
///
/// 时间模型（钉死，别改）：
///   1 tick      = 游戏内 1 日
///   30 日       = 1 月
///   12 月       = 1 年 = 360 tick
///   90 日(=3月) = 1 季（春 1/2/3 月、夏 4/5/6、秋 7/8/9、冬 10/11/12）
///   墙钟 1 秒   = tick +1   ⇒ 1 游戏年 ≈ 6 分钟真机
///
/// ⚠ 两条铁律：
///   1. 推导**必须纯整数运算**，不掺浮点（浮点累积误差会让 360 天算不到一年）。
///   2. 时基**必须是单调计时器**（Stopwatch / TickCount64），**绝不用 DateTime.UtcNow** ——
///      系统时间跳变（NTP 校正 / 改时区）会让世界瞬移或倒退。
/// </summary>
public static class GameClock
{
    // ── 时间常量（唯一真源）─────────────────────────────────────────────
    public const int TicksPerDay = 1;
    public const int DaysPerMonth = 30;
    public const int MonthsPerYear = 12;
    public const int TicksPerYear = DaysPerMonth * MonthsPerYear;   // 360
    public const int TicksPerSeason = TicksPerYear / 4;             // 90

    /// <summary>墙钟毫秒 ↔ tick 的换算比：1 tick = 1000ms。</summary>
    public const long MsPerTick = 1000;

    /// <summary>季名（索引 = season）。</summary>
    public static readonly string[] SeasonNames = { "春", "夏", "秋", "冬" };

    /// <summary>月名（索引 = month-1）。</summary>
    public static readonly string[] MonthNames =
    {
        "一月", "二月", "三月", "四月", "五月", "六月",
        "七月", "八月", "九月", "十月", "十一月", "十二月"
    };

    // ── tick → 历法 ────────────────────────────────────────────────────

    /// <summary>年（1 起）。</summary>
    public static int YearOf(long tick) => (int)(tick / TicksPerYear) + 1;

    /// <summary>年内的第几天（0..359）。⚠ 这是所有其他推导的基准量。</summary>
    public static int DayOfYear(long tick)
    {
        var d = tick % TicksPerYear;
        if (d < 0) d += TicksPerYear;     // 防御：负 tick 归一化
        return (int)d;
    }

    /// <summary>季（0=春 1=夏 2=秋 3=冬）。</summary>
    public static int SeasonOf(long tick) => DayOfYear(tick) / TicksPerSeason;

    /// <summary>月（1..12）。</summary>
    public static int MonthOf(long tick) => DayOfYear(tick) / DaysPerMonth + 1;

    /// <summary>日（1..30）。</summary>
    public static int DayOfMonth(long tick) => DayOfYear(tick) % DaysPerMonth + 1;

    /// <summary>
    /// 一次拿全（避免调用方多次重算 DayOfYear）。
    /// </summary>
    public static CalDate ToDate(long tick)
    {
        var doy = DayOfYear(tick);
        return new CalDate(
            Year: (int)(tick / TicksPerYear) + 1,
            Month: doy / DaysPerMonth + 1,
            Day: doy % DaysPerMonth + 1,
            Season: doy / TicksPerSeason,
            DayOfYear: doy);
    }

    // ── 历法 → tick（ToDate 的逆，用于判据的自洽穷举）──────────────────

    public static long FromDate(int year, int month, int day)
    {
        if (year < 1) throw new ArgumentOutOfRangeException(nameof(year));
        if (month is < 1 or > MonthsPerYear) throw new ArgumentOutOfRangeException(nameof(month));
        if (day is < 1 or > DaysPerMonth) throw new ArgumentOutOfRangeException(nameof(day));
        return (long)(year - 1) * TicksPerYear
             + (month - 1) * DaysPerMonth
             + (day - 1);
    }

    /// <summary>「第 N 年 春 一月 一日」这类中文描述（仅日志/调试用）。</summary>
    public static string Describe(long tick)
    {
        var d = ToDate(tick);
        return $"第{d.Year}年 {SeasonNames[d.Season]} {MonthNames[d.Month - 1]} {ChineseDay(d.Day)}";
    }

    private static string ChineseDay(int day)
    {
        string[] ones = { "", "一", "二", "三", "四", "五", "六", "七", "八", "九" };
        if (day is >= 1 and <= 9) return ones[day] + "日";
        if (day == 10) return "十日";
        if (day < 20) return "十" + ones[day - 10] + "日";
        if (day == 20) return "二十日";
        if (day < 30) return "二十" + ones[day - 20] + "日";
        return "三十日";
    }

    // ── 墙钟换算（单调时基）─────────────────────────────────────────────

    /// <summary>单调毫秒时基。⚠ 唯一允许的「现在」。</summary>
    public static long NowMonoMs() => Stopwatch.GetTimestamp() * 1000L / Stopwatch.Frequency;

    /// <summary>
    /// 由「出生时刻的单调毫秒 + 出生 tick」推到当前 tick。
    /// ⚠ 只在本框架内部用；真正的权威 tick 由 <see cref="WorldClockStore"/> 持久化，
    /// 重启后**从存档 tick 继续**（不按墙钟差值追补，见 TickOptions.OfflineCatchUp）。
    /// </summary>
    public static long TickAt(long bornMonoMs, long bornTick, long nowMonoMs)
    {
        var elapsed = nowMonoMs - bornMonoMs;
        if (elapsed < 0) elapsed = 0;
        return bornTick + elapsed / MsPerTick;
    }

    /// <summary>
    /// 对齐到「下一个整秒边界」的等待毫秒数。
    /// ⚠ 不要用 Sleep(1000) 累积 —— 每轮的处理耗时会叠加成漂移。
    /// </summary>
    public static int MsToNextSecondBoundary(long nowMonoMs)
    {
        var rem = (int)(nowMonoMs % MsPerTick);
        var wait = (int)(MsPerTick - rem);
        if (wait < 1) wait = 1;
        return wait;
    }

    /// <summary>把任意 tick 对齐到「本季度的第一天」（L1 季级任务的规范锚点）。</summary>
    public static long AlignToSeasonStart(long tick)
    {
        var doy = DayOfYear(tick);
        var baseTick = tick - doy;
        return baseTick + doy / TicksPerSeason * TicksPerSeason;
    }

    /// <summary>把任意 tick 对齐到「本月的第一天」。</summary>
    public static long AlignToMonthStart(long tick)
    {
        var doy = DayOfYear(tick);
        var baseTick = tick - doy;
        return baseTick + doy / DaysPerMonth * DaysPerMonth;
    }

    /// <summary>把任意 tick 对齐到「本年的第一天」。</summary>
    public static long AlignToYearStart(long tick)
    {
        var doy = DayOfYear(tick);
        return tick - doy;
    }
}

/// <summary>历法快照（<see cref="GameClock.ToDate"/> 的返回）。</summary>
public readonly record struct CalDate(int Year, int Month, int Day, int Season, int DayOfYear);
