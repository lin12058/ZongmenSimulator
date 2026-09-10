/* ============================================================
 * w3_astar_budget.mjs — A* 迭代上限回归 (review A2 #11/#12 / 待办「远游黑区卡死」)
 *   锁两件事:
 *     ① 零道路损失: 当前源码的 guard 与 60000 基线的道路条数完全一致
 *        (guard 只允许排除「本来就不可达」的聚落对, 不许伤及真实可通行的路);
 *     ② 最坏单 region 构建耗时上界: 防止 guard 被改回大值再次造成
 *        「一次 regionJson 持 V8 门闩数秒 → 该 seed 全部请求排队超时 → 黑区卡死」。
 *
 *   全离线 (Node 直接 eval Engine/js), 不需要起服务。
 *   用法: node verify/w3_astar_budget.mjs [样本数] [耗时上界ms]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = parseInt(process.argv[2] || '500', 10);
const TIME_BUDGET_MS = parseInt(process.argv[3] || '1500', 10);

const src0 = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const noiseSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'noise.js'), 'utf8');
const CUR_GUARD = (src0.match(/guard\+\+ < (\d+)/) || [])[1];

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rnd = mulberry32(12345);
const cells = [];
for (let n = 0; n < N; n++) cells.push([250 + ((rnd() * 500) | 0), 250 + ((rnd() * 500) | 0)]);

/* 在指定 guard 下跑同一采样, 返回 {roads, maxMs, p95Ms} */
function run(guard) {
  global.window = globalThis;
  const src = src0.replace(/guard\+\+ < \d+/, 'guard++ < ' + guard);
  if (!src.includes('guard++ < ' + guard)) throw new Error('源码未找到 guard++ < N, 无法替换');
  (0, eval)(noiseSrc);
  (0, eval)(src);
  const MG = global.MapGen;
  MG.init('42');
  const times = [];
  for (const [i, j] of cells) {
    const t = performance.now();
    MG.settlementsFor(i, j);
    MG.roadsNear(i, j, 9999);
    times.push(performance.now() - t);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  return { roads: MG.roadCache.size, maxMs: sorted[sorted.length - 1], p95Ms: sorted[Math.floor(sorted.length * 0.95)], times };
}

console.log(`== A* 迭代上限回归 (源码 guard=${CUR_GUARD}, 采样 ${N} region) ==`);
const base = run(60000);          // 基线: 宽松上限 = 真值
const cur = run(CUR_GUARD);       // 当前实现

console.log(`  基线(60000): roads=${base.roads} max=${base.maxMs.toFixed(0)}ms p95=${base.p95Ms.toFixed(0)}ms`);
console.log(`  当前(${CUR_GUARD}): roads=${cur.roads} max=${cur.maxMs.toFixed(0)}ms p95=${cur.p95Ms.toFixed(0)}ms`);

check('guard 有上界且远小于旧值 60000', Number(CUR_GUARD) > 0 && Number(CUR_GUARD) <= 20000, String(CUR_GUARD));
check(`零道路损失 (当前 roads=${cur.roads} == 基线 ${base.roads})`, cur.roads === base.roads,
  `当前 ${cur.roads} vs 基线 ${base.roads}`);
check(`最坏单 region 耗时 < ${TIME_BUDGET_MS}ms`, cur.maxMs < TIME_BUDGET_MS, cur.maxMs.toFixed(0) + 'ms');
check('总耗时不劣化 (当前 ≤ 基线)', cur.times.reduce((a, b) => a + b, 0) <= base.times.reduce((a, b) => a + b, 0) + 50,
  `${cur.times.reduce((a, b) => a + b, 0).toFixed(0)}ms vs ${base.times.reduce((a, b) => a + b, 0).toFixed(0)}ms`);

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
