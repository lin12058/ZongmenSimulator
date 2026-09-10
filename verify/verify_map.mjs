/* ============================================================
 * verify_map.mjs — 地图数据准确性三方对照验证 (WebSocket 单块版)
 *   ① 参考基准: Node 加载 Engine/js 原始脚本, 直接调 MapGen 生成
 *   ② 服务端:   C# 走同一脚本 (ClearScript), 图数据经 ws://…/ws/map
 *               TileResponse 下发 (gzip protobuf 多图层子消息)
 *   ③ 解码端:   浏览器同款 web/js/pb.js 还原
 *   对照: 单块 (chunk/region/settle/poi/comm 五图层) + mask 位选 +
 *        rev 最小化响应 + 未登录门禁 + 单格详情。
 *
 * 用法: node verify/verify_map.mjs [baseUrl]   (默认 http://127.0.0.1:8140)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';

/* 全局注入 window = globalThis 以原样执行浏览器脚本 */
global.window = globalThis;

for (const f of ['noise.js', 'mapgen.js', 'mapgen-server.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8');
  (0, eval)(code);
}
const PBcode = fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8');
(0, eval)(PBcode);

const ref = global.MapGen;                 // 原始生成逻辑 (参考基准)
const GS = global.MapGenServer;            // 原始生成逻辑的 JSON 适配 (服务端同源)
const PB = global.PB;                      // 浏览器同款解码器

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

async function getBinary(url) {
  const r = await fetch(BASE + url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return new Uint8Array(await r.arrayBuffer());     // fetch 自动解 gzip
}
async function getJson(url) {
  const r = await fetch(BASE + url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}

/* ---------- WebSocket 单块客户端 (与 web/js/mapclient.js 同帧协议) ---------- */
class WsClient {
  constructor(baseUrl) {
    this.url = baseUrl.replace(/^http/, 'ws') + '/ws/map';
    this.seq = 0;
    this.pending = new Map();
    this.loginWaiter = null;
    this.closed = false;
  }
  async connect() {
    this.sock = new WebSocket(this.url);
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      this.sock.onopen = res;
      this.sock.onerror = () => rej(new Error('ws 连接失败 ' + this.url));
    });
    this.sock.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data));
    this.sock.onclose = () => { this.closed = true; };
  }
  frame(type, body) {
    const f = new Uint8Array(1 + body.length);
    f[0] = type;
    f.set(body, 1);
    this.sock.send(f);
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
      }).catch((e) => console.error('TileResponse 解码失败', e));
    }
  }
  async login(account = 'verify', token = 'demo') {
    const p = new Promise((res) => { this.loginWaiter = res; });
    this.frame(1, PB.encodeLogin({ account, token }));
    const lr = await p;
    if (!lr.ok) throw new Error('登录失败: ' + lr.err);
    return lr;
  }
  async tile(seed, i, j, mask = 0, lastRevs = []) {
    const sseq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(sseq); reject(new Error('ws 请求超时')); }, 30000);
      this.pending.set(sseq, { resolve, reject, timer });
      this.frame(2, PB.encodeTileRequest({ op: 1, seed, i, j, mask, seq: sseq, lastRevs }));
    });
  }
  close() { try { this.sock.close(); } catch { /* 忽略 */ } }
}
async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
}

/* ---------- 单块五图层对照 ---------- */
const GEO = { hexR: 8, hexW: Math.sqrt(3) * 8, chunkS: 21 };

function verifyChunkArrays(tag, arrays, d) {
  const n = d.tiles.length;
  check(`${tag} count`, arrays.count === n, `${arrays.count} vs ${n}`);
  check(`${tag} tiles 精确`, arrays.tiles.length === n && sameF(arrays.tiles, d.tiles), '');
  check(`${tag} neigh 精确`, sameF(arrays.neigh, d.neigh), '');
  check(`${tag} centers ≤1e-3px`, sameFtol(arrays.centers, d.centers, 1e-3), maxDiff(arrays.centers, d.centers).toExponential(2));
  check(`${tag} elevs u16容差`, maxAbs(arrays.elevs, d.elevs) <= 1.6e-5, '');
  const pn = d.propSprites.length;
  check(`${tag} 精灵数`, (arrays.propSprites || []).length === pn, `${(arrays.propSprites || []).length} vs ${pn}`);
  if (pn) {
    check(`${tag} 精灵 sprite 精确`, sameF(arrays.propSprites, d.propSprites), '');
    check(`${tag} 精灵中心 ≤0.02px`, sameFtol(arrays.propCenters, d.propCenters, 0.02), '');
  }
}

