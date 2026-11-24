# 代码审查 · 最近提交 bug 清单

> 审查日：2026-10-11
> 审查范围：`c22ae7c`(10-10 P2 城市演化 v4 + 世界时钟 Tick 框架落地)、`709c325`(10-11 Core/Subsystems 分层落地 + Characters 子系统)，**外加工作区未提交的人物分布层 WIP**（`MapMessages.cs` / `MapWorldService.cs` / `MapWsHandler.cs` / `TickPump.cs` / `TickJobStore.cs` / `TickOptions.cs` / `web/js/*`）。
> 方法：静态精读 `Server/Zongmen/{Engine,Time,Services,Web,Subsystems}` + `web/js/{main,pb,people-layer}.js` + `City/js/city-evo.js`，逐条交叉验证调用点（`grep` 确认无第二处 re-arm / 无调用者）。
> 严重度：**P0** 静默数据丢失/永久停摆 ｜ **P1** 静默错误（需特定路径）｜ **P2** 资源泄漏/性能/契约脆弱 ｜ **P3** 死代码/诊断失真/文档漂移。

---

## 〇、结论摘要

| ID | 严重度 | 位置 | 一句话 |
|----|--------|------|--------|
| **T1** | **P0** | `Time/TickPump.cs:244-268` | 预算闸 `break`（或执行器抛异常）后，**已收集未执行**的 job 永久吊销（`NextTick=long.MaxValue`）⇒ 那些城**永久停止演化**，对账也救不回来 |
| **T2** | **P1** | `Time/TickJobStore.cs:186-208` | `Flush()` 先清脏集再落库 ⇒ 中途异常时脏行已丢，调用方日志「下轮重试」是**假的** |
| **T3** | **P1** | `Time/TickPump.cs:210-215, 277` | catch-up 用 `due.Count > 0` 判「是否落后」⇒ 稀疏 job 的世界**永远追不上**，`MaxCatchUpTicks` 形同虚设 |
| **T4** | **P1** | `Subsystems/City/CityTickExecutor.cs:325-333` | 演化落库走逐行 `Put`（每次开连接 + 独立事务），与 `PutRange` 注释「逐行会把 WAL 打满」**自相矛盾** |
| **T5** | **P2** | `Engine/JsVmPool.cs:177-183` | `_onCreated` 回调抛异常 ⇒ 新建的 V8 既不 `Exit` 也不 `Dispose`（原生内存泄漏 + `_inFlight` 永久为 1） |
| **T6** | **P2** | `Services/MapWorldService.cs:80,873-934` | `_peopleCache` **没有任何失效钩子**；人口随 tick 演化后热力图永久显示旧人数，`BlockRevs.Bump` 的注释只提示挂 rev、漏了清 LRU |
| **T7** | **P2** | `Subsystems/City/CityTickExecutor.cs:331-332` | `PersistRow` 用 `CurrentSeed()` 而非 job 的 seed ⇒ 换世竞态下给新世打脏；`CurrentSeed()` 为 null 时写出 `blk::i:j` 空前缀 key |
| **T8** | **P3** | `Time/ConcurrentTickQueue.cs:250-256` | 「在途副本」分支是**死代码**（`MaxValue <= nowTick` 恒 false）⇒ `duplicateSuppressed` 永远 0，诊断指标失真 |
| **T9** | **P3** | `Time/TickPump.cs:57-59` | `_joinGate` / `_pendingTicks` 是死字段 —— 而「在途批」跟踪正是 T1 缺失的那一环 |
| **T10** | **P3** | `Time/TickPump.cs:261,263` | `report.Skipped > 0` 被当成「超预算」⇒ `incompleteTicks` 虚增；`BeginApply(batch.Jobs[0].Kind)` 把整批 apply 耗时记到第一个 kind 头上 |
| **T11** | **P3** | `Time/TickScheduler.cs:118` vs `TickJobRegistry.cs:178-196` | `NextDue`（能正确对齐相位）**无任何生产调用者**，实际用 `nowTick + Period` ⇒ 落后场景下相位相对漂移 |
| **T12** | **P3** | 多处 | 常量/文档漂移：`main.js:292` 注释仍写「31 & ~1 = 30」；`MapMessages.cs:345` 的 `LastRevs` 注释漏 People；`verify/check_calc_local.mjs:235,246` 断言 `maskEff===30/31` 只在 people 开关默认关时侥幸成立 |

