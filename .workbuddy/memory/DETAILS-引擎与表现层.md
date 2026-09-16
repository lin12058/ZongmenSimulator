# 细节契约 · 引擎 / 灵脉 / 建筑表现层
> `MEMORY.md` 的配套细节文件。需要动灵脉或表现层时读本文件。所有 check_*.mjs 是这些契约的可执行真源。

## 灵脉契约 (真源 web/js/vein-skin.js → global.VeinSkin，挂 textures.js 前)
- 结构 shape / elements 五行 / variants 四异灵根 / dual / **levels 四档(0大 1中 2小 3从属)** / levelInfo()。⚠ `elements[].glow==mapgen ELEMENT_RGB`、`variants[].glow==VARIANT_RGB`、键序==VEIN_VARIANT_ORDER；`levels[i].level==veins[].level`、hScale 严格递减且可视高度互不重叠。`check_vein_skin.mjs`(35 项，含「又高又瘦」) 钉死，改后必跑。
- **占地 7/3/1**：`veinFootKeep(level,dq,dr)` 大=hexDist≤1(7格) / 中=本格+(-1,1)+(0,1)(3格) / 小=仅本格；d≥2 不留。从属格 level=`CFG.VEIN_SAT_LEVEL(=3)`(专用第4档，**不是**"中心档+1")且**绝不进 comm.veins[]**(否则多名牌/统计虚高/污染群落与 veinNear)。`fields()` 守卫 `vn.d<=1 && e>=SEA_LEVEL && veinFootKeep(...)`；buildChunk 用 `e: f.vein?f.vein.level:f.e`(复用海拔通道)。判据 `check_vein_cluster.mjs`(26 项，含 §D)。⚠ 已知非缺陷：相邻两群落次级灵脉可落同一整数格 ⇒ veinNear 全局最近裁其一 =「幻影灵脉」(名牌叠字)，不破 7/3/1。
- **地盘彩环 = 同口径（十四版 2026-09-16）**：旧做法只 `hexPath(v.x, v.y)` 垫中心 1 格（用户报障：「大灵脉 1 格外面 6 格，中的是 1 格下面 2 格 … 地盘彩环没有对应的另外 6 格和 2 格」）。
  真源 = `web/js/vein-skin.js` `footOffsets(level, MG)`：偏移池 `FOOT_OFF` = 本格 + 六邻（序同 `NEIGH_SLOTS`）；**引擎就绪时直接问引擎** `MG.veinFootKeep`，镜像表 `FOOT_MIRROR`（大 `[0..6]` / 中 `[0,2,3]` / 小 `[0]`）只在 `EngineLocal.load` 失败时兜底。
  `main.js`：先铺满全部格再统一描边；本格恒用封包 `(v.x, v.y)`；`veinOwnerOf` 做**归属裁决**（镜像引擎 `veinNear` 的 9 宫格最近规则；`veinAll` 先按 (q,r) 排序 ⇒ 与 comm 包到达序无关）；海里（`elevAtTile < geo.seaLevel`）不铺、海拔未到货 (-1) 照画。
  §D **14 条**（跨源逐值 ×4 档 + 偏移池序 + 源码守卫「已接线 / 旧写法不复活 / 探针齐备」）；实机取数 `?veinprobe=1` → `__feat().veinRings`（逐根 `{name,lv,n}`）。实测 seed42 机位 `qt=-248&rt=-178&zm=2.4`：大 9 根全 7 / 中 10 根全 3 / 小 20 根全 1。
- **上屏尺寸**：PROP_VS 按还原等级取 hs 大1.90/中1.58/小1.22 + 收窄 hrand ⇒ 相对分档 H 大[63,68]>中[55,57]>小[41,43]px(uR=8)。`shape.sizeScale:0.40` = **唯一「上屏尺寸」旋钮**，PROP_VS 只对**峰体**再乘一次(W/H 同乘 ⇒ 比值不变)，**底座不乘**。字面量 EPS=1/1024 + toFixed(3) 防 FP 尾数入 GLSL。⚠ 改系数须同步 tools/prop_sheet.mjs。
- **山形/渐隐** `veinPeakPts()` 独立成形(topW0.30/seg11/topSeg7/fade0.50/miDian12；wScale0.95 ⇒ W/H≈1.031)。⚠ **渐隐只能靠 alpha 渐变、不能靠叠雾**(旧 mist 叠加会把渐隐糊实 ⇒ 已删/降档)。判渐变看**前景中位 alpha**：灵脉 半腰187→山脚9(20.8) vs 大世界山 137→44(3.1)。⚠ 别用 RGB 阈值。
- **山地底座** `SHAPE.terrainBase:1.0`(0 = 关回七版) ⇒ 把**该格原山**垫在峰下(与大世界山**同档公式** MTN 0.55/1.30、SNOW 0.95/1.55；海拔<0.70 自动为 0)。`shape.terrainBaseMin=0.30` 兜小档底座(LIFT_CORE[2]=0.70 压严格边界 ⇒ 无下限恒 0)。名牌锚点见 `veinTopU()`。⚠ **u16 海拔通道装不下两个量** ⇒ refreshChunkProps 写 `iElev=(等级+海拔)/4`(四档)，shader `vz=clamp(iElev,0,1)*4`、`等级=floor(vz)` / `海拔=frac(vz)`、`min(floor(vz),3.0)`；max=(3+1)/4=1.0 恰好不溢出。
- **`SHAPE.terrainBaseW:0`**(0≤tbw≤1.2)：PROP_VS 的 vbaseW 再乘 VBASEW。⚠ 底座**宽度**若也叠加 ⇒ 总框 W/H≈1.24(宽>高)，与「又高又瘦」相反；=0 时总框 3.06×6.75~10.39 uR、**W/H 0.45**。要**再拔高**抬 terrainBase(只乘高)、要**更瘦**收 wScale(只乘宽)。
- `propSpriteFor`: variant→32+idx 否则 b+42(row4=id32..35 异灵根、row6 col2..6=id50..54 五行)。定点 seed42：金(-8,0)、群落(4,3)=大(247,192)/中(243,168)/小(226,194)。

