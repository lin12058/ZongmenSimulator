/* ============================================================
 * w2_concurrency.mjs — 并发/缓存回归 (W2: blockLayers LRU + 冷 VM 并发构建)
 *   1) 同一「新 seed」冷启动下 24 路并发 WS 请求 (6 块 × 4 客户端):
 *        - 全部成功, 每块 chunk/region 图层齐备;
 *        - 同块不同客户端的 chunk 字节完全一致 (确定性与 in-flight 去重);
 *        - liveSeeds 不超过 MaxSeeds(3) —— 冷建 VM 的 double-check 未泄漏实例。
 *   2) 同块重复请求 (blockLayersJson 走 LRU 后) 响应内容保持一致。
 *
 * 用法: node verify/w2_concurrency.mjs [baseUrl]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const SEED = 'w2c' + (Date.now() % 1000000);        // 每次运行都是新 seed → 强制冷 VM

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
async function stats() {
  const r = await fetch(BASE + '/api/map/stats');
  return r.json();
}

class Ws {
  constructor() { this.seq = 0; this.pending = new Map(); this.loginWaiter = null; }
  async connect() {
    this.sock = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws/map');
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => { this.sock.onopen = res; this.sock.onerror = () => rej(new Error('ws 失败')); });
    this.sock.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data));
  }
  onFrame(u8) {
    const type = u8[0], payload = u8.subarray(1);
    if (type === PB.FRAME.LOGIN) {
      const lr = PB.decodeLoginResponse(payload);
      if (this.loginWaiter) { this.loginWaiter(lr); this.loginWaiter = null; }
      return;
    }
    if (type === PB.FRAME.TILE) {
      gunzip(payload).then((buf) => {
        const resp = PB.decodeTileResponse(buf);
        const p = this.pending.get(resp.seq);
        if (!p) return;
        this.pending.delete(resp.seq);
        clearTimeout(p.timer);
        p.resolve(resp);
      });
    }
  }
  async login() {
    const p = new Promise((r) => { this.loginWaiter = r; });
    const b = PB.encodeLogin({ account: 'w2', token: 'demo' });
    const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.LOGIN; f.set(b, 1);
    this.sock.send(f);
    return p;
  }
  async tile(i, j, mask = 0, lastRevs = []) {
    const sseq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(sseq); reject(new Error('ws 超时')); }, 60000);
      this.pending.set(sseq, { resolve, reject, timer });
      const b = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask, seq: sseq, lastRevs });
      const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.TILE; f.set(b, 1);
      this.sock.send(f);
    });
  }
  close() { try { this.sock.close(); } catch { /* 忽略 */ } }
}

console.log('== W2 并发 / 缓存回归 (seed=' + SEED + ') ==');
console.log('\n== 冷 VM 24 路并发 ==');
{
  const before = await stats();
  const BLOCKS = [[0, 0], [1, 0], [0, 1], [2, 2], [-1, 1], [3, -1]];
  const PER = 4;                                    // 每块 4 个客户端 → 24 路

  const jobs = [];
  const clients = [];
  for (const [ca, cb] of BLOCKS) {
    for (let k = 0; k < PER; k++) {
      jobs.push((async () => {
        const w = new Ws();
        await w.connect();
        await w.login();
        clients.push(w);
        return { ca, cb, resp: await w.tile(ca, cb) };
      })());
    }
  }
  const results = await Promise.all(jobs);
  const t0 = Date.now();
  check('24 路并发全部返回', results.length === 24 && results.every((r) => r.resp && r.resp.err === ''),
    results.filter((r) => r.resp && r.resp.err).map((r) => r.resp.err).join('|'));

  const okLayers = results.every((r) => !!r.resp.chunk && r.resp.regions.length > 0 && r.resp.mask === 31);
  check('每块 chunk+region 图层齐备且 mask=ALL', okLayers,
    JSON.stringify(results.filter((r) => !(r.resp.chunk && r.resp.regions.length)).map((r) => [r.ca, r.cb])));

  /* 同块多客户端 chunk 字节一致 (in-flight 去重 + 确定性) */
  const byBlock = new Map();
  for (const r of results) {
    const key = r.ca + ',' + r.cb;
    const hex = Array.from(r.resp.chunk).join(',');
    if (!byBlock.has(key)) byBlock.set(key, []);
    byBlock.get(key).push(hex);
  }
  let allSame = true;
  byBlock.forEach((arr) => { if (new Set(arr).size !== 1) allSame = false; });
  check('同块各客户端 chunk 字节一致', allSame, '');

  const after = await stats();
  check('liveSeeds 有界 (LRU 淘汰生效, 冷建未泄漏实例)',
    after.liveSeeds <= after.maxSeeds && after.maxSeeds > 0,
    JSON.stringify({ before: before.liveSeeds, after: after.liveSeeds, max: after.maxSeeds }));
  console.log(`  (并发耗时 ${Date.now() - t0}ms, liveSeeds ${before.liveSeeds} → ${after.liveSeeds}, maxSeeds=${after.maxSeeds})`);
  /* 锁定「appsettings.json 被静默忽略」回归: 配置里 MaxSeeds=3, 代码默认是 4 */
  check('appsettings.json 已生效 (maxSeeds=3, 非代码默认 4)', after.maxSeeds === 3, String(after.maxSeeds));

  /* 同块重复请求一致性 (blockLayersJson / raw 缓存命中路径) */
  const w = clients[0];
  const a = await w.tile(BLOCKS[0][0], BLOCKS[0][1]);
  const b = await w.tile(BLOCKS[0][0], BLOCKS[0][1]);
  check('同块重复请求图层集合一致',
    a.regions.length === b.regions.length && a.comms.length === b.comms.length &&
    (!!a.settle) === (!!b.settle) && (!!a.poi) === (!!b.poi),
    JSON.stringify({ a: [a.regions.length, a.comms.length], b: [b.regions.length, b.comms.length] }));

  clients.forEach((c) => c.close());
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
