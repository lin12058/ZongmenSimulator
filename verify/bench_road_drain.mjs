/* ============================================================
 * bench_road_drain.mjs — 道路生成性能/账本剖析 (mapgen.js)
 * ------------------------------------------------------------
 * ⚠⚠ 2026-09-14 起**已随 B 版退役, 直接跑会抛「注入点未找到」—— 这是预期行为**。
 *     B 版取消了「已建路格 2 费」的路廊复用 (折线改为只依赖「该边 + 静态地形」,
 *     换来顺序无关性), 本脚本剖析的对象正是那套复用机制:
 *       · drain (DI 重试队列逐条消化)      → 连同 diRetryQueue/drainMark 一并删除
 *       · deferred 延迟重试轮 / 入队        → 删除
 *       · roadTileIdx (已铺路格索引)        → 删除 (无读者)
 *       · mainAstar / mainDirectRetry 锚点 → 行文已改 (不再传 roadTileIdx)
 *     仍有效的锚点只有函数级计数器 (bfsRoad / search / fields / hexDist / cartDist /
 *     isqrt / rngDominated / scanDemandEdges / skeletonEdgesFor) 与 roadSet 三处入库点。
 *     若将来再需要剖析: 把 38~68 行里失效的 raw() 去掉 (只留函数级 entry + roadSet),
 *     审计口径改为「单次 A* 耗时分布 + 需求边命中率」—— B 版下这两个才是真瓶颈
 *     (实测 A* 占总耗时 70%, 其中「必败穷举」占失败类 33%)。
 * ------------------------------------------------------------
 * 手法: 读 mapgen.js 源码 → 字符串注入计数器 (只在内存副本, 不改源文件)
 *       → vm 里跑与 灵脉预览.html pumpRoads 相同的泵送序列。
 *       ⚠ 计数注入必须插在【分支内部】(整段替换);
 *         用「在签名后追加」的方式会落到 if 块之外 —— 带 continue/return
 *         的分支会被数成反面 (本项目已踩过两次)。
 * 加载序必须是 noise.js + mapgen-config.js + mapgen.js
 *  (漏 mapgen-config.js 会静默退回 mapgen.js 内置兜底参数)。
 * 用法: node verify/bench_road_drain.mjs [seed] [区域格半径=8]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSDIR = path.join(path.resolve(__dirname, '..'), 'Server', 'Zongmen', 'Engine', 'js');
const seed = process.argv[2] || 'seed-check';
const N = parseInt(process.argv[3] || '8', 10);

const C = {
  drainPop: 0, drainAstar: 0, drainNullPath: 0, drainRequeueFail: 0,
  drainDiRequeue: 0, drainBuilt: 0,
  mainAstar: 0, mainBuilt: 0, mainFailPush: 0, mainDirectRetry: 0, mainDeferPush: 0,
  bfsRoad: 0, search: 0, fields: 0, hexDist: 0, cartDist: 0, isqrt: 0,
  rngDominated: 0, scanDemandEdges: 0, skeletonEdgesFor: 0
};

/* ⚠ 工作区 core.autocrlf=true ⇒ 检出为 CRLF, 而下面的注入锚点是按 \n 拼接的多行字面量。
   必须先归一化行尾 (只在内存副本上做), 否则多行锚点全部失配、报「注入点未找到」。 */
let src = fs.readFileSync(path.join(JSDIR, 'mapgen.js'), 'utf8').replace(/\r\n/g, '\n');
const raw = (a, b) => { if (!src.includes(a)) throw new Error('注入点未找到: ' + a); src = src.replace(a, b); };
/* 进入即计数 (函数体首行) */
const entry = (sig, key) => raw(sig, sig + ' C.' + key + '++;');
/* 分支内部计数 (整段替换, 别追加) */
raw('        } else if ((qp.length - 1) * 10 > roadDI * hexDist(qa.q, qa.r, qb.q, qb.r)) {',
    '        } else if ((qp.length - 1) * 10 > roadDI * hexDist(qa.q, qa.r, qb.q, qb.r)) { C.drainDiRequeue++;');  // 绕行闸拒绝
/* ⚠ 入库点已由 cacheSet(roadCache,…) 改为 roadSet(…)（A4 引用计数）——
   锚点必须跟着改，否则报「注入点未找到」。三处建成点: 主循环 / DI 延迟重试轮 / drain。 */
