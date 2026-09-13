# 宗门模拟器 — 五份 review 汇总核验（review.md）

> **生成时间**：2026-09-13
> **输入**：`待办事项/review_v1.md` ~ `review_v5.md`（5 份并行代码审查）
> **核验基线**：工作区当前磁盘代码 = `HEAD = ff6d476`（09-13 14:14「修复近距聚落不连通 + 两段式镜头」）
> **核验方式**：逐条 Read 源码 / Grep 定位 / 实跑脚本，不信文档描述；每条给 `文件:行` 证据
> **注意**：五份文档的基线都早于 `ff6d476`（v1 基线 `57428dd`，v2~v4 为 09-13 早些时候，v5 覆盖到 `6122e26`+未提交）。因此部分结论在当时为真、现在已被修复 —— 这类标为「已修复」，不算误报。

---

## 0. 判定口径

| 标记 | 含义 |
|---|---|
| ✅ **真实** | 当前代码中确实存在，机理与文档描述一致 |
| 🟡 **夸大/部分真实** | 机理存在，但**影响面、严重度或后果**被放大；或只在特定条件下成立 |
| ⚪ **已修复** | 审查当时为真，之后被提交修复（主要是 `ba86c73` / `ff6d476`） |
| ❌ **误报** | 代码与结论相反，不成立 |

---

## 1. 总览：五份文档体检

| 文档 | 声明条数 | ✅真实 | 🟡夸大 | ⚪已修复 | ❌误报 | 一句话评价 |
|---|---|---|---|---|---|---|
| v1 | 12 | 11 | 1 | 1 | 0 | 命中率最高、结论最稳；范围最窄（只 48h 那批道路/聚落改动） |
| v2 | 33 | 26 | 6 | 1 | 0 | **覆盖最全、误报为 0**，工程价值最高；少数条严重度偏高 |
| v3 | 12 | 9 | 4 | 1 | 0 | 最精炼；性能视角好，但两条「正确性」结论夸大 |
| v4 | 12 | 4 | 4 | 3 | 1 | 结构清晰带实测数字，但**唯一含明确误报**，且核心结论已随代码失效 |
| v5 | 16 | 13 | 1 | 1 | 0 | 唯一**真实跑过验证脚本**的；分级表 + 可复跑命令最实用 |

**去重后唯一 bug 总数：58 条**（P0 级 3 / P1 级 14 / P2 级 25 / P3 级 16）。

**重叠情况（重要）**：五份文档对同一批改动并行审查，重复率很高。被报 2 次以上的有 11 个问题，其中
`DI 拒绝边无负缓存`、`roadTileIdx 只增不清`、`roadFailTrials 无上限`、`skeletonEdgesFor 未缓存`、
`roadsNear(9999) 一次算全`、`内置兜底 CFG 漂移`、`poi 被生成城镇足迹`
这 7 个被 3~5 份文档重复报告 —— 它们是这轮改动**真正的高置信度问题**。

**核验中发现文档没说到位的 2 处**（下面 §2.A16 / §4 详述）：
1. 兜底 CFG 的漂移**远不止**文档说的「缺 2 个键 + ROAD_W 表」，而是整表旧值（`COMM_CL` 150 vs 60、`SPIRIT_R_TILES` 1000 vs 500、`COMM_P_MIN` 0.16 vs 0.60…），漏载 config 会生成完全不同的世界。
2. `mapgen.js:48-50` 的注释写着「本文件不再自带默认值」，但 `:51-65` 的兜底对象**还在** —— 注释与代码互相矛盾。

---

## 2. 唯一 Bug 清单（去重后）

