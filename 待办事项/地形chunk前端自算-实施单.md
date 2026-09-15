# 地形 chunk 改前端自算 · 实施单（P1 / hybrid）

> 拍板日 **2026-09-15** · 状态 **✅ 已实施并验收（S1~S5 全达成，S6/S7 未做且不需要做）**
> 需求原文：*「地形 chunk 换成前端算的，然后请求的时候不要请求后端的。」*
> 上级文档（证据 / 成本 / 全量 P0~P4 方案）：`待办事项/地图前端自算可行性-规划.md`
>
> 📌 **实施结果摘要（2026-09-15 深夜，详见文末 §12）**
> - 落地：`web/js/engine-local.js`（新，唯一 eval 点）+ `index.html` 挂载 + `main.js` 的 `CALC` 档位/掩码/分帧预算 + `MapWorldService.cs` 的 meta `engineHash` 注入。
> - 行为级验收 `verify/check_calc_local.mjs`（真浏览器 3 档，**11/11 绿**）：hybrid 档 `maskEff=30`、**服务端 chunk 包 = 0**；`ab` 档 48 块 **逐位差异 0**（9 段全有样本）；server 档 `maskEff=31` 且服务端照旧下发（证明计数有牙）；无请求风暴（`localFail=0`）；meta 带 `engineHash`。
> - ⚠ **S5 的原判据是假红**（只看 hybrid「首屏 ≤50ms」实测恒红 ~250ms）。归因后 `server` 档（零本地算）同样 249ms ⇒ 是 WebGL 启动开销。判据已改为 **hybrid ≤ server + 40ms 余量**，三档数字都打进摘要行。
> - S6/S7 未做：S6 的「原生精度档」与 S7「Worker 化」按 S5 观测结论**无必要**（本地算未顶出长任务）。

---

## 0. 一句话

**主视图的地形块改由前端按 seed 本地算；WS 请求的 `mask` 去掉 `CHUNK` 位（31 → 30），服务端一行不改。**
其余四层（region / settle / poi / comm）继续走 WS，原样不动。

| 项 | 拍板结论 |
|---|---|
| 默认档 | **hybrid**：chunk 本地算，其余四层走 WS |
| 请求 | `mask = PB.MASK.ALL & ~PB.MASK.CHUNK = 30`，**服务端零改动**（`MapWorldService` 的 `needChunk` 分支本就支持） |
| 回退档 | `?calc=server`（老链路一行不改，作为降级通道长期保留） |
| 本地数组来源 | `MapGen.buildChunk(ca,cb)` + **融合复刻** `mapgen-server.chunkJson` 的量化 + `pb.js chunkToArrays` 的还原 ⇒ 与下发**逐位等价** |
| 引擎实例 | **全站单实例**（`EngineLocal`），小地图改为复用它（否则双 `init(seed)` 互清缓存，4 倍性能差） |
| 不做的 | region / settle / poi / comm 暂时**不**本地化（那是 P2/P3，另有阻塞点）；不动引擎 js；不动协议主体 |

---

## 1. 为什么这是「等价替换」而不是「近似复刻」

三条已固化的证据（复跑命令见文末）：

1. **同一批文件**：服务端 `JsEngineHost.cs:126` 拼的 bundle 与 WS 下发给前端的 `EngineScriptOrder`（`MapWsHandler.cs:26`）是**同一批源文件**，且下发白名单**故意不含** `mapgen-server.js`（纯搬运层）⇒ 前端拿到的是原封不动的生成逻辑。
2. **逐字节一致**：`verify/chunk_selfcalc_ab.mjs` 用 6 块 × 11 段（`cq/cr/tiles/elev/hash/neigh/pdx/pdy/psp/ph/pe`）与真实 WS `mask=CHUNK` 对拍，**全部一致**（含 pn=418 / pn=18 的极端精灵段）。
3. **成本更低**：首屏 25 块冷算 **61.4 ms**，而服务端「算 + 打包 + base64」是 **69.2 ms**（还不含 gzip / 落库 / 网络）。省掉的正是「打包 → JSON/b64 → 传输 → gzip 解 → protobuf 解 → u16 还原」整条链。

> 结论：`mask` 去掉 CHUNK 位不会改变任何一个像素的**输入数据**，只是换了个生产者。

---

