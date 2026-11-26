using System.IO.Compression;
using System.Text;

namespace Zongmen.Storage;

/// <summary>
/// 落库边界的紧凑编码：文本 ↔ BLOB。
///
/// ⚠ 为什么**不是永远 gzip**：JSON 小于 ~128B 时 gzip 头(10B) + 尾(8B) 比原文还大。
///   所以带 1 字节 tag 区分 raw / gzip，短串原样存（仍比 TEXT 少一层类型头）。
///
/// ⚠ 为什么第 1 字节是 tag 而不是"看能不能解压"：SQLite 的 BLOB 列可以塞任意字节，
///   旧库里那一列可能是**纯 UTF-8 文本**（迁移前写的）。tag=0/1 之外的字节一律按
///   原文解 —— 这样老数据读得出来，不需要迁移脚本。
/// </summary>
public static class BlobCodec
{
    private const byte TagRaw = 0;
    private const byte TagGzip = 1;

    /// <summary>低于此长度直接存原文（gzip 头尾 18B 就不划算）。</summary>
    public const int MinCompressLen = 128;

    /// <summary>文本 → BLOB。空串给空数组（SQLite 存 0 字节，比 "{}" 省）。</summary>
    public static byte[] Pack(string? text)
    {
        if (string.IsNullOrEmpty(text)) return [];
        var raw = Encoding.UTF8.GetBytes(text);
        if (raw.Length < MinCompressLen) return Wrap(TagRaw, raw);

        using var ms = new MemoryStream(raw.Length / 2 + 32);
        ms.WriteByte(TagGzip);
        using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
            gz.Write(raw, 0, raw.Length);
        var packed = ms.ToArray();

        /* 压不动就退回原文（有些短 JSON 的 gzip 会膨胀 10%~20%，
           这在高重复的小对象上真的会发生）。判据用"净字节"而不是"压缩率"。 */
        return packed.Length < raw.Length + 1 ? packed : Wrap(TagRaw, raw);
    }

    /// <summary>加 1 字节 tag 前缀。</summary>
    private static byte[] Wrap(byte tag, byte[] body)
    {
        var o = new byte[body.Length + 1];
        o[0] = tag;
        body.CopyTo(o, 1);
        return o;
    }

    /// <summary>SQLite 字段值 → 文本。兼容旧库 TEXT 行 / NULL / BLOB 三种形态。</summary>
    public static string FromField(object? v) => v switch
    {
        byte[] b => Unpack(b),
        string s => s,                     // 旧库还没转成 BLOB 的行
        null => "",
        DBNull => "",
        _ => v.ToString() ?? "",
    };

    /// <summary>BLOB → 文本。空 / null ⇒ 空串。tag 不认识 ⇒ 当原文（兼容旧库）。</summary>
    public static string Unpack(byte[]? blob)
    {
        if (blob is null || blob.Length == 0) return "";
        switch (blob[0])
        {
            case TagRaw:
                return Encoding.UTF8.GetString(blob, 1, blob.Length - 1);
            case TagGzip:
                using (var src = new MemoryStream(blob, 1, blob.Length - 1))
                using (var gz = new GZipStream(src, CompressionMode.Decompress))
                using (var dst = new MemoryStream(blob.Length * 4 + 64))
                {
                    gz.CopyTo(dst);
                    return Encoding.UTF8.GetString(dst.ToArray());
                }
            default:
                return Encoding.UTF8.GetString(blob);   // 旧库纯文本行
        }
    }
}

/// <summary>
/// 变长整数（LEB128，无符号）。给 `Built` 这类「小整数 + 短中文串」的数组用 ——
/// 一个 q/r 坐标通常在 2~3 字节内，比固定 int32 再省一半。
/// </summary>
public static class Varint
{
    public static void WriteU(Span<byte> buf, ref int pos, ulong v)
    {
        while (v >= 0x80) { buf[pos++] = (byte)(v | 0x80); v >>= 7; }
        buf[pos++] = (byte)v;
    }

    public static ulong ReadU(ReadOnlySpan<byte> buf, ref int pos)
    {
        ulong v = 0; int shift = 0;
        while (true)
        {
            var b = buf[pos++];
            v |= (ulong)(b & 0x7F) << shift;
            if ((b & 0x80) == 0) return v;
            shift += 7;
            if (shift > 63) throw new InvalidDataException("varint 溢出");
        }
    }

    /// <summary>ZigZag：让 -1 → 1、1 → 2（负数不再吃满 10 字节）。</summary>
    public static ulong Zig(int v) => (ulong)((v << 1) ^ (v >> 31));
    public static int UnZig(ulong v) => (int)((v >> 1) ^ (ulong)-(long)(v & 1));
}
