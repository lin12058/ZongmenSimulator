/* ============================================================
 * w3_bfs_road.mjs — 道路寻路回归 (A*: Dial 桶优先队列 + 三重剪枝)
 *   全离线 (Node 直接 eval Engine/js), 不需要起服务。
 *
 * 背景 —— 旧版 (w3_astar_budget.mjs) 锁的是「A* guard 下界 vs 丢路」的取舍:
 *   guard=12000 步下, 海岸破碎区的失败搜索仍会探完整片大陆, 最坏单 region
 *   达 540ms 且同步持 V8 门闩 → 同 seed 全部请求排队 → 黑区卡死。
 *   重构后 (§二) 改为「A*: Dial 桶优先队列 + 三重剪枝」, 该取舍不复存在:
 *     权重剪枝  累计权重 > ROAD_COST_MAX 的分支不扩展
 *     步数剪枝  距起点层数 > ROAD_STEPS_MAX 的格不入队
 *     下界剪枝  剩余代价可采纳下界 (最小权重×六边距) 使 g+h > 预算 的格跳过
 *   故本回归改为直接断言 BFS 的语义契约。
 *
 * 本回归锁七件事:
 *   ① 权重表与文档 §二 一致 (深海8/浅海6/沙岸4/草地3/林地4/沙漠5/山地8/雪峰8, 8 个 biome 全覆盖)
 *   ② 双预算上界: 任何成功路径 Σ权重 ≤ COST_MAX 且 步数 ≤ STEPS_MAX
 *   ③ 权重累加自洽: Σ权重 ∈ [minW×hexDist, COST_MAX] (下界=最便宜地形直连)
 *   ④ 邻域剪枝: 直线下界即超预算的对必须返回 null (不再跨大陆找路)
 *   ⑤ 剪枝不改变结果: 与「去掉下界剪枝」的参照实现逐对路径完全一致
 *   ⑥ 确定性: 同对重复调用 / 跨引擎实例 路径一致 (跨会话一致性的前提)
 *   ⑦ 端到端: 建路率 ≥ 阈值 + 最慢单 region(含 roadsNear) < 预算 ms
 *   附: 权重预算扫描 (信息性输出, 便于日后调参时判断影响面)
 *
 * 用法: node verify/w3_bfs_road.mjs [样本区域数] [最慢单region上界ms]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const SPAN = 30;                       // 灵域半径 ≈ 32 区域格 (spiritEdgeWorld/REGION_M)
const TIME_BUDGET_MS = parseInt(process.argv[3] || '250', 10);   // 实测冷启动最坏 ~106ms

const noiseSrc = fs.readFileSync(path.join(JSDIR, 'noise.js'), 'utf8');
const cfgSrc = fs.readFileSync(path.join(JSDIR, 'mapgen-config.js'), 'utf8');
const mapSrc = fs.readFileSync(path.join(JSDIR, 'mapgen.js'), 'utf8');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

/* ---- 引擎工厂 (每个实例一份独立闭包/缓存) ----
   参照实现 = 去掉下界剪枝两行, 并把权重剪枝退回「只看当前累计权重」 */
const PRUNE_H = /^.*下界剪枝.*$\n/m;
const PRUNE_W = /^.*权重剪枝 \(实际权重 ≥ 下界\).*$/m;
const BUCKET_ALLOC = /^.*var b = 0; b <= maxCost; b\+\+.*$/m;
const LOOP_BOUND = /^.*var f = 0; f <= maxCost; f\+\+.*$/m;
if (!PRUNE_H.test(mapSrc) || !PRUNE_W.test(mapSrc) || !BUCKET_ALLOC.test(mapSrc) || !LOOP_BOUND.test(mapSrc))
  throw new Error('源码未找到剪枝/桶语句, 无法构造参照实现 (改了 bfsRoad 请同步本脚本)');

function makeEngine(src) {
  const ctx = { window: {}, console, Math, Map, Set, Array, Infinity, isFinite, isNaN };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(noiseSrc + '\n' + cfgSrc + '\n' + src, ctx, { filename: 'engine.js' });
  return ctx.window.MapGen;
}

const MG = makeEngine(mapSrc);

const COST_MAX = MG.CFG.ROAD_COST_MAX | 0;
const STEPS_MAX = MG.CFG.ROAD_STEPS_MAX | 0;
const W = MG.CFG.ROAD_W;

/* 参照实现保留「无下界剪枝」语义 ⇒ 桶下标 f=g+h 允许超出预算 (g≤maxCost, h≤maxW×maxSteps),
   故桶数组与扫描上界必须同比放大, 否则 buckets[ng+h] 越界。
   (桶序由 g 改 f=g+h 后暴露的脚手架问题: 下界剪枝正是拦住超预算桶的那道阀) */
