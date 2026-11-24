# 宗门模拟器 demo · 长期备忘
> 只钉**跨模块契约 & 会误事的坑**。细则指针：
> - `DETAILS-引擎与表现层.md` —— 引擎/灵脉/建筑/小地图/前端自算/渔村A2/势力B/匾额C/世界种子/构建坑
> - `.workbuddy/skills/zongmen-verify-pipeline/SKILL.md` §1~§39 —— 跑法/验收姿势（唯一真源）
> - `docs/小队背包数据接口.md` —— 队伍/背包契约（§12 多小队、§13 归属标记/空队合并）
> - 同目录 `YYYY-MM-DD.md` —— 每日叙事

## 全局 / 架构
- 坐标「格」(q,r)，渲染才 tileToWorld。服务端 .NET8(ClearScript.V8 + protobuf-net3 + SQLite/WAL)，Kestrel :8140（`127.0.0.1` + LAN `192.168.63.62`）。⚠ 引擎真源只在 `Server/Zongmen/Engine/js/`，前端在 `web/js/`。
- ⚠ 并行 Edit 偶发只落第一条却全报成功 ⇒ 改完必 grep 复核。
- 生成参数真源 `Engine/js/mapgen-config.js`，bundle 序 `[noise, mapgen-config, mapgen, mapgen-server]`；Node 侧须同序加载且先 `global.window = globalThis`（漏 ⇒ 静默跑旧参数）。
- 改引擎 js ⇒ ① `sync_preview_inline --check` ② 重启服务端 ③ 载荷变则停服清 `db/zongmen.sqlite*`。
- `edgeKeep` 是「保留」权重（衰减写 `1-edgeKeep`）；真半径 `MG.spiritEdgeWorld()`。存储格式/LRU 细则 → DETAILS。

## 协议 / 前端铁律
- protobuf 带符号整型 ZigZag；bytes 裸 LE 定宽；`WaterD=-1` 用 255 哨兵；pb.js 长度前缀 `var len=r.vi();var eN=r.p+len;`。
- mask 0→All、未登录剔实体层都在 MapWsHandler；revs **只更新 resp.mask 命中位**；帧 `[1B type][payload]`；TileResponse 恒 gzip。
- 写 chunk/region/settle/poi/comm/roads 必须同时 `forceStaticDirty()`。
- 色板真源 `/api/map/meta`；`sprite=row*8+col` 须在已绘制格 ⇒ 两侧字段清单必须对齐。
- ⚠ 新增图层/导出三处必挂：`JsEngineHost.cs` 的 `JsWorldVm.Call` 白名单 / repeated 逐次 push / WS 解码异常必须 reject pending。
- ⚠ 纯海区块 pn=0 ⇒ `chunkToArrays` 给 **null** ⇒ 读 `.length` 崩整页；可选包一律判空。

## 灵脉占地 7/3/1（真源 `veinFootKeep`；细则 → DETAILS）
- 大 = hexDist≤1（7 格）／中 = 本格+(-1,1)+(0,1)（3 格）／小 = 本格；d≥2 不留。从属格 level=`CFG.VEIN_SAT_LEVEL(=3)`，**不进 comm.veins[]**。`fields()` 守卫 `vn.d<=1 && e>=SEA_LEVEL && veinFootKeep(...)`；`buildChunk` 用 `e: f.vein?f.vein.level:f.e`。
- 判据 `check_vein_cluster.mjs`（26 条）+ `check_vein_skin.mjs`。已知非缺陷：相邻群落次级灵脉可落同格 ⇒ `veinNear` 取最近裁其一 =「幻影灵脉」。
- 地盘彩环同口径：真源 `vein-skin.js footOffsets(level, MG)`（引擎在就问 `MG.veinFootKeep`，`FOOT_MIRROR` 仅兜底）；⚠ 一格只画一次 —— `veinOwnerOf` 按 hexDist 最近裁决。探针 `?veinprobe=1`。

## 小地图 R12/R13（细则 → DETAILS）
- 热拔插单点 `main.js initMinimap()` 只注入 `{panel, full, snapshot, jump}`。⚠ main.js 是 `(function () {` **无 `g` 形参** ⇒ 只能写 `window.MiniMapVein`，写 `g.` 整页 fatal。
- 三层：L1 地形前端按 seed 自算（只读 `biome/e`，⚠ 绝不读 `onRoad`）／L2 世界走 WS 快照／L3 视野（面板档跟主相机 `FOLLOW_WPP=6`）。
- 引擎脚本经 WS 下发：帧 `Script=4`，`EngineScriptOrder=[noise,mapgen-config,mapgen]`（白名单防穿越）。⚠ 帧本身不 gzip，只有 `Source` 字段 gzip。
- R13：`panelWpp = baseWpp*DEFAULT_ZOOM/camZoom`（乘积恒 13.2）；滚轮只改 `baseWpp`。
- 手机档：触摸四闸（⚠ 触摸后 ~300ms 合成 `mousedown/up` ⇒ 一拖就弹全屏；判据比 `e.timeStamp`）＋ `color-scheme: only light`。U4 块色表决/面板几何 → DETAILS。

