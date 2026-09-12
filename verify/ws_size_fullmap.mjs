/* ============================================================
 * ws_size_fullmap.mjs — 走真实 WebSocket 链路实测「整张地图加载」体积
 * ------------------------------------------------------------
 * 对着真实服务端 (默认 http://127.0.0.1:8141, 独立实例) 按块发 TileRequest,
 * 量的是线上真实帧: [1B 类型][gzip(protobuf)]。
 *
 *   Pass 1: mask=ALL 冷扫全部块  ← 整图一次性加载的真实总量
 *   Pass 2~6: 单图层扫 (CHUNK/REGION/SETTLE/POI/COMM) ← 分项归因
 *
 * 块范围: 世界盘 (灵气归零半径) + 一圈余量内的全部区块格。
 * 用法: node verify/ws_size_fullmap.mjs [baseUrl]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8141';
const CONC = 8;
const SEED = 'szfull' + (Date.now() % 1000000);      // 新 seed → 全部现算 (冷口径)

global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

/* 世界半径: 引擎配置 → 归零世界半径 → 格 */
global.MapGenConfig = undefined;
new Function(fs.readFileSync(path.join(ROOT, 'Server/Zongmen/Engine/js/mapgen-config.js'), 'utf8'))();
const CFG = global.MapGenConfig;
const meta = await (await fetch(BASE + '/api/map/meta')).json();
const RT = CFG.SPIRIT_R_TILES * meta.hexR * 2 / meta.hexW;   // 归零半径 ≈ 格数

async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}

/* ---------- WS 客户端 (与 w2 同构: 单连接 + seq 关联) ---------- */
class Ws {
  async connect() {
    this.seq = 0; this.pending = new Map(); this.loginWaiter = null;
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
        const p = this.pending.get(this.curSeq(buf));
        if (!p) return;
        this.pending.delete(p.seq);
        clearTimeout(p.timer);
        p.resolve({ raw: buf, frame: payload.length + 1 });
      });
    }
  }
  /* TileResponse 头部字段 1..7 按号序在图层子消息 (10..14) 之前, seq 可从头解出 */
  curSeq(buf) {
    let p = 0, seq = 0;
    const u8 = buf;
    const vi = () => { let v = 0, s = 0, b; do { b = u8[p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v; };
    while (p < u8.length) {
      const tag = vi(), field = tag >>> 3, wire = tag & 7;
      if (field === 6 && wire === 0) { seq = vi(); break; }
      if (field === 7) break;                        // revs 之后是图层子消息, seq 必在其前
      if (wire === 0) vi();
      else if (wire === 1) p += 8;
      else if (wire === 2) p += vi();
      else if (wire === 5) p += 4;
      else break;
    }
    return seq;
  }
  async login() {
    const p = new Promise((r) => { this.loginWaiter = r; });
    const b = PB.encodeLogin({ account: 'szfull', token: 'demo' });
    const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.LOGIN; f.set(b, 1);
    this.sock.send(f);
    return p;
  }
  tile(i, j, mask) {
    const sseq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(sseq); reject(new Error('ws 超时 i=' + i + ' j=' + j)); }, 120000);
      this.pending.set(sseq, { resolve, reject, timer });
      const b = PB.encodeTileRequest({ op: 1, seed: SEED, i, j, mask, seq: sseq, lastRevs: [] });
      const f = new Uint8Array(1 + b.length); f[0] = PB.FRAME.TILE; f.set(b, 1);
      this.sock.send(f);
    });
  }
}

/* ---------- 块枚举: 区块格间距 S, 覆盖世界盘 + 一圈 ---------- */
const hexDist = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
const S = meta.chunkS;
const R = Math.ceil((RT + S) / S) + 1;
const blocks = [];
for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++)
  if (hexDist(i * S, j * S, 0, 0) <= RT + 11) blocks.push([i, j]);

