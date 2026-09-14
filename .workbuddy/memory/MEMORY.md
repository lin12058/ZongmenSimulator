# 宗门模拟器 demo · 长期备忘
> 细节见 daily log 与 待办事项/前端表现升级-匾额山体云气.md(§A~P)；构建/回归跑法见 skill `zongmen-regression`。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8+protobuf-net3+SQLite/WAL)，Kestrel :8140 托管 web/ 与 /api/map/*、/ws/map；引擎在 Engine/js/，前端在 web/js/。
- ⚠ 并行 Edit 偶发只落第一条、回执全报成功 ⇒ 改完必 grep 复核。
- 生成参数真源 Engine/js/mapgen-config.js（bundle 序 [noise,mapgen-config,mapgen,mapgen-server]）。⚠ Node 侧加载引擎必须带它(同序)，漏加载静默跑旧参数 ⇒ 参照世界≠服务端。
- 改引擎 js ⇒ ① sync_preview_inline --check ② 重启服务端 ③ 载荷变则停服清 db/zongmen.sqlite*。
- edgeKeep 是「保留」权重(衰减写 1-edgeKeep，写反=越浓越沉海)；真半径真源 MG.spiritEdgeWorld()。存储：单表 Data(Key,Value BLOB) WAL+250ms 只存 chunk/comm/settle(gzip+protobuf，键 w:<seedHash16>:<kind>:<a>:<b>)；Region 内存 LRU512；tile/fields 不落库。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；WaterD=-1 用 255 哨兵；pb.js 长度前缀必须 `var len=r.vi();var eN=r.p+len;`。
- mask 0→All 与未登录剔实体层在 MapWsHandler；onFrame 只更新命中位 rev；帧[1B type][payload]；TileResponse 恒 gzip。写 chunk/region/settle/poi/comm/roads 必须同时 forceStaticDirty()。
- /api/map/fields 只下发 {q0,r0,nq,nr,d}，色板真源 /api/map/meta；sprite=row*8+col 须在已绘制格 ⇒ 两侧字段清单必须对齐。
- ⚠ 新增图层/导出三处必挂：① JsEngineHost.cs 的 JsWorldVm.Call switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ chunkToArrays 给 null 非空数组 ⇒ 读 .length 抛异常废整页；可选包一律判空。

## 灵脉（2026-09-14 九版）
- **配置真源 web/js/vein-skin.js**(global.VeinSkin，挂在 textures.js 前)：shape/elements 五行/variants 四异灵根/dual/**levels 三档**/levelInfo()。
- ⚠ 契约：elements[].glow==mapgen.js ELEMENT_RGB、variants[].glow==VARIANT_RGB、键序==VEIN_VARIANT_ORDER；**levels[i].level==veins[].level(0大/1中/2小)**、hScale 严格递减且可视高度互不重叠。check_vein_skin.mjs(**34 项**，含 §C 山地底座 + 十版「又高又瘦」) 钉死，改后必跑。
- **占地三档一律只占本格**：mapgen.js `veinFootKeep()` 恒 `return dq===0&&dr===0`（旧 7/3/1 与 `VEIN_LVL_BELOW` 已删；7 格密排会连成尖顶山簇）。等级**只**影响前端高度。fields() 守卫 `vn.d<=1 && e>=SEA_LEVEL && veinFootKeep(...)`；buildChunk 用 `e: f.vein?f.vein.level:f.e`(复用海拔通道)。
- **高度/尺寸**：PROP_VS 按还原出的等级取 hs 大1.90/中1.58/小1.22 + 收窄 hrand ⇒ 相对分档 H 大[63,68]>中[55,57]>小[41,43]px(uR=8)。**七版新增 `shape.sizeScale:0.40` = 唯一「上屏尺寸」旋钮**，PROP_VS 只对灵脉分支再乘一次 ss(W/H 同乘⇒比值不变)，上屏降为大 3.16~3.42/中2.74~2.84/小2.03~2.17 uR。字面量 EPS=1/1024+toFixed(3) 防 FP 尾数入 GLSL。⚠ 改系数须同步 tools/prop_sheet.mjs。
- **山形/渐隐** veinPeakPts() 独立成形(topW0.30/seg11/topSeg7/fade0.50/miDian12；wScale0.95⇒W/H≈1.031)。⚠ **渐隐只能靠 alpha 渐变不能靠叠雾**(旧 mist 叠加会把渐隐糊实⇒已删/降档)。判渐变看**前景中位 alpha**：灵脉 半腰187→山脚9(20.8) vs 大世界山 137→44(3.1)。
- **九版「山地底座」**：`vein-skin.js SHAPE.terrainBase:1.0`(0=关回七版) ⇒ PROP_VS 把**该格原山**垫在峰下(与大世界山**同档公式** MTN 0.55/1.30、SNOW 0.95/1.55；海拔<0.70 自动为 0)。⚠ **u16 海拔通道装不下两个量** ⇒ refreshChunkProps 写 `iElev=(等级+海拔)/3`，shader `vz=clamp(iElev,0,1)*3`、`等级=floor`/`海拔=frac`(max=(2+1)/3=1.0 恰好不溢出)；底座**不乘** sizeScale(仅峰体乘)。名牌锚点见 veinTopU()。
- **十版「底座只加高不加宽」**：shape.terrainBaseW:0(默认, 0≤tbw≤1.2) ⇒ PROP_VS 的 vbaseW 再乘 VBASEW。九版底座**宽度**也叠加 ⇒ 总框 W/H≈1.24(宽>高)，与「又高又瘦」相反；十版 ⇒ 总框 3.06×6.75~10.39 uR、**W/H 0.45**。要**再拔高**抬 terrainBase(只乘高度)、要**更瘦**收 wScale(只乘宽度)。
- propSpriteFor: variant→32+idx 否则 b+42（row4=id32..35 异灵根、row6 col2..6=id50..54 五行）。定点 seed42：金(-8,0)、群落(4,3)=大(247,192)/中(243,168)/小(226,194)。

