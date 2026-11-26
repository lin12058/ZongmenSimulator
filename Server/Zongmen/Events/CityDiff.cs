using Zongmen.Subsystems.City;

namespace Zongmen.Events;

/* ============================================================
 * CityDiff —— 「调脚本前 vs 调脚本后」的状态差，落 History 表的那一坨 BLOB
 * ------------------------------------------------------------
 * 语义：**每个字段 null = 没变**（一个字节都不写）；有值 = 变成了该值（即使新值是 0）。
 *   这就是用户要的「不存在的值就不会存」。相比存整份 CityStateRow（28 个字段，
 *   大部分每 tick 都不变），一次典型事件只写 2~4 个字段 ⇒ 十几字节。
 *
 * ⚠ 三种「没变」必须分清，写错了回放就会错：
 *   ① 字段没变        ⇒ 不写 tag
 *   ② 字段变成了 0    ⇒ **要写**（tag + zigzag(0)）。如果用「0 当哨兵」，
 *      回放时「人口降到 0」会被当成「人口没变」，永远回不去。
 *   ③ `BasePopF` 从有值变成 null ⇒ 用独立的 `BasePopFCleared=true` 表达
 *      （nullable 的 nullable 在 protobuf 里没有原生表示）。
 *
 * ⚠ field 号**只增不改**：将来加字段就往后排（40、41…），旧 BLOB 靠
 *   <see cref="PbWire.SkipField"/> 跳过，绝不复用已删的号。
 * ============================================================ */
public sealed class CityDiff
{
    // ── 人口 / 等级 / 状态 ──
    public int? Pop;              // 1
    public double? PopF;          // 2
    public int? Tier;             // 3
    public int? State;            // 4

    // ── Δ 铁律累加器 ──
    public long? Age;             // 5
    public double? FoodDebt;      // 6
    public int? PopBase;          // 7
    public double? BasePopF;      // 8  有值 = 变成该值
    public bool BasePopFCleared;  // 9  true = 变成 null
    public long? BaseAge;         // 14 有值 = 变成该值
    public bool BaseAgeCleared;   // 15 true = 变成 null
    public double? BuiltFrac;     // 10
    public double? Kf;            // 11

    // ── 时间 / 版本 ──
    public long? LastEvoTick;     // 12
    public int? Ver;              // 13

    // ── 八资源库存（顺序见 CityStateStore.ResourceOrder，field 20..27）──
    public readonly long?[] Stock = new long?[CityStateStore.ResourceCount];

    // ── 建筑数组 ──
    public string? Built;         // 30

    /// <summary>一个字段都没变 ⇒ History 里存空 BLOB（事件触发过，但没改状态）。</summary>
    public bool IsEmpty
    {
        get
        {
            if (Pop.HasValue || PopF.HasValue || Tier.HasValue || State.HasValue) return false;
            if (Age.HasValue || FoodDebt.HasValue || PopBase.HasValue) return false;
            if (BasePopF.HasValue || BasePopFCleared) return false;
            if (BaseAge.HasValue || BaseAgeCleared) return false;
            if (BuiltFrac.HasValue || Kf.HasValue) return false;
            if (LastEvoTick.HasValue || Ver.HasValue || Built != null) return false;
            for (var i = 0; i < Stock.Length; i++) if (Stock[i].HasValue) return false;
            return true;
        }
    }

    /// <summary>变了的字段个数（诊断 / 判据用）。</summary>
    public int Count
    {
        get
        {
            var n = 0;
            if (Pop.HasValue) n++; if (PopF.HasValue) n++; if (Tier.HasValue) n++; if (State.HasValue) n++;
            if (Age.HasValue) n++; if (FoodDebt.HasValue) n++; if (PopBase.HasValue) n++;
            if (BasePopF.HasValue) n++; if (BasePopFCleared) n++;
            if (BaseAge.HasValue) n++; if (BaseAgeCleared) n++;
            if (BuiltFrac.HasValue) n++; if (Kf.HasValue) n++;
            if (LastEvoTick.HasValue) n++; if (Ver.HasValue) n++; if (Built != null) n++;
            for (var i = 0; i < Stock.Length; i++) if (Stock[i].HasValue) n++;
            return n;
        }
    }

