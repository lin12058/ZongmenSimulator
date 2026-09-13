# 《宗门模拟器》近期改动 Review — 性能与隐性 bug（v4）

> 范围：2026-09-12 ~ 2026-09-13 改动的核心代码
> （`mapgen.js` 道路网重构、`mapgen-server.js`、`MapWorldService.cs`、`main.js`、`灵脉预览.html` 对应的引擎部分）
> 目的：梳理影响性能的写法与可能引发隐藏 bug 的代码路径，供下一轮优化前评审。
> 说明：以下「★」为确认的热点/隐患，「▲」为需人工复核的疑点，「◐」为低优先级。

---

## 〇、最近两天改动总览

| 组件 | 改动 | 影响面 |
|---|---|---|
| `mapgen.js` 道路段 | Network-first P0 重构：需求图 5×5 池近似 RNG、全局折扣 ROAD_W_ROAD、绕行闸 DI、骨架边 Kruskal、DI 重试队列 | 服务端 `regionJson` / 预览页道路每 Region 调 `roadsNear` |
| `mapgen.js` 聚落段 | `settlementsFor` 由试投改「勘测→选址→生长」，`siteScore/resourceBonus/prospectArea` 逐格扫描 | settleCache CAP 1024（缓存驱逐热点） |
| `mapgen-config.js` | ROAD_W 调整、新增 ROAD_W_ROAD/ROAD_DI_MAX10、PROSPECT_R=4 等 | 参数位全部被 `roadsNear`/`settlementsFor` 消费 |
| `mapgen-server.js` | `regionJson`（道路权威）、`settleJson`、`tileJson`(onRoad)、`blockLayersJson` | 服务端每次区块请求都会触达道路/聚落缓存 |
| `MapWorldService.cs` | `GetRegionBytes` 永远走 JS 重建 + `_mem` 兜底；`_roadVerCache` 刷新 | 区域包缓存命中率直接决定 V8 门开销 |
| `web/js/main.js` | 左侧宗门录、菜单浮层、静态门控 | 前端渲染热路径（本轮重点在引擎层） |

---

## 一、确认会影响性能的点（按影响排序）

### 1.【高】`roadsNear` 每次调用都先无条件构建需求图 — 渲染帧也会付出全量代价
- 位置：`mapgen.js:1217` `roadsNear()`；`:1224 var edges = demandEdgesFor(i,j,cq,cr);`
- 问题：预算 `maxNew` 只在**建路循环内**控 A* 次数，但 `demandEdgesFor` 本身在每次调用（含 `maxNew=0` 的纯读缓存渲染调用）都被整体执行一遍：
  - 对本格聚落扫描 5×5 池（`settlementsFor` 25 格 × LRU）；
  - 对每条候选边再跑 `rngDominated()`（同样 5×5 池 × 两端重复扫描）；
  - 候选边集合按 `hub 等级→间距→rkey` 全排序。
- 结论：**渲染线程每绘制一帧**（预览页 `pumpRoads` 每 24ms 调一次 `draw()`，生产端瓦片加载同样走缓存调用）都会重复构建整张需求图，即使一条边都没建。数据越大（聚落格多）越容易被 LRU 逐出而复算。
- 建议：
  - 把「需求边构建」结果按 `(i,j)` 做一层缓存（`edgesCache`，cap≈ settleCache），`maxNew==0` 直接命中缓存返回 `out`；
  - 或把 `demandEdgesFor` 改为懒构建：仅在本次真正要建第一条路时才触发。
- 关联日志佐证：09-13「最慢单 region（含 roadsNear+闸门）195.8ms（预算 250）」；09-12「道路单条约 40ms、个别最坏 380ms；可见范围全建 400 条 ≈16s」。这些数字在需求图每次重建下会叠加。

