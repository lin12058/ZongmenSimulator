#!/usr/bin/env node
/* 决定性问题: Δ 残差是否**可约**?
   假设 H1: 残差 100% 来自 maturity(age) 的批间漂移, 而不是滚动基期取整台阶。
   证法: 把 maturity 的 age 从「累计 age」改成「固定 0」(即去掉成熟度项), 若 Δ 归零 ⇒ H1 成立。
   再证 H2: 残差也会来自 popBase 取整台阶 —— 把 popBase 改成不取整(浮点)看是否进一步变好。 */
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
const T = { Year: 360 };
const DEMAND = { 粮: 500, 木: 800, 渔: 900, 炭: 1200, 矿: 1500, 灵: 5000, 丹: 8000, 器: 8000 };
const E = { K_POP_RATIO: 4.0, K_MIN: 30, K_MIN_SCALE: 0.35, K_MAX_SCALE: 3.0, FOOD_DEBT_HALF: 720, POP_FLOOR: 50, R0: 8.3e-5, R_CITY: 1.4 };

const sells = new Map();
for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++)
  for (const s of MG.settlementsFor(i, j)) { if (s.type === 'poi') continue; if (!sells.has(s.id)) sells.set(s.id, s); }
const planCache = new Map();
const resOf = (bs) => { if (!planCache.has(bs.id)) planCache.set(bs.id, MG.growTownFootprint(bs.id, bs.type, bs.q, bs.r).resources); return planCache.get(bs.id); };

/* ── 三种 K 口径 ─────────────────────────────────────────────────── */
/* A. asis      : maturity(累计 age) + popBase 取整  ← 当前 v3.1 真源
   B. nomaturity: maturity 恒 1                      ← 消掉批间 K 漂移
   C. floatbase : maturity(累计 age) + popBase 浮点   ← 消掉取整台阶
   D. both      : maturity 恒 1 + popBase 浮点        ← 两者都消 */
function computeK(popBase, age, res, mode) {
  let supplyHint = 0, grainSup = 0;
  for (const it of res) { supplyHint += it.amount; if (it.resource === '粮') grainSup += it.amount; }
  const ref = mode === 'floatbase' || mode === 'both' ? popBase : Math.round(popBase);
  const grainNeed = Math.max(1, Math.round(Math.max(1, ref) / DEMAND['粮']));
  const deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
  const debtSs = deficitRate * E.FOOD_DEBT_HALF * 4;
  const debtScale = 1 - Math.tanh(debtSs / E.FOOD_DEBT_HALF);
  const supplyScale = 1 + Math.tanh(supplyHint / 2000);
  const maturity = (mode === 'nomaturity' || mode === 'both') ? 1 : 1 + 0.25 * Math.tanh(age / T.Year);
  const kScale = Math.min(E.K_MAX_SCALE, Math.max(E.K_MIN_SCALE, debtScale * supplyScale * maturity));
  return { K: Math.max(E.K_MIN, Math.max(1, ref) * E.K_POP_RATIO * kScale), maturity };
}
function evolve(s, bs, dt, mode) {
  const res = resOf(bs), type = bs.type;
  const popBase = Math.round(s.popF != null ? s.popF : s.pop) || s.pop || 1;
  const p0 = +(s.popF != null ? s.popF : s.pop);
  const rEff = E.R0 * (type === 'city' ? E.R_CITY : 1.0);
  const { K } = computeK(popBase, s.age | 0, res, mode);
  let pop = (!(p0 > 0) || K <= 0) ? p0 : K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
  if (pop < E.POP_FLOOR) pop = E.POP_FLOOR;
  const capPop = K * 1.05;
  if (pop > capPop) pop = capPop;
  let tier = s.tier | 0;
  for (let t = tier; t < 3; t++) { const need = t === 1 ? 4000 : 20000; if (Math.round(pop) >= need) tier = t + 1; else break; }
  if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + E.POP_FLOOR);
  return { popF: pop, pop: Math.round(pop), age: (s.age | 0) + dt, tier, Kf: K };
}

const CASES = [[360, 30, 12], [360, 1, 360], [90, 10, 9], [180, 45, 4]];
console.log('口径说明: asis=当前真源 / nomaturity=去掉成熟度漂移 / floatbase=popBase不取整 / both=两者都去\n');
for (const mode of ['asis', 'nomaturity', 'floatbase', 'both']) {
  const out = [];
  for (const [A, B, reps] of CASES) {
    let maxD = 0, worst = '';
    for (const [id, bs] of sells) {
      const s0 = { popF: bs.pop, pop: bs.pop, age: 0, tier: bs.tier | 0 };
      const one = evolve(s0, bs, A, mode);
      let acc = s0;
      for (let k = 0; k < reps; k++) acc = evolve(acc, bs, B, mode);
      const d = Math.abs(one.pop - acc.pop);
      if (d > maxD) { maxD = d; worst = id; }
    }
    out.push(`  ${A}=${reps}×${B}:  maxΔ=${String(maxD).padStart(3)}  (worst ${worst})`);
  }
  console.log(`── ${mode} ──`);
  console.log(out.join('\n'));
  console.log('');
}
