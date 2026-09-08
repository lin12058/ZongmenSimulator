# 代码审核记录 review_v4

> 审核对象：Server/Zongmen（C# .NET8 后端）+ web/js（前端）最新提交（HEAD=886675f）
> 审核侧重：性能热点、潜在 bug、一致性风险。按严重程度排列。

---

## 一、高危 / 正确性 Bug

### 1.1 LRU 淘汰可能与"在途 JS 调用"并发冲突（中高危）· JsEngineHost.cs
- **位置**：`JsEngineHost.GetOrCreate` / `EvictLocked`，`JsWorldVm` 用 `SemaphoreSlim` 串行执行 `Call`。
- **问题**：当 `_vms.Count > _maxSeeds` 时 `EvictLocked` 直接在 `_lock` 内对最旧 vm 调用 `Dispose()`。若该 seed 恰有另一线程正在 `Call(...)`（持有该 vm 的 `_gate` 尚未释放），此处的 `_engine.Dispose()` 会让正在执行的 JS 调用崩溃或产生不确定结果。由于持有 `_lock` 时调用方处于 `GetOrCreate`，而 `Call` 并不持有 `_lock`，两条路径会交叉。
- **建议**：淘汰前先确认目标 vm 的 `_gate` 可无成本抢占；或把"待回收"条目改为延迟到该 vm 空闲后再 Dispose；或对淘汰对象 `Interlocked.CompareExchange` 标记 + 由调用方释放后来清理。

### 1.2 chunk 请求失败后永久静默（中）· main.js `loadChunk`
- **位置**：`catch` 中 `chunkFail.add(key)`，之后不再重试。
- **问题**：网络抖动 / 后端一次瞬时 5xx 会让该区块**本次会话永久不加载**，地图出现空洞，无任何恢复手段；只有 `regenerate()` 清空 `chunkFail`。需区分"确定错误(404)"与"可重试错误(网络/5xx)"，后者应退避重试而非一棒子打死。

### 1.3 seed 长度截断导致世界碰撞（低中）· JsEngineHost.cs `GetOrCreate`
- **位置**：`seed = seed.Length > 80 ? seed[..80] : seed;`
- **问题**：两个 80 字符后不同的种子会被当作同一世界，LRC 命中错世界（离线确定性语义被破坏）。建议改为保留完整字符串用于 key，若担心内存则改用哈希作为 key，而不是截断。

---

## 二、性能热点

### 2.1 `updateStreaming` 每帧全量重建需求集（高）
- **位置**：main.js `updateStreaming()`，主循环 `loop()` 每帧调用。
- **热点一**：每帧执行 `viewBounds` → `tileBoundsOf` → 三层象限扫描 + `chunkData.forEach` 全量判断卸载 + `chunkQueue.sort`。相机静止时全部是冗余计算。
- **热点二**：`updateStreaming` 每次被调用都 `pumpChunks()` / `pumpExtra()`，即使队列为空。
- **建议**：相机坐标变化小于阈值（已有 `staticNeedsRedraw` 同思路）时跳过重建；仅当相机位移超过一个 chunk 边长才重算 needs 集。参考 `staticNeedsRedraw` 的 `scale` 阈值方案。

### 2.2 浪线绘制 `drawChunkWaves` 邻域解码用 `Math.pow(8, k)`（高）
- **位置**：main.js 顶部 `drawChunkWaves` 内 `for wn 0..6: Math.floor(nv / Math.pow(8,wn))%8`。
- **问题**：每帧（staticDirty 时）对**每个已加载 tile** × 6 个邻居各做一次 `Math.pow`（浮点幂，较贵）。区块多时是主要 CPU 消耗。
- **建议**：用 `[1,8,64,512,4096,32768]` 整数表，`(neigh>>(3*wn))&0x7` 位运算替换；或一次性用位掩码展开。mapgen.js `packNeigh` 处同样把 `Math.pow(8,k)` 换成查表。

### 2.3 `fields()`/`elevAt()` 缓存条目淘汰策略触发过晚（中）
- **位置**：mapgen.js `elevAt`/`fields`/`veinNear`，各缓存 `size > 150000/200000` 才 `evictHalf`。
- **问题**：阈值设得过大，长期运行内存随探索区域线性膨胀；且 `evictHalf` 逐条 `delete` 在超大 Map 上会形成一次性长停顿。
- **建议**：采用固定容量 + 简单 FIFO 阈值（如 1 万条）；或按时戳惰性淘汰；`evictHalf` 改为分批执行避免卡顿。

### 2.4 服务端道路生成 `regionJson` 每格 `roadsNear(i,j,9999)`（中）
- **位置**：mapgen-server.js `regionJson`。
- **问题**：加载每个区域格都跑一次"无预算上限"的道路 A*（`9999`），区域网络大时首次加载该格会产生明显延迟；虽然之后有 roadCache，但连续滚动新区域时会反复触发。
- **建议**：预算化（如每格最多 3~6 条新路，其余延迟到 `warmRoadsStep` 后台渐进预热，前端已有 `warmRoadsStep` 机制，服务端未接入）。