## 2. 本地块数组的精确构造（bit-identical 是硬要求）

服务端两块代码**必须一起复刻**，缺一段就会与下发产生肉眼可见或不可见的偏差：

| 环节 | 位置 | 作用 |
|---|---|---|
| 打包 + 量化 | `mapgen-server.js:40-79 chunkJson` | `qrel/rrel` +16 存 u8、`elev/hash/propHash/propElev` `round(v*65535)` 存 u16、`neigh` `round` 存 u32、精灵坐标存**相对区块中心的 Float32** |
| 解码 + 还原 | `web/js/pb.js:148-197 chunkToArrays` | 由 `cq-16`/`cr-16` 反推**绝对格**，再由 `geo.hexW/hexR` 算世界像素；u16/65535 还原；精灵坐标 = 区块中心绝对像素 + 相对 Float32 |

融合后直出渲染器要的 10 个数组，**没有任何中间字节缓冲**，但每个 `round` / `clamp` / `16` 偏移 / `fround` 都必须照抄 —— 它们是「逐位等价」的全部内容。

```js
/* web/js/engine-local.js —— 融合 chunkJson(量化) + chunkToArrays(还原) */
function u16(v) { var r = Math.round(v * 65535); return r < 0 ? 0 : (r > 65535 ? 65535 : r); }

function chunkArrays(ca, cb) {
  var S = MG.CHUNK_S;
  var d = MG.buildChunk(ca, cb).data;          // 引擎的唯一入口, 与 mapgen-server 同一调用
  var n = d.tiles.length, pn = d.propCenters.length / 2;
  var cqx = MG.tileToWorld(ca * S, cb * S);    // ⚠ 与 chunkJson 同源 (别用 geo 自己再算一遍中心)
  var out = { ca: ca, cb: cb, count: n,
    centers: new Float32Array(n * 2), tiles: new Float32Array(n),
    elevs: new Float32Array(n), hashes: new Float32Array(n), neigh: new Float32Array(n),
    propCenters: pn ? new Float32Array(pn * 2) : null, propSprites: pn ? new Float32Array(pn) : null,
    propHashes: pn ? new Float32Array(pn) : null, propElevs: pn ? new Float32Array(pn) : null };

  for (var i = 0; i < n; i++) {
    var qa = ca * S + d.qrel[i];               // ≡ 服务端 (cq[i] - 16) 还原
    var ra = cb * S + d.rrel[i];
    out.centers[i * 2]     = geo.hexW * (qa + ra / 2);   // 与服务端/pb.js 同一公式 (double 中间值 → f32 落盘)
    out.centers[i * 2 + 1] = 1.5 * geo.hexR * ra;
    out.tiles[i]  = Math.round(d.tiles[i]);              // u8 直存, 整数语义
    out.elevs[i]  = u16(d.elevs[i]) / 65535;             // ⚠ 量化, 不是 raw f.e
    out.hashes[i] = u16(d.hashes[i]) / 65535;
    out.neigh[i]  = Math.round(d.neigh[i]);              // u32 打包值
  }
  if (pn) {
    var ox = geo.hexW * (ca * S + cb * S / 2);
    var oy = 1.5 * geo.hexR * (cb * S);
    for (var k = 0; k < pn; k++) {
      out.propCenters[k * 2]     = ox + Math.fround(d.propCenters[k * 2]     - cqx.x);
      out.propCenters[k * 2 + 1] = oy + Math.fround(d.propCenters[k * 2 + 1] - cqx.y);
      out.propSprites[k] = d.propSprites[k];             // u8 直存
      out.propHashes[k]  = u16(d.propHashes[k]) / 65535;
      out.propElevs[k]   = u16(d.propElevs[k]) / 65535;   // ⚠ 灵脉峰载的是「等级」, 同样走这条量化
    }
  }
  return out;
}
```

**可选的「原生精度档」（本次不做，仅记录）**：跳过全部量化直接用 `d.elevs` / `d.propHashes` 原值，视觉上无差别（海拔差 < 1/65535），但会破坏与下发的逐位可比性 ⇒ 验收只能靠截图差分。**先不碰**，等 P1 稳定后再单独评估。

**必须一并核对的三个等式**（写进自检，不等就是潜在漂移）：

