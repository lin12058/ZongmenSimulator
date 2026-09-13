/* ============================================================
 * stats_buildings.mjs — 服务端建筑种类「实际出现」盘点
 * ------------------------------------------------------------
 * 目的: mapgen.js 定义了 BUILDINGS(地皮) + CORE_KIND(核心) 两套建筑池,
 *       本脚本用同一份引擎在若干 seed 上真实跑一遍 settlementsFor +
 *       growTownFootprint, 统计每种 kind 的生成次数, 回答:
 *         · 哪些建筑在真实世界里真的会出现 (以及出现频次/占比)
 *         · 哪些建筑定义了但实际极罕见 / 永不出现
 *         · 各地皮 (terrain) 的覆盖率, 说明"为什么某类建筑见不到"
 * 只读脚本: 不写文件、不改配置、不联网。
 * 用法: node verify/stats_buildings.mjs [seed ...] [--R=20]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

/* ---- 参数 ---- */
const args = process.argv.slice(2);
const R = (() => { const a = args.find(s => s.startsWith('--R=')); return a ? Number(a.split('=')[1]) : 20; })();
const seeds = args.filter(s => !s.startsWith('--R='));
if (!seeds.length) seeds.push('stats-a', 'stats-b', 'stats-c');

/* ---- 加载引擎 (必须带 mapgen-config.js, 否则静默跑兜底参数) ---- */
global.window = globalThis;
const srcText = {}; 
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  const code = fs.readFileSync(path.join(ENG, f), 'utf8');
  srcText[f] = code;
  (0, eval)(code);
}
const MG = global.MapGen;

/* ---- 从源码文本抽取「建筑全集」(真源 = mapgen.js, 不硬编码) ---- */
const mk = srcText['mapgen.js'];
const ALL = new Set();                       // 全部建筑名 (去重)
const CAT = new Map();                       // 建筑名 -> 来源 (地皮名 / core:type)
const bBlock = mk.match(/var BUILDINGS = \{([\s\S]*?)\n  \};/);
if (!bBlock) throw new Error('未找到 BUILDINGS 定义');
const bLines = bBlock[1].split('\n');
for (const ln of bLines) {
  const land = ln.match(/^\s*'([^']+)':\s*\[(.*)\],?\s*$/);
  if (!land) continue;
  const landName = land[1];
  for (const m of land[2].matchAll(/k:\s*'([^']+)'/g)) {
    ALL.add(m[1]);
    if (!CAT.has(m[1])) CAT.set(m[1], landName);
  }
}
const cBlock = mk.match(/var CORE_KIND = \{([\s\S]*?)\n  \};/);
if (!cBlock) throw new Error('未找到 CORE_KIND 定义');
/* ⚠ 一行里可能有多个 type: [...] (city 与 town 同行), 必须 matchAll 全取 */
for (const t of cBlock[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
  for (const m of t[2].matchAll(/'([^']+)'/g)) {
    ALL.add(m[1]);
    if (!CAT.has(m[1])) CAT.set(m[1], 'core:' + t[1]);
    else if (!CAT.get(m[1]).includes('core:' + t[1])) CAT.set(m[1], CAT.get(m[1]) + ' | core:' + t[1]);
  }
}

/* ---- 遍历 ---- */
const kindCnt = new Map(), terrCnt = new Map(), typeCnt = new Map();
const luCnt = new Map();
let settleN = 0, buildN = 0, planFail = 0;
const seen = new Set();
const t0 = Date.now();

for (const seed of seeds) {
  MG.init(seed);
  /* 地皮抽样: 步长 3 扫 ±R*18 格, 看各地皮在世界上是否存在 */
  const span = R * MG.REGION_M;
  for (let q = -span; q <= span; q += 3) {
    for (let r = -span; r <= span; r += 3) {
      leaveLu(MG.landuseOf(MG.fields(q, r)));
    }
  }
  for (let i = -R; i <= R; i++) {
    for (let j = -R; j <= R; j++) {
      let arr;
      try { arr = MG.settlementsFor(i, j); } catch (e) { continue; }
      for (const st of arr) {
        if (st.type === 'poi') continue;                 // 秘境无建筑
        const key = seed + ':' + st.id;
        if (seen.has(key)) continue;
        seen.add(key);
        settleN++;
        typeCnt.set(st.type, (typeCnt.get(st.type) || 0) + 1);
        let plan = null;
        try { plan = MG.growTownFootprint(st.id, st.type, st.q, st.r); } catch (e) { plan = null; }
        if (!plan || !plan.buildings) { planFail++; continue; }
        for (const b of plan.buildings) {
          buildN++;
          kindCnt.set(b.kind, (kindCnt.get(b.kind) || 0) + 1);
          terrCnt.set(b.terrain, (terrCnt.get(b.terrain) || 0) + 1);
        }
      }
    }
  }
}
function leaveLu(lu) { luCnt.set(lu, (luCnt.get(lu) || 0) + 1); }

/* ---- 输出 ---- */
console.log('=== 建筑盘点 (seed: ' + seeds.join(', ') + ', 区域半径 R=' + R +
            ' ≈ ±' + (R * MG.REGION_M) + ' 格) ===');
console.log('聚落 ' + settleN + ' 座 · 建筑实例 ' + buildN + ' 座 · 足迹规划失败 ' + planFail +
            ' · 耗时 ' + (Date.now() - t0) + 'ms\n');

console.log('— 聚落类型 —');
for (const [k, v] of [...typeCnt].sort((a, b) => b[1] - a[1])) console.log('  ' + pad(k, 8) + v);

console.log('\n— 地皮分布 (抽样) —');
for (const [k, v] of [...luCnt].sort((a, b) => b[1] - a[1])) console.log('  ' + pad(k, 8) + v);

console.log('\n— 建筑出现次数 (全集 ' + ALL.size + ' 种) —');
const present = [...kindCnt].sort((a, b) => b[1] - a[1]);
for (const [k, v] of present) {
  console.log('  ✔ ' + pad(k, 10) + pad(String(v), 8) + (CAT.get(k) || '') );
}
const missing = [...ALL].filter(k => !kindCnt.has(k)).sort();
console.log('\n— 定义了但本轮未出现 (' + missing.length + ' 种) —');
if (!missing.length) console.log('  (无)');
for (const k of missing) console.log('  ✘ ' + pad(k, 10) + (CAT.get(k) || ''));

console.log('\n— 地皮→建筑覆盖 —');
for (const [k, v] of [...terrCnt].sort((a, b) => b[1] - a[1])) console.log('  ' + pad(k, 8) + v);

function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s + ' '; }
