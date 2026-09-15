---
name: zongmen-verify-pipeline
description: 宗门模拟器 demo3 的构建→启动后端→三层回归验证→headless 截图→清理停服完整管线。任何涉及 Server/Zongmen (C#) 或 web/ (前端 JS) 的代码改动后，按本流程验证。
---

# 宗门模拟器 · 验证管线

> ✅ **地图生成重构已完成（2026-09-12）**：`Engine/js/mapgen*` 的「道路 A\* → 带权重 BFS」与
> 「聚落随机落点 → 勘测/选址/生长三段式 + 建筑足迹落库 + 贸易网络」已全部落地并通过回归。
> A\* 时代产物（`astar`/`Heap`/`roadCost`、`w3_astar_budget.mjs`、`bench_guard_frontier.mjs`）**已删除**，
> `guard=12000` 的说法作废；道路剪枝现为 **120 权重 / 40 步**（`ROAD_COST_MAX`/`ROAD_STEPS_MAX`）。
> 相关参数唯一真源 = `Engine/js/mapgen-config.js`（见 §11 第 1 条，**漏加载它会静默跑错口径**）。
> 已记录的事实/戒条（如「改了世界内容就要清 `db/zongmen.sqlite`」）继续复用。

## 1. 编译
```bash
dotnet build Server/Zongmen/Zongmen.csproj -v q
```
- 必须指到 `.csproj`（给目录会报 MSB1009）。

## 2. 启动后端（仓库根执行）
```bash
./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe > verify/server_run.log 2>&1   # run_in_background
```
- 端口 8140（appsettings.json "Zongmen.Port"）。
- 探活：`curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`
- **本机 curl 必须 `--noproxy "*"`**，否则环境代理报 upstream connect failed 误判服务死。
- 改过 `Server/Zongmen/Engine/js/*.js` 后必须重启后端才生效（bundle 在 VM 构造时读取）。

## 3. 三层验证
```bash
node verify/verify_map.mjs        # 944 项契约: Node 加载同份 Engine/js 作参考 + HTTP/WS 走真实 protobuf+gzip 链路
node verify/w1_client_revs.mjs    # 客户端 revs 记账: 真实服务端取帧 + 驱动真实 mapclient.js
node verify/w2_concurrency.mjs    # 新 seed 冷启 24 路并发 + liveSeeds 有界 + 配置生效
node verify/w3_bfs_road.mjs       # 道路 BFS 契约: 权重表 / 双预算上界 / 权重累加自洽 / 邻域剪枝全量 null / 下界剪枝不改路径 / 确定性(重复+跨实例) / 建路率+耗时 (离线, 不需起服务)
node verify/w4_revs_at_scale.mjs  # revs 契约 + 毒块恢复 (纯 Node 120 块, 替代跑不动的 CDP 竞态回归)
node verify/w5_sprite_range.mjs   # 立体精灵索引契约 (与图集/着色器分段一致, 离线)
node verify/frontend_smoke.mjs    # meta 常量 + HTTP meta/tile + 几何往返 ±1000 格 + DOM id/静态置脏/小地图(R12)/色板 契约
node verify/scan_poison.mjs       # 广域抓毒块 (1681 块 bad=0); 例: node ... 42 '[-20,20,-20,20]'
node --check web/js/*.js          # 前端语法
```
- **全套基线（一次跑全，2026-09-12 重测）**：`verify_map 1206 项` + `w3_bfs_road 7 项断言` +
  `w1/w2/w4/w5 + frontend_smoke` 全绿；另 `scan_poison 1681 块 bad=0`。
  （verify_map 由旧基线 944 涨到 1206，是新增 settle 层——城镇足迹/建筑/产出的三方对照断言。
  **数字变了不是回归**，比对时认「结果: 全部通过 ✔ + 退出码 0」，别拿旧数字当判据。）
- `frontend_smoke.mjs` 里有几条**静态契约检查**（改前端 UI 状态 / 色板 / 协议字段时最有用，且不依赖浏览器）：
  - **DOM id 契约**：JS 里 `$('x')`/`getElementById('x')` 引用的 id 必须在 `index.html` 定义；
  - **静态层置脏契约**：`showVeins`/`showLabels` 的运行时改写、以及每个 `classList.toggle('off')`
    开关，都必须伴随 `forceStaticDirty()`/`markStaticDirty()`（否则相机静止时点了没反应 —— N12 的真实 bug）；
  - **小地图契约（R12 起已换口径）**：旧实现每 1.5s 轮询 HTTP `/api/map/fields`（132×88 后端采样）
    直接撞请求速率上限 ⇒ **整体退役**，`mapclient.fieldGrid` 已删，前端零 HTTP。现检查 = 源码守卫
    （不得出现 `/api/map/fields`、不得残留旧符号 `mmData/mmCam/requestMinimap…`、`main.js` 只经
    `MiniMapVein` 单点注入）+ 用 `Engine/js` 复算「前端自算地形」抽样上色（0 越界 + ≥3 种地貌色）。
    历史 N11「客户端读 `mmData.q1/r1` 恒 undefined ⇒ 小地图自上线起一直是空框」的教训保留在 §9；
  - **色板契约**：五行/异灵根配色由 `metaJson` 的 `elementRGB`/`variantRGB` 单点下发，
    断言与 `Engine/js/mapgen.js` 的 `ELEMENT_RGB`/`VARIANT_RGB` 逐值相同，并守卫 `main.js`
    优先读 `geo.elementRGB`/`geo.variantRGB`。**改色板只改 `mapgen.js` 一处。**
  - **解码字段契约**：从 `pb.js` 抽出 `resp/cm/st/lr` 的产出字段集，扫描前端全部属性读取并断言命中
    —— 自动抓 N11 那一类「读了服务端从未下发的字段」。报 `main.js:resp.xxx` 时先确认服务端是否真下发，
    再决定补解码还是改白名单（白名单仅用于「客户端本地 memo 字段」，如 `cm.elementRGB`）。
- ⚠️ **改了 `Engine/js/mapgen.js` 的「地形/精灵/群系」产出后，必须清掉 `db/zongmen.sqlite`**：
  chunk 载荷里含精灵索引与格底数据，旧代码落盘的行会与新参照不符（`verify_map` 会红）。
  region/road 不受影响（region 不落库，且 chunk 不含道路）—— 这是当初 A* guard 改动「无需清库」的原因。
  清理方式：停服 → 把 `db/zongmen.sqlite*` 移到仓库外（可复原）→ 重启，服务会按需重建。
- **CDP 类脚本在本机跑不动**（`cdp_pan_race.mjs` / `cdp_probe.mjs` / `cdp_screenshot.mjs` 的长驻 spawn 会被 SIGTERM）：
  别在它们身上耗时间。毒块/竞态链路的回归已由 **w4_revs_at_scale.mjs**（纯 Node，阶段3 断言「丢弃 revs 后必然全量重发且逐字节一致」）替代。
- **大范围回归（不复制代码，直接复用 verify_map）**：
  `node verify/verify_map.mjs http://127.0.0.1:8140 '["42"]' '[[-16,3],[50,-51],...]'`
  seeds/blocks/tiles 三个参数可覆盖（默认仍是 2 seed × 6 块）。实测 100 块 ±80 = 6259 项 10.9s；
  换全新 seed 跑 60 块 ±70 强制冷生成 = 3921 项 3.5s —— 用来校验「大坐标 qrel/rrel 偏移 + 五图层编码」，
  比默认 6 块强得多，改坐标/编码相关代码后建议跑一轮。
- **验前先确认服务已起**（除 w3 是纯离线）。
- **源码覆盖（已完成，勿重复扫）**：C# 13 源文件 + 前端 5 JS（`main`/`renderer`/`textures`/`mapclient`/`pb`）
  + 引擎 3 JS（`noise`/`mapgen`/`mapgen-server`）+ `noiselib.js` + `web/server.js` + `index.html` 均逐文件复核过。
  两个易被误判为问题的文件：`web/js/noiselib.js` 是**有意复制**的贴图专用噪声（与 `Engine/js/noise.js`
  位级一致，纯视觉、不需同步，非隐患）；`web/server.js` 是已标注的「旧版预览备用」静态服务（8137），无害。
- 全绿标准：`结果: 全部通过 ✔`，退出码 0。
- 改 `web/js/mapclient.js`（revs/连接状态机）务必跑 `w1_client_revs.mjs` —— `verify_map.mjs` 只覆盖服务端契约，**覆盖不到客户端记账**。
- ⚠ **`w3_bfs_road.mjs` ⑦ 的两条「墙钟阈值」是机器绝对速度门槛，跨机必红，别当回归**：第 3 慢单 region < 400ms / 最慢 < 500ms。实测接手机 i7-6700HQ（2.6GHz 移动四核 / 15.8G / Win10 1903）第 3 慢 **550ms** / 最慢 **936ms** ⇒ 2 项失败，而**功能类 8 项 + 建路率 95.6% 全过**。换机器复验时先看「功能断言是否全过」，再按本机基线解释 ⑦；要让它真能跨机，应改成「先跑一段固定 CPU 基准，再按倍率缩放阈值」的相对校准。
- 改缓存/并发（`blockLayersJson`/`roadVer`/`BuildOnce`/VM 池）跑 `w2_concurrency.mjs`。
- 改 `Engine/js/mapgen.js`（尤其 road/城镇/贸易）必须跑 `w3_bfs_road.mjs` + `check_preview_settle_road.mjs`。
- 大范围排查空白块/毒块用 `scan_poison.mjs`（注意耗时：1681 块 ≈ 65s）。
  ⚠️ **它的 BASE 默认写死 8140**；对着非 8140 的实例跑必须显式传 baseUrl，否则每块都 timeout
  并打印 `BAD ... timeout(可能解码失败)` —— 那是「连错端口」的假 BAD，不是毒块（本次踩过）。
- `w1` 依赖 Node 原生 `WebSocket`/`DecompressionStream`/`CompressionStream`/`Blob`（Node ≥ 22 自带），无需浏览器。
- **在 Node 里 eval `mapclient.js` 必须提供 `global.location`**（模块级读 `location.protocol/host` 拼 WS_URL），否则 `ReferenceError: location is not defined` —— 这是 `frontend_smoke.mjs` 曾长期失效的原因。

## 4. 专项 sanity（改缓存/并发相关时）
- 字节一致性：同 URL 请求两次比 md5（`_regionHot`/tile 缓存命中路径）。
- 并发：优先 `node verify/w2_concurrency.mjs`（24 路 + 同块字节一致 + liveSeeds 有界）。
- 落库行为：全新 seed 请求后查库
  `"C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" -c "import sqlite3; c=sqlite3.connect('file:db/zongmen.sqlite?mode=ro', uri=True); ..."`
  （只读模式 `?mode=ro`）。当前语义：region 不落库（T2），chunk/comm 落库。
- **清理任务（P3）观察法**：造几个新 seed 触发 LRU 淘汰 → 每 15s 轮询 `/api/stats` 的 `dbRows`；
  正常应在 2min 维护周期处**掉一次**（如 10872 → 20）后保持稳定。若一直不降 =
  `_seenSeedPrefixes` 未在 `World()` 处登记（见 W2 修复），或 `stale` 判定失效。
- **配置生效**：`/api/map/stats` 带 `maxSeeds` 字段，应等于 `appsettings.json` 的 `Zongmen:MaxSeeds`。
  若等于代码默认值（`Options.cs` 的 4）而配置写的是别的 → ContentRoot 没指到 exe 目录（见 §8）。

## 5. headless 渲染回归（本机环境不稳定，务必用 shot.mjs）
```bash
node verify/shot.mjs "http://127.0.0.1:8140/index.html?seed=42&nofade=1&qt=-51&rt=133&zm=1.1" verify/shot.png
```
- **不要直接裸跑 `chrome --screenshot` 结论**：本机 headless 视觉验证会被两种环境抖动欺骗 ——
  ① **虚拟时钟跑在真实网络之前**：`--virtual-time-budget` 太小会在 WS 块数据到达前就截图 → 整幅只剩纸色底；
     实测同一 URL budget=60000 空白 / 120000 成功（同一参数还会漂移）。
  ② **WebGL command buffer 间歇失败**：stderr 可见 `command_buffer_proxy_impl.cc GPU state invalid`。
- `verify/shot.mjs` 会**解码 PNG 判定是否真渲染**（空白图 mean RGB≈(237,227,205)、颜色种类 <300；
  真渲染 mean≈(130~190)、颜色上千），空白就换 profile 并按 60000→100000→140000 递增预算重试；
  退出码 1 = 重试耗尽（判定环境问题，非页面 bug）。
  - 它还会单独识别**「中途帧」**（`mean < 70` = 背景大片未加载的偏黑画面）并同样重试 ——
    仅靠「颜色数 <300」会把中途帧误判为渲染成功（实测曾漏过一帧 `mean=34 / 646 色`）。
- ⚠️ **headless 验不了「按时间门控」的 UI**（N11 排查中的关键教训）：虚拟时钟下 rAF 帧数极少，
  实测 `frameCount = 5`（当时读出的 `minimapTimer` 变量已随 R12 删除旧小地图一并消失，仅作历史证据）—— 任何「累积 0.4s 才刷新」的逻辑（如小地图门控）
  **永远到不了**，于是截图里那部分恒空。**这是 headless 伪影，不是线上 bug**（真实浏览器 60fps 下约 0.4s 即出现）。
  遇到这类「截图里某块恒空/恒不变」时，**先怀疑帧饥饿，不要直接当代码 bug 改**。三条可靠验法（按可靠性排序）：
  1. **纯 Node 复现同一算法**（首选）：见 `frontend_smoke.mjs` 的「小地图契约」段 —— 加载 `Engine/js`
     原算法逐格 `MapGen.fields()` 抽样上色，断言「0 越界 + ≥3 种地貌色」（R12 后数据源由「HTTP 字段网格」
     换成「前端自算」，断言意图不变）；
  2. **真实浏览器 A/B**：临时把时间门控改成首帧触发，截图对比修复前/后（本次即用此法确证：
     bug 版框内是整片兜底色 `#b9ad92`，修复版是真实地形缩略图），**验完立即还原**；
  3. **临时在 canvas 上绘制诊断文字**再截图读取（本次用它读出 `frameCount=5`，一锤定音）。
- ⚠️ **`--dump-dom` 不要用来读循环状态**：该模式下 **rAF 不触发**，只会 dump 到 boot 初始态
  （`#stats` 恒为 `-`、`#era`/`#seedShow` 有值），会误导判断。
- 定点视野 URL 参数：`qt`=格q `rt`=格r `zm`=缩放 `nofade=1`（避免虚拟时钟导致渐入发白）。
- Chrome 路径：`$HOME/AppData/Local/Google/Chrome/Application/chrome.exe`（**不在 Program Files**）。
  必须给独立 `--user-data-dir`；不要加 `--disable-gpu`。
- **`--screenshot=` 的路径要先 `path.resolve()` 成绝对路径**：Chrome 对相对路径的解析基准与本进程不一致，
  用相对路径会「exit=0 但没落盘」。
- **CDP 方案（`verify/cdp_screenshot.mjs`）在本机会被 SIGTERM**（长驻 spawn），只能作为兜底尝试。
- ⚠ **CDP 的「取数」通道对本页会永久挂起**（`Runtime.evaluate` 与 `Page.captureScreenshot` 均复现，连 `verify/cdp_feat.mjs` 也挂 >100s）⇒ 别在 CDP 上耗时间。可靠替代 = **探针页 + 像素差分**：页面内注入脚本驱动点击/平移，事实用 `window.__probe()` 暴露的**整数/坐标**读出，面积/位移类量用 `live_cap.mjs` 截两态图做逐像素差分 + 连通域统计。
- ⚠ **量「已渲染的目标」别把期望屏幕坐标硬编码进探针**：实测偏 >60px 全废（相机取整 + 视差 + 精灵底边偏移三者叠加）。正解 = **从新旧两态差分自证位置**（有标记态 vs 无标记态逐像素差分 → 连通域质心），或直接读 `__probe()` 里已暴露的事实字段。
- `?capture=1` 页内合成路径已修复（见 §9 的 frameCount 门槛）：产出 `verify/capture.png`，可作交叉验证，
  但色彩偏白（drawImage 读回色彩空间差异），**渲染判据仍以 shot.mjs 的 `--screenshot` 为准**。
- **预览页（`灵脉预览.html`）可复现视觉断言三件套**（改预览页渲染后用它做定点比对）：
  1. `node verify/preview_fixedpage.mjs <scale> <out.html> [extraJs]` —— 生成「固定种子 + 固定缩放 + 相机居中某大灵脉」的临时页
     （页面每次加载随机种子，不固定则两次截图是两套世界，无法对照）；
  2. `node verify/shot.mjs` 截图 → 3. `node verify/crop_png.mjs` 裁局部并最近邻放大做 1:1 形状/朝向检查。
  ⚠️ `shot.mjs` 输出 PNG 像素尺寸**不固定**（实测同页出现过 2229×1286 与 1484×856，等比缩放）
  → 裁图坐标必须按「PNG 宽高 × 比例」推，**不可写死像素**。
- **预览页静态契约回归**：`node verify/check_preview_vein_marker.mjs`（4 内联块语法 + DOM id + markBase 唯一真源
  + 六角形朝向 + 全缩放数值表 + 星形/圆形残留拦截），纯 Node、不需起服务，改预览页后必跑。

## 6. 停服与确认
```bash
# 停: 按进程名 (比按端口稳)
Get-Process -Name Zongmen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
# 确认: netstat + tasklist 双确认, 勿用 Get-NetTCPConnection (本机输出不稳定, 监听存在时也可能返回空)
netstat -ano | grep ":8140" | grep LISTEN || echo "无监听"
tasklist | grep -i zongmen || echo "无进程"
```
- 用户惯例：服务由用户手动启动，验证完必须停干净。
- run_in_background 起的进程被外部终止时日志特征=戛然而止无异常。

## 7. 提交惯例
- 本仓库每轮审核修复单独提交，中文标题 + 逐条 bullet（编号 + 一句话说明 + 验证结论），review 文档状态回填随代码同 commit（参考 B1~B3/P1~P8、R1~R13、T0~T15、W1~W2 四轮）。
- ✅ **推送状态**：全部已推送，远端 `main` = 本地 HEAD（2026-09-12 核对为 `40cfb9a`）。**每次提交后立即 push，别攒**（旧的「先攒着」要求已作废）。push 挂起/报错按 §10 先区分两种病因。
- `.gitignore` 现行口径（2026-09-12 更新）：`待办事项/` 仍整体忽略；**`.workbuddy/memory/` 与 `.workbuddy/skills/` 已开白名单入库**（父目录被排除时须「目录级 + 内容级」两条 `!` 反转，仅靠 `!子文件` 无效），其余 `.workbuddy/` 内容仍忽略；verify 下的 `.png/.log/.txt/.html` 忽略，只提交 `.mjs` 脚本。

## 8. 配置坑（W2 修复）
- `WebApplication.CreateBuilder(args)` 以**当前工作目录**为 ContentRoot，且 appsettings.json 在
  CreateBuilder 期间加载 → 从仓库根跑 `./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe` 时
  **整份 appsettings.json 被静默忽略**，Port/MaxSeeds/PersistEnabled 全回落 `Options.cs` 默认值。
  已改为 `WebApplication.CreateBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory })`。
- 资源定位（web/引擎脚本/db）不受影响：`ZongmenPaths.FindRoot` 会自 ContentRoot 向上找 `web/index.html`。
- 判据：启动日志新增 `配置根: <path>  (MaxSeeds=n)`；或查 `/api/map/stats` 的 `maxSeeds`。

## 9. 排查教训（W1 / 调试钩子）
- **`r.p + r.vi()` 是长度前缀重复计数陷阱**：JS 先取 `r.p`（推进前）再调 `r.vi()`（推进后），
  算出的终点比真实末尾少 1 字节。`pb.js` 里所有 `var eN = r.p + r.vi();` 都必须写成
  `var len = r.vi(); var eN = r.p + len;`。末尾字段 ≥2 字节时会"侥幸正确"，
  但 packed varint（每项 1 字节）会少解最后一项 —— 表面不报错、数据静默缺失。
- 前端 revs 记账铁律：**只更新 `resp.mask` 命中位**。无条件写全 5 位会让
  「非全量 mask 请求」或「未登录被拒」把没收到数据的图层记成已持有 → 永久缺层。
- **`?capture=1` 页内截图不能「数据一到就合成」**：headless 虚拟时钟下 timer 会跑到 WS 数据/RenderFrame 之前，
  此时 `drawImage(glcanvas)` 读到的是**从未渲染过的 framebuffer**（`alpha:false` → 不透明白黑）→ 全黑图。
  修法：`main.js` 用 `frameCount` 帧计数门槛 —— 记下「就绪时的帧号」，等 `frameCount` 前进后再合成
  （**不要**把合成塞进 `requestAnimationFrame`：rAF 可能被虚拟时钟饿死导致永不截图）。
- 前端渲染异常时先分辨「页面没数据」还是「GL 没画出来」：GL canvas 无 chunk 时 `render()` 会清成**纸色**，
  所以整幅纸色 = 数据层为空；而黑区/黑块才是渲染问题。
- **横向编码/映射类 bug 的查法（N9 森林精灵溢出的经验）**：不要只读代码猜，先用真实引擎**统计输出直方图**
  （如 `MG.buildChunk()` 的 `propSprites`），发现异常值后**再区分来源分支**（本案 48 的 389 次 = 沙漠合法 381 + 森林溢出 8，相加吻合即确证）。
  精灵/图集类索引契约：`sprite = row*8 + col`，索引必须落在图集**已绘制**格内（第 6 行只画 7 个，**55 是空的**，落到那里静默不可见）。
- **「客户端读了一个服务端从未下发的字段」是最隐蔽的一类 bug（N11 小地图）**：`refreshMinimap` 用
  `mmData.q1/r1` 做越界判断，而 `/api/map/fields` 只返回 `{q0,r0,nq,nr,d}` → 恒 `undefined` →
  `t.q <= undefined` 恒假 → 每个像素都判「窗口外」→ **小地图自上线起一直是兜底色空框，没人发现**。
  特征：**只出现「恒定不变的空/默认值」，不报错、不抛异常**（因为 `x <= undefined` 是合法表达式，只是恒 false）。
  查法：把「客户端读取的字段清单」与「服务端实际 JSON 键」**逐一对齐**；再在 Node 里驱动真实客户端跑一遍，
  断言输出**不是单一值**（见 `frontend_smoke.mjs` 的小地图契约段）。
- **`staticDirty` 门控的双向陷阱（N12/N12b）**：`renderStaticInto()` 由 `staticDirty` 门控，而它内部**既消费
  又驱动**一堆状态（`roadsDirty`/`regionCells`/`commCells`/`settleCells`/`poiCells`/`showVeins`/`showLabels`）。
  规则：**凡是被它消费的状态，写入方都必须同时置静态脏**。违反会表现为「改了没反应，要等平移/缩放才生效」：
  - 只置 `roadsDirty` 不置 `staticDirty` → 相机静止时道路/区域名不刷新（N12b）；
  - UI 开关只翻变量不置脏 → 点了按钮图层不变（N12，灵脉/标注）。
  改完前端 UI 状态务必跑 `frontend_smoke.mjs` 的「静态层置脏契约」段（源码级检查，不依赖浏览器）。
- **判别「渲染问题」还是「数据/逻辑问题」的通用顺序**：① 先看服务端是否返回了正确数据（Node 直连）；
  ② 再在 Node 里复现同一算法（跳过浏览器）；③ 最后才进浏览器。本次若一开始就进浏览器查，
  会被「帧饥饿 + GPU 抖动」双重噪声带偏 —— 而 Node 复现 3 分钟就锁定了 `q1/r1`。
- **★ 测量方法论（2026-09-10 的「零道路损失」误判，代价很高）**：
  1. **「大小相等」不能证明「集合相同」**。旧 `bench_roads_lost.mjs` 只比 `roadCache.size`
     → 「丢一条 + 少算一条」恰好相等，把真实丢路判成零损失。凡要断言「无损」，必须比
     **集合/逐元素**（本例：逐对比较 pair key + 路径哈希）。
  2. **测量必须喂纯函数**。经 `roadsNear` 测量会被跨区域的 `roadFail`/`roadCache` 淘汰状态
     污染 —— 实测出现「**低 guard 反而多出参照没有的路**」这种违反单调性的假象。
  3. **结果违反单调性 ⇒ 先怀疑测量方法**（A\* 成功本应单调：小 guard 能成功⇒大 guard 必成功）。
     `MapGen.astar` 因此被导出（纯函数，只依赖 seed 地形，不读任何可变缓存）供逐对隔离测量。
  4. 断言要写**能表达取舍**的形式。w3 现在锁「guard ∈ [10000, 20000] + 丢路率 ≤3% + 耗时上界」，
     而不是一个当时就不成立的「零损失」——否则测试会**在真丢路时静默通过**。

## 10. 本机 git 环境与「对象库被删」恢复（2026-09-10 事故）
- 本机 `.git` 曾被外部进程删除 `refs/` 与 `objects/pack/*.pack`（全部提交对象丢失，`git`
  报 "not a git repository" / "bad object HEAD"）。remote = `https://github.com/lin12058/ZongmenSimulator.git`。
- ⚠️ **push 失败有两种不同病因，先区分再动手**（2026-09-10 两次都撞上）：
  1. **挂起且无任何输出** → **GitHub 凭据授权弹窗没人点**（本机 push 会弹窗；实测 `timeout 300`
     静默超时 exit=124）。**让用户点一下弹窗，一次即过**（曾重试 6 次全败 → 用户点后 1 次成功）。
     此时**不要**加 `GIT_TERMINAL_PROMPT=0`（会让弹窗直接失败而非弹出），也不要盲目重试。
  2. **几秒内显式报错** `schannel: failed to receive handshake, SSL/TLS connection failed`（exit=128）
     → **真·TLS 通道问题**（连 `ls-remote` 也会被挡，属本机安全/管控代理干扰现象群）。
     **换策略重试**：`-c http.version=HTTP/1.1` / `-c http.sslBackend=openssl` / 稍后再试。
  - 口诀：**挂起无输出看弹窗；快速 schannel 报错换策略**。不可一概归因于弹窗。
  - `GIT_TERMINAL_PROMPT=0` 只适合无人值守脚本（避免挂起），手工推送时别加。
- 恢复顺序（**别急着重 init**）：
  1. 先把工作树整体 `cp -r` 到仓库外备份（代码是唯一不可再生资产）。
  2. `git ls-remote --heads origin` 确认远程可达与 `origin/main` 停在哪。
  3. `git fetch origin` 恢复远程已有对象；`git cat-file -t <sha>` 校验。
  4. 从 `.git/logs/HEAD` 取分支末端 SHA → `git update-ref refs/heads/main <sha>`。
  5. `rm .git/index && git read-tree HEAD` 重建索引（旧索引可能引用已丢对象）。
  6. 工作树改动重新提交（本地未推送的提交对象不可恢复，内容在即可重建）。
- 触发前兆：复合命令（git + chrome）被 SIGTERM、`.git/gk/` 之类非标准目录出现。

## 11. 新增协议层/图层时的必查项（2026-09-12 settle 层落地总结）

新增一层（如 `settle` 城镇足迹）会同时动 **JS 适配 / C# 白名单 / protobuf 契约 / 前端解码** 四处，
任何一处漏挂都只在**运行期**才炸，且症状会伪装成别的东西。四条铁律：

1. **Node 侧加载引擎必须带 `mapgen-config.js`**（顺序：`noise → mapgen-config → mapgen → mapgen-server`）。
   `mapgen.js` 里是 `var CFG = global.MapGenConfig || { 内置兜底 }` —— 漏加载**不报错**，只静默用陈旧兜底参数，
   于是「参照世界 ≠ 服务端世界」（区域名/灵脉名/chunk 瓦片/道路点列/城镇中心**全都不同**），
   `verify_map` 会红 292 项而**根因与被测代码无关**。
   2026-09-12 修复：`verify_map.mjs` / `scan_poison.mjs` / `w5_sprite_range.mjs` / `frontend_smoke.mjs` 四处补齐。
   **自检一行**：`for f in verify/*.mjs; do grep -q mapgen.js $f && ! grep -q mapgen-config $f && echo "缺配置 $f"; done`。
2. **`JsWorldVm.Call` 是 `switch (fn)` 白名单**（`Engine/JsEngineHost.cs`）。`mapgen-server.js` 新增导出后
   **必须补 case**，否则运行期抛 `未知 JS 函数: xxx` → 整个 `TileRequest` 中断。
   指纹症状：**`mask=ALL 0` + `revs []` + 所有图层「存在」全 FAIL**（看起来像服务端没数据，其实是异常提前返回）；
   判据：翻服务端 stdout 找 `TileRequest 处理异常`。
3. **repeated 消息字段在前端必须「每次出现即 push 一个元素」**（同 `EntityGroup.items[]` 的写法）。
   若误写成「容器套 field 1 条目」，`ResourceQuantDto` 的 field1 恰是 `string`(wire=2) 会被当成条目载荷，
   把 UTF-8 字节按子消息解 → `不支持的 wire=7` / desync。
   正确形态：`case 15: m.buildings.push(parseBuilding(r.bin(rdLen(r, t))));`（`parseBuilding` 只解**一个**元素）。
4. **WS 客户端解码异常必须 reject pending，否则伪装成超时**：`verify_map.mjs` 的 `tile()` 只在 `onmessage`
   里 resolve，`.catch` 只 `console.error` → 解码失败时 promise 永不落地 → **30s「ws 请求超时」**。
   看到超时先翻日志里有没有 `TileResponse 解码失败`，别一头扎进性能排查（本次就是解码错，30s 超时是假象）。

### 隔离验证实例（不打断用户正在看的 8140）
`appsettings.json` 的 `Zongmen.{Port,WebDir,DbPath,EngineJsDir}` 全可覆盖；`ZongmenPaths.FindRoot`
会自 ContentRoot **向上找 `web/index.html`**，所以从 `verify/_vmsrv/` 跑也能自动指到仓库根的
`web/` 与 `Server/Zongmen/Engine/js`（=最新源码）。做法：
1. `dotnet build Server/Zongmen/Zongmen.csproj -o verify/_vmsrv -p:UseAppHost=false`
   （`-o` 独立目录 + `UseAppHost=false` 可在**正式 exe 被占用时**照样验证；**先停实例再 build**，dll 会被锁）。
2. 覆写 `verify/_vmsrv/appsettings.json`：`Port` 换一个空闲口、`DbPath` 指到 `verify/` 下的独立库
   （**关键：别与用户的 `db/zongmen.sqlite` 共用**）。
3. `cd verify/_vmsrv && dotnet Zongmen.dll`（run_in_background）→ 探活 → 把 baseUrl 传给各回归脚本。
4. 验完 **只 kill 自己的 PID**，再删 `_vmsrv/` 与临时库。
> 注：build 会用项目内的 `appsettings.json` 覆盖输出目录 → **写完临时配置后不要再 build**。
> 另：`verify/ws_size_fullmap.mjs` 注释里的「8141 独立实例」是历史遗留，别当成约定端口（本次就撞上 8141 被占用）。

## 12. 两个跨机 / 打包类经验（2026-09-14 九版收尾）
- **u16 精灵通道可以「复合打包」装两个量，别为此加通道或改 protobuf**：灵脉峰的海拔通道是 u16 量化（值域 [0,1]），要同时传「灵脉等级」+「该格真实海拔 0~1」时，写入端压成 `iElev = (等级 + 海拔) / N`，shader 端 `vz = clamp(iElev,0,1)*N` → `等级 = min(floor(vz), N-1)` / `海拔 = frac(vz)`。**N 由「最高等级」定：九版 3 档（0 大/1 中/2 小）取 N=3，上界 (2+1)/3 = 1.0 恰好不溢出；十一版新增第 4 档「从属」(level=3) ⇒ N 必须同步改成 4**（上界 (3+1)/4 = 1.0）。⚠ 换量纲/加档时必须**同时**改写入端与 shader 的 N，漏改 ⇒ 等级/海拔双双错位、灵脉底座高度全乱。⚠ 副作用：大世界山仍直传海拔（走 else-if 分支），**同一通道两种语义**，必须在 shader 注释里钉死。
- **对 CRLF 文本文件做「定点替换 / 追写」脚本前先 normalize 成 LF，最后统一写回 CRLF**：本仓库的 `.md`（`.workbuddy/memory/`、`待办事项/`、skill）**全是 CRLF**，用编辑器类工具追写会混入裸 LF ⇒ 行尾不一致、`git diff` 变整文件重写（历史上踩过一次）。做法：`readFileSync(f,'utf8').replace(/\r\n/g,'\n')` → 替换/拼接 → `replace(/\n/g,'\r\n')` 写回；收尾断言「裸 LF 残留 = 0」。
- **别用 bash 双引号包 `node -e` 跑含反引号 / 反斜杠的脚本**：双引号内反引号会触发**命令替换**（实测把 `待办事项/前端表现升级-匾额山体云气.md` 的 §P 里所有 `code` 段替换成了命令输出与空串 ⇒ 文件损坏、只能回滚重写），反斜杠也被改写（`\s`→`s`、`\r\n` 变字面量 ⇒ 正则/字符串静默变形）。凡**多行**或**含特殊字符**的 JS（正则、模板串、CRLF 拼接）一律**先写临时脚本文件再 `node <file>`**（本仓惯用 `.tmp_*.js`，`.gitignore` 的 `.tmp_*` 已覆盖）；写完记得删。
- **定点替换脚本要逐条断言「恰好命中 1 次」**：`m.split(old).length - 1 !== 1` 立即抛错终止，避免规则静默命中 0 处或误命中多处（比事后 grep 复核更早暴露问题）。


## 13. 十一版（2026-09-15）新增离线回归脚本（不必起服务）

本轮把「灵脉七星占地 / 灵脉禁建 / 聚落最小间距 / 海上渔村 / 灵脉绕路」五条业务契约固化成脚本，
全部**纯 Node 离线**、直接加载 Engine/js 跑真实世界抽样，红/绿只看 `结果: 全部通过 ✔` + 退出码 0。

| 脚本 | 钉死的契约 |
| --- | --- |
| `check_vein_cluster.mjs` | `veinFootKeep` 大 **7**（中心+六邻）/ 中 **3**（本格+西南+东南）/ 小 **1**；`d>=2` 一律不保留；`CFG.VEIN_SAT_LEVEL === 3`（第 4 档从属）；真实世界逐根灵脉核对中心/从属 level 与占地格数 |
| `check_no_build_on_vein.mjs` | `landuseOf(灵脉格) === 'vein'`；`siteScore(灵脉格) === -1e18`（中心永不落灵脉）；无任何建筑落灵脉格（含从属格）；宗门足迹出现 `宗门附属`；D4 五种附属建筑仍可产出 |
| `check_settle_spacing.mjs` | `CFG.SETTLE_MIN_DIST === 7`；任两聚落中心距 ≥ 7；抑制层只减不增；连算三次结果确定 |
| `check_vein_settle_gap.mjs` | **R11 聚落↔灵脉间距**（十二版新增）：分级扣分单调；无聚落中心落 `d<=1`；无建筑落 `d<=1`；建筑 `d<=2` 占比 <2%；灵脉域聚落占比 >=10%；每 seed 聚落数 >=100。详见 §15 |
| `check_sea_village.mjs` | 存在 `type==='fishing'` 渔村；中心落 OCEAN 且近岸；建筑无深海格；建筑种类 ⊆ 渔类集合；`style==='fishing'`；名以「渔村」结尾；陆聚落不受影响；**R5b 形态**：以水上民居为主（民房/仓库 ≥40%）+ 水工为辅（≤45%）+ 无一村零民居 —— 钉死「渔村 ≠ 一片栈桥」 |

- **灵脉绕路（R9）已并入 `w3_bfs_road.mjs` §⑧**，不再是独立脚本：严格模式（`allowVein=false`）能连通 ⇒
  生产路径必须与严格路径**逐位一致且不含灵脉格**；只在无路时才许退到 `allowVein=true` 兜底穿脉；
  路网「灵脉格路段」占比 **< 5%**（实测 seed 42 = 0/13073 = 0.00%）。
  ⚠ 脚本靠 `mapSrc.replace(/return pS \|\| search\(stepsTight, true\);/, 'return pS;')` **造严格参照**，
  所以**改 `bfsRoad` 里那句兜底返回必须同步改这个替换式** —— 找不到会立刻抛 `R9: 未找到严格模式兜底语句`。
- ⚠ `check_vein_cluster.mjs` 的**已知非缺陷**：相邻两群落的次级灵脉可能落到**同一整数格**，`veinNear` 并列取先者，
  败者成为「幽灵灵脉」（重名、不占格）⇒ 表现为一个名牌挂两处。脚本按**信息行**列出（跨群落中心撞格 N 处），
  **不判失败** —— 引擎的 7/3/1 占地契约本身没有被破坏，别去「修」它。
- 离线套件现为 **14 个脚本**全绿（§13 表格 5 个 + `check_vein_skin` / `check_preview_draw` / `check_preview_settle_road` / `check_preview_terrain` / `check_preview_vein_marker` / `check_edge_falloff` / `w3_bfs_road` / `w5_sprite_range` / `w6_bldg_face`）；
  ⚠ `check_cloud_zoom.mjs` **需要实机截图参数**（`<zoom>:<on.png>:<off.png>`），裸跑只打印用法并 `rc=2` —— 别当成回归失败。

- **总 runner（2026-09-15 新增；同夜扩到 22 条）**：`verify/run_regression.mjs` —— 一条命令跑完上表全部离线判据（默认 **18 条离线 + 4 条 live = 22 条**：`frontend_smoke` / `check_mm_layout` / `check_mm_ui` / `check_calc_local`），汇总「红 N / 共 M / warn W」。
  `--offline-only` 跳过需活服务端的项；`--with-server` 追加 `verify_map/w1/w2/w4`（⚠ 先起隔离实例，见 §22）；`--base=host:port` 换基址；`--only=/--skip=` 按文件名片段过滤；`--list` 只列计划不回显。
  ⚠ 它统一清掉 `HTTP_PROXY`/`HTTPS_PROXY` 并置 `NO_PROXY=*`（本机 `HTTP_PROXY=127.0.0.1:9105` 会劫持内网请求 ⇒ 502），
  并把 `w3_bfs_road` 的 ⑦ 两条**墙钟**失败自动降级为 `warn`（机器绝对速度门槛，非回归；`--w3-ms=` 可改阈值）。
  `check_cloud_zoom.mjs` 需实机截图参数 ⇒ **不在**默认清单内，要跑请单独调。
  ⚠ **live 四条会连跑多个 Chrome**，对**隔离实例**跑（见 §22）。跑出红时**先单独复跑那一条**再下结论 —— 联跑抖动（Chrome 争用 / 实例 `MaxSeeds` 跑满）会伪装成回归，见 §22 第 0 条与 §31。
  服务端侧仍走 §3 的 `verify_map/w1/w2/w4` + `frontend_smoke`。

## 14. 「场地」表现与聚落形态的改法（2026-09-15 R10 / R5b）

- **改建筑脚下的「场地」只动两处，必须同步**：`bldg_ink.js` 的 `hexPlate`（精灵内 / 看板 / 预览页内联）
  与 `plateAt`（`main.js` 逐格现画·城镇色）。只改一处 ⇒ 看板/bldg_town 与实机不一致。
  ⚠ 两个后端（`CanvasBk` / `SvgBk`）**只有单环 `poly`/`line`，没有 even-odd 填充** ⇒ 想画"中空环带"
  只能用「以中径的六边形描一条宽度 = 环宽的边」（`R10` 的做法：`mid=(rIn+rOut)/2`，`lineWidth=rOut-rIn`）。
- ★ **一眼看出"聚落长什么样"：`node tools/bldg_town.mjs <seed> --type=fishing --R=30`** ——
  它用**生产代码**（`BldgInk.svgBody` + `faceSolver`）渲染**引擎真实生成的一座聚落**，并把建筑清单
  直接打在 stdout（例：`民房×3[朝聚落中枢] 仓库×2 祠堂×1 渔船坞×2`）。排查"聚落看起来不对"
  **先跑它**，别去猜、也别一上来就上浏览器。它支持 `--q/--r --type --R --nolabel`。
  ⚠ 改了 `paint()` 的 spec（如新增 `spec.onWater`）记得在 `tools/bldg_town.mjs` 里同步传参，
  否则看板与实机表现不一致。
- ⚠ **"聚落看起来不对"先分清「渲染分支」还是「数据构成」**：`main.js` 里 `bridge = onWater && !isFish`
  决定"画栈桥还是画真建筑"。写个探针（Node 里 eval `pb.js` + `mapclient.js`，用 `MC.block(seed,i,j)`
  取**真实 WS 帧**）打印 `st.type` 直方图 —— 若 `fishing` 有值就说明分支没坏，锅在**引擎的建筑配比**。
  （本次即如此：前端 `isFish` 一直是对的，是 `水岸` 池只有水工 ⇒ 渔村 8 格全是栈桥。）
- ⚠ **新增"地皮"时的必挂项**：`LANDUSE_PRI`（**漏了会让 `outer.sort` 的差值变 NaN ⇒ 排序不确定、
  结果跨会话漂移**）与 `BUILDINGS` 池。地皮改判的 `if` 要放在「内环改判村落」那句**之后**，
  否则刚判完就被覆盖。池的权重靠**重复条目**表达（等概率抽取 ⇒ 条目数即权重），逐格 `hash01` 抽
  ⇒ 与扫描顺序无关、天然确定。
- ⚠ **新增「建筑 kind」的代价远大于新增「地皮」**：要同步 `KIND_LIST` / `KIND_TERRAIN` / 图集与着色器
  分段 / `tools/ink_buildings.mjs` / `verify/stats_buildings.mjs` / 预览页内联 … 一处漏挂就静默不可见。
  能用「新地皮 + 复用现有 kind + 前端/画架派生表现」解决，就别加 kind。
- **落水建筑的表现走「画架派生」而非新 kind**：`spec.onWater` → `paint()` 里垫 `waterDeck`。
  ⚠ 新标志位必须加进 `spriteOf` 的缓存 key（否则第一次画出的形态被所有格复用）；
  ⚠ 木台之类**别铺实色** —— 会把水面糊住，且与「场地要中空」的审美直接冲突。

## 15. 「聚落 ↔ 灵脉」间距 与 「点选标记」缩放（2026-09-15 十二版 R11）

### 15.1 R11 聚落不再贴着灵脉长
旧版 `siteScore` 把「灵脉邻近」当**加分**（`vn.d<=1` +30 / `d<=3` +10）⇒ 城镇中心被主动吸到灵脉脚下。
改前实测（seed 42/7/check 共 382 座）：**32 座中心距灵脉中心仅 1 格**（8.4%），最近建筑同样贴到 1 格。
现在分两层避让：

| 层 | 位置 | 机制 |
| --- | --- | --- |
| 中心 | `siteScore()` | 按 `veinNear().d` **扣分**：`d<=1` → `-CFG.SETTLE_VEIN_CENTER_PEN`(40)；`d===2` → `-CFG.SETTLE_VEIN_CENTER_PEN2`(20) |
| 足迹 | `growTownFootprint()` | 距最近灵脉中心 `d<=CFG.SETTLE_VEIN_FOOT_PAD`(2) 的格**不落建筑**（= 视觉缓冲圈） |

- ⚠⚠ **分级扣分必须单调：`CENTER_PEN > CENTER_PEN2`**。实测把 PEN2 加到 **≥ PEN**（40 / 60）反而**冒出 2 / 10 座 `d<=1` 的中心** ——
  `d=2` 比 `d=1` 罚得更狠时，`d=1` 就成了「两害相权取其轻」的最优解。调这两个参数必须成对看。
- ⚠ **`FOOT_PAD=1` 几乎无效**：那一圈本来就只有灵脉格（已被 `f.vein` 剔过），实测建筑 `d<=2` 仍有 **139 座**；
  **`=2` 才是分水岭** —— `d<=2` 降到 15 座，而全图建筑总数只降 **0.65%**（不心疼）。
- ⚠ 足迹缓冲判定必须放在 `cell.d === 0`（核心格）**之后**：否则灵脉密布处会出「有卫星、无主殿」的残缺聚落。
- 语义澄清：**灵脉域的「繁华」不靠贴脸表达**，由 `rawSettlementsFor` 的 `inVeinDomain`（pop×1.3 + 宗门概率提高）承担，
  所以避让不会毁掉「灵脉附近更热闹」的设定 —— 契约里也据此钉了一条「灵脉域聚落占比 >= 10%」防「赶尽」。
- 旧代码里 `vn.d === 0 ? 60` 是**死分支**（灵脉格早已 `f.vein` → `-1e18` 提前 return），本次顺手清掉；
  后人若看到「灵脉格 +60 加成」的旧注释，那是十一版以前的残留。

### 15.2 点选「朱砂标记」的大小旋钮
- 标记画在**覆盖层**（`main.js` `drawOverlay` 里 `if (selMark)`），几何量**全部乘 `SEL_K`** —— 十二版 `1/3`（用户：「红色圈圈太大」）→ 再 ×1.2 = **`1/3*1.2 ≈ 0.4`**（用户：「圈圈太小了」）；
  **线宽不写死像素**：`selLw = max(geo.hexW * cam.zoom * 0.1, SEL_LW_MIN)` —— 基准是「该缩放下一格屏显宽度的 0.1」（放大时圈/线同比变粗，粗细比例恒定），`SEL_LW_MIN = 1.5px` 保底使**缩得越小线相对越粗**（用户：「线太细了，大概 0.1 格宽；屏幕缩太小要跟着变粗」）。副圈 `selLw*0.6`（保底 1px）、四角斜标 `selLw*1.2` 保持层级。 ⚠ `geo.hexW` 缺失时回退 `geo.hexR*1.7320508`。
  要再调大小**只改 `SEL_K` 一处**，别去逐个改半径/斜标偏移。
- ★ **headless 无法模拟鼠标点击** ⇒ 验收点选态必须靠 `?sel=q,r`（**仅 DEBUG / `capture=1` 生效**的调试参数，与 `plaqdbg` / `ancgeo` 同类）。
  ⚠ 赋值必须在 `regenerate()` **之后** —— 世界重铸（`selMark = null`）会把它清掉。
- **做「改前/改后」对照图的正确姿势**：临时把 `SEL_K` 改成 1 → 同一 URL 截一张 → 改回 `1/3` → 再截一张
  （Chrome 每次加载都重读磁盘 js，**不需要重启服务端**）。
  ⚠ 改回后**必须 grep `var SEL_K` 复核**，别把对照值留在生产代码里。

## 16. 小地图灵脉化：独立模块 + 全 WS 数据（2026-09-15 十三版 R12）

> 触发：用户「右下角小地图**一直请求**导致到了请求速率上限」。根因 = 旧小地图每 1.5s 轮询
> HTTP `/api/map/fields`（132×88 后端采样，`main.js requestMinimap` → `MC.fieldGrid`），撞
> `ApiRateLimitMiddleware`。要求：融合 `灵脉预览.html` 风格重做、可最大化、**独立文件热拔插**、数据走 WS。

### 16.1 交付物与热拔插点
- 新模块 `web/js/minimap-vein.js`（独立 IIFE → `global.MiniMapVein`，约 680 行）。
- **唯一接线点** = `main.js initMinimap()`：`var M = window.MiniMapVein;` → `M.init({panel, full, snapshot, jump})`。
  换小地图 = 换这一个文件 + `index.html` 一行 `<script>`，壳层零改动。
- ⚠⚠ **`main.js` 是 `(function () {`，没有 `g` 形参**（`mapclient.js` 是 `(function(g){`）。写 `g.MiniMapVein`
  会 `g is not defined` → 整页 fatal「后端世界服务不可用」。**必须写 `window.MiniMapVein`**（本版踩过，
  现象是 `--dump-dom` 里 fatal 文本 + canvas 不挂载）。

### 16.2 三层数据口径（改小地图必守）
| 层 | 数据源 | 铁律 |
|----|--------|------|
| L1 地形 | **前端按 seed 自算**：`MapGen.fields(q,r).biome/.e` → 位图 | ⚠ **绝不读 `onRoad`**（道路语义依赖引擎 `roadCache` 冷热，见 `mapgen.js`）；色板取 `geo.biomeMeta[i].color` |
| L2 世界 | **全部来自 WS 快照**：`commCells` / `settleCells` / `regionCells` | 世界是动态的 ⇒ 前端**绝不自算**灵脉/聚落/道路（自算必与服务端不一致） |
| L3 视野 | 默认档跟随主相机（`FOLLOW_WPP=6`，不可拖）；全屏档独立相机 | 全屏浮层/tooltip 必须与 `.panel` **同级兄弟**（面板 `clip-path` 会裁整棵子树） |

### 16.3 引擎脚本经 WS 下发（D3）
- 协议：帧 `Script = 4`；`ScriptRequest{Name}` C→S → `ScriptPack{Name, Source}` S→C。
- 服务端 `MapWsHandler.EngineScriptOrder = [noise.js, mapgen-config.js, mapgen.js]`，**按序拼接**（`mapgen-server.js` 不下发）；
  文件名走**白名单**（杜绝目录穿越），缺文件回空 `Source`（`name="missing"/"denied"`）。
- 前端 `mapclient.requestScript(name)` → `gunzip(source)` → `(0, eval)("'use strict';\n" + src)` 注入全局 → `window.MapGen`；
  `finally` 还原 `window.NoiseLib`（引擎 noise.js 会覆盖它，但引擎内部已捕获自身引用 ⇒ 还原无副作用）。
- ⚠ **ScriptPack 帧本身不 gzip，只有 `Source` 字段 gzip**。第一版在 `onFrame` 里先 `gunzip(payload)` 再解码 ⇒
  `Z_DATA_ERROR` + `.then is not a function`。正确顺序：`PB.decodeScriptPack(payload)` → `gunzip(pack.source)`。
- **单真源**：绝不把 `mapgen.js` 拷进 `web/js/`（副本漂移 ⇒ 前端世界 ≠ 服务端；`灵脉预览.html` 当年就是内联副本）。

### 16.4 防卡与收敛（全屏档大范围抽样）
- 每帧按**时间额度**抽样 `clamp(dtMs * 0.35, SAMPLE_BUDGET_MS=10, 110)` ms（不是按个数），
  配 `SAMPLE_CELLS_MAX`（显示位图 / 抽样层级）与 `REDRAW_MS` 节流；未算到的画「未探测」斜纹占位。
- ⚠ 抽样格必须**世界对齐**（`q%m==0 && r%m==0`，缓存键只有 `q,r`）—— 初版「按画布像素格取格」是
  **视图锁定**的：平移 5 世界单位只剩 55% 复用，每次交互都重新露底。详见 §17。
- **隐藏 = 真停摆**（`tick()` 直接 return，停 rAF / 停抽样 / 停绘制），不是只 `display:none`。
- 实测成本基准：`MapGen.fields` 单格 **0.019 ms**（Node 冷缓存；浏览器约 0.06~0.11 ms/格）⇒ 前端自算可行。
### 16.5 验收姿势
- 端到端：登录 → `ScriptRequest` → `ScriptPack`（约 95KB js，gzip 26ms）→ eval → 抽样 `MapGen.fields`
  与 `/api/map/tile` 地形**逐格比对必须一致**（本次 6/6）。
- 实机三态截图：默认左下 / 全屏 / 隐藏（`verify/live_r11_mm_*.png`）。
- 契约：`verify/frontend_smoke.mjs::checkMinimap`（16 项）。
- ⚠ **环境更正**：本机 8140 **`127.0.0.1` 与 LAN IP `192.168.63.62` 都通**（Kestrel 绑全网卡）。
  旧记录「只绑 LAN IP、127.0.0.1 不通」是把「服务没在跑」误当成绑定问题 —— 早先的 `ECONNREFUSED` 请先探活服务。

## 17. 小地图地形层：抽样格必须「世界对齐」（2026-09-15 R12 修复 · 大面积未探测）

### 17.1 病征与根因

- 病征：全屏大地图只有中心一块实心（= 默认档跟随相机时算过的窗口），其余约 30% 散点 +
  大面积「未探测」斜纹，越靠下越空。
- 根因：`buildTerrain` 的抽样点是**画布像素格投影进世界**得到的 ⇒ **抽样格与视图绑定**。
  实测（复刻抽样格、比较两视图的格集合）：平移 5 世界单位（不足半格）复用 **55.1%**、
  平移一格 **36.4%**、滚轮一格 ×1.14 **30.7%**、面板档→全屏档 **11.5%**；且默认全屏档
  视图内真实 58363 格只抽 21850 = **漏格 63%**（wpp=12 时达 96.8%）。
- ⚠ 看到「小地图大片暗底斜纹」先怀疑**抽样格跟不跟着视图走**，别先查引擎 ——
  `MapGen.fields` 在 ±220 格内**零 null 零异常**、单格约 0.019ms（Node 冷缓存）。

### 17.2 正确口径（改小地图地形层必守）

- 抽样集合 = 世界格 `{ q % m == 0 && r % m == 0 }`，`m = 2^k`；**缓存键只有 `q,r`**，
  `m` 只决定「选哪些格去算 / 显示时读哪一格」⇒ 跨视图、跨层级复用同一张表。
- `m` 取「一个抽样格 ≈ 一个显示块」：`m = ceil_pow2(step(px) * wpp / hexW)`（`levelFor`）；
  只取 2 的幂 ⇒ 缩放跨阈值才换层，层内平移/缩放基本 100% 复用。
- 显示读取走 `biomeAt` 的**层级回退链**（精确格 → m → 2m → 4m → 8m）；重建待采样列表时
  **先铺粗层**（m*8/m*4/m*2）再铺 m ⇒ 首帧就有粗略地脉，不成片露底。
- 待采样列表按「离视野中心由近及远」排序，用**游标**消费（别用 `Array.shift()`：大数组 O(n) 搬移）；
  容量上限别静默丢弃（旧 `QUEUE_CAP` 满即丢 = 把「待算」永久变成「未探测」）。
- 缓存超限按插入序**淘汰最旧 1/4**（整表清空会重新露底）。

### 17.3 取数 / 验收姿势（headless 实机）

- 三态 `?mm=full|hide`；**`?mmwpp=N`** 指定全屏档初始缩放（复现「缩得很远」的现场）；
  `?debug=1` 才暴露 `window.__mm`。
- **`?mmprobe=1`**：页面按时间点采 `__mm.probe()`（`terrainCached / queueLen / sampleM / miss /
  draws / enqDrop`），**末尾一次性 POST 到 `/api/debug/snap`**（服务端只落字节、不校验 MIME）
  ⇒ 读 `verify/capture.png` 即得**整条时间序列**。⚠ CDP `Runtime.evaluate` 对本页会永久挂起，别用。
- **`?mmdrive=1`**：在全屏画布上派发**真实** `WheelEvent` 与 `mousedown/mousemove/mouseup`
  （走模块自己的处理器），验收「拖动/缩放之后是否还露底」。判据：**`miss` 应全程为 0**；
  平移只应新增少量格（本次 1784），缩放换层才会有一批新格（本次 7885，约 1s 补齐）。
- **截图量化**：`verify/*.png` 用自写 PNG 解码（Node `zlib.inflateSync` 手解，零依赖）统计
  「未探测」像素占比 —— 未探测色是 `(40,36,32)/(58,52,44)`，基色:斜纹恒 **3:1**（代码 `(px+py)&3`），
  与任何地貌色都不撞（深海是 `#6d9aab`）。这是最直观的回归判据：本次 **46.5% → 0%**。
- 离线契约：`verify/frontend_smoke.mjs::checkMinimap`（**16 项**），其中
  「平移/缩放复用率 ≥ 90%」与「视图内 0 空洞」是本病的回归闸。
  ⚠ 该段是**按模块常量复刻抽样规则**的代理检查 —— 改抽样规则必须同步改它。

### 17.4 教训

- 「按屏幕像素抽样」这类**视图锁定**的设计，在「全屏大范围 + 逐帧补齐」场景下必然退化；
  抽样/缓存键必须落在**世界坐标**上。
- **静默丢弃最坑**：容量上限提前 return 会把「还没算」变成「永远算不到」，而且日志里什么都看不到。
- 判「大面积未探测」不要靠看：量它的**像素占比**和**随行号的覆盖率梯度**，一秒定性。

## 18. 小地图「面板档倍率」与主相机联动（2026-09-15 R13）

### 18.1 现象与改法

- 现象：面板档（左下角那个）写死 `FOLLOW_WPP = 6` ⇒ 主相机放大/缩小，面板档图幅**纹丝不动**，与全屏档/主图的缩放感脱节。
- 改法（只改 `web/js/minimap-vein.js`）：
  `panelWppNow() = baseWpp * DEFAULT_ZOOM / camZoom` —— **反比**，乘积 `panelWpp × camZoom` 恒等于 `baseWpp × DEFAULT_ZOOM`（= **13.2**），即面板档与主相机保持**恒定比例**。
- 面板档滚轮**只改 `baseWpp`**，别直接改上屏 wpp（否则下一帧被 `panelWppNow()` 覆盖 ⇒ 滚不动）。
- 面板档拖动过阈值 ⇒ 自动转**自由视角**（`follow=false`）；「归心」回 `follow=true`。
- 持久化：`localStorage['zongmen.mmView']` 存 `{ baseWpp, fullWpp, follow }`，刷新还原（面板档/全屏档共用一份档案）。

### 18.2 验收（四组 live_cap + 探针自回传）

| 组 | 验证点 | 实测 |
| --- | --- | --- |
| A 面板驱动 | 滚轮 6→9.44→4.78、saved=YES；拖动 → follow=false；归心 → follow=true | 全过，`miss` 全程 0 |
| B/C 缩放联动 | `camZoom=0.7 → panelWpp=18.857`；`camZoom=6 → panelWpp=2.2`；乘积恒 **13.2** | 覆盖主相机 0.7~6 全档、不越界 |
| D 跨刷新 | 刷新后 `wpp=9.4411` 由 localStorage 还原 | 全过 |

- 取数通道：**`?mmdrive=panel`**（在面板画布派发真 `WheelEvent`/鼠标事件）、**`?mmreload=1`**（验跨刷新还原）。
- 契约：`frontend_smoke.mjs::checkMinimap` 的 R13 段 8 项 —— 「wpp 不再写死」「恒为常数比 13.20:1」「覆盖 zoom 0.7~6 且不越界 `[0.30, 48]`」「全屏档同持久化」。

## 19. 小地图粗层「椒盐感」：金字塔多数表决（2026-09-15 交接单 U4 · 拍板「做」）

### 19.1 病征与根因

- 病征：`m>=4` 的粗层在**地貌过渡带**（湖/林/雪交界）呈细碎噪点，一块一个色、跳来跳去。
- 根因：一个显示块只取**一个**格点样本（网格点/左上角），单点采样在过渡带必然抖 ⇒ 相邻块随机落到不同地貌。

### 19.2 口径（只改 `web/js/minimap-vein.js`）

- 块色 = 块内 `AGG_DIV×AGG_DIV`（现 `=2`，即 4 个）**原始子格样本取众数**。
- 原始样本层 `rawM = rawLevelOf(mD) = mD >= AGG_DIV ? max(1, floor(mD/AGG_DIV)) : 1`；
  `mD < AGG_DIV` ⇒ `rawM = 1` ⇒ **与旧「单点取色」逐字节相同**（低缩放档零行为变化，可安全 A/B）。
- `aggCache` 键 `"mD:q,r"`（`null` 也缓存）；`aggInvalidate(q,r)` 在**新样本落地**时删掉该块 ⇒ 块色随子格实时刷新。
- `rebuildPending` 铺到 `rawM`（不是 `m`），且**仍先铺粗层** `m*8/m*4/m*2` 再铺 `m` ⇒ 样本量 ×4 也不首帧露底。
- ⚠ `biomeAt` 在 `sampleM >= AGG_DIV` 时**一律走块级表决**，删掉「格已在缓存就直接用」的快路径 ——
  否则同一块内会出现「已缓存的格用精确色、没缓存的用表决色」⇒ **块内串色、块边界露缝**。

### 19.3 实测（seed 42；两组独立口径互证）

| 口径 | 改前（单点） | 改后（多数表决） | 提升 |
| --- | --- | --- | --- |
| 离线一致率（800 块，与「块内原生格真值多数」比） | 86.3% | **91.6%** | +5.4pp（混合区 70.1% → 81.1%） |
| 实机椒盐量 `probe().isoPct`（位图块级「与四邻全不同」的孤立块占比） | 6.29% | **4.61%** | −1.68pp |

- ⚠ 代价 = **原始样本 ×4**：mD=8 实测 3.0 万 → 12.1 万格（浏览器约 10s 排空）。
- A/B 做法 = **只翻 `AGG_DIV` 2↔1** 再跑同一 URL；验完**必须 grep 复核复位**（契约已钉死该常量）。
- 诊断通道：`probe()` 新增 `rawM / agg / iso / isoBase / isoPct`。
- 契约：`frontend_smoke.mjs::checkMinimap` 加 3 项（多数表决三件套装配 / `rawLevelOf` 公式 1→1 2→1 4→2 8→4 16→8 32→16 / 一致率 ≥ 角点 +3pp）。

### 19.4 教训

- 「单点采样」在离散块的粗层就是**欠采样** ⇒ 过渡带必然椒盐；正确解是**金字塔聚合（子格取众数）**，而不是去调色板或加模糊。
- 聚合必须与**缓存失效**配套：只聚不失效 ⇒ 块色冻在旧样本上；只失效不聚 ⇒ 每帧重算（×4 成本雪上加霜）。
- `AGG_DIV` 这种「一行开关」很适合 A/B，但**必须让契约钉住它的值**，否则验完忘了复位就成了幽灵回归。

## 20. 本机环境前提（两条会误事的 · 2026-09-14 七轮实测）

1. **本机有 .NET SDK**：`C:\Program Files\dotnet\dotnet.exe` = **8.0.100**。
   「无 SDK ⇒ 服务端回归跑不了」是**错的**（曾因此把 `verify_map`/`w1`/`w2`/`w4`/`frontend_smoke` 搁置一天）。
2. **本机 bash 的 PATH 是坏的**：`ls`/`cp`/`tail`/`head`/`dirname`/`grep` 一律 `command not found`；且**终端工具不回显 stdout**（PowerShell/终端执行成功但零输出，本会话实测）。
   可靠姿势 = **全程 Node 绝对路径**：

   ```bash
   N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
   "$N" -e "const {execFileSync}=require('child_process');const G='C:/Program Files/Git/cmd/git.exe';console.log(execFileSync(G,['status','--porcelain'],{cwd:'D:/codes/宗门模拟器demo',encoding:'utf8'}));"
   ```

   - git 绝对路径：`C:/Program Files/Git/cmd/git.exe`（备选 PortableGit `.../binaries/PortableGit/versions/1.2.0/cmd/git.exe`）。
   - 长输出**写盘再 Read**；`| tail` / `| head` 用不了（管道目标不存在）⇒ 用 `node -e` 截取。
   - 需要显式 PATH 时：`export PATH="/c/Program Files/Git/cmd:/c/Program Files/Git/bin:$PATH"`，**再** `cd`（否则连 `cd` 都失败）。
   - ⚠ `git -c core.quotepath=false status` 的 `-c` 必须写在子命令**之前**（`git -c ... status`，写后面报 `unknown switch c`）。
- ⚠ **别用 `node -e "…"` 内联含反引号的脚本**：bash 双引号里的反引号会触发**命令替换** —— 内容被静默吞掉（无报错，只是没了）。本项目已踩 **2 次**（一次把台账整段拼坏需回滚，本轮又把 daily log 两行的 `` ` `` 内容整段抹掉）。⇒ 凡**多行**或含**反引号/反斜杠/`$`** 的 JS，一律**先写成临时脚本文件再 `node <file>`**；写完必须**回读断言**关键串还在。

## 21. 离线回归清单 + 批量驱动

逐条跑（不需要服务端，先跑这批）：

```bash
cd D:/codes/宗门模拟器demo
N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
"$N" verify/sync_preview_inline.mjs --check
"$N" verify/check_preview_vein_marker.mjs
"$N" verify/check_preview_terrain.mjs
"$N" verify/check_edge_falloff.mjs
"$N" verify/check_preview_draw.mjs              # 期望 32 通过 / 0 失败
"$N" verify/check_preview_settle_road.mjs       # 期望 305 条（多圈收敛 7 圈）
"$N" verify/check_vein_skin.mjs                 # 前端灵脉配色/形状/等级契约（现 42 项）
"$N" verify/check_plaque_align.mjs              # 匾额/名牌落点对齐（C-a 真建筑格 / C-c 签位=峰尖 / D 文案）· 39 项
"$N" verify/check_fish_skin.mjs                 # 渔村皮肤（A）· 44 项，含 stub canvas 真跑 spriteOf 验缓存不串图
"$N" verify/check_faction.mjs                   # 归属势力底图（B）· 72 项，抠 main.js 真源码 eval + 真跑 plateAt
"$N" verify/w5_sprite_range.mjs
"$N" verify/w6_bldg_face.mjs                    # 期望 23 / 0
"$N" verify/w3_bfs_road.mjs                     # 17 项；约 60~100s，前台跑并放宽 timeout
```

- **批量驱动已固化**：直接用 `verify/run_regression.mjs`（见 §13 的「总 runner」条目），别再手拼命令行。
- ⚠ 「**把生产代码抠出来 eval**」是本项目写离线契约的首选手法（别把逻辑重写一遍 —— 测的必须是上屏那份代码）。范式在 `check_faction.mjs`：用括号配平 + 字符串/注释感知的扫描器从 `main.js` 抠出 `factionOf/factionColor/factionSig/townColor/…` 共 9 段，注入可控 `settleCells` 与 `location` 后 `new Function(...)` 跑。
  - ⚠ 抠片段必须在**原文**上做（去注释版会把字符串内容一起毁掉，抠出来就不能 eval 了）；但**源码守卫**要用去注释版（否则文档注释里的示例代码被当成真实调用）。两份都留着。
  - ⚠ `scanTo` 这类括号配平扫描器：`}` 必须先 `depth--` **再**问「是否到达 depth 0」，否则配平的收尾括号永远问不到（写成 `depth--; continue;` 就恒返回 -1，症状是「所有片段都抠不出来」）。
- ⚠ Canvas 绘制函数（`plateAt` / `spriteOf`）能在 Node 里**真跑**：装一个 `document.createElement('canvas')` 返回假 canvas + 一个**记录型 2D 上下文**（把 `beginPath/moveTo/lineTo/arc/rect/stroke` 全记下来）。于是可以逐值断言「刻痕长 0.11R」「8 型印纹的图形描述符两两互异」「无归属时恰 3 笔且不出 arc/rect」。见 `check_fish_skin.mjs` / `check_faction.mjs`。
- ⚠ **测散列/随机分布前先验证测试数据本身不退化** —— 踩过两次：① `q=(i*53)%400-200 / r=(i*149)%400-200` 时 `53≡149≡5 (mod 16)` ⇒ q,r 低 4 位恒相等 ⇒ 颜色唯一率从 100% 假跌到 52%；② LCG 取**低位** `%12` 周期极短 ⇒ 坐标本身大量重复。正确做法：xorshift32 **只取高位**（`(r32()>>>20) % n`）。
- ⚠ 实机 A/B 抓图（验证渲染改动）务必带 URL 参数 **`capmin=N`**（截屏前预热 N 秒）：页面自截的就绪门槛常写得松（`chunkData>=3`），不加则同一 URL 两帧可差 ~20%，A/B 会被噪声吞掉。详见 skill `webgl-headless-verify`。

## 22. 服务端回归 —— 起**隔离实例**（绝不动用户的 8140）

```bash
# 构建到仓内临时目录（.gitignore 已忽略 verify/_*）
dotnet build Server/Zongmen/ZongMen.csproj -o verify/_vmsrv -p:UseAppHost=false