async function verifyBlock(ws, seed, ca, cb) {
  const tag = `block(${ca},${cb})`;
  GS.init(seed);
  const built = ref.buildChunk(ca, cb);
  const layers = JSON.parse(GS.blockLayersJson(ca, cb));

  const resp = await ws.tile(seed, ca, cb);
  check(`${tag} 回显坐标`, resp.i === ca && resp.j === cb, `${resp.i},${resp.j}`);
  check(`${tag} mask=ALL`, resp.mask === 31, String(resp.mask));
  check(`${tag} revs 5 位`, resp.revs.length === 5 && resp.revs.every((v) => v > 0), JSON.stringify(resp.revs));

  /* 图层0 chunk */
  check(`${tag} 图层0 chunk 存在`, !!resp.chunk, '');
  if (resp.chunk) verifyChunkArrays(tag, PB.chunkToArrays(resp.chunk, GEO), built.data);

  /* 图层1 region (区域名 + 道路; 聚落已拆出) */
  check(`${tag} 图层1 region 存在`, resp.regions.length === layers.regions.length,
    `${resp.regions.length} vs ${layers.regions.length}`);
  for (const [i, j] of layers.regions) {
    const local = JSON.parse(GS.regionJson(i, j));
    const got = resp.regions.find((r) => r.i === i && r.j === j);
    if (!got) { check(`${tag} region(${i},${j}) 存在`, false); continue; }
    check(`${tag} region(${i},${j}) 名`, got.region && got.region.name === local.region.name,
      `${got.region?.name} vs ${local.region.name}`);
    const lkeys = new Set(local.roads.map((x) => x.key));
    const gkeys = new Set(got.roads.map((x) => x.key));
    check(`${tag} region(${i},${j}) 道路 key 一致`, lkeys.size === gkeys.size && [...lkeys].every((k) => gkeys.has(k)), '');
    for (const lr2 of local.roads) {
      const gr = got.roads.find((x) => x.key === lr2.key);
      if (!gr) { check(`${tag} 道路 ${lr2.key} 存在`, false); continue; }
      check(`${tag} 道路 ${lr2.key} 点列`, gr.pts && gr.pts.length === lr2.pts.length &&
        sameFtol(gr.pts, Float32Array.from(lr2.pts), 1e-3),
        `len ${gr.pts ? gr.pts.length : 'null'} vs ${lr2.pts.length}`);
    }
  }

  /* 图层2/3 settle/poi (按区域分组, 实体含骨架字段) */
  let settleN = 0, poiN = 0;
  for (const [i, j] of layers.regions) {
    const local = JSON.parse(GS.regionJson(i, j));
    const expSettle = local.settlements.filter((s) => s.type !== 'poi');
    const expPoi = local.settlements.filter((s) => s.type === 'poi');
    const gSettle = (resp.settle?.groups || []).find((g) => g.i === i && g.j === j);
    const gPoi = (resp.poi?.groups || []).find((g) => g.i === i && g.j === j);
    if (expSettle.length) {
      check(`${tag} settle 分组(${i},${j}) 存在`, !!gSettle, '');
      if (gSettle) { settleN += gSettle.items.length; cmpEntities(tag, `settle(${i},${j})`, gSettle.items, expSettle); }
    }
    if (expPoi.length) {
      check(`${tag} poi 分组(${i},${j}) 存在`, !!gPoi, '');
      if (gPoi) { poiN += gPoi.items.length; cmpEntities(tag, `poi(${i},${j})`, gPoi.items, expPoi); }
    }
  }
  /* 空区域不应产生空分组 */
  if (resp.settle) check(`${tag} settle 无空分组`, resp.settle.groups.every((g) => g.items.length > 0), '');
  if (resp.poi) check(`${tag} poi 无空分组`, resp.poi.groups.every((g) => g.items.length > 0), '');

  /* 图层4 comm */
  check(`${tag} 图层4 comm 数`, resp.comms.length === layers.comms.length,
    `${resp.comms.length} vs ${layers.comms.length}`);
  for (const [ci, cj] of layers.comms) {
    const local = JSON.parse(GS.commJson(ci, cj));
    const got = resp.comms.find((c) => c.ci === ci && c.cj === cj);
    if (!got) { check(`${tag} comm(${ci},${cj}) 存在`, false); continue; }
    check(`${tag} comm(${ci},${cj}) 存在标记`, got.exists === local.exists, '');
    if (!local.exists) continue;
    check(`${tag} comm(${ci},${cj}) 主格/五行`, got.q === local.q && got.r === local.r && got.element === local.element, '');
    check(`${tag} comm(${ci},${cj}) 灵脉数`, got.veins.length === local.veins.length, '');
    for (let v = 0; v < local.veins.length; v++) {
      const a = got.veins[v], b = local.veins[v];
      check(`${tag} 灵脉#${v} ${b.name}`, a.q === b.q && a.r === b.r && a.element === b.element &&
        (a.variant || '') === (b.variant || '') && a.level === b.level && a.name === b.name, '');
    }
  }
  return { resp, settleN, poiN };
}