const BUCKET_MAX = COST_MAX + Math.max(...W) * STEPS_MAX;
const REF_SRC = mapSrc.replace(PRUNE_H, '')
                      .replace(PRUNE_W, 'if (ng > maxCost) continue;')
                      .replace(BUCKET_ALLOC, `for (var b = 0; b <= ${BUCKET_MAX}; b++) buckets.push([]);`)
                      .replace(LOOP_BOUND, `for (var f = 0; f <= ${BUCKET_MAX}; f++) {`);
const REF = makeEngine(REF_SRC);

console.log(`== 道路 A* 寻路回归 (COST_MAX=${COST_MAX}, STEPS_MAX=${STEPS_MAX}, ROAD_W=[${W}]) ==\n`);

/* ---- ① 权重表契约 (文档 §二, 2026-09-13 用户拍板新表) ---- */
{
  const BIOME = MG.BIOME;
  const expect = {};
  expect[BIOME.DEEP] = 8; expect[BIOME.OCEAN] = 6; expect[BIOME.BEACH] = 4;
  expect[BIOME.GRASS] = 3; expect[BIOME.DESERT] = 5;
  expect[BIOME.FOREST] = 4;
  expect[BIOME.MOUNTAIN] = 8; expect[BIOME.SNOW] = 8;
  let ok = Array.isArray(W) && W.length === 8;
  const bad = [];
  for (const k of Object.keys(expect)) if (W[k] !== expect[k]) { ok = false; bad.push(`${k}:${W[k]}≠${expect[k]}`); }
  check('权重表 = 文档 §二 (深海8/浅海6/沙岸4/草3/林4/沙漠5/山8/雪8, 8 个 biome 全覆盖)', ok, bad.join(' '));
  const minW = Math.min(...W);
  check('roadMinWeight() = 权重表最小值 (下界剪枝用)', MG.roadWeight({ biome: BIOME.GRASS }) === 3 && minW === 3, String(minW));
}

/* ---- 枚举聚落对 (复刻 roadsNear 配对: 本区域 × 3×3 邻域, 按 id 序归一化, 去重) ---- */
MG.init('42');
const pairs = [], seen = new Set();
for (let i = -SPAN; i <= SPAN; i++) {
  for (let j = -SPAN; j <= SPAN; j++) {
    const mine = MG.settlementsFor(i, j).filter((s) => s.type !== 'poi');
    if (!mine.length) continue;
    const near = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
      for (const s of MG.settlementsFor(i + di, j + dj)) if (s.type !== 'poi') near.push(s);
    for (const a of mine) for (const b of near) {
      if (a.id === b.id) continue;
      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const pA = a.id < b.id ? a : b, pB = a.id < b.id ? b : a;
      pairs.push([pA.q, pA.r, pB.q, pB.r, pA.type, key]);
    }
  }
}
console.log(`  灵域 ±${SPAN} 区域格: 去重候选对 ${pairs.length} 对\n`);
const MIN_PAIRS = 300;
check(`样本有意义 (候选对 ≥ ${MIN_PAIRS})`, pairs.length >= MIN_PAIRS, `${pairs.length} 对`);

