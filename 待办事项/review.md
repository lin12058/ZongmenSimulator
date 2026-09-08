# 宗门模拟器 · 合并代码审核待办清单（review.md）

> 由 review_v1 ~ review_v5 五份审核报告去重合并而成。
> 覆盖：Server/Zongmen（C# .NET8 后端）+ web/（前端）+ verify 验证链路。
> 优先级说明：🔴 必改（功能错误/崩溃风险）→ 🟠 建议（明确性能瓶颈）→ 🟡 可选（健壮性/维护性）。命中数 = 五份报告中独立提及该主题的次数。

---

## 一、🔴 功能 Bug（必须修复）

### B1. 立体精灵海拔通道从未上传 GPU → 山/雪峰/灵脉峰高度全部失效 【命中 2】
- **位置**：`web/js/renderer.js` `uploadChunk()` 精灵段（约 440–450 行）
- **现象**：
  ```js
  var pd = [data.propCenters, data.propSprites, data.propHashes, data.propElevs]; // 4 元素
  var pl = [1, 2, 3, 4];
  for (k = 0; k < 3; k++) { ... }   // ← 只遍历 3，propElevs(location=4) 永不绑定
  ```
- **后果**：`iElev` 输入恒为默认 0 → `PROP_VS` 中山峰 `hs=mix(0.55,1.30,...)`、雪峰 `hs=mix(0.95,1.55,...)` 永远取最低档 → **所有山变矮、雪峰无高度差、灵脉峰高度失效**。
- **修复**：`for (k = 0; k < 4; k++)` 一行改动。注意 `vertexAttribPointer` size 判断：仅 `pl[k]===1`（centers）为 2，其余（含 iElev）均为 1。
- **来源**：review_v3 (P0-1)、review_v5 (B1)
- **✅ 2026-09-09 已修复**：`web/js/renderer.js` L442 循环改为 `k < 4`，location=4 `iElev` 与其余属性一同绑定（`vertexAttribPointer` size 分支本已正确）。已核对 PROP_VS `layout(location=4) in float iElev` 声明一致；真实浏览器会话上传大量区块无异常。

### B2. chunk 请求一次失败即永久静默 → 地图永久空洞 【命中 3】
- **位置**：`web/js/main.js` `loadChunk()` / `chunkFail`
- **现状**：`catch` 里 `chunkFail.add(key)` 后 `updateStreaming` 不再重试，本会话该区块永远空洞；仅 `regenerate()` 可清空。
- **后果**：网络抖动 / 一次瞬时 5xx 就造成不可恢复缺块。
- **修复**：区分「确定错误(404)」与「可重试错误(网络/5xx/超时)」；可重试项采用**指数退避**后重试；保留 `regenerate()` 清空兜底。
- **来源**：review_v1 (1.2)、review_v4 (1.2)、review_v5 (R1)
- **✅ 2026-09-09 已修复**：`web/js/main.js` 新增 `chunkRetry` 表（退避计划）。`loadChunk` 失败时 `HTTP 404` → `chunkFail`（确定放弃）；网络/5xx/超时 → `scheduleChunkRetry` 记 0.8s→30s 封顶的指数退避，`updateStreaming` 队列重建按 `rr.at` 过滤、到期自动重试（服务恢复后地图自愈）；离开视野的记录即时清理、`regenerate()` 同步清空。`performance.now()` 计时在每帧 `updateStreaming` 中驱动，无需额外定时器。

### B3. seed 超过 80 字符被截断 → 世界碰撞 【命中 2】
- **位置**：`Server/Zongmen/Engine/JsEngineHost.cs` `GetOrCreate`
- **现状**：`seed = seed.Length > 80 ? seed[..80] : seed;` 两个 80 字符前缀相同的不同种子会共享同一世界 → LRU 命中错世界，破坏离线确定性。
- **修复**：用完整字符串作 key，或改用 SHA1 哈希作 key，勿截断。
- **来源**：review_v1 (1.3)、review_v4 (1.3)，review_v3 (P2.5 列为低危一致性问题)
- **✅ 2026-09-09 已修复**：`Server/Zongmen/Engine/JsEngineHost.cs` 删除 `[..80]` 截断，VM key 与 `init(seed)` 均使用完整 seed（与 `WorldKeys.SeedPrefix` 对完整 seed 做 SHA1 的持久化口径一致）。黑盒实测：两个 86 字符、前 80 字符相同的种子，chunk(0,0) 响应字节不同（世界已隔离）；同种子两次请求字节一致（确定性无回归）。

