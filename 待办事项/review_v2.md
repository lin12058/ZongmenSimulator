# review_v2 — 全部代码审核报告（性能 + 正确性）

> 审核范围：`Server/Zongmen`（C# 后端）+ `web/`（前端）最后一次实质性提交 `24a7d47` 后的完整代码。
> 结论：整体架构清晰、数据流正确；以下按「必改 / 建议改 / 观察项」列出影响性能与正确性的问题。

---

## 一、性能问题（重点）

### P1.1 点击单格详情会触发邻域 3×3 区域的**全量道路 A* 计算**
- **位置**：`Server/Zongmen/Engine/js/mapgen-server.js` 的 `tileJson()`（onRoad 判定）→ 调用 `roadsNear(ci+di, cj+dj, 9999)`。
- **问题**：`maxNew=9999` 表示每次点击，对环绕的每个 3×3 区域格（至多 9 格）都要在 `roadsNear` 内对**该区域内全部聚落对**强制计算 A* 寻路，直到预算 9999 条。A* 内部守卫上限 60000 步（`astar` 里 `guard < 60000`），在每个未缓存聚落对上都是重负载。**玩家在网络地图上每点一格就触发数百次 A* 级计算，属于明显卡顿源。**
- **影响**：首次点击任意格，后端主通路被 IO/CPU 占满；V8 沙箱内纯 JS 循环。
- **建议**：
  1. onRoad 判定改用轻量判断：只做「几何射线 + 区域缓存」或把道路点集缓存在 `roadCache` 里按区域索引，避免对 3×3 邻域重复扫。
  2. 若必须在线判定，把 `maxNew` 降到合理阈值（例如 0/纯读缓存）并在缺路时用保守结果。
  3. 避免 `roadsNear` 内部对每个已缓存 road 重新遍历所有 points。

### P1.2 `elevAt` 与 `fields` 对每个地块重复计算 `veinNear` 显卡开销
- **位置**：`Server/Zongmen/Engine/js/mapgen.js`。
  - `elevAt()` 内部调用 `veinNear(q,r)`（用于地形迁就）。
  - `fields()` 内部调用 `elevAt()`（其已调 `veinNear`），随后 `fields()` 又独立调用 `veinNear(q,r)`（用于灵脉/生态偏置）。
- **问题**：每个地块在计算阶段至少执行 2 次 `veinNear`，且 `veinNear` 固定扫描 3×3 群落格子 × 每条灵脉做 six-hex 距离判断。全量构建区块（`buildChunk` 内逐 tile）时该开销被放大。
- **建议**：`fields()` 复用 `elevAt` 内已算出的 `veinNear` 结果（返回结构带 d/v 或不重复调用），把每个地块的付出减半。

### P1.3 区块构建期逐 tile 调 `fields`，且无整体预计算
- **位置**：`mapgen.js buildChunk()`。
- **问题**：`CHUNK_SCAN=15` 半径下每个区块约 721 个候选格，每个都走 `chunkOfTile→fields→elevAt(递归+缓存)` 与 6 邻居 `fields`（neigh 打包）。虽然 `fieldCache`/`elevCache` 使重复格复用，但首次冷区构建时仍是重计算；若相机快速平移触发多个区块同时冷构建，会长时间阻塞。
- **建议**：保持 LRU 缓存淘汰（已有 evictHalf），但可把 `fields` 的邻域打包改为一次遍历 6 邻居并共享 `elevAt` 结果；若冷启动出现轻微卡顿，可对 `fieldCache` 预填充可见区。

### P1.4 `fieldGrid` / `tileJson` 实时计算无结果缓存
- **位置**：`mapgen-server.js fieldGridJson()` 与 `tileJson()`。
- **问题**：小地图每次 `refreshMinimap` 会对区域内每格调 `fields()`；点击会调 `tileJson()`（含 `settlementsFor` + `roadsNear`）。这些无结果级缓存，反复操作重复计算。
- **建议**：对「区域已算过」的 `regionInfo`/`settlements` 建立结果级 LRU；`tileJson` 的结果可按 `(seed,q,r)` 缓存一段时间（无世界变更）。

