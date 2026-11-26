# 宗门模拟器 demo · 长期备忘

> **只钉跨模块契约 & 会静默误事的坑**，一行一条。细则分流：
> - 引擎/灵脉/小地图/前端自算/世界种子/建筑/Core-Subsystems/**Tick 详述**/**本机坑** → `.workbuddy/memory/DETAILS-引擎与表现层.md`
> - **小队/背包/招募/招募生成器** → `.workbuddy/memory/DETAILS-小队与招募.md`
> - 跑法/验收/教训唯一真源 → skill `zongmen-verify-pipeline/`（`SKILL.md` 索引 + `references/*.md` 章号仍用 §4~§46；每日日志同目录 `YYYY-MM-DD.md`）
> - 方案档：立宗/城市→`玩家宗门放置与城市迭代方案.md`§十；Tick→`docs/游戏时钟与Tick演化框架方案.md`(v2.1)；城市→`脚本化城市迭代-v2`+`城市演化-v4`；人物→`地图人物分布-实施方案.md`+`Subsystems/Characters/README.md`；战斗→`待办事项/战斗系统-资料调研.md`；**生成器→`docs/游戏设计/角色生成器-实施方案.md`**；**招募→`docs/游戏设计/招募系统-实施方案.md`**；**事件→`docs/游戏设计/跨tick事件系统-实施.md`**。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8 + ClearScript.V8 7.4.5 + protobuf-net3 + SQLite/WAL，Kestrel :8140。⚠ 引擎地基真源只在 `Engine/js/`，前端 `web/js/`，`city-evo.js` 在 `Subsystems/City/js/`。
- ⚠★ 同一文件多条 Edit 同条消息 ⇒ **只有最后一条生效**（回执都成功，实测 4 次）⇒ 一文件一次一条，改完必 grep 复核。
- 参数真源 `mapgen-config.js`；bundle 序 `[noise,mapgen-config,mapgen,mapgen-server,city-evo,city-events,chargen]`（chargen 排最后，**不进** `ComputeEngineHash`/`EngineScriptOrder`，events 同理）；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态/事件**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`/`WorldClock`/`TickJob`/`TickPerf`/`Crew`/`RecruitPoint`/`RecruitPool`/`Entity`/`EntityIdSeq`/`EventQueue`/`History`）。
- ⚠★ **落库字符串一律紧凑**（2026-11-26，清库重来不复用旧格式）：`TickJob`/`TickPerf` **已删 `Seed` 列**（单世界，真源只有 `World.Seed`；若要做「下一世预生成」并行必须加回）、`Kind`→`KindCode` 用 `KindNames.Code` 的**显式固定码**（1..8，绝不用 `(int)enum`，插成员会让历史行静默错读成别的 kind）；`CityState.Type`→`TypeCode`（字典表 `CityDict(Dom,Name)`）、`Stock`→`R0..R7`、`Built`→varint BLOB（字段集≠7 或项数>255 时**回退存 JSON**）；`RecruitPool`/`Crew` 的 JSON 列 gzip BLOB（`Storage/BlobCodec.cs`，1 字节 tag 区分 raw/gzip，<128B 不压）。⚠ `Stock` 遇 `RES_ORDER` 之外的键**必须抛**，绝不静默丢。⚠ `Data.Key` 的 `w:<hash>:` 前缀（占该列 63%）**尚未去掉** —— 要动得改 `VirtualContext` 接口 + `PruneExcept`。
- ⚠★ **V8 单线程**：`JsVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内不并行；并行度只来自多 VM(多 Scope)/多 seed。⚠ 每个新 JS 出口都要在**对应** `JsvmModule.Invoke` switch 加 case（世界层→`WorldModule`，子系统→各自 `*Module`），漏=`未知 JS 函数`（编译期不报）。守卫 `verify/check_js_exports.mjs`。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**（绕过容器检测 ⇒ 不抛异常/进程活着/不监听/零日志）。定位：`netstat` 无监听 + 绕代理 `curl` + log 0 字节 ⇒ `Program.cs` 插 `Stopwatch` 桩。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`/`ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/Clock）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端溢 2^53 ⇒ **哨兵别用 -1**。
- mask 0→All、未登录剔实体层都在 MapWsHandler；revs 只更新 resp.mask 命中位；帧 `[1B type][payload]`；TileResponse 恒 gzip。WsFrame 1 Login/2 Tile/3 Ping/4 Script/5 PlaceCheck/6 PlaceCommit/7 Clock。
- ⚠★ **块级 rev**（`BumpBlockRev`）：改某块某图层内容必须 Bump，否则客户端带旧 lastRevs 被判「未变化」⇒ **永久陈旧**（不报错）；还须 `EvictWithGate` 作废落库包，否则淘汰后 `ReadSqlBackfill` 把旧包捞回。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（`MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；旧名 `forceStaticDirty` 不存在）。
- ⚠ 新增图层/导出三处必挂：① Invoke switch ② repeated 逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 null ⇒ 可选包判空。⚠ 别混 JSON 名与 protobuf 名（placeCheck 落点 protobuf=`ok`/JSON=`can`）。

## Core / Subsystems（一子系统一 VM）
- `Engine/`=地基（`JsvmModule`/`JsVmPool`（键 (Scope,seed)）/`WorldModule`）；`Subsystems/`=一子系统一文件夹（`ISubsystem`+`SubsystemRegistry`，Core 只认契约）；一子系统一独立 V8 ⇒ tick 走 `city`、读路径走 `core`，零门闩争用。
- ⚠★ 接新子系统三坑：① `AcceptsExternalSettlements` 默认 false ⇒ 纯数据子系统首次建 VM 即抛「未知 JS 函数」② 两 VM 同 bundle 但**出口分治**，ext 须对两 Scope 统一注入，漏一边=静默错位 ③ 角色=`(seed,index)` 纯派生不落库，`GET /api/characters`（gzip/no-cache），真源 `Subsystems/Characters/js/chargen-core.js`（出口 `CultivatorGen`），`roster.js` 载荷带 `dict`（不许硬编码标签）。

## 子系统契约
- ⚠★ **世界种子=服务端资产**：`WorldLedger.cs` + `/api/world/current|next|list`；取不到 `showFatal`，绝不前端造；唯一真源 `store.js`；`showVeins/showLabels` 变量名不能改（frontend_smoke 逐名扫）。
- ⚠ 小地图 main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`；帧 Script=4 不 gzip（只有 `Source` 字段 gzip）。
- ⚠ **玩家放置**：`roadVer` 只能 +1 绝不归零；`DOMAIN_R` 真源在引擎（city8/town6/sect3-8/2-7/1-6/village4/fishing4/poi0），C# 不镜像、前端必须镜像；`isExpandType` 白名单必存在；`excludeId` 只立宗档传；判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`；`PlayerSectStore` v1→v2 迁移单事务+显式列。
- ⚠ **Tick**（详述 → DETAILS）：`CommitSuccess` 必须经 `_registry.NextDue`；相位钥匙 `KindNames.Of(kind)`；`ApplyOutcome` 唯一写世界入口；`ExpectedJobsProvider` 必须返回全集，**返回 null=整轮跳过、绝不喂空集**；`EnableDemoHeartbeat` 默认 false；**`AdvanceTo` 收集即吊销 ⇒ 被收集 job 必须本 tick 内 re-arm**（`DeferUnapplied` 已兜预算/异常）；换世 `CityStateStore.RemoveRound`。⚠ 预算闸在**批执行之前**检查，`ConcurrentExecution=false`(默认) ⇒ 每 job 单独一批 ⇒ 单个 job >300ms 必然把同 tick 其余 job 顺延（日志「超预算+顺延 N」的真实语义，**不是**卡死）。
- ⚠ **城市 v4**：`settleJson.towns[]` 无 `type/q/r` ⇒ 静默 K 塌到 K_MIN（用 `citySettlementsJson`）；建筑计划纯派生不落库；state 1→cap=0、3→`cap×0.65`（折减在 CAP_MIN 夹断之后）；事件唯一写入口 `ApplyShock`；Δ 判据须 `step(s,90)≡9×step(sᵢ,10)`，`dt=0` 严格 no-op，绝不逐子步 round(pop)。

