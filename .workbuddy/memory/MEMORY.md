# 宗门模拟器 demo · 长期备忘

> 详程见 daily logs。仅留跨会话必记。2026-09-13 精简重写。

## 全局约定
- 坐标/距离一律「格」(q,r)；渲染才 tileToWorld。
- ⚠ 一条消息里多个并行 Edit 偶发只落第一条、回执全报成功 → 改完必须 grep 复核，宁可串行。

## 架构 / 参数真源
- Server/Zongmen=.NET8+ClearScript.V8+protobuf-net3+SQLite(WAL)，Kestrel 0.0.0.0:8140(`Zongmen.Port`)，托管 web/ + /api/map/* + /ws/map。前端 web/js/{pb,mapclient,textures,renderer,main}.js；生成/噪声/寻路在 Engine/js/。
- **生成参数唯一真源 Engine/js/mapgen-config.js**（global.MapGenConfig）。服务端按 [noise,mapgen-config,mapgen,mapgen-server] 拼 bundle，不热加载。
- ⚠ 任何 Node 侧加载引擎都要带 mapgen-config.js（同上序）。mapgen.js 写 `var CFG=global.MapGenConfig||{兜底}`，漏加载不报错只静默跑旧参数 → 参照世界≠服务端。自检 grep。
- 改引擎 js → ① node verify/sync_preview_inline.mjs --check ② 重启服务端；chunk/comm/settle 载荷变则清 db/zongmen.sqlite*。

## 灵气边界衰减
- edgeKeep(sp,band)=smoothstep(0,band,sp) 是「保留」权重；要衰减写 1-edgeKeep(...)（写反=越浓越沉海）。
- EDGE_SEA_SP(0.30)→地形沉海，须放 LIFT_CORE 抬升后，同系数乘进 communityOf；EDGE_SETTLE_SP(0.35)→settlementsFor 的 pSpawn 与秘境同受门控。
- fields() 灵脉覆写守卫 vn.d<=1 && e>=SEA_LEVEL。边界真半径唯一真源 MapGen.spiritEdgeWorld()(=SPIRIT_R_TILES×HEX_R×2，勿用 ×HEX_W)。

## 存储
- SQLite 单表 Data(Key PK,Value BLOB)，WAL+250ms 批量；存 chunk/comm/settle，Value=gzip(protobuf)，键 w:<seedHash16>:<kind>:<a>:<b>。Region 键只内存 LRU512；tile/fields 从不落库。
- MemoryVirtualContext cap8192；入口仅 Store()，读 _mem→ReadSqlBackfill。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；WaterD=-1 用 255 哨兵。
- pb.js 长度前缀必须 `var len=r.vi();var eN=r.p+len;`（r.p+r.vi() 少 1 字节）。
- mask：0→All 与未登录剔实体层都在 MapWsHandler；mapclient.onFrame 只更新命中位 rev。帧[1B type][payload]，TileResponse 恒 gzip。
- renderStaticInto() 由 staticDirty 门控：写 chunk/region/settle/poi/comm/roads 必须同时置脏。
- /api/map/fields 只下发 {q0,r0,nq,nr,d}；色板唯一真源 /api/map/meta。
- 精灵 sprite=row*8+col 须在已绘制格；客户端读未下发字段不报错恒定空 → 对齐两侧字段清单。
- ⚠ 新增图层/导出三处必挂：① JsEngineHost.cs 的 JsWorldVm.Call 是 switch 白名单(MapGenServer 新导出补 case)；② repeated 字段逐次 push 元素；③ WS 解码异常必须 reject pending。

## 建筑与贴图（2026-09-13）
- 建筑真源=mapgen.js `BUILDINGS`(地皮→建筑) + `CORE_KIND`(核心格)，去重共 **26 种**，实测全部会出现（0 种死定义）。
  盘点：`node verify/stats_buildings.mjs <seed...> --R=N`。稀有档(<150 次)：炼炉/官衙/焦炭窑/宗祠/祭坛/聚灵阵/灵枢殿。
- **前端 26/26 无建筑贴图**：图集 ATLAS_ROWS=8、40~63 已满；预览只画 LANDUSE_COL 六边+方块芯；main.js 只有文字 chip。
  设计稿+26 张代码生成的水墨图：`待办事项/前端建筑绘.md`，生成器 `tools/ink_buildings.mjs`（纯 Node 拼 SVG，无依赖不调 AI）+ `tools/shot_buildings.mjs`。
- 建筑图集规划=**独立 build_atlas**（别扩 ATLAS_ROWS：renderer.js 有「宽高比必须推出 ATLAS_ROWS 行」构建期断言 + 着色器同源常量）。

## 面板定位
- .panel 默认 position:relative；浮层显式 absolute(#info/#minimapBox)。
- ⚠ .panel 的 clip-path 裁整棵子树 → 下拉/浮层须同级容器兄弟（#sectWrap>#sectMenu）。

## 道路网（2026-09-13 network-first P0；旧成对 A*/跳板剪枝已退役）
- 需求图=聚落×5x5 池近似 RNG（3x3 漏隔格真邻居）；MST⊆RNG 连通。
- 建网序=端点 hub 降序→距升→rkey。全局折扣已建路格 ROAD_W_ROAD=2，不限走廊。
- 绕行闸 DI=步数/六边距>ROAD_DI_MAX10/10(=1.4)→先试无折扣直连，仍超则骨架边(Kruskal)强制建、非骨架放弃。
- DI 重试队列（会话 FIFO，每次限 8）**不进 roadFail**（路复用路径依赖）；3 次仍败转终身不可达。maxNew=0 渲染调用跳过消化。
- cartDist()=端点实际笛卡尔世界直线/HEX_W 取整（纯整数恒等式+isqrt）；A* h=minW×cartDist；hexDist 只余步数预算语义。ROAD_STEPS_MAX 复用模式自动放宽=COST_MAX÷ROAD_W_ROAD。
- 必须先跑独立朴素 Dijkstra 对拍；整数几何与浮点真值≥10万点对拍。
- 遗留 P1/P2：RoadNet 共享表示+干线加宽；line-of-sight 平滑；严格全局成网。