### A. 引擎 · 道路网

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| A1 | **DI 闸拒绝（路径存在只是绕行超限）的边永不退场、无负缓存** —— 不计数 `roadFailTrials`，每次 `roadsNear` 重跑 A* 并吃 `budget` | v1 P1-1 / v5 #5 / v4 #6 | ✅ 真实 | **P0** |
| A2 | `skeletonEdgesFor` 未缓存，`skel` 是局部变量，每次命中 DI 闸重算 O(P²·P) | v1 P3-8 / v5 #6 | ✅ 真实 | P1 |
| A3 | `roadFailTrials` 无 `*_CAP`、转正后条目也不 delete → 会话内线性增长 | v1 P3-11 / v3 P1-2 / v5 #9 | ✅ 真实 | P2 |
| A4 | `roadTileIdx` 只增不清，而 `roadCache` 有 `ROAD_CAP=4096` 淘汰 → 幽灵路廊 + 重建路径可能不同 | v1 P3-5 / v3 P2-4 / v5 #3 | ✅ 真实（边界，未触发） | P1 |
| A5 | `regionJson` 用 `roadsNear(i,j,9999)` 一次算全 → 新区域首请求在 V8 门闩内阻塞（实测 195.8ms） | v3 P0-1 / v4 #9 / v5 #13 | ✅ 真实 | P1 |
| A6 | `bfsRoad` 每次 `search()` 分配 121 个桶 + 2 Map + 1 Set；两段式镜头后可能 ×2 | v1 P3-9 / v2 L1 | ✅ 真实 | P3 |
| A7 | 跨格道路在两份相邻区域包里重复输出（按 `rkey` 缓存、各自 `out.push`） | v2 L5 | ✅ 真实 | P2 |
| A8 | 建路顺序依赖 → 跨会话路形在批边界可能略异 | v3 P2-2 | ✅ 真实（代码注释已承认，设计取舍） | P2 |
| A9 | `diRetryQueue` 用 `shift()` O(n) 出队 | v2 L6 | ✅ 真实（常量小） | P3 |
| A10 | 内置兜底 CFG 与 `mapgen-config.js` 整表漂移（缺 `ROAD_W_ROAD`/`ROAD_DI_MAX10`，`ROAD_W` 旧表，且 `COMM_CL`/`SPIRIT_R_TILES` 等大面积不同） | v1 P2-2 / v2 L3 | ✅ 真实（**比文档说的更严重**） | P1 |
| A11 | 需求图（`scanDemandEdges`+`rngDominated`）每次调用重建，含 `maxNew=0` 纯读帧 | v4 #1/#7 / v2 L2 / v3 P1-3 | ⚪ 已修复（`ff6d476` 引入 `demandCache`） | — |
| A12 | `rngDominated` 是隐性 O(N²)（每候选边 × 5×5 池 × 两端） | v4 #4 | ⚪ 已随 `demandCache` 摊销 | — |
| A13 | `rngDominated` 注释写「3x3」实际 `-2..2` | v1 P3-12 | ⚪ 该行已改 5×5；但 `:1046`、`:1237` 同类注释仍在 | P3 |
| A14 | 骨架边强制建路无隔海检查 → 可在窄水体上被强制画出「海上路」 | v3 B1 | 🟡 夸大（受 `ROAD_COST_MAX=120` 限制，仅约 ≤15 格窄水；非「跨大陆」） | P2 |
| A15 | `bfsRoad` 平原扩散 + 桶粒度粗 → A* 铺满预算圆 | v3 P0-2 / P2-3 | 🟡 夸大（`ff6d476` 两段式镜头 + 欧氏启发已大幅缓解） | P3 |
| A16 | DI 闸对极近邻对（`d0hex` 小）易触发 → 「多数近邻边被跳过」 | v4 #10 | 🟡 夸大（DI 闸对近距对触发属设计语义，直连重试有兜底） | P3 |
| A17 | `Configure()` 未清理 `diRetryQueue` 引用 | v4 #11 | ❌ **误报**（`mapgen.js:1538` 明确 `diRetryQueue.length = 0`；v1 也把它列为「已核实无问题」） | — |
| A18 | `Math.pow`/`Math.sqrt` 跨引擎末位 ulp 差异 → 两端地形判定可能不一致 | v2 L7 | ✅ 理论真实，实际风险极低（生成路径关键判定已尽量整数化） | P3 |

**A1 证据**：`mapgen.js:1275`（drain 中 DI 超限 → `diRetryQueue.push` 后 `continue`，不计数）、`:1350`（deferred 重试仍超限 → `continue`，不计数）、`:1369`（回队尾）。三条路径都**不进 `roadFailTrials`** ⇒ 无 3 振转正机制。
**A1 对预览页的真实后果**：`灵脉预览.html:2344` `budget = roadBudget() = max(1, 输入值)`。drain 循环（`:1684`）**先于**主循环且共享预算；若队列头是卡住的边，`budget=1` 时全部预算被 drain 吃掉 → 主循环一条都建不出，`built` 恒 0；同时每 tick（最多 40 格）白跑 A*。

