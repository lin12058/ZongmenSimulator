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
    /* WebSocket 单块接口 (设计 §3.4): 实体骨架扩展字段。
       9..12 仅存在于新会话的区域包缓存中 (region 包不落 SQLite, 无历史行兼容问题)。 */
    [ProtoMember(9)] public string Owner { get; set; } = "";      // 归属
    [ProtoMember(10)] public int Tier { get; set; }               // 等级/规模
    [ProtoMember(11)] public int State { get; set; }              // 0活跃 1被毁 2刷新中 3事件态
    [ProtoMember(12)] public long ExpireTs { get; set; }          // 0=永久
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

/* ============================================================
 * WebSocket 单块统一协议 (设计 §3 / §5)
 *   传输: ws://…/ws/map 二进制帧, 帧头 1 字节消息类型 + protobuf 载荷:
 *     C→S: 1=LoginRequest(明文)  2=TileRequest(明文)  3=Ping(空载荷)
 *     S→C: 1=LoginResponse(明文) 2=TileResponse(gzip)  3=Pong(空载荷)
 *   mask 按位选图层; TileResponse 内各图层为独立子消息, 字段缺省即
 *   「该图层未变/未请求」, 客户端据 Revs 判断 (设计 §4 rev 失效)。
 * ============================================================ */

/// <summary>WebSocket 帧类型 (帧头字节)。</summary>
public static class WsFrame
{
    public const byte Login = 1;
    public const byte Tile = 2;
    public const byte Ping = 3;
    public const byte Pong = 3;
}

/// <summary>图层位掩码 (设计 §3.3)。mask=0 语义上等同 All。</summary>
[System.Flags]
public enum TileMask : uint
{
    None = 0,
    Chunk = 1 << 0,     // 0x01 静态地形+精灵
    Region = 1 << 1,    // 0x02 区域名+道路
    Settle = 1 << 2,    // 0x04 聚落实体
    Poi = 1 << 3,       // 0x08 景点实体
    Comm = 1 << 4,      // 0x10 灵脉群落
    All = Chunk | Region | Settle | Poi | Comm   // 0x1F
}

[ProtoContract]
public sealed class LoginRequest
{
    [ProtoMember(1)] public string Account { get; set; } = "";
    [ProtoMember(2)] public string Token { get; set; } = "";
}

[ProtoContract]
public sealed class LoginResponse
{
    [ProtoMember(1)] public bool Ok { get; set; }
    [ProtoMember(2)] public string Err { get; set; } = "";
    [ProtoMember(3)] public string Account { get; set; } = "";
}

[ProtoContract]
public sealed class TileRequest
{
    [ProtoMember(1)] public int Op { get; set; }               // 1=请求单个块
    [ProtoMember(2)] public string Seed { get; set; } = "";
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(5)] public uint Mask { get; set; }            // 0 或 ALL = 全量
    [ProtoMember(6)] public uint Seq { get; set; }             // 客户端关联序号, 响应回显
    /// <summary>客户端已持有的各图层 rev (按 TileMask 位序: 0=Chunk..4=Comm; 0=未持有)。</summary>
    [ProtoMember(7)] public List<int> LastRevs { get; set; } = [];
}

[ProtoContract]
public sealed class PlaceEntity
{
    [ProtoMember(1)] public string Id { get; set; } = "";      // 跨块唯一: i_j_k / i_j_p
    [ProtoMember(2)] public string Type { get; set; } = "";    // sect/city/town/village | poi
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(5)] public float X { get; set; }
    [ProtoMember(6)] public float Y { get; set; }
    [ProtoMember(7)] public string Name { get; set; } = "";
    [ProtoMember(8)] public long Pop { get; set; }             // 聚落人口 / 景点热度
    [ProtoMember(9)] public string Owner { get; set; } = "";
    [ProtoMember(10)] public int Tier { get; set; }
    [ProtoMember(11)] public int State { get; set; }           // 0活跃 1被毁 2刷新中 3事件态
    [ProtoMember(12)] public long ExpireTs { get; set; }       // 0=永久
}

/// <summary>按区域格分组的实体列表 (key = 区域格坐标, 客户端据键去重/失效)。</summary>
[ProtoContract]
public sealed class EntityGroup
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(3)] public List<PlaceEntity> Items { get; set; } = [];
}

/// <summary>图层2 聚落实体 (设计 §3.2 SettleData)。</summary>
[ProtoContract]
public sealed class SettleData
{
    [ProtoMember(1)] public List<EntityGroup> Groups { get; set; } = [];
}

/// <summary>图层3 景点实体 (设计 §3.2 PoiData)。</summary>
[ProtoContract]
public sealed class PoiData
{
    [ProtoMember(1)] public List<EntityGroup> Groups { get; set; } = [];
}

/// <summary>图层1 区域数据: 区域名 + 道路 (聚落已拆分到 Settle/Poi 图层)。</summary>
[ProtoContract]
public sealed class RegionData
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(3)] public RegionInfoDto Info { get; set; } = new();
    [ProtoMember(4)] public List<RoadDto> Roads { get; set; } = [];
}

[ProtoContract]
public sealed class TileResponse
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(3)] public uint Mask { get; set; }            // 回显实际服务的图层
    [ProtoMember(4)] public uint DeniedMask { get; set; }      // 未登录被拒的图层位
    [ProtoMember(5)] public string Err { get; set; } = "";
    [ProtoMember(6)] public uint Seq { get; set; }             // 回显请求序号
    /// <summary>各图层当前 rev (按 TileMask 位序 0..4), 供客户端下次带 LastRevs。</summary>
    [ProtoMember(7)] public List<int> Revs { get; set; } = [];

    /* ---- 图层子消息 (字段缺省 = 未请求 / rev 未变, 设计 §4) ---- */
    [ProtoMember(10)] public byte[]? Chunk { get; set; }          // 图层0: ChunkPayload 原始 protobuf
    [ProtoMember(11)] public List<RegionData> Regions { get; set; } = [];  // 图层1
    [ProtoMember(12)] public SettleData? Settle { get; set; }     // 图层2
    [ProtoMember(13)] public PoiData? Poi { get; set; }           // 图层3
    [ProtoMember(14)] public List<byte[]> Comms { get; set; } = [];        // 图层4: CommunityPack 原始 protobuf
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
