/* ============================================================
 * chunk_selfcalc_ab.mjs — A/B 铁证: 「前端自算的块」与「服务端下发的块」
 *                          是否逐字节相同
 *
 * A 侧: 本地按 seed 自算 (MapGen.buildChunk → mapgen-server 打包布局)
 * B 侧: 对着真实服务端发 TileRequest(mask=CHUNK), 收 gzip(protobuf) 解出
 *
 * 两侧同源 (服务端 JsEngineHost 与前端 ScriptPack 下发的都是同一份
 * noise.js + mapgen-config.js + mapgen.js), 因此逐字节一致 = 前端自算
 * 不是"近似复刻", 而是"等价替换" —— 这是改造可行性的正确性前提。
 *
 * 跑法: node verify/chunk_selfcalc_ab.mjs [baseUrl] [seed]
 * 默认 http://127.0.0.1:8140 (只读请求, 不动用户实例)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || 'abcalc-selfcalc';

/* ---------- 加载: 前端 pb.js + 引擎四件套 (与服务端同序) ---------- */
global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js'])
  (0, eval)(fs.readFileSync(path.join(JSDIR, f), 'utf8'));
const MG = global.MapGen, SVC = global.MapGenServer;
MG.init(SEED);

/* ---------- A 侧: 自算 + 按线上布局切段 ---------- */
function selfChunk(ca, cb) {
  const j = JSON.parse(SVC.chunkJson(ca, cb));
  const raw = Buffer.from(j.d, 'base64');
  const n = j.count, pn = j.pn;
  const seg = (o, len) => new Uint8Array(raw.buffer, raw.byteOffset + o, len);
  let o = 0;
  const out = { ca: j.ca, cb: j.cb, count: n, pn: pn };
  out.cq = seg(o, n); o += n;
  out.cr = seg(o, n); o += n;
  out.tiles = seg(o, n); o += n;
  out.elev = seg(o, 2 * n); o += 2 * n;
  out.hash = seg(o, 2 * n); o += 2 * n;
  out.neigh = seg(o, 4 * n); o += 4 * n;
  out.pdx = seg(o, 4 * pn); o += 4 * pn;
  out.pdy = seg(o, 4 * pn); o += 4 * pn;
  out.psp = seg(o, pn); o += pn;
  out.ph = seg(o, 2 * pn); o += 2 * pn;
  out.pe = seg(o, 2 * pn); o += 2 * pn;
  out.leftover = raw.length - o;
  return out;
}

/* ---------- B 侧: 真实 WS ---------- */
async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
class Ws {
  async connect() {
    this.seq = 0; this.pending = new Map();
    this.sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/map');
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = () => rej(new Error('WS 连接失败')); });
    this.sock.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data));
  }
  onFrame(u8) {
    const type = u8[0], payload = u8.subarray(1);
    if (type !== PB.FRAME.TILE) return;
    gunzip(payload).then((buf) => {
      let resp;
      try { resp = PB.decodeTileResponse(buf); } catch (e) { return; }
      const p = this.pending.get(resp.seq);
      if (!p) return;
      this.pending.delete(resp.seq);
      clearTimeout(p.timer);
      p.resolve(resp);
    }, () => {});
  }
  block(ca, cb) {
    return new Promise((res, rej) => {
      const seq = ++this.seq;
      const body = PB.encodeTileRequest({ op: 1, seed: SEED, i: ca, j: cb, mask: PB.MASK.CHUNK, seq: seq, lastRevs: [] });
      const frame = new Uint8Array(1 + body.length);
      frame[0] = PB.FRAME.TILE; frame.set(body, 1);
      const timer = setTimeout(() => { this.pending.delete(seq); rej(new Error('超时 ' + ca + ',' + cb)); }, 15000);
      this.pending.set(seq, { resolve: res, reject: rej, timer: timer });
      this.sock.send(frame);
    });
  }
}

/* ---------- 逐字段比对 ---------- */
function cmpSeg(name, a, b, rows) {
  if (!b) return rows.push([name, '缺失', '远端无此段']);
  const n = Math.min(a.length, b.length);
  let firstDiff = -1, diffCount = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) { if (firstDiff < 0) firstDiff = i; diffCount++; }
  const same = a.length === b.length && diffCount === 0;
  rows.push([name, same ? '一致' : '不一致',
    'len ' + a.length + (a.length !== b.length ? ' vs ' + b.length : '') +
    (same ? '' : ' | 首个差异 @' + firstDiff + ' 共 ' + diffCount + ' 处')]);
  return same;
}

const blocks = [[0, 0], [1, -1], [-2, 3], [4, 5], [-7, -4], [12, -9]];
console.log('seed = ' + SEED + '   base = ' + BASE);
console.log('块坐标          前端自算(ms)   服务端帧(bytes)  地块段  精灵段');
console.log('-'.repeat(78));

const ws = new Ws();
await ws.connect();

let allSame = true, totalSelf = 0, totalWire = 0;
const detail = [];
for (const [ca, cb] of blocks) {
  const t0 = performance.now();
  const A = selfChunk(ca, cb);
  const selfMs = performance.now() - t0;

  const resp = await ws.block(ca, cb);
  const B = resp.chunk;
  totalSelf += selfMs;
  if (!B) { console.log(`(${ca},${cb})  服务端未返回 chunk 层`); allSame = false; continue; }
  totalWire += 0;   // 帧大小在 ws 层未透出, 单独量

  const rows = [];
  for (const k of ['cq', 'cr', 'tiles', 'elev', 'hash', 'neigh', 'pdx', 'pdy', 'psp', 'ph', 'pe'])
    if (!cmpSeg(k, A[k], B[k], rows)) allSame = false;
  if (A.count !== B.count) { allSame = false; rows.push(['count', '不一致', A.count + ' vs ' + B.count]); }
  if (A.pn !== B.pn) { allSame = false; rows.push(['pn', '不一致', A.pn + ' vs ' + B.pn]); }

  const bad = rows.filter((r) => r[1] === '不一致');
  console.log(`(${String(ca).padStart(3)},${String(cb).padStart(3)})  ` +
    `${selfMs.toFixed(2).padStart(9)}   n=${String(B.count).padStart(3)} pn=${String(B.pn).padStart(3)}    ` +
    (bad.length ? '✗ ' + bad.length + ' 段不一致' : '✓ 全段逐字节一致'));
  if (bad.length) detail.push([ca, cb, bad]);
}

console.log('-'.repeat(78));
console.log(`前端自算 ${blocks.length} 块合计 ${totalSelf.toFixed(1)} ms (均 ${(totalSelf / blocks.length).toFixed(2)} ms/块)`);
console.log(`结论: ${allSame ? '✓ A/B 逐字节一致 —— 前端自算与下发等价, 可安全替换' : '✗ 存在不一致, 需逐项排查'}`);
for (const [ca, cb, bad] of detail) {
  console.log(`  (${ca},${cb}):`);
  for (const r of bad) console.log('    ' + r[0] + '  ' + r[2]);
}
try { ws.sock.close(); } catch (e) { /* ignore */ }
process.exit(allSame ? 0 : 1);