### B. 引擎 · 聚落 / 城镇 / 贸易

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| B1 | **贸易扫描窗口只 ±1（3×3），而 `TRADE_REACH=40` 可跨 2 格** → 相距 23~40 格的城镇对本应建边却永远不配对（多份文档只有 v2 指出） | v2 M6 | ✅ 真实 | **P0** |
| B2 | 同格双聚落可选中**同一个**城镇中心（`settlementsFor` 无去重）→ 足迹完全重叠、`d=0` 贸易边、自环路 | v2 M7 | ✅ 真实（低频） | P1 |
| B3 | 同格双聚落 `pop`/`tier` 完全相同（hash salt 不含 `k`） | v2 L4 | ✅ 真实 | P2 |
| B4 | `growTownFootprint` 只跳过海洋，**雪峰格不设防** → 雪峰上铺「矿山/熔炉」 | v1 P3-7 | ✅ 真实 | P3 |
| B5 | `regionJson` 的 `settlementJson` **无 `type` 过滤** → 秘境(poi)被生成一整套祠堂/村口足迹（`settleJson` 有过滤） | v2 M8 / v5 #4 | ✅ 真实 | P1 |
| B6 | `prospectArea` 冷启动成本（R=4 逐格 `siteScore` + 前 6 名 `resourceBonus`） | v3 P1-1 | ✅ 真实（观察项，不回退） | P3 |
| B7 | `resourceBonus` 对每候选重复扫邻域 | v4 #5 | ✅ 真实（量级小） | P3 |
| B8 | `SETTLE_CAP=1024` 抖动 → `tileJson` 的 `onRoad` 3×3 逆缓存滚动，高温重扫 | v4 #2 | 🟡 夸大（CAP 值与遍历方式属实；「294ms 反复淘汰」为推算，无可复现证据） | P2 |
| B9 | `settleCache` 与 `roadCache` 驱逐节奏不一致 → 端点认知漂移 | v4 #8 | 🟡 夸大（推测性；引擎按坐标幂等重算，最终一致） | P3 |

**B1 证据**：`mapgen.js:841-845` `for (di=-1..1) for (dj=-1..1)`，且只对 `mine = settlementsFor(i,j)` 发起。跨越 2 格的城镇对（属 (i,j) 与 (i+2,j)）**在任何区域格都不是「本格聚落」**，因此永远不会被任何 `tradeEdgesFor` 发射。对照 `demandEdgesFor` 用 ±2（`:1101`）恰好覆盖 —— 唯独贸易窗口小一号。

### C. 服务端 C#

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| C1 | `JsEngineHost` LRU 淘汰不检查在途引用，正在执行 JS 的 V8 引擎会被 `Dispose`（`Dispose` 还在 `lock` 内） | v2 H2 | ✅ 真实 | **P0** |
| C2 | `_roadVerCache` 无锁 read→write，旧值回写 → tile 缓存误判新鲜 | v2 M1 | ✅ 真实（窗口窄） | P1 |
| C3 | `roadVer` 是 per-VM 实例值、缓存键却是 per-seed → VM 重建后 ver 归零 | v2 M2 | 🟡 夸大（机制成立，但后果是「缓存失效重算」而非「返回过期数据」；后者要叠加 C2 才成立） | P2 |
| C4 | `blockLayersJson` 每请求两遍循环 + `RegionPack`/`SettlePack` 重复 gzip 解压反序列化 | v2 M3 / v1 P3-10 | 🟡 部分（两遍与重复解压属实；但结果已被 `_blockLayersCache` 缓存，**非「每请求」**） | P2 |
| C5 | `_blockRev` 无界增长 + `BlockRevs.Bump` 非原子 + `BumpBlockRev` **无调用者** → settle 演化不下发（`Need=false`） | v2 M4 / v5 #11 | ✅ 真实 | P1 |
| C6 | `GetTileBlock` 全同步管线跑在 async WS 处理器里，`_gate.Wait()` 无取消 → 线程池饥饿 | v2 M5 | ✅ 真实 | P1 |
| C7 | 同 seed 并发冷启各建一个 V8 实例，无 per-seed 构建去重 | v2 L8 | ✅ 真实 | P2 |
| C8 | region miss 后额外调 `World()` 只为读 `roadVer`；VM 恰被淘汰会整场重建 V8 | v2 L9 | ✅ 真实 | P2 |
| C9 | 维护循环 stale 判定漏洞（`"w:"+pfx+":"` vs 裸 16 位十六进制）+ `PruneExcept` 不检查 `_disposed` | v2 L10 | 🟡 部分（stale/差集/无 `_disposed` 属实；`Task.Delay(token)` 抛 `ObjectDisposedException` 被 `:716 IsCancellationRequested` 拦断 → **该子项夸大**） | P2 |
| C10 | `GetRegionBytes` 区域包**永不落库**（只 `_regionHot` + `_mem`）→ 冷回访必然重跑全量道路 | v4 #3 | ✅ 真实（代码注释明说不落 SQLite） | P2 |
| C11 | `GetTileBlock` 的 `needSettle` 分支按 region 解 `SettlePack`，而同一份数据已随 region 包到达 | v5 #8 | ✅ 真实 | P2 |
| C12 | `b.GetProperty("q")` / `r.GetProperty("resource")` 未用 `TryGetProperty`（同文件其它字段都用了）→ 缺字段抛 `JsonException` 中断**整个** TileRequest | v5 #12 | ✅ 真实 | P1 |
| C13 | `MapMessages.cs` ProtoMember 13~16 纯增量、无字段号冲突 | v1 无问题项 | ✅ 复核属实 | — |
| C14 | `BuildOnce` 双检正确、SQLite 层无泄漏/注入 | v1 无问题项 | ✅ 复核属实 | — |