# 起实例：env 用「双下划线」映射配置节
# ⚠ MaxSeeds 必须显式放大，见下方第 1 条
Zongmen__Port=8150 \
Zongmen__MaxSeeds=64 \
Zongmen__DbPath="C:/Users/Administrator/AppData/Local/Temp/wb/reg.sqlite" \
dotnet verify/_vmsrv/ZongMen.dll

curl -s --noproxy "*" http://127.0.0.1:8150/api/map/stats
```

0. ⚠ **`Zongmen__MaxSeeds` 必须显式放大（2026-09-15 新增，最容易误判成回归）**
   `appsettings.json` 的 `MaxSeeds` 是 **3**。而 live 组里 `check_mm_ui` 每次用**新的随机 seed**、`frontend_smoke`/`check_mm_layout` 也会各占一个 ⇒ **连跑三四轮回归就把名额用满**，之后新 seed 一律被服务端拒绝 ⇒ 页面拿不到世界/快照 ⇒ 判据报「`模块/快照 25s 内未就绪 (MiniMapVein=true)`」或「引擎未 ready」。
   **症状与产品回归几乎一样**，但 `check_mm_ui` 单跑也红、且**失败得很快（~1.6s，不是 25s 超时）**就是它的指纹。
   - 查法：`curl -s --noproxy "*" http://127.0.0.1:PORT/api/map/stats` → 看 `liveSeeds` 是否 **等于** `maxSeeds`。
   - 修法：起实例时带 `Zongmen__MaxSeeds=64`（并换新 `DbPath`，旧库里的 seed 也会占名额）。
