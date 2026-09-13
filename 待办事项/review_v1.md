# 代码审查 review_v1 — 最近两天改动（性能 / 隐藏 bug）

- **审查基线**: HEAD = `57428dd`（渐进修路：中心点向外生长 + 预览页点击设定修路中心）
- **审查窗口**: 2026-09-11 15:11 ~ 09-13 13:51（48h），期间有并行会话在审查中途提交了 `57428dd`，已一并纳入
- **覆盖提交**: `549381e` 参数单点化/预览页 → `a0c7d49` 灵气边界衰减 → `7d7cd9e` 灵脉标记缩放 → `c2b80d3` 道路网拓扑重构+城镇四阶段 → `d76acd9` 寻路修正/cartDist → `641e8f4` Network-First P0 → `57428dd` 渐进修路
- **覆盖文件**: `mapgen.js`（+973，重点）、`mapgen-config.js`（新增）、`mapgen-server.js`、`JsEngineHost.cs`、`MapWorldService.cs`、`MapMessages.cs`、`web/js/main.js`、`web/js/pb.js`、`web/index.html`、`灵脉预览.html`（重点看道路/贸易/点击中心相关段落）
- 未逐行审查: verify/*.mjs 回归脚本（仅检查了加载方式）、db/*.sqlite、.workbuddy/*

---

## TL;DR

道路网络重构这轮改动整体质量高：Dial 桶 A* 的可采纳性/一致性、三重剪枝、wire 兼容、双检门闩都经得起推敲（见文末「已验证无问题项」）。发现 **1 个建议尽快修的逻辑缺陷（P1）**、**3 个应修的隐藏问题（P2）**、若干低危项。无「会立刻炸」的线上级 bug。

---

## P1 — 建议尽快修

### 1. DI 闸拒绝（但路径存在）的边永不退场，且会饿死渐进修路的预算

- 位置: `Server/Zongmen/Engine/js/mapgen.js:1245`（drain 循环）、`:1277`（主循环失败入队）、`:1337-1341`（deferred → 重试队列）
- 机理: `roadFailTrials` 只在 `bfsRoad` 返回 null 时 +1（3 次后转 `roadFail` 终身跳过）。但「找得到路径、只是 DI = 步数/六边距 > 1.4 超闸」的边在 drain 循环里被 push 回队尾时**不计数**——地理上注定超闸的边（典型：海湾/峡道两侧聚落，任何路径都绕）永远不会转正，在会话余生里每次 `roadsNear` 都重跑一遍 A* 并消耗 `budget--`/`drained++` 配额。
- 影响分两档:
  - **服务端**（`regionJson` 传 budget=9999）: 每次 region 构建多付 ≤8 次无效 A*，量级可控，但是永久性税。
  - **预览页渐进修路**（`灵脉预览.html:2310 pumpRoads`，budget 可低至 1~3）: drain 循环**先于**本格主循环执行，队列头的死循环边会吃光每次泵送的预算 → `built` 恒为 0，**当前视野的新路一条都建不出来**，同时每 tick 最多 40 格 × budget 次 A* 空转（CPU 白烧）。只要队列里进了几条注定超闸的边，渐进修路就可能整体停滞。
- 顺带放大项: `skeletonEdgesFor`（见 P3-8）是局部变量不缓存，主循环每碰到一次 DI 超闸就重算一次 O(n³)，与上面的空转叠加。
- 建议（任选其一或组合）:
  1. drain 循环里 DI 超闸（有路径）也计入 `roadFailTrials`，3 次后转 `roadFail`（语义：「路网变密也救不了」）；主循环 deferred 分支同理在重试次数超限后转正。
  2. 把 drain 挪到主循环**之后**（本格自己的边优先拿预算），drain 只用剩余预算。
  3. 预览页 `pumpRoads` 不再透传小 budget 给 drain（或 drain 每次调用固定只消化 1 条）。

---

## P2 — 应修

### 2. mapgen.js 内置兜底 CFG 与 mapgen-config.js 已漂移（含 2 个键缺失 → 兜底路径行为剧变）

- 位置: `Server/Zongmen/Engine/js/mapgen.js:51-62`（fallback CFG）vs `Server/Zongmen/Engine/js/mapgen-config.js`
- 事实:
  - 兜底**缺 `ROAD_W_ROAD`** → `CFG.ROAD_W_ROAD | 0` = 0 → 已铺路格 0 费、`hMin=0`（启发函数失效、步数上限被放宽到 120）。 `mapgen.js:1179` `roadW = CFG.ROAD_W_ROAD | 0`
  - 兜底**缺 `ROAD_DI_MAX10`** → `roadDI = 0` → `steps*10 > 0` 恒真，**每条边都触发绕行闸** → 非骨架边全部放弃，路网退化为「仅 Kruskal 骨架」。
  - `ROAD_W` 数值也不一致: 兜底 `[4,4,4,3,5,3,8,8]` vs 真源 `[8,6,4,3,4,5,8,8]`（深海/浅海/林地/沙漠权重全不同，兜底值是重构前的旧表）。
- 触发面: 当前所有加载方（`JsEngineHost.cs:95` bundle 顺序、全部 verify 脚本）都先载 config，所以是**潜伏**问题；但任何一个新宿主/新脚本漏载 config 就会「静默跑错参数」——比崩溃更难查（`verify/stats_buildings.mjs:27` 的注释已经点名这个坑）。
- 建议: 兜底值与 config 逐项同步；更彻底的做法是缺 `MapGenConfig` 时直接 throw（config 已是唯一真源，静默兜底的价值为负）。灵脉预览.html:483 内联的同款兜底副本也要一起改。

### 3. 预览页「清空道路」只清 roadCache，不清 roadTileIdx / roadFail / diRetryQueue / roadVer

- 位置: `灵脉预览.html:3238`（`MapGen.roadCache.clear()`）
- 机理: `roadTileIdx` 是 add-only 的已铺路格索引，`mapgen.js:123-126` 注释明确约定它与 roadCache「同生共死，仅 resetWorld/configure 清」。清空按钮绕过了这个约定：清完之后新寻路仍把已删除路的格子当 2 费高速路骑 → **新路沿看不见的幽灵路廊走**，画面与真实路网错位；同时 `roadVer` 不变 → tile onRoad 缓存不失效；`diRetryQueue`/`roadFail` 残留导致部分边被永远跳过。
- 建议: 清空按钮改调一个引擎侧清理入口（如 `MapGen.resetRoads()`：清 roadCache + roadTileIdx + roadFail + roadFailTrials + diRetryQueue 并 bump roadVer），不要在页面里只 clear 一个 Map。

### 4. 一次性探针脚本被误提交到仓库根目录

- 位置: `.tmp_cs_probe.js`、`.tmp_review_check.js`（`57428dd` 带入）
- 说明: 上一轮 `6122e26` 刚清理过同类误入库的调试副本，这两个又进来了（内容只是临时 grep 探针，无保留价值）。
- 建议: `git rm` 两个文件，并在 `.gitignore` 加 `.tmp_*` 一劳永逸。

---

## P3 — 低危 / 择机处理

### 5. roadCache FIFO 淘汰与 roadTileIdx 只增不清的相互作用（一致性边界）

- 位置: `mapgen.js:162-165`（cacheSet）、`:91`（ROAD_CAP=4096）、`:123-126`（只增不清的约定）
- 机理: 长会话路数超 4096 后旧路被淘汰，但其路格永久留在 `roadTileIdx`。该路若因再次请求而重建，重建的 A* 会骑在幽灵格与**此后新建路**的格上 → 同一对 (a,b) 的路在淘汰前后形状可能不同；C# 侧已持久化的旧 region 包里还是旧形状。头部「跨会话完全一致」的承诺实际附带「未触发淘汰」前提（注释已部分承认「批边界路形可能略异」）。
- 建议的廉价修法: 给 `cacheSet` 加淘汰回调（或在 roadsNear 里检测到淘汰）时，从 road 对象的 `tiles` 反向清 `roadTileIdx`——路对象里现成有 tiles 集合，成本 O(路长)。

### 6. tradeEdgesFor「每对只算一次」+ 按可见格绘制 → 贸易线在视野边界闪失

- 位置: `mapgen.js:832-873`（`a.id > b.id` skip，边归属 id 较小端所在格）+ `灵脉预览.html:2931-2941`（只对 `indexRange` 可见格求边）
- 现象: TRADE_REACH=40 可跨 2~3 个区域格；相机只罩住 id 较大端那格时，两端点都在画面里、虚线却不画（属格在视野外）。
- 提醒: `tradeEdgesFor` 目前**只有预览页消费**（服务端 region/settle 包、正式前端 main.js 都没接）。将来接入时要定下发口径——按属格下发（省带宽，客户端须按属格缓存）还是两端格都下发（渲染简单）——否则线上会复现同样的缺线。

### 7. growTownFootprint 对雪峰格不设防

- 位置: `mapgen.js:713-760`（只 `biome <= OCEAN` 跳过）+ `:594-599`（`biome >= MOUNTAIN → '矿脉'`，SNOW=7 ≥ MOUNTAIN=6）
- 现象: 城镇中心由 siteScore 排除雪峰选出，但 TOWN_R=3 环内的雪峰格会按「矿脉」铺「矿山/熔炉」——雪峰上的矿场。纯观感问题，按设定取舍即可（要修的话在 footprint 循环里把 SNOW 与海洋同等跳过）。

### 8. skeletonEdgesFor 无缓存 + O(n³)

- 位置: `mapgen.js:1040-1078`
- 机理: 5x5 池全部聚落两两组合 × 每对 O(n) 支配判定；`skel` 是 roadsNear 的局部变量，不按 (i,j) 缓存 → 每次碰到 DI 超闸的调用都全量重算。n≈20~40 时单次 0.1~3ms，独立看可接受；但与 P1-1 的空转叠加会被反复放大（有卡边的格每个泵送 tick 重算一次）。纯函数可按 (i,j) 缓存（与其它派生缓存同样随 configure 清空）。

### 9. bfsRoad 每次调用分配 121 个桶 + 字符串键容器

- 位置: `mapgen.js:1134-1240`
- 说明: `buckets` 每次调用 new 出 maxCost+1=121 个数组，`dist/prev/closed` 用 `"q,r"` 字符串键。剪枝后搜索域 ≤ ~5k 格，单次不贵；但 roadsNear 一次算几十条边、DI 直连重试再翻倍，每 region 峰值上万次小分配。实测 ~130ms/region 已在预算内，属「有余裕再做」：桶数组可模块级复用，键可换 `(q+32768)*65536+(r+32768)` 整数。

### 10. GetTileBlock 每请求对每 region 重复 gzip 解压 + protobuf 反序列化 SettlePack

- 位置: `Server/Zongmen/Services/MapWorldService.cs:468-476`（plans 循环）与 `:477`（region 循环）
- 说明: 字节有两级缓存，但 `DesFromGz` 每请求重跑；layers.regions ~25 格 × 2 遍。SettlePack 很小（≤2 镇 × ≤25 建筑），单请求多 ~1-2ms，当前可接受。若后续足迹字段涨（事件演化），建议按 key+rev 缓存反序列化结果，或把足迹并入 region 包省一遍。

### 11. roadFailTrials 无容量上限、转正后条目不删

- 位置: `mapgen.js:85` 附近定义；drain/主循环各处 `roadFailTrials.set(...)`
- 说明: `roadFail` 有 ROADFAIL_CAP，但 trials Map 只增不减（3 次转正后条目也不 delete）。单条极小，会话级慢性增长；顺手在转正分支 `roadFailTrials.delete(rkey)` 即可。

### 12. rngDominated 注释与实现不符

- 位置: `mapgen.js:1015` 注释「池 = 3x3(a) ∪ 3x3(b)」vs 实现 `-2..2` 双重循环（5x5 ∪ 5x5 = 50 格）
- 说明: 实现比注释更保守（更全面），无正确性问题；把注释改成 5x5 即可。`demandEdgesFor` 的同类注释在 `57428dd` 已改成 5x5，这里是漏网之鱼。

---

## 已验证无问题项（后续审查可跳过）

- **bfsRoad (Dial 桶 A*) 正确性**: `hMin = min(地形最小权重, ROAD_W_ROAD)` 保证启发可采纳且一致（相邻格恰差 1 单位、⌊·⌋ 次可加性成立）→ 首次出队即最优；`ds+dn>maxSteps`（步数透镜）、`g+h>maxCost`、`ng+h>maxCost` 三道剪枝均为下界剪枝，不改变可行路径集；复用模式步数上限 `COST_MAX÷2=60` 与预算自洽（40×3=120 / 60×2=120）；`buckets[ng+h]` 越界不可能（先剪枝后入桶）；桶内 FIFO + NEIGH_SLOTS 固定序 + 端点 id 序归一化 → 确定性。边界核过：hexDist=61 的对（config 注释 max 61）在两种模式下确实都超预算 120，提前 null 正确。
- **ROAD_DI_MAX10=14 / ROAD_W_ROAD=2 / ROAD_W 表** 配置值合理，与注释口径一致（DI≤1.4）。
- **wire 兼容**: `MapMessages.cs` 新增 ProtoMember 13~16 为纯增量；`pb.js` 对未知字段 `default: r.skip` 兼容；`parseBuilding/parseResource` 的 repeated-message 解法与 `rdLen/rdSInt` 签名、ZigZag 标注逐项对上（注释里对「field1 是 string 会被误判为子消息」的提醒是对的写法）。
- **`BuildOnce` 双检**: 等 latch 期间并发命中会直接返回缓存（`MapWorldService.cs:371-387`），`GetSettleBytes` 先查 `_mem ?? ReadSqlBackfill` 的路径无重复构建。
- **预览页点击修路中心**: `pxToTile` 返回立方取整后的整数轴坐标（`mapgen.js:188-198`），`cartDist` 的整数语义不会被浮点坐标破坏。
- **main.js 宗门录**: `layerFingerprint` 修掉了「宗门实体先到、region/comm 后到 → 地界/灵脉永久显示未探明」的时序坑；`initWorld` 重置路径 `sect.curFp` 有清（`main.js:916`）；`esc()` 覆盖 `&<>"` 且属性一律双引号包裹，无注入面；`collectSects/nearestVein` 均随已加载缓存有界，1.5s 节拍 + settle 响应触发，无每帧开销。
- **灵气边界衰减**: 沉海在灵脉抬升之后 + `d<=1` 灵脉覆写加 `e >= SEA_LEVEL` 陆地守卫，不会出「界外灵脉山」；群落概率、聚落概率、地表三处共用同一 edgeKeep 曲线，方向（保留 vs 沉没）用法正确。
- **缓存生命周期**: `roadTileIdx/diRetryQueue/roadFailTrials/新增 5 个派生缓存`在 `resetWorld` 与 `configure` 两条路径都有清理（`mapgen.js:635`、`:1930`）。
- verify 回归脚本全部按 `noise → mapgen-config → mapgen` 顺序加载，无脚本踩中 P2-2 的兜底坑。

---

## 建议的处理顺序

1. **P1-1**（DI 死循环边计数/转正 + drain 挪后）—— 预览页渐进修路的可用性直接受益。
2. **P2-3**（清空按钮补全清理）—— 几行改动，马上修。
3. **P2-4**（删 .tmp 文件 + gitignore）—— 一分钟。
4. **P2-2**（兜底 CFG 同步或 throw）—— 防将来踩坑。
5. P3 按 touching 顺手带走：P3-11、P3-12 一行级；P3-5（roadTileIdx 淘汰回收）在 ROAD_CAP 触发前做完即可。
