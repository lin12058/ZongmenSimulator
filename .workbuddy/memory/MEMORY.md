# 宗门模拟器 demo · 长期备忘（已压缩，详尽过程见 daily logs）

## 一、WebSocket 单块图数据通道（2026-09-09）
- 通道 `/ws/map`，帧 `[1B type][payload]`；Login=1/Tile=2。TileResponse **恒 gzip**，请求上限 1MB，取消异常静默。
- 协议（MapMessages.cs）：TileRequest{op,seed,i,j,mask,seq,lastRevs}；TileResponse{I,J,Mask,Seq,Err,Revs,Chunk,Settles,Pois,Comms + ChunkHas/*Has 显式空标记}。LoginResponse{Ok,Err}。统一块坐标系=方案B（块=chunk格 CHUNK_S=21）。
- 服务：MapWorldService.GetTileBlock(seed,i,j,mask,lastRevs) 编排 chunk/region/comm + BlockRevs 版本表（lastRevs 最小化下发）。rev 未变图层缺省。SettlementDto 扩 Owner/Tier/State。
- 前端：pb.js Writer/encode*/decode*；mapclient.js WS 单块客户端（登录+指数退避+revs 缓存）；main.js loadBlock/applyBlock 单块流式 + settleCells/poiCells 实体缓存驱动标注层。
- 踩坑：① resp.chunk 是原始 protobuf 消息，必须 `PB.chunkToArrays()` 再 uploadChunk；② A* 道路方向会话序依赖（同路冷热 astar 起点不同点列整条相反）—— 按端点 id 归一化方向修复；③ capture=1 截图改为「块数据到达+1.2s」触发（固定 4s 在 headless 真实时间下早于 WS 往返）。

## 二、当前形态：C# 后端 + 前端渲染
- C# Server/Zongmen：.NET 8 + ClearScript.V8 + protobuf-net 3.2.30 + Microsoft.Data.Sqlite 8.0.8。Kestrel 0.0.0.0:8140（appsettings "Zongmen.Port"）。托管 web/ 静态 + /api/map/*（meta/stats/tile/fields/debug）+ /ws/map + /api/debug/snap。
- 前端 web/：index.html + js/{pb,mapclient,textures,renderer,main}.js + 极小 noiselib.js。noise.js/mapgen.js 迁至 Server/Zongmen/Engine/js/；前端无任何地图生成/噪声/寻路逻辑。
- 数据流：JS 沙箱 noise.js+mapgen.js+mapgen-server.js → JSON → C# 装配 protobuf → gzip → SQLite (Data KV) + 内存 LRU；图数据经 /ws/map 单块；tile/fields 仍 HTTP。
- 按区块加载：区块 (seed,ca,cb)、群落 (seed,ci,cj) 持久化 SQLite；**区域包不再落库**（T2：只写不读纯写放大，会话内 `_regionHot` LRU 512 + `_mem` 兜底）；tile/fields 即时计算 + 进程内缓存（fields 纯确定性；tile 按 **roadVer 道路版本号**失效防 onRoad 过期）。

## 三、protobuf 经验（持续命中）
- 带符号整型必须 `[ProtoMember(N, DataFormat=ProtoBuf.DataFormat.ZigZag)]` 否则按 int32 写、按 sint32 读全错号。命中：ChunkPayload.Ca/Cb、RegionPack.I/J、RegionInfoDto.Q/R、SettlementDto.Q/R、CommunityPack.Ci/Cj/Q/R、VeinDto.Q/R、TileQuery.Q/R/RegionI/RegionJ。
- bytes 存裸 LE 定宽数组（cq u8、elev/hash u16、neigh u32、pdx/pdy f32）省 varint。Float32Array 不能 `new Uint8Array(f32.buffer,0,n)`（取低字节 5.0→0x00），必须逐值 round 写 u8。
- TileQuery.WaterD=-1 改用 255 哨兵，避免 int32 负值变 10 字节 varint 触发长度限制。

## 四、已闭合 bug（写新前端管线时引以为戒）
- **中央黑区**（2026-09-09）：main.js `pumpChunks/pumpExtra` while 循环用 `var job`/`var k` 共享闭包 → busy 永久卡死。修复：loadChunk/loadExtra 独立函数闭包独占 + gen 守卫 + regenerate 清 busy。教训：ES5 var + 异步回调 + busy/in-flight 集合，必须逐 job 闭包捕获。
- **propElevs 未上传**（B1）：uploadChunk 精灵段 `for(k=0;k<3)` → `k<4`，iElev(location=4) 漏绑导致山/雪峰高度恒最低档。
- **chunk 失败永久静默**（B2）：HTTP 404 → chunkFail；网络/5xx/超时 → 800ms→30s 指数退避（`chunkRetry` Map + `scheduleChunkRetry`）。
- **seed>80 截断世界碰撞**（B3）：删 `seed[..80]`，完整串作 key（DB 端 `WorldKeys.SeedPrefix` 已是全量 SHA1）。
- **个别色块无贴图（2026-09-09 修复）**：MapClient.onFrame 收到 TileResponse **无条件**写 revs 缓存；若此时 main.loadChunk 因出视野/世界重铸丢弃响应（keepChunk.has=false / gen!=worldSeed），chunkData 不落库而 revs 残留 → 用户回到该块 → `MC.block()` 携带旧 lastRevs → 服务端 `GetTileBlock.Need(0)` 判定 chunk rev 未变 → 缺省下发 → resp.chunk=null → arrays=null → 块永久空白。**修复**（main.js 三处微改）：
  1. `loadChunk` 两处丢弃分支 `if (gen !== worldSeed)` / `if (!keepChunk.has(job.key))` 都 `MC.blockForget(job.key)`，维持不变量「revs 有 ⇒ chunkData 有」。
  2. `applyBlock` 防御：`if (!arrays && !chunkData.has(job.key)) { MC.blockForget(job.key); chunkQueue.push(job); return; }` 兜底历史遗留坏状态 —— 清 rev 后重新入队拉全量。
  - 验证：verify_map.mjs 310 项全绿（服务端语义未改）；capture 截图渲染完整无空白。本会话 CDP 动态竞态往返受 spawn 限制未跑成（headless 直接截图与 cdp_screenshot.mjs 模板均被 SIGTERM；chrome.exe `--headless=new --screenshot` 单次可行）。

## 五、验证管线
- `verify/verify_map.mjs`：Node 加载同份 Engine/js 作为参考基准 + HTTP/WS 走真实 protobuf 链路 + 浏览器同款 pb.js 解码，310 项检查。运行：`node verify/verify_map.mjs`。**已含** rev 最小化（带 lastRevs 全层未变 → 服务端返最小响应）、门禁、12 路并发、tile/fields 二字节一致、新 seed region 落库 0 行/chunk 落 1 行（T2 证实）。
- headless 截图：直接命令 `chrome --headless=new --user-data-dir=全新临时 --virtual-time-budget=20000 --screenshot=out.png 'http://...index.html?seed=42&nofade=1&capture=1'`（页面自截图走 /api/debug/snap → verify/capture.png）。**本会话 spawn 长驻 chrome（CDP）会被 SIGTERM**，静态截图走单次命令 OK。
- `?capture=1` 触发页面内 4s 后合成 glcanvas+overlay → POST /api/debug/snap → verify/capture.png，最可靠 headless 路径。

## 六、山河图（index.html + js/）架构精简
- 流式六边形：HEX_R=8，CHUNK_S=21，CHUNK_SCAN=15，视野扫描盘 721 格。
- **坐标空间铁律**：相机/视野/流式/overlay 标注全用 CSS 像素；renderer uRes = fboW/dpr。GL 与 JS 不一致 → 边缘黑楔。
- WebGL2 三遍：Pass1 块实例化 FBO（fade 0.6s）+ Pass1.2 道路（halo+core）+ Pass1.5 立体精灵 propFbo（α 混合、y 升序遮挡）+ Pass2 后处理（晕染/海岸墨线/精灵剪影/接地投影/宣纸/暗角）。图集 8 行（0-3 群系 4 变体 / 4 灵脉格底 / 5-7 精灵）。
- 着色器铁律：HEX_FS biome 解码 `floor(vTile/4.0+0.001)`；HEX_FS 图集 uv 除 `vec2(8.0,8.0)`；PROP_VS location=4 iElev；山 40/41/56/57、雪 42/43/58/59 按海拔 mix 缩放。
- 渲染粗剔除（R7）：uploadChunk 存 bbox，render `_viewBox(cam)+boxHits` AABB，Pass1 pad=hexR*2.2，Pass1.5 pad=hexR*12。
- 灵脉：spiritAt 半径 1000 归零 → COMM_CL=150 晶格 → 群内 1大+[0-3]中+[0-7]小聚敛 → 五行相生 SHENG=[2,3,1,4,0]、相克 KE=[1,4,3,0,2] + 异灵根（雷/风/冰/暗）→ 抬升 LIFT_CORE=[0.80,0.75,0.70]。灵脉格 biome 8..12。
- 异步回填校验（R4）：模块级 `keepChunk/keepR/keepC` Set；loadChunk/loadExtra 回调前 `keep*.has(key)`；regenerate 重置。
- 静态层节流（R1）：markStaticDirty 200ms 合并；forceStaticDirty 强制。tile 防抖（R5）：150ms。DEBUG 句柄（R10）：`if (DEBUG)` 包裹 `window.__cam/__renderer/__data`；debug=1/capture=1 开启。

## 七、review.md T0~T15 修复架构（2026-09-09 全部已落地+验证）
- **roadVer 机制（T4 核心）**：mapgen.js `roadsNear` 每新增一条 A* 道路 `roadVer++`（init/configure 归零）；`JsWorldVm.RoadVersion()` 透出；MapWorldService tile 缓存条目 = (Gz, RoadVer)，`entry.RoadVer == vm.RoadVersion()` 才算新鲜。**只有真有新路落成才失效 tile 缓存**。
- **缓存容量（T1）**：mapgen.js REGION_CAP=512/SETTLE_CAP=1024/COMM_CAP=1024/ROAD_CAP=4096/ROADFAIL_CAP=1024，走 cacheSet + setAdd（淘汰只损命中不改确定性）。
- **Storage/LruCache.cs（T11）**：lock+Dictionary+LinkedList 线程安全 LRU（tile/grid/_regionHot 三缓存全用）；MemoryVirtualContext 同款（T8），SQLite 命中经 ReadSqlBackfill 回填 _mem。
- **SQLite（T3/T5）**：Flush/Prune 持 _flushLock；移入 MapWorldService MaintenanceLoopAsync（2min）；StatsJson 只 Flush。
- **buildChunk 两遍扫描（T6）**：先 R+1 灌 grid，二维数组自取 → 消除 7 次拼 key+Map.get；纯重排输出与单遍一致。
- **前端（T7/T9/T10）**：main.js roadsDirty 路网几何缓存（region 到达/regenerate 置脏；不做逐路视野裁剪）；drawChunkWaves 概率筛前置（~70% 深水免 3 浮点哈希）；renderer.js 顶部 ATLAS_ROWS=8 唯一常量字符串拼接注入 + setTextures 宽高比断言；window.onerror 只 console.error（T10）。
- **其他**：MaxSeeds 3→4（T13）；EvictLocked 线性扫（T12）；b64FromBytes 注释+textures.js 头注释 7→8 行（T14）；propPad=hexR*12 保留。

## 八、工具经验
- 静态服务/截图：节点服务被 run_in_background 起的进程会被外部终止（特征=日志戛然而止）。停旧后端：`Get-Process -Name Zongmen | Stop-Process -Force`。**Get-NetTCPConnection 输出在本机不稳定**（监听存在也可能空）；端口/进程判定一律 `netstat -ano | grep :8140 | grep LISTEN` + `tasklist | grep -i zongmen` 双确认。
- 清理临时文件用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }`（bash rm / cmd del 会被 SIGTERM）。
- agent-browser screenshot 本机 SIGTERM 失效；chrome 长驻 spawn 也 SIGTERM。WebGL 截图走 headless 单次命令（`--headless=new --screenshot` 直接落 png）或 `?capture=1` 页面内自截图，最可靠。
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj；目录报 MSB1009）。`dotnet run --project` 接受目录。启动后端= 根根 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe`。
- 本机 curl 127.0.0.1 必须 `--noproxy "*"`，否则代理报"upstream connect failed"。后端存活= `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`。
- CDP 脚本：Node 22 全局 WebSocket（undici）— 不要 `import('node:ws')`。Chrome 进程必须 `taskkill /PID <pid> /T /F` 杀进程树；动态端口防残留；15s 看门狗 + /json 15×0.4s 重试。**注意**：本会话 CDP 长驻 spawn 仍 SIGTERM，仅静态截图路径稳定。