1. `Options.FindRoot` 自 ContentRoot（= exe 目录）**向上找含 `web/index.html` 的目录** ⇒ 从 `verify/_vmsrv` 起步会命中仓库根，**自动用仓库 `web/` 与 `Engine/js`**，不用拷资产。
2. 跑完 **kill 该实例 + 删 `verify/_vmsrv`**（46 个文件 / 约 292MB），最后 `git status` 与 `git status --ignored verify/` 双净。
3. 探端口用 `net.connect` 确认起来/关闭；**别用 `taskkill /IM`**（会连带杀用户实例）。按命令行精确定位才安全（`wmic` 在本机可用）：
   ```bash
   wmic process where "name='dotnet.exe'" get processid,commandline /format:csv | tr -d '\r' | grep -i 'vmsrv' | awk -F',' '{print $NF}'
   # 再对拿到的 PID 逐个 taskkill /F /PID <pid>
   ```
4. ⚠ **别在回归跑动中去清 `%TEMP%/wb-*`**：那批目录里就有正在跑的 Chrome profile，删了会当场假红（实测 `check_calc_local` 一次红 4 条，单跑立刻 11/11 绿）。要清就等跑完。
5. 然后都传该端口：

  ```bash
  "$N" verify/frontend_smoke.mjs    http://127.0.0.1:8150
  "$N" verify/w1_client_revs.mjs    http://127.0.0.1:8150
  "$N" verify/w2_concurrency.mjs    http://127.0.0.1:8150
  "$N" verify/w4_revs_at_scale.mjs  http://127.0.0.1:8150
  "$N" verify/scan_poison.mjs http://127.0.0.1:8150 42 "[-20,20,-20,20]"   # 1681 块 bad=0
  ```

  ⚠ `scan_poison` 的 BASE 默认写死 8140，**换端口必须显式传 baseUrl**，否则每块 timeout 报假 BAD；
  其默认范围 `[-80,80]²`（2.6 万块，太慢），基线口径是 **`[-20,20]²` = 1681 块**。

