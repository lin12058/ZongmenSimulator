# 代码审查报告 · 宗门模拟器 · review_v3

审查范围：最后一次提交（`git log -1`: `886675f`）全量代码
覆盖：C# 后端（Server/Zongmen）、前端（web/js）、验证脚本（verify）
审查日期：2026-09-09

---

## 一、Bug（按严重度排序）

### P0-1 立体精灵「海拔属性」从未上传 GPU —— 山峰/雪峰高度缩放失效

- **文件**：`web/js/renderer.js` → `InkRenderer.prototype.uploadChunk`
- **位置**：约第 440–450 行
- **问题**：
  ```js
  var pd = [data.propCenters, data.propSprites, data.propHashes, data.propElevs];
  var pl = [1, 2, 3, 4];
  for (k = 0; k < 3; k++) {          // ← 数组/pl 是 4 个元素，循环只遍历 3
      ...
      gl.vertexAttribPointer(pl[k], ...);
      gl.vertexAttribDivisor(pl[k], 1);
  }
  ```
  最后一组 `propElevs`（对应 vertex shader `PROP_VS` 中 `layout(location=4) in float iElev`）**从未被 `vertexAttribPointer` 绑定**。
- **后果**：location=4 属性数据恒为 0，shader 中
  `hs = mix(0.55,1.30, clamp((iElev-0.70)/0.14,...))` 与雪峰 `mix(0.95,1.55,...)` 永远取到 0 档 → **所有山/雪峰精灵始终按最低高度渲染**，海拔驱动的高度变化、山峰高度差异全部丢失（视觉上所有同类山峰一样高）。
- **修复**：`for (k = 0; k < 4; k++)` 或 `k < pl.length`。

### P0-2 服务端 JS 沙箱全串行 —— 并发加载吞吐受限

- **文件**：`Server/Zongmen/Engine/JsEngineHost.cs` → `JsWorldVm.Call`
- **位置**：`SemaphoreSlim _gate = new(1,1)`，每次 `Call` 前 `_gate.Wait()`、finally 里 `Release()`。
- **问题**：同一 seed 世界内所有 JS 计算（chunk / region / comm / tile 生成）被一把信号量**完全串行化**。前端 3–6 并发拉取 chunk 时，服务端实际逐个执行。
- **后果**：多客户端同时进入新区域/多个 chunk 排队时首个耗时明显；V8 解释执行下含 `fields()` 递归的 `buildChunk` 本身不轻，串行会放大延迟。
- **建议**：明确该串行是**为保证共享缓存线程安全**。若需提吞吐，可改为 per-world 细粒度锁或仅对「生成 + 写缓存」加锁、读缓存不加锁（先用 `TryGetValue` 无锁读，未命中再进 gate 生成）。

### P1-3 服务端内存/磁盘缓存无上限 —— 长期漫游无限增长

- **文件**：`Server/Zongmen/Services/MapWorldService.cs`（`_mem`、`SqliteVirtualContext`、`SetData`）
- **问题**：
  - `MemoryVirtualContext` 为 `ConcurrentDictionary`，只增不删；
  - SQLite `Data` 表 `INSERT ... ON CONFLICT DO UPDATE`，同样只增；
  - 前端会 `dropChunk` 释放 GPU 资源，但**服务端缓存永不回收**。
- **后果**：玩家持续探索新区域 → 后端起每个 chunk/region/comm 的 gzip(proto) 无限累积 → 内存与 db 文件无限膨胀。
- **建议**：为内存缓存加 LRU（可按 key 前缀区分 chunk/region），并定期清理 SQLite 中活跃种子之外的旧数据；或至少记录并给出清理策略。

### P1-4 `buildChunk` 存在重复/嵌套缓存污染风险（冷启动偏慢）

- **文件**：`Server/Zongmen/Engine/js/mapgen.js` → `buildChunk`
- **问题**：对区块内每个 tile 都要对**自身 + 6 邻居**依次调 `fields()`，而 `fields()` 内部又可能触发 `elevAt`/`veinNear` 的递归缓存。第一帧加载多个 chunk 时构成较大的冷启动计算量。
- **现状**：结果均有 `fieldCache`/`elevCache`/`veinNearCache` 跨区块复用，chunk 间不重复计算同格；`evictHalf` 在 >15 万条时淘汰一半。
- **建议**：属可接受范围，但可在 `hexDist > CHUNK_SCAN` 时先短路扫描（当前已短路）。无需紧急处理；记录以防后续区块更大或尺度过大时性能退化。

### P1-5 前端 overlay 静态层重建时全量重传道路数据

