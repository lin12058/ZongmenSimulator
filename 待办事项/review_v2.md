# 代码 Review v2 — 性能与隐藏 Bug 清单

> 日期：2026-09-13
> 范围：最近 2 天（09-12 ~ 09-13）改动的生产代码，即 09-12「城市选址与建筑足迹重构」落地及后续调整：
> - 服务端 C#：`JsEngineHost.cs`、`MapWorldService.cs`、`MapMessages.cs`
> - 地图生成 JS：`Engine/js/mapgen.js`、`mapgen-config.js`、`mapgen-server.js`
> - 前端：`web/js/main.js`、`web/js/pb.js`、`web/index.html`
> - `verify/*.mjs` 为一次性测试脚本，未做深度审查；`灵脉预览.html`/`verify/_test_center.html` 仅做副本一致性比对。
> 方法：服务端 / 算法 / 前端三路并行逐行审查 + `dotnet build` 编译验证（无编译错误，改动 API 的全部调用点签名匹配；引擎确认为 ClearScript V8 7.4.5，`Program.cs` 单例注册）。
> 行号以 09-13 审查时点为准，后续改码可能偏移。

## 总览

| 严重度 | 数量 | 说明 |
|---|---|---|
| 高 | 2 | 会造成功能失效或线上报错，建议立即处理 |
| 中 | 11 | 确定性 bug 或明显性能瓶颈，尽快排期 |
| 低 | 20 | 边界问题 / GC 压力 / 体验细节，择机处理 |

---

## 一、高危（建议立即处理）

- [ ] **H1【副本不一致】`verify/_test_center.html` 内嵌的 mapgen.js 是旧版，测试页结论不可信**
  - 位置：`verify/_test_center.html:1504`（`demandEdgesFor(i,j)` 旧签名）、`:1629`（`roadsNear(i,j,maxNew)`），对照源码 `Server/Zongmen/Engine/js/mapgen.js:1085、1111-1115、1217、1224`
  - 问题：内嵌引擎缺 `cq/cr`「修路中心由内向外生长」排序整段逻辑，而页面层 `:2309` 已按新签名传参（第 4/5 参被静默丢弃）→ 该页的「修路中心」功能完全失效。且建路是路径依赖的（`ROAD_W_ROAD=2` 复用折扣），建路顺序不同路形就不同——**用这个页做回归验证会得出错误结论**。
  - 建议：把 `_test_center.html` 422~1997 行的引擎段用当前 mapgen.js 重新内联（`灵脉预览.html` 已同步为逐字节一致，可参照）；加自动校验（对内嵌段做 hash 比对）+ 页头版本注释防复发。
  - 备注：`灵脉预览.html` 已确认一致；`mapgen-server.js` 是适配层非算法副本，全部 `MG.*` 引用与新 mapgen.js 兼容，无漂移。

- [ ] **H2【隐藏bug】JsEngineHost LRU 淘汰不检查在途引用，正在用的 V8 引擎会被 Dispose**
  - 位置：`Server/Zongmen/Engine/JsEngineHost.cs:119-147`
  - 问题：`MaxSeeds=4`，出现第 5 个 seed 时新 seed 的 `GetOrCreate` 淘汰"最旧"VM，但其它线程可能刚拿到该 VM 引用、正持 `_gate` 执行 JS（regionJson 冷启可达 130ms+）→ 在途 `Call` 撞上已释放引擎，客户端收到「块构建失败」，且 `GetTileBlock` 是逐步写缓存（chunk 已 Store、region 失败）产生残缺块。`Dispose()` 在 `lock(_lock)` 内还会拖住所有 seed 的取用。附带：`MaxSeeds` 配 0/负数时 100% 复现（刚插入的 VM 立即被销毁并返回已释放实例）。
  - 建议：`JsWorldVm` 加在途引用计数（Call 前 Acquire / 后 Release），`EvictLocked` 跳过在用者或「移出字典 + 延迟 Dispose」；`_maxSeeds` 构造时 `Math.Max(1, maxSeeds)` 兜底。

---

## 二、中危

### 服务端 C#

