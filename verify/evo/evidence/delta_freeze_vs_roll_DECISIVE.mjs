#!/usr/bin/env node
/* ★ 判决性实验: 证明 Δ 残差的**唯一**根因 = popBase 逐批滚动 ⇒ K 批间不同。
   对照四组:
     (1) freeze-K   : 全程用 s0 算出的 K (批内常数 AND 批间常数)  → 应 Δ ≡ 0
     (2) roll-popBase: 每批按入口人口重算 K (v3.1 真源)            → 应 Δ > 0
     (3) roll-nomaturity: 同(2) 但 maturity 恒 1 (排除 maturity)   → 应仍 > 0
     (4) freeze-K + 每批仍更新 age: 确认 age 本身不引入 Δ          → 应 Δ ≡ 0
   若 (1)(4) 归零而 (2)(3) 非零 ⇒ 根因确定: **K 批间漂移**, 且不可约(因为滚动是设计意图)。 */
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

function computeK(popBase, age, res, useMaturity) {
  let supplyHint = 0, grainSup = 0;
  for (const it of res) { supplyHint += it.amount; if (it.resource === '粮') grainSup += it.amount; }
  const grainNeed = Math.max(1, Math.round(Math.max(1, popBase) / DEMAND['粮']));
  const deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
  const debtSs = deficitRate * E.FOOD_DEBT_HALF * 4;
  const debtScale = 1 - Math.tanh(debtSs / E.FOOD_DEBT_HALF);
  const supplyScale = 1 + Math.tanh(supplyHint / 2000);
  const maturity = useMaturity ? 1 + 0.25 * Math.tanh(age / T.Year) : 1;
  const kScale = Math.min(E.K_MAX_SCALE, Math.max(E.K_MIN_SCALE, debtScale * supplyScale * maturity));
  return Math.max(E.K_MIN, Math.max(1, popBase) * E.K_POP_RATIO * kScale);
}

/* group: 1=freeze-K / 2=roll / 3=roll-noMaturity / 4=freeze-K(age 仍累加) */
function evolve(s, bs, dt, group) {
  const res = resOf(bs), type = bs.type;
  const enterPop = Math.round(s.popF != null ? s.popF : s.pop) || s.pop || 1;
  const p0 = +(s.popF != null ? s.popF : s.pop);
  const rEff = E.R0 * (type === 'city' ? E.R_CITY : 1.0);
  let K;
  if (group === 1 || group === 4) {
    /* 冻结: 一律用「本组初始那个 K」 */
    K = s.__K != null ? s.__K : (s.__K = computeK(enterPop, 0, res, true));
  } else if (group === 2) {
    K = computeK(enterPop, s.age | 0, res, true);
  } else {
    K = computeK(enterPop, s.age | 0, res, false);
  }
  let pop = (!(p0 > 0) || K <= 0) ? p0 : K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
  if (pop < E.POP_FLOOR) pop = E.POP_FLOOR;
  const capPop = K * 1.05;
  if (pop > capPop) pop = capPop;
  let tier = s.tier | 0;
  for (let t = tier; t < 3; t++) { const need = t === 1 ? 4000 : 20000; if (Math.round(pop) >= need) tier = t + 1; else break; }
  if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + E.POP_FLOOR);
  return { popF: pop, pop: Math.round(pop), age: (s.age | 0) + dt, tier, __K: s.__K, Kf: K };
}

const CASES = [[360, 30, 12], [360, 1, 360], [90, 10, 9], [180, 45, 4]];
const NAMES = { 1: 'freeze-K (批内批间皆常数)', 2: 'roll-popBase (v3.1 真源)', 3: 'roll -maturity', 4: 'freeze-K (age 仍累加)' };
for (const group of [1, 2, 3, 4]) {
  console.log(`── ${NAMES[group]} ──`);
  for (const [A, B, reps] of CASES) {
    let maxD = 0, worst = '';
    for (const [id, bs] of sells) {
      const s0 = { popF: bs.pop, pop: bs.pop, age: 0, tier: bs.tier | 0 };
      const one = evolve(s0, bs, A, group);
      let acc = { popF: bs.pop, pop: bs.pop, age: 0, tier: bs.tier | 0 };
      for (let k = 0; k < reps; k++) acc = evolve(acc, bs, B, group);
      const d = Math.abs(one.pop - acc.pop);
      if (d > maxD) { maxD = d; worst = id; }
    }
    console.log(`  ${String(A).padStart(3)}=${String(reps).padStart(3)}×${String(B).padStart(2)}:  maxΔ=${String(maxD).padStart(3)}  (worst ${worst})`);
  }
  console.log('');
}