## 跨 tick 事件系统（`Server/Zongmen/Events/` + `Subsystems/City/js/city-events.js`）
- 四表：`Entity`(int32↔引擎 id，**号只增不回收**，`Alive=0` 代替删) / `EntityIdSeq`(认领上界) / `EventQueue`(PK `Round,EntityId,EventKey`) / `History`(PK `Round,Seq`)。文档 `docs/游戏设计/跨tick事件系统-实施.md`。
- ⚠★ **`CityStateStore.Put(after)` 必须在 `EventStore.CommitRun(...)` 之前**：反了 =「History 说有变化、状态没变」⇒ 回放整段错位；正着的顺序白送幂等（Put 成功/Commit 失败 ⇒ 下 tick 重跑 ⇒ before 已是新态 ⇒ diff 自然为空，不重复施加）。
- ⚠★ **diff 语义**：null = 没变；有值 = 变了（**即使新值是 0**，用 0 当哨兵会把「人口降到 0」当没变）；`BasePopF`/`BaseAge` 这类 `nullable→null` 用独立 `xxxCleared` 标志（field 9/15）。整数一律 zigzag（sint32/sint64），field 20..27 = `Stock[0..7]` 按 `CityStateStore.ResourceOrder`，30 = `Built` 原串。
- ⚠★ **`EventStore.CommitRun` 的 Seq 必须懒初始化**（无缓存就查 `MAX(Seq)`）：只靠 `LoadAll` 初始化 ⇒ 重启后先写后读从 1 发号 ⇒ 撞 `(Round,Seq)` 主键（Error 19）⇒ 事件永远推不动且每 tick 重试。
- ⚠ 事件/`TickJob` **两套表两套堆**，由同一 `TickPump.RunOneTick` 驱动（先 job 后事件）；挂线用 `RunEventsHook`/`BindEventsHook` 委托，**不构造注入**（避 DI 环）；`BindEventsHook` 必须在 `AttachTickPump` **之前**挂（那一步立刻 `BindWorld`）。
- ⚠ 脚本三铁律：① 不改身份字段(id/type/q/r) ② **幂等**（重放时须「看到已是目标态就返回 null」，绝不写 `pop*=0.9`）③ **确定性**（禁 `Math.random`/`Date.now`，用 `hash32(entityId^tick)`）。`spawn.after` 至少 1（同 tick 级联会让回放分歧）。
- ⚠ 落库存 `ScriptId`+`FnId` 两字节（`EventScriptRegistry` 显式固定码），**不存函数名字符串**；C# 单一出口 `CityModule.Invoke` 的 `"eventScriptJson"`，JS 侧 dispatch。判据 `check_event_system.mjs`（79 项）逐值比对注册表与 HANDLERS。

