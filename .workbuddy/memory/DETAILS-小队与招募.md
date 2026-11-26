# 细节契约 · 小队 / 背包 / 招募 / 招募生成器

> `MEMORY.md` 的配套细节文件。动 `web/js/crew/`、`web/js/recruit/`、`Server/Zongmen/Storage/{CrewStore,RecruitStore}.cs`、`Engine/js/chargen.js` 时读本文件。所有 `check_*.mjs` 是这些契约的可执行真源。

## 小队 / 能力 / 背包（`web/js/crew/`，独立插件，main.js 零改动）
- 四件套 `crew-model.js`/`crew-panel.js`/`crew-panel.css`/`crew-bridge.js`；index.html 3 行 script 在 main.js 之前。口径：六项属性=六道（天赋之和，≤60/道），气血/攻防/命中/闪避/负重是**派生值**；只有全局背包 6×8=48；页签叫「能力」。
- **多小队**：`squads=[{id,name,members[]}]`+`curSquad`，`state.pawns` 仍全量；归属唯一真源=members 数组顺序（读 `locatePawn`/`probe().assign`，写只走 `movePawn`），**别另存 position**；空队也渲染 `.rp-list.empty`、不自动删。
- 契约：单 `squad{members[]}`+`bag{items[]}`；装备存 itemId 引用、id 带 `srv-`；`/api/crew` 5 端点，`CrewStore` 独立 `Crew` 表；patch 用原始 `JsonObject` 逐键合并；接后台必须 `setLocalTick(false)`。
- 事件流（真源 `docs/小队背包数据接口.md` §14）：只发事件不发整份契约；信封 `{v,id,seq,base,at,type,data}`；拖动过程零事件；`squad.create` 唯一非乐观。⚠ 代码未实现；**`member.recruit` 未定义**（接招募时补）。验收 `_crew_harness.html?test=1`（148 条）+ `_crew_static.mjs`。
- ⚠★ **编制上限恒 = 9（`SquadCap`），不许读 `contract.squad.capacity`**：该字段被 `crew-bridge` 旧默认值写成背包行数 8 ⇒ 第 8 人报「队满」而界面显示 8/9。前端同值 `crew-model.CFG.SQUAD_CAP`；`hireGate` 下发 `squadCap`/`maxSquads`/每队 `canEnter`+`full`，前端只读不推。

## 招募系统（`/api/recruit/*` + `web/js/recruit/`）
- 四端点 `GET state|pool?settle=` + `POST roll|hire`；**点数和 taken 按账号**（`X-Account`，缺省 `guest`），**crew 契约全局单份** ⇒ 驻地闸对全服可见、余额各自独立；`RecruitPoint`/`RecruitPool` 独立表。
- ⚠★ 池子内容与账号无关（种子只吃 worldSeed/settle/rollNo）；`taken` 也是每人一份（个人进度，不是公共池）。
- 生成器出口只开**一个**：`mapgen-server.js` → `chargenPoolJson(optsJson)` → `Chargen.genPoolJson`，C# 只加 `"chargenPool"` 一条 case。暴露 `global.Chargen` 13 个函数 = `check_js_exports.mjs` 一片红。
- ⚠★ **驻地闸只有一份判据 `AllowedHere()`**（Gate.allowed 与 Decide 共用）：没队员哪都能招；有队员 ⇒ 至少一队驻地在本地或驻地为空。两处各写一份必然漂成「按钮亮着点下去 wrong-settle」。
- ⚠ 并发抢同一 slot：`Mutate` 里先查成员 id 已存在 ⇒ `dupHired`（退点 + `duplicated:true`），否则同 id 弟子和装备写 N 份；`MarkTaken(..., rollNo)` 批次不符不标。
- `SettleLocked`：首次建档 `nowTick<=0` **只回临时行不落库**；夹断 cap 后必须回写 `_points`；`EnsureLoaded` 的 `_loaded` 只能在读成功后置位。
- 判据：`check_recruit_pool.mjs`(22) / `check_recruit_api.mjs`(57,需起服务) / `check_recruit_race.mjs`(9) / `check_recruit_e2e.mjs`(18+17) / `check_recruit_ui.mjs`(36)。⚠ 正式脚本别用 `_` 前缀（被 `.gitignore` 的 `verify/_*.mjs` 吞）。
- ⚠★ 三个在线判据都会 `DELETE /api/crew`（全局单份）⇒ 端口 8140 **硬 SKIP**（玩家存档）；e2e 还要求 guest 首日 50 点 ⇒ 库副本先 `delete from RecruitPoint/RecruitPool`。重置测试库要连 `-wal`/`-shm` 一起删；起临时实例用 `Zongmen__Port`/`Zongmen__DbPath` 覆盖，别改 appsettings.json。
- 方案档：`docs/游戏设计/招募系统-实施方案.md`（v2：产量=影响力(桩恒10)/上限=产量×30/刷新-30/招人-50/初始50；池子快照落库；弟子数=小队人数合计）。

## 招募生成器（真源 `Server/Zongmen/Engine/js/chargen.js`，出口 `window.Chargen`）
- 口径：灵根合计恒 100、**每系 ≥20**、系数量 1/2/3/4/5 = **1%/2.5%/20%/30%/46.5%**（⚠ 实际只出 0/20 两档，合计=20k）；天赋 **90~180 平方偏斜**（`90+90·rng^TALENT_SKEW`，SKEW=2 ⇒ 均值 120、150+ 仅 18%）、单道 ≤60；**只出凡人**（炼气 1~3 层）；神通 0 已学（cap 3）；装备只发起步件；**特质 1~3 全正面**四档；抽取走**量化加成轮盘**（`w=BASE/bonus^2.5×档位系数`，双闸 ⇒ 天命仅 0.15%/人）；⚠ **百分比一律原值÷4**（`+50%→+13%`），点数值不缩。
- ⚠ 三者别混：`crew-model.demoSquad`（前端演示）、`chargen-core.js`=`CultivatorGen`（世界人口 NPC）、`Engine/js/chargen.js`（可招募弟子）。⚠ 旧 `probe` 仍断言「灵根合计 100 / 神通 3~4 格 / 修为>0」⇒ 新生成器在旧 probe 下会红。
