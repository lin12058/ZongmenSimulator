# 宗门模拟器 demo3 · 项目长期备忘

## 山河图（index.html + js/）架构
- 无限流式六边形区块世界：地块直径 16px（HEX_R=8），区块=六边形，中心间距 CHUNK_S=21，四候选最近中心归属（六边形距离），构建扫描半径 CHUNK_SCAN=15（胞腔最远 14 格，<15 会出楔形黑洞）。
- **坐标空间铁律**：相机、视野边界、流式需求集、overlay 标注全用 CSS 像素；renderer 的 uRes 必须传 fboW/dpr（本机 dpr 可为 1.5）。GL 与 JS 坐标空间不一致 → 地图边缘黑楔 + 标注错位。
- WebGL2 三遍渲染：Pass1 每区块实例化绘制进 FBO（uFade 纸色→墨色 0.6s 渐入），Pass1.5 立体精灵遍（独立 propFbo，alpha 混合，山/雪/林/沙/草丛/灵脉峰超出格子压邻格，y 升序即遮挡序，精灵索引=图集行*8+列，第 5/6 行），Pass2 水墨后处理（底图晕染→精灵合成→墨线→精灵剪影勾边+接地投影→宣纸/暗角）。图集共 7 行。区块生成队列距相机排序，积压>6 每帧 2 个否则 1 个。
- 小地图：132×88 基准画布、每像素 6 世界像素；点击换算用基准尺寸（勿用 backing 尺寸）；刷新节流 0.4s/1.5s。
- 内容（2026-09-07 灵脉驱动重构后）：灵气场 spiritAt（原点 0,0、半径 1000 格归零）→ 群落晶格 COMM_CL=150 播大灵脉（概率 0.16+0.62*spirit）→ 群内 1大+[0~3]中+[0~7]小 向心聚敛 → 五行相生相克只在群内（SHENG=[2,3,1,4,0]，KE=[1,4,3,0,2]，异灵根 DUAL 雷/风/冰/暗）→ 地形迁就（灵脉中心抬 0.80/0.75/0.70，落水抬成岛）。灵脉格 disp biome 8..12 进图集第 5 行；七星空岛花由 overlay drawVeinFlower 绘制。
- **着色器解码铁律**：HEX_FS biome 解码必须 `floor(vTile/4.0+0.001)`（tile=biome*4+variant）；旧写法 +0.5 会把 variant 2/3 解到 biome+1 → 黑格/错色。
- 端口：8137 被 demo3 副本占用，demo2 用 8138（node server.js 8138）。

## 工具经验
- agent-browser daemon 在本机多条 bash 命令间会重启丢页面：open/eval/截图必须串在同一条命令，且需 dangerouslyDisableSandbox（沙箱会 SIGTERM 杀链）；eval 用 Promise 轮询等 window.__MapGen 就绪；无头 Chrome --screenshot 不落盘，用 agent-browser screenshot。
- agent-browser screenshot 语法：**位置参数** `screenshot ./x.png`（`--path` 会被当 selector 报 Element not found）；png 大截图常被 SIGTERM，用 `--screenshot-format jpeg --screenshot-quality 85` 更稳；最可靠的页面验证是 present_files 开 http://localhost:port 内置浏览器预览（用户偏好此方式）。
- 静态服务：node server.js [port]，demo2 默认 8137（常被 demo3 占用，改 8138）。
