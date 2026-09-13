#!/usr/bin/env node
/* ============================================================
 * verify/w6_bldg_face.mjs — 建筑「朝向推导」独立对拍
 * ------------------------------------------------------------
 * 校验对象: 前端 web/js/main.js 中的建筑朝向探针 + web/js/bldg_ink.js 的
 *           FACE_RULE / DIRS / resolveFace 契约。
 * 数据来源: 引擎真源 Server/Zongmen/Engine/js (MapGen.fields 作地类真值),
 *           不依赖 HTTP 服务端, 不依赖前端打包产物。
 *
 * 断言项:
 *   A. DIRS 与引擎 NEIGH_SLOTS 同序同向 (轴向→屏幕向量公式自洽)
 *   B. axDist 与引擎 hexDist 逐格一致 (环枚举前提)
 *   C. 水岸/矿脉/林地建筑的探针在 3 环内必命中对应地类 → 不落回退
 *   D. 命中方向的环内偏移格, 其地类确实匹配 (方向真的指向该地类)
 *   E. center 规则: 朝向与「格→中枢」向量同向 (点积 > 0)
 *      away  规则: 反向 (点积 < 0)
 *   F. 任何建筑的 face 都必须是有限非零向量, 且可归入 6 个精灵朝向之一
 *   G. 区块数组反解 (centers → qa,ra) 往返一致, 且 33 格窗口自洽
 *
 * 判据: 全部通过 + 退出码 0
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

const SEEDS = process.argv.slice(2).filter((a) => !/^--/.test(a));
const seedList = SEEDS.length ? SEEDS : ['宗门模拟器', '山河图', '青云宗'];

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; bad.push(name + (detail ? ' → ' + detail : ''));
  return false;
}

/* ---------- 载入引擎 (顺序铁律: noise → mapgen-config → mapgen) ---------- */
const sandbox = { console, Math, JSON };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
import vm from 'node:vm';
const ctx = vm.createContext(sandbox);
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ctx, { filename: f });
}
const MG = sandbox.MapGen;
if (!MG) { console.error('MapGen 未导出'); process.exit(1); }

/* ---------- 载入绘制核心 (前端真源) ---------- */
const biSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'bldg_ink.js'), 'utf8');
const biBox = { console, Math, JSON };
biBox.window = biBox; biBox.globalThis = biBox;
vm.runInContext(biSrc, vm.createContext(biBox), { filename: 'bldg_ink.js' });
const BI = biBox.BldgInk;
if (!BI) { console.error('BldgInk 未导出'); process.exit(1); }

/* =====================================================================
 * A. DIRS ↔ NEIGH_SLOTS 同序同向
 *    引擎世界公式 world(q,r) = (hexW*(q + r/2), 1.5*hexR*r);
 *    前端 faceDirOf 必须由同一公式归一化而来。
 * ===================================================================== */
const NEIGH = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
MG.init(seedList[0]);
const geoA = { hexR: MG.HEX_R, hexW: MG.HEX_W };   // 单一真源, 不写字面量
{
  let m = 0;
  for (let k = 0; k < 6; k++) {
    const wx = geoA.hexW * (NEIGH[k][0] + NEIGH[k][1] / 2);
    const wy = 1.5 * geoA.hexR * NEIGH[k][1];
    const L = Math.hypot(wx, wy);
    const ex = wx / L, ey = wy / L;
    m = Math.max(m, Math.abs(ex - BI.DIRS[k][0]), Math.abs(ey - BI.DIRS[k][1]));
  }
  ok('A1 DIRS 与 NEIGH_SLOTS 同序同向 (maxdiff<1e-9)', m < 1e-9, 'maxdiff=' + m);
}
{
  /* DIRS[k] 必须能把第 k 个邻居还原回 6 向桶 (spriteOf 的 dirIdxOf 前提) */
  let m = 0;
  for (let k = 0; k < 6; k++) {
    const wx = geoA.hexW * (NEIGH[k][0] + NEIGH[k][1] / 2);
    const wy = 1.5 * geoA.hexR * NEIGH[k][1];
    const L = Math.hypot(wx, wy);
    let best = -9, bi2 = -1;
    for (let j = 0; j < 6; j++) {
      const d = (wx / L) * BI.DIRS[j][0] + (wy / L) * BI.DIRS[j][1];
      if (d > best) { best = d; bi2 = j; }
    }
    void m;
    ok('A2 邻居 ' + k + ' 唯一归入朝向桶 ' + k, bi2 === k, 'got=' + bi2);
  }
}