## 建筑 / 表现层 / 道路
- 建筑真源 mapgen.js `BUILDINGS`+`CORE_KIND`(26 种)；绘制真源 web/js/bldg_ink.js(挂 main.js 前) ⇒ drawBuildings()。⚠ 三坑：① DIRS 必须 sqrt(3)/2 ② 区块归属禁 `round(q/chunkS)`，须枚举 4 候选 ③ S.p/S.d 必须从 this.fx/fy 读。⚠ bldg_ink.js 是独立 IIFE ⇒ 改完必须 eval + 冒烟(曾因 paint() 漏 `var fn` 整层崩)。
- **中空地盘**：`hexPlate`(精灵内/看板/预览) 与 `plateAt`(main.js 现画·城镇色) 同步 = 半径带 **[0.80R, 0.90R] 中空环**；实现 = 「以 mid=0.85R 的六边形描宽 (rOut-rIn) 的边」(两后端只有单环 poly/line，无 even-odd 填充)；`solid:true` 回退七版实心块。0.90R<1R 且邻格中心距 √3R ⇒ 密排环不相接；海上渔村走同一函数 ⇒ 自动生效。
- **城镇地盘色**：`plateAt` 直画 2D 上下文、**不进 `_spr` 缓存**(`spriteOf` key 补 plate 位 `|p/n` 防串色)；main.js `townColor(st)` 由 q,r,type 派生确定性 HSL(色相分带 城22/镇46/村142/宗268/渔196 ±14)，贴精灵前逐格现画、精灵侧 `plate:false`。
- **渔村形态**：⚠ 根因不是渲染分支而是**建筑配比** —— `landuseOf` 把浅海/沙岸一律判 `水岸`，而 `BUILDINGS.水岸` 池只有 码头/渔船坞/渔亭 ⇒ 渔村 8 格全是栈桥。修法：mapgen.js 新增地皮 **`渔家`**(`LANDUSE_PRI.渔家=2`) 池 `[民房×3,仓库×2,码头,渔船坞,渔亭]`(重复条目=权重，逐格 hash 抽 ⇒ 确定)，且该改判必须放在 `growTownFootprint` 里**「内环改判村落」之后**，否则被抢走。前端 `paint()` 在 `spec.onWater` 时垫 `waterDeck`(桩脚+板缝+极淡暖晕，**不铺实色**)，`spriteOf` key 补 `|W/-`。⚠ `onWater` 已改：渔村聚落按原 kind 画，仅非渔聚落水上格才画「栈桥」。
- **匾额** drawNameBanner：锚点水平=st.x、**垂直=建筑格 r 的 p25**(⚠ 由"最北格 min"改来：离群农田/水磨格会伸到主体以北 2~3 档 ⇒ min 会把签顶高 ≈4 格)；让位 propBlock/refreshChunkProps；受「匾额」开关管。压水 `KINDS['栈桥']` + roadBufWater(⚠ 建筑永不落水)。
- **云气** `buildClouds()`(**祥云 6 型**) + `buildCloudShadows()`(云影同种子对齐、drawClouds 两遍、`?noshadow=1` 单差量) + `drawClouds()`。结构：遍历单位 = **族群块**(CLOUD_CLUSTER 3 格 / CLUSTER_W 570) → 块内 1/2/3 个团心(±0.30 块) → 朵按**圆盘均匀**堆在团心(每团 4/13/24 朵再抖 ±40%)，CLOUD_CELL 190 ⇒ 才有「一团一团」集群感；⚠ 密集靠**团内多朵互叠**、非单朵变大(a 仍压低)。尺寸**世界锁定**：`CLOUD_W0=59`(世界像素基准朵宽)，上屏 `base=CLOUD_W0*cam.zoom`(旧律是屏幕 px ⇒ 与 zoom 弱耦合、z>3.2 冻结不随缩放)。判据 `check_cloud_zoom.mjs`。
- **道路网 B 版**：⚠ 折线只依赖「该边 + 静态地形」(生产恒 `bfsRoad(q,r,q,r)` 不传 roadTileIdx) ⇒ 扫描顺序无关；绕行闸骨架集必须按「边」归一。**灵脉禁路**：bfsRoad 增 `allowVein` 两遍(严格绕行优先，无路才兜底穿一次 = 连通性优先)；w3_bfs_road §⑧ 三条钉死；实测路网灵脉格 0/13073。
- **聚落↔灵脉间距**：`siteScore` 的灵脉邻近由**加分改扣分**(`SETTLE_VEIN_CENTER_PEN=40` / `PEN2=20`，⚠ **必须单调 PEN>PEN2**，否则 d=2 罚更狠时 d=1 反成最优解)；`growTownFootprint` 加 `FOOT_PAD=2` 缓冲(core 格豁免)。实测中心 d≤1 32→0、建筑 d≤2 353→16、聚落 382→381。契约 `check_vein_settle_gap.mjs`。
- **点选朱砂标记**：`main.js drawOverlay` 唯一尺寸旋钮 `SEL_K`(半径/圈距/斜标全乘它)；线宽 = 0.1×该缩放下一格屏显宽(`geo.hexW*cam.zoom`)、保底 `SEL_LW_MIN`。实机验收点选态用 `?sel=q,r`(DEBUG/capture 专用，须在 regenerate 之后赋值)。
- ⚠ `.panel` 的 clip-path 裁整棵子树 + `#controls .row` 须 `flex-wrap:wrap`；浮层须同级兄弟。⚠ 静止降帧计数必须每次 loop 自增(tickCount)。调试开关 `?nobanner/?nocloud/?noclouddrift/?noshadow/?noyield/?nobldg/?plaqdbg/?ancgeo=1`。

