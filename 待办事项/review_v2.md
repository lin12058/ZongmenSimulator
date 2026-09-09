# 宗门模拟器 · 全量代码审核报告 v2（前端 + 后端）

> 审核范围：`web/js/*`（main/mapclient/noiselib/pb/textures/renderer）、`Server/Zongmen/Engine/js/*`（noise/mapgen/mapgen-server）、`Server/Zongmen/*.cs`（Program/Options/MapWorldService/JsEngineHost/MapEndpoints/StaticWebMiddleware/ApiRateLimit~ 与 Storage、Domain、Protocol、Web）。
> 审核性质：性能 & 正确性 & 潜在 bug 定向扫描。共约 5900 行。
>
> 评级说明：🔴严重（影响正确性/急需处理）｜🟠中（可导致卡顿/损耗）｜🟡轻（可维护性/注释/小损耗）。

---

## 一、正确性 / 潜在 Bug

### 1. 🔴 `renderer.js` — `PROP_FS` 精灵行号 `floor(vSprite/8)` 与 `setTextures` 线性采样
- **位置**：`renderer.js` PROP_FS（约 L161）`row = floor(vSprite/8.0+0.001)`。
- **问题**：山、雪条目 `propSpriteFor()` 返回 `40/41/56/57`、`42/43/58/59`，行索引 `40/8=5`、`56/8=7` 无误；但 `44..47`（林地）与 `48/49`（沙/草）、`50..54`（灵脉峰）、`60..63`（草丘/孤树）均落第 5~7 行。**若 atlas 实际行数 < 8，高位采样越界返回透明，精灵不显示**。已核实 `textures.js` `ATLAS_ROWS=8` 且按 8 行生成，故当前 **不触发**；但 `renderer.js` 构造默认 `atlasRows=8` 与 `HEX_FS` 硬编码 `vec2(8.8)` 三者强耦合，**一旦 future 调整 ATLAS_ROWS 即静默丢精灵**。
- **建议**：抽公共常量，`HEX_FS`/`PROP_FS`/`uploadChunk` 全部引用同一 `ATLAS_ROWS`，加构建期断言 `texAtlas 高 % PX == 0 && spec rows == ATLAS_ROWS`。

### 2. 🟠 `mapgen.js` — `buildChunk` 内层 6 邻居 `fields()` 与灵脉级联扫描
- **位置**：`mapgen.js buildChunk` L378-383。
- **问题**：每个归属地块对 6 个邻居再次 `fields()`，每个 `fields()` 内又 `veinNear()`→`communityOf()`（3×3 晶格，最多生成 1+3+7=11 条灵脉并逐条 `hexDist`）。冷区块构建 = ~721 格 ×(自身位+6 邻居) ≈ **5000 次 fields 级重计算**，其中大量重复 `veinNear` 可通过缓存复用（`veinNearCache` 已存在但 `fields()` 层仍重复触发）。综合噪声（`nWarp`/`elevAtVN`/`ridged`）冷启动高 seed 时易出现**首帧卡顿 / 浮窗开格卡**。
- **建议**：
  a) `buildChunk` 内循环改成一次 `fields()`，其内部已含 `veinNear` + `elevAtVN` 缓存复用，再显式从 `fieldCache` 取邻居（避免再走 veinNear 分支）；
  b) 将 `chunkOfTile` 归属判定与 `fields` 解耦（先归属后取场），减少对非本区块格的无效 `fields`。

### 3. 🟠 `MapWorldService.cs` — `GetChunkBytes/GetRegionBytes/GetCommBytes` 三处相似取缓存+gate
- **位置**：`MapWorldService.cs` L61-85 / L125-154 / L212-235。
- **问题**：`GetRegionBytes` **跳过 SQLite 直读**（注释解释为需保持 VM roadCache 热），却仅依赖 `_mem` 缓存；若进程重启或内存 LRU 淘汰后 **冷回访区域**，必然经 JS VM 再生成，且 `_regionEpoch` 只在“经 JS 生成”时 `+1` —— 若区域从 SQLite 直接命中则 `tile` 的 onRoad 可能与已绘道路不一致（虽当前因不直读而规避，但**约束脆弱**，`_mem` 清空后即失效）。
- **建议**：给 `RegionEpoch` 加“SQLite 命中也同步推进”的语义，或为 `onRoad` 提供与道路生成同源的版本号，避免语义漂移。

### 4. 🟡 `mapclient.js` / `pb.js` — `meta` 全局单例与 `seed=1` 硬编码
- **位置**：`mapclient.js fetchMeta`（L18 请求 `?seed=1`）。
- **问题**：元信息是**世界无关**常量（几何/图例），硬编码 `seed=1` 本无碍；但 `meta` 被模块级单例缓存，若未来元信息按 seed 变化（如 BIOME_META 随种子），此处不会刷新。
- **建议**：保留单例的同时将 seed 参数透出，或显式注释为“世界无关常量”。

### 5. 🟡 `JsEngineHost.cs` — 每 VM 一个 `V8ScriptEngine` + `SemaphoreSlim(1)`
- **位置**：`JsEngineHost.cs GetOrCreate` / `JsWorldVm.Call`。
- **问题**：每个 seed 一个独立 V8 实例，`MaxSeeds=3` LRU 淘汰。冷世界生成成本高（完整 noise+mapgen 加载），且**同一 seed 并发进入 `Call` 时全程串行**（`_gate` 单锁）——地图请求若被限流缓解仍可接受，但 `meta/fields/chunk` 混入同一门闩时（meta 与 fields 实为不同请求），高频小地图轮询会与 chunk 生成互相排队。
- **建议**：给 `meta/fields` 类“快路径”独立于 chunk/region 的重计算；或按请求类型拆分信号量。

