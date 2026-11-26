# 跨 Tick 事件系统 —— 外部资料调研

> 目的：为「每个 entity 记录下一个待触发事件 + 脚本入口 + 全剧唯一 id」找可复用的成熟设计，避免自造。
> 调研时间：2026-11-27。所有结论附带来源链接，可复核。

---

## 零、一句话结论

工业界的做法**不是**"一个优先队列 + 一堆回调函数"，而是**三层分离**：

| 层 | 职责 | 是否可丢 |
|---|---|---|
| 持久层（权威） | 每个实体自己存"下次触发时间 + 事件类型" | 不可丢，重启恢复的唯一依据 |
| 调度层（加速） | 内存最小堆 / 时间轮，只为快速找到"最小 tick" | 可丢，随时能从持久层重建 |
| 执行层（派发） | tick 结束后统一分发事件，调脚本入口 | 可重放 |

你描述的"维护优先队列 → 取最小 tick → 查 entity 的事件和脚本入口"正好对应其中第 2、3 层，但**第 1 层不能省**，否则重启就丢事件。

---

## 一、七个可引用的成熟设计

### 1. 时间轮是"加速结构"，不是事实来源

> "时间轮适合处理秒级到分钟级任务，但它的语义是**可丢失的运行态加速结构**，不应该成为唯一事实。Buff 的结束时间仍然要写在角色状态里，时间轮只是到点触发重新计算。进程重启后，服务根据角色状态重建时间轮。这样即使某个过期事件没触发，下次读取状态也能根据结束时间纠正。"

