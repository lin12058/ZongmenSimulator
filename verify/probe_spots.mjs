#!/usr/bin/env node
/* ============================================================
 * verify/probe_spots.mjs — 离线定点: 找出「路压水」「建筑压水」「灵脉群」
 * 的坐标, 供 headless 截图脚本把镜头停到正确位置。
 *
 * 为什么离线: 广角在线探测要等服务端灌几十个区块/区域包 (还撞 rate limit),
 * 而引擎是纯函数 —— 直接调 roadsNear / growTownFootprint / communityOf 更快
 * 且可复现 (与服务端 regionJson/settleJson 同一入口)。
 *
 * 用法: node verify/probe_spots.mjs [seed] [--R=<区域半径>] [--BR=<找压水建筑的半径>]
 * 产出: 一行 JSON
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

const argOf = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').split('=')[1];
const SEED = process.argv.slice(2).find((a) => !/^--/.test(a)) || '42';
const R = Number(argOf('R')) || 8;

/* ---------- 引擎 (顺序铁律: noise → mapgen-config → mapgen) ---------- */
const sb = { console, Math, JSON };
sb.window = sb; sb.globalThis = sb;
const ectx = vm.createContext(sb);
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ectx, { filename: f });
}
const MG = sb.MapGen;
if (!MG) { console.error('MapGen 未导出'); process.exit(1); }
MG.init(SEED);

const isWater = (q, r) => { const f = MG.fields(q, r); return !!f && f.disp <= 1; };
const w2t = (x, y) => MG.pxToTile(x, y);

/* ---------- ① 路压水 ---------- */
const water = [];
for (let i = -R; i <= R && water.length < 400; i++) {
  for (let j = -R; j <= R && water.length < 400; j++) {
    let roads = [];
    try { roads = MG.roadsNear(i, j, 9999) || []; } catch (e) { continue; }
    for (const rd of roads) {
      const pts = rd.pts;
      for (let p = 0; p + 1 < pts.length; p++) {
        const a = pts[p], b = pts[p + 1];
        const ta = w2t(a.x, a.y), tb = w2t(b.x, b.y);
        if (isWater(ta.q, ta.r) || isWater(tb.q, tb.r)) {
          water.push({ region: [i, j], key: rd.key, a: [ta.q, ta.r], b: [tb.q, tb.r],
            d0: MG.hexDist(0, 0, ta.q, ta.r) });
          break;
        }
      }
      if (water.length >= 400) break;
    }
  }
}
water.sort((a, b) => a.d0 - b.d0);

/* ---------- ② 建筑压水 (栈桥点) ---------- */
const bridge = [];
const BR = Number(argOf('BR')) || R;
for (let i = -BR; i <= BR && bridge.length < 20; i++) {
  for (let j = -BR; j <= BR && bridge.length < 20; j++) {
    let sts = [];
    try { sts = MG.settlementsFor(i, j) || []; } catch (e) { continue; }
    for (const st of sts) {
      if (st.type === 'poi') continue;
      let plan = null;
      try { plan = MG.growTownFootprint(st.id, st.type, st.q, st.r); } catch (e) { continue; }
      if (!plan || !plan.buildings) continue;
      for (const b of plan.buildings) {
        if (isWater(b.q, b.r)) bridge.push({ name: st.name, type: st.type, tile: [b.q, b.r], kind: b.kind });
        if (bridge.length >= 20) break;
      }
      if (bridge.length >= 20) break;
    }
  }
}

/* ---------- ③ 聚落清单 (按建筑数排序, 给「城镇近景」选点) ---------- */
const towns = [];
for (let i = -R; i <= R; i++) {
  for (let j = -R; j <= R; j++) {
    let sts = [];
    try { sts = MG.settlementsFor(i, j) || []; } catch (e) { continue; }
    for (const st of sts) {
      if (st.type === 'poi') continue;
      let n = 0;
      try { const p = MG.growTownFootprint(st.id, st.type, st.q, st.r); n = p ? p.buildings.length : 0; } catch (e) { n = 0; }
      towns.push({ name: st.name, type: st.type, q: st.q, r: st.r, n: n, d0: MG.hexDist(0, 0, st.q, st.r) });
    }
  }
}
towns.sort((a, b) => b.n - a.n);

/* ---------- ④ 灵脉群 (群落) —— 按距原点远近排序, 取最近几处 ---------- */
const veins = [];
let commShape = null;
for (let i = -8; i <= 8; i++) {
  for (let j = -8; j <= 8; j++) {
    let cm = null;
    try { cm = MG.communityOf(i, j); } catch (e) { continue; }
    if (!cm) continue;
    if (!commShape) commShape = Object.keys(cm);
    if (!cm.veins || !cm.veins.length) continue;
    for (const v of cm.veins) {
      veins.push({ cell: [i, j], element: v.element, level: v.level, name: v.name,
        tile: [v.q, v.r], d0: MG.hexDist(0, 0, v.q, v.r) });
    }
  }
}
veins.sort((a, b) => a.d0 - b.d0);

console.log('SPOTS ' + JSON.stringify({
  seed: SEED, regionR: R, chunkS: MG.CHUNK_S, hexW: MG.HEX_W, hexR: MG.HEX_R, commCL: MG.CFG.COMM_CL,
  waterCount: water.length, water: water.slice(0, 10),
  bridgeCount: bridge.length, bridge: bridge.slice(0, 10),
  topTowns: towns.slice(0, 12),
  veinCount: veins.length, closestVeins: veins.slice(0, 10), commShape: commShape
}));
