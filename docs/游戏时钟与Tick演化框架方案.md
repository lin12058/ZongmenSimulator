# 游戏时钟与 Tick 演化框架 —— 设计方案

> 状态：**设计稿 v2（未开工）**
> 日期：2026-09-27
> 目标：给 C# 后端引入一套「1 秒 1 tick = 游戏内 1 日」的**实时世界时钟 + 定时演化调度**框架。
> 核心形状：**nextTick 落库（重启不重算）→ 相位抖动摊批（不挤同一 tick）→ 解耦分批 → 消费队列 → 无状态 VM 并行执行 → 定序合流**。
>
> 阅读前置：
> - `docs/方案.md`（总体架构）、`docs/设定.md`（灵气复苏 / 气运 / 灵脉）
> - `docs/devdoc/地图建筑与景点重构-WebSocket单块接口设计.md`（**§二 明确留了「本版无世界时钟」的钩子，本文档就是来还这笔债的**）
> - `待办事项/玩家宗门放置与城市迭代方案.md` §十.6（P2「NPC 城市 tick 演化」—— 本框架正是它的载体）
> - `待办事项/脚本化城市迭代-资料调研.md`（演化**内容**怎么定义；本篇是「演化**何时跑、怎么调度**」，实施时两份合读）
> - `Server/Zongmen/Services/MapWorldService.cs`（C5 rev 契约、GzUnwrap、BlockRevs）、`Engine/JsEngineHost.cs`（VM 生命周期与门闩）

---

## v1 → v2 修订记录（先说清哪几条被推翻了）

| # | v1 的说法 | v2 的结论 | 为什么 |
|---|-----------|-----------|--------|
| R1 | job 集合可**从世界状态重建**，故不落库 | ❌ **推翻**：新建独立表 `TickJob`（`EntityId`/`Kind`/`NextTick`/`LastRunTick`/`FailCount`/`Payload`） | ① 一次性事件（内容，非派生）**不可重建**；② 全量重建 = 冷 V8 下遍历全图区域格 `settlementsFor`，秒级；③ `FailCount`/`Enabled` 丢失会让坏 job 重启后重跑同一轮失败 |
| R2 | 「进 V8 并行」办不到，单世界只能批量化 | ⚠ **部分推翻**：单 VM 不可并行**成立**，但**同 seed 可开 N 个 VM** ⇒ 单世界分片并行**可行** | VM 可多开 + VM 可丢弃 ⇒ 世界权威态搬到 C#/SQLite，VM 退化为**无状态执行器**（快照进 / patch 出） |
| R3 | 单世界分片「先别做」（roadCache 等全局态 ⇒ 等于重写引擎） | ⚠ **收窄保留**：**道路（L2）仍不可分片**（依赖建路顺序，不可从 seed 重建）；**其余 L0/L1 可分片** | 分片前提不是「全局态不存在」，而是「该 job 的读集可快照化」。道路的既成事实**不在** seed 里 |
| R4 | V8 边界传 JSON（`tickBatch(jobsJson)`） | ❌ **推翻**：边界只有 **protobuf 字节 + ArrayBuffer（堆外）**，**不过 string、不 base64** | 现路径 = JS string 构造 + UTF-16 marshal + C# string 分配 + base64 解码 + JSON 解析；base64 膨胀 33%、UTF-16 对 ASCII 膨胀 100% ⇒ 下行放大 ~2.7× |
| R5 | 每层用固定周期（1 日 / 1 月 / 1 季 / 1 年） | ❌ **推翻**：周期固定**但相位由确定性哈希打散**，且 L0 摊成 M 子批 | 否则 360 个 L1 job 全挤在第 30/60/… 天；L0 若 `Period==1` 则 lazy 是假的 |
| R6 | 未提「引擎侧 pb 编码器」 | ★ **新增**：引擎里没有 pb 写入口（`web/js/pb.js` 是**只读解码器**）⇒ 必须新增引擎侧编解码器 + 交叉判据 | 边界换 protobuf 的硬前置 |
| R7 | 未提「读路径 VM 的陈旧」 | ★ **新增硬要求**：必须给引擎加**按实体/按区域失效**出口，由合流器调用 | 读路径 VM 的 `townCache`/`tradeCache` 不会自己知道世界被 tick 改了 |
| R8 | 未提 gzip 边界 | ★ 明确：**压缩属「存储/传输」层；V8 边界恒为未压缩裸 proto** | 存储/下发已是 gzip，绝不让 V8 处理压缩流 |
| R9 | 未提 V8 运行期成本统计 | ★ 新增分段计时（解压/反序列化/JS/序列化/压缩/apply）+ `TickPerf` 独立表 | 「方便后续优化」必须先知道时间花在哪一段 |
| R10 | `TimedEvent` 独立表 | 合并：一张 `TickJob`，`PeriodTicks = 0` 即一次性 | 同一套载入/回写/对账，少维护一张表 |

---

## 〇、一页纸结论

| 议题 | 结论 |
|------|------|
| 时间模型 | `1 tick = 1 日`；`30 日 = 1 月`；`12 月 = 1 年 = 360 日`；`90 日 = 1 季`（春夏秋冬） |
| 实时口径 | 墙钟 **1 秒 → tick +1**（1 游戏年 = 6 分钟真机）。时基用**单调计时器**，不用 `DateTime` |
| lazy nextTick | 每个 job 带**绝对** `NextTick`；调度器是小顶堆。**且 `NextTick` 落库**，重启只做一次 `SELECT` 回灌，不全量重算 |
| 相位抖动 | `Phase = mix32(hash(seed\|entityId\|kind)) % PeriodTicks` ⇒ 到期点**散布**，不撞同一天。**周期不变，只挪首次相位**；绝不用运行时 RNG |
| 摊批 | L0 从「每 tick 全算」摊成 `PeriodTicks = M` + 相位 ⇒ 每 tick 只有 1/M 到期。⚠ 引擎演化公式**必须按 `dt` 积分**，不能默认推进 1 天 |
| 演化内容 | 城镇足迹生长 / 建筑升降级 / 贸易边重估 / 势力声望扩散 —— 四项均归 L1（季度为主），明细见 §1.3 |
| 「并行」 | ⚠ 单 VM 不可并行（`_gate` 是事实），但**同 seed 可开 N 个 VM**。形态 = **无状态 tick VM 池**：输入快照(proto) + job 批，输出 patch(proto)，世界权威态在 C#/SQLite |
| 跨界 | **堆外 + protobuf**：`ArrayBuffer`（V8 堆外 backing store）直传裸 proto 字节，**不过 string、不 base64、不 gzip**。每 VM 一对**复用缓冲**，零分配 |
| 消费队列 | **两条**，按**资源**而非业务划：`v8Queue`（每 VM 串行）+ `cpuQueue`（并发 = 核数-1）。独立 VM 池 ⇒ **与人类请求零门闩争用** |
| 使能技术 | **双缓冲快照 + 定序合并**：job 只读快照、只写私有 Patch，单线程合流器按 `(Layer, SortKey, Id)` 全序 apply |
| ⚠ 红线 1 | tick **只许改「可变派生层」**（实体属性 / `townCache` / `tradeCache`），**绝不许改「seed 纯函数层」**（`chunk` / `settleCache` / `siteScoreCache` / `regionCache`） |
| ⚠ 红线 2 | **道路重算不进 tick VM 池** —— `roadCache` 依赖建路顺序，不可从 seed 重建。走既有 `Lease(seed) + commitPlace` 同款串行序列 |
| 时钟存哪 | 独立表 `WorldClock` + `TickJob` + `TickPerf`。⚠ **绝不能塞 `Data(Key,Value)`** —— 后台 `PruneExcept` 会静默删非活跃 seed 前缀 |
| gzip | 存储/下发保持 gzip；**传给 V8 前解压 → 处理后回来再压缩**。V8 侧永不处理压缩流 |
| 分期 | P1 时钟+表+相位+调度+L0 摊批（可跑通）→ P2 无状态 VM 池 + protobuf 边界 + L1 四项 + rev 接线 → P3 跨世界/跨分片并行 + L2 + 快进 |

---

## 一、需求口径固化

### 1.1 时间模型（唯一真源）

```
TICKS_PER_DAY    = 1
DAYS_PER_MONTH   = 30
MONTHS_PER_YEAR  = 12         ⇒ TICKS_PER_YEAR  = 360
TICKS_PER_SEASON = 90         （3 月 = 1 季）
```

推导（纯函数，无状态，放 `GameClock.cs`）：

```
year   = tick / 360 + 1        // 1 起
doy    = tick % 360            // 0..359
season = doy / 90              // 0=春 1=夏 2=秋 3=冬
month  = doy / 30 + 1          // 1..12
day    = doy % 30 + 1          // 1..30
```

> ⚠ 必须是**纯整数运算**，不掺浮点。四季与月份钉死：春=1/2/3 月、夏=4/5/6、秋=7/8/9、冬=10/11/12。

### 1.2 墙钟 ↔ tick

- **时基 = 单调计时器**（`Stopwatch.GetTimestamp()` / `Environment.TickCount64`）。
  ⚠ 绝不用 `DateTime.UtcNow` 累计 —— 系统时间跳变（NTP 校正、改时区）会让世界**瞬移或倒退**。工程里 `PlaceCommitMinGapMs` 已用这个口径，保持一致。
- `tick = baseTick + (nowMono - bornMono) / 1000`
- **catch-up 预算**：某 tick 超时（重活阻塞）时，下一轮最多补 `MaxCatchUpTicks`（建议 4）；再多**记日志丢弃**（宁可世界慢下来，也不要雪崩式追补）。
- **离线语义（待拍板，默认「冻结」）**：重启后从存档 tick **继续**，不按墙钟差值追补。一次周末停机 = 数十万 tick。

