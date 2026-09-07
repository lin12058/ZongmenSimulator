# 宗门模拟器 demo3 · 项目长期备忘

## 山河图（index.html + js/）架构
- 无限流式六边形区块世界：地块直径 16px（HEX_R=8），区块=六边形，中心间距 CHUNK_S=21，四候选最近中心归属（六边形距离），构建扫描半径 CHUNK_SCAN=15（胞腔最远 14 格，<15 会出楔形黑洞）。
- **坐标空间铁律**：相机、视野边界、流式需求集、overlay 标注全用 CSS 像素；renderer 的 uRes 必须传 fboW/dpr（本机 dpr 可为 1.5）。GL 与 JS 坐标空间不一致 → 地图边缘黑楔 + 标注错位。
- WebGL2 两遍渲染：Pass1 每区块实例化绘制进 FBO（uFade 纸色→墨色 0.6s 渐入），Pass2 水墨后处理。区块生成队列距相机排序，积压>6 每帧 2 个否则 1 个。
- 小地图：132×88 基准画布、每像素 6 世界像素；点击换算用基准尺寸（勿用 backing 尺寸）；刷新节流 0.4s/1.5s。
- 内容：种子驱动纯噪声函数（跨会话一致）+ 全球晶格（区域/聚落/道路 A*/灵脉）；灵脉阈值 elev>0.72；道路 z≥0.8、灵脉 z≥0.7 才绘制。

## 工具经验
- agent-browser daemon 在本机多条 bash 命令间会重启丢页面：open/eval/截图必须串在同一条命令；页面截图用 eval 内 canvas.toDataURL 导出最可靠（agent-browser screenshot 易被杀）。
- 静态服务：node server.js，端口 8137（用户常已自行启动，EADDRINUSE 时直接复用）。
