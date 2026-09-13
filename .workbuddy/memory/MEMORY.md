# 宗门模拟器 demo · 长期备忘

> 详程见 .workbuddy/memory/YYYY-MM-DD.md。只留跨会话必记结论。2026-09-13 精简重写（14.6KB → ~5.5KB）。

## 全局约定
- 坐标/距离一律「格子」；规则层用格 (q,r)，仅渲染经 tileToWorld 换算。
- ⚠ 一条消息里发多个并行 Edit，实测偶发只落第一条、回执却全报成功 → 改完必须 grep 复核文件实际内容，宁可串行一条一验。文件是唯一真源。

## 架构与参数真源
- Server/Zongmen：.NET8 + ClearScript.V8 + protobuf-net3 + SQLite(WAL)，Kestrel 0.0.0.0:8140(`Zongmen.Port`)，托管 web/ + /api/map/* + /ws/map。前端 web/js/{pb,mapclient,textures,renderer,main}.js；生成/噪声/寻路在 Engine/js/。
- **生成参数唯一真源 `Engine/js/mapgen-config.js`**（global.MapGenConfig）。服务端启动按 [noise, mapgen-config, mapgen, mapgen-server] 拼 bundle，不热加载。
- ⚠ 任何 Node 侧加载引擎的脚本都必须带上 mapgen-config.js（同上顺序）。mapgen.js 写 `var CFG = global.MapGenConfig || {兜底}`，漏加载**不报错**，只静默跑陈旧参数 → 参照世界 ≠ 服务端世界。自检：`for f in verify/*.mjs; do grep -q mapgen.js $f && ! grep -q mapgen-config $f && echo "缺配置 $f"; done`
- 改引擎 js 后必做：① `node verify/sync_preview_inline.mjs`（--check 比对）② 重启服务端；chunk/comm/settle 载荷变了要清 db/zongmen.sqlite*。

## 灵气边界衰减
- `edgeKeep(sp,band)=smoothstep(0,band,sp)` 是「保留」权重；要衰减一律 `1-edgeKeep(...)`（写反 = 越浓越沉海）。
- EDGE_SEA_SP(0.30) → 地形 gSea，**必须放在 LIFT_CORE 抬升之后**，同系数乘进 communityOf；EDGE_SETTLE_SP(0.35) → settlementsFor 的 pSpawn 与秘境同受门控。
- fields() 灵脉覆写守卫 `vn.d<=1 && e >= SEA_LEVEL`。边界真半径唯一真源 `MapGen.spiritEdgeWorld()`（= SPIRIT_R_TILES×HEX_R×2，勿用 ×HEX_W）。

## 存储
- SQLite 单表 Data(Key PK, Value BLOB)，WAL + 250ms 批量；存 chunk/comm/settle，Value=gzip(protobuf)，键 `w:<seedHash16>:<kind>:<a>:<b>`。Region 键只内存 LRU512；tile/fields 从不落库。
- MemoryVirtualContext cap8192；入口仅 Store()，读 _mem → ReadSqlBackfill。

## 协议 / 前端铁律
- protobuf 带符号整型必须 ZigZag；bytes 裸 LE 定宽；WaterD=-1 用 255 哨兵。
- pb.js 长度前缀必须 `var len=r.vi(); var eN=r.p+len;`（`r.p+r.vi()` 少 1 字节，packed varint 静默丢末项）。
- mask：0→All 与未登录剔实体层都在 MapWsHandler；mapclient.onFrame **只更新命中位**的 rev。帧 [1B type][payload]，TileResponse 恒 gzip。
- renderStaticInto() 由 staticDirty 门控：写 chunk/region/settle/poi/comm/roads 必须同时置脏。
- /api/map/fields 只下发 {q0,r0,nq,nr,d}；色板唯一真源 /api/map/meta。
- 精灵 sprite=row*8+col 必须在已绘制格（第 6..54 行；森林仅 44..47）。
- 客户端读服务端未下发的字段不报错，只恒定空值 → 对齐两侧字段清单。
- ⚠ 新增图层/导出的**三处必挂点**：① JsEngineHost.cs 的 JsWorldVm.Call 是 switch 白名单，MapGenServer 新导出必须补 case（漏 = 「未知 JS 函数」→ TileRequest 中断，症状 mask=ALL 0 + revs[]）；② repeated 字段前端必须**逐次 push 一个元素**（写成容器套 field1 会把 string 当子消息 → `不支持的 wire=7`）；③ WS 解码异常**必须 reject pending**（否则伪装成 30s 超时）。

## 面板定位
- .panel 默认 position:relative（顶栏靠 flex）；只有浮层显式 absolute（#info/#minimapBox）。
- ⚠ .panel 的 clip-path **会裁掉整棵子树** → 下拉/浮层必须是同级定位容器的兄弟（如 #sectWrap > #sectMenu），不能当面板子节点。
- 左上「宗门录」= 实体层字段汇总；owner 恒空时掌门由 seed 派生；重建判据须含「图层规模指纹」（settle 早于 region/comm 到达）。

## 道路网（2026-09-13 network-first P0；旧成对 A*/跳板剪枝框架已退役）
- 需求图 = 聚落 × **5x5 池**的近似 RNG（3x3 会漏隔格真最近邻）；MST ⊆ RNG ⇒ 连通不碎裂。
- 建网序 = 端点 hub 等级降序 → 距离升序 → rkey（与访问顺序无关）。全局折扣：已建路格 ROAD_W_ROAD=2，不限走廊。
- 绕行闸 DI = 步数/六边距 > ROAD_DI_MAX10/10(=1.4) → 先试无折扣直连，仍超限则骨架边(Kruskal) 强制建、非骨架放弃。
- DI 重试队列（会话 FIFO，每次限量 8）**不进 roadFail**（路复用是路径依赖，记 fail 会永久毒化）；3 次仍败才转终身不可达。maxNew=0 的渲染调用跳过消化。
- cartDist() = 端点实际笛卡尔世界坐标直线距离/HEX_W 取整（纯整数恒等式 + isqrt，无浮点开方）；A* 启发 h=minW×cartDist；hexDist 只余步数预算语义。ROAD_STEPS_MAX 在复用模式下自动放宽 = COST_MAX÷ROAD_W_ROAD。
- 旋钮：ROAD_DI_MAX10、ROAD_W_ROAD、ROAD_COST_MAX(120；提 150 可救沙/水隔断孤点)。遗留 P1/P2：RoadNet 共享表示 + 干线加宽渲染；line-of-sight 平滑；严格全局成网。