### 2.5 Spider/静态文件整文件读入无缓存（低）· StaticWebMiddleware.cs
- **位置**：`InvokeAsync` 每次 `File.ReadAllBytesAsync` 读整个 js/css/html。
- **问题**：无 ETag/304、无内容缓存。对地图场景影响较小，但首屏多文件 + 每文件整读有优化空间。
- **建议**：加简单的 `Last-Modified`/ETag + 304 支持，或对体积小的文件做内存缓存。

### 2.6 主循环每帧 `drawOverlay` 全屏 clear + 重绘静态层（中）
- **位置**：main.js `drawOverlay` → `staticNeedsRedraw` 判定，但 `ctx.clearRect` 全屏注定每帧走一遍。
- **问题**：静态层（战线/道路/聚落）本可单独缓存到 `staticLayer`，但 `drawOverlay` 每帧复制整张 canvas（`drawImage(staticLayer,...)`），若 cam 缓慢变化则每帧重绘全屏，GPU/合成开销大。
- **建议**：仅当 `staticNeedsRedraw` 为真时 `renderStaticInto`，平时按 `(cam - staticCam)` 偏移直接 blit，已实现但需确认静态层重绘触发是否过于频繁（staticDirty 在 loading 区块期间每 chunk 置位可能过密）。

---

## 三、一致性 / 健壮性问题

### 3.1 Assertion: 服务端算法与前端解码"圆心→相对偏移"依赖浮点逆推
- **位置**：mapgen-server.js `chunkJson` 用 `Math.round(fy/(1.5*HEX_R))` 反解 r、再反解 q；客户端 `chunkToArrays` 用 `ca*S+(cq[i]-16)` 正向还原。
- **风险**：反解 r/q 经过浮点取整，若 `tileToWorld` 存在舍入误差（尤其大坐标时 HEX_W=13.8564 累积），服务端存下的相对偏移可能与客户端按轴坐标点逆推的结果差一个像素/格。当前 verify 已过，但**大世界深处坐标**仍需回归验证。
- **建议**：服务端直接按轴坐标（q,r）存相对量（int），不要用浮点反解，杜绝取整歧义。

### 3.2 `regionCells`/`commCells` 卸载只删远端、拉取并发保护较粗糙
- **位置**：main.js `updateStreaming`。
- **问题**：`regionBusy`/`commBusy` 仅为 Set 防重，但 `regionQueue`/`commQueue` 每帧整体 `length=0` 重建，可能与在途异步回调交错；`loadExtra` 回调里 `regionCells.set` 不带"是否仍需要"判断，可能把刚出视野的格子数据塞回来，造成短暂多一份内存。
- **建议**：注册/回调时校验 `keepR.has(key)` 再 set。

### 3.3 静态层 dirty 标记粒度过粗
- **位置**：`staticDirty = true` 在 `loadChunk` 成功回调中无条件置位。
- **问题**：一个 chunk 上传就全屏重绘静态层，连续加载 N 个 chunk 时静态层会碎片化重绘 N 次。
- **建议**：用一个轻量的"待重绘区域"或合并 dirty 节流（如 200ms 内合并）。

---

## 四、小问题 / 可读性

1. **`CONC_CHUNK`/`CONC_EXTRA` 魔法数字**在 main.js 顶部有注释但非配置化；不同环境（弱机）无法调。建议收敛到常量对象。
2. **`mapGen.configure()`** 清缓存时未同步清 `regionCache/settleCache/roadCache/roadFail`，而 `configure` 改 `COMM_*` 会影响群落但不影响区域——目前语义正确但脆弱，若未来 `REGION_M` 被配置化需一并清理。
3. **`window.__cam`/`__renderer`/`__data`** 全局调试句柄保留在正式代码，建议用 `if (DEBUG)` 包裹。

---

## 五、建议的修复优先级

| 优先级 | 项 | 备注 |
|---|---|---|
| P0 | LRU 淘汰 vs 在途调用竞态（1.1） | 理论崩溃风险 |
| P0 | chunk 失败永久静默（1.2） | 功能空洞 |
| P1 | updateStreaming 相机静止仍全量重建（2.1） | 每帧阻塞 |
| P1 | 浪线 pow → 位运算表（2.2） | 主要 CPU 热点 |
| P1 | fieldCache 淘汰阈值/分批（2.3） | 内存+卡顿 |
| P2 | 服务端道路预算化（2.4） | 滚动卡顿 |
| P2 | 静态层 dirty 合并（3.3） | 首屏流畅 |
| P3 | 其余一致性/健壮性优化 | 后续迭代 |

---

*生成说明：本文基于对 Server/Zongmen 与 web/js 源码的静态审查，未执行运行时 profile。其余较细节项请以运行时验证为准。*