## 小地图 L1 地形层契约 (真源 `web/js/minimap-vein.js`)
- **抽样格必须世界对齐**：`m` 为 2 的幂，抽样格 = `{q%m==0 && r%m==0}`；`terrainCache` 键**只有 `q,r`**，与视图无关 ⇒ 平移/缩放/换层级都复用同一张表。这条是整个地形层的**唯一正确性基石**。
- ⚠ **反例(初版病根)**：按画布像素格反投影进世界取格 ⇒ **视图锁定**(视图一动采样点几乎全落新格) ⇒ 缓存命中率极低、大面积「未探测」斜纹。实测：截图未探测 **46.5%**；默认全屏档视图内真实 58363 格 vs 采样 21850 = **漏格 63%**(wpp=12 时 96.8%)；复用率 平移5单位 55.1% / 平移1格 36.4% / 缩放×1.14 30.7% / 面板→全屏 11.5%。改世界对齐后同口径复用率 **99.4% / 100.0%**、`probe().miss` 全程 **0**。
- **层级 `m` 对齐显示分辨率**：`step = max(2, ceil(sqrt(W*H/SAMPLE_CELLS_MAX)))`；`m = 1<<min(LEVEL_MAX=5, ceil(log2(max(eps, step*v.wpp/hexW()))))`。
- **粗层引导**：`rebuildPending` 待采样列表按 `[m*8, m*4, m*2, m]`(m 上限 512)逐层枚举拼接 ⇒ 首帧即有粗略地脉。配套 `biomeAt(q,r)` 走**层级回退链** `m=sampleM; m<=sampleM*8; m*=2`（该格无样本就退回更粗层，避免成片露底）。`pendingAdd` 把坐标**对齐到 `sampleM`** 再入列。
- **枚举范围**：视图外扩 `PADDING=0.20`，跳过已算/已挂起，按离视野中心平方距排序。
- **游标消费**：`pending[]` + `pendingIdx`(取代 `Array.shift()` 的 O(n) 搬移)；容量 `PENDING_CAP=400000`/`TERRAIN_CAP=400000`，**超额不再静默丢弃**，`sampleTick` 超额时按插入序删 `terrainCache` 最旧 **1/4**（整表清空会重新露底）。
- **重建时机**：`tick()` 里「层级/视野签名 `ep`」变化且**列表已排空**才 `rebuildPending`（拖动中不重建）。
- `probe()` 暴露 `queueLen(=pending.length-pendingIdx)/pendingLen/sampleM/blocks/miss/draws/enqDrop/enq`；`?mm=full|hide`、`?mmwpp=N`(全屏档初始缩放)、`?mmdrive=1`(真 WheelEvent/鼠标事件驱动)、`?mmprobe=1`(按时间点采 probe 并 POST `/api/debug/snap`)。

## 小地图 U4 块色 / 面板几何 (2026-09-15 · 从 MEMORY.md 迁入)
- **U4 块色 = 金字塔多数表决**：`cell(mD)` = 4 个 `cell(mD/2)` 子格取众数(`AGG_DIV=2`、`rawM=mD/2`；`mD<2` 时与旧角点口径**逐字节完全相同**)。效果：与「块内 mD×mD 原生格真值多数」一致率 86.3%→**91.6%**(混合区 70→81%)，实机椒盐量 `isoPct` **6.29%→4.61%**。⚠ 代价 = 原始样本 **×4**(mD=8 实测 3.0万→12.1万格，浏览器约 10s 排空；粗层先铺满 ⇒ `miss` 全程 0、不卡帧)。A/B 做法 = 只翻 `AGG_DIV` 2↔1，**验完必 grep 复核**。`probe()` 新增 `rawM/agg/iso/isoBase/isoPct`(iso = 位图块级「与四邻全不同」的孤立块数)。
- **面板几何参数化 + 窄屏铺满窗体**(2026-09-15 手机报「不占满」)：`#minimapBox` 是 `position:absolute` ⇒ **收缩包裹盒**，宽度取最宽子孙；窄屏档画布 `150×98` 而头行/提示行固有宽 **188px** ⇒ 面板 204px、画布只铺满 **79.8%**、右留 **38px** 空白纸(桌面档 `216=216` 恰好相等 ⇒ 只 ≤760px 暴露)。修法：`--mm-h/--mm-chrome(57)/--mm-bottom/--mm-gap` 参数化，`#info.bottom` 改 `calc()` 推导(**删掉写死的 230px/168px**——窄屏那个本就差 5px，山川志一直压住小地图)；窄屏 `#minimapBox{left:10;right:10}` + `#minimap{width:100%;height:min(132px,22vh)}`。⚠ **桌面档禁止 `width:100%`**：收缩盒百分比宽回落画布 `width` 属性，模块每帧又改它 ⇒ 反馈环。
- 契约 `verify/check_mm_layout.mjs`(同源 iframe 探针页 + 旧版 headless `--dump-dom`，**不用 CDP**；12 档 × 8 条，含「桌面档锁死 232×198/216×141」防误伤)；**改样式表必跑**——CSS 几何不在 `frontend_smoke` 源码守卫内。固化手法：改前临时换回旧文件跑一次**必须红**(反向对照)，跑完按 sha256 还原。
- ⚠ 面板 `clip-path` 裁整棵子树 ⇒ 全屏浮层/tooltip 须与 `.panel` 同级兄弟。