### 1.3 演化内容（本框架要跑的**全部**东西）

四类，全部落在 L1（邻域层），因为它们的读集都是「自身 + 1~2 环邻域」：

| 内容 | job Kind | 读集 | 写集 | 引擎缓存 | 建议周期 | 并行键 |
|------|----------|------|------|----------|----------|--------|
| **城镇足迹生长** | `TownGrowth` | 自身属性 + 邻域聚落 + 地形（只读） | 实体属性（`pop`/`tier`）+ 足迹增量 | `townCache[stId]` | 季度（90） | `stId` |
| **建筑升降级** | `BuildingTier` | 同 `TownGrowth` | 足迹内建筑 `tier` | `townCache[stId]` | 季度（90） | `stId` |
| **贸易边重估** | `TradeEdge` | 两端聚落供需 | 边权重 | `tradeCache[edgeKey]` | 月（30） | `edgeKey` |
| **势力声望扩散** | `Reputation` | 1 环邻域势力 | `owner` / `influence` | 无（写实体属性） | 季（90） | `stId` |

⚠ 三条实施要点：

1. **`TownGrowth` 与 `BuildingTier` 写同一个 `townCache[stId]` ⇒ 同 `stId` 不可并行**。
   ⇒ 强烈建议**合并成一个实体级 job**（`TownEvolve`：读一次快照，一次算出「生长 + 升降级」两个 patch）—— 同时省掉一次跨界往返。见 §5.2。
2. **`TradeEdge` 请先做「边级局部重估」**（每条边只看两端供需），**不要一上来做全局最短路/势能流** —— 全局图算法与道路 A* 同病（顺序依赖 ⇒ 只能串行）。全局势能版列 P3。
3. **`Reputation` 的单轮邻域扩散可并行**（读快照、写 patch，半格推进）；**多轮扩散必须串行**（轮间有依赖）。这正是 §5.4 双缓冲的经典适用场景：每 tick 一轮，轮间靠快照隔离。

### 1.4 三条不可动摇的约束（红线 1 从 `chunk` 扩到「seed 纯函数层全集」）

1. **tick 只许改「可变派生层」**：
   - ✅ 可写：实体属性（`pop`/`tier`/`owner`/`state`/`influence`）、`townCache`、`tradeCache`、落库的 settle 包。
   - ❌ 绝不写：`chunk`（地形/biome/elev/neigh/精灵）、`settleCache`、`settleRawCache`、`siteScoreCache`、`prospectCache`、`regionCache`。
   ⚠ 为什么把红线从 `chunk` 扩到整个「seed 纯函数层」：这些缓存 + 前端自算地形共同构成**「世界 = f(seed)」**这条契约。基线是 `settlementsFor = $base + extIn`（`$base` 逐字节不变、零拷贝）。**只要 tick 碰了 `$base` 类的东西，位置会漂 ⇒ 前端自算与后端下发错位 ⇒「建筑落海」**。
2. **世界必须仍可确定性重建**。tick 产出的是「演化增量」，不是「随机漂移」；同 seed + 同起 tick + 同 job 集 ⇒ 两跑逐字节一致。
   ⇒ 推论：**相位抖动必须是 `hash(seed\|entityId\|kind)` 派生**，绝不用运行时 RNG 或「按调用顺序取随机数」。
3. **时钟是服务端资产**，与 `WorldLedger`（种子台账）同级。前端**只能读**，不许自造（对齐既有「种子绝不回落前端造」的规矩）。

---

## 二、lazy nextTick 的持久化（§二 = v2 新增核心）

### 2.1 表结构（独立表，绝不进 `Data`）

```sql
CREATE TABLE IF NOT EXISTS TickJob (
  Seed        TEXT    NOT NULL,          -- 世界种子（完整字符串，同 JsEngineHost 的 key 口径）
  Round       INTEGER NOT NULL,          -- 世次（同 PlayerSectStore 口径）
  EntityId    TEXT    NOT NULL,          -- ★ 实体 id，**原样存取**，绝不由 C# 重算
  Kind        TEXT    NOT NULL,          -- 事件（TickJobKind 枚举名，字符串便于向后兼容）
  Layer       INTEGER NOT NULL,          -- 0=L0 1=L1 2=L2
  Resource    INTEGER NOT NULL,          -- 0=V8 1=Cpu
  NextTick    INTEGER NOT NULL,          -- ★ lazy 的载体：绝对 tick 号
  PeriodTicks INTEGER NOT NULL,          -- 0 = 一次性（原 TimedEvent）
  Phase       INTEGER NOT NULL,          -- 相位（由哈希派生；存下来防漂移，可缺省）
  LastRunTick INTEGER NOT NULL,          -- ★ 演化增量 Δt 的来源
  FailCount   INTEGER NOT NULL DEFAULT 0,
  Enabled     INTEGER NOT NULL DEFAULT 1,
  Payload     BLOB,                      -- 该 kind 自己的 proto（一次性事件的参数）
  PRIMARY KEY (Seed, Round, EntityId, Kind)
);
CREATE INDEX IF NOT EXISTS ix_tickjob_due
  ON TickJob (Seed, Round, Enabled, NextTick);
```

⚠ 五条设计约束：

- **三张账分账**：`WorldClock`（时钟）+ `TickJob`（调度）**必须独立成表**，与 `WorldLedger`/`PlayerSectStore` 同一库不同表。塞 `Data(Key,Value)` 会**被 `PruneExcept` 静默删掉**（它只清 `Data` 表的非活跃 seed 前缀，够不着独立表 —— 这是既有两个台账的同一理由）。
- **`EntityId` 原样存取**：玩家实体 id 形如 `{区域i}_{区域j}_u{n}`，是**引擎自算**的（`rngDominated`/`roadsNear` 要靠 `id.split('_')` 反解，NaN ⇒ 静默扫空）。C# 重算 = 批量踩坑。
- **`Payload` 是 BLOB 而非 TEXT**：一次性事件的参数走 proto（§九）。⚠ **不要 gzip** —— 它很小（几十字节），gzip 的 header 就 18 字节，净亏。
- **索引按 `(Seed, Round, Enabled, NextTick)`**：载入时唯一要跑的查询就是「本世所有 enabled 的 job，按 NextTick」。
- **`Kind` 存字符串不存 int**：新增/删除 kind 不会让历史行错读成另一个 kind（int 枚举会）。

### 2.2 三条生命周期（载入 / 回写 / 对账）

```
① 载入（启动 / 换世）
   SELECT EntityId, Kind, Layer, Resource, NextTick, PeriodTicks, Phase,
          LastRunTick, FailCount, Payload
     FROM TickJob WHERE Seed=? AND Round=? AND Enabled=1
   → 逐行 Enqueue 进小顶堆。NaN/缺失字段的行**跳过并计数**（不要让一行脏数据废掉整次载入）。

② 回写（不能每 tick UPDATE）
   内存堆是运行时唯一真源；NextTick 推进 → 标记脏行。
   每 FlushEveryTicks（建议 10）或批量攒够 N 行 → 一次事务内批量 UPSERT。
   ⚠ 关机/换世必须 flush：挂 IHostApplicationLifetime.ApplicationStopping。

③ 对账 reconcile（防「漏事件 ⇒ 永久缺 job」，静默病）
   · 启动：载入后做一次**全量**对账（从引擎聚落集合 + PlayerSect 台账推出「应有 job」）。
   · 运行中：**事件驱动增量**（commitPlace 新聚落 / 聚落移除 / 类型或 tier 变化 → INSERT 或 UPDATE 该行）。
     ⚠ 比「每 tick 扫描」便宜几十倍。
   · 兜底：每 `ReconcileEveryTicks`（建议 360 = 1 游戏年）做一次全量对账，修掉漂移。
```

⚠ 对账的对齐键必须是 `(EntityId, Kind)`，且**只增删不重置**：已存在行的 `NextTick`/`Phase` **不许被对账覆盖**，否则每年一次的兜底对账会把相位抖动全部推平回同一天（抖动就白做了）。

### 2.3 为什么必须落库（对「重启全量重算」的量化反驳）

不做表意味着重启后要：
1. **遍历全图区域格**（`regionSeedOf` → `settlementsFor`）列出全部聚落 ⇒ 冷 V8 下这是**秒级**（`regionJson` 首次实测单区域 A* 就 ~195.8ms；全图区域数远大于 1）。
2. 每个聚落 × 每 kind 派生一次 job ⇒ job 数 ~ 聚落数 × 4。
3. **一次性事件直接丢失** —— 这是**内容**，不是派生，丢了就永远回不来（最硬的理由）。
4. `FailCount` 归零 ⇒ 坏 job 重启后**重新开始**失败循环（重复日志、重复无效计算）。
5. `LastRunTick` 归零 ⇒ 首次演化的 Δt 算错（要么按 0 天不演化，要么按巨大值跳变）。

### 2.4 崩溃语义（为什么「丢最后 10 tick 的 NextTick」是安全的）

- `NextTick` 是**派生量**：`NextTick = EpochStart + Phase + k·PeriodTicks`。丢了只丢「最多 10 天的相位偏移」，**不丢事件本身**。
- 一次性事件是**内容**，靠 ② 的批量 UPSERT 落库；⚠ 因此**一次性事件必须在插入时立即写库**（不能等 10 tick 的批量窗口）—— 它的触发点可能就在窗口内。
- ⇒ 规则：**周期 job 可以延迟 flush；一次性 job 立即 flush。**

---

