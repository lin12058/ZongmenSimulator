/* ============================================================
 * size_fullmap.mjs — 实测「一次性加载整张地图」的载荷体积
 * ------------------------------------------------------------
 * 用服务端同一份引擎 (Server/Zongmen/Engine/js 4 件套) 回答:
 *   ① 全图灵泉(灵脉)+坐标: 枚举世界盘内全部群落格, 逐个 commJson,
 *      统计 灵脉总数 / 逐群落 JSON 体积 / 一次性全量数组体积 (含 gzip)
 *   ①b 全图聚落(村落/城镇/仙城/宗门/秘境) 与道路: 枚举区域晶格
 *      (道路按 key 去重; 先小样本外推, 超时自动跳过)
 *   ② 全图缩略图(字段网格): fieldGridJson 覆盖世界外接方格,
 *      统计 原始字节 / base64 / gzip
 *   ③ 真渲染 PNG 缩略图: 用 ② 的网格按世界坐标采样上色,
 *      编码 1024² 与 2048² 两档真实 PNG 文件 (落盘可直接看)
 * 用法: node verify/size_fullmap.mjs [--no-grid] [--no-roads]
 *   --no-grid   跳过 ②字段网格 + ③PNG 缩略图 (全图采样一次 ~95s×种子数)
 *   --no-roads  跳过 道路实测 (BFS×全图区域, 较慢)
 * ============================================================ */
import fs from 'fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const QUICK_GRID = process.argv.includes('--no-grid');
const DO_ROADS = !process.argv.includes('--no-roads');

/* 按脚本自身位置推导, 不硬编码 (目录更名会让绝对路径失效) */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const load = (p) => fs.readFileSync(`${ROOT}/Server/Zongmen/Engine/js/${p}`, 'utf8');

globalThis.window = globalThis;
new Function(load('noise.js'))();          // → NoiseLib
new Function(load('mapgen-config.js'))();  // → MapGenConfig
new Function(load('mapgen.js'))();         // → MapGen
new Function(load('mapgen-server.js'))();  // → MapGenServer
const MG = globalThis.MapGen, MGS = globalThis.MapGenServer, CFG = globalThis.MapGenConfig;

const HEX_W = MG.HEX_W, TILE_H = 1.5 * MG.HEX_R;
const EDGE_W = MG.spiritEdgeWorld();               // 归零世界半径 (世界单位)
const RT = EDGE_W / HEX_W;                         // 同半径 ≈ 格数
const fmt = (n) => n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB'
                 : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const gz = (s) => zlib.gzipSync(Buffer.isBuffer(s) ? s : Buffer.from(s), { level: 9 }).length;

/* ---------- 真彩 PNG 编码 (RGB888, 无滤波, deflate 9) ---------- */
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, 'binary'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]); }
function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0;
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3); }
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]); }

/* 调色板: disp 0..12 → BIOME_META 颜色 */
const PAL = MG.BIOME_META.map(m => {
  const c = m.color; return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
});

console.log(`世界: 归零半径 ${EDGE_W} 世界单位 = ${RT.toFixed(1)} 格, 群落晶格 ${CFG.COMM_CL}, 半径 ${CFG.COMM_R}`);

