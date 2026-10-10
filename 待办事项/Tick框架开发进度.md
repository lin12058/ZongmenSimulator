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
| **P0** | spike：`IArrayBuffer` 句柄链路（7.4.5 可行性） | ⬜ 未做 |
| **P1** | 时钟 + 三张表 + 相位 + **线程安全调度器** + L0 摊批 + 帧 7 接线 | ✅ **已完成** |
| **P2** | 无状态 VM 池 + protobuf 边界 + L1 四项 + rev/失效接线 | ⬜ 未开始 |
| **P3** | L2 道路 + 跨世界并行 + 快进 + 17 出口迁裸 proto | ⬜ 未开始 |

图例：⬜ 未开始 ／ 🟡 进行中 ／ ✅ 已完成 ／ ⚠️ 有已知坑 ／ ❌ 已放弃

**P1 验收证据**（2026-09-27）
- 端到端：`/api/clock` 返回 `{"Tick":40,...,"Desc":"第1年 春 二月 十一日","Executor":"demo"}`；重启从存档 tick 续档（不是从 0）。
- 帧 7：`ws_clock_probe.mjs` 未登录直查 → 回帧 7 明文 protobuf，`(year,month,day,season)` 与 tick 自洽，1 tick/秒。
- 空转：`/api/clock/stats` 的 `peek == advanceCalls == tick 数`、`dispatched=0` ⇒ lazy 字面为真。
- 判据：`check_clock` / `check_tick_phase` / `check_tick_lazy` / `check_tick_queue_threadsafe` / `check_tick_job_persist` / `ws_clock_probe` / `frontend_smoke` 全绿。

---

## 二、P1 任务清单（逐条销账）

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

---

## 六、变更日志

| 日期 | 变更 |
|------|------|
| 2026-09-27 | 立文件。P1 开工：纯函数层 / 数据形状 / 线程安全调度器 / 三张表 / 指标 / 泵 / 分批器 / 接线（`Options` + `Program` + `/api/clock`）/ 四条判据。文档同步修订为 v2.1（R11 推翻「单线程独占」）。 |
| 2026-09-27 | **P1 收尾（第二轮）**：① 帧 7 全链路打通（`MapMessages` DTO + `MapWsHandler.HandleClockAsync` + `pb.js` 编解码 + `mapclient.clock()` + `main.js` 时钟显示 + `Program` 传 pump）；② `MapWorldService.StatsJson` / `MapEndpoints` 销账；③ `TickPump.Stats()` 的 `perfRows` 写死 0 改为 `_perfStore.WrittenRows`（注入 `TickPerfStore`）；④ 新增 `check_tick_job_persist.mjs`（25 断言）+ `ws_clock_probe.mjs`（18 断言，端到端）；⑤ `frontend_smoke.mjs` 扩充帧 7 三处契约；⑥ 进度文件 §2.6/§2.7 销账 + §五 补 7 条守卫。**P1 全部 ✅**，7 条判据全绿。 |
