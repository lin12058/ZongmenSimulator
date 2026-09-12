/* ============================================================
 * check_preview_terrain.mjs — 校验预览页「地形层（多级 LOD）」
 * ------------------------------------------------------------
 * 1) 4 个内联脚本块语法 + 渲染脚本引用的 DOM id 是否存在
 * 2) 光栅定位不变式：cell i = floor(dx)，dx = q + r/2  ←→  反解 q = round(i - r/2)
 *    （这是整张地形图与真实格网对齐的唯一依据，必须逐格成立）
 * 3) LOD 不变式：
 *    a. 覆盖不变式：该级世界矩形必须完整包含视口（含起点对齐后）
 *    b. 起点对齐：i0 % stepT === 0（同级采样点稳定）
 *    c. 单调性：scale 增大 ⇒ wantStepT 不增（放大只会更细，绝不更粗）
 *    d. 预算：每级采样数 ≤ TERRAIN_MAX_SAMPLES
 *    e. 清晰度：显示级块宽 ≤ MAX_BLOCK_PX×1.5，或 stepT == 1（无可再分）
 *    f. 逐格可达：MAX_SCALE 时 wantStepT == 1（六边形模式进得去）
 *    g. 回归：terrainEnsure 的复用判据必须含"当前需求级"，
 *       否则重现「放大后旧粗级永远被复用 → 一直糊」的老 bug
 * 4) 各缩放档实测 stepT / 采样 / 块宽 / 是否需要重建
 * 5) 实测一次完整构建（默认视野）
 * 用法: node verify/check_preview_terrain.mjs
 * ============================================================ */
import fs from 'fs';

