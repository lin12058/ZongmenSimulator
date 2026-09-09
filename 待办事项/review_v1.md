# 宗门模拟器 demo3 · 前后端代码审查 v1

> 审核范围：`Server/Zongmen`(C# 后端) + `Server/Zongmen/Engine/js`(世界引擎) + `web/`(前端渲染)
> 结论分级：🔴 高(影响正确性/瓶颈) · 🟡 中(可优化/隐患) · 🟢 低(建议)

---

## 一、后端 C# 服务层

### 🔴 P1. `GetRegionBytes` 从不读 SQLite，`region` 行的落库纯属浪费
`MapWorldService.GetRegionBytes`(L126-154)：
```csharp
var hit = _mem.GetDataBytes(key);      // 只查内存
if (hit != null) return hit;
...
Store(key, gz);                        // _sql?.SetDataDeferred(...)
```
- 检查了 `_sql` 却从不使用 `_mem` 之外的结果。
- 后果：**`db/zongmen.sqlite` 里存的 region 数据永远不会被回读**，冷启动后所有 region 仍需经 JS 重算；存储/占用 100% 浪费。
- 根因(注释已说明)：`region` 与 `tileJson.onRoad` 依赖 VM 的 `roadCache` 热状态，读旧行会导致道路缓存不一致。
- **建议**：`region` 干脆不写 SQLite（省 IO）；或为 `tile` 的 onRoad 引入独立的 `roadKey→set` 持久化，使 region 可安全走 SQLite 读缓存。若维持现状，请在注释中明确说明“仅内存缓存，SQL 落库为兼容旧版遗留”。

### 🔴 P2. `RegionEpoch` + tile 缓存的失效粒度过粗
`_tileCache` 的 key 为 `t:＜seed前缀＞:q:r`，epoch 按 **seed 全局** 推进(L146)。任何一次 `GetRegionBytes` 都会 `++_regionEpoch[seed]`，从而**使该 seed 全部 1024 个 tile 缓存条目同时失效**。
- 后果：多个区域并发/连续流式加载时，之前缓存的 tile 全被清空重算，用户拖动小地图连点时反复重算。
- **建议**：改为按 `(seed, regionI, regionJ)` 粒度的 epoch，只淘汰落在受影响区域内的 tile 条目。

### 🟡 P3. `BuildChunk`/`BuildRegion` 中基础类型数组用 `float/double→BitConverter` 多次拷贝
- `BuildChunk`：`Slice` 复制 6 个字节数组 + `ByteToProto` 再序列化；`B64→byte[]→份段→protobuf→gzip`，一道 chunk 数据在内存中至少拷贝 5 次。
- `BuildRegion` 逐点 `BitConverter.GetBytes(pt.GetSingle())` 分配小数组。
- **建议**：chunk 段可由 JS 直接输出 `Uint8Array` 原始字节经 base64 传输后 C# 零拷贝包装进 proto（用 `MemoryStream` 写各字段引用子数组），减少 `Array.Copy` 与中间数组。量级不大，作为容量优化。

### 🟡 P4. `StatsJson` 里同步 `_sql.Flush()` 可能卡住统计接口
`StatsJson`(L370) 为获得准确计数调用 `_sql.Flush()`，而 Flush 内会打开事务逐条 INSERT，在写入量大时会让 `/api/map/stats` 一个 GET 阻塞数 10~数百毫秒。
- **建议**：统计改为读取 `_pending.Count`（近似值）或仅统计已落库行；避免在只读的 stats 路径触发同步写。

### 🟢 P5. `Enumerable.OrderBy(...).First()` 逐次线性查找淘汰
`JsEngineHost.EvictLocked` 每次新建 VM 用 `OrderBy → First` 找最旧，复杂度 O(n·logn)（n≤MaxSeeds=3，当前无碍）。若未来调大 MaxSeeds 需改为维护最小堆/按需惰性淘汰。

---

## 二、世界引擎 JS（mapgen.js / mapgen-server.js）

### 🔴 P6. `regionCache` / `settleCache` / `roadCache` / `commCache` / `roadFail` 无容量上限
`init()` 只做 `clear()`，而 `ELEV_CAP/FIELD_CAP/VEIN_CAP` 只约束高程/地块/灵脉缓存（L120-122）。区域、聚落、道路缓存**每条随机游走持续累积**：
- 长期运行的单 seed 世界，`roadCache` / `settleCache` 会无限增长，内存与 GC 压力上升。
- `roadFail`(不可达道路集合)同理，只增不减。
- **建议**：仿照 `cacheSet` 给这四类缓存加固定容量（如区域 512、聚落 1024、道路 4096、roadFail 1024），淘汰最旧。

### 🟡 P7. `buildChunk` 邻居 `fields()` 全量重算，未命中 FIELD 缓存时开销高
每个地块扫 6 个邻居做 3bit 打包(L379-382)，且每 chunk 外层再扫 ~721 格。因 FIELD_CAP=30000，一旦视野内 chunk 数量大、`cacheSet` 逐条淘汰，相邻 chunk 共享的邻居格会重复重算。
- **建议**：`buildChunk` 改为一次收集所有需要的地块再统一去重计算并写缓存（相邻 6 格只需算一次），可显著降低大视野下的 CPU。

### 🟢 P8. `cacheSet` 每次插入淘汰 1 条是 O(1)，但淘汰不保证命中率
长期随机游走时 FIELD/ELEV 缓存命中率下降仍会频繁触发 `cacheSet`。影响限于 CPU，若后续调大视野再优化为按行/按区域批量淘汰。

---

## 三、前端渲染与数据加载

### 🟡 P9. `mapclient.fieldGrid()` 未去重并发同窗口请求
`main.js requestMinimap` 用 `mmInFlight` 保证同时只一个请求，但**快速平移相机时新窗口请求会被旧请求结果覆盖后丢失**（旧请求完成后 `mmInFlight=false`，新窗口可能无数据）。当前影响小（下个 tick 会重新请求），但可通过 key 比对丢弃过时响应。

### 🟢 P10. `refreshMinimap` 每像素 `MC.pxToTile` 的浮点开销
132×88=11616 像素 × 相机换算每帧。实际仅在小地图刷新时才执行，非热点，无需优化；如需可做行步进增量。

### 🟡 P11. `setRoads` / Pass1.2 每帧用 `Float32Array` 全量重建道路
`renderStaticInto` 在每次静态层重绘时重建并上传全部道路三角面（含 halo+core 双缓冲）。区块流式频繁时道路数据反复全量重建。
- **建议**：道路几何在 `setRoads` 已经全量上传为非热点，关键是把 `markStaticDirty` 的触发点收敛（已有 200ms 节流），并在真的无道路变化时跳过重建。

---

## 四、已发现的隐性正确性风险（非本轮必改）

### 🟡 P12. `StaticWebMiddleware.IsNotModified` 对空 `If-None-Match` 的处理
`If-None-Match` 存在但值为空串时，`string.Equals("", etag)` 恒 false → 正常回 200。无 bug，但值得约束校验，避免某些客户端发 `If-None-Match: *` 时的语义差异（`*` 不匹配会回 200 全量，浏览器可接受）。

### 🟢 P13. 前端 `chunkQueue`/`regionBusy`/`commBusy` 与 `regenerate` 竞态
已由 `gen` 守卫 + `regenerate` 清空集合覆盖，当前安全。若未来引入“切换种子且不重建缓存”的需求需复查此处。

---

## 五、总体评估

| 类别 | 结论 |
|---|---|
| 正确性 | 核心网格打包(P5 布局)、水去距离哨兵、tile onRoad 语义均对齐，未发现数据错位 bug |
| 性能主瓶颈 | **P1(region 落库浪费)、P2(epoch 失效过粗)、P6(无上限缓存)、P7(邻居重复计算)** 是量大时的四项主占位 |
| 前端流畅度 | 加载有 200ms 静态节流 + 150ms tile 防抖，已收敛；剩余小开销非热点 |

**优先建议排期**：P6(防内存膨胀) → P2(epoch 粒度) → P1(省 IO/存储) → P7(CPU 优化)。P3/P4 属容量调优，可延后。

_生成时间：2026-09-09 · 基于当前仓库代码静态审核，未含压测数据。_