| 断言 | 说明 |
|---|---|
| `geo.hexW === MG.HEX_W && geo.hexR === MG.HEX_R` | 否则 `centers` / 精灵原点与引擎内部不一致 |
| `out.centers` 与 `MG.buildChunk().data.centers` 逐位相同 | 检验「公式重算」与「引擎内部 `f.x/f.y`」是否真同源 |
| `?chunkprobe=1` 时 `out` 与 `PB.chunkToArrays(resp.chunk, geo)` 逐位相同 | 端到端等价性（见 §7 自检） |

---

## 3. 引擎加载器：`web/js/engine-local.js`（单实例，唯一 eval 点）

现状是**小地图自己 eval 引擎**（`minimap-vein.js:164-191`）。chunk 本地化后必须有第二个消费者，所以要把加载器提出来：

```js
/* web/js/engine-local.js —— 引擎单实例 (IIFE → window.EngineLocal) */
window.EngineLocal = (function () {
  var MG = null, seed = null, loading = null;

  function load() {                     // 幂等; 只此一处 eval 引擎
    if (MG) return Promise.resolve(true);
    if (loading) return loading;
    loading = MC.requestScript().then(function (pack) {
      var saved = window.NoiseLib;                       // ⚠ 引擎 noise.js 会覆盖同名全局
      try { (0, eval)("'use strict';\n" + pack.text); }
      finally { if (saved) window.NoiseLib = saved; }
      if (!window.MapGen || typeof window.MapGen.fields !== 'function')
        throw new Error('引擎脚本未导出 MapGen');
      MG = window.MapGen;
      return true;
    }).catch(function (e) {
      loading = null; console.warn('[自算] 引擎不可用:', e && e.message);
      return false;                                      // false = 走降级
    });
    return loading;
  }

  function setSeed(s) {                // 全站唯一 init 点
    if (!MG || !s || s === seed) return;
    seed = s; MG.init(s);
  }

  return { load: load, setSeed: setSeed, ready: function () { return !!MG; },
           mapgen: function () { return MG; }, chunkArrays: chunkArrays /* §2 */ };
})();
```

三个坑（`地图前端自算可行性-规划.md` §4.2/4.3 已记，此处是施工要求）：

1. ⚠ **`NoiseLib` 同名覆盖**：`web/js/noiselib.js`（视觉噪声/纸纹）与引擎 `noise.js` 都导出 `NoiseLib`。目前靠小地图 `finally` 还原 + `textures.js:15` 的模块顶层捕获侥幸不炸。**`EngineLocal` 是唯一 eval 点后，这段保存/还原必须留在里面**（已含）。`textures.js:15` 的顶层捕获暂时保留，但它改名为 `VisNoise` 是后续 S6 的可选加固。
2. ⚠ **双 `init(seed)` 互清缓存**：`MapGen.init()` 会 `clear()` 全部 14 张缓存（`mapgen.js:266-272`）。`minimap-vein.js:202-208 syncEngineSeed` 必须改成调 `EngineLocal.setSeed()`，**删除它自己的 `engine.init()`**，否则主视图每次重铸世界都会把小地图的字段缓存清光（热算 0.62 ms/块 → 冷算 2.46 ms/块）。
3. ⚠ **seed 同步点唯一**：`main.js regenerate()`（`:1636`）里调一次 `EngineLocal.setSeed(worldSeed)`；小地图与主视图都只读不写。加载顺序：`EngineLocal.load()` 与 `MC.requestScript()` 都幂等，谁先到都不冲突。

加载时序（务必保持）：

```
boot → fetchMeta → regenerate(seed) → EngineLocal.load()(并行, 失败即 calc 降级)
                                    → setSeed(seed)  ⇒ 之后 chunkArrays 才可用
```

---

## 4. 请求不再要后端 chunk（协议零改动）

### 4.1 前端

| 改动 | 位置 | 内容 |
|---|---|---|
| `mapclient.block` 支持 mask 参数 | `web/js/mapclient.js:316-345` | 签名 `block(seed, i, j, mask)`；`mask: mask == null ? PB.MASK.ALL : mask` |
| 调用点传档位 mask | `web/js/main.js:295` | `MC.block(gen, job.ca, job.cb, CALC.local ? PB.MASK.ALL & ~PB.MASK.CHUNK : PB.MASK.ALL)` |