---

# 以下三节 2026-09-16 从 `MEMORY.md` 迁入（压缩该文件体积；内容未改口径）

## 小地图 R12/R13 契约（热拔插独立模块 + 全 WS 世界层）
- 热拔插单点 = `main.js initMinimap()` 只注入 `{panel, full, snapshot, jump}`；换模块只改它 + index.html 一行 script。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` 整页 fatal。
- 三层：**L1 地形** = 前端按 seed 自算（只读 `biome/e`；⚠ 绝不读 `onRoad`）；**L2 世界**（灵脉/聚落/道路/区域名/POI）全走 WS 快照；**L3 视野** = 面板档跟随主相机（`FOLLOW_WPP=6`；拖动/触摸拖转自由视角、滚轮/捏合改 `baseWpp`、未移动单击展开全屏）/ 全屏档独立相机。
- 引擎脚本经 WS 下发：帧 `Script=4`；`ScriptRequest{name}` C→S → `ScriptPack{name, source}` S→C；`MapWsHandler.cs:26 EngineScriptOrder=[noise,mapgen-config,mapgen]` 按序拼接（白名单防目录穿越）。⚠ **帧本身不 gzip，只有 `Source` 字段 gzip**。
- R13 倍率联动：`panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`（乘积恒 **13.2**）；面板滚轮只改 `baseWpp`（别直接改上屏 wpp）、拖动转自由视角、归心回跟随；`localStorage['zongmen.mmView']` 持久化。驱动参数 `?mmdrive=panel` / `?mmdrive=1` / `?mmreload=1`。
- **手机档两件**（2026-09-15）：① 原只绑 `mouse*` ⇒ 手机上零交互；补齐触摸（单指拖=平移+脱离跟随、双指捏合=**等价滚轮只改 `baseWpp`**、未移动抬指=展开全屏/跳转）、`TOUCH_SLOP=8`、画布 `touch-action:none`。⚠ **合成鼠标事件**：触摸结束后浏览器 ~300ms 补发 `mousedown/up` ⇒ 被「未拖动⇒单击展开全屏」接住 = **一拖就弹全屏**；`fromTouch(e)` 四闸全挂（比 **`e.timeStamp`** 非 `Date.now()`，600ms）。② 变暗来自宿主**算法暗化**（本机三组 flag 截图逐像素近乎相同 ⇒ 复现不出）⇒ `<meta>`/`:root` 齐写 `color-scheme: **only light**`（**`only`** 才是退出关键字）。判据 `verify/check_mm_ui.mjs`（14 条，已挂 live 组 ⇒ 回归 **18 条**），细则见 skill §29/§30。
- 契约 `verify/frontend_smoke.mjs::checkMinimap`（源码守卫零轮询/旧符号清除/单点注入 + 用引擎真源复算上色 + **原始样本格世界对齐 / 显示块 4 子格全覆盖 / 平移缩放复用率 ≥90% / U4 多数表决一致率**，全量 **51/51**）。实机取数：`?mmprobe=1`（按时间点采 probe 并 POST `/api/debug/snap`，读 `verify/capture.png` 即时间序列）、`?mmwpp=N`（全屏档初始缩放）。

## 前端自算地形（2026-09-15 · 规划 `待办事项/地图前端自算可行性-规划.md`；**实施单 `待办事项/地形chunk前端自算-实施单.md`**）
- 结论：**算法完全支持，且已在跑**（小地图 L1 地形层就是前端自算）。`EngineScriptOrder` 故意**不含 mapgen-server.js**（纯搬运层）⇒ 前端拿到的是原封不动的生成逻辑；缺的只是打包层，而打包层可本地融合复刻。
- **A/B 铁证** `verify/chunk_selfcalc_ab.mjs`：6 块 × 11 段（`cq/cr/tiles/elev/hash/neigh/pdx/pdy/psp/ph/pe`）vs 真实 WS `mask=CHUNK` **逐字节一致**。成本 `verify/chunk_selfcalc_bench.mjs`：eval 4 文件 8.4ms、`init(seed)` 0.8ms、`buildChunk` 冷 2.46/热 0.62ms、首屏 25 块冷 **61.4ms（比服务端「算+打包+b64」69.2ms 更快）**；region×25 69.4ms（最大头；服务端写死 `REGION_ROAD_BUDGET=9999` ⇒ 首请求 ~195.8ms 阻塞同 VM）、settle×25 10.9ms、comm×25 0.45ms；全图 3249 块 ≈20s。
- 引擎 = **确定性纯函数 + 内存缓存**（淘汰只损命中率，不改结果）；`roadsNear(i,j,maxNew,cq,cr)` 的预算/中心**只决定先算哪些边**，收敛后与不传完全一致 ⇒ 道路同样可自算。服务端存储（`w:{seed}:chunk/region/settle/comm`）**100% 是算力缓存，无世界真值**。
- 三障碍：① 主线程阻塞（需分帧/Worker）② ⚠ `web/js/noiselib.js`（视觉噪声）与引擎 `noise.js` **同名导出 `NoiseLib`**（现靠 minimap `finally` 还原 + `textures.js:15` 顶层捕获规避，主流程接入前必须收敛）③ 双实例/双 `init(seed)` 会**互清全部缓存**（4 倍性能差）⇒ 必须单实例。
- 接线收敛点：`main.js:317 applyBlock(job,resp)` 是**唯一**数据分发入口（5 图层全在此落表）；`MC.block` 全项目**只被 `main.js:295` 调一次**。⚠ 已拍板：地形 chunk 改前端算 + WS `mask` 去 `CHUNK` 位（=30，服务端零改动）。
- ⚠ 长期分叉点：世界一旦可写（`settle` 的 `state/expireTs`、`Owner`、`BumpBlockRev` 均是伏笔），纯前端自算立即失效 ⇒ 应把「静态地形可自算 / 动态状态须服务端」在协议上分层。

## C-a 聚落名牌锚点：**城市中心点**（五修 · 现行默认）／ 历史四修全口径（契约 `verify/check_plaque_align.mjs` 79 条）

### ★ 现行默认（五修 2026-09-16）：落点 = 实体自己的中心点
用户拍板：「要和当前的城市的中心点，还有灵山的中心点位置一样，而不是什么所谓的平均值或者
什么参照物」。⇒ 落点**不估计**，直接读实体坐标。**权威定义**：`mapgen.js growTownFootprint`
把**核心建筑**（祠堂/村口/宗祠/集市/官衙/祖师殿…）恒定放在**中心格**（`cell.d === 0`；
建筑记录 `terrain:'core'`）。离线跑引擎实测（契约 E1/E2，`MG.init(seed)` + `settlementsFor` +
`growTownFootprint`）：**seed42/777 共 465 座聚落，`core.q,r === st.q,r` 全部成立**、且中心格
恒在 buildings 清单里。⇒
- 聚落落点 = `(st.x, st.y)`（= 中心格 = 核心建筑所在格）⇒ 恒落在**真建筑**上；
- 灵脉落点 = `(v.x, v.y)`（格心；地盘色环 `hexPath(v.x,v.y)` 与灵脉花同点）；
- 免疫性从"近似"升级为**恒等**（锚点**不读建筑清单**）；
- 原始病灶（点悬在村里空地）的真因是初版**合成点**（中心格 x + 建筑格 y 的 p25），
  **不是**"中心格不够中间"—— 前四修都在解一个本不是问题的问题。
**实现**：`main.js` `ANC_GEO` 缺省 `'center'`；`bldgAnchor` 默认分支不调求解器，
`real` = 中心格上是否有建筑（清单未到货**不落缓存**）。灵脉 `VEIN_PT` 缺省 `'center'`，
**两档签位逐像素相同**（中心点档靠 `gap = topU·hexR·z` 把签抬到峰上，点不动只抬签）。
**实机**（8141 临时实例，`?plaqprobe=1`）：`anc=center veinpt=center`，载入 12 座
**coreOn 12/12**，在屏 2 座 `dotX/dotY` 与中心点投影**偏差 0.000px**，灵脉 48 条
`topU∈[2.273,6.186]`。旧口径全部降级为 A/B 档位：`?ancgeo=densest|box|col|med|sum`、`?veinpt=apex`。

### 历史（一~四修，只作 A/B 对拍；下述"最优性"均不再属于线上默认）

- **求解器** `bldg_ink.js BI.anchorOf(bl,hexW,hexR,centerX,mode)` → `centerPiece(ws,mode,hexR)`；
  `mode`: `''` 最密格（默认，四修）/ `'med'` 中位格（二修 A/B）/ `'sum'` medoid / `'box'` 包围盒中心 / `'col'` 离中心列最近（一修 A/B）/ 布尔 `true` ≡ `'box'`。`?ancgeo=box|col|med|sum` 同机位对拍。
- **默认口径两条**：
  1. 第一键 = **`2·hexR` 邻域内建筑数（含自身）最多**；
  2. 平手参照物 = **「最密束（计数 == max）的 2R 邻域**并集**」的质心**，决序 `离它近 → 更北 → 更西`（全序 ⇒ 与输入序无关）。
- ⚠⚠ **离群免疫是恒等链，不是"更鲁棒"**：远点不在任何候选的 2R 内 ⇒ 计数表逐值不变 ⇒ 最密束逐元素不变 ⇒ 并集不变 ⇒ 质心不变 ⇒ 决序不变。任何"鲁棒统计量"（截尾质心 / 坐标中位数 / Winsorized / 迭代重裁）只**减小**影响不消除，平手卡在噪声量级上照样翻案。
- ⚠ **旧口径（三修）的病灶**：平手参照物用 `trimmedCentroid`（先取全体均值，丢最远 25%，再取均值），其内部排序用的是**含离群点的均值** ⇒ 远处多加一块农田/码头就换了保留集 ⇒ 决序翻转（实测 `(1,0) ↔ (1,2)`，换方向/个数还会再变）。该函数现已删除。
- 复算判据必须与实现**同容差语义**：实现是 `k < bk - 1e-9` 的滚动比较（平方距离），纯 `sort` 会被 2e-13 的尾数噪声决定（实测 5/33 座不一致）。
- 实测（33 座 fixture `verify/anc_fixture.json`，每格 = 平均/最差偏差，单位 R；三参照系 trim 截尾质心 / geo 几何中位数 / bbf 包围盒中心）：

| 口径 | trim | geo | bbf | 和(平均) | 和(最差) | A6 免疫 |
|---|---|---|---|---|---|---|
| 三修 mean-key | 0.839/1.756 | 0.693/2.318 | 1.206/4.265 | 2.739 | 8.339 | ✗ |
| 一修 col | 1.605/4.715 | 1.300/4.458 | 1.562/3.464 | 4.467 | 12.637 | — |
| 二修 med | 1.074/2.843 | 0.861/3.464 | 1.356/4.330 | 3.290 | 10.637 | — |
| medoid sum | 0.915/2.021 | 0.483/1.572 | 0.960/2.250 | 2.358 | 5.842 | — |
| **四修 plateau（现行）** | 1.109/2.385 | 0.883/2.692 | 1.466/3.269 | **3.459** | 8.346 | ✓ 8/8 |

  ⇒ 用 **+0.24R 平均居中（≈6px/座）** 换**精确**离群免疫，**最差和持平**（8.346 vs 8.339）。
- 被否决的替代方案（同 fixture，trim 参照系，平均/最差）：坐标中位数定序 ✓免疫 1.045/3.126（最差差）；逐轴 Winsorized 25% ✗ 0.896/1.756（裁点数随 n 变）；中位数起手 + 4 轮重裁迭代 ✗ ≈裸均值（**收敛回裸均值不动点**，白做）；截断核分 `Σ min(d,2R)` ✓ 1.652/3.969（是"紧致度"不是"中心性"，比一修 col 还差）；多尺度计数阶梯 `c(2R)→c(R)→c(R/2)→c(R/4)` ✓ 1.421/3.329（同病）。
- **免疫参照物的末轮微调（同为恒等免疫，三参照系 平均和/最差和）**：`mean(最密束2R并集U)` **3.459/8.346 ← 最优，采用**；`mean(以 cU 为中心的 2R 窗口)` 3.711/8.346；`mean(以 cU 为中心的 3R 窗口)` 3.459/8.346（**与 U 等价**，实测同值）；`mean(离 cU 最近的 |U| 个)` 3.757/9.087；`mean(以"最密束最北那座"为中心的 2R 窗口)` 5.158/11.697（最差）。
- **逐种子诚实口径（别只看 pooled）**：pooled 上默认明显优于 col（平均和 3.459 vs 4.467），但**单看 seed42 的平均和只与 col 打平**（3.547 vs 3.464，即每座每参照系差 0.002R≈0.06px）；最差和则在两套种子上都明显更优（7.649 vs 9.284 / 8.077 vs 12.637）。契约因此拆成 A13c（逐种子最差和 ≤ col）+ A13c1（逐种子平均和 ≤ col×1.10）+ A13c2（与 med 平均和之差 ≤ 0.30R）—— **不要合并成一条"平均和 ≤ col"**，那在 seed42 上是假的。
- **实机数值探针（seed42, zm=3.2, 12 座聚落, 48 条灵脉）**：dTrimR 平均 1.113 / 最差 2.291 / **2 座 >2R**（古井村 2.179、桑园村 2.291）；对照 dMedR 0.840/1.756、dColR 1.329/3.253、dSumR 0.855/1.893。⚠ 这两座 >2R **不是回归**：两者的落点都是"最密束自身的中心"（古井村落 `(-1,-2)` = 竖直主列的**正中**；桑园村落 `(29,-27)` = 竖列的**正中**），只是 dTrimR 的参照系（裸均值定序截尾质心）被同一批**稀疏外圈**的农地/水磨拉偏了 —— 正是 §32 说的"参照系偏差"。⚠ 别拿 dTrimR 单独当判据。灵脉侧：topU ∈ [2.27, 6.19]（非零，峰值随档/海拔）、jxU ∈ [-0.782, 0.788]（非零，双向），`apexV=0.14889`。
- 压测协议：合成簇 `CLUSTER`（8 座，基准恒为 `(1,0)`）+ 8 方向远点 `(9,9) (-14,7) (0,-21) (31,-3) (-6,40) (22,22) (-30,-30) (5,-18)`，逐个加 + 八个齐加，结果都不得变（契约 A6/A6b）。
- 其它：`anchorOf` 返回 `{x,y,q,r,y0,real}`，`y0` = 建筑格 y 的 p25（旧路径/让位逻辑仍用）；无建筑 ⇒ `null`，**调用方必须不落缓存**（`main.js bldgAnchor` 守卫 D7）。`?plaqprobe=1` 数值探针自回传（含原始建筑格 `bldgs`）。教训见 skill §32/§33/§34。

## 渔村 A2 / 归属势力 B / 匾额 C / 世界种子 W（2026-09-16 从 MEMORY.md 迁入，口径未改）

### A2（用户定案）水面建筑一律渔家 + 地盘环水陆都画
**不再以「中心格是否在水里」判渔村**。引擎把「渔家」地皮从 `type==='fishing'` **放开到任何聚落的水面格**（`mapgen.js` 地皮段 `lu==='水岸'→'渔家'`）；前端 `main.js` 栈桥降为**白名单兜底** —— `WATER_KIND`(民房/仓库/码头/渔船坞/渔亭)、`bridge = onWater && !isFish && (WATER_OLD || !WATER_KIND[b.kind])`、`fishVillage: WATER_OLD ? isFish : (isFish || onWater)`、地盘环改 `if (!bridge || !WATER_OLD)` **无差别绘制**（旧 `if(!bridge)` 跳过水面格 = 用户报的「下面没有正六边形框」）。同机位 A/B 档位 **`?water=old`**；`tools/bldg_town.mjs` 镜像判据已同步。测试环境**无需清库**。
- 同源条目（A 版）：`KINDS_FISH`（民房/仓库）画法表，`paint()` 在 `spec.fishVillage` 时优先查表；远视图标拆出独立 `drawFishing`。⚠ 加任何「影响画法」的 flag ⇒ **`spriteOf` 缓存 key 必须同步加位**，否则水陆**串图**（本次加 `|'F`）。看板 `tools/bldg_sheet.mjs all|dirs|fish`。