## 九、性能/一致性关键点
- `GetRegionBytes` 总是经 JS 生成（不直读 SQLite 旧行）—— 保持 VM roadCache 热，与 tileJson.onRoad 语义一致；同会话 _mem 命中免重复生成。
- verify_map 的 verifyTile 在 init 后先模拟客户端流式 3×3 区域包，与 P4「只读缓存」对齐。
- SqliteVirtualContext WAL + 每操作短连接 + 批量异步落库（WriterLoopAsync 250ms）；MemoryVirtualContext cap 8192 + 访问序 LRU（T8）。
- JsEngineHost：构造一次缓存 `dynamic _svc`；Call 7 分支走 `_svc.xxx` 免 DLR 解析。
- mapgen.js 缓存：cacheSet(m,key,val,cap) 插入即超 cap 删最旧单条；ELEV_CAP=40000/FIELD_CAP=30000/VEIN_CAP=40000。elevAtVN 复用 fields veinNear。
- chunkJson 单段定宽缓冲（11nB 地块 + 13pnB 精灵，全小端）；BuildChunk Slice 切回。
- R8/R9：tile/fieldGrid 内存 LRU；tile 缓存带 roadVer 失效；chunk/region/comm per-key in-flight 去重（_buildGates lock + double-check + TryRemove）。
- R2：StaticWebMiddleware ETag/Last-Modified + 文件内存缓存（mtime 变即刷新）；R6 ApiRateLimitMiddleware 仅对 tile/fields 5s/120/IP。
- R3：buildChunk 携带 qrel/rrel 整数偏移；chunkJson 直接 dv.setUint8 不做浮点反解。
- R11：configure() 清全部 region/settle/road/roadFail 缓存。R12：CONC_CHUNK/CONC_EXTRA/CHUNK_RETRY_* 收敛 NET_CFG。R13：buildAtlas/buildPaper/buildNoise 各自重置 trng 去 boot 顺序耦合。