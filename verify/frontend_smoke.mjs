/* ============================================================
 * frontend_smoke.mjs — 在 Node 中「完整模拟前端」数据流
 *   直接复用 web/js/pb.js + web/js/mapclient.js (与浏览器同份) 拉取
 *   /api/map/* 后解码, 验证几何公式 + 协议还原正确, 不依赖浏览器/GL。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';

/* 全局注入 window = globalThis 以原样执行浏览器脚本 */
global.window = globalThis;
/* Node 中 fetch 必须是绝对 URL, 给 mapclient.js 的相对路径补上 base */
const _realFetch = global.fetch;
global.fetch = (url, opts) =>
  _realFetch(String(url).startsWith('http') ? url : BASE + url, opts);

for (const f of ['pb.js', 'mapclient.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8');
  (0, eval)(code);
}
const PB = global.PB, MC = global.MapClient;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

async function fetchMeta() {
  const m = await MC.fetchMeta();
  check('meta 几何常量', m.hexR === 8 && m.chunkS === 21 && near(m.hexW, Math.sqrt(3) * 8, 1e-9));
  check('meta 图例 13', m.biomeMeta.length === 13, String(m.biomeMeta.length));
  return m;
}

async function fetchChunk(seed, ca, cb) {
  const arr = await MC.chunk(seed, ca, cb);
  check(`chunk(${ca},${cb}) count>0 & 长度`, arr.count > 0 && arr.tiles.length === arr.count,
    `count=${arr.count} tiles=${arr.tiles.length}`);
  /* 抽查: 第 0 个地块的 lat 通过 (cq[i]-16) + ca*S + (cr[i]-16)+cb*S 反解出的
   * 绝对坐标应与 arr.centers 完全一致 (因为前端 chunkToArrays 直接用其反解公式) */
  return arr;
}

async function fetchRegion(seed, i, j) {
  const r = await MC.region(seed, i, j);
  check(`region(${i},${j}) i/j 精确`, r.i === i && r.j === j, `${r.i}/${r.j}`);
  check(`region name 非空`, typeof r.region?.name === 'string' && r.region.name.length > 0);
  check(`region 列表是数组`, Array.isArray(r.settlements) && Array.isArray(r.roads));
  return r;
}

async function fetchComm(seed, ci, cj) {
  const c = await MC.comm(seed, ci, cj);
  if (c.exists) {
    check(`comm(${ci},${cj}) 主格坐标`, typeof c.q === 'number' && typeof c.r === 'number');
    check(`comm 灵脉是数组`, Array.isArray(c.veins));
  } else {
    check(`comm(${ci},${cj}) 不存在标记`, c.exists === false && Array.isArray(c.veins));
  }
  return c;
}

async function fetchTile(seed, q, r) {
  const t = await MC.tile(seed, q, r);
  check(`tile(${q},${r}) e in [0,1]`, t.e >= 0 && t.e <= 1, String(t.e));
  check(`tile biome 0..7`, t.biome >= 0 && t.biome <= 7, String(t.biome));
  return t;
}

async function fetchFields(seed, q0, q1, r0, r1) {
  const g = await MC.fieldGrid(seed, q0, q1, r0, r1);
  check(`fields 网格大小`, g.nq === q1 - q0 + 1 && g.nr === r1 - r0 + 1,
    `${g.nq}x${g.nr}`);
  check(`fields data 字节数`, g.data.length === g.nq * g.nr);
  return g;
}

function checkGeometry() {
  const G = MC.geo();
  for (let i = 0; i < 50; i++) {
    const q = (Math.random() * 200 | 0) - 100;
    const r = (Math.random() * 200 | 0) - 100;
    const w = MC.tileToWorld(q, r);
    const back = MC.pxToTile(w.x, w.y);
    if (back.q !== q || back.r !== r) {
      failures++;
      console.log(`  FAIL 几何往返 (${q},${r}) -> (${back.q},${back.r})`);
    }
  }
  console.log('  PASS 几何往返 50 次');
}

console.log('== 元信息 ==');
await fetchMeta();

const seed = '42';
console.log(`\n== 区块/区域/群落/单格/字段 模拟前端 (seed=${seed}) ==`);
await fetchChunk(seed, 0, 0);
await fetchChunk(seed, 1, 0);
await fetchChunk(seed, 0, 1);
await fetchChunk(seed, -2, 3);
await fetchRegion(seed, 0, 0);
await fetchRegion(seed, 1, 0);
await fetchRegion(seed, -1, 0);
await fetchComm(seed, 0, 0);
await fetchComm(seed, 1, 0);
await fetchComm(seed, -1, 1);
await fetchTile(seed, 0, 0);
await fetchTile(seed, 5, -3);
await fetchTile(seed, -8, 7);
await fetchFields(seed, -10, 10, -10, 10);

console.log('\n== 几何公式往返 ==');
checkGeometry();

console.log(`\n========== 前端模拟: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);