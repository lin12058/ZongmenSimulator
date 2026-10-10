# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块契约 & 会误事的坑**，一行一条；细则全部分流（本文件不重复）：
> 引擎/灵脉/小地图/前端自算/渔村A2/归属B/匾额C/种子W/建筑表现/验证坑 → `DETAILS-引擎与表现层.md`；
> 跑法/验收姿势/教训（唯一真源）→ skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md`（§44=Δ拆分不变性判决）；
> 每日叙事 → 同目录 `YYYY-MM-DD.md`。
> 方案档：P0立宗/P2-α扩张 → `玩家宗门放置与城市迭代方案.md` §十/§10.6；Tick调度 → `docs/游戏时钟与Tick演化框架方案.md`(v2.1)、进度`Tick框架开发进度.md`；城市迭代 v2 → `脚本化城市迭代-v2-实施方案.md`、**v4建筑计划(b)+事件接口 → `城市演化-v4-建筑等级与事件方案.md`**。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 7.4.5+protobuf-net3+SQLite/WAL)，Kestrel :8140。⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**，前端 `web/js/`。
- ⚠ 并行 Edit 偶发只落第一条却回执成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `mapgen-config.js`；bundle 序 `[noise, mapgen-config, mapgen, mapgen-server, city-evo]`；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。
- 改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删 `Data` 非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`+`WorldClock`/`TickJob`/`TickPerf`）。
- ⚠★ **V8 单线程**：`JsWorldVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内 V8 不可能并行；并行度只来自多 VM 或多 seed。⚠ 每个新 JS 出口都要在 `JsEngineHost.Call` 的 switch 加 case，漏=`未知 JS 函数`（编译期不报）。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**（2026-09-27 实测）：`sp=>new X(sp.GetRequiredService<TickPump>())` 绕过容器循环检测 ⇒ 不抛异常，进程活着/不监听端口/零日志；声明式 `AddSingleton` 反而会抛 `InvalidOperationException`。⚠ 注入而未用=定时炸弹。定位：`netstat` 无监听 + `curl` **必绕代理** + log 0 字节 ⇒ `Program.cs` 插 `Stopwatch`/`Console.Error` 桩夹出真凶。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载（Span 需 7.5.1+）。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`；❌ `ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（仅 Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/ClockQuery 系）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端 varint 溢出 2^53 ⇒ **哨兵别用 -1，用 0**。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。**WsFrame：1 Login / 2 Tile / 3 Ping / 4 Script / 5 PlaceCheck / 6 PlaceCommit / 7 Clock**。
- ⚠★ **块级 rev 显式契约**（`BumpBlockRev`）：任何改变某块某图层内容的服务端改动**必须** Bump，否则客户端带旧 lastRevs 重拉被判「未变化」⇒ **永久陈旧**（不报错）。⚠ Bump 之外还须按 key 作废落库包（`EvictWithGate`），否则淘汰后 `ReadSqlBackfill` 把旧包捞回来。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（现用 `MapWorldService.MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；⚠ 旧名 `forceStaticDirty` **不存在**）。
- ⚠ 新增图层/导出三处必挂：① `JsEngineHost.Call` switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** 而非空数组 ⇒ 可选包一律判空。⚠ 别混 JSON 名与 protobuf 名：placeCheck「能否落点」protobuf 叫 `ok`（JSON 叫 `can`）。

