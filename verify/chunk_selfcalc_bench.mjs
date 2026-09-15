/* ============================================================
 * chunk_selfcalc_bench.mjs — 「地图能否改由前端自算」可行性基准
 *
 * 目的: 量化「前端按 seed 自算整块地图」的启动/单块/批量成本,
 *       与「服务端算 + WS 下发」对比, 为待办规划提供实测数据。
 *
 * 跑法: node verify/chunk_selfcalc_bench.mjs [seed] [--blocks=N]
 *
 * 说明: Node 与浏览器同为 V8, 单线程算术性能同量级 ⇒ 本机数据可作
 *       前端耗时的**乐观上界**(浏览器还要叠加渲染与主线程争用)。
 *       本脚本只读引擎源码, 不写任何文件。
 * ============================================================ */
'use strict';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const ORDER = ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js'];

const argv = process.argv.slice(2);
const seed = (argv.find((a) => !a.startsWith('--')) || '42');
const nBlocks = parseInt((argv.find((a) => a.startsWith('--blocks=')) || '--blocks=25').split('=')[1], 10) || 25;

/* 与服务端 JsEngineHost 相同的加载姿势: 先给 window 别名, 再按序 eval */
global.window = globalThis;
global.global = globalThis;
global.self = globalThis;

function ms(fn) { const t = performance.now(); const v = fn(); return { ms: performance.now() - t, v }; }
function fmt(n) { return n.toFixed(2).padStart(9); }
function pct(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; }

const out = [];
function log(s) { out.push(s); console.log(s); }

/* ---------- 1. 冷加载 = 前端首屏必须付的固定成本 ---------- */
const bundleParts = [];
for (const f of ORDER) bundleParts.push(fs.readFileSync(path.join(JSDIR, f), 'utf8'));
const bundle = bundleParts.join('\n');
log(`bundle: ${ORDER.join(' + ')}  ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KB`);

const tLoad = ms(() => { for (const f of ORDER) (0, eval)(fs.readFileSync(path.join(JSDIR, f), 'utf8')); });
log(`[冷] 脚本 eval (4 文件)                     ${fmt(tLoad.ms)} ms`);

/* 单文件 eval 拆解 (定位成本在哪) */
for (const f of ORDER) {
  const src = fs.readFileSync(path.join(JSDIR, f), 'utf8');
  const r = ms(() => (0, eval)(src));
  log(`      └ ${f.padEnd(18)} eval              ${fmt(r.ms)} ms`);
}

const MG = global.MapGen;
const SVC = global.MapGenServer;
if (!MG || !SVC) { console.error('引擎未导出 MapGen/MapGenServer'); process.exit(2); }

const tInit = ms(() => MG.init(seed));
log(`[冷] MapGen.init("${seed}")                  ${fmt(tInit.ms)} ms`);
log(`     HEX_R=${MG.HEX_R} HEX_W=${MG.HEX_W} CHUNK_S=${MG.CHUNK_S} CHUNK_SCAN=${MG.CHUNK_SCAN} REGION_M=${MG.REGION_M} COMM_CL=${MG.CFG.COMM_CL}`);

/* ---------- 2. 单格 fields (前端小地图 L1 已在这条路上) ---------- */
MG.fields(0, 0);                                    // 预热一格
const N_FIELDS = 20000;
const tF = ms(() => { for (let i = 0; i < N_FIELDS; i++) MG.fields((i % 400) - 200, ((i / 400) | 0) - 25); });
log(`[场] fields() 冷跑 ${N_FIELDS} 格 (首触)          ${fmt(tF.ms)} ms  → ${(tF.ms / N_FIELDS * 1000).toFixed(2)} µs/格`);
const tF2 = ms(() => { for (let i = 0; i < N_FIELDS; i++) MG.fields((i % 400) - 200, ((i / 400) | 0) - 25); });
log(`[场] fields() 热跑 ${N_FIELDS} 格 (全命中)        ${fmt(tF2.ms)} ms  → ${(tF2.ms / N_FIELDS * 1000).toFixed(2)} µs/格`);

/* ---------- 3. 单块 buildChunk ---------- */
const probe = MG.buildChunk(0, 0);
log(`[块] 单块数据规模: tiles=${probe.data.tiles.length} 格, propCenters=${probe.data.propCenters.length / 2} 精灵`);
const wire0 = (() => { const t = performance.now(); SVC.chunkJson(0, 0); return performance.now() - t; })();
log(`     服务端同款 chunkJson (打包+JSON+b64)       ${fmt(wire0)} ms  → 线上字节数见下`);

const j0 = SVC.chunkJson(0, 0);
log(`     线上单块 JSON 载荷 ${(Buffer.byteLength(j0) / 1024).toFixed(1)} KB (b64 后, 未 gzip)`);

