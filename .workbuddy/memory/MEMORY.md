# 宗门模拟器 demo · 长期备忘
> 本文件只钉**跨模块契约 & 会误事的坑**（刻意压到最小）。三个向下指针：
> - **`DETAILS-引擎与表现层.md`** —— 引擎 / 灵脉 / 建筑 / 小地图地形层 / 前端自算 / 构建验证坑 的**细则与实测数字**
> - **仓库内 skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`** §1~§39 —— **跑法 / 验收姿势 / 教训**（唯一真源；旧用户级 `zongmen-regression` 已并入其 §20~§27 并删除）
> - 同目录 `YYYY-MM-DD.md` —— 每日叙事
> （2026-09-16 压缩：原「前端自算地图」「小地图 R12/R13」「构建/验证」三节已成指针，正文迁入上面两个文件。）

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140（`127.0.0.1` 与 LAN `192.168.63.62` 均通）；⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**（旧备忘常写成 `Engine/js/`，**该目录不存在**），前端 web/js/。
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

## 小地图 R12/R13（细则 → DETAILS「小地图 R12/R13 契约」）
- 热拔插单点 = `main.js initMinimap()` 只注入 `{panel, full, snapshot, jump}`。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` **整页 fatal**。
- 三层：L1 地形 = 前端按 seed 自算（只读 `biome/e`；⚠ 绝不读 `onRoad`）／L2 世界全走 WS 快照／L3 视野（面板档跟随主相机 `FOLLOW_WPP=6`，全屏档独立相机）。
- 引擎脚本经 WS 下发：帧 `Script=4`；`EngineScriptOrder=[noise,mapgen-config,mapgen]` 按序拼接（白名单防目录穿越）。⚠ **帧本身不 gzip，只有 `Source` 字段 gzip**。
- R13 倍率联动：`panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`（乘积恒 **13.2**）；面板滚轮只改 `baseWpp`（别直接改上屏 wpp）。
- 手机档两件：触摸四闸（⚠ 触摸后浏览器 ~300ms 补发合成 `mousedown/up` ⇒ 被「未拖动⇒单击展开全屏」接住 = **一拖就弹全屏**；判据比 **`e.timeStamp`** 非 `Date.now()`）＋ `color-scheme: **only light**`（`only` 才是退出关键字）。
- **U4 块色金字塔多数表决** 与 **面板几何参数化 / 窄屏铺满** 的完整契约（实现、A/B 手法、收缩盒反馈环、`check_mm_layout.mjs` 12 档 × 8 条）→ DETAILS 末节，改这两处前必读。

## 前端自算地图（细则 → DETAILS「前端自算地形」）
- **算法完全支持且已在跑**（小地图 L1 就是前端自算）；`EngineScriptOrder` 故意不含 `mapgen-server.js`（纯搬运层）。A/B 铁证 `verify/chunk_selfcalc_ab.mjs`（6 块 × 11 段逐字节一致）。
- ⚠ 三障碍：主线程阻塞（需分帧/Worker）／`web/js/noiselib.js` 与引擎 `noise.js` **同名导出 `NoiseLib`**（主流程接入前必须收敛）／**双实例或双 `init(seed)` 会互清全部缓存**（必须单实例）。
- 接线收敛点 `main.js:317 applyBlock(job,resp)`（唯一数据分发入口，5 图层全在此落表）。已拍板：地形 chunk 改前端算 + WS `mask` 去 `CHUNK` 位（=30，服务端零改动）。
- ⚠ 长期分叉：世界一旦可写（settle 的 `state/expireTs`、`Owner`、`BumpBlockRev`）纯前端自算立即失效 ⇒ 应在协议上把「静态地形可自算 / 动态状态须服务端」分层。

