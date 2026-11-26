# 跨 tick 事件系统 · 实施说明

> 配套：`docs/游戏设计/跨tick事件系统-调研.md`（外部方案与选型依据）
> 代码：`Server/Zongmen/Events/`、`Server/Zongmen/Subsystems/City/js/city-events.js`
> 判据：`node verify/check_event_system.mjs`

## 一、一句话

事件的**调度真源在库**（`EventQueue` 表），内存只有一层可丢的最小堆；
到点后调脚本，**用「调前 vs 调后」的对比结果当 diff** 写进 `History`，diff 是 protobuf，没变的字段一个字节都不写。

## 二、四张表

| 表 | 主键 | 作用 | 行数增长 |
|---|---|---|---|
| `Entity` | `Id`（全局 int32） | int32 ↔ 引擎字符串 id（`-3_-3_0`）的唯一映射 | 随实体数，**只增不删** |
| `EntityIdSeq` | `Id=1` | 号空间认领上界（HighWater） | 恒 1 行 |
| `EventQueue` | `(Round, EntityId, EventKey)` | 谁、何时、跑哪个脚本 | 有界（未触发事件数） |
| `History` | `(Round, Seq)` | 每次执行的状态差 | **随 tick 增长** |

`EventKey` 这一维不能省：同一实体的同一 tick 可能挂多个事件（瘟疫 + 火灾），
只用 `(Round, EntityId)` 会让后插入的静默覆盖前一个。

四张都**独立成表** —— `MapWorldService` 的后台维护会调 `SqliteVirtualContext.PruneExcept`，
塞进 `Data(Key,Value)` 的东西会在换世后被静默删掉（与 `WorldLedger` / `TickJob` 同一个坑）。

## 三、一次触发的完整链路

```
TickPump.RunOneTick(nowTick)
  ├─ ① 先跑 TickJob 批（城市演化，写 CityState）
  └─ ② RunEventsHook → EventRunner.RunDue(seed, round, nowTick)
        ├─ heap.AdvanceTo(nowTick)          // 收集即吊销（NextTick 置哨兵）
        ├─ 逐条（按 EntityId,EventKey 排序，与入堆顺序无关）：
        │   ├─ EntityRegistry.NameOf(entityId)     → "9_9_0"
        │   ├─ CityStateStore.Get(round, name)     → before
        │   ├─ vm.Call("eventScriptJson", script, fn, beforeJson, ctxJson)
        │   ├─ after = FromEngineJson(out.state)
        │   ├─ diff  = CityDiff.Between(before, after)   ★ 对比，不是脚本自报
        │   ├─ cityStore.Put(after)                      ★ 先写状态
        │   ├─ store.CommitRun(ev, tick, diff, next, oneShot)  ★ 同事务写 History + 推进事件
        │   └─ out.spawn[] → Schedule(...)               // 派生只往未来排，不当场执行
        └─ 兜底：未执行的 re-arm 到 nowTick+1（收集即吊销的必然后果）
```

★ **顺序纪律**：`Put` 在 `CommitRun` **之前**。反了会出现「History 说有变化、状态没变」⇒ 回放整段错位。
而 `Put` 成功 / `CommitRun` 失败时，事件未推进 ⇒ 下 tick 重跑 ⇒ `before` 已是新状态 ⇒
diff 自动变空 ⇒ **不会重复施加**。这个幂等性是「对比前后状态」白送的。

## 四、diff 的 protobuf 字段表

标准 protobuf wire format（field number + wire type + zigzag），任何 protobuf 工具都能解。

| field | 字段 | 类型 | 备注 |
|---:|---|---|---|
| 1 | Pop | sint32 | |
| 2 | PopF | double | |
| 3 | Tier | sint32 | |
| 4 | State | sint32 | |
| 5 | Age | sint64 | |
| 6 | FoodDebt | double | |
| 7 | PopBase | sint32 | |
| 8 | BasePopF | double | 有值 = 变成该值 |
| 9 | BasePopFCleared | bool | true = 变成 null |
| 10 | BuiltFrac | double | |
| 11 | Kf | double | |
| 12 | LastEvoTick | sint64 | |
| 13 | Ver | sint32 | |
| 14 | BaseAge | sint64 | |
| 15 | BaseAgeCleared | bool | true = 变成 null |
| 20..27 | Stock[0..7] | sint64 | 顺序 = `CityStateStore.ResourceOrder` |
| 30 | Built | string | 存**原串**（结构不符也能原样往返） |

三条编码纪律：

