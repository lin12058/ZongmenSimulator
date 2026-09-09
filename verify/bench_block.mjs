/* bench_block.mjs — 测量服务端 WS 单块构建耗时 (冷/热), 定位卡顿源头 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = process.argv[3] || '42';

global.window = globalThis;
for (const f of ['noise.js', 'mapgen.js', 'mapgen-server.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8');
  (0, eval)(code);
}
const PBcode = fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8');
(0, eval)(code0());
function code0() { return fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'); }
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
          if (p) { this.pending.delete(resp.seq); p(resp); }
        });
    }
  }
  block(i, j, lastRevs) {
    const sseq = ++this.seq;
    const body = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask: PB.MASK.ALL, seq: sseq, lastRevs: lastRevs || [] });
    const f = new Uint8Array(1 + body.length); f[0] = PB.FRAME.TILE; f.set(body, 1);
    this.sock.send(f);
    return new Promise((res) => this.pending.set(sseq, res));
  }
}

const ws = new Ws(BASE);
await ws.connect();

// 远处冷块: 模拟玩家拖到新区域 (原点以东 ~40 块 ≈ 800+ 格)
const cases = JSON.parse(process.argv[4] || '[[40,0],[41,0],[42,0],[40,1],[41,1],[42,1],[43,0],[43,1]]');
for (const [i, j] of cases) {
  const t0 = Date.now();
  const resp = await ws.block(i, j);
  const ms = Date.now() - t0;
  const has = { chunk: !!resp.chunk, regions: resp.regions.length, settles: resp.settle ? resp.settle.groups.length : 0, comms: resp.comms.length, err: resp.err || '' };
  // 再拉一次热缓存
  const t1 = Date.now();
  await ws.block(i, j, resp.revs);
  const ms2 = Date.now() - t1;
  console.log(`block(${i},${j})  cold=${ms}ms  hot(rev)=${ms2}ms  ${JSON.stringify(has)}`);
}
console.log('done');
process.exit(0);