> **C1 补充**：`_maxSeeds` 配 0/负数时会 100% 返回刚被 `Dispose` 的实例（`JsEngineHost.cs` 无 `Math.Max(1, ...)` 兜底），这条比文档说的「并发才触发」更狠。

### D. 前端

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| D1 | `verify/_test_center.html` 内嵌引擎是旧版（缺 `cq/cr` 修路中心），页面层却已按新签名传参 → **该页结论不可信** | v2 H1 | ✅ 真实 | P1 |
| D2 | `renderStaticInto` 未判空 `pack.region`，而别处判了 → 缺字段即整页 `showFatal` | v2 M9 | ✅ 真实 | P1 |
| D3 | `refreshMinimap` 每 1.5s 无条件全量重建，逐像素 3 次 `parseInt` | v2 L14 | ✅ 真实 | P1 |
| D4 | `drawMinimap()` 每帧重绘；`index.html` 画布固定 432×282 与 CSS 216×141、dpr 解耦 | v2 L13 | ✅ 真实 | P2 |
| D5 | 主循环无脏门控，静止时仍每帧全跑 3-pass WebGL（含全屏后处理） | v2 L12 | ✅ 真实 | P2 |
| D6 | 格详情点击竞态（`panelBusy` 早退静默丢弃）+ `MC.tile` 无超时/AbortController | v2 M11 | ✅ 真实 | P1 |
| D7 | `pb.js` 每读一个字符串/float 就 `new TextDecoder`/`DataView` | v2 L15 | ✅ 真实 | P2 |
| D8 | `Reader.skip` 无越界校验 + `chunkToArrays` 不校验字段长度 → 半截消息被当正常数据 / 一次解码失败 `failAllPending` 全部在途请求 | v2 L20 | ✅ 真实 | P2 |
| D9 | hover 高亮与 `cursor` 鼠标离开画布后不清除（`mousemove` 无 `else`，无 `mouseleave`） | v2 L16 | ✅ 真实 | P2 |
| D10 | 键盘状态无 `blur` 清理 → Alt+Tab 后相机持续漂移 | v2 L17 | ✅ 真实 | P2 |
| D11 | 双指捏合无锚点补偿 + 抬起一指后单指拖动失效 | v2 L18 | ✅ 真实 | P2 |
| D12 | 滚轮缩放未归一化 `deltaMode` → Firefox line 模式几乎无法缩放 | v2 L19 | ✅ 真实 | P2 |
| D13 | 格详情面板 `innerHTML` 直接拼服务端字符串，未走已有 `esc()`；`TYPE_NAME[...]` 缺省显示字面 "undefined" | v2 L21 | ✅ 真实 | P2 |
| D14 | `updateSectPanel` 先做全量 `collectSects()`+sort，**后**才比指纹 | v5 #14 | ✅ 真实 | P3 |
| D15 | region 包冗余携带城镇足迹，前端 `main.js:303` 只取 `{region, roads}` 后全部丢弃（服务端算 + 序列化 + 传输后归零） | v5 #7 | ✅ 真实 | P1 |
| D16 | 小地图数据窗口不随相机刷新（`minimapDirty` 仅 3 处置位）→ 长时间平移后内容陈旧/回退兜底色 | v2 M10 | 🟡 夸大（「不刷新」属实；但按绝对 `(q,r)` 索引，**不会错位**，是「陈旧」而非「错位」） | P2 |
| D17 | 静态覆盖层快速拖拽时高频全量重绘 | v2 L11 | 🟡 夸大（有 offset 补偿复用，非「几乎每帧」；阈值 zoom2.2 时约 21 屏幕像素，快速拖拽确实频繁越界） | P2 |
| D18 | 宗门菜单浮层锚点不随缩放/窗口变化 | v4 #12 | 🟡 夸大（`#sectMenu` 是 `#sectWrap` 兄弟 + `z-index:6`，结构正确；「锚点漂移」未证实） | P3 |
| D19 | `layerFingerprint` 时序修正、`esc()` 覆盖 `&<>"`、`collectSects`/`nearestVein` 有界 | v1 无问题项 | ✅ 复核属实 | — |

