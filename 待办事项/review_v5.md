# 宗门模拟器 · 山河图 代码整体审查 (review_v5)

> 审查范围：`Server/Zongmen`（C# 后端）＋ `web/js`（前端渲染）
> 审查日期：2026-09-09
> 结论：**存在 1 个必现崩溃级 bug + 3 个高影响性能/一致性问题 + 若干中低风险项**。建议按“严重度”顺序修复。

---

## S0 · 必现崩溃级：前端 `geo.biomeMeta` 未定义，打开小地图/详情即抛 TypeError（★最优先）

- **位置**：`web/js/mapclient.js` 的 `geo()`（第 26~33 行）
- **表现**：
  - `geo()` 只返回 `hexR / hexW / chunkS / chunkScan / regionM / commCl / commR / seaLevel`，**漏掉了 `biomeMeta`**；
  - 但 `web/js/main.js` 有三处读取 `geo.biomeMeta[...]`：
    - 第 450 行（`refreshMinimap` 小地图配色）：`(geo.biomeMeta[disp] || {...}).color`
    - 第 773 行（点击格详情“地貌”）：`(geo.biomeMeta[m.disp] || {}).name`
    - 第 1055 行用的是 `m.biomeMeta`（来自原始 meta 响应），所以这一处正常，**恰好掩盖了问题**。
- **后果**：一旦小地图请求完成并触发 `refreshMinimap()`，或点击任意格弹出详情，会抛 `TypeError: Cannot read properties of undefined (reading '0')`，进入 `showFatal` 阻塞主循环。当前之所以“看起来能跑”，是因为多数路径在小地图刷新前被后续逻辑兜住或渲染尚未触发——属于典型的“数据夹缝崩溃”。
- **修复**：在 `geo()` 返回对象中补 `biomeMeta: meta.biomeMeta`（一行）。
- **验证**：修后打开页面 → 鼠标滑动触发小地图 → 点击一格看详情，确认不再抛错。

---

## S1 · 高影响：区域包永远「重算不读库」，A*/道路缓存冷启动反复全量重生成

- **位置**：`Server/Zongmen/Services/MapWorldService.cs` 第 124–153 行 `GetRegionBytes`
- **现状**：注释写明“区域包总是经 JS 生成”。代码只查 `_mem`，不查 `_sql`，每次内存淘汰后点击任何区域格都会**重新触发对一整条道路的 A* 全量寻路**（`roadsNear(..., 9999)`）。
- **影响**：
  - 区域分页行已经被反复 `Store(k, gz)` 写进 SQLite，但读取路径永远忽略它们——SQLite 里躺着大量**永远读不到**的冷数据；
  - 在 `tileJson` 的 `onRoad` 语义上，只读内存缓存是**故意**的（防 VM roadCache 与画面不一致），但由此引出了下面的 S2。
- **建议（分层，需与 P4 语义一起评估）**：
  1. 短修：核心把 `_mem` 的容量调大，并对“邻近区域格”做 LRU 保活；
  2. 中修：为“区域 → 道路集合”建立独立的进程内 `Map<seed, (区域, 道路, roadCache指纹)>` 缓存，命中且 roads 指纹一致时直接复用，不必每次都重算；
  3. 长修：把 SQLite 里已生成的区域包**作为“仅当新道路不影响 onRoad 时”的只读备份**，用 `roadCache` 版本号判断新鲜度后直接返回，A* 只做增量。
- **风险提示**：不要简单改成“直接读 SQLite 行”，那会让点击某区域时 vs 地图绘制时的路况不一致（当前注释已踩过坑）。

---

## S2 · 高影响：`chunk`/`comm` 冷数据只走 `_mem` 或 `_sql`，磁盘命中与内存命中路径不对称

- **位置**：`GetChunkBytes`（第 61–85 行）与 `GetCommBytes`（第 212–235 行）
- **现状**：
  - chunk / comm 是 `_mem ?? _sql` 双重读取（这点正确）；但**写路径统一走 `Store(key, gz)` → `_memory.SetData` + `_sql.SetDataDeferred`**。
  - 而 `Session` 级 `_mem` 是 LRU 有界（`MemoryVirtualContext` cap=8192 条，按插入序淘汰），一旦某 chunk 从 `_mem` 淘汰、SQLite 命中后，**不回填 `_mem`**。
- **影响**：
  - 高频漫游时同一 chunk 会反复 SQLite 读（短连接 + 池化，开销可控，但非最优）；
  - 更重要的：`_mem` 淘汰策略是最旧插入，与相机空间相关性弱——用户在某视野内来回扫时，离相机最近的区块可能被“远处先访问的区块”挤掉。
- **建议**：
  1. SQLite 命中后把字节回填 `_mem`（`Store` 仅写也顺带回填），避免二次读库；
  2. `MemoryVirtualContext` 增加“最近使用”更新——命中时把 key 重新入队尾（可接受 O(n) 或维护一个访问计数器），保证空间局部性。

---

## S3 · 中高：渲染线程整帧阻塞风险——`drawChunkWaves` 每帧逐格遍历全部已加载区块

- **位置**：`web/js/main.js` 第 488–552 行 `drawChunkWaves`，由 `renderStaticInto()` 每次静态层重绘时调用
- **现状**：对每个已加载 chunk 内**所有地块**逐格做 `Math.round` 世界坐标反算、hash 取 3 个浮点、`beginPath/arc/stroke`（可能 2~3 次 stroke）。典型视野约 721 格 × 多 chunk，在低端机每帧 Canvas2D 路径过多。
- **影响**：滚动/缩放时静态层频繁重绘（`staticNeedsRedraw` 阈值较小），易掉帧；尤其放大后同屏格子数不降反增。
- **建议**：
  1. 静态层只在“数据变化/跨越阈值”时重绘本身就正确，但请将 wave 绘制改为**对可见格做包围盒裁剪后再进 inner loop**（现在已有 bbox 粗判，但 `bbox` 粒度是 chunk，未到格级）；
  2. 或提前把 `(fr1,fr2,fr3)` 与是否近岸**离线缓存进每 chunk 数组**，避免每帧重算 hash 浮点；
  3. 低端机可把 wave 密度按 `devicePixelRatio/zoom` 降采样。

