# 宗门模拟器 demo · 长期备忘
> 本文件只钉**跨模块契约 & 会误事的坑**（刻意压到最小）。向下指针：
> - **`DETAILS-引擎与表现层.md`** —— 引擎/灵脉/建筑/小地图/前端自算/渔村A2/归属势力B/匾额C/世界种子W/构建验证坑 的**细则与实测数字**
> - **仓库内 skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`** §1~§39 —— **跑法/验收姿势/教训**（唯一真源）
> - 同目录 `YYYY-MM-DD.md` —— 每日叙事（2026-09-16 二次压缩：长细则继续外迁 DETAILS）

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140（`127.0.0.1` 与 LAN `192.168.63.62` 均通）；⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**（旧备忘的 `Engine/js/` **不存在**），前端 `web/js/`。
- ⚠ 并行 Edit 偶发只落第一条、回执却全报成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `Server/Zongmen/Engine/js/mapgen-config.js`，bundle 序 `[noise, mapgen-config, mapgen, mapgen-server]`。⚠ Node 侧加载引擎必须带它（同序）且先 `global.window = globalThis`；漏加载 ⇒ 静默跑旧参数、参照世界≠服务端。
- 改引擎 js ⇒ ① `sync_preview_inline --check` ② 重启服务端 ③ 载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`；写反 = 越浓越沉海）；真半径真源 `MG.spiritEdgeWorld()`。存储：Data(Key,Value BLOB) WAL + 250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀必须 `var len=r.vi();var eN=r.p+len;`。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**（未命中保持 0=未持有）；帧 `[1B type][payload]`；TileResponse 恒 gzip。
- 写 chunk/region/settle/poi/comm/roads 必须同时 `forceStaticDirty()`。
- 色板真源 `/api/map/meta`；`sprite=row*8+col` 须在已绘制格 ⇒ 两侧字段清单必须对齐。
- ⚠ 新增图层/导出三处必挂：① `JsEngineHost.cs` 的 `JsWorldVm.Call` switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** 而非空数组 ⇒ 读 `.length` 抛异常废整页；**可选包一律判空**。

## 灵脉占地 7/3/1（真源 `veinFootKeep`；细则 → DETAILS）
- **大 = hexDist≤1（7 格）／中 = 本格+(-1,1)+(0,1)（3 格）／小 = 仅本格**；d≥2 不留。从属格 level=`CFG.VEIN_SAT_LEVEL(=3)`，**绝不进 comm.veins[]**。`fields()` 守卫 `vn.d<=1 && e>=SEA_LEVEL && veinFootKeep(...)`；`buildChunk` 用 `e: f.vein?f.vein.level:f.e`（复用海拔通道）。
- ⚠ 判据 `check_vein_cluster.mjs`（**26 条**，含 §D 前端档位表）+ `check_vein_skin.mjs`；已知非缺陷：相邻群落次级灵脉可落同一整数格 ⇒ veinNear 全局最近裁其一 =「幻影灵脉」(名牌叠字)，不破 7/3/1。
- **地盘彩环 = 同口径**（2026-09-16 十四版修完）：环的真源 = `vein-skin.js` `footOffsets(level, MG)`（**引擎就绪时问引擎 `MG.veinFootKeep`**，镜像表 `FOOT_MIRROR` 只在引擎缺席时兜底，由判据 §D **跨源逐值**钉死）。⚠ 一格只画一次 —— main.js `veinOwnerOf` 按「hexDist 最近」裁决归属（镜像引擎 `veinNear` 的 9 宫格规则，`veinAll` 先按 (q,r) 排序消除到达序依赖）；海里（`elevAtTile < geo.seaLevel`）不铺，海拔未到货 (-1) 照画。取数 `?veinprobe=1` → `__feat().veinRings`（逐根 `{name,lv,n}`）。

