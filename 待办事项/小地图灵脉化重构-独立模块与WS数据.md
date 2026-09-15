# 小地图灵脉化重构 · 待办（T2~T11 已落地 · 见 §8）

> 生成 2026-09-15 12:40 / 更新 2026-09-15 13:00（**仅规划，未动任何代码**）/ **§8 实施结果 · 2026-09-15 18:30 已全部落地**
> 需求来源：用户 2026-09-15 两条 ——
> ①「右下角小地图一直请求导致到了请求速率」；要求融合 `灵脉预览.html` 重做小地图、可最大化、**独立文件热拔插**、数据改 WebSocket；
> ②追加（本轮）：**可独立平移，打开后可以拖动；小地图在左下角，默认跟随视野；传入 seed，地形在前端计算；「未探测」纹理；除地形外都走 WS 因为世界是动态的；D5 删掉**。

---

## 0. 根因与已核对事实

| 项 | 事实（实测行号） |
|----|------------------|
| 速率根因 | `main.js:587 requestMinimap` → `MC.fieldGrid` → HTTP `/api/map/fields`（132×88 服务端采样），由 `minimapTimer`(2172-2184) / `minimapWindowStale`(651) 反复触发 → 撞 `ApiRateLimitMiddleware`（`Program.cs:36`） |
| 现小地图全部落点 | `main.js:585-698`（requestMinimap/refreshMinimap/minimapWindowStale/mmCamMoved/syncMinimapSize/drawMinimap）+ 状态 `105-108` + 脏位 `344/1681-1682` + loop `2172-2190` + 点击监听 `2051` + `els.minimap` `2205`；`index.html:190-196/212/261-264` |
| 引擎已是浏览器可跑 | `mapgen.js:1887` 结尾 `})(window);`、导出 `global.MapGen{init,fields,elevAt,BIOME_META,BIOME,ELEMENT_RGB,VARIANT_RGB,hexDist,tileToWorld,pxToTile,spiritEdgeWorld,settlementsFor,roadsNear,tradeEdgesFor,growTownFootprint,communityOf,roadCache,CFG,configure…}`（`mapgen.js:1811-1886`）；`灵脉预览.html:2255/5489/4401` 即 `MapGen.init(seed)` + `MapGen.fields(q,r)` |
| 引擎 bundle 序（真源） | `JsEngineHost.cs:126`：`noise.js, mapgen-config.js, mapgen.js, mapgen-server.js`；服务端还前置 `'use strict'` + `var window = globalThis;`（`JsEngineHost.cs:124-125`）——**说明引擎在严格模式下已跑通**，浏览器侧同样严格 eval 无额外风险 |
| 引擎自带缓存 | `mapgen.js:162-186` `elevCache/fieldCache/regionCache/settleCache/roadCache/commCache/veinNearCache/…`（均带 CAP 上限）⇒ 前端逐格 `fields()` 首次算、之后命中缓存 |
| 静态托管口径 | `StaticWebMiddleware` 只托管 `web/`（`Program.cs:35`），**不托管 Engine/js** ⇒ 想在前端跑引擎必须另开通道（本轮定为 WS 下发，见 §3） |
| 引擎目录真源 | `Options.cs:42-49 ResolveEngineJsDir`（默认 `Server/Zongmen/Engine/js`） |
| 布局冲突 | `#info`（山川志）现占 **left:16 bottom:18**（`index.html:175-177`），小地图要挪到左下角 ⇒ 二者必须让位（见 §6 Open Q2） |

---

## 1. 需求登记（用户原话 → 落点）