### E. 预览页（灵脉预览.html）

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| E1 | 「清空道路缓存」**只清 `roadCache`**，不清 `roadTileIdx`/`roadFail`/`roadFailTrials`/`diRetryQueue`/`roadVer` → 新路沿幽灵路廊走、onRoad 缓存不失效 | v1 P2-3 | ✅ 真实 | P1 |
| E2 | 预览页传「修路中心」`cq/cr` 给 `roadsNear`，服务端不传 → 设了中心后**预览路网 ≠ 服务端路网** | v5 #2 | ✅ 真实（条件性） | P1 |
| E3 | 预览页内联引擎与 `mapgen.js` 未同步 | v5 #1 | ⚪ **已修复**（实跑 `--check` 全同步，源已 68116 字节） | — |
| E4 | 贸易虚线只在**小 id 端属格**可见时绘制 → 两端都在画面里也可能不画 | v1 P3-6 | ✅ 真实 | P2 |

**E1 证据**：`灵脉预览.html:3267-3277` 的 `roadClearBtn.onclick` = `MapGen.roadCache.clear()` + `resetRoadState()`（后者只重置队列/定时器，见 `:2372-2375`）。对照内联引擎自身的完整清法是 `:1960` / `:637`。

### F. 仓库 / 运维

| # | 问题 | 来源 | 核验 | severity |
|---|---|---|---|---|
| F1 | `.tmp_cs_probe.js` / `.tmp_review_check.js` 误提交到仓库根 | v1 P2-4 | ⚪ 已修复（`ba86c73` 移出版本库 + `.gitignore` 加 `.tmp_*`；两文件仍在磁盘上但已忽略） | — |
| F2 | `verify/_cdp_shot.mjs`、`verify/_scratch_diag.mjs` 未跟踪残留，违反「不留一次性脚本」约定 | v5 #16 | ✅ 真实（`git status` 确认仍未跟踪） | P3 |
| F3 | 改 `ROAD_*`/`PROSPECT_*`/`TOWN_*`/`FARM_SPIRIT` 等参数后未清 `db/zongmen.sqlite*` → SQLite 旧包优先回读，参数不生效 | v5 #15 | ✅ 真实（运维提示） | P2 |

---

## 3. 被夸大的结论（严重度打折说明）

用户关心的「哪些是夸大其词」，集中在这 8 条。**注意：夸大 ≠ 不成立，机理基本都对，只是后果/范围被放大。**

| 出处 | 文档的结论 | 核验后的修正 |
|---|---|---|
| v3 B1 | 骨架边强制建 → **会画出海上路**（跨大陆） | 强制建只发生在「`bfsRoad` 在 120 代价预算内已找到路径」的边上。深水 8 费 → 最多约 15 格水面。是「窄水体上被强制画路」，不是「跨海」。 |
| v3 P0-2 | `hMin=2` → 平原整片等 `f`，A* **扩散到预算圆铺满** | `ff6d476` 已加**两段式镜头**（先 40 步紧凑镜头，未中才 60 步兜底），且启发早已换成**欧氏 `cartDist`**（直线走廊 f 最低）。这段描述是 hexDist 时代的旧结论。 |
| v2 M2 | VM 重建后 `roadVer` 归零 → **返回过期 tile 数据** | 归零只会让旧条目**失配 → 重算**（结果正确，只是失效）。要真返回过期数据必须叠加 v2 自己的 M1 竞态。 |
| v2 M3 | `blockLayersJson` **每请求**两遍循环 + 重复解压 | 结果已被 `_blockLayersCache` 缓存，不是每请求；「两遍循环 + 重复解压」本身属实。 |
| v2 L10(c) | 维护循环 `Task.Delay(token)` 抛 `ObjectDisposedException` | 被 `MapWorldService.cs:716 IsCancellationRequested` 提前拦断，走不到取 `token`。该子项不成立（其余两子项成立）。 |
| v2 L11 | 静态层持续平移时**几乎每帧**全量重绘 | 有 offset 补偿复用（`:968-971`），未越阈值时按相机差平移复用。快速拖拽确实频繁重建，但「几乎每帧」偏绝对。 |
| v2 M10 | 小地图**错位**/大片纸色 | 按绝对 `(q,r)` 索引，**不会错位**，是「数据窗口不更新 → 内容陈旧 + 新区域回退兜底色」。 |
| v4 #2 / #8 | `SETTLE_CAP=1024` 反复重扫、缓存驱逐节奏不一致致「端点状态跳变」 | 机制路径存在，但两处都缺可复现实测；引擎按坐标幂等重算，最终一致。属**待实测的假说**。 |

**唯一明确误报**：**v4 #11**「`Configure()` 未清 `diRetryQueue`」—— `mapgen.js:1538` 明确写了 `diRetryQueue.length = 0`。

---

## 4. 逐份文档评价

