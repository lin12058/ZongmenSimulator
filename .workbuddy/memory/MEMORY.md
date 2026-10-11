# 宗门模拟器 demo · 长期备忘
> **只钉跨模块契约 & 会静默误事的坑**，一行一条；细则分流：
> 引擎/灵脉/小地图/前端自算/渔村A2/归属B/匾额C/种子W/建筑表现/构建验证坑/**本机环境坑**/**Core-Subsystems 分层详述** → `DETAILS-引擎与表现层.md`；跑法/验收/教训（唯一真源）→ skill `zongmen-verify-pipeline/SKILL.md`(§44=Δ拆分不变性判决)；每日 → 同目录 `YYYY-MM-DD.md`。
> 方案档：P0立宗/P2-α扩张→`玩家宗门放置与城市迭代方案.md`§十/§10.6；Tick→`docs/游戏时钟与Tick演化框架方案.md`(v2.1)+`Tick框架开发进度.md`；城市v2→`脚本化城市迭代-v2-实施方案.md`；**v4建筑(b)+事件接口→`城市演化-v4-建筑等级与事件方案.md`**；**人物/角色→`待办事项/人物系统-资料调研.md` + `Subsystems/Characters/README.md`**。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 7.4.5+protobuf-net3+SQLite/WAL)，Kestrel :8140。⚠ 引擎地基真源只在 `Engine/js/`（noise/mapgen-config/mapgen/mapgen-server **不动**），前端 `web/js/`；`city-evo.js` 在 `Subsystems/City/js/`。
- ⚠★ 多条 Edit **同一文件**放同一条消息 ⇒ **只有最后一条生效**（都回执「成功」，实测 4 次）；不同文件可并发。⇒ 一文件一次只发一条 Edit，改完必 grep 复核（`replace_all` 同守此律）。
- 生成参数真源 `mapgen-config.js`；bundle 序 `[noise,mapgen-config,mapgen,mapgen-server,city-evo]`；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`/`WorldClock`/`TickJob`/`TickPerf`）。
- ⚠★ **V8 单线程**：`JsVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内 V8 不并行；并行度只来自多 VM(多 Scope)/多 seed。⚠ 每个新 JS 出口都要在**对应** `JsvmModule.Invoke` 的 switch 加 case（世界层→`WorldModule`；子系统→各自 `*Module`），漏=`未知 JS 函数`（编译期不报）。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**：`sp=>new X(sp.GetRequiredService<TickPump>())` 绕过容器循环检测 ⇒ 不抛异常，进程活着/不监听端口/零日志；声明式 `AddSingleton` 反而会抛。定位：`netstat` 无监听 + `curl`（**必绕代理**）+ log 0 字节 ⇒ `Program.cs` 插 `Stopwatch` 桩夹出真凶。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`/`ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/ClockQuery 系）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端溢出 2^53 ⇒ **哨兵别用 -1，用 0**。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。**WsFrame：1 Login / 2 Tile / 3 Ping / 4 Script / 5 PlaceCheck / 6 PlaceCommit / 7 Clock**。
- ⚠★ **块级 rev 显式契约**（`BumpBlockRev`）：任何改变某块某图层内容的服务端改动**必须** Bump，否则客户端带旧 lastRevs 重拉被判「未变化」⇒ **永久陈旧**（不报错）。⚠ Bump 之外还须按 key 作废落库包（`EvictWithGate`），否则淘汰后 `ReadSqlBackfill` 把旧包捞回来。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（`MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；⚠ 旧名 `forceStaticDirty` **不存在**）。
- ⚠ 新增图层/导出三处必挂：① **对应 `JsvmModule.Invoke` 的 switch** ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** ⇒ 可选包一律判空。⚠ 别混 JSON 名与 protobuf 名（placeCheck 落点 protobuf=`ok`，JSON=`can`）。

## ★ Core / Subsystems 分层 + 「一子系统一 VM」（契约 2026-10-11；长文 → `DETAILS` 同名节）
- `Engine/`=地基（`JsvmModule` / `JsVmPool`（键 **(Scope,seed)**）/ `WorldModule`）；`Subsystems/`=每子系统一文件夹（`ISubsystem`+`SubsystemRegistry`，**Core 只认契约不引用具体子系统类**）。已搬 City / Characters（**已接 C#+独立 V8+HTTP 端点**，见其 README）。
- ⚠★ **角色 = 服务端实时生成，不是静态表**：独立 `characters` V8 scope + `CharactersSubsystem`（**无台账/job/tick**）→ **`GET /api/characters`**（gzip、no-cache）；`(seed,index)` **纯函数派生 ⇒ 不落库**；真源 `js/chargen-core.js`（classic script）；前端 `roster.js`，载荷带 **`dict`**（**不许硬编码标签**）。⚠ 新子系统必查 `JsvmModule.AcceptsExternalSettlements`（默认 false；不早退 ⇒ **首次建 VM 即抛「未知 JS 函数」**）。
- ⭐ **每子系统一个独立 V8** ⇒ tick 走 `city` VM、人类读路径走 `core` VM，**零门闩争用**（修掉 Tick 框架缺陷 #17）。
- ⚠★ **两 VM 同 bundle 但出口分治**：需 MapGen 骨架+**ext 层**的出口留 `WorldModule`，纯演化出口在 `CityModule`。**ext(玩家宗门) 必须对两个 Scope 统一注入**，漏一边=两 VM ext 漂移 ⇒ 静默错位。
- ⚠ 旧 `JsEngineHost`/`JsWorldVm` **已删**；`JsVmPool` **无 `LiveSeeds`**（活跃数=`Count`）。`ITickExecutor.Claims` + `TickExecutorHub` 按 `TickJobKind` 路由（认领集**不得重叠**，构造期校验）。回归脚本已随迁（`verify/evo/*` 从 `Subsystems/City/js` 载 `city-evo.js`；I6 守卫读 `WorldModule.cs`+`CityModule.cs` 断言出口归属）。

## 各子系统契约
- ⚠★ **世界种子=服务端资产**：`WorldLedger.cs` 独立表 + `/api/world/current|next|list`；取不到就 `showFatal`，**绝不回落前端造**；设置唯一真源 `store.js`；⚠ `showVeins/showLabels` 变量名**不能改**（frontend_smoke 逐名扫）。
- ⚠ 小地图 main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`；帧 `Script=4` 不 gzip（只有 `Source` 字段 gzip）。

## 前端 UI 模块边界
- `#sectWrap`=「本宗」面板，数据源=服务端 `PlayerSect` 表（**不读 settleCells**）；地图渲染走 `EntityGroup→PlaceEntity→settleCells`。
- 「看他人详情」→ `web/js/infocard.js`（`window.InkInfoCard`，**只注入不渲染**），⚠ 引入顺序在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（`frontend_smoke` 反向守卫）。⚠ DOM 句柄别命名成 `st`（保留名，用 `elState`）。

## 玩家放置 P0 / 城市扩张 P2-α（清单 → 方案 §十/§10.6；跑法 → skill §41/§42）
- ⚠ **两笔账分账**：道路重算 405~443ms vs 城市重算 31ms。`growTownFootprint` **不读道路**。
- ⚠ **`roadVer` 只能 +1 绝不归零**（红线）：归零撞 `ObserveRoadVer` 单调取大 ⇒ tile 判新鲜 ⇒ 路重建却永远送不出去。统一走 `bumpRoadVer`。
- ⚠ **邻域校验必须扫 2 环(25 格)**：REGION_M=18+锚点抖动 6.3+PROSPECT_R=4 ⇒ 单侧最大偏移 10.3。
- ⚠ **`DOMAIN_R` 真源在引擎**（city:8 town:6 sect3:8 sect2:7 sect1:6 village:4 fishing:4 poi:0），`dist<need` 才拒。⚠ **C# 不镜像，前端必须镜像** `domainRof`。
- ⚠ **ext 只在缓存外零拷贝叠加**：`settlementsFor=…$base+extIn`；`demand/skeleton/road/roadFail` 含 ext ⇒ **必须按边清**（`clearRoadSideFor`）。⚠ 玩家实体 id=`{区域i}_{区域j}_u{n}`（前两段=区域格十进制整数，引擎自算）。
- ⚠ **白名单必须存在**（`isExpandType`）：`placeSettlement` **不校验 type** ⇒ 传 'city' 静默得 8 格。判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`（`commitPlace` 步 0 二次校验）。两档同链路差 3 处：幂等键**必含类型**；`excludeId` **只在立宗档传**。⭐ 锚点恒为本宗、服务端从台账推、前端不给坐标。
- ⚠ **`PlayerSectStore` v1→v2**：PK `(Account,Round)`→`(Account,Round,Id)`+加 `SectId`；无列 ⇒ RENAME→建新表→INSERT…SELECT→DROP **单事务**，⚠ 显式列清单禁 `SELECT *`。

## Tick 框架（真源 → `Tick框架开发进度.md` + `docs/…方案.md` v2.1）
- ⚠★ **两个静默 bug**：① `CommitSuccess` 必须**复位哨兵后**写 `NextTick=nowTick+Period`（读旧值遇 long.MaxValue 溢出成负⇒到期随机）② 相位钥匙必须 `KindNames.Of(kind)`（线上名）**绝不 `kind.ToString()`**。
- ⚠ **`ApplyOutcome`=唯一写世界入口**（`TickPump.cs`）；P2 挂钩走 `TickPump.OnJobApplied`（回调**不得抛** ⇒ 演化做两遍）+`ExpectedJobsProvider`（**必须返回全集**，少给一类 ⇒ 该类 job 全被 Remove=静默停演化）。
- ⚠ **L0 摊批前提**：`f(state,dt)` 而非「+1 步」（`JobSpec.dtTicks`），漏了**不报错**。红线1 只写可变派生层（**绝不** chunk/settleCache/settleRawCache/siteScoreCache/prospectCache/regionCache）；红线2 道路不进 tick VM 池。
- ⚠ 相位 `mix32(fnv1a(seed|entityId|kind))%Period`（**抖相位不抖周期**，绝不用运行时 RNG）；对账**只增删不重置**；`TickPartitioner.CanJoin` 含**引擎缓存键重叠**（`ExpandEngineCaches`）⇒ 同 `stId` 串行批。仍未做：迁移层未进 vmpool、`EvolveMaxCitiesPerTick` 未使用、`check_city_evo_ws.mjs` 尚不存在。
- ⚠ 人物系统已留空壳 job：`SectCultivation`/`Lifespan`/`PopGrowth`（`TickJobKind` 已声明+注册为 L0/Cpu，`ITickExecutor.cs:96-101`）⇒ 人物时间维度接缝已好，**只差实体**。

## 城市迭代 P2 / v4 建筑计划（→ v2 / **v4 方案**；判据 → `verify/evo/`）
- ✅ 全链路：`Subsystems/City/js/city-evo.js`（纯函数 R1~R6）⇒ `CityModule.Invoke` ⇒ `TickJobRegistry` ⇒ `CityStateStore.cs`（PK `(Round,Id)`，**无 Account**）⇒ `CityTickExecutor.cs`（原 `Time/TickVmPoolExecutor.cs`；`Claims=[TownEvolve,TradeEdge]`）。判据 `check_city_evo_integration.mjs`；仿真器 `city_evo_sim.mjs`（零侵入，`--k=` 默认 freeze）。
- ⚠★ **跨层传参缺字段是静默的**：`settleJson.towns[]` **无 `type/q/r`** ⇒ 引擎读 `type=""` ⇒ `growTownFootprint(id,"")` ⇒ `maxN=8`+`rEff=R0` ⇒ **K 塌到 K_MIN ⇒ 人口恒 30 不报错**。修法=`citySettlementsJson`（带身份），三处调用点全切。
- ⭐ **v4（2026-10-10 落地）**：骨架逐字节不变；只派生「哪几栋被点亮」+「骨架外新盖了啥」+「每栋几级」——**全纯派生，不落库/不进 townCache/townNet**。`planCityBuildings`（点亮集=骨架排序前缀 ⇒ 萎缩外圈先消失）；state `1`(毁)→cap=0、`3`(灾荒/战乱)→`cap×0.65`（⚠ **折减必须在 CAP_MIN 夹断之后**）。渲染 `settlePlanJson`（**无 overlay ⇒ 与旧 `settleJson` 逐字节等同**）。事件唯一写入口 `CityStateStore.ApplyShock`。细则 → `2026-10-10.md` + `DETAILS`。
- ⚠ Δ 铁律（判决 → skill §44）：判据必须「**连续累加**」`step(s,90)≡9×step(sᵢ,10)`；唯一残差根因=**K 在批间被重算** ⇒ 判「冻结 K ⇒ Δ≡0」（须同时钉 `basePop`+`maturity(age)`）。⚠★ **`dt=0` 严格 no-op**；**绝不逐子步 `round(pop)`**；`amount` 与 `pop/TRADE_DEMAND[r]` 皆**日产**。⚠ 事件态阈值必须相对自身基准，断言用**自造夹具**。

## ⚠ 构建 / 验证 / 本机坑（跑法唯一真源 → skill；长文 → `DETAILS`）
- ⚠ 清理文件**已 3 次误删**：一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先 `git ls-files` 过滤被跟踪名单；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。
- ⚠ 本机坑：`PowerShell 输出被吞`／`Bash shim 缺 ls/cd/dirname/wc/head`／`WMIC 黑名单`／`/tmp→D:\tmp`／`>log 吞输出` ⇒ 诊断走 Node 或 `python -c`，临时脚本一律写 `Temp/`。
- ⚠ 判据四防：①绝对值阈值必假红 ⇒ 改 **A/B 归因** ②参照系不能是被测规则自己的目标函数 ③复算须与实现**同容差语义** ④源码守卫判「赋值点所在**整个函数体**」且必须先剥注释。⚠ 几何对齐优先**数值探针**+离线复算；**判据自己的断言也会错**（已 2 次）。
- ⚠ 后台实例**活不过一个回合**（起实例+跑实机判据必须同回合）；基线默认**离线 30 + 在线 6**；`--only=`/`--skip=` 是**子串匹配**；**rc=2=跳过**；⚠ **别 kill 用户 8140**。