---

## 二、性能 / 资源

### 6. 🟠 `mapgen.js` — `roadsNear` 预算制 A* 的 `maxNew` 语义
- **位置**：`mapgen.js roadsNear` L622。
- **问题**：`maxNew=0` 为纯读缓存路径（点击/绘制帧），`9999` 为流式全算。**`roadFail` Set 终身累积不可达对**，无限世界漫游时集合无上限增长（虽单条极小）。
- **建议**：`roadFail` 与 `veinNearCache` 等一样纳入容量上限（`cacheSet`）或按 seed 会话重置；防止长期漫游内存缓慢膨胀。

### 7. 🟠 `MapWorldService.cs` — 三个 LRU 的“粗淘汰删 1/4”
- **位置**：`GetTileBytes`/`GetFieldGridJson` 的市区淘汰（L326-330 / L344-348）。
- **问题**：`ConcurrentDictionary.Count>=Cap` 时 `Take(Cap/4)` **每次全量遍历 Keys 再批量删**，O(n) 且存在并发取键竞态（容忍性可，但每到达上限都触发一次 O(cap) 开销）。
- **建议**：改用预置的 `ConcurrentLRU`（双向链表+锁）或固定分片淘汰，避免热点轮询期间反复整表遍历。

### 8. 🟡 `renderer.js` — `setRoads` 每帧重建 Float32Array
- **位置**：`renderer.js setRoads`（L396）。
- **问题**：Canvas2D overlay 每帧 `drawOverlay` 重新生成 `haloV/coreV`，主循环每帧 `renderer.render` 前由 `main.js` 全量重算道路顶点 → **GPU buffer 每帧 `bufferData(DYNAMIC)` 重传**，若道路多且坐标频繁变化则浪费带宽。
- **建议**：道路仅在 `showVeins/showLabels/静态脏标记` 变化时重建（沿用 R1 static 节流），而非每帧。

### 9. 🟡 `mapclient.js`/`main.js` — `pxToTile`/`tileToWorld` 无条件重算
- **位置**：`mapclient.js` 几何工具。
- **问题**：每帧 `drawOverlay` 对每个屏幕采样调用 `pxToTile`，纯函数无缓存；高楼帧率下 Canvas2D 全屏贴图级计算可能成为瓶颈（当前 DPR 下肉眼感知低，留给日后）。
- **建议**：低优先级，仅在 profile 显示热点时引入 tile 级缓存。

---

## 三、可维护性与注释不一致（低风险）

- 🔵 `textures.js` 头注释“共 7 行”，实际 `ATLAS_ROWS=8` —— 文档与实现不符，已核实实现正确，仅注释误导。
- 🔵 `mapgen-server.js` 注释提到 `R11 configure 清全部缓存`，`mapgen.js configure` 亦清 `regionCache/settleCache/roadCache/roadFail` —— 与实现一致，但 `MapWorldService._regionEpoch` 未纳入 configure 复位路径（见 #3）。
- 🔵 `JSVM` 分支数与注释（`Call` 的 7 分支）与 `MapGenServer` 导出方法一致，无失配。

---

## 四、建议处理优先级

| # | 模块 | 级别 | 建议动作 |
|---|------|------|----------|
| 1 | renderer.js ATLAS_ROWS 耦合 | 🟠 | 抽公共常量 + 构建期断言 |
| 2 | mapgen.js buildChunk 邻居 fields | 🟠 | 复用 fieldCache 提邻居，解耦归属判定 |
| 3 | MapWorldService RegionEpoch 与 SQL 直读 | 🟠 | 语义统一 / 版本号化 onRoad |
| 4 | mapclient meta 硬编码 seed | 🟡 | 透出参数或注释 |
| 5 | JsEngineHost 单门闩 | 🟡 | meta/fields 与重计算分离 |
| 6 | roadFail 无限增长 | 🟠 | 纳入容量上限 |
| 7 | MapWorldService LRU 粗淘汰 | 🟡 | 换 ConcurrentLRU 或分片 |
| 8 | setRoads 每帧重建 | 🟡 | 静态标记节流重建 |
| 9 | pxToTile 每帧重算 | 🟡 | 热点时再缓存 |

---

## 五、总体结论

- **架构**：C# 权威计算 + JS 沙箱 + protobuf/gzip 两级缓存 + 前端纯渲染的解耦**合理且正确**，无结构性缺陷。数据流（chunk/region/comm 缓存，tile/fields 即时计算）与注释基本一致。
- **重点风险集中在三处**：(1) 图集行数 / 精灵行号的隐式常量耦合（#1）；(2) 区块构建的邻居-灵脉级联重计算导致冷启动卡顿（#2）；(3) `_regionEpoch` 与 SQLite 读路径的语义漂移隐患（#3）。
- **性能上**：整体有 LRU/限流/预算制多重保护，主要瓶颈仍是 cold 世界构建与频繁的全量 static 层重建，建议按 #2/#7/#8 顺序优化。
- **正确性**：未发现会直接导致画面错误的确定性 bug；当前 310 项 verify 覆盖的项可通过，以上为边界/演进性隐患。