### P1.5 浪线/道路静态层一触发就全量重绘
- **位置**：`web/js/main.js` `renderStaticInto()` 中 `drawChunkWaves()` + roads。
- **问题**：`staticNeedsRedraw` 阈值很小（zoom 差 >0.02 或移动 > 阈值即重绘）。一旦重绘，`drawChunkWaves` 遍历所有已加载区块的**每一块 tile**，并对邻域打包用 `Math.floor(nv/Math.pow(8,wn))%8`（每格 6 次 pow）。相机连续缩放/拖动时每帧都可能全量重建静态层。
- **建议**：
  1. 预计算 `Math.pow(8,k)` 数组，循环内替换为查表（省 6×count 次 pow）。
  2. 放大 zoom 触发重绘阈值，或对 zoom 变化做离散化（只在大档位变化才重建）。
  3. 道路顶点数组 `haloV/coreV` 每次重建并重新 `bufferData(DYNAMIC_DRAW)`；可在 chunk 增删时才重建。

### P1.6 后端 SQLite 单连接 + 全局锁串行化所有读写
- **位置**：`Server/Zongmen/Storage/SqliteVirtualContext.cs`。
- **问题**：`GetDataBytes/SetData/Count` 全部 `lock(_gate)`，且只用一个连接。任何并发请求（多 chunk/region 预取）都会被串行化；磁盘 I/O 期间阻塞其他请求。
- **影响**：在 P1.1 修复前，点击引起的 A* + 落库 + 后续流式加载容易形成队头阻塞。
- **建议**：改用读-写锁（`ReaderWriterLockSlim`）或每线程短连接；至少让 `Count` 走独立连接/异步。

### P1.7 内存层与 SQLite 层双层写入重复 IO
- **位置**：`MapWorldService.Store()` 先写 `_mem` 再同步写 `_sql`。
- **问题**：每次区块冷生成都同步落 SQLite（gzip+protobuf 有体积），而内存已有缓存。冷区很多时写放大明显。
- **建议**：可异步/批量落库，或按 LRU 周期 flush；保证崩溃不必全量重算的策略不变。

---

## 二、正确性 Bug

### P2.1 `neigh` 打包用浮点累加 `Math.pow(8,k)`，可能溢出/精度丢失
- **位置**：`mapgen.js buildChunk()` 内 `packed += Math.min(nf.biome,7)*Math.pow(8,k)`，`Math.pow(8,6)=262144`，biome max 7，6 项累加最大值 ≈ 7*(1+8+…+32768)=7*37449=262143，未超 int32。
- **风险**：若某邻域 biome 被覆盖成 8..12（灵脉格），`Math.min(nf.biome,7)` 已夹到 7，不会溢出；但 JS number 双精度足够。**结论：无溢出 bug，但建议改为位运算 `(packed<<3)|min(biome,7)` 更稳。**（低危）
- **正确性提示**：客户端解码 `Math.floor(nv/Math.pow(8,wn))%8` 需与服务端打包次序一致，当前一致。

### P2.2 `roadsNear` 用 `9999` 预算导致行为不可控
- **位置**：`mapgen-server.js` 两个调用点（`regionJson` 给 9999 属可控一次性预计算；但 `tileJson` 的 onRoad 也用 9999 属危）。
- **风险**：在 P1.1 中已述，可能因预算巨大而把道路上首个未缓存聚落对算满到 60000 步守卫，若地形湖泊分隔导致 A* 失败，`roadFail` 累积可缓存，但首次触发长卡顿。
- **修复**：见 P1.1。