### B 归属势力（前端派生）
`factionOf` 扫 `settleCells` 取**最近宗门**；⚠ 半径是**镜像常量** `SECT_DOMAIN_R = CFG.COMM_R(25) × 1.4 = 35`（同 `mapgen.js:1174`，跨源断言 `check_faction` A2）；⚠ 缓存 `st._fac` **必须靠 `settleVer` 失效**（首个 settle 包到货时附近可能还没宗门，只算一次会**永久锁成无归属**）。`townColor` 归属优先 ⇒ **同宗同色**；记号 `factionSig` 同源派生 crest(3~6)/crestRot(k·π/3)/seal(0~7) → `plateAt` 的 `water/crest/seal` **全部条件画**（荒野保持纯环）。协议 `Owner`(`MapMessages.cs:82`) 仍恒空 ⇒ 日后引擎补 owner 只改 `factionOf` 返回（B-B），绘制层不动。总开关 `?fac=0`；探针 `__facProbe`。

### C 匾额引线
`bldgAnchor` 扎**真建筑格**（`BI.anchorOf`）；`main.js veinTopU` **委托** `VS.tipU`、`veinJxU` 委托 `VS.apexJx`（单一真源）；`renderer.js` GLSL 判档阈值走 `VEIN_SHAPE` 的 `E_MTN/S_MTN/E_SNOW/S_SNOW`；⚠ `vein-skin.js levelInfo` 越界返 `null`（原来静默归一化成「大」）。⚠ 教训：用户说「要某个东西的中心点」时，先查那个中心点在数据里**是不是已存在**（skill §35）。
- 灵脉名 **`XX灵脉·大`**（`main.js:1197`/`1865`、`minimap-vein.js`）。⚠ `v.name` 常自带「脉/峰/谷」⇒ 叠字，是否再砍「灵脉」后缀**待用户拍板**。

