# Tick 框架开发进度

> **本文件是 Tick 框架「落地形态」的唯一进度真源。**
> 设计文档：`docs/游戏时钟与Tick演化框架方案.md`（v2.1）
> 判据目录：`verify/`
> 开工日：2026-09-27

---

## 〇、一条铁律（先读这条）

**设计文档说「应该怎样」，本文件说「实际做成了怎样」。两者冲突时以本文件为准**，并回头修文档。

---

## 一、状态总览

| 期 | 内容 | 状态 |
|----|------|------|
| **P0** | spike：`IArrayBuffer` 句柄链路（7.4.5 可行性） | ⬜ 未做（被 P2 的「JSON 边界」整体绕开，见 §四 D6 ⇒ 已非必需） |
| **P1** | 时钟 + 三张表 + 相位 + **线程安全调度器** + L0 摊批 + 帧 7 接线 | ✅ **已完成** |
| **P2** | 无状态 VM 池 + protobuf 边界 + L1 四项 + rev/失效接线 | 🟡 **部分完成** —— 仅「城市演化」纵向切片；基础设施（VM 池 / proto 边界 / 双缓冲 / 消费队列）**全部未做**，见 §二.8 |
| **P3** | L2 道路 + 跨世界并行 + 快进 + 17 出口迁裸 proto | ⬜ 未开始 |

图例：⬜ 未开始 ／ 🟡 进行中 ／ ✅ 已完成 ／ ⚠️ 有已知坑 ／ ❌ 已放弃

> ⚠ **P2 的定性（本节最重要的一条）**：P1 是「框架」，P2 本应是「框架底层设施 + 四项演化」。
> 实际落地的是**后者的一条竖切**：`TownEvolve` + `TradeEdge` 端到端跑通、有台账、有判据；
> 而**前者（`TickVmPool` / protobuf 跨界 / 双缓冲快照 / `v8Queue`·`cpuQueue`）一条都没做**，
> 用「**复用读路径 VM + JSON string 边界 + 泵内联串行执行**」的简化形态替代。
> ⇒ 当前 tick 与人类请求**共用同一把 V8 `_gate`**（v2 §6.7 宣称的「零门闩争用」**尚未兑现**）。
> 逐条见 **§二.8 P2 销账**与 **§四 D4~D9**。

**P1 验收证据**（2026-09-27）
- 端到端：`/api/clock` 返回 `{"Tick":40,...,"Desc":"第1年 春 二月 十一日","Executor":"demo"}`；重启从存档 tick 续档（不是从 0）。
- 帧 7：`ws_clock_probe.mjs` 未登录直查 → 回帧 7 明文 protobuf，`(year,month,day,season)` 与 tick 自洽，1 tick/秒。
- 空转：`/api/clock/stats` 的 `peek == advanceCalls == tick 数`、`dispatched=0` ⇒ lazy 字面为真。
- 判据：`check_clock` / `check_tick_phase` / `check_tick_lazy` / `check_tick_queue_threadsafe` / `check_tick_job_persist` / `ws_clock_probe` / `frontend_smoke` 全绿。

**P2 落地证据（2026-10-10）—— 仅「城市演化」纵向切片**（详见 §二.8）
- 链路：`TickJobRegistry`（`TownEvolve`/`TradeEdge` spec）→ `MapWorldService.ProvideExpectedJobs`（演化窗口内每城 × 2 kind，60s 缓存）→ `TickVmPoolExecutor`（`/stats` 报 `executor=vmpool`）→ 引擎 `Engine/js/city-evo.js` 纯函数 → `CityStateStore` 落库 → `MarkSettleDirty` 推 rev。
- 台账：`Storage/CityStateStore.cs`（第三条独立表，PK `(Round,Id)`）；换世 `RemoveRound` 清空 —— ⚠ 防**跨世串味**（城 id 跨世会重名）。
- v4 建筑计划（2026-10-10）：`city-evo.js` 的 `planCityBuildings`（`cap = round(maxN × ratio^0.6)`；`lv∈[1,3]`；state `1`→cap=0、`3`→`cap×0.65`）**全纯派生**，不落库 / 不进 `townCache`；渲染 `settlePlanJson(i,j,overlay)`（无 overlay ⇒ 与旧 `settleJson` 逐字节等同）。
- 事件预留：`CityStateStore.ApplyShock(round,id,deltaPop,newState)` = **事件系统写演化的唯一入口**（暂无人调用）。
- 判据：`verify/evo/check_city_evo_integration.mjs`（G 同源 / H 生产路径 / I 红线）+ `verify/evo/city_evo_sim.mjs`（参数真源 + Δ铁律 + 4 红线）。