## 各子系统契约（细则 → DETAILS 同名节；`check_*.mjs` 是可执行真源）
- **灵脉占地 7/3/1**（`veinFootKeep`）：大 hexDist≤1/中 本格+(-1,1)+(0,1)/小 本格；从属格 level=`VEIN_SAT_LEVEL(=3)` **绝不进 `comm.veins[]`**。地盘彩环同口径。取数 `?veinprobe=1`。判据 check_vein_cluster(27)+check_vein_skin。
- **小地图 R12/R13**：⚠ main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`。L1 地形前端按 seed 自算/L2 世界走 WS/L3 视野。帧 `Script=4`，`EngineScriptOrder=[noise,mapgen-config,mapgen]`（⚠ 帧不 gzip，只有 `Source` 字段 gzip）。手机档触摸四闸（比 `e.timeStamp` 非 `Date.now()`）+`color-scheme: only light`。
- **前端自算地图**：⚠ 三障碍=主线程阻塞/`web/js/noiselib.js` 与引擎 `noise.js` **同名导出 `NoiseLib`**/双实例互清缓存。收敛点 `main.js applyBlock`；已拍板地形 chunk 前端算 + WS `mask` 去 `CHUNK` 位(=30)。
- **渔村 A2**：不以「中心格在水里」判渔村（`WATER_KIND` 白名单+`?water=old`）。⚠ 加任何影响画法的 flag ⇒ `spriteOf` 缓存 key 同步加位。
- **归属势力 B**：前端 `factionOf` 取最近宗门；⚠ 半径**镜像常量** `SECT_DOMAIN_R=25×1.4=35`；缓存 `st._fac` **必须靠 `settleVer` 失效**。`?fac=0`。
- **匾额 C-a = 实体自己中心点**（`st.x/st.y`、`v.x/v.y`）。⚠ 要「某东西的中心点」先查该点是否**已在数据里**。判据 check_plaque_align。
- **世界种子=服务端资产**：`WorldLedger.cs` 独立表+`/api/world/current|next|list`；拿不到种子直接 `showFatal`，**绝不回落前端造**；`?seed=` 仅调试。设置唯一真源 `store.js`；⚠ `showVeins/showLabels` 变量名**不能改**（frontend_smoke 逐名扫）。

## 前端 UI 模块边界
- `#sectWrap`=「本宗」面板，数据源=服务端 `PlayerSect` 表（**不读 settleCells**）。地图渲染仍走 `EntityGroup→PlaceEntity→settleCells`。
- 「看他人详情」→ `web/js/infocard.js`（`window.InkInfoCard`，**只注入不渲染**），⚠ 引入顺序必须在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（`frontend_smoke` 反向守卫）。⚠ 别把 DOM 句柄命名成 `st`（保留名，用 `elState`）。