---

## 二、🟠 性能热点（明确瓶颈，建议修复）

### P1. `updateStreaming` 每帧全量重建需求集 + 排序 【命中 3】
- **位置**：`web/js/main.js` `updateStreaming()`（主循环每帧调用）
- **现状**：每帧执行 `viewBounds → tileBoundsOf → 三层象限扫描 + chunkData.forEach 全量卸载判断 + chunkQueue.sort`；相机静止时全部冗余；队列为空仍调用 `pumpChunks/pumpExtra`。
- **修复**：相机位移超过阈值（复用 `staticNeedsRedraw` 的 `scale` 思路）才重算；队列空时跳过 pump。
- **来源**：review_v1 (2.3)、review_v4 (2.1)、review_v5 (P7)
- **✅ 2026-09-09 已修复**：`web/js/main.js` 增 `lastStream` 状态（NaN 初值 + `regenerate()` 重置），相机位移/缩放/视口尺寸未超阈值（`16/(zoom*0.75+0.25)` 世界px）且 `chunkRetry` 无到期项时直接 `pumpChunks/pumpExtra(缓存 queue)` 并 return；首帧/重铸后 NaN 强制全量重建。在途完成回调的 pump 自驱不动摇加载流。

### P2. 浪线邻域解码用 `Math.pow(8, k)` 【命中 3】
- **位置**：`web/js/main.js` `drawChunkWaves`；`Server/.../mapgen.js` `packNeigh` 同理
- **现状**：每个已加载 tile × 6 邻居各一次浮点 `Math.pow(8, wn)`，区块多时为主要 CPU 开销。
- **修复**：查表 `[1,8,64,512,4096,32768]` + 位运算 `(neigh >> (3*wn)) & 0x7`；`packNeigh` 侧同步改为查表左移。
- **来源**：review_v1 (2.4)、review_v3 (P1.5)、review_v4 (2.2)
- **✅ 2026-09-09 已修复**：`drawChunkWaves` 解码 `Math.floor(nv/Math.pow(8,wn))%8` → `(nv>>(wn*3))&7`；`mapgen.js buildChunk` 打包 `+=min(biome,7)*Math.pow(8,k)` → `|=min(biome,7)<<(k*3)`（biome≤7 无进位重叠，数值一致）。GLSL 端 `pow(8.0,k)` 保持不动。

### P3. `elevAt` / `fields` / `veinNear` 缓存淘汰阈值过大、一次性长停顿 【命中 3】
- **位置**：`Server/Zongmen/Engine/js/mapgen.js`（`elevCache`/`fieldCache`/`veinNearCache`）
- **现状**：`size > 150000/200000` 才 `evictHalf`；且 `evictHalf` 在超大 Map 上一次循环 `delete` 是长停顿；另 `fields()` 与内部 `elevAt()` 对每格重复调用 `veinNear`。
- **修复**：固定容量（如 1 万条）+ FIFO 或时间戳惰性淘汰；`evictHalf` 分批执行避免卡顿；`fields()` 复用 `elevAt` 已算出的 `veinNear` 结果（减少 50% 重复计算）。
- **来源**：review_v1 (2.4 P2)、review_v3 (P1.2/O1)、review_v4 (2.3)
- **✅ 2026-09-09 已修复**：删 `evictHalf`，新增 `cacheSet(m,key,val,cap)` 每次插入超 cap 即 `m.delete(m.keys().next().value)` 单条淘汰（摊薄成本）。固定容量 `ELEV_CAP=40000 / FIELD_CAP=30000 / VEIN_CAP=40000`。新增内部 `elevAtVN(q,r,vn)`，`fields()` 先 `vn=veinNear(q,r)` 一次再传 `elevAtVN`，消除 fields/elevAt 重复扫描。