## 已闭合 bug 戒条
- pumpChunks 共享闭包 var job → busy 卡死（改独立闭包 + gen 守卫）；propElevs k<3→k<4；chunk 404→chunkFail、网络→指数退避；丢弃分支必须 MC.blockForget。
- 整型几何公式必须与浮点真值做 ≥10 万点对拍（B 公式曾漏 2·u.dr·v.dr 交叉项）；寻路改动用**独立朴素 Dijkstra** 对拍代价/可达性。

## 构建 / 运维
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj）。ContentRoot = AppContext.BaseDirectory（否则静默丢 appsettings）。
- 存活 `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`；端口 netstat + tasklist 双查。优先 `taskkill /F /PID <pid>`（git-bash 要 MSYS_NO_PATHCONV=1）；`/IM` 会连带杀用户那份。
- ⚠ bin/wsbuild/ 可能是旧构建（曾缺 settleJson 白名单分支 → 「未知 JS 函数」，实体层整个丢，伪装成服务端没数据）。怪症先 dotnet build。
- 隔离验证实例：`dotnet build Server/Zongmen/Zongmen.csproj -o verify/_vmsrv -p:UseAppHost=false`（先停实例否则 dll 被锁）→ 覆写该目录 appsettings 的 Port/DbPath（独立库）→ `cd verify/_vmsrv && dotnet Zongmen.dll`。FindRoot 自动上溯仓库根，web/ 与 Engine/js 用最新源码；写完临时配置**别再 build**。

