# 宗门模拟器 demo · 长期备忘

> 详程见 daily logs（2026-09-07~12.md）。只留跨会话必记结论。2026-09-12 精简重写 + 清理 verify/ 一次性脚本。

## 全局约定
- 坐标/距离一律用「格子」，废弃「世界单位」。规则层用格 (q,r)；仅渲染画点时经 tileToWorld 换算。

## 架构与参数真源
- Server/Zongmen：.NET8 + ClearScript.V8 + protobuf-net3 + SQLite(WAL)，Kestrel 0.0.0.0:8140(`Zongmen.Port`)，托管 web/ + /api/map/* + /ws/map。前端 web/js/{pb,mapclient,textures,renderer,main}.js；生成/噪声/寻路全在 Engine/js/。
- **生成参数唯一真源 = `Engine/js/mapgen-config.js`**（global.MapGenConfig）。服务端启动时按 [noise, mapgen-config, mapgen, mapgen-server] 拼 bundle（不热加载）。改参数只改 config 或 `MapGen.configure()`。
- 改引擎 js 后必做：① `node verify/sync_preview_inline.mjs`（`--check` 比对）② 重启服务端；chunk/comm 载荷变了再清 `db/zongmen.sqlite*`。

## 灵气边界衰减（界外全海洋 + 无聚落）
- `edgeKeep(sp,band)=smoothstep(0,band,sp)` 是 0..1 的「保留」权重；要衰减一律 `1 - edgeKeep(...)`（写反 = 灵气越浓越沉海）。
- `EDGE_SEA_SP`(0.30) → 地形 `gSea = 1-edgeKeep(...)`，**必须放在 LIFT_CORE 抬升之后**，同系数乘进 `communityOf`；`EDGE_SETTLE_SP`(0.35) → `settlementsFor` 的 pSpawn 与秘境同受门控。置 0 = 硬边界。
- `fields()` 灵脉覆写守卫 `vn.d<=1 && e >= SEA_LEVEL`（否则海面出无根灵脉峰）。
- ⚠ 边界真半径 = `SPIRIT_R_TILES × HEX_R × 2` = 8000 世界单位 ≈577 格，**唯一真源 `MapGen.spiritEdgeWorld()`**；绝不用 ×HEX_W（差 √3/2）。

## 存储
- SQLite 单表 `Data(Key PK, Value BLOB)`，WAL + 250ms 批量落库；**只存 chunk/comm**，Value=gzip(protobuf)，键 `w:<seedHash16>:<kind>:<a>:<b>`。Region 键不落库（内存 `_regionHot` LRU512）；**tile/fields 从不落库**。
- 内存：MemoryVirtualContext cap8192 + 独立 LRU（tile/grid/region/blockLayers/roadVer/blockRev）。入口仅 `Store()`，读 `_mem → ReadSqlBackfill`。

## 协议 / 前端铁律
- protobuf 带符号整型必须 ZigZag；bytes 裸 LE 定宽逐值写；WaterD=-1 用 255 哨兵。
- `pb.js` 长度前缀必须 `var len=r.vi(); var eN=r.p+len;`（`r.p+r.vi()` 少 1 字节，packed varint 静默丢末项）。
- mask：0→All 与「未登录剔实体层」都在 MapWsHandler；`mapclient.onFrame` **只更新命中位**的 rev。帧 [1B type][payload]，TileResponse 恒 gzip。
- `renderStaticInto()` 由 `staticDirty` 门控：写 chunk/region/settle/poi/comm/roads 必须同时置脏。
- `/api/map/fields` 只下发 `{q0,r0,nq,nr,d}`（**无 q1/r1**）；色板唯一真源 `/api/map/meta`，改色只改 mapgen.js。
- 精灵 `sprite=row*8+col` 必须在已绘制格（第 6 行到 54，55 空；森林仅 44..47）。
- 教训：客户端读服务端未下发的字段不报错，只表现为恒定空值 → 对齐两侧字段清单。

## 已闭合 bug 戒条
- pumpChunks 共享闭包 `var job` → busy 卡死（改独立闭包 + gen 守卫）；propElevs `k<3→k<4`；chunk 失败 404→chunkFail、网络→指数退避；seed 全串作 key；丢弃分支必须 `MC.blockForget`（维持「revs 有 ⇒ chunkData 有」）。

## 构建 / 运维
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj）。ContentRoot = `AppContext.BaseDirectory`（否则静默丢 appsettings）。
- 存活 `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`；端口 netstat + tasklist 双确认；占用先 taskkill。
- 🚫 mapgen 一律先不动（待整体重构）；astar guard=12000 不变。
- 验证「无损」要比集合/逐元素（比数量会抵消误判）；给纯函数喂输入。

## ⚠ 本机文件删除高危（2026-09-12 实测）
- **`git rm <文件>` 两次导致整个 `verify/` 目录从工作区消失**；连带 shell 通配符 `rm -f ./*.html` 因 `cd` 失败落到仓库根，误删 `灵脉预览.html`。根因未定（已排除钩子/alias/GitKraken）；未复现，勿再试。
- **规矩**：清理一律 Node `fs.unlinkSync`（绝对路径 + basename/数量断言），**禁用 shell 通配符与 `git rm`**；登记用 `git add -A <dir>`。恢复：`git restore --source=HEAD --staged --worktree -- .`（untracked 产物不可恢复）。
- 本机 PowerShell 工具调用异常（exit 1 无输出），勿用于清理。

## 验证
- 基线：`verify_map` 944 + w1~w5(6/6/4/6/6) + `frontend_smoke` 32 = **1004 全绿**；`scan_poison` 1681 块 bad=0。对应：mapclient/revs/mask→w1+w4；缓存并发→w2；mapgen/astar→w3；UI/色板/协议字段→frontend_smoke。
- 静态回归（改预览页后必跑，无需服务端）：`check_preview_vein_marker` / `check_preview_terrain` / `check_preview_settle_road` / `check_edge_falloff` / `sync_preview_inline --check`。
- 视觉三件套：`preview_fixedpage.mjs <scale> <out.html>` → `shot.mjs` → `crop_png.mjs`（裁图按 PNG 宽高×比例推，勿写死像素）。Chrome 在 `~/AppData/Local/Google/Chrome/Application/chrome.exe`。
- headless 判据：空白 mean≈(237,227,205) 色数<300；真渲染 mean130~190、色数千+。按时间门控的 UI 恒空是伪影。
- 2026-09-12 清理：删 9 个一次性脚本 + 全部调试产物（40png/8log；68MB→200K），保留 20 个（含 cdp 三件套作兜底）。

## 预览页 `灵脉预览.html`
- 4 个内联 `<script>`：noise / mapgen-config / mapgen / 渲染层；file:// 直开；改引擎后需重新内联。
- **灵脉标识 = 六角形徽标**，尺寸唯一真源 `markBase = clamp(REGION_M*HEX_W*scale*0.16, 2, 16)`（聚落共用）；`vrr = max(2.2, max(markBase,3.0)*vf)`，vf 大1.5/中1/小0.65。禁止退回 `rTiles*HEX_R*scale` 或 `cellPx>1.5` 门控；**六芒星已被否决**，别再改星形。须与地块网格同朝向（60k-90° 尖顶）。
- 地形层多级 LOD：阶梯 `[1,2,3,4,6,8,11,16,22,32,45,64,90,128,181,256]`（×√2，别改回 2 的幂）；插值仅当每光栅像素 <2.5px；**缓存判据必须含「当前需求级」**；周期 draw() 会饿死纯 debounce。
- 聚落网格 ≠ 群落晶格，`settlementsFor` 不读 COMM_CL。代价：A* 单条 ~40ms（最坏 380ms）、聚落扫描冷 138ms → 聚落本页再缓存，道路仅中心 ±N 渐进。控件：`oninput` 只更数字、`onchange` 才 configure()。

## 待办：占地皮玩法（未开工）
- 筹划书 `待办事项/六边形领地扩张（占地皮）实现筹划.md`。只需加 L2 领地层 + L3 世界时钟，**不改 mapgen.js**；核心 = 单一多源 Dijkstra 波前；D1~D8 待拍板。

## git（本机脆弱）
- remote `https://github.com/lin12058/ZongmenSimulator.git`。push 挂起无输出 = 凭据弹窗没人点；几秒内 schannel 报错 = 真 TLS（换 HTTP/1.1 或 openssl）。
- `.git` 曾被外部进程删过一次；恢复靠备份 + fetch + 从 `.git/logs/HEAD` 取 SHA `update-ref`，别急着重 init。每次提交后尽快 push。
- `.gitignore` 排除 `verify/*.png|*.html|*.log|*.txt` 与 `待办事项/`；**`.workbuddy/memory/` 与 `.workbuddy/skills/` 已开白名单入库**（用户 2026-09-12 要求；须「目录级 `!xxx/` + 内容级 `!xxx/**`」两条反转，只写 `!子文件` 无效）。
- bash 工具偶发 PATH 残缺 → 前置 `export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:$PATH"`。