| # | 用户原话 | 落点 | 状态 |
|---|----------|------|------|
| R1 | 小地图一直请求 → 请求速率 | 去掉 `fieldGrid` HTTP 轮询，模块内零 HTTP | 已明确 |
| R2 | 融合 `灵脉预览.html` 改成这个 | 搬其**渲染/交互**层（底图色板、五行灵脉、角色标记、拖拽/缩放/tooltip），**不搬**它的"浏览器内联 mapgen 自生成"（改为 §3 的 WS 下发真源） | 已明确 |
| R3 | 可最大化 / 独立一个文件 / 热拔插 | 独立模块 + 独立浮层节点；壳层只留挂载点 | 已明确 |
| R4 | 传入 seed，**地形在前端计算** | `MapGen.init(seed)` + 逐格 `MapGen.fields(q,r)` 抽样成位图 | 已明确（本轮拍板） |
| R5 | **除地形外都走 WS（世界是动态的）** | 灵脉/聚落/道路/区域/POI 等全部取自主客户端 WS 实体快照；前端**不**自行 `settlementsFor/roadsNear` | 已明确（本轮拍板） |
| R6 | 「未探测」纹理 | 尚未抽样/未计算的格 → 专用未探测纹理（斜纹等），与海/地形色可区分 | 已明确 |
| R7 | 可独立平移，打开后可以拖动 | 默认档跟随视野；打开为全屏窗后**可拖动平移 + 滚轮缩放** | 已明确 |
| R8 | 小地图在左下角，默认跟随视野 | `#minimapBox` 移到左下角；默认档中心=主相机 | 已明确 |
| R9 | 可以隐藏整个小地图，相关组件不工作 | 隐藏 = 模块停摆（停 rAF/停抽样/停绘制/不占 WS 帧），不是只 `display:none` | 已明确 |
| R10 | D5 的删掉 | `mapclient.js:315 fieldGrid` 退役删除 | 已明确 |

---

## 2. 已拍板决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | 地形数据源 | **前端按 seed 算**（`MapGen.fields`），不走后端 |
| D2 | 其余内容数据源 | **全走 WS**（灵脉/聚落/道路/区域/POI），前端不自算 |
| D3 | 引擎 js 引入方式 | **WS 下发 js 文件 → 前端执行**（不新增静态挂载、不拷副本、不内联） |
| D4 | 小地图位置 | **屏幕左下角** |
| D5 | 默认档行为 | **跟随视野**（不可拖） |
| D6 | 打开后行为 | **全屏窗口**，可拖动平移、可放大缩小 |
| D7 | 隐藏 | 可隐藏整个小地图，隐藏期间组件不工作 |
| D8 | `fieldGrid` | **删**（用户口径） |
| D9 | 模块形态 | 独立文件 `web/js/minimap-vein.js`（IIFE + 全局注册，仿 `bldg_ink.js`），壳层只留挂载点与快照注入 ⇒ 可热拔插替换 |
| D10 | 「农商」解读 | 用户澄清：**农=农田/聚落、商=商路/贸易**属"世界动态内容" ⇒ 一律 WS（前端只算地形，不再自算农商） |

---

## 3. 架构（三层 + 引擎脚本 WS 下发）

```
MiniMapVein(挂载点)  ← 热拔插壳, 只依赖 4 个注入: snapshot / cam / jump / seed
├─ L1 地形层   前端算: MapGen.init(seed) → 逐格 MapGen.fields(q,r).biome 抽样 → 位图
│              未算到的抽样点 = 「未探测」纹理        ← 用户 R4/R6
├─ L2 世界层   全 WS : comm.veins(五行/异灵根/等级) / settle / roads / region / poi
│              只读主客户端已到的实体快照, 零请求   ← 用户 R5
└─ L3 视野层   默认档: 中心=主相机(不可拖) + 视野框; 全屏档: 独立相机(pan/zoom) + 视口联动
```

### 3.1 引擎脚本 WS 下发（D3 落地）