/* ---- ②③④⑤⑥ 逐对断言 (抽样: 全量 1777 对逐对跑 Dijkstra+参照 ≈ 90s, 取定步长样本) ---- */
REF.init('42');
const PAIR_SAMPLE = Math.min(pairs.length, 600);
const STRIDE = Math.max(1, Math.floor(pairs.length / PAIR_SAMPLE));
const sampled = pairs.filter((_, i) => i % STRIDE === 0).slice(0, PAIR_SAMPLE);
const minW = Math.min(...W);
let okN = 0, nullN = 0;
let costBad = 0, stepBad = 0, lowerBad = 0, nearBad = 0, mismatch = 0, detBad = 0;
const samples = [];
/* ④ 邻域剪枝: 全量检查「直线下界即超预算 → 必 null」(便宜, 无需寻路) */
for (const [aq, ar, bq, br, , key] of pairs) {
  const d0 = MG.hexDist(aq, ar, bq, br);
  if (d0 * minW > COST_MAX || d0 > STEPS_MAX) {
    if (MG.bfsRoad(aq, ar, bq, br)) { nearBad++; samples.push(`越界却连通 ${key} d=${d0}`); }
    else nullN++;
  }
}
/* 抽样逐对详情 */
let totalBuilt = 0;
for (const [aq, ar, bq, br, , key] of sampled) {
  const p = MG.bfsRoad(aq, ar, bq, br);
  const d = MG.hexDist(aq, ar, bq, br);
  if (!p) continue;                     // 预算内但不可达: 合法 (绕行超预算)
  totalBuilt++; okN++;
  /* 端点与形状 */
  if (p[0][0] !== aq || p[0][1] !== ar || p[p.length - 1][0] !== bq || p[p.length - 1][1] !== br) {
    costBad++; samples.push(`端点不符 ${key}`);
    continue;
  }
  /* ② 步数上界 */
  if (p.length - 1 > STEPS_MAX) { stepBad++; samples.push(`步数 ${p.length - 1} > ${STEPS_MAX} ${key}`); }
  /* ②③ 权重累加 */
  let cost = 0;
  for (let k = 1; k < p.length; k++) cost += MG.roadWeight(MG.fields(p[k][0], p[k][1]));
  if (cost > COST_MAX) { costBad++; samples.push(`Σ权重 ${cost} > ${COST_MAX} ${key}`); }
  if (cost < minW * d) { lowerBad++; samples.push(`Σ权重 ${cost} < 下界 ${minW * d} ${key}`); }

  /* ⑤ 剪枝不改变结果 */
  const r = REF.bfsRoad(aq, ar, bq, br);
  if (JSON.stringify(p) !== JSON.stringify(r)) {
    mismatch++;
    if (samples.length < 6) samples.push(`剪枝改结果 ${key}: ${JSON.stringify(p)} vs ${JSON.stringify(r)}`);
  }
  /* ⑥ 确定性 (重复调用) */
  if (JSON.stringify(MG.bfsRoad(aq, ar, bq, br)) !== JSON.stringify(p)) { detBad++; samples.push(`重复调用不一致 ${key}`); }
}
console.log(`  全量 ${pairs.length} 对: 直线越界(必 null) ${nearBad === 0 ? nullN : '?'} 对`);
console.log(`  抽样 ${sampled.length} 对: 成功 ${okN} 对 → 抽样建路率 ${(okN / sampled.length * 100).toFixed(1)}%`);
for (const s of samples.slice(0, 8)) console.log('    ' + s);

check('② 全部成功路径 Σ权重 ≤ COST_MAX', costBad === 0, `${costBad} 例越界`);
check(`② 全部成功路径 步数 ≤ STEPS_MAX(${STEPS_MAX})`, stepBad === 0, `${stepBad} 例越界`);
check('③ 权重累加自洽 (Σ权重 ≥ 最便宜地形×六边距)', lowerBad === 0, `${lowerBad} 例低于下界`);
check('④ 邻域剪枝: 直线下界超预算的对一律返回 null (全量比对)', nearBad === 0, `${nearBad} 例越界连通`);
check('⑤ 下界剪枝不改变任何路径 (与无剪枝参照逐对一致)', mismatch === 0, `${mismatch} 例不一致`);
check('⑥ 同对重复调用路径一致 (确定性)', detBad === 0, `${detBad} 例不一致`);

/* ---- ⑥b 跨引擎实例一致 (跨会话确定性的前提) ---- */
{
  const MG2 = makeEngine(mapSrc);
  MG2.init('42');
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const [aq, ar, bq, br] = sampled[i];
    if (JSON.stringify(MG.bfsRoad(aq, ar, bq, br)) !== JSON.stringify(MG2.bfsRoad(aq, ar, bq, br))) bad++;
  }
  check('⑥ 跨引擎实例路径一致 (300 对)', bad === 0, `${bad} 例不一致`);
}

