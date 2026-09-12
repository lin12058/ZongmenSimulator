/* 校验灵脉预览页新增的「聚落 / 道路」层：
   1) 4 个内联脚本块语法
   2) 渲染脚本 getElementById 引用的 id 是否都存在于 HTML
   3) 内联 mapgen 是否导出了 settlementsFor / roadsNear / roadCache / REGION_M
   4) 真实跑一遍：聚落扫描 + 道路泵送（模拟 pumpRoads 的分批逻辑）
   用法: node verify/check_preview_settle_road.mjs                        */
import fs from 'fs';

const html = fs.readFileSync('灵脉预览.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('脚本块数:', blocks.length, '(应为 4: noise / config / mapgen / 渲染)');
blocks.forEach((b, i) => {
  try { new Function(b); console.log('  块' + (i + 1) + ' 语法 OK  len=' + b.length); }
  catch (e) { console.log('  块' + (i + 1) + ' 语法错误: ' + e.message); }
});

/* --- DOM id 一致性 --- */
const ids = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
const render = blocks[blocks.length - 1];
const refs = [...new Set([...render.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
const miss = refs.filter(r => !ids.includes(r));
console.log('\n渲染脚本引用 id 共 %d 个，缺失: %s', refs.length, miss.length ? '✘ ' + miss.join(',') : '✔ 无');
for (const need of ['cb_settle', 'cb_sname', 'cb_road', 'roadCells', 'roadBudget', 'roadClear', 'tip']) {
  console.log('  ' + (ids.includes(need) ? '✔' : '✘') + ' #' + need);
}

/* --- 引擎导出 --- */
global.window = global;
(0, eval)(blocks[0] + '\n' + blocks[1] + '\n' + blocks[2]);
const M = global.MapGen;
const has = k => typeof M[k] !== 'undefined';
console.log('\n引擎导出: settlementsFor=%s roadsNear=%s roadCache=%s REGION_M=%s astar=%s',
  has('settlementsFor'), has('roadsNear'), has('roadCache'), has('REGION_M'), has('astar'));
console.log('REGION_M =', M.REGION_M, ' HEX_R =', M.HEX_R);

/* --- 真实跑：聚落扫描 + 道路泵送（复刻页面批次参数） --- */
M.init('seed-check');
const RM = M.REGION_M, HEX_R = M.HEX_R, HEX_W = M.HEX_W;
const W = 1400, H = 800;
const scale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
/* 复刻 indexRange：视口四角反解区域格范围 + 上下限 200 */
function range(step) {
  const toWorld = (sx, sy) => ({ x: (sx - W / 2) / scale, y: (sy - H / 2) / scale });
  const cs = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)];
  let iMin = 1e9, iMax = -1e9, jMin = 1e9, jMax = -1e9;
  for (const w of cs) {
    const jf = w.y / (1.5 * HEX_R) / step;
    const ifx = (w.x / HEX_W - (w.y / (1.5 * HEX_R)) / 2) / step;
    iMin = Math.min(iMin, ifx); iMax = Math.max(iMax, ifx);
    jMin = Math.min(jMin, jf); jMax = Math.max(jMax, jf);
  }
  let r = { iMin: Math.floor(iMin) - 1, iMax: Math.ceil(iMax) + 1, jMin: Math.floor(jMin) - 1, jMax: Math.ceil(jMax) + 1 };
  const CAP = 200;
  if (r.iMax - r.iMin > CAP) { const m = (r.iMin + r.iMax) / 2; r.iMin = Math.floor(m - CAP / 2); r.iMax = r.iMin + CAP; }
  if (r.jMax - r.jMin > CAP) { const m = (r.jMin + r.jMax) / 2; r.jMin = Math.floor(m - CAP / 2); r.jMax = r.jMin + CAP; }
  return r;
}
const rr = range(RM);
console.log('\n聚落扫描范围 %d×%d = %d 区域格', rr.iMax - rr.iMin + 1, rr.jMax - rr.jMin + 1,
  (rr.iMax - rr.iMin + 1) * (rr.jMax - rr.jMin + 1));

/* 本页本地缓存层（复刻 getSettlements） */
const local = new Map();
function getSettlements(i, j) {
  const k = i + ',' + j;
  let v = local.get(k);
  if (v !== undefined) return v;
  try { v = M.settlementsFor(i, j) || []; } catch (e) { v = []; }
  if (local.size >= 30000) local.clear();
  local.set(k, v); return v;
}
let t0 = Date.now(), n = 0, byType = {};
for (let i = rr.iMin; i <= rr.iMax; i++) for (let j = rr.jMin; j <= rr.jMax; j++)
  for (const s of getSettlements(i, j)) { n++; byType[s.type] = (byType[s.type] || 0) + 1; }
console.log('首帧(冷): %d ms, 聚落 %d 个 %j', Date.now() - t0, n, byType);
t0 = Date.now();
for (let i = rr.iMin; i <= rr.iMax; i++) for (let j = rr.jMin; j <= rr.jMax; j++) getSettlements(i, j);
console.log('后续帧(本地缓存命中): %d ms  ← 关键：不应再触碰引擎', Date.now() - t0);

/* 道路：复刻 buildRoadQueue(±8 区域格 + 跳过空格) + pumpRoads(budget=1, 每轮≤40 格) */
const RC = 8;
const BUDGET = 1;
const cj = 0, ci = 0;   // 视野中心 = 世界原点
const q = [];
let skipped = 0;
for (let i = ci - RC; i <= ci + RC; i++) for (let j = cj - RC; j <= cj + RC; j++) {
  const arr = getSettlements(i, j);
  if (arr.some(s => s.type !== 'poi')) q.push([i, j]); else skipped++;
}
console.log('\n道路队列: ±%d 区域格 → 全 %d 格, 有可建路聚落 %d 格, 跳过空格 %d 格',
  RC, (RC * 2 + 1) * (RC * 2 + 1), q.length, skipped);
let cur = 0, built = 0, rounds = 0, tMax = 0, tSum = 0, worst = 0;
t0 = Date.now();
while (cur < q.length) {
  const a = Date.now();
  let b = 0, scanned = 0;
  while (cur < q.length && b < BUDGET && scanned < 40) {
    const c = q[cur++]; scanned++;
    const before = M.roadCache.size;
    M.roadsNear(c[0], c[1], BUDGET - b);
    const add = M.roadCache.size - before;
    if (add > 0) { b += add; built += add; }
  }
  const dt = Date.now() - a; tMax = Math.max(tMax, dt); tSum += dt; rounds++;
}
console.log('道路泵送: %d 轮, 共建 %d 条, 总 %d ms, 单轮 max %d ms / avg %s ms',
  rounds, built, Date.now() - t0, tMax, (tSum / rounds).toFixed(1));
console.log('roadCache.size =', M.roadCache.size);

/* 抽一条路看结构（绘制层依赖 pts/x0/x1/y0/y1） */
const one = [...M.roadCache.values()][0];
if (one) {
  const p = one.pts[0];
  console.log('样例道路: key=%s pts=%d x0=%s x1=%s y0=%s y1=%s 首点=(%s,%s) tiles=%d',
    one.key, one.pts.length, one.x0.toFixed(0), one.x1.toFixed(0), one.y0.toFixed(0), one.y1.toFixed(0),
    p.x.toFixed(1), p.y.toFixed(1), one.tiles.size);
} else { console.log('✘ 未建出道路'); }