- [ ] **M1【隐藏bug】`_roadVerCache` 无锁 read→write，旧值回写覆盖导致 tile 缓存误判新鲜**
  - 位置：`MapWorldService.cs:622-624`（另见 `:168`）
  - 问题：tile 线程读 `RoadVersion()`（ver=4）→ 释放 V8 门闩后写缓存；期间 region 线程把 ver 推到 5 并写入；tile 线程随后把 4 写回覆盖。此后 RoadVer=4 的旧 tile 条目被判新鲜，返回「新路落成前」的 onRoad 结果，与客户端已画的道路矛盾。
  - 建议：roadVer 单调递增，两处写都改 `AddOrUpdate(prefix, ver, (_, old) => Math.Max(old, ver))`。

- [ ] **M2【隐藏bug】roadVer 是 per-VM 实例值，缓存却是 per-seed 进程级键，VM 淘汰重建后 ver 归零**
  - 位置：`MapWorldService.cs:56-60、600-624、168`（`TileEntry(byte[] Gz, long RoadVer)`，`_roadVerCache` 键仅 seed 前缀）
  - 问题：roadCache 每个 VM 实例从 0 计数。VM 被 LRU 淘汰后重访同 seed → 新实例 `roadVersion()=0` → 缓存被踩回 0，道路落成前的旧 tile 条目被判新鲜返回过期数据；若按 M1 改成 Max 保留，则新实例条目永远比对失败，该 seed 的 tile 缓存实质失效、每次重算。
  - 建议：tile 新鲜度键带上 VM 实例代数（`GetOrCreate` 返回 `(vm, generation)`），换代即整体失效该 seed 的 tile 缓存。

- [ ] **M3【性能】`blockLayersJson` 每请求两遍循环 + RegionPack/SettlePack 重复解压反序列化**
  - 位置：`MapWorldService.cs:468-513`
  - 问题：一个块可覆盖 3×3~4×4 个区域格，mask=All 时两遍 foreach 各自 gzip 解压 + protobuf 反序列化（`_rawCache` 只缓存 chunk/comm 的压缩字节，不缓存反序列化产物）。流式加载连续块时 CPU 大量花在重复解压/DTO 构建。
  - 建议：合并两遍循环；对反序列化产物加小容量 LRU（DTO 不可变可共享引用）。

- [ ] **M4【隐藏bug+泄漏】`_blockRev` 无界增长；`BlockRevs.Bump` 非原子**
  - 位置：`MapWorldService.cs:414、419/436、397-412`
  - 问题：`ConcurrentDictionary<string, BlockRevs>` 按访问过的块无限增长（key 含 seed 前缀，已淘汰世界也留着），常驻服务随漫游线性上涨。`Bump` 对 5 个 int 字段非原子 `++`、快照读取无同步——当前 Bump 未被调用（事件钩子预留），一旦接入就有丢失更新/撕裂读。
  - 建议：换 LruCache 或按淘汰 seed 前缀清理；Bump/快照用小锁或返回不可变快照。

- [ ] **M5【性能】`GetTileBlock` 全同步管线跑在 async WS 处理器里，`_gate.Wait()` 无取消**
  - 位置：`MapWorldService.cs:433-525` + `MapWsHandler.cs:132`；`JsEngineHost.cs:40/55`
  - 问题：每条 WS 消息同步执行整条管线（V8 门闩无限等待、SQLite 同步读、gzip、多次 region 构建冷启 ~130ms/格）。多客户端并发时每条消息占死一个线程池线程数百毫秒 → 线程池饥饿拖垮全部 /api 与其它连接；客户端断开后已排队的 V8 任务不取消。
  - 建议：最低成本 `var resp = await Task.Run(() => svc.GetTileBlock(...), ct);`；中期给 `JsWorldVm` 提供 `WaitAsync(ct)` 异步门闩。

### 地图生成 JS

- [ ] **M6【隐藏bug】贸易网络扫描窗口 ±1 不足，漏建 tradeEdge**
  - 位置：`mapgen.js:839-844`
  - 问题：`TRADE_REACH=40` 但只扫 ±1 区域格（3×3）。`REGION_M=18`、聚落锚点抖动 ±6.3，跨 2 格的最近城镇对距离下限 = 2×18−12.6 = 23.4 格 < 40 → 相距 23~40 格、本应建边的城镇对（分属 (i,j) 与 (i+2,j)）永远不会被配对。聚落越密漏得越多。道路侧 `demandEdgesFor` 用 ±2（5×5）恰好覆盖，唯独贸易窗口小一号。
  - 建议：贸易循环改 `di/dj ∈ [-2,2]`，与 demandEdgesFor 对齐（`d > reach` 剪枝已能兜住多余候选，代价可忽略）。