function cmpEntities(tag, gname, items, exp) {
  const byId = new Map(items.map((e) => [e.id, e]));
  for (const b of exp) {
    const a = byId.get(b.id);
    check(`${tag} ${gname} 实体 ${b.id}`, !!a &&
      a.q === b.q && a.r === b.r && a.type === b.type && a.name === b.name &&
      a.pop === b.pop && a.x !== undefined && a.y !== undefined,
      a ? JSON.stringify(a) + ' vs ' + JSON.stringify(b) : '缺失');
    if (a) {
      check(`${tag} ${gname} 实体 ${b.id} 骨架字段`,
        a.owner === (b.owner || '') && a.tier === (b.tier || 0) &&
        a.state === (b.state || 0) && a.expireTs === (b.expireTs || 0), '');
    }
  }
  check(`${tag} ${gname} 实体数`, items.length === exp.length, `${items.length} vs ${exp.length}`);
}

function sameF(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function sameFtol(a, b, tol) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
  return true;
}
function maxAbs(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

/* ---------- 单格详情 (HTTP 保留接口) ---------- */
async function verifyTile(seed, q, r) {
  GS.init(seed);
  /* P4 语义: tileJson 的 onRoad = 只读已生成道路 (点击不触发 A*)。
     参考端 init() 会清缓存, 故先对齐两端道路缓存:
     - 参考端: GS.regionJson (预算充足) 生成 3×3 区域道路;
     - 服务端: 经 ws 拉取覆盖这些区域格的单块 (每格 2×2 块保证
       hexDist(seed, 块中心) ≤ 33 的归属条件必命中) → 区域包伴随道路落成。 */
  const ri = Math.floor(q / ref.REGION_M), rj = Math.floor(r / ref.REGION_M);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      GS.regionJson(ri + di, rj + dj);
      const sq = (ri + di) * ref.REGION_M, sr = (rj + dj) * ref.REGION_M;
      const c0 = Math.floor(sq / ref.CHUNK_S), c1 = Math.floor(sr / ref.CHUNK_S);
      for (let dca = 0; dca <= 1; dca++)
        for (let dcb = 0; dcb <= 1; dcb++)
          await wsTileOnce(seed, c0 + dca, c1 + dcb);
    }
  }
  const local = JSON.parse(GS.tileJson(q, r));
  const buf = await getBinary(`/api/map/tile?seed=${seed}&q=${q}&r=${r}`);
  const got = PB.decodeTileMsg(buf);
  check(`tile(${q},${r}) biome/disp`, got.biome === local.f.biome && got.disp === local.f.disp, `${got.biome}/${got.disp} vs ${local.f.biome}/${local.f.disp}`);
  check(`tile e/m/t 容差`, near(got.e, local.f.e, 1e-6) && near(got.m, local.f.m, 1e-6) && near(got.t, local.f.t, 1e-6), '');
  const hv = local.vein, gv = got.hasVein;
  check(`tile 灵脉标记`, gv === !!hv, `${gv} vs ${!!hv}`);
  if (hv) {
    check(`tile 灵脉详情`, got.veinName === hv.name && got.veinElement === hv.element &&
      got.veinLevel === hv.level && (got.veinVariant || '') === (hv.variant || ''), '');
  }
  check(`tile 区域`, got.regionName === local.region.name, `${got.regionName} vs ${local.region.name}`);
  const lp = local.place, gp = got.placeType;
  check(`tile 聚落标记`, gp === (lp ? lp.type : ''), `${gp} vs ${lp?.type || ''}`);
  if (lp) check(`tile 聚落详情`, got.placeName === lp.name && got.placePop === lp.pop, '');
  const wantD = local.f.biome <= 1 ? 0 : (local.waterD > 0 ? local.waterD : 255);
  check(`tile 去水`, got.waterD === wantD, `${got.waterD} vs ${wantD}`);
  check(`tile onRoad`, got.onRoad === local.onRoad, `${got.onRoad} vs ${local.onRoad}`);
}

