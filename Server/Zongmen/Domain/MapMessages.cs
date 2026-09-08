using ProtoBuf;

namespace Zongmen.Domain;

/* ============================================================
 * 领域层 — 地图协议契约 (protobuf-net)
 *
 * 全部为「服务端权威世界」的下发数据。字段号与 wire 布局为前后端共享规范,
 * 客户端微型解码器 web/js/pb.js 必须与此处保持一一对应, 不可随意改号。
 *
 * 压缩/存储约定: proto 字节 → GZip → SQLite (Data.Value); HTTP 下发时
 * 设置 Content-Encoding: gzip, 由浏览器/Node fetch 透明解压。
 *
 * Chunk 数值打包(相对起点减量):
 *   tile 坐标存「相对区块中心 (Δq,Δr)」小整数(+16 偏移, 0..32),
 *   客户端用 世界公式 tileToWorld(ca*S+Δq, cb*S+Δr) 精确还原绝对像素。
 *   海拔/哈希 u16 量化(1/65535), 邻域编码 u32 原样保留。
 *   精灵中心存相对区块中心世界像素的 f32 偏移。
 * ============================================================ */

[ProtoContract]
public sealed class ChunkPayload
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Ca { get; set; }      // sint32 区块轴坐标
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Cb { get; set; }
    [ProtoMember(3)] public int Count { get; set; }   // 地块数
    [ProtoMember(4)] public byte[] Cq { get; set; } = [];   // Δq+16, count 字节
    [ProtoMember(5)] public byte[] Cr { get; set; } = [];   // Δr+16
    [ProtoMember(6)] public byte[] Tiles { get; set; } = []; // biome*4+variant, count 字节
    [ProtoMember(7)] public byte[] Elev { get; set; } = [];  // u16 LE ×count
    [ProtoMember(8)] public byte[] Hash { get; set; } = [];  // u16 LE ×count
    [ProtoMember(9)] public byte[] Neigh { get; set; } = []; // u32 LE ×count
    [ProtoMember(10)] public int Pn { get; set; }      // 精灵数
    [ProtoMember(11)] public byte[] Pdx { get; set; } = []; // f32 LE ×pn (相对区块中心 x)
    [ProtoMember(12)] public byte[] Pdy { get; set; } = []; // f32 LE ×pn
    [ProtoMember(13)] public byte[] Psp { get; set; } = []; // u8 ×pn 精灵索引
    [ProtoMember(14)] public byte[] Ph { get; set; } = [];  // u16 LE ×pn
    [ProtoMember(15)] public byte[] Pe { get; set; } = [];  // u16 LE ×pn
}

[ProtoContract]
public sealed class RegionInfoDto
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(3)] public float X { get; set; }
    [ProtoMember(4)] public float Y { get; set; }
    [ProtoMember(5)] public int Biome { get; set; }
    [ProtoMember(6)] public string Name { get; set; } = "";
}

[ProtoContract]
public sealed class SettlementDto
{
    [ProtoMember(1)] public string Id { get; set; } = "";
    [ProtoMember(2)] public string Type { get; set; } = "";   // sect/city/town/village/poi
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(5)] public float X { get; set; }
    [ProtoMember(6)] public float Y { get; set; }
    [ProtoMember(7)] public string Name { get; set; } = "";
    [ProtoMember(8)] public int Pop { get; set; }
}

[ProtoContract]
public sealed class RoadDto
{
    [ProtoMember(1)] public string Key { get; set; } = "";
    [ProtoMember(2)] public float X0 { get; set; }
    [ProtoMember(3)] public float Y0 { get; set; }
    [ProtoMember(4)] public float X1 { get; set; }
    [ProtoMember(5)] public float Y1 { get; set; }
    [ProtoMember(6)] public byte[] Pts { get; set; } = [];  // f32 LE 交错 x,y
}

[ProtoContract]
public sealed class RegionPack
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(3)] public RegionInfoDto Region { get; set; } = new();
    [ProtoMember(4)] public List<SettlementDto> Settlements { get; set; } = [];
    [ProtoMember(5)] public List<RoadDto> Roads { get; set; } = [];
}

[ProtoContract]
public sealed class VeinDto
{
    [ProtoMember(1)] public string Name { get; set; } = "";
    [ProtoMember(2)] public int Element { get; set; }
    [ProtoMember(3)] public string Variant { get; set; } = "";
    [ProtoMember(4)] public int Level { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(6, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(7)] public float X { get; set; }
    [ProtoMember(8)] public float Y { get; set; }
}

[ProtoContract]
public sealed class CommunityPack
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Ci { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Cj { get; set; }
    [ProtoMember(3)] public bool Exists { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(6)] public float X { get; set; }
    [ProtoMember(7)] public float Y { get; set; }
    [ProtoMember(8)] public int Element { get; set; }
    [ProtoMember(9)] public float Spirit { get; set; }
    [ProtoMember(10)] public List<VeinDto> Veins { get; set; } = [];
}

[ProtoContract]
public sealed class TileQuery
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    // 字段事实
    [ProtoMember(3)] public float E { get; set; }
    [ProtoMember(4)] public float M { get; set; }
    [ProtoMember(5)] public float T { get; set; }
    [ProtoMember(6)] public int Biome { get; set; }
    [ProtoMember(7)] public int Disp { get; set; }
    [ProtoMember(8)] public int Variant { get; set; }
    // 灵脉事实(可选)
    [ProtoMember(9)] public int VeinElement { get; set; }
    [ProtoMember(10)] public string VeinVariant { get; set; } = "";
    [ProtoMember(11)] public int VeinLevel { get; set; }
    [ProtoMember(12)] public int VeinD { get; set; }
    [ProtoMember(13)] public string VeinName { get; set; } = "";
    [ProtoMember(14)] public bool HasVein { get; set; }
    // 区域/聚落
    [ProtoMember(15, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionI { get; set; }
    [ProtoMember(16, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionJ { get; set; }
    [ProtoMember(17)] public string RegionName { get; set; } = "";
    [ProtoMember(18)] public int RegionBiome { get; set; }
    [ProtoMember(19)] public string PlaceType { get; set; } = ""; // 命中聚落
    [ProtoMember(20)] public string PlaceName { get; set; } = "";
    [ProtoMember(21)] public int PlacePop { get; set; }
    // 派生事实
    [ProtoMember(22)] public int WaterD { get; set; }     // 0=水/滨水; 1..4=距离; 255=较远
    [ProtoMember(23)] public bool OnRoad { get; set; }
}

/// <summary>世界键规约: 所有持久化内容按 种子 隔离。</summary>
public static class WorldKeys
{
    public static string SeedPrefix(string seed)
    {
        var h = System.Security.Cryptography.SHA1.HashData(
            System.Text.Encoding.UTF8.GetBytes(seed));
        return Convert.ToHexString(h).Substring(0, 16).ToLowerInvariant();
    }
    public static string Chunk(string seed, int ca, int cb)
        => $"w:{SeedPrefix(seed)}:chunk:{ca}:{cb}";
    public static string Region(string seed, int i, int j)
        => $"w:{SeedPrefix(seed)}:region:{i}:{j}";
    public static string Comm(string seed, int ci, int cj)
        => $"w:{SeedPrefix(seed)}:comm:{ci}:{cj}";
}