- [ ] **M7【隐藏bug】同格双聚落可选中同一个城镇中心（无去重，本次重构引入）**
  - 位置：`mapgen.js:887-923`（`settlementsFor`）、`686-698`（`pickSettlementCenter`）
  - 问题：`count=2` 时两个锚点相距可小于 2×PROSPECT_R=8，勘测窗重叠且存在明显最高分格时，两个聚落选中同一个 (q,r)，无任何去重 → 37 格足迹完全重叠、`bfsRoad` 自环生成单点退化道路、tradeEdge 出现 d=0 边、两份相同数据入库。旧算法锚点即落点天然分离，是「勘测→选址」重构引入的。
  - 建议：`settlementsFor` 内记录已选中心，第二个聚落重合时改取 `prospectArea` 次高分格（或 continue）。

- [ ] **M8【隐藏bug】regionJson 给秘境（POI）生成了城镇足迹，三层口径不一致**
  - 位置：`mapgen-server.js:82-99、106`（`settlementJson` 无 type 过滤）vs `:127`（`settleJson` 跳过 POI）vs `灵脉预览.html:2905`（绘制过滤 POI）
  - 问题：`CORE_KIND['poi']` 不存在 → POI 兜底成 village 核心（祠堂/村口），Buildings/Resources/Style 被填满下发；而 settle 层明确 `if (st.type === 'poi') continue`（设计文档：秘境无城镇足迹），展示层又不画。生产前端一旦接入 footprint 渲染（待办 §五）就会在秘境上画出村庄，且白耗 protobuf 字节。
  - 建议：三处统一——`settlementJson` 开头对 `type==='poi'` 返回空足迹，或 regionJson 复用 settleJson 的过滤。

### 前端

- [ ] **M9【隐藏bug】`renderStaticInto` 未判空 `pack.region`，一旦字段缺省整个页面 fatal**
  - 位置：`web/js/main.js:670-678`；对照 `:965-969`（`regionNameAt` 判了空）、`pb.js:408-420`（protobuf3 未设置即 null）
  - 问题：`regionCells.set` 无条件入库，渲染主路径直接 `rg.x`。一旦某区域格只带 roads 不带 region（或服务端字段裁剪），TypeError 被 loop 的 try/catch 捕获后 `showFatal('渲染循环异常')`，rAF 不再排队，**整个应用定格在错误面板**。同文件在别处判了空，说明 null 是认可的合法状态，此处是防御不对称。
  - 建议：循环开头 `if (!pack.region) return;` 或入库时过滤。

- [ ] **M10【隐藏bug】小地图数据窗口不随相机刷新，平移后错位/大片纸色**
  - 位置：`web/js/main.js:293、453、920、1278`（`minimapDirty` 仅 3 处置位）、`472-477`
  - 问题：`minimapDirty` 只在 chunk 到达/数据返回/regenerate 时置位，平移缩放不置位；`refreshMinimap` 每 1.5s 按**当前**相机中心采样**旧窗口**的数据 → 窗口内像素整体错位、窗口外回退兜底色 `#b9ad92`。在已加载区域缓慢平移（长时间无新块）时，小地图与视框长期不符。
  - 建议：相机中心移动超过 `W/2*SCALE`（约 396 世界像素）时置 `minimapDirty`；或小地图改世界锚定随数据整体平移。

- [ ] **M11【隐藏bug】格详情点击竞态：在途时新点击被静默丢弃，且请求无超时**
  - 位置：`web/js/main.js:818-836`；`web/js/mapclient.js:238-241`
  - 问题：点击 A 在途时点击 B，B 防抖到期后因 `panelBusy` 直接 return 且 `infoPending` 已被清空 → B 永久丢失；A 返回后面板显示 A 内容而高亮框在 B，数据与选择不一致。另 `MC.tile` 的 fetch 无超时/AbortController，服务端一次挂起就让 `panelBusy` 永久为 true，详情面板从此点不开。
  - 建议：去掉 `panelBusy` 早退，改请求序号守卫（响应回来时非最新 seq 则丢弃）；fetch 加超时。