---

## 二、逐条销账（P1 任务清单 + P2 对账）

### 2.1 纯函数层（无依赖，可单测）

| # | 文件 | 内容 | 状态 |
|---|------|------|------|
| 1 | `Time/GameClock.cs` | tick ↔ 年/月/季/日 纯整数推导；墙钟换算；`MaxCatchUpTicks` | ✅ |
| 2 | `Time/PhaseHash.cs` | `fnv1a32` + `mix32`；`PhaseOf(seed, entityId, kind, period)` | ✅ |

### 2.2 数据形状

| # | 文件 | 内容 | 状态 |
|---|------|------|------|
| 3 | `Time/TickJob.cs` | `TickLayer` / `TickResource` / `TickJobKind` / `JobKey` / `TickJob` / `JobSpec` | ✅ |
| 4 | `Time/TickJobRegistry.cs` | `Kind → JobSpec` 静态表（读写集 + 引擎缓存声明）；`NewJob` 派生 `NextTick` + `Phase` | ✅ |

### 2.3 调度器（★ 本轮重点：线程安全）

| # | 文件 | 内容 | 状态 |
|---|------|------|------|
| 5 | `Time/ConcurrentTickQueue.cs` | `lock` + 二叉小顶堆 + 键索引；`Push`/`TryPeek`/`AdvanceTo`/`Reprioritize`/`TryRemove` | ✅ |
| 6 | `Time/TickScheduler.cs` | 门面：载入回灌 + `AdvanceTo` + `Enqueue` + 合流后重排（`Commit` / `Fail`） | ✅ |

**★ 线程安全的设计裁决（推翻 v2 原文）**
- v2 原文写「.NET `PriorityQueue` 非线程安全 / 无 decrease-key ⇒ 调度器必须单线程独占」。**已推翻**。
- 落地：自实现 `ConcurrentTickQueue`，任意线程可投递（`commitPlace`、对账、一次性事件都不必中转）。
- 守住的唯一纪律：**`AdvanceTo` 的「弹出 — 校验 — 吊销」在一次持锁内完成**，吊销哨兵 = `NextTick = long.MaxValue`。
- `decrease-key` 的缺失与线程安全无关（堆结构固有），仍走「弹出改键再入堆」。

### 2.4 三张独立表（⚠ 绝不进 `Data`）

| # | 文件 | 表 | 状态 |
|---|------|-----|------|
| 7 | `Time/WorldClockStore.cs` | `WorldClock(Seed, Round) → Tick, BornMono, LastSaveUtc` | ✅ |
| 8 | `Time/TickJobStore.cs` | `TickJob` 载入 / 批量 UPSERT / 对账三态 | ✅ |
| 9 | `Time/TickPerfStore.cs` | `TickPerf` 环形缓冲 + 每 30 tick 聚合落库 | ✅ |

⚠ 建表 / 打开方式**照 `Storage/WorldLedger.cs` 抄**（`Data Source={path};Pooling=True` + `PRAGMA busy_timeout=8000`，同步短连接）。

### 2.5 执行与指标

| # | 文件 | 内容 | 状态 |
|---|------|------|------|
| 10 | `Time/TickMetrics.cs` | 分段计时（gz/ser/xfer/`js`/apply）+ 环形缓冲 + P50/P95 | ✅ |
| 11 | `Time/TickResult.cs` | `TickOutcome` / `TickFailure` / `TickRunReport` | ✅ |
| 12 | `Time/TickPump.cs` | `BackgroundService`：1Hz 单调对齐 + catch-up 预算 + 到期收集 + 消费投递 + 合流推进 | ✅ |
| 13 | `Time/TickPartitioner.cs` | 独立性判定（写集 / RAW / WAR / 引擎缓存键）→ 批 | ✅ |
| 14 | `Time/TickBatch.cs` | 批（`TickId` / `Resource` / `Layer` / 规范序 `Jobs`） | ✅ |
| 15 | `Time/ITickExecutor.cs` | ★ 执行器抽象 —— P1 落地为**内联演示执行器**，P2 换成 `TickVmPool` | ✅ |