## 小地图 R12/R13（细则 → DETAILS「小地图 R12/R13 契约」）
- 热拔插单点 = `main.js initMinimap()` 只注入 `{panel, full, snapshot, jump}`。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` **整页 fatal**。
- 三层：L1 地形 = 前端按 seed 自算（只读 `biome/e`；⚠ 绝不读 `onRoad`）／L2 世界全走 WS 快照／L3 视野（面板档跟随主相机 `FOLLOW_WPP=6`，全屏档独立相机）。
- 引擎脚本经 WS 下发：帧 `Script=4`；`EngineScriptOrder=[noise,mapgen-config,mapgen]` 按序拼接（白名单防目录穿越）。⚠ **帧本身不 gzip，只有 `Source` 字段 gzip**。
- R13 倍率联动：`panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`（乘积恒 **13.2**）；面板滚轮只改 `baseWpp`（别直接改上屏 wpp）。
- 手机档两件：触摸四闸（⚠ 触摸后浏览器 ~300ms 补发合成 `mousedown/up` ⇒ 被「未拖动⇒单击展开全屏」接住 = **一拖就弹全屏**；判据比 **`e.timeStamp`** 非 `Date.now()`）＋ `color-scheme: **only light**`（`only` 才是退出关键字）。
- **U4 块色金字塔多数表决** 与 **面板几何参数化 / 窄屏铺满**（收缩盒反馈环、`check_mm_layout.mjs` 12 档 × 8 条）→ DETAILS，改这两处前必读。

## 前端自算地图（细则 → DETAILS「前端自算地形」）
- **算法完全支持且已在跑**（小地图 L1 就是前端自算）；`EngineScriptOrder` 故意不含 `mapgen-server.js`（纯搬运层）。A/B 铁证 `verify/chunk_selfcalc_ab.mjs`（6 块 × 11 段逐字节一致）。
- ⚠ 三障碍：主线程阻塞（需分帧/Worker）／`web/js/noiselib.js` 与引擎 `noise.js` **同名导出 `NoiseLib`**（主流程接入前必须收敛）／**双实例或双 `init(seed)` 会互清全部缓存**（必须单实例）。
- 接线收敛点 `main.js applyBlock(job,resp)`（唯一数据分发入口，5 图层全在此落表）。已拍板：地形 chunk 改前端算 + WS `mask` 去 `CHUNK` 位（=30，服务端零改动）。
- ⚠ 长期分叉：世界一旦可写（`settle` 的 `state/expireTs`、`Owner`、`BumpBlockRev`）纯前端自算立即失效 ⇒ 协议上应分层「静态地形可自算／动态状态须服务端」。

## 渔村 / 归属势力 / 匾额 / 世界种子（都已实施；**全细则 → DETAILS 同名节**）
- **渔村 A2**：**不再以「中心格是否在水里」判渔村** —— 引擎把「渔家」地皮放开到任何聚落的水面格（`lu==='水岸'→'渔家'`）；前端 `WATER_KIND` 白名单兜底 + `?water=old` A/B 档；地盘环**水陆都画**。⚠ 加任何「影响画法」的 flag ⇒ `spriteOf` 缓存 key 必须同步加位，否则水陆串图。
- **归属势力 B**：前端派生 `factionOf` 取最近宗门；⚠ 半径是**镜像常量**（`SECT_DOMAIN_R = COMM_R(25)×1.4 = 35`，同 `mapgen.js:1174`）；⚠ 缓存 `st._fac` **必须靠 `settleVer` 失效**（否则永久锁成无归属）。`?fac=0`；探针 `__facProbe`。
- **匾额锚点 C-a 现行默认 = 实体自己的中心点**（聚落 `st.x/st.y`＝中心格＝核心建筑；灵脉 `v.x/v.y`）。前四修全降为 A/B 档 `?ancgeo=densest|box|col|med|sum`、`?veinpt=apex`。契约 `check_plaque_align` **79 条**；探针 `?plaqprobe=1`。⚠ 教训：用户说「要某个东西的中心点」时先查该中心点在数据里**是否已存在**（skill §35）。
- **世界种子 = 服务端资产**：`WorldLedger.cs` **独立表**（⚠ 绝不能塞 `Data(Key,Value)`，`PruneExcept` 会静默删台账）＋ `/api/world/current|next|list`；前端拿不到种子直接 `showFatal`，**绝不回落前端造**；`?seed=` 仅调试覆盖（削掉即废验证管线）。
- **设置唯一真源 `web/js/store.js`**（键 `zongmen.settings.v1`）；⚠ `showVeins/showLabels` 变量名**不能改**（`frontend_smoke` 逐名扫原文）。

## 玩家放置宗门（方案 `docs/玩家宗门放置与城市迭代方案.md`；**细则全在该文档 §2~§4**）
- **两笔账必须分账**：道路重算 **405~443 ms**（热地形，25 区域格）vs 城市重算 **31 ms**（纯城市 ≈ **23 ms**）⇒ 道路 ≈ 19 倍。⚠ `growTownFootprint` **不读道路**（只读 fields/landuseOf/veinNear，mapgen.js:950~975）⇒ 玩家实体不进 `settlementsFor` 则**既有城市无需重算**；用户口中的「附近城市重算」实为「附近**道路**重算」。
- ⚠ **`roadVer` 只能 +1 增量，绝不归零**：`resetRoads()` 设 roadVer=0（mapgen.js:1851）撞 `ObserveRoadVer` 单调取大（MapWorldService.cs:114~121）⇒ known 保持旧值 ⇒ tile 判「新鲜」⇒ **路重建了却永远送不出去**（无异常无日志）。只按边清 roadCache/roadFail + 显式 roadVer++。
- ⚠ **邻域校验必须扫 2 环（25 格）**：REGION_M=18 + 锚点抖动 6.3 + PROSPECT_R=4 ⇒ 单侧最大偏移 10.3；第 1 环最近可能仅 7.7 格 < 8 禁区。判据 `check_place_neighborhood.mjs`。
- 判据：`check_place_road_recompute.mjs`（4 PASS / 25 s；段 2 跑 A*，样本数已参数化）。注入手法仍是**内存副本注入** —— 引擎尚无 `setExternalSettlements`，真接口落地后脚本会**主动报错**而不是静默跑旧路径。
- ⚠ 测「重算代价」前必须 **warm 上一层缓存**（否则测出的是两层之和），且 warm 是否充分要做成**断言**；首测含 JIT（85ms vs 中位 31ms）⇒ **必须交替多轮取中位**。

## 前端 UI 模块边界（2026-09-23 十二版）
- ⚠ **`#sectWrap` = 「本宗」面板**，数据源 = 服务端 `PlayerSect` 表（**不读 `settleCells`** —— 本宗是持久资产，不在视野内也要显示）。旧「宗门录 + 择宗」闭环**已全删**（`pinId`/择宗菜单/点图认领/`layerFingerprint`）。地图渲染仍走 `EntityGroup→PlaceEntity→settleCells`（与 NPC 同通路），两条路独立。
- 「看**他人**宗门/聚落详情」→ 独立模块 `web/js/infocard.js`（`window.InkInfoCard`）。**只注入不渲染**：`main.js initInfoCard()` 接数据源，将来调 `describe(q,r,refQ,refR)` → `{found,kind,name,html}`。⚠ 引入顺序必须在 `main.js` **之前**；`TIER_NAME` 留 main.js（全局口径）经 `init({tierName})` 注入。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**：`frontend_smoke`（**live 组**）有反向守卫「JS 引用的每处 DOM id 必须已定义」，只删一边必假红。
- `__feat()` 删 `sectPin`，新增 `mySect`（本宗面板态）/`infoCard`（模块就位）。
- `verify/_w_head_main.js`（167 KB 旧 main.js 快照）**已删**（2026-09-23）。⚠ `.gitignore:24` 的 `verify/_*.js` 覆盖它 ⇒ **git 不跟踪 ⇒ 删后不可 git 恢复**（同族 `_*.png`/`_*.txt` 亦然，见 :13/:27）⇒ 删这类文件**必先落副本**，别套用「删错了就 `git restore`」。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，**先按 `git -c core.quotepath=false ls-files` 过滤被跟踪名单**；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ `verify/_scratch_diag.mjs` 是**被跟踪**的，别按 `_` 前缀当临时件。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 统计必带 `-c core.quotepath=false`。

