# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块契约与坑**。表现层/灵脉/建筑/小地图地形层细则 → 同目录 `DETAILS-引擎与表现层.md`；跑法/验收姿势 → 仓库内 skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`（§1~§27，**唯一真源**；旧用户级 `zongmen-regression` 已归并入其 §20~§27 并删除）；叙事 → daily log。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140（`127.0.0.1` 与 LAN `192.168.63.62` 均通）；⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**（旧备忘常写成 `Engine/js/`，**该目录不存在**），前端 web/js/。
- ⚠ 并行 Edit 偶发只落第一条、回执却全报成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `Server/Zongmen/Engine/js/mapgen-config.js`，bundle 序 `[noise, mapgen-config, mapgen, mapgen-server]`。⚠ Node 侧加载引擎必须带它(同序)且先 `global.window = globalThis`；漏加载 ⇒ 静默跑旧参数、参照世界≠服务端。
- 改引擎 js ⇒ ① sync_preview_inline --check ② 重启服务端 ③ 载荷变则停服清 `db/zongmen.sqlite*`。
- edgeKeep 是「保留」权重(衰减写 `1-edgeKeep`；写反 = 越浓越沉海)；真半径真源 `MG.spiritEdgeWorld()`。存储：Data(Key,Value BLOB) WAL + 250ms，只存 chunk/comm/settle(gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`)；Region 内存 LRU512；tile/fields 不落库。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；WaterD=-1 用 255 哨兵；pb.js 长度前缀必须 `var len=r.vi();var eN=r.p+len;`。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**（未命中保持 0=未持有）；帧 `[1B type][payload]`；TileResponse 恒 gzip。
- 写 chunk/region/settle/poi/comm/roads 必须同时 forceStaticDirty()。
- 色板真源 `/api/map/meta`；`sprite=row*8+col` 须在已绘制格 ⇒ 两侧字段清单必须对齐。
- ⚠ 新增图层/导出三处必挂：① JsEngineHost.cs 的 JsWorldVm.Call switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ chunkToArrays 给 null 而非空数组 ⇒ 读 .length 抛异常废整页；可选包一律判空。

## 小地图 R12/R13 (热拔插独立模块 + 全 WS 世界层；地形层细则见 DETAILS)
- 热拔插单点 = main.js `initMinimap()` 只注入 `{panel, full, snapshot, jump}`；换模块只改它 + index.html 一行 script。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` 整页 fatal。
- 三层：**L1 地形** = 前端按 seed 自算(只读 `biome/e`；⚠ 绝不读 onRoad)；**L2 世界**(灵脉/聚落/道路/区域名/POI) 全走 WS 快照；**L3 视野** = 面板档跟随主相机(FOLLOW_WPP=6；拖动/触摸拖转自由视角、滚轮/捏合改 `baseWpp`、未移动单击展开全屏) / 全屏档独立相机。
- 引擎脚本经 WS 下发：帧 `Script=4`；`ScriptRequest{name}` C→S → `ScriptPack{name, source}` S→C；`MapWsHandler.cs:26 EngineScriptOrder=[noise,mapgen-config,mapgen]` 按序拼接(白名单防目录穿越)。⚠ **帧本身不 gzip，只有 `Source` 字段 gzip**。
- R13 倍率联动：`panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`(乘积恒 **13.2**)；面板滚轮只改 `baseWpp`(别直接改上屏 wpp)、拖动转自由视角、归心回跟随；`localStorage['zongmen.mmView']` 持久化。驱动参数 `?mmdrive=panel` / `?mmdrive=1` / `?mmreload=1`。
- **U4 块色金字塔多数表决** 与 **面板几何参数化 / 窄屏铺满** 两条的完整契约(实现、A/B 手法、收缩盒反馈环、`check_mm_layout.mjs` 12 档 × 8 条) → **`DETAILS-引擎与表现层.md` 末节**，改这两处前必读。
- **手机档两件**（2026-09-15）：① 原只绑 `mouse*` ⇒ 手机上零交互；补齐触摸(单指拖=平移+脱离跟随、双指捏合=**等价滚轮只改 `baseWpp`**、未移动抬指=展开全屏/跳转)、`TOUCH_SLOP=8`、画布 `touch-action:none`。⚠ **合成鼠标事件**：触摸结束后浏览器 ~300ms 补发 `mousedown/up` ⇒ 被「未拖动⇒单击展开全屏」接住 = **一拖就弹全屏**；`fromTouch(e)` 四闸全挂(比 **`e.timeStamp`** 非 `Date.now()`，600ms)。② 变暗来自宿主**算法暗化**(本机三组 flag 截图逐像素近乎相同 ⇒ 复现不出) ⇒ `<meta>`/`:root` 齐写 `color-scheme: **only light**`(**`only`** 才是退出关键字)。判据 `verify/check_mm_ui.mjs`(14 条, 已挂 live 组 ⇒ 回归 **18 条**)，细则见 skill §29/§30。
- 契约 `verify/frontend_smoke.mjs::checkMinimap`(源码守卫零轮询/旧符号清除/单点注入 + 用引擎真源复算上色 + **原始样本格世界对齐 / 显示块 4 子格全覆盖 / 平移缩放复用率 ≥90% / U4 多数表决一致率**，全量 **51/51**)。实机取数：`?mmprobe=1`(按时间点采 probe 并 POST `/api/debug/snap`，读 `verify/capture.png` 即时间序列)、`?mmwpp=N`(全屏档初始缩放)。

## 前端自算地图 (2026-09-15 · 规划 `待办事项/地图前端自算可行性-规划.md`；**实施单 `待办事项/地形chunk前端自算-实施单.md`**)
- 结论：**算法完全支持，且已在跑**(小地图 L1 地形层就是前端自算)。`EngineScriptOrder` 故意**不含 mapgen-server.js**(纯搬运层) ⇒ 前端拿到的是原封不动的生成逻辑；缺的只是打包层，而打包层可本地融合复刻。
- **A/B 铁证** `verify/chunk_selfcalc_ab.mjs`：6 块 × 11 段(`cq/cr/tiles/elev/hash/neigh/pdx/pdy/psp/ph/pe`) vs 真实 WS `mask=CHUNK` **逐字节一致**。成本 `verify/chunk_selfcalc_bench.mjs`：eval 4 文件 8.4ms、`init(seed)` 0.8ms、`buildChunk` 冷 2.46/热 0.62ms、首屏 25 块冷 **61.4ms(比服务端「算+打包+b64」69.2ms 更快)**；region×25 69.4ms(最大头；服务端写死 `REGION_ROAD_BUDGET=9999` ⇒ 首请求 ~195.8ms 阻塞同 VM)、settle×25 10.9ms、comm×25 0.45ms；全图 3249 块 ≈20s。
- 引擎 = **确定性纯函数 + 内存缓存**(淘汰只损命中率，不改结果)；`roadsNear(i,j,maxNew,cq,cr)` 的预算/中心**只决定先算哪些边**，收敛后与不传完全一致 ⇒ 道路同样可自算。服务端存储(`w:{seed}:chunk/region/settle/comm`) **100% 是算力缓存，无世界真值**。
- 三障碍：① 主线程阻塞(需分帧/Worker) ② ⚠ `web/js/noiselib.js`(视觉噪声)与引擎 `noise.js` **同名导出 `NoiseLib`**(现靠 minimap `finally` 还原 + `textures.js:15` 顶层捕获规避，主流程接入前必须收敛) ③ 双实例/双 `init(seed)` 会**互清全部缓存**(4 倍性能差) ⇒ 必须单实例。
- 接线收敛点：`main.js:317 applyBlock(job,resp)` 是**唯一**数据分发入口(5 图层全在此落表)；`MC.block` 全项目**只被 `main.js:295` 调一次**。⚠ 已拍板：地形 chunk 改前端算 + WS `mask` 去 `CHUNK` 位(=30，服务端零改动)。
- ⚠ 长期分叉点：世界一旦可写(`settle` 的 `state/expireTs`、`Owner`、`BumpBlockRev` 均是伏笔)，纯前端自算立即失效 ⇒ 应把「静态地形可自算 / 动态状态须服务端」在协议上分层。

## 渔村皮肤 / 归属势力 / 匾额引线 (2026-09-15 **已全部实施并验收**；单 `待办事项/渔村贴图重画与归属势力底图-规划.md` §8 = 结果+证据)
- **渔村(A) 已修**：新增 `KINDS_FISH`(民房/仓库) 画法表，`paint()` 在 `spec.fishVillage` 时**优先查表**；远视图标拆出独立 `drawFishing`。⚠ 加任何「影响画法」的 flag ⇒ **`spriteOf` 缓存 key 必须同步加位**，否则水陆**串图**（本次已加 `|'F'`；契约 `check_fish_skin` 44 条的主断言就是「水陆是两张不同缓存条目」）。看板 `tools/bldg_sheet.mjs all|dirs|fish`，真实平面 `bldg_town.mjs <seed> --type=fishing`。
- **归属势力(B) 已修，走 B-A 前端派生**：`factionOf` 扫 `settleCells` 取**最近宗门**；⚠ 半径是**镜像常量** `SECT_DOMAIN_R = CFG.COMM_R(25) × 1.4 = 35`（同 `mapgen.js:1174` 判灵脉域口径，跨源断言在 `check_faction` A2）；⚠ 缓存 `st._fac` **必须靠 `settleVer` 失效**（首个 settle 包到货时附近可能还没宗门，只算一次会**永久锁成无归属**，旧 `bldgAnchor` 踩过）。`townColor` 归属优先 ⇒ **同宗同色**（色相全周展开，区别于 R6 的位置派生色）；记号 `factionSig` 同源派生 crest(3~6)/crestRot(k·π/3)/seal(0~7) → `plateAt` 的 `water/crest/seal` **全部条件画**（荒野保持纯环）。协议 `Owner`(`MapMessages.cs:82`) 仍恒空 ⇒ 日后引擎补 owner 只改 `factionOf` 返回（B-B），绘制层不动。总开关 `?fac=0`；探针 `__facProbe`。
- **匾额引线(C) 已修**：`bldgAnchor` 改扎**真建筑格**（`BI.anchorOf`，不再用「中心格 x + p25」的合成点）；`main.js veinTopU` **委托** `VS.tipU`（单一真源）；`renderer.js` GLSL 判档阈值改走 `VEIN_SHAPE` 的 `E_MTN/S_MTN/E_SNOW/S_SNOW`；⚠ `vein-skin.js levelInfo` 越界现在返 `null`（原来静默归一化成「大」）。契约 `check_plaque_align` 39 条。机位探针 `verify/_vv_pick.mjs`，引线调试 `?plaqdbg=1`。
- 灵脉名 **`XX灵脉·大`**(`main.js:1197`/`1865`、`minimap-vein.js`)。⚠ `v.name` 常自带「脉/峰/谷」⇒ 有叠字，是否再砍「灵脉」后缀待拍板。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，**先按 git ls-files 过滤被跟踪名单**；禁 shell 通配与 git rm。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ 别按 `_` 前缀当临时件：`verify/_scratch_diag.mjs` 是**被跟踪**的。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 统计 `git ls-files` 必须带 `-c core.quotepath=false`，否则假 0。

## 构建 / 验证 (跑法/姿势最新真源 = 仓库内 skill `zongmen-verify-pipeline/SKILL.md` §1~§27，本节只留「会踩的坑」)
- ⚠ 截图：`--headless=new` 忽略 `--window-size`(精确尺寸须旧版)；实机自截 `verify/live_cap.mjs <url> <out> 90 1400x900`(capture=1，落共享 `verify/capture.png` ⇒ **串行**)；**截前必须预热 `capmin=N`**(就绪阈值 chunkData>=3 在低缩放太松，不加则同 URL 两帧可差 20%)；裁剪用通用版 `verify/_vv_crop.mjs <in> <out> x0 y0 x1 y1 [scale]`(自包含 PNG 编解码，本机无 PIL)，别用硬编码的 `crop_png.mjs`。
- ⚠ CDP `Runtime.evaluate`/`Page.captureScreenshot` 对本页**永久挂起**(>100s) ⇒ 改用探针页 + `?mmprobe=1` 时间序列 或 live_cap 差分。⚠ 目测坐标必错(>60px)：量标签引线用 `?plaqdbg=1`(走产品同一个 bldgAnchor/veinTopU)并换算成 R 倍数(R=hexR×zoom)；别把「期望屏幕坐标」硬编码进探针；量高度别用 RGB 阈值。⚠ **Read 显示 PNG 会等比缩小**(1400×900 实显约 1080×694) ⇒ 目测坐标先 ÷ 显示比再裁。⚠ Read PNG "content filtered" ⇒ 探针页 `getImageData` + `--dump-dom` 取 stdout(见 skill `webgl-headless-verify`)。
- 基线(离线) **18 条**：frontend_smoke **79**、check_plaque_align **39**、check_fish_skin **44**、check_faction **72**、check_vein_skin 42、check_mm_layout、vein_cluster 12 / no_build_on_vein 5 / settle_spacing 6 / sea_village 11 / vein_settle_gap 10 / preview_* ×4 / edge_falloff / w5 / w6 / w3_bfs_road；在线 4 条 = frontend_smoke + check_mm_layout 8 + check_mm_ui 14 + check_calc_local 11。服务端 verify_map/w1/w2/w4 全绿。
- ⚠ 服务端验证别 kill 用户 8140 ⇒ 起**临时独立实例**：`dotnet build Server/Zongmen/ZongMen.csproj -o verify/_vmsrv -p:UseAppHost=false` 后 `Zongmen__Port=8157 Zongmen__MaxSeeds=64 Zongmen__DbPath=<%TEMP%/…>.sqlite dotnet verify/_vmsrv/ZongMen.dll`（`Options.FindRoot` 会向上找到仓库根 ⇒ 自动用仓库 web/ 与 Engine/js）。⚠ **`MaxSeeds` 必须显式放大** —— appsettings 默认 3，而 `check_mm_ui` 每次用**新随机 seed**，连跑几次就把名额用满 ⇒ 页面拿不到世界、判据报「快照未就绪」，**长得像产品回归**。查法 `curl /api/map/stats` 看 `liveSeeds == maxSeeds`。⚠ 跑完 kill **只按命令行含 `_vmsrv` 的 dotnet PID**（`wmic process where "name='dotnet.exe'" get processid,commandline`）+ 删 `verify/_vmsrv`。
- ⚠ **Chrome profile 泄漏**：`live_cap.mjs`/`check_mm_layout.mjs` 曾把 `rmSync(profile)` 放 `setTimeout` 而紧接着 `process.exit()` ⇒ 定时器永不触发；本机 `%TEMP%` 曾积 **255 个 `wb-*` 目录 / 3.54 GB**（已改**同步删+重试**，`Atomics.wait` 当同步小睡）。⚠ **别在回归跑动中清 `%TEMP%/wb-*`** —— 会删掉在跑的判据 profile 并当场假红（自伤）。⚠ 清 `wb-*` 时**别碰无短横的 `wb/`**（隔离实例的库在里面）。
- ⚠ 判据「绝对值阈值」在 headless 下极易假红 —— 例：`check_calc_local` 的 S5 原判「hybrid 首屏最长任务 ≤50ms」恒红 ~250ms，归因后发现 **server 档（零本地算）也 245~254ms** ⇒ 那是 WebGL/着色器/图集启动开销。**改成 A/B 归因**（hybrid ≤ server + 40ms）才对。
- ⚠ `frontend_smoke` 的「解码字段读取审计」按**项目约定**放行 **`_` 前缀**属性（线路 protobuf 字段不带下划线 ⇒ `_xxx` 只可能是前端自挂 memo：`_anc`/`_fac`/`_facV`）。别再加白名单条目。
- **总 runner** `verify/run_regression.mjs`（默认 **18 离线 + 4 在线 = 22**；`--offline-only` / `--with-server` / `--base=` / `--only=` / `--skip=` / `--list`；统一清 `HTTP_PROXY` 置 `NO_PROXY=*`；w3 墙钟失败自动降级 warn）。