---

## 一、P0 — 会让世界静默停摆（先修这个）

### T1. 预算闸 break 后，已吊销的 job 永不重排

**位置**：`Server/Zongmen/Time/TickPump.cs:242-277`（配 `ConcurrentTickQueue.AdvanceTo:230-274`）

**链路**：

```csharp
var due = _sched.AdvanceTo(nowTick);        // ① 弹出=吊销：NextTick ← RevokedTick(long.MaxValue)
if (due.Count > 0) {
    var batches = _partitioner.Partition(due, nowTick);
    foreach (var batch in batches) {
        if (elapsedMs > _opt.TickBudgetMs) { budgetExceeded = true; break; }   // ② 剩余批直接丢
        var report = _executor.Execute(batch, nowTick, _metrics, CancellationToken.None);
        foreach (var outcome in report.Outcomes) ApplyOutcome(outcome, nowTick, b);  // ③ 只有这里才 Reprioritize
    }
}
```

- `AdvanceTo` 把**所有** `NextTick <= nowTick` 的 job 弹出、填 `DtTicks`、置 `NextTick = RevokedTick` 再塞回堆（`ConcurrentTickQueue.cs:262-267`）。注释明确写着「NextTick 推进不在这里做 —— 必须等合流 apply 成功后才推进」。
- 一旦 ② 的 `break` 命中（默认 `TickBudgetMs = 300`，城市演化批含 V8 + A*，超预算并不罕见），后面那些批的 job **既没执行、也没有 `CommitSuccess`/`Reprioritize`** ⇒ 它们的 `NextTick` 永远停在 `long.MaxValue`。
- 之后每一次 `AdvanceTo` 的循环条件 `_heap[0].NextTick <= nowTick` 都把它们排除在外（MaxValue 沉在堆底）⇒ **再也不到期**。
- ③ 之外的同类路径：`_executor.Execute` 抛异常时（`RunOneTick` 内没有 try）异常冒到 `ExecuteAsync` 的 catch 被吞，`due` 里尚未 apply 的 job 同样被永久吊销。

**为什么对账救不回来**：

- `TickJobStore.Reconcile` 只对 `existing` 里**不存在**的 key 补行；这些 job 的 DB 行还在（`Enabled=1`，即 `Load` 可见）⇒ 判为 existing ⇒ 不会被重加。
- `MaybeReconcile` 的补灌条件 `expected.Where(j => !have.Contains(j.Key))`，而 `have = _sched.Queue.Snapshot()` **包含**这些吊销 job（它们还在堆里）⇒ 也不会被重新入队。
- 只有 `BindWorld`（重启 / 换世）里的 `_sched.Reset()` 才会清掉这个状态。

**触发条件**：任意一次单 tick 执行超过 300ms（冷 VM、城市数量上涨、A* 抖动、debugger/GC 停顿），或任意一次执行器异常。

**建议修法**：`break` / catch 时把 `due` 中尚未 apply 的 job 逐条按其**原** `NextTick`（或 `nowTick + 1`）`Reprioritize` 回队列。`_pendingTicks`（见 T9）正好就是为这个场景预留的容器，建议直接启用。核心不变量应写成：**「被 `AdvanceTo` 收集的 job 必然在本次 `RunOneTick` 结束前被 re-arm（成功推进 / 失败退避 / 顺延）」**。

> 注：`TickPump` 的类注释声称「预算超了 ⇒ 未完成部分顺延」，但代码里没有任何顺延动作 —— 注释与实现不一致，也印证这是遗漏而非设计。

---

## 二、P1 — 静默错误（需特定路径）

### T2. `Flush()` 清了脏集才落库 ⇒ 「下轮重试」是假的

**位置**：`Server/Zongmen/Time/TickJobStore.cs:186-286`；调用方 `TickPump.cs:334-349`

