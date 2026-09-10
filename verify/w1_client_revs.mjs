/* ============================================================
 * w1_client_revs.mjs — W1 回归: 验证 web/js/mapclient.js 的 revs 记账
 *   问题: onFrame 过去无条件把响应里的 5 个 rev 全量写入本地缓存。
 *         一旦服务端按「非全量 mask」或「未登录被拒」只下发了部分图层,
 *         本地就把没收到数据的图层 rev 记为已持有 → 下次请求服务端判
 *         「rev 未变」而缺省下发 → 该图层(聚落/景点/灵脉)永久缺失。
 *   修复: 只更新 resp.mask 命中位, 其余位保持原值(0=未持有)。
 *
 * 做法:
 *   ① 用 Node 原生 WebSocket 连真实服务端, 取一条 mask=CHUNK 的真实响应,
 *      确认服务端契约 (mask 精确回显 / revs 仍为 5 位);
 *   ② 用假 WebSocket 驱动真实 mapclient.js, 按每个请求的 seq 注入合成响应
 *      (mask=CHUNK) → 断言下一个请求只带 chunk 位 (旧逻辑会带 5 个 1);
 *   ③ 再注入一次全量响应 (mask=ALL) → 断言 revs 恢复为 5 位。
 *
 * 用法: node verify/w1_client_revs.mjs [baseUrl]   (默认 http://127.0.0.1:8140)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = '42';
const BLK = [3, 3];                       // 与 verify_map.mjs 的 W1 用例同块

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

/* ---------- 极简 protobuf 读/写 ---------- */
function vi(b, p) { let r = 0, s = 0; while (true) { const x = b[p++]; r += (x & 127) * Math.pow(2, s); if (!(x & 128)) return [r, p]; s += 7; } }
function zz(v) { return v >= 0 ? v * 2 : -v * 2 - 1; }

/* 解析 TileRequest: 取 seq(field 6) 与 lastRevs(field 7) */
function parseTileRequest(frame) {
  let p = 1; const end = frame.length; const out = { seq: 0, lastRevs: [] };
  const skip = (pp, w) => {
    if (w === 0) { const [, n] = vi(frame, pp); return n; }
    if (w === 2) { const [l, n] = vi(frame, pp); return n + l; }
    if (w === 5) return pp + 4;
    if (w === 1) return pp + 8;
    return end;
  };
  while (p < end) {
    const [tag, p1] = vi(frame, p); p = p1;
    const f = tag >> 3, w = tag & 7;
    if (f === 6 && w === 0) { const [v, n] = vi(frame, p); out.seq = v; p = n; }
    else if (f === 7 && w === 2) {
      const [len, p2] = vi(frame, p); let q = p2; const e = q + len;
      while (q < e) { const [v, nq] = vi(frame, q); out.lastRevs.push(v); q = nq; }
      p = e;
    } else p = skip(p, w);
  }
  return out;
}

/* 合成最小 TileResponse (i/j/mask/seq/revs — 客户端记账只依赖这些字段) */
function encTileResponse({ i, j, mask, seq, revs }) {
  const w = [];
  const push = (v) => { v = Math.round(v); while (v >= 128) { w.push((v % 128) | 128); v = Math.floor(v / 128); } w.push(v); };
  const tag = (f, wt) => push(f * 8 + wt);
  tag(1, 0); push(zz(i));
  tag(2, 0); push(zz(j));
  tag(3, 0); push(mask);
  tag(6, 0); push(seq);
  const tmp = [];
  for (const r of revs) { let v = Math.round(r); while (v >= 128) { tmp.push((v % 128) | 128); v = Math.floor(v / 128); } tmp.push(v); }
  tag(7, 2); push(tmp.length); for (const x of tmp) w.push(x);
  return new Uint8Array(w);
}
async function gzip(u8) {
  const cs = new CompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
}
async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

/* ---------- 引用: pb.js ---------- */
global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

/* ---------- ① 真实服务端契约确认 ---------- */
async function realPartialResponse() {
  const sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/map');
  sock.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error('ws 连接失败')); });
  const inbox = [];
  sock.onmessage = (ev) => inbox.push(new Uint8Array(ev.data));

  const lb = PB.encodeLogin({ account: 'w1cli', token: 'demo' });
  const lframe = new Uint8Array(1 + lb.length); lframe[0] = 1; lframe.set(lb, 1);
  sock.send(lframe);
  await new Promise((r) => setTimeout(r, 400));

  const body = PB.encodeTileRequest({ op: 1, seed: SEED, i: BLK[0], j: BLK[1], mask: PB.MASK.CHUNK, seq: 7, lastRevs: [] });
  const tf = new Uint8Array(1 + body.length); tf[0] = 2; tf.set(body, 1);
  sock.send(tf);
  await new Promise((r) => setTimeout(r, 800));
  sock.close();

  const tiles = inbox.filter((f) => f[0] === PB.FRAME.TILE);
  if (!tiles.length) throw new Error('未收到 TileResponse');
  const resp = PB.decodeTileResponse(await gunzip(tiles[tiles.length - 1].subarray(1)));
  return resp;
}

