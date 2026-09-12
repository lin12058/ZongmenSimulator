# 宗门模拟器 demo · 长期备忘

> 详程见 daily logs(2026-09-07~11.md)。此处只留跨会话必记结论。

## 通用约定
- **坐标/距离一律用「格子」表述，废弃「世界单位」概念**（不用 tileToWorld 的 x/y 像素级单位描述间距）。
  规则层全用格子(q,r)判定；仅在最终渲染画点时经 tileToWorld 换算坐标。若需像素可临时折算（≈1格≈13.86×12），但常规距离讨论只用格子。

## 形态与数据流
- 后端 Server/Zongmen：.NET8 + ClearScript.V8 + protobuf-net3 + Microsoft.Data.Sqlite(WAL)。Kestrel 0.0.0.0:8140(appsettings `Zongmen.Port`)。托管 web/ 静态 + /api/map/* + /ws/map + /api/debug/snap。
- 前端 web/：index.html + js/{pb,mapclient,textures,renderer,main}.js。地图生成全在 Server/Engine/js/（noise+mapgen+mapgen-server），前端无生成/噪声/寻路。
- 链路：JS 沙箱 → JSON → C# 装配 protobuf → gzip → SQLite(KV) + 内存 LRU。图数据走 /ws/map 单块；tile/fields 走 HTTP 即时算 + 进程内缓存。
- **世界生成参数唯一真源 = `Server/Zongmen/Engine/js/mapgen-config.js`（global.MapGenConfig）**：mapgen.js 从其导入（原有内置 CFG 已删，仅留兜底）；服务器 `JsEngineHost` 按 [noise.js, mapgen-config.js, mapgen.js, mapgen-server.js] 顺序拼 bundle；预览页内联同名脚本块。**改参数只改 config**（或运行时 MapGen.configure）。引擎 js 目录由 ResolveEngineJsDir 直读源目录，新增 js 无需改 csproj。
- **改引擎 js 后的两条硬动作**：① `node verify/sync_preview_inline.mjs`（把 config/mapgen 同步内联进 `灵脉预览.html`，以前手工替换必漏；`--check` 只比对）；② 重启服务器（`JsEngineHost` 在启动时一次性拼 bundle，不热加载）+ 清 `db/zongmen.sqlite*`（若 chunk/comm 载荷变了）。

## 灵气边界衰减（界外全海洋 + 无聚落，2026-09-12 落地）
- 一个场驱动两处衰减：`edgeKeep(sp,band) = NL.smoothstep(0, band, sp)` 是 **0..1 的"保留"权重**（sp≥band→1 不衰减，sp=0→0 彻底衰减）。
  - `EDGE_SEA_SP`(0.30) → 地形：`gSea = 1 - edgeKeep(spiritAt(q,r), EDGE_SEA_SP)`，**必须放在 LIFT_CORE 灵脉抬升之后**；下沉目标 ∈[0.24,0.36] 恒 < SEA_LEVEL ⇒ 界外必为海。同一系数还乘进 `communityOf`（否则水下留空壳群落）。
  - `EDGE_SETTLE_SP`(0.35) → `settlementsFor` 的 `pSpawn = (0.20+0.38*spLoc) * edgeKeep(...)`（秘境同受门控）。
  - 系数置 0 = 硬边界。两处都可调，改 config 即可。
- `fields()` 的灵脉覆写加守卫 `vn.d<=1 && e >= SEA_LEVEL`（否则沉海的灵脉仍吐 disp≥8 → 海面"无根灵脉峰"）。
- ⚠ **语义陷阱（踩过）**：别把 edgeKeep 当"衰减权重"直接乘 —— 写反的后果是**灵气越浓越沉海**（内圈全淹、边界露出陆地）。
  要衰减一律 `1 - edgeKeep(...)`。命名已按"方向"定死（Keep 而非 Fade）。
- ⚠ **灵气边界口径（用户曾因此抱怨"界外还有山/城"）**：真半径 = `SPIRIT_R_TILES × HEX_R × 2` = 500×16 = **8000 世界单位 ≈ 577 格**。
  **唯一真源 = `MapGen.spiritEdgeWorld()`**；预览页边界圈/灵气渐变/统计都必须用它。
  绝不要用 `SPIRIT_R_TILES × HEX_W`（=0.866×，圈会偏小 → "圈内看着是界外"）。注意 HEX_W≈13.856 是格邻距，HEX_R×2=16 是格直径，两者差 √3/2。
- 验证：`verify/check_edge_falloff.mjs`（加载预览页内联的同一份引擎；断言 界外全海/无 disp≥8/界外 0 聚落/0 群落/系数单调/径向 48 方向陆地止于边界/5 条回归）。
- 实测（边界=8000 世界单位）：陆地占比 0.95×→61%、1.00×→**0%**；聚落 0~0.5 环 501 个 → 0.9~1.0 环 55 个 → 界外 **0**；径向陆地最远 0.70/0.93(中位)/0.97 × 边界。

## 存储（三处，别混）
- **SQLite**：唯一表 `Data(Key TEXT PRIMARY KEY, Value BLOB NOT NULL)`，WAL + 每操作短连接(池化) + 250ms 后台 writer 事务批量落库（失败整批回退重试）。**只存 chunk / comm 两类**，Value = **gzip(protobuf)**（magic `1f8b08`）。
  - 键形如 `w:{seedSHA1前16hex}:chunk:{ca}:{cb}`、`w:{...}:comm:{ci}:{cj}`；`WorldKeys.Region` 键构造存在但**不落库**（历史上只写不读 → 已改纯内存 `_regionHot` LRU512 + `_mem` 兜底）。
  - 按 seed 前缀分组；维护任务每 2min，仅当「确有世界被 LRU 淘汰」时 `PruneExcept(活跃前缀)` 清历史世界行。
- **内存**：`MemoryVirtualContext` cap8192 访问序 LRU（chunk/comm 回填用）；另 `_tileCache`/`_gridCache`/`_regionHot`/`_blockLayersCache`/`_roadVerCache`/`_blockRev` 各自独立缓存。
- 落库入口仅 `Store(key,gz)`（写 _mem + `_sql.SetDataDeferred`）；读为 `_mem → ReadSqlBackfill`（读库并回填 _mem）。**tile / fields 从不落库**。
- **没有「多表/按类型分表」设计**：全部靠 **Key 字符串 `w:<hash>:<kind>:<a>:<b>`** 区分世界与数据类型。

## 协议与编码铁律
- protobuf：带符号整型必须 `DataFormat=ZigZag`（Q/R/Ca/Cb/Ci/Cj/qr/ci/cj…）；bytes 存裸 LE 定宽（cq u8 / elev,hash u16 / neigh u32 / pdx,pdy f32），Float32Array 不能直接 `new Uint8Array(f32.buffer)`，须逐值写。TileQuery.WaterD=-1 用 255 哨兵。
- **`pb.js` 长度前缀陷阱**：`var eN=r.p+r.vi()` 中 r.p 是推进前值 → 少 1 字节。必须 `var len=r.vi(); var eN=r.p+len;`（packed varint 会静默丢最后一项）。共 6 处已修。
- **mask 语义**：0→All 归一 + 「未登录剔实体层」都在 `MapWsHandler`；`GetTileBlock` 按字面语义。`resp.Mask` = 客户端可视为持有的位；`mapclient.onFrame` **只更新命中位**的 rev（无条件写全 5 位 → 图层永久缺失）。帧 [1B type][payload]，Login=1/Tile=2/Ping=3，TileResponse 恒 gzip，请求上限 1MB。

## 前端契约铁律
- `renderStaticInto()` 由 `staticDirty` 门控 —— 凡它消费的状态（chunk/region/settle/poi/comm/roads），写入方必须同时置脏，否则「改了没反应，要等平移缩放」。
- `/api/map/fields` 只下发 `{q0,r0,nq,nr,d}`（**无 q1/r1**，上界须由 `q0+nq-1` 推）。
- 色板单点真源 = `/api/map/meta`（`geo.elementRGB/variantRGB`）；**改色只改 `mapgen.js`**。
- 精灵索引 `sprite=row*8+col` 必须落在图集已绘制格（第6行只到 54，**55 是空的**；森林仅 44..47）。着色器 biome `floor(vTile/4+0.001)`；图集除 `vec2(8,8)`。
- **通用教训**：「客户端读了服务端从未下发的字段」不报错，只表现为恒定的空/默认值 → 逐一对齐「客户端读取清单」vs「服务端 JSON 键」。

## 已闭合 bug（戒条）
- 中央黑区：pumpChunks while 里 `var job` 共享闭包 → busy 永久卡死。修：loadChunk 独立闭包 + gen 守卫 + regenerate 清 busy。
- propElevs 漏绑：uploadChunk 精灵段 `k<3→k<4`（漏 location=4 的 iElev → 山/雪峰恒最低档）。
- chunk 失败静默：404→chunkFail；网络/5xx/超时→800ms→30s 指数退避自愈。
- seed 截断冲突：删 `seed[..80]`，全串作 key。
- 「个别色块无贴图」：revs 有而 chunkData 无（丢弃分支未清 rev）→ 服务端判缺省下发 → 永久空白。修：两个丢弃分支都 `MC.blockForget`，维持「revs 有 ⇒ chunkData 有」不变式。

## 性能关键点
- GetRegionBytes 总经 JS 生成（不直读 SQLite）保持 VM roadCache 热，与 tileJson.onRoad 一致；`_mem` 命中免重生成。
- R8/R9：tile/fieldGrid 内存 LRU（tile 缓存带 roadVer 失效）；chunk/region/comm per-key in-flight 去重（`_buildGates` lock + double-check + TryRemove）。
- R2 StaticWeb ETag/Last-Modified + 文件缓存；R6 ApiRateLimit 仅 tile/fields（5s/120/IP）；R11 `configure()` 清全部 region/settle/road 缓存；R12 并发常量收敛 NET_CFG。
- mapgen 内 `cacheSet(m,key,val,cap)` 插入即超 cap 删最旧；ELEV_CAP=40000/FIELD_CAP=30000/VEIN_CAP=40000。chunkJson 单段定宽缓冲（11n 地块 + 13p 精灵，全小端）。

## 构建 / 运维
- 构建 `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj，目录报 MSB1009）；启动 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe`。
- ContentRoot 已改为 `AppContext.BaseDirectory`——否则从仓库根启动会**静默丢整份 appsettings.json**（判据：`/api/map/stats` 的 `maxSeeds`）。
- 存活 `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`（本机 curl 必须 `--noproxy`）；端口判定 `netstat -ano | grep :8140 | grep LISTEN` + tasklist 双确认。构建前若 exe 被占用先 `taskkill /PID <pid> /F`。
- 清理临时文件用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }`（bash rm/cmd del 被 SIGTERM）。
- ⚠️ 改 `mapgen.js` 地形/精灵/群系产出后**必须清 `db/zongmen.sqlite`**（chunk 载荷含精灵索引与格底；region/road 不受影响）。清法：停服 → 移走 `db/zongmen.sqlite*` → 重启重建。
- 🚫 **mapgen 一律先不动**（用户 2026-09-10 决定后续整体重构地图生成）；astar guard=12000（原 60000）保持不变，别再在 mapgen.js 做局部性能/算法改动。重构时复用 `verify/bench_guard_frontier.mjs` + `verify/w3_astar_budget.mjs`。
- 方法论警示：验证「无损」必须比**集合/逐元素**（比数量会因一增一减抵消而误判为无损，旧 `bench_roads_lost.mjs` 就这样错过），且给**纯函数**喂输入。结果违反单调性时先怀疑测量方法。

## 验证
- **全套基线**：`verify_map 944 + w1 6 + w2 6 + w3 4 + w4 6 + w5 6 + frontend_smoke 32 = 1004 项全绿`；`scan_poison` 1681 块 `bad=0`。
- 改动对应：mapclient/revs/mask → w1 + w4；缓存/并发 → w2；mapgen/astar → w3；前端 UI 状态/色板/协议字段 → `frontend_smoke`（除数据层外含五条静态契约：DOM id / 静态层置脏 / 小地图 / 色板 / 解码字段）。
- `verify_map` 只覆盖服务端契约，**覆盖不到客户端记账**；支持外部覆盖采样：`node verify_map.mjs <base> '<seeds>' '<blocks>' '<tiles>'`（100 块 ±80 = 6259 项 10.9s）。
- 截图：`node verify/shot.mjs [url] [out.png]`（解码 PNG 判空白 + 换 profile + 递增预算重试）。Chrome 在 `~/AppData/Local/Google/Chrome/Application/chrome.exe`（**不在 Program Files**）。
  - **headless 视觉验证不可靠**：虚时钟 `--virtual-time-budget` 会跑到真实 WS 之前 → 只剩纸色；且**按时间门控的 UI 恒空是伪影**（虚时钟下 rAF 仅 ~5 帧），先怀疑帧饥饿别改代码。判据：空白 mean≈(237,227,205) 且色数<300；真渲染 mean 130~190 色数上千；中途帧 mean<70。`--dump-dom` 下 rAF 不触发。
  - CDP / agent-browser 长驻 spawn 在本机被 SIGTERM，别用（`cdp_*.mjs` 仅兜底）。
- **可复现视觉断言三件套**：`verify/preview_fixedpage.mjs <scale> <out.html> [extraJs]` 生成固定种子/缩放/相机居中某大灵脉的临时页 → `shot.mjs` 截图 → `crop_png.mjs` 裁局部并最近邻放大做 1:1 形状检查。
  ⚠️ `shot.mjs` 输出 PNG 像素尺寸不固定（实测 2229×1286 与 1484×856 等比缩放）→ 裁图坐标按「PNG 宽高 × 比例」推，**不可写死像素**。
- 预览页静态契约回归：`node verify/check_preview_vein_marker.mjs`（4 内联块语法 + 27 个 DOM id + markBase 唯一真源 + 六角形朝向 + 全缩放数值表 + 星形残留拦截）。改预览页渲染后必跑。

## 调试页 `灵脉预览.html`（仓库根，自包含单文件）
- 形态：HTML + CSS + **内联 4 个 `<script>`** = noise.js / mapgen-config.js / mapgen.js / 渲染层。file:// 双击即用（内联是为了绕开 file:// 跨目录 `<script src>` 拦截）。改引擎后需**重新内联同步**。
- 渲染层唯一几何真源：地块 `(i*step, j*step)` → `tileToWorld` → `×scale + cam(像素)`；`scale` 只由滚轮控制，**不做反向补偿**。六边形世界半径 = `HEX_R*step`（step=CL 时天然平铺：横 √3R、纵 1.5R —— 实测 2078.5 / 1800.0 与理论一致）。
- 四层可视图：①群落六边形+灵脉（step=COMM_CL）②聚落（step=`REGION_M`=18）③道路（读 `roadCache`）④**地形底面**。
- **灵脉标识 = 六角形徽标**，尺寸机制与**聚落标记同一套**（唯一真源 = `draw()` 顶部的 `markBase`）：
  `markBase = clamp(REGION_M*HEX_W*scale*0.16, 2, 16)`（聚落 `mBase = markBase`，别各算一套）；
  灵脉 `vrr = max(2.2, max(markBase,3.0) * vf)`，`vf` = 大1.5 / 中1.0 / 小0.65（同聚落 tier 系数）。
  ⇒ 缩小时不会变成看不见的点、放大时不会糊成一整片；任何缩放任何位置都可辨。
  ⚠️ **禁止**退回旧式 `rTiles*HEX_R*scale`（无上限 → 4× 时 64px 巨块）或 `cellPx>1.5` 整层门控；
  占地半径（大2/中1.5/小1格）只用于地形抬升与图例文字，**不再等于标记屏幕尺寸**。
  名称标签阈值随标记尺寸（大 ≥7px、中 ≥12px），否则低缩放会标签风暴。
  **必须与地块网格同朝向**（`hexPath` 的 `60k-90°` 尖顶：顶点朝上下、左右为平边），否则与地形六边形错位。
  ⚠️ **六芒星方案已被用户否决**（2026-09-12：做成 ★式 6 尖星后用户判定"太丑"，改回六角形）。
  别再提议/改成星形、圆形或其它多边形；`check_preview_vein_marker.mjs` 已加断言拦住 `starPath/VEIN_STAR_INNER/.swatch.star` 残留。
  图例同步：色块用 `.swatch.hex`（`clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%)`）。
  ⚠️ 引擎本体的灵脉仍是**精灵峰**（图集第 6 行 50..54，按 `disp` 出），预览页的六角形只是调试标识，两者独立。
- **地形层铁律**：`fields()` 单格 21~30µs → 默认视野 1137k 格逐格 = 100 秒级，**只能"多级 LOD 光栅 + 分帧渐进"**。
  - 光栅列 `i↔世界x=i*HEX_W`、行 `j↔世界y=j*1.5*HEX_R`（即 `cell i = floor(q + r/2)`，反解 `q=Math.round(i-r/2)`，已逐格断言）。
  - **LOD 阶梯（唯一真源）** `[1,2,3,4,6,8,11,16,22,32,45,64,90,128,181,256]`（×√2，16 级）。
    `wantStepT() = quant(max(blockOK, capStep))`：`blockOK` 保屏幕块宽 ≤6px；`capStep` 保采样 ≤24000（≈引擎 `fieldCache` cap30000 → 热重建仅 3~6ms）。
    **别改回 2 的幂**：默认视野需求 9 会被拖到 16 → 17px 色块；√2 阶梯给 11 → 11.7px。
  - 各级独立缓存 `terrainLv[stepT]`（含 `img` ImageData）；`pickTerrainLv` = 覆盖视口的最细级；`pickTerrainFallback` 作过渡；
    起点对齐到本级 step 倍数；空闲 160ms 向更细一级预取。
  - **逐格六边形**（wantStepT==1 且 1 级覆盖）= 读 1 级 ImageData 取色，**不再逐格调 `fields()`** → 拖动不卡。
  - **插值只允许在"每光栅像素 <2.5px"时开**；块大必须硬边。旧规则 `块宽≥14px 才插值` 正是"放大糊成一团"的元凶之一。
  - 拖动中只拉伸旧图（`pointerdown` `terrainAbort()`）、80ms 防抖重建。**防抖必须"同需求级不重排"**——
    `pumpRoads` 每 24ms 调一次 `draw()`，纯 clearTimeout+setTimeout 会被**永久饿死**（terrainStart 一次都跑不到）。
  - **缓存复用判据必须含"当前需求级"**（`terrainLv[want]` 覆盖才复用）。只判"签名+几何覆盖"会让放大后永远吃旧粗级。
  - 别再用 `--virtual-time-budget` 下的 `performance.now()` 判耗时（虚拟时间，失真）。
  - 通用戒条：**缓存判据要包含所有影响"产物精度"的输入**（此处漏了 `scale`）；**周期性 draw() 会饿死任何纯 debounce**。
- **聚落网格与群落晶格是两套独立网格**：`settlementsFor` 不读 COMM_CL；改 `SPIRIT_R_TILES/SPIRIT_CURVE` 才会改聚落密度。
- 代价铁律：**A* 道路单条约 40ms（最坏 380ms），聚落扫描 5353 区域格冷 138ms**。故：聚落结果本页再缓存一层（对抗引擎 `SETTLE_CAP=1024` 淘汰，命中后 2ms）；道路只在视野中心 ±N 区域格渐进建造（每轮 1 条 / 24ms 间隔）+ 跳过无可建路聚落的空区域格。**别把道路铺满整个可见范围**（会 16 秒）。
- 控件语义：CFG 参数 `oninput` 只更数字、`onchange` 才 `configure()` 全量重建（否则只变视觉不变内容）；「重新生成」= 换随机种子、参数不动。

## 待办：占地皮玩法（已筹划，未开工）
- 筹划书 = `待办事项/六边形领地扩张（占地皮）实现筹划.md`（由 demo4《六边形网格城市变迁算法调研.md》转化）。目标形态：类群星/无尽的拉格朗日 占地皮 4X-lite。
- 核心结论：**只需新增 L2 领地层 + L3 世界时钟**（L1 地形/聚落/道路/灵气场已有）；**不改 mapgen.js**，全部从既有导出派生（spiritAt/veinNear/settlementsFor/roadsNear/buildChunk）。
- 核心算法 = **单一多源 Dijkstra 波前**（共享一张 bestCost → 图上加权 Voronoi；PQ 常驻跨回合增量续跑，总步数 = 总占领格数×常数）。领地层按 **chunk 同网格稀疏分块**（441 格/块），状态放 **C# 侧** 不放 JS 沙箱。
- 8 个未拍板决策点 D1~D8（含 D6 与 WS 单块重构先后、D7 与 devdoc §10「移除 comm 链路」撞车风险）。

## git（本机脆弱）
- remote `https://github.com/lin12058/ZongmenSimulator.git`。
- push 失败二分：**挂起且无输出** = 凭据弹窗没人点（让用户点一次即过；别加 `GIT_TERMINAL_PROMPT=0`，别盲目重试）；**几秒内显式 schannel 报错** = 真 TLS 问题 → 换 `-c http.version=HTTP/1.1` / `-c http.sslBackend=openssl`。
- 本地 `.git` 曾被外部进程删除过一次（提交对象全丢）；恢复靠备份 + `git fetch` + 从 `.git/logs/HEAD` 取 SHA `update-ref` 重建，**别急着重 init**。正常提交后尽快 push。
- 已全部推送：远端 main = 本地 HEAD（2026-09-12 核对为 `7d7cd9e`）。每次提交后 push，别攒。
- ✅ **`.workbuddy/memory/` 必须入库**（用户 2026-09-12 明确要求）：`.gitignore` 用 `.workbuddy/*` + `!.workbuddy/memory/` + `!.workbuddy/memory/**` 开白名单（**父目录被排除后单靠 `!` 救不回子文件，必须目录级+内容级两条反转**）；`.workbuddy/skills/` 与临时截图仍排除。`待办事项/` 仍整体排除。
- 提交 memory 时一并带上：daily log `YYYY-MM-DD.md` + `MEMORY.md`。
- 本机 bash 工具偶发 PATH 残缺（`dirname/git/tail: command not found`）→ git 命令前显式 `export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:...:$PATH"` 即可。
- `git fetch` 报 `[new branch] main -> origin/main` 但 `.git/refs/remotes/` 仍空 → `origin/main` 显示 `[gone]`。**不影响 push**；比对远端用 `git ls-remote origin refs/heads/main` 直接取 SHA。