---

## 三、低危 / 优化项

### 地图生成 JS

- [ ] **L1【性能】`bfsRoad` 每次调用分配 121 个桶 + 2 Map + 1 Set**（`mapgen.js:1148-1150`）。全图流式累计数万次调用，GC 压力可观。建议提为模块级 scratch 清空复用（f 单调不减，重置安全），或桶懒创建。
- [ ] **L2【性能】budget=0 纯读路径仍全量重算 `demandEdgesFor`**（`mapgen.js:1224` 无缓存 + `mapgen-server.js:225` 点击查询）。每点一次 tile 判定要 9 次 `roadsNear(ci+dj,cj+dj,0)`，每次构建 5×5 池 + `rngDominated` 50 次 Map 查找 + `id.split('_')`。密集区单次点击 ~万级 Map 操作且同格反复点击重复付出。建议按 `i,j,cq,cr` 缓存；`id.split('_')` 解析一次复用。
- [ ] **L3【隐藏bug】内置兜底 CFG 与 config 漂移**（`mapgen.js:61-62` vs `mapgen-config.js:69-79`）。兜底 `ROAD_W=[4,4,4,3,5,3,8,8]` 与真源 `[8,6,4,3,4,5,8,8]` 不一致，且缺 `ROAD_W_ROAD`（→ 启发式失效，慢 3~5 倍）和 `ROAD_DI_MAX10`（→ roadDI=0，**所有非骨架边全被绕行闸放弃，路网坍缩成骨架**）。任何按旧顺序拼 bundle 漏掉 config 的宿主都会静默劣化。建议补齐兜底值，或 `init()` 里 `if (!global.MapGenConfig) throw`。
- [ ] **L4【隐藏bug】同格双聚落 pop/tier 完全相同**（`mapgen.js:905-916`，hash salt 不含 k）。k=0/k=1 同类型聚落得到相同 pop/tier。建议 salt 改 `91+k`（注意会改变既有世界内容，落库数据需重置）。
- [ ] **L5【性能/带宽】跨格道路在两份区域包中重复输出**（`mapgen.js:1309` + `mapgen-server.js:107-111`）。端点分属相邻两格的需求边在两格各自 `roadsNear` 中都命中 → 同一条路出现在两个 regionJson 载荷，带宽 ×2（重复绘制无视觉错误）。建议 regionJson 输出前按 `rd.key` 去重。
- [ ] **L6【性能】`diRetryQueue` 数组 `shift()` O(n) 出队**（`mapgen.js:1233、1340`）。上限 4096，常量小，可不动；要改就环形缓冲/头指针。
- [ ] **L7【隐藏bug·条件性】跨引擎浮点一致性边界**（`mapgen.js:1353-1358` 等 `Math.pow`）。服务端 V8 vs 浏览器：Firefox/WebKit 的 `Math.pow` 末位 ulp 可能不同，`spiritAt`/海平面严格比较在极少数格子翻转 → 两端地形/良田判定不一致。两端都跑 V8 内核时无风险。建议文档约束「客户端限 V8 内核」，或 pow 改查表插值。
  - 已确认：生成路径无 `Math.random`，确定性在 V8 内成立。

### 服务端 C#