    // ══ 求差 ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 前后对比。⚠ **身份字段（Id / Type / Q / R / Round）不参与 diff** ——
    ///   它们按红线 R1 是 seed 纯函数结论，事件脚本不许改它们；真改了也只是
    ///   「换了一个实体」，那不是 diff 能表达的，应该报错而不是静默记一笔。
    /// </summary>
    public static CityDiff Between(CityStateRow before, CityStateRow after)
    {
        var d = new CityDiff();

        if (before.Pop != after.Pop) d.Pop = after.Pop;
        if (!SameDouble(before.PopF, after.PopF)) d.PopF = after.PopF;
        if (before.Tier != after.Tier) d.Tier = after.Tier;
        if (before.State != after.State) d.State = after.State;

        if (before.Age != after.Age) d.Age = after.Age;
        if (!SameDouble(before.FoodDebt, after.FoodDebt)) d.FoodDebt = after.FoodDebt;
        if (before.PopBase != after.PopBase) d.PopBase = after.PopBase;

        if (before.BasePopF.HasValue != after.BasePopF.HasValue)
        {
            if (after.BasePopF.HasValue) d.BasePopF = after.BasePopF.Value;
            else d.BasePopFCleared = true;
        }
        else if (after.BasePopF.HasValue && !SameDouble(before.BasePopF!.Value, after.BasePopF.Value))
        {
            d.BasePopF = after.BasePopF.Value;
        }

        /* ⚠ BaseAge 与 BasePopF 同一形态（`long?`），**必须有独立的 cleared 标志**：
           直接用 `long?` 表达「变成 null」会与「没变」撞车（都是 null）⇒ 回放时
           K 基期年龄清不掉，Δ 会带着旧 maturity 继续算。 */
        if (before.BaseAge.HasValue != after.BaseAge.HasValue)
        {
            if (after.BaseAge.HasValue) d.BaseAge = after.BaseAge.Value;
            else d.BaseAgeCleared = true;
        }
        else if (after.BaseAge.HasValue && before.BaseAge!.Value != after.BaseAge.Value)
        {
            d.BaseAge = after.BaseAge.Value;
        }

        if (!SameDouble(before.BuiltFrac, after.BuiltFrac)) d.BuiltFrac = after.BuiltFrac;
        if (!SameDouble(before.Kf, after.Kf)) d.Kf = after.Kf;

        if (before.LastEvoTick != after.LastEvoTick) d.LastEvoTick = after.LastEvoTick;
        if (before.Ver != after.Ver) d.Ver = after.Ver;

        var sa = SplitStock(before.Stock);
        var sb = SplitStock(after.Stock);
        for (var i = 0; i < sa.Length; i++) if (sa[i] != sb[i]) d.Stock[i] = sb[i];

        /* ⚠ 建筑数组按**原串**比，不按结构比：演化器会重排 / 重算字段，
           结构相等但串不同意味着「下一个消费者看到的东西变了」，必须记。 */
        if (!string.Equals(before.Built, after.Built, StringComparison.Ordinal))
            d.Built = after.Built;

        return d;
    }

    /// <summary>把 diff 应用到一行上（回放 / 判据用）—— 未涉及的字段保持原值。</summary>
    public void ApplyTo(CityStateRow row)
    {
        if (Pop.HasValue) row.Pop = Pop.Value;
        if (PopF.HasValue) row.PopF = PopF.Value;
        if (Tier.HasValue) row.Tier = Tier.Value;
        if (State.HasValue) row.State = State.Value;

        if (Age.HasValue) row.Age = Age.Value;
        if (FoodDebt.HasValue) row.FoodDebt = FoodDebt.Value;
        if (PopBase.HasValue) row.PopBase = PopBase.Value;
        if (BasePopFCleared) row.BasePopF = null;
        else if (BasePopF.HasValue) row.BasePopF = BasePopF.Value;
        if (BaseAgeCleared) row.BaseAge = null;
        else if (BaseAge.HasValue) row.BaseAge = BaseAge.Value;
        if (BuiltFrac.HasValue) row.BuiltFrac = BuiltFrac.Value;
        if (Kf.HasValue) row.Kf = Kf.Value;

        if (LastEvoTick.HasValue) row.LastEvoTick = LastEvoTick.Value;
        if (Ver.HasValue) row.Ver = Ver.Value;

        var stock = SplitStock(row.Stock);
        var touched = false;
        for (var i = 0; i < Stock.Length; i++)
        {
            if (!Stock[i].HasValue) continue;
            stock[i] = Stock[i]!.Value;
            touched = true;
        }
        if (touched) row.Stock = JoinStock(stock);

        if (Built != null) row.Built = Built;
    }

    // ══ 编解码（标准 protobuf wire format）══════════════════════════════