## 三、相位抖动：用随机数打散，不用固定 tick（§三 = v2 新增核心）

### 3.1 病在哪

固定周期 = 固定栅格点：360 个 L1 季度 job 若都从 `tick % 90 == 0` 起算，则第 90/180/270/360 天各挤 360 个 job，其余 356 天**一个都没有**。后果：
- 那一天 tick 预算被撑爆 ⇒ 顺延 ⇒ 世界「跳帧」；
- lazy 的收益被摊平（平均负载低但峰值高，队列和 VM 池得按峰值配）。

### 3.2 解法：相位由确定性哈希派生

```
Phase(entityId, kind, seed) = mix32( fnv1a(seed + '|' + entityId + '|' + kind) ) % PeriodTicks
NextTick 首次 = EpochStart + Phase
NextTick 之后 = 上次 + PeriodTicks          ← 严格加周期，周期永不抖动
```

- `mix32` 至少一轮混淆（如 splitmix32 的 finalizer）。⚠ **必须混到位**：`EntityId` 形如 `12_-3_u0`，`i/j` 连续 ⇒ 直接取模会让相邻聚落的相位相邻（哈希低位相关），抖动退化成「斜线排队」而不是均匀散布。
- ⚠ **抖的是相位，不是周期**。若写成 `NextTick += Period + jitter`（jitter 有正有负），则「一年 4 次」会变成 3 次或 5 次，判据（§十二 `check_tick_lazy`）立刻失效。
- ⚠ **绝不用运行时 RNG**（`Math.random()` / 引擎内 RNG）。重启后相位变 ⇒ 世界不确定；并行时取数顺序变 ⇒ 两跑不一致。

### 3.3 L0 摊批：把「每 tick 全算」变成「每 M 天摊 1/M」

若某个 L0 job 是 `PeriodTicks == 1`（每 tick 都算），则 **lazy 是假的** —— 堆顶永远到期。正确做法：

```
PeriodTicks = M                 （如 M = 30）
Phase       = hash(...) % M     ⇒ 每个实体平均每 M 天算一次，每 tick 只有 1/M 到期
```

⚠⚠ **这条能成立的前提，是引擎接口按 `dt` 积分**：

```js
// ❌ 错误：隐含「推进 1 天」
function tickPopGrowth(job) { st.pop += growthRate(st); }

// ✅ 正确：显式接收真实 Δt
function tickPopGrowth(job, dtTicks) { st.pop += growthRate(st) * dtTicks; }
```

**所有演化公式必须写成 `f(state, dt)` 而非 `f(state)` 的「+1 步」**。这是引擎侧的**硬接口要求**，也必须在 `JobSpec` 里带上 `dtTicks = nowTick - LastRunTick`（对恢复/顺延/抖动都正确）。⚠ 这条漏了不会报错，只会让世界演化速度**随机地快慢 M 倍** —— 典型的静默病。

### 3.4 反模式清单

| 反模式 | 为什么错 |
|--------|----------|
| 每 tick 掷骰子决定「今天算不算」 | 每 tick 都要判定 ⇒ lazy 失效；且概率分布长尾 ⇒ 某些实体长期不触发 |
| `NextTick += Period ± jitter` | 周期被改 ⇒ 计数判据失效，演化速率漂移 |
| 载入时用 `Random.Shared` 重排相位 | 重启后相位变 ⇒ 不确定性；且每次重启抖动结果不同，无法定位问题 |
| 对账时重置已有行的 `Phase` | 每年兜底对账把抖动推平回同一天（§2.2） |
| 相位只用 `entityId` 不掺 `seed` | 不同世界的负载分布完全相同（无害但没必要）；更糟的是同 id 跨世相位相同，掩盖 bug |
| 相位只用 `kind` | 同 kind 全部同相位 = 完全没打散 |

---

## 四、调度器（lazy 的落点）

### 4.1 数据结构选型

| 方案 | 插入 | 取到期 | 适用 |
|------|------|--------|------|
| **小顶堆**（`PriorityQueue<TickJob,long>`） | O(log n) | O(log n) | ★ **MVP 选它**：支持任意 `NextTick`，语义最直白 |
| 分层时间轮（日轮 360 / 月轮 12 / 年轮） | O(1) | O(1) | job 数 > 1e5 时的 P3 升级 |

⚠ 两条实现注意：
- .NET 的 `PriorityQueue` **不是线程安全**、**没有 decrease-key**。调度器必须**单线程独占**（= tick 泵线程）；重排一律「弹出后改 `NextTick` 再重新 `Enqueue`」。
- 不用「优先级打洞 + 惰性删除」那一套：job 自带 `NextTick`，弹出时**校验版本**即可（`job.NextTick != 队列键` ⇒ 丢弃重排后的旧副本）。

### 4.2 `AdvanceTo(nowTick)` —— lazy 的全部魔法

```
AdvanceTo(nowTick):
    batch = []
    while 堆非空 and 堆顶.NextTick <= nowTick:
        job = Pop()
        if job.NextTick != 键: continue        // 惰性删除（已被重排）
        job.DtTicks = nowTick - job.LastRunTick   // ★ 真实 Δt
        batch.add(job)
    if batch.isEmpty: return                   // ★ 本 tick 零成本 —— 一次 Peek 而已
    Partition(batch) → 投递到消费队列
    （重排在合流后做，见 §6.8）
```

- **空转成本 = 一次 `Peek` 的比较**。这是「避免每 Tick 都要计算」的唯一兑现方式。
- **快进（可选，P3）**：堆顶 `NextTick` 距现在 > `FastForwardThreshold` 且**无在线玩家**时，可把 `nowTick` 直接跳到堆顶。仅用于离线演化，在线时**禁用**（否则玩家会看到「跳帧」）。

### 4.3 tick 泵（背景服务）

```
TickPump : BackgroundService
  loop:
    await TimerWaitToNextSecond()            // 单调对齐到下一秒边界，不要 Sleep(1000) 累积漂移
    ticks = min(应补数, MaxCatchUpTicks)
    for i in ticks: scheduler.AdvanceTo(clock.Tick); clock.Tick++
```

⚠ 时钟推进与 job 执行**解耦**：泵只宣布「第 N 天到了」，不等 job 算完。在途批由 pipeline 自己管，超预算就顺延到下一 tick（`IncompleteTicks++` 上报 `/stats`）。

---

## 五、第一步：解耦计算

### 5.1 三层频率 —— 把全局耦合赶去低频

解耦的**主手段**不是「让全局计算并行」，而是**让全局计算少发生**。

| 层 | 周期（含相位抖动） | 内容 | 读写特征 | 并行度 |
|----|--------------------|------|----------|--------|
| **L0 局部** | 摊批 `M=30` ⚠ 需 `dt` 积分 | 人口增长/衰减、资源产出与消耗、弟子修炼、寿元倒计时 | 读自身 + 只读世界常量；写自身 | **高**（写集天然不相交） |
| **L1 邻域** | 月(30) / 季(90) | ★ 四项演化（§1.3） | 读 1~2 环邻域快照；写自身 | **中**（按 `stId`/`edgeKey` 分区，块间靠快照隔离） |
| **L2 全局** | 年(360) / 事件触发 | **道路网重算**、聚落抑制层、灵脉归属与势力领地、世界级事件（灵气跃迁、劫数） | 读全图；写全局缓存 | **1**（串行，固定规范序） |

⚠ L2 为什么必须串行：`mapgen-config.js` 已写明 —— 「路径形状取决于**建路顺序**（建网规范序）」。A\* 会主动并线到既有道路（`ROAD_W_ROAD=2`）⇒ 前一条路改变后一条路的搜索空间。**并行重算道路 = 不确定的世界**。这是算法性质，不是工程保守。且实测单次道路重算 **405~443ms**（`check_place_road_recompute.mjs`）⇒ 必须**分帧**（一年摊成 12 个月 tick 做 1/12）。

### 5.2 实体级聚合（★ 减少跨界次数的最便宜一招）

同一实体、同一层、**写同一引擎缓存**的多个 kind 应**合并成一个 job**：

```
❌ 两个 job:  TownGrowth(stId=12_-3_u0)  +  BuildingTier(stId=12_-3_u0)
             ⇒ 两次跨界、两次快照、必须在同一批内串行（同写 townCache[stId]）

✅ 一个 job:  TownEvolve(stId=12_-3_u0)   ⇒ 一次快照、一次跨界、产出两个 patch、零竞态
```

⚠ 这条同时消掉了「同 `stId` 不可并行」这条限制的**大部分**损失 —— 因为大多数冲突来自「同实体不同 kind」，聚合后冲突自动消失。

### 5.3 依赖声明（解耦的输入）

每个 `Kind` 在**注册表**里静态声明读写集，而不是运行时嗅探：

```csharp
// 键空间：Chunk:ca,cb / Region:i,j / Settle:entityId / Edge:idA|idB / Vein:commId / World:*
public sealed record JobSpec(
    TickJobKind Kind,
    TickLayer    Layer,
    TickResource Resource,
    string[] Reads,           // 例: ["Settle:{id}", "Region:{i},{j}"]
    string[] Writes,          // 例: ["Settle:{id}"]
    string[] EngineCaches     // ★ 触碰的引擎内部可变缓存: townCache/tradeCache/...
);
```

⚠ `EngineCaches` 是**最容易漏、后果最重**的字段。只看 `Writes` 会得出「两个不同 `stId` 的城镇生长互不相干 ⇒ 可并行」—— 事实上它们都在写 `townCache`，只是 key 不同。所以：

- `EngineCaches` 非空 且 目标 key 可能相撞 ⇒ 不可并行；
- 无法证明 key 不相交 ⇒ **按不安全处理**（保守串行）。