### review_v1 —「窄而准」
- **范围**：48h（09-11~09-13）那批道路/聚落改动 + 前端时序；`verify/*.mjs` 未逐行看。
- **方法**：逐行读 + 给「已验证无问题项」清单（12 条，**复核后全部属实**，含 bfsRoad 可采纳性/一致性的数学论证、wire 兼容、灵气边界衰减方向）—— 这份的「无问题项」质量是五份里最高的，能当后续审查的免检基线。
- **命中率**：12 条声明 11 真 1 部分 0 误报，最高。
- **独有价值**：**雪峰上的矿场（B4）**、**贸易虚线视野边界闪失（E4）**、**清空按钮清理不全（E1）**、`.tmp` 入库（F1）—— 这 4 条只有 v1 报。
- **短板**：覆盖最窄，没进 C#，前端只看了时序。

### review_v2 —「最全、最工程化」
- **范围**：服务端 C# / 引擎 JS / 前端三路并行逐行，附 `dotnet build` 编译验证。
- **方法**：H/M/L 三级 + 明确「已排查无问题」清单（8 条，复核属实）；33 条声明是五份里最多的。
- **命中率**：26 真 6 夸大 **0 误报** —— 广度与准度兼顾最好。
- **独有价值**：**贸易窗口 ±1（B1，P0 级真问题）**、**同格双聚落同中心（B2）**、**整页 fatal（D2）**、**点击竞态（D6）**、**`_test_center.html` 旧版副本（D1）**，以及整批前端 L 项（D3~D13）—— 前端问题是 v2 独家。
- **短板**：M2/M3/L10/L11 四条严重度偏高（见 §3）；L2/L4 涉及 salt 的改动会改变既有世界内容，修的时候要注意清库。

### review_v3 —「最精炼」
- **范围**：`git log --since="2 days"` 覆盖的改动，明确「静态阅读 + 热路径计数，未改代码、未压测」。
- **方法**：P0/P1/P2 + 末尾「配置参数核对清单」，把 config 注释里的约束逐条与实际代码对账（4 项复核全部正确）—— 这个「配置对账」做法值得保留。
- **命中率**：9 真 4 夸大 0 误报。**没有独有高价值新发现**，多数与 v1/v4/v5 重叠。
- **独有价值**：**骨架边跨海（A14）** 与 **DI 复用模式近邻语义（A16 的同族）**，以及那份配置核对清单。
- **短板**：两条 P0 一条夸大（A15）一条是重复项（A5）；篇幅最短，适合当索引用。

### review_v4 —「结构好、但结论最易过期」
- **范围**：引擎/服务端/前端 + 关联 09-12/09-13 实测日志数字（138ms 扫描、400 条≈16s、195.8ms region）。
- **方法**：★确认热点 / ▲需复核 / ◐低优先 三档，带「关联日志佐证」—— 分级语义清楚。
- **命中率**：4 真 4 夸大 **1 误报**（唯一一份有误报）+ **3 条已修复**（#1/#4/#7 的核心性能结论被 `ff6d476` 的 `demandCache` 直接消掉）。
- **独有价值**：**`SETTLE_CAP` 抖动（B8）**、**`GetRegionBytes` 不落库（C10）**、**DI 队列消费偏宽（A1 的同族）**、浮层锚点（D18）。
- **短板**：把「需求图每次重建」当成最大热点（#1，P0），但它是最先被修掉的一条；#11 是明确误报（属读代码不细）。**实测数字有价值，但核心性能判断衰减最快。**

### review_v5 —「唯一真跑了验证的」
- **范围**：含工作区未提交改动，逐文件 diff + 代码通读；附 §五「本次已执行/可复跑的命令」。
- **方法**：唯一一份**实际执行** `node verify/sync_preview_inline.mjs --check` 并贴出真实输出的；每条带 `文件:行` + 交互验证路径；§三「看着可疑但不是问题」（5 条，复核属实，含 `pb.js` repeated 写法、`Reader.bin()` 视图安全、`#sectMenu` 不被 `clip-path` 裁、`BuildOnce` 不自锁）。
- **命中率**：13 真 1 夸大 **0 误报**；唯一「已修复」是 #1（文档基于未提交态写的，合理）。
- **独有价值**：**预览/服务端路网分叉（E2）**、**region 包足迹三重成本（D15）**、**Json 取值风格硬故障（C12）**、**清库提示（F3）**、**verify 残留（F2）**。
- **短板**：16 条里 9 条与 v1/v2 重叠；`#1`、`#2` 都是围绕「未提交态」的时点问题，稳定性依赖提交时机。

### 横向结论
- **可信度排序**：v2 ≈ v5 > v1 > v3 > v4。
- **v1 的「已验证无问题」清单 + v2 的「已排查无问题」清单 + v5 的「看着可疑但不是问题」清单** 三份互不重复，合起来是一份很扎实的免检基线，建议保留。
- v4 的价值在实测数字，v3 的价值在配置对账，两者的「结论」都建议重新打点后再采信。

---