- [ ] **L8【性能】同 seed 并发冷启各建一个 V8 实例，无 per-seed 去重**（`JsEngineHost.cs:110-126`，代码注释自述"收敛"）。前端首屏对新 seed 并发十几条请求时最坏一次建 N 个 V8，CPU/内存尖峰。建议 `ConcurrentDictionary<string, Task<JsWorldVm>>` 构建去重。
- [ ] **L9【隐藏bug】region miss 后额外 `World()` 只为读 roadVer**（`MapWorldService.cs:168`）。若恰逢 VM 被淘汰，这里会整场重建 V8（数百 ms）只读一个版本号。建议 build 闭包返回 `(gz, ver)`，在持门闩期间顺带读。
- [ ] **L10【隐藏bug】维护循环 stale 判定漏洞 + Dispose 竞态**（`MapWorldService.cs:722-739、771-780`）。(a) `prefixes` 快照后淘汰的世界前缀被遗忘，无主 SQLite 行清理延迟；(b) 历史进程残留行可能永远不清理；(c) `_maintTask.Wait(1000)` 超时后 `Task.Delay(token)` 抛 `ObjectDisposedException`（只捕了 OperationCanceledException），且 `PruneExcept` 不检查 `_disposed`。建议精确求差集删除、catch 放宽到 Exception、Prune/Flush 开头检查 `_disposed`。
- [ ] **留档不改码**：`GetMetaJson` 的单条 `_metaCache` 不区分 seed——已核对 `metaJson()` 只返回与 seed 无关的几何/配色常量，目前正确；若日后 meta 引入 seed 相关字段会静默串世界，建议加注释锚定前提。另外 `/ws/map` 不在 `ApiRateLimitMiddleware` 热点路径内（WS 侧仅靠 per-connection 串行兜底），接入真实账号体系前建议给 TileRequest 加频控。

### 前端

- [ ] **L11【性能】静态覆盖层在持续平移时几乎每帧全量重绘**（`main.js:507-515` 阈值、`518-584` drawChunkWaves、`586-765` renderStaticInto）。offset 补偿只在位移小于阈值时生效，阈值很小（zoom 2.2 时约 21 屏幕像素），快速拖拽每帧都越阈值 → 每帧遍历 1.5~2 万 tile 画浪线/渐变/文字 + 逐条拼接 `rgba(...).toFixed(2)` 字符串 + 重建 RadialGradient。**低倍缩放 + 拖拽是最大掉帧源，也是四块短板里最值得投入的一项。** 建议：静态层渲染到「视口+四周 40% 边距」的离屏 canvas 放大阈值；浪线按 chunk 烘焙世界锚定离屏；晕圈预渲染 sprite；颜色/字体分档缓存。
- [ ] **L12【性能】主循环无跳帧门控，静止时仍每帧全功率跑 3-pass WebGL**（`main.js:1269-1271` + `renderer.js:544-719`）。画面静止时每帧仍执行 POST_FS 全屏后处理（每像素约 30 次纹理采样），dpr=2 的 1080p 即 830 万像素 × 30 采样/帧，纯 GPU 功耗。建议加 `needsRender` 标志（相机变化/chunk 上传与淡入中/staticDirty/hover 或选中变化时置位），静止时跳过 render + drawOverlay。
- [ ] **L13【性能】`drawMinimap()` 每帧重绘**（`main.js:1281、490-504`）。内容只在 mmBase 更新（≥1.5s 一次）时变化。建议仅更新后重绘一次；顺带修 `index.html:259` 固定 432×282 与 dpr 解耦、3.27 倍最近邻放大像素不均的问题（改 `216*dpr × 141*dpr`）。
- [ ] **L14【性能】`refreshMinimap()` 每 1.5s 无条件全量重建，逐像素 parseInt**（`main.js:1274-1280、470-487`）。1.1 万次 `pxToTile`（含对象分配）+ 3.5 万次 parseInt/slice，相机没动也是纯浪费。建议移动超过 SCALE 才重建；`colCache` 缓存 `[r,g,b]` 或 Uint32 调色板。
- [ ] **L15【性能】pb.js 每读一个字符串/float 就 new TextDecoder/DataView**（`pb.js:32-37、68-73`）。一条 TileResponse 几十到几百个字符串字段逐个构造。建议模块级单例 TextDecoder、Reader 复用 DataView。
- [ ] **L16【隐藏bug】hover 高亮与 cursor 在鼠标离开画布后不清除**（`main.js:1108-1123` 无 else 分支）。mousemove 绑 window，移出 #app 后高亮框残留、cursor 一直 pointer。建议 else 分支复位。
- [ ] **L17【隐藏bug】键盘状态无 blur 清理，切窗后相机持续漂移**（`main.js:1180-1189`）。按住方向键 Alt+Tab（keyup 丢失），33ms 定时器让相机漂到世界尽头。建议 `window.addEventListener('blur', () => keys = {})`。
- [ ] **L18【隐藏bug】双指捏合：无锚点补偿 + 抬起一指后单指拖动失效**（`main.js:1149-1178`）。对比 wheel 有完整锚点补偿，pinch 完全没有（捏合时中点下世界点漂移）；touchend 把 `drag=null` 后单指分支要求非空，需全部抬起重按。建议 pinch 做中点世界坐标 before/after 锚定；touchend 时剩一指则重置 drag 基准。
- [ ] **L19【隐藏bug】滚轮缩放未归一化 deltaMode，Firefox line 模式几乎无法缩放**（`main.js:1142`）。系数按 pixel 模式调的，Firefox 普通鼠标 deltaY≈±3 → 每格仅缩 0.36%。建议按 `e.deltaMode` 归一化后再进公式。
- [ ] **L20【隐藏bug】pb.js `Reader.skip` 无越界校验 + `chunkToArrays` 不校验字段长度**（`pb.js:42-48、140-149`）。截断/畸形帧时 `p` 越过 `end` 返回**半截消息**被当正常数据用（表现为莫名空白块而非报错）；字段缺失时 `toU16(undefined)` TypeError 会被当解码失败 `failAllPending` 拒绝**全部**在途请求并无限退避重拉。建议 skip 统一越界 throw；chunkToArrays 做存在性与长度断言（抛带块坐标的明确错误）；main.js 重试设上限并展示 `resp.err`。
- [ ] **L21【隐藏bug】格详情面板 innerHTML 直接拼服务端字符串，未走已有的 `esc()`**（`main.js:840-864`；对照 `:944-948`、`:1030-1053` 宗门录面板已用 esc）。当前数据源可信风险低，属防御不对称漏网；另 `TYPE_NAME[...]`/`biomeMeta[...]` 缺省显示字面 "undefined"。建议统一过 esc + 兜底文案。

