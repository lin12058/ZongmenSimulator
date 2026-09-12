/* ============================================================
 * bench_preview_terrain.mjs — 预览页「地形层」渲染策略基准
 * ------------------------------------------------------------
 * 地形 = 逐格读 MapGen.fields(q,r).biome 着色, 成本 = 采样格数 × 单格耗时。
 * 本脚本测:
 *   ① fields() 冷/热 单次耗时 (决定光栅分辨率上限)
 *   ② 默认缩放(scale=5格宽基准)下视口覆盖多少格
 *   ③ 不同降采样倍率 stepT 的光栅构建耗时 (含 ImageData 写入模拟)
 *   ④ 光栅复用率: 视野外扩 margin 后, 平移多少格才需要重建
 * 运行: node verify/bench_preview_terrain.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const DIR = 'Server/Zongmen/Engine/js/';
const sandbox = {};
sandbox.window = sandbox;
sandbox.console = console;
sandbox.Math = Math;
vm.createContext(sandbox);
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  vm.runInContext(readFileSync(DIR + f, 'utf8'), sandbox, { filename: f });
}
const MG = sandbox.MapGen;

const HEX_R = MG.HEX_R, HEX_W = MG.HEX_W, COMM_CL = MG.CFG.COMM_CL;
const TILE_W = Math.sqrt(3) * HEX_R;      // 一格的世界宽 (px)
const TILE_H = 1.5 * HEX_R;               // 一格的世界高 (px)

function ms(t) { return t.toFixed(1) + 'ms'; }

/* ---------- ① fields() 单格耗时 ---------- */
MG.init('bench-terrain');
console.log('=== ① fields() 单格耗时 ===');
{
  const q0 = 300, r0 = 300;          // 远离原点/群落稀少处
  let n = 0, t0 = performance.now();
  for (let r = r0; r < r0 + 200; r++) for (let q = q0; q < q0 + 200; q++) { MG.fields(q, r); n++; }
  const cold = performance.now() - t0;
  t0 = performance.now();
  for (let r = r0; r < r0 + 200; r++) for (let q = q0; q < q0 + 200; q++) { MG.fields(q, r); n++; }
  const warm = performance.now() - t0;
  console.log(`  冷: ${n / 2} 格 ${ms(cold)} → ${(cold / (n / 2) * 1000).toFixed(2)} µs/格`);
  console.log(`  热: ${n / 2} 格 ${ms(warm)} → ${(warm / (n / 2) * 1000).toFixed(2)} µs/格`);
}

/* 原点附近 (群落最密, 灵气最高) 的冷成本 */
{
  MG.init('bench-terrain-2');
  let t0 = performance.now();
  for (let r = -100; r < 100; r++) for (let q = -100; q < 100; q++) MG.fields(q, r);
  console.log(`  原点 ±100 冷: 40000 格 ${ms(performance.now() - t0)}`);
}

/* ---------- ② 视口覆盖格数 ---------- */
console.log('\n=== ② 视口覆盖格数 (W=1400,H=800 画布) ===');
const W = 1400, H = 800;
// 预览页初始 scale: 目标让 5 个 COMM_CL 宽的菱形铺满短边
const baseScale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
console.log(`  初始 scale=${baseScale.toFixed(4)} (COMM_CL=150 基准)`);
for (const s of [baseScale, 0.25, 0.577, 1, 2, 4]) {
  const tilesX = W / (TILE_W * s), tilesY = H / (TILE_H * s);
  console.log(`  scale=${s.toFixed(3)}: 视口 ${tilesX.toFixed(0)}×${tilesY.toFixed(0)} = ${(tilesX * tilesY / 1000).toFixed(0)}k 格  (一格 ${(TILE_W * s).toFixed(1)}px)`);
}

/* ---------- ③ 光栅构建耗时 ---------- */
console.log('\n=== ③ 光栅构建 (每像素 1 格 → stepT 降采样, 目标 ≤400k px) ===');
const META = MG.BIOME_META.map(m => {
  const c = m.color.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
});
function buildRaster(x0, y0, x1, y1, stepT) {
  const nCols = Math.ceil((x1 - x0) / HEX_W / stepT);
  const nRows = Math.ceil((y1 - y0) / TILE_H / stepT);
  const i0 = Math.round(x0 / HEX_W), j0 = Math.round(y0 / TILE_H);
  const buf = new Uint8ClampedArray(nCols * nRows * 4);
  let p = 0;
  for (let jj = 0; jj < nRows; jj++) {
    const r = j0 + jj * stepT;
    for (let ii = 0; ii < nCols; ii++) {
      const q = Math.round(i0 + ii * stepT - r * 0.5);
      const f = MG.fields(q, r);
      const rgb = META[f.biome] || [0, 0, 0];
      const k = 0.70 + 0.60 * f.e;
      buf[p] = rgb[0] * k; buf[p + 1] = rgb[1] * k; buf[p + 2] = rgb[2] * k; buf[p + 3] = 255;
      p += 4;
    }
  }
  return { nCols, nRows, buf };
}
for (const [name, x0, y0, s] of [['初始视野', -5000, -3000, baseScale], ['放大 scale=1', -640, -360, 1], ['放大 scale=4', -160, -90, 4]]) {
  const x1 = x0 + W / s, y1 = y0 + H / s;
  for (const margin of [0, 0.25]) {
    const mx = (x1 - x0) * margin, my = (y1 - y0) * margin;
    const ax0 = x0 - mx, ay0 = y0 - my, ax1 = x1 + mx, ay1 = y1 + my;
    let stepT = 1;
    for (let k = 0; k < 6; k++) {
      const nc = Math.ceil((ax1 - ax0) / HEX_W / stepT), nr = Math.ceil((ay1 - ay0) / TILE_H / stepT);
      if (nc * nr <= 400000) break;
      stepT *= 2;
    }
    MG.init('bench-terrain');                    // 冷启动: 清空全部缓存
    const t0 = performance.now();
    const res = buildRaster(ax0, ay0, ax1, ay1, stepT);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    buildRaster(ax0, ay0, ax1, ay1, stepT);
    const warm = performance.now() - t1;
    console.log(`  ${name.padEnd(12)} margin=${margin}: stepT=${stepT} ${res.nCols}×${res.nRows}=${(res.nCols * res.nRows / 1000).toFixed(0)}k  冷 ${ms(cold)}  热 ${ms(warm)}`);
  }
}