## 图层5 人物分布（详述 → DETAILS；判据 `verify/check_people_layer.mjs`）
- ⚠★ **mask 门控、不走 rev 去重**（`wantPeople`，含该位每发必带）：关开关丢数据但 `lastRevs[5]` 仍记旧 rev ⇒ 二次打开**永久空白**（不报错）；前端掩码是**剔位** `mask &= ~PEOPLE`。落格走 core VM、战力/小队走 characters VM（不吃境界，小队 1~12）；C# `BuildPeopleLayer` 两 VM 拼装 + 进程内 LRU 不落库；`TileMask.People=1<<5`/`All=0x3F`/revs 6 元；前端 `people-layer.js`。

## 前端 UI 边界
- `#sectWrap`=本宗面板，数据源=服务端 `PlayerSect` 表（不读 settleCells）；地图渲染走 `EntityGroup→PlaceEntity→settleCells`。
- 他人详情 `web/js/infocard.js`（`window.InkInfoCard`）、名录 `web/js/roster.js`：只注入不渲染，⚠ 引入在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（frontend_smoke 反向守卫）；DOM 句柄别叫 `st`（保留名，用 `elState`/`dragSt`）。
- **HUD 最终形态**：`#titleBox` 已删；`#topbar`=`#hudLeft`（`#toolBox`+`#sectWrap`）+ 右上 `#controls`。⚠ `#sectBody` **不许删**。山川志 `#info`=可拖动浮窗（h3 把手，存 `ZMStore('infoPos')`）。`els.era`/`els.eraRound` 已恒 null ⇒ 判空。

## 小队 / 招募（细则 → `DETAILS-小队与招募.md`）
- `web/js/crew/` 四件套独立插件（main.js 零改动，3 行 script 在 main.js 之前）；`/api/crew` 5 端点 + 独立 `Crew` 表；`/api/recruit/*` 四端点，点数与 `taken` 按账号、crew 契约全局单份。
- ⚠★ **编制上限恒 = 9（`SquadCap`），不许读 `contract.squad.capacity`**（旧默认值=背包行数 8 ⇒ 第 8 人报队满而界面显示 8/9）；⚠★ **驻地闸只有一份判据 `AllowedHere()`**（两处各写必然漂成「按钮亮着点下去 wrong-settle」）；⚠ 池子内容与账号无关，种子只吃 worldSeed/settle/rollNo。
- ⚠ 招募生成器真源 `Engine/js/chargen.js`（出口 `window.Chargen`，只开 `chargenPoolJson` 一条 case）；三者别混：`crew-model.demoSquad` / `chargen-core.js`=`CultivatorGen` / `Engine/js/chargen.js`。⚠ 三个在线判据都 `DELETE /api/crew` ⇒ 端口 8140 **硬 SKIP**。

## ⚠ 构建 / 验证 / 本机坑（细则 → DETAILS + skill）
- 三红线：① 清文件一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先过 `git ls-files`，**禁 shell 通配与 `git rm`**（已 3 次误删，`verify/_*` 删后不可恢复）② `git push` 代理要现场探：直连 GitHub 一直不通（`schannel: failed to receive handshake`）；2026-11-27 实测 7897 已死，改用 `git -c http.proxy=http://127.0.0.1:8965 push origin main`（备 12618）。⚠ 判据只认 `git ls-remote`（curl 走自己的 TLS 栈会误报 000/200）；git 全局 `http.proxy=7897` 属过期配置，显式 `-c` 覆盖即可 ③ 后台实例活不过一个回合 ⇒ 起实例+跑实机判据**同回合**，别 kill 用户 8140。
- 判据四防：绝对值阈值必假红／参照系不能是被测规则自己的目标函数／复算同容差语义／源码守卫判整个函数体且先剥注释。诊断走 Node（PS 输出被吞、Bash shim 缺 ls/cd/dirname、`/tmp→D:\tmp`、`>log` 吞输出）；临时脚本写 `Temp/`；rc=2=跳过。
- ⚠ 合并两线：题名牌可删、**本宗面板不可删**；对撞文件 `git checkout --theirs` 取远端再打补丁。