## 23. 判定「失败是不是回归」——引擎 / 前端**副本 A/B**（不碰仓库）

- 复制 `Engine/js` 到临时目录，只改待测那一行；让被测脚本的引擎目录可由环境变量覆盖：
  `const ROOT = process.env.ROOT_OVERRIDE || path.resolve(__dirname,'..')` + `process.env.ENJDIR || ...`。
- 服务端侧同理：**`Zongmen__EngineJsDir=<临时副本>`**；前端副本走 **`Zongmen__WebDir=<副本>`**（`Options.ResolveWebDir` 认这个键）⇒ 两台实例**仅差那几个常量**，同 seed 同机位抓帧差分即可归因。
- ⚠ 复制脚本到仓库外后 `__dirname` 变了 ⇒ **必须同时加 `ROOT_OVERRIDE`**（`web/js/pb.js`、`mapgen-config` 等都从 ROOT 解析），否则报 `ENOENT ...\Temp\web\js\pb.js`。
- ⚠ 副本要用**递归 `copyFileSync`**（沙箱里 `fs.cpSync` 会**静默杀进程**：exit 127 且无输出）；回退用**断言式替换**（每条断言唯一命中数，全绿才落盘）+ 替换后自检。
- 自己写个只读 `MapGen` 结果的小 harness（把 `noise.js` + `mapgen-config.js` + `mapgen.js` 加载进 `vm`）比改现有脚本省事 —— 现有脚本多数把 `JSDIR` 写死。
- ⚠ `bench_road_drain.mjs` 自 2026-09-14「路廊复用」起**已退役**，别拿它当 A/B 载体。

