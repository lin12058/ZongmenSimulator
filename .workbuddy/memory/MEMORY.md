# 宗门模拟器 demo · 长期备忘
> **只钉跨模块契约 & 会静默误事的坑**，一行一条。细则分流：
> `DETAILS-引擎与表现层.md`（引擎/灵脉/小地图/前端自算/渔村/归属/匾额/世界种子/建筑/**Core-Subsystems 详述**/**Tick**/**本机坑**）。
> 跑法/验收/教训唯一真源 → skill `zongmen-verify-pipeline/`（`SKILL.md` 入口索引 + `references/*.md`，章号仍用 §4~§46；每日 → 同目录 `YYYY-MM-DD.md`）。
> 方案档：立宗/城市扩张→`玩家宗门放置与城市迭代方案.md`§十；Tick→`docs/游戏时钟与Tick演化框架方案.md`(v2.1)；城市→`脚本化城市迭代-v2`+`城市演化-v4`；人物/分布→`待办事项/人物系统-资料调研.md`+`地图人物分布-实施方案.md`+`Subsystems/Characters/README.md`；战斗→`待办事项/战斗系统-资料调研.md`；**招募生成器→`docs/游戏设计/角色生成器-实施方案.md`**；**招募系统→`docs/游戏设计/招募系统-实施方案.md`**（2026-11-26 v2 定案：产量=影响力(桩恒10)/上限=产量×30(当前300)/刷新 -30/招人 -50/初始 50；池子快照落库防刷；弟子数=小队人数合计；`Squads[].Settle` 驻地 —— 有队员只能在本队驻地招，否则 `wrong-settle`，无队员任意聚落可招；⚠ `squads` 整表替换会静默洗掉 settle）。

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。.NET8(ClearScript.V8 7.4.5 + protobuf-net3 + SQLite/WAL)，Kestrel :8140。⚠ 引擎地基真源只在 `Engine/js/`，前端 `web/js/`，`city-evo.js` 在 `Subsystems/City/js/`。
- ⚠★ 同一文件多条 Edit 同条消息 ⇒ **只有最后一条生效**（回执都成功，实测 4 次）⇒ 一文件一次一条，改完必 grep 复核（`replace_all` 同守）。
- 参数真源 `mapgen-config.js`；bundle 序 `[noise,mapgen-config,mapgen,mapgen-server,city-evo,chargen]`（chargen 排最后，**不进** `ComputeEngineHash`/`EngineScriptOrder` ⇒ 不使世界库失效）；Node 侧同序且先 `global.window=globalThis`，漏加载=静默跑旧参数。改引擎 js ⇒ ①`sync_preview_inline.mjs --check` ②重启服务端 ③载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`，写反=越浓越沉海）；半径真源 `MG.spiritEdgeWorld()`。
- 存储：`Data(Key,Value BLOB)` WAL+250ms，只存 chunk/comm/settle（gzip+protobuf，键 `w:<seedHash16>:<kind>:<a>:<b>`）；Region 内存 LRU512；tile/fields 不落库。⚠ `PruneExcept` 静默删非活跃 seed 前缀 ⇒ 台账/玩家资产/演化状态**必须独立成表**（`WorldLedger`/`PlayerSectStore`/`CityStateStore`/`WorldClock`/`TickJob`/`TickPerf`）。
- ⚠★ **V8 单线程**：`JsVm.Call` 全程持 `SemaphoreSlim _gate` ⇒ 一世界内不并行；并行度只来自多 VM(多 Scope)/多 seed。⚠ 每个新 JS 出口都要在**对应** `JsvmModule.Invoke` switch 加 case（世界层→`WorldModule`，子系统→各自 `*Module`），漏=`未知 JS 函数`（编译期不报）。守卫 `verify/check_js_exports.mjs`（三向闭合，含「改坏必红」自检）——C11 就是这么漏的 3 个。
- ⚠⚠★ **DI 循环藏在手写 factory lambda = 静默死锁**（绕过容器检测 ⇒ 不抛异常/进程活着/不监听/零日志；声明式 `AddSingleton` 反而会抛）。定位：`netstat` 无监听 + **绕代理** `curl` + log 0 字节 ⇒ `Program.cs` 插 `Stopwatch` 桩。
- ⚠ ClearScript 7.4.5 ⇒ `IArrayBuffer` 只有 `byte[]` 重载。`pben.js` 挂载点：✅ bundle 数组；❌ `EngineScriptOrder`/`ComputeEngineHash`。

## 协议 / 前端铁律
- protobuf **带符号整型 ZigZag**（Q/R/RegionI/RegionJ/Ca/Cb/AnchorQ/AnchorR/Tick/Clock）；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 前缀 `var len=r.vi();var eN=r.p+len;`。⚠ 负 int32=10 字节 varint，前端溢 2^53 ⇒ **哨兵别用 -1**。
- mask 0→All、未登录剔实体层都在 MapWsHandler；revs 只更新 resp.mask 命中位；帧 `[1B type][payload]`；TileResponse 恒 gzip。WsFrame 1 Login/2 Tile/3 Ping/4 Script/5 PlaceCheck/6 PlaceCommit/7 Clock。
- ⚠★ **块级 rev**（`BumpBlockRev`）：改某块某图层内容必须 Bump，否则客户端带旧 lastRevs 被判「未变化」⇒ **永久陈旧**（不报错）；还须 `EvictWithGate` 作废落库包，否则淘汰后 `ReadSqlBackfill` 把旧包捞回。
- 写 chunk/region/settle/poi/comm/roads 必须同时标脏（`MarkSettleDirty`=`EvictWithGate`+`BumpBlockRev`；旧名 `forceStaticDirty` 不存在）。
- ⚠ 新增图层/导出三处必挂：① Invoke switch ② repeated 逐次 push ③ WS 解码异常必须 reject pending。⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 null ⇒ 可选包判空。⚠ 别混 JSON 名与 protobuf 名（placeCheck 落点 protobuf=`ok`/JSON=`can`）。

## Core / Subsystems（一子系统一 VM）
- `Engine/`=地基（`JsvmModule`/`JsVmPool`（键 (Scope,seed)）/`WorldModule`）；`Subsystems/`=一子系统一文件夹（`ISubsystem`+`SubsystemRegistry`，Core 只认契约）；一子系统一独立 V8 ⇒ tick 走 `city`、读路径走 `core`，零门闩争用。旧 `JsEngineHost`/`JsWorldVm` 已删。细则 → DETAILS。
- ⚠★ 接新子系统三坑：① `AcceptsExternalSettlements` 默认 false ⇒ 纯数据子系统首次建 VM 即抛「未知 JS 函数」② 两 VM 同 bundle 但**出口分治**，ext 须对两 Scope 统一注入，漏一边=静默错位 ③ 角色=`(seed,index)` 纯派生不落库，`GET /api/characters`（gzip/no-cache），真源 `Subsystems/Characters/js/chargen-core.js`（classic script，出口 `CultivatorGen`），`roster.js` 载荷带 `dict`（不许硬编码标签）。

## 子系统契约
- ⚠★ **世界种子=服务端资产**：`WorldLedger.cs` + `/api/world/current|next|list`；取不到 `showFatal`，绝不前端造；唯一真源 `store.js`；`showVeins/showLabels` 变量名不能改（frontend_smoke 逐名扫）。
- ⚠ 小地图 main.js 是 `(function(){` **无 `g` 形参** ⇒ 只能 `window.MiniMapVein`；帧 Script=4 不 gzip（只有 `Source` 字段 gzip）。
- ⚠ **玩家放置**：`roadVer` 只能 +1 绝不归零；`DOMAIN_R` 真源在引擎（city8/town6/sect3-8/2-7/1-6/village4/fishing4/poi0），C# 不镜像、前端必须镜像；`isExpandType` 白名单必存在；`excludeId` 只立宗档传；判据优先级 `bad_type→too_far→deep_water→on_vein→too_close→spirit_too_low`；`PlayerSectStore` v1→v2 迁移单事务+显式列。
- ⚠ **Tick**（详述 → DETAILS）：`CommitSuccess` 必须经 `_registry.NextDue`；相位钥匙 `KindNames.Of(kind)`；`ApplyOutcome` 唯一写世界入口；`ExpectedJobsProvider` 必须返回全集，**返回 null=整轮跳过、绝不喂空集**；`EnableDemoHeartbeat` 默认 false；**`AdvanceTo` 收集即吊销 ⇒ 被收集 job 必须本 tick 内 re-arm**（`DeferUnapplied` 已兜预算/异常）；换世 `CityStateStore.RemoveRound`；修复记录 → `待办事项/代码审查-最近提交bug清单.md` §七。
- ⚠ **城市 v4**：`settleJson.towns[]` 无 `type/q/r` ⇒ 静默 K 塌到 K_MIN（用 `citySettlementsJson`）；建筑计划纯派生不落库；state 1→cap=0、3→`cap×0.65`（折减在 CAP_MIN 夹断之后）；事件唯一写入口 `ApplyShock`；Δ 判据须 `step(s,90)≡9×step(sᵢ,10)`，`dt=0` 严格 no-op，绝不逐子步 round(pop)。

## 图层5 人物分布（详述 → DETAILS；判据 `verify/check_people_layer.mjs`）
- ⚠★ **mask 门控、不走 rev 去重**（`wantPeople`，含该位每发必带）：关开关丢数据但 `lastRevs[5]` 仍记旧 rev ⇒ 二次打开**永久空白**（不报错）；前端掩码是**剔位** `mask &= ~PEOPLE`。落格走 core VM、战力/小队走 characters VM（不吃境界，小队 1~12）；C# `BuildPeopleLayer` 两 VM 拼装 + 进程内 LRU 不落库；`TileMask.People=1<<5`/`All=0x3F`/revs 6 元；前端 `people-layer.js`。

## 前端 UI 边界
- `#sectWrap`=本宗面板，数据源=服务端 `PlayerSect` 表（不读 settleCells）；地图渲染走 `EntityGroup→PlaceEntity→settleCells`。
- 他人详情 `web/js/infocard.js`（`window.InkInfoCard`）、名录 `web/js/roster.js`：只注入不渲染，⚠ 引入在 `main.js` 之前。
- ⚠ 删前端 DOM 必与删 JS 引用**同批**（frontend_smoke 反向守卫）；DOM 句柄别叫 `st`（保留名，用 `elState`/`dragSt`）。
- **HUD 最终形态**：`#titleBox` 已删；`#topbar`=`#hudLeft`（`#toolBox`+`#sectWrap`）+ 右上 `#controls`。⚠ `#sectBody` **不许删**。山川志 `#info`=可拖动浮窗（h3 把手，存 `ZMStore('infoPos')`；远端 `showInfo(tile)` 移植时**点击行要同改**）。`els.era`/`els.eraRound` 已恒 null ⇒ 判空。

## 小队 / 能力 / 背包（`web/js/crew/`，独立插件，main.js 零改动）
- 四件套 `crew-model.js`/`crew-panel.js`/`crew-panel.css`/`crew-bridge.js`；index.html 3 行 script 在 main.js 之前。口径：六项属性=六道（天赋之和，≤60/道），气血/攻防/命中/闪避/负重是**派生值**；只有全局背包 6×8=48；页签叫「能力」。UI 细则（品阶色 / CSS 注入 / 两步背包 / `eatClick` / 法宝队列）→ DETAILS「小队面板 UI 细则」。
- **多小队**：`squads=[{id,name,members[]}]`+`curSquad`，`state.pawns` 仍全量；归属唯一真源=members 数组顺序（读 `locatePawn`/`probe().assign`，写只走 `movePawn`），**别另存 position**；空队也渲染 `.rp-list.empty`、不自动删。
- 契约：单 `squad{members[]}`+`bag{items[]}`（多队升级 → 接口档 §12 三处）；装备存 itemId 引用、id 带 `srv-`；`/api/crew` 5 端点，`CrewStore` 独立 `Crew` 表（塞 `Data` 会被 `PruneExcept` 删）；patch 用原始 `JsonObject` 逐键合并；接后台必须 `setLocalTick(false)`。
- 事件流（真源 `docs/小队背包数据接口.md` §14）：只发事件不发整份契约（PUT 降级导入/调试）；9 条 `squad.*`+`member.move`+`item.*`+`job.priority`，信封 `{v,id,seq,base,at,type,data}`；拖动过程零事件；`squad.create` 唯一非乐观。⚠ 代码未实现；**`member.recruit` 未定义**（接招募时补）。
- 验收 `_crew_harness.html?test=1`（148 条）+ `_crew_static.mjs 8199`。

## 招募系统（2026-11-26 落地：`/api/recruit/*` + `web/js/recruit/`）
- 四端点 `GET state|pool?settle=` + `POST roll|hire`；**点数和 taken 按账号**（`X-Account`，缺省 `guest`），**crew 契约全局单份** ⇒ 驻地闸对全服可见、余额各自独立；`RecruitPoint`/`RecruitPool` 独立表（不塞 `Data`，`PruneExcept` 会删）。
- ⚠★ 池子内容与账号无关（种子只吃 worldSeed/settle/rollNo）⇒ 越权只能靠账号，别指望"不同人看到不同人"；`taken` 也是每人一份（个人进度，不是公共池）。
- 生成器出口只开**一个**：`mapgen-server.js` → `chargenPoolJson(optsJson)` → `Chargen.genPoolJson`，C# 只加 `"chargenPool"` 一条 case。把 `global.Chargen` 13 个函数直接暴露 = `check_js_exports.mjs` 一片红。
- 写 Crew 一律 `CrewStore.Mutate`（锁内深拷贝→改→`Save`，失败退点）；`Patch` 里 `squads` 整表替换必须「旧 `settle` 非空则保留」。
- 判据四条（都 `check_` 前缀、已入库）：`check_recruit_pool.mjs`(22, 纯 JS) / `check_recruit_api.mjs`(49, 需起服务) / `check_recruit_e2e.mjs <base> hire|roll`(17×2, headless) / `check_recruit_ui.mjs`(34, 源码守卫)。⚠ 正式脚本别用 `_` 前缀，会被 `.gitignore` 的 `verify/_*.mjs` 吞掉。
- ⚠ 重置测试库要连 `-wal`/`-shm` 一起删（只 `cp` 主库 ⇒ 旧 WAL 被重放，看着新库其实带旧招募行）；起临时实例用 `Zongmen__Port` / `Zongmen__DbPath` 环境变量覆盖，别改 appsettings.json。

## ⚠ 构建 / 验证 / 本机坑（细则 → DETAILS + skill）
- 三红线：① 清文件一律 Node `fs.unlinkSync` 绝对路径+basename/数量断言，先过 `git ls-files`，**禁 shell 通配与 `git rm`**（已 3 次误删，`verify/_*` 删后不可恢复）② `git push` 的代理要现场探：**2026-11-26 起直连 GitHub 不通**（`Recv failure: Connection was reset`），须走 `-c http.proxy=http://127.0.0.1:7897`（v2rayN，实测 200）；旧口径「必加 `-c http.proxy=` 绕代理」已失效。推前先 `curl -x http://127.0.0.1:<port> -m 6 https://github.com` 探 7897/12618 哪个通，别硬套 ③ 后台实例活不过一个回合 ⇒ 起实例+跑实机判据**同回合**，别 kill 用户 8140。
- 判据四防：绝对值阈值必假红（改 A/B 归因）／参照系不能是被测规则自己的目标函数／复算同容差语义／源码守卫判整个函数体且先剥注释。诊断走 Node（PS 输出被吞、Bash shim 缺 ls/cd/dirname、`/tmp→D:\tmp`、`>log` 吞输出）；临时脚本写 `Temp/`；基线离线 30+在线 6；rc=2=跳过。
- ⚠ 合并两线：题名牌可删、**本宗面板不可删**；对撞文件 `git checkout --theirs` 取远端再打补丁。

## 招募生成器（2026-11-25 新线）
- 真源 `Server/Zongmen/Engine/js/chargen.js`（出口 `window.Chargen`，无依赖 classic script；Node 侧 `global.window=globalThis` 可直接载）。方案 → `docs/游戏设计/角色生成器-实施方案.md`。
- 口径：灵根合计恒 100、**每系 ≥20**、系数量 1/2/3/4/5 = **1%/2.5%/20%/30%/46.5%**（⚠ 实际只出 0/20 两档，合计=20k，100 仅作纯度分母）；天赋 **90~180 但平方偏斜**（`90+90·rng^TALENT_SKEW`，SKEW=2 ⇒ 均值 120、150+ 仅 18%、两道≥55 仅 3.4%）、单道 ≤60；**只出凡人**（炼气 1~3 层，境界不由天赋推）；神通 0 已学（cap 3，靠功法书+时间）；装备只发起步件（灵力驱动规则待做）；**特质 1~3 全正面**、四档 common/uncommon/rare/epic，负面不再产出；抽取走**量化加成轮盘**（`w=BASE/bonus^2.5×档位系数`，`TRAIT_HIGH_CAP=1`+`TRAIT_BONUS_CAP=10` 双闸 ⇒ 天命仅 0.15%/人）；⚠ **百分比一律原值÷4**（`+50%→+13%`），点数值不缩，落在派生值上保底 +1。
- ⚠ 三者别混：`crew-model.demoSquad`（前端演示）、`chargen-core.js`=`CultivatorGen`（世界人口 NPC）、`Engine/js/chargen.js`（可招募弟子）。⚠ 旧 `probe` 仍断言「灵根合计 100 / 神通 3~4 格 / 修为>0」⇒ 新生成器「0 神通、炼气 1 层」在旧 probe 下会红，接入前按方案档改。
