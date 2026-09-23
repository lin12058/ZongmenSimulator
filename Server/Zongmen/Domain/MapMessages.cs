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
public sealed class BuildingDto
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(3)] public string Kind { get; set; } = "";      // 码头/农田/矿山/民房…
    [ProtoMember(4)] public string Terrain { get; set; } = "";   // 地皮: 灵枢/水岸/良田/矿脉/林地/灼壤/村落/core
    [ProtoMember(5)] public int Tier { get; set; }
}

[ProtoContract]
public sealed class ResourceQuantDto
{
    [ProtoMember(1)] public string Resource { get; set; } = "";  // 粮/木/矿/渔/炭/灵/丹/器
    [ProtoMember(2)] public int Amount { get; set; }
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
    /* 13..16 城镇足迹 (§三/Phase3): 风格 + 建筑 + 产出。
       ⚠ 与 settle 包 (SettlePack) 同源 — 区域包内这四项仅作「不必二次取包」的冗余,
       持久化权威在 w:{seed}:settle:{i}:{j}。 */
    [ProtoMember(13)] public string Style { get; set; } = "";      // 风格 key: farm/mine/river…
    [ProtoMember(14)] public string StyleName { get; set; } = "";  // 风格中文名
    [ProtoMember(15)] public List<BuildingDto> Buildings { get; set; } = [];
    [ProtoMember(16)] public List<ResourceQuantDto> Resources { get; set; } = [];
}

/// <summary>城镇足迹包 (落 SQLite: w:{seed}:settle:{i}:{j})。
/// 建筑足迹后续会演化 (事件/毁损/升级), 故独立成包、独立持久化。</summary>
[ProtoContract]
public sealed class SettleTownDto
{
    [ProtoMember(1)] public string Id { get; set; } = "";
    [ProtoMember(2)] public string Style { get; set; } = "";
    [ProtoMember(3)] public string StyleName { get; set; } = "";
    [ProtoMember(4)] public List<BuildingDto> Buildings { get; set; } = [];
    [ProtoMember(5)] public List<ResourceQuantDto> Resources { get; set; } = [];
}

[ProtoContract]
public sealed class SettlePack
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int I { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int J { get; set; }
    [ProtoMember(3)] public List<SettleTownDto> Towns { get; set; } = [];
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
    /* R11 (小地图灵脉化): 引擎脚本下发 —— 前端要按 seed 自行算地形, 需要
       mapgen 三件套 (noise/mapgen-config/mapgen)。走 WS 而非新增静态挂载,
       保证「单真源」: 浏览器拿到的永远是服务端当前 bundle, 不会与前端副本漂移。 */
    public const byte Script = 4;
    /* ---- 玩家宗门放置 (2026-09-23 方案 §4.1) ----
       与 Login/Tile 同例: **请求与响应共用同一个类型号** (方向由上下文区分)。
       PlaceCheck  = 悬停即问 (高频, 只读, 不落库)
       PlaceCommit = 确认落子 (低频, 写: 落库 + 重算道路 + 版本号前进)
       ⚠ 7 号 (CityQuery) 是 P2「城市迭代」的预留位, 本轮**不实现** —— 别占。 */
    public const byte PlaceCheck = 5;
    public const byte PlaceCommit = 6;
}

[ProtoContract]
public sealed class ScriptRequest
{
    /// <summary>文件名 (仅白名单内有效); 空 = 要整包 (noise+mapgen-config+mapgen)。</summary>
    [ProtoMember(1)] public string Name { get; set; } = "";
}