## 渔村皮肤 / 归属势力 / 匾额引线（2026-09-15 已实施；单 `待办事项/渔村贴图重画与归属势力底图-规划.md` §8 = 结果+证据）
- **渔村(A)**：新增 `KINDS_FISH`（民房/仓库）画法表，`paint()` 在 `spec.fishVillage` 时优先查表；远视图标拆出独立 `drawFishing`。⚠ 加任何「影响画法」的 flag ⇒ **`spriteOf` 缓存 key 必须同步加位**，否则水陆**串图**（本次加 `|'F`）。看板 `tools/bldg_sheet.mjs all|dirs|fish`。
- **A2（2026-09-16 用户定案）水面建筑一律渔家 + 地盘环水陆都画**：**不再以「中心格是否在水里」判渔村**。引擎把「渔家」地皮从 `type==='fishing'` **放开到任何聚落的水面格**（`mapgen.js` 地皮段 `lu==='水岸'→'渔家'`）；前端 `main.js` 栈桥降为**白名单兜底** —— `WATER_KIND`(民房/仓库/码头/渔船坞/渔亭)、`bridge = onWater && !isFish && (WATER_OLD || !WATER_KIND[b.kind])`、`fishVillage: WATER_OLD ? isFish : (isFish || onWater)`、地盘环改 `if (!bridge || !WATER_OLD)` **无差别绘制**（旧 `if(!bridge)` 跳过水面格 = 用户报的「下面没有正六边形框」）。同机位 A/B 档位 **`?water=old`**；`tools/bldg_town.mjs` 镜像判据已同步。测试环境**无需清库**。
- **归属势力(B)**：走 B-A **前端派生**。`factionOf` 扫 `settleCells` 取**最近宗门**；⚠ 半径是**镜像常量** `SECT_DOMAIN_R = CFG.COMM_R(25) × 1.4 = 35`（同 `mapgen.js:1174`，跨源断言 `check_faction` A2）；⚠ 缓存 `st._fac` **必须靠 `settleVer` 失效**（首个 settle 包到货时附近可能还没宗门，只算一次会**永久锁成无归属**）。`townColor` 归属优先 ⇒ **同宗同色**；记号 `factionSig` 同源派生 crest(3~6)/crestRot(k·π/3)/seal(0~7) → `plateAt` 的 `water/crest/seal` **全部条件画**（荒野保持纯环）。协议 `Owner`(`MapMessages.cs:82`) 仍恒空 ⇒ 日后引擎补 owner 只改 `factionOf` 返回（B-B），绘制层不动。总开关 `?fac=0`；探针 `__facProbe`。
- **匾额引线(C)**：`bldgAnchor` 扎**真建筑格**（`BI.anchorOf`）；`main.js veinTopU` **委托** `VS.tipU`、`veinJxU` 委托 `VS.apexJx`（单一真源）；`renderer.js` GLSL 判档阈值走 `VEIN_SHAPE` 的 `E_MTN/S_MTN/E_SNOW/S_SNOW`；⚠ `vein-skin.js levelInfo` 越界返 `null`（原来静默归一化成「大」）。
- **C-a 锚点口径 = 城市中心点（2026-09-16 五修 · 现行默认）**：落点直接取**聚落中心格** `st.x/st.y`。依据：引擎把**核心建筑**（祠堂/村口/宗祠/集市/官衙/祖师殿…）恒定放在中心格（`mapgen.js growTownFootprint` 的 `cell.d===0`；离线实测 seed42/777 **465 座全部成立**）⇒ 点恒落在真建筑上，且**根本不读建筑清单 ⇒ 对离群地物恒等免疫**。⚠ 前四修（合成点→列最近→中位格→最密格+平手参照物）**全部降级为 A/B 档位** `?ancgeo=densest|box|col|med|sum`，不再走线上默认。灵脉签同理：默认落点 = **灵脉格心**（地盘色环/灵脉花所在处），旧峰尖口径降为 `?veinpt=apex`（**两档签位逐像素相同**，只差圆点/引线终点）。契约 `check_plaque_align` **79 条**（A/B 段=历史档位仍可复现；**E 段**=抽 main.js 真实源码跑行为 + 引擎交叉源）；探针 `?plaqprobe=1` 新增 `anc/veinpt/coreOn/ctrX,ctrY`（可逐点核 `dotX==ctrX`）；fixture `verify/anc_fixture.json`。⚠ 教训：用户说「要某个东西的中心点」时，先查那个中心点在数据里**是不是已存在**——前几轮全在"用统计量去猜一个给定的值"（skill §35）。
- 灵脉名 **`XX灵脉·大`**（`main.js:1197`/`1865`、`minimap-vein.js`）。⚠ `v.name` 常自带「脉/峰/谷」⇒ 叠字，是否再砍「灵脉」后缀**待用户拍板**。

