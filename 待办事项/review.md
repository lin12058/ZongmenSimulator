# 宗门模拟器 demo3 · 前后端代码审查汇总（review.md）

> 整合来源：`review_v1` ~ `review_v5`（2026-09-09 五轮静态审阅合并去重）
> 审核范围：`Server/Zongmen`（C# .NET8 后端 + 引擎 JS）+ `web/`（前端渲染）
> 评级：🔴 高（正确性/崩溃/长期性能）· 🟠 中（可优化/一致性问题）· 🟡 低（维护性/小损耗）
> 结论：整体架构（C# 权威计算 + V8 沙箱 + protobuf/gzip 两级缓存 + 前端纯渲染）设计合理、无结构性缺陷；未发现确定性数据错位 bug。风险集中在**缓存与持久化生命周期**、**渲染静态层全量重绘**与一处**必现崩溃级缺字段**。
>
> **【2026-09-09 修复记录】T0~T15 已全部处理完毕。** 验证：`dotnet build` 0 错误；`node verify/verify_map.mjs` 310 项全绿；`?capture=1` headless 渲染回归正常（山/雪/湖/灵脉峰/无黑区）；T3 后台 prune 实测将 dbRows 4278→307。偏离原建议的点：① T4 未按「区域粒度 epoch」，改用 **roadVer 道路版本号**（roadCache 每新增道路 +1，tile 缓存条目携带生成时版本）——更精准且实现更简；② T2 采取「region 不再落库 + `_regionHot` 大容量 LRU」组合；③ T14 中 `propPad=hexR*12` 经核算保留（聚类偏移最大 36px + 精灵最高 ~8uR，12uR 属合理余量）。运行时注意：区域包不再写 SQLite，重启后区域首次访问会重新走 JS 生成（区块/群落持久化不受影响）。

---

## 〇、待办总表（按优先级）

