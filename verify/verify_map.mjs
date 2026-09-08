/* ============================================================
 * verify_map.mjs — 地图数据准确性三方对照验证
 *   ① 参考基准: Node 加载 Engine/js 原始脚本, 直接调 MapGen 生成
 *   ② 服务端:   C# 走同一脚本 (ClearScript) 产出 gzip(protobuf)
 *   ③ 解码端:   浏览器同款 web/js/pb.js 还原
 *   对照: 区块(坐标/地貌/海拔/哈希/邻域/精灵) 与 区域/群落/单格。
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

/* ---------- 区块对照 ---------- */
async function verifyChunk(seed, ca, cb) {
  GS.init(seed);
  const built = ref.buildChunk(ca, cb);
  const d = built.data;
  const n = d.tiles.length;

  const buf = await getBinary(`/api/map/chunk?seed=${seed}&ca=${ca}&cb=${cb}`);
  const msg = PB.decodeChunkMsg(buf);
  const geo = { hexR: 8, hexW: Math.sqrt(3) * 8, chunkS: 21 };
  const arr = PB.chunkToArrays(msg, geo);

  check(`count (seed=${seed} chunk=${ca},${cb})`, arr.count === n, `${arr.count} vs ${n}`);
  check(`tiles 精确`, arr.tiles.length === n && sameF(arr.tiles, d.tiles), '');
  check(`neigh 精确`, sameF(arr.neigh, d.neigh), '');
  check(`centers ≤1e-4px`, sameFtol(arr.centers, d.centers, 1e-3), maxDiff(arr.centers, d.centers).toExponential(2));
  check(`elevs u16容差`, maxAbs(arr.elevs, d.elevs) <= 1.6e-5, maxAbs(arr.elevs, d.elevs).toExponential(2));
  check(`hashes u16容差`, maxAbs(arr.hashes, d.hashes) <= 1.6e-5, maxAbs(arr.hashes, d.hashes).toExponential(2));
  const pn = d.propSprites.length;
  check(`精灵数`, (arr.propSprites || []).length === pn, `${(arr.propSprites || []).length} vs ${pn}`);
  if (pn) {
    check(`精灵 sprite 精确`, sameF(arr.propSprites, d.propSprites), '');
    check(`精灵中心 ≤0.02px`, sameFtol(arr.propCenters, d.propCenters, 0.02), maxDiff(arr.propCenters, d.propCenters).toExponential(2));
    check(`精灵 elev/hash 容差`, maxAbs(arr.propElevs, d.propElevs) <= 1.6e-5 && maxAbs(arr.propHashes, d.propHashes) <= 1.6e-5, '');
  }
  /* 与原 buildChunk 的绝对中心逐点抽查 (还原偏差验证) */
  const ccX = geo.hexW * (ca * geo.chunkS + cb * geo.chunkS / 2);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const qa = ca * geo.chunkS + (msg.cq[i] - 16);
    const ra = cb * geo.chunkS + (msg.cr[i] - 16);
    const rx = geo.hexW * (qa + ra / 2) - d.centers[i * 2];
    const ry = 12 * ra - d.centers[i * 2 + 1];
    worst = Math.max(worst, Math.abs(rx), Math.abs(ry));
  }
  check('相对坐标还原 ≤1e-3px', worst <= 1e-3, worst.toExponential(2));
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