## 5. 建议处理顺序

**立即（P0，3 条）**
1. **A1** DI 闸拒绝边加负缓存/计数转正（`diCooldown: Map<rkey, roadVer>` 或直接计入 `roadFailTrials`；并把 drain 挪到主循环**之后**只吃剩余预算）—— 预览页渐进修路可用性直接受益。
2. **B1** 贸易扫描窗口 `±1` → `±2`，与 `demandEdgesFor` 对齐（改 2 个数字；已建世界需清库）。
3. **C1** `JsWorldVm` 加在途引用计数或「移出字典 + 延迟 Dispose」；`_maxSeeds` 补 `Math.Max(1, ...)`。

**本周（P1，14 条中的高价值项）**
4. **A2** `skeletonEdgesFor` 按 `(i,j)` 缓存（纯函数，随 `configure` 清）；顺手把 `:1046`/`:1237` 的「3x3」注释改成 5×5。
5. **A4** `roadTileIdx` 与 `roadCache` 同步淘汰（用路对象的 `tiles` 反向清）。**E1** 预览页清空按钮改调引擎侧统一清理入口。
6. **B5 / D15** region 包去掉城镇足迹（足迹只走 settle 包）—— 一刀同时消掉 B5、C11、D15。
7. **A5** `regionJson` 改有限预算 + 渐进补算；**C5** 把「改足迹 ⇒ 必 `BumpBlockRev`」写成显式契约或加 TODO 断言。
8. **D1** 重新内联 `_test_center.html`（或直接删掉这个 gitignored 的临时页）；**D2** `renderStaticInto` 开头补 `if (!pack.region) return;`。
9. **A10** 兜底 CFG 与 config 逐项同步（或 `init()` 里 `if (!global.MapGenConfig) throw`）—— 顺手修 `mapgen.js:48-50` 那句与代码矛盾的注释。

**性能专项（打包做）**
10. **D5 + D3 + D4**（静止功耗 + 小地图两处）为前端最大收益；**C6**（`Task.Run` 包一层 + `WaitAsync(ct)`）、**C4**、**C10**。

**择机（P2/P3）**
11. 其余按 touching 顺手带走：`A3`/`A13`/`F2` 是行级；`B3`/`B2` 改 salt 会变世界内容，合并到一次「世界重生成」发布；`F3` 写进改参数的提交说明。

---

## 6. 核验用到的关键命令（可复跑）

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/usr/bin:$PATH"
cd D:/codes/宗门模拟器demo

git log --oneline -14                                  # HEAD = ff6d476
git log --oneline -S "demandCache" -- Server/Zongmen/Engine/js/mapgen.js
                                                       # → 只有 ff6d476 ⇒ A11/A12 是提交后才被修的
node verify/sync_preview_inline.mjs --check            # → ✔ 全部同步（E3 已修复）

