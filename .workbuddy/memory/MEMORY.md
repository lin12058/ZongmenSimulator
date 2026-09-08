# 宗门模拟器 demo3 · 项目长期备忘

## 当前形态（2026-09-09）：C# 后端 + 前端渲染
- **C# Server/Zongmen**：.NET 8 + ClearScript.V8 + protobuf-net 3.2.30 + Microsoft.Data.Sqlite 8.0.8。Kestrel 默认 0.0.0.0:8140（appsettings "Zongmen.Port"）。单进程托管 web/ 静态 + /api/map/* + /api/debug/snap。
- **前端 web/**：index.html + js/{pb, mapclient, textures, renderer, main}.js + 极小 noiselib.js。noise.js / mapgen.js 已迁至 Server/Zongmen/Engine/js/；前端无任何地图生成/噪声/寻路逻辑。
- **数据流**：JS 沙箱执行 noise.js+mapgen.js+mapgen-server.js → JSON → C# 装配 protobuf → gzip → SQLite (Data KV) + 内存 LRU；HTTP `Content-Encoding:gzip` 下发；前端 fetch 透明解压 → Float32Array 还原绝对坐标。
- **按区块加载**：区块 (seed,ca,cb)、区域 (seed,i,j)、群落 (seed,ci,cj) 全部持久化；tile/fields 即时计算 + 进程内 LRU 缓存（fields 纯确定性；tile 按 region epoch 失效防 onRoad 过期）。

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
- `verify/probe_r8r9.mjs` / `probe_r2r6r3.mjs`：专项 R8/R9 缓存与 R2/R6/R3 探测。
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

## 工具经验
- 静态服务/截图：节点服务被 run_in_background 起的进程会被外部终止（用户 Stop / 会话清理），特征=日志无异常戛然而止。停旧后端：`Get-NetTCPConnection -LocalPort 8140 -State Listen | Select -First 1 -ExpandProperty OwningProcess | Stop-Process -Force`。
- 清理临时文件用 PowerShell `Get-ChildItem | ForEach-Object { $_.Delete() }`（bash rm / cmd del 都会被 SIGTERM）。
- agent-browser screenshot 在本机 SIGTERM 失效。WebGL 截图走 headless Chrome `--headless=new --user-data-dir=临时 --virtual-time-budget=25000 --screenshot=xxx.png`（带 nofade=1）→ Read 查看。最可靠还是 `?capture=1` 页面内自截图或 `present_files` 内置浏览器。
- `dotnet build Server/Zongmen/Zongmen.csproj`（必须 .csproj；拿目录报 MSB1009）。`dotnet run --project` 接受目录。启动后端 = 仓库根直接跑 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe`。
- 本机 curl 127.0.0.1 必须 `--noproxy "*"`，否则环境代理报 "upstream connect failed" 误判服务死。后端存活判定 = `curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`。
- CDP 脚本：Node 22 全局 `WebSocket` (undici EventTarget 风格) — 不要 `import('node:ws')`。Chrome 进程必须 `taskkill /PID <pid> /T /F` 杀进程树；动态端口 `9333 + Math.floor(Math.random()*300)` 防残留；15s 看门狗 + /json 15×0.4s 重试。
- PowerShell 直出输出常被吞，进程盘点用 CIM 落盘临时文件再 Read。

## 性能/一致性关键点（2026-09-09 收尾时已应用）
- `GetRegionBytes` 总是经 JS 生成（不直读 SQLite 旧行）— 保持 VM roadCache 热，与 tileJson.onRoad 语义一致；同会话 `_mem` 命中免重复生成。
- verify_map 的 verifyTile 在 init 后先模拟客户端流式 3×3 区域包，与 P4「只读缓存」对齐。
- SqliteVirtualContext WAL + 每操作短连接 + 批量异步落库（WriterLoopAsync 250ms）；MemoryVirtualContext cap 8192 + 插入序 FIFO。
- JsEngineHost：构造时一次缓存 `dynamic _svc`；Call 7 分支走 `_svc.xxx`（免 DLR 解析）。
- mapgen.js 缓存：`cacheSet(m,key,val,cap)` 插入即超 cap 删最旧单条；ELEV_CAP=40000/FIELD_CAP=30000/VEIN_CAP=40000。`elevAtVN(q,r,vn)` 复用 fields 的 `veinNear`。
- chunkJson 单段定宽缓冲（11nB 地块 + 13pnB 精灵，全小端）；BuildChunk 用 `Slice(raw,o,len)` 切回。
- R8/R9：tile/fieldGrid 内存 LRU；tile 缓存带 region epoch 失效；chunk/region/comm per-key in-flight 去重（`_buildGates` lock + double-check + TryRemove）。
- R2：StaticWebMiddleware ETag/Last-Modified + 文件内存缓存（mtime 变即刷新）；R6 ApiRateLimitMiddleware 仅对 tile/fields 5s/120/IP。
- R3：buildChunk 携带 qrel/rrel 整数偏移；chunkJson 直接 `dv.setUint8(oCq+i, qrel[i]+16)` 不做浮点反解。
- R11：configure() 清全部 region/settle/road/roadFail 缓存。
- R12：CONC_CHUNK/CONC_EXTRA/CHUNK_RETRY_* 收敛 NET_CFG；mapgen.js warmRoadsStep/warmIdx 死代码清理。
- R13：buildAtlas/buildPaper/buildNoise 各自显式重置 `trng = NL.mulberry32(SEED_*)`，去 boot 顺序隐式耦合。