## 24. 引擎改动的正确性验证：**顺序无关性 harness**（比逐项 assert 更有力）

道路/聚落这类「按需增量生成」的引擎，最容易出的不是崩溃，而是**「输出取决于访问顺序 / 缓存冷热」**。
2026-09-14 用它定位并根治了 `verify_map` 22 项 + 预览页/服务端分叉：

```js
// 同一引擎副本, 用 4 种扫描顺序各把窗口建成「收敛态」, 比指纹
// 顺序: fwd(ij 升) / rev(ij 降) / col(ji 转置) / center(按到原点距离)
for (const [i,j] of cells) MG.roadsNear(i, j, 9999);   // 第一遍
for (const [i,j] of cells) MG.roadsNear(i, j, 9999);   // 第二遍 → 新增应为 0 (幂等)
// 指纹: 逐产出物 (key | 折线量化 | 瓦片集) 排序后 FNV —— 与遍历顺序无关
// 再补一组: 带中心点参数 vs 不带 (预览页传 cq/cr、服务端不传)
```

判据：**4 种顺序 1 个指纹 + 二遍零新增 + 带参不带参一致**。改前 HEAD 是 **4 种顺序 4 个指纹**。
配套的「逐次耗时注入」（在 `search()` 返回处 `__lg(seg,len)` 记录 ms）能区分「整体变慢」与「个别格堆了多次昂贵调用」。

