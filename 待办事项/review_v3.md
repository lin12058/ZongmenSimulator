# 近 2 天代码改动评审 — 性能影响 / 隐性 bug

> 范围：`git log --since="2 days"` 涉及的核心改动：
> - `Server/Zongmen/Engine/js/mapgen.js`（道路网络重构 Network-First + 边界衰减 + 城镇勘测选址生长）
> - `Server/Zongmen/Engine/js/mapgen-config.js`（参数单点化）
> - `Server/Zongmen/Engine/js/mapgen-server.js` / `JsEngineHost.cs` / `MapWorldService.cs`
> - `web/js/main.js`、`web/index.html`（前端图层挂载）
> 评审时间：2026-09-13。以下按【P0 必改 / P1 建议 / P2 观察】分级。
> 本文档基于静态阅读 + 热路径计数，未改动任何代码。

---

## 一、性能影响（按热路径）

### P0-1. `roadsNear(i, j, 9999)` 每次区域包都以“全额预算”走全需求边
**文件**：`mapgen-server.js:104` → `regionJson`；`mapgen.js:1217 servicesNear`

当客户端每拉一块区域包（region），服务端调用 `roadsNear(i,j,9999)`。虽然已缓存的路不会重算 A*，但只要 `demandEdgesFor` 返回的 edge 里有任意一条未落缓存，就会在**当前线程**跑一次完整 A*（`bfsRoad`）。若一张区块涉及多个城镇、且 `roadCache`（4096 上限）被 LRU 淘汰后再被拉回，会重复付「勘测→选址→逐边 A*」全部成本。
- 现状基线：文档里注明最慢单 region ~130ms < 250ms 预算，冷世界重启后首次扫这块区域会有多个未命中边叠加。
- 建议：不改预算逻辑的前提下，把 `regionJson` 的路网生成挪到后台/懒加载，或对 `roadsNear(i,j, budget)` 的 budget 按区块密度按需给（如 min( 9999, 需求边数 )）；至少保证**一次区域包的 A* 总数不再无限叠加**（每区域此前最多 ~12×19 次勘测精算已降到 6×6，但 A* 才是大头）。

### P0-2. `bfsRoad` 的代价模型与「骑路折扣」导致的搜索平面扩张
`mapgen.js:1134 bfsRoad`：`roadTiles` 传入后，已铺路格权重固定 `ROAD_W_ROAD=2`，而 `hMin` 允许下界取 2 —— 意味着**整个开放平原**的 g+h 都远小于预算，A* 会一直扩散到邻域完整铺满预算圆为止（而非很快命中）。配合 `stepLib`×`hexDist` 的步数透镜，平原上每格的 f 几乎相同，桶内 FIFO 依赖固定顺序，扩张数量接近「预算半径²」。
- 建议：仅在有明确目标方向时才探索（欧氏启发已收敛，但要留意 `hMin=2` 时桶粒度过粗 → 整片等 f）。可给「未铺路面」单独步数/代价阈值，避免纯探索空转；或按 Opentrees 引入 `hMin` 与 `roadW` 的加权，降低空旷区权重差。
- 观察位：若区域边界跨越两片不相连陆地，`bfsRoad` 会就近空转一层再失败——该场景已有 `return null` 分支兜底，但如果 DI 闸把骨架边强制建出来，会出现跨海路。

### P1-1. `prospectArea` / `settlementsFor` 冷启动批量成本
`mapgen.js:661` `prospectArea`：R=4 磁盘 61 格逐格 `siteScore`（每格一次 `fields`）+ 前 6 名 `resourceBonus`（再扫 6 邻）。全程依托 `siteScoreCache/fieldsCache`，但冷世界首次全扫一块区域仍要填 ~61×N 格。`settlementsFor` 每锚点两座 → 每个区域最多 2 次 `prospect＋center`。同类 `growTownFootprint` 对每栋建筑小区逐格调 `coastalAt`（6 次 `elevAt`）与 `landuseOf`（`spiritAt`）。
- 影响仅在冷缓存，命中后有 BLRU 缓存兜底；但**跨会话首帧**（尤其服务端刚起、客户端全图预览）仍是这几块的合计峰值。列为观察，不回退。

### P1-2. `roadFailTrials` 无容量上限（内存）
`mapgen.js:121` `var roadFailTrials = new Map()`，只在 `init()` 时 clear；`roadFail` Set 有 ROADFAIL_CAP=1024，但 `roadFailTrials` **永不淘汰**。键 = `"a|b"` 聚落对，数量随会话累计。长时间运行且大量探索聚落的服务端子进程会持续累积（O(聚落²)）。
- 建议：给 `roadFailTrials` 上加与 `roadFail` 一致的容量裁剪（或引入简单 LRU），与 `roadTileIdx`（会话内只增、规模由世界大小界定）区分对待——后者可接受，前者确实应裁剪。

### P1-3. `demandEdgesFor` 按聚落重复建池 + `rngDominated` 多层嵌套
`demandEdgesFor` 对每个聚落重建 5×5 池并 `sorted`（O(P log P)），随后每条候选边再进 `rngDominated`（mapgen.js:1017）做 5×5 支配扫描。聚落密集簇下该两段是网络构建的主开销（虽被缓存）。
- 建议：把候选边的 `rngDominated` 的多重距离计算做成单次矩阵预计算（每对只算一次欧氏距离），并用排序剪枝提前跳出；逻辑不变。