| 级别 | 编号 | 模块 | 摘要 | 状态 |
|------|------|------|------|------|
| 🔴 崩溃 | **T0** | mapclient.js `geo()` | **缺 `biomeMeta` 字段**，打开小地图/格详情即抛 TypeError | ✅ 已修 |
| 🔴 内存 | **T1** | mapgen.js | region/settle/comm/road/roadFail 五类缓存**无容量上限**，长期漫游内存线性增长 | ✅ 已修（512/1024/1024/4096/1024 容量） |
| 🟠 存储 | **T2** | MapWorldService | 区域包**只写 SQLite 从不回读**，冷回访必重算 A*；落库纯占磁盘 | ✅ 已修（不再落库 + _regionHot LRU 512） |
| 🟠 存储 | **T3** | SqliteVirtualContext | SQLite **无界增长**；Prune 仅依赖 `/stats` 第 20 次触发，历史 seed 数据永不清除（现 33MB+） | ✅ 已修（后台 2min 维护任务，实测 4278→307 行） |
| 🟠 一致性 | **T4** | MapWorldService | `_regionEpoch` 按 **seed 全局失效**，一发区域包即清空该 seed 全部 tile 缓存，连点小地图反复重算 | ✅ 已修（roadVer 道路版本号） |
| 🟠 一致性 | **T5** | SqliteVirtualContext | `Flush` 前台/后台并发写、失败回滚重入队可能旧覆盖新；`Prune` 与 writer 不同锁 | ✅ 已修（全程持 _flushLock） |
| 🟠 性能 | **T6** | mapgen.js | `buildChunk` 6 邻居 `fields()`/`veinNear` 级联重复重算，冷启动高 seed 首帧卡顿 | ✅ 已修（两遍扫描，数组下标取邻居场） |
| 🟠 性能 | **T7** | main.js | 静态层（路网/浪线/标注）**整层全量重建**：缩放频繁重绘、`drawChunkWaves` 逐格 hash+多次 stroke | ✅ 已修（roadsDirty 路网缓存 + 概率筛前置） |
| 🟠 缓存 | **T8** | MapWorldService+MemoryVC | chunk/comm SQLite 命中后**不回填 `_mem`**；MemoryVC 先进先出淘汰与视角局部性冲突 | ✅ 已修（ReadSqlBackfill + LRU 化） |
| 🟡 维护 | **T9** | renderer.js/textures.js | `ATLAS_ROWS=8` 与 `HEX_FS`/`PROP_FS` **隐式硬编码耦合**，调图集行数将静默丢精灵；注释“7 行”与实现不符 | ✅ 已修（唯一常量注入着色器 + 构建期断言） |
| 🟡 体验 | **T10** | main.js | `window.onerror` 全局兜底过宽，次要异常即弹致命面板并中断帧 | ✅ 已修（只落 console，主循环 try/catch 保留） |
| 🟡 性能 | **T11** | MapWorldService | 三个 LRU 用 `Take(Cap/4)` 全量遍历淘汰，O(n) 且并发取键竞态 | ✅ 已修（新建 Storage/LruCache.cs） |
| 🟡 性能 | **T12** | JsEngineHost | `EvictLocked` 用 `OrderBy.First()` 找最旧 VM，O(n·logn)（MaxSeeds=3 时量级小） | ✅ 已修（线性扫最旧） |
| 🟡 配置 | **T13** | Options.cs | `MaxSeeds=3` 与“seed 隔离”内存边界，多 seed 并发观看会互相挤出重建 | ✅ 已修（默认 3→4，appsettings 可调） |
| 🟢 低 | **T14** | 多文件 | 注释/命名/死代码清理（`propPad=hexR*12` 过大、`struct` 语义、`clusterOffset` 常量、`b64FromBytes` 遗留注释等） | ✅ 已处理（clusterOffset 魔数提为 CLUSTER_EPS 常量；b64FromBytes 注释修正；propPad 经核算保留；probe 脚本已不存在，注释项失效） |
| 🟢 低 | **T15** | mapclient.js | `pxToTile/tileToWorld` 每像素无条件重算、`drawOverlay` 全屏计算；`meta` 全局单例硬编码 seed=1 | ✅ 已修（geo() 结果单例复用——原实现每次调用新建对象，小地图单次刷新 ~1.1 万次分配；补世界无关注释） |

---

## 一、崩溃级 🔴

### T0 · `geo()` 缺 `biomeMeta` —— 必现 TypeError（最优先）
- **位置**：`web/js/mapclient.js` `geo()`（约 L26-33）
- **表现**：`geo()` 只返回 `hexR/hexW/chunkS/chunkScan/regionM/commCl/commR/seaLevel`，**漏了 `biomeMeta`**；但 `main.js` 两处读取 `geo.biomeMeta[...]`：`refreshMinimap`（L450，小地图配色）与点击格详情（L773 地貌名）→ 抛 `Cannot read properties of undefined`，进入 `showFatal` 阻塞主循环。第三处（L1055）用原始 `m.biomeMeta` 恰好掩盖了问题。
- **修复**：`geo()` 返回对象补 `biomeMeta: meta.biomeMeta`（一行）。
- **验证**：开页 → 滑动触发小地图 → 点击一格看详情，确认不再抛错。
- **连带**：`refreshMinimap` 的 `colCache`（S4）因缺字段形同虚设，随本项一并恢复。

---

## 二、高频一致性/一致性类 🟠

### T1 · 引擎 JS 五类缓存无上限（内存主风险）
- **位置**：`Engine/js/mapgen.js`
- **现状**：`elevCache/fieldCache/veinNearCache` 走 `cacheSet()` 有 `ELEV_CAP/FIELD_CAP/VEIN_CAP`；但 **`regionCache`、`settleCache`、`commCache`、`roadCache` 全为裸 `Map.set()` 永不淘汰**，`roadFail`（不可达集）只增不减。
- **影响**：持续向新区域漫游时 V8 堆与世界面积线性增长，只增不减，长期运行触发 GC 压力/OOM。
- **建议**：四类缓存复用 `cacheSet` 加固定容量（建议 region 512 / settle 1024 / road 4096 / comm 1024、roadFail 1024），淘汰最旧；`roadCache` 用 `a|b` 作 key，淘汰时注意与 `roadFail` 一致性（只淘汰、不改语义）。
- **来源**：v1 P6、v2 #6、v4 1.1、v5。