## 前端自算地图（细则 → DETAILS）
- 算法已在跑（小地图 L1）；`EngineScriptOrder` 不含 `mapgen-server.js`；A/B 铁证 `verify/chunk_selfcalc_ab.mjs`。
- ⚠ 三障碍：主线程阻塞（分帧/Worker）／`noiselib.js` 与引擎 `noise.js` 同名 `NoiseLib`／双实例或双 `init(seed)` 互清缓存。
- 收敛点 `main.js applyBlock(job,resp)`（5 图层唯一分发）；地形改前端算 + WS mask 去 `CHUNK`(=30)。⚠ 世界可写后纯前端自算失效。

## HUD 契约（2026-11-24 大改）
- 题名牌/宗门录/择宗菜单**已整体删除**（`#titleBox`/`#sectBox`/`#sectMenu` 全没）；`#topbar` 只剩右上齿轮（`justify-content:flex-end`）。
- 山川志 `#info` = 可拖动浮窗（`h3` 把手；拖过存 `ZMStore('infoPos')` 且不再跟随点击；默认宽屏右下/窄屏右上 `top:62`）；正文「此格之物」在前 →「地土」。
- ⚠ 拖动状态变量不能叫 `st`（`frontend_smoke` 当聚落字段审计，含注释）⇒ 用 `dragSt`。

## 小队/能力/背包面板（`web/js/crew/`，独立插件，main.js 零改动）
- 三件套 `crew-model.js` / `crew-panel.js` / `crew-panel.css`（桌面 404px 抽屉，≤760px 底部 80dvh）；index.html 只多两行 script。
- 口径：**六项属性 = 六道 体/气/神/器/丹/阵**（天赋之和，每道 ≤60）；气血/攻防/命中/闪避/负重是**派生战斗值**，只在能力页。人物框 4 条状态条按「当前/上限」；页签叫「能力」；只有**全局背包 6×8=48 格**。
- 队伍行 4 层：姓名/职司境界/修为(+「移」) → 六属性 → 气血·灵力细条 + 5 装备图标 → 功法。⚠ 队伍页**无顶部提示行**、面板无页脚（有反向断言）。
- 能力页内嵌背包 = **两步**：点格只选中+出详情卡（`#pcInfo` 夹在分类与网格间），再点「装备/替换/服用/研习」才动手。
- 药物 `M.useItem(pawn, stash, idx)`；换装对比 `M.compareGear()`；`pawn.vit={hp,mp}` + `M.vitalOf()`（上限现算）；属性不存（天赋+装备+特质现算）；换装 `M.equip/unequip`，旧件回腾出的格。
- ⚠ **品阶色只能作用在文字节点**：裸 `.q1{color}` 会命中图标方块 ⇒ 字色=底色。只写 `.ws-n/.bc-n/.ii-n/.qk-n.qN`，图标一律 `.ws-g/... .rp-g.qN { background; color: 浅色 }`。
- 天赋 `genTalents`：主/次道权重 3/1.8/0.5，六道都不为 0。演示参数 `?crew=1` / `?crewtab=` / `?crewcount=3..9` / `?qksel=eq|pill` / `?squads=N`。
- ⚠ CSS 注入：init 在 DOMContentLoaded，`document.currentScript` 已 null ⇒ IIFE **解析时**存 `SELF`，否则 css 404 无报错。⚠ 别在 init 后同步量 `getComputedStyle`（CSS 异步注入）⇒ 样式断言放 200ms 轮询块。
- ⚠ 法宝换装只动 `queue[0]`，不可 unshift 后塞背包（同对象双存）；卸法宝时队列还有件 ⇒ 槽位换下一件（不是空槽）。
- **多小队**：`state.squads=[{id,name,members:[id…]}]` + `state.curSquad`；⚠ `state.pawns` 仍全量。队名 ≤4 字、最多 6 支；入口 = **每队一条独立纸签 `.ce-item` 上下堆叠**（条尾本队人数，当前队放大成 tab；不是一条横条挤多个队名）；点哪条 ⇒ 开面板 + `scrollIntoView` + `.flash`。队伍页 = **纵向多段**：段头 `≡`+队名+人数+负重+×（二次确认），拖段头改队序、拖弟子行改站位/换队，双击改名，底部 `＋ 新建小队`。
- **归属标记**：不存字段，唯一真源 = `members` 数组顺序；读 `M.locatePawn(state,id)` / `M.probe().assign`；写只走 `M.movePawn(state,id,toSq,toPos)`（空队可收人，返回 `fromEmpty`）。⚠ 别另存 position。
- **空队/移空**：空队也渲染 `.rp-list.empty`（高≥40px）当落点，拖进去或「移」都行；空队不自动删。移空 ⇒ 提示「负重 0（物品都在宗门背包，不会丢）」。当前全宗一份背包；若改分队背包，移空必须整队 bag 并入主背包（件数/负重守恒）。
- ⚠ `eatClick` 只吃**拖动松手后的那一次** click，不能写成时间窗（否则切队/解散被吞）。
- 验收 `verify/_crew_harness.html?test=1`（**148 条**，I 段多小队 / J 段跨队+空队+移空）；先 `node verify/_crew_static.mjs 8199`；headless 必带独立 `--user-data-dir`（否则 exit=21 输出空）。真机 `verify/shot.mjs`。
- 契约：`squad{members[]}` + `bag{items[]}`；`crew-bridge.js` 双向转换。铁律：只传源数据 / 装备存 itemId 引用（`cell` int 在格、null 穿戴）/ id 带 `srv-`。`activity{kind,jobId,taskName,progress,done,since,note}`。`/api/crew` 5 端点，`CrewStore` 独立 `Crew` 表（塞 `Data` 会被 `PruneExcept` 删）。⚠ patch 用原始 `JsonObject` 逐键合并（DTO 会把缺失 int 抹成 0）；格位冲突只 warning。接后台必须 `setLocalTick(false)`。
- **事件流口径（2026-11-25 定案，真源 `docs/小队背包数据接口.md` §14）**：日常只发**事件**、不发整份契约（旧 `onChange + contract + PUT` 作废，PUT 降级为导入/调试）。9 条：`squad.create/rename/disband/move` + `member.move` + `item.equip/unequip/use` + `job.priority`；信封 `{v,id(幂等),seq,base(乐观rev),at,type,data}`，`data` 只放 id + 目标值。⚠ 砍掉 reorder（一次拖动只挪一个）；本地偏好（curSquad/selId/tab/filter）不发事件；拖动过程零事件、松手才 1 条；`job.priority` 发目标值不发"下一档"；`squad.create` 唯一非乐观。服务端 `CrewEvent` 独立表做 5 分钟去重 + `Crew.Rev`。事件走 JSON，protobuf 只留地图 WS。⚠ 代码尚未实现（§14.9 落点）。