/* ---------- ② 假 WebSocket 驱动真实 mapclient.js ---------- */
function driveClient() {
  const sent = [];
  const seen = [];                 // 每条 TILE 请求的 {seq,lastRevs}
  let fake = null;
  let mode = 'partial';            // 注入的响应类型

  class FakeWS {
    constructor(u) {
      this.url = u; this.readyState = 0; this.binaryType = '';
      fake = this;
      setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0);
    }
    send(f) { sent.push(Uint8Array.from(f)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  }

  const savedWS = global.WebSocket, savedLoc = global.location;
  global.WebSocket = FakeWS;
  global.location = { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') };
  delete global.MapClient;
  (0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'mapclient.js'), 'utf8'));
  const MC = global.MapClient;

  const pump = () => {
    while (sent.length) {
      const f = sent.shift();
      if (f[0] === PB.FRAME.LOGIN) {
        setTimeout(() => fake.onmessage({ data: Uint8Array.from([PB.FRAME.LOGIN, 0x08, 0x01]).buffer }), 0);
      } else if (f[0] === PB.FRAME.TILE) {
        const req = parseTileRequest(f);
        seen.push(req);
        const mask = mode === 'partial' ? PB.MASK.CHUNK : PB.MASK.ALL;
        setTimeout(() => {
          gzip(encTileResponse({ i: BLK[0], j: BLK[1], mask, seq: req.seq, revs: [1, 1, 1, 1, 1] }))
            .then((gz) => {
              const frame = new Uint8Array(1 + gz.length);
              frame[0] = PB.FRAME.TILE; frame.set(gz, 1);
              fake.onmessage({ data: frame.buffer });
            });
        }, 0);
      }
    }
  };
  const tick = setInterval(pump, 5);
  return {
    MC, seen,
    setMode: (m) => { mode = m; },
    stop: () => { clearInterval(tick); global.WebSocket = savedWS; global.location = savedLoc; }
  };
}

/* ---------- 主流程 ---------- */
console.log('== W1 客户端 revs 记账回归 ==');
const real = await realPartialResponse();
console.log(`  服务端真实响应: mask=${real.mask} chunk=${!!real.chunk} regions=${real.regions.length} revs=${JSON.stringify(real.revs)}`);
check('服务端: 非全量请求 mask 精确回显 =CHUNK', real.mask === PB.MASK.CHUNK, String(real.mask));
check('服务端: revs 仍为 5 位契约不变', real.revs.length === 5, JSON.stringify(real.revs));

/* ---------- pb.js packed varint 解码回归 (长度前缀不得被重复计数) ---------- */
{
  const packed = encTileResponse({ i: 1, j: 2, mask: PB.MASK.ALL, seq: 9, revs: [1, 2, 3, 4, 5] });
  const d = PB.decodeTileResponse(packed);
  check('pb.js: packed revs 全量解码为 5 项 (旧实现少 1 项)',
    d.revs.length === 5 && d.revs[0] === 1 && d.revs[4] === 5, JSON.stringify(d.revs));
}

const env = driveClient();
await env.MC.block(SEED, BLK[0], BLK[1]);          // 第 1 次: 收到 mask=CHUNK
await new Promise((r) => setTimeout(r, 60));
check('第 1 次请求未携带 lastRevs (本地无记录)',
  env.seen.length >= 1 && env.seen[0].lastRevs.length === 0, JSON.stringify(env.seen[0]));

await env.MC.block(SEED, BLK[0], BLK[1]);          // 第 2 次: 只应带 chunk 位
await new Promise((r) => setTimeout(r, 60));
const carried = env.seen[1] ? env.seen[1].lastRevs : [];
check('第 2 次请求 lastRevs 只记 chunk 位 (其余 4 位为 0)',
  carried.length === 5 && carried[0] > 0 && carried[1] === 0 && carried[2] === 0 && carried[3] === 0 && carried[4] === 0,
  JSON.stringify(carried));

env.setMode('full');
await env.MC.block(SEED, BLK[0], BLK[1]);          // 第 3 次: 收到 mask=ALL (此时仍是旧的 1 位记账)
await new Promise((r) => setTimeout(r, 60));
await env.MC.block(SEED, BLK[0], BLK[1]);          // 第 4 次: 应体现全量响应后的 5 位记账
await new Promise((r) => setTimeout(r, 60));
const carried2 = env.seen[3] ? env.seen[3].lastRevs : [];
check('全量响应后 revs 恢复为 5 位全非 0',
  carried2.length === 5 && carried2.every((v) => v > 0), JSON.stringify(carried2));
env.stop();

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