### T4 · `_regionEpoch` 按 seed 全局失效
- **位置**：`MapWorldService.cs` `GetRegionBytes`
- **现状**：每次经 JS 生成区域后 `++_regionEpoch[seed]`，使该 seed 全部 tile 缓存条目同时失效（最多 1024 条）。
- **影响**：多区域并发/连续流式加载时，之前缓存的 tile 被整片清空重算；连点小地图反复重算。
- **建议**：改按 `(seed, regionI, regionJ)` 粒度 epoch，只淘汰落在当前区域内的 tile 条目。
- **来源**：v1 P2、v2 #3、v3 2.3、v5 S1。

### T5 · SQLite 并发写/裁剪竞争（低概率）
- **位置**：`SqliteVirtualContext.cs`
  - `Flush` 前台（Stats/Dispose）与后台 writer 可并发：逻辑幂等（UPSERT）不丢主数据，但**失败回滚把 batch 重新入队时可能被同 key 新版本覆盖**（旧覆盖新，短暂陈旧读）。
  - `PruneExcept` 与 writer **不共享同一把 `_flushLock`**，极端下 `DELETE` 与 `INSERT` 交错 → 偶发 `database is locked`。
- **建议**：改单写者模型（落库只在后台线程，Stats/Dispose 仅发信号）；`PruneExcept` 也套 `_flushLock`。
- **来源**：v4 1.3、v5 S7。

### T8 · chunk/comm SQLite 命中不回填内存 + 淘汰顺序与视角冲突
- **位置**：`GetChunkBytes`/`GetCommBytes`（`_mem ?? _sql`）+ `MemoryVirtualContext.cs`
- **现状**：
  - chunk/comm 双读正确，但 **SQLite 命中后不回填 `_mem`**，同一 chunk 反复走库读。
  - `MemoryVirtualContext` 按插入序 FIFO 淘汰（cap=8192），与相机空间局部性弱相关——热区 chunk 可能被远处“先访问”的条目挤掉。
- **建议**：
  1. SQLite 命中后把字节回填 `_mem`（`Store` 一并回填），避免二次读库；
  2. MemoryVC 命中时将该 key 移到队尾/维护访问计数，保空间局部性。
- **来源**：v2 #7、v5 S2、S5。

---

## 三、性能类 🟠

### T2 · 区域包只写不读，A* 冷启动全量重生成
- **位置**：`MapWorldService.GetRegionBytes`（v1 P1 / v3 2.1 / v4 1.2 / v5 S1）
- **现状**：只查 `_mem`、不查 `_sql`，`Store` 却照写 `_sql`。注释说明是为保持 `tileJson.onRoad` 与 VM `roadCache` 语义一致而**故意**不读库。
- **影响**：区域内存缓存淘汰后，任何点击/流式都会对整条道路重新跑 `roadsNear(...,9999)` A* 全量寻路；SQLite 里的 region 行自写入起永不回读，纯占磁盘与写放大。
- **建议（分层，需与 T4 一起评估）**：
  1. 短修：调大 `_mem` 容量并对“邻近区域格”LRU 保活；
  2. 中修：为区域→道路集建独立进程内 `Map<seed,(区域,道路,roadCache指纹)>` 缓存，指纹一致时直接复用；
  3. 长修：把 SQLite 区域包当“仅当新道路不影响 onRoad 时的只读备份”，用 roadCache 版本号判新鲜度后返回，A* 增量。
- **风险**：不要简单改为直读 SQLite 行，否则点击某区域与地图绘制路况会不一致（旧代码注释已踩坑）。

