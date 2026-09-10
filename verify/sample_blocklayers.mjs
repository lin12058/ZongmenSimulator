/* ============================================================
 * sample_blocklayers.mjs — 采样 blockLayersJson 归属映射规模 (review A4 #28)
 *   疑问: 一个块按 COMM_CL=150 判距「可能带出多个群落 × 每个最多 11 条灵脉」,
 *         导致单块 TileResponse 膨胀。
 *   做法: 撒 400 个块, 统计每块的 regions / comms 数量与 comms 的灵脉总数分布。
 *   用法: node verify/sample_blocklayers.mjs [baseUrl] [seed] [样本数]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || '42';
const N = parseInt(process.argv[4] || '400', 10);

global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function pct(arr, p) { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
function stats(arr) {
  return { min: Math.min(...arr), p50: pct(arr, 0.5), p95: pct(arr, 0.95), max: Math.max(...arr), avg: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) };
}

const rnd = mulberry32(20260910);
const blocks = [];
for (let n = 0; n < N; n++) blocks.push([((rnd() * 120) | 0) - 60, ((rnd() * 120) | 0) - 60]);

const sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/map');
sock.binaryType = 'arraybuffer';
await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws 失败')); });
const pending = new Map();
sock.onmessage = (ev) => {
  const u = new Uint8Array(ev.data);
  if (u[0] !== PB.FRAME.TILE) return;
  gunzip(u.subarray(1)).then((buf) => {
    const r = PB.decodeTileResponse(buf);
    const p = pending.get(r.seq);
    if (p) { pending.delete(r.seq); p(r); }
  });
};
const login = PB.encodeLogin({ account: 'sample', token: 'demo' });
const lf = new Uint8Array(1 + login.length); lf[0] = PB.FRAME.LOGIN; lf.set(login, 1);
sock.send(lf);
await new Promise((r) => setTimeout(r, 400));

let seq = 0;
function tile(i, j) {
  const s = ++seq;
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(s); rej(new Error('超时')); }, 60000);
    pending.set(s, (r) => { clearTimeout(t); res(r); });
    const b = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask: 31, seq: s, lastRevs: [] });
    const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.TILE; f.set(b, 1);
    sock.send(f);
  });
}

const regionsN = [], commsN = [], veinsN = [];
for (const [i, j] of blocks) {
  const r = await tile(i, j);
  regionsN.push(r.regions.length);
  commsN.push(r.comms.length);
  let v = 0;
  for (const c of r.comms) v += (c.veins ? c.veins.length : 0);
  veinsN.push(v);
}
sock.close();

console.log(`== blockLayers 规模采样 (seed=${SEED}, ${N} 块) ==`);
console.log('  regions/块 :', JSON.stringify(stats(regionsN)));
console.log('  comms/块   :', JSON.stringify(stats(commsN)));
console.log('  灵脉数/块  :', JSON.stringify(stats(veinsN)));
const over = commsN.filter((v) => v > 3).length;
console.log(`  comms>3 的块: ${over}/${N} (${(over / N * 100).toFixed(1)}%)  → 原判「多群落多灵脉膨胀」${over / N > 0.2 ? '成立' : '不成立'}`);
process.exit(0);
