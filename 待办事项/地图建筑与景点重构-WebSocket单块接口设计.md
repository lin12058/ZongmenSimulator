# 地图建筑与景点重构 — WebSocket 单块统一接口设计

> 状态：**设计方案已定稿，未开工**
> 日期：2026-09-09
> 目标：把 chunk/region/comm/settle/poi 从多个 HTTP endpoint 重构成
>  **「一个 WebSocket 请求拉一整个块，内部多个独立子消息，mask 按位选择」**，
>  同时把建筑的「静态地形层」与「动态实体层（建筑/景点）」拆开。
> 坐标系**新建统一单块网格，块大小与 chunk 完全一致**。region/comm 仅为生成时逻辑层。

---

## 一、确认过的需求点（四问）

| # | 需求 | 定稿 |
|---|------|------|
| 1 | 单块返回格式 | **一个 protobuf 包内含多个独立子消息**（类似 JSON 分多个 key），前端按子消息分别解析 |
| 2 | mask 参数 | **按位 OR 位掩码**，`mask = ALL` 表示全量；每 bit 对应一个子图层 |
| 3 | 传输方式 | **全部走 WebSocket**，socket 与账号绑定；HTTP 仅保留 meta / 首连，不在 HTTP 上拉图 |
| 4 | 推送模型 | **纯请求/响应**（类似 HTTP 语义）：客户端切块才发 ws 请求，服务器按块响应；**服务器不主动推送**（含世界事件，客户端按需拉取） |

---

## 二、目标分层（构建物 vs 事件物）

```
明文可读层
├─ 图层0 静态地形   chunk        → 格底 tile/biome/elev/neigh + 山/树/灵脉峰 sprite   【世界骨架，基本不动】
├─ 图层1 区域       region       → 区域名 + 道路          【低频，随聚落生灭】
├─ 图层2 聚落实体   settle       → sect/city/town/village 【★ 动态实体，带 ID/状态/归属/等级】
├─ 图层3 景点实体   poi          → 秘境/热门景点/(未来奇观) ★ 动态实体，独立于建筑
└─ 图层4 灵脉       comm         → 群落 + veins 灵脉       【已有独立层，保留】
```

**拆分目标**：`poi` 与 `settle` 从 `RegionPack.settlements` 中分离，各自带唯一 ID、状态机位（state）、归属（owner）、等级（tier）。
> ⚠️ `expireTs`（过期时间）：**本版不实现**，无世界时钟、无时间变化，字段暂不产出（留待"世界演化"阶段）。

---

## 三、单块请求/响应协议（WebSocket 消息）

> **帧序号**：每个请求携带自增 `seq`，服务器原样回显；客户端据此核对响应归属并支持超时重发。首版仅回显，不做复杂重传。

### 3.1 请求（Client → Server）

```protobuf
message TileRequest {
  int32  op      = 1;   // =1 请求单个块
  string seed    = 2;   // 世界种子
  sint32 i       = 3;   // 统一块网格轴坐标（与 chunk 同尺寸，见 §6）
  sint32 j       = 4;
  uint32 mask    = 5;   // 位掩码，见 §3.3；0 或 ALL = 全量
  int32  seq     = 6;   // 客户端自增帧序号，服务器原样回显
}
```

### 3.2 响应（Server → Client）

单个 protobuf 包，内部多个独立子消息（对应需求点1）。
**每个子消息带显式 `has` 标记（方式乙）**：请求了但无数据 → 子消息存在、`has=false`；请求了且有数据 → `has=true`。纯坐标与 `seq` 始终回显。

```protobuf
message TileResponse {
  sint32   i, j;                  // 回显请求块坐标（统一块网格）
  int32    seq;                   // 回显请求帧序号
  uint32   mask;                  // 回显实际返回的图层掩码（0 = 某些图层空）
  ChunkData    chunk  = 3; bool chunkHas   = 13;   // 图层0
  RegionData   region = 4; bool regionHas  = 14;   // 图层1
  SettleData   settle = 5; bool settleHas  = 15;   // 图层2
  PoiData      poi    = 6; bool poiHas     = 16;   // 图层3
  CommData     comm   = 7; bool commHas    = 17;   // 图层4
  // 每个子消息带独立 rev，供增量失效（§4）
}
```

> **空语义（方式乙·显式标记）**：空 ≠ 缺省。凡被请求的图层一定出现在响应中，用 `xxxHas` 显式区分「有数据/无数据」；未请求的图层不出现（由 mask 语义保证）。同 rev 无变化时 `xxxHas=false`，前端不重建该层。

### 3.3 mask 位定义（按位 OR）

