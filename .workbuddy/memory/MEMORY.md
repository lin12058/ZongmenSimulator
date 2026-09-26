# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块契约 & 会误事的坑**，逐条压一行。细则分流（本文件不重复）：
> - 引擎/灵脉/小地图/前端自算/渔村A2/归属B/匾额C/种子W/构建坑 → `DETAILS-引擎与表现层.md`
> - 跑法/验收姿势/教训（唯一真源）→ skill `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md` §1~§42
> - P0 立宗 / P2-α 城市扩张 清单+判据 → `待办事项/玩家宗门放置与城市迭代方案.md` §十 / §10.6
> - Tick 时钟/演化调度 → `docs/游戏时钟与Tick演化框架方案.md`（v2，红线见「Tick 框架」节）
> - 每日叙事 → 同目录 `YYYY-MM-DD.md`

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140。⚠ **引擎真源只在 `Server/Zongmen/Engine/js/`**（旧 `Engine/js/` 不存在），前端 `web/js/`。
- ⚠ 并行 Edit 偶发只落第一条却回执成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `mapgen-config.js`；bundle 序 `[noise, mapgen-config, mapgen, mapgen-server]`；Node 侧加载须同序且先 `global.window=globalThis`，漏加载 = 静默跑旧参数。
- 改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 会**静默删** `Data` 表非活跃 seed 前缀 ⇒ **任何台账/玩家资产必须独立成表**（`WorldLedger` / `PlayerSectStore` 即此例）。
- ⚠ **V8 实例单线程**：`JsWorldVm.Call` 全程持 `SemaphoreSlim _gate`（`GetOrCreate` 冷启锁外、入表锁内）。⇒ **一个世界内 V8 不可能并行**；并行度只能来自「多 VM（多 seed）」或「同 tick 批量化进一次调用」。
- ⚠ **V8 每个新出口都要在 `JsEngineHost.Call` 的 switch 加 case**，漏了 = 运行期 `未知 JS 函数`（编译期不报）。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（仅 `Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR`）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32 = 10 字节 varint，前端 JS varint 溢出 2^53 ⇒ **哨兵别用 -1，用 0**。
- mask 0→All 与未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。**WsFrame：1 Login / 2 Tile / 3 Ping / 4 Script / 5 PlaceCheck / 6 PlaceCommit / 7 = P2 城市迭代预留（勿占）**。
- ⚠ **块级 rev 显式契约**（`BumpBlockRev`）：任何改变某块某图层内容的服务端改动**必须** Bump，否则客户端带旧 lastRevs 重拉被判「未变化」⇒ **永久陈旧**（不报错）。
- 写 chunk/region/settle/poi/comm/roads 必须同时 `forceStaticDirty()`。
- ⚠ 新增图层/导出三处必挂：① `JsEngineHost` 的 `Call` switch 白名单 ② repeated 字段逐次 push ③ WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** 而非空数组 ⇒ 读 `.length` 抛异常废整页 ⇒ **可选包一律判空**。
- ⚠ 判据别混 JSON 名与 protobuf 名：placeCheck 的「能否落点」protobuf 叫 **`ok`**（JSON 叫 `can`）。