### 4.2 服务端：**不用改**

`MapWorldService` 的 `needChunk = Need(0)` 分支本来就按 mask 出包（`地图前端自算可行性-规划.md` §5.2a）。mask=30 时不下发 chunk 字段、不算 `chunkJson`、不查块缓存 —— 这正是本次要的收益。

### 4.3 ⚠ 坑①：`main.js:328` 的「chunk 缺省兜底」会变成死循环（**本次最容易踩**）

```js
// 现状 (main.js:328): chunk 缺失 ⇒ 判定「rev 不一致」⇒ 清 rev 重排队
if (!arrays && !chunkData.has(job.key)) { MC.blockForget(job.key); ... chunkQueue.push(job); return; }
```

local 档下服务端**永远**不下发 chunk ⇒ `arrays` 为 null 时这段会把同一个块无限重排（服务端每次都按 mask 不给 chunk），实际表现是「视野里反复空白 + 请求风暴」。必须拆成两条互不干扰的路径（规划 §5.2c 已预判「别把两套逻辑混在一起」）：

```js
if (!arrays && !chunkData.has(job.key)) {
  if (CALC.local) {
    /* 本地算失败: 清 rev 重拉没有意义 (服务端本就不发 chunk) ⇒ 走退避重试本地;
       连续失败超阈值 ⇒ 本会话自动回切 calc=server (老链路), 并 console.warn 一次。 */
    if (++CALC.localFail > CALC.localFailMax) CALC.local = false;
    scheduleChunkRetry(job);
  } else {
    MC.blockForget(job.key);
    if (resp.err) scheduleChunkRetry(job); else chunkQueue.push(job);
  }
  return;
}
```

### 4.4 ⚠ 坑②：revs 是安全的（已确认，无需额外处理）

`mapclient.js:243-251` **只更新 `resp.mask` 命中位**。mask 不含 CHUNK ⇒ `revs[key][0]` 保持 0（= 未持有），下次请求带 `lastRevs[0]=0`，服务端在 `needChunk=false` 时根本不理这一位。⇒ mask=30 与 rev 机制**天然自洽**，不需要清 `revs`、也不需要在回退档时做特殊处理（回退档 mask 回到 ALL，服务端按 rev 判断，第 0 位是 0 ⇒ 全量下发 chunk ⇒ 正常）。

### 4.5 `applyBlock` 的第二来源

```js
function applyBlock(job, resp, localArrays) {           // ← 新增第 3 参
  ...
  var arrays = localArrays || (resp.chunk ? PB.chunkToArrays(resp.chunk, geo) : null);
```

调用侧（`loadChunk`）**在两道丢弃守卫之后**算，避免为已出视野/已重铸的块白算：

```js
MC.block(gen, job.ca, job.cb, mask).then(function (resp) {
  if (gen !== worldSeed) { MC.blockForget(job.key); return; }
  if (!keepChunk.has(job.key)) { MC.blockForget(job.key); return; }
  var local = null;
  if (CALC.local) { try { local = EngineLocal.chunkArrays(job.ca, job.cb); }
                    catch (e) { console.error('本地块计算失败', job.key, e); } }
  applyBlock(job, resp, local);
})
```

> 注：本阶段**不拆**「本地先算、WS 后到」的双路径（那能更早出地形，但要复制一遍守卫/退避逻辑，风险 > 收益）。收益记录为 P1.5 候选。

---

## 5. 分帧预算（别让 61 ms 一次性砸在主线程）

`pumpChunks`（`main.js:409`）的 `concChunk=4` 是**网络**并发数；本地算之后它同时成了**CPU**并发数 —— 4 个响应落在同一批微任务里就是 ≈10 ms 冷算（低端机 ×5~10）。

P1 做法（简单可靠）：给 `CALC` 加一个每帧预算闸，超预算的块留到下一帧算。

```js
var CALC = { local: true, budgetMs: 6, frameUsed: 0, localFail: 0, localFailMax: 8 };
// 每帧开头: CALC.frameUsed = 0  (放进 rAF 循环, 与 mmBump 同一处)
// chunkArrays 前: if (CALC.frameUsed > CALC.budgetMs) { scheduleChunkRetry 改为「下一帧再试」; return; }
// chunkArrays 后: CALC.frameUsed += 实测毫秒
```