### T3 · SQLite 无界增长 + Prune 依赖 `/stats` 偶发触发
- **位置**：`SqliteVirtualContext` / `StatsJson`
- **现状**：`PruneExcept` 仅在 `/stats` 第 20 次请求触发，且只按“当前存活 seed 前缀”过滤；被 LRU 淘汰的历史 seed 数据永不清理。现 `db/zongmen.sqlite` 已达 33MB+，长期多 seed 持续膨胀。
- **建议**：a) 持久化加 TTL/大小预算，按最近访问/seed 时间淘汰；b) prune 移到运行期后台任务，不依赖 `/stats`；c) region 不落库后可显著回落。
- **来源**：v3 2.2、v4。

### T6 · `buildChunk` 邻居/灵脉级联重算
- **位置**：`mapgen.js buildChunk`（L378-383 附近）
- **现状**：归属地块对 6 个邻居各再 `fields()`；每个 `fields()` 内又 `veinNear()`→`communityOf()`（3×3 晶格最多 1+3+7=11 条灵脉逐条 `hexDist`）。冷区块 ≈721 格×(自身+6 邻居)≈**5000 次 fields 级重计算**，`veinNear/veinNearCache/elevAtVN` 大量重复触发。
- **影响**：冷启动高 seed 首帧卡顿、浮窗开格卡。
- **建议**：a) inner 循环只 `fields()` 一次即可取到 `veinNear+elevAtVN` 结果，邻居场显式从 `fieldCache` 取，不再走 veinNear 分支；b) 把 `chunkOfTile` 归属判定与 `fields` 解耦（先归属后取场），避免对非本区块格无效 `fields`。
- **来源**：v2 #2、v1 P7、v3。

### T7 · 静态层整层全量重建 + 逐格浪线开销
- **位置**：`main.js drawOverlay`/`renderStaticInto`（L706 附近）、`drawChunkWaves`（L488-552）
- **现状**：
  - 每次静态层重绘对 `regionCells.forEach` 全量重建 `haloV/coreV` 路网顶点并 `setRoads()`→`bufferData(DYNAMIC)` 重传；缩放过程中频繁整体重绘。
  - `drawChunkWaves` 对每个已加载 chunk 的全部地块逐格做 `Math.round` 世界坐标反算、hash 取 3 浮点、`beginPath/arc/stroke`（2~3 次），低端机转/缩放易掉帧。
- **建议**：a) 路网/标注拆“分块缓存”，仅失效块重绘；或烘焙到离屏 Canvas，平移只 `drawImage`；b) `drawChunkWaves` 先按可见格包围盒裁剪（现 bbox 粒度为 chunk，未到格级），或把 `(fr1,fr2,fr3)/近岸` 离线缓存进每 chunk 数组；c) 低端机按 dpr/zoom 降浪线密度。
- **来源**：v1 P11、v2 #8、v3 1.1、v4 3.1、v5 S3。

---

## 四、低/维护类 🟡🟢

### T9 · 图集行数硬编码耦合（v2 #1 / v3 / v4）
- `renderer.js` `PROP_FS` 行号 `floor(vSprite/8)`、默认 `atlasRows=8`、`HEX_FS` 硬编码 `vec2(8,8)`、`textures.js ATLAS_ROWS=8` 四处强耦合；`PROP_FS` 精灵行 44..47/48/49/50..54/60..63 依赖 8 行为界。当前不触发，但**一旦调整行数即静默丢精灵**。
- 建议抽公共常量，三处同引用，加构建期断言 `texAtlas高%PX==0 && rows==ATLAS_ROWS`。
- `textures.js` 头注释“共 7 行”与实现 `ATLAS_ROWS=8` 不符，仅注释滞后。

### T10 · 全局 error 兜底过宽（v4 3.2）
- `main.js window.onerror` 对任意异常（第三方脚本、WebGL 上下文丢失、次要错误）都弹致命面板并 throw 中断当前帧。
- 建议只捕获与渲染强相关错误（`try/catch(renderer.render(...))`），不做全局 hook。