## 构建 / 验证（跑法见 skill §1~§39；**坑清单 → DETAILS 末节**）
- 基线（离线）**19 条** + 在线 **4 条**；总 runner `verify/run_regression.mjs`（`--offline-only`/`--with-server`/`--base=`/`--only=`/`--skip=`/`--list`）。服务端 verify_map/w1/w2/w4 全绿。
- ⚠ **服务端验证别 kill 用户 8140** ⇒ 起临时独立实例，且 **`MaxSeeds` 必须显式放大**（默认 3；`check_mm_ui` 每次用新随机 seed ⇒ 名额用满后判据报「快照未就绪」，**长得像产品回归**）。姿势见 skill §22。
- ⚠ 判据三防：① 绝对值阈值必假红 ⇒ 改 **A/B 归因** ② **参照系不能是被测规则自己的目标函数**（自证陷阱）⇒ §32 ③ 复算必须与实现**同容差语义**（2e-13 的 tie 就能翻案）⇒ §32.1。
- ⚠ 几何对齐类断言：**优先数值探针（`?plaqprobe=1`/`?mmprobe=1`）+ 离线复算**，不要写像素阈值（截图目测误差 >60px，Read PNG 还会等比缩小）。
- ⚠ 本机环境：**WMIC 已进黑名单**（查进程用 `netstat -ano` + `tasklist /FI` + `taskkill /PID`）；**PowerShell 工具输出会被吞** ⇒ 诊断走 Node；Bash shim 缺 `ls/cd/dirname` ⇒ 先 `export PATH="/c/Program Files/Git/usr/bin:$PATH"`。
- ⚠ **后台起的实例/服务活不过一个回合** ⇒ **起实例 + 跑实机判据必须同一回合**；跨回合先 `net.connect` 探端口，别直接怀疑代码。仓库外起临时实例时 `/api/debug/snap` 落在**实例自己目录**旁（`FindRoot` 向上找 `web/index.html`）⇒ `live_cap` 必超时但探针其实已写出（细则 → skill §35.2/§35.3）。
- ⚠ 文档-磁盘漂移：`verify/_vv_crop.mjs` / `verify/_vv_pick.mjs` 文档里被当「常驻工具」引用，但**磁盘上不存在**（要用先按文档接口重建）。
