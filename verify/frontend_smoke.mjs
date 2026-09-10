/* ============================================================
 * frontend_smoke.mjs — 在 Node 中「完整模拟前端」数据流
 *   直接复用 web/js/pb.js + web/js/mapclient.js (与浏览器同份) 拉取
 *   /api/map/* 后解码, 验证元信息常量 + 几何往返 + HTTP 侧数据还原, 不依赖浏览器/GL。
 *
 *   注: chunk/region/comm 在 WebSocket 单块重构后已下线 HTTP 接口,
 *       其数据正确性由 verify_map.mjs (WS 链路) / w1_client_revs.mjs 覆盖;
 *       本脚本只负责「HTTP 辅助接口 (meta/tile/fields) + 几何公式」这一层。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';

/* 全局注入 window = globalThis 以原样执行浏览器脚本 */
global.window = globalThis;
/* mapclient.js 模块级会读 location.protocol/host 拼 WS_URL — Node 里必须提供 */
global.location = { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') };
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

async function fetchTile(seed, q, r) {
  const t = await MC.tile(seed, q, r);
  check(`tile(${q},${r}) e in [0,1]`, t.e >= 0 && t.e <= 1, String(t.e));
  check(`tile(${q},${r}) biome 0..7`, t.biome >= 0 && t.biome <= 7, String(t.biome));
  check(`tile(${q},${r}) 区域名非空`, typeof t.regionName === 'string' && t.regionName.length > 0,
    String(t.regionName));
  return t;
}

async function fetchFields(seed, q0, q1, r0, r1) {
  const g = await MC.fieldGrid(seed, q0, q1, r0, r1);
  check(`fields 网格大小`, g.nq === q1 - q0 + 1 && g.nr === r1 - r0 + 1, `${g.nq}x${g.nr}`);
  check(`fields data 字节数`, g.data.length === g.nq * g.nr, String(g.data.length));
  return g;
}

function checkGeometry() {
  const G = MC.geo();
  let bad = 0, samples = 0;
  for (let i = 0; i < 200; i++) {
    const q = (Math.random() * 2000 | 0) - 1000;
    const r = (Math.random() * 2000 | 0) - 1000;
    const w = MC.tileToWorld(q, r);
    const back = MC.pxToTile(w.x, w.y);
    samples++;
    if (back.q !== q || back.r !== r) {
      bad++;
      if (bad <= 3) console.log(`  FAIL 几何往返 (${q},${r}) -> (${back.q},${back.r})`);
    }
  }
  check(`几何往返 ${samples} 次 (大坐标 ±1000)`, bad === 0, `不一致 ${bad} 次`);
  check('geo() 结果被缓存复用', MC.geo() === G);
}

console.log('== 元信息 ==');
await fetchMeta();

const seed = '42';
console.log(`\n== HTTP 辅助接口模拟前端 (seed=${seed}) ==`);
await fetchTile(seed, 0, 0);
await fetchTile(seed, 5, -3);
await fetchTile(seed, -8, 7);
await fetchFields(seed, -10, 10, -10, 10);

/* HTTP tile 缓存头已改 no-cache (内容随 roadVer 变), 顺带断言不再给长缓存 */
{
  const r = await fetch(BASE + '/api/map/tile?seed=42&q=0&r=0');
  const cc = r.headers.get('cache-control') || '';
  check('tile 响应头不再含 max-age 长缓存', !/max-age=(?!0)/.test(cc), cc);
}

console.log('\n== 几何公式往返 ==');
checkGeometry();

console.log(`\n========== 前端模拟: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);