/* =====================================================================
 * B. axDist (前端) ≡ MG.hexDist (引擎)
 * ===================================================================== */
{
  let mism = 0, n = 0;
  const axDist = (dq, dr) => (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) >> 1;
  for (let dq = -9; dq <= 9; dq++) for (let dr = -9; dr <= 9; dr++) {
    n++;
    if (axDist(dq, dr) !== MG.hexDist(0, 0, dq, dr)) mism++;
  }
  ok('B1 axDist ≡ hexDist (' + n + ' 格全等)', mism === 0, 'mismatch=' + mism);
}

/* =====================================================================
 * C–F. 逐建筑朝向推导
 *   ⚠ 这里调用的是**生产代码**: BldgInk.faceSolver —— 前端 web/js/main.js
 *     与离线预览页都注入各自的地类回调复用同一份实现。本脚本只注入
 *     「引擎真值地类」MG.fields().biome, 于是校验的是真实链路而非复刻版。
 * ===================================================================== */
const RING_MAX = 3;
const hexW = geoA.hexW, hexR = geoA.hexR;
const solver = BI.faceSolver({
  biome: (q, r) => { const f = MG.fields(q, r); return f ? f.biome : -1; },
  hexW, hexR, ringMax: RING_MAX
});
const faceDirOf = solver.dirOf;
const axDist = solver.axDist;
const CODE = { water: 1, rock: 6, wood: 4 };

let nBldg = 0, nFaceBad = 0, nBucketBad = 0;
const byRule = {};                       // rule -> { n, fallback }
const a = { biomeUse: 0, biomeMiss: 0 }; // 地类规则命中/未命中
const mustHit = { n: 0, miss: 0 };       // 「地皮 ⇒ 必有该地类」的建筑 (磨坊除外)
const mill = { n: 0, wet: 0 };           // 磨坊: 有水 / 总数 (无水走旱碾分支)
const dirHitCheck = [];                  // 命中方向反向验证样本

for (const seed of seedList) {
  MG.init(seed);
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const sts = MG.settlementsFor(i, j) || [];
      for (const st of sts) {
        if (st.type === 'poi') continue;
        const plan = MG.growTownFootprint(st.id, st.type, st.q, st.r);
        if (!plan || !plan.buildings) continue;
        for (const b of plan.buildings) {
          nBldg++;
          const rule = BI.FACE_RULE[b.kind] || 'south';
          const rec = byRule[rule] || (byRule[rule] = { n: 0, fallback: 0 });
          rec.n++;

          /* 生产求解器: 与前端 drawBuildings 完全同一条代码路径 */
          const fi = solver.faceInfo(b, st);
          const face = fi.face;
          const code = CODE[rule] || 0;
          const isBiomeRule = !!code;
          /* 独立复算探针结果 (走 solver.nearestAt, 不依赖 faceInfo 内部状态) */
          const pf = isBiomeRule ? solver.nearestAt(b, code) : null;
          if (isBiomeRule) {
            if (pf) a.biomeUse++; else a.biomeMiss++;
            if (!pf) rec.fallback++;
            /* 磨坊地皮是「良田」, 不临水属常态 → 不计入必命中;
               其余 (水岸/矿脉/林地/灼壤) 地皮本就由该地类定义, 必命中 */
            if (b.kind === '磨坊') { mill.n++; if (pf) mill.wet++; }
            else { mustHit.n++; if (!pf) mustHit.miss++; }
            /* 地类规则命中时, face 必须**逐位等于**该方向 (不被回退覆盖) */
            if (pf && (face.x !== pf.x || face.y !== pf.y)) {
              dirHitCheck.push({ kind: b.kind, rule, mismatch: true });
            }
            /* water 标记必须与「环内是否真有水面」一致 (磨坊画水车/旱碾的开关) */
            if (b.kind === '磨坊' && (fi.water === true) !== !!pf) {
              dirHitCheck.push({ kind: b.kind, rule, waterFlagBad: true });
            }
          }
          if (rule === 'center' || rule === 'away') {
            const self = (st.q === b.q && st.r === b.r);
            if (self) { rec.fallback++; }          // 建筑即中枢格 → 无向可指, 走回退
            else {
              const toC = faceDirOf(st.q - b.q, st.r - b.r);
              const want = rule === 'center' ? 1 : -1;
              const d = face.x * toC.x + face.y * toC.y;
              dirHitCheck.push({ kind: b.kind, rule, dot: d, want, self });
            }
          }
          /* 地类方向真值验证: 沿 face 反查同向整格, 该格地类必须真的匹配 */
          if (isBiomeRule && pf) {
            let found = false;
            for (let rad = 1; rad <= RING_MAX && !found; rad++) {
              for (let dq = -rad; dq <= rad; dq++) {
                for (let dr = -rad; dr <= rad; dr++) {
                  if (axDist(dq, dr) !== rad) continue;
                  const dd = faceDirOf(dq, dr);
                  if (Math.abs(dd.x - face.x) > 1e-12 || Math.abs(dd.y - face.y) > 1e-12) continue;
                  const bm = MG.fields(b.q + dq, b.r + dr).biome;
                  const hit = code === 1 ? bm <= 1 : code === 6 ? bm >= 6 : bm === code;
                  if (hit) { found = true; break; }
                }
                if (found) break;
              }
            }
            if (!found) dirHitCheck.push({ kind: b.kind, rule, badDir: true });
          }

          /* F: face 有限非零 */
          const usable = face && isFinite(face.x) && isFinite(face.y) && (face.x !== 0 || face.y !== 0);
          if (!usable) nFaceBad++;
          /* F2: 可归入 6 向桶 */
          if (usable) {
            const L = Math.hypot(face.x, face.y);
            let best = -9;
            for (let k = 0; k < 6; k++) {
              const d = (face.x / L) * BI.DIRS[k][0] + (face.y / L) * BI.DIRS[k][1];
              if (d > best) best = d;
            }
            if (best < 0.6) nBucketBad++;
          }
        }
      }
    }
  }
}

