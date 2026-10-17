/* ============================================================
 * check_people_layer.mjs — 图层5「地图人物分布」在线判据 (方案 v2 · §6)
 * ------------------------------------------------------------
 * 纯 Node 直连真实服务端 (WS 取块 + HTTP 取点击详情), 不需浏览器。
 * 用法: node verify/check_people_layer.mjs [baseUrl] [seed]
 *
 * 覆盖 (与方案 §6 的六条对齐):
 *   ① mask 不含 PEOPLE 位 ⇒ resp.people 必须为 null (关着零开销)
 *      mask 含 PEOPLE 位   ⇒ 必须构建该层 (people 非 null)
 *   ② **不走 rev 去重**: 带旧 lastRevs 重拉, People 层仍必须下发
 *      (否则用户「关→开」热力图时永久空白 —— 这是本层与其它层的关键差异)
 *   ③ 稀疏: 只发 n>0 的格; 每格 ps>0
 *   ④ /api/people 对拍: 同 (q,r) 的 n 一致; Σ(小队 power) == 该格 ps
 *   ⑤ 小队按战力降序 (稳定)
 *   ⑥ 纯派生: 同一 (seed,块) 两次新请求逐字节一致
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || '42';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;
const M_ALL = PB.MASK.ALL;                    // 63 (含 PEOPLE)
const M_PEOPLE = PB.MASK.PEOPLE;              // 32
const M_NO_PEOPLE = M_ALL & ~M_PEOPLE;        // 62

async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

class Ws {
  constructor() { this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/map');
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = () => rej(new Error('ws 失败')); });
    this.sock.onmessage = async (ev) => {
      const u = new Uint8Array(ev.data);
      if (u[0] !== PB.FRAME.TILE) return;
      const resp = PB.decodeTileResponse(await gunzip(u.subarray(1)));
      const p = this.pending.get(resp.seq);
      if (p) { this.pending.delete(resp.seq); p(resp); }
    };
    const lb = PB.encodeLogin({ account: 'verify-people', token: 'demo' });
    const lf = new Uint8Array(1 + lb.length); lf[0] = 1; lf.set(lb, 1);
    this.sock.send(lf);
    await new Promise((r) => setTimeout(r, 400));
  }
  tile(i, j, mask = M_ALL, lastRevs = []) {
    const seq = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(seq); rej(new Error('超时 ' + i + ',' + j)); }, 60000);
      this.pending.set(seq, (r) => { clearTimeout(t); res(r); });
      const b = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask, seq, lastRevs });
      const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.TILE; f.set(b, 1);
      this.sock.send(f);
    });
  }
  close() { try { this.sock.close(); } catch { /* 忽略 */ } }
}

/* 候选块采样 (含靠近原点的聚落密集区) */
const cands = [[0, 0], [1, 1], [2, 1], [3, 3], [1, 2], [2, 0], [0, 1], [-1, 1], [1, -1], [4, 2], [2, 2], [3, 1]];
let s = 20261011;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
for (let k = 0; k < 24; k++) cands.push([Math.round((rnd() * 2 - 1) * 16), Math.round((rnd() * 2 - 1) * 16)]);

console.log(`== 图层5 地图人物分布 在线判据 (seed=${SEED}) ==`);
const ws = new Ws();
await ws.connect();

/* ---- ① mask 位选: 关着不给、开着才构建 ---- */
console.log('\n-- ① mask 位选 --');
let withPeople = null, withoutPeople = null, picked = null;
for (const [i, j] of cands) {
  if (!withoutPeople) {
    const r = await ws.tile(i, j, M_NO_PEOPLE, []);
    if (r.people !== null) { console.log(`  意外: 块(${i},${j}) mask 未含 PEOPLE 却下发 people`); }
    withoutPeople = r;
  }
  const r = await ws.tile(i, j, M_ALL, []);
  if (r.people && r.people.tiles && r.people.tiles.length > 0) { withPeople = r; picked = [i, j]; break; }
  if (!withPeople) withPeople = r;
}
check('①a mask 不含 PEOPLE ⇒ resp.people 为 null', withoutPeople && withoutPeople.people === null,
  withoutPeople ? String(withoutPeople.people) : '无响应');