### P4. 点击单格详情触发邻域全量道路 A*（`roadsNear(...,9999)`）【命中 2，且属最大卡顿源】
- **位置**：`Server/Zongmen/Engine/js/mapgen-server.js` `tileJson()` onRoad 判定；`regionJson()` 每格同款
- **现状**：点击一次对 3×3 邻域每格调 `roadsNear(ci+dj, cj+dj, 9999)`（无预算上限），首访区域可对全部聚落对跑满 60000 步 A* 守卫，玩家连点会连续触发全量道路计算 → 明显卡顿。
- **修复**：
  1. onRoad 改用轻量判断（几何射线 + 区域道路缓存）；把道路点集按区域索引进 `roadCache`。
  2. 若必须在线判定，把 `maxNew` 降到读缓存阈值，缺路时用保守结果。
  3. `regionJson`/`warmRoadsStep` 后台渐进预热，避免每格一次性 `9999` 无预算。
- **来源**：review_v1 (2.2)、review_v3 (P1.1/P2.2)、review_v4 (2.4)
- **✅ 2026-09-09 已修复**：`tileJson` onRoad 改 `roadsNear(...,0)` 纯读 `roadCache`（点击零 A*）；`regionJson` 内 `roadsNear(...,9999)` 保留为权威生成路径。配套：`MapWorldService.GetRegionBytes` 改为**总是经 JS 生成**（不直读 SQLite）— 保证 VM `roadCache` 与 `onRoad` 面板一致；同会话 `_mem` 命中免重复生成。`verify/verify_map.mjs verifyTile` 在 `init` 后、`tileJson` 前先模拟客户端流式拉 3×3 区域包对齐两端道路缓存（与 P4「只读缓存」语义一致），3 次连续全绿。

### P5. 服务端 chunk 走「JSON + base64」中转 【命中 1，但为生成期主要开销】
- **位置**：`Server/Zongmen/Engine/js/mapgen-server.js` + `MapWorldService.cs`
- **现状**：JS 端每个 byte 数组 `b64FromBytes → JSON.stringify → C# Parse → Convert.FromBase64String → protobuf → gzip`。base64 膨胀 33%，JSON 序列化 + 双转码 + JS 大字符串分配是每次生成 chunk 的主要 CPU/GC 开销。
- **修复**：若能 ClearScript 字节直传则省去 base64+JSON；否则把大量定宽字段（cq/cr/tiles/elev/hash/neigh/pdx/pdy...）合并为**单段定宽缓冲**再 base64，减少 JSON key 数量。
- **来源**：review_v1 (2.1)
- **✅ 2026-09-09 已修复**：`chunkJson` 输出合并为单段定宽缓冲（11nB 地块 + 13pnB 精灵，全小端），JSON 仅 `{ca,cb,count,pn,d}`。`MapWorldService.BuildChunk` 用新 `Slice(raw,o,len)` 切回 `ChunkPayload`（含长度断言）。删除旧 `f32bytes/u16bytes/u32bytes/u8bytes/tileBytes/toU8` 辅助。

### P6. SQLite 单连接 + 全局锁串行化读写；双层写放大 【命中 2】
- **位置**：`Server/Zongmen/Storage/SqliteVirtualContext.cs`、`MapWorldService.Store()`
- **现状**：`GetDataBytes/SetData/Count` 全部 `lock(_gate)` + 单连接；任意并发请求被串行，磁盘 I/O 期间阻塞其它请求。`Store()` 同时写内存与 SQLite，冷区每次同步 gzip/protobuf 落库 → 写放大。
- **修复**：读走 `ReaderWriterLockSlim` 或每线程短连接；至少 `Count` 独立异步；冷生成**异步/批量落库**，按 LRU 周期 flush。
- **来源**：review_v3 (P1.6/P2)、review_v5 (P2)
- **✅ 2026-09-09 已修复**：`SqliteVirtualContext` 重写 — 每操作短连接（`Pooling=True` + `PRAGMA busy_timeout=8000`），启动时 `PRAGMA journal_mode=WAL`（库级持久）使读/写并发；`SetData` 改为入 `ConcurrentQueue`，后台 `WriterLoopAsync` 每 250ms `BeginTransaction` 批写；失败退回队列重试不阻塞请求路径。`MapWorldService.Store → SetDataDeferred`；`StatsJson` / `Dispose` 前 `Flush()`。

