# 宗门模拟器 demo3 · 项目长期备忘

## WebSocket 单块接口（2026-09-09 下午落地，当前图数据通道）
- **通道**：`/ws/map`，帧格式 `[type][payload]`；类型 Login=1/Tile=2/Ping=3/Pong=4。登录门禁（guest 任意 token 放行）；TileResponse **恒 gzip**（消除压缩阈值歧义）；请求上限 1MB；取消异常静默。
- **协议**（MapMessages.cs）：TileRequest{op,seed,i,j,mask,seq,lastRevs}；TileResponse{I,J,Mask,Seq,Err,Revs,Chunk,Settles,Pois,Comms + ChunkHas/SettlesHas/PoisHas/CommsHas 显式空标记}；LoginResponse{Ok,Err}。统一块坐标系=方案B：块=chunk 格(CHUNK_S=21)，region/comm 仅生成时逻辑层，`blockLayersJson(ca,cb)` 是块→覆盖 region/comm 格的权威映射。
- **服务**：MapWorldService.GetTileBlock(seed,i,j,mask,lastRevs) 编排（chunk+region 实体按块裁剪+comm 原样）+ BlockRevs 版本表（lastRevs 最小化下发，rev 未变的图层子消息缺省）。SettlementDto 扩 Owner/Tier/State。
- **前端**：pb.js 增 Writer/encodeTileRequest/encodeLogin/decodeTileResponse/decodeLoginResponse；mapclient.js=WS 单块客户端（登录+重连指数退避+rev 缓存）；main.js=loadBlock/applyBlock 单块流式 + settleCells/poiCells 实体缓存驱动标注层/stats。HTTP chunk/region/comm 端点已删除；meta/stats/tile/fields/debug 保留。
- **踩坑**：① resp.chunk 是原始 protobuf 消息，必须先 `PB.chunkToArrays()` 再 uploadChunk；② **A* 道路方向会话序依赖**——同一条路冷热缓存 astar 起点不同点列整条相反，已按端点 id 归一化方向修复；③ capture=1 截图改为「块数据到达+1.2s」触发（固定 4s 在 headless 真实时间下早于 WS 往返）。
- **验证**：verify_map.mjs 已重写为 ws 单块对照（登录门禁/mask 过滤/rev 最小化/同块确定性/tile HTTP 对照），全部通过；headless 截图渲染正常。