## 各子系统契约（细则 → DETAILS 同名节）
- **灵脉占地 7/3/1**（真源 `veinFootKeep`）：大 hexDist≤1(7)／中 本格+(-1,1)+(0,1)(3)／小 仅本格；d≥2 不留；从属格 level=`VEIN_SAT_LEVEL(=3)` **绝不进 `comm.veins[]`**。地盘彩环同口径（`vein-skin.js footOffsets`，`FOOT_MIRROR` 仅兜底）；⚠ 一格只画一次（`veinOwnerOf` 取 hexDist 最近）。取数 `?veinprobe=1`。判据 `check_vein_cluster`(27)+`check_vein_skin`。
- **小地图 R12/R13**：⚠ main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`，写 `g.` 整页 fatal。三层：L1 地形=前端按 seed 自算／L2 世界走 WS／L3 视野。帧 `Script=4`，`EngineScriptOrder=[noise,mapgen-config,mapgen]`（⚠ **帧不 gzip，只有 `Source` 字段 gzip**）。R13 `panelWpp=DEFAULT_ZOOM×baseWpp×camZoom`（恒 13.2），面板滚轮只改 `baseWpp`。手机档：触摸四闸（比 `e.timeStamp` 非 `Date.now()`）＋ `color-scheme: only light`。
- **前端自算地图**（在跑）：⚠ 三障碍 = 主线程阻塞／`web/js/noiselib.js` 与引擎 `noise.js` **同名导出 `NoiseLib`**／双实例或双 `init(seed)` 互清缓存（必须单实例）。收敛点 `main.js applyBlock`；已拍板地形 chunk 前端算 + WS `mask` 去 `CHUNK` 位(=30)。
- **渔村 A2**：不以「中心格在水里」判渔村（前端 `WATER_KIND` 白名单兜底 + `?water=old`）。⚠ 加任何「影响画法」flag ⇒ `spriteOf` 缓存 key 同步加位。
- **归属势力 B**：前端 `factionOf` 取最近宗门；⚠ 半径**镜像常量** `SECT_DOMAIN_R=25×1.4=35`；⚠ 缓存 `st._fac` **必须靠 `settleVer` 失效**。`?fac=0`；探针 `__facProbe`。
- **匾额锚点 C-a = 实体自己中心点**（`st.x/st.y`、`v.x/v.y`）。⚠ 要「某东西的中心点」先查该点是否**已在数据里**（skill §35）。契约 `check_plaque_align`(79)；探针 `?plaqprobe=1`。
- **世界种子 = 服务端资产**：`WorldLedger.cs` 独立表 ＋ `/api/world/current|next|list`；拿不到种子直接 `showFatal`，**绝不回落前端造**；`?seed=` 仅调试覆盖。设置唯一真源 `store.js`（键 `zongmen.settings.v1`）；⚠ `showVeins/showLabels` 变量名**不能改**（`frontend_smoke` 逐名扫原文）。

## 玩家放置 P0 / 城市扩张 P2-α（清单 → 方案 §十/§10.6，跑法 → skill §41/§42）
- ⚠ **两笔账分账**：道路重算 **405~443ms** vs 城市重算 **31ms**。`growTownFootprint` **不读道路** ⇒ 用户口中「附近城市重算」实为「附近**道路**重算」。
- ⚠ **`roadVer` 只能 +1，绝不归零**（红线）：归零撞 `ObserveRoadVer` 单调取大 ⇒ tile 判新鲜 ⇒ 路重建了却永远送不出去。已从代码层消除（统一走 `bumpRoadVer`）。
- ⚠ **邻域校验必须扫 2 环(25 格)**：REGION_M=18 + 锚点抖动 6.3 + PROSPECT_R=4 ⇒ 单侧最大偏移 10.3；第 1 环最近可能仅 7.7 < 8。判据 `check_place_neighborhood.mjs`。
- **`DOMAIN_R` 真源在引擎**（`city:8 town:6 sect3:8 sect2:7 sect1:6 village:4 fishing:4 poi:0`）。口径=**中心距阈值、单向判定**（拿新落点量**既有**聚落），`dist<need` 才拒。⚠ **C# 不镜像**（几何只在 `domainCheck`）；**前端必须镜像**（`domainRof`），`check_domain_radius.mjs` 段 G 跨源钉死。
- ⚠ **玩家实体 id = `{区域i}_{区域j}_u{n}`**：前两段必须是区域格十进制整数（`rngDominated`/`roadsNear` 要 `id.split('_')` 反解，NaN ⇒ 静默扫空边池）；**id 由引擎自算**，不接受 C# 传入。
- ⚠ **ext 只在缓存外叠加（零拷贝）**：`settlementsFor=…$base+extIn`；`settleCache/townCache/siteScoreCache` **逐字节不变**（`check_place_no_pollute`）。`demand/skeleton/road/roadFail` **含 ext ⇒ 必须按边清**（`clearRoadSideFor`）。五个静默坑已由 `commitPlace` 七步序列一次处置。
- ⭐ **验证姿势：离线直调 `MapGenServer.commitPlace`** ⇒ 不付 25s A*，`check_place_rules.mjs` 20 PASS/6s；协议层才上 WS（`w5_place_rev.mjs`）。
- ⚠ `w5_place_rev.mjs` **会写入**且要求「本世还没落过宗门」⇒ 世界跑脏 = 一串 FAIL；已加前置闸（自查 `stats.playerSects`）⇒ rc=2 跳过。段 H 提交须避 `PlaceCommitMinGapMs=700` ⇒ `await sleep(900)`。
- ⚠ 测「重算代价」前必须 **warm 上一层缓存**（否则测两层之和），warm 充分要做成**断言**；首测含 JIT（85 vs 中位 31ms）⇒ **交替多轮取中位**。
- **扩固定案**：附属档=**镇/村**；距**本宗中心** ≤ `EXPAND_R=CHUNK_R=10`。真源只在引擎（`EXPAND_R`+`EXPAND_TYPES`），⚠ **C# 不镜像**，前端经 `meta.expandR/expandTypes` 取用（老服务端无此字段 ⇒ 静默降级）。
- ⭐ **锚点恒为本宗、服务端从 `PlayerSect` 台账推、前端不给坐标**。`expandCheck`：`dist<=maxR` 放行；`maxR<=0`/无锚点=不限。⚠ 与 `domainCheck` **两条独立判据，一次都跑**。
- ⚠ **白名单必须存在**（`isExpandType`）：`placeSettlement` **不校验 type** ⇒ 传 `'city'` 静默得 8 格领地、`'poi'` 得 0 格。
- ⚠ **判据优先级 `bad_type → too_far → deep_water → on_vein → too_close → spirit_too_low`**：`too_far` 必须在深海/灵脉之前。半径内 too_far 恒不命中 ⇒ 原有三条语义未被遮挡。⚠ **`commitPlace` 步 0 二次校验**（白名单+半径）。
- **`PlayerSectStore` v1→v2**（⚠ 玩家资产高危）：PK `(Account,Round)` → `(Account,Round,Id)` + 加 `SectId` 列；识别「无 SectId 列」⇒ RENAME→建新表→INSERT…SELECT→DROP，**单事务**。主宗数按 `Type='sect'`；`ByAccount` 主宗排前；`FindByIdemKey` 按那座回放。
- **两档同链路差 3 处**：⚠ 幂等键**必须含类型**；⚠ `excludeId` **只在立宗档传**（拓土档必须空，豁免=可贴脸建）。
- **`LoginResponse` 回填 `MyPlaces`(帧4)+`TownMax`(帧5)**；前端 `MC.onLogin` 拆包 → `applyMyPlaces`。**按钮显隐单点** `applyPlaceButtons()`。换世后 `regenerate()` 必调 `MC.loginAgain()`。判据 `check_expand_rules.mjs` 34 PASS。已注册（离线 24→**25**）。

## Tick 框架 v2（**设计稿**，未开工；全文 → `docs/游戏时钟与Tick演化框架方案.md`）
- **三张独立表** `WorldClock` / `TickJob` / `TickPerf`（⚠ 与 `WorldLedger`/`PlayerSectStore` 同理：进 `Data` 会被 `PruneExcept` 静默删）。`TickJob` PK `(Seed,Round,EntityId,Kind)`，含 `NextTick/PeriodTicks/Phase/LastRunTick/FailCount/Payload`。**一次性事件(PeriodTicks=0)必须插入即落库**，周期 job 可攒 10 tick 批量 UPSERT。
- ⚠ **相位抖动**：`Phase = mix32(fnv1a(seed|entityId|kind)) % PeriodTicks`，**抖相位不抖周期**（`+=Period` 严格）；**绝不用运行时 RNG**（重启/并行必不确定）。对账时**不许重置已有行的 `Phase`**（否则抖动白做）。
- ⚠ **L0 摊批前提**：引擎演化公式必须 `f(state, dt)` 而非「+1 步」——`JobSpec` 要带 `dtTicks = nowTick - LastRunTick`。漏了**不报错**，只会让演化速度随机快慢 M 倍。
- ⚠ **红线 1 扩展**：tick 只许写**可变派生层**（实体属性 `pop/tier/owner/influence`、`townCache`、`tradeCache`、落库 settle 包），**绝不写 seed 纯函数层**（`chunk`/`settleCache`/`settleRawCache`/`siteScoreCache`/`regionCache`）。判据 `check_tick_no_pollute` + `check_tick_chunk_immutable`。
- ⚠ **红线 2**：**道路不进 tick VM 池** —— `roadCache` 是「建路顺序 + 玩家放置史」的产物，**不可从 seed 重建** ⇒ 走既有 `Lease(seed) + commitPlace` 同款串行序列（L2 单元素批，分帧到月 tick）。
- ⚠ **同 seed 可开 N 个 VM** ⇒ 单世界分片**可行**，前提 = VM 无状态化（输入快照 proto + job 批 → 输出 patch proto，权威态在 C#/SQLite）。**「用完即丢」不行**（`new V8ScriptEngine+Evaluate+init` 数百 ms）⇒ 池化复用 + 可随时 Drop（无状态 ⇒ 丢弃零损失）。tick VM 池与读路径 `JsEngineHost` **两套** ⇒ 门闩零争用。
- ⚠⚠ **读路径 VM 陈旧**：tick 改了世界后读路径 VM 的 `townCache`/`tradeCache` 不会自己知道 ⇒ **必须新增 `invalidateTowns/Trades/Regions` 引擎出口**由合流器调用（容错：`TryGet` 不 `GetOrCreate`）。漏了 = 单格点击看到旧建筑，**不报错**。
- ⚠ **ClearScript 版本现实**：项目是 **7.4.5** ⇒ `IArrayBuffer` 只有 `byte[]` 重载（**Span 重载要 7.5.1+**，`InvokeWithDirectAccess` 同）；`SharedArrayBuffer` 跨 runtime 共享 7.2+ 有。⇒ 想零拷贝得升级（会换原生 dll，须全量回归）；**宿主如何拿 `IArrayBuffer` 句柄必须 spike 验证，别假设 API 名**。
- ⚠ **V8 边界 = 未压缩裸 proto + ArrayBuffer**，不过 string、不 base64、不 gzip。现路径 JSON+base64 对 ASCII 放大 ~2.7×（base64 +33%、UTF-16 +100%）。每 VM 一对**私有复用缓冲**（共享 = 竞争）。新增 `CallBytes` 与 `Call` **并列**，不改既有 17 个出口签名。
- ⚠ **`pben.js`（引擎侧 pb 编解码，新增）挂载点**：✅ 加 bundle 数组；❌ **不加** `EngineScriptOrder`（前端有自己的 `pb.js`）；❌ **不加** `ComputeEngineHash`（加了 ⇒ 前端误判引擎升级、静默回退）。⚠ 引擎里原本**没有** pb 写入口（`web/js/pb.js` 是**只读解码器**）。判据 `check_tick_pb_roundtrip`（三处实现字段号对齐）。
- ⚠ 演化参数要读 `tier/pop`，但 `growTownFootprint(id,type,q,r)` **签名里没有时间维度** ⇒ 走 **`$base + evoIn` 扩展层**（照抄 ext 零拷贝），保住 `townCache` 的 `$base` 逐字节不变；⚠ 任何影响画法的 flag ⇒ `spriteOf` 缓存 key 同步加位。

## 前端 UI 模块边界

- ⚠ **`#sectWrap` = 「本宗」面板**，数据源 = 服务端 `PlayerSect` 表（**不读 `settleCells`**）。旧「宗门录+择宗」闭环**已全删**；地图渲染仍走 `EntityGroup→PlaceEntity→settleCells`，两条路独立。
- 「看**他人**详情」→ `web/js/infocard.js`（`window.InkInfoCard`），**只注入不渲染**；⚠ 引入顺序必须在 `main.js` **之前**。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**：`frontend_smoke`（live 组）反向守卫「JS 引用的每处 DOM id 必须已定义」。
- ⚠ **别把 DOM 句柄命名成 `st`** —— `frontend_smoke` 按名字扫 `<resp|cm|st|lr>.prop`，`st` 是聚落解码结构保留名（用 `elState`）。