| 步骤 | 落点 | 动作 |
|------|------|------|
| 1 | `Domain/MapMessages.cs:206 WsFrame` | 新增 C→S `ScriptRequest = 4`、S→C `ScriptPack = 4`（Pong 现在也占 3，故取 4） |
| 2 | 新消息类 | `ScriptRequest { string Name }`（空 = 要整包）、`ScriptPack { string Name; byte[] Source; bool Gzip }`（protobuf-net 沿用现有 codec） |
| 3 | `MapWsHandler.cs:47 switch` | 加 `case WsFrame.ScriptRequest` → 从 `ZongmenPaths.ResolveEngineJsDir` 读 `noise.js / mapgen-config.js / mapgen.js`（**按此序拼接**，`mapgen-server.js` 不下发）→ gzip 后单帧回 `ScriptPack` |
| 4 | `mapclient.js:182 onFrame` | 加 type=4 分支：解包 → 拼字符串 → **间接 eval** `(0, eval)(src)`（等价 `<script>`，全局作用域）；浏览器**不需要** `var window=globalThis` 垫片，但**保留 `'use strict'` 前缀**与服务端一致 |
| 5 | 调用侧 | 模块 `init` 时 `MC.requestScript()` → `MapGen.init(worldSeed)`；脚本未到 → 全图未探测纹理 + console.warn，模块其余功能照常（优雅降级） |
| 6 | 缓存（可选） | 按内容 hash 存 sessionStorage，刷新免重传；⚠ 失效键必须取内容哈希，不能取时间 |

**为什么这样最稳**：单真源。绝不把 `mapgen.js` 拷进 `web/js/`（历史坑：副本漂移 ⇒ 前端世界 ≠ 服务端世界）；`灵脉预览.html` 当年就是内联副本，所以页面注释里写着"改引擎后请同步替换此段"。

### 3.2 L1 地形层的成本控制

> ⚠ 本节口径已被 §9 修正：初版「按小地图像素取格」= 抽样格**视图锁定**，平移/缩放会把缓存
> 全部作废（实测复用率 36%~11%），且默认全屏档漏格 63%。现改为**世界格对齐抽样**。

- 抽样集合 = 世界格 `{ q % m == 0 && r % m == 0 }`（与视图无关），`m = 2^k` 由「一个抽样格 ≈
  一个显示块」定（`levelFor`）；缓存键是 `q,r`，**平移/缩放/换层级都复用**。
- 每帧**时间预算**抽样（`clamp(dtMs*0.35, 10, 110)ms`，按帧间隔自适应），列表按「离视野中心
  由近及远」排序 ⇒ 视野中心先清晰；未算到的画「未探测」斜纹（配合层级回退 + 粗层引导，
  实际不再出现成片未探测）。
- 只读 `fields().biome / .e`：**不读 `onRoad`**（道路语义依赖 `roadCache` 冷热，`mapgen.js:222-224` 明写），道路一律 L2 走 WS。
- 底图色板口径：`biome 0..7` 用 `MapGen.BIOME_META[i].color`（与 `灵脉预览.html:4401/4688` 一致）；**灵脉染色不画进底图**（灵脉由 L2 画，避免双份）——见 Open Q3。
- `MapGen.init(seed)` 会清空引擎缓存（`mapgen.js:266-270`）⇒ 每换一次世界只调一次，模块内自己做"seed 变了"的判定。

---

## 4. 交互规格

| 态 | 行为 |
|----|------|
| 默认（左下角小图） | 中心跟随主相机；**不可拖**；显示视野红框；单击 = 见 Open Q1 |
| 全屏窗（点击打开） | 占满视口浮层；**拖动平移**（独立相机，可离开主视野 —— 因地形前端可算，不再受"只缓存视野内区块"限制）；**滚轮缩放**放大缩小；关闭按钮 / ESC 退出；退出后回跟随态（默认记忆见 Open Q5） |
| 隐藏 | 模块停止一切工作；隐藏入口见 Open Q4 |
| tooltip | 灵脉名/等级/五行、聚落名、区域名（口径同 `灵脉预览.html:5002-5127` 的悬停层） |

⚠ 浮层必须与 `#minimapBox` **同级兄弟**：`.panel` 的 `clip-path` 会裁整棵子树（备忘录既有坑）。

---

## 5. 批次

