# 宗门模拟器 demo3 · 全量代码审核报告（review_v4）

> 审核范围：`Server/Zongmen`（C# .NET8 后端 + 引擎 JS）+ `web/`（前端渲染）
> 审核方式：逐文件静态审阅，重点排查 **性能隐患** 与 **并发/内存 bug**
> 审核日期：2026-09-09

---

## 0. 结论摘要

整体结构清晰（服务端权威 + 前端只读渲染），无致命逻辑错误，但存在 **两类需要处理的隐性问题**：

| 等级 | 数量 | 说明 |
|------|------|------|
| 🔴 高 | 1 | 引擎 JS 中 `regionCache / settleCache / commCache / roadCache` **无容量上限** → 无限探索下内存持续增长 |
| 🟠 中 | 4 | 见各节：`MapWorldService` 双写路径、`Flush` 竞争、`EvictLocked` 排序、前端 `error` 兜底过宽 |
| 🟡 低 | 若干 | 均为非阻塞性优化建议 |

**整体性能在正常交互量级（单用户、千级区块）下没有问题**，以下问题集中在「长期漫游 / 极端参数」场景。

---

## 1. 后端 C#（Server/Zongmen）

### 1.1 🔴 mapgen.js 缓存无上限（核心内存隐患）
位置：`Engine/js/mapgen.js`
- `elevCache/fieldCache/veinNearCache` 通过 `cacheSet()` 有 `ELEV_CAP/FIELD_CAP/VEIN_CAP` 上限；
- 但 **`regionCache (L459)`、`settleCache (L535)`、`roadCache (L666)`、`commCache (L760)` 全部是裸 `Map.set()`，永不淘汰**。

影响：玩家持续向新区域移动时，每次 `BuildRegion/GetRegionBytes` 都会向 VM 内这四个 Map 追加新条目，进程内 `JsEngineHost` 的 V8 堆随探索面积线性增长，只增不减（与世界同尺度），最终触发 GC 压力/OOM。**这是长期运营最需要修复的一项。**

建议：将四个缓存也改为固定容量（可复用 `cacheSet`），或按「最近活跃」淘汰最旧区块条目；`roadCache` 用 `a|b` Key，淘汰时注意与 `roadFail` 的一致性（只淘汰，不改语义）。

---

### 1.2 🟠 MapWorldService 区域包双写路径（内存/语义重复）
位置：`Services/MapWorldService.cs`
- `GetRegionBytes()` **只查 `_mem`、不查 `_sql`**；`Store()` 同时写 `_mem` 与 `_sql`（SQLite 异步落库）。
- `MemoryVirtualContext` 容量默认 8192 条，区域包被挤掉后再次 get 会**完全重新走 JS 生成**，SQLite 里那条旧行永远不会被读回（故意为之：保证 onRoad 语义一致）。

影响：SQLite 中的 region 行实际是“只写不读”的冗余数据，随地图增长占用磁盘与写放大；且内存缓存淘汰后重建成本高（每次重建都要 A* 全量算路）。

建议：要么给 region 也按 eras 使 SQLite 可命中（同时保证 roadCache 一致性），要么明确去掉 region 的 `_sql` 落库（仅留内存），减少写放大。

---

### 1.3 🟠 SqliteVirtualContext.Flush 的并发写入竞态（低概率）
位置：`Storage/SqliteVirtualContext.cs`
- `_pending` 入队（`SetDataDeferred`）**不加 `_flushLock`**；`Flush()` 在 `_flushLock` 内一次性排空全部。
- `Flush` 可能被 **后台 writer 线程** 与 **StatsJson/Dispose 的前台线程** 同时调用：
  - 前台 `Flush` 排空到本地 batch 并 commit 时，后台 `Flush` 若也执行会排空到*下一批* —— 逻辑上幂等（UPSERT），不会丢数据；
  - 但失败回滚路径会把 batch 重新 `Enqueue` 回 `_pending`，若此时另一线程已把相同 key 的新版本入队，**旧版本会覆盖新版本**（顺序颠倒）。
- 另外 `Open()` 每次 `PRAGMA busy_timeout`，并发读高时开销可忽略。

影响：极低概率下，同一 key 的旧数据可能晚于新数据被 commit，造成短暂陈旧读。一般可容忍，但建议用 `ConcurrentQueue` + 单写者模型（比如让 `Flush` 只在 writer 线程内执行，Stats/Dispose 只 `Signal` writer），彻底消除双写顺序问题。

---

### 1.4 🟡 JsEngineHost.EvictLocked O(n·log n)
位置：`Engine/JsEngineHost.cs`
- `EvictLocked` 每次超出 `_maxSeeds` 用 `_vms.OrderBy(LastUsed).First()` 选最旧 —— 对整个字典排序。
- 默认 `MaxSeeds=3`，仅在并发创建多个世界时触发，量级小；但若调大 `MaxSeeds` 会变成热点。

建议：维护一个 LRU 双向链表（或按 `LastUsed` 组织的最小堆），O(log n)。

---

### 1.5 🟡 MemoryVirtualContext 淘汰策略
位置：`Storage/MemoryVirtualContext.cs`
- 用 FIFO 队列淘汰（入队序），对 chunk/region/comm 混合缓存不公平：热区 chunk 可能被新 region 挤出。

建议：改为 2Q / 简单 LRU 计数（存 entry 附带 lastUsed，淘汰时扫描）—— 非必须。

---

### 1.6 ✅ 良好实践（无需改）
- `GetChunkBytes/GetCommBytes` 两级缓存 + in-flight 门闩（R9）设计正确；
- `RegionEpoch` 用 ConcurrentDictionary，并发写安全；
- GZip 只 compress 一次并缓存，HTTP 复用字节数组，避免每请求重压缩；
- R8 tile/fieldGrid 进程内缓存 + region epoch 失效设计干净。

