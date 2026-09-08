# 代码审核 · 最后一次架构迁移提交（24a7d47 之后）

> 审核范围：`Server/Zongmen`（.NET 8 + ClearScript V8 + protobuf-net + SQLite）与 `web/` 前端
> （main.js / mapclient.js / pb.js / renderer.js）。最后一次提交 `886675f` 仅改 .gitignore，
> 实质代码即 `24a7d47` 全套迁移。
>
> 结论：整体架构清晰、职责划分正确，但存在 **1 处功能性 bug**（导致山/雪/灵脉峰高度全失效）、
> 若干性能与健壮性隐患。以下按「确定 bug → 性能隐患 → 健壮性/设计」三档列出。

---

## 一、确定 Bug（必须修复）

### B1. 立体精灵海拔通道从未上传 → 山/雪/灵脉峰高度全部归零
- **位置**：`web/js/renderer.js` `uploadChunk()` 精灵段。
- **现象**：`pd = [propCenters, propSprites, propHashes, propElevs]` 定义了 4 组数据，
  `pl = [1,2,3,4]`（1=centers,2=sprite,3=hash,4=elev），但循环是
  `for (k = 0; k < 3; k++)`，**只绑定前 3 个，`propElevs`(iElev, location=4) 从不 `bufferData`**。
- **后果**：`iElev` 输入变量未启用时 WebGL 取默认值 0，于是 PROP_VS 中
  - 山体 `hs = mix(0.55,1.30, clamp((0-0.70)/0.14)) = 0.55`（永远最低档）；
  - 雪峰 `hs = mix(0.95,1.55, clamp((0-0.84)/0.12)) = 0.95`（永远最低档）；
  - 所有山变矮、雪峰无高度差、灵脉峰高度也失效。
- **修复建议**：`for (k = 0; k < 4; k++)`，且 `vertexAttribPointer` 的 size 判断
  `pl[k]===1 ? 2 : 1` 仅对 centers 为 2，其余均为 1，属性 4（iElev）是标量，保持不变即可。

---

## 二、性能隐患（按影响排序）

### P1. 渲染每帧全量遍历所有已加载 chunk，无视锥剔除
- `renderer.render()` 在 Pass1 与 Pass1.5 各 `chunks.values()` 全量迭代并 `drawArraysInstanced`。
- 当世界持续加载、chunk 数到几十上百时，每个可见帧都要对全部 chunk 做 bind/uniform/绘制提交，
  远离相机的 chunk 也在消耗 CPU。
- **建议**：对 `chunks` 做 AABB 视锥粗剔除（viewBounds 已在 main.js 有现成逻辑），
  Pass1/Pass1.5 只绘制 bbox 与视图相交的 chunk。

### P2. 区块数据双写内存 + SQLite，重复 IO
- `Store()` 对每个 chunk/region/comm 同时 `Mem.Set` 与 `Sqlite.Insert ... ON CONFLICT`。
- 冷启动后所有 lazily 加载的 chunk 都会写 SQLite，单条 `ExecuteNonQuery` 有固定开销；
  这不是瓶颈级，但可批量/异步落库，避免阻塞请求线程。

### P3. Tile / FieldGrid 不落库，"即时计算"全部堵在单线程 V8
- 每次点击格 `GET /api/map/tile`、每次小地图采样 `GET /api/map/fields` 都会在
  `JsEngineHost` 的 `SemaphoreSlim(1)` 门闩上串行排队，重新调用 `fields()/roadsNear()`。
- 小地图 0.4~1.5s 轮询 + 用户频繁点击时，单实例 V8 会成为吞吐瓶颈。
- **建议**：① fields/tile 结果按 (seed,q,r) LRU 缓存；② 小地图采样降频或用后台线程预取；
  ③ 必要时 JsEngineHost 支持每 seed 多实例分摊并行。

### P4. `geTChunk` 命中内存仍可能触 SQL 查询
- `Mem.Get ?? Sql.Get`：内存命中时短路不查 SQL，这点没问题；但 `Sql` 分支在
  高并发下没有请求级合并——同一 chunk 首次 miss 时，多个并发请求会重复 `buildChunk`
  并重复写库。**建议**：加 per-key in-flight 去重（CompletableFuture 风格），
  避免雪崩时重复构建。