## ⚠ 文件删除高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename/数量断言，先 `git ls-files` 过滤被跟踪名单；禁 shell 通配与 `git rm`。恢复 `git restore --source=HEAD --worktree -- verify/`。⚠ `verify/_scratch_diag.mjs` **被跟踪**。⚠ `verify/_*.js/_*.png/_*.txt` 被 `.gitignore` 覆盖 ⇒ **删后不可恢复** ⇒ 删前必落副本。

## 构建 / 验证（跑法 → skill；环境坑 → DETAILS 末节）
- 基线：离线 **25** + 在线 **5** + 写入型 **1**；`verify/run_regression.mjs`：`--offline-only`/`--live-only`/`--with-server`/`--with-place`（⚠ **写入型判据的显式 opt-in**）/`--base=`/`--only=`/`--skip=`/`--list`。⚠ 离线组 ~8 分钟。⚠ **`rc=2`=跳过**。
- ⚠ **被跑脏的实例会伪造「回归」**：`w5_place_rev` 要求本世没落过宗门；`check_world_ledger` 会真实开一世 ⇒ 只对该**隔离实例+全新 DB** 跑，`w5` 排最后。
- ⚠ `check_calc_local` 的 hybrid/ab 档在本机 headless 虚拟时间下**假红**（已 A/B 定案）。
- ⚠ **别 kill 用户 8140**（PID 18336）⇒ 起临时独立实例且 `MaxSeeds` 显式放大（代码默认 4；`check_mm_ui` 用新随机 seed）。放大后 `w2_concurrency` 的 `maxSeeds===3` 硬断言假红 ⇒ 已改判「≠ 代码默认 4」。
- ⚠ 判据三防：① 绝对值阈值必假红 ⇒ 改 **A/B 归因** ② 参照系不能是被测规则自己的目标函数 ③ 复算须与实现**同容差语义** ④ 源码守卫别用「固定字符窗」判邻近 ⇒ 改判「赋值点所在**整个函数体**」。⚠ 几何对齐断言优先**数值探针**（`?plaqprobe`/`?mmprobe`）+ 离线复算，不写像素阈值。
- ⚠ 本机：**WMIC 黑名单**（用 `netstat -ano`+`tasklist /FI`+`taskkill /PID`）；PowerShell 输出会被吞 ⇒ 诊断走 Node；Bash shim 缺 `ls/cd` ⇒ 先 `export PATH="/c/Program Files/Git/usr/bin:$PATH"`，或直接用内置 Glob/Grep/Read；`taskkill //PID` 被路径转换吃掉 ⇒ 用 PowerShell `Stop-Process -Id`；`dotnet build -o /d/...` 被拼成 `D:\d\...` ⇒ 用 `-o "D:\..."`；构建前若隔离实例在跑会锁 dll（MSB3021/3027）。
- ⚠ `git stash` 做 A/B：`web/js/store.js` 有 **CRLF 伪修改**会挡 `stash pop` ⇒ 先 `git checkout -- <该文件>`；pop 后必须 `diff -rq` 逐字节核对。⚠ 反空真脚本必须 `try/finally`。
- ⚠ 后台实例/服务**活不过一个回合** ⇒ 起实例+跑实机判据必须同一回合；跨回合先 `net.connect` 探端口。仓库外起实例时 `/api/debug/snap` 落在实例自己目录旁 ⇒ `live_cap` 必超时但探针已写出（skill §35.2/§35.3）。
- ⚠ 文档-磁盘漂移：`verify/_vv_crop.mjs`/`_vv_pick.mjs` 文档当常驻工具引用但**磁盘不存在**。