ok('C1 取样建筑数 > 0', nBldg > 0, 'n=' + nBldg);
ok('C2 地皮定义类建筑 (水岸/矿脉/林地/灼壤) 3 环内必命中地类', mustHit.miss === 0,
   'n=' + mustHit.n + ' miss=' + mustHit.miss);
ok('C3 磨坊确有「无水」样本 (旱碾分支被走到的前提)', mill.wet < mill.n,
   'wet=' + mill.wet + '/' + mill.n);
ok('C4 命中方向反向校验: 该方向环上确有匹配地类',
   !dirHitCheck.some((x) => x.badDir), 'badDir=' + dirHitCheck.filter((x) => x.badDir).length);
ok('C5 地类规则命中时 face 逐位等于探针方向 (不被回退覆盖)',
   !dirHitCheck.some((x) => x.mismatch), 'mismatch=' + dirHitCheck.filter((x) => x.mismatch).length);
ok('C6 磨坊 water 标记 ≡「环内真有水面」',
   !dirHitCheck.some((x) => x.waterFlagBad), 'bad=' + dirHitCheck.filter((x) => x.waterFlagBad).length);
{
  const cen = dirHitCheck.filter((x) => x.rule === 'center');
  const awy = dirHitCheck.filter((x) => x.rule === 'away');
  ok('D1 center 规则朝向与「格→中枢」同向 (dot>0.99, n=' + cen.length + ')',
     cen.every((x) => x.dot > 0.99),
     'min dot=' + (cen.length ? Math.min(...cen.map((x) => x.dot)).toFixed(4) : 'n/a'));
  ok('D2 away 规则朝向与「格→中枢」反向 (dot<-0.99, n=' + awy.length + ')',
     awy.every((x) => x.dot < -0.99),
     'max dot=' + (awy.length ? Math.max(...awy.map((x) => x.dot)).toFixed(4) : 'n/a'));
}
ok('F1 face 无「非有限 / 零向量」', nFaceBad === 0, 'bad=' + nFaceBad);
ok('F2 face 全部可归入 6 个精灵朝向 (cos>0.6)', nBucketBad === 0, 'bad=' + nBucketBad);