### 2.【高】SETTLE_CAP=1024 导致聚落缓存抖动 → 反复重扫
- 位置：`mapgen.js:148 SETTLE_CAP=1024`；`settlementsFor` 全量查进入 LRU。
- 引擎 `settlementsFor` 冷扫描代价（09-12 实测）：约 138 ms/区域格（含 ProspectArea 61 格 score + refine 邻域）。
- 服务端 `tileJson` 的 `onRoad` 循环读 `settlementsFor(ci,cj)` **逆着缓存滚动**（3×3 邻域），区域格一多即把早期条目挤出 LRU，客户端往返时重新触发全量扫描。
- 预览页 09-12 实测「settleCache 1024 → 探查区 101×53 反复淘汰，热扫一度升到 294 ms」据此加了一层 `settleLocal`；但**服务端没有这层本地缓存**，高热扫描仍会漏进 V8。
- 建议：
  - 提升 `SETTLE_CAP`（视区域密度开到 2048~4096）并按「区域格局部性」淘汰（LRU 已具备，但容量需随地图规模放大）；
  - 或把 `settlementsFor` 结果并入 `_regionHot` LRU，避免两个 LRU 互搏。

### 3.【中】`GetRegionBytes` 区域包永不落库 → 冷回访必然重跑道路（含骨架边）
- 位置：`MapWorldService.cs GetRegionBytes`（注释已明确说明）。
- 现状：区域包只存在于 `_regionHot` LRU512 + `_mem` cap8192；一旦 `_mem` 满载淘汰，客户端重新流到该区域时 `regionJson → roadsNear(9999)` 全量重建（需求图+A*+骨架边），V8 门锁再次被持有数百 ms。
- 这是设计取舍（TL 注释：区域包落库“纯写放大”），但对「长会话 + 大世界漫游」场景成立时热点明显。
- 建议：
  - 短期：把 `_regionHot` 容量与 `_mem` 容量对齐（512 太小），或在 LRU 淘汰前只保留「不含道路」的轻量区域信息，道路部分惰性重建；
  - 中长期：对已生成道路加入最终落库（settle 层新增道路边持久化），避免冷回访重复 A*。

### 4.【中】`rngDominated` 是隐性 O(N²)：每候选边 × 5×5 池 × 两端再扫描
- 位置：`mapgen.js:1017 rngDominated` + `demandEdgesFor:1095~1108` 逐边调用。
- 复杂度估算（区域格聚落数 S，20 池宽）：
  `demandEdgesFor` 候选边 ≈ Σa Σb；每边 `rngDominated` 扫 50 格内的聚落，每格再 2 个哈希谓词 + 2 次 `cartDist`；
  单格 40 聚落时 ≈ 40×40×50×常数 ≈ 数万次 `cartDist`（每次含 `isqrt` 牛顿迭代）。这是服务端 `regionJson` 最稳的 CPU 大头。
- 建议：为「支配判断」引入**粗过滤**——先按质点 hexDist 近邻剪枝再精确判断（多数边在第一步就被排除），并缓存 `(a.id,b.id)` 的支配判定结果（幂等）。

### 5.【低】`resourceBonus` 每候选重复扫邻域
- `prospectArea` refine 阶段对前 N 名 `siteScore` 逐格 `resourcesWithin(R=1..2)` 扫六邻；`siteScore` 自身又扫 `veinNear`。
- Prospect 每区域格一次，冷启动 1.4s（09-12 实测）。局部性缓存可复用 `siteScore` 关键字，避免重复调用 `fields`/`veinNear`。

---

## 二、隐藏 bug / 边界风险（近期改动引入）

### 6.【中】DI 重试队列容量上限（4096）与消费策略偏宽 → 冷门边饥饿风险待实测
- 位置：`roadsNear` deferred → `diRetryQueue`（`shift()` 最旧，上限 4096）。
- 事实：队列仅在每次 `roadsNear` 头部消化 ≤8 条，且主循环与尾部 defer 持续追加；但主边与 defer 边都会在后续调用重试，并非只喂首部。
- 风险（需实测确认）：高密度世界若 defer 追加速率 > 消费速率，尾端边可能长期排不到 → 局部空洞且无日志。
- 建议：先加「消费失败率」统计，确认后再决定是否需要优先队列或扩容。

### 7.【中】`maxNew==0` 纯读调用仍会执行需求图构建（等待 #1 缓存后可消除）
- 事实核对：budget 守卫出现在建块之前（`if (budget<=0) continue;`），因此纯读帧不会借骨架分支「偷偷建路」；骨架边只在已消耗的单个 budget 单元内落地。
- 真正开销在 `demandEdgesFor` / `rngDominated`——`maxNew==0` 时它们仍在渲染帧被完整执行（见 #1）；这是纯读帧性能开销的主要来源，语义上并无越权写。
- 建议：复用 #1 的需求图缓存，`maxNew==0` 直接命中返回。