---

## 2. 引擎 JS（noise.js / mapgen.js / mapgen-server.js）

### 2.1 🔴 无上限缓存（同 1.1）—— 前端与后端 VM 各自都有一份
- `noise.js`/`mapgen.js` 在原工程亦被直接加载到**浏览器前端**（web/ 未包含，但若未来前端开世界会重复此问题）。
- 服务端 VM（`mapgen-server.js` 适配层）中 `regionJson/commJson/road` 每次都会把结果写入缓存；当前以 `buildChunk` 为核心路径，`region` 只在点击详情/流式预取时触发 —— 仍会累积。

### 2.2 🟠 `veinNear` 的 `bd<=3` 剪枝
位置：`mapgen.js: veinNear (L780)`
- 每次 `fields()` 都调用 `veinNear`，再通过 `elevAtVN` 传入复用 —— 但这个局部最优只在 `fields` 内复用，`elevAt` 单独调用（`buildChunk` 的邻域、道路 A* 里会大量调用）**没有穿过 vn**，会重复扫描 3×3 群落 × 每个群落 veins。
- 在高密度灵脉区，A* 邻域展开时 `elevAt` 被反复调用，`veinNear` 的 3×3 grid 扫描 + 每个群落内部静脉遍历形成 O(群落×静脉) 热点。

影响：属于常量级偏大但非爆炸，性能敏感时可对 `elevAt(q,r)` 增加一个「同 tile 短缓存」（NLFU），避免同一 tile 在 chunk 邻域与 A* 中重复计算。

### 2.3 🟡 `roadCost` 每次 alloc
- 每格调用无分配，OK；`astar` 每点 `path.push([])` 只发生在终点回填，OK。

### 2.4 ✅ 良好实践
- `cacheSet` 单条淘汰的摊薄策略（P3）正确；
- 无递归、纯坐标函数，跨区块一致。

---

## 3. 前端渲染（web/js）

### 3.1 🟠 renderStaticInto 的 staticLayer 缩放
位置：`main.js renderStaticInto / drawOverlay`
- `staticLayer` 在 `cam.zoom` 变化时会整体重绘（`staticNeedsRedraw` 阈值 0.02），重绘成本 = 全部已加载 chunk 的浪线 + 道路 + 灵脉/聚落图标，**每帧只会在相机静止时被合并 200ms 节流**。
- 缩放缩放过程中会频繁整层重绘，加上 `drawImage(staticLayer)` 在 overlay 上，可能造成缩放卡顿。

建议：缩放时改为「先画底图 + 少量重点标注」，缩放停止后再补全 staticLayer（hierarchical LOD）。低优先级。

### 3.2 🟠 全局 error 兜底过宽
位置：`main.js window.addEventListener('error')`
- 任何 `window.onerror`（含未知第三方/广告脚本、WebGL 上下文丢失、一次性的 minor 异常）都会把 `#fatal` 面板弹出来并 `throw` 中断当前帧。

建议：只捕获与地图渲染强相关的错误（包在 `try/catch(renderer.render(...))` 内），不要全局 hook 后直接展示致命面板。

### 3.3 🟡 renderer.setRoads 每帧 DYNAMIC 分配
位置：`renderer.js setRoads`
- 每帧按当前 static 重绘把新 Float32Array 传给 `gl.bufferData(DYNAMIC_DRAW)`，量级在数百线段，可接受；但可复用两块 buffer，避免 GC 峰值。

### 3.4 ✅ 良好实践
- `updateStreaming` 阈值（P1）与区域/群落 keepSet 校验（R4）正确；
- dpr 与 CSS 像素统一，GL 视口同 source，避免黑边；
- 图集 UV `/8` 与灵脉行映射正确。

---

## 4. 性能热点一览（按优先级）

| # | 位置 | 问题 | 影响 | 建议动作 |
|---|------|------|------|----------|
| 1 | mapgen.js region/settle/comm/road Cache | 无上限 | 长期漫游内存线性增长 | 改 `cacheSet` 固定容量 |
| 2 | MapWorldService.GetRegionBytes | SQLite 只写不读 + 内存淘汰重建成本高 | 磁盘写放大 + 热点重建 | 明确 region 不落库或按 epoch 可命中 |
| 3 | veinNear + elevAt 重复扫描 | A* 高密度区热点 | 负载尖峰 | 加 tile 短缓存 |
| 4 | Flush 并发写顺序 | 低概率陈旧读 | 数据一致边缘 | 单写者化 |
| 5 | renderStaticInto 整层重绘 | 缩放卡顿 | 体验 | 分层 LOD |
| 6 | EvictLocked O(n·log n) | 多世界场景 | 微热 | LRU 链 |

---

## 5. 建议与待办

- [ ] **P0 内存**：给 `regionCache/settleCache/commCache/roadCache` 加固定容量（复用 `cacheSet`），并同步保证 `roadFail` 不被错误清空语义。
- [ ] **P1 清晰化**：决定 region 是否落 SQLite；若不读则去掉 `_sql` 写，或加 epoch 可命中路径。
- [ ] **P1 稳定性**：SqliteWriter 改为单写者（仅后台线程落库），Stats/Dispose 只触发重试而非并发 Flush。
- [ ] **P2 体验**：前端 error 兜底收窄；缩放时 staticLayer 分层。
- [ ] **P2 性能**：`veinNear/elevAt` 增加 tile 粒度短缓存；`EvictLocked` 改 LRU。
- [ ] **验证方式**：跑 `node verify/verify_map.mjs` 确认改动不破坏 310 项契约校验；对 `?capture=1` headless 截图核对渲染无明显回归。