### W 世界种子 / 设置组件 / 灵脉签色
- **种子 = 服务端资产**：`Server/Zongmen/Storage/WorldLedger.cs` **独立表** `World(Round,Seed,BornAt)`（⚠ 绝不能塞 `Data(Key,Value)` —— `PruneExcept` 按前缀 DELETE 会**静默删掉**台账）＋ `GET /api/world/current`（幂等，空库就地开第一世）/ `POST /api/world/next`（另启一世）/ `GET /api/world/list`。前端 boot `await worldFetch('/api/world/current')`；**拿不到种子直接 `showFatal`，绝不回落前端造**。⚠ `?seed=` 保留为调试覆盖（不入账、`src:'url'`）——削掉即废掉整条验证管线。
- **设置唯一真源 `web/js/store.js`（`window.ZMStore`）**：键 `zongmen.settings.v1`；schema 白名单 `{veins,nameSettle,nameVein,nameRegion,clouds}`；读路径只读内存副本（不逐帧 `getItem`）／写 200ms 节流 + `pagehide` 强写／坏 JSON 与无 localStorage 静默降级。右上角只剩 ⚙ `#btnGear` → `#settingsWrap` 弹窗；复选框 `data-zm` **只往 store 写**，渲染变量由 `S.settings.on(applySettings)` 单向下发。⚠ 变量名 `showVeins/showLabels` **不能改**（`frontend_smoke` 逐名扫原文）。
- **灵脉签五行色（C-b）**：`drawNameBanner` 走**两道** —— 同路径上再敷一层「向纸色提亮 `VEIN_WASH_MIX=0.40`」的渐变（`VEIN_WASH_A0/A1=0.30/0.46`），描边 = `mixRGB(tint,[72,58,40],0.52)`，印章用本色 `0.86`；灵脉名单独开关 `nameVein`（`?nobanner=1` 仍一键全关）。
- ⚠ **`check_calc_local` / `check_mm_ui` 不认 `--base=`**，只认**位置参数 URL**（`run_regression` 正是位置传的）。手跑隔离实例必须 `node verify/xxx.mjs http://127.0.0.1:8150`，否则静默打 8140。