### 2.6 接线

| # | 文件 | 动作 | 状态 |
|---|------|------|------|
| 16 | `Server/Zongmen/Options.cs` | 加 tick 配置节（`TickEnabled` / `TickVmPoolSize` / `L0SpreadTicks` / `MaxCatchUpTicks` / `TickBudgetMs` / `TickFlushEvery` / `ReconcileEveryTicks` / `OfflineCatchUp`） | ✅ |
| 17 | `Server/Zongmen/Program.cs` | 注册 `WorldClockStore` / `TickJobStore` / `TickPerfStore` / `TickJobRegistry` / `ConcurrentTickQueue` / `TickScheduler` / `TickMetrics` / `ITickExecutor` / `TickPump`；`AttachTickPump`；关机 `UnbindWorld` | ✅ |
| 18 | `Server/Zongmen/Web/MapEndpoints.cs` | `GET /api/clock`（只读时钟，**前端绝不自造**）+ `GET /api/clock/stats`（调度器/指标观测） | ✅ |
| 19 | `Server/Zongmen/Web/MapWsHandler.cs` | 帧 7 = `ClockQuery`（请求）/ `ClockPush`（响应同号），**明文不 gzip**，**不鉴权**（时钟是世界公开事实） | ✅ |
| 20 | `Server/Zongmen/Services/MapWorldService.cs` | `StatsJson` 加 `tick / tickPendingJobs / tickIncomplete / tickMsP50 / tickMsP95 / tickExecutor` | ✅ |
| 20b | `Server/Zongmen/Domain/MapMessages.cs` | `WsFrame.ClockQuery/ClockPush = 7` + `ClockQueryRequest` / `ClockQueryResponse` 协议 DTO | ✅ |
| 20c | `web/js/pb.js` | `FRAME.CLOCK_QUERY/CLOCK_PUSH = 7` + `encodeClockQuery` / `decodeClockQueryResponse`（⚠ `Tick` 走 **ZigZag**） | ✅ |
| 20d | `web/js/mapclient.js` | 帧 7 解码分支 + `clockWaiters` + 公开 `clock()` 出口 | ✅ |
| 20e | `web/js/main.js` | `clockSyncLoop`：每 10 tick 校绝对 tick + `performance.now` 本地插值 → `#era` 显示「岁次X · 季 · 第N年」；换世清 `clockBase` | ✅ |

### 2.7 判据

| # | 判据 | 断言类型 | 状态 |
|---|------|----------|------|
| 21 | `verify/check_clock.mjs` | 恒等（360 值穷举 + 边界 + 前 5 年 + 负 tick 防御） | ✅ |
| 22 | `verify/check_tick_phase.mjs` | 统计 + 恒等（可复现 / **卡方**均匀 / 周期不变 / 源码守卫） | ✅ |
| 23 | `verify/check_tick_lazy.mjs` | 恒等（调用次数公式 + 空转 `Peek`==1 + 规模对照） | ✅ |
| 24 | `verify/check_tick_queue_threadsafe.mjs` | 并发不变量（真 8 线程 × 2000 job，无重复 / 无丢失 / 计数恒等） | ✅ |
| 25 | `verify/check_tick_job_persist.mjs` | 落库→载入 逐字段一致 + 幂等 + 一次性事件 + 7 条源码守卫 | ✅ |
| 25b | `verify/ws_clock_probe.mjs` | **端到端**（在线）：帧 7 明文非 gzip / 字段自洽 / 未登录可读 / 1 tick/秒 | ✅ |
| 25c | `verify/frontend_smoke.mjs`（扩充） | 帧 7 三处契约（pb.js ZigZag / mapclient 出口 / main.js 单调时基） | ✅ |
| 26 | `verify/check_tick_pb_roundtrip.mjs` | 交叉源（pben/pb/C# 三处） | ⬜ P2 |
| 27 | `verify/spike_v8_abuffer.mjs` | 可行性（P0 前置） | ⬜ P0 |