    public byte[] Encode()
    {
        var o = new List<byte>(64);
        if (Pop.HasValue) PbWire.WriteSInt(o, 1, Pop.Value);
        if (PopF.HasValue) PbWire.WriteDouble(o, 2, PopF.Value);
        if (Tier.HasValue) PbWire.WriteSInt(o, 3, Tier.Value);
        if (State.HasValue) PbWire.WriteSInt(o, 4, State.Value);

        if (Age.HasValue) PbWire.WriteSInt(o, 5, Age.Value);
        if (FoodDebt.HasValue) PbWire.WriteDouble(o, 6, FoodDebt.Value);
        if (PopBase.HasValue) PbWire.WriteSInt(o, 7, PopBase.Value);
        if (BasePopF.HasValue) PbWire.WriteDouble(o, 8, BasePopF.Value);
        if (BasePopFCleared) PbWire.WriteBool(o, 9, true);
        if (BaseAge.HasValue) PbWire.WriteSInt(o, 14, BaseAge.Value);
        if (BaseAgeCleared) PbWire.WriteBool(o, 15, true);
        if (BuiltFrac.HasValue) PbWire.WriteDouble(o, 10, BuiltFrac.Value);
        if (Kf.HasValue) PbWire.WriteDouble(o, 11, Kf.Value);

        if (LastEvoTick.HasValue) PbWire.WriteSInt(o, 12, LastEvoTick.Value);
        if (Ver.HasValue) PbWire.WriteSInt(o, 13, Ver.Value);

        for (var i = 0; i < Stock.Length; i++)
            if (Stock[i].HasValue) PbWire.WriteSInt(o, 20 + i, Stock[i]!.Value);

        if (Built != null) PbWire.WriteString(o, 30, Built);

        return o.ToArray();
    }

    /// <summary>⚠ 空 BLOB（长度 0）= 「事件触发但状态没变」，返回全空的 diff，不抛。</summary>
    public static CityDiff Decode(byte[]? blob)
    {
        var d = new CityDiff();
        if (blob is null || blob.Length == 0) return d;

        var p = 0;
        while (PbWire.TryReadTag(blob, ref p, out var field, out var wire))
        {
            switch (field)
            {
                case 1: d.Pop = (int)PbWire.ReadSInt(blob, ref p); break;
                case 2: d.PopF = PbWire.ReadDouble(blob, ref p); break;
                case 3: d.Tier = (int)PbWire.ReadSInt(blob, ref p); break;
                case 4: d.State = (int)PbWire.ReadSInt(blob, ref p); break;
                case 5: d.Age = PbWire.ReadSInt(blob, ref p); break;
                case 6: d.FoodDebt = PbWire.ReadDouble(blob, ref p); break;
                case 7: d.PopBase = (int)PbWire.ReadSInt(blob, ref p); break;
                case 8: d.BasePopF = PbWire.ReadDouble(blob, ref p); break;
                case 9: d.BasePopFCleared = PbWire.ReadVarint(blob, ref p) != 0; break;
                case 10: d.BuiltFrac = PbWire.ReadDouble(blob, ref p); break;
                case 11: d.Kf = PbWire.ReadDouble(blob, ref p); break;
                case 12: d.LastEvoTick = PbWire.ReadSInt(blob, ref p); break;
                case 13: d.Ver = (int)PbWire.ReadSInt(blob, ref p); break;
                case 14: d.BaseAge = PbWire.ReadSInt(blob, ref p); break;
                case 15: d.BaseAgeCleared = PbWire.ReadVarint(blob, ref p) != 0; break;
                case 30: d.Built = PbWire.ReadString(blob, ref p); break;
                default:
                    if (field >= 20 && field < 20 + CityStateStore.ResourceCount)
                        d.Stock[field - 20] = PbWire.ReadSInt(blob, ref p);
                    else
                        PbWire.SkipField(blob, ref p, wire);   // 未来字段，跳过
                    break;
            }
        }
        return d;
    }

    // ══ 小工具 ═════════════════════════════════════════════════════════

    /// <summary>⚠ 用**逐位相等**而不是 `==`：NaN != NaN 会让「没变」被判成「变了」，
    /// 而演化器确实会产出 NaN（K 除零）。这里把「都是 NaN」当相等。</summary>
    private static bool SameDouble(double a, double b)
    {
        if (double.IsNaN(a) && double.IsNaN(b)) return true;
        return a.Equals(b);
    }

    private static long[] SplitStock(string json)
    {
        var v = new long[CityStateStore.ResourceCount];
        if (string.IsNullOrEmpty(json) || json == "{}") return v;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object) return v;
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                var i = CityStateStore.ResourceIndex(prop.Name);
                if (i < 0 || prop.Value.ValueKind != System.Text.Json.JsonValueKind.Number) continue;
                v[i] = (long)Math.Round(prop.Value.GetDouble());
            }
        }
        catch (System.Text.Json.JsonException) { /* 坏 JSON ⇒ 当空库存（与演化器口径一致） */ }
        return v;
    }

    private static string JoinStock(long[] v)
    {
        var any = false;
        for (var i = 0; i < v.Length; i++) if (v[i] != 0) { any = true; break; }
        if (!any) return "{}";
        var sb = new System.Text.StringBuilder(96);
        sb.Append('{');
        var first = true;
        for (var i = 0; i < v.Length; i++)
        {
            if (v[i] == 0) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(CityStateStore.ResourceOrder[i]).Append("\":")
              .Append(v[i].ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        return sb.Append('}').ToString();
    }
}
