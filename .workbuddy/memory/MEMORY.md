# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块的契约与坑**。灵脉/建筑/小地图地形层细则 → 同目录 `DETAILS-引擎与表现层.md`；历史叙事 → daily log 与 `待办事项/前端表现升级-匾额山体云气.md(§A~P)`；跑法/验收姿势 → skill **仓库内 `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`**（§1~§27，随仓库走）。⚠ 2026-09-15 夜**已归并**：用户级 `zongmen-regression` 的独有章节（本机前提 / 副本 A/B / 顺序无关 harness / 断言式补丁 / 误删事故 / 漏跟踪审计 / vein-skin 契约）并成 **§20~§27**，该副本已删（备份 `%TEMP%/zongmen-regression.bak-20260915`）⇒ 现只有一份，无同名异实。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140（`127.0.0.1` 与 LAN `192.168.63.62` 均通）；引擎 Engine/js/，前端 web/js/。
- ⚠ 并行 Edit 偶发只落第一条、回执却全报成功 ⇒ 改完必 grep 复核。
- 生成参数真源 Engine/js/mapgen-config.js，bundle 序 `[noise, mapgen-config, mapgen, mapgen-server]`。⚠ Node 侧加载引擎必须带它(同序)且先 `global.window = globalThis`；漏加载 ⇒ 静默跑旧参数、参照世界≠服务端。
- 改引擎 js ⇒ ① sync_preview_inline --check ② 重启服务端 ③ 载荷变则停服清 db/zongmen.sqlite*。
- edgeKeep 是「保留」权重(衰减写 1-edgeKeep；写反 = 越浓越沉海)；真半径真源 MG.spiritEdgeWorld()。存储：Data(Key,Value BLOB) WAL + 250ms，只存 chunk/comm/settle(gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`)；Region 内存 LRU512；tile/fields 不落库。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；WaterD=-1 用 255 哨兵；pb.js 长度前缀必须 `var len=r.vi();var eN=r.p+len;`。
- mask 0→All 与未登录剔实体层在 MapWsHandler；onFrame 只更新命中位 rev；帧 [1B type][payload]；TileResponse 恒 gzip。写 chunk/region/settle/poi/comm/roads 必须同时 forceStaticDirty()。
- 色板真源 /api/map/meta；`sprite=row*8+col` 须在已绘制格 ⇒ 两侧字段清单必须对齐。
- ⚠ 新增图层/导出三处必挂：① JsEngineHost.cs 的 JsWorldVm.Call switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ chunkToArrays 给 null 而非空数组 ⇒ 读 .length 抛异常废整页；可选包一律判空。

## 小地图 R12 (2026-09-15 · 独立模块 + 全 WS 数据；本项目 **R11 已被「聚落↔灵脉间距」占用**，勿混)
- 退役根因：旧实现每 1.5s 轮询 HTTP `/api/map/fields` ⇒ 撞 ApiRateLimitMiddleware。`mapclient.fieldGrid` 已删，只走 meta/tile + WS。
- 交付 `web/js/minimap-vein.js`(独立 IIFE → `global.MiniMapVein`)。**热拔插单点** = main.js `initMinimap()` 里只注入 `{panel, full, snapshot, jump}`；换模块只改这一文件 + index.html 一行 script。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` 直接整页 fatal。
- 三层：**L1 地形**=前端按 seed 自算(只读 `MapGen.fields().biome/.e`，⚠ **绝不读 onRoad**，道路语义依赖 roadCache 冷热)；**L2 世界**(灵脉/聚落/道路/区域名/POI)=**全走 WS 快照**(世界是动态的，前端绝不自算)；**L3 视野**=默认档跟随主相机(FOLLOW_WPP=6，不可拖、单击展开全屏)，全屏档独立相机(拖动/滚轮锚光标/单击跳转/ESC)。
- 引擎脚本经 WS 下发：帧 `Script=4`；`ScriptRequest{name}` C→S → `ScriptPack{name, source}` S→C；`MapWsHandler.EngineScriptOrder=[noise,mapgen-config,mapgen]` 按序拼接(白名单防目录穿越)。⚠ **帧本身不 gzip，只有 `Source` 字段 gzip**。
- **R13 面板档倍率联动**：写死 `FOLLOW_WPP=6` → `panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`(与小图的恒定比例联动主相机缩放，乘积极恒等 **13.2**)；面板滚轮只改 `baseWpp`(别直接改上屏 wpp)、拖动转自由视角、归心回跟随；`localStorage['zongmen.mmView']` 持久化(含全屏档 fullWpp)。面板档驱动取数走 `?mmdrive=panel` / `?mmreload=1`。
- **U4 块色 = 金字塔多数表决**：`cell(mD)` = 4 个 `cell(mD/2)` 子格取众数(`AGG_DIV=2`、`rawM=mD/2`；`mD<2` 时与旧角点口径**逐字节相同**)。效果：与「块内 mD×mD 原生格真值多数」一致率 86.3%→**91.6%**(混合区 70→81%)，实机椒盐量 `isoPct` **6.29%→4.61%**。⚠ 代价 = 原始样本 **×4**(mD=8 实测 3.0万→12.1万格，浏览器约 10s 排空；粗层先铺满 ⇒ `miss` 全程 0、不卡帧)。A/B 做法 = 只翻 `AGG_DIV` 2↔1，**验完必 grep 复核**。`probe()` 新增 `rawM/agg/iso/isoBase/isoPct`(iso = 位图块级「与四邻全不同」的孤立块数)。
- ⚠ **抽样格必须世界对齐**：`q%m==0 && r%m==0`，缓存键只有 `q,r`、与视图无关。初版=画布像素反投影取格 ⇒ **视图锁定**，一平移/缩放几乎全落新格 ⇒ 大面积「未探测」(实测截图 46.5%、默认档漏格 63%)。层级 `m≈ceil_pow2(step像素×wpp/hexW)`；重建列表先铺 `m*8/m*4/m*2` 再铺 `m`(粗层引导)；游标 `pendingIdx` 取代 `Array.shift()`。量化与验收口径见 DETAILS。
- 防卡：`SAMPLE_BUDGET_MS` 按帧间隔自适应(clamp(dt*0.35, 10, 110)) + `SAMPLE_CELLS_MAX`/`REDRAW_MS` 节流；**隐藏 = 真停摆**(tick 直接 return)。⚠ 面板 clip-path 裁整棵子树 ⇒ 全屏浮层/tooltip 须与 .panel 同级兄弟。
- 契约 `verify/frontend_smoke.mjs::checkMinimap`：源码守卫(零轮询/旧符号清除/单点注入) + 用 Engine/js 复算上色(0 越界、≥3 种地貌色) + **原始样本格世界对齐 / 显示块 4 子格全覆盖 / 平移缩放复用率 ≥90% / U4 多数表决一致率**（全量 **51/51**）。实机取数：`?mmprobe=1`(按时间点采 probe 并 POST `/api/debug/snap`，读 `verify/capture.png` 即时间序列)、`?mmdrive=1`(全屏档驱动)/`?mmdrive=panel`(面板档驱动)、`?mmwpp=N`(全屏档初始缩放)。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，**先按 git ls-files 过滤被跟踪名单**；禁 shell 通配与 git rm。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ 别按 `_` 前缀当临时件：`verify/_scratch_diag.mjs` 是**被跟踪**的。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 统计 `git ls-files` 必须带 `-c core.quotepath=false`，否则假 0。

## 构建 / 验证（跑法/姿势详见仓库 skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`，§1~§27）
- ⚠ Chrome `--headless=new` 忽略 `--window-size`(精确尺寸须旧版)；实机自截 `verify/live_cap.mjs <url> <out> 90 1400x900`(capture=1，落共享 verify/capture.png ⇒ 串行)；**截前须预热 URL 参数 `capmin=N`**(就绪阈值 chunkData>=3 在低缩放太松，不加则同 URL 两帧可差 20%)；看板 tools/prop_sheet.mjs；裁切 verify/crop_png.mjs。
- ⚠ CDP `Runtime.evaluate`/`Page.captureScreenshot` 对本页**永久挂起**(>100s) ⇒ 别用来取数；改用探针页 + live_cap 差分 或 `?mmprobe=1` 时间序列。
- ⚠ 图上量坐标目测必错(>60px) ⇒ 连通域检测或叠 `?plaqdbg=1`；⚠ 别把「期望屏幕坐标」硬编码进探针(偏 >60px 全废) ⇒ 从新旧差分自证或读 `__probe()`。量高度别用固定屏幕窗口跨机位、别用 RGB 阈值(橙花树假命中金灵脉)；实机同档邻格精灵必互盖 ⇒ 单格高度靠同底同刻度看板判。量「已缩放的小目标」剪影别用固定阈值 ⇒ 改用与阈值无关的量(峰底宽 maxRun)。⚠ Read PNG 返回 "content filtered" ⇒ 探针页 `getImageData` + Chrome `--dump-dom` 取 stdout(见 skill `webgl-headless-verify`)。⚠ **Read 显示 PNG 会等比缩小**(1400×900 实显约 1080×694，比 0.771) ⇒ 按"看到的坐标"去裁图必裁错(2026-09-15 踩过，裁到隔壁区域) ⇒ 目测坐标先 ÷ 显示比换算回原图再裁。判"标签引线对不对得上"用项目内置 `?plaqdbg=1`(它调的是产品路径同一个 `bldgAnchor`/`veinTopU`) + 把纵向差换算成 R 倍数(R=hexR×zoom)。
- 基线：离线脚本全绿(check_vein_skin 40、check_vein_cluster 12、check_no_build_on_vein 5、check_settle_spacing 6、check_sea_village 11、check_vein_settle_gap 10、check_preview_* ×4、check_edge_falloff、w5 半径 12、w6、w3_bfs_road、**frontend_smoke 51**），服务端 verify_map/w1/w2/w4 全绿。⚠ `check_cloud_zoom.mjs` 需实机截图参数，裸跑 rc=2 属正常。⚠ 服务端验证别 kill 用户 8140：起**临时独立实例**(`Zongmen__Port=8141 Zongmen__DbPath=db/zongmen.verify.sqlite`，jsDir 仍指源码树) + `verify_map <url>` 传参。⚠ `w3_bfs_road` ⑦ 两条**墙钟**阈值是**机器绝对速度门槛** ⇒ 跨机复验别当回归。裁剪 PNG 别用硬编码的 `verify/crop_png.mjs`，改用通用版 `verify/_vv_crop.mjs <in> <out> x0 y0 x1 y1 [scale]`（自包含 PNG 解/编码；本机无 PIL）。
- **总 runner** `verify/run_regression.mjs`（默认 16 条含 `frontend_smoke`；`--offline-only` 跳服务端项 / `--with-server` 加 verify_map·w1·w2·w4 / `--base=` / `--only=` / `--skip=` / `--list`；统一清 `HTTP_PROXY` 并置 `NO_PROXY=*`；`w3_bfs_road` ⑦ 两条墙钟失败自动降级为 `warn`，不计红）。

## 渔村贴图 / 归属势力 / 匾额引线（2026-09-15 · 规划见 `待办事项/渔村贴图重画与归属势力底图-规划.md`）
- **渔村：有生成、无专属贴图**。水上格走 `渔家` 地皮（`mapgen.js:988`；池 `:670` = 民房×3/仓库×2/码头/渔船坞/渔亭），但画的是内陆 `KINDS['民房']`/`['仓库']` + `waterDeck()` 干栏木台；远视图 `ICON_FN.fishing` 复用 `drawVillage`。⚠ 加"渔村皮肤"flag ⇒ **`spriteOf` 缓存 key 必须加位**（`bldg_ink.js:1913`），否则与内陆民房**串图**。主看板 `tools/bldg_sheet.mjs all|dirs …`，真实平面 `tools/bldg_town.mjs <seed> --type=fishing`。
- **归属势力不存在**：协议有 `Owner`（`MapMessages.cs:82`）但引擎恒空（`mapgen.js:1204`）；R6 地盘色 `townColor()`（`main.js:943`）是"区分同屏不同镇"的位置派生色，**非势力**。
- **匾额落点是"合成点"**：`bldgAnchor()`（`main.js:1232`）= (聚落中心格 x, 建筑格 y 的 p25) ⇒ 不对应任何真实建筑格（落点扎空地）；且 `st._anc` 首帧缓存，建筑未到会永久退化成 `(st.x,st.y)`。灵脉 `veinTopU()`（`:804`）是包络估算（hrand 取中值 + 0.35R 故意余量）⇒ 实测圆点**悬空 ≈2.1R**。机位探针 `verify/_vv_pick.mjs <seed> --R --D`（挑「聚落↔灵脉相邻」并输出 URL），证据 `verify/_vv_evidence_*.png`。
- 灵脉名文案：**`XX灵脉·大`**（去括号，`main.js:1197`/`1865`、`minimap-vein.js:626`）。⚠ `v.name` 常自带"脉/峰/谷"（LANDFORM 池 `mapgen.js:99`）⇒ 有"脉…脉"叠字，是否砍掉"灵脉"后缀待拍板。
