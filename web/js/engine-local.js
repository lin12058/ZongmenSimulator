/* ============================================================
 * engine-local.js — 地图生成引擎 · 浏览器侧**单实例**加载器
 * ------------------------------------------------------------
 * 职责 (就三件, 别加第四件):
 *   ① load()      —— 唯一 eval 点: 向 WS 要引擎脚本 (ScriptPack) 并间接 eval,
 *                    产出 window.MapGen。幂等, 失败返回 false (调用方降级)。
 *   ② setSeed(s)  —— 唯一 init(seed) 点。幂等; 引擎还没到货时先记账,
 *                    load 完成后自动补 init (启动期二者是并发竞速的)。
 *   ③ chunkArrays(ca,cb) —— 按 seed **本地算**一个地形块, 直出渲染器要的
 *                    10 个数组。与「服务端下发 + pb.chunkToArrays」逐位等价 (见下)。
 *
 * 为什么必须单实例 (历史坑):
 *   · MapGen.init() 会 clear() 引擎内全部 14 张缓存 (mapgen.js init) ⇒ 两个实例/
 *     两次 init 会让对方已算好的格全部作废: 热算 0.62ms/块 ⇒ 冷算 2.46ms/块 (实测 4×)。
 *     故本文件是全站唯一 eval 与唯一 init 点, 小地图与主视图都只**读**。
 *   · window.NoiseLib 同名覆盖: web/js/noiselib.js (视觉噪声/纸纹) 与引擎 noise.js
 *     导出同名全局。引擎 IIFE 期已捕获自己的引用 ⇒ 执行前后保存/还原没有副作用,
 *     但**只能**在这一处做 (eval 点只有一个, 别的地方没有机会)。
 *
 * chunkArrays 的「逐位等价」是怎么来的:
 *   服务端把权威结果先量化再下发 (mapgen-server.chunkJson), 客户端再还原
 *   (pb.js chunkToArrays)。本函数把这两半**融合复刻**成一步, 没有任何中间字节缓冲 ——
 *   但每个 round / clamp / +16 偏移 / fround 都必须照抄, 它们是等价的全部内容。
 *   证据: verify/chunk_selfcalc_ab.mjs (段级逐字节) + verify/frontend_smoke.mjs
 *         (真页面数组级) —— 改这里之前先跑它们。
 *   ⚠ 精灵坐标必须走 Math.fround (服务端以 Float32 落盘), 直接相减会用 double 精度,
 *     与下发差 1e-7 级 ⇒ 渲染看不出, 但逐位比对会红。
 * ============================================================ */
