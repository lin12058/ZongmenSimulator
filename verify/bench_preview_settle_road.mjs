/* 基准：预览页可见范围内，聚落扫描 + 道路泵送的耗时。
   目的：决定预览页需要多大预算/缩放门控，避免拖动卡顿。
   用法: node verify/bench_preview_settle_road.mjs            */
import fs from 'fs';
import path from 'path';

const dir = 'Server/Zongmen/Engine/js/';
const order = ['noise.js', 'mapgen-config.js', 'mapgen.js'];
global.window = global;
global.global = global;
for (const f of order) {
  const src = fs.readFileSync(dir + f, 'utf8');
  (0, eval)(src);
}
const M = global.MapGen;
const HEX_R = M.HEX_R, HEX_W = M.HEX_W, REGION_M = M.REGION_M;
console.log('HEX_R=%d HEX_W=%.3f REGION_M=%d', HEX_R, HEX_W, REGION_M);

/* 复刻预览页的初始 scale： min(W,H)/(5*√3*HEX_R*150) */
const W = 1400, H = 800;
const scale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
console.log('预览初始 scale=%s  → 1格=%s px  区域格(18格)=%s px',
  scale.toFixed(5), (HEX_W * scale).toFixed(2), (REGION_M * HEX_W * scale).toFixed(1));

/* 视口四角 → 世界 → 区域格索引范围（与预览页同一算法） */
function regionRange(camX, camY) {
  const toWorld = (sx, sy) => ({
    x: (sx - W / 2 - camX) / scale, y: (sy - H / 2 - camY) / scale
  });
  const cs = [toWorld(0, 0), toWorld(W, 0), toWorld(0, H), toWorld(W, H)];
  let iMin = 1e9, iMax = -1e9, jMin = 1e9, jMax = -1e9;
  for (const w of cs) {
    const jf = w.y / (1.5 * HEX_R) / REGION_M;
    const ifx = (w.x / HEX_W - (w.y / (1.5 * HEX_R)) / 2) / REGION_M;
    if (ifx < iMin) iMin = ifx; if (ifx > iMax) iMax = ifx;
    if (jf < jMin) jMin = jf; if (jf > jMax) jMax = jf;
  }
  return {
    iMin: Math.floor(iMin) - 1, iMax: Math.ceil(iMax) + 1,
    jMin: Math.floor(jMin) - 1, jMax: Math.ceil(jMax) + 1
  };
}

function run(seed) {
  M.init(seed);
  const r = regionRange(0, 0);
  const nCells = (r.iMax - r.iMin + 1) * (r.jMax - r.jMin + 1);
  console.log('\n=== seed=%s 可见区域格 %d×%d = %d 个 ===',
    seed, r.iMax - r.iMin + 1, r.jMax - r.jMin + 1, nCells);

  /* 1) 聚落扫描（冷） */
  let t0 = Date.now();
  let sett = 0, byType = {};
  for (let i = r.iMin; i <= r.iMax; i++) {
    for (let j = r.jMin; j <= r.jMax; j++) {
      const a = M.settlementsFor(i, j);
      sett += a.length;
      for (const s of a) byType[s.type] = (byType[s.type] || 0) + 1;
    }
  }
  const tSettleCold = Date.now() - t0;
  console.log('聚落扫描(冷): %d ms, 命中 %d 个  %j', tSettleCold, sett, byType);

  /* 2) 聚落扫描（热，模拟拖动下一帧） */
  t0 = Date.now();
  for (let i = r.iMin; i <= r.iMax; i++)
    for (let j = r.jMin; j <= r.jMax; j++) M.settlementsFor(i, j);
  console.log('聚落扫描(热): %d ms', Date.now() - t0);

  /* 3) 只扫描「有聚落」的格子成本（实际绘制只需这些） */
  t0 = Date.now();
  let cellsWith = 0;
  for (let i = r.iMin; i <= r.iMax; i++)
    for (let j = r.jMin; j <= r.jMax; j++) {
      const a = M.settlementsFor(i, j);
      if (a.length) cellsWith++;
    }
  console.log('（其中有聚落的格子 %d 个, 耗时 %d ms）', cellsWith, Date.now() - t0);

  /* 4) 道路泵送：每次预算 8 条 A*，看需要多少轮 / 每轮耗时 */
  t0 = Date.now();
  const cells = [];
  for (let i = r.iMin; i <= r.iMax; i++)
    for (let j = r.jMin; j <= r.jMax; j++)
      if (M.settlementsFor(i, j).some(s => s.type !== 'poi')) cells.push([i, j]);
  console.log('含可建路聚落的格子 %d 个', cells.length);

  let rounds = 0, tMax = 0, tSum = 0, ci = 0;
  const ROAD_BUDGET_PER_ROUND = 8, CELLS_PER_ROUND = 24;
  while (ci < cells.length && rounds < 500) {
    const a = Date.now();
    const before = M.roadCache.size;
    let used = 0;
    for (let n = 0; n < CELLS_PER_ROUND && ci < cells.length; n++, ci++) {
      const grow = Math.max(0, ROAD_BUDGET_PER_ROUND - used);
      const sz0 = M.roadCache.size;
      M.roadsNear(cells[ci][0], cells[ci][1], grow);
      used += Math.max(0, M.roadCache.size - sz0);
    }
    const dt = Date.now() - a;
    tSum += dt; tMax = Math.max(tMax, dt); rounds++;
  }
  console.log('道路泵送: %d 轮, 总 %d ms, 单轮 max %d ms / avg %s ms, roadCache=%d',
    rounds, Date.now() - t0, tMax, (tSum / rounds).toFixed(2), M.roadCache.size);
}

run('bench-a');
run('bench-b');