### 5.4 分批算法

```
Partition(dueJobs):
  1) 按 (Resource, Layer) 分桶                     // V8 与 Cpu 绝不混队列
  2) 桶内按 SortKey 排序                            // 规范序，先定后切
  3) 贪心聚批：依次尝试把 job 放入当前批 P
       可放入 ⟺ ∀j∈P:
         Writes(job) ∩ Writes(j)      = ∅          // 写集不相交
         Writes(job) ∩ Reads(j)       = ∅          // 无 RAW
         Reads(job)  ∩ Writes(j)      = ∅          // 无 WAR
         EngineCacheKey(job) ∩ …(j)   = ∅          // ★ 引擎缓存键也不许撞
       否则开新批
  4) 每批内部仍按 SortKey 执行（并行的是「批与批」，不是批内）
```

三条「不能并行」清单：

1. **任何写 `roadCache` 的** ⇒ 全局串行（`RoadRework`、以及任何触发 `roadsNear` 的改动）。
2. **任何用引擎内 RNG 的** ⇒ 要么全局串行，要么**给每个 job 独立 rng 流**（`hash(seed\|jobId)` 派生）。⚠ 按调用顺序取随机数 = 并行必变序列 = 破坏确定性。
3. **宿主级单例状态**（`forceStaticDirty`、`_placeVer`、`_blockRev`、`settleVer`、`roadVerCache`）⇒ 只允许**合流器单线程**碰，worker 一概不碰。

### 5.5 双缓冲快照 + 定序合并

```
tick N 开始:
  Snapshot_N = freeze(WorldState_N)        // 只冻结「本 tick 会被写」的数据（COW，不是全图深拷贝）
  并行执行所有批:  job 只读 Snapshot_N，产出私有 Patch_i
  合流器（单线程）:
     按 (Layer, SortKey, Id) 全序排序所有 Patch_i
     apply 到 WorldState_N → WorldState_{N+1}
     BumpBlockRev(...) / forceStaticDirty(...) / InvalidateEngineCache(...)
```

收益：把并行正确性从「细粒度依赖分析 + 锁」**降级**为「快照读 + 私有写 + 定序合并」三件不用动脑的事。代价：被写数据的内存短暂翻倍（COW 范围可控）。

⚠ 快照粒度：**不做全图深拷贝**。建议 `WorldState` 用「不可变 map + 写时复制」，只有本 tick 要写的实体才复制。

---

## 六、第二步：进引擎执行（v2 大改）

### 6.1 先澄清：单 VM 不可并行，但**同 seed 可以开 N 个 VM**

`JsWorldVm` 的现状是不容置疑的：

```csharp
private readonly SemaphoreSlim _gate = new(1, 1);   // ← 单实例门闩
```

`V8ScriptEngine` 是**单线程**引擎 ⇒ 给**一个 VM** 配 4 个 worker 去调 `vm.Call`，结果是 4 个线程排在同一把门闩上（纯浪费线程、零加速）。

**但这不构成上限** —— 并行度可以来自「开更多 VM」：

| 维度 | 机制 | 成本 | 结论 |
|------|------|------|------|
| **① 批量化** | N 个 job 合并进**一次**跨界调用，JS 侧 for 循环 | 省 N-1 次跨界 + 编解码 | ★ 必做（最便宜） |
| **② 跨世界** | K 个活跃 seed ⇒ K 组 VM ⇒ `Parallel.ForEach` | 内存 O(K) | ★ 随 `MaxSeeds` 免费获得 |
| **③ 同 seed 分片** | 同 seed 开 S 个**无状态** VM，各跑一个分片的 job 批 | 每个 VM 一份引擎常驻内存 | ★ **v2 新增：可行**（前提见 6.2） |
| ④ 道路分片 | ✗ | — | ❌ 不可行（见 §1.4 红线 2） |

### 6.2 ③ 为什么会变可行：把「有状态 VM」改成「无状态执行器」

现状 `JsWorldVm` 是**有状态**的：`roadCache`/`settleCache`/`townCache`/`ext` 跨调用存活。这是「一个 seed 一个 VM」的根本原因。

**v2 的形态**：tick 用一组**无状态执行器 VM**（`TickVmPool`），每个 job 批自带**读集快照**：

```
        ┌──────────────────────────────────────────────┐
        │ C# 侧（唯一权威世界态）                        │
        │  内存 WorldState + SQLite（settle/comm/…）    │
        └───────────────┬──────────────────────────────┘
                        │ ① 冻结读集 → proto 快照（未压缩）
                        ▼
        ┌──────────────────────────────────────────────┐
        │ TickVmPool: S 个无状态 VM（可并行）            │
        │   VM#1  VM#2  … VM#S                          │
        │   每个 = bundle + init(seed) + 复用 in/out 缓冲 │
        │   输入: 快照 + job 批   →   输出: patch(proto) │
        └───────────────┬──────────────────────────────┘
                        │ ② 回传 patch（未压缩 proto）
                        ▼
        ┌──────────────────────────────────────────────┐
        │ 合流器（单线程）: 定序 apply + rev + 失效出口   │
        └──────────────────────────────────────────────┘
```

**这个形态的成立条件（缺一不可）**：

1. **读集可快照化** ⇒ L0/L1 成立（自身 + 1~2 环邻域）；L2 不成立（全图）。
2. **VM 不跨批携带世界态** ⇒ 每个批自己带读集，不依赖上一次调用的残留缓存。
3. **快照必须包含「不可从 seed 重建」的东西**：⚠ `roadCache` 是**建路顺序 + 玩家放置史**的产物，**不在 seed 里** ⇒ **tick VM 绝不触碰道路逻辑**（读也不要）。同理 `ext`（玩家宗门）也要随快照灌入（既有 `setExternalSettlements` 就是这个先例）。

### 6.3 「用完就丢」还是「池化复用」——必须算清冷启账

`JsWorldVm` 构造函数原文写得很清楚：**`new V8ScriptEngine()` + `Evaluate(bundle)` + `init(seed)` 可能耗时数百 ms**。

⇒ **「每批新建、用完即丢」在每秒一次的 tick 路径上不可行**：1 秒预算里塞几百 ms × S 个分片 = 必然超时。

⇒ 正确形态是 **`TickVmPool`：预热 S 个 VM，`init(seed)` 一次，之后复用于后续 tick；但随时可 `Drop()` 重建**。

⚠ 而「随时可丢」正是**无状态化带来的最大收益**：VM 泄漏 / 状态漂移 / 抛异常后，**直接丢弃重建，比调 bug 便宜得多**（丢弃零损失，因为权威态不在 VM 里）。

```
TickVmPool
  · 尺寸 S = max(1, Environment.ProcessorCount - 1)     // 留一核给 Kestrel/WS
  · 每 VM: 一份 bundle（与 JsEngineHost 同源同序）+ init(seed) + 一对复用 in/out ArrayBuffer
  · 借出/归还（lease），无跨批状态 ⇒ 归还时无需清理
  · Drop 条件: 超时 / 抛异常 / 内存超阈 / 连续 N 次 err ⇒ 丢弃重建（记 Perf 表）
```

### 6.4 ⚠⚠ 读路径 VM 的陈旧问题（v1 漏掉的硬要求）

`TickVmPool` 与读路径的 `JsEngineHost` 是**两套 VM**。tick 改了世界后，读路径 VM 里的 `townCache[stId]` / `tradeCache[edgeKey]` **不会自己知道** ⇒ 玩家会看到旧建筑。

必须给引擎加**失效出口**，由合流器在 apply 后调用：

```js
/* mapgen-server.js 追加（仿既有 clearRoadSideFor / setExternalSettlements 的先例） */
MapGenServer.invalidateTowns = function (idsJson) { ... MG.invalidateTown(id) ... };
MapGenServer.invalidateTrades = function (keysJson) { ... };
MapGenServer.invalidateRegions = function (ijJson) { ... };   // 按区域格清派生
```

三条要点：
1. ⚠ 读路径 VM **可能已被 LRU 淘汰** ⇒ 此时无需失效（重建时自然从 DB 读新值）。所以失效调用要**容忍 VM 不存在**（`TryGet`，不 `GetOrCreate` —— 别为了失效而新建一个 VM）。
2. ⚠ **`settleCache` 不许清**（红线 1）：它是 seed 纯函数层。要清的是 `townCache`/`tradeCache`（可变派生层）。
3. ⚠ **失效出口本身是「写操作」**，必须在 `JsEngineHost.Call` 的 switch 加 case（漏了 = 运行期 `未知 JS 函数`，编译期不报）。

> 附：为什么足迹权威在 DB 而不在引擎 —— `GetTileBlock` 的 `needSettle` 分支会用落库的 settle 包**覆盖**引擎即时生成的结果。所以只要落库的 settle 包是新的，**即使引擎缓存陈旧，块响应也是对的**；失效出口是给 `tileJson`（单格点击）与 `regionJson` 这类**不落库**的即时路径兜底。

### 6.5 跨界：堆外内存 + protobuf（不再过 string）

#### 6.5.1 现状的病（量化）

当前 17 个出口全是 `(string)_svc.xxxJson(...)`，一次单块请求的跨界成本：

```
JS 侧:  构造 JS string（UTF-16）→ base64 编码（+33%）
跨界:   JS string → .NET string（UTF-16 marshal，ASCII 场景 +100%）
C# 侧:  string 分配（LOH 风险）→ base64 解码 → JSON 解析 → 组装 protobuf
```

对 ASCII 的 JSON + base64，**载荷一行膨胀 ~2.7×**，还有 4 次内存分配。