**P1 判据全绿**（7 条，其中 2 条是新增的端到端/前端契约）。⚠ **判据抓出 2 个真实生产 bug**（见 §五·10 / §五·11），不是「跑一遍就算」。

### 2.8 P2 销账（逐条，标注「落地 / 替代形态 / 未做」）

⚠ 按设计文档 §十一 的 P2 清单逐条对账。**结论：P2 的「基础设施」一条没做，「四项演化」只做了一半。**

| # | 设计要求的 P2 项 | 落地 | 实际形态 / 未做原因 |
|---|------------------|------|---------------------|
| P2-1 | `TickVmPool`：预热 S 个无状态 VM + 复用 in/out 缓冲 + 可 Drop | ⚠️ **替代形态** | **无 `TickVmPool` 类**。执行器直接 `MapWorldService.LeaseWorld(seed)` 借**读路径 VM**（= `JsEngineHost` 池，持 `_gate`）；无独立复用缓冲（仍走 JSON string）。`TickOptions.TickVmPoolSize` / `EffectiveVmPoolSize` / `UseReadPathVmForTick` **均无人读取（死配置）** |
| P2-2 | `TickMetrics` 分段计时（gz/ser/xfer/js/apply） | 🟡 **部分** | 有 `BeginJs` / `BeginApply` 分段 + 环形缓冲 + P50/P95；无 gz/xfer（因边界仍是 JSON，见 D6） |
| P2-3 | protobuf 跨界：`pben.js` + `CallBytes` + 裸 proto | ⬜ **未做** | 边界仍是 `(string)_svc.xxxJson(...)`。`pben.js` / `CallBytes` **不存在**（`ITickExecutor.cs` 头注释仍把它列为 P2 计划）。⚠ 连带 **P0 spike 已无必要** |
| P2-4 | 双缓冲快照 + `WorldPatch` 定序合并 + `v8Queue`/`cpuQueue` 消费队列 | ⬜ **未做** | 无 `Channel<...>`、无 `WorldPatch`、无快照。泵**内联执行**：`执行器.Execute → 立刻 ApplyOutcome`（`TickPump.RunOneTick`）。且 `ConcurrentExecution` **默认 false** ⇒ `TickPartitioner` 每批做成单元素 `Serial` ⇒ **当前实质串行** |
| P2-5 | L1 四项 | 🟡 **2/4** | `TownEvolve` ✅ / `TradeEdge` ✅（批级，`SettleTrade`）；`Reputation` ⬜（`JobSpec` 在册但**无执行器认领** ⇒ 投递即 `not-claimed`）；迁移层 `migrateEdgesJson` 引擎有出口但 **C# 无调用方** |
| P2-6 | `BumpBlockRev` + `forceStaticDirty` + `invalidate*` 三件接线 | 🟡 **1.5/3** | `MarkSettleDirty` = `EvictWithGate` + `BumpBlockRev(Settle\|Poi)` ✅（`PersistRow` 每次演化后调）；`forceStaticDirty` 未用（旧名已废）；`invalidate*` 失效出口 ⬜ **未做**（靠「落库包覆盖 + EvictWithGate」绕开读路径 VM 陈旧，见 D7） |
| P2-7 | 引擎演化参数走扩展层（`$base + evoIn`，保住 `$base` 逐字节不变） | ⚠️ **已绕开** | v4 改由 `planCityBuildings` **纯派生**（骨架逐字节不变，只改「哪几栋被点亮 + 每栋几级」），**不落库 / 不进 `townCache`** ⇒ 无需 overlay |
| P2-8 | `PlayerSect` 参与 tick；一次性事件立即落库 | 🟡 **半** | `PlayerSectStore` 台账在，但 **tick 不读写它**（`ProvideExpectedJobs` 只枚举引擎聚落）；一次性事件存储机制 ✅（`TickJobStore.UpsertImmediate`），但**尚无 kind 用它** |
| P2-9 | 判据：`check_tick_determinism` / `check_tick_rev` / `check_tick_no_pollute` | 🟡 **换源** | 未建这三个文件名；实际判据落在 `verify/evo/`：`check_city_evo_integration.mjs`（G 同源 / H 生产路径 / I 红线）+ `city_evo_sim.mjs`（Δ 铁律 + 红线） |