/* =====================================================================
 * G. 区块数组反解 (centers → qa,ra) + 前端「4 候选区块 + 索引成员判定」归属
 *    前端 biomeAt 不复制引擎的距离/平局规则, 而是枚举 4 个候选区块、直接问
 *    「该区块的索引里有没有这一格」—— 索引由服务端 qrel 生成, 归属天然权威。
 *    这里对拍: ①centers 反解格位与 qrel/rrel 真值全等 ②(cq,cr) 落在 33 窗口
 *    ③4 候选枚举必唯一命中, 且命中的区块 == 引擎 chunkOfTile 真值
 * ===================================================================== */
{
  const S = MG.CHUNK_S, CS_OFF = 16, SPAN = 33;
  MG.init(seedList[0]);
  const chunks = [];
  const truth = new Map();                       // 'q,r' -> 'ca,cb' (引擎归属)
  for (const [ca, cb] of [[0, 0], [1, -1], [-2, 3], [2, 2]]) {
    const d = MG.buildChunk(ca, cb).data;
    const idx = new Set();
    for (let i = 0; i < d.tiles.length; i++) {
      const q = ca * S + d.qrel[i], r = cb * S + d.rrel[i];
      idx.add(q + ',' + r);
      truth.set(q + ',' + r, ca + ',' + cb);
    }
    chunks.push({ ca, cb, d, idx });
  }
  let n = 0, rtMism = 0, outWin = 0, miss = 0, dup = 0, ownMism = 0;
  let cqMin = 99, cqMax = -99, crMin = 99, crMax = -99;
  for (const ch of chunks) {
    for (let i = 0; i < ch.d.tiles.length; i++) {
      n++;
      const q = ch.ca * S + ch.d.qrel[i], r = ch.cb * S + ch.d.rrel[i];
      /* ① centers 反解往返 */
      const cx = ch.d.centers[i * 2], cy = ch.d.centers[i * 2 + 1];
      const ra2 = Math.round(cy / (1.5 * hexR));
      const qa2 = Math.round(cx / hexW - ra2 / 2);
      if (qa2 !== q || ra2 !== r) rtMism++;
      /* ② 33 格索引窗口 */
      const cq = qa2 - ch.ca * S + CS_OFF, cr = ra2 - ch.cb * S + CS_OFF;
      if (cq < 0 || cq >= SPAN || cr < 0 || cr >= SPAN) outWin++;
      if (cq < cqMin) cqMin = cq; if (cq > cqMax) cqMax = cq;
      if (cr < crMin) crMin = cr; if (cr > crMax) crMax = cr;
      /* ③ 前端归属: 4 候选枚举 + 成员判定 */
      const qb = Math.floor(q / S) * S, rb = Math.floor(r / S) * S;
      const hits = [];
      for (let a2 = 0; a2 < 4; a2++) {
        const ca2 = (qb + (a2 % 2) * S) / S, cb2 = (rb + (a2 >> 1) * S) / S;
        const cc = chunks.find((c) => c.ca === ca2 && c.cb === cb2);
        if (cc && cc.idx.has(q + ',' + r)) hits.push(cc.ca + ',' + cc.cb);
      }
      if (hits.length === 0) miss++;
      else if (hits.length > 1) dup++;
      else if (hits[0] !== truth.get(q + ',' + r)) ownMism++;
    }
  }
  ok('G1 centers 反解格位与 qrel/rrel 真值全等 (' + n + ' 格)', rtMism === 0, 'mismatch=' + rtMism);
  ok('G2 全部格落在 33×33 索引窗口内 (cq ' + cqMin + '..' + cqMax + ', cr ' + crMin + '..' + crMax + ')',
     outWin === 0, 'out=' + outWin);
  ok('G3 前端 4 候选归属: 无缺失', miss === 0, 'miss=' + miss);
  ok('G4 前端 4 候选归属: 无重复命中 (归属唯一)', dup === 0, 'dup=' + dup);
  ok('G5 前端归属 ≡ 引擎 chunkOfTile', ownMism === 0, 'mismatch=' + ownMism);
}

/* ---------- 汇总 ---------- */
const rules = Object.keys(byRule).sort();
console.log('建筑朝向对拍 · 种子 ' + seedList.length + ' 个 · 建筑 ' + nBldg + ' 座' +
            ' · chunkS=' + MG.CHUNK_S);
console.log('  地皮类必命中 ' + (mustHit.n - mustHit.miss) + '/' + mustHit.n +
            ' · 磨坊有水 ' + mill.wet + '/' + mill.n);
for (const r of rules) {
  console.log('  ' + r.padEnd(7) + ' n=' + String(byRule[r].n).padStart(5) +
              '  回退=' + byRule[r].fallback);
}
if (bad.length) {
  console.log('\n未通过:');
  for (const b of bad) console.log('  ✗ ' + b);
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
