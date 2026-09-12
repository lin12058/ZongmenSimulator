/* ============================================================
 * bench_preview_terrain2.mjs — 地形层策略二次校准
 * ------------------------------------------------------------
 * 一次基准给出关键事实: fields() 单格 ~14µs, 视口 1137k 格 → 逐格渲染不可行。
 * 本脚本回答"那么用什么策略":
 *   ① buildChunk 单块耗时 (校准: 服务端就是这么算的)
 *   ② 降采样采样点的成本是否随 stepT 变化 (步长越大邻域缓存越没用)
 *   ③ 冷/热 + 不同预算下"渐进式光栅"的帧成本
 *   ④ fieldCache (cap 30000) 溢出导致的抖动确认
 * 运行: node verify/bench_preview_terrain2.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DIR = 'Server/Zongmen/Engine/js/';
const sandbox = { window: null, console, Math };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  vm.runInContext(readFileSync(DIR + f, 'utf8'), sandbox, { filename: f });
}
const MG = sandbox.MapGen;
const HEX_R = MG.HEX_R, HEX_W = MG.HEX_W, TILE_H = 1.5 * HEX_R;
const ms = (t) => t.toFixed(1) + 'ms';

/* ---------- ① buildChunk 基准 ---------- */
console.log('=== ① buildChunk 单块耗时 (服务端同款路径) ===');
MG.init('bench-chunk');
{
  let cnt = 0, t0 = performance.now();
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { MG.buildChunk(a, b); cnt++; }
  const cold = performance.now() - t0;
  t0 = performance.now();
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) { MG.buildChunk(a, b); cnt++; }
  const warm = performance.now() - t0;
  console.log(`  单块 ~${(cold / 25).toFixed(1)}ms (冷, 25 块 ${ms(cold)}) / ${(warm / 25).toFixed(2)}ms (热)`);
  console.log(`  单块格数 ≈ ${MG.buildChunk(0, 0).count} 格 → ${(cold / 25 / MG.buildChunk(0, 0).count * 1000).toFixed(2)} µs/格`);
}

/* ---------- ② 采样成本 vs stepT ---------- */
console.log('\n=== ② 采样成本 vs 降采样步长 (每次冷启动) ===');
function rasterCost(x0, y0, x1, y1, stepT) {
  const nCols = Math.ceil((x1 - x0) / HEX_W / stepT);
  const nRows = Math.ceil((y1 - y0) / TILE_H / stepT);
  const i0 = Math.round(x0 / HEX_W), j0 = Math.round(y0 / TILE_H);
  let sum = 0;
  const t0 = performance.now();
  for (let jj = 0; jj < nRows; jj++) {
    const r = j0 + jj * stepT;
    for (let ii = 0; ii < nCols; ii++) {
      const q = Math.round(i0 + ii * stepT - r * 0.5);
      sum += MG.fields(q, r).biome;
    }
  }
  return { ms: performance.now() - t0, n: nCols * nRows, nCols, nRows, sum };
}
{
  const W = 1400, H = 800, baseScale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
  const x0 = -5000, y0 = -3000, x1 = x0 + W / baseScale, y1 = y0 + H / baseScale;
  for (const stepT of [64, 32, 16, 8, 4, 2, 1]) {
    MG.init('bench-step-' + stepT);
    const res = rasterCost(x0, y0, x1, y1, stepT);
    console.log(`  stepT=${String(stepT).padStart(2)}: ${res.nCols}×${res.nRows}=${(res.n / 1000).toFixed(1)}k 采样 ${ms(res.ms)} → ${(res.ms / res.n * 1000).toFixed(2)} µs/采样`);
  }
}

/* ---------- ③ 渐进式光栅: 每帧预算切片 ---------- */
console.log('\n=== ③ 渐进式光栅: 分帧构建 (默认视野 stepT=16) ===');
{
  const W = 1400, H = 800, baseScale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
  const m = 0.25;
  const x0 = -5000 - W / baseScale * m, y0 = -3000 - H / baseScale * m;
  const x1 = -5000 + W / baseScale * (1 + m), y1 = -3000 + H / baseScale * (1 + m);
  for (const budget of [1000, 2000, 3000]) {
    MG.init('bench-slice-' + budget);
    const stepT = 16;
    const nCols = Math.ceil((x1 - x0) / HEX_W / stepT), nRows = Math.ceil((y1 - y0) / TILE_H / stepT);
    const i0 = Math.round(x0 / HEX_W), j0 = Math.round(y0 / TILE_H);
    let done = 0, frames = 0, maxFrame = 0, total = 0;
    while (done < nCols * nRows) {
      const t0 = performance.now();
      const end = Math.min(done + budget, nCols * nRows);
      for (; done < end; done++) {
        const jj = (done / nCols) | 0, ii = done % nCols;
        const r = j0 + jj * stepT;
        MG.fields(Math.round(i0 + ii * stepT - r * 0.5), r);
      }
      const ft = performance.now() - t0;
      maxFrame = Math.max(maxFrame, ft); total += ft; frames++;
    }
    console.log(`  预算 ${budget} 样本/帧: ${nCols * nRows} 样本 → ${frames} 帧, 最坏帧 ${maxFrame.toFixed(1)}ms, 合计 ${ms(total)}`);
  }
}

/* ---------- ④ 平移复用: 外扩 margin 能撑多远 ---------- */
console.log('\n=== ④ 平移复用 (外扩 margin → 可平移格数) ===');
{
  const W = 1400, H = 800, baseScale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
  for (const margin of [0, 0.25, 0.5]) {
    const tilesX = W / baseScale / 13.856, tilesY = H / baseScale / 12;
    console.log(`  margin=${margin}: 覆盖 ${(tilesX * (1 + 2 * margin)).toFixed(0)}×${(tilesY * (1 + 2 * margin)).toFixed(0)} 格 · 可平移 ±${(tilesX * margin).toFixed(0)} 格 (≈±${(tilesX * margin * 13.856 * baseScale).toFixed(0)}px 屏幕)`);
  }
}