| # | 任务 | 处置 | 落点 |
|---|------|------|------|
| T1 | 本文档定稿（需求/接口/交互） | 新增 | 待办事项/ |
| T2 | 后端 WS 下发引擎 js（WsFrame + 消息类 + handler + ResolveEngineJsDir 读取 + gzip） | 新增 | MapMessages.cs / MapWsHandler.cs |
| T3 | 前端 client：`requestScript` + onFrame type=4 + 间接 eval +（可选）缓存 | 新增 | mapclient.js |
| T4 | 新模块骨架 `MiniMapVein`（init/setMaximized/hide/destroy + 挂载点 + dpr 对齐 + 脏位重绘） | 新增 | web/js/minimap-vein.js |
| T5 | 壳层暴露只读快照接口（chunk 遍历取 biome/comm.veins/settle/roads + cam + worldSeed + jump 回调） | 新增（最小侵入） | main.js |
| T6 | index.html：左下角挂载点 + 全屏浮层节点（同级兄弟）+ script 引入（main.js 前）+ CSS + `#info` 让位 | 修改 | index.html |
| T7 | L1 地形层：抽样缓存 / 每帧预算 / 未探测纹理 / seed 变更重置 | 新增 | minimap-vein.js |
| T8 | L2 世界层：灵脉（五行色+等级+异灵根）、聚落、道路、区域名、POI —— 全部读 WS 快照 | 新增 | minimap-vein.js |
| T9 | L3 交互：跟随视野 / 全屏拖动缩放 / 隐藏停摆 / tooltip / 关闭 | 新增 | minimap-vein.js |
| T10 | 删旧小地图：`main.js:585-698` + `105-108` + `344/1681-1682` + `2172-2190` + `2051 监听` + `2205 els.minimap`；`mapclient.js:315 fieldGrid` 删 | 删除（T7~T9 验收后） | main.js / mapclient.js |
| T11 | 验证：① Network 无 `/api/map/fields`（且无新增 HTTP）② 实机 `live_cap` 三态截图（左下默认/全屏/隐藏）③ 拖动缩放不卡、未探测纹理正确 ④ 隐藏后 CPU 归零（无 rAF 空转）⑤ 离线回归 10/10（`check_vein_skin` 34 项）+ 服务端 6/6 | 必做 | verify/ |

**顺序**：T2→T3→T4→T5→T6→T7→T8→T9（新模块独立跑通）→T10（删旧）→T11。
**回滚**：T10 之前新旧不共存（挂载点直接替换），回滚 = `git restore web/ Server/`。

---

## 6. 待你拍板（Open Q）

| # | 问题 | 我的建议 |
|---|------|----------|
| Q1 | 现「单击小地图 = 主相机跳转」，新「单击 = 打开全屏」互斥 | 默认档单击=打开全屏；**全屏内**单击=主相机跳转（并退出全屏）；或保留单击跳转、双击进全屏 |
| Q2 | 左下角已被「山川志」面板占（`index.html:175-177`） | 左列堆叠：山川志上移（bottom = 小地图高度 + 间距），小地图贴左下角 |
| Q3 | 地形底图要不要含灵脉染色（`disp 8..12`） | **不含**（灵脉由 WS 层画，避免双份且能带等级/异灵根信息） |
| Q4 | 隐藏入口放哪 | 小地图标题栏右上角「×/眼」小按钮；隐藏后屏幕角落留一个极小的「显示小地图」恢复钮（否则无法唤回） |
| Q5 | 全屏退出后回哪种态 | 回到跟随视野（默认档）；全屏期间的平移中心不记忆 |
| Q6 | 全屏档缩放范围与采样精度 | 缩放 1×~8×，采样粒度随缩放自适应（放大到 4× 以上时逐格精确） |

---

## 7. 风险清单