### P7. `JsWorldVm.Call` dynamic 动态绑定无缓存 【命中 1】
- **位置**：`Server/Zongmen/Engine/JsEngineHost.cs` `Call`
- **现状**：每次调用 `dynamic s = _engine.Script.MapGenServer;` + switch 分支；`dynamic` 调用慢、无缓存。
- **修复**：缓存强类型 `MapGenServer` 句柄，或把 7 个方法名映射为固定委托；对高频 chunk/tile 收益明显。
- **来源**：review_v3 (P1.6)
- **✅ 2026-09-09 已修复**：`private readonly dynamic _svc = _engine.Script.MapGenServer;` 构造时一次缓存，`Call` 7 个 switch 分支全部走 `_svc.xxx`，不再每次取 Script 属性；`Call("init", seed)` 顺序调到 `_svc` 赋值之后。

### P8. 内存/SQLite 缓存无上限 → 长期漫游无限增长 【命中 1】
- **位置**：`MapWorldService` `_mem`、`SqliteVirtualContext.SetData`
- **现状**：`ConcurrentDictionary` 只增不删；SQLite `INSERT ... ON CONFLICT` 只增；前端 `dropChunk` 只释放 GPU，服务端缓存永久累积。
- **修复**：内存缓存加 LRU（按 key 前缀区分 chunk/region/comm）；定期清理活跃 seed 之外的 SQLite 旧数据；或至少记录并给出清理策略。
- **来源**：review_v3 (P1.3)
- **✅ 2026-09-09 已修复**：`MemoryVirtualContext` 加容量上限（默认 8192），`SetData` 走 `TryAdd` 区分新/旧入 `ConcurrentQueue<string> _order`，`_map.Count>cap` 时按入队序逐条 `TryRemove`（残留 entry 容错）。`SqliteVirtualContext.PruneExcept(seedPrefixes)` 拼接 `DELETE ... WHERE NOT (Key LIKE $p0 OR $p1 ...)`。`MapWorldService.StatsJson` 每 20 次 stats 调用触发一次清理，活跃 seed 前缀取自 `JsEngineHost.Seeds` 快照。

---

## 三、🟡 健壮性 / 一致性 / 维护性（可选，排期靠后）

### R1. 静态层 dirty 粒度过粗 【命中 2】
- `web/js/main.js`：`staticDirty = true` 在每 chunk 上传成功后无条件置位 → 连续加载 N 个 chunk 静态层重绘 N 次。
- **修复**：合并 dirty（200ms 节流）或记录待重绘区域。
- **来源**：review_v1 (3.3)、review_v4 (3.3)
- **✅ 2026-09-09 已修复**：`markStaticDirty()` 距上次重绘 ≥200ms 立即置位、否则 `setTimeout(200)` 合并；`forceStaticDirty()` 用于卸载/重铸（绕过节流）；`renderStaticInto` 末尾清挂起 timer 并写 `lastStaticDraw`。loadChunk/loadExtra 改走节流，dropChunk/regenerate 走强制。

### R2. 静态中间件无缓存头 / ETag 【命中 3】
- `Server/Zongmen/StaticWebMiddleware.cs`：每次 `File.ReadAllBytesAsync` 全量读文件 + `Cache-Control: no-cache`，无 ETag/304。
- **修复**：按 mtime 生成 ETag + `Last-Modified`，或小文件内存缓存。
- **来源**：review_v1 (2.5)、review_v4 (2.5)、review_v5 (R4)
- **✅ 2026-09-09 已修复**：按 mtime+length 生成弱 ETag（`"<ft:x>-<len:x>"`），并发支持 `If-None-Match`/`If-Modified-Since` 命中返回 304。`HEAD` 不回体。`ConcurrentDictionary<fullPath, CachedFile>` 内存缓存 ≤8MB 文件 + 64 项上限（mtime 变即刷新）。`Cache-Control: no-cache` 维持语义。探测验证：200/304/不匹配-200 全对。