/* ---------- 并发扫描一个 mask ---------- */
async function sweep(ws, mask, label) {
  let wire = 0, raw = 0, errs = 0, decodeFails = 0, n = 0, sampleErr = '';
  const stat = { tiles: 0, chunks: 0, regions: 0, roads: 0, roadPts: 0, settle: 0, poi: 0, comms: 0, veins: 0 };
  const t0 = Date.now();
  let cursor = 0;
  async function worker() {
    while (cursor < blocks.length) {
      const [i, j] = blocks[cursor++];
      const { raw: buf, frame } = await ws.tile(i, j, mask);
      wire += frame;                               // 线上帧 = 1B 类型 + gzip 载荷
      raw += buf.length;                           // 解压后 protobuf
      n++;
      let resp = null;
      try { resp = PB.decodeTileResponse(buf); }
      catch (e) { decodeFails++; }                 // 重构中间态: 解码崩了也照常计量
      if (resp) {
        if (resp.err) { errs++; if (!sampleErr) sampleErr = `(${i},${j}) ${resp.err}`; }
        if (resp.chunk) { stat.chunks++; stat.tiles += resp.chunk.count || 0; }
        for (const rg of resp.regions) {
          stat.regions++; stat.roads += rg.roads.length;
          for (const rd of rg.roads) stat.roadPts += (rd.pts ? rd.pts.length / 2 : 0);
        }
        if (resp.settle) for (const g of resp.settle.groups) stat.settle += g.items.length;
        if (resp.poi) for (const g of resp.poi.groups) stat.poi += g.items.length;
        stat.comms += resp.comms.length;
        for (const cm of resp.comms) if (cm.exists) stat.veins += cm.veins.length;
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return { label, mask, n, wire, raw, errs, decodeFails, sampleErr, stat, ms: Date.now() - t0 };
}

const fmt = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
console.log(`服务端 ${BASE}  seed=${SEED}`);
console.log(`世界: 归零半径 ${(RT * meta.hexW).toFixed(0)} 世界单位 = ${RT.toFixed(1)} 格; 块间距 ${S}; 覆盖块数 ${blocks.length}`);

const ws = new Ws();
await ws.connect();
const lr = await ws.login();
if (!lr.ok) { console.log('登录失败: ' + lr.err); process.exit(1); }

/* Pass 1: ALL 冷扫 (真实"整图加载") */
const all = await sweep(ws, 0, 'ALL(全图层)');
console.log(`\n=== Pass 1 整图一次加载 (mask=ALL, 冷) — ${all.n} 块, ${all.ms / 1000 | 0}s ===`);
console.log(`  线上传输 (gzip帧): ${fmt(all.wire)}   解压后 protobuf: ${fmt(all.raw)}`);
console.log(`  内容: 地块 ${all.stat.tiles} / 区域 ${all.stat.regions} / 道路 ${all.stat.roads}条${all.stat.roadPts}折点 / 聚落 ${all.stat.settle} / 景点 ${all.stat.poi} / 群落 ${all.stat.comms} / 灵泉 ${all.stat.veins}`);
if (all.errs) console.log(`  ⚠ 服务端错误响应 ${all.errs} 个, 样例: ${all.sampleErr}`);
if (all.decodeFails) console.log(`  ⚠ 客户端解码失败 ${all.decodeFails} 个 (字节数已计入)`);

/* Pass 2~6: 单图层归因 (ALL 已缓存, 纯量线宽) */
const layers = [['CHUNK 地形+精灵', 1], ['REGION 区域+道路', 2], ['SETTLE 聚落', 4], ['POI 景点', 8], ['COMM 灵脉', 16]];
let sumWire = 0;
console.log(`\n=== Pass 2~6 单图层线上帧 (gzip) ===`);
for (const [name, mask] of layers) {
  const r = await sweep(ws, mask, name);
  sumWire += r.wire;
  const warn = (r.errs ? `  ⚠ err×${r.errs}: ${r.sampleErr}` : '') + (r.decodeFails ? `  ⚠ 解码崩×${r.decodeFails}` : '');
  console.log(`  ${name.padEnd(14)} ${fmt(r.wire).padStart(9)}  (protobuf ${fmt(r.raw).padStart(9)}, ${r.ms / 1000 | 0}s)${warn}`);
}
console.log(`  ${'-'.repeat(40)}\n  五图层合计     ${fmt(sumWire).padStart(9)}   vs ALL 冷扫 ${fmt(all.wire)}`);
process.exit(0);