**目标形态**：一次 `memcpy`。

```
JS 侧:  DataView 直接写进 ArrayBuffer（V8 堆外 backing store）
跨界:   ReadBytes/WriteBytes 直拷
C# 侧:  Span<byte> 视图 → protobuf 反序列化（protobuf-net，零 string）
```

⚠ **V8 侧的 ArrayBuffer backing store 本身就在 V8 堆之外**（V8 的 external/off-heap 区）⇒ 「堆外」在 V8 这一侧天然成立。真正的收益是**消掉 string 与 base64 两道中转**。

#### 6.5.2 ClearScript 版本现实（必须先看清，再定方案）

项目当前：`Microsoft.ClearScript.Complete 7.4.5`。

| 能力 | 版本 | 结论 |
|------|------|------|
| `IArrayBuffer.ReadBytes/WriteBytes(byte[], …)`、`GetBytes()` | 7.1.3+ | ✅ 7.4.5 可用 |
| `WriteBytes(ReadOnlySpan<byte>, …)` / `ReadBytes(… , Span<byte>, …)` | **7.5.1** | ❌ 7.4.5 **没有** ⇒ 想「非托管 buffer 直写不拷」得**升到 7.5+** |
| `SharedArrayBuffer` 跨 runtime 共享（零拷贝分发同份快照） | 7.2+ | ✅ 7.4.5 可用（需 spike 确认） |

⇒ **两条路**：
- **A（7.4.5 现状）**：`byte[]` 重载 ⇒ 跨界时多一次拷贝（`byte[]` → ArrayBuffer）。**对 tick 的规模（每批几 KB~几十 KB）完全够用**，先走这条。
- **B（升 7.5+）**：`ReadOnlySpan` 直写 + `InvokeWithDirectAccess` ⇒ 真零拷贝（非托管 buffer pin 后直拷）。⚠ 升级会换 `ClearScriptV8.win-*.dll` 原生库 ⇒ **必须跑全量回归**（离线段 25 条）。

> ⚠ **不假设 API 名**：宿主侧「如何拿到一个 `IArrayBuffer` 句柄」（是否有直接分配 API，还是必须 `Evaluate("new ArrayBuffer(n)")` 再转型）**必须先做一次 P0 spike 验证**，本方案不写死。见 §十二 `spike_v8_abuffer.mjs`。

#### 6.5.3 零分配形态：每 VM 一对复用缓冲

⚠ 不要每批 `new ArrayBuffer`（V8 堆分配 + GC）。**每个 VM 持有一对私有复用缓冲**：

```js
/* 引擎侧（bundle 内，尾部追加） */
MapGenServer.__buf = { in: new ArrayBuffer(1 << 16), out: new ArrayBuffer(1 << 20) };
MapGenServer.__bufHandle = function () { return MapGenServer.__buf; };   // 宿主取一次句柄即可
```

```csharp
// 宿主侧（每个 TickVm 一次）
_in  = (IArrayBuffer)_svc.__buf.GetProperty("in");
_out = (IArrayBuffer)_svc.__buf.GetProperty("out");

// 每批：写 → 调 → 读
_in.WriteBytes(reqBytes, 0, (ulong)reqBytes.Length, 0);
_svc.tickBatch(_in, reqLen);                                  // 返回写入 out 的字节数
var n = (ulong)_svc.__lastOutLen();
var span = _outSpan[..(int)n];                                // 复用 byte[] 池
_out.ReadBytes(0, n, _outBuf, 0);
```

⚠ 缓冲**必须每 VM 私有**（不能跨 VM 共享一个）—— VM 是并行单元，共享缓冲 = 数据竞争。共享只在「只读快照」场景用 `SharedArrayBuffer`（§6.5.5）。
⚠ 缓冲要**可增长**：超限时重新分配（并记 `BufGrow` 计数）；固定死上限 = 大区域第一批就静默截断。

#### 6.5.4 C# 侧入口：与 `Call` 并列的 `CallBytes`，不动现有 17 个出口

⚠ **不要改 `Call` 的签名**（它返回 `string`，17 个出口都依赖它）。新增第二个入口：

```csharp
/// <summary>二进制出口：入参/出参都是 ArrayBuffer（V8 堆外）。返回写入 out 的字节数。</summary>
public int CallBytes(string fn, ReadOnlySpan<byte> input, Span<byte> output)
{
    _gate.Wait();
    try
    {
        _in.WriteBytes(input.ToArray(), 0, (ulong)input.Length, 0);   // 7.4.5 需 byte[]；7.5+ 可直传 span
        var n = Convert.ToInt32((double)_svc.tickBatch(_in, input.Length));
        _out.ReadBytes(0, (ulong)n, output, 0);
        return n;
    }
    finally { _gate.Release(); }
}
```

⚠ `Call` 的 switch 白名单机制**不适用于它**（`CallBytes` 只服务 tick 一个出口）。但**首次调用前必须确认 `MapGenServer.tickBatch` 存在** —— 漏加 bundle/挂载点 ⇒ 这里会 `undefined is not a function`（好在是**调用即炸**，不是静默）。

#### 6.5.5 可选：`SharedArrayBuffer` 零拷贝分发只读快照

S 个分片 VM 若读**同一份**快照（如「本 tick 的全局势力表」），可用 `SharedArrayBuffer`（ClearScript 7.2+ 支持跨 runtime 共享，含其上的 typed array/DataView）**只共享一份内存**。

⚠ 使用条件（三条，缺一不可）：
1. 只读共享（写完才交给 worker；不写就不需要 `Atomics`）；
2. 必须**确认全部 worker 已停止读**才能改写下一批（即需要「批屏障」，不能边写边读）；
3. VM 必须能拿到**同一个** `SharedArrayBuffer` 句柄（跨 runtime 需 ClearScript 正确 marshal）⇒ **列 spike 项**。

⇒ MVP **不用**它（每 VM 各拷一份，简单可靠，量也不大）；列 P3 优化。

#### 6.5.6 过渡期信封：「protobuf 信封 + JSON 载荷」

既有 17 个 JSON 出口不必一次迁完。允许过渡形态：

```proto
message TickBatchResponse {
  repeated TickResult results = 1;
  uint32 computed = 2;
  uint32 errored  = 3;
  bytes  legacy_json = 15;   // ★ 过渡期：protobuf 信封里放 JSON（utf8）
}
```

⇒ 边界协议**统一为 protobuf**（符合「如果是 json 也用 protobuf 进行封装」），内部载荷渐进替换。P3 再把 chunk/region 这类**本来就能受益**的出口迁到裸 proto（它们现在是 base64 定宽打包，换裸 proto 直接省 33% + 一次 base64）。

### 6.6 引擎侧出口与「挂载点」裁决

⚠ **不新建 `tick-batch.js` 业务文件**，但**必须新增一个 pb 编解码文件**（引擎里现在**没有** pb 写入口，`web/js/pb.js` 是只读解码器）。两个文件的挂载点裁决不同：

| 文件 | `JsEngineHost` bundle 数组 | `Call` switch | `EngineScriptOrder`（下发前端） | `ComputeEngineHash`（指纹） | `sync_preview_inline` |
|---|---|---|---|---|---|
| **`pben.js`**（新增，引擎侧编解码） | ✅ **必须加** | — | ❌ **不该加** | ❌ **不该加** | ❌ 不该加 |
| **`mapgen-server.js`**（既有，追加 `tickBatch` 等） | 已在 | ✅ 加 case（**失效出口也要**） | ❌ 不加 | ❌ 不加 | ❌ 不加 |

⚠ 两个「不该加」的理由（漏了会**静默**出错）：
- `EngineScriptOrder` 是给**前端自算地形**用的；pb 编解码器前端不需要（它有自己的 `pb.js`），加进去 = 白传 + 前端多定义一份。
- `ComputeEngineHash` 只对**下发前端的三件套**算（`noise.js`+`mapgen-config.js`+`mapgen.js`，注释原文：**不含 `mapgen-server.js`**）。把 `pben.js` 算进去 ⇒ 「服务端没升级却换了指纹」⇒ 前端误判引擎升级、静默回退服务端下发。

```js
/* mapgen-server.js 追加 */
MapGenServer.tickBatch = function (inBuf, inLen) {
  var r = PbEn.reader(new Uint8Array(inBuf, 0, inLen));
  var req = PbEn.decodeTickBatchRequest(r);        // ★ 未压缩裸 proto
  var out = PbEn.writer(MapGenServer.__buf.out);
  PbEn.beginTickBatchResponse(out);
  for (var k = 0; k < req.jobs.length; k++) {
    var j = req.jobs[k];                            // C# 已按 (Layer, SortKey) 排好序
    switch (j.kind) {
      case 'townEvolve':   PbEn.pushResult(out, tickTownEvolve(j));   break;   // L1 只写本块
      case 'tradeEdge':    PbEn.pushResult(out, tickTradeEdge(j));    break;
      case 'reputation':   PbEn.pushResult(out, tickReputation(j));   break;
      case 'popGrowth':    PbEn.pushResult(out, tickPopGrowth(j, j.dtTicks)); break;  // ★ 按 Δt 积分
      default:             PbEn.pushErr(out, j.entityId, 'kind');
    }
  }
  return PbEn.finish(out);                          // 返回写入字节数
};
```

三条契约：
1. **批内顺序 = 传入顺序**（C# 已按规范序排好），JS **不再排序**。
2. **只产 Patch，不改世界**。`forceStaticDirty` / `roadVer` / 缓存失效**一律由 C# 合流器统一做** —— 脏标记只有一处来源。
3. **未识别的 kind 回 `err`，不抛异常**（一个坏 job 不该废掉整批）。

