/* ============================================================
 * w4_revs_at_scale.mjs — revs 契约与「毒块」恢复的规模化回归
 *
 * 背景: verify/cdp_pan_race.mjs 是「个别色块无贴图」的原始复现, 但它依赖 CDP
 *       驱动真实浏览器, 本机长驻 spawn 会被 SIGTERM → 长期跑不动。
 *       本脚本用纯 Node 直连真实服务端, 在 N 块规模上覆盖同一根因链路:
 *
 *   阶段1 全量首拉        : lastRevs=[] → 必须含 chunk, 记录各块 revs
 *   阶段2 带 revs 重拉    : 必须全部「最小响应」(无任何图层子消息) —— rev 契约
 *   阶段3 丢弃 revs 重拉  : 模拟客户端 blockForget → 必须重新拿到 chunk, 且内容与阶段1 一致
 *                          (毒块的修复核心: 「revs 无记录 ⇒ 必然全量下发」)
 *   阶段4 局部 revs       : 只带 chunk 位 (其余 0) → 其余图层仍必须下发 (W1 契约)
 *
 * 全 Node 原生 WebSocket, 不需要浏览器。用法: node verify/w4_revs_at_scale.mjs [baseUrl] [seed] [块数]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || '42';
const N = parseInt(process.argv[4] || '120', 10);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
function fnv(arrays) {
  let h = 2166136261;
  for (const a of arrays) {
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const v = a[i] | 0;                       // u8/u16/u32 均按整值参与, 不能只取低字节
      h ^= v & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(16);
}
function chunkSig(c) {
  return [c.count, c.pn,
          fnv([c.tiles, c.elev, c.hash, c.neigh]),
          fnv([c.cq, c.cr, c.psp, c.pdx, c.pdy, c.ph, c.pe])].join('|');
}

/* 确定性块采样 (近/中/远) */
let s = 314159; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const seen = new Set(); const blocks = [];
while (blocks.length < N) {
  const d = rnd() < 0.4 ? 12 : rnd() < 0.7 ? 30 : 55;
  const i = Math.round((rnd() * 2 - 1) * d), j = Math.round((rnd() * 2 - 1) * d);
  const k = i + ',' + j; if (seen.has(k)) continue; seen.add(k); blocks.push([i, j]);
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
    const lb = PB.encodeLogin({ account: 'w4', token: 'demo' });
    const lf = new Uint8Array(1 + lb.length); lf[0] = 1; lf.set(lb, 1);
    this.sock.send(lf);
    await new Promise((r) => setTimeout(r, 400));
  }
  tile(i, j, mask = 31, lastRevs = []) {
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

console.log(`== revs 契约与毒块恢复 规模化回归 (seed=${SEED}, ${N} 块) ==`);
const ws = new Ws();
await ws.connect();

/* ---- 阶段1: 全量首拉 ---- */
const revs = new Map(), sig1 = new Map();
let miss1 = 0;
for (const [i, j] of blocks) {
  const r = await ws.tile(i, j, 31, []);
  if (!r.chunk) { miss1++; continue; }
  revs.set(i + ',' + j, r.revs);
  sig1.set(i + ',' + j, chunkSig(r.chunk));
}
check(`阶段1 全量首拉: 全部含 chunk (缺 ${miss1})`, miss1 === 0, `${N - miss1}/${N}`);
check('阶段1 revs 恒为 5 位', [...revs.values()].every((v) => v.length === 5), '');

/* ---- 阶段2: 带 revs 重拉 → 必须最小响应 ---- */
let notMinimal = [];
for (const [i, j] of blocks) {
  const r = await ws.tile(i, j, 31, revs.get(i + ',' + j));
  if (r.chunk || r.regions.length || r.settle || r.poi || r.comms.length) notMinimal.push(`${i},${j}`);
}
check(`阶段2 带 revs 重拉: 全部最小响应 (非最小 ${notMinimal.length})`, notMinimal.length === 0,
  notMinimal.slice(0, 5).join(' '));

/* ---- 阶段3: 丢弃 revs 重拉 → 必须重新拿到与阶段1 一致的 chunk ---- */
let mismatch = [], noChunk = 0;
for (const [i, j] of blocks) {
  const r = await ws.tile(i, j, 31, []);          // 模拟 blockForget 后的请求
  if (!r.chunk) { noChunk++; continue; }
  if (chunkSig(r.chunk) !== sig1.get(i + ',' + j)) mismatch.push(`${i},${j}`);
}
check(`阶段3 丢弃 revs 后必然全量重发 (缺 ${noChunk})`, noChunk === 0, `${N - noChunk}/${N}`);
check(`阶段3 重发内容与首拉逐字节一致 (不一致 ${mismatch.length})`, mismatch.length === 0,
  mismatch.slice(0, 5).join(' '));

/* ---- 阶段4: 只带 chunk 位 → 其余图层仍必须下发 (W1 契约) ---- */
let blocked = [];
for (const [i, j] of blocks.slice(0, 40)) {
  const carried = [revs.get(i + ',' + j)[0], 0, 0, 0, 0];
  const r = await ws.tile(i, j, 31, carried);
  // chunk 该缺省 (rev 命中); region 层必须下发 (rev=0 = 未持有)
  if (r.chunk) blocked.push(`${i},${j}:chunk未缺省`);
  else if (r.regions.length === 0) blocked.push(`${i},${j}:region被误缺省`);
  else if (r.mask !== 31) blocked.push(`${i},${j}:mask=${r.mask}`);
}
check('阶段4 只带 chunk 位: 其余图层未被 rev 误缺省', blocked.length === 0, blocked.slice(0, 5).join(' '));

ws.close();
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