- **R1** 引擎脚本经 WS 下发 = 服务端代码在前端执行；同源可信，但要防「脚本未到就调 `MapGen`」⇒ 必须判 `typeof MapGen !== 'undefined'` 并降级（模块首帧不能抛）。
- **R2** 世界动态性：地形是 seed 静态量（可前端算），**灵脉/聚落/道路会随世界变化** ⇒ 一律 WS；绝不能用前端 `settlementsFor` 代替（会与服务端不一致）。
- **R3** 全屏档大范围抽样成本：必须每帧预算 + 缓存 + 未探测占位，否则一次全屏重绘会卡死（`灵脉预览.html` 也是靠 `scheduleTerrainPrefetch` 空闲预取解决）。
- **R4** `MapGen.init()` 清缓存 + `roadCache` 冷热敏感 ⇒ 地形层只读 `biome/e`，道路不碰。
- **R5** 浮层被 `.panel` 的 clip-path 裁掉 ⇒ 浮层与面板同级。
- **R6** 隐藏必须真停摆（停 rAF/停抽样/停解帧），否则只是"看不见但还在烧"。
- **R7** 改完 grep 复核（并行 Edit 只落第一条的前科）。

---

## 8. 实施结果（2026-09-15 18:30 · T2~T11 全部落地）

### 8.1 落点

| # | 文件 | 动作 |
|---|------|------|
| T2 | `Server/Zongmen/Domain/MapMessages.cs` | 新增 `WsFrame.Script = 4` + `ScriptRequest{Name}` + `ScriptPack{Name, Source}` |
| T2 | `Server/Zongmen/Web/MapWsHandler.cs` | `EngineScriptOrder=[noise.js, mapgen-config.js, mapgen.js]`；`Map(...)` 加 `engineJsDir` 形参；`case WsFrame.Script → HandleScriptAsync`（白名单文件名防目录穿越 + 按序拼接 + gzip 进 `Source`；缺文件回空 `name="missing"`） |
| T2 | `Server/Zongmen/Program.cs` | `MapWsHandler.Map(..., ZongmenPaths.ResolveEngineJsDir(options, contentRoot))` |
| T3 | `web/js/pb.js` | `FRAME.SCRIPT=4` + `encodeScriptRequest` / `decodeScriptPack` |
| T3 | `web/js/mapclient.js` | `requestScript()`（超时 15s）+ onFrame `type===4` 分支 + `onclose → failScript`；**删** `fieldGrid`/`base64ToBytes`（D5 退役） |
| T4/T7/T8/T9 | `web/js/minimap-vein.js`（**新**，678 行 IIFE） | 三层 + 三态 + 引擎自取 + 抽样预算 |
| T5 | `web/js/main.js` | `mmSnapshot()` 只读快照（含 `comms/settles/roads` 全取 WS 层）/ `mmJump` / `initMinimap()`；删旧小地图 115 行 + 旧状态 + 旧 loop 分支 |
| T6 | `web/index.html` | `#minimapBox` 移左下（`left:16;bottom:18`）+ `.mm-head` + `#mmRestore` + `#mmTip`(z70) + `#mmFull`(z60，与面板**同级兄弟**)；`#info` 让位 `bottom:230px`；`<script src="js/minimap-vein.js">` 挂 `bldg_ink.js` 后 |
| T11 | `verify/frontend_smoke.mjs` | `fetchFields` 删除；`checkMinimap` 重写为「源码守卫 + 前端自算地形复算」 |

### 8.2 关键实现口径

- **引擎注入**：`(0, eval)("'use strict';\n" + src)` 注入全局 → `window.MapGen`；`finally` 还原 `window.NoiseLib`（引擎 noise.js 会覆盖它，但引擎内部已捕获自身引用 ⇒ 还原无副作用）。
- ⚠ **ScriptPack 帧本身不 gzip，只有 `Source` 字段 gzip**（第一版把它当整帧 gzip 解 ⇒ `Z_DATA_ERROR`）。
- ⚠ **地形层只读 `MapGen.fields().biome/.e`，绝不读 `onRoad`**（道路语义依赖引擎 `roadCache` 冷热）；道路/灵脉/聚落/区域名一律取 WS 快照。
- ⚠ **热拔插单点**：`main.js` 是 `(function () {` **没有 `g` 形参** ⇒ 必须写 `window.MiniMapVein`（写 `g.MiniMapVein` 会 `g is not defined` 整页 fatal，已踩）。
- 防卡：每帧额度 `clamp(dtMs*0.35, 10, 110)ms` 抽样 + 缓存 + 「未探测」斜纹占位；隐藏 = `tick()` 直接 return（真停摆）。