⚠ 计时类判据在本机**噪声极大**：同一份代码单区域 max 实测 **221/290/297/307/605ms**（整轮总耗时同步 14s→19s）。

- 别用**单个极值**做阈值；用**第 3 慢**这类尾部统计（同代码 B 版 178~181ms / HEAD 230~241ms，高度可重复）。
- 判回归时**必须同机同 harness 跑 HEAD 对照** —— 250ms 那个旧阈值 HEAD 自己 281.8ms 就 FAIL，属陈旧标定。

## 25. 改核心源码的手法：**断言式补丁脚本**（别用多次 Edit 试错）

批量改 `Engine/js/mapgen.js`（尤其是「删一片、改一片」的大改动）时：

```js
const PATCHES = [];  const rep = (label, oldS, newS, hits=1) => PATCHES.push({label, oldS, newS, hits});
/* … 逐条 rep() … */
// 先对【原始文本】逐条校验命中数, 全部符合才落盘
for (const p of PATCHES) { const n = s.split(p.oldS).length - 1;
  if (n !== p.hits) bad.push(`${p.label}: 期望 ${p.hits} 实得 ${n}\n${p.oldS}`); }
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }   // 一次看到全部失配点
for (const p of PATCHES) s = s.replace(p.oldS, p.newS);
```