⚠ **连带发现的死代码 / 死配置**（P3 开工前要么接线、要么删，别让它继续骗人）：

- `TickOptions.EvolveMaxCitiesPerTick`（防超预算的硬上限）**从未被读取**；`TickVmPoolSize` / `UseReadPathVmForTick` 同上。
- `TickVmPoolExecutor._migrations`（迁移计数）**只声明、从不自增**（无迁移逻辑）。

---

## 三、开工前核实到的硬事实（本轮）

| 事实 | 依据 |
|------|------|
| 项目为 **.NET 8**，`TargetFramework=net8.0`，`Microsoft.ClearScript.Complete 7.4.5` | `Zongmen.csproj` |
| `Server/Zongmen/Time/` 目录**此前不存在**，本轮新建 | `ls` |
| `WorldLedger` 是「独立台账表」的唯一范本（同步短连接 + `Pooling=True`） | `Storage/WorldLedger.cs` |
| `WsFrame` 1~6 已占，**7 号被 P2「城市迭代」预留** ⇒ 本轮 clock 帧正好落在 7 | `Domain/MapMessages.cs` |
| `TileResponse` 恒 gzip、Place 系帧明文 ⇒ 「按帧类型判压缩」是既有惯例 | `Web/MapWsHandler.cs` |
| `MapWorldService` 有 `_maintTask`（2 分钟周期）—— tick 泵**不复用它**，独立 1Hz | `Services/MapWorldService.cs` |
| 既有 `PruneExcept` 只清 `Data` 表 ⇒ 三张 tick 表必须独立 | `MEMORY.md` 全局节 |

---

## 四、落地形态与文档的差异（必须回写文档的部分）

| # | 文档说法 | 实际落地 | 差异原因 |
|---|----------|----------|----------|
| D1 | 调度器必须单线程独占 | `ConcurrentTickQueue` 线程安全，任意线程可投递 | 用户点破；见 §2.3 |
| D2 | P1「先用读路径 VM 串行跑」 | 引入 `ITickExecutor` 抽象，P1 落 `DemoTickExecutor`（**纯托管、不碰 V8**） | P1 的目标是「时钟链路可验证」，V8 边界属 P2。抽象层让 P2 只换实现 |
| D3 | `TickPump` 只「宣布第 N 天到了」 | P1 的泵**同时负责执行与合流**（因为 P1 无批间并发） | P2 引入 `v8Queue`/`cpuQueue` 后再拆 |
| D4 | 新建 `TickVmPool`（与 `JsEngineHost` 并列，S 个无状态 VM，**零门闩争用**） | 执行器**复用读路径 VM**（`MapWorldService.LeaseWorld`） | 简化落地、省一份引擎常驻内存。⚠ 代价：tick 与人类请求**共用 V8 `_gate`**，v2 §6.7 的「零争用」**未兑现**（见 §五·17） |
| D5 | `v8Queue`/`cpuQueue` 两条 Channel + 双缓冲快照 + `WorldPatch` 定序合流 | 泵**内联执行** + 立刻 `ApplyOutcome`；`ConcurrentExecution=false` ⇒ 分批器只产单元素批 | P2 只跑单城演化、量小，无需拆。⚠ 代价：并行/VM 池收益未兑现，「合流顺序与到达顺序无关」这条纪律在单线程下**天然满足**（P3 一开并行就必须补） |
| D6 | protobuf + `ArrayBuffer` 跨界（不过 string） | **JSON string 边界**（`(string)_svc.xxxJson(...)`） | 演化每城仅 3 次 `Call`，JSON 够用且省一次 pb 编解码。⚠ 连带 P0 spike 无意义；§八 的 `t_xfer/t_gz` 分段无数据可测 |
| D7 | 新增 `invalidate*` 引擎失效出口（`TryGet` 不 `GetOrCreate`） | **未做** —— 靠「落库 settle 包覆盖 + `EvictWithGate`」绕开 | settle 包是落库的，包新则块响应对；失效出口只为 `tileJson`/`regionJson` 即时路径兜底，而那条路径 P2 未接 ⇒ 降级为「暂不需要」 |
| D8 | `PlayerSect` 参与 tick（拓土成本 / 气运累积） | 只演化**引擎聚落**；玩家宗门仅做 `ext` 层重放（`InjectPlayerSects`） | 玩家宗门的 tick 演化语义尚未定义 |
| D9 | L1 四项 | **2 项**（`TownEvolve` / `TradeEdge`） | `Reputation` 无可写入口；迁移层（`migrateEdgesJson`）留待 v3 |