---

## 构建 / 验证：会踩的坑（跑法见 skill §1~§35，本节只留坑）
- ⚠ 截图：`--headless=new` 忽略 `--window-size`（精确尺寸须旧版）；实机自截 `verify/live_cap.mjs <url> <out> 90 1400x900`（`capture=1`，落**共享** `verify/capture.png` ⇒ **串行**）；**截前必须预热 `capmin=N`**（就绪阈值 `chunkData>=3` 在低缩放太松，不加则同 URL 两帧可差 20%）；裁剪用通用版 `verify/_vv_crop.mjs <in> <out> x0 y0 x1 y1 [scale]`（自包含 PNG 编解码，本机无 PIL），别用硬编码的 `crop_png.mjs`。
- ⚠ CDP `Runtime.evaluate`/`Page.captureScreenshot` 对本页**永久挂起**（>100s）⇒ 改用**数值探针**（`?plaqprobe=1` / `?mmprobe=1`）+ 离线复算，或 live_cap 差分。⚠ 目测坐标必错（>60px）：量标签引线用 `?plaqdbg=1`（走产品同一个 `bldgAnchor`/`veinTopU`）并换算成 R 倍数（R=hexR×zoom）；别把「期望屏幕坐标」硬编码进探针；量高度别用 RGB 阈值。⚠ **Read PNG 会等比缩小**（1400×900 实显约 1080×694）⇒ 目测坐标先 ÷ 显示比再裁。⚠ Read PNG "content filtered" ⇒ 探针页 `getImageData` + `--dump-dom` 取 stdout（见 skill `webgl-headless-verify`）。
- 基线（离线）**19 条**：frontend_smoke **79**、check_plaque_align **79**（2026-09-16 由 39 扩）、check_fish_skin **47**、check_faction **72**、check_settings_store 39、check_vein_skin 42、check_mm_layout、vein_cluster **26** / no_build_on_vein 5 / settle_spacing 6 / sea_village 15 / vein_settle_gap 10 / preview_* ×4 / edge_falloff / sync_preview_inline / w5 / w6 / w3_bfs_road；在线 4 条 = frontend_smoke + check_mm_layout 8 + check_mm_ui 14 + check_calc_local 11。服务端 verify_map/w1/w2/w4 全绿。
- ⚠ 服务端验证别 kill 用户 8140 ⇒ 起**临时独立实例**：`dotnet build Server/Zongmen/ZongMen.csproj -o verify/_vmsrv -p:UseAppHost=false` 后 `Zongmen__Port=8157 Zongmen__MaxSeeds=64 Zongmen__DbPath=<%TEMP%/…>.sqlite dotnet verify/_vmsrv/ZongMen.dll`（`Options.FindRoot` 会向上找到仓库根 ⇒ 自动用仓库 `web/` 与 `Engine/js`）。⚠ **`MaxSeeds` 必须显式放大** —— appsettings 默认 3，而 `check_mm_ui` 每次用**新随机 seed**，连跑几次就把名额用满 ⇒ 页面拿不到世界、判据报「快照未就绪」，**长得像产品回归**。查法 `curl /api/map/stats` 看 `liveSeeds == maxSeeds`。⚠ 跑完 kill **只按命令行含 `_vmsrv` 的 dotnet PID**（`wmic process where "name='dotnet.exe'" get processid,commandline`）+ 删 `verify/_vmsrv`。
- ⚠ **Chrome profile 泄漏**：`live_cap.mjs`/`check_mm_layout.mjs` 曾把 `rmSync(profile)` 放 `setTimeout` 而紧接着 `process.exit()` ⇒ 定时器永不触发；本机 `%TEMP%` 曾积 **255 个 `wb-*` 目录 / 3.54 GB**（已改**同步删+重试**，`Atomics.wait` 当同步小睡）。⚠ **别在回归跑动中清 `%TEMP%/wb-*`** —— 会删掉在跑的判据 profile 并当场假红（自伤）。⚠ 清 `wb-*` 时**别碰无短横的 `wb/`**（隔离实例的库在里面）。
- ⚠ 判据「绝对值阈值」在 headless 下极易假红 ⇒ 必须改 **A/B 归因**（例：`check_calc_local` 的 S5 原判「hybrid 首屏最长任务 ≤50ms」恒红 ~250ms，归因后发现 **server 档（零本地算）也 245~254ms** ⇒ 那是 WebGL/着色器/图集启动开销；改成「hybrid ≤ server + 40ms」）。⚠ `frontend_smoke` 的「解码字段读取审计」按**项目约定**放行 **`_` 前缀**属性（线路 protobuf 字段不带下划线 ⇒ `_xxx` 只可能是前端自挂 memo：`_anc`/`_fac`/`_facV`）。⚠ **判据的参照系不能是被测规则自己的目标函数**（自证陷阱）—— skill §32；⚠ 判据复算必须与实现**同容差语义**（2e-13 的 tie 就能翻案）—— skill §32.1。
- **总 runner** `verify/run_regression.mjs`（默认 **18 离线 + 4 在线 = 22**；`--offline-only` / `--with-server` / `--base=` / `--only=` / `--skip=` / `--list`；统一清 `HTTP_PROXY` 置 `NO_PROXY=*`；w3 墙钟失败自动降级 warn）。

