/* ============================================================
 * bench_guard_frontier.mjs — 找 astar guard 的「安全下界」(逐对隔离法)
 *
 * 问题: guard 越低 → 最坏 region 越快, 但可能把「本来可达」的聚落对误判为不可达 → 丢路。
 *   60000→5053ms / 12000→540ms / 6000→32ms (最慢 region)。
 *
 * 方法学 (关键: 不用 roadsNear, 它的配对受跨区域 roadFail/缓存淘汰状态影响 ——
 *   实测同一样本会出现「低 guard 反而多出参照没有的路」这种非单调现象, 是混淆而非真实结果):
 *   · 只测**纯函数** `MapGen.astar(q,r,q,r)` —— 它只依赖 seed 地形, 不读 roadCache/roadFail;
 *   · 配对规则忠实复刻 roadsNear: a 取本区域聚落(非 poi), b 取 3x3 邻域聚落(非 poi),
 *     按聚落 id 序归一化端点 (与实现的方向归一化一致), 按 pair key 去重;
 *   · **递增试探**利用 A* 的单调性 (guard 小能成功 ⇒ 大必成功): 逐对从 1500 试起,
 *     升到成功为止 → 直接得到「该对最少需要多少步」的直方图;
 *     升到 12000 仍失败者记为 ">12000" —— 它们在当前采用的 12000 下**本来就不建路**,
 *     因此对「能否把 12000 调低」这个问题不影响结论 (不构成回归)。
 *   · 额外断言: 同一对在低/高 guard 都成功时, 路径必须**完全一致** (否则降 guard 会改道路几何)。
 *
 * 用法: node verify/bench_guard_frontier.mjs [seeds] [perSeed] [span] [ladder]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const src0 = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const noiseSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'noise.js'), 'utf8');
const CUR = (src0.match(/guard\+\+ < (\d+)/) || [, '?'])[1];

const SEEDS = (process.argv[2] || '42,20260909,guard-frontier-1').split(',').filter(Boolean);
const PER_SEED = parseInt(process.argv[3] || '1200', 10);
const SPAN = parseInt(process.argv[4] || '3000', 10);
const LADDER = JSON.parse(process.argv[5] || '[1500,3000,6000,12000]');

console.log(`源码当前 astar guard = ${CUR}`);
console.log(`采样: ${SEEDS.length} seed × ${PER_SEED} 区域 (±${SPAN} 格)`);
console.log(`试探阶梯 = ${LADDER.join(' → ')} (升到成功为止; 顶档仍失败记 ">${LADDER[LADDER.length - 1]}")\n`);

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function fnv(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/* 每个 guard 一个独立引擎实例: eval 一次换来一份干净的模块级闭包, 之后立刻抓住引用 */
function makeEngine(guard) {
  const src = src0.replace(/guard\+\+ < \d+/, 'guard++ < ' + guard);
  if (!src.includes('guard++ < ' + guard)) throw new Error('替换失败: ' + guard);
  global.window = globalThis;
  (0, eval)(noiseSrc);
  (0, eval)(src);
  return global.MapGen;                 // 本次 eval 的实例 (含自己的缓存闭包)
}