```csharp
[Flags] enum TileMask : uint {
  None      = 0,
  Chunk     = 1 << 0,   // 0x01 静态地形+精灵
  Region    = 1 << 1,   // 0x02 区域名+道路
  Settle    = 1 << 2,   // 0x04 聚落实体
  Poi       = 1 << 3,   // 0x08 景点实体
  Comm      = 1 << 4,   // 0x10 灵脉群落
  All       = Chunk|Region|Settle|Poi|Comm   // 0x1F
}
```

前端渲染仅需 `Chunk|Region`（mask=0x03）；UI 展示需要 `Settle|Poi|Comm`。**各图层完全独立可选。**

### 3.4 实体公共骨架（settle/poi 共用基础字段）

```protobuf
message PlaceEntity {
  string id;        // 跨帧唯一: settle_a1b2 / poi_c3d4
  string type;      // settle: sect/city/town/village; poi: secret/ruin/wonder...
  sint32 q, r;      // 轴向格坐标
  float  x, y;      // 世界像素
  string name;
  int64  pop;       // 聚落人口 / 景点热度
  string owner;     // 归属
  int32  tier;      // 等级/规模
  int32  state;     // 0活跃 1被毁 2刷新中 3事件态
}
// ⚠️ 本版无 expireTs / 世界时钟，字段不产出（后续"世界演化"阶段再加）
```

---

## 四、版本失效（增量/按块失效，不全局刷新）

对齐现有 `roadVer` 机制，新增**按块的图层版本**：

```csharp
// 服务端每个块独立维护各图层 rev
private readonly ConcurrentDictionary<(long seed, int i, int j), BlockRevs> _blockRev;
class BlockRevs { public int chunkRev,sRegionRev,settleRev,poiRev,commRev; }
```

- 客户端 `mapclient.js` 缓存每个块已取到的各图层 `<mask, rev>`；
- 切块重拉时带上最后 rev，服务端 `rev` 变化才整体重发该图层（否则可短响应/不发，由 mask 语义决定）；
- **「纯请求/响应」模式**：客户端在视角移动/主动刷新时发请求；服务端**不主动 push**，`rev` 只作为响应内的失效依据，不驱动主动推送。

---

## 五、WebSocket 连接与会话（与账号绑定）

- 连接建立：客户端带 `?token=<账号令牌>` 或首帧 `Login {account, token}`；
- 服务端建立 `Wssession`：`{ conn, accountId, subscribedBlocks:Set<(i,j)>, lastRev:Map }`；
- 心跳/保活：应用层 ping/pong，空闲断开重连（与账号恢复绑定）；
- **鉴权与数据请求解耦**：未登录只能拿静态 Chunk/Region；登录后才能拿 Settle/Poi/Comm（带归属/状态）。

---

## 六、统一块坐标系映射（已定稿：方案 B）

**新建单一「世界块」网格，块尺寸与现 chunk 完全一致（CHUNK_S=21）**，作为唯一持久化/寻址单元；**region 与 comm 降为生成时逻辑层，不再有独立网格寻址**——它们只在生成块内容时按既有 `regionSeedOf`/`communityOf` 规则参与计算，产物（区域名、道路、聚落、灵脉）随块一起落库/返回，客户端只用统一块坐标请求。

- **请求 `TileRequest{i,j}` 中的 `i,j` = 统一块坐标**（与现 chunk 的 ca/cb 同尺度同网格）。
- 每个统一块内部按旧规则求其所属 region(i,j)、covering comm，生成该块内的：
  - `chunk`：静态地形 + 精灵（原样）
  - `region`：该块区域名 + 本块经过的道路段（按旧 region/road 规则）
  - `settle`：落在本块的聚落实体（由原 `settlementsFor` 派生，但只保留本块内的）
  - `poi`：落在本块的景点实体（由原 `settlementsFor` 中 type=='poi' 独立出）
  - `comm`：影响本块的灵脉/群落 from `communityOf`
- 存储/PB 均按统一块组织；旧三套网格**仅存在于生成算法内部**，对外不再暴露。

> 迁移要点：大量旧代码以 region 格/comm 格为键（如 `settlementsFor(i,j)`、`roadsNear`、`communityOf`），重构时以「统一块 → 求出该块覆盖的旧 region 格 → 取结果 → 裁剪到本块」为适配层，避免重写生成算法本身。

---

## 七、改造范围（涉及文件）