### P2.3 `SetData(key,null)` 语义不一致
- **位置**：`Storage/SqliteVirtualContext.cs` 与 `MemoryVirtualContext.cs`。
- **问题**：内存层 `SetData(key,null)` 删除 key；SQLite 层 `SetData(key,null)` 插入 `Array.Empty<byte>()`（空 blob）而不是删除。同一抽象 API 两层语义不一致，若未来业务按「传 null 即删除」写入 SQLite 会产生空值占位。
- **建议**：让 SQLite `SetData(key,null)` 也走 `DELETE`，或文档化约定 Store 永不传 null。

### P2.4 窗口缩放/onResize 后 dpr 变化未重算
- **位置**：`web/js/main.js onResize()` 使用闭包 `dpr`（启动时固定），未在 `matchMedia(devicePixelRatio)` 变化时刷新。若用户把窗口从高分屏拖到低分屏，`dpr` 仍用旧值导致 canvas 分辨率不匹配。
- **建议**：`onResize` 内重读 `window.devicePixelRatio`（保持上限 2），与 main.js 注释一致。

### P2.5 后端未对 `seed` 长度做完整校验
- **位置**：`MapWorldService`/`JsEngineHost.GetOrCreate` 截断 80 字符，但 `WorldKeys.SeedPrefix` 用 SHA1。超长 seed 截断后可能碰撞，且 `GetOrCreate` 截断不通知上层。属低危一致性风险，建议在 entrance 层显式限制或校验。

---

## 三、健壮性 / 观察项

### O1. `veinNearCache` 淘汰阈值 200000 与 elev/field 150000 不一致且淘汰调用在 `veinNear` 内
- 位置：`mapgen.js veinNear()`。
- 影响：缓存分布不均，冷区高峰时 vein 缓存先满触发 O(n/2) 迭代删除；建议统一阈值并按需节奏淘汰。

### O2. `elevAt` 无显式「出生点岛」边界的范围上限
- 位置：`elevAt` 中 `spawn = Math.max(0,1-d0/70)`。d0 超大（远离原点）时 spawn=0，属正常。仅记录。

### O3. 静态覆盖层地图（minimap）对 132×88 全域用 `MMData` 但每帧 `drawMinimap` 重绘
- 位置：main.js `refreshMinimap/drawMinimap`。
- 影响：缩放/拖动时全量 createImageData + putImageData 重绘小地图；建议仅在 mmData 变化或视图窗口变化时重建 mmBase。

### O4. WebGL2 固定 dpr=2 上限
- 位置：main.js `var dpr = Math.min(window.devicePixelRatio || 1, 2)`。高 DPI 屏取 2 会导致 FBO 为 2x；在 P1.5 全量重绘背景下叠加 CPU/GPU 压力。属可接受默认，仅记录。

### O5. `mapgen-server.js metaJson` 明文暴露全部 biomeMeta / CFG 常量
- 位置：`metaJson()`。
- 观察项：若地图后续加入按段位/内容解锁逻辑，需注意。当前纯几何元信息，风险低。

---

## 四、修复优先级建议

| 优先级 | 项 | 说明 |
|---|---|---|
| ★★★ | P1.1 / P2.2 | 点击详情触发邻域全量 A*，是最显著的卡顿/行为失控点 |
| ★★★ | P1.5 | 静态层重绘代价大，缩放拖动卡顿 |
| ★★☆ | P1.2 / P1.4 | 每地块重复 veinNear + 无结果缓存 |
| ★★☆ | P1.6 / P1.7 | SQLite 串行写放大 |
| ★☆☆ | P2.3 / P2.4 / P2.5 | 语义与边界一致性问题 |
| 观察 | O1–O5 | 缓存阈值/常量暴露等 |

---

## 五、备注
- `veinNearCache`/`elevCache`/`fieldCache` 的 evictHalf 逻辑正确（无拼写不一致）。
- 前端 `dpr` 阈值、`hexPath`/图层 z 序逻辑均与注记一致，未发现额外错误。
- 本报告基于 `25a7d47` 之后源码静态审阅；P1.1 建议在修复后用 `verify/verify_map.mjs` 复跑对照（尤其 tileJson 路径）。