两条必踩的坑：

1. **CRLF**：源码在盘上是 CRLF（`core.autocrlf=true`）。读时 `replace(/\r\n/g,'\n')` 匹配，写回时 `s.replace(/\n/g,'\r\n')` —— 否则整个文件判为「全部改写」。
2. **转义引号**：注释里可能有 `(Set \"q,r\")` 这种带反斜杠的引号，匹配串要按**实际字节**写（在 JS 模板串里就是 `\\"`）。第一次写错会命中 0 处。

改完 `Engine/js/*.js` 别忘了：① `node verify/sync_preview_inline.mjs`（重跑内联，再 `--check`）；② 重启服务端；③ 若 chunk/comm/settle/road 载荷变了 ⇒ 清 `db/zongmen.sqlite*`。

## 26. 工作区事故与仓库卫生

### 26.1 `verify/` 被误删（已发生 3 次）

症状：`git status` 里一批 ` D verify/*.mjs`（被跟踪文件从工作区消失）。
危险的是清理脚本常以 `git status --ignored` 为名单 —— **连被跟踪文件一起删时，该命令恰好报「剩余 0」，判据自证**。

```bash
git restore --source=HEAD --worktree -- verify/
git add -- verify/     # 清 stat-cache 假脏（CRLF/时间戳导致的假 ` M`）
git diff --numstat     # 应为空 = 内容确实等于 HEAD
```

清理铁律：**先按 `git ls-files` 过滤掉被跟踪名单**，再用 Node `fs.unlinkSync` 绝对路径删；禁 shell 通配符与 `git rm`。
删除脚本建议加两道闸：① 干跑（`--dry`）先打印「候选 / 保留 / 删除清单 + 总字节」；② **跨目录代码依赖扫描** —— 若 `web/`·`Server/`·`Engine/`·`tools/` 下的 `.js/.mjs/.json/.html/.cs` 文本里出现了某个待删文件名 ⇒ 判为依赖、**中止**（⚠ 扫描时必须**规范化路径**排除 `verify/` 自身，否则 `_foo.mjs` 会“自己引用自己”恒命中；`path.join` 而非字符串拼 `/`，双斜杠会让前缀判等失败）。

### 26.2 漏跟踪资产审计（防「配置真源被覆盖即丢失」）

按目录比对「`git ls-files <dir>` 的扩展名惯例」vs「工作区实际文件」。已命中实例：`web/js/vein-skin.js`（渲染配置真源）· `verify/{check_vein_skin,probe_spots,cdp_feat}.mjs` · `tools/prop_sheet.mjs` · 台账 `待办事项/前端表现升级-匾额山体云气.md`。

⚠ `core.quotepath` 会给中文/特殊路径加引号 ⇒ 按扩展名过滤必须 `git -c core.quotepath=false ls-files`，否则统计假 0。
惯例参考：`docs/` 下 27 张 png **是入库的** ⇒ 证据图入库可接受；`待办事项/img/`（fx* 系列，14.6MB）从未入库，是否入库待定。

### 26.3 安全暂存删除（文件已在工作区消失、只剩索引里的 ` D`）

```bash
git rm --cached -- <paths>   # 只动索引；工作区本就无文件，非破坏性
```

先看 HEAD 里它们是什么（`git show HEAD:<path>`）：若属「一次性 review / todo / 设计稿」且结论已进台账 ⇒ 可删。
⚠ 绝不对**已被跟踪**的文件用 shell 通配删除（§26.1 已发生 3 次事故）。

## 27. 前端「配置真源」的契约验证（灵脉配色范式，2026-09-14）

前端一旦引入**专用配置文件**（如 `web/js/vein-skin.js` = 灵脉颜色/形状唯一真源），就必须有一条脚本把「前端配置」与「引擎常量」钉在一起 —— 否则只会在视觉上**静默错位**（颜色偏一点，无报错、无异常）。
已实现为 `verify/check_vein_skin.mjs`（现 **40 项断言**：A 段配色 10 + B 段等级分档 30；直接 node 跑、不需要服务端）：

```js
// 在 vm 里按「引擎加载序」加载；前端配置文件靠 global 共享同一份 global
load('Engine/js/noise.js'); load('Engine/js/mapgen-config.js'); load('Engine/js/mapgen.js');
load('web/js/vein-skin.js');            // ← 它写 global.VeinSkin
// ① 数组/键【顺序】一致：顺序错 ⇒ sprite 索引错位，比颜色错更隐蔽
assertEq(VS.elements.map(e=>e.key), MG.ELEMENTS)             // ['金','木','水','火','土']
assertEq(Object.keys(VS.variants),   MG.VEIN_VARIANT_ORDER)  // ['雷','风','冰','暗']
// ② 每元素/异灵根的 glow 必须逐一等于引擎 RGB
for (const e of VS.elements) assertEq(e.glow, MG.ELEMENT_RGB[e.key]);
for (const v of VS.variants)  assertEq(v.glow, MG.VARIANT_RGB[v.key]);
// ③ hScale 有下限（灵脉须高过大世界山；大档实测 1.90、中档 1.58，阈值 >1.55）
// ④ 算 W/H 断言落在 [0.6,1.6]（近正方 ⇒ 山形不被横向拉宽）
// ⑤ variantSprite(name) = 32+index（图集 row4），越界回 -1
```

- 该脚本属 **§21 离线回归清单**，**改前端配色后必跑**；加新元素/异灵根时也要补断言。
- 契约的另一半是**挂载序**：`vein-skin.js` 必须在 `textures.js` **之前**（textures 绘制时读它）—— 只验值不验顺序会漏，用 `index.html` grep 复核。
- 改形状系数（hScale/wScale）必须**同步 `tools/prop_sheet.mjs`**：看板按同一公式摆「实机尺寸条」，不同步会把比例判错。
- 图集若新增/启用行位（九版启用此前**永不触发**的 row4 → id 32..35：tile 索引 = `biome*4+variant ≤ 31` 使 `HEX_FS` 的 `biome-8→row4` 分支成死代码），必须同步 `verify/w5_sprite_range.mjs` 的 DRAWN / BY_BIOME 集合，否则漏报或误报「未使用精灵位」。
- 精灵位/载荷变了 ⇒ **停服清 `db/zongmen.sqlite*`** 再起（否则实机看旧内容）。

> 本节内容原在**用户级** skill `zongmen-regression`（2026-09-15 夜归并到本仓库版；用户级那份已删除，避免「同名异实、改了这处忘了那处」）。
## 28. 响应式几何缺陷：「绝对定位收缩盒」+ 量盒才是唯一证据（2026-09-15 手机小地图「不占满窗体」）

**症状**（用户手机截图）：小地图面板右侧一条空白纸，画布只占左边一块。

**根因**：`#minimapBox` 是 `position:absolute` ⇒ **收缩包裹盒 (shrink-to-fit)**，宽度 = 最宽子孙的固有宽。
窄屏档 `@media (max-width:760px)` 把画布缩到 `150×98`，但头行「山河小图 归心 全屏 隐藏」与提示行的固有宽**都是 188px**
⇒ 面板 204px 而画布 150px ⇒ **右侧空白 38px**（手机截图上量到的 61 物理像素 = 38 CSS px × 1.6 DPR，对得上）。
桌面档 `216=216` 恰好相等 ⇒ **只在窄屏暴露**。
> 教训：`position:absolute` 的面板里若同时有「固定像素宽的画布」和「文本行」，两者宽度必须显式对齐；
> 只量桌面档看不出来，**必须在断点两侧各量一次**。

**修法**（`web/index.html`，纯 CSS）：
1. **几何参数化**：`--mm-h`（画布高）/ `--mm-chrome`（57px：头行+提示+内边距）/ `--mm-bottom` / `--mm-gap`；
   `#info`（山川志）的 `bottom` 改成 `calc()` 由变量推出。原先写死 `230px`（桌面）/`168px`（窄屏），
   而窄屏那个**本身就是错的**：面板顶边在 173px、山川志底边在 168px ⇒ **压住小地图 5px**，只有反向对照时才暴露。
2. 窄屏 `#minimapBox{left:10px;right:10px}` ⇒ 宽度确定；再 `#minimap{width:100%;height:var(--mm-h)}` ⇒ 铺满窗体。
   ⚠ **桌面档绝不能给 `width:100%`**：收缩盒里百分比宽会回落到画布自身的 `width` **属性**，而模块每帧都在改这个属性
   （`clientWidth×dpr`）⇒ **反馈环**。所以桌面档保留固定 `216px`，只让窄屏走百分比。