| 文件 | 改动 |
|------|------|
| `Server/Zongmen/Protocol/`（新） | 新增 `MapMessages.proto` 重构态（TileRequest/TileResponse/PlaceEntity 等），旧 DTO 冻结 |
| `Server/Zongmen/Web/MapEndpoints.cs` | HTTP 图数据端点 `Map` 中的 chunk/region/comm/tile/fields **注释掉（不删除代码）**，仅保留 meta/stats；`MapDebug` 不动 |
| `Server/Zongmen/Web/MapWsHandler.cs`（新） | WebSocket 收发：解析 TileRequest（含 seq 回显）→ 调 service → 组 TileResponse 二进制返回 |
| `Server/Zongmen/Services/MapWorldService.cs` | 拆出 `GetTileResponse(i,j,mask,lastRev)` 单口；settle/poi 从 region 包拆出；维护 `_blockRev` |
| `Server/Zongmen/Engine/js/mapgen.js` | `settlementFor`/`poiFor` 拆成两个独立 generator，产出带 id/owner/tier/state/expireTs |
| `web/js/mapclient.js` | `fetch` 逻辑改为 `WebSocket` 发 `TileRequest`（带自增 seq）、按子消息分发解析 |
| `web/js/pb.js` | 新增 `decodeTileResponse` 分帧解码器（复用现 Reader/zigzag 工具），解析显式 `has` 标记 |
| `web/js/main.js` | 标注层改用新 settleCells/poiCells 缓存 + 独立图层 rev 失效 |

---

## 八、验收口令（开工后对照）

1. `ws://…/map` 一次 `TileRequest{mask=ALL}` 返回单包，内含 chunk/region/settle/poi/comm 五个独立子消息，前端分别解析成功。
2. `mask = Chunk|Region(0x03)` 只回地形+区域，不含 settle/poi/comm；未请求图层不出现在响应中。
3. 请求某图层但该块无数据 → 子消息存在且 `*Has=false`；同 rev 无变化 → 也回 `false`，前端不整块重建。
4. 建筑事件（如某宗门被毁）后，仅该块 `settleRev` 变化；客户端重拉只重发 settle 子消息，前端不整块重建。
5. 全部图数据经 ws；HTTP chunk/region/comm/tile/fields 端点已注释（代码保留），无新请求走 HTTP。
6. 未登录 ws 只能取 Chunk/Region；登录后可取 Settle/Poi/Comm。
7. 请求带 `seq`，服务器原样回显，客户端可核对请求归属；同 seq+同 rev 无变化时响应最小化（空子消息 + `*Has=false`）。

---

## 九、决策拍板记录（五项已定稿）

1. **统一块坐标系** → **方案 B（已定）**：新建单一世界块网格，**块尺寸与现 chunk 完全一致**；region/comm 仅作生成时逻辑层，不独立寻址。见 §六。
2. **子消息空语义** → **方式乙·显式标记**：请求过的图层一定返回子消息 + `*Has` 布尔显式区分有/无数据。见 §3.2。
3. **expireTs** → **本版不实现**：无世界时钟、无时间变化，字段不产出（待"世界演化"阶段）。见 §二/§3.4。
4. **ws seq** → **需要**：请求带自增 seq，服务器原样回显；首版仅回显不做复杂重传。见 §三。
5. **HTTP 图数据端点** → **注释掉调用、保留代码**：chunk/region/comm/tile/fields 相应 Map 分支注释，不删除；确认 ws 稳定后再清理。见 §七。
---

## 十、开工定稿（2026-09-09 已确认）

### 决策落实
1. **settle/poi 归属块**：region 生成后按 `(q,r)` 世界坐标落到所在 chunk，不在本块的实体不返回。
2. **道路按块存**：A* 不再走全局 roadCache；每条路按"相对当前 chunk"裁剪成 pixel 坐标点，直接存当前 chunk。保留 roadVer 语义用于 tile onRoad 失效（roadVer 改为按块或全局统一编号，见实现）。
3. **无灵脉/线概念**：只有"清泉"等**点**概念。移除 `communityOf/commJson/veinNear` 整条 comm 链路（CommunityPack、VeinDto、WorldKeys.Comm）。清泉作为 poi 的一种 type 保留。
4. **无前端去重层**：settle/poi 只由所属块返回，前端直接按块渲染（不重复）。
5. **HTTP 注释**：`chunk/region/comm/tile/fields` 全注释（`Map()` 里不注册），仅留 `meta/stats`；`MapDebug` 保留。

### ws 协议（最终）
- 请求：**JSON 文本** `{"seq":<int>,"seed":"<str>","i":<int>,"j":<int>,"mask":<uint>}`
  - mask 位：0x01 terrain / 0x02 region / 0x04 settle / 0x08 poi / 0x10 预留(清泉并入 poi)
  - `mask=ALL`(0x1F) 全量
- 响应：**protobuf 二进制**（gzip，Content-Encoding 等价不适用——ws 帧内自含，服务端 gzip 压缩 body，前端 inflate）
  - 见 MapMessages.cs 新增 `TileResponse`
- seq/回显：服务端原样回 `seq`，客户端靠 seq 匹配响应（超时重发）。