raw('roadSet(dq.rkey, droad);', 'C.drainBuilt++; roadSet(dq.rkey, droad);');
raw('roadSet(de.rkey, road2);', 'C.mainBuilt++; roadSet(de.rkey, road2);');
raw('roadSet(rkey, road);', 'C.mainBuilt++; roadSet(rkey, road);');

entry('function bfsRoad(sq, sr, tq, tr, roadTiles) {', 'bfsRoad');
/* 单次 A* 耗时分布: 重命名后套计时 wrapper (只记录, 不影响返回值) */
raw('function bfsRoad(sq, sr, tq, tr, roadTiles) {', 'function bfsRoadInner(sq, sr, tq, tr, roadTiles) {');
raw('  function roadsNear(i, j, maxNew, cq, cr) {',
    '  function bfsRoad(){var __t=performance.now();try{return bfsRoadInner.apply(null,arguments);}finally{__T.push(performance.now()-__t);}}\n' +
    '  function roadsNear(i, j, maxNew, cq, cr) {');
entry('    function search(maxSteps) {', 'search');
entry('function fields(q, r) {', 'fields');
entry('function hexDist(aq, ar, bq, br) {', 'hexDist');
entry('function cartDist(q1, r1, q2, r2) {', 'cartDist');
entry('function isqrt(n) {', 'isqrt');
entry('function rngDominated(a, b, dab) {', 'rngDominated');
entry('function scanDemandEdges(i, j) {', 'scanDemandEdges');
entry('function skeletonEdgesFor(i, j) {', 'skeletonEdgesFor');
raw('      var dq = diRetryQueue.shift();', '      C.drainPop++; var dq = diRetryQueue.shift();');
raw('        var qp = bfsRoad(qa.q, qa.r, qb.q, qb.r, roadTileIdx);\n        if (!qp) {',
    '        C.drainAstar++; var qp = bfsRoad(qa.q, qa.r, qb.q, qb.r, roadTileIdx);\n        C.drainNullPath++; if (!qp) {');
raw('          if (tr3 >= 3) setAdd(roadFail, dq.rkey, ROADFAIL_CAP);   // 3 次仍无路: 终身不可达\n          else diRetryQueue.push(dq);',
    '          if (tr3 >= 3) setAdd(roadFail, dq.rkey, ROADFAIL_CAP);   // 3 次仍无路: 终身不可达\n          else { C.drainRequeueFail++; diRetryQueue.push(dq); }');
raw('        var path = bfsRoad(pA.q, pA.r, pB.q, pB.r, roadTileIdx);', '        C.mainAstar++; var path = bfsRoad(pA.q, pA.r, pB.q, pB.r, roadTileIdx);');
raw('          else diRetryQueue.push({ a: a, b: b, rkey: rkey });', '          else { C.mainFailPush++; diRetryQueue.push({ a: a, b: b, rkey: rkey }); }');
raw('        var direct = bfsRoad(pA.q, pA.r, pB.q, pB.r);', '        C.mainDirectRetry++; var direct = bfsRoad(pA.q, pA.r, pB.q, pB.r);');
raw('      diRetryQueue.push(deferred[d5]);', '      C.mainDeferPush++; diRetryQueue.push(deferred[d5]);');

const ctx = { window: {}, console, C, Math, Map, Set, performance, JSON, __T: [] };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['noise.js', 'mapgen-config.js']) {
  vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ctx);
}
vm.runInContext(src, ctx);
const MG = ctx.window.MapGen;
MG.init(seed);

const snap = () => ({ ...C });
const delta = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, b[k] - a[k]]));
const q = [];
for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
  if (MG.settlementsFor(i, j).some(s => s.type !== 'poi')) q.push([i, j]);
}
console.log(`seed=${seed}  队列 ${q.length} 格 (±${N} 区域格, 有可建路聚落)`);
console.log(`CFG: COST_MAX=${MG.CFG.ROAD_COST_MAX} STEPS_MAX=${MG.CFG.ROAD_STEPS_MAX} DI_MAX=${(MG.CFG.ROAD_DI_MAX10 / 10).toFixed(1)} W_ROAD=${MG.CFG.ROAD_W_ROAD}`);