```csharp
lock (_gate) {
    if (_dirty.Count == 0 && _deleted.Count == 0) return 0;
    jobs = _dirty.Values.ToList();
    deleted = _deleted.ToList();
    _dirty.Clear();          // ← 先清
    _deleted.Clear();
}
if (_cs == null) { ... }
using var c = Open();        // ← 之后任何一步抛异常，脏行已经没了
using var tx = c.BeginTransaction();
... ExecuteNonQuery(); tx.Commit();
```

`MaybeFlush` 的 catch 里打印 `"flush 失败 @tick={Tick}（下轮重试）"` —— **内存里已无待写行，下轮没有任何东西可重试**。丢失的是 `NextTick / FailCount / Enabled / LastRunTick` 的持久化更新：重启后读回旧值，`FailCount` 归零会重新走失败循环、`LastRunTick` 失真会让首次 Δt 算错。

**建议修法**：落库成功后再清脏集；或在 `catch` 里把 `jobs` / `deleted` 合并回 `_dirty` / `_deleted`（保证 at-least-once）后再抛出。

### T3. catch-up 用 `due.Count > 0` 当「是否落后」

**位置**：`TickPump.cs:210-215`（循环）+ `:277`（`return due.Count > 0;`）

```csharp
while (caughtUp < _opt.MaxCatchUpTicks && !stoppingToken.IsCancellationRequested) {
    var advanced = RunOneTick();
    caughtUp++;
    if (!advanced) break;      // advanced == (due.Count > 0)
}
```

语义应是「本秒是否落后于墙钟」。但实现返回「本轮有没有到期 job」。后果：进程停顿 K 秒后，若落后位置的**第一个 tick 恰好没有到期 job**（L0 摊批 30、TownEvolve 90、TradeEdge 30 ⇒ 绝大多数 tick 是空的），循环立刻 break ⇒ 每秒只补 1 tick ⇒ **永远追不上**，`MaxCatchUpTicks = 4` 从未真正生效。

**建议修法**：在 `BindWorld` 记下「绑定时刻的墙钟 + tick」，用 `应到 tick = 绑定tick + 经过秒数` 与 `_currentTick` 比较来判断落后；或直接以 `wait` 是否 > 一秒为信号。

### T4. 演化落库逐行 `Put`，与 `PutRange` 的设计意图相反

**位置**：`CityTickExecutor.cs:131`（`if (rowJson.Length > 0) PersistRow(round, rowJson);`）→ `:325-333` → `CityStateStore.cs:200-211`

`CityStateStore.Put` 每次 `Open()` 一条连接 + 一次隐式事务。而 `PutRange` 的注释写着：

> 「**必须成批**：逐行各自开事务在 90 tick × 数百城的量级上会把 WAL 打满；而且批中途失败会留下『半批已演化』的不一致状态。」

演化主路径恰恰是逐行 `Put`。相位抖动（`PhaseHash`）让每 tick 只到期约 1/30 的城，所以现在没炸；但调小 `L0SpreadTicks`/放大 `EvolveSpanRegions` 或城数上涨后就会踩中。

**建议修法**：`Execute` 里按批收集 `CityStateRow`，执行完一次 `PutRange`（一次事务）。注意 `SettleTrade` 已经用了 `PutRange`，可直接复用该口径。

---

## 三、P2 — 资源泄漏 / 性能 / 契约脆弱

### T5. `GetOrCreate` 里 `_onCreated` 抛异常 ⇒ V8 实例泄漏

**位置**：`Engine/JsVmPool.cs:177-183`

```csharp
var created = new JsVm(module, module.BuildBundle(), seed);
created.Enter();                     // _inFlight = 1
_onCreated?.Invoke(created, module); // ← 抛异常则直接向上抛
```

回调注释说「回调抛异常 ⇒ 直接向上抛（宁可这一次请求失败，也不要丢了玩家资产的世界）」—— 抛是对的，但抛之前没有 `created.Exit(); created.Dispose();`。`V8ScriptEngine` 持有非托管内存且没有可靠的终结器，这次失败的冷启会泄漏一个完整 V8 实例（引擎在 `new JsVm` 里已经 `Evaluate(bundle)` 过）。