---

## S4 · 中：`refreshMinimap` 每帧全量计算 `colCache` 且 biomeMeta 缺失（与 S0 同源）

- **位置**：`web/js/main.js` 第 433–459 行
- **说明**：`colCache` 以 `disp` 为键做缓存设计是好的，但因 S0 的 `geo.biomeMeta` 未定义，`colCache[disp] ||= ...` 处会直接抛错，缓存形同虚设。
- **修复**：随 S0 一并解决即可。

---

## S5 · 中：region/comm/road 数据在 `_memory` 中被“先进先出”淘汰，与视角局部性冲突

- **位置**：`Server/Zongmen/Storage/MemoryVirtualContext.cs`
- **现状**：`EvictIfOver` 用 `ConcurrentQueue` 顺序淘汰（`_order.Enqueue` + `TryDequeue`）。
- **影响**：正好对应的就是 S2 提到的“相机在 A 区、却在淘汰 A 区缓存，保留最早访问的 B 区”场景。对服务端这种概率性影响，建议在 `GetDataBytes` 命中时不重置淘汰序（高频请求会持续命中热点），配合 S2 的回填即可大幅缓解。

---

## S6 · 低：`rank` 语义与注释不一致的残余命名 / 死代码

- `verification`/`probe` 目录中 `mapgen-server._countVeins`、`JsEngineHost` 的 `_countVeins` 与注释描述偏离不大，仅提醒后续统一；
- `mapgen.js` `clusterOffset` 里的 `CLUSTER_JIT` 常量、`mapgen-server` 的 `b64FromBytes` 辅助注释“不再用逐段 b64”（遗留说明），可清理；
- `renderStaticInto` 中 `var b = viewBounds()` 在 `ctx.setTransform` 之前调用，若首帧 `clientWidth` 为 0 会有临时 NaN，但被后续覆盖，非阻断。

---

## S7 · 低：SQLite 后台 writer 与只读路径并发

- **位置**：`SqliteVirtualContext` `WriteLoopAsync` 每 250ms 批量落库；读路径为独立短连接（池化并发读）。
- **说明**：已用 WAL + busy_timeout=8000，风险低；但 `PruneExcept` 与 writer 可能在同连接事务交错——当前用 `_flushLock` 保护了批量写入，但 `PruneExcept` 没与 writer 共享同一把锁，极端下 `DELETE` 与新写入可能交错。短期无需处理，若曾出现偶发 `database is locked`，在 `PruneExcept` 外也套 `_flushLock`。

---

## S8 · 低：限流中间件 `AddOrUpdate` 的“重置窗口”判定与计数同帧

- **位置**：`ApiRateLimitMiddleware` 第 41–43 行
- **说明**：加锁内完成“窗口过期→重置→计数+1”，原子性OK；但 `entry.Count > LimitPerIp` 判断以 `old.Count+1` 结果为准（即第 121 次才触发）。5s/120 的阈值对单人连点足够。仅提醒：若未来多实例部署，需要外部存储限流。

---

## S9 · 建议：多实例/长驻下 `MaxSeeds=3` 与“世界按 seed 隔离”的内存边界

- **位置**：`Options.cs` `MaxSeeds=3`，`JsEngineHost` LRU
- **说明**：若未来同时跑多个 seed 观看端，3 个 V8 实例会互相把对方挤出，导致来回切换时反复重建 VM 并重跑 `init`。当前单 seed 场景没问题；扩展时把 `MaxSeeds` 提到连接数/并发 seed 数即可。

---

## 修复优先级总表

| 级别 | 编号 | 摘要 | 建议 |
|------|------|------|------|
| S0 崩溃 | 必现 | `geo()` 缺 `biomeMeta`，打开小地图/详情抛 TypeError | 一行补字段 |
| S1 性能 | 高 | 区域包重算不读库，A* 冷启动全量重生成 | 追加 roads 指纹缓存/增量 |
| S2 性能 | 高 | chunk/comm SQLite 命中不回填 `_mem` | SQLite 命中后回填 + LRU 访问热更新 |
| S3 性能 | 中高 | `drawChunkWaves` 逐格整帧计算+多次 stroke | 离线缓存 hash / 格级裁剪 |
| S4 | 中 | 小地图 colCache 因 S0 失效 | 随 S0 修复 |
| S5 | 中 | 内存淘汰顺序与视角局部性冲突 | LRU 热更新 |
| S6 | 低 | 注释/死代码清理 | 顺手 |
| S7 | 低 | Prune 与 writer 锁分离 | 视偶发锁定补锁 |
| S8 | 低 | 限流单机语义 | 多实例时注意 |
| S9 | 低 | MaxSeeds 内存边界 | 扩展时调整 |

---

### 已确认无问题（避免误修）
- protobuf 字段号/压缩链路（`Content-Encoding:gzip` + `fetch` 透明解压）：前后端一致，无错位。
- ZigZag 负号问题：`ChunkPayload`/`RegionInfo`/`TileQuery` 的带符号整型均已 `ZigZag`，前端对应 `sint` 解码正确。
- `regenerate()` 清状态 + `gen` 版本守卫：旧世界回调不会污染新世界，正确。
- 区域 `onRoad` 只读已生成道路的语义与地图绘制一致（在 S1 未改前此设计是安全的）。