/* ---- 1) 枚举配对 (settlementsFor 与 guard 无关, 用任一引擎) ---- */
const en0 = makeEngine(LADDER[LADDER.length - 1]);
const PAIRS = new Map();                // seed -> [[aq,ar,bq,br,key], ...]
const SAMPLES = new Map();
let pairsTotal = 0;
for (const seed of SEEDS) {
  const rnd = mulberry32(fnv(seed) ^ 0x9e3779b9);
  const cells = [];
  for (let n = 0; n < PER_SEED; n++) cells.push([Math.round((rnd() * 2 - 1) * SPAN), Math.round((rnd() * 2 - 1) * SPAN)]);
  SAMPLES.set(seed, cells);
  en0.init(seed);
  const seen = new Set(), list = [];
  for (const [i, j] of cells) {
    const mine = en0.settlementsFor(i, j).filter((s) => s.type !== 'poi');
    if (!mine.length) continue;
    const near = [];
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const s of en0.settlementsFor(i + di, j + dj)) if (s.type !== 'poi') near.push(s);
      }
    }
    for (const a of mine) {
      for (const b of near) {
        if (a.id === b.id) continue;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const pA = a.id < b.id ? a : b, pB = a.id < b.id ? b : a;
        list.push([pA.q, pA.r, pB.q, pB.r, key]);
      }
    }
  }
  PAIRS.set(seed, list);
  pairsTotal += list.length;
  console.log(`  seed ${seed}: 采样区域 ${cells.length}, 去重后待测聚落对 ${list.length}`);
}
console.log(`配对合计 ${pairsTotal} 对\n`);

/* ---- 2) 递增试探: 逐对得到「最少需要多少步」 ---- */
const ENG = {};
for (const g of LADDER) ENG[g] = makeEngine(g);

const hist = new Map();                 // needGuard -> 对数  ('>max' 表示顶档仍失败)
const pathMismatch = [];
let stepBudget = 0;
const t0 = process.hrtime.bigint();
for (const seed of SEEDS) {
  for (const g of LADDER) ENG[g].init(seed);
  for (const [aq, ar, bq, br, key] of PAIRS.get(seed)) {
    let need = null;
    for (const g of LADDER) {
      const p = ENG[g].astar(aq, ar, bq, br);
      stepBudget++;
      if (p) {
        need = g;
        /* 单调性附加断言: 顶档成功时路径必须与低档成功时一致 (降 guard 不改几何) */
        if (g !== LADDER[LADDER.length - 1]) {
          const pTop = ENG[LADDER[LADDER.length - 1]].astar(aq, ar, bq, br);
          const h = (q) => fnv(JSON.stringify(q));
          if (!pTop || h(p) !== h(pTop)) pathMismatch.push(`${seed} ${key} @${g}`);
        }
        break;
      }
    }
    const k = need === null ? '>' + LADDER[LADDER.length - 1] : need;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`===== 逐对「最少所需 guard」直方图 (共 ${pairsTotal} 对, ${(ms / 1000).toFixed(1)}s, astar 调用 ${stepBudget} 次) =====`);
const maxG = LADDER[LADDER.length - 1];
let cum = 0;
for (const g of LADDER) {
  const n = hist.get(g) || 0;
  cum += n;
  console.log(`  ≤${String(g).padStart(5)} 步: ${String(n).padStart(6)} 对  (${(n / pairsTotal * 100).toFixed(2)}%)`);
}
const over = hist.get('>' + maxG) || 0;
console.log(`  >${maxG} 或不可达: ${String(over).padStart(6)} 对  (${(over / pairsTotal * 100).toFixed(2)}%)  ` +
  `← 当前 guard=${maxG} 下本来就不建路, 与是否调低无关`);

console.log(`\n===== 「把 guard 从 ${maxG} 调低」会丢多少路 =====`);
function lostAbove(g) {                 // 需要 > g 步、但 ≤ maxG 步 → 调低后会丢
  let n = 0;
  for (const k of LADDER) if (k > g) n += hist.get(k) || 0;
  return n;
}
for (const g of LADDER) {
  if (g === maxG) continue;
  const l = lostAbove(g);
  console.log(`  改用 guard=${String(g).padStart(5)}: 丢 ${String(l).padStart(5)} 对路 (${(l / pairsTotal * 100).toFixed(3)}%)  ` +
    `${l === 0 ? '✔ 零丢路' : '✘ 有丢路'}`);
}
console.log(`\n路径一致性断言 (低档成功 vs 顶档成功): ${pathMismatch.length === 0 ? '全部一致 ✔' : '不一致 ' + pathMismatch.length + ' 例 ✘'}`);
for (const s of pathMismatch.slice(0, 5)) console.log('  ' + s);