**建议修法**：
```csharp
try { _onCreated?.Invoke(created, module); }
catch { created.Exit(); created.Dispose(); throw; }
```

### T6. `_peopleCache` 无失效钩子；rev 提示只说了一半

**位置**：`Services/MapWorldService.cs:80`（LRU 1024）、`:873-934`（Build）、`:368-372`（MarkSettleDirty）、`:723-725`（BlockRevs.Bump 注释）

- 现状注释认为 People 层是「(seed, 区块) 的纯函数、内容永不变化」——**但它的输入（聚落人口）恰恰会随 tick 演化**（城市 v4 已落地）。一旦人口变化，进程内 LRU 会一直返回旧热力图，而**没有任何代码去清它**。
- `BlockRevs.Bump` 里那条提醒只写了「一旦人物分布开始吃 tick 演化，这里就是第一处必须挂上的钩子」—— **漏了第二处**：挂了 rev 只解决「客户端重拉」，服务端 `_peopleCache.Get` 仍会命中旧包。两处都挂才算闭环。
- 附带：`resp.People = BuildPeopleLayer(...)` 把**缓存对象本身**挂进响应（与 `_regionPackCache` 同款「只读共享」假设）。将来若有人在响应侧改 `Tiles` 会污染缓存 —— 建议至少加注释钉住这条不变量。

**建议修法**：在 `MarkSettleDirty` 内同步清 `_peopleCache` 对应块（`"ppl:" + prefix + ":" + ca + ":" + cb`，或按前缀粗粒度清），并把 `BlockRevs.Bump` 的注释补成「rev + LRU 两处」。

### T7. `PersistRow` 用 `CurrentSeed()` 而非 job 的 seed

**位置**：`CityTickExecutor.cs:325-333`

```csharp
var (i, j) = RegionOf(row.Id);
if (i.HasValue) _world.MarkSettleDirty(_world.CurrentSeed() ?? "", i.Value, j!.Value);
```

- 若换世发生在 job 执行期间，`CurrentSeed()` 已是**新世** ⇒ 给新世某块打了脏 rev（该块内容并未变化 ⇒ 客户端白拉一次；更糟的是 `EvictWithGate` 会用新 seed 去删新世的缓存包）。
- `CurrentSeed()` 返回 null 时写出 `seed=""` ⇒ `BumpBlockRev` 生成 `blk::<i>:<j>` 这种空前缀 key，而 `MaintenanceLoopAsync` 的裁剪只认 `blk:<16位hex>:`，这条 key 会**永久滞留**。

**建议修法**：用 `row.Round` / job 的 `seed` 对齐（`PersistRow` 需要拿到 seed 参数），并在 seed 为空时直接跳过脏块通知。

---

## 四、P3 — 死代码 / 诊断失真 / 文档漂移

### T8. `AdvanceTo` 的「在途副本」分支恒不可达

`ConcurrentTickQueue.cs:246-256`：循环入口条件是 `_heap[0].NextTick <= nowTick`，而分支条件是 `job.NextTick == RevokedTick (long.MaxValue)` —— 两者不可能同时成立（`nowTick` 是游戏 tick，远小于 MaxValue）。所以该分支是**死代码**，`_duplicateSuppressed` 永远是 0（`/stats` 里这个诊断项失去意义）。实际去重靠「MaxValue 沉底 + `Reprioritize` 复位」。建议删掉该分支与计数，或修正不变量描述。

### T9. `_joinGate` / `_pendingTicks` 是死字段

`TickPump.cs:57-59` 声明后全程无读无写（`grep` 确认）。它们注释写着「为 P2 的异步合流预留」，但**在途批/已收集未执行 job 的跟踪正是 T1 修复所必需的** —— 建议不要留着当装饰，直接用起来。

### T10. `TickMetrics` 归属失真

