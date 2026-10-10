#!/usr/bin/env node
/* 定位 Δ 残差: 是纯滚动基期造成(不可避免), 还是 tier 夹断重复触发(可优化)?
   ⚠ BUGFIX: 原版打印 one.pop / acc.pop —— 但返回对象字段名是 popF ⇒ undefined ⇒ Math.round(..)=NaN。
     逻辑本身一直是对的, NaN 是打印字段名写错。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
const MG = global.MapGen;
MG.init('city-evo-sim-1');
const DEMAND = { 粮: 500, 木: 800, 渔: 900, 炭: 1200, 矿: 1500, 灵: 5000, 丹: 8000, 器: 8000 };
const sells = new Map();
for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++)
  for (const s of MG.settlementsFor(i, j)) { if (s.type === 'poi') continue; if (!sells.has(s.id)) sells.set(s.id, s); }

const bs = sells.get('-1_-1_0');
const plan = MG.growTownFootprint(bs.id, bs.type, bs.q, bs.r);
const res = plan.resources;

function computeK(popBase, age) {
  let supplyHint = 0, grainSup = 0;
  for (const it of res) { supplyHint += it.amount; if (it.resource === '粮') grainSup += it.amount; }
  const grainNeed = Math.max(1, Math.round(popBase / DEMAND['粮']));
  const deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
  const debtSs = deficitRate * 720 * 4;
  const debtScale = 1 - Math.tanh(debtSs / 720);
  const supplyScale = 1 + Math.tanh(supplyHint / 2000);
  const maturity = 1 + 0.25 * Math.tanh(age / 360);
  const kScale = Math.min(3.0, Math.max(0.35, debtScale * supplyScale * maturity));
  return Math.max(30, popBase * 4.0 * kScale);
}

/* ── 三种口径 ────────────────────────────────────────────────────────── */
/* rolling   : popBase 每步取入口人口 (真源 v3.1 滚动基期), tier 夹断开启
   frozen    : popBase 开局冻结 (旧 v3 口径),            tier 夹断开启
   noTier    : rolling 基期 + 去掉 tier 夹断,隔离夹断贡献                          */
function makeStep(mode) {
  return function evo(s, dt) {
    const popBase = mode === 'frozen' ? s.popBase : (Math.round(s.popF) || 1);
    const age = mode === 'frozen' ? 0 : s.age;
    const K = computeK(popBase, age);
    const rEff = 8.3e-5 * 1.4;
    const p0 = s.popF;
    let pop = p0 <= 0 || K <= 0 ? p0 : K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
    if (pop < 50) pop = 50;
    const cap = K * 1.05;
    if (pop > cap) pop = cap;
    /* tier 夹断 */
    let tier = s.tier | 0;
    if (mode !== 'noTier') {
      for (let t = tier; t < 3; t++) { const need = t === 1 ? 4000 : 20000; if (Math.round(pop) >= need) tier = t + 1; else break; }
      if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + 50);
    }
    return { popF: pop, age: s.age + dt, tier, popBase };
  };
}

/* 一次比较: 单步 dt vs N 次 dt/N 连续累加 (Δ 铁律的「连续累加」口径) */
function compare(mode, total, sub, reps) {
  const st = makeStep(mode);
  const s0 = { popF: bs.pop, age: 0, tier: bs.tier, popBase: bs.pop };
  const one = st(s0, total);
  let acc = s0;
  for (let k = 0; k < reps; k++) acc = st(acc, sub);
  const d = Math.abs(Math.round(one.popF) - Math.round(acc.popF));
  return { one: Math.round(one.popF), acc: Math.round(acc.popF), d };
}

/* 另跑一个「重喂 s0」口径, 证明它数学上必不相等 (对照用) */
function compareRefeed(mode, total, sub, reps) {
  const st = makeStep(mode);
  const s0 = { popF: bs.pop, age: 0, tier: bs.tier, popBase: bs.pop };
  const one = st(s0, total);
  let last = null;
  for (let k = 0; k < reps; k++) last = st(s0, sub);   // ⚠ 每次都重喂 s0
  return { one: Math.round(one.popF), acc: Math.round(last.popF), d: Math.abs(Math.round(one.popF) - Math.round(last.popF)) };
}

console.log('城市 -1_-1_0  (type=' + bs.type + ' pop=' + bs.pop + ' tier=' + bs.tier + ')');
console.log('资源:', res.map(r => r.resource + ':' + r.amount).join(' '));
console.log('');
const CASES = [[360, 30, 12], [360, 1, 360], [90, 10, 9], [180, 45, 4]];
for (const mode of ['rolling', 'frozen', 'noTier']) {
  console.log('── ' + mode + ' ──');
  for (const [total, sub, reps] of CASES) {
    const a = compare(mode, total, sub, reps);
    console.log(`  连续累加 ${total}=${reps}×${sub}:  单步=${a.one} 累加=${a.acc} Δ=${a.d}`);
  }
  const r = compareRefeed(mode, 360, 30, 12);
  console.log(`  【对照·重喂】360=12×30*:  单步=${r.one} 重喂=${r.acc} Δ=${r.d}  ← 应远大于 0(数学必不等)`);
  console.log('');
}