check('①b mask 含 PEOPLE ⇒ resp.mask 回显含该位且 people 非 null',
  withPeople && (withPeople.mask & M_PEOPLE) !== 0 && withPeople.people !== null,
  withPeople ? JSON.stringify({ mask: withPeople.mask, people: !!withPeople.people }) : '无响应');

/* ---- ③ 稀疏 + ps>0 ---- */
console.log('\n-- ③ 稀疏与战力 --');
let badSparse = 0, badPs = 0, tileCount = 0, sample = null;
for (const [i, j] of cands) {
  const r = await ws.tile(i, j, M_ALL, []);
  const ts = (r.people && r.people.tiles) || [];
  for (const t of ts) {
    tileCount++;
    if (!(t.n > 0)) badSparse++;
    if (!(t.ps > 0)) badPs++;
    if (!sample) sample = { i, j, t };
  }
}
check(`③ 稀疏: 所有格 n>0 (违例 ${badSparse}, 共 ${tileCount} 格)`, badSparse === 0, '');
check(`③ 战力: 所有格 ps>0 (违例 ${badPs})`, badPs === 0, '');

/* ---- ② People 层不走 rev 去重 ---- */
console.log('\n-- ② People 层不 rev 去重 --');
if (picked) {
  const first = await ws.tile(picked[0], picked[1], M_ALL, []);
  const second = await ws.tile(picked[0], picked[1], M_ALL, first.revs);
  check('② 带旧 lastRevs 重拉, People 层仍下发 (否则二次开热力图空白)',
    second.people !== null && !!second.people.tiles && second.people.tiles.length ===
      (first.people && first.people.tiles ? first.people.tiles.length : -1),
    JSON.stringify({ first: first.people && first.people.tiles.length, second: second.people && second.people.tiles && second.people.tiles.length }));
} else {
  console.log('  跳过: 未找到带人物的块 (采样子集内)');
}

/* ---- ⑥ 纯派生: 两次新请求逐字节一致 ---- */
console.log('\n-- ⑥ 纯派生确定性 --');
if (picked) {
  const a = await ws.tile(picked[0], picked[1], M_ALL, []);
  const b = await ws.tile(picked[0], picked[1], M_ALL, []);
  const ja = JSON.stringify((a.people && a.people.tiles) || []);
  const jb = JSON.stringify((b.people && b.people.tiles) || []);
  check('⑥ 同一 (seed,块) 两次请求 people 逐字节一致', ja === jb, ja === jb ? '' : ja + ' != ' + jb);
}

ws.close();

/* ---- ④⑤ /api/people 对拍 ---- */
console.log('\n-- ④⑤ /api/people 对拍 --');
if (sample) {
  const { i, j, t } = sample;
  const url = BASE + '/api/people?seed=' + encodeURIComponent(SEED) + '&q=' + t.q + '&r=' + t.r;
  const d = await (await fetch(url)).json();
  check('④a /api/people 同格 n 一致', (d.n | 0) === (t.n | 0), JSON.stringify({ http: d.n, tile: t.n, kind: d.kind }));
  const sum = (d.squads || []).reduce((a, x) => a + (x.power | 0), 0);
  check('④b Σ(小队 power) == 该格 ps', sum === (t.ps | 0), JSON.stringify({ sum, ps: t.ps }));
  let ordered = true, sizesOk = true;
  for (let k = 0; k < (d.squads || []).length; k++) {
    const q = d.squads[k];
    if (k > 0 && q.power > d.squads[k - 1].power) ordered = false;
    if (!(q.size >= 1 && q.size <= 12)) sizesOk = false;
  }
  check('⑤a 小队按战力降序', ordered, JSON.stringify((d.squads || []).map((x) => x.power)));
  check('⑤b 每队规模 1~12 人', sizesOk && (d.squads || []).length > 0, JSON.stringify((d.squads || []).map((x) => x.size)));
  const d2 = await (await fetch(url)).json();
  check('⑥b /api/people 两次一致 (纯派生)',
    JSON.stringify(d.squads) === JSON.stringify(d2.squads) && d.ps === d2.ps, '');
} else {
  console.log('  跳过: 无样本格');
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