### R3. 服务端用浮点反解圆心偏移 → 大坐标可能错位 【命中 2】
- `mapgen-server.js` `chunkJson`：先 `Math.round(fy/(1.5*HEX_R))` 反解 r 再反解 q；客户端用 `ca*S+(cq[i]-16)` 正向还原。大坐标下浮点累计可能差一格。
- **修复**：服务端直接按轴向坐标 (q,r) 存整数相对偏移，不做浮点反解。
- **来源**：review_v1 (3.1)、review_v4 (3.1)
- **✅ 2026-09-09 已修复**：`mapgen.js` `buildChunk` 收尾在 data 中增加 `qrel/rrel` 数组（与 tiles 同序，记录每个 tile 整数相对偏移 dq/dr）；`mapgen-server.js` `chunkJson` 改 `dv.setUint8(oCq+i, d.qrel[i]+16)` / `setUint8(oCr+i, d.rrel[i]+16)`——不再 `Math.round(fy/(1.5*HEX_R))` 反解。客户端 `pb.js#chunkToArrays` 不变（`qa = ca*S+(cq-16)` 仍精确等价）；verify_map 相对坐标还原 ≤1e-3px + centers 精度全绿；大坐标 chunk `(1000,500)/(-800,1200)/(20000,-15000)` 全部 200。

### R4. 卸载后回调仍可能回填出视野的格子 【命中 2】
- `web/js/main.js` `loadExtra` 回调：`regionCells.set/commCells.set` 无"是否仍在需要窗口"校验，可能把刚出视野的格子数据塞回 → 短暂内存残留 + 与卸载冲突。
- **修复**：回调前校验 `keepR.has(key)`。
- **来源**：review_v1 (3.2)、review_v4 (3.2)
- **✅ 2026-09-09 已修复**：模块级 `keepChunk/keepR/keepC` Set 集合，`updateStreaming` 全量重建时刷新；`loadChunk`/`loadExtra` 回调前 `if (!keep*.has(job.key)) return;`（防已卸载格子被回填 + 与卸载冲突；chunk 端同步防御避免重新上传 GPU）。`regenerate` 重置三集合。

### R5. tile 请求无防抖 【命中 2】
- 每次点击单发 `/api/map/tile`，无节流；连点产生连续小请求。
- **修复**：加 100–200ms 防抖。
- **来源**：review_v3 (P2)、review_v4 (categorie 其他/P2)
- **✅ 2026-09-09 已修复**：`showInfo()` 改为 `infoTimer`/`infoPending` 防抖壳，150ms 内连点只发最后一次；原主体抽为 `requestTileInfo(tile)`。`hideInfo()` 关闭面板同时 `clearTimeout(infoTimer)` 避免关闭后仍弹出。

### R6. 服务端并发 tile/fields 无节流上限 【命中 1】
- 无 per-IP 限流；高频刷新会钉死 V8 门闩。
- **修复**：中间件层加简单 per-IP 限流。
- **来源**：review_v5 (R6)
- **✅ 2026-09-09 已修复**：`Server/Zongmen/Web/ApiRateLimitMiddleware.cs` 新增，Program.cs 注册在 StaticWebMiddleware 之后。仅拦截 `/api/map/tile` + `/api/map/fields` 两个即时计算端点（chunk/region/comm 持久化缓存兜底不限流）。固定窗口 5s/120 次/IP，超限 429 + `Retry-After`。单 IP 字典超 1024 项时按 1/1024 概率触发清理过期条目。探测：200 连发成功 120 后触发 429。

