# 代码审核记录 review_v1

> 审核对象：最后一次提交（HEAD=886675f）Server/Zongmen（C# .NET8 后端）＋ web/js（前端）＋ verify。
> 审核侧重：**性能热点** + **潜在 bug**，按严重程度排序。本文为完整清单，覆盖前端/后端/验证链路。

---

## 一、正确性 Bug（高危）

### 1.1 LRU 淘汰与"在途 JS 调用"并发竞态（P0）· JsEngineHost.cs
- `GetOrCreate` 持 `_lock` 内发现超员，`EvictLocked` 直接对最旧 `JsWorldVm.Dispose()` → `_engine.Dispose()`。
- 但 `Call()` 走的是 `JsWorldVm._gate`（SemaphoreSlim），**不持有** `_lock`。若被淘汰的 vm 恰好另一线程正在 `Call`，Dispose 正在执行的 V8 引擎会造成 JS 崩溃/不确定结果。
- 修复：淘汰前以 `Interlocked.CompareExchange` 标记"待回收"；由调用方在自己结束 call（Release 后）检查标记并自清理，或在 vm 空闲时再 Dispose。

### 1.2 chunk 请求一次失败即永久沉默（P0）· main.js `loadChunk`/`chunkFail`
- `catch` 里 `chunkFail.add(key)`，之后 `updateStreaming` 不再重试，本会话该区块永远空洞。
- 需区分「确定错误(404)」与「可重试(网络抖动/5xx/超时)」；可重试应当指数退避后回来，而不是一棒子打死。目前仅 `regenerate()` 可清空。

### 1.3 seed 超过 80 字符被截断 → 世界碰撞（P2）· JsEngineHost.cs
- `seed = seed.Length > 80 ? seed[..80] : seed;` 两个 80 字符后不同的种子会共享同一世界（LRU 命中错世界）。
- 修复：用完整字符串做 Map key，或用哈希（SHA1）作 key，勿截断。

### 1.4 `propMound` 附近无守卫 `trng`？（已核对）· textures.js 654-655 行
- 逐字节核查：声明 `var trng` 与调用 `trng()` 均为 `t-r-n-g`（0x74 0x72 0x6e 0x67），**非 typo**。此处撤销初判，无 bug。

### 1.5 `StaticWebMiddleware` 越界目录防护可被穿透（P2）
- `Path.Combine(_root, rel)` + `full.StartsWith(_root)` 判断。若请求路径含 URL 编码 `%2e%2e`，`Path.GetFullPath` 会解析出上级目录；只要 `full` 仍以 `_root` 开头则通过，但若目标是 `_root` 的同级目录且恰好以同一前缀起名（如请求 /../ZongmenX 且其父与 _root 前缀一致）风险有限；真实风险来自 `req.Path` 未先规范化，`..` 段被 Kestrel 一般已拦。低危但建议用 `Path.GetRelativePath` 校验无 `..` 前缀。

---

## 二、性能热点

### 2.1 服务端 chunk 数据走「JSON + base64」中转（P1）· mapgen-server.js + MapWorldService.cs
- 现状：JS 端把每个 byte 数组 `b64FromBytes` 变 base64 字符串 → `JSON.stringify` → C# `Parse` → 再 `Convert.FromBase64String` → 再 protobuf → gzip。
- base64 使字节体积膨胀 **33%**，JSON 序列化 + 双转码 + JS 字符串大对象分配，是每次生成 chunk 最主要的 CPU/GC 开销。
- 建议：C#↔JS 若可行改为**字节数组直传**（ClearScript 支持将 `byte[]` 传入 JS 侧直接返回，或通过宿主对象），省去 base64+JSON。若无法直传，至少把数量巨大、已定宽的 `cq/cr/tiles/elev/hash/neigh/pdx/...` 合并为**一段定宽缓冲** base64，减少 JSON 键的数量。

### 2.2 单格详情 `tileJson` 的 onRoad 判定是高频热点（P1）· mapgen-server.js `tileJson`
- 每次点击网格（信息面板）都会执行：
  - 去水距离 4 环逐环 `elevAt(q,r)` 扫描；
  - `onRoad` 对 3×3 每个区域格都 `MG.roadsNear(ci+cj, 9999)`（无预算上限的全量 A*）。
- 若用户快速点击/连点，会连续触发全量道路重算，卡顿明显。`roadsNear` 虽有缓存但第一个区域第一次访问仍是全量。
- 建议：`tileJson` 的 onRoad 判定改为**只查已缓存道路的 tiles 集合**，避免触发新 A*；或在首次访问某区域时只预算少量路径。