## ⚠ 本机文件删除高危
- `git rm` 曾两次导致整个 verify/ 从工作区消失；shell 通配符 rm 因 cd 失败落到仓库根，误删 灵脉预览.html。
- 规矩：清理一律 Node fs.unlinkSync（绝对路径 + basename/数量断言），**禁用 shell 通配符与 git rm**；登记用 git add -A <dir>。恢复 `git restore --source=HEAD --staged --worktree -- .`。本机 PowerShell 工具调用异常，勿用于清理。

## 验证
- 基线（2026-09-13）：verify_map + w3_bfs_road(12 项) + w1/w2/w4/w5 + frontend_smoke **全绿**；scan_poison 1681 块 bad=0。判据认「全部通过 ✔ + 退出码 0」，别拿旧数字比。
- 对应：mapclient/revs/mask→w1+w4；缓存并发→w2；道路→w3_bfs_road；UI/色板/协议字段→frontend_smoke。静态回归：check_preview_{vein_marker,terrain,settle_road} + check_edge_falloff + sync_preview_inline --check。
- ⚠ scan_poison.mjs 的 BASE 默认写死 8140；跑别的端口要显式传 baseUrl（否则是连错端口的**假 BAD timeout**）。
- 视觉三件套：preview_fixedpage.mjs <scale> <out.html> → shot.mjs → crop_png.mjs（按 PNG 宽高×比例裁图）。Chrome 在 ~/AppData/Local/Google/Chrome/Application/chrome.exe。
- 生产页截图：`node verify/cdp_screenshot.mjs <url>`（含 HUD 几何探针），用 run_in_background 跑（~20s，前台易被掐断）。快速迭代可 headless chrome --virtual-time-budget=16000 --screenshot（带独立 --user-data-dir）。
- HUD 错位一律用 getBoundingClientRect 数值核，别凭缩放截图肉眼判断。headless 判据：空白 mean≈(237,227,205)、色数<300；真渲染 mean130~190、色数千+。

## 预览页 灵脉预览.html
- 4 个内联 script：noise / mapgen-config / mapgen / 渲染层；file:// 直开；改引擎后需重新内联（sync_preview_inline.mjs）。
- 灵脉/聚落标识 = 六角形徽标，尺寸唯一真源 `markBase = clamp(REGION_M*HEX_W*scale*0.16, 2, 16)`；禁止退回 rTiles*HEX_R*scale 或 cellPx>1.5 门控；**六芒星已被否决**。须与地块网格同朝向（60k-90° 尖顶）。
- 地形层多级 LOD 阶梯 [1,2,3,4,6,8,11,16,22,32,45,64,90,128,181,256]（×√2）；**缓存判据必须含「当前需求级」**。
- ⚠ 生产前端 web/js/main.js **尚未在地图上绘 footprint**（建筑足迹/贸易弧线只在预览页落地）；宗门录已消费产能/建筑摘要。

## 待办
- 占地皮玩法筹划书：待办事项/六边形领地扩张（占地皮）实现筹划.md。只需加 L2 领地层 + L3 世界时钟，**不改 mapgen.js**；核心 = 单一多源 Dijkstra 波前。

## git（本机脆弱）
- remote https://github.com/lin12058/ZongmenSimulator.git。push 挂起 = 凭据弹窗没人点；几秒内 schannel 报错 = 真 TLS。
- .git 曾被外部进程删过；恢复靠备份 + fetch + 从 .git/logs/HEAD 取 SHA `update-ref`，别急着重 init。每次提交后尽快 push。
- .gitignore 排除 verify/*.png|*.html|*.log|*.txt 与 待办事项/；.workbuddy/memory/ 与 skills/ 已开白名单（须目录级 `!x/` + 内容级 `!x/**` 两条）。
- bash 工具偶发 PATH 残缺 → 前置 `export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:$PATH"`。