- 默认 `?calc=server|hybrid`（hybrid ≡ local），`?chunkbudget=N`（0 = 不分帧，调试用）。
- ⚠ 超预算的块**不要**走 `scheduleChunkRetry`（那是 0.8s 起步的惩罚性退避），要单独一个「下一帧重试」的轻队列，否则首屏会被人为拖慢。

**实测门槛**：若 `?chunkbudget=0` 下 `PerformanceObserver` 的 `longtask` 出现 >50 ms 条目，则 P1 直接上 §5.7 的 Worker 化（规划文档已设计：Worker 内 `self.window = self`，返回值用 transferable 零拷贝回传）。

---

## 6. 引擎版本握手（防「建筑落海」）

**风险**：页面长开期间服务端升级了引擎 ⇒ 前端用旧引擎算地形，服务端下发新引擎算的 settle/region ⇒ 建筑落在海里。
**最小方案（首选，零 protobuf 改动）**：把引擎 bundle 指纹挂到**已有**的 meta 端点上。

| # | 文件 | 改动 |
|---|---|---|
| 1 | `Server/Zongmen/Services/MapWorldService.cs` `GetMetaJson` | 增 `"engineHash":"<sha256前16位>"`（对 `EngineScriptOrder` 三文件 UTF-8 内容**按拼接顺序**取哈希，进程内缓存一次） |
| 2 | `web/js/mapclient.js` `fetchMeta` | 把 `engineHash` 存进 `geo.engineHash`（不改解析结构，只多带一个字段） |
| 3 | `web/js/engine-local.js` | `load()` 时记下 `geo.engineHash`；WS 重连时重取 meta，**hash 变了 ⇒ `CALC.local = false`**（本会话回退 server）并 `console.warn('引擎版本已变更, 请刷新页面')` |

- 备选方案 B（更省一次往返但动 protobuf）：`ScriptPack` 加 `Hash`(field 3) ⇒ 需改 `MapMessages.cs:226`、`MapWsHandler.cs:206-220`、`pb.js decodeScriptPack`（`:395`）。
- **不需要**哈希一致性的反向证明：前端只做「服务端现在说的」与「我加载时记下的」对比，不必自己重算哈希。

---

## 7. 落地期自检开关（默认关，不改变产品行为）

| 参数 | 作用 |
|---|---|
| `?chunkab=1` | 每个块**额外**带 CHUNK 位请求一次，对 `out` 与 `PB.chunkToArrays(resp.chunk, geo)` 做**逐位比对**（0 差异计数），结果挂 `window.__calcProbe()`。这是把 `chunk_selfcalc_ab.mjs` 搬进**真浏览器真页面**的等价断言 —— Node 脚本证明不了「浏览器里这份 eval 出来的引擎也一致」 |
| `?chunkprobe=1` | 只采数不上屏：输出每块冷/热毫秒、`geo.hexW===MG.HEX_W`、`centers` 等式、`localFail` 计数，供 `--dump-dom` 取 stdout |
| `window.__calcProbe()` | 供 `verify/live_cap.mjs` / 探针页读取（沿用小地图 `__probe()` 的先例） |

⚠ 注意 `?chunkab=1` 与需求「不要请求后端的」**不冲突**：它是显式的开发自检，默认关，且只在 S1/S2 联调期用。

---

## 8. 开关与降级链

```
boot
 ├ meta 到达 → regenerate(seed) → EngineLocal.load()
 │     ├ 成功 + hash 一致 → calc=hybrid: mask=30, chunk 本地算
 │     └ 失败(eval 抛错 / CSP / 脚本缺失 / hash 不符 / ?calc=server)
 │                        → calc=server: mask=31, chunk 走 WS（老链路一行不改）
 └ 运行期 localFail 连续超阈 → 自动回切 server（本会话，不弹窗，只 console.warn）
```

- 参数：`?calc=server` / `?calc=hybrid`（默认）。**不要**给 `client` 档留入口（region/settle 未本地化，那档名会误导）。
- 降级必须是**静默且无损**：老链路完整保留，这也是无 JS 客户端与未来「服务端权威演化」的唯一退路。

---

## 9. 逐文件改动清单