来源：[游戏服务器世界时钟与 Tick 架构设计](https://plumephp.com/game-server-world-clock-tick-architecture)

**对本项目的映射**：`TickJob` 表（存 `NextTick`）就是"写在状态里的结束时间"，`ConcurrentTickQueue` 是加速结构。这个分工已经是对的，不要为了省一张表把 `NextTick` 只放内存。

### 2. 三种时间绝对不能混用

同一篇文献把时间分成三个接口，代码评审时"看到跨层使用就要追问理由"：

| 时间 | 用途 | 特性 |
|---|---|---|
| `monotonicTime` | 实时模拟、tick 推进 | 单调递增，不因系统校时而倒退 |
| `wallClock` | 日志、超时 | 可跳变 |
| `businessCalendar` | 每日重置、活动开启 | 带时区 |

你的 `WorldClock` 属于第一类。**事件系统的 `NextTick` 必须只吃 tick，绝不吃 `DateTime.Now`**——否则回放必然分叉。

### 3. tick 内事件必须"先收集、后分发"（两阶段）

SLG_DEMO 的分层时间轮实现里，整条链路是：

```
TickTimer(1Hz) → World.Tick → MarchMgr.Tick → wheel.Tick
                                                    ↓
                                          emit(ArriveEvent)   ← 只入队
                                                    ↓
                                        「tick 处理完毕后」才 dispatch
```

原文关键点：

> "事件在 tick 完成后才进行分发，从而确保所有计时器处理都在副作用传播之前结束。由于 `World.Tick` 先处理 `MarchMgr.Tick`，然后再排空 `events` 切片，因此所有由计时器触发的到达事件都会在任何分发逻辑运行之前被收集完毕。这可以防止在 tick 处理期间触发的到达事件引发战斗结算，从而避免在其他计时器仍在触发时改变状态。"

来源：[分层时间轮 · SLG_DEMO](https://zread.ai/zfunnily/SLG_DEMO/7-hierarchical-timing-wheel)

**这是本设计最重要的一条。** 原因：如果 A 事件的处理过程中直接触发 B 事件并立即执行，那么"本轮还有哪些事件"取决于执行顺序，回放就会分叉。拆成"收集 → 统一分发"后，一个 tick 的输入集合是确定的。

### 4. 事件级联要记父事件（可追溯因果）

Eventure 框架的 `EventCascade` 给每个事件记 `parent_event`：

> "Every event can have a parent event that triggered it. Complete traceability from cause to effect."

来源：[Eventure — event-driven framework for simulations/games](https://git.mafyuh.dev/enricostara/eventure)

**对你的价值**：一个 tick 内 A 触发了 B、B 又触发了 C，如果没有父子链，回放时只能看到三条并列事件，无法解释"为什么这一 tick 冒出 300 个事件"。加一个 `CausedBy` 字段（可空）即可。

### 5. 事件溯源：history 只存"变化"，状态靠重放算

同一篇 Eventure 文档的定位：

> "Events as the single source of truth for all state changes. Current state is derived by replaying the event history. `log.get_events_until_tick(5)` → 状态重建到第 5 tick。"

**这直接回答你之前问的 history 怎么省**：history 存 `(tick, entityId, eventKind, delta)`，不存 `CityState` 全量快照。全量快照只按固定间隔存一份（比如每 1000 tick），重放时"最近快照 + 之后的事件"即可。

### 6. 排序键必须逐字段稳定，绝不能用指针/哈希反序

GDC 2016 David Salz《Deterministic Simulation》的经典结论：

> "接触排序按 `(min(idA,idB), max(idA,idB), featureId)`。宽相哈希遍历后必须排序再交给窄相。这点不做，回放必炸。"

来源：[Deterministic Simulation, GDC Europe 2016](https://media.gdcvault.com/gdceurope2016/presentations/Salz_David_Deterministic_Simulation.pdf)

**对本项目的映射**：`TickScheduler.CompareByCanonicalOrder` 逐字段比较 `(Layer, EntityId, Kind)` 是对的做法。反例是之前删掉的 `TickJob.SortKey`（每次访问新建字符串、且排序依赖字符串拼接顺序）——那种写法一旦被 `OrderBy` 用上就是回放炸弹。

⚠ 补一条本项目特有的坑：`Kind` 如果按 `(int)enum` 排序，**在枚举中间插成员会改变历史 job 的相对顺序** ⇒ 同一个 seed 重放结果不同。所以排序必须用 `KindCode`（显式固定码 1..8），这和你已经做的 `KindNames.Code` 是同一个理由。

### 7. 脚本入口 = 注册表，不是动态函数名

云风《开发笔记(15) 热更新》描述的分发器模型：

> "每个服务就是一个包分发器。主干代码在启动时，将一组组函数按模块加载入框架。框架分发消息包，经由分发器调用消息处理函数。热更新其实也是由一个消息来触发的……只需要把消息处理函数的分发器重置，重新把新版的消息处理函数塞进去就可以了。"

来源：[开发笔记(15): 热更新 · 云风](https://blog.codingnow.com/2012/03/dev_note_15.html)

**这正好对上你要的"脚本入口函数"**：事件表里存的不是字符串函数名（`"onPlague"`），而是一个 **registry key**：

```
EventKind(1 字节) → Registry[kind] → (scriptName, fnName)
```

三个好处：
1. 表里只存 1 字节，不存 `"city-events"` / `"onPlague"` 这类重复字符串（你关心的省内存）；
2. 静态可校验 —— 可以写脚本扫一遍 registry，确认每个 fn 在 JS 里真实存在（对应项目里的 `verify/check_js_exports.mjs`）；
3. 热更时"重置分发器塞新函数"，表里数据一个字都不用改。

**反例**：把 `{script:"x", fn:"y"}` 直接塞进事件行 → 动态函数名绕不过静态白名单检查，拼错只能在运行时炸"未知 JS 函数"。

### 8. 监控指标是 schedule_lag，不是队列长度

延迟任务系统的工程文献给了一条通用指标：

> "`schedule_lag = now - min(pending 中最早 trigger_at)`。它是「最老的那个已经该触发但还没被触发的任务，晚了多久」。这个指标比「队列长度」准得多——队列长度 100 万可能只是未来 24 小时的任务，而 lag 是 3 秒就说明真的出事了。"

来源：[百万级延迟任务调度系统怎么设计](http://www.d7kj.com/blog/2026/11/16/delayed-task-scheduler-interview)

**对本项目的映射**：`TickPerf` 现在只记每批耗时。要加一个 `lag = currentTick - heapTop.NextTick`，一旦 > 0 就说明 tick 在追帧。

同文还有两条：① 幂等靠"唯一 ID + 去重表"；② 取消用**懒删除/失效标记**，不真删。

---

## 二、最小堆 vs 时间轮：本项目该选哪个

文献的对照结论很一致：

| 方案 | 增/删 | 取最小 | 精度 | 取消 | 适用 |
|---|---|---|---|---|---|
| 最小堆 | O(log n) | **O(1)**（堆顶） | 精确 | O(log n)，需 id→索引映射 | 中等量、要精确 |
| 单层时间轮 | O(1) | O(1)（指针） | 退化到一格 | O(1)（需句柄） | 海量、短周期 |
| 分层时间轮 | O(1) | O(1) | 退化到一格 | O(1) | 海量、跨度大 |

**选最小堆，不选时间轮。** 三条理由都能从文献里找到支撑：

1. 游戏后台的 Tick 本身就是分片（本项目 `WorldClock` 有固定 tick 间隔），"秒级粒度"这个前提已经满足 ⇒ 时间轮"减少空跑"的优势不成立。
2. 原文：「多级时间轮主要解决间隔跨度较大的问题……从游戏后台的实际需求出发，Timer 常用于几秒至几十分钟，以小时记的非常少见。」你的 `townEvolve` 是 90 tick 周期，跨度差别不大。
3. 时间轮最怕"跨度极不均匀"：一个 90 tick 的周期任务 + 一个"3 天后触发"的一次性事件，塞进同一个轮子要么取模碰撞要么加圈数。

来源：[游戏后台定时器系统设计与实现](https://www.gameres.com/384649.html) / [Q60: 如何设计定时器系统](https://cuihairu.github.io/apollo/qa/q60-timer-system)

> 注：如果将来事件量到千万级（每日任务 + 冷却 + 刷新全挂上去），再换分层时间轮。现在 `TickJob` 是 50 行，换轮子是纯负收益。

---

## 三、取消语义：懒删除是对的

文献共识：

> "取消操作：定时器经常会遇到「回调前被取消」「回调执行时再次注册」「对象已销毁但定时器还在」，所以必须有明确的生命周期约束和失效检查。常见做法是懒删除或失效标记。"

本项目已经有对应实现：`ConcurrentTickQueue` 收集时把 `NextTick` 设为 `RevokedTick` 哨兵。这是标准做法，**不要改成真删除**——真删除要维护 `id → 堆内索引`，代价是每个节点多存一个 int，而且并发下容易错。

---

## 四、和本项目现状的对照表

| 需要的能力 | 现成有什么 | 缺什么 |
|---|---|---|
| 每个实体记下次触发时间 | `TickJob.NextTick`（落库） | — |
| 取最小 tick | `ConcurrentTickQueue` 堆顶 | 没有只读属性暴露；没有 `lag` 指标 |
| 事件类型 + 脚本入口 | `TickJobKind` + `KindNames.Code` | **只有编译期枚举，没有 registry → (script, fn)** |
| 全局唯一实体 id | `EntityIdAllocator`（int32，已写未接） | 未接入主链路 |
| 同一实体多事件 | 主键 `(Round, EntityId, KindCode)` | **缺 `EventKey` 维度**：同实体同 kind 只能一条 |
| tick 内定序 | `CompareByCanonicalOrder` | 缺"收集→分发"两阶段：现在是 job 直接 `ApplyOutcome` |
| 事件级联追溯 | 无 | 缺 `CausedBy` |
| 幂等/重复触发 | 部分（`FailCount`） | 缺"已执行"标记 —— 崩溃在"执行完、未提交"之间会重放 |

---

## 五、三个必须你拍板的决策

### 决策 1：事件只挂聚落，还是一路挂到人物/弟子？

- 只挂聚落 → 直接用 `CityState.Id`（`-3_-3_0`），改动最小。
- 挂到人物 → 人物 id 是 `c` + 17 位大数，且 **`personIndexOf` 只吃 `(q,r,k)`，pop 一降尾部 id 就消失** ⇒ 必须另存 `(q,r,k)` 快照并在触发时校验 `k < 当前人数`，否则事件永远挂空。

文献里没有对应方案，这是本项目特有的坑。

### 决策 2：脚本入口用"注册表 key"还是"字符串 script/fn"？

强烈建议注册表 key（见 §1.7）。代价：新增事件类型要改 C# 枚举 + 注册表两处；收益：1 字节落库、静态可校验、热更友好。

### 决策 3：事件执行是"直接改状态"还是"发意图事件"？

- 直接改状态（现状 `ApplyOutcome`）→ 简单，但 tick 内级联顺序敏感。
- 发意图事件 → 需要两阶段（收集→分发），多一层，但回放确定。

如果确定要做 history 回放，**必须选第二个**。

---

## 六、参考链接汇总

| 主题 | 链接 |
|---|---|
| 世界时钟与 Tick 架构（三种时间、帧预算、时间轮非权威） | https://plumephp.com/game-server-world-clock-tick-architecture |
| 持久化定时器架构（幂等、租约、重启恢复、评审清单） | https://plumephp.com/game-server-durable-timer-architecture-design |
| 时间轮从零实现（Go，含级联） | https://plumephp.com/mmo-net-09-2-time-wheel-from-scratch |
| 分层时间轮 + 事件两阶段分发（SLG_DEMO 源码解读） | https://zread.ai/zfunnily/SLG_DEMO/7-hierarchical-timing-wheel |
| 游戏后台定时器系统设计与实现（tick 分片、FreeList） | https://www.gameres.com/384649.html |
| 定时器系统设计问答（堆 vs 轮、回调不能阻塞） | https://cuihairu.github.io/apollo/qa/q60-timer-system |
| 确定性模拟与回放（排序键、状态哈希） | https://media.gdcvault.com/gdceurope2016/presentations/Salz_David_Deterministic_Simulation.pdf |
| 锁步确定性与回放工程实现 | https://blog.csdn.net/2301_77785315/article/details/162781666 |
| 事件溯源 + tick 定序 + 事件级联（Eventure） | https://git.mafyuh.dev/enricostara/eventure |
| 热更新与分发器注册表（云风） | https://blog.codingnow.com/2012/03/dev_note_15.html |
| 百万级延迟任务调度（schedule_lag、幂等、懒删除） | http://www.d7kj.com/blog/2026/11/16/delayed-task-scheduler-interview |
| 延迟队列四种实现对比 | https://ithome.me/post/2026/07/12/delay-queue-four-approaches |