### 6.7 消费队列：按「资源」划，不按业务划

```
                      ┌─ v8Queue  (bounded S, FullMode=Wait) ─→ [TickVm × S] ─┐
TickPump ──► 调度 ──► │  每个 TickVm 内部仍持 _gate（真并行来自 S 个 VM）      ├─► 合流器(单线程) ─► apply + rev + 失效
                      └─ cpuQueue (bounded 2N, FullMode=Wait) ─→ [worker × N-1] ─┘
```

- `System.Threading.Channels.Channel<TickBatch>`，`BoundedChannelOptions { FullMode = Wait }` ⇒ **背压**（泵阻塞而非无限堆积 OOM）。
- `v8Queue` 并发 = **S = 池里 VM 的个数**（不是 1！v2 的 v8Queue 与 v1 的关键差异）。
- `cpuQueue` 并发 = `max(1, Environment.ProcessorCount - 1)`（留一核给 Kestrel/WS）。
- ⚠ **别合二为一**：合成一条配 N 个 worker，V8 类 job 仍要抢 VM 独占权 ⇒ 队列语义会骗人。
- ⚠ **`TickVmPool` 与读路径的 `JsEngineHost` 是两套独立的 VM** ⇒ **tick 与人类请求零门闩争用**（v1 §5.5「tick 让位于人类」的 `TryWait` 那套在 v2 里**不再需要**）。这是 v2 的一个意外收获。
  ⚠ 代价：多 S 份引擎常驻内存（一份 `mapgen` 的缓存 + V8 堆）⇒ 需实测 `TickVmMemory`，并在 `S` 与内存间取平衡（列 P2 验收项）。

### 6.8 合流器（唯一写世界的入口）

```
OnPatch(JobResult r):
    results[r.Key] = r
    若本 tick 的批全齐了:
        按 (Layer, SortKey, Id) 全序排序
        foreach r in order:
            apply(r.Patch)                              // 写 WorldState / 落库(settle 包)
            if r 影响可变图层: BumpBlockRev(seed, ca, cb, 该层位)
            if r 改了引擎派生: InvalidateEngineCache(r) + forceStaticDirty()
            标记该 job 行脏（NextTick 推进）
        FlushDirtyJobs()                                // 批量 UPSERT（§2.2）
```

- ⚠ **合流顺序必须是稳定全序**，且**与到达顺序无关**（到达顺序由线程调度决定 ⇒ 不确定）。排序键 = `(Layer, SortKey, Id)`。
- **重排放在合流后**：job 只有成功 apply 才推进 `NextTick`，否则「失败也推进」= 静默跳过周期。
- **失败语义**：`失败 ⇒ NextTick = now + BackoffTicks`（不是 `+Period`，避免和正常周期撞一起），连续失败 `MaxFails` 次 ⇒ `Enabled = 0` + 写日志 + `/stats` 上报。⚠ **绝不静默停摆**。
- ⚠ `JobResult.Key` 必须含 `(EntityId, Kind)` —— 否则同实体不同 kind 的返回会被互相覆盖。

### 6.9 tick 预算与分帧

- **`TickBudgetMs` 硬上限**（建议 300ms/次批量）：超了就切片，未完成部分顺延（`IncompleteTicks++`）。
- ⚠ **L2 道路重算 405~443ms** ⇒ 必须排**低频（1 年）+ 分帧**（一年摊成 12 个月 tick，每月 1/12），否则每年那一下明显卡顿。
- ⚠ 与人类请求抢门闩的问题**在 v2 已被 VM 池隔离消解**（§6.7）。但 **L2 仍走读路径 VM** ⇒ L2 的按需分帧照旧保留（它抢的是读路径门闩）。

---

## 七、gzip 语义（全链路压缩边界）

**唯一规则**：**压缩是「存储 / 传输」层的事；V8 边界恒为未压缩裸 proto。**

| 链路 | 是否压缩 | 依据 |
|------|----------|------|
| SQLite `Data.Value`（chunk/comm/settle 包） | ✅ gzip(proto) | 既有约定 |
| SQLite `TickJob.Payload` / `WorldClock` / `TickPerf` | ❌ 不压 | 行很小，gzip header 18B 净亏 |
| WS → 客户端 | `TileResponse` **恒 gzip**；Place 系帧**明文** | 既有（按帧类型判别） |
| HTTP → 客户端 | `Content-Encoding: gzip` | 既有 |
| **C# → V8** | ❌ **解压后传裸 proto** | ★ 本方案 |
| **V8 → C#** | ❌ **裸 proto 回来** | ★ 本方案 |
| V8 产出的 patch → 落库/下发 | ✅ **由 C# 再 gzip** | ★ 本方案 |

⚠ 三条推论：
1. **绝不要把 gzip 后的字节喂给 V8** —— V8 侧要么解压（额外 CPU + 又要一份 buffer），要么根本无法处理。压缩/解压只在 C# 侧发生。
2. 从 DB 读已落库的 settle 包喂 V8 时，直接复用既有的 `GzUnwrap`（`MapWorldService` 里就有，`GZipCodec.Decompress`）⇒ `gzip(proto) → proto → WriteBytes → V8`。
3. 落库前才 gzip ⇒ 合流器里 `GZipCodec.Compress` 一次；**不要**在 V8 侧压缩（V8 没有 gzip API，且那是宿主职责）。

---

## 八、V8 运行期成本统计（v2 新增）

### 8.1 必须**分段**计时，否则「优化」是猜的

```
t_total
 ├─ t_gz_unwrap     解压（若来源是 DB）
 ├─ t_pb_ser        宿主侧快照序列化（proto）
 ├─ t_xfer_in       WriteBytes（跨堆拷贝）
 ├─ t_js            纯 JS 计算         ← ★ 唯一「该被优化」的一段
 ├─ t_xfer_out      ReadBytes
 └─ t_apply         合流 apply（含 rev / 失效 / 落库）
```

⚠ 为什么必须分段：`t_total` 变大可能是「快照传多了」（`t_pb_ser`+`t_xfer_in`），也可能是「JS 真算多了」（`t_js`）。**只看 `t_total` 会朝错误方向优化**（比如去优化 JS 算法，而瓶颈其实是快照膨胀）。

### 8.2 内存

| 指标 | 拿法 | 备注 |
|------|------|------|
| V8 堆 / 堆外 | ClearScript 是否暴露 `GetHeapStatistics` ⇒ **需 spike**；否则用进程 `WorkingSet` 差分 | ⚠ 不要编 API 名 |
| 跨堆拷贝量 | `reqLen` / `respLen` 累计（自己的计数器，最可靠） | 单位 bytes/tick |
| 托管分配 | `GC.GetAllocatedBytesForCurrentThread()` 差分 | 抓「有没有偷偷 new」 |
| VM 常驻 | 每个 `TickVm` drop 前后 WorkingSet 差分 | 决定 `S` 的上限 |

### 8.3 落哪

⚠ 独立表 `TickPerf`（**不能进 `Data`** —— `PruneExcept` 会静默删）：

```sql
CREATE TABLE IF NOT EXISTS TickPerf (
  Seed TEXT NOT NULL, Tick INTEGER NOT NULL, Kind TEXT NOT NULL,
  N INTEGER NOT NULL,
  MsGz INTEGER, MsSer INTEGER, MsJs INTEGER, MsApply INTEGER,
  BytesIn INTEGER, BytesOut INTEGER, VmDrops INTEGER,
  PRIMARY KEY (Seed, Tick, Kind)
);
```

- 逐 tick 全存会写放大 ⇒ **内存环形缓冲（最近 N tick）+ 每 30 tick 聚合一行落库**。
- `/stats` 暴露实时快照：`tick / pendingJobs / incompleteTicks / tickMsP50 / tickMsP95 / jsMsShare / bytesIn / vmDrops`。
  ⚠ 用 **P50/P95 而非平均**：平均值会被 catch-up 那几次异常值掩盖（工程既有教训：首测含 JIT，85 vs 中位 31ms ⇒ 交替多轮取中位）。

---

## 九、protobuf 作为全局数据骨架（v2 新增）

### 9.1 契约清单

```
① 落库/下发（既有，不动）
   chunk / region / settle / comm / poi / place  ← MapMessages.cs（protobuf-net）
② tick 跨界（新增）
   TickBatchRequest  { proto_ver, tick, seed_hash, repeated TickJob }
   TickJob           { entity_id, kind, layer, dt_ticks, phase_key, payload }
   TickBatchResponse { repeated TickResult, computed, errored, legacy_json }
   TickResult        { entity_id, kind, err, repeated Patch }
   Patch             { 变体: AttrPatch | TownPatch | TradePatch }
③ 快照（新增）
   WorldSnapshot     { tick, repeated SettleSnapshot, repeated ExtSettle, repeated TradeEdge }
④ 台账（新增，BLOB 列承载 ②③ 的子消息）
   TickJob.Payload / WorldClock.* / TickPerf.*
```

### 9.2 ⚠ 三处实现必须对齐（否则静默错位）

| 处 | 角色 | 文件 |
|----|------|------|
| C#（protobuf-net） | 权威 schema，`[ProtoMember(n)]` | `Domain/TickMessages.cs`（新增） |
| 引擎（V8 侧） | **编 + 解** | `Engine/js/pben.js`（新增） |
| 前端（`pb.js`） | **只解**（不下发 tick 帧时可不涉） | `web/js/pb.js`（既有） |

⚠ **工程量提醒**：引擎侧不要写通用 protobuf 运行时。**按 §9.1 的 schema 手写「按字段号取值 / 按字段号写值」的函数**即可 —— 这正是 `mapgen-server.js` 既有风格（它手写位打包）。字段数 ~30 个，够用且好审。

