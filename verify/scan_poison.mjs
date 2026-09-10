/* scan_poison.mjs — 广域扫描: 用浏览器同款 pb.js 解码每块响应, 抓毒块 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || '42';
/* 扫描范围: 块坐标 [ia,ib,ja,jb] */
const [ia, ib, ja, jb] = JSON.parse(process.argv[4] || '[-80,80,-80,80]');

global.window = globalThis;
for (const f of ['noise.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

class Ws {
  constructor(base) { this.url = base.replace(/^http/, 'ws') + '/ws/map'; this.seq = 0; this.pending = new Map(); }
  async connect() {
    this.sock = new WebSocket(this.url);
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = () => rej(new Error('ws fail')); });
    this.sock.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data));
    const login = PB.encodeLogin({ account: 'guest', token: 'demo' });
    const f = new Uint8Array(1 + login.length); f[0] = PB.FRAME.LOGIN; f.set(login, 1);
    this.sock.send(f);
    await new Promise((res) => { this._loginRes = res; });
  }
  onFrame(u8) {
    const type = u8[0], payload = u8.subarray(1);
    if (type === PB.FRAME.LOGIN) { this._loginRes(); return; }
    if (type === PB.FRAME.TILE) {
      new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        .then((buf) => {
          const resp = PB.decodeTileResponse(buf);
          const p = this.pending.get(resp.seq);
          if (p) { this.pending.delete(resp.seq); p({ ok: true, resp }); }
        })
        .catch((err) => {
          // 解码失败: 找出超时的 pending (近似: 直接广播给所有等待者不行 — 记日志)
          console.log('DECODE_FAIL seed=' + SEED, err && err.message);
          this._lastDecodeErr = err;
        });
    }
  }
  block(i, j) {
    const sseq = ++this.seq;
    const body = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask: PB.MASK.ALL, seq: sseq, lastRevs: [] });
    const f = new Uint8Array(1 + body.length); f[0] = PB.FRAME.TILE; f.set(body, 1);
    this.sock.send(f);
    return new Promise((res) => {
      const timer = setTimeout(() => {
        if (this.pending.has(sseq)) { this.pending.delete(sseq); res({ ok: false, why: 'timeout(可能解码失败)' }); }
      }, 8000);
      this.pending.set(sseq, (resp) => { clearTimeout(timer); res(resp); });
    });
  }
}

const ws = new Ws(BASE);
await ws.connect();

let n = 0, bad = 0, t0 = Date.now();
const CONC = 12;
const jobs = [];
for (let i = ia; i <= ib; i++) for (let j = ja; j <= jb; j++) jobs.push([i, j]);
let idx = 0;
async function worker() {
  while (idx < jobs.length) {
    const [i, j] = jobs[idx++];
    const r = await ws.block(i, j);
    n++;
    if (!r.ok) { bad++; console.log(`BAD block(${i},${j}) ${r.why}`); }
    else if (r.resp.err) { bad++; console.log(`ERR block(${i},${j}) ${r.resp.err}`); }
    else if (!r.resp.chunk) { bad++; console.log(`NO_CHUNK block(${i},${j}) (lastRevs 空 却缺 chunk!)`); }
    if (n % 200 === 0) console.log(`... ${n} blocks, ${Date.now() - t0}ms`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`scanned=${n} bad=${bad} elapsed=${Date.now() - t0}ms`);
process.exit(0);