## 当前形态（2026-09-09）：C# 后端 + 前端渲染
- **C# Server/Zongmen**：.NET 8 + ClearScript.V8 + protobuf-net 3.2.30 + Microsoft.Data.Sqlite 8.0.8。Kestrel 默认 0.0.0.0:8140（appsettings "Zongmen.Port"）。单进程托管 web/ 静态 + /api/map/*（meta/stats/tile/fields/debug）+ /ws/map + /api/debug/snap。
- **前端 web/**：index.html + js/{pb, mapclient, textures, renderer, main}.js + 极小 noiselib.js。noise.js / mapgen.js 已迁至 Server/Zongmen/Engine/js/；前端无任何地图生成/噪声/寻路逻辑。
- **数据流**：JS 沙箱执行 noise.js+mapgen.js+mapgen-server.js → JSON → C# 装配 protobuf → gzip → SQLite (Data KV) + 内存 LRU；图数据经 /ws/map 单块下发；tile/fields 仍 HTTP（gzip protobuf / JSON）。
- **按区块加载**：区块 (seed,ca,cb)、群落 (seed,ci,cj) 持久化 SQLite；**区域包不再落库**（T2：只写不读纯写放大，会话内 `_regionHot` LRU 512 + `_mem` 兜底，重启后区域首访重走 JS 生成）；tile/fields 即时计算 + 进程内缓存（fields 纯确定性；tile 按 **roadVer 道路版本号**失效防 onRoad 过期）。

## 关键 protobuf 经验
- 带符号整型字段必须显式 `[ProtoMember(N, DataFormat = ProtoBuf.DataFormat.ZigZag)]`，否则按 int32 (10 字节 varint) 写，前端按 sint32 (zz) 读会全部错号。命中字段：ChunkPayload.Ca/Cb、RegionPack.I/J、RegionInfoDto.Q/R、SettlementDto.Q/R、CommunityPack.Ci/Cj/Q/R、VeinDto.Q/R、TileQuery.Q/R/RegionI/RegionJ。
- bytes 存裸 LE 定宽数组（cq u8, elev/hash u16, neigh u32, pdx/pdy f32）省 varint；Float32Array 不能 `new Uint8Array(f32.buffer,0,n)`（会取低字节 5.0→0x00），必须逐值 round 后写 u8。
- TileQuery.WaterD=-1 改用 255 哨兵，避免 int32 负值变 10 字节 varint 触发长度限制。

## 已闭合 bug（写新前端管线时引以为戒）
- **中央黑区**（2026-09-09）：main.js `pumpChunks/pumpExtra` while 循环用 `var job`/`var k` 共享闭包——并发回调永远用最后一个 job 的 key，busy 只删最后一个 key，**前几个 chunk 的 busy 永久卡死、永不重试**。修复：loadChunk/loadExtra 独立函数闭包独占 + gen 守卫 + regenerate 清 busy。**教训**：ES5 var + 异步回调 + busy/in-flight 集合，必须逐 job 闭包捕获。
- **propElevs 未上传**（B1，2026-09-09）：uploadChunk 精灵段 `for(k=0;k<3)` → `k<4`，iElev(location=4) 漏绑导致山/雪峰高度恒为最低档。
- **chunk 失败永久静默**（B2）：HTTP 404 → chunkFail（确定放弃）；网络/5xx/超时 → 800ms→30s 指数退避自动重试（`chunkRetry` Map + `scheduleChunkRetry`）。
- **seed>80 截断世界碰撞**（B3）：删 `seed[..80]`，完整串作 key（DB 端 `WorldKeys.SeedPrefix` 已是全量 SHA1）。

## 验证管线
- `verify/verify_map.mjs`：Node 加载同份 Engine/js 作为参考基准 + HTTP 走真实 protobuf 链路 + 浏览器同款 pb.js 解码，310 项检查全绿。运行：`node verify/verify_map.mjs`。
- 静态对照点：tiles/neigh/roads/灵脉名精确一致；centers/elev/hash/精灵容差。`相对坐标还原 ≤1e-3px` 用 `ca*S+(cq-16)` 反推。
- 专项验证（2026-09-09）：region/tile 二次请求字节一致；12 路并发同 key 全 200 无死锁；新 seed region 落库 0 条/chunk 落 1 条（T2 证实）；headless `?capture=1` 渲染正常。Chrome 在 `~/AppData/Local/Google/Chrome/Application/chrome.exe`。
- `?capture=1` 触发页面内 4s 后合成 glcanvas+overlay → POST /api/debug/snap → verify/capture.png，作为 headless 真实渲染稳定路径。

## 山河图（index.html + js/）架构
- 流式六边形世界：HEX_R=8，区块中心间距 CHUNK_S=21，扫描半径 CHUNK_SCAN=15（721 hex 六边形盘），CHUNK_SCAN+CHUNK_S 用于 include 邻接。
- **坐标空间铁律**：相机/视野/流式需求/overlay 标注全用 CSS 像素；renderer uRes = fboW/dpr。GL 与 JS 坐标空间不一致 → 边缘黑楔。
- WebGL2 三遍渲染：Pass1 区块实例化 FBO（fade 0.6s 渐入）+ Pass1.2 道路（halo + core 两种 quad）+ Pass1.5 立体精灵独立 propFbo（α 混合、y 升序遮挡）+ Pass2 后处理（晕染外渗/海岸墨线/精灵剪影/接地投影/宣纸/暗角）。图集 8 行，第 0-3 群系 4 变体，第 4 灵脉格底，第 5/6/7 立体精灵。
- 精灵高度海拔驱动：PROP_VS location=4 iElev；山 40/41/56/57 `mix(0.55,1.30,(e-0.70)/0.14)`、雪 42/43/58/59 `mix(0.95,1.55,(e-0.84)/0.12)` 缩放 H/W。
- 着色器解码铁律：HEX_FS biome 解码 `floor(vTile/4.0+0.001)`（tile=biome*4+variant）；HEX_FS 图集 uv 必须除 `vec2(8.0,8.0)`。
- 渲染粗剔除（R7）：uploadChunk 存 bbox，render 用 `_viewBox(cam) + boxHits` AABB 相交测试；Pass1 pad=hexR*2.2，Pass1.5 pad=hexR*12。
- 海浪静态无动画：main.js overlay 浪线层（hash 确定性：近岸白沫弧+沫点，深海 prob 0.30/浅海 0.46）；道路双色土路（深路缘+米黄路面，z>2 宽 2.1）。无贴图模式（buildPaper/buildNoise/buildAtlas 全程序化）。
- 灵脉驱动：spiritAt 半径 1000 格归零 → COMM_CL=150 群落晶格 → 群内 1大+[0~3]中+[0~7]小向心聚敛 → 五行相生相克（SHENG=[2,3,1,4,0], KE=[1,4,3,0,2]）+ 异灵根（DUAL 雷/风/冰/暗）→ 灵脉抬升（LIFT_CORE=[0.80,0.75,0.70]）。灵脉格 disp biome 8..12。
- 异步回填校验（R4）：模块级 `keepChunk/keepR/keepC` Set；loadChunk/loadExtra 回调前 `keep*.has(key)` 校验；regenerate 重置。
- tile 防抖（R5）：150ms 节流，hideInfo 清 timer。
- 静态层节流（R1）：markStaticDirty 200ms 合并；forceStaticDirty 强制（卸载/重铸）。
- 调试句柄（R10）：`if (DEBUG)` 包裹 `window.__cam/__renderer/__data`；DEBUG 由 URL `debug=1` 或 `capture=1` 开启。

## review.md T0~T15 修复架构（2026-09-09 下午，全部已落地+验证）
- **roadVer 机制（T4 核心）**：mapgen.js `roadsNear` 每新增一条 A* 道路 `roadVer++`（init/configure 归零）；`JsWorldVm.RoadVersion()` 透出；MapWorldService tile 缓存条目 = (Gz, RoadVer)，`entry.RoadVer == vm.RoadVersion()` 才算新鲜。**只有真有新路落成才失效 tile 缓存**——区域包缓存命中不再整片作废 tile（旧 `_regionEpoch` 按 seed 全局失效已删除）。
- **缓存容量（T1）**：mapgen.js REGION_CAP=512 / SETTLE_CAP=1024 / COMM_CAP=1024 / ROAD_CAP=4096 / ROADFAIL_CAP=1024，走 `cacheSet` + 新增 `setAdd`（Set 版）。淘汰只损失命中率不改确定性输出。
- **Storage/LruCache.cs（T11）**：lock + Dictionary + LinkedList 线程安全 LRU（命中提序、超限删单条）；tile/grid/_regionHot 三缓存全用它。MemoryVirtualContext 同款 LRU 化（T8），SQLite 命中经 `ReadSqlBackfill` 回填 `_mem`。
- **SQLite（T3/T5）**：Flush 出队+写库+回退全程持 `_flushLock`；PruneExcept 同锁；Flush+Prune 移入 MapWorldService `MaintenanceLoopAsync`（每 2 分钟），StatsJson 只 Flush。实测 prune 把 dbRows 4278→307。
- **buildChunk 两遍扫描（T6）**：先 R+1 扫描盘 fields() 灌二维数组 grid，第二遍 `grid[(dq+R1)*W2+(dr+R1)]` 数组取自身/6 邻居场——消除逐格 7 次字符串拼 key+Map.get；纯重排，输出与单遍一致（verify 全绿佐证）。
- **前端（T7/T9/T10）**：main.js `roadsDirty` 路网几何缓存（region 到达/regenerate 置脏；**重建不做逐路视野裁剪**——regionCells 随视野卸载，按重建时刻裁剪会致平移后远路缺失）；drawChunkWaves 概率筛前置（近岸判定+出线概率先算，~70% 深水格免 3 浮点哈希）。renderer.js 顶部 `ATLAS_ROWS=8` 唯一常量字符串拼接注入 HEX_FS/PROP_FS + setTextures 构建期断言（图集宽高比推行数不符即抛错）。window.onerror 只 console.error。
- **其他**：MaxSeeds 默认 3→4（T13）；EvictLocked 线性扫（T12）；b64FromBytes 注释修正、textures.js 头注释 7行→8行（T14）；`propPad=hexR*12` 经核算保留（聚类偏移 36px + 精灵最高 ~8uR，12uR 合理）。

## 工具经验
- 静态服务/截图：节点服务被 run_in_background 起的进程会被外部终止（用户 Stop / 会话清理），特征=日志无异常戛然而止。停旧后端：`Get-Process -Name Zongmen | Stop-Process -Force`（按进程名比按端口稳）。**注意（2026-09-09 实测）：本机 Get-NetTCPConnection 输出不稳定——监听存在时也可能返回空，勿以它的空输出判定"端口已释放"；端口/进程判定一律用 `netstat -ano | grep :8140 | grep LISTEN` + `tasklist | grep -i zongmen` 双确认。**
- 清理临时文件用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }`（bash rm / cmd del 都会被 SIGTERM）。
- agent-browser screenshot 在本机 SIGTERM 失效。WebGL 截图走 headless Chrome `--headless=new --user-data-dir=临时 --virtual-time-budget=25000 --screenshot=xxx.png`（带 nofade=1）→ Read 查看。最可靠还是 `?capture=1` 页面内自截图或 `present_files` 内置浏览器。
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj；拿目录报 MSB1009）。`dotnet run --project` 接受目录。启动后端 = 仓库根直接跑 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe`。
- 本机 curl 127.0.0.1 必须 `--noproxy "*"`，否则环境代理报 "upstream connect failed" 误判服务死。后端存活判定 = `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`。
- CDP 脚本：Node 22 全局 `WebSocket` (undici EventTarget 风格) — 不要 `import('node:ws')`。Chrome 进程必须 `taskkill /PID <pid> /T /F` 杀进程树；动态端口 `9333 + Math.floor(Math.random()*300)` 防残留；15s 看门狗 + /json 15×0.4s 重试。
- PowerShell 直出输出常被吞，进程盘点用 CIM 落盘临时文件再 Read。

## 性能/一致性关键点（2026-09-09 收尾时已应用）
- `GetRegionBytes` 总是经 JS 生成（不直读 SQLite 旧行）— 保持 VM roadCache 热，与 tileJson.onRoad 语义一致；同会话 `_mem` 命中免重复生成。
- verify_map 的 verifyTile 在 init 后先模拟客户端流式 3×3 区域包，与 P4「只读缓存」对齐。
- SqliteVirtualContext WAL + 每操作短连接 + 批量异步落库（WriterLoopAsync 250ms）；MemoryVirtualContext cap 8192 + 访问序 LRU（T8 改造）。
- JsEngineHost：构造时一次缓存 `dynamic _svc`；Call 7 分支走 `_svc.xxx`（免 DLR 解析）。
- mapgen.js 缓存：`cacheSet(m,key,val,cap)` 插入即超 cap 删最旧单条；ELEV_CAP=40000/FIELD_CAP=30000/VEIN_CAP=40000。`elevAtVN(q,r,vn)` 复用 fields 的 `veinNear`。
- chunkJson 单段定宽缓冲（11nB 地块 + 13pnB 精灵，全小端）；BuildChunk 用 `Slice(raw,o,len)` 切回。
- R8/R9：tile/fieldGrid 内存 LRU；tile 缓存带 **roadVer** 失效（原 region epoch 已废弃，见 review 修复架构节）；chunk/region/comm per-key in-flight 去重（`_buildGates` lock + double-check + TryRemove）。
- R2：StaticWebMiddleware ETag/Last-Modified + 文件内存缓存（mtime 变即刷新）；R6 ApiRateLimitMiddleware 仅对 tile/fields 5s/120/IP。
- R3：buildChunk 携带 qrel/rrel 整数偏移；chunkJson 直接 `dv.setUint8(oCq+i, qrel[i]+16)` 不做浮点反解。
- R11：configure() 清全部 region/settle/road/roadFail 缓存。
- R12：CONC_CHUNK/CONC_EXTRA/CHUNK_RETRY_* 收敛 NET_CFG；mapgen.js warmRoadsStep/warmIdx 死代码清理。
- R13：buildAtlas/buildPaper/buildNoise 各自显式重置 `trng = NL.mulberry32(SEED_*)`，去 boot 顺序隐式耦合。