## 渔村 / 势力 / 匾额 / 世界种子（细则 → DETAILS）
- 渔村 A2：不以「中心格在水里」判；引擎把「渔家」放开到聚落水面格；`WATER_KIND` 兜底 + `?water=old`。⚠ 加影响画法的 flag ⇒ `spriteOf` 缓存 key 同步加位。
- 势力 B：`factionOf` 取最近宗门；半径 `SECT_DOMAIN_R = COMM_R(25)×1.4 = 35`；⚠ `st._fac` 必须靠 `settleVer` 失效。`?fac=0`。
- 匾额 C-a：默认锚点 = 实体自己中心点；其余降 A/B 档。`check_plaque_align` 79 条；`?plaqprobe=1`。教训：用户要「中心点」先查数据是否有（skill §35）。
- 世界种子是服务端资产：`WorldLedger.cs` 独立表 + `/api/world/*`；前端拿不到就 `showFatal`，绝不前端造；`?seed=` 仅调试。
- 设置唯一真源 `web/js/store.js`；`showVeins/showLabels` 变量名不能改（`frontend_smoke` 逐名扫）。

## ⚠ 文件 / 文本写入高危
- 已 3 次误删。清理一律 Node `fs.unlinkSync` 绝对路径 + basename 断言，先过 `git -c core.quotepath=false ls-files`；禁 shell 通配与 `git rm`。⚠ `verify/_scratch_diag.mjs` 被跟踪。
- ⚠ **禁止用 bash heredoc/`>>` 追加中文 md**：本机 shim 会写到**文件开头并覆盖原字节**（2026-11-25 毁过 `docs/小队背包数据接口.md` 开头 34 行）。一律 Write/Edit。
- ⚠ bash 双引号里包 `node -e` 时反引号会被命令替换。

## 构建 / 验证（跑法见 skill；坑 → DETAILS）
- 基线：离线 19 + 在线 4；runner `verify/run_regression.mjs`（`--offline-only`/`--with-server`/`--only=`/`--skip=`/`--list`）。
- ⚠ 别 kill 用户 8140；临时实例 **`MaxSeeds` 显式放大**（默认 3，用满后报「快照未就绪」，像产品回归）。skill §22。
- ⚠ 判据三防：绝对值阈值必假红（改 A/B 归因）／参照系不能是被测规则自己的目标函数／复算同容差语义。几何断言优先数值探针。
- ⚠ 本机：WMIC 黑名单（`netstat -ano`+`tasklist /FI`+`taskkill /PID`）；PowerShell 输出会被吞 ⇒ 走 Node；Bash shim 缺 `ls/cd/dirname` ⇒ 先 `export PATH="/c/Program Files/Git/usr/bin:$PATH"`。
- ⚠ 后台实例活不过一个回合 ⇒ 起服务 + 跑判据同回合；跨回合先 `net.connect` 探端口。仓库外实例 `/api/debug/snap` 落实例目录旁 ⇒ `live_cap` 超时但探针已写出（skill §35.2/§35.3）。