### P2-1. 前端道路几何每次区域包全量 rebuild
`web/js/main.js:605` `roadsDirty → renderStatic` 对 `regionCells` 里每条路的 `pts` 重建缓冲并重传 GPU——区块流式到达时若一次到达多块区域会有并发重建。缓冲生命周期按视野卸载，可接受；但观察是否存在「同一区域反复到达触发 `roadsMerge` 重复构建」。

---

## 二、隐性 bug（正确性 / 逻辑隐患）

### B1. 骨架边强制建路可与「不可达」判定冲突
`mapgen.js:1284-1293`：绕行闸超限时，若为骨架边 → 强制保留（含折扣路径）；非骨架边 → 仅延迟不入 `roadFail`。骨架边强制建的前提是「MST ⊆ RNG ⇒ 连通」——但若两点分处隔离大陆（中间纯水体），强制建的折扣路径会穿海。当前靠 `diRetryQueue` 限次 + `diRetry` 重试掩盖，但骨架边一旦命中就无条件建，**没有隔海检查**。跨大陆聚落对的 `roadFail` 3 次退避并不能阻止骨架边直接落地 → 会画出海上路。
- 修复建议：强制建边前追加一条「沿途水体占比」或「路径代价上限」校验，超限则不建并计入 `roadFailTrials`。

### P2-2. `roadsNear` 计算次序依赖往返池（跨会话一致性风险）
`demandEdgesFor` 的边排序在 `edges.sort` 中同时使用「距中心升序」与「hub 等级」，距离基准同分时依赖 `rkey` 字典序——跨会话请求顺序一致时结果一致；但若服务端访问顺序不同（冷缓存 vs 热缓存 / 编队不同），`roadTileIdx` 全局集合的增量形状会导致**同一世界在不同会话生成的路形在这个批边界上略有差异**（违背部分回归预期的「跨会话一致」）。注释里也已标注此点。属设计取舍，不在本次改动回退，但请保留该认知：涉及 route 语义的校验（如 verify/w3_bfs_road）不应假设严格逐像素一致。

### P2-3. `bfsRoad` 的 `h` 可采纳弱界与预算内「次优」膨胀
`h = hMin * cartDist`，当 `hMin=2`（已铺路）探索开放地形时启发偏乐观 → 会先发散再收敛，可能先入队后剪枝。正确性无碍（仍是最优首次出队），但要关注超长路径（长直走廊）下的膨胀峰值是否超过回归预算。建议补一个路径长度回归（w/router 类）在多大陆角落的压测。

### P2-4. `roadTileIdx` 只增不清（会话内）
`mapgen.js:122` 注释明确「只增不清」。长会话且世界大时集合增长无上限，但对一次性世界（重置即 `init`）可接受。唯一需要注意：**服务端作为常驻进程持续接受多世界请求时**，`resetWorld` 才重置——若存在「同一 VM 处理多个 seed 而不 reset」的路径，会累积。代码当前每位请求都走 `init`，安全；保留观察即可。

---

## 三、改动新增的配置参数核对清单

以下注释里声称的约束与实际代码一致（已抽查）：
- `mapgen-config.js:78 ROAD_DI_MAX10=14`：整数比 `steps*10 > DI*hex` ✓
- `ROAD_COST_MAX=120` / `ROAD_STEPS_MAX=40`，运费模式 `maxSteps=floor(COST/ROAD_W_ROAD)=60` ✓
- `TOWN_INNER_R=1`：内侧铺民房逻辑 ✓
- `EDGE_*_SP` 作用于 `edgeKeep`（保留权重）✓ —— 注意语义是「保留」，衰减一律 `1 - edgeKeep`（已核对 elevAt 沉海一行）。

---

## 四、优先级汇总

| 优先级 | 项 | 类型 | 一句话修复方向 |
|---|---|---|---|
| P0 | regionJson 每包全额 A*（budget 9999） | 性能 | 预算按需求边数收敛 / 后台生成 |
| P0 | BFS 平原发散 + 桶粒度粗 | 性能 | 道路权重与 h 加权、限制空旷区扩散 |
| P1 | roadFailTrials 无上限 | 内存 | 加 LRU/容量裁剪 |
| P1 | demandEdges/rngDominated 重复建池 | 性能 | 距离矩阵预计算 + 剪枝 |
| P1 | 骨架边强行跨海 | 正确性 | 强制建前加水体占比校验 |
| P2 | 跨会话路形边界差异 | 约定 | 记录，路由断言勿假设逐像素一致 |
| P2 | 每次区域包全量重启几何 | 前端 | 增量重建缓冲 |

---

## 五、建议下一步（低风险增量）

1. 给 `roadFailTrials` 加容量裁剪（一行，先做）。
2. `regionJson` 的 `roadsNear(9999)` 改为按 `demandEdgesFor` 实际需求边数分配预算（防止超长冷启动）；同时把单岛无路场景的骨架强制路径加水体占比校验。
3. 补一条 `verify` 回归：跨大陆聚落对不应强制生成道路（防止 P1 骨架边的问题复发）；再加一条长走廊回归确认膨胀峰值在预算内。
4. 前端道路几何改为「到达去重 + 增量追加」，避免同一区域重复到达时全量重建。

---

*评审基于 `git log --since="2 days"` 覆盖的改动（c2b80d3→6122e26），未实际运行压测；数值均为代码路径推演。*