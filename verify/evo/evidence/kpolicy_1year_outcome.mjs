#!/usr/bin/env node
/* 三选项实测对照: 跑满 1 年, 看各自的世界演化结果与 Δ 代价。
   A. freeze-K 严格拼接: popBase/K 全程冻结 ⇒ Δ≡0, 但迁入的小城撞旧 K 墙
   B. roll + 相对容差   : v3.1 现状 ⇒ 经济闭环正常, Δ≤22 (0.03%)
   C. 年度滚动          : 每年(360tick)才允许 popBase 重置一次 ⇒ 折中
   输出: 总人口变化 / 大城市变化 / tier 分布 / 事件态城数 / Δ 上界
   注: 这里只做**K 口径**的对比, 不跑完整价格层(那需要整份仿真器)。
       目的是量化「冻结 K」对世界演化的实际伤害。 */
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
const T = { Day: 1, Month: 30, Season: 90, Year: 360 };
const DEMAND = { 粮: 500, 木: 800, 渔: 900, 炭: 1200, 矿: 1500, 灵: 5000, 丹: 8000, 器: 8000 };
const E = { K_POP_RATIO: 4.0, K_MIN: 30, K_MIN_SCALE: 0.35, K_MAX_SCALE: 3.0, FOOD_DEBT_HALF: 720, POP_FLOOR: 50, R0: 8.3e-5, R_CITY: 1.4, TIER_MAX: 3 };

const sells = new Map();
for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++)
  for (const s of MG.settlementsFor(i, j)) { if (s.type === 'poi') continue; if (!sells.has(s.id)) sells.set(s.id, s); }
const planCache = new Map();
const resOf = (bs) => { if (!planCache.has(bs.id)) planCache.set(bs.id, MG.growTownFootprint(bs.id, bs.type, bs.q, bs.r).resources); return planCache.get(bs.id); };

function computeK(popBase, age, res) {
  let supplyHint = 0, grainSup = 0;
  for (const it of res) { supplyHint += it.amount; if (it.resource === '粮') grainSup += it.amount; }
  const grainNeed = Math.max(1, Math.round(Math.max(1, popBase) / DEMAND['粮']));
  const deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
  const debtSs = deficitRate * E.FOOD_DEBT_HALF * 4;
  const debtScale = 1 - Math.tanh(debtSs / E.FOOD_DEBT_HALF);
  const supplyScale = 1 + Math.tanh(supplyHint / 2000);
  const maturity = 1 + 0.25 * Math.tanh(age / T.Year);
  const kScale = Math.min(E.K_MAX_SCALE, Math.max(E.K_MIN_SCALE, debtScale * supplyScale * maturity));
  return Math.max(E.K_MIN, Math.max(1, popBase) * E.K_POP_RATIO * kScale);
}

/* 一次 evolve; KPolicy: 'freeze' | 'roll' | 'year' */
function evolve(s, bs, dt, policy) {
  const res = resOf(bs), type = bs.type;
  const enterPop = Math.round(s.popF != null ? s.popF : s.pop) || s.pop || 1;
  const p0 = +(s.popF != null ? s.popF : s.pop);
  const rEff = E.R0 * (type === 'city' ? E.R_CITY : 1.0);
  let K;
  if (policy === 'freeze') K = s.__K != null ? s.__K : (s.__K = computeK(enterPop, 0, res));
  else if (policy === 'roll') K = computeK(enterPop, s.age | 0, res);
  else {   /* year: 只在 age 跨过整年时重置 */
    const crossed = Math.floor((s.age | 0) / T.Year) !== Math.floor(((s.age | 0) + dt) / T.Year);
    K = (s.__K == null || crossed) ? (s.__K = computeK(enterPop, s.age | 0, res)) : s.__K;
  }
  let pop = (!(p0 > 0) || K <= 0) ? p0 : K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
  if (pop < E.POP_FLOOR) pop = E.POP_FLOOR;
  const capPop = K * 1.05;
  if (pop > capPop) pop = capPop;
  let tier = s.tier | 0;
  for (let t = tier; t < E.TIER_MAX; t++) { const need = t === 1 ? 4000 : 20000; if (Math.round(pop) >= need) tier = t + 1; else break; }
  if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + E.POP_FLOOR);
  return { popF: pop, pop: Math.round(pop), age: (s.age | 0) + dt, tier, __K: s.__K, Kf: K };
}

function runYear(policy, split) {
  const st = new Map();
  for (const [id, bs] of sells) st.set(id, { popF: bs.pop, pop: bs.pop, age: 0, tier: bs.tier | 0 });
  const steps = split ? 12 : 1, dt = split ? 30 : 360;
  for (let k = 0; k < steps; k++) for (const [id, bs] of sells) st.set(id, evolve(st.get(id), bs, dt, policy));
  let total = 0, big = []; const tierCnt = { 1: 0, 2: 0, 3: 0 };
  for (const [id, v] of st) { total += v.pop; tierCnt[v.tier] = (tierCnt[v.tier] || 0) + 1; }
  const arr = [...st.entries()].sort((a, b) => b[1].pop - a[1].pop).slice(0, 3);
  return { total, big: arr.map(([id, v]) => id + ':' + v.pop), tierCnt };
}
function pop0Total() { let t = 0; for (const [, bs] of sells) t += bs.pop; return t; }
const P0 = pop0Total();

console.log(`世界初始总人口 = ${P0}\n`);
for (const policy of ['freeze', 'roll', 'year']) {
  const one = runYear(policy, false), sp = runYear(policy, true);
  const dmax = Math.abs(one.total - sp.total);
  console.log(`── K 策略 = ${policy} ──`);
  console.log(`  单步360总人口=${one.total} (${((one.total / P0 - 1) * 100).toFixed(2)}%)   12×30总人口=${sp.total}   Δ总=${dmax}`);
  console.log(`  单步 top3: ${one.big.join('  ')}`);
  console.log(`  拆分 top3: ${sp.big.join('  ')}`);
  console.log(`  tier 单步=${JSON.stringify(one.tierCnt)}  拆分=${JSON.stringify(sp.tierCnt)}`);
  console.log('');
}