const html = fs.readFileSync('灵脉预览.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let ok = true;
console.log('脚本块数:', blocks.length, '(应为 4: noise / config / mapgen / 渲染)');
blocks.forEach((b, i) => {
  try { new Function(b); console.log('  块' + (i + 1) + ' 语法 OK  len=' + b.length); }
  catch (e) { ok = false; console.log('  块' + (i + 1) + ' ✘ 语法错误: ' + e.message); }
});

/* --- DOM id --- */
const ids = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
const render = blocks[blocks.length - 1];
const refs = [...new Set([...render.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
const miss = refs.filter(r => !ids.includes(r));
console.log('\n渲染脚本引用 id 共 %d 个，缺失: %s', refs.length, miss.length ? '✘ ' + miss.join(',') : '✔ 无');
if (miss.length) ok = false;
for (const need of ['cb_terrain']) {
  const has = ids.includes(need);
  console.log('  ' + (has ? '✔' : '✘') + ' #' + need);
  if (!has) ok = false;
}
/* 地形层关键符号是否都在渲染脚本里 */
for (const sym of ['terrainEnsure', 'terrainDraw', 'terrainPumpFrame', 'terrainStart', 'terrainAbort',
                   'resetTerrain', 'rasterBlit', 'terrainSig', 'TERRAIN_MAX_SAMPLES', 'TERRAIN_RGB',
                   'wantStepT', 'terrainQuant', 'terrainPrevStep', 'pickTerrainLv', 'pickTerrainFallback',
                   'lvCover', 'lvBlockPx', 'terrainLevels', 'pruneTerrain', 'terrainSamples',
                   'terrainLv', 'scheduleTerrainPrefetch']) {
  const has = render.includes(sym);
  console.log('  ' + (has ? '✔' : '✘') + ' ' + sym);
  if (!has) ok = false;
}

/* --- 回归：LOD 复用判据必须带"当前需求级" --- */
console.log('\n=== 回归：terrainEnsure 复用判据 ===');
{
  const m = render.match(/function terrainEnsure[\s\S]*?\n\}/);
  const body = m ? m[0] : '';
  const hasWant = /terrainLv\[want\]/.test(body) && /terrainWant\s*=\s*want/.test(body);
  console.log('  ' + (hasWant ? '✔' : '✘') + ' 判据包含 terrainLv[want]（而非只看覆盖）');
  if (!hasWant) ok = false;
  const noOld = !render.includes('coversRect');
  console.log('  ' + (noOld ? '✔' : '✘') + ' 单级实现 coversRect 已移除');
  if (!noOld) ok = false;
  const smooth = render.match(/imageSmoothingEnabled\s*=\s*px\s*<\s*([\d.]+)/);
  console.log('  ' + (smooth ? '✔' : '✘') + ' 插值阈值 = 每像素 <' + (smooth ? smooth[1] : '?') + 'px（放大时硬边）');
  if (!smooth || +smooth[1] > 3) ok = false;
}

/* --- 引擎 --- */
global.window = global;
(0, eval)(blocks[0] + '\n' + blocks[1] + '\n' + blocks[2]);
const MG = global.MapGen;
const HEX_R = MG.HEX_R, HEX_W = MG.HEX_W, TILE_H = 1.5 * HEX_R;
MG.init('check-terrain');

/* --- ② 定位不变式 --- */
console.log('\n=== ② 光栅定位不变式 (cell i = floor(dx)) ===');
{
  let bad = 0, n = 0;
  for (let q = -400; q <= 400; q += 7) {
    for (let r = -400; r <= 400; r += 5) {
      const dx = q + r / 2;
      const i = Math.floor(dx);              // 该地块落在哪一列
      const q2 = Math.round(i - r * 0.5);    // 页面的反解
      n++;
      if (q2 !== q) { bad++; if (bad < 4) console.log('  ✘ q=%d r=%d → i=%d → 反解 %d', q, r, i, q2); }
    }
  }
  console.log('  %d 个地块: %s', n, bad ? '✘ ' + bad + ' 个错位' : '✔ 全部按 floor(dx) 落在同一列');
  if (bad) ok = false;
}

/* --- ③ LOD 不变式 --- */
console.log('\n=== ③ LOD 不变式 ===');
const W = 1400, H = 800;
const MARGIN = 0.25, MAX_SAMPLES = 24000, MAX_BLOCK_PX = 6;
/* 页面里的阶梯必须与这里一致 */
const m = render.match(/TERRAIN_STEP_LADDER\s*=\s*\[([^\]]+)\]/);
const LADDER = m ? m[1].split(',').map(s => +s.trim()) : [];
console.log('  阶梯 (%d 级): %s', LADDER.length, LADDER.join(','));
if (LADDER[0] !== 1 || LADDER[LADDER.length - 1] !== 256) ok = false;
for (let i = 1; i < LADDER.length; i++) {
  if (!(LADDER[i] > LADDER[i - 1])) { console.log('  ✘ 阶梯非严格递增 @' + i); ok = false; }
  if (LADDER[i] / LADDER[i - 1] > 2.05) { console.log('  ✘ 级差过大 %d→%d', LADDER[i - 1], LADDER[i]); ok = false; }
}
const quant = s => { for (const v of LADDER) if (v >= s) return v; return LADDER[LADDER.length - 1]; };
const prevStep = s => { const i = LADDER.indexOf(s); return i > 0 ? LADDER[i - 1] : 0; };

function viewRect(scale, camX = 0, camY = 0) {
  const toWorld = (sx, sy) => ({ x: (sx - W / 2 - camX) / scale, y: (sy - H / 2 - camY) / scale });
  const a = toWorld(0, 0), b = toWorld(W, H);
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}
function spans(v) {
  const mx = (v.x1 - v.x0) * MARGIN, my = (v.y1 - v.y0) * MARGIN;
  return {
    i0: Math.floor((v.x0 - mx) / HEX_W), i1: Math.ceil((v.x1 + mx) / HEX_W),
    j0: Math.floor((v.y0 - my) / TILE_H), j1: Math.ceil((v.y1 + my) / TILE_H),
  };
}
function wantStepT(scale, camX = 0, camY = 0) {
  const v = viewRect(scale, camX, camY), sp = spans(v);
  const cols = Math.max(1, sp.i1 - sp.i0), rows = Math.max(1, sp.j1 - sp.j0);
  const tileWpx = Math.sqrt(3) * HEX_R * scale;
  const blockOK = Math.floor(MAX_BLOCK_PX / Math.max(0.01, tileWpx));
  const capStep = Math.ceil(Math.sqrt(cols * rows / MAX_SAMPLES));
  return quant(Math.max(1, Math.max(blockOK, capStep)));
}
/* 该缩放档下，stepT 这级的采样数（对齐前后差不到一行一列，够判预算） */
function samplesAt(scale, step, camX = 0, camY = 0) {
  const sp = spans(viewRect(scale, camX, camY));
  const cols = Math.max(1, sp.i1 - sp.i0), rows = Math.max(1, sp.j1 - sp.j0);
  return Math.ceil(cols / step) * Math.ceil(rows / step);
}
function plan(scale, camX = 0, camY = 0) {
  const v = viewRect(scale, camX, camY), sp = spans(v);
  const stepT = wantStepT(scale, camX, camY);
  const i0 = Math.floor(sp.i0 / stepT) * stepT, j0 = Math.floor(sp.j0 / stepT) * stepT;
  const i1 = Math.ceil(sp.i1 / stepT) * stepT,  j1 = Math.ceil(sp.j1 / stepT) * stepT;
  const nx = Math.max(1, Math.round((i1 - i0) / stepT)), ny = Math.max(1, Math.round((j1 - j0) / stepT));
  return { stepT, i0, j0, nx, ny, samples: nx * ny,
           rect: { x0: i0 * HEX_W, y0: j0 * TILE_H, x1: (i0 + nx * stepT) * HEX_W, y1: (j0 + ny * stepT) * TILE_H },
           blockPx: Math.sqrt(3) * HEX_R * scale * stepT };
}

/* a/b/c/d/e —— 各缩放档逐项断言 */
console.log('\n  阶段   scale    需求LOD  光栅        采样    块宽    模式      覆盖 对齐 预算 最细');
const baseScale = Math.min(W, H) / (5 * Math.sqrt(3) * HEX_R * 150);
const SCALES = [['默认', baseScale], ['远', 0.05], ['中', 0.25], ['近', 0.5], ['1x', 1.0], ['最大', 4.0]];
for (const [name, s] of SCALES) {
  for (const cam of [[0, 0], [377, -231]]) {
    const p = plan(s, cam[0], cam[1]);
    const v = viewRect(s, cam[0], cam[1]);
    const covers = p.rect.x0 <= v.x0 && p.rect.y0 <= v.y0 && p.rect.x1 >= v.x1 && p.rect.y1 >= v.y1;
    const aligned = p.i0 % p.stepT === 0 && p.j0 % p.stepT === 0;
    const inBudget = p.samples <= MAX_SAMPLES;
    /* "已是最细的负担得起的一级"：块宽达标 / 已逐格 / 再细一级就超预算 */
    const finer = prevStep(p.stepT);
    const sharp = p.stepT === 1 || p.blockPx <= MAX_BLOCK_PX ||
                  finer < 1 || samplesAt(s, finer, cam[0], cam[1]) > MAX_SAMPLES;
    const mode = p.stepT === 1 ? '逐格/细' : '光栅';
    console.log('  ' + name.padEnd(5) + ' ' + String(s).padEnd(9) + String(p.stepT).padStart(6) +
      '  ' + (p.nx + '×' + p.ny).padEnd(11) + String(p.samples).padStart(7) +
      '  ' + p.blockPx.toFixed(1).padStart(5) + 'px  ' + mode.padEnd(9) +
      ' ' + (covers ? '✔' : '✘').padEnd(4) + ' ' + (aligned ? '✔' : '✘').padEnd(4) +
      ' ' + (inBudget ? '✔' : '✘').padEnd(4) + ' ' + (sharp ? '✔' : '✘'));
    if (!covers || !aligned || !inBudget || !sharp) ok = false;
  }
}

/* c —— 单调性：放大 ⇒ LOD 不增 */
{
  let prev = Infinity, bad = 0;
  for (let s = 0.01; s <= 4.001; s *= 1.05) {
    const w = wantStepT(s);
    if (w > prev) { bad++; if (bad < 4) console.log('  ✘ 放大反而变粗: scale=%s %d→%d', s.toFixed(3), prev, w); }
    prev = w;
  }
  console.log('\n  单调性 (0.01→4.0, ~123 档): ' + (bad ? '✘ ' + bad + ' 处倒退' : '✔ 单调不增（放大只会更细）'));
  if (bad) ok = false;
}

/* f —— 逐格可达 + 预取链 */
{
  const atMax = wantStepT(4.0);
  console.log('  最大缩放 LOD = ' + atMax + ' ' + (atMax === 1 ? '✔ 可进逐格六边形' : '✘ 进不去'));
  if (atMax !== 1) ok = false;
  const chain = [];
  let s = wantStepT(baseScale);
  for (let g = 0; g < 20 && s > 1; g++) { s = prevStep(s); chain.push(s); }
  console.log('  默认视野预取链: ' + wantStepT(baseScale) + ' → ' + chain.join(' → '));
  if (chain[chain.length - 1] !== 1) { console.log('  ✘ 预取链未到达 1 级'); ok = false; }
}

/* --- ④ 实测一次完整构建（默认视野） --- */
console.log('\n=== ④ 实测构建耗时 (默认视野, 冷启动) ===');
{
  const s = baseScale;
  const p = plan(s, 0, 0);
  MG.init('check-terrain-2');
  const t0 = Date.now();
  let acc = 0;
  for (let jj = 0; jj < p.ny; jj++) {
    const r = p.j0 + jj * p.stepT;
    for (let ii = 0; ii < p.nx; ii++) {
      const q = Math.round(p.i0 + ii * p.stepT - r * 0.5);
      const f = MG.fields(q, r);
      acc += MG.BIOME_META[f.biome] ? 1 : 0;
    }
  }
  const dt = Date.now() - t0;
  console.log('  LOD=%d %d×%d 采样 %d → 冷 %d ms (分帧约 %d 帧 @22ms)',
    p.stepT, p.nx, p.ny, p.samples, dt, Math.ceil(p.samples / 600));
  console.log('  BIOME_META 命中 %d/%d', acc, p.samples);
  if (acc !== p.samples) ok = false;
  const hist = {};
  for (let jj = 0; jj < p.ny; jj++) for (let ii = 0; ii < p.nx; ii++) {
    const r = p.j0 + jj * p.stepT;
    const f = MG.fields(Math.round(p.i0 + ii * p.stepT - r * 0.5), r);
    hist[MG.BIOME_META[f.biome].name] = (hist[MG.BIOME_META[f.biome].name] || 0) + 1;
  }
  console.log('  群系分布:', JSON.stringify(hist));
  if (Object.keys(hist).length < 3) { console.log('  ✘ 群系过于单一'); ok = false; }

  /* 热重建：同样的采样点再跑一遍（模拟同级重建，应显著更快） */
  const t1 = Date.now();
  for (let jj = 0; jj < p.ny; jj++) {
    const r = p.j0 + jj * p.stepT;
    for (let ii = 0; ii < p.nx; ii++) MG.fields(Math.round(p.i0 + ii * p.stepT - r * 0.5), r);
  }
  console.log('  同一级热重建 %d ms（都在 fieldCache 内）', Date.now() - t1);
}

console.log('\n=== 结论: %s ===', ok ? '✔ 全部通过' : '✘ 存在问题');
process.exit(ok ? 0 : 1);
