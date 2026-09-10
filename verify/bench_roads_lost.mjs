/* bench_roads_lost.mjs — 统计不同 guard 下同区域生成的道路数量差 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const src0 = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const noiseSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'noise.js'), 'utf8');

/* 固定采样序列 (可复现): 与 bench_roads 相同的随机区域 */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(12345);
const cells = [];
for (let n = 0; n < 4000; n++) {
  cells.push([250 + ((rnd() * 500) | 0), 250 + ((rnd() * 500) | 0)]);
}

for (const guard of JSON.parse(process.argv[2] || '[60000,12000,6000,3000]')) {
  global.window = globalThis;
  const src = src0.replace(/guard\+\+ < \d+/, 'guard++ < ' + guard);
  if (!src.includes('guard++ < ' + guard)) { console.log('替换失败: 源码未找到 guard++ < N'); process.exit(1); }
  (0, eval)(noiseSrc);
  (0, eval)(src);
  const MG = global.MapGen;
  MG.init('42');
  const t0 = performance.now();
  let settleRegions = 0;
  for (const [i, j] of cells) {
    const s = MG.settlementsFor(i, j);
    if (s.length) settleRegions++;
    MG.roadsNear(i, j, 9999);
  }
  console.log('guard=' + guard,
    'roads=' + MG.roadCache.size,
    'settleRegions=' + settleRegions,
    'time=' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
}