### P5. chunk 全量重建成本高、无服务器级长期缓存
- V8 VM 内部其实已缓存数据（`LB chunk()` 数据结构）；`buildChunk` 只是从 VM 取数打包。
- 但只要 VM 因 LRU 淘汰，再次请求会触发整 chunk 级重建 + gzip，代价大。
- `MaxSeeds=3` 固定值，若业务多 seed 会频繁进出。至少应为热 seed 保留权重不淘汰。

### P6. gzip 每 chunk 都重新压
- `GZipCodec.Compress(Fastest)` 每次构建都全量压一次；建议压缩结果并入长期缓存
  （当下 `Mem/Sql` 存的本就是 gzip 字节，命中缓存即免压，OK），仅在失重时付出即可——此项实际已合理，
  保留提示：失重重建时会重复压缩。

### P7. main.js `updateStreaming()` 每帧全量重建并排序 chunkQueue
- 每帧 `for key in need` + `sort(by dist)`。chunk 数量增大后 O(n log n) 每帧。
- 可改为：仅在 `staticDirty || 相机位移超阈值` 时才重排（项目已有相机阈值跳过的先例）。

---

## 三、健壮性 / 设计问题

### R1. `chunkFail` 永久黑名单
- `loadChunk().catch(chunkFail.add(key))` 后永不清理；一次瞬时网络失败该区块将一直不加载，
  且地图出现永久空洞。**建议**：带重试次数/退避上限，或在新一轮 `regenerate` 时清空黑名单
  （当前 `regenerate()` 确实只 `chunkFail.clear()`——但同一 viewport 内的临时失败仍不会在
  本 session 内自动恢复）。

### R2. 已卸载且在途 chunk 会被重新 upload 后又被丢弃
- 视野快速移动时，某 chunk `chunkData.delete`（卸载）但 `chunkBusy` 仍在途；
- 响应回来 `loadChunk` 成功路径 `if (!chunkData.has(key))` 成立 → 重新 `uploadChunk`+`chunkData.set`，
- 下一轮 `updateStreaming` 又把它当冗余 drop。**浪费一次全量上传**，且与 R1 组合可能出现
  chunkData 短暂包含视野外数据。
- **建议**：成功回调也校验「此 key 今日是否仍在 need 集」（或记录卸载时间），已移出视野则跳过 upload 并清 busy。

### R3. `WorldKeys.SeedPrefix()` 每次调用都 SHA1
- 每个 key 拼 string 时都 `SHA1.HashData` + Hex（前 16 字符）。虽小，但 `getChunk` 等每请求多次。
- **建议**：对 seed → 前缀做一次内存 map 缓存。

### R4. 静态中间件无缓存头/ETag
- `StaticWebMiddleware` 每次 `File.ReadAllBytesAsync` 全量读文件，且 `Cache-Control: no-cache`。
- 每帧无影响，但页面刷新都要重取所有 js。**建议**：按 mtime 生成 ETag，加 `Cache-Control: max-age`。

### R5. `ChunkPayload` 打包里 `count`（地块数）与 `pn`（精灵数）来自不同来源
- 代码中 `count = d.tiles.length`、`pn = d.propCenters.length/2`；若两端数量不一致（如某 chunk
  无精灵）逻辑正常，但无断言——加一层一致性校验更稳。

### R6. 并发 `tile`/`fields` 无节流上限
- 后端无请求限流，恶意/高频刷新会钉死 V8 门闩。可在中间件级别加简单 per-IP 限流。

---

## 四、总结优先级
| 级别 | 条目 | 影响 |
|------|------|------|
| 🔴 必修 | B1 精灵海拔未上传 | 山岳/雪峰高度视觉全失效 |
| 🟠 建议 | P1 视锥剔除、P3 tile/fields 缓存、P2 落库异步 | 视口越大/点击越频，CPU 与 V8 越吃力 |
| 🟡 可选 | R1 失败重试、R2 在途卸载协调、R3 seed前缀缓存、R4 静态缓存、R5 断言、P7 队列重排节流 | 稳定性与长期可维护 |