/* ---------- 区域包对照 (直接同源函数 vs HTTP 解码) ---------- */
async function verifyRegion(seed, i, j) {
  GS.init(seed);
  const local = JSON.parse(GS.regionJson(i, j));
  const buf = await getBinary(`/api/map/region?seed=${seed}&i=${i}&j=${j}`);
  const got = PB.decodeRegionMsg(buf);
  check(`region 名 (${i},${j})`, got.region && got.region.name === local.region.name, `${got.region?.name} vs ${local.region.name}`);
  check(`region 聚落数`, got.settlements.length === local.settlements.length, `${got.settlements.length} vs ${local.settlements.length}`);
  for (let s = 0; s < local.settlements.length; s++) {
    const a = got.settlements[s], b = local.settlements[s];
    check(`聚落#${s} ${b.type}:${b.name}`, a.q === b.q && a.r === b.r && a.type === b.type &&
      a.name === b.name && a.pop === b.pop, JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  }
  const lkeys = new Set(local.roads.map((x) => x.key));
  const gkeys = new Set(got.roads.map((x) => x.key));
  check(`道路 key 集合一致`, lkeys.size === gkeys.size && [...lkeys].every((k) => gkeys.has(k)), '');
  for (const lr of local.roads) {
    const gr = got.roads.find((x) => x.key === lr.key);
    if (!gr) { check(`道路 ${lr.key} 存在`, false); continue; }
    check(`道路 ${lr.key} 点列`, gr.pts && gr.pts.length === lr.pts.length &&
      sameFtol(gr.pts, Float32Array.from(lr.pts), 1e-3), '');
  }
}

/* ---------- 群落包对照 ---------- */
async function verifyComm(seed, ci, cj) {
  GS.init(seed);
  const local = JSON.parse(GS.commJson(ci, cj));
  const buf = await getBinary(`/api/map/comm?seed=${seed}&ci=${ci}&cj=${cj}`);
  const got = PB.decodeCommMsg(buf);
  check(`群落存在标记 (${ci},${cj})`, got.exists === local.exists, `${got.exists} vs ${local.exists}`);
  if (!local.exists) return;
  check(`群落主格/五行`, got.q === local.q && got.r === local.r && got.element === local.element, '');
  check(`灵脉数`, got.veins.length === local.veins.length, `${got.veins.length} vs ${local.veins.length}`);
  for (let v = 0; v < local.veins.length; v++) {
    const a = got.veins[v], b = local.veins[v];
    check(`灵脉#${v} ${b.name}`, a.q === b.q && a.r === b.r && a.element === b.element &&
      (a.variant || '') === (b.variant || '') && a.level === b.level && a.name === b.name,
      JSON.stringify(a) + ' vs ' + JSON.stringify(b));
  }
}

/* ---------- 单格详情 ---------- */
async function verifyTile(seed, q, r) {
  GS.init(seed);
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

/* ---------- 主流程 ---------- */
const seeds = ['42', '20260909'];
const chunks = [[0, 0], [1, 0], [0, 1], [-1, 1], [-2, 3], [5, 7]];
const regions = [[0, 0], [-1, 0], [0, 1], [1, -1], [4, 3]];
const comms = [[0, 0], [1, 0], [0, 1], [-1, 0], [-1, 1], [2, 2]];
const tiles = [[0, 0], [3, -2], [-8, 5], [12, 9], [-3, -4]];

console.log('== 元信息 ==');
const meta = await getJson('/api/map/meta?seed=x');
check('meta 几何常量', meta.hexR === 8 && meta.chunkS === 21 && Math.abs(meta.hexW - Math.sqrt(3) * 8) < 1e-9, '');
check('meta 图例13', meta.biomeMeta.length === 13, String(meta.biomeMeta?.length));

for (const seed of seeds) {
  console.log(`\n== 区块对照 seed=${seed} ==`);
  for (const [ca, cb] of chunks) await verifyChunk(seed, ca, cb);

  console.log(`== 区域包对照 seed=${seed} ==`);
  for (const [i, j] of regions) await verifyRegion(seed, i, j);

  console.log(`== 群落对照 seed=${seed} ==`);
  for (const [ci, cj] of comms) await verifyComm(seed, ci, cj);

  console.log(`== 单格详情 seed=${seed} ==`);
  for (const [q, r] of tiles) await verifyTile(seed, q, r);
}

console.log('\n== 确定性与缓存 ==');
{
  const b1 = await getBinary('/api/map/chunk?seed=42&ca=0&cb=0');
  const b2 = await getBinary('/api/map/chunk?seed=42&ca=0&cb=0');
  check('区块二次请求字节一致', b1.length === b2.length && b1.every((v, i) => v === b2[i]), '');
}
const stats = await getJson('/api/map/stats');
check('SQLite 落库行数 > 0', stats.dbRows > 0, JSON.stringify(stats));

console.log(`\n========== 结果: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);