### R7. 渲染每帧全量遍历所有已加载 chunk，无视锥剔除 【命中 1】
- `renderer.render()` Pass1/Pass1.5 均 `chunks.values()` 全量迭代 + drawArraysInstanced；chunk 数到几十上百后，远离相机的也在消耗 CPU/GPU。
- **修复**：对 chunks 做 AABB 与 viewBounds 的粗剔除，只绘制相交 chunk。
- **来源**：review_v5 (P1)
- **✅ 2026-09-09 已修复**：`uploadChunk` 接收 bbox 存到 chunk 记录（main.js 计算并传入，省重复遍历）；`render()` 中 `_viewBox(cam)` 算 CSS 像素可视世界矩形（`(w/dpr)/2/zoom` 半宽/高），`boxHits(box, vb, pad)` AABB 相交测试。Pass1 pad=hexR*2.2，Pass1.5 pad=hexR*12（山峰/聚类偏移容差）。headless 渲染图无遗漏。

### R8. Tile/FieldGrid 不落库，全部即时计算堵在单线程 V8 【命中 1】
- 小地图 0.4–1.5s 轮询 + 点击频繁时，`SemaphoreSlim(1)` 门闩成为吞吐瓶颈。
- **修复**：field/tile 结果按 (seed,q,r) LRU 缓存；小地图降频或后台预取；必要时支持每 seed 多实例并行。
- **来源**：review_v5 (P3)
- **✅ 2026-09-09 已修复**：`GetFieldGridJson` 缓存 JSON 文本（key=seed 前缀+窗口，cap 64）——纯确定性、无 VM 共享状态依赖，安全。`GetTileBytes` 缓存 gz bytes（key=tile+seed 前缀+q+r，cap 1024），值带 region epoch——`GetRegionBytes` 每次经 JS 生成时 `_regionEpoch[seed]++`（可能新增道路），使旧 tile 缓存的 onRoad 自动失效，避免 P4 教训的语义回归。同 seed 多实例并行未做（与 P4 共享 roadCache 语义冲突，破坏一致性）。客户端降频已有 minimapTimer 0.4/1.5s + R5 tile 防抖。探测：tile/fields 同请求字节/JSON 一致。

### R9. 同 chunk 首 miss 无 in-flight 去重 【命中 1】
- 高并发下多请求同时 miss 同一 chunk → 重复 buildChunk + 重复写库。
- **修复**：加 per-key in-flight 合并（CompletableFuture 风格）。
- **来源**：review_v5 (P4)
- **✅ 2026-09-09 已修复**：`MapWorldService.cs` `ConcurrentDictionary<string, object> _buildGates` + lock per key + 双重检查；同 key 并发 miss 只 build 一次，其余等待者 double-check 命中 `_mem` 直接返回；finally `TryRemove` 释放门闩（不删除 → 新 miss 走缓存直返）。同样逻辑覆盖 region/comm。探测：24 并发同 key miss 88ms 全一致。

### R10. 全局调试句柄残留 【命中 1】
- `web/js/main.js` `window.__cam/__renderer/__data` 无条件暴露。
- **修复**：用 `if (DEBUG)` 包裹。
- **来源**：review_v1 (3.4)
- **✅ 2026-09-09 已修复**：`var DEBUG = URLSearchParams('debug=1|capture=1')` 开启，`window.__cam/__renderer/__data` 包裹 `if (DEBUG)` 内。`verify/cdp_probe.mjs` 默认 URL 追加 `&debug=1` 保留状态探测能力。

### R11. `configure()` 清缓存未同步 region/roadCache 【命中 1】
- 若未来 `REGION_M` 可配置，需同时清理 `regionCache/settleCache/roadCache/roadFail`。
- **来源**：review_v1 (四/2)
- **✅ 2026-09-09 已修复**：`mapgen.js` `configure()` 在原 `commCache/veinNearCache/elevCache/fieldCache.clear()` 基础上追加 `regionCache.clear(); settleCache.clear(); roadCache.clear(); roadFail.clear();`——CFG 任何参数变化（包括未来 REGION_M 可配置）都不会留下新旧混用缓存。

