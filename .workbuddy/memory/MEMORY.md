# 宗门模拟器 demo3 · 项目长期备忘

## 山河图（index.html + js/）架构
- 无限流式六边形区块世界：地块直径 16px（HEX_R=8），区块=六边形，中心间距 CHUNK_S=21，四候选最近中心归属（六边形距离），构建扫描半径 CHUNK_SCAN=15（胞腔最远 14 格，<15 会出楔形黑洞）。
- **坐标空间铁律**：相机、视野边界、流式需求集、overlay 标注全用 CSS 像素；renderer 的 uRes 必须传 fboW/dpr（本机 dpr 可为 1.5）。GL 与 JS 坐标空间不一致 → 地图边缘黑楔 + 标注错位。
- WebGL2 三遍渲染：Pass1 每区块实例化绘制进 FBO（uFade 纸色→墨色 0.6s 渐入），Pass1.5 立体精灵遍（独立 propFbo，alpha 混合，山/雪/林/沙/草丛/灵脉峰超出格子压邻格，y 升序即遮挡序，精灵索引=图集行*8+列，第 5/6/7 行），Pass2 水墨后处理（底图晕染→精灵合成→海岸墨线→精灵剪影勾边+接地投影→宣纸/暗角）。图集共 8 行。区块生成队列距相机排序，积压>6 每帧 2 个否则 1 个。
- **精灵高度海拔驱动**（2026-09-07）：prop 实例多传 propElevs（PROP_VS location=4 iElev）；山 40/41/56/57 按 mix(0.55,1.30,(e-0.70)/0.14)、雪 42/43/58/59 按 mix(0.95,1.55,(e-0.84)/0.12) 缩放 H/W；林/沙/草仅 hash 微变。低山疏密：e<0.76 且 hash<0.30 无山精灵。
- **图集 8 行布局**：第 0~3 行 8 群系×4 变体；第 4 行灵脉格底；第 5 行 40/41山 42/43雪 44..47林（阔叶/松/花树/秋色四种林相，TREE_PAL 调色）；第 6 行 48沙 49草丛 50..54灵脉峰；第 7 行 56/57山B 58/59雪B（三峰横岭构图）。HEX_FS 图集 uv 必须除 vec2(8.0, 8.0)。
- **海浪静态**（用户明确要求无动画）：main.js overlay 浪线层（z≥1.0，hash 确定性：开阔海面白描长浪线+短回笔，深海 prob 0.30/浅海 0.46；近岸浅海画白沫弧+沫点）；POST_FS 只留静态近岸白沫（ring 三级采样 1x/3.4x/7.5x + sin 脊，无 uTime）；HEX_FS 水面波纹也已去 uTime。道路为双色土路（深路缘 rgba(96,78,54,.34)+米黄路面 rgba(233,218,178,.82)，z>2 宽 2.1 否则 1.5）。
- **无贴图模式**（2026-09-07）：已移除 main.js boot 中异步加载 assets/textures/paper.png 替换纸纹理的逻辑（img.onload/setTextures 替换块整体删除），全程只用程序化 buildPaper()（底 #eee5d2 偏暗带斑驳）。此前 http 打开与 file:// 打开亮度不一致的根因即该 png（平均亮度 242 vs 程序化 ~229，经 POST_FS paper*1.28 放大）。项目现无任何外部资源引用。
- 页面支持 URL 定点参数：?seed=&qt=&rt=&zm=&nofade=1（main.js boot 解析，nofade 供 headless 截图跳过渐入）。
- 小地图：132×88 基准画布、每像素 6 世界像素；点击换算用基准尺寸（勿用 backing 尺寸）；刷新节流 0.4s/1.5s。
- 内容（2026-09-07 灵脉驱动重构后）：灵气场 spiritAt（原点 0,0、半径 1000 格归零）→ 群落晶格 COMM_CL=150 播大灵脉（概率 0.16+0.62*spirit）→ 群内 1大+[0~3]中+[0~7]小 向心聚敛 → 五行相生相克只在群内（SHENG=[2,3,1,4,0]，KE=[1,4,3,0,2]，异灵根 DUAL 雷/风/冰/暗）→ 地形迁就（灵脉中心抬 0.80/0.75/0.70，落水抬成岛）。灵脉格 disp biome 8..12 进图集第 5 行；七星空岛花由 overlay drawVeinFlower 绘制。
- **着色器解码铁律**：HEX_FS biome 解码必须 `floor(vTile/4.0+0.001)`（tile=biome*4+variant）；旧写法 +0.5 会把 variant 2/3 解到 biome+1 → 黑格/错色。
- 端口：8137 被 demo3 副本占用，demo2 用 8138；本项目（宗门模拟器demo）现用 **8139**（server 常驻后台跑着，验证直接连 http://127.0.0.1:8139）。

## 工具经验
- agent-browser daemon 在本机连单条 screenshot 命令都会被 SIGTERM（已失效），WebGL/Canvas 地图页验证一律用 webgl-headless-verify skill：系统 Chrome `--headless=new --user-data-dir=临时目录 --virtual-time-budget=25000 --screenshot=xxx.png`（带 nofade=1），截图用 Read 查看后即删。
- 删除项目内临时文件时 bash rm / cmd del 均可能被 SIGTERM，用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }` 最稳。
- agent-browser screenshot 语法：**位置参数** `screenshot ./x.png`（`--path` 会被当 selector 报 Element not found）；png 大截图常被 SIGTERM，用 `--screenshot-format jpeg --screenshot-quality 85` 更稳；最可靠的页面验证是 present_files 开 http://localhost:port 内置浏览器预览（用户偏好此方式）。
- 静态服务：node server.js [port]，demo2 默认 8137（常被 demo3 占用，改 8138）。