### T11 · 三个 LRU 粗淘汰（v2 #7 / v3 2.4 / v4 1.4）
- `GetTileBytes`/`GetFieldGridJson` 超限时 `Take(Cap/4)` 全量遍历 Keys 再批量删，O(n) 且存在并发取键竞态。
- 建议换 `ConcurrentLRU`（链表+锁）或固定分片淘汰，避免热点轮询反复整表扫描。

### T12 · `EvictLocked` O(n·logn)（v1 P5 / v4 1.5 / v5 S12）
- 超 `MaxSeeds` 用 `OrderBy(LastUsed).First()` 找最旧 VM 排序整个字典；默认 MaxSeeds=3 时量级小。调大后需改 LRU 双向链表/最小堆 O(logn)。

### T13 · `MaxSeeds=3` 与 seed 隔离冲突（v5 S9）
- 多 seed 并发观看端会互相把对方 VM 挤出（LRU），来回切换反复重建 V8 与重跑 init。扩展时把 MaxSeeds 提到并发/seed 数。

### T15 · 前端纯函数无条件重算 + meta 硬编码（v1 P10 / v2 #4 / v4 / v5 S4）
- `pxToTile/tileToWorld` 每帧无缓存；`drawOverlay` 全屏贴图级计算（DPR 高时成本累积）。低优先级，出现热点再缓存。
- `mapclient.meta` 模块级单例且 `fetchMeta(seed=1)` 硬编码；元信息当前为世界无关常量，建议透出参数或显式注释“世界无关”。

### T14 · 杂项清理（v3 1.2 / v4 / v5 S6）
- `renderer.js propPad=hexR*12`（96px）远大于实际精灵高度（约 3.3~4.5 倍半径≈26~36px），Pass1.5 粗剔除偏保守；无正确性问题，量级小。
- 注释/命名：`verify/probe` 目录 `_countVeins` 语义与注释偏差；`mapgen.js clusterJit` 内 `clusterOffset` 常量、`mapgen-server` `b64FromBytes` “不再逐段 b64” 的遗留注释，可清理。

---

## 五、已确认无问题（避免误修）

- **protobuf 链路**：字段号、`Content-Encoding:gzip` + `fetch` 透明解压、`ChunkPayload/RegionInfo/TileQuery` 带符号整型均 `ZigZag`，前端 `sint` 解码一致，无错位。
- **坐标还原**：`chunkToArrays` 用 `qa=ca*S+(cq[i]-16)`、服务端 `dq+16` 正确还原 `dq=q-ca*S`，与 `Path.resolve`/`NEIGH_SLOTS` 对齐。
- **`regenerate()` + `gen` 版本守卫**：旧世界回调不会污染新世界，正确。
- **区域 `onRoad` 只读已生成道路**：与地图绘制路况一致（在 T2 未改前此设计安全）。
- **灵脉灯色/元数据/区块终端序**：`ELEMENT_RGB(5)`↔`geoElementColor`、`CHUNK_S/SCAN/...`↔`geo()`、字节宽跨文件一致。
- **现有覆盖**：`verify_map.mjs` 310 项覆盖区块坐标/地貌/海拔/哈希/邻域/精灵/区域/群落/单格，全绿。

---

## 六、建议落地顺序

1. **T0**（必现崩溃，一行修复 + 回归点小地图/格详情）
2. **T1**（内存主风险：五类缓存加容量上限）+ **T4**（epoch 按区域粒度失效）
3. **T2 + T3**（存储生命周期二合一：region 落库策略 + SQLite 定时整理）
4. **T6 → T7**（CPU：buildChunk 邻居复用 → 静态层分块缓存/浪线裁剪）
5. **T5/T8/T11/T12**（并发与淘汰策略）→ **T9/T10/T13/T15/T14**（维护与体验）

> 验证方式：每轮改动后跑 `node verify/verify_map.mjs` 确认不破坏 310 项契约；用 `?capture=1` headless 截图回归渲染。

_汇总于 2026-09-09 · 由 review_v1~v5 合并去重_