/* ws 单块拉取 (无对照, 只为驱动服务端 VM 道路生成) */
let sharedWs = null;
async function wsTileOnce(seed, ca, cb) {
  if (!sharedWs) {
    sharedWs = new WsClient(BASE);
    await sharedWs.connect();
    await sharedWs.login('verify-warm', 'demo');
  }
  await sharedWs.tile(seed, ca, cb).catch(() => {});
}

/* ---------- 主流程 ---------- */
/* 采样可外部覆盖 (大范围回归用): node verify_map.mjs <base> '<seedsJSON>' '<blocksJSON>' '<tilesJSON>' */
const seeds = process.argv[3] ? JSON.parse(process.argv[3]) : ['42', '20260909'];
const blocks = process.argv[4] ? JSON.parse(process.argv[4]) : [[0, 0], [1, 0], [0, 1], [-1, 1], [-2, 3], [5, 7]];
const tiles = process.argv[5] ? JSON.parse(process.argv[5]) : [[0, 0], [3, -2], [-8, 5], [12, 9], [-3, -4]];
if (blocks.length > 6) console.log(`(大范围模式: ${seeds.length} seed × ${blocks.length} 块)`);

console.log('== 元信息 (HTTP) ==');
const meta = await getJson('/api/map/meta?seed=x');
check('meta 几何常量', meta.hexR === 8 && meta.chunkS === 21 && Math.abs(meta.hexW - Math.sqrt(3) * 8) < 1e-9, '');
check('meta 图例13', meta.biomeMeta.length === 13, String(meta.biomeMeta?.length));
check('HTTP 图数据端点已下线 (chunk)',
  (await fetch(BASE + '/api/map/chunk?seed=42&ca=0&cb=0')).status === 404, '验收 §8.4');
check('HTTP 图数据端点已下线 (region)',
  (await fetch(BASE + '/api/map/region?seed=42&i=0&j=0')).status === 404, '验收 §8.4');
check('HTTP 图数据端点已下线 (comm)',
  (await fetch(BASE + '/api/map/comm?seed=42&ci=0&cj=0')).status === 404, '验收 §8.4');

/* ---- 未登录门禁 (验收 §8.5) ---- */
console.log('\n== 未登录门禁 ==');
{
  const anon = new WsClient(BASE);
  await anon.connect();
  const resp = await anon.tile('42', 0, 0);
  check('未登录: chunk/region 可取', !!resp.chunk && resp.regions.length > 0, '');
  const denied = 4 | 8 | 16;
  check('未登录: deniedMask = Settle|Poi|Comm', resp.deniedMask === denied, String(resp.deniedMask));
  check('未登录: 不含实体/群落层', !resp.settle && !resp.poi && resp.comms.length === 0, '');
  /* W1: mask 回显「客户端可视为持有」的图层位 — 未登录时应已剔除实体层,
     否则客户端会把从未收到数据的实体层 rev 记为已持有 → 永久缺层 */
  check('未登录: resp.mask 已剔除实体层 (=Chunk|Region)', resp.mask === 3, String(resp.mask));
  anon.close();
}

/* ---- 登录后单块全量对照 ---- */
const ws = new WsClient(BASE);
await ws.connect();
const lr = await ws.login('verify', 'demo');
check('登录成功', lr.ok && lr.account === 'verify', JSON.stringify(lr));

for (const seed of seeds) {
  console.log(`\n== 单块五图层对照 seed=${seed} ==`);
  for (const [ca, cb] of blocks) await verifyBlock(ws, seed, ca, cb);
}

/* ---- mask 位选 (验收 §8.2) ---- */
console.log('\n== mask 位选 ==');
{
  GS.init('42');
  const resp = await ws.tile('42', 0, 0, 0x03);   // Chunk|Region
  check('mask=0x03 回显', resp.mask === 3, String(resp.mask));
  check('mask=0x03 含 chunk/region', !!resp.chunk && resp.regions.length > 0, '');
  check('mask=0x03 不含 settle/poi/comm', !resp.settle && !resp.poi && resp.comms.length === 0, '');
  const resp2 = await ws.tile('42', 0, 0, 0x10);  // Comm 单层
  check('mask=0x10 仅 comm', resp2.mask === 16 && !resp2.chunk && resp2.regions.length === 0 &&
    !resp2.settle && !resp2.poi, '');
}

/* ---- W1 回归: 非全量 mask 首拉后, 带「只含 mask 命中位」的 revs 全量重拉,
        未请求的图层仍必须下发 (否则客户端该层永久缺失) ---- */