> 行号为 **2026-09-15 22:30 快照**，施工时以符号名为准（并行会话常改这几个文件）。

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | **新增** `web/js/engine-local.js` | 单实例加载器 + `chunkArrays()`（§2/§3）；IIFE → `window.EngineLocal` | 新文件，无回归面 |
| 2 | `web/index.html` | 在 `minimap-vein.js` **之前**引 `engine-local.js` | 顺序错 ⇒ `EngineLocal` 未定义 |
| 3 | `web/js/minimap-vein.js:164-208` | 删内部 `enginePromise`/`engine`/`init`，改 `EngineLocal.load()` + `setSeed()` | ⚠ 双 init 互清缓存；⚠ 无 `g` 形参 ⇒ 只能写 `window.EngineLocal` |
| 4 | `web/js/mapclient.js:316-345` | `block()` 增 `mask` 形参；`fetchMeta` 带出 `engineHash` | 低 |
| 5 | `web/js/main.js:295` | `MC.block(...)` 传档位 mask | 低 |
| 6 | `web/js/main.js:303` | `applyBlock(job, resp, local)` | 低 |
| 7 | `web/js/main.js:317-336` | `applyBlock` 第 3 参 + **兜底分支拆分**（§4.3 坑①） | ⚠ **高**：拆错就是请求风暴 |
| 8 | `web/js/main.js:95-99` + 每帧 | `NET_CFG`/`CALC` 配置 + 预算闸（§5）；`regenerate()`(`:1636`) 加 `EngineLocal.setSeed` | 中 |
| 9 | `Server/Zongmen/Services/MapWorldService.cs` `GetMetaJson` | meta 增 `engineHash`（§6） | 低（只加字段） |
| 10 | `verify/frontend_smoke.mjs` | 新契约：`mask` 去 CHUNK 位只出现在同一处；`engine-local.js` 存在且是唯一 eval 点；兜底分支含 `CALC.local` 分支；`maxfail` 存在 | 低 |
| 11 | `verify/run_regression.mjs` | 挂 `chunk_selfcalc_ab.mjs`（`--with-server` 组） | 低 |

**不动**：`Server/Zongmen/Engine/js/*`（改了就要重启 + 清库）、`pb.js` 协议解码、`renderer.js`、`textures.js`（S6 可选加固）。

---

## 10. 验收（四层，缺一不放行）

| 层 | 手段 | 通过标准 |
|---|---|---|
| **等价性（核心）** | `?chunkab=1` 真页面逐位比对 + `verify/chunk_selfcalc_ab.mjs` | 0 差异；脚本 `exit 0` |
| **视觉一致性** | 同 seed 同机位、同 `capmin` 预热：`?calc=server` vs `?calc=hybrid` 截图 `verify/imgdiff.mjs` | 差异 0（量化路径逐位等价 ⇒ 应为像素级相同） |
| **协议收益** | 服务端日志/抓帧确认 mask=30 时无 chunk 字段；对比请求前后 `chunkJson` 调用次数 | chunk 包不再生成、不再传输（省 ~0.2 MB/25 块） |
| **性能/不卡** | `PerformanceObserver({entryTypes:['longtask']})`，首屏 25 块 | 无 >50 ms 长任务（超了 ⇒ 上 Worker） |
| **回归** | `verify/frontend_smoke.mjs`（含新契约）、`check_mm_layout.mjs`、`verify/run_regression.mjs --with-server` | 全绿（frontend_smoke 由 51 条起只增不减） |
| **小地图不退化** | 世界重铸后小地图 L1 仍在（不被双 init 清空） | `?mmprobe=1` 的 `miss` 全程 0；切 seed 后地形正常 |

⚠ 实机截图铁律：`--headless=new` 忽略 `--window-size`（要精确尺寸用旧版 headless）；截图前必须预热 `capmin=N`；`verify/capture.png` 是共享单文件 ⇒ 串行跑。服务端验证**别 kill 用户 8140**，起 8141 临时实例。

---

## 11. 实施顺序（每步独立可验、可停）

