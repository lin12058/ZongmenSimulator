# 宗门模拟器 demo · 长期备忘
> **只钉跨模块契约 & 会静默误事的坑**，一行一条。细则分流：
> 引擎/灵脉/小地图/前端自算/渔村A2/归属B/匾额C/种子W/建筑表现/**构建验证坑**/**本机环境坑**/**Core-Subsystems 分层详述** → `DETAILS-引擎与表现层.md`；
> 跑法/验收/教训（唯一真源）→ skill `zongmen-verify-pipeline/`：**`SKILL.md` = 入口索引（约 12KB，路由表 + 三条红线 + 判据四防 + 本机环境 + 常用命令 + 43 章索引）**，细则在 `references/*.md`（00-跑法与验收骨架 / 10-判据方法学 / 20-源码守卫与仓库卫生 / 30-协议图层与子系统接入 / 40-前端与表现层 / 50-Tick与演化）；章号沿用原 §4~§46 ⇒ 交叉引用「见 §32」仍有效；每日 → 同目录 `YYYY-MM-DD.md`。
> 方案档：P0立宗/城市扩张→`玩家宗门放置与城市迭代方案.md`§十；Tick→`docs/游戏时钟与Tick演化框架方案.md`(v2.1)+`待办事项/Tick框架开发进度.md`；城市→`脚本化城市迭代-v2-实施方案.md`+`城市演化-v4-建筑等级与事件方案.md`；**人物/地图人物分布→`待办事项/人物系统-资料调研.md`、`地图人物分布-实施方案.md`、`Subsystems/Characters/README.md`**；战斗/觅长生数值→`待办事项/战斗系统-资料调研.md`+`docs/觅长生数据/`。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 7.4.5+protobuf-net3+SQLite/WAL)，Kestrel :8140。⚠ 引擎地基真源只在 `Engine/js/`（noise/mapgen-config/mapgen/mapgen-server **不动**），前端 `web/js/`；`city-evo.js` 在 `Subsystems/City/js/`。
- ⚠★ 多条 Edit **同一文件**同条消息 ⇒ **只有最后一条生效**（都回执成功，实测 4 次）；不同文件可并发 ⇒ 一文件一次一条 Edit，改完必 grep 复核（`replace_all` 同守）。
- 生成参数真源 `mapgen-config.js`；bundle 序 `[noise,mapgen-config,mapgen,mapgen-server,city-evo]`；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`/`WorldClock`/`TickJob`/`TickPerf`）。
- ⚠★ **V8 单线程**：`JsVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内 V8 不并行；并行度只来自多 VM(多 Scope)/多 seed。⚠ 每个新 JS 出口都要在**对应** `JsvmModule.Invoke` 的 switch 加 case（世界层→`WorldModule`；子系统→各自 `*Module`），漏=`未知 JS 函数`（编译期不报）。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**：`sp=>new X(sp.GetRequiredService<TickPump>())` 绕过容器循环检测 ⇒ 不抛异常，进程活着/不监听端口/零日志；声明式 `AddSingleton` 反而会抛。定位：`netstat` 无监听 + `curl`（**必绕代理**）+ log 0 字节 ⇒ `Program.cs` 插 `Stopwatch` 桩夹出真凶。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`/`ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/Clock 系）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端溢出 2^53 ⇒ **哨兵别用 -1，用 0**。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。**WsFrame：1 Login / 2 Tile / 3 Ping / 4 Script / 5 PlaceCheck / 6 PlaceCommit / 7 Clock**。
- ⚠★ **块级 rev 显式契约**（`BumpBlockRev`）：任何改变某块某图层内容的服务端改动**必须** Bump，否则客户端带旧 lastRevs 重拉被判「未变化」⇒ **永久陈旧**（不报错）。⚠ Bump 之外还须按 key 作废落库包（`EvictWithGate`），否则淘汰后 `ReadSqlBackfill` 把旧包捞回来。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（`MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；⚠ 旧名 `forceStaticDirty` **不存在**）。
- ⚠ 新增图层/导出三处必挂：① **对应 `JsvmModule.Invoke` 的 switch** ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** ⇒ 可选包一律判空。⚠ 别混 JSON 名与 protobuf 名（placeCheck 落点 protobuf=`ok`，JSON=`can`）。

## ★ Core / Subsystems 分层 +「一子系统一 VM」
- `Engine/`=地基（`JsvmModule`/`JsVmPool`（键 **(Scope,seed)**）/`WorldModule`）；`Subsystems/`=一子系统一文件夹（`ISubsystem`+`SubsystemRegistry`，**Core 只认契约**）；**一子系统一个独立 V8** ⇒ tick 走 `city`、读路径走 `core`，**零门闩争用**（修 Tick 缺陷 #17）。旧 `JsEngineHost`/`JsWorldVm` 已删。
- ⚠★ 接新子系统三坑：① `JsvmModule.AcceptsExternalSettlements` 默认 false，纯数据子系统不早退 ⇒ **首次建 VM 即抛「未知 JS 函数」** ② 两 VM 同 bundle 但**出口分治**（骨架/ext→`WorldModule`，纯演化→`CityModule`），**ext 须对两 Scope 统一注入**，漏一边=静默错位 ③ 角色=`(seed,index)` 纯派生 ⇒ 不落库，`GET /api/characters`(gzip/no-cache)，真源 `Subsystems/Characters/js/chargen-core.js`(classic script)，`roster.js` 载荷带 `dict`（**不许硬编码标签**）。

## 各子系统契约
- ⚠★ **世界种子=服务端资产**：`WorldLedger.cs` 独立表 + `/api/world/current|next|list`；取不到就 `showFatal`，**绝不回落前端造**；唯一真源 `store.js`；⚠ `showVeins/showLabels` 变量名**不能改**（frontend_smoke 逐名扫）。
- ⚠ 小地图 main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`；帧 `Script=4` 不 gzip（只有 `Source` 字段 gzip）。
- ⚠ **玩家放置**：`roadVer` 只能 +1 绝不归零；`DOMAIN_R` 真源在引擎（city8/town6/sect3-8/2-7/1-6/village4/fishing4/poi0），C# 不镜像、**前端必须镜像**；`isExpandType` 白名单必存在（`placeSettlement` 不校验 type，传 'city' 静默得 8 格）；`excludeId` 只在立宗档传；判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`；`PlayerSectStore` v1→v2 迁移须单事务+显式列清单。
- ⚠ **Tick**：`CommitSuccess` **必须经 `_registry.NextDue(job, nowTick)`** 推进（内部用 `job.DueTick`=`AdvanceTo` 收集时记下的原到期 tick ⇒ 保相位、绝不拿吊销哨兵算；**禁**再写裸 `nowTick+Period`）；相位钥匙必须 `KindNames.Of(kind)` 绝不 `kind.ToString()`；`ApplyOutcome`=唯一写世界入口；`TickPump.ExpectedJobsProvider` **必须返回全集**（少给一类 ⇒ 该类 job 全被 Remove=静默停演化）；⚠★ `ExpectedJobs` 返回 **null=期望集未知 ⇒ 对账整轮跳过**，**绝不回落空集/demo 心跳**（对账语义是「只增删」⇒ 喂空集=授权它删光本世 job；provider 抛异常同理）；`EnableDemoHeartbeat` 默认 false（保底心跳在 hub 无认领者 ⇒ 停用↔对账复活成环，周期=`ReconcileEveryTicks`）；L0 摊批 `f(state,dt)`（漏了不报错）；相位 `mix32(fnv1a(seed|entityId|kind))%Period`（**抖相位不抖周期**）；换世必须 `CityStateStore.RemoveRound`。⚠★ **`AdvanceTo` 收集即吊销**（`NextTick=RevokedTick`）⇒ 铁律：**被收集的 job 必须在本次 `RunOneTick` 内 re-arm**（成功推进 / 失败退避 / 预算闸顺延）。✅2026-10-12 已修：`TickPump.DeferUnapplied` 在预算 break（默认 300ms）/执行器抛异常时把未 apply 的 job 按 `nowTick+1` 重排；`Flush` 改 at-least-once（失败并回脏集）；catch-up 判据换成「墙钟落后」`IsBehindWallClock`（原 `due.Count>0` 令稀疏世界永远追不上）；`CommitSuccess` 改走 `NextDue`。缺陷清单与修复记录见 `待办事项/代码审查-最近提交bug清单.md` §七。P2 基础设施全未做 ⇒ 替代形态=复用读路径 VM+JSON 边界+泵内联（`ConcurrentExecution` 默认 false=实质串行）。
- ⚠ **城市 v4**：`settleJson.towns[]` 无 `type/q/r` ⇒ 静默 K 塌到 K_MIN（修法=`citySettlementsJson`）；建筑计划全纯派生不落库；state 1→cap=0、3→`cap×0.65`（**折减在 CAP_MIN 夹断之后**）；事件唯一写入口 `CityStateStore.ApplyShock`。Δ 铁律：判据须连续累加 `step(s,90)≡9×step(sᵢ,10)`；**`dt=0` 严格 no-op**；绝不逐子步 `round(pop)`。

## 图层5 地图人物分布（→ 方案 `地图人物分布-实施方案.md` v2；判据 → `verify/check_people_layer.mjs`）
- ⚠★ **People 层 = mask 门控、不走 rev 去重**（`GetTileBlock` 的 `wantPeople`，含该位则每发必带）：它是「热力图开关」的临时数据，关开关丢数据但 `lastRevs[5]` 仍记旧 rev ⇒ 二次打开会**永久空白**（不报错）；前端掩码是**剔位** `mask &= ~PEOPLE`（All/`CALC_MASK` 已含该位）。落格走 **core VM**（`peopleBlockJson/peopleAtJson`，owner-block 去重 + 6% 散布），战力/小队走 **characters VM**（`powerSumsJson/squadBatchJson`，只吃基本属性不吃境界；小队 1~12）；C# `BuildPeopleLayer` 两 VM 拼装 + **进程内 LRU 绝不落库**；`GET /api/people?q=&r=`；`TileMask.People=1<<5`/`All=0x3F`/`revs 6 元`；前端 `web/js/people-layer.js`（`window.PeopleLayer`，热力图 + 点击战力淡出 + 人烟面板，可拔插）。`stats.poolCapacity=MaxSeeds×Scope数` 才是 liveSeeds 上界。

## 前端 UI 模块边界
- `#sectWrap`=「本宗」面板，数据源=服务端 `PlayerSect` 表（**不读 settleCells**）；地图渲染走 `EntityGroup→PlaceEntity→settleCells`。
- 「看他人详情」→ `web/js/infocard.js`（`window.InkInfoCard`）、角色名录 → `web/js/roster.js`：均**只注入不渲染**，⚠ 引入顺序在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（`frontend_smoke` 反向守卫）。⚠ DOM 句柄别命名成 `st`（保留名，用 `elState`）。

## ⚠ 构建 / 验证 / 本机坑
- 三红线：① 清文件一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先 `git ls-files` 过滤，**禁 shell 通配与 `git rm`**（已 3 次误删；`verify/_*` 被 ignore ⇒ 删后不可恢复）② **`git push` 必加** `-c http.proxy= -c https.proxy=`（本机 127.0.0.1:7897 无进程 ⇒ Connection refused）③ **后台实例活不过一个回合** ⇒ 起实例+跑实机判据必须同回合，⚠ **别 kill 用户 8140**。
- ⚠ 判据四防：①绝对值阈值必假红 ⇒ 改 **A/B 归因** ②参照系不能是被测规则自己的目标函数 ③复算须与实现**同容差语义** ④源码守卫判「赋值点所在**整个函数体**」且先剥注释。诊断走 Node/`python -c`（PS 输出被吞；Bash shim 缺 ls/cd/dirname；`/tmp→D:\tmp`；`>log` 吞输出）；临时脚本写 `Temp/`；基线离线 30 + 在线 6；`--only/--skip` 子串匹配；rc=2=跳过。
