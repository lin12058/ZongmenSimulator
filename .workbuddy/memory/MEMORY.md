# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块的契约与坑**。灵脉/建筑/小地图地形层细则 → 同目录 `DETAILS-引擎与表现层.md`；历史叙事 → daily log 与 `待办事项/前端表现升级-匾额山体云气.md(§A~P)`；跑法/验收姿势 → skill `zongmen-verify-pipeline`（⚠ **没有** `zongmen-regression` 这个 skill，旧备忘里的名字是错的）。

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
- ⚠ **抽样格必须世界对齐**：`q%m==0 && r%m==0`，缓存键只有 `q,r`、与视图无关。初版=画布像素反投影取格 ⇒ **视图锁定**，一平移/缩放几乎全落新格 ⇒ 大面积「未探测」(实测截图 46.5%、默认档漏格 63%)。层级 `m≈ceil_pow2(step像素×wpp/hexW)`；重建列表先铺 `m*8/m*4/m*2` 再铺 `m`(粗层引导)；游标 `pendingIdx` 取代 `Array.shift()`。量化与验收口径见 DETAILS。
- 防卡：`SAMPLE_BUDGET_MS` 按帧间隔自适应(clamp(dt*0.35, 10, 110)) + `SAMPLE_CELLS_MAX`/`REDRAW_MS` 节流；**隐藏 = 真停摆**(tick 直接 return)。⚠ 面板 clip-path 裁整棵子树 ⇒ 全屏浮层/tooltip 须与 .panel 同级兄弟。
- 契约 `verify/frontend_smoke.mjs::checkMinimap`：源码守卫(零轮询/旧符号清除/单点注入) + 用 Engine/js 复算上色(0 越界、≥3 种地貌色) + **抽样格世界对齐 / 视图内无空洞 / 平移缩放复用率 ≥90%**（41/41）。实机取数：`?mmprobe=1`(按时间点采 probe 并 POST `/api/debug/snap`)、`?mmdrive=1`(真 WheelEvent/鼠标事件驱动)、`?mmwpp=N`(全屏档初始缩放)。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，**先按 git ls-files 过滤被跟踪名单**；禁 shell 通配与 git rm。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ 别按 `_` 前缀当临时件：`verify/_scratch_diag.mjs` 是**被跟踪**的。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 统计 `git ls-files` 必须带 `-c core.quotepath=false`，否则假 0。

## 构建 / 验证（跑法/姿势详见 skill `zongmen-verify-pipeline`）
- ⚠ Chrome `--headless=new` 忽略 `--window-size`(精确尺寸须旧版)；实机自截 `verify/live_cap.mjs <url> <out> 90 1400x900`(capture=1，落共享 verify/capture.png ⇒ 串行)；**截前须预热 URL 参数 `capmin=N`**(就绪阈值 chunkData>=3 在低缩放太松，不加则同 URL 两帧可差 20%)；看板 tools/prop_sheet.mjs；裁切 verify/crop_png.mjs。
- ⚠ CDP `Runtime.evaluate`/`Page.captureScreenshot` 对本页**永久挂起**(>100s) ⇒ 别用来取数；改用探针页 + live_cap 差分 或 `?mmprobe=1` 时间序列。
- ⚠ 图上量坐标目测必错(>60px) ⇒ 连通域检测或叠 `?plaqdbg=1`；⚠ 别把「期望屏幕坐标」硬编码进探针(偏 >60px 全废) ⇒ 从新旧差分自证或读 `__probe()`。量高度别用固定屏幕窗口跨机位、别用 RGB 阈值(橙花树假命中金灵脉)；实机同档邻格精灵必互盖 ⇒ 单格高度靠同底同刻度看板判。量「已缩放的小目标」剪影别用固定阈值 ⇒ 改用与阈值无关的量(峰底宽 maxRun)。⚠ Read PNG 返回 "content filtered" ⇒ 探针页 `getImageData` + Chrome `--dump-dom` 取 stdout(见 skill `webgl-headless-verify`)。
- 基线：离线脚本全绿(check_vein_skin 35、check_vein_cluster 7、check_no_build_on_vein 5、check_settle_spacing 6、check_sea_village 11、check_vein_settle_gap 8、check_preview_* ×4、check_edge_falloff、w5 半径 12、w6、w3_bfs_road、**frontend_smoke 41**)，服务端 verify_map/w1/w2/w4 全绿。⚠ `check_cloud_zoom.mjs` 需实机截图参数，裸跑 rc=2 属正常。⚠ 服务端验证别 kill 用户 8140：起**临时独立实例**(`Zongmen__Port=8141 Zongmen__DbPath=db/zongmen.verify.sqlite`，jsDir 仍指源码树) + `verify_map <url>` 传参。⚠ `w3_bfs_road` ⑦ 两条**墙钟**阈值是**机器绝对速度门槛** ⇒ 跨机复验别当回归。
