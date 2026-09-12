# 宗门模拟器 demo · 长期备忘

> 详程见 daily logs（2026-09-07~12.md）。只留跨会话必记结论。2026-09-12 精简重写 + 清理 verify/ 一次性脚本。

## 全局约定
- 坐标/距离一律用「格子」，废弃「世界单位」。规则层用格 (q,r)；仅渲染画点时经 tileToWorld 换算。
- ⚠ **一条消息里发多个并行 Edit 时，实测偶发只落第一条，回执却都报「成功」**（2026-09-12 两次：`els` 初始化块、`#info/#minimapBox` 的 `position:absolute`）。
  → 改完**必须 grep 复核实际文件内容**，别只看回执；宁可串行发、一条一验。同理：文件是唯一真源，别拿「我以为改过了」推演布局。

## 架构与参数真源
- Server/Zongmen：.NET8 + ClearScript.V8 + protobuf-net3 + SQLite(WAL)，Kestrel 0.0.0.0:8140(`Zongmen.Port`)，托管 web/ + /api/map/* + /ws/map。前端 web/js/{pb,mapclient,textures,renderer,main}.js；生成/噪声/寻路全在 Engine/js/。
- **生成参数唯一真源 = `Engine/js/mapgen-config.js`**（global.MapGenConfig）。服务端启动时按 [noise, mapgen-config, mapgen, mapgen-server] 拼 bundle（不热加载）。改参数只改 config 或 `MapGen.configure()`。
- ⚠ **任何 Node 侧加载引擎的脚本都必须带上 `mapgen-config.js`**（顺序 noise → config → mapgen → mapgen-server）。`mapgen.js` 是 `var CFG = global.MapGenConfig || {兜底}`，**漏加载不报错**，只静默跑陈旧兜底参数 → 「参照世界 ≠ 服务端世界」（区域名/灵脉/chunk/道路/城镇中心全不同）。2026-09-12 已补齐 verify_map / scan_poison / w5_sprite_range / frontend_smoke。自检：`for f in verify/*.mjs; do grep -q mapgen.js $f && ! grep -q mapgen-config $f && echo "缺配置 $f"; done`
- 改引擎 js 后必做：① `node verify/sync_preview_inline.mjs`（`--check` 比对）② 重启服务端；chunk/comm/**settle** 载荷变了再清 `db/zongmen.sqlite*`。

## 灵气边界衰减（界外全海洋 + 无聚落）
- `edgeKeep(sp,band)=smoothstep(0,band,sp)` 是 0..1 的「保留」权重；要衰减一律 `1 - edgeKeep(...)`（写反 = 灵气越浓越沉海）。
- `EDGE_SEA_SP`(0.30) → 地形 `gSea = 1-edgeKeep(...)`，**必须放在 LIFT_CORE 抬升之后**，同系数乘进 `communityOf`；`EDGE_SETTLE_SP`(0.35) → `settlementsFor` 的 pSpawn 与秘境同受门控。置 0 = 硬边界。
- `fields()` 灵脉覆写守卫 `vn.d<=1 && e >= SEA_LEVEL`（否则海面出无根灵脉峰）。
- ⚠ 边界真半径 = `SPIRIT_R_TILES × HEX_R × 2` = 8000 世界单位 ≈577 格，**唯一真源 `MapGen.spiritEdgeWorld()`**；绝不用 ×HEX_W（差 √3/2）。

## 存储
- SQLite 单表 `Data(Key PK, Value BLOB)`，WAL + 250ms 批量落库；**存 chunk/comm/settle**，Value=gzip(protobuf)，键 `w:<seedHash16>:<kind>:<a>:<b>`。Region 键不落库（内存 `_regionHot` LRU512）；**tile/fields 从不落库**。
- 内存：MemoryVirtualContext cap8192 + 独立 LRU（tile/grid/region/blockLayers/roadVer/blockRev）。入口仅 `Store()`，读 `_mem → ReadSqlBackfill`。

## 协议 / 前端铁律
- protobuf 带符号整型必须 ZigZag；bytes 裸 LE 定宽逐值写；WaterD=-1 用 255 哨兵。
- `pb.js` 长度前缀必须 `var len=r.vi(); var eN=r.p+len;`（`r.p+r.vi()` 少 1 字节，packed varint 静默丢末项）。
- mask：0→All 与「未登录剔实体层」都在 MapWsHandler；`mapclient.onFrame` **只更新命中位**的 rev。帧 [1B type][payload]，TileResponse 恒 gzip。
- `renderStaticInto()` 由 `staticDirty` 门控：写 chunk/region/settle/poi/comm/roads 必须同时置脏。
- `/api/map/fields` 只下发 `{q0,r0,nq,nr,d}`（**无 q1/r1**）；色板唯一真源 `/api/map/meta`，改色只改 mapgen.js。
- 精灵 `sprite=row*8+col` 必须在已绘制格（第 6 行到 54，55 空；森林仅 44..47）。
- 教训：客户端读服务端未下发的字段不报错，只表现为恒定空值 → 对齐两侧字段清单。
- ⚠ **新增图层/导出时的三处必挂点**（漏任一处只在运行期炸，且症状伪装）：
  ① `JsWorldVm.Call`（`Engine/JsEngineHost.cs`）是 `switch` 白名单 —— JS 侧 `global.MapGenServer` 新增导出后**必须补 case**，否则抛「未知 JS 函数」→ 整个 TileRequest 中断，症状=`mask=ALL 0` + `revs []` + 所有图层「存在」全 FAIL（看着像没数据，实为异常提前返回）。
  ② repeated 消息字段在前端必须**逐次 push 一个元素**（同 `EntityGroup.items[]`）：`case 15: m.buildings.push(parseBuilding(r.bin(rdLen(r,t))))`。误写成「容器套 field1 条目」时，`ResourceQuantDto` 的 field1 恰是 string(wire=2) 被当条目载荷 → 把 UTF-8 按子消息解 → **`不支持的 wire=7`**。
  ③ WS 客户端解码异常**必须 reject pending**：`verify_map.tile()` 只在 onmessage 里 resolve，解码失败若只 `console.error` → promise 永不落地 → 伪装成 **30s「ws 请求超时」**（先查日志有无 `TileResponse 解码失败`，别先怀疑性能）。

- **面板定位**：`.panel` 默认 `position:relative`（顶栏靠 flex 排序）；**浮层才显式 `absolute`**（`#info`/`#minimapBox`）。
  原先 `.panel` 写死 absolute、顶栏两块面板靠「无偏移绝对定位」凑左右位 —— 一旦其中一块回到流内，另一块的静态位置立刻跑到行首（曾把 `#controls` 甩到左上压住题名）。
  ⚠ `.panel` 的 `clip-path` **会裁掉整棵子树** → 下拉/浮层必须放到同级的定位容器里（如 `#sectWrap > #sectMenu`），不能当 `#sectBox` 的子节点。
- **左上「宗门录」**（`web/js/main.js` 的 `sect` 模块）= 实体层字段汇总（name/pop/tier/styleName/buildings/resources + regionCells 推地界 + 群落推最近灵脉），**未新增后端契约**；
  「掌门」因 `owner` 恒空而由 seed 派生（演示值，owner 有值即优先）；重建判据须含「图层规模指纹」（区块响应里 settle 先于 region/comm 到达，否则「未探明/未附灵脉」永久滞留）。

## 已闭合 bug 戒条
- pumpChunks 共享闭包 `var job` → busy 卡死（改独立闭包 + gen 守卫）；propElevs `k<3→k<4`；chunk 失败 404→chunkFail、网络→指数退避；seed 全串作 key；丢弃分支必须 `MC.blockForget`（维持「revs 有 ⇒ chunkData 有」）。

## 构建 / 运维
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj）。ContentRoot = `AppContext.BaseDirectory`（否则静默丢 appsettings）。
- 存活 `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`；端口 netstat + tasklist 双确认；占用先 taskkill。
  ⚠ `taskkill /F /IM Zongmen.exe` 是**按进程名**杀，会连带用户自己那份一起结束；优先 `taskkill /F /PID <pid>`（git-bash 里要 `MSYS_NO_PATHCONV=1`，否则 `/F` 被当路径转换）。
- ⚠ **`bin/wsbuild/` 可能是旧构建**：2026-09-12 它缺 `JsEngineHost` 的 `settleJson` 白名单分支（dll 15:26 < 源码 15:48）→ 页面报「未知 JS 函数: settleJson」、实体层整个丢，症状伪装成「服务端没数据」。
  遇到引擎缺函数的怪症先 `dotnet build`（输出 `bin/Debug/net8.0`）或重新 publish，别先怀疑引擎。
- ✅ **mapgen 重构已于 2026-09-12 完成**：道路 A\*→带权重 BFS（剪枝 **120 权重/40 步**，桶序 `f=g+h`）、城镇「勘测→选址→生长」（`PROSPECT_R=4`/`PROSPECT_REFINE=6`/`TOWN_R=3`/`TOWN_HOUSE_RATIO=0.3`）、
  建筑数按规模分档 `TOWN_BUILD_MAX{village:8,town:16,city:25,sect:16}`、`settle` 层落库、贸易 `TRADE_REACH=40`。`astar`/`Heap`/`roadCost`/`guard=12000` 说法**全部作废**。
- 验证「无损」要比集合/逐元素（比数量会抵消误判）；给纯函数喂输入。
- **隔离验证实例**（不打扰用户正在看的 8140）：`dotnet build Server/Zongmen/Zongmen.csproj -o verify/_vmsrv -p:UseAppHost=false`
  （正式 exe 被占用时也能编；**先停实例再 build**，dll 会被锁）→ 覆写该目录 `appsettings.json` 的 `Port`/`DbPath`（独立库，勿共用 `db/zongmen.sqlite`）→ `cd verify/_vmsrv && dotnet Zongmen.dll`。
  `FindRoot` 会向上自动找到仓库根，故 web/ 与 Engine/js 直接用最新源码。**写完临时配置后别再 build**（会被项目里的 appsettings 覆盖）。

## ⚠ 本机文件删除高危（2026-09-12 实测）
- **`git rm <文件>` 两次导致整个 `verify/` 目录从工作区消失**；连带 shell 通配符 `rm -f ./*.html` 因 `cd` 失败落到仓库根，误删 `灵脉预览.html`。根因未定（已排除钩子/alias/GitKraken）；未复现，勿再试。
- **规矩**：清理一律 Node `fs.unlinkSync`（绝对路径 + basename/数量断言），**禁用 shell 通配符与 `git rm`**；登记用 `git add -A <dir>`。恢复：`git restore --source=HEAD --staged --worktree -- .`（untracked 产物不可恢复）。
- 本机 PowerShell 工具调用异常（exit 1 无输出），勿用于清理。

## 验证
- 基线（2026-09-13 更新）：`verify_map` **1206** + `w3_bfs_road` **12** 项断言（拓扑改「邻域全对 + 跳板剪枝」后分母=可建对，详见 2026-09-13 日志） + `w1/w2/w4/w5` + `frontend_smoke` **全绿**；`scan_poison` 1681 块 bad=0。（旧基线「verify_map 944 / w3 4」已作废：944→1206 是新增 settle 层断言，w3 由 A\* 断言换成 BFS 断言。判据认「全部通过 ✔ + 退出码 0」，别拿旧数字比。）对应：mapclient/revs/mask→w1+w4；缓存并发→w2；道路 BFS/城镇→w3+w3_bfs_road；UI/色板/协议字段→frontend_smoke。
- ⚠ `scan_poison.mjs` 的 BASE **默认写死 8140**；对别的端口跑必须显式传 baseUrl，否则每块都 timeout 并打印 `BAD ... timeout` —— 那是连错端口的**假 BAD**。
- 静态回归（改预览页后必跑，无需服务端）：`check_preview_vein_marker` / `check_preview_terrain` / `check_preview_settle_road` / `check_edge_falloff` / `sync_preview_inline --check`。
- 视觉三件套：`preview_fixedpage.mjs <scale> <out.html>` → `shot.mjs` → `crop_png.mjs`（裁图按 PNG 宽高×比例推，勿写死像素）。Chrome 在 `~/AppData/Local/Google/Chrome/Application/chrome.exe`。
- **生产页（8140）截图**：`node verify/cdp_screenshot.mjs <url>`（已内置 HUD 几何探针：titleBox/sectBox/controls/minimapBox/info 的 left,top,w,h + 宗门录字段数）。
  ⚠ 用 `run_in_background` 跑：它要等 ~20s，前台跑常被掐断（SIGTERM），管道输出一起丢，表现为「完全无输出」的假故障。
  快速迭代布局可直接 `chrome --headless=new --window-size=1500,950 --virtual-time-budget=16000 --screenshot=x.png <url>`（必须带独立 `--user-data-dir`）。
- **HUD 错位别据缩放后的截图下判断**（预览图会被重采样，肉眼会把阴影/地形看成"空面板"）→ 一律用 `getBoundingClientRect` 数值核。交互态（下拉菜单开合/选中）用 CDP 里 `element.click()` 驱动后再截图+回读文本。
- headless 判据：空白 mean≈(237,227,205) 色数<300；真渲染 mean130~190、色数千+。按时间门控的 UI 恒空是伪影。
- 2026-09-12 清理：删 9 个一次性脚本 + 全部调试产物（40png/8log；68MB→200K），保留 20 个（含 cdp 三件套作兜底）。

## 预览页 `灵脉预览.html`
- 4 个内联 `<script>`：noise / mapgen-config / mapgen / 渲染层；file:// 直开；改引擎后需重新内联。
- **灵脉标识 = 六角形徽标**，尺寸唯一真源 `markBase = clamp(REGION_M*HEX_W*scale*0.16, 2, 16)`（聚落共用）；`vrr = max(2.2, max(markBase,3.0)*vf)`，vf 大1.5/中1/小0.65。禁止退回 `rTiles*HEX_R*scale` 或 `cellPx>1.5` 门控；**六芒星已被否决**，别再改星形。须与地块网格同朝向（60k-90° 尖顶）。
- 地形层多级 LOD：阶梯 `[1,2,3,4,6,8,11,16,22,32,45,64,90,128,181,256]`（×√2，别改回 2 的幂）；插值仅当每光栅像素 <2.5px；**缓存判据必须含「当前需求级」**；周期 draw() 会饿死纯 debounce。
- 聚落网格 ≠ 群落晶格，`settlementsFor` 不读 COMM_CL。代价：道路单区域 **22ms（最坏 ~58ms，2026-09-13 起为「邻域全对 + 跳板剪枝」拓扑；A\* 时代最坏 540ms）**、聚落扫描冷 ~138ms → 聚落本页再缓存，道路仅中心 ±N 渐进。控件：`oninput` 只更数字、`onchange` 才 configure()。
- **道路拓扑/距离语义（2026-09-13）**：roadsNear = 邻域全对（3x3 池，按 `cartDist` 升序）+ 跳板剪枝 `hopPrune`（∃m 严格介于两点之间且直线绕行 ≤30% `10/13` ⇒ 不建直达；跳板不限规模；m 严格介于 ⇒ 最近邻对与 MST 边不可剪 ⇒ 不碎裂）。**`cartDist` = 两端点笛卡尔世界坐标实际直线距离/HEX_W 取整**（恒等式 dx²+dy²=HEX_W²·(dq²+dq·dr+dr²) + 整数 isqrt，无浮点开方）；A\* 启发 h=minW×cartDist；hexDist 只剩步数预算语义。跳板池 = 3x3(a格)∪3x3(b格) 保证两侧评估一致。
- 城镇足迹已渲染（`cb_build`/`drawTownPlan` 六边底框+建筑芯）、贸易网络（`cb_trade` 虚线弧+产能摘要）、名称后 `· 风格名`。
- ⚠ **生产前端 `web/js/main.js` 尚未在地图上绘 footprint**（§五 的建筑足迹/贸易弧线目前只在预览页落地）。产能/建筑**摘要**已由左上「宗门录」面板消费（按 kind 计数 + resources 列表），但地图上的足迹图元仍未画 —— 后续工作。

## 待办：占地皮玩法（未开工）
- 筹划书 `待办事项/六边形领地扩张（占地皮）实现筹划.md`。只需加 L2 领地层 + L3 世界时钟，**不改 mapgen.js**；核心 = 单一多源 Dijkstra 波前；D1~D8 待拍板。

## git（本机脆弱）
- remote `https://github.com/lin12058/ZongmenSimulator.git`。push 挂起无输出 = 凭据弹窗没人点；几秒内 schannel 报错 = 真 TLS（换 HTTP/1.1 或 openssl）。
- `.git` 曾被外部进程删过一次；恢复靠备份 + fetch + 从 `.git/logs/HEAD` 取 SHA `update-ref`，别急着重 init。每次提交后尽快 push。
- `.gitignore` 排除 `verify/*.png|*.html|*.log|*.txt` 与 `待办事项/`；**`.workbuddy/memory/` 与 `.workbuddy/skills/` 已开白名单入库**（用户 2026-09-12 要求；须「目录级 `!xxx/` + 内容级 `!xxx/**`」两条反转，只写 `!子文件` 无效）。
- bash 工具偶发 PATH 残缺 → 前置 `export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:$PATH"`。