console.log('\n== W1 mask→全量 回归 ==');
{
  const w1 = new WsClient(BASE);
  await w1.connect();
  await w1.login('verify-w1', 'demo');
  const w2 = new WsClient(BASE);
  await w2.connect();
  await w2.login('verify-w1b', 'demo');

  const BLK = [3, 3];                                   // 未被其他用例占用的块
  const part = await w1.tile('42', BLK[0], BLK[1], PB.MASK.CHUNK);
  check('局部 mask: resp.mask 精确回显 (=Chunk)', part.mask === PB.MASK.CHUNK, String(part.mask));
  check('局部 mask: 未含 region/settle/poi/comm',
    part.regions.length === 0 && !part.settle && !part.poi && part.comms.length === 0, '');
  check('局部 mask: chunk 已下发且 revs 为 5 位',
    !!part.chunk && part.revs.length === 5, JSON.stringify(part.revs));

  /* 客户端按 mask 只记账 chunk 位 → 其余位保持 0 (未持有) */
  const carried = [part.revs[0], 0, 0, 0, 0];
  const full = await w1.tile('42', BLK[0], BLK[1], 31, carried);
  check('全量重拉: chunk 因 rev 未变而缺省', !full.chunk, String(!!full.chunk));
  check('全量重拉: region 层仍下发', full.regions.length > 0, String(full.regions.length));

  /* 与「全新连接首次全量」对照: 图层存在性必须一致 */
  const fresh = await w2.tile('42', BLK[0], BLK[1], 31);
  check('全量重拉与首次全量图层存在性一致',
    (full.regions.length > 0) === (fresh.regions.length > 0) &&
    (!!full.settle) === (!!fresh.settle) &&
    (!!full.poi) === (!!fresh.poi) &&
    full.comms.length === fresh.comms.length,
    JSON.stringify({
      full: { r: full.regions.length, s: !!full.settle, p: !!full.poi, c: full.comms.length },
      fresh: { r: fresh.regions.length, s: !!fresh.settle, p: !!fresh.poi, c: fresh.comms.length }
    }));

  w1.close(); w2.close();
}

/* ---- rev 最小化响应 (验收 §8.6) ---- */
console.log('\n== rev 增量失效 ==');
{
  const first = await ws.tile('42', 1, 1);
  check('首次全量', !!first.chunk && first.regions.length > 0, '');
  const second = await ws.tile('42', 1, 1, 31, first.revs);
  check('rev 相同 → 最小响应 (无任何图层子消息)',
    !second.chunk && second.regions.length === 0 && !second.settle && !second.poi && second.comms.length === 0,
    JSON.stringify({ c: !!second.chunk, r: second.regions.length, s: !!second.settle, p: !!second.poi, m: second.comms.length }));
  check('最小响应回显 revs 一致', JSON.stringify(second.revs) === JSON.stringify(first.revs), '');
  const bumped = first.revs.slice(); bumped[2] = bumped[2] + 1;   // settle 层版本前进
  const third = await ws.tile('42', 1, 1, 31, bumped);
  check('settle rev 变化 → 仅重发受影响层', !third.chunk && third.regions.length === 0 &&
    !!third.settle && !third.poi && third.comms.length === 0,
    JSON.stringify({ c: !!third.chunk, r: third.regions.length, s: !!third.settle, p: !!third.poi, m: third.comms.length }));
}

/* ---- 单格详情 (HTTP, 保留接口) ---- */
console.log('\n== 单格详情 seed=42 ==');
for (const [q, r] of tiles) await verifyTile('42', q, r);

ws.close();
if (sharedWs) sharedWs.close();

console.log('\n== 确定性 ==');
{
  const a = await wsRequery('42', 2, 0);
  const b = await wsRequery('42', 2, 0);
  check('同块两次全量请求内容一致',
    JSON.stringify(a.revs) === JSON.stringify(b.revs) &&
    !!a.chunk && !!b.chunk &&
    sameF(PB.chunkToArrays(a.chunk, GEO).tiles, PB.chunkToArrays(b.chunk, GEO).tiles) &&
    a.regions.length === b.regions.length, '');
}
async function wsRequery(seed, ca, cb) {
  const w = new WsClient(BASE);
  await w.connect();
  await w.login('verify-det', 'demo');
  const r = await w.tile(seed, ca, cb);
  w.close();
  return r;
}

const stats = await getJson('/api/map/stats');
check('SQLite 落库行数 > 0', stats.dbRows > 0, JSON.stringify(stats));

console.log(`\n========== 结果: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);