1. **有符号整数一律 zigzag**（`sint32`/`sint64`）。标准 `int32` 对负数编码成 10 字节，
   而人口差、tick 都可能为负。`-1` 用 zigzag 只占 2 字节（tag + 1）。
2. **null = 没变**，有值 = 变了（**即使新值是 0**）。用「0 当哨兵」会让「人口降到 0」被当成「没变」。
3. `nullable → null` 用**独立的 `xxxCleared` 标志**，因为 `null` 已经被「没变」占用。

实测：一次典型瘟疫（改 pop/popF/state/ver 四个字段）= **16 字节**。
存整份 `CityStateRow` 约 120 字节 —— 差 7.5 倍。

## 五、脚本契约

C# 只有一个出口 `eventScriptJson(scriptId, fnId, stateJson, ctxJson)`，JS 侧按 id 分派。
落库存的是 `ScriptId` + `FnId` 两个字节，**不存函数名字符串** ——
省字节、能静态校验（`check_js_exports.mjs`）、热更新不动数据。

返回三选一：

```js
'null'                                        // 不改状态
'{"state":{...}}'                             // 新状态（必须同一实体）
'{"state":{...},"spawn":[{"fn":2,"after":60}]}'  // 改状态 + 派生后续事件
```

三条铁律：

- **R1 不改身份字段**（id/type/q/r）。C# 侧会比对并抛异常 —— 那是 seed 纯函数结论。
- **R2 必须幂等**。崩在「状态已写、History 未提交」之间时会被重放。
  判据一律写成「看到状态已经是目标态就返回 null」，**绝不能**写 `pop *= 0.9` 这种无条件乘。
- **R3 必须确定性**。不许 `Math.random` / `Date.now`；需要"随机"就用 `hash32(entityId ^ tick)`。

## 六、纪律清单（每条都对应一个静默 bug）

| 纪律 | 违反后的表现 |
|---|---|
| `AdvanceTo` 收集即吊销 ⇒ 必须本 tick 内 re-arm | 事件永久沉在堆底、再也不触发（库里那行还在，对账也救不回） |
| 只有成功才推进 `NextTick` | 失败也推进 = 静默跳过事件 |
| `Put` 在 `CommitRun` 之前 | 回放分歧：History 说有变化、实际状态没变 |
| Seq 懒初始化（无缓存时查库 `MAX(Seq)`） | 重启后先写后读 ⇒ 主键冲突，事件永远推不动 |
| `spawn.after >= 1` | 同一 tick 内级联，结果依赖遍历顺序，两台机器跑出不同世界 |
| 同 `(entity, fn)` 已存在时改期而不新增 | 脚本 bug 每次触发都 spawn ⇒ 事件无限膨胀 |
| 号永不回收（`Entity` 行只标 `Alive=0`） | 复用号 = 历史事件挂到新实体身上 |
| `EventKey` 进主键 | 同实体第二个事件静默覆盖第一个 |

## 七、监控口径

看 **`lag = nowTick - NextDueTick`**，不看队列长度。
队列 10 万条可能只是「未来一年的任务」；lag 是 3 就说明真在追帧。

`EventRunner.Stats(nowTick)` 已输出 `pending / nextDue / lag / runs / failures / emptyDiffs / historyRows`。

## 八、已验证 / 未验证

**已验证（`check_event_system.mjs` 全绿 + 实机）**

- 判据 79 项：PbWire zigzag、diff 只写变化字段/往返逐字节一致/apply 后无差、
  堆序与收集顺序、同 ref 去重、收集即吊销、re-arm、EntityRegistry 重启保持、
  EventStore 原子提交与 Seq 接续、注册表 ↔ JS 逐一对应、8 条源码守卫。
- 实机：插入 1 城 + 1 条瘟疫事件（tick 594 触发）→ 起服务 22 秒 →
  `History` 出现 1 条 16 字节 diff（`08a40d 11 0000000000908a40 20 06 68 0c`），
  `CityState` 人口 1000→850 / state 0→3 / ver 5→6，
  `EventQueue` 原事件被删、派生 `PlagueEnd` 排在 654。

**未验证**

- 人物域（`EntityKind.Character`）：人物 id 是 `personIndexOf(q,r,k)` 现算的，
  pop 一降尾部 id 直接消失 ⇒ 挂在身上的一次性事件会永远挂空。
  接之前必须先存 `(q,r,k)` 快照并在触发时校验 `k < 当前人数`。
- 长跑压力：脚本派生风暴的上限（`MaxPerTick=256` / `MaxSpawnPerRun=8`）只在代码里，
  没有真实风暴数据。
- 多进程并发写同一个库（与项目其它 store 一致，不支持）。