3. 窄屏画布高 `min(132px, 22vh)`（横屏时不至于吃掉半屏）。

**怎么量**（本机 CDP `Runtime.evaluate` 对本页**永久挂起** ⇒ 不能用来取数）：
写**同源探针页**（`web/_*.html`，已被 `.gitignore` 的 `web/_*` 覆盖），把 `index.html` 装进**各档宽度的 iframe**，
读 `getBoundingClientRect()` + `scrollWidth/clientWidth`，结果写进 `<pre>`，再用**旧版** headless 取回：

```bash
chrome --headless --disable-gpu --window-size=1400,900 --virtual-time-budget=90000 \
       --dump-dom "http://127.0.0.1:8140/_mmlayout_probe.html?w=280,390,760,761"
```

iframe 的布局视口 = iframe 尺寸 ⇒ **一次 Chrome 跑完十几档宽度**（媒体查询 / `100vw` / `vw` 单位全部按该档生效），
而且 DOM、`window`、模块的 `MiniMapVein.probe()` 都读得到（同源）⇒ **不碰 CDP、不读图、纯数字**。
⚠ 必须用**旧版** `--headless`（`--headless=new` 忽略 `--window-size`），且 `--virtual-time-budget` 要够长
（本脚本按 `20000 + 5000×档数` ms 给）。

**固化成判据**：`verify/check_mm_layout.mjs`（自包含：生成探针页 → 跑 Chrome → 断言 → 删探针），
12 档宽度 × 8 条：数据齐全 / **画布铺满内容框 ≤1px** / 窄屏左右贴边 10px / 窄屏画布高 = min(132,22vh) /
**宽屏桌面档锁死 232×198 与 216×141（防误伤）** / 头行与提示行不溢出不截字 / 山川志净距 ≥6px / 画布不出视口。
已挂进 `run_regression.mjs` 的 live 组（**17 条**）；无 Chrome 或服务端不通 ⇒ 自己 rc=2 跳过，不算红。

**⚠ 检查必须有牙 —— 反向对照**：改完把**改前**的 `index.html` 临时换回去再跑一次，必须**红**
（本轮实测 5 条 FAIL / rc=1），跑完按 **sha256 核对还原**。
只证明「修改后是绿的」等于什么都没证明 —— 判据写歪了、选择器写错了，一样是绿的。

**边界（CSS 改动不在 `frontend_smoke` 的源码守卫内）**：`frontend_smoke.mjs` 的 51 条里，源码守卫只 grep
「零轮询/旧符号/单点注入」这类符号事实，**CSS 几何完全不在其中**。改样式表后**必须**跑
`verify/check_mm_layout.mjs`（或整条回归），否则「手机上又留一条空白纸」这类缺陷会静默回归。

## 29. 手机触摸档：事件根本没绑（2026-09-15 · 「手机版的不能放大或者拖动」）

**症状**：手机上小地图捏合/拖动全无反应，桌面鼠标一切正常。

**根因不在几何在事件**：`bindPanel()` / `bindFull()` 只绑了 `mousedown/mousemove/mouseup/wheel`，
**零个 `touch*`**。触屏上鼠标事件只在「点击」时被合成，拖动/捏合**不会**补 ⇒ 等于没接交互。
⇒ **排查「某个交互没反应」时，第一步永远是 grep 事件绑定，而不是看坐标/尺寸。**

**改法（照抄主地图 `main.js` 已有口径，别另创）**：单指拖 = 平移且 `followCam=false`；
双指捏合 = **等价滚轮**（面板档只改 `baseWpp`，别碰上屏 wpp，否则 R13 的恒定比例就毁了）；
未移动的抬指 = 单击（展开全屏 / 跳转）；`TOUCH_SLOP=8`（比鼠标 3px 宽，手指抖）；
捏合抬一指 ⇒ 剩指接着拖并标 `moved:true`；画布加 `touch-action: none`。

**⚠⚠ 必踩的坑 —— 合成鼠标事件**：一次触摸结束后浏览器 ~300ms 内**补发** `mousedown/mouseup`。
原 `mouseup` 写着「未拖动 ⇒ 单击 ⇒ 展开全屏」⇒ **手机上一拖动松手就自己弹全屏**。
对策：`lastTouchTs` + `fromTouch(e)`，四条鼠标处理全挂闸。
⚠ 比较用 **`e.timeStamp`**（合成事件与真事件同一时钟），用 `Date.now()` 会跨时钟误判。

**验证手法**：合成 `TouchEvent`（`new Touch({identifier,target,clientX,clientY})` +
`new TouchEvent(type,{touches,targetTouches,changedTouches,bubbles,cancelable})`）打进
**同源 iframe 里的真页面**，再读 `probe()`。抬最后一指 = `touches: []`；
拖完再补发一对合成 `MouseEvent` —— 这一条专门验「一拖就弹全屏」的坑。

**⚠ 判据自欺的一种**：全屏档平移我一开始断言 `panelCx` 变化 —— 但 `probe()` 只有 `fullWpp`，
`panelCx` 是**面板档**的字段，压根不反映全屏中心 ⇒ 判据恒 FAIL（这次是**假红**，反方向的自欺）。
处理：给 `probe()` 补 `fullCx/fullCy`（诊断字段本就该齐），别在判据里将就现有字段。
**推论**：断言用的字段必须**是你真正在测的那个量** —— 假绿与假红都源于「字段与语义不对齐」。

## 30. 手机浏览器「算法暗化」→ 强制浅色（2026-09-15 · 「ui不应该跟随系统变化」）

**症状**：系统切深色，整张纸白 UI 变墨黑。

**排除顺序（先排除自己，再怀疑宿主）**：
1. 全 `web/` grep `prefers-color-scheme|matchMedia|color-scheme|darkMode` → **0 命中**，配色全写死。
2. 本机桌面 Chrome：`--force-dark-mode` / `--enable-features=WebContentsForceDark` / 两者叠加，
   各截 480×700 逐像素比 → 最大差 **0**（另一组 3614px 只是抗锯齿抖动），亮度完全一致。
   ⇒ **本机复现不出**，别硬造复现。
3. 结论：变暗来自**宿主浏览器/WebView 的算法暗化**（Chrome Android 自动深色 / Android WebView
   algorithmic darkening / 微信·QQ X5 夜间模式）—— 它们对**未声明 `color-scheme` 的页面**强行反色。

**修法（标准退出方式）**：`<meta name="color-scheme" content="only light">` **+**
`:root { color-scheme: only light; }`。**`only`** 才是退出关键字（`light` 只说「支持浅色」）。
meta 给浏览器、CSS 给渲染引擎，两条都写才稳。

**⚠ 诚实边界**：本机证明不了「手机上就好了」，只能断言「退出声明在位 + 全表无反向规则」。
写判据时**把这条限制写进脚本头部注释**，别让后来人以为它验过了实机观感。

**固化成判据**：`verify/check_mm_ui.mjs`（自包含：生成同源 iframe 探针页 → 合成触摸/鼠标事件 →
断言 → 删探针），①强制浅色 3 条 + ②触摸交互 8 条 + ③鼠标回归 2 条 = **14 条**，已挂进
`run_regression.mjs` 的 live 组（**18 条**）。无 Chrome / 服务端不通 ⇒ 自己 rc=2 跳过，不算红。

**反向对照（有牙的证明）**：把改前的 `minimap-vein.js` + `index.html` 临时换回去再跑 ⇒
**10 条 FAIL / rc=1**，其中「拖动后合成鼠标事件把 maximized 打成 true」直接复现了 §29 的坑；
且 `colorScheme` 由 `"light only"` 退回 `"normal"`、`<meta>` 由 `"only light"` 退回 `null`。
跑完按 **sha256 核对**还原（`ebedc942…` / `481fefbd…`）。

---

## 31. 判据自己会「假红」：两类必须归因的断言（2026-09-15 收口 · A/B/C + 地形自算）

收口时遇到的两个「红」**都不是产品 bug，而是判据写错了**。它们的形态不同，但都属同一类错误：
**用绝对值阈值去判一件「和基线比才有意义」的事。**

### 31.1 绝对值阈值 ⇒ 必须改成 A/B 归因

`check_calc_local.mjs` 的 S5 原本断「hybrid 档首屏最长任务 ≤ 50ms」，实测**恒红 ~250ms**。
做**归因 A/B** 后（把三档的最长任务一起打出来）：

| 档 | 本地算 | 首屏最长任务 |
|----|--------|--------------|
| hybrid | ✅ 48 块本地算 | 253 ms |
| ab | ✅ 48 块 + 服务端对拍 | 252 ms |
| **server** | ❌ **零本地算** | **245 ms** |

`server` 档一行本地算都不跑，照样 250ms ⇒ 那钱花在 **WebGL 上下文 / 着色器编译 / 图集构建**上。
判据已改为 **「hybrid ≤ server + 40ms 余量」**，并把三档数字打进摘要行（**数字不许被藏起来**）。
> 教训：**给判据加绝对值阈值前，先问「这个量在「老路径」上是多少」**。拿不到基线就别下这个断言 ——
> 只需一行 A/B 就能把「本次改造引入的」与「本来就在的」分开。
> 结论同时带出一个决策：S5 观测 = 分帧预算够用，**不需要 Worker 化**（实施单 S7 免做）。

### 31.2 结构审计的白名单要按**约定**推断，别逐个补

`frontend_smoke.mjs` 的「前端读取的解码字段必须落在解码器字段集内」把 B 新增的
`st._fac` / `st._facV` 判红。它们是**客户端本地 memo**（与既有 `st._anc` 同类，纯前端缓存，非线路字段）。
- 修法：按项目约定 **整体放行 `_` 前缀**属性 —— 线路 protobuf 字段一律不带下划线 ⇒ `_xxx` 只可能是前端自挂缓存。
- ⚠ 这类误报**已发生两次**（`_anc`，然后 `_fac`/`_facV`）。**第二次就该改规则**，不要再补一条白名单。

### 31.3 harness 自己泄漏：`setTimeout` 里的清理 + 紧跟的 `process.exit`

`live_cap.mjs` 与 `check_mm_layout.mjs` 把 `fs.rmSync(profile)` 放进 `setTimeout(..., 800~1500)`，
而 `finish()` / `cleanup()` 里**紧接着就 `process.exit()`** ⇒ **定时器永不触发** ⇒
每次跑都漏一个 Chrome profile 目录。本机 `%TEMP%` 已积 **255 个 `wb-*` / 3.54 GB**（`wb-livecap-*` 127 个最多）。

- 修法：**同步删**（`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` 可当同步小睡），带重试 ——
  `taskkill` 返回后 Chrome 释放文件锁还有几百 ms 延迟。
- 顺手修掉 `check_mm_layout.mjs` 里 `KEEP` 的两个分支**写反**（`KEEP=true`「留档」反而立刻删）。
- 清理姿势（**跑完后**再清，别在回归跑动中清）：
  ```bash
  # 只碰 wb-<name>；⚠ 绝不碰无短横的 wb/（隔离实例的 sqlite 就在里面）
  node -e "const fs=require('fs'),p=require('path'),os=require('os');const t=os.tmpdir();
    for(const d of fs.readdirSync(t).filter(x=>/^wb-/.test(x))) fs.rmSync(p.join(t,d),{recursive:true,force:true});"
  ```

### 31.4 「红」的三种归因顺序（省钱）

1. **单跑那一条**：立刻绿 ⇒ 联跑抖动（Chrome 争用 / `MaxSeeds` 跑满，见 §22 第 0 条）。
2. **对比 `?fac=0` / `?calc=server` / 老链路副本**：确认是不是本次改造引入（§23 的副本 A/B 手法）。
3. **查环境**：`/api/map/stats` 的 `liveSeeds == maxSeeds`？`%TEMP%/wb-*` 堆了多少？端口上是哪个构建（meta 有没有新字段）？

> 本次收口的最终验收：**`--base=<隔离实例>` 全量 22 条，红 0**（离线 18 + live 4）。