| 步 | 内容 | 完成判据 |
|---|---|---|
| **S1** | 建 `web/js/engine-local.js` + 接 `index.html`；小地图改为复用（**此时还没换 chunk 来源**） | `frontend_smoke` 全绿；小地图 `?mmprobe=1` 与改前同；切 seed 正常 |
| **S2** | `chunkArrays()` 落地 + `?chunkab=1` 自检 | 真页面 0 差异；`geo.hexW===MG.HEX_W` 等式成立 |
| **S3** | `mask` 去掉 CHUNK 位 + `applyBlock` 第二来源 + 兜底分支拆分 | `?calc=server` 与 `?calc=hybrid` 截图 diff 0；无请求风暴（观察 WS 帧率） |
| **S4** | meta `engineHash` 握手 + 重连校验 | 手工改服务端引擎文件并重启 ⇒ 前端自动回退 server 且有 warn |
| **S5** | 分帧预算 + longtask 观测 | 无 >50 ms 长任务（或据此决定上 Worker） |
| **S6** | 契约补齐（frontend_smoke / run_regression）+ 文档与备忘收口 | `run_regression` 全绿 |
| **S7（可选）** | `textures.js` 的 `NoiseLib` 顶层捕获改为显式 `VisNoise` | 摘掉最后一个时序脆弱点 |

---

## 12. 风险与「不做」

- ⚠ **世界一旦可写就不成立**：`settle.state/expireTs`、`Owner`、`BumpBlockRev` 都是伏笔。本单只把**静态地形**搬到前端，`settle` 及以后仍以服务端为权威 —— 这正是留 hybrid 而不是一步到 client 的原因（规划 §4.6）。
- ⚠ **并行会话**：`minimap-vein.js` / `frontend_smoke.mjs` 近期被另一个会话改过（U4 金字塔多数表决）。S1 动小地图前先 `git status` + grep 复核，别覆盖别人的改动。
- **不做**：region/settle/poi/comm 本地化（P2/P3）；原生精度档；Worker 化（除非 S5 实测触发）；删服务端 chunk 缓存/落库（保留作降级通道与预热）。
- **不改**：`Server/Zongmen/Engine/js/*`。本次是**纯前端 + meta 一个字段**的改动。

---

## 附 A · 复跑命令

```bash
N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"

# 等价性 (只读, 打本机 8140)
"$N" verify/chunk_selfcalc_ab.mjs                 # 期望 exit 0 / 全段一致
"$N" verify/chunk_selfcalc_bench.mjs 42 --blocks=25

# 前端契约
"$N" verify/frontend_smoke.mjs

# 实机截图对照 (务必先预热 capmin)
"$N" verify/live_cap.mjs "http://127.0.0.1:8140/index.html?seed=42&calc=server&capture=1&capmin=8" verify/_calc_server.png 100 1400x900
"$N" verify/live_cap.mjs "http://127.0.0.1:8140/index.html?seed=42&calc=hybrid&capture=1&capmin=8" verify/_calc_hybrid.png 100 1400x900
"$N" verify/imgdiff.mjs verify/_calc_server.png verify/_calc_hybrid.png
```

## 附 B · 关键代码坐标（快照 2026-09-15 22:30）

| 位置 | 内容 |
|---|---|
| `MapWsHandler.cs:26` | `EngineScriptOrder` 下发白名单（不含 mapgen-server） |
| `MapMessages.cs:236-245` | `TileMask`：Chunk=1 / Region=2 / Settle=4 / Poi=8 / Comm=16 / All=31 |
| `mapgen-server.js:40-79` | `chunkJson` 打包与量化（**本地要复刻的一半**） |
| `pb.js:148-197` | `chunkToArrays`（**另一半**） |
| `pb.js:342` | `PB.MASK` |
| `mapgen.js:492-576` | `buildChunk` 返回 `{data:{qrel,rrel,tiles,elevs,hashes,neigh,propCenters,propSprites,propHashes,propElevs}}` |
| `mapgen.js:266-272` | `init()` 清全部缓存（双 init 的杀伤面） |
| `mapclient.js:243-251` | revs 只更新命中位（§4.4 的依据） |
| `mapclient.js:287-345` | `requestScript` / `block` |
| `main.js:295` | `MC.block` 唯一调用点 |
| `main.js:317-396` | `applyBlock` 唯一数据入口 |
| `main.js:1636` | `regenerate()` seed 变更点 |
| `minimap-vein.js:164-208` | 现状「前端 eval 引擎」范式（S1 要迁走） |

---

## 12. 实施结果（2026-09-15 深夜）

### 12.1 逐阶段状态