### R12. 队列/其他常数与死代码 【命中 1】
- `CONC_CHUNK/CONC_EXTRA` 魔法数字非配置化；`mapgen.js` 中 `warmRoadsStep/warmIdx` 为无调用方死代码。
- **建议**：收敛到常量对象；清理残留死代码。
- **来源**：review_v1 (四/1)、review_v3 (P2)
- **✅ 2026-09-09 已修复**：`web/js/main.js` `CONC_CHUNK/CONC_EXTRA/CHUNK_RETRY_BASE_MS/CHUNK_RETRY_MAX_MS` 收敛为单一 `NET_CFG` 常量对象。`mapgen.js` 删除 `warmRoadsStep` 函数 + `warmIdx` 变量 + L671-674 注释块 + L842 导出（grep 确认无调用方）。

### R13. 纹理生成顺序隐式耦合 【命中 1】
- `buildAtlas` 重置 `trng`，`buildPaper/buildNoise` 不重置，依赖 `boot` 固定顺序。中间插入任何消费 `trng()` 的代码都会导致外观漂移。
- **建议**：在各自构建函数开头显式重置种子。
- **来源**：review_v3 (P2)
- **✅ 2026-09-09 已修复**：`textures.js` `SEED_ATLAS/SEED_PAPER/SEED_NOISE` 各自独立常量（当前都取 20260906）。`buildAtlas`/`buildPaper`/`buildNoise` 函数开头 `trng = NL.mulberry32(SEED_*)`——不再依赖 boot 顺序 `atlas→paper→noise`，中间插入消费 `trng()` 的代码不会再造成下游纹理外观漂移。**注意**：buildPaper 原先依赖 buildAtlas 末尾 trng 状态，重置后纸张纹理外观会略有变化（程序化水墨风格近似，无参照基准，可接受一次漂移换取确定可复现）。

---

## 四、建议修复顺序（合并后的执行计划）

### 第一波（下次发版必含）
1. **B1**：renderer.js `k<3 → k<4`（一行，恢复山/雪峰高度）
2. **B2**：chunk 失败退避重试（消除永久空洞）
3. **B3**：seed 不再截断，改完整串/哈希 key
4. **P4**：tileJson onRoad 去全量 A*（最大卡顿源）

### 第二波（性能优化）
5. **P1** updateStreaming 相机阈值跳过
6. **P2** 浪线/neigh 查表位运算
7. **P3** 缓存固定容量 + 分批淘汰 + fields 复用 veinNear
8. **P6** SQLite 读写锁 / 异步批量落库

### 第三波（稳健性，择机）
9. **P5** JSON+base64 中转优化
10. **P7** dynamic 调用缓存
11. **P8** 服务端缓存 LRU 上限
12. **R1–R13** 按需排期（防抖、ETag、视锥剔除、in-flight 去重等）
    - **2026-09-09 全部闭合 ✔**：R1 静态层 200ms 节流 / R2 静态 ETag+304+小文件内存缓存 / R3 整数轴向偏移替代浮点反解 / R4 keepR/keepC/keepChunk 回填校验 / R5 tile 150ms 防抖 / R6 ApiRateLimitMiddleware 5s/120/IP tile+fields / R7 渲染视锥粗剔除 / R8 tile+fieldGrid LRU（fieldGrid 纯确定性 / tile 按 region epoch 失效） / R9 chunk/region/comm per-key in-flight 去重 / R10 DEBUG 门控 / R11 configure() 清 region+settle+road+roadFail / R12 NET_CFG 常量收敛 + warmRoadsStep 死代码清理 / R13 buildAtlas/buildPaper/buildNoise 各自显式重置种子。

---

## 五、验证与回归

- 修复后用 `verify/verify_map.mjs` 复跑全量对照（310 项检查，含 chunk(0,0) 逐点核对）。
- **B1 修复后**重点检查 `uploadChunk` 的 `vertexAttribPointer` size：`pl[k]===1 ? 2 : 1`，确保 iElev 以标量(1)绑定。
- **B2/B3 修复后**确认 `/api/map/stats` `dbRows>0` 且重启后二次请求 proto 解压字节一致。
- 性能项（P1/P2/P4）建议在真机上抓一次主线程/后端 CPU 前后对比再合入。

---

*生成说明：由 review_v1~v5 五份报告去重合并，重复项已在「命中 n」标注。文件行号基于各报告摘抄，修前请以当前 HEAD 实读为准。*