/* ---- 冷建 (等价服务端 regionJson: 满预算) ---- */
ctx.__T.length = 0;
let s = snap(), t = performance.now();
for (const [i, j] of q) MG.roadsNear(i, j, 9999);
const msCold = performance.now() - t, roads = MG.roadCache.size;
let d = delta(s, snap());
const T = ctx.__T.slice().sort((a, b) => a - b);
const sum = T.reduce((a, b) => a + b, 0);
console.log(`\n[冷建] ${msCold.toFixed(0)} ms / ${roads} 条路 = ${(msCold / roads).toFixed(1)} ms 每条`);
console.log(T.length
  ? `[单次 A*] n=${T.length} 均 ${(sum / T.length).toFixed(2)} ms  p50 ${T[(T.length * 0.5) | 0].toFixed(2)}  p90 ${T[(T.length * 0.9) | 0].toFixed(2)}  max ${T[T.length - 1].toFixed(1)} ms`
  : '[单次 A*] 无样本');
console.log(`  主循环 A* ${d.mainAstar + d.mainDirectRetry} (建成 ${d.mainBuilt}, 失败回队 ${d.mainFailPush}, 无折扣重寻 ${d.mainDirectRetry})`);
console.log(`  drain   A* ${d.drainAstar} (建成 ${d.drainBuilt}, 寻路失败回队 ${d.drainRequeueFail}, 绕行闸回队 ${d.drainDiRequeue})`);
console.log(`  需求图: scanDemandEdges ${d.scanDemandEdges} 次 / rngDominated ${d.rngDominated} 次 / skeletonEdgesFor ${d.skeletonEdgesFor} 次`);
console.log(`  底层: fields ${d.fields}  hexDist ${d.hexDist}  cartDist/isqrt ${d.cartDist}  每次 A* ≈ ${(d.fields / d.bfsRoad).toFixed(0)} 次 fields`);

/* ---- 热跑 (路已全建好, 只应读缓存) ---- */
s = snap(); const n0 = MG.roadCache.size;
t = performance.now();
for (const [i, j] of q) MG.roadsNear(i, j, 9999);
const msHot = performance.now() - t;
d = delta(s, snap());
console.log(`\n[热跑] ${msHot.toFixed(0)} ms → ${(msHot / q.length).toFixed(2)} ms/格, roadCache ${n0} → ${MG.roadCache.size}`);
console.log(`  主循环 A* ${d.mainAstar + d.mainDirectRetry} (建成 ${d.mainBuilt}, 失败回队 ${d.mainFailPush}, 无折扣重寻 ${d.mainDirectRetry})`);
console.log(`  ⚠ 零产出 A*: drain ${d.drainAstar} 次 (建成 ${d.drainBuilt}) — 其中绕行闸回队 ${d.drainDiRequeue} 次` +
            ` = ${(d.drainDiRequeue / Math.max(1, d.drainAstar) * 100).toFixed(0)}%`);
const t2 = performance.now();
for (let k = 0; k < 200; k++) MG.roadsNear(0, 0, 9999);
console.log(`  单次 roadsNear(9999) 热态均 ${((performance.now() - t2) / 200).toFixed(2)} ms`);
const t3 = performance.now();
for (let k = 0; k < 200; k++) MG.roadsNear(0, 0, 0);
console.log(`  单次 roadsNear(0)    热态均 ${((performance.now() - t3) / 200).toFixed(3)} ms  (纯读路径, 无 A*)`);

/* ---- 复刻 灵脉预览.html pumpRoads(budget) ---- */
for (const B of [1, 3, 8]) {
  MG.init(seed);
  ctx.__T.length = 0;
  let cur = 0, built = 0, rounds = 0, zero = 0, astar = 0;
  t = performance.now();
  while (cur < q.length) {
    let b = 0, scanned = 0;
    const a0 = C.drainAstar + C.mainAstar;
    while (cur < q.length && b < B && scanned < 40) {
      const cell = q[cur++]; scanned++;
      const before = MG.roadCache.size;
      MG.roadsNear(cell[0], cell[1], B - b, 0, 0);
      const add = MG.roadCache.size - before;
      if (add > 0) { b += add; built += add; }
    }
    astar += (C.drainAstar + C.mainAstar) - a0;
    rounds++;
    if (b === 0) zero++;
  }
  console.log(`\n[泵送 budget=${B}] ${rounds} 轮 / 建 ${built} 条 / ${(performance.now() - t).toFixed(0)} ms` +
              ` / 零产出轮 ${zero} (${(zero / rounds * 100).toFixed(0)}%) / 每条路 ${(astar / Math.max(1, built)).toFixed(2)} 次 A*`);
}