---

## 五、已知坑与守卫（写代码时对照）

1. ⚠ **`NextTick` 吊销哨兵**：`AdvanceTo` 收集后置 `long.MaxValue`。否则并行重排 ⇒ 同一 job 收集两次。
2. ⚠ **相位绝不重置**：对账「只增删不重置」，已有行的 `Phase` / `NextTick` 不许被覆盖。
3. ⚠ **相位绝不用运行时 RNG**：必须 `f(seed, entityId, kind)` 派生，否则重启不确定。
4. ⚠ **`dt` 积分**：`JobSpec` 必须带 `DtTicks = nowTick - LastRunTick`；漏了 = 演化速度随机快慢 M 倍（**不报错**）。
5. ⚠ **失败不推进周期**：`失败 ⇒ NextTick = now + BackoffTicks`，**不是** `+Period`；连续失败 `MaxFails` 次 ⇒ `Enabled=0` + 日志（绝不静默停摆）。
6. ⚠ **红线 1**：tick 只写可变派生层，绝不写 `chunk` / `settleCache` / `siteScoreCache` / `regionCache`。
7. ⚠ **红线 2**：道路重算不进 tick VM 池（`roadCache` 不可从 seed 重建）。
8. ⚠ **catch-up 有预算**：超预算宁可世界慢，绝不雪崩式追补。
9. ⚠ **时基必须单调**：`Stopwatch.GetTimestamp()` / `Environment.TickCount64`，**绝不用 `DateTime.UtcNow`**。前端同理 —— `clockNowTick` 主基准是 `performance.now()`（`Date.now()` 只在 performance 不可用时兜底）。
10. ⚠⚠ **★ 哨兵溢出（判据抓出的真实生产 bug）**：`CommitSuccess` 若在 `NextTick` **仍是哨兵**时去算下一跳（如 `long.MaxValue + Period`），会**整数溢出成负数** ⇒ 命中兜底分支 ⇒ 下一次到期是随机负数 ⇒ job 立刻被再收集 ⇒ 相位彻底错乱（间隔出现 8/12/46/342 这种不规则值）。**不报错，只是演化节奏乱掉**。
    - **正解**：`job.NextTick = nowTick + job.PeriodTicks`（复位哨兵 + 严格 += Period，**不读旧值**），且在 `NextDue` 加防御 `if (NextTick >= RevokedTick - PeriodTicks) return nowTick + PeriodTicks;`。
    - 守卫：`check_tick_job_persist.mjs` F6 + `check_tick_lazy.mjs` B5。
11. ⚠⚠ **★ 相位钥匙必须用线上名（判据抓出的真实生产 bug）**：`PhaseHash` 派生的 kind 参数必须用 `KindNames.Of(kind)`（线上名，如 `demoHeartbeat`），**绝不能用 `kind.ToString()`（枚举名，如 `DemoHeartbeat`）** —— `TickJobStore` 落库存的是线上名，对账/重建要按同一把钥匙复现同一相位。**改个枚举成员名就会让全世界的相位漂移且不报错。**
    - 守卫：`check_tick_job_persist.mjs` F5 + `check_tick_queue_threadsafe.mjs` F15。
12. ⚠ **`Load` 只取 `Enabled=1`**：停用的 job 不该在重启后复活（否则失败 job 无限重试）。`check_tick_job_persist.mjs` F7 钉死。
13. ⚠ **相位分布不能用「max/min 桶比」**：该度量随样本量剧烈波动（N=2000 落 90 桶时 2.6 属正常采样方差）。**必须用卡方检验**（χ² vs df），见 `check_tick_phase.mjs` B。
14. ⚠ **换世必须先清 `clockBase`**：否则新世界头几秒继续显示旧世界年份（「换了世界时间却没换」，静默错）。
15. ⚠ **前端时钟绝不清零**：校准失败只停更、保留旧显示 —— 显示旧值远好于显示「0 年」/空白。
16. ⚠ **帧 7 明文不 gzip**：时钟包 < 64 B，压缩净亏；且「按帧类型判压缩」是既有纪律，混用会让客户端解错。

