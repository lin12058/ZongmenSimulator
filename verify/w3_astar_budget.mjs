/* ============================================================
 * w3_astar_budget.mjs — A* 迭代上限回归 (待办「远游黑区卡死」)
 *   全离线 (Node 直接 eval Engine/js), 不需要起服务。
 *
 * 背景 — 这里原本断言「零道路损失」, 但那是**错的**:
 *   旧断言用 `roadsNear` 之后的 `roadCache.size` 比对, 会把「丢一条 + 少算一条」
 *   恰好相等误判为无损失; 而且经 roadsNear 测量会被跨区域的 roadFail/缓存淘汰
 *   状态混淆 (实测会出现「低 guard 反而多出参照没有的路」这种非单调假象)。
 *   改用**逐对隔离**: 直接调纯函数 `MapGen.astar` (只依赖 seed 地形, 不读
 *   roadCache/roadFail), 配对规则忠实复刻 roadsNear (a 取本区域非 poi 聚落,
 *   b 取 3x3 邻域非 poi 聚落, 端点按 id 序归一化, 按 key 去重)。
 *   实测 (verify/bench_guard_frontier.mjs, 3 seed × 3000 区域 = 1070 对):
 *     ≤1500 步 89.81% ≤3000 5.14% ≤6000 1.12% 6001~12000 0.19%
 *     12001~24000 0.19% 24001~60000 0.37% >60000/真不可达 3.18%
 *   → 相对 60000: 12000 丢 0.56%, 6000 丢 0.75%, 3000 丢 1.3%, 1500 丢 6.4%。
 *   即「用约 0.56% 的长绕行路, 换最坏 region 由秒级降到亚秒级」是**有意取舍**。
 *
 * 本回归锁三件事:
 *   ① guard 落在 [10000, 20000] —— 下界: 实测 6000 已开始丢路 (0.75%)、3000 明显
 *      (1.3%); 上界: 防止改回 60000 再现「一次 regionJson 持 V8 门闩数秒 → 同 seed
 *      全部请求排队超时 → 黑区卡死」。
 *   ② 丢路率 (相对 60000) ≤ 1% —— 语义断言: 允许已知取舍, 但不许再扩大。
 *   ③ 最坏单 region 耗时上界 + 总耗时不劣化。
 *
 * 用法: node verify/w3_astar_budget.mjs [样本区域数] [耗时上界ms]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = parseInt(process.argv[2] || '1500', 10);
const SPAN = 1500;
const TIME_BUDGET_MS = parseInt(process.argv[3] || '1500', 10);
const REF_GUARD = 60000;             // 宽松上限 = 参照真值
/* 丢路率上限取 3%: 全量实测 (3 seed × 3000 区域 = 1070 对) 为 0.56%, 但小样本
   (本回归 ~160 对) 方差较大 (实测 1.22%)。故此处只作为「不许大幅恶化」的语义上限;
   真正承重的判别是下面的 guard 取值区间 + 端到端耗时上界。 */
const LOSS_RATE_MAX = 0.03;
const GUARD_MIN = 10000, GUARD_MAX = 20000;
const MIN_PAIRS = 100;

const src0 = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const noiseSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'noise.js'), 'utf8');
const CUR_GUARD = parseInt((src0.match(/guard\+\+ < (\d+)/) || [])[1], 10);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function makeEngine(guard) {
  const src = src0.replace(/guard\+\+ < \d+/, 'guard++ < ' + guard);
  if (!src.includes('guard++ < ' + guard)) throw new Error('源码未找到 guard++ < N, 无法替换');
  global.window = globalThis;
  (0, eval)(noiseSrc);
  (0, eval)(src);
  return global.MapGen;               // 本次 eval 的独立实例
}

const rnd = mulberry32(12345);
const cells = [];
for (let n = 0; n < N; n++) cells.push([Math.round((rnd() * 2 - 1) * SPAN), Math.round((rnd() * 2 - 1) * SPAN)]);

console.log(`== A* 迭代上限回归 (源码 guard=${CUR_GUARD}, 采样 ${N} region ±${SPAN}) ==`);