## 世界种子 / 设置组件 / 灵脉签色（W · 2026-09-16 已实施）
- **种子 = 服务端资产**：`Server/Zongmen/Storage/WorldLedger.cs` **独立表** `World(Round,Seed,BornAt)`（⚠ 绝不能塞 `Data(Key,Value)` —— `PruneExcept` 按前缀 DELETE 会**静默删掉**台账）＋ `GET /api/world/current`（幂等，空库就地开第一世）/ `POST /api/world/next`（另启一世）/ `GET /api/world/list`。前端 boot `await worldFetch('/api/world/current')`；**拿不到种子直接 `showFatal`，绝不回落前端造**。⚠ `?seed=` 保留为调试覆盖（不入账、`src:'url'`）——削掉即废掉整条验证管线。
- **设置唯一真源 `web/js/store.js`（`window.ZMStore`）**：键 `zongmen.settings.v1`；schema 白名单 `{veins,nameSettle,nameVein,nameRegion,clouds}`；读路径只读内存副本（不逐帧 `getItem`）／写 200ms 节流 + `pagehide` 强写／坏 JSON 与无 localStorage 静默降级。右上角只剩 ⚙ `#btnGear` → `#settingsWrap` 弹窗；复选框 `data-zm` **只往 store 写**，渲染变量由 `S.settings.on(applySettings)` 单向下发。⚠ 变量名 `showVeins/showLabels` **不能改**（`frontend_smoke` 逐名扫原文）。
- **灵脉签五行色（C-b）**：`drawNameBanner` 走**两道** —— 同路径上再敷一层「向纸色提亮 `VEIN_WASH_MIX=0.40`」的渐变（`VEIN_WASH_A0/A1=0.30/0.46`），描边 = `mixRGB(tint,[72,58,40],0.52)`，印章用本色 `0.86`；灵脉名单独开关 `nameVein`（`?nobanner=1` 仍一键全关）。
- ⚠ **`check_calc_local` / `check_mm_ui` 不认 `--base=`**，只认**位置参数 URL**（`run_regression` 正是位置传的）。手跑隔离实例必须 `node verify/xxx.mjs http://127.0.0.1:8150`，否则静默打 8140。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，**先按 `git -c core.quotepath=false ls-files` 过滤被跟踪名单**；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ 别按 `_` 前缀当临时件：`verify/_scratch_diag.mjs` 是**被跟踪**的。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 统计 `git ls-files` 必须带 `-c core.quotepath=false`，否则假 0。

## 构建 / 验证（跑法见 skill §1~§39；**会踩的坑清单 → DETAILS 末节**）
- 基线（离线）**18 条** + 在线 **4 条**；总 runner `verify/run_regression.mjs`（`--offline-only` / `--with-server` / `--base=` / `--only=` / `--skip=` / `--list`）。服务端 verify_map / w1 / w2 / w4 全绿。
- ⚠ **服务端验证别 kill 用户 8140** ⇒ 起临时独立实例，且 **`MaxSeeds` 必须显式放大**（默认 3，`check_mm_ui` 每次用新随机 seed ⇒ 连跑几次名额用满，判据报「快照未就绪」，**长得像产品回归**）。姿势见 skill §22。
- ⚠ 判据三防：① 绝对值阈值必假红 ⇒ 改 **A/B 归因** ② **参照系不能是被测规则自己的目标函数**（自证陷阱）⇒ skill §32 ③ 复算必须与实现**同容差语义**（2e-13 的 tie 就能翻案）⇒ skill §32.1。
- ⚠ 几何对齐一类断言：**优先数值探针（`?plaqprobe=1` / `?mmprobe=1`）+ 离线复算**，不要写像素阈值（截图目测误差 >60px，Read PNG 还会等比缩小）。
- ⚠ **文档-磁盘漂移（2026-09-16 发现，待用户拍板）**：`verify/_vv_crop.mjs`（裁图放大，自包含 PNG 解/编码）与 `verify/_vv_pick.mjs`（挑机位，`<seed> --R=10 --D=8`）**磁盘上不存在**，但仍被 `.gitignore` 注释与 `待办事项/渔村贴图…规划.md` 当「常驻工具」引用（本文件旧版也引过）。要用先按文档接口重建。
- ⚠ 本机环境：**WMIC 已进程序黑名单**（查进程改用 `netstat -ano` 取 PID + `tasklist /FI` 验镜像名 + `taskkill /PID`）；**PowerShell 工具输出会被吞**（exit 0 无 stdout）⇒ 诊断走 Node；Bash shim 缺 `ls/cd/dirname` ⇒ 先 `export PATH="/c/Program Files/Git/usr/bin:$PATH"`。
- ⚠ **后台起的实例/服务活不过一个回合**（2026-09-16 实测）⇒ **起实例 + 跑实机判据必须同一回合**；跨回合先 `net.connect` 探端口，别直接怀疑代码（端口 CLOSED 却看着像产品回归）。仓库外起临时实例时 `/api/debug/snap` 会落到**实例自己目录**旁边（`FindRoot` 从 exe 向上找 `web/index.html`）⇒ `live_cap` 必然超时、但探针其实已写出，去那条路径读（细则 → skill §35.2/§35.3）。
