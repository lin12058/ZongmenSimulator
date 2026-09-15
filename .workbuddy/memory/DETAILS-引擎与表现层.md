# 细节契约 · 引擎 / 灵脉 / 建筑表现层
> `MEMORY.md` 的配套细节文件。需要动灵脉或表现层时读本文件。所有 check_*.mjs 是这些契约的可执行真源。

## 灵脉契约 (真源 web/js/vein-skin.js → global.VeinSkin，挂 textures.js 前)
- 结构 shape / elements 五行 / variants 四异灵根 / dual / **levels 四档(0大 1中 2小 3从属)** / levelInfo()。⚠ `elements[].glow==mapgen ELEMENT_RGB`、`variants[].glow==VARIANT_RGB`、键序==VEIN_VARIANT_ORDER；`levels[i].level==veins[].level`、hScale 严格递减且可视高度互不重叠。`check_vein_skin.mjs`(35 项，含「又高又瘦」) 钉死，改后必跑。
- **占地 7/3/1**：`veinFootKeep(level,dq,dr)` 大=hexDist≤1(7格) / 中=本格+(-1,1)+(0,1)(3格) / 小=仅本格；d≥2 不留。从属格 level=`CFG.VEIN_SAT_LEVEL(=3)`(专用第4档，**不是**"中心档+1")且**绝不进 comm.veins[]**(否则多名牌/统计虚高/污染群落与 veinNear)。`fields()` 守卫 `vn.d<=1 && e>=SEA_LEVEL && veinFootKeep(...)`；buildChunk 用 `e: f.vein?f.vein.level:f.e`(复用海拔通道)。判据 `check_vein_cluster.mjs`(7 项)。⚠ 已知非缺陷：相邻两群落次级灵脉可落同一整数格 ⇒ veinNear 全局最近裁其一 =「幻影灵脉」(名牌叠字)，不破 7/3/1。
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