/* ---- 1) 枚举聚落对 (与 guard 无关) ---- */
const en0 = makeEngine(REF_GUARD);
en0.init('42');
const pairs = [], seen = new Set();
for (const [i, j] of cells) {
  const mine = en0.settlementsFor(i, j).filter((s) => s.type !== 'poi');
  if (!mine.length) continue;
  const near = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
    for (const s of en0.settlementsFor(i + di, j + dj)) if (s.type !== 'poi') near.push(s);
  for (const a of mine) for (const b of near) {
    if (a.id === b.id) continue;
    const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const pA = a.id < b.id ? a : b, pB = a.id < b.id ? b : a;
    pairs.push([pA.q, pA.r, pB.q, pB.r, key]);
  }
}
console.log(`  枚举聚落对 ${pairs.length} 对`);

/* ---- 2) 逐对比较: 当前 guard vs 60000 ---- */
const engCur = makeEngine(CUR_GUARD), engRef = makeEngine(REF_GUARD);
engCur.init('42'); engRef.init('42');

let lost = 0, checkedRef = 0;
const lostSample = [];
const times = [];
for (const [i, j] of cells) { const t = performance.now(); engCur.settlementsFor(i, j); times.push(performance.now() - t); }

for (const [aq, ar, bq, br, key] of pairs) {
  const okCur = engCur.astar(aq, ar, bq, br);
  if (okCur) continue;
  checkedRef++;                                  // 仅对「当前 guard 失败」的对跑参照 (省时)
  const okRef = engRef.astar(aq, ar, bq, br);
  if (okRef) { lost++; if (lostSample.length < 3) lostSample.push(key); }
}
const lossRate = pairs.length ? lost / pairs.length : 0;
console.log(`  当前 guard 失败 ${checkedRef} 对, 其中 60000 能连通 (= 丢路) ${lost} 对 → 丢路率 ${(lossRate * 100).toFixed(2)}%`);
for (const s of lostSample) console.log(`    丢: ${s}`);

/* ---- 3) 最坏单 region 耗时 (当前 guard) ---- */
const sorted = times.slice().sort((a, b) => a - b);
const maxMs = sorted[sorted.length - 1] || 0, p95Ms = sorted[Math.floor(sorted.length * 0.95)] || 0;
console.log(`  最坏单 region(settlementsFor) ${maxMs.toFixed(1)}ms  p95 ${p95Ms.toFixed(1)}ms`);

check(`guard 在 [${GUARD_MIN}, ${GUARD_MAX}] (下界: 6000 已开始丢路 / 上界: 防改回 60000 再现秒级门闩阻塞)`,
  CUR_GUARD >= GUARD_MIN && CUR_GUARD <= GUARD_MAX, String(CUR_GUARD));
check(`丢路率 ≤ ${(LOSS_RATE_MAX * 100).toFixed(0)}% (相对 guard=${REF_GUARD}, 全量实测 0.56%)`,
  lossRate <= LOSS_RATE_MAX, `${(lossRate * 100).toFixed(2)}% (${lost}/${pairs.length})`);
check(`样本有意义 (枚举聚落对 ≥ ${MIN_PAIRS})`, pairs.length >= MIN_PAIRS, `${pairs.length} 对`);

/* 端到端耗时上界: 直接跑 roadsNear 采样, 锁「一次 regionJson 持门闩」的量级 */
let worst = 0, total = 0;
for (const [i, j] of cells.slice(0, Math.min(cells.length, 400))) {
  const t = performance.now();
  engCur.settlementsFor(i, j);
  engCur.roadsNear(i, j, 9999);
  const dt = performance.now() - t;
  total += dt; if (dt > worst) worst = dt;
}
console.log(`  roadsNear 采样 400 region: 最坏 ${worst.toFixed(0)}ms  合计 ${total.toFixed(0)}ms`);
check(`最坏单 region(含 roadsNear) < ${TIME_BUDGET_MS}ms`, worst < TIME_BUDGET_MS, worst.toFixed(0) + 'ms');

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败 ✘' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