- **文件**：`web/js/main.js` → `renderStaticInto`
- **位置**：每帧 `drawOverlay` 先 `staticNeedsRedraw` 决定是否重算；一旦需要重算，则把 `roadHaloV`/`roadCoreV` **整批**重新 `bufferData`（`DYNAMIC_DRAW`），且灵脉辐射/名牌/聚落图标全部重绘。
- **后果**：平移超过阈值或 `staticDirty` 频繁置位时，每次整批重建；道路点越多开销越大。
- **建议**：对道路三角面增量/按可见区裁剪；或至少在相机小步平移时复用上一次已上传的 buffer（当前只有当 `|Δcam| > scale` 才触发，基本可接受）。

### P1-6 `JsWorldVm.Call` 每次动态绑定 + `dynamic` 开销

- **文件**：`Server/Zongmen/Engine/JsEngineHost.cs`
- **问题**：每次调用都执行 `dynamic s = _engine.Script.MapGenServer;` 并通过 switch 分支；`dynamic` 调用较慢、无缓存。
- **建议**：缓存 `MapGenServer` 对象为强类型/`COM` 或把 7 个方法名映射为固定委托；对高频 chunk/tile 调用收益明显。

---

## 二、一致性 / 既定设计（确认无问题或低优先级）

### P2 图集/宣纸/噪声纹理生成顺序耦合
- **文件**：`web/js/textures.js`
- `buildAtlas` 逐格重设模块级 `trng = NL.mulberry32(固定种子)`；`buildPaper`/`buildNoise` **不重置** `trng`，依赖 buildAtlas 结束后的随机游标。
- 当前 `boot` 固定顺序 `buildAtlas → buildPaper → buildNoise`，因此纹理稳定。但该顺序是隐式依赖，若未来在中间插入任何额外 `trng()` 消费，paper/noise 将随之变化（外观漂移）。记录为脆弱点。

### P2 前端 `showInfo`/tile 请求无防抖
- 每次点击单独请求 /api/map/tile，无节流。点击节奏快时会产生连续小请求。可加 100–200ms 防抖。

### P2 客户端 `warmRoadsStep` / `warmIdx` 为遗留死代码
- `mapgen.js` 中 `warmRoadsStep`、`warmIdx` 与新注释引用 main.js `warmGap`，但当前前端不再运行生成逻辑，服务端用 `roadsNear(...,9999)` 全量计算。此函数已无调用方，仅增加代码困惑。建议后续清理（低优先级，不影响运行）。

### P2 无符号 vs 有符号 水位字段 (waterD=-1 → 255)
- 前端/后端对 `waterD` 使用 0–4 + 255 哨兵约定，mapgen.js 返回 `-1` 时 C# 转 `255`，前端按 `255 → "较远"` 处理。已核对一致，无 bug。

### P2 chunk 数据相对偏移 int8（cq/cr +16）
- 构建扫描半径 15，理论最大偏移 ±14(<15)，+16 后落在 2–30，均在 u8 内。当前不溢出。**仅当未来增大 CHUNK_SCAN >15 时需同步校验**（否则溢出导致错位）。

### P2 SQLite 单连接 + 全局锁写盘
- `SqliteVirtualContext` 单 `SqliteConnection` + `lock` 串行写。首次加载每个 chunk 同步写盘，存在磁盘 I/O 停顿。建议异步/批量落盘（P2 优化）。

---

## 三、性能总结（按影响排序）

| 优先级 | 项 | 影响 |
|---|---|---|
| P0 | renderer 缺 propElevs 上传 | 山峰高度视觉数据丢失 |
| P0 | JsWorldVm 全串行 gate | 并发 chunk 吞吐受限，latency 上升 |
| P1 | 服务端内存/SQLite 无界增长 | 长期漫游内存与磁盘膨胀 |
| P1 | overlay 重建时整批道路重传 | 平移/缩放时偶发卡顿 |
| P1 | dynamic 调用无缓存 | 每 chunk 冷启动开销 |
| P2 | 纹理生成顺序隐式耦合 | 潜在外观漂移（当前稳定） |
| P2 | tile 请求无防抖 | 连续点击多发请求 |
| P2 | SQLite 同步写盘 | 首次加载磁盘停顿 |
| P2 | 死代码 / 哨兵常量 | 代码可维护性 |

---

## 四、优先修复建议（下一步动作）

1. **立即修复 P0-1**：`renderer.js` 第 442 行 `for(k=0;k<3;k++)` → `k<4`（一行改动），恢复山/雪峰海拔高度渲染。
2. **评估 P0-2**：改进 `JsWorldVm` 并发策略（读缓存无锁、生成加锁），降低多客户端/多区块同时加载延迟。
3. **规划 P1-3**：为 chunk/region/comm 缓存引入 LRU 淘汰与 SQLite 清理策略。

---

*本报告由全量代码审查生成，标注文件与行号对应当前提交。*