[ProtoContract]
public sealed class ScriptPack
{
    /// <summary>包名 ("engine" = 整包, 否则单文件名)。</summary>
    [ProtoMember(1)] public string Name { get; set; } = "";
    /// <summary>gzip(UTF-8 js 源码)。空数组 = 未找到/被拒。</summary>
    [ProtoMember(2)] public byte[] Source { get; set; } = [];
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
    /* 13..16 城镇足迹 (§三/Phase3): 供客户端画足迹底框 / 建筑图标 / 产能摘要。
       与 SettlePack 同源, 由 GetTileBlock 从 settle 包合并进来。 */
    [ProtoMember(13)] public string Style { get; set; } = "";
    [ProtoMember(14)] public string StyleName { get; set; } = "";
    [ProtoMember(15)] public List<BuildingDto> Buildings { get; set; } = [];
    [ProtoMember(16)] public List<ResourceQuantDto> Resources { get; set; } = [];
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
    /// <summary>城镇足迹包 (Phase3): 建筑/产出/风格, 独立持久化 (会随事件演化)。</summary>
    public static string Settle(string seed, int i, int j)
        => $"w:{SeedPrefix(seed)}:settle:{i}:{j}";
}

/* ============================================================
 * 玩家宗门放置协议 (2026-09-23 方案 §4.2)
 * ------------------------------------------------------------
 * 两条路径的分工:
 *   PlaceCheck  = 只读, 悬停即问 (前端 ≥150ms 节流)。判据 5~7 (深海/灵脉/领地)
 *                 在引擎里算, 判据 1~3/9 (seed/登录/配额/名字) 在服务端叠上去。
 *   PlaceCommit = 写。服务端**重新**跑一遍全部判据 (前端的 check 只是提示,
 *                 绝不可信), 再落库 + 引擎侧重算道路 + 版本号前进, 最后返回
 *                 「客户端必须重拉的块」清单。
 * ⚠ 客户端对**已加载**的块不会自动重拉 (main.js updateStreaming 的入队条件是
 *   `!chunkData.has(key)`) ⇒ PlaceCommitResponse.Blocks 是让新宗门/新路立刻可见的
 *   唯一手段, 服务端只 BumpBlockRev 是不够的。
 * ============================================================ */

/// <summary>落点校验请求 (帧 5, C→S, 明文 protobuf)。</summary>
[ProtoContract]
public sealed class PlaceCheckRequest
{
    [ProtoMember(1)] public string Seed { get; set; } = "";
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(4)] public uint Seq { get; set; }
    /// <summary>「原地重建/升级」时豁免自己的聚落 id (P0 恒空)。</summary>
    [ProtoMember(5)] public string ExcludeId { get; set; } = "";
}