⚠ 判据 `check_tick_pb_roundtrip.mjs`：Node 侧用 `pben.js` 编码 → 用 `pb.js` 解码 → 断言字段逐值一致；再拿同一份字节喂 C#（跑一个小 CLI）反序列化 → 断言一致。**三处任何一处字段号错了，这条判据当场红。**

---

## 十、接线点（与现有系统逐个对齐）

| # | 接线点 | 动作 | 风险 |
|---|--------|------|------|
| 1 | **`WorldLedger`** | 时钟/调度/性能三张表与种子同库**独立表**（`WorldClock` / `TickJob` / `TickPerf`） | ⚠ 塞 `Data(Key,Value)` 会被 `PruneExcept` 静默删 |
| 2 | **`PlaceEntity.expireTs`** | 语义从「Unix 时间戳」改为 **`ExpireAtTick`** | devdoc §二 明说本版不实现、留待世界演化。⚠ 若沿用 `int64`，**老数据要区分**（tick 恒 < 1e6，时间戳 ~1.7e9，靠量级判别） |
| 3 | **`BumpBlockRev`** | 合流器对每个影响可变图层的 Patch 调用（`TileMask.Settle/Poi/…`） | ⚠ `MapWorldService` 的 **C5 显式契约**原文：「任何会让某块某图层内容变化的服务端改动**必须**调用」——**本方案就是那个调用者**。漏了 = 前端带旧 rev 重拉被判「未变化」= 改了没反应、**不报错** |
| 4 | **`forceStaticDirty`** | 同上（引擎侧派生缓存失效） | 漏了 = 引擎内部缓存与画面不一致 |
| 5 | **★ 新增失效出口** | `invalidateTowns/Trades/Regions`（§6.4） | 漏了 = 单格点击/区域包看到旧建筑。⚠ 要**容忍 VM 不在内存**（`TryGet`，不 `GetOrCreate`） |
| 6 | **`WsFrame` 帧 7** | `ClockQuery / ClockPush`（帧 7 已被 P2「城市迭代」预留，正好归它） | ⚠ 别占别的号；帧 5/6 已给 PlaceCheck/PlaceCommit。**帧 7 是否 gzip 需一次钉死**（建议**明文**：时钟包极小，gzip 净亏，且要避开「按帧类型判压缩」的歧义） |
| 7 | **前端** | 帧 7 下发 `{tick, year, month, day, season, ratePerSec}`；客户端**本地插值**（`tick + elapsed/1000`），每 10 tick 校准一次 | 每秒推一帧会与 Tile 响应抢 WS 带宽；插值即可 |
| 8 | **`PlayerSectStore`** | 玩家宗门也参与 tick（拓土成本、气运累积）⇒ 从台账读、写回台账 | ⚠ 台账是**玩家资产**，改动必须留判据 |
| 9 | **`JsEngineHost`** | ⚠ **只加不删**：新增 `CallBytes` 与失效出口 case；**保持既有 17 个 JSON 出口原样** | 改 `Call` 签名会波及 17 处 |
| 10 | **`TickVmPool`** | 新建，**与 `JsEngineHost` 并列**（两套 VM） | ⚠ 多 S 份引擎常驻内存；`init(seed)` 冷启数百 ms ⇒ 必须预热 |
| 11 | **`/stats`** | 上报 §8.3 的指标 | 探活对账用（对齐现有 `StatsJson` 风格） |

### 10.1 新增文件布局（建议）

```
Server/Zongmen/Time/
├─ GameClock.cs             纯函数：tick ↔ 年/月/季/日、墙钟换算（无状态、可单测）
├─ WorldClockStore.cs       独立表 WorldClock（⚠ 不进 Data）
├─ TickJobStore.cs          ★ 独立表 TickJob 的载入 / 批量 UPSERT / 对账（§二）
├─ TickPerfStore.cs         ★ 独立表 TickPerf（环形缓冲 + 聚合落库）
├─ PhaseHash.cs             ★ 相位派生（fnv1a + mix32），纯函数可单测
├─ TickJob.cs               Job / Layer / Resource / JobSpec
├─ TickJobRegistry.cs       Kind → JobSpec（读写集 + 引擎缓存声明）★ 解耦的唯一真源
├─ TickScheduler.cs         小顶堆 + AdvanceTo + 空转 Peek + 重排
├─ TickPartitioner.cs       第一步：独立性判定 → 批
├─ TickBatch.cs             批（Layer / 规范序 / Jobs / 快照句柄）
├─ TickPipeline.cs          第二步：两条 Channel + 合流器
├─ TickPump.cs              BackgroundService：1Hz 单调脉冲 + catch-up 预算
├─ TickVmPool.cs            ★ 无状态执行器 VM 池（与 JsEngineHost 并列）
├─ TickMetrics.cs           ★ 分段计时器（§8.1）
├─ WorldPatch.cs            私有写产物 + 定序合并
└─ Jobs/
   ├─ TownEvolveJob.cs       ★ L1：城镇足迹生长 + 建筑升降级（聚合，§5.2）
   ├─ TradeEdgeJob.cs        ★ L1：贸易边局部重估
   ├─ ReputationJob.cs       ★ L1：势力声望单轮扩散
   ├─ PopGrowthJob.cs        L0（按 dt 积分）
   ├─ SectCultivationJob.cs  L0
   └─ RoadReworkJob.cs       L2（单元素批，走读路径 VM，分帧到月 tick）

Server/Zongmen/Domain/TickMessages.cs        ★ tick 的 proto 契约（§9.1）
Server/Zongmen/Engine/js/pben.js             ★ 引擎侧 pb 编解码（bundle 加它，指纹不加）
Server/Zongmen/Engine/js/mapgen-server.js    ← 追加 tickBatch / invalidate* 出口
```

⚠ `pben.js` 的挂载点裁决与 `mapgen-server.js` 的 switch case 已在 §6.6 列清。

---

## 十一、分期实施

### P1 —— 时钟 + 三张表 + 相位 + 调度 + L0 摊批（最小可跑通闭环）

- `GameClock` 纯函数 + `WorldClockStore` / `TickJobStore` + `TickPump`（1Hz 单调）
- `PhaseHash` + `TickScheduler`（小顶堆 + 空转 Peek）+ `AdvanceTo` 的 `DtTicks`
- `TickJobRegistry`（先只有 L0 的 2~3 个 Kind）
- ⚠ **P1 就上 protobuf 边界**（`pben.js` + `CallBytes` + 复用缓冲）—— 因为「先 JSON 后换 proto」等于把跨界层写两遍。**这是 v2 与 v1 在分期上的关键差异**。
- ⚠ **P0 spike 必做**：`spike_v8_abuffer.mjs` —— 验证「宿主拿 `IArrayBuffer` 句柄 + `WriteBytes` + JS 侧读」这条链在 **7.4.5** 上跑得通（§十二）。
- WS 帧 7 下发时钟；前端面板显示「第 N 年 春 一月 三日」
- **不做**：双缓冲（L0 写集天然不相交）、`TickVmPool`（P1 先用读路径 VM 串行跑）、L1/L2

判据：`check_clock.mjs`、`check_tick_lazy.mjs`、`check_tick_phase.mjs`、`check_tick_pb_roundtrip.mjs`、`check_tick_job_persist.mjs`。

### P2 —— 无状态 VM 池 + L1 四项 + rev/失效接线

- `TickVmPool`（预热 S 个、复用缓冲、可 Drop）+ `TickMetrics` 分段计时
- 双缓冲快照 + `WorldPatch` 定序合并 + 合流器
- L1 四项（`TownEvolve` / `TradeEdge` / `Reputation`）+ 分批器
- **★ `BumpBlockRev` + `forceStaticDirty` + `invalidate*` 三件接线** —— 这一步才真正让前端看见演化
- ⚠ **引擎演化参数走「扩展层」**（对齐 `settlementsFor = $base + extIn` 零拷贝模式）：`TownGrowth` 要读演化参数（`tier`/`pop`），而当前 `growTownFootprint(id, type, q, r)` **不读这些** ⇒ 需要 overlay。**把 overlay 做成 `$base + evoIn`，保住 `townCache` 的 `$base` 逐字节不变**，否则 `mapgen.js` 改动会改 `ComputeEngineHash` ⇒ 前端误判引擎升级、静默回退。
  ⚠ 附带：**任何影响画法的 flag 必须同步加到 `spriteOf` 的缓存 key**（既有坑）。
- `PlayerSect` 参与 tick；一次性事件（`PeriodTicks = 0`）立即落库
- 判据：`check_tick_determinism.mjs`、`check_tick_rev.mjs`、`check_tick_no_pollute.mjs`

### P3 —— L2 全局 + 并行扩展 + 快进

- `RoadReworkJob`（全局串行、分帧到月 tick，走读路径 VM 的 `Lease + 同款序列`）
- 跨世界并行（按 seed 分池）；`SharedArrayBuffer` 零拷贝共享只读快照（§6.5.5）
- 时间轮升级（若 job 数 > 1e5）；离线快进（`OfflineCatchUp`）
- **既有 17 个 JSON 出口迁裸 proto**（chunk/region 收益最直接：省 base64 的 33%）
- 判据：`check_tick_road.mjs`（`roadVer` 严格 +1，⚠ 绝不归零）

---

## 十二、验收判据清单（对齐工程的「判据文化」）

