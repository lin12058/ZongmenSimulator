/* bench_roads.mjs — 定位 roadsNear/astar 慢点 (Node 直跑引擎, 不经服务端) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED = process.argv[2] || '42';
global.window = globalThis;
for (const f of ['noise.js', 'mapgen.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
}
const MG = global.MapGen;
MG.init(SEED);

/* 探针: 统计 A* 失败对数量 (roadFail 增长) */
let failCount = 0;
const seenFail = new Set();

const t0 = Date.now();
const N = +(process.argv[3] || 400);       // 采样 region 格数量
const R0 = +(process.argv[4] || -100);     // 起始 region i/j
const results = [];
for (let n = 0; n < N; n++) {
  // 随机撒点: 大范围覆盖
  const i = R0 + ((Math.random() * 2 * R0) | 0);
  const j = R0 + ((Math.random() * 2 * R0) | 0);
  const before = MG.roadFailSize ? MG.roadFailSize() : -1;
  const t1 = performance.now();
  try {
    MG.settlementsFor(i, j);
    MG.roadsNear(i, j, 9999);
  } catch (e) {
    console.log('THROW at', i, j, e.message);
    break;
  }
  const ms = performance.now() - t1;
  results.push({ i, j, ms: +ms.toFixed(1) });
}
results.sort((a, b) => b.ms - a.ms);
console.log('Top-10 slowest regionJson(roadsNear):');
for (const r of results.slice(0, 10)) console.log(`  region(${r.i},${r.j}) ${r.ms}ms`);
const total = results.reduce((s, r) => s + r.ms, 0);
const over100 = results.filter(r => r.ms > 100).length;
const over1000 = results.filter(r => r.ms > 1000).length;
console.log(`sampled=${results.length} total=${total.toFixed(0)}ms avg=${(total / results.length).toFixed(1)}ms >100ms=${over100} >1s=${over1000} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