- `TickPump.cs:261`：`if (report.Skipped > 0) budgetExceeded = true;` —— `Skipped` 的语义是「本执行器不认领的 kind」（`CityTickExecutor.Report`），与预算无关 ⇒ 一个没人认领的 job 会把 `incompleteTicks` 虚增，把「配置漏了执行器」伪装成「tick 太慢」。
- `TickPump.cs:263`：`using (_metrics.BeginApply(batch.Jobs[0].Kind))` —— 整批（可能含多 kind）的 apply 耗时全记到第一个 job 的 kind 头上。
- 附带：`TickRunReport.BudgetExceeded` 被 Hub 逐级聚合（`TickExecutorHub.cs:83`），但 `TickPump` 从不读它（自己用 `elapsedMs` 判定）⇒ 该字段是死数据。

### T11. `NextDue` 无生产调用者

`TickJobRegistry.NextDue`（:178-196，含哨兵防御 + 「推进到 nowTick 之后第一个相位命中点」的兜底）**只在 `verify/check_tick_phase.mjs` 的源码守卫 F14 里被 grep 到**，生产路径走的是 `TickScheduler.CommitSuccess:118` 的 `job.NextTick = nowTick + job.PeriodTicks`。后者只在「`nowTick` 恰好是命中点」时保持相位；一旦某 job 被收集时 `NextTick < nowTick`（重启后时钟已被 `WorldClockStore` 推进到更晚的值、或 `Reconcile` 补灌的 job 首跳落在过去），相位就会相对漂移且不再回正。建议要么把 `CommitSuccess` 改为调 `NextDue`，要么在注释里钉死「本路径假定 `nowTick` 恒为命中点」并在 `RunOneTick` 加断言。

### T12. 常量与文档漂移（不报错，但会误导 / 将来变假红）

| 位置 | 问题 |
|------|------|
| `web/js/main.js:292` | 注释 `// 31 & ~1 = 30` —— 现已 `ALL=63`、`CALC_MASK=62`（people 关时再 `& ~32` 才回到 30） |
| `Server/Zongmen/Domain/MapMessages.cs:345` | `TileRequest.LastRevs` 注释仍写「按 TileMask 位序: 0=Chunk..4=Comm」—— 漏了 `5=People`（WIP 只更新了 `TileResponse.Revs` 的注释） |
| `verify/check_calc_local.mjs:235,246` | 断言 `maskEff === 30` / `=== 31`。目前**恰好**成立仅因为 people 开关默认关；一旦默认打开或测试里打开热力图 ⇒ 立即假红。建议改为 `PB.MASK` 常量运算 |
| `web/js/people-layer.js:50` | `PL.maskBit` 无任何调用者（main.js 内联 `mask &= ~PB.MASK.PEOPLE` 已覆盖）⇒ 死代码 |

---

## 五、已核对、**不是** bug 的点（避免重复排查）

- People 层的 mask 门控与「不走 rev 去重」：服务端 `wantPeople` 恒按 mask 判断、每发必带（`MapWorldService.cs:773-781`），前端 `PeopleLayer.onBlock` 对「服务端明确不给」也落空表（`people-layer.js:69-73`）⇒ 不会出现「二次打开永久空白」或请求风暴。
- `pb.js` 已正确解码 `TileResponse` 字段 15 → `parsePeopleData`（`pb.js:644,651-666`），`MASK.PEOPLE=32 / ALL=63` 已同步 ⇒ 前后端位序一致，无「解码缺失导致静默无数据」。
- `TickJobStore.Flush` 的 `NextTick == RevokedTick ? NextTick - 1` 落库（:253）与 `Load` 的 `nextTick < 0 ⇒ skipped`（:139）配套 —— `MaxValue-1 > 0` 能正常载入，不会把吊销哨兵写坏库。
- `city-evo.js` 的 `dt === 0` 严格 no-op、`out.ver = ver+1`、`lastEvoTick += dt`、只在写回时 `Math.round(pop)`（:279-393）与 R5/Δ 铁律一致。
- `TickExecutorHub` 的重复认领检测（构造期抛异常）、`TickPartitioner.CanJoin` 的四条件（含 `EngineCaches`）实现完整。
- `Program.cs` 的 DI 装配无循环（`CityTickExecutor` 不再注入 `TickPump`，`MapWorldServiceAccessor` 用晚绑定解环）。

---

## 六、建议修复顺序