grep -n "roadClear\|resetRoadState" 灵脉预览.html        # E1
grep -n "function demandEdgesFor\|function roadsNear" verify/_test_center.html   # D1
grep -n "settlements" web/js/main.js web/js/pb.js      # D15
grep -n "_regionHot\|GetRegionBytes" Server/Zongmen/Services/MapWorldService.cs  # C10
```

---

## 7. 处理进展（2026-09-13 晚 · 执行记录）

> §5 的落地情况。⚠ 同一 worktree 当时有**两个会话并行**改 `Engine/js/mapgen.js`（见 `.workbuddy/memory/2026-09-13.md`
> 的并发事故记录）；本节只记录可归因的改动。工作区**尚未提交** —— 避免把并行会话的半成品一并提交。

### 已落地

| 编号 | 内容 | 关键文件 |
|---|---|---|
| A1 | DI 拒绝边负缓存 + drain 让位（并行会话完成） | mapgen.js |
| B1 | 贸易扫描窗口 ±1 → ±2（与 `demandEdgesFor` 对齐） | mapgen.js `tradeEdgesFor` |
| C1 | V8 在途引用计数（`VmLease`）+ `_maxSeeds = Math.Max(1,·)` + 淘汰跳过 `InFlight>0` | JsEngineHost.cs |
| A2 | `skeletonEdgesFor` 按 (i,j) 缓存（`skeletonCache`，随 init/configure 清） | mapgen.js |
| A3 | `trialBump`/`trialClear` + `ROADFAILTRIALS_CAP`（有界 + 转正即删） | mapgen.js |
| A4 | `roadSet()` 引用计数（`roadTileRef`），随 ROAD_CAP 淘汰回收 `roadTileIdx`（消幽灵路廊） | mapgen.js |
| A13 | 三处「3x3 池」注释改 5x5（`rngDominated` 池实际 ±2） | mapgen.js |
| A10 | 兜底 CFG 与 `mapgen-config.js` 逐项对齐 + 键集一致性 warn + 修 `:48-50` 矛盾注释 | mapgen.js |
| B2 | 同格双聚落中心去重（`usedCenters` / `pickCenterExcluding`） | mapgen.js |
| B3 | 同格双聚落 `pop`/`tier` 的 hash salt 含 k | mapgen.js |
| B5/D15/C11 | 区域包不再携带城镇足迹（只发骨架）；足迹唯一权威 = settle 包 | mapgen-server.js + MapWorldService.cs |
| C2 | `_roadVerCache` 加锁 + `ObserveRoadVer` 单调 max（防旧值回写） | MapWorldService.cs |
| C4 | `_regionPackCache` / `_settlePackCache`，免每请求重复 gzip 解压 | MapWorldService.cs |
| C5 | `BlockRevs.Bump` 用 `Interlocked.Increment` + 显式契约注释；维护循环按 live prefix 修剪 `_blockRev` | MapWorldService.cs |
| C6 | `Task.Run(() => GetTileBlock(...), ct).WaitAsync(ct)` | MapWsHandler.cs |
| C12 | `ReadBuildings`/`ReadResources` 改 `TryGetProperty`（缺字段不再中断整个 TileRequest） | MapWorldService.cs |
| D2~D16 | 前端：静态层脏门控 / 小地图窗口+尺寸 / AbortController 超时 / pb 越界校验 / 输入健壮性（blur·deltaMode·捏合锚点·mouseleave）/ 面板转义等 | web/js/* |
| E1 | 导出 `MapGen.resetRoads()`；预览页清空按钮改调它（内联副本已 sync） | mapgen.js + 灵脉预览.html |

### 有意未闭环 / 无需处理

- **A5**（region 首请求在 V8 门闩内阻塞 ~195.8ms）：`regionJson` 预算抽为常量 `REGION_ROAD_BUDGET = 9999`（仍 = 无上限）。
  单纯调小预算会让区域包**永久少路** —— `BlockRevs.Region` 只在显式 `BumpBlockRev` 时变化、**不随 roadVer 前进**，
  客户端不会自动重拉。要真正降阻塞必须配套「region rev 随道路增量前进 + 渐进补算」的跨 C#/前端契约改动，
  实测收敛后再落（本次不做，避免静默丢路）。
- **C10**（区域包不落库）：代码注释明示「区域行历史上只写不读，落库纯写放大」，属**设计取舍**，未改。
- **D1**（`verify/_test_center.html` 旧版副本）：该文件在当前磁盘上**不存在**（gitignored，早前已移除）⇒ 无需处理。
- **F2**（verify 残留脚本）：review 点名的 `_cdp_shot.mjs` / `_scratch_diag.mjs` 已不在未跟踪列表；
  现存 `_*.mjs` / `_old_mapgen.js` 等是**并行会话的在用工作文件**，未擅自删除。

### 验证结果（本机无 .NET SDK）

| 项 | 结果 |
|---|---|
| `node --check`（web/js 全部 + mapgen.js + mapgen-server.js） | ✔ |
| `verify/w5_sprite_range.mjs` | ✔ 全部通过 |
| `verify/w6_bldg_face.mjs` | ✔ 23/23 |
| `verify/sync_preview_inline.mjs --check` | ✔ 全部同步 |
| 预览页 4 段内联脚本 `vm.Script` 解析 | ✔ |
| `verify/w3_bfs_road.mjs` | 12/13；⑦（最慢单 region < 250ms 墙钟）FAIL |
| `verify_map` / `w1` / `w2` / `w4` / `frontend_smoke` | 未跑（需 `dotnet build` + 起服务） |

- **w3 ⑦ 说明**：本次 1190.4ms 与**并行会话改动前的独立记录（1138.9ms / 冷启合计 99358ms）同量级**，
  且墙钟受两会话并发占 CPU 影响 ⇒ **不是本轮改动的回归**；建议在安静工作树上重测并重标定 `TIME_BUDGET_MS`。
  其余 12 项（权重表 / 双预算上界 / 权重自洽 / 邻域剪枝 / 剪枝不改路径 / 确定性 / 建路率 97.9%）全 PASS，
  建成路 739 条与并行会话基线**逐一致** ⇒ 引擎语义未变。

### 提交前必做

1. `dotnet build Server/Zongmen/Zongmen.csproj -v q` 编译 C#（本机缺 SDK，未编译）。
2. 改了世界内容（B1/B2/B3/A10）⇒ **停服后把 `db/zongmen.sqlite*` 移出仓库再重启**，否则旧包优先回读、参数不生效。
3. 起服务跑 `verify_map.mjs` + `w1/w2/w4` + `frontend_smoke.mjs` 三层回归。
