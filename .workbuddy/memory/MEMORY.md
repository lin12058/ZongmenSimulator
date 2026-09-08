# 宗门模拟器 demo3 · 项目长期备忘

## 当前形态（2026-09-09）：C# 后端 + 前端渲染
- **C# 后端 Server/Zongmen**：.NET 8 + ClearScript.V8 (ClearScript.Complete 7.4.5 包可还原)+ protobuf-net 3.2.30 + Microsoft.Data.Sqlite 8.0.8。Kestrel 默认监听 **0.0.0.0:8140**（appsettings "Zongmen.Port"）。**单进程同时托管前端 web/ 与 /api/map/**，StaticWebMiddleware 默认代理 web/，前端不再依赖 node server.js。
- **前端 web/**：index.html + js/{pb.js, mapclient.js, textures.js, renderer.js, main.js}；js/noise.js + js/mapgen.js 已迁移到 Server/Zongmen/Engine/js/ 不再出现在前端（前端不再跑任何地图生成）。renderer.js / textures.js 原样保留。
- **权威世界数据流**：JS 沙箱执行原始 noise.js+mapgen.js+mapgen-server.js → JSON 字符串 → C# 装配 protobuf 契约 → gzip → 直接写 SQLite (Data 表 KV) → HTTP `Content-Encoding:gzip` 下发；浏览器 fetch 透明解压；前端 `web/js/pb.js` 解码 → Float32Array 还原绝对坐标。
- **按区块加载**：区块 (seed,ca,cb)、区域 (seed,i,j)、群落 (seed,ci,cj) 全部持久化；tile/fields 即时计算。LRU 常驻 seed 数默认 3（Zongmen.MaxSeeds）。
- **持久化**：`db/zongmen.sqlite`（路径解析根目录 = 含 web/index.html 的目录）。

## 关键 protobuf 经验（写新服务时复用）
- **带符号整型字段必须显式 `[ProtoMember(N, DataFormat = ProtoBuf.DataFormat.ZigZag)]`**，否则 protobuf-net 按 int32（两补码 varint 10 字节）写，前端按 sint32（zz 解码）读会全部错号（+1 → -1）。本次涉及的字段：ChunkPayload.Ca/Cb、RegionPack.I/J、RegionInfoDto.Q/R、SettlementDto.Q/R、CommunityPack.Ci/Cj/Q/R、VeinDto.Q/R、TileQuery.Q/R/RegionI/RegionJ。
- **bytes 字段存裸 LE 定宽数组**（cq u8, elev u16, hash u16, neigh u32, pdx/pdy f32）省 varint 开销且客户端 DataView 解码简单；不要把 Float32Array 当 u8 直接 `new Uint8Array(f32.buffer, 0, n)`，会拿到浮点低字节（5.0 → 0x00）！正确做法：逐值 round 后写 u8 数组。
- **TileQuery.WaterD=-1 改用 255 哨兵**，避免 protobuf int32 负值变 10 字节 varint 触发长度限制；客户端逻辑以 255 表示"较远"。

## 已闭合的重要 bug（写新前端管线时引以为戒）
- **中央海域/陆面渲染黑区（2026-09-09 已修复）**：根因是 main.js `pumpChunks`/`pumpExtra` 在 while 循环里用 `var job`/`var k`，并发 fetch 的多个回调共享同一绑定——①上传回调永远用"最后一个 job"的 key，先到响应错挂 key、其余响应被 `chunkData.has()` 挡掉丢弃；②收尾 `chunkBusy.delete(job.key)` 只删最后一个 key，**前两个 chunk 的 busy 标记永久卡死，永不重试**。开机第一屏距相机最近的 chunk(0,0) 被卡死 → 屏幕**中心出现六边形盘面空缺**（半径 15 格，视觉"中央菱形黑区 RGB~5,4,4"= FBO 透明底被后处理提亮的底色），其余 46 块正常。修复：每个请求生命周期抽成独立函数（loadChunk/loadExtra）让 job 被闭包独占 + busy 删除带 gen 守卫 + regenerate() 清 busy 集。**教训：ES5 风格 var + 异步回调 + busy/in-flight 集合，必须逐 job 闭包捕获，否则 starvation 静默发生。**
- **澄清（备忘纠错）**：区块实际 = 半径 CHUNK_SCAN=15 格的六边形盘（721 hex），`CHUNK_S=21` 正确；此前记录的"服务器实际 chunk 32×32=1024 hex、协议口径不一致"是误判，pb.js 的 `ca*chunkS+(cq-16)` 公式与服务端一致且 verify_map 已对 chunk(0,0) 逐点对照全绿。中央黑区与协议无关。

## 验证管线
- `verify/verify_map.mjs`：Node 加载同一份 Engine/js/*.js 作为参考基准 + HTTP 走真实 protobuf 链路 + 浏览器同款 pb.js 解码，逐字段对照（310 项检查全绿）。运行：`"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe" verify/verify_map.mjs`。
- 静态对照点：tiles/neigh/roads/灵脉名等字段必须精确一致；centers/elev/hash/精灵中心/坐标还原均为容差比较（≤1e-3 px / u16 容差）。
- **重启可复用性**：`/api/map/stats` `dbRows > 0` 且重启动后二次请求 proto 解压字节完全一致 → 持久化正确。

## 山河图（index.html + js/）架构（旧 demo 仍可参考的渲染细节）
- 无限流式六边形区块世界：地块直径 16px（HEX_R=8），区块=六边形，中心间距 CHUNK_S=21，四候选最近中心归属（六边形距离），构建扫描半径 CHUNK_SCAN=15。
- **坐标空间铁律**：相机、视野边界、流式需求集、overlay 标注全用 CSS 像素；renderer 的 uRes 必须传 fboW/dpr。GL 与 JS 坐标空间不一致 → 地图边缘黑楔 + 标注错位。
- WebGL2 三遍渲染：Pass1 区块实例化 FBO（uFade 纸色→墨色 0.6s 渐入）；Pass1.5 立体精灵遍（独立 propFbo，alpha 混合，山/雪/林/沙/草丛/灵脉峰超出格子压邻格，y 升序即遮挡序，精灵索引=图集行*8+列，第 5/6/7 行）；Pass2 水墨后处理（底图晕染→精灵合成→海岸墨线→精灵剪影勾边+接地投影→宣纸/暗角）。图集共 8 行。区块生成队列距相机排序，积压>6 每帧 2 个否则 1 个。
- **精灵高度海拔驱动**：prop 实例多传 propElevs（PROP_VS location=4 iElev）；山 40/41/56/57 按 mix(0.55,1.30,(e-0.70)/0.14)、雪 42/43/58/59 按 mix(0.95,1.55,(e-0.84)/0.12) 缩放 H/W。低山疏密：e<0.76 且 hash<0.30 无山精灵。
- **图集 8 行布局**：第 0~3 行 8 群系×4 变体；第 4 行灵脉格底；第 5 行 40/41山 42/43雪 44..47林；第 6 行 48沙 49草丛 50..54灵脉峰；第 7 行 56/57山B 58/59雪B。HEX_FS 图集 uv 必须除 vec2(8.0, 8.0)。
- **海浪静态**（用户明确要求无动画）：main.js overlay 浪线层（z≥1.0，hash 确定性：开阔海面白描长浪线+短回笔，深海 prob 0.30/浅海 0.46；近岸浅海画白沫弧+沫点）；POST_FS 只留静态近岸白沫；HEX_FS 水面波纹也已去 uTime。道路为双色土路（深路缘 rgba(96,78,54,.34)+米黄路面 rgba(233,218,178,.82)，z>2 宽 2.1 否则 1.5）。
- **无贴图模式**（2026-09-07）：已移除 main.js boot 中异步加载 assets/textures/paper.png 的逻辑，全程只用程序化 buildPaper()。项目无任何外部资源引用。
- 页面支持 URL 定点参数：`?seed=&qt=&rt=&zm=&nofade=1`（main.js boot 解析，nofade 供 headless 截图跳过渐入；**capture=1 触发页面内 4s 后合成 glcanvas+overlay → POST /api/debug/snap → 落地 verify/capture.png**，作为 headless 真实渲染的稳定路径）。
- 小地图：132×88 基准画布、每像素 6 世界像素；刷新节流 0.4s/1.5s；显示色由 disp 编号映射图例。
- 内容（灵脉驱动重构后）：灵气场 spiritAt（原点 0,0、半径 1000 格归零）→ 群落晶格 COMM_CL=150 播大灵脉（概率 0.16+0.62*spirit）→ 群内 1大+[0~3]中+[0~7]小 向心聚敛 → 五行相生相克只在群内（SHENG=[2,3,1,4,0]，KE=[1,4,3,0,2]，异灵根 DUAL 雷/风/冰/暗）→ 地形迁就（灵脉中心抬 0.80/0.75/0.70，落水抬成岛）。灵脉格 disp biome 8..12；七星空岛花由 overlay drawVeinFlower 绘制。
- **着色器解码铁律**：HEX_FS biome 解码必须 `floor(vTile/4.0+0.001)`（tile=biome*4+variant）。

## 工具经验
- agent-browser daemon 在本机连单条 screenshot 命令都会被 SIGTERM（已失效），WebGL/Canvas 地图页验证改用 webgl-headless-verify skill：系统 Chrome `--headless=new --user-data-dir=临时目录 --virtual-time-budget=25000 --screenshot=xxx.png`（带 nofade=1），截图用 Read 查看后即删。
- 删除项目内临时文件时 bash rm / cmd del 均可能被 SIGTERM，用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }` 最稳。
- agent-browser screenshot 语法：**位置参数** `screenshot ./x.png`（`--path` 会被当 selector 报 Element not found）；png 大截图常被 SIGTERM，用 `--screenshot-format jpeg --screenshot-quality 85` 更稳；最可靠的页面验证是 **present_files 开 http://localhost:port 内置浏览器预览**（用户偏好此方式）。
- 静态服务：node server.js [port]，demo2 默认 8137（常被 demo3 占用，改 8138）。
- 后端 dev 自测要点：先 `dotnet build Server/Zongmen -v q` 看警告；启动后用 `/api/map/stats` 健康检查；再跑 `verify/verify_map.mjs`；**headless 真实渲染图用 ?capture=1 走页面内自截图钩子（产物 verify/capture.png）**，比 CDP 的 Page.captureScreenshot 更稳——后者在重度 WebGL 渲染下可能挂起。
- 后端进程管理：Bash `netstat -ano | grep LISTEN` 抓不到 PID 是因为 netstat 输出端口在前；改用 `powershell Get-NetTCPConnection -LocalPort 8140 -State Listen | Select -First 1 -ExpandProperty OwningProcess | Stop-Process -Id $_ -Force` 才能稳定停掉 dotnet run 起的子进程。
- CDP 脚本（verify/cdp_screenshot.mjs）健壮性坑：①Node 22 用全局 `WebSocket` (undici EventTarget 风格: onmessage/onopen/onerror + addEventListener)，不要 `import('node:ws')`（ERR_UNKNOWN_BUILTIN_MODULE）。②Chrome 进程 `proc.kill()` 在 Windows 上会留孤儿 Chrome 占着调试端口，下一次启动会因端口冲突挂死；**结束必须 `taskkill /PID <pid> /T /F` 杀进程树**。③调试端口固定 9333 也容易跟残留 Chrome 撞——脚本里用 `9333 + Math.floor(Math.random()*300)` 动态选端口。④加 15s 看门狗 + /json 拉取 15×0.4s 重试避免空等超时。
- **构建命令**：`dotnet build Server/Zongmen/Zongmen.csproj`（必须给 .csproj 文件；拿目录当参数报 MSB1009，只有 `dotnet run --project` 接收目录）。启动后端 = 仓库根直接跑 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe`。
- **本机 curl 探测 127.0.0.1 必须加 `--noproxy "*"`**：否则请求走环境代理，返回 "upstream connect failed / 积极拒绝" 误判服务已死（甚至可能 exit=0）。后端存活判定一律 `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/meta`。
- **run_in_background 的后台进程会被外部终止（用户手动 Stop-Process / 会话清理），特征=日志无异常戛然而止**；判定"被杀"而非崩溃看日志尾部无 exception。PowerShell 工具直出输出常被吞，进程盘点用 CIM 落盘临时文件再 Read。

## 性能热点闭合（2026-09-09 P1~P8，待办清单 review.md 已 ✅ 闭环）
- **`MapWorldService.GetRegionBytes` 必须总是经 JS 生成**（不直读 SQLite 命中），同会话由 `_mem` 缓存兜底。**原因**：P4 把 `tileJson.onRoad` 改为只读 `roadCache`（预算 0，点击零 A*），若区域包从 SQLite 旧行直接命中返回，VM `roadCache` 不热 → `onRoad` 与地图已绘制道路不一致。chunk 端无此问题（其内容纯确定性读、无 VM 共享状态依赖），保留 mem→sqlite 读路径。
- **`verify/verify_map.mjs verifyTile`** 在 `GS.init(seed)` 后、对比 `tileJson` 前，**先模拟客户端流式 3×3 区域包**（`GS.regionJson(ri+d, rj+d)` + HTTP `/api/map/region`），与 P4「只读缓存」语义一致；否则 Node 端 init 清空 roadCache、server 端 VM 仍热，导致 tile(-8,5) of seed=20260909 onRoad 不稳定 FAIL。修复后 3 次连跑全绿。
- **`SqliteVirtualContext`**：每操作短连接（`Pooling=True` + `PRAGMA busy_timeout=8000`），启动时 `PRAGMA journal_mode=WAL`（库级持久，使读/写可并发）。写：原 `SetData` 改为入 `ConcurrentQueue<...>`；后台 `Task.Run(WriterLoopAsync)` 每 250ms `BeginTransaction` 批写，失败退回队列重试不阻塞请求路径。`MapWorldService.Store → SetDataDeferred`；`StatsJson` 与 `Dispose` 前必须 `Flush()`，否则 `dbRows` 滞后。
- **`MemoryVirtualContext`** 加容量上限（默认 8192）：`SetData` 走 `TryAdd` 区分新/旧，仅新项入 `ConcurrentQueue<string> _order`；`_map.Count>cap` 时按入队序逐条 `TryRemove`（残留 entry 用 TryRemove false 容错，不影响语义）。所有条目均确定性可重建，淘汰只损命中率。
- **`SqliteVirtualContext.PruneExcept(seedPrefixes)`** 拼接 `DELETE ... WHERE NOT (Key LIKE $p0 OR $p1 ...)` 仅保留活跃 seed 前缀（`w:<seed sha1_16>:%`）。`MapWorldService.StatsJson` 每 20 次 stats 调用触发一次 prune，活跃 seed 前缀取自 `JsEngineHost.Seeds` 快照（lock 下 ToList 拷贝）。
- **`JsEngineHost`**：`private readonly dynamic _svc = _engine.Script.MapGenServer;` 构造时一次缓存，`Call` 7 个 switch 分支全部走 `_svc.xxx`（避免每次取 Script 属性的 DLR 解析）。`Call("init", seed)` 顺序调到 `_svc` 赋值之后。新增 `public List<string> Seeds { get; }` 快照活跃 seed。
- **`mapgen.js` 缓存**：删 `evictHalf`（超大 Map 半量 delete 一次长停顿），新增 `cacheSet(m,key,val,cap)` 每次插入超 cap 即 `m.delete(m.keys().next().value)` 单条淘汰（摊薄成本）。容量：`ELEV_CAP=40000 / FIELD_CAP=30000 / VEIN_CAP=40000`。新增内部 `elevAtVN(q,r,vn)`；`fields()` 先 `vn=veinNear(q,r)` 一次再传 `elevAtVN`，消除 fields/elevAt 对同格重复扫描。
- **`mapgen-server.js chunkJson` 单段定宽缓冲**：输出 `{ca,cb,count,pn,d:<base64>}`，布局 11nB 地块（cq/cr/tiles u8 + elev/hash u16le + neigh u32le）+ 13pnB 精灵（pdx/pdy f32le + psp u8 + ph/pe u16le），全小端。`MapWorldService.BuildChunk` 用 `Slice(raw,o,len)` 切回 `ChunkPayload`，含长度断言。删除旧 `f32bytes/u16bytes/u32bytes/u8bytes/tileBytes/toU8` 辅助。