/* ---------- 4. 视野批量: 前端自算 vs 服务端序列化 ---------- */
const R = Math.max(1, Math.round(Math.sqrt(nBlocks) / 2));
const coords = [];
for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) coords.push([i, j]);
const take = coords.slice(0, nBlocks);

MG.init(seed);                                      // 干净世界, 保证是"首屏冷算"
const perBlock = [];
const tBatchCold = ms(() => {
  for (const [ca, cb] of take) {
    const s = performance.now();
    MG.buildChunk(ca, cb);
    perBlock.push(performance.now() - s);
  }
});
log(`[批] 前端自算 ${take.length} 块 (冷, 首屏)          ${fmt(tBatchCold.ms)} ms  → 均 ${(tBatchCold.ms / take.length).toFixed(2)} ms/块  中位 ${pct(perBlock, 0.5).toFixed(2)}  p90 ${pct(perBlock, 0.9).toFixed(2)}`);

const perBlock2 = [];
const tBatchHot = ms(() => { for (const [ca, cb] of take) { const s = performance.now(); MG.buildChunk(ca, cb); perBlock2.push(performance.now() - s); } });
log(`[批] 前端自算 ${take.length} 块 (热, 缓存命中)      ${fmt(tBatchHot.ms)} ms  → 均 ${(tBatchHot.ms / take.length).toFixed(2)} ms/块`);

/* 服务端同规模: 打包 + 序列化 + base64 (不含 gzip/DB/网络) */
MG.init(seed);
const tSrv = ms(() => { for (const [ca, cb] of take) SVC.chunkJson(ca, cb); });
log(`[批] 服务端 ${take.length} 块 chunkJson (含打包/序列化)  ${fmt(tSrv.ms)} ms  → 均 ${(tSrv.ms / take.length).toFixed(2)} ms/块`);
let wireBytes = 0;
MG.init(seed);
for (const [ca, cb] of take) wireBytes += Buffer.byteLength(SVC.chunkJson(ca, cb));
log(`     服务端这批需传输 ${(wireBytes / 1024 / 1024).toFixed(2)} MB (b64 JSON, gzip 前)`);

/* ---------- 5. 世界层各包成本 ---------- */
MG.init(seed);
const tRegion = ms(() => { for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) SVC.regionJson(i, j); });
log(`[层] regionJson ×25 (含 roadsNear 全预算 A*)   ${fmt(tRegion.ms)} ms  → 均 ${(tRegion.ms / 25).toFixed(2)} ms/区域`);

MG.init(seed);
const tSettle = ms(() => { for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) SVC.settleJson(i, j); });
log(`[层] settleJson ×25 (growTownFootprint 全量)   ${fmt(tSettle.ms)} ms  → 均 ${(tSettle.ms / 25).toFixed(2)} ms/区域`);

MG.init(seed);
const tComm = ms(() => { for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) SVC.commJson(i, j); });
log(`[层] commJson ×25 (群落+灵脉)                  ${fmt(tComm.ms)} ms  → 均 ${(tComm.ms / 25).toFixed(2)} ms/群落格`);

/* ---------- 6. 多 seed 切换 (客户端"重铸世界"成本) ---------- */
const seeds = ['1', '2', '7', '42', 'abc', '宗门', '999999'];
const tSeed = seeds.map((s) => { const r = ms(() => MG.init(s)); MG.fields(0, 0); return r.ms; });
log(`[换] init 新 seed ×${seeds.length}                  ${fmt(tSeed.reduce((a, b) => a + b, 0))} ms  → 每次 ${tSeed.map((x) => x.toFixed(1)).join('/')} ms (含缓存清空)`);

log('');
log('结论键值(供 md 引用):');
log(JSON.stringify({
  bundleKB: +(Buffer.byteLength(bundle) / 1024).toFixed(1),
  evalMs: +tLoad.ms.toFixed(1),
  initMs: +tInit.ms.toFixed(1),
  fieldsColdUs: +(tF.ms / N_FIELDS * 1000).toFixed(2),
  fieldsHotUs: +(tF2.ms / N_FIELDS * 1000).toFixed(2),
  chunkTiles: probe.data.tiles.length,
  chunkProps: probe.data.propCenters.length / 2,
  chunkJsonKB: +(Buffer.byteLength(j0) / 1024).toFixed(1),
  selfNBatchMs: +tBatchCold.ms.toFixed(1),
  selfNBatchPerMs: +(tBatchCold.ms / take.length).toFixed(2),
  selfNBatchHotMs: +tBatchHot.ms.toFixed(1),
  srvNBatchMs: +tSrv.ms.toFixed(1),
  wireMB: +(wireBytes / 1024 / 1024).toFixed(2),
  region25Ms: +tRegion.ms.toFixed(1),
  settle25Ms: +tSettle.ms.toFixed(1),
  comm25Ms: +tComm.ms.toFixed(1)
}));