/* ---- ⑦ 端到端: 建路率 + 最慢单 region (用较小跨度控制耗时, 结论与全域一致) ---- */
const MG3 = makeEngine(mapSrc);
MG3.init('seed-check');
{
  const E2E_SPAN = 14;
  /* 配对语义 = roadsNear 现行规则: 聚落 × 3x3 邻域内全部聚落, 按距离升序逐对 A*,
     但「跳板剪枝」会故意不建冗余直达路 —— 分母须排除这些对。
     attempted = 预算内(下界可达) 且未被跳板剪枝的去重候选对;
     built     = roadsNear 产出按 key 去重的建成路 (同一条路从两端区域各返回一次)。
     跳板剪枝判定复刻 hopPrune: 距离全部用 cartDist (实际笛卡尔直线距离,
     借恒等式 dx²+dy² = HEX_W²·(dq²+dq·dr+dr²) 整数化), ∃m (3x3(a格)∪3x3(b格),
     非poi, 非端点) 使 dam<dab && dmb<dab (严格介于两点之间) 且
     10(dam+dmb) ≤ 13·dab (直线绕行 ≤30%)。 */
  const isqrtT = (n) => {
    if (n < 2) return n;
    let x = n, y = ((x + (n / x | 0)) >> 1) | 0;
    while (y < x) { x = y; y = ((x + (n / x | 0)) >> 1) | 0; }
    return x;
  };
  const cartT = (q1, r1, q2, r2) => {
    const dq = q1 - q2, dr = r1 - r2;
    return isqrtT(dq * dq + dr * dr + dq * dr);
  };
  const prunedT = (a, b) => {
    const dab = cartT(a.q, a.r, b.q, b.r);
    const pa = a.id.split('_'), pb = b.id.split('_');
    const cells = new Set();
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      cells.add(`${+pa[0] + di},${+pa[1] + dj}`);
      cells.add(`${+pb[0] + di},${+pb[1] + dj}`);
    }
    const pool = new Map();                    // id -> 聚落 (并集去重)
    for (const ck of cells) {
      const [ci, cj] = ck.split(',').map(Number);
      for (const s of MG3.settlementsFor(ci, cj)) {
        if (s.type === 'poi' || s.id === a.id || s.id === b.id) continue;
        pool.set(s.id, s);
      }
    }
    for (const m of pool.values()) {
      const dam = cartT(a.q, a.r, m.q, m.r);
      if (dam >= dab) continue;
      const dmb = cartT(m.q, m.r, b.q, b.r);
      if (dmb >= dab) continue;
      if (10 * (dam + dmb) <= 13 * dab) return true;
    }
    return false;
  };
  const seenPair = new Set(), seenRoad = new Set();
  let attempted = 0, worst = 0, total = 0, cells = 0;
  for (let i = -E2E_SPAN; i <= E2E_SPAN; i++) {
    for (let j = -E2E_SPAN; j <= E2E_SPAN; j++) {
      const mine = MG3.settlementsFor(i, j).filter((s) => s.type !== 'poi');
      if (mine.length) {
        const near = [];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
          for (const s of MG3.settlementsFor(i + di, j + dj)) if (s.type !== 'poi') near.push(s);
        for (const a of mine) for (const b of near) {
          if (a.id === b.id) continue;
          const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          const d0 = MG3.hexDist(a.q, a.r, b.q, b.r);
          if (d0 > STEPS_MAX || d0 * minW > COST_MAX) continue;   // 预算外: A* 必 null (步数下界)
          if (prunedT(a, b)) continue;                            // 跳板剪枝: 有意不建
          attempted++;
        }
      }
      const t = performance.now();
      const roads = MG3.roadsNear(i, j, 9999);
      const dt = performance.now() - t;
      for (const rd of roads) seenRoad.add(rd.key);
      total += dt; cells++;
      if (dt > worst) worst = dt;
    }
  }
  const built = seenRoad.size;
  const rate = built / attempted;
  console.log(`\n  seed=seed-check ±${E2E_SPAN}: 建成路 ${built} 条 / 可建候选对(预算内且未被跳板剪枝) ${attempted} → 建路率 ${(rate * 100).toFixed(1)}%`);
  console.log(`  roadsNear 冷启动合计 ${total.toFixed(0)}ms / ${cells} 区域格, 最慢单区域 ${worst.toFixed(1)}ms`);
  /* 阈值: 可建对绝大多数应连通 (旧近邻版实测 ~89-92%); 留出余量, 只在「路网大幅退化」时报错 */
  check('⑦ 建路率 ≥ 70% (路网未退化)', rate >= 0.70, `${(rate * 100).toFixed(1)}%`);
  check(`⑦ 最慢单 region(含 roadsNear) < ${TIME_BUDGET_MS}ms (A* 时代最坏 ~540ms)`,
    worst < TIME_BUDGET_MS, worst.toFixed(1) + 'ms');
}

/* ---- 附: 权重预算扫描 (信息性, 不参与判定) ---- */
{
  const cst = [];
  for (const [aq, ar, bq, br] of sampled) {
    const p = MG.bfsRoad(aq, ar, bq, br);
    if (!p) continue;
    let c = 0;
    for (let k = 1; k < p.length; k++) c += MG.roadWeight(MG.fields(p[k][0], p[k][1]));
    cst.push(c);
  }
  cst.sort((a, b) => a - b);
  const cnt = (t) => cst.filter((c) => c <= t).length;
  const q = (t) => cst[Math.min(cst.length - 1, Math.floor(cst.length * t))];
  console.log(`\n  [信息] 建成道路代价分布: n=${cst.length} p50=${q(.5)} p90=${q(.9)} max=${cst[cst.length - 1]}`);
  console.log(`  [信息] 若上限收紧为 30/60/90 → 分别只剩 ${(cnt(30) / cst.length * 100).toFixed(1)}% / ${(cnt(60) / cst.length * 100).toFixed(1)}% / ${(cnt(90) / cst.length * 100).toFixed(1)}% 的道路`);
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败 ✘' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
