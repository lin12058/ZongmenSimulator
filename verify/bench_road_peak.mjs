/* ============================================================
 * bench_road_peak.mjs — 道路生成「单区域峰值」定位 (mapgen.js)
 * ------------------------------------------------------------
 * 与 bench_road_drain.mjs 互补:
 *   · bench_road_drain 看「泵送总量 + drain 账本 + 单次 A* 分布」;
 *   · 本脚本复刻 w3_bfs_road ⑦ 的 ±14 区域格冷启动, 逐格记录耗时与 A* 次数,
 *     用来回答「最慢单区域超标」到底是「A* 次数多」还是「单次 A* 极慢」。
 *     (2026-09-13 排查 drain 峰值时, 正是靠它看出最慢格只跑 9 次 A* 却有 431ms,
 *      从而把矛头从「次数」转向「大跨度老边」的。)
 *
 * 手法: 读 mapgen.js 源码 → 内存副本注入 A* 计数器 (不改源文件) → vm 跑冷启动。
 * 加载序必须是 noise.js + mapgen-config.js + mapgen.js
 *  (漏 mapgen-config.js 会静默退回 mapgen.js 内置兜底参数 → 数据失真)。
 *
 * 用法: node verify/bench_road_peak.mjs [tag] [seed]
 * ============================================================ */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 按脚本自身位置推导, 不硬编码 (目录更名会让绝对路径失效) */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSDIR = path.resolve(__dirname, '..', 'Server/Zongmen/Engine/js');
const tag = process.argv[2] || '?';
const SEED = process.argv[3] || 'seed-check';
const SPAN = 14;
const C = { astar: 0 };

let src = fs.readFileSync(JSDIR + '/mapgen.js', 'utf8');
const raw = (a, b) => { if (!src.includes(a)) throw new Error('注入点未找到: ' + a); src = src.replace(a, b); };
raw('function bfsRoad(sq, sr, tq, tr, roadTiles) {', 'function bfsRoad(sq, sr, tq, tr, roadTiles) { C.astar++;');

const ctx = { window: {}, console, C, Math, Map, Set, performance, JSON };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['noise.js', 'mapgen-config.js']) vm.runInContext(fs.readFileSync(JSDIR + '/' + f, 'utf8'), ctx);
vm.runInContext(src, ctx);
const MG = ctx.window.MapGen;
MG.init(SEED);

const rows = [];
let total = 0, worst = 0, cells = 0;
for (let i = -SPAN; i <= SPAN; i++) for (let j = -SPAN; j <= SPAN; j++) {
  const a0 = C.astar, n0 = MG.roadCache.size;
  const t = performance.now();
  MG.roadsNear(i, j, 9999);
  const dt = performance.now() - t;
  total += dt; cells++;
  rows.push({ i, j, dt, astar: C.astar - a0, built: MG.roadCache.size - n0 });
  if (dt > worst) worst = dt;
}
rows.sort((a, b) => b.dt - a.dt);
console.log(`[${tag}] seed=${SEED}  ±${SPAN} 共 ${cells} 格  合计 ${total.toFixed(0)}ms / 最慢 ${worst.toFixed(1)}ms / A* 总 ${C.astar} / 建成 ${MG.roadCache.size}`);
console.log('  最慢 8 格:');
for (const r of rows.slice(0, 8)) console.log(`    (${r.i},${r.j}) ${r.dt.toFixed(1)}ms  A* ${r.astar}  建 ${r.built}`);
const withAst = rows.filter(r => r.astar > 0);
const sumAst = withAst.reduce((a, r) => a + r.astar, 0);
console.log(`  有 A* 的格 ${withAst.length} 个, A* 合计 ${sumAst}, 平均 ${(sumAst / Math.max(1, withAst.length)).toFixed(1)} 次/格, 单次 A* 均 ${(total / Math.max(1, sumAst)).toFixed(2)}ms`);