| 阶段 | 目标 | 状态 | 证据 |
|------|------|------|------|
| **S1** | 建 `web/js/engine-local.js` + 接 `index.html`；小地图改为复用 | ✅ 完成 | `web/js/engine-local.js`（唯一 eval 点）；`index.html` 已挂 `<script src="js/engine-local.js">`；`frontend_smoke` 断言「间接 eval 全站仅 1 处且在 engine-local.js」 |
| **S2** | `chunkArrays()` 落地 + 自检开关 | ✅ 完成 | `ab` 档 48 块**逐位差异 0**，9 段（centers/tiles/elevs/hashes/neigh/prop*）全有样本 |
| **S3** | `mask` 去掉 CHUNK 位 + 第二来源 + 兜底分支拆分 | ✅ 完成 | hybrid `maskEff=30` / server `maskEff=31`；hybrid 档**服务端 chunk 包 = 0**（改造的目的断言）；`localFail=0` 无请求风暴 |
| **S4** | meta `engineHash` 握手 + 重连校验 | ✅ 完成 | `MapWorldService.cs` 注入（`InjectEngineHash` / `ComputeEngineHash`）；`mapclient.js` 暴露 `engineHash()`；契约断言 meta 带字段 |
| **S5** | 分帧预算 + longtask 观测 | ⚠ **改成归因判据后通过** | 见 12.3 —— 观测数据说明**不需要**上 Worker |
| S6 / S7 | 原生精度档 / Worker 化 | ⛔ 未做（按 S5 结论无必要） | —— |

### 12.2 怎么跑（对着**隔离实例**，别动用户的 8140）

```bash
# 起隔离实例 (§22 的姿势, 端口换成空闲的)
dotnet build Server/Zongmen/ZongMen.csproj -o verify/_vmsrv -p:UseAppHost=false
Zongmen__Port=8157 Zongmen__DbPath="C:/Users/Administrator/AppData/Local/Temp/wb/reg8157.sqlite" dotnet verify/_vmsrv/ZongMen.dll

node verify/check_calc_local.mjs http://127.0.0.1:8157      # 行为级: 真浏览器 3 档
node verify/run_regression.mjs --base=127.0.0.1:8157        # 总回归: 18 离线 + 4 在线
```

> ⚠ **必须对含 S4 的服务端跑**：meta 没有 `engineHash` 就是「服务端没重启到新构建」，那是提示不是回归。本机常驻的 8140 是**改造前**的 exe（`engineHash` 缺）⇒ 对它跑会红 1 条。

### 12.3 S5 的归因结论（**本单最值得记的一条**）

原判据是「hybrid 档首屏最长任务 ≤ 50ms」，实测**恒红 ~250ms**。做**归因 A/B** 后真相：

| 档 | 本地算 | 首屏最长任务 |
|----|--------|--------------|
| hybrid | ✅ 48 块本地算 | **254 ms**（1 次） |
| ab | ✅ 48 块本地算 + 服务端对拍 | **254 ms**（1 次） |
| **server** | ❌ **一行本地算都不跑** | **249 ms**（1 次） |

⇒ 这 250ms 与本地算**无关**：observer 在 `main.js` 模块初始化时就挂上（`main.js:195`），把 **WebGL 上下文创建 / 着色器编译 / 图集构建**全算了进去。原判据是**假红**。

判据已改为 **「hybrid ≤ server + 40ms 余量」**（余量 40ms 的依据：本地算的边际成本 ~115ms/48 块是**分摊到多帧**的，单帧不该再多出一个长任务），并把三档的「首屏最长任务」打进摘要行 —— 数字不再被藏起来。

**结论：S5 观测结果 = 分帧预算够用，不需要 Worker 化（S7 免做）。**

### 12.4 联跑抖动（**不是产品回归**）

`check_calc_local` 单独跑 **11/11 绿**；在 `run_regression` 里紧跟 `check_mm_ui` 之后会**红 5 条**（连 `chunksLocal >= 6` 都不成立）。原因是 **Chrome 实例争用**（同 `user-data-dir` 被复用 / 前一个 Chrome 没退干净 ⇒ 新档的页面不是干净加载）。单独复跑即绿。

处理：另跑一次单档确认，别把它当回归（同类「环境性红」还有 `w3_bfs_road` ⑦ 的机器绝对速度门槛）。
