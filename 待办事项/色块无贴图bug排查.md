# 待办：个别色块无任何贴图（前端 WS 块加载竞态）

## 现象
- 地图上会出现某一个色块没有任何地块（贴图），像是块数据从未加载成功。
- 怀疑为后端请求失败 / 空响应。

## 根因定位（已通过读代码确认）
`mapclient.js` 与 `main.js` 之间存在竞态，导致**该块的 rev 被缓存但块数据未落库，后续请求永远拿到空 chunk**：

1. `mapclient.onFrame()` 在收到 TileResponse 时，**无条件**把 `resp.revs` 写进 `revs` 缓存（mapclient.js ~line 156-159），
   早于 main.js 侧对 `keepChunk` 的校验。
2. 若块 A（in-flight）在相机快速移动后出视野：
   - `main.updateStreaming` 重建 `keepChunk`，块 A 不在其中；
   - `loadChunk` 回调里 `keepChunk.has(A)` 为 false → **return，不 applyBlock，chunkData 无 A**。
3. 但 revs 已在第 1 步被缓存，且这块**不在 chunkData 里**，所以 updateStreaming 卸载时**不会 `blockForget`**（forget 只在 `chunkData.forEach` 里对已加载块调用）。
4. 用户平移回 A → 重新 `MC.block()`，`lastRevs` 带上了缓存的 rev。
5. 后端 `GetTileBlock.Need(0)` 判定 chunk rev 未变 → **返回空 chunk 子消息**。
6. 前端 `applyBlock` 中 `resp.chunk` 为 null → `arrays=null` → 不 uploadChunk → **块 A 从此永久空白**。

> 只有服务端 rev 递增（未来事件系统）或 `blockForgetAll`（regenerate）才能自愈，正常浏览永远空白。

## 修复方向
- 方案 A（推荐）：mapclient 在 `block(i,j)` 返回的响应**真正被上层消费**前，不落 revs；或在 main.loadChunk 因 keepChunk 丢弃时，主动 `MC.blockForget(key)`。
- 方案 B：updateStreaming 重建 need 时，对「不再需要」的 in-flight 块（在 chunkBusy 但不在 chunkData）也调用 `blockForget`。
- 方案 C：mapclient 暴露 `onFrame` 与 apply 的耦合点，让 revs 缓存与 chunkData 落库绑定。

## 验证
- verify/ 增加用例：加载块 → 移出视野丢弃 → 移回 → 断言仍能拿到 chunk 数据（非空）。
- headless `?capture=1` 截图确认无空白块。