### 8.【中】缓存驱逐节奏不一致 → 长时间漫游后道路端点认知漂移
- `roadsNear` 结果含 `road.tiles` Set，而 tile 语义依赖 `roadCache` 与 `settleCache`（SETTLE_CAP=1024）；两者 LRU 淘汰节奏不一致时，`tileJson` 的 3×3 邻域 `onRoad` 读取可能命中「旧聚落分布」先、新分布后，导致端点状态跳变。
- 引擎按坐标幂等重算，结果最终一致；重点是避免「先旧后新」造成的瞬时状态不一致干扰诊断。

### 9.【中】`regionJson` 每次全量 `roadsNear(maxNew=9999)`：冷启动/缓存抖动时重建成本叠加
- 位置：`mapgen-server.js regionJson()`。
- 在 `regionCache` 冷启动下，每个区域格都做全预算 roadsNear；一旦 `SETTLE_CAP` / `_mem` 抖动，同一区域反复触发「需求图 + A* + 骨架边」重建，服务端吞吐显著下降。
- 建议：骨架边结果按 `(i,j)` 缓存；或将 `roadsNear` 的「需求图构建」与「实际建边」解耦（首边失败即短路）。可并入 #1 一并演进。

---

## 三、其他近期改动引入的小隐患

### 10. DI 判定的 `steps*10 > roadDI*d0` 在道路「复用模式」下的上下界语义
- `maxSteps` 在复用模式放宽到 `COST_MAX/ROAD_W_ROAD=60`，DI 闸仍用原来的 `hexDist` 下界。
- 边界：当两点极近（`d0hex` 接近 0）时，`steps*10` 很容易超过下限 → 非骨架边被放弃 → 多数情况近邻边被跳过。是否满足语义需按几何实例回归复核（可对照 09-13 对拍脚本）。

### 11. `Configure()` 清理缓存但**未清理 `diRetryQueue` 的引用**（代码里 `diRetryQueue.length=0` 只清会话级重试痕迹）
- 参数变更后旧队列引用可能仍滞留旧区域 key；建议在 `configure` 内同时重置 DI 队列状态（09-12 注释已提示需一并清）。

### 12. 前端 `main.js` 宗门菜单浮层依赖 pan 面板位置固定，缩放/窗口变化未跟随 —— 交互态下浮层锚点漂移
- 属 UI 隐患，非性能；已在备忘录记录，此处仅列项。

---

## 四、建议优先处理顺序

1. **P0**：#1 需求图缓存 / `maxNew==0` 短路 — 直接消除渲染帧与瓦片加载的隐性开销。
2. **P0**：#6 DI 队列消费策略（防冷门边饥饿）+ #7 纯读帧照样跑需求图 — 高海拔场景道路网空洞 & 渲染帧间的多余计算。
3. **P1**：#2 SETTLE_CAP 放大 + 局部缓存 — 消除客户端漫游高温重扫。
4. **P1**：#3 区域包缓存对齐（或 settle 落库）— 长会话冷回访性能。
5. **P2**：#4 `rngDominated` 邻域剪枝；#5 复用 siteScore 关键字。
6. **P2**：#11 Configure 重置 DI 队列引用。

---

## 五、备注（后续验证建议）
- 所有性能判断基于 09-12/09-13 实测日志（探查扫描 138ms、道路单条 40ms~380ms、全场景 400 条≈16s、供需图 101×101 抖动、DI 队列 8/次消化）。复核时应以当前版本 `roadsNear` 重新打点一次。
- 修复策略对齐「一条消息多个并行 Edit 易丢改动」的教训：每改一处后单独 grep 复核落盘。
- 新增「维修 A*/道路对拍」（可用 09-13 独立朴素 Dijkstra 对拍脚本复用）验证 #6/#7/#9 行为一致。

---

**本次 review 结论摘要**：改动核心风险集中在「渲染/瓦片读取路径也承担了全量道路需求图构建」（#1）、「DI 重试队列消费策略偏宽（冷门边饥饿）」（#6）、「纯读帧仍全量执行需求图构建」（#7）、「SETTLE_CAP 抖动导致反复扫聚落」（#2）。建议优先做 #1 的懒构建/缓存与 #6、#7 的队列与读写路径优化，再做缓存容量与区域包策略调优。