/// <summary>领地被侵占的元凶 (前端标红用)。</summary>
[ProtoContract]
public sealed class PlaceBlockDto
{
    [ProtoMember(1)] public string Id { get; set; } = "";
    [ProtoMember(2)] public string Type { get; set; } = "";
    [ProtoMember(3)] public int Tier { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    /// <summary>新落点到它的中心距 (格)。</summary>
    [ProtoMember(6)] public int Dist { get; set; }
    /// <summary>它的领地半径 (格, DOMAIN_R)。判定 = Dist &lt; Need ⇒ 拒绝。</summary>
    [ProtoMember(7)] public int Need { get; set; }
}

/// <summary>附近一座聚落的领地圈 (前端画环用; 与 blocker 同形状但语义不同)。</summary>
[ProtoContract]
public sealed class PlaceDomainDto
{
    [ProtoMember(1)] public string Id { get; set; } = "";
    [ProtoMember(2)] public string Type { get; set; } = "";
    [ProtoMember(3)] public int Tier { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(6)] public int Dist { get; set; }
    [ProtoMember(7)] public int Need { get; set; }
    [ProtoMember(8)] public string Name { get; set; } = "";
}

/// <summary>落点校验响应 (帧 5, S→C, 明文 protobuf)。</summary>
[ProtoContract]
public sealed class PlaceCheckResponse
{
    [ProtoMember(1)] public bool Ok { get; set; }
    /// <summary>拒绝原因码: deep_water / on_vein / too_close / spirit_too_low /
    /// world_stale / need_login / quota_exceeded / bad_coord / bad_name /
    /// too_frequent / "" (可建)。</summary>
    [ProtoMember(2)] public string Reason { get; set; } = "";
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionI { get; set; }
    [ProtoMember(6, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionJ { get; set; }
    [ProtoMember(7)] public bool Deep { get; set; }
    [ProtoMember(8)] public bool OnVein { get; set; }
    [ProtoMember(9)] public int VeinD { get; set; }
    [ProtoMember(10)] public float Spirit { get; set; }
    [ProtoMember(11)] public float SpiritMin { get; set; }
    [ProtoMember(12)] public int Biome { get; set; }
    [ProtoMember(13)] public float Elev { get; set; }
    [ProtoMember(14)] public PlaceBlockDto? Blocker { get; set; }
    [ProtoMember(15)] public List<PlaceDomainDto> Near { get; set; } = [];
    [ProtoMember(16)] public uint Seq { get; set; }
    /// <summary>本账号本世已立宗门数 / 上限 (前端在按钮上做提示)。</summary>
    [ProtoMember(17)] public int Quota { get; set; }
    [ProtoMember(18)] public int QuotaMax { get; set; }
    [ProtoMember(19)] public string Err { get; set; } = "";
}

/// <summary>落子提交请求 (帧 6, C→S, 明文 protobuf)。</summary>
[ProtoContract]
public sealed class PlaceCommitRequest
{
    [ProtoMember(1)] public string Seed { get; set; } = "";
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Q { get; set; }
    [ProtoMember(3, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int R { get; set; }
    [ProtoMember(4)] public string Name { get; set; } = "";
    /// <summary>宗门档位 1~3 (下品/中品/上品); 决定领地半径档 (DOMAIN_R.sect1/2/3)。</summary>
    [ProtoMember(5)] public int Tier { get; set; } = 1;
    [ProtoMember(6)] public uint Seq { get; set; }
    /// <summary>幂等键 (前端每次「点确认」生成一个; 同键重发直接回放上次响应,
    /// 不再落库、不再重算道路 —— 这是「同步重算 ~450ms 时用户狂点」的兜底)。</summary>
    [ProtoMember(7)] public string IdemKey { get; set; } = "";
}

[ProtoContract]
public sealed class BlockRef
{
    [ProtoMember(1, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Ca { get; set; }
    [ProtoMember(2, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int Cb { get; set; }
}

/// <summary>落子提交响应 (帧 6, S→C, 明文 protobuf)。</summary>
[ProtoContract]
public sealed class PlaceCommitResponse
{
    [ProtoMember(1)] public bool Ok { get; set; }
    [ProtoMember(2)] public string Reason { get; set; } = "";
    /// <summary>落成的宗门实体 (与 Settle 图层同形状 ⇒ 前端可先用它乐观上屏)。</summary>
    [ProtoMember(3)] public SettlementDto? Sect { get; set; }
    [ProtoMember(4, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionI { get; set; }
    [ProtoMember(5, DataFormat = ProtoBuf.DataFormat.ZigZag)] public int RegionJ { get; set; }
    /// <summary>重算后的道路版本号 (单调递增; 前端可用它做诊断/握手)。</summary>
    [ProtoMember(6)] public long RoadVer { get; set; }
    /// <summary>服务端本次同步重算耗费的毫秒 (实测 400~450ms 属预期)。</summary>
    [ProtoMember(7)] public int Ms { get; set; }
    [ProtoMember(8)] public uint Seq { get; set; }
    [ProtoMember(9)] public string Err { get; set; } = "";
    /// <summary>⚠ **必须重拉**的块清单 (>0 个)。理由见本区头注释。</summary>
    [ProtoMember(10)] public List<BlockRef> Blocks { get; set; } = [];
    /// <summary>挂在玩家宗门上的道路条数 (诊断)。</summary>
    [ProtoMember(11)] public int Roads { get; set; }
    [ProtoMember(12)] public string IdemKey { get; set; } = "";
}