### 2.3 `updateStreaming` 每帧全量重建需求集（P1）· main.js
- 主循环每帧调用 `updateStreaming()`：`viewBounds`→`tileBoundsOf`（4 角取 min/max）→三层扫格 + `chunkData.forEach` 全量卸载判定 + `chunkQueue.sort`。
- 相机静止时全部冗余。已有 `staticNeedsRedraw` 的相机位移阈值思路可复用。
- 建议：仅当相机移动超过某像素阈值（如 `scale = 18/(zoom*0.75+0.25)`）才触发重算；队列为空时跳过 `pumpChunks`。

### 2.4 浪线邻域解码每格 6 次 `Math.pow(8,k)`（P1）· main.js `drawChunkWaves`
- `Math.floor(nv / Math.pow(8, wn)) % 8`，对每个已加载海洋 tile × 6 邻居。浮点 pow 昂贵。
- 建议：换成查表 `[1,8,64,512,4096,32768]` 与位运算 `(neigh >> (3*wn)) & 7`。mapgen.js `packNeigh` 的 pow 同理。

### 2.4 高程/字段缓存淘汰阈值过大（P2）· mapgen.js `elevAt`/`fields`
- `size > 150000/200000` 才 `evictHalf`，长期探索内存线性膨胀，且 evictHalf 在超大 Map 上一次 delete 是长停顿。
- 建议：固定容量（如 1 万）+ FIFO 或时间戳惰性淘汰；evict 分批/异步执行。

### 2.5 静态文件整读、无缓存头（P3）· StaticWebMiddleware.cs
- 每次 `File.ReadAllBytesAsync` 全读 + `Cache-Control: no-cache`，无 ETag/304。
- 建议：小文件内存缓存 + `Last-Modified`/ETag。

---

## 三、一致性 / 健壮性

### 3.1 服务端反解圆心浮点取整歧义（P2）· mapgen-server.js `chunkJson`
- 存储相对偏移时先 `Math.round(fy/(1.5*HEX_R))` 反解 r，再反解 q，浮点累计后在大坐标处可能差一格。客户端正向公式 `ca*S+(cq[i]-16)`。
- 建议：服务端直接按轴坐标 (q,r) 存整数偏移，不做浮点反解。

### 3.2 `regionCells`/`commCells` 卸载后回调仍可能回填（P2）· main.js
- `loadExtra` 回调 `regionCells.set` 无「该格是否仍在需要窗口」判断，可能在格子刚出视野后把数据塞回，造成短暂内存残留 + 与卸载冲突。
- 建议回调前校验 `keepR.has(key)`。

### 3.3 静态层 dirty 粒度太粗（P3）· main.js
- `staticDirty = true` 在每个 chunk 上传成功后无条件置位；连续加载 N 个 chunk → 静态层重绘 N 次。
- 建议：合并 dirty（200ms 节流）或记账待重绘区域。

### 3.4 全局调试句柄残留（P4）· main.js 950-952 行
- `window.__cam/__renderer/__data` 无条件暴露。建议 DEBUG 门控。

---

## 四、其他小问题

1. `CONC_CHUNK`/`CONC_EXTRA` 魔法数字不配置化，弱机无法调。
2. `configure()` 清缓存未同步清 regionCache/roadCache，虽暂不涉及 `REGION_M`，但未来若 REGION_M 可配需一并清理。
3. web/server.js 为旧版备用静态服务（`res.end(data)` 最大 `highWaterMark` 直读），主服务迁移后建议删除或标注 deprecated。
4. verify 脚本依赖固定 seed 与 `dbRows>0`，若未来持久化关闭（PersistEnabled=false）会误报失败。

---

## 五、修复优先级汇总

| 优先级 | 项 | 风险 |
|---|---|---|
| P0 | LRU 淘汰 vs 在途调用竞态 (1.1) | 可能 JS 崩溃 |
| P0 | chunk 失败永久静默 (1.2) | 缺块不可恢复 |
| P1 | 服务端 base64+JSON 中转 (2.1) | chunk 生成主要开销 |
| P1 | tileJson 高频全量道路/扫描 (2.2) | 点击卡顿 |
| P1 | updateStreaming 每帧重建 (2.3) | 每帧阻塞 |
| P1 | 浪线 pow→位运算 (2.4) | 主要 CPU 热点 |
| P2 | 高程/字段缓存淘汰 (2.5)、seed 截断 (1.3)、路径校验(1.5)、浮点反解(3.1)、回调回填(3.2) | 内存/正确性 |
| P3 | 静态缓存、dirty 合并、调试句柄 | 体验 |

---

*生成说明：基于 HEAD=886675f 源码静态审阅，重点核对 renderer.js/mapclient.js/mapgen-server.js/JsEngineHost.cs/MapWorldService.cs。未运行基准测试，运行时可配合性能采样复核 2.1/2.2。*