### 8.3 验收

| 项 | 结果 |
|----|------|
| 速率根因 | 前端**零 HTTP**：`mapclient` 无 `/api/map/fields`、无 `fieldGrid`；小地图数据全走已建立的 WS |
| 端到端 | 登录 → `ScriptRequest` → `ScriptPack`（95KB js，gzip 26ms）→ eval → `MapGen.fields` 抽样 **6/6 与服务端 `/api/map/tile` 地形一致** |
| 性能 | `MapGen.fields` 单格 0.006~0.031ms（热/冷缓存）⇒ 前端自算可行，按帧预算抽样防卡 |
| 实机三态 | `verify/live_r11_mm_*.png`（默认左下 / 全屏 / 隐藏）+ 裁剪 `_r11_*_crop.png` |
| 回归 | `frontend_smoke` **36/36 全绿**（含新小地图契约 12 项）；离线+服务端全量见 daily log |

### 8.4 环境事实更正

- 旧记录「服务只绑 LAN IP `192.168.63.62:8140`，127.0.0.1 不通」**已被推翻**：本轮 `127.0.0.1:8140/api/map/meta` 实测 200，且完整回归（`frontend_smoke`/`verify_map`/`w1`/`w2`/`w4` 默认 BASE 就是 127.0.0.1）全绿 ⇒ 两者皆通。早先的 `ECONNREFUSED` 应是**当时服务端未在跑**，不是绑定问题。

---

## 9. 修复：大地图采样「大面积未探测」（2026-09-15 · 用户截图报障）

### 9.1 现象

全屏档：只有中心一块矩形是实心地形（= 默认档跟随相机时已算过的窗口），其余是
**约 30% 散点 + 46.5% 未探测斜纹**，且越靠下越空。

### 9.2 取证（全部实测，不是推断）

| 证据 | 手段 | 结果 |
|------|------|------|
| 暗色确实是「未探测」而非地貌色 | 取 `/api/map/meta` 色板比对 + 自写 PNG 解码器量色（zlib 手解） | `(40,36,32)/(58,52,44)` 不在 13 个群系色里（深海=`#6d9aab`），且 base:hatch **恰好 3.005:1** = 代码里的 `(px+py)&3` 斜纹 |
| 覆盖率随行号递减 | PNG 覆盖率网格 24×16 | 实心区只在 x=296..1242；外部 ~30% 散点，**最底两行 ≈ 0%** |
| 引擎侧无问题 | Node 扫 `MapGen.fields` ±220 格 | **零 null、零异常**；`spiritEdgeWorld()=8000` |
| 引擎侧不慢 | Node 冷缓存全屏量 | 21060 格 / 405ms = **0.019ms/格** |
| **抽样格视图锁定** | 复刻 `buildTerrain` 抽样格，比较两视图的格集合 | 平移 5 世界单位（不足半格）复用 **55.1%**；平移一格 **36.4%**；缩放 ×1.14 **30.7%**；面板档→全屏档 **11.5%** |
| 采样数远不够 | 同上 | 默认全屏档视图内真实 **58363 格** vs 21850 样本 = **漏格 63%**；wpp=12 时 **漏格 96.8%** |
| 浏览器侧同源 | `?mmprobe=1` 自回传「探针时间序列」（CDP 对本页会挂起） | 静止打开全屏档能收敛（`miss→0`，约 2s），但每次拖动/缩放后重建 |

### 9.3 根因

`buildTerrain` 的抽样点是**画布像素格投影进世界**得到的 ⇒ 抽样格与视图绑定：