---

## 四、已排查、确认没有问题的点（避免重复怀疑）

- **bfsRoad 桶序安全性**：`h=hMin×⌊笛卡尔距⌋` 的 f 单调不减已数学验证，`buckets[f]=null` 后不会有节点推入已释放桶，无 TypeError/死循环/重复扩展；桶下标不越界、权重不溢出，closed 懒删除正确。
- **buildChunk 两遍扫描**：grid 覆盖 R+1=16 盘，dist-15 邻居必已填充，无 undefined 解引用。
- **贸易配对复杂度**：3×3 窗口 + settleCache 下每格约 36 对，不是 O(n²) 热点（真问题是 M6 的窗口不足）。
- **`| 0 || 默认` 优先级、roadFail 三振、diRetry 预算、chunkJson u8/u32 打包边界**：均正确。
- **C# 编译与调用方**：`dotnet build` 无错误，`MapEndpoints.cs`/`MapWsHandler.cs` 对全部改动 API 调用签名匹配。
- **SQLite 层**：全部 `using` + 参数化 + WAL + 批量异步落库 + 失败回退重入队，未发现连接泄漏或注入面。
- **MapMessages.cs**：字段号/ZigZag/默认 `[]` 防 null/`LastRevs` 越界负数兜底均正确，无协议层 bug。
- **前端健壮的部分**：块请求并发上限 + 指数退避 + 回填校验 + `gen !== worldSeed` 世界代际守卫；静态层 offset 补偿 + 200ms 节流；WS 重连状态管理（failAllPending、乱序响应丢弃、rev 缓存保留）健全。
- **index.html 脚本加载顺序**：`pb → mapclient → noiselib → textures → renderer → main`，依赖无倒置，无内联脚本问题。

## 五、建议处理顺序

1. **立即**：H1（重新内联 `_test_center.html`，否则后续回归都在验证错的代码）→ M6/M7/M8（各只需几行，且都是确定性复现的内容正确性问题）。
2. **本周**：H2 + M1/M2（同属 VM 生命周期与 roadVer 一簇，可一起改）；M9（整页 fatal 的防御）。
3. **性能专项**（可打包做）：L11 + L12（前端最大掉帧源与静止功耗）、M5（线程池饥饿）、M3、M4。
4. **择机**：其余 L 项。M7/L4 修 salt 时注意会改变既有世界内容，落库数据需重置，建议合并到一次「世界重生成」发布里。