1. **T1**（P0，唯一会让演化静默停摆的）→ 顺手启用 T9 的 `_pendingTicks`。
2. **T2 / T3**（P1，静默丢更新 / 时钟永久落后）。
3. **T4 / T5 / T6 / T7**（P2，性能与契约）。
4. P3 各项随下次触碰对应文件时一并清理；T12 建议和下一次「加图层」同批改（否则老问题会以假红的形式复现）。

---

## 七、修复记录（2026-10-12）

全部 12 条已修，`dotnet build` 0 警告 0 错误；tick 组离线判据 4/4 绿。

| ID | 状态 | 改动落点 |
|----|------|----------|
| T1 | 已修 | `TickPump.RunOneTick`：新增 `applied` 集合 + `DeferUnapplied()`，预算 `break` / 执行器抛异常时把未 apply 的 job 按 `nowTick+1` 重新 `Reprioritize`，兑现「收集即吊销 ⇒ 必须在本 tick 内 re-arm」不变量 |
| T2 | 已修 | `TickJobStore.Flush`：DB 段包进 `try/catch`，失败时把快照**并回**脏集（`TryAdd`，不覆盖新值）再抛出 ⇒ 真 at-least-once |
| T3 | 已修 | `TickPump`：`_bindTick/_bindMonoMs` + `IsBehindWallClock()`；catch-up 改 `do/while`，判据从 `due.Count>0` 换成「墙钟落后」 |
| T4 | 已修 | `CityTickExecutor.Execute` ②b：收集 `pendingRows` → 一次 `PutRange`（一次事务）；`EnsureInitialized` 同步改成成批 |
| T5 | 已修 | `JsVmPool.GetOrCreate`：`_onCreated?.Invoke` 包 `try/catch`，抛前 `created.Exit(); created.Dispose();` |
| T6 | 已修 | `MarkSettleDirty` 内追加 `_peopleCache.Clear()`；`BlockRevs.Bump` 注释补成「rev + LRU 两处都要挂」 |
| T7 | 已修 | `CityTickExecutor` 用 **job 的 seed**（`mine[0].Seed`）而非 `CurrentSeed()`，空 seed 直接跳过脏块通知；`PersistRow` 已删（并入 ②b） |
| T8 | 已修 | `ConcurrentTickQueue.AdvanceTo` 删掉恒不可达的「在途副本」分支与 `_duplicateSuppressed` 字段；`DuplicateSuppressed` 属性改为恒 0 并注明是结构性 0 |
| T9 | 已修 | `TickPump` 删掉死字段 `_joinGate`/`_pendingTicks`（T1 用局部 `applied` 集合完成同一目的） |
| T10 | 已修 | `TickPump`：删 `report.Skipped>0 ⇒ budgetExceeded`（Skipped ≠ 预算）；`BeginApply` 移进 per-outcome 循环按真实 kind 归属；改为读 `report.BudgetExceeded` |
| T11 | 已修 | 新增 `TickJob.DueTick`（`AdvanceTo` 收集时写入原到期 tick）；`NextDue` 改用 `DueTick`；`CommitSuccess` 改调 `_registry.NextDue(job, nowTick)` |
| T12 | 已修 | `main.js:292` 注释改成 `ALL(63) & ~CHUNK(1) = 62…⇒30`；`MapMessages.cs` 补 `5=People`；`check_calc_local.mjs` 30/31 换成 `MASK_BASE/MASK_LOCAL` 常量推导；`people-layer.js` 删死代码 `PL.maskBit` |

**判据同步**（改口径而非放宽）：`check_tick_queue_threadsafe.mjs` F14 与 `check_tick_job_persist.mjs` F6 原先硬查 `job.NextTick = nowTick + job.PeriodTicks`，现改为守更强的新不变量「`CommitSuccess` 必须经 `_registry.NextDue`，且不得出现裸的 `nowTick + Period`」；并新增 F6b 守 `NextDue` 必须用 `DueTick` 且保留哨兵防御。

**未做的取舍**：T1 顺延按 `nowTick+1`（非原到期格），极端持续超载下相位会小幅漂；T6 因区块格↔区域格无 O(1) 逆映射而整清 `_peopleCache`（容量 1024、仅热力图开启时才有热度）。两处均已在代码注释里写明。

