/* bench_guard.mjs — 验证 astar guard 值对最慢 region 耗时的影响 (eval 前替换源码, 不改原文件) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CASES = JSON.parse(process.argv[2] || '[[584,290],[626,446],[674,458],[277,364],[611,642],[332,675]]');
const GUARDS = JSON.parse(process.argv[3] || '[60000,12000,6000,3000]');

const src0 = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const noiseSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'noise.js'), 'utf8');
/* astar 迭代上限当前值从源码读 (不写死), 便于随实现调整后继续复用本基准 */
const CUR = (src0.match(/guard\+\+ < (\d+)/) || [, '?'])[1];
console.log('源码当前 astar guard =', CUR);

for (const guard of GUARDS) {
  global.window = globalThis;
  const src = src0.replace(/guard\+\+ < \d+/, 'guard++ < ' + guard);
  if (!src.includes('guard++ < ' + guard)) { console.log('替换失败'); process.exit(1); }
  (0, eval)(noiseSrc);
  (0, eval)(src);
  const MG = global.MapGen;
  MG.init('42');
  const row = [`guard=${guard}`];
  for (const [i, j] of CASES) {
    const t = performance.now();
    MG.settlementsFor(i, j);
    MG.roadsNear(i, j, 9999);
    row.push(`(${i},${j})=${(performance.now() - t).toFixed(0)}ms`);
  }
  console.log(row.join('  '));
}