| 判据 | 断言类型 | 要点 |
|------|----------|------|
| `check_clock.mjs` | **恒等** | `tick=359` → 第 1 年 冬 十二月 三十日；`tick=360` → 第 2 年 春 一月 一日。全 360 值穷举自洽 |
| `check_tick_lazy.mjs` | **恒等**（不是阈值） | `调用次数 == floor(总 tick / PeriodTicks) + 首次相位命中 ?1:0`；**无 job 的 tick 里 `Peek` 次数 == 1** |
| `check_tick_phase.mjs` | **统计 + 恒等** | ① 相位不改周期：360 tick 内每 job 计数严格相等；② 分布：N 个 job 的 `Phase` 分 `Period` 个桶，`max/min` 桶比 < 阈值（测哈希质量，非性能；⚠ 固定 seed 保证可复现）；③ 同输入两次派生结果恒等 |
| `check_tick_job_persist.mjs` | 恒等 + 幂等 | 落库→载入→堆内容逐字节一致；载入后再 flush 不产生变更（幂等）；一次性事件**立即**落库（不等 flush 窗口） |
| `check_tick_pb_roundtrip.mjs` | **交叉源** | `pben.js` 编码 → `pb.js` 解码 → 字段逐值一致；同一份字节 C# 反序列化一致（三处实现对齐） |
| `spike_v8_abuffer.mjs` / `.cs` | **可行性**（P0 前置） | 7.4.5 上：宿主取 `IArrayBuffer` 句柄 → `WriteBytes` → JS 侧 `new Uint8Array(buf)` 读到 → JS 写 → 宿主 `ReadBytes` 读回。失败则降级为 7.5+ 升级或「base64+proto」 |
| `check_tick_determinism.mjs` | **A/B 归因** | 同 seed + 同起 tick，两跑输出**逐字节**一致（绝不写「耗时 < N ms」这类绝对值阈值） |
| `check_tick_rev.mjs` | 语义 | 演化后某块 `settleRev` 前进；客户端带旧 rev 重拉**必须**收到该层 |
| `check_tick_no_pollute.mjs` | **红线守卫** | 跑 1000 tick 后，`settleCache`/`siteScoreCache`/`regionCache` 与 tick=0 时**逐字节相同**（`$base` 零污染） |
| `check_tick_chunk_immutable.mjs` | **红线守卫** | 跑 1000 tick 后，任意块的 `chunk` 字节与 tick=0 时**逐字节相同** |
| `check_tick_road.mjs` | 单调性 | `roadVer` 严格 +1；⚠ **绝不归零**（归零 = 撞 `ObserveRoadVer` 单调取大 ⇒ tile 判新鲜 ⇒ 送不出去） |
| `check_tick_budget.mjs` | 语义 | 单 tick 超 `TickBudgetMs` ⇒ 标记 incomplete 且**不阻塞**下一 tick（无死循环） |
| `check_tick_dt.mjs` | **恒等** | 「每 30 天算 1 次 × dt=30」与「每 30 天算 30 次 × dt=1」结果**在容差内一致**（验证 §3.3 的积分语义） |

⚠ 判据三防（工程既有教训）：① 不用绝对值阈值，用 A/B 归因；② 参照系不能是被测规则自己的目标函数；③ 复算必须与实现**同容差语义**；④ 源码守卫别用「固定字符窗」判邻近 ⇒ 判「赋值点所在**整个函数体**」。

---

## 十三、待拍板项

1. **离线是否追补**：默认「冻结」（重启续档不按墙钟补）。若要挂机演化，需 `OfflineCatchUp` + 快进路径。
2. **ClearScript 是否升 7.5**：升级换 Span 直写（省一次拷贝）vs 保持 7.4.5（`byte[]` 重载够用，但要跑全量回归）。**建议先不升**，等 `spike_v8_abuffer` 结果 + P2 实测拷贝占比再定。
3. **`TickVmPool` 的 `S`**：`ProcessorCount - 1`？还是按内存反推（每个 VM 常驻多少 MB × S < 预算）？需 P2 实测。
4. **L0 的摊批 `M`**：30（月）还是 7（旬）？`M` 越大越省，但演化「粒度感」越粗（人口会「跳」）。⚠ 前提是先确认所有 L0 公式写成了 `dt` 积分。
5. **`TradeEdge` 是否本轮做**：只做边级局部重估（可并行）？全局势能流列 P3？
6. **一次性事件（`PeriodTicks = 0`）本轮是否做**：P2 可以做（表已经在了，成本低）。
7. **前端每秒一帧 vs 本地插值**：建议本地插值 + 每 10 tick 校准。
8. **`expireTs` 字段改制**：沿用 `int64` 承载 tick（靠量级判别老数据），还是新增 `expireTick` 字段？（前者省协议改动，后者干净）
9. **帧 7 的压缩约定**：建议**明文**（时钟包极小，gzip 净亏，且避开「按帧类型判压缩」的歧义）。
10. **引擎 pb 编解码器的落点**：`pben.js` 独立文件（本文档建议）vs 直接内联进 `mapgen-server.js`（少一个挂载点）。⚠ 内联会让 `mapgen-server.js` 变长，但它本来就不参与指纹，加文件也只是动 bundle 数组一处。**倾向独立文件**。

---

## 十四、一页伪代码（把全链路串起来）

```csharp
// TickPump（每秒一次，单调时基）
while (!ct.IsCancellationRequested) {
    await WaitToNextSecondBoundary();
    for (int i = 0; i < MaxCatchUp; i++) {
        var due = _sched.AdvanceTo(_clock.Tick);        // 空则 O(1) 返回（一次 Peek）
        if (due.Count == 0) break;
        foreach (var batch in _partitioner.Partition(due))   // ★ 第一步：解耦
            _queueFor(batch.Resource).Writer.TryWrite(batch); // 第二步：投递
        _clock.Tick++;
    }
}

// V8 worker（S 个无状态 VM，每个 VM 内部仍串行）
await foreach (var batch in _v8Queue.Reader.ReadAllAsync(ct)) {
    var vm = _pool.Lease();                                   // 无状态 ⇒ 归还无需清理
    try {
        var snap = _snapshot.Freeze(batch.ReadSet);           // ① 冻结读集（COW）
        var req  = _codec.EncodeRequest(batch, snap);         // ② proto，未压缩
        m.Mark("ser");
        var n = vm.CallBytes(req, m.OutSpan);                 // ③ ArrayBuffer 直传
        m.Mark("js");
        _joiner.Submit(batch, vm.OutBuf.AsSpan(0, n));        // ④ 裸 proto 回传
    } catch { _pool.Drop(vm); throw; }                        // 无状态 ⇒ 丢弃零损失
}

// 合流器（单线程，唯一写世界的入口）
void Submit(batch, ReadOnlySpan<byte> patchProto) {
    var r = _codec.DecodeResponse(patchProto);
    _pending.Add(r.Key, r);
    if (!_pending.AllDone(batch.TickId)) return;
    foreach (var item in _pending.TakeOrdered(batch.TickId))      // (Layer, SortKey, Id) 全序
        _applier.Apply(item);    // 写 WorldState + 落库
                                 // + BumpBlockRev + forceStaticDirty + InvalidateEngineCache
                                 // + 标记 NextTick 脏（合流后才推进）
    _jobs.FlushDirty();          // 批量 UPSERT；一次性事件已在插入时立即落库
}
```

---

## 附 A：与「前端自算地形」的关系（为什么红线 1 成立）

工程现状：**地形 chunk 由前端按 seed 自算**，WS 的 `mask` 已把 `CHUNK` 位剔掉（=30）。
这条链路成立的前提**只有一条**：「地形是 seed 的纯函数，永不变」。

tick 框架引入的「世界可写」是本项目第一次让世界带上状态。只要严守 §1.4 红线 —— **tick 只写可变派生层，绝不写 seed 纯函数层** —— 前端自算与 tick 演化可以长期共存：

```
静态层（seed 纯函数，前端自算）        chunk / settleCache / siteScoreCache   ← tick 绝不触碰
动态层（服务端权威，tick 演化）        settle 包 / townCache / tradeCache / 实体属性
                                        ← 走 WS + rev 失效 + invalidate* 出口
```

---

## 附 B：v2 的关键推翻与理由（给未来的自己）

1. **「用 V8 并行不可能」→「单 VM 不可能，但可以开多个 VM」**：用户点破的。真正的杠杆不是让 V8 并行，而是**把世界的权威态从 VM 里搬出来**（搬到 C#/SQLite），VM 就退化成可复制、可丢弃、可并行的纯函数执行器。
2. **「lazy 不需要落库」→「必须落库」**：因为**一次性事件是内容不是派生**。这跟 `WorldLedger`/`PlayerSectStore` 必须独立成表的道理一样 —— **只要有东西无法从 seed 重建，它就必须有自己的账**。
3. **「固定周期」→「固定周期 + 哈希相位」**：lazy 的敌人不是「算得太多」，而是「**算得太集中**」。峰值决定队列深度与 VM 池大小，均值不决定任何东西。
4. **「V8 边界传 JSON」→「ArrayBuffer + protobuf」**：JSON+base64 在 ASCII 场景下行放大 ~2.7×，还有 4 次分配。这是**每 tick 都要付**的成本，不是一次性成本。
5. **「tick 让位于人类请求」→「VM 池天然隔离」**：把 tick 的 VM 与读路径的 VM 分开，门闩争用问题**从设计里消失**（比加 `TryWait` 超时逻辑更干净）。代价是内存 —— 用 `S` 换确定性，比用「偶尔跳过一 tick」换便宜。
6. **「忘掉的失效出口」**：读路径 VM 的 `townCache` 不会自己知道世界变了。**这是本方案最容易在 P2 静默失败的一处** —— 玩家看到旧建筑，且不报错。
