using System.Buffers.Binary;
using System.Text;

namespace Zongmen.Events;

/* ============================================================
 * protobuf wire format 最小实现（无 protobuf-net 依赖）
 * ------------------------------------------------------------
 * 为什么手写而不用 protobuf-net：
 *   ① 需求是「**没变的字段一个字节都不写**」。protobuf-net 对 `int?` 的行为是
 *      「非 null 就写」，而它的 `ShouldSerialize` / `[DefaultValue]` 组合在
 *      nullable 上的语义要看版本 —— 这是**静默多写**（不是错，只是白烧磁盘），
 *      排查时看不出来。
 *   ② 本项目的 diff 是**热路径**（每 tick 每条事件一次），要精确控制长度。
 *   ③ 项目已有手写 varint 的先例（`CityStateStore.EncodeBuilt`），风格一致。
 *
 * ★ 与标准 protobuf 完全兼容（field number + wire type + zigzag），
 *   任何 protobuf 工具都能解 —— 不是私有格式。
 *
 * ⚠ 有符号整数一律 zigzag（`sint32`/`sint64`）：
 *   标准 `int32` 对负数编码成 **10 字节** varint，而人口差、坐标、tick 都可能为负。
 *   用 zigzag 后 -1 只占 1 字节。漏了这条，diff 会比不压缩还大。
 * ============================================================ */
public static class PbWire
{
    public const int WireVarint = 0;
    public const int WireFixed64 = 1;
    public const int WireBytes = 2;
    public const int WireFixed32 = 5;

    // ══ 写 ═════════════════════════════════════════════════════════════

    public static void WriteTag(List<byte> o, int field, int wire)
        => WriteVarint(o, (ulong)((field << 3) | wire));

    public static void WriteVarint(List<byte> o, ulong v)
    {
        while (v >= 0x80) { o.Add((byte)(v | 0x80)); v >>= 7; }
        o.Add((byte)v);
    }

    /// <summary>有符号整数（zigzag）。field 必须 1..536870911。</summary>
    public static void WriteSInt(List<byte> o, int field, long v)
    {
        WriteTag(o, field, WireVarint);
        WriteVarint(o, Zig(v));
    }

    public static void WriteDouble(List<byte> o, int field, double v)
    {
        WriteTag(o, field, WireFixed64);
        var buf = new byte[8];
        BinaryPrimitives.WriteDoubleLittleEndian(buf, v);
        o.AddRange(buf);
    }

    public static void WriteBool(List<byte> o, int field, bool v)
    {
        WriteTag(o, field, WireVarint);
        WriteVarint(o, v ? 1UL : 0UL);
    }

    public static void WriteString(List<byte> o, int field, string s)
    {
        var raw = Encoding.UTF8.GetBytes(s);
        WriteTag(o, field, WireBytes);
        WriteVarint(o, (ulong)raw.Length);
        o.AddRange(raw);
    }

    public static ulong Zig(long v) => (ulong)((v << 1) ^ (v >> 63));
    public static long UnZig(ulong v) => (long)(v >> 1) ^ -(long)(v & 1);

    // ══ 读 ═════════════════════════════════════════════════════════════

    /// <summary>读 tag。到末尾返回 false（**不是异常** —— 循环靠它退出）。</summary>
    public static bool TryReadTag(byte[] b, ref int p, out int field, out int wire)
    {
        if (p >= b.Length) { field = 0; wire = 0; return false; }
        var tag = ReadVarint(b, ref p);
        field = (int)(tag >> 3);
        wire = (int)(tag & 0x7);
        return true;
    }

    public static ulong ReadVarint(byte[] b, ref int p)
    {
        ulong v = 0;
        var shift = 0;
        while (true)
        {
            if (p >= b.Length) throw new InvalidDataException("PbWire: varint 越界（BLOB 被截断）");
            var x = b[p++];
            v |= (ulong)(x & 0x7F) << shift;
            if ((x & 0x80) == 0) return v;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("PbWire: varint 溢出（>10 字节）");
        }
    }

    public static long ReadSInt(byte[] b, ref int p) => UnZig(ReadVarint(b, ref p));

    public static double ReadDouble(byte[] b, ref int p)
    {
        if (p + 8 > b.Length) throw new InvalidDataException("PbWire: double 越界");
        var v = BinaryPrimitives.ReadDoubleLittleEndian(b.AsSpan(p, 8));
        p += 8;
        return v;
    }

    public static string ReadString(byte[] b, ref int p)
    {
        var n = (int)ReadVarint(b, ref p);
        if (n < 0 || p + n > b.Length) throw new InvalidDataException("PbWire: string 越界");
        var s = Encoding.UTF8.GetString(b, p, n);
        p += n;
        return s;
    }

    /// <summary>跳过不认识的字段（**向前兼容的唯一手段**）。
    /// ⚠ 缺了它，将来给 diff 加字段会让旧版本读新库直接抛 ⇒ 回放整段报废。</summary>
    public static void SkipField(byte[] b, ref int p, int wire)
    {
        switch (wire)
        {
            case WireVarint: ReadVarint(b, ref p); break;
            case WireFixed64: p += 8; break;
            case WireBytes: { var n = (int)ReadVarint(b, ref p); p += n; break; }
            case WireFixed32: p += 4; break;
            default: throw new InvalidDataException($"PbWire: 未知 wire type {wire}");
        }
        if (p > b.Length) throw new InvalidDataException("PbWire: skip 越界");
    }
}