for (const seed of ['EDGETEST', 'EDGETEST2', '宗门模拟器']) {
  MGS.init(seed);
  console.log(`\n=== seed=${seed} ===`);

  /* ① 全图灵泉: 枚举群落晶格 (±12 覆盖 577+25 格盘面) */
  const R = 12;
  let commN = 0, veinN = 0, nameBytes = 0, xyBytes = 0;
  const veins = [], commStrs = [];
  const t0 = Date.now();
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
    const s = MGS.commJson(i, j);
    const o = JSON.parse(s);
    if (!o.exists) continue;
    commN++; veinN += o.veins.length;
    commStrs.push(s);
    for (const v of o.veins) {
      veins.push(v);
      nameBytes += Buffer.byteLength(JSON.stringify({ name: v.name }));
      xyBytes += Buffer.byteLength(JSON.stringify({ x: v.x, y: v.y }));
    }
  }
  const oneShot = JSON.stringify(veins);
  const oneShotNoXY = JSON.stringify(veins.map(({ name, element, variant, level, q, r }) =>
    ({ name, element, variant, level, q, r })));
  const arrMin = JSON.stringify(veins.map(v => [v.q, v.r, v.level, v.element, v.variant || -1]));
  const commBatch = Buffer.concat(commStrs.map(s => Buffer.from(s)));
  console.log(`群落 ${commN} 个 / 灵泉 ${veinN} 条 (枚举耗时 ${Date.now() - t0} ms)`);
  console.log(`  逐群落包合计 (commJson×${commN}, 含群落信封): ${fmt(commBatch.length)}  整批 gzip ${fmt(gz(commBatch))}`);
  console.log(`  一次性全量数组 [name,element,variant,level,q,r,x,y]: ${fmt(Buffer.byteLength(oneShot))}  gzip ${fmt(gz(oneShot))}`);
  console.log(`     └ 去掉世界坐标 x/y 只留 q/r:            ${fmt(Buffer.byteLength(oneShotNoXY))}  gzip ${fmt(gz(oneShotNoXY))}`);
  console.log(`     └ 极简数组 [q,r,level,element,variant]:  ${fmt(Buffer.byteLength(arrMin))}  gzip ${fmt(gz(arrMin))}`);
  console.log(`  平均每条灵泉 JSON ${(Buffer.byteLength(oneShot) / veinN).toFixed(0)} B (其中名称 ${nameBytes / veinN | 0} B, 世界坐标 ${xyBytes / veinN | 0} B)`);
  console.log(`  二进制打包参考: ${veinN} × 9 B = ${fmt(veinN * 9)} → base64 ${fmt(Math.ceil(veinN * 9 / 3) * 4)}`);

  /* ①b 全图聚落 (村落/城镇/仙城/宗门/秘境): 枚举区域晶格 (REGION_M=18) */
  const MR = MG.REGION_M;
  const RR = Math.ceil((RT + MR) / MR) + 2;
  const sts = [];
  const t2 = Date.now();
  for (let i = -RR; i <= RR; i++) for (let j = -RR; j <= RR; j++) {
    const arr = MG.settlementsFor(i, j);
    for (const st of arr) sts.push(st);
  }
  const byType = {};
  let stNameB = 0;
  for (const st of sts) { byType[st.type] = (byType[st.type] || 0) + 1; stNameB += Buffer.byteLength(JSON.stringify({ name: st.name })); }
  const stFull = JSON.stringify(sts.map(st => ({ id: st.id, type: st.type, q: st.q, r: st.r,
    x: st.x, y: st.y, name: st.name, pop: st.pop, owner: '', tier: st.tier, state: 0, expireTs: 0 })));
  const stNoXY = JSON.stringify(sts.map(st => ({ id: st.id, type: st.type, q: st.q, r: st.r,
    name: st.name, pop: st.pop, tier: st.tier })));
  const stMin = JSON.stringify(sts.map(st => [st.q, st.r, st.type, st.tier, st.pop, st.name]));
  console.log(`聚落 ${sts.length} 处 (枚举耗时 ${Date.now() - t2} ms) — ${Object.entries(byType).map(([k, n]) => `${k}:${n}`).join(' / ')}`);
  console.log(`  一次性全量数组 [id,type,q,r,x,y,name,pop,tier,state…]: ${fmt(Buffer.byteLength(stFull))}  gzip ${fmt(gz(stFull))}`);
  console.log(`     └ 去掉 x/y 与运行态字段 (id,type,q,r,name,pop,tier): ${fmt(Buffer.byteLength(stNoXY))}  gzip ${fmt(gz(stNoXY))}`);
  console.log(`     └ 极简数组 [q,r,type,tier,pop,name]:                 ${fmt(Buffer.byteLength(stMin))}  gzip ${fmt(gz(stMin))}`);
  console.log(`  平均每处聚落 JSON ${(Buffer.byteLength(stFull) / sts.length).toFixed(0)} B (其中名称 ${stNameB / sts.length | 0} B)`);
  console.log(`  二进制打包参考: ${sts.length} × 14 B = ${fmt(sts.length * 14)} → base64 ${fmt(Math.ceil(sts.length * 14 / 3) * 4)}`);

  /* ①c 道路 (regionJson 自带, 全图按 key 去重合计) — 先小样本外推, 太慢则跳过 */
  if (DO_ROADS) {
    const probeN = 24, probeCells = [];
    for (let i = -RR, n = 0; i <= RR && n < probeN; i += 7) for (let j = -RR; j <= RR && n < probeN; j += 9, n++) probeCells.push([i, j]);
    const t3 = Date.now();
    for (const [i, j] of probeCells) MG.roadsNear(i, j, 9999);
    const per = (Date.now() - t3) / probeN;
    const nCells = (2 * RR + 1) ** 2;
    if (per * nCells > 240000) {
      console.log(`道路: 单区域 BFS ~${per.toFixed(0)} ms × ${nCells} 格 > 4 分钟, 已跳过 (--no-roads 可显式关闭)`);
    } else {
      const seen = new Set(); const roadArr = [];
      const t4 = Date.now();
      for (let i = -RR; i <= RR; i++) for (let j = -RR; j <= RR; j++) {
        for (const rd of MG.roadsNear(i, j, 9999)) {
          if (seen.has(rd.key)) continue;
          seen.add(rd.key);
          const pts = [];
          for (const p of rd.pts) pts.push(Math.round(p.x), Math.round(p.y));
          roadArr.push([rd.key, Math.round(rd.x0), Math.round(rd.y0), Math.round(rd.x1), Math.round(rd.y1), pts]);
        }
      }
      const roadJson = JSON.stringify(roadArr);
      const ptN = roadArr.reduce((a, r) => a + r[5].length / 2, 0);
      console.log(`道路 ${roadArr.length} 条 / ${ptN} 折点 (去重枚举耗时 ${((Date.now() - t4) / 1000).toFixed(1)} s):`);
      console.log(`  一次性全量数组 [key,x0,y0,x1,y1,pts…](坐标取整): ${fmt(Buffer.byteLength(roadJson))}  gzip ${fmt(gz(roadJson))}`);
    }
  }

  /* ② 全图字段网格 (现有小地图机制, 1 字节/格, 外接方格) */
  if (QUICK_GRID) { console.log('  (② ③ 已按 --no-grid 跳过)'); continue; }
  const B = Math.ceil(RT) + 2;
  const q0 = -B, q1 = B, r0 = -B, r1 = B;
  const nq = q1 - q0 + 1, nr = r1 - r0 + 1;
  const t1 = Date.now();
  const grid = JSON.parse(MGS.fieldGridJson(q0, q1, r0, r1));
  const raw = Buffer.from(grid.d, 'base64');
  console.log(`  缩略图字段网格 ${nq}×${nr}=${nq * nr} 格 (${((nq * nr) / 1e6).toFixed(2)}M, 采样 ${Date.now() - t1} ms):`);
  console.log(`    原始 ${fmt(raw.length)} → base64 ${fmt(grid.d.length)} → gzip(原始) ${fmt(gz(raw))}`);

  /* ③ 真 PNG 缩略图: 按世界坐标逐像素采样网格上色 */
  for (const W of [1024, 2048]) {
    const rgb = Buffer.alloc(W * W * 3);
    const half = EDGE_W * 1.02;
    for (let py = 0; py < W; py++) {
      const wy = (py + 0.5) / W * 2 * half - half;
      const r = Math.round(wy / TILE_H);
      for (let px = 0; px < W; px++) {
        const wx = (px + 0.5) / W * 2 * half - half;
        const q = Math.round(wx / HEX_W - r * 0.5);
        let d = 0;                                        // 越界/界外 → 深海
        if (q >= q0 && q <= q1 && r >= r0 && r <= r1) d = raw[(r - r0) * nq + (q - q0)];
        const c = PAL[Math.min(d, PAL.length - 1)];
        const di = (py * W + px) * 3;
        rgb[di] = c[0]; rgb[di + 1] = c[1]; rgb[di + 2] = c[2];
      }
    }
    const png = encodePng(W, W, rgb);
    const out = `${ROOT}/verify/fullmap_thumb_${W}_${seed}.png`;
    if (W === 1024) fs.writeFileSync(out, png);
    console.log(`    PNG 缩略图 ${W}×${W}: ${fmt(png.length)}${W === 1024 ? '  → ' + out : ''}`);
  }
}
console.log('\n注: gzip 为服务端「protobuf+gzip 落库/下发」口径的近似; PNG 未加行滤波, 实际还可再小 10~30%。');
