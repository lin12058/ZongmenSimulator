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
node verify/frontend_smoke.mjs    # meta 常量 + HTTP tile/fields + 几何往返 ±1000 格 + DOM id/静态置脏/小地图/色板 契约
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
  - **小地图契约**：`/api/map/fields` 只下发 `{q0,r0,nq,nr,d}`，客户端必须由 `q0+nq-1`/`r0+nr-1` 推上界
    （曾直接读 `mmData.q1/r1` → 恒 undefined → 小地图自上线起一直是空框 —— N11）；
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
  实测 `frameCount = 5`、`minimapTimer = 0.10` —— 任何「累积 0.4s 才刷新」的逻辑（如小地图门控）
  **永远到不了**，于是截图里那部分恒空。**这是 headless 伪影，不是线上 bug**（真实浏览器 60fps 下约 0.4s 即出现）。
  遇到这类「截图里某块恒空/恒不变」时，**先怀疑帧饥饿，不要直接当代码 bug 改**。三条可靠验法（按可靠性排序）：
  1. **纯 Node 复现同一算法**（首选）：见 `frontend_smoke.mjs` 的「小地图契约」段 —— 直接驱动真实
     `MapClient` + 真实服务端跑一遍像素上色，断言「0 落空 + ≥3 种地形色」；
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