1. 视图一动，采样点几乎全部落到**新格**上 ⇒ 缓存命中率 11%~55%，每次交互都从「未探测」重来；
2. 拖动时 FIFO 按行扫描 + 逐帧重建列表，底部行永远排不上队 ⇒ 截图里「上面稀疏点阵 + 底部全空」；
3. 样本数封顶 24000，与「视图内真实格数」无关 ⇒ 就算收敛也是残图（默认档漏 63%）；
4. `QUEUE_CAP=40000` 满即**静默丢弃**，把「待算」永久变成「未探测」。

### 9.4 改法（只动 `web/js/minimap-vein.js` —— 热拔插单文件，别处零改动）

| # | 改动 | 说明 |
|---|------|------|
| F1 | 抽样格改**世界对齐** `q%m==0 && r%m==0`；缓存键 = 世界格 `q,r` | `m=2^k` 只决定「选哪些格去算 / 显示读哪一格」，**不进键** ⇒ 跨视图、跨层级复用同一张表 |
| F2 | `levelFor()`：`m ≈ 显示块像素 step × wpp / hexW` | 抽样分辨率与显示分辨率对齐（比显示更细是白算，更粗则见块状损失）；只取 2 的幂 ⇒ 缩放跨阈值才换层 |
| F3 | 待采样列表按**离视野中心由近及远**排序（`enumLevel`） | 视野中心先清晰；重建只在「层级/视野签名」变化时发生；拖动中仅当列表排空才重建（保证抽样器永远有活干，又不在每帧重排两万格） |
| F4 | **粗层引导**：重建时先按 `m*8, m*4, m*2` 各铺一遍，再铺 `m` | 首帧就有粗略地脉；配合 `biomeAt` 的层级回退链 ⇒ 实际不再出现成片未探测 |
| F5 | 游标 `pendingIdx` 取代 `Array.shift()`；`PENDING_CAP` 提到 400000 | 免 O(n) 搬移；免静默丢弃 |
| F6 | 缓存超限改为**按插入序淘汰最旧 1/4**（原为整表清空） | 整表清空会重新露底 |
| F7 | 调试入口：`?mmwpp=N`（全屏档初始缩放）、`?mmprobe=1`（探针时间序列自回传）、`?mmdrive=1`（脚本化拖动/滚轮） | headless 没法手拖，取数/截图必需 |

### 9.5 验收

| 项 | 修复前 | 修复后 |
|----|--------|--------|
| 平移 6 世界单位复用率（离线复算） | 55.1% | **99.4%** |
| 缩放 5% 复用率 | 32.2% | **100.0%** |
| 视图内空洞（3384 探针点） | 未断言（实际漏 63%） | **0** |
| 实机 `probe().miss`（含拖动/缩放后全过程） | 5481（t=1.5s） | **恒为 0** |
| 实机截图未探测像素占比 | **46.5%** | **0%**（默认全屏档 + `mmwpp=12` 远缩档） |
| 实机平移新增格 | 整屏重算（约 2 万） | **1784**（仅新露出的边缘） |
| 实机缩放出新层 | 整屏重算 | **7885**（m=4 层，1s 内补齐） |
| `frontend_smoke` 小地图契约 | 36/36 | **41/41**（新增世界对齐 / 全覆盖 / 平移复用 / 缩放复用 4 项） |

截图：`verify/live_r12_mm_panel.png` / `live_r12_mm_full.png` / `live_r12_mm_zoom12.png`。

### 9.6 遗留（未做，待拍板）

- **粗层点采样的椒盐感**：`m>=4` 时一个格只取 1 个格点的群系，混合地貌区会有细碎噪点。
  正确做法是金字塔**多数表决聚合**（`cell(m)` = 4 个 `cell(m/2)` 取众数），但需记录子格可用性，
  复杂度不低；当前观感可接受（放大到 wpp=12 仍读得出湖/林/雪的分布）。
- 若嫌远缩档偏碎：`SAMPLE_CELLS_MAX` 调大即可换更细的层（代价是首屏填充时间线性增长）。
