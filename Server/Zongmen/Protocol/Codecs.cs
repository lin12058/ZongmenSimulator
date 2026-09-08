using System.IO.Compression;
using ProtoBuf;

namespace Zongmen.Protocol;

/// <summary>protobuf 序列化封装 (对齐参考文档 ProtoBufExtension)。</summary>
public static class ProtoCodec
{
    public static byte[] SerToByte<T>(T obj)
    {
        using var ms = new MemoryStream();
        Serializer.Serialize(ms, obj);
        return ms.ToArray();
    }

    public static T DesFromByte<T>(byte[] bytes)
    {
        using var ms = new MemoryStream(bytes, writable: false);
        return Serializer.Deserialize<T>(ms);
    }
}

/// <summary>GZip 压缩工具: 链路约定 protobuf → gzip。</summary>
public static class GZipCodec
{
    public static byte[] Compress(byte[] data)
    {
        using var outMs = new MemoryStream();
        using (var gz = new GZipStream(outMs, CompressionLevel.Fastest, leaveOpen: true))
        {
            gz.Write(data, 0, data.Length);
        }
        return outMs.ToArray();
    }

    public static byte[] Decompress(byte[] data)
    {
        using var inMs = new MemoryStream(data, writable: false);
        using var gz = new GZipStream(inMs, CompressionMode.Decompress);
        using var outMs = new MemoryStream();
        gz.CopyTo(outMs);
        return outMs.ToArray();
    }
}