## 玩家放置 P0 / 城市扩张 P2-α（清单 → 方案 §十/§10.6，跑法 → skill §41/§42）
- ⚠ **两笔账分账**：道路重算 405~443ms vs 城市重算 31ms。`growTownFootprint` **不读道路**。
- ⚠ **`roadVer` 只能 +1 绝不归零**（红线）：归零撞 `ObserveRoadVer` 单调取大 ⇒ tile 判新鲜 ⇒ 路重建却永远送不出去。已统一走 `bumpRoadVer`。
- ⚠ **邻域校验必须扫 2 环(25 格)**：REGION_M=18+锚点抖动 6.3+PROSPECT_R=4 ⇒ 单侧最大偏移 10.3。
- **`DOMAIN_R` 真源在引擎**（city:8 town:6 sect3:8 sect2:7 sect1:6 village:4 fishing:4 poi:0）；口径=中心距阈值单向判定，`dist<need` 才拒。⚠ **C# 不镜像，前端必须镜像** `domainRof`。
- ⚠ **玩家实体 id=`{区域i}_{区域j}_u{n}`**（前两段=区域格十进制整数，id 由引擎自算）。
- ⚠ **ext 只在缓存外叠加（零拷贝）**：`settlementsFor=…$base+extIn`；`demand/skeleton/road/roadFail` 含 ext ⇒ **必须按边清**（`clearRoadSideFor`）。`commitPlace` 七步已处置五个静默坑。
- ⭐ **验证姿势：离线直调 `MapGenServer.commitPlace`**（不付 25s A*）⇒ `check_place_rules.mjs`；协议层才上 WS（`w5_place_rev.mjs`，**会写入**且要求本世没落过宗门，已加前置闸 rc=2；段 H 避 `PlaceCommitMinGapMs=700` ⇒ sleep 900）。⚠ 测重算代价前必须 warm 缓存+交替多轮取中位。
- **扩固定案**：附属档=镇/村；距本宗中心 ≤ `EXPAND_R=CHUNK_R=10`。真源只在引擎，⚠ **C# 不镜像**，前端经 `meta.expandR/expandTypes` 取用。
- ⭐ **锚点恒为本宗、服务端从 `PlayerSect` 台账推、前端不给坐标**。与 `domainCheck` 两条独立判据都跑。
- ⚠ **白名单必须存在**（`isExpandType`）：`placeSettlement` **不校验 type** ⇒ 传 'city' 静默得 8 格。判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`；`commitPlace` 步 0 二次校验。
- 两档同链路差 3 处：幂等键**必须含类型**；`excludeId` **只在立宗档传**（拓土档必须空=可贴脸建）。
- **`PlayerSectStore` v1→v2**：PK `(Account,Round)`→`(Account,Round,Id)`+加 `SectId` 列；识别无列 ⇒ RENAME→建新表→INSERT…SELECT→DROP **单事务**，⚠ 显式列清单禁 `SELECT *`。
- `LoginResponse` 回填 `MyPlaces`(帧4)+`TownMax`(帧5)；前端 `MC.onLogin`→`applyMyPlaces`；按钮显隐单点 `applyPlaceButtons()`；换世 `regenerate()` 必调 `MC.loginAgain()`。

## Tick 框架（真源 → `Tick框架开发进度.md`+`docs/…方案.md` v2.1）
- `Server/Zongmen/Time/` 15 文件；判据 7 条全绿。⚠ 调度器**线程安全** `ConcurrentTickQueue`（lock+小顶堆+索引+`volatile _countHint`），任意线程可投递。
- ⚠★ **两个静默 bug**：① `CommitSuccess` 必须**复位哨兵后**写 `NextTick=nowTick+Period`（不读旧值；读旧值遇 long.MaxValue 溢出成负⇒到期随机）② 相位钥匙必须 `KindNames.Of(kind)`（线上名）**绝不 `kind.ToString()`**。
- ⚠ 相位 `mix32(fnv1a(seed|entityId|kind))%Period`，**抖相位不抖周期**，绝不用运行时 RNG；对账**只增删不重置**（`MaybeReconcile` 360 tick 一次）。`TickJob` PK `(Seed,Round,EntityId,Kind)`。
- **帧 7=世界时钟**（明文不 gzip、不鉴权）：DTO→`HandleClockAsync`→`pb.js`（⚠ Tick 是 ZigZag）→`mapclient.clock()`→`clockSyncLoop`。每 10 tick 校绝对 tick+`performance.now()` 插值；校准失败**只停更不清零**；换世先清 `clockBase`。
- ⚠ **`ApplyOutcome`=唯一写世界入口**（`TickPump.cs`），P2 挂钩走 `TickPump.OnJobApplied`（回调**不得抛**，抛了把成功 job 拖成败 ⇒ 演化做两遍）+`ExpectedJobsProvider`（**必须返回全集**，少给一类 ⇒ 该类 job 全被 Remove=静默停演化）。
- ⚠ **L0 摊批前提**：`f(state,dt)` 而非「+1 步」（`JobSpec.dtTicks`），漏了**不报错**。红线1 只写可变派生层（**绝不** chunk/settleCache/settleRawCache/siteScoreCache/prospectCache/regionCache）；红线2 道路不进 tick VM 池。
- ⚠ `TickPartitioner.CanJoin` 四条件含**引擎缓存键重叠**（`ExpandEngineCaches`）⇒ 同 `stId` 的 job 拆成串行批。`TownEvolve.EngineCaches` 已由 `townCache:{id}` 改 `cityState:{id}`。
- ⚠ 仍未做：迁移层未进 vmpool（`Migrations` 已声明未调用）、`EvolveMaxCitiesPerTick` 未使用、`check_city_evo_ws.mjs`（活服务端端到端）尚不存在。

## 城市迭代 P2（→ v2 方案 / **v4 方案**；判据 → `verify/evo/`）
- `verify/evo/city_evo_sim.mjs` 自包含仿真器，**零侵入引擎**（只只读直调 `MG.*`）。`--help/--json/--k=/--diag-b1`。6 种子×3 周期全绿。
- **两层**：第一层（城内）=覆盖层，`growTownFootprint` **无时间维度** ⇒ `$base.map(applyCityState)`，**绝不改 `maxN`**（townCache 参与 townNet ⇒ 可变则 tradeCache 失效不可判）。第二层（城际）=复用 `townNet`+`tradeEdgesFor`，唯一扩展=加结算步。
- `RES_ORDER=['粮','木','矿','渔','炭','灵','丹','器']`；`TRADE_DEMAND={粮:500,木:800,渔:900,炭:1200,矿:1500,灵:5000,丹:8000,器:8000}`（**未导出**，从 townNet 反解）；`TIER_POP_UP={1:4000,2:20000}` 只升不降；`POP_FLOOR=50`。判据 C1~C12/E1~E8/三级回退。
- ⚠「不需可复现」只豁免 RNG，不豁免红线1/幂等键/`roadVer`单调/Δ铁律。
- ✅ 已融入：`Engine/js/city-evo.js`（无状态纯函数 R1~R6）⇒ `JsEngineHost` switch ⇒ `TickJobRegistry` ⇒ `Storage/CityStateStore.cs`（PK `(Round,Id)`，**无 Account**，`Ver` 由引擎携带**不自动+1**）⇒ `Time/TickVmPoolExecutor.cs`（`"vmpool"`）。判据 `check_city_evo_integration.mjs`。
- ⚠★ **跨层传参缺字段是静默的**：`settleJson.towns[]` **无 `type/q/r`** ⇒ 引擎读 `type=""` ⇒ `growTownFootprint(id,"")` ⇒ `maxN=8`（非 city 25）+`rEff=R0`（非 R_CITY）⇒ **K 塌到 K_MIN ⇒ 人口恒 30 不报错**。修法=`citySettlementsJson`（带身份），三处调用点全切。只有端到端对拍能抓到。

### Δ 铁律 vs K 基期（判决实验结论）
- **判据形式必须「连续累加」**：`step(s,90) ≡ 9×step(sᵢ,10)`。读成「每子步从 s 出发」⇒ **数学必不相等**。
- **唯一残差根因=K 在批间被重算**（不可约）。判：**冻结 K ⇒ Δ≡0**。⚠ 冻结必须同时钉 `basePop` 和 `maturity(age)`（只冻 basePop ⇒ Δ=21）。
- 三档 `--k=`（默认 freeze）：freeze +0.36% 全绿 / year +0.65% 5FAIL / roll +0.94% 5FAIL。⚠ 主循环**恒以 dt=90 调一次** ⇒ 拆分运行期从不发生 ⇒ Δ 只是单元测试属性。
- ⚠★ **`dt=0` 必须严格 no-op**（连 tier 追升都不许）；**绝不逐子步 `round(pop)`**；量纲：`plan.resources[].amount` 已是**日产**、`pop/TRADE_DEMAND[r]` 也是日 ⇒ 直接相减。
- ⚠ **事件态阈值必须相对自身基准**（`pop<kBase×0.35` 而 kBase=popBase×4 ⇒ **恒真**）；断言别写空真 ⇒ 用**自造夹具**。

### ⭐ v4 建筑计划（b 方案，2026-10-10 落地）— 取代旧「只增累加器」
- **骨架逐字节不变**（`growTownFootprint` 仍 seed 纯函数）；变的是「哪几栋被点亮」+「骨架之外新盖了啥」+「每栋几级」——**全纯派生**自 `(pop,tier,state,type,骨架输出)`，**不落库/不进 townCache/townNet**。
- `planCityBuildings`：`cap=round(maxN×ratio^0.6)`，`ratio=pop/BLDG_POP_REF[tier]`(1:3000/2:15000/3:50000)；点亮集=骨架按「核心→民居→生产→离城心距离」排序取前缀 ⇒ 萎缩时**外圈先消失**。溢出建筑在骨架环外（`OVER_RING_PAD`），1/3 生产（补最紧缺）。
- `lv∈[1,3]`：核心=城 tier；民房 `1+floor(ratio/0.9)`；生产 `1+(缺≥0.25)+(缺≥0.60)`。
- state：`1`(毁)→cap=0；`3`(灾荒/战乱)→`cap×0.65`。⚠ **折减必须在 CAP_MIN 夹断之后**（否则「1 栋荒村」灾荒不减 = 真缺陷，C5d 抓到）。
- 渲染：`settlePlanJson(i,j,overlay)`；**无 overlay ⇒ 与旧 `settleJson` 逐字节等同**（非演化世界零变化）。C# `MapWorldService.BuildSettle`→`SettleOverlayJson(i,j)`（只取**本区域格**）；`JsEngineHost.Call` 加 `citySettlePlanJson`。
- 身份往返修复：`newCityState` 补 `type/q/r`；`CityStateStore.To/FromEngineJson` 同步；`TickVmPoolExecutor.EnsureInitialized` **自愈**（`Type` 空才按骨架重建，**不清库**）。
- 等级端到端：`BuildingDto.Lv`(ProtoMember 6)→`pb.js parseBuilding`→`drawBuildings`→`bldg_ink.js`（`lvK=1+0.10*(lv-1)` + 民房叠楼；⚠ spriteOf 缓存键含 lv）。
- 事件预留：`CityStateStore.ApplyShock(round,id,deltaPop,newState)` = **唯一事件写入口**（钳 pop≥1、同步 PopF、bump Ver、**不动 PopBase**——事件态/恢复判据都相对它，故 state=3 持续到真正恢复）。⚠ **无需 schema 迁移**：pop 由 tick 层写，灯数/等级全派生。判据 C5a~C5g（引擎↔镜像交叉断言）+ I6。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先 `git ls-files` 过滤被跟踪名单；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ `verify/_scratch_diag.mjs` **被跟踪**。⚠ `verify/_*.js/_*.png/_*.txt` 被 .gitignore 覆盖 ⇒ **删后不可恢复**。

## 构建 / 验证（跑法唯一真源 → skill `zongmen-verify-pipeline/SKILL.md`）
- 基线默认**离线 30 + 在线 6**；`--with-server` 加 w1/w2/w4/verify_map；`--with-place` 加 w5_place_rev（**写入型**）。⚠ `--only=`/`--skip=` 是**子串匹配**，逗号分隔无效；⚠ **rc=2=跳过**；⚠ 被跑脏的实例会**伪造回归** ⇒ 只对**隔离实例+全新 DB** 跑；⚠ **别 kill 用户 8140**（服务由用户手动启停）。
- ⚠ 判据四防：①绝对值阈值必假红 ⇒ 改 **A/B 归因** ②参照系不能是被测规则自己的目标函数 ③复算须与实现**同容差语义** ④源码守卫判「赋值点所在**整个函数体**」且**必须先剥注释**。⚠ 几何对齐优先**数值探针**+离线复算，不写像素阈值；分桶均匀性用**卡方**；**判据自己的断言也会错**（已 2 次）。
- ⚠ 本机坑：**WMIC 黑名单**（用 `netstat -ano`+`tasklist /FI`+`taskkill /PID`）；PowerShell 输出被吞 ⇒ 诊断走 Node；**Bash shim 缺 `ls/cd/dirname/wc/head`** ⇒ 先 `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"`，或直接用内置 Glob/Grep/Read/Write + `python -c`；`dotnet build -o /d/...` 被拼成 `D:\d\...` ⇒ 用 `-o "D:\..."`；⚠ **`/tmp` 映射到 `D:\tmp`** ⇒ 临时脚本一律写工作目录 `Temp/`；⚠ **Bash 重定向 `>log` 吞输出**（0 字节）⇒ 抓子进程输出用 Node `spawn`；⚠ **HEREDOC `cat >>` 被安全策略拦** ⇒ 用 Edit/Write。⚠ 判后端死活必须 `NO_PROXY='*' HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= curl`。
- ⚠ 后台实例/服务**活不过一个回合** ⇒ 起实例+跑实机判据必须同回合；长命令用 `run_in_background=true`。⚠ `git stash` A/B：`web/js/store.js` 有 **CRLF 伪修改**会挡 `stash pop` ⇒ 先 `git checkout -- <该文件>`。
