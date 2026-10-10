# 宗门模拟器 demo · 长期备忘
> **只钉跨模块契约 & 会误事的坑**，一行一条。细则一律分流（本文件不重复）：
> - 引擎/灵脉/小地图/前端自算/渔村A2/归属B/匾额C/种子W/建筑表现/**构建验证坑** → `DETAILS-引擎与表现层.md`
> - 跑法/验收/教训（唯一真源）→ skill `zongmen-verify-pipeline/SKILL.md`（§44=Δ拆分不变性判决）
> - 每日叙事 → 同目录 `YYYY-MM-DD.md`
> - 方案档：P0立宗/P2-α扩张 → `玩家宗门放置与城市迭代方案.md` §十/§10.6；Tick → `docs/游戏时钟与Tick演化框架方案.md`(v2.1)+`Tick框架开发进度.md`；城市迭代 v2 → `脚本化城市迭代-v2-实施方案.md`；**v4 建筑计划(b)+事件接口 → `城市演化-v4-建筑等级与事件方案.md`**

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 7.4.5+protobuf-net3+SQLite/WAL)，Kestrel :8140。⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**，前端 `web/js/`。
- ⚠ 并行 Edit 偶发只落第一条却回执成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `mapgen-config.js`；bundle 序 `[noise, mapgen-config, mapgen, mapgen-server, city-evo]`；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删 `Data` 非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`/`WorldClock`/`TickJob`/`TickPerf`）。
- ⚠★ **V8 单线程**：`JsWorldVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内 V8 不并行；并行度只来自多 VM/多 seed。⚠ 每个新 JS 出口都要在 `JsEngineHost.Call` 的 switch 加 case，漏=`未知 JS 函数`（编译期不报）。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**：`sp=>new X(sp.GetRequiredService<TickPump>())` 绕过容器循环检测 ⇒ 不抛异常，进程活着/不监听端口/零日志；声明式 `AddSingleton` 反而会抛。定位：`netstat` 无监听 + `curl`（**必绕代理**）+ log 0 字节 ⇒ `Program.cs` 插 `Stopwatch` 桩夹出真凶。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`/`ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/ClockQuery 系）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端溢出 2^53 ⇒ **哨兵别用 -1，用 0**。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。**WsFrame：1 Login / 2 Tile / 3 Ping / 4 Script / 5 PlaceCheck / 6 PlaceCommit / 7 Clock**。
- ⚠★ **块级 rev 显式契约**（`BumpBlockRev`）：任何改变某块某图层内容的服务端改动**必须** Bump，否则客户端带旧 lastRevs 重拉被判「未变化」⇒ **永久陈旧**（不报错）。⚠ Bump 之外还须按 key 作废落库包（`EvictWithGate`），否则淘汰后 `ReadSqlBackfill` 把旧包捞回来。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（`MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；⚠ 旧名 `forceStaticDirty` **不存在**）。
- ⚠ 新增图层/导出三处必挂：① `JsEngineHost.Call` switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** 而非空数组 ⇒ 可选包一律判空。⚠ 别混 JSON 名与 protobuf 名（placeCheck「能否落点」protobuf=`ok`，JSON=`can`）。

## 各子系统契约
> 灵脉占地 7/3/1、小地图 R12/R13、前端自算地形、渔村 A2、归属势力 B、匾额 C、世界种子 W —— **细则+判据全在 `DETAILS-引擎与表现层.md` 同名节**（可执行真源 `check_*.mjs`）。只留会误事的：
- ⚠★ **世界种子=服务端资产**：`WorldLedger.cs` 独立表 + `/api/world/current|next|list`；取不到就 `showFatal`，**绝不回落前端造**；设置唯一真源 `store.js`；⚠ `showVeins/showLabels` 变量名**不能改**（frontend_smoke 逐名扫）。
- ⚠ 小地图 main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`；帧 `Script=4` 不 gzip（只有 `Source` 字段 gzip）。

## 前端 UI 模块边界
- `#sectWrap`=「本宗」面板，数据源=服务端 `PlayerSect` 表（**不读 settleCells**）；地图渲染仍走 `EntityGroup→PlaceEntity→settleCells`。
- 「看他人详情」→ `web/js/infocard.js`（`window.InkInfoCard`，**只注入不渲染**），⚠ 引入顺序必须在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（`frontend_smoke` 反向守卫）。⚠ DOM 句柄别命名成 `st`（保留名，用 `elState`）。

## 玩家放置 P0 / 城市扩张 P2-α（清单 → 方案 §十/§10.6；跑法 → skill §41/§42）
- ⚠ **两笔账分账**：道路重算 405~443ms vs 城市重算 31ms。`growTownFootprint` **不读道路**。
- ⚠ **`roadVer` 只能 +1 绝不归零**（红线）：归零撞 `ObserveRoadVer` 单调取大 ⇒ tile 判新鲜 ⇒ 路重建却永远送不出去。统一走 `bumpRoadVer`。
- ⚠ **邻域校验必须扫 2 环(25 格)**：REGION_M=18+锚点抖动 6.3+PROSPECT_R=4 ⇒ 单侧最大偏移 10.3。
- ⚠ **`DOMAIN_R` 真源在引擎**（city:8 town:6 sect3:8 sect2:7 sect1:6 village:4 fishing:4 poi:0），`dist<need` 才拒。⚠ **C# 不镜像，前端必须镜像** `domainRof`。
- ⚠ **ext 只在缓存外零拷贝叠加**：`settlementsFor=…$base+extIn`；`demand/skeleton/road/roadFail` 含 ext ⇒ **必须按边清**（`clearRoadSideFor`）。⚠ 玩家实体 id=`{区域i}_{区域j}_u{n}`（前两段=区域格十进制整数，引擎自算）。
- ⚠ **白名单必须存在**（`isExpandType`）：`placeSettlement` **不校验 type** ⇒ 传 'city' 静默得 8 格。判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`（`commitPlace` 步 0 二次校验）。两档同链路差 3 处：幂等键**必含类型**；`excludeId` **只在立宗档传**。⭐ 锚点恒为本宗、服务端从 `PlayerSect` 台账推、前端不给坐标。
- ⚠ **`PlayerSectStore` v1→v2**：PK `(Account,Round)`→`(Account,Round,Id)`+加 `SectId`；无列 ⇒ RENAME→建新表→INSERT…SELECT→DROP **单事务**，⚠ 显式列清单禁 `SELECT *`。

## Tick 框架（真源 → `Tick框架开发进度.md` + `docs/…方案.md` v2.1）
- ⚠★ **两个静默 bug**：① `CommitSuccess` 必须**复位哨兵后**写 `NextTick=nowTick+Period`（读旧值遇 long.MaxValue 溢出成负⇒到期随机）② 相位钥匙必须 `KindNames.Of(kind)`（线上名）**绝不 `kind.ToString()`**。
- ⚠ **`ApplyOutcome`=唯一写世界入口**（`TickPump.cs`）；P2 挂钩走 `TickPump.OnJobApplied`（回调**不得抛** ⇒ 演化做两遍）+`ExpectedJobsProvider`（**必须返回全集**，少给一类 ⇒ 该类 job 全被 Remove=静默停演化）。
- ⚠ **L0 摊批前提**：`f(state,dt)` 而非「+1 步」（`JobSpec.dtTicks`），漏了**不报错**。红线1 只写可变派生层（**绝不** chunk/settleCache/settleRawCache/siteScoreCache/prospectCache/regionCache）；红线2 道路不进 tick VM 池。
- ⚠ 相位 `mix32(fnv1a(seed|entityId|kind))%Period`（**抖相位不抖周期**，绝不用运行时 RNG）；对账**只增删不重置**；`TickPartitioner.CanJoin` 含**引擎缓存键重叠**（`ExpandEngineCaches`）⇒ 同 `stId` 串行批。仍未做：迁移层未进 vmpool、`EvolveMaxCitiesPerTick` 未使用、`check_city_evo_ws.mjs` 尚不存在。

## 城市迭代 P2 / v4 建筑计划（→ v2 方案 / **v4 方案**；判据 → `verify/evo/`）
- ✅ 已融入：`Engine/js/city-evo.js`（无状态纯函数 R1~R6）⇒ `JsEngineHost` switch ⇒ `TickJobRegistry` ⇒ `Storage/CityStateStore.cs`（PK `(Round,Id)`，**无 Account**）⇒ `Time/TickVmPoolExecutor.cs`（`"vmpool"`）。判据 `check_city_evo_integration.mjs`；仿真器 `verify/evo/city_evo_sim.mjs`（**零侵入引擎**，`--k=` 默认 freeze）。
- ⚠★ **跨层传参缺字段是静默的**：`settleJson.towns[]` **无 `type/q/r`** ⇒ 引擎读 `type=""` ⇒ `growTownFootprint(id,"")` ⇒ `maxN=8`+`rEff=R0` ⇒ **K 塌到 K_MIN ⇒ 人口恒 30 不报错**。修法=`citySettlementsJson`（带身份），三处调用点全切。
- ⭐ **v4（2026-10-10 落地）取代旧「只增累加器」**：骨架逐字节不变；变的是「哪几栋被点亮」+「骨架外新盖了啥」+「每栋几级」——**全纯派生**自 `(pop,tier,state,type,骨架输出)`，**不落库/不进 townCache/townNet**。核心：`planCityBuildings`（`cap=round(maxN×ratio^0.6)`，`ratio=pop/BLDG_POP_REF[tier]`，点亮集=骨架排序前缀 ⇒ 萎缩外圈先消失）；`lv∈[1,3]`；state `1`(毁)→cap=0、`3`(灾荒/战乱)→`cap×0.65`（⚠ **折减必须在 CAP_MIN 夹断之后**）。渲染 `settlePlanJson(i,j,overlay)`（**无 overlay ⇒ 与旧 `settleJson` 逐字节等同**）。事件预留 `CityStateStore.ApplyShock(round,id,deltaPop,newState)`=**唯一事件写入口**。细则 → `2026-10-10.md`。
- ⚠ Δ 铁律（判决 → skill §44）：判据必须「**连续累加**」`step(s,90)≡9×step(sᵢ,10)`；唯一残差根因=**K 在批间被重算** ⇒ 判「冻结 K ⇒ Δ≡0」（须同时钉 `basePop`+`maturity(age)`）。⚠★ **`dt=0` 严格 no-op**；**绝不逐子步 `round(pop)`**；`amount` 与 `pop/TRADE_DEMAND[r]` 皆**日产**。⚠ 事件态阈值必须相对自身基准，断言用**自造夹具**。

## ⚠ 文件删除高危 / 构建 / 验证（跑法唯一真源 → skill）
- 已 3 次误删：清理一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先 `git ls-files` 过滤被跟踪名单；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ `verify/_scratch_diag.mjs` **被跟踪**；⚠ `verify/_*.js/_*.png/_*.txt` 被 .gitignore 覆盖 ⇒ **删后不可恢复**。
- ⚠ 判据四防：①绝对值阈值必假红 ⇒ 改 **A/B 归因** ②参照系不能是被测规则自己的目标函数 ③复算须与实现**同容差语义** ④源码守卫判「赋值点所在**整个函数体**」且**必须先剥注释**。⚠ 几何对齐优先**数值探针**+离线复算；分桶用**卡方**；**判据自己的断言也会错**（已 2 次）。
- ⚠ 本机坑：**WMIC 黑名单**；PowerShell 输出被吞 ⇒ 诊断走 Node；**Bash shim 缺 `ls/cd/dirname/wc/head`** ⇒ 先 `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"`，或直接用内置 Glob/Grep/Read/Write + `python -c`；`dotnet build -o /d/...` 被拼成 `D:\d\...` ⇒ 用 `-o "D:\..."`；⚠ **`/tmp` → `D:\tmp`** ⇒ 临时脚本一律写工作目录 `Temp/`；⚠ Bash 重定向 `>log` 吞输出 ⇒ 抓子进程用 Node `spawn`；⚠ HEREDOC `cat >>` 被拦 ⇒ 用 Edit/Write。⚠ 判后端死活必须 `NO_PROXY='*' HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= curl`。
- ⚠ 后台实例/服务**活不过一个回合** ⇒ 起实例+跑实机判据必须同回合（长命令 `run_in_background=true`）。⚠ `git stash` A/B：`web/js/store.js` 有 **CRLF 伪修改**挡 `stash pop` ⇒ 先 `git checkout -- <该文件>`。基线默认**离线 30 + 在线 6**；`--only=`/`--skip=` 是**子串匹配**；**rc=2=跳过**；⚠ **别 kill 用户 8140**。