## 建筑 / 表现层 / 道路
- 建筑真源 mapgen.js BUILDINGS+CORE_KIND(26 种)；绘制真源 web/js/bldg_ink.js(挂 main.js 前)⇒drawBuildings()。⚠ 三坑：① DIRS 必须 sqrt(3)/2 ② 区块归属禁 round(q/chunkS)须枚举 4 候选 ③ S.p/S.d 必须从 this.fx/fy 读。⚠ bldg_ink.js 是独立 IIFE ⇒ 改完必须 eval+冒烟(曾因 paint() 漏 `var fn` 整层崩)。
- 表现层(细节 ledger §A~E)：匾额 drawNameBanner(锚点水平=st.x、**垂直=建筑格 r 的 p25** —— ⚠ 八版由"最北格 min"改来：离群农田/水磨格会伸到主体以北 **2~3 档**，min 会把签顶高 ≈4 格)；让位 propBlock/refreshChunkProps；压水 KINDS['栈桥']+roadBufWater(⚠ 建筑永不落水 mapgen.js:836)；云气 buildClouds()(**祥云 6 型**)+buildCloudShadows()(云影同种子对齐、drawClouds 两遍、?noshadow=1 单差量)+drawClouds()(七版 base176→92；**八版两层掷骰**：族群块 CLOUD_CLUSTER=1.5 格定族型 晴空/孤单/小批/成批 → 块内逐格播种，每格 1/2~3/**5~8** 朵，CLOUD_CELL 430→350；**九版结构性重做**：遍历单位由格升为**族群块**(CLOUD_CLUSTER 1.5→3 格/CLUSTER_W 570) → 块内 1/2/3 个团心(±0.30 块) → 朵按**圆盘均匀**堆在团心(每团 4/13/24 朵再抖±40%)，CLOUD_CELL 350→190 ⇒ 才有「一团一团」集群感；⚠ 密集靠**团内多朵互叠**非单朵变大(a 仍压低)；**十版尺寸世界锁定**：`CLOUD_W0=59`(世界像素基准朵宽)、上屏 `base=CLOUD_W0*cam.zoom`，旧律=`92*(0.70+0.32*min(z,3.2))` 屏幕 px ⇒ 与 zoom 弱耦合且 z>3.2 冻结、云不随缩放；默认档 zm=2.2 ⇒ ≈130px 观感不变。判据 verify/check_cloud_zoom.mjs))；**建筑「场地」七版加强 hexPlate(fill 0.16→0.40 + radial 柔光 + ink 圈线)**。灵脉签受「匾额」开关管。
- ⚠ .panel 的 clip-path 裁整棵子树 + #controls .row 须 flex-wrap:wrap；浮层须同级兄弟。⚠ 静止降帧计数必须每次 loop 自增(tickCount)。调试 ?nobanner/?nocloud/?noclouddrift/?noshadow/?noyield/?nobldg/?plaqdbg/?ancgeo=1。
- 道路网 B 版：⚠ 折线只依赖「该边+静态地形」(生产恒 bfsRoad(q,r,q,r) 不传 roadTileIdx) ⇒ 扫描顺序无关；绕行闸骨架集必须按「边」归一。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node fs.unlinkSync 绝对路径+basename/数量断言，**先按 git ls-files 过滤被跟踪名单**；禁 shell 通配与 git rm。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ 别按 `_` 前缀当临时件：verify/_scratch_diag.mjs 是**被跟踪**的。⚠ core.quotepath 给非 ASCII 路径加引号 ⇒ 按扩展名统计 `git ls-files` 必须带 `-c core.quotepath=false`，否则假 0。

## 构建 / 验证（跑法详见 skill `zongmen-regression`）
- ⚠ Chrome --headless=new 忽略 --window-size(精确尺寸须旧版)；实机自截 verify/live_cap.mjs <url> <out> 90 1400x900(capture=1，落共享 verify/capture.png ⇒ 串行)；**截前须预热 URL 参数 `capmin=N`**(就绪阈值 chunkData>=3 在低缩放太松，不加则同 URL 两帧可差 20%)；看板 tools/prop_sheet.mjs；裁切 verify/crop_png.mjs。
- ⚠ CDP Runtime.evaluate / Page.captureScreenshot 对本页会**永久挂起**(>100s，连 cdp_feat.mjs 也挂) 别用来取数；改用探针页+live_cap 差分。⚠ 图上量坐标目测必错(>60px)⇒连通域检测或叠 ?plaqdbg=1；⚠ **别把「期望屏幕坐标」硬编码进探针**(偏 >60px 全废)⇒ 从新旧差分自证(连通域质心)或读 `__probe()` 事实。⚠ 量高度别用固定屏幕窗口跨机位、别用 RGB 阈值(橙花树假命中金灵脉)；实机同档邻格精灵必互盖 ⇒ 单格高度靠同底同刻度看板判。⚠ 量「已缩放的小目标」剪影别用固定阈值(缩放前后含义不同)⇒ 改用与阈值无关的量(峰底宽 maxRun)。
- ⚠ **读不了图时**(Read PNG 返回 "content filtered")：建探针页 → `getImageData` 量 alpha 剪影 → 文本注入 DOM → Chrome `--dump-dom` 取 stdout（见 skill `webgl-headless-verify`）。
- 基线：离线 **10/10** 绿(check_vein_skin **32/32**、w5 半径 12)，服务端 6/6 绿。判据=全通过+退出码 0。⚠ `w3_bfs_road` ⑦ 两条**墙钟**阈值是**机器绝对速度门槛**(i7-6700HQ 上 550/936ms 超 400/500ms，功能断言全过) ⇒ 跨机复验别当回归。