**P2 新增（2026-10-11 回写）**

17. ⚠⚠ **P2 执行器复用读路径 VM** ⇒ 走 `JsEngineHost` 的 `_gate` ⇒ tick 与人类请求**互相阻塞**。演化窗口 `EvolveSpanRegions` 调大 / 城变多时，会明显拖慢 `tile`/`region` 请求。**P3 必须有独立 VM 池（v2 §6.7）才能解**，否则「零争用」永远只是纸面承诺。
18. ⚠ **`ConcurrentExecution` 默认 `false`** ⇒ `TickPartitioner.CanJoin` 的四条件判定根本不会走到并行路径，每批都是单元素 `Serial`。**别以为分批器在并行**——它当前只是「按规范序分组」，不是并发。
19. ⚠ **`Reputation` job 无执行器认领** ⇒ 一旦它到期进批，`TickVmPoolExecutor` 回 `not-claimed` ⇒ 反复失败 ⇒ 退避 / 停用。当前 `ProvideExpectedJobs` 只排 `TownEvolve`/`TradeEdge`（安全），但**扩 provider 前先确认有执行器认领**。
20. ⚠ **跨世串味**：城 id `{i}_{j}_u{n}` **跨世会重名** ⇒ 换世**必须** `CityStateStore.RemoveRound(旧 round)`（`BindCurrentWorldToTick` 已做）；漏了就是「新世第 0 天的城带着上一世几十年的人口继续跑」，且**不报错**。
21. ⚠ **死配置 / 死计数器**：`EvolveMaxCitiesPerTick`（硬上限）、`TickVmPoolSize`、`UseReadPathVmForTick`、`TickVmPoolExecutor._migrations` —— **均未被读取/自增** ⇒ 改它们不会有任何效果。P3 开工前要么接线、要么删。

---

## 六、变更日志

| 日期 | 变更 |
|------|------|
| 2026-09-27 | 立文件。P1 开工：纯函数层 / 数据形状 / 线程安全调度器 / 三张表 / 指标 / 泵 / 分批器 / 接线（`Options` + `Program` + `/api/clock`）/ 四条判据。文档同步修订为 v2.1（R11 推翻「单线程独占」）。 |
| 2026-09-27 | **P1 收尾（第二轮）**：① 帧 7 全链路打通（`MapMessages` DTO + `MapWsHandler.HandleClockAsync` + `pb.js` 编解码 + `mapclient.clock()` + `main.js` 时钟显示 + `Program` 传 pump）；② `MapWorldService.StatsJson` / `MapEndpoints` 销账；③ `TickPump.Stats()` 的 `perfRows` 写死 0 改为 `_perfStore.WrittenRows`（注入 `TickPerfStore`）；④ 新增 `check_tick_job_persist.mjs`（25 断言）+ `ws_clock_probe.mjs`（18 断言，端到端）；⑤ `frontend_smoke.mjs` 扩充帧 7 三处契约；⑥ 进度文件 §2.6/§2.7 销账 + §五 补 7 条守卫。**P1 全部 ✅**，7 条判据全绿。 |
| 2026-10-10 | **P2 融入（纵向切片）**：`TickVmPoolExecutor` + `Storage/CityStateStore`（第三条独立表）+ 引擎 `city-evo.js` 融入 + `verify/evo/` 判据（G 同源 / H 生产路径 / I 红线）；v4 建筑计划 `planCityBuildings`（纯派生）+ `ApplyShock` 事件入口。⚠ 无状态 VM 池 / protobuf 边界 / 双缓冲 / 消费队列**均未做**。 |
| 2026-10-11 | **回写 P2 销账**：§一 状态改为 🟡 部分完成（并加定性说明）；新增 §二.8（逐条对账，标出「替代形态 / 未做 / 死配置」）；§二.7 追加 P2 落地证据段；§四 补 D4~D9（P2 与设计的六处背离）；§五 补 17~21（P2 新坑与死配置）。 |