## 构建 / 运维
- ⚠ Chrome 截图：**`--headless=new` 忽略 `--window-size`**（按内容自取尺寸）→ 要精确尺寸必须用旧版 `--headless`。
- dotnet build Server/ZongMen/ZongMen.csproj（须 .csproj）。ContentRoot=AppContext.BaseDirectory。
- 存活 curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats；优先 taskkill /F /PID（/IM 会连带杀用户实例）；隔离实例 build -o verify/_vmsrv -p:UseAppHost=false + 覆写 appsettings Port/DbPath。
- bin/wsbuild/ 可能是旧构建（漏 settleJson 白名单 → 「未知 JS 函数」伪装成后端没数据）；怪症先 dotnet build。

## ⚠ 本机文件删除高危
- git rm 曾两次致整个 verify/ 从工作区消失；shell 通配 rm 曾误删 灵脉预览.html。清理一律 Node fs.unlinkSync 绝对路径+basename/数量断言，禁 shell 通配与 git rm；登记 git add -A <dir>。恢复 git restore --source=HEAD --staged --worktree -- .

## 验证
- 基线（2026-09-13）：verify_map + w3_bfs_road(12 项) + w1/w2/w4/w5 + frontend_smoke 全绿；scan_poison 1681 块 bad=0。判据认「全部通过 + 退出码 0」。
- ⚠ scan_poison.mjs BASE 默认写死 8140；别端口跑必须显式传 baseUrl，否则每块 timeout 为假 BAD。
- 静态回归：check_preview_{vein_marker,terrain,settle_road} + check_edge_falloff + sync_preview_inline --check。
- 视觉三件套：preview_fixedpage.mjs `<scale>` `<out.html>` → shot.mjs → crop_png.mjs；Chrome ~/AppData/Local/Google/Chrome/Application/chrome.exe。

## 预告视图 灵脉预览.html
- 4 个内联 script；file:// 直开；改引擎后重新内联（sync_preview_inline.mjs）。
- 灵脉/聚落标记=六角徽标，尺寸真源 markBase=clamp(REGION_M×HEX_W×scale×0.16,2,16)；禁止回退 rTiles×HEX_R×scale 或 blockPx>1.5；六芒星已否决。
- 地形多级 LOD 阶梯[1,2,3,4,6,8,11,16,22,32,45,64,90,128,181,256]（×√2）；缓存判据必须含「当前需求级」。
- ⚠ 生产前端 web/js/main.js 尚未在地图画 footprint。

## 待办
- 占地皮玩法筹划书：待办事项/六边形领地扩张（占地皮）实现筹划.md。只加 L2 领地层 + L3 世界时钟，不改 mapgen.js；核心=单一多源 Dijkstra 波前。