(function (g) {
  'use strict';

  var MC = g.MapClient || null;      // Node 侧 (verify 脚本) 无此依赖, 允许缺省

  var MG = null;                     // window.MapGen — 全站唯一实例
  var loading = null;                // load() 幂等句柄 (Promise<boolean>)
  var wantSeed = null;               // 最近一次 setSeed 的目标
  var seed = null;                   // 已真正应用给引擎的 seed
  var lastError = '';

  /* S4 握手: 加载时的引擎指纹 + 「服务端已升级」判定 */
  var hashAtLoad = null, hashStale = false;

  /* ---------- ① 加载 (唯一 eval 点) ---------- */
  function load() {
    if (MG) return Promise.resolve(true);
    if (loading) return loading;
    if (!MC || typeof MC.requestScript !== 'function') {
      lastError = 'MapClient.requestScript 不可用';
      return Promise.resolve(false);
    }
    loading = MC.requestScript().then(function (pack) {
      var saved = g.NoiseLib;                        // 引擎 noise.js 会覆盖同名全局
      try {
        (0, eval)("'use strict';\n" + pack.text);    // 间接 eval: 全局作用域, 等价 <script>
      } finally {
        if (saved !== undefined) g.NoiseLib = saved;
      }
      if (!g.MapGen || typeof g.MapGen.fields !== 'function') {
        throw new Error('引擎脚本已执行但未导出 MapGen');
      }
      MG = g.MapGen;
      applySeed();                                   // 启动期 setSeed 可能先到 (此时引擎未就绪)
      return true;
    }).catch(function (e) {
      loading = null;                                // 允许后续重试 (WS 刚断时)
      lastError = (e && e.message) || String(e);
      console.warn('[自算] 引擎脚本不可用, 地形块降级为服务端下发:', lastError);
      return false;
    });
    return loading;
  }

  /* ---------- ② 种子 (唯一 init 点) ---------- */
  function applySeed() {
    if (!MG || !wantSeed || wantSeed === seed) return false;
    seed = wantSeed;
    try { MG.init(seed); } catch (e) {
      console.warn('[自算] MapGen.init 失败', e);
      seed = null;
      return false;
    }
    return true;
  }
  function setSeed(s) {
    if (s == null || s === '') return false;
    wantSeed = String(s);
    return applySeed();
  }
  function ready() { return !!MG; }
  function mapgen() { return MG; }
  function currentSeed() { return seed; }
  function lastErrorText() { return lastError; }

  /* ---------- S4 引擎版本握手 ---------- */
  /* 页面长开期间服务端可能已升级引擎: 前端旧引擎算地形 + 后端新引擎发 settle/region
     ⇒ 坐标口径漂移 (极端表现: 建筑落海)。这里只做「服务端现在说的」与「我加载时
     记下的」对比 —— 前端不自己重算哈希 (没必要, 且会引入第二份实现)。 */
  function noteEngineHash(h) {
    if (h) hashAtLoad = String(h);
    return hashAtLoad;
  }
  function verifyHash(h) {
    if (!h || !hashAtLoad) return true;              // 任一侧缺失 ⇒ 不判定 (老服务端/老页面)
    if (String(h) === hashAtLoad) return true;
    if (!hashStale) {
      hashStale = true;
      console.warn('[自算] 服务端引擎版本已变更, 本会话回退服务端下发; 请刷新页面');
    }
    return false;
  }
  function hashStaleNow() { return hashStale; }

  /* ---------- ③ 本地块数组 (融合复刻 chunkJson 量化 + chunkToArrays 还原) ---------- */
  function u16q(v) {                                 // ≡ setUint16(clamp(round(v*65535)))
    var r = Math.round(v * 65535);
    return r < 0 ? 0 : (r > 65535 ? 65535 : r);
  }
  function geoOf(G) {
    if (G) return G;
    if (MC && typeof MC.geo === 'function') { try { return MC.geo(); } catch (e) { /* meta 未到 */ } }
    return null;
  }
  /* G (可选) = { hexW, hexR, chunkS }: 仅 verify 脚本在 Node 侧显式注入。
     ⚠ G.hexW 必须 === MG.HEX_W、G.hexR === MG.HEX_R, 否则 centers 与引擎内部不同源。 */
  function chunkArrays(ca, cb, G) {
    if (!MG) throw new Error('引擎未就绪 (EngineLocal.load 未完成)');
    var ge = geoOf(G);
    if (!ge) throw new Error('geo 未就绪 (meta 未到)');
    var S = MG.CHUNK_S, d = MG.buildChunk(ca, cb).data;
    var n = d.tiles.length, pn = d.propCenters.length / 2, i, k;

    var out = {
      ca: ca, cb: cb, count: n,
      centers: new Float32Array(n * 2),
      tiles: new Float32Array(n), elevs: new Float32Array(n),
      hashes: new Float32Array(n), neigh: new Float32Array(n),
      propCenters: pn ? new Float32Array(pn * 2) : null,
      propSprites: pn ? new Float32Array(pn) : null,
      propHashes: pn ? new Float32Array(pn) : null,
      propElevs: pn ? new Float32Array(pn) : null
    };
    for (i = 0; i < n; i++) {
      /* qrel/rrel 是整数轴向偏移 ⇒ 绝对格 ≡ 服务端 (cq-16) 还原 (无浮点往返) */
      var qa = ca * S + d.qrel[i], ra = cb * S + d.rrel[i];
      out.centers[i * 2]     = ge.hexW * (qa + ra / 2);
      out.centers[i * 2 + 1] = 1.5 * ge.hexR * ra;
      out.tiles[i]  = Math.round(d.tiles[i]);         // u8 直存 (整数语义)
      out.elevs[i]  = u16q(d.elevs[i]) / 65535;       // ⚠ 量化, 不是 raw f.e
      out.hashes[i] = u16q(d.hashes[i]) / 65535;
      out.neigh[i]  = Math.round(d.neigh[i]);         // u32 打包值
    }
    if (pn) {
      /* 精灵坐标: 服务端存「相对区块中心的 Float32」, 还原加回区块中心绝对像素 */
      var ccx = MG.tileToWorld(ca * S, cb * S);
      var ox = ge.hexW * (ca * S + cb * S / 2);
      var oy = 1.5 * ge.hexR * (cb * S);
      for (k = 0; k < pn; k++) {
        out.propCenters[k * 2]     = ox + Math.fround(d.propCenters[k * 2]     - ccx.x);
        out.propCenters[k * 2 + 1] = oy + Math.fround(d.propCenters[k * 2 + 1] - ccx.y);
        out.propSprites[k] = d.propSprites[k];        // u8 直存
        out.propHashes[k]  = u16q(d.propHashes[k]) / 65535;
        out.propElevs[k]   = u16q(d.propElevs[k]) / 65535;   // 灵脉峰载的是「等级」, 同走量化
      }
    }
    return out;
  }

  /* ---------- 自检 (仅 ?chunkprobe=1 / ?chunkab=1 用) ----------
     probe 是「事实出口」, 不参与任何业务判断: 供 --dump-dom / live_cap 读取。 */
  var stat = { built: 0, coldMs: 0, hotMs: 0, lastMs: 0, hexOk: null, centerMis: 0, checked: 0 };
  function probeReset() { stat.built = 0; stat.coldMs = 0; stat.hotMs = 0; stat.lastMs = 0; stat.centerMis = 0; stat.checked = 0; }
  function probe() {
    return {
      ready: !!MG, seed: seed, wantSeed: wantSeed,
      hashAtLoad: hashAtLoad, hashStale: hashStale, lastError: lastError,
      built: stat.built, lastMs: +stat.lastMs.toFixed(3),
      hexOk: (MG && MC && MC.geo) ? (function () {
        try { var ge = MC.geo(); return ge.hexW === MG.HEX_W && ge.hexR === MG.HEX_R; } catch (e) { return null; }
      })() : null,
      centerMis: stat.centerMis, centerChecked: stat.checked
    };
  }
  function noteBuild(ms) {
    stat.built++; stat.lastMs = ms;
    if (stat.built === 1) stat.coldMs = ms; else stat.hotMs = ms;
  }

  g.EngineLocal = {
    load: load, setSeed: setSeed, ready: ready, mapgen: mapgen,
    currentSeed: currentSeed, lastErrorText: lastErrorText,
    noteEngineHash: noteEngineHash, verifyHash: verifyHash, hashStale: hashStaleNow,
    chunkArrays: chunkArrays,
    probe: probe, probeReset: probeReset, noteBuild: noteBuild
  };
})(typeof window !== 'undefined' ? window : globalThis);
