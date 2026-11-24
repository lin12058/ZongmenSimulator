/* ============================================================
 * check_place_rules.mjs — 落定流程 (commitPlace) 的端到端离线契约
 * ------------------------------------------------------------
 * ⚠ 为什么能离线跑整个流程: `mapgen-server.js` 是**纯搬运层** (无宿主依赖,
 *   末尾 `typeof window !== 'undefined' ? window : globalThis`), 加载序
 *   noise.js + mapgen-config.js + mapgen.js + mapgen-server.js 之后,
 *   `MapGenServer.commitPlace(q,r,optsJson)` 就是服务端真正调的那条路
 *   (方案 §3.3 的七步同步序列全在这一次调用里)。这条离线直调比"手搓原语复刻流程"
 *   可信得多 —— 参照系不是我自己拼的。
 *
 * 断言:
 *   A. 落定返回体: id 形态 / regionI,J / regions=25 / cross 非空 / roadVer +1 /
 *      ms>0 / st 世界坐标 == fields()
 *   B. 脏块范围: **真正发生变化的区域格必须全部落在 blocks 里** (坑 D 的运行时验证)
 *   C. 不清缓存 ⇒ ext 静默无效 (坑 E 的真身): 记为一条正面断言
 *   D. roadVer 红线: 单调 +1, resetRoads/configure **不归零** (红线 4)
 *
 * 用法: node verify/check_place_rules.mjs [seed] [扫描半径]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;
const MS = global.MapGenServer;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

const SEED = process.argv[2] || 'seed-check';
const SCAN = parseInt(process.argv[3] || '5', 10);
const WIN = SCAN + 2;                       // 指纹扫描窗 (比落点扫描半径多 2 环)
const DIRTY_PAD = 4;                        // 与 mapgen-server.js 的 DIRTY_BLOCK_PAD 同步

MG.init(SEED);
console.log(`seed=${SEED}`);

/* ---------- 取一个"像样"的落点 ----------
   不能紧贴既有聚落 (那会落在它的领地里, 真实流程会判 too_close), 也不能太远
   (太远则新宗门拉不出任何路, "重算代价"就成了空跑)。故沿轴向在 [need, need+10] 里找:
   既过 domainCheck, 又过 placeCheckJson 的其余判据 (灵气/灵脉/深海)。 */
let spot = null;
const spMin = MG.CFG.SEA_SETTLE_MIN_SPIRIT;
outer:
for (let i = -SCAN; i <= SCAN; i++) {
  for (let j = -SCAN; j <= SCAN; j++) {
    for (const s of MG.settlementsFor(i, j)) {
      if (s.type === 'poi') continue;
      const need = Math.max(1, MG.domainRadiusOf(s));
      for (let dq = need; dq <= need + 10 && !spot; dq++) {
        for (let dr = -3; dr <= 3 && !spot; dr++) {
          const q = s.q + dq, r = s.r + dr;
          const f = MG.fields(q, r);
          if (f.biome === MG.BIOME.DEEP || f.biome === MG.BIOME.OCEAN || f.vein) continue;
          if (MG.spiritAt(q, r) < spMin) continue;
          const vn = MG.veinNear(q, r);
          if (vn && vn.d < (MG.CFG.SETTLE_VEIN_FOOT_PAD | 0)) continue;
          if (!MG.domainCheck(q, r, '').ok) continue;
          spot = { q, r, near: s }; break outer;
        }
      }
    }
  }
}
check('找到合法落点样本 (过 placeCheckJson 全链: 非深海/非灵脉/不侵入既有领地/灵气达标)',
  !!spot, '±' + SCAN + ' 区域格内没找到 ⇒ 换 seed 或放大扫描半径');
if (!spot) {
  console.log('\n========== 结果: 无法取样 ==========');
  process.exit(1);
}
console.log(`  落点 (${spot.q},${spot.r}) · 最近聚落 ${spot.near.type} "${spot.near.name}" ` +
            `@ (${spot.near.q},${spot.near.r}) 距 ${MG.hexDist(spot.q, spot.r, spot.near.q, spot.near.r)} 格`);

/* ---------- 指纹 ----------
   ⚠ **必须分开**: 实体层 (settleJson) 是直读 ext 的 —— 放下去立刻可见;
     道路层 (regionJson) 才是被 demandCache/skeletonCache/roadCache 缓存住的那一半。
     混成一个指纹会让「不清缓存」的静默失效被实体层的正常变化掩盖 (第一版就是这么写的)。 */
const RS = MG.regionSeedOf(spot.q, spot.r);
function fpRegion() {
  const out = new Map();
  for (let di = -WIN; di <= WIN; di++) {
    for (let dj = -WIN; dj <= WIN; dj++) {
      const i = RS.i + di, j = RS.j + dj;
      let rj = '';
      try { rj = MS.regionJson(i, j); } catch (e) { rj = 'ERR:' + e.message; }
      out.set(i + ',' + j, rj);
    }
  }
  return out;
}
function fpSettle() {
  const out = new Map();
  for (let di = -WIN; di <= WIN; di++) {
    for (let dj = -WIN; dj <= WIN; dj++) {
      const i = RS.i + di, j = RS.j + dj;
      out.set(i + ',' + j, MS.settleJson(i, j));
    }
  }
  return out;
}
function diffKeys(a, b) {
  const d = [];
  b.forEach((v, k) => { if (a.get(k) !== v) d.push(k); });
  return d;
}

/* ============================================================
 * C. 坑 E —— 「不清缓存 ⇒ 道路静默不变」必须先被证实, 否则后面的断言全是假绿
 * ============================================================ */
console.log('\n== C. 坑 E: 不清 demand/骨架/road 缓存 ⇒ 道路静默不变 ==');
MG.setExternalSettlements([]);
MG.resetRoads();
const cR0 = fpRegion(), cS0 = fpSettle();
const pl1 = MG.placeSettlement(spot.q, spot.r, { type: 'sect', tier: 3, name: '试锋宗' });
const cR1 = fpRegion(), cS1 = fpSettle();
check('C1 不清缓存就放置 ⇒ 实体层立刻可见 (settleJson 有变化)',
  diffKeys(cS0, cS1).length > 0, '变化 0 个 ⇒ 实体层没写进 ext?');
/* ⚠ 这里**故意不**硬断言「道路层完全没变」: 逐格 regionJson 的差分会掺入道路装配的
   惰性补算 (regionJson 内部会顺手把缺的边补进 roadCache), 于是"不清缓存"也能看到
   个别格变化。坑 E 的严格形态 (demand/骨架集合逐条比对) 由
   verify/check_place_road_recompute.mjs 段 1 断言 —— 那边才有 demandEdgesFor /
   skeletonEdgesFor 的只读出口。此处只报数, 不当判据。 */
console.log(`  [报数] 不清缓存时变化格 ${diffKeys(cR0, cR1).length} 个` +
            ` (含实体层与惰性补算; 不是"没变"的证据)`);
/* 正确路径: 清派生状态后再重算那 25 格 */
const clr = MG.clearRoadSideFor(RS.i, RS.j, 0, [pl1.id]);
for (const [i, j] of clr.regions) MG.roadsNear(i, j, 9999);
const cR2 = fpRegion();
check('C2 清缓存 + 重算后 ⇒ 道路层确实变了 (证明"清缓存"这一步不可省)',
  diffKeys(cR0, cR2).length > 0, '变化 0 个 ⇒ 清了也没用?');
console.log(`  clearRoadSideFor: regions=${clr.regions.length} cross=${clr.cross.length} ` +
            `清掉 demand=${clr.n.demand} skel=${clr.n.skel} road=${clr.n.road} fail=${clr.n.fail}`);

/* ============================================================
 * A. commitPlace 端到端 (与服务端同一条路)
 * ============================================================ */
console.log('\n== A. commitPlace 端到端 ==');
MG.setExternalSettlements([]);
MG.init(SEED);                                   // 世界重铸: ext 清空 + roadVer 前进 (不归零)
const verBefore = MG.roadVersion();
const base3 = fpRegion();
const raw = MS.commitPlace(spot.q, spot.r, JSON.stringify({ type: 'sect', tier: 3, name: '试锋宗', owner: 'u1' }));
const res = JSON.parse(raw);
check('A1 ok=1 且返回体可解析', res.ok === 1, raw.slice(0, 160));
const st = res.st || {};
check('A2 id 形态 {i}_{j}_u{n} (前两段必须是整数: 引擎会 split 反解)',
  /^-?\d+_-?\d+_u\d+$/.test(String(st.id)), String(st.id));
const rs = MG.regionSeedOf(st.q, st.r);
check('A3 regionI/J == regionSeedOf(落点)', res.regionI === rs.i && res.regionJ === rs.j,
  `${res.regionI},${res.regionJ} vs ${rs.i},${rs.j}`);
const f0 = MG.fields(spot.q, spot.r);
check('A4 st 世界坐标 == fields() 的 x/y (不与坐标口径漂移)',
  Math.abs(st.x - f0.x) < 1e-6 && Math.abs(st.y - f0.y) < 1e-6,
  `${st.x},${st.y} vs ${f0.x},${f0.y}`);
check('A5 regions == 25 个区域格 (ring=0 ⇒ 5x5)', res.regions.length === 25,
  String(res.regions.length));
check('A6 cross 非空 (坑 D: 跨界边另一端也要重发)', res.cross.length > 0,
  String(res.cross.length));
/* ⚠ roadVer 是**全局道路变更计数** —— roadsNear 每落成一条新路就会 ++
   (mapgen.js:1935), 所以一次 commitPlace 会让它前进很多 (实测 0 → 246: 25 格
   重算里新铺了两百多条路)。因此这里断言的是两条更强的性质, 而不是"+1":
     · 严格前进 (宿主 ObserveRoadVer 单调取大 ⇒ 必须比任何历史观测值大);
     · 报告值 == 引擎当前值 (别把一个陈旧值发给宿主, 那会让 tile 判"新鲜")。 */
check('A7a roadVer 相对提交前严格前进 (增量, 绝不回退/归零)',
  res.roadVer > verBefore, `${verBefore} → ${res.roadVer}`);
check('A7b 报告值 == 引擎当前值 (不是陈旧快照)',
  res.roadVer === MG.roadVersion(), `${res.roadVer} vs ${MG.roadVersion()}`);
check('A8 ms > 0 (同步重算真的跑了)', res.ms > 0, String(res.ms));
check('A9 blocks 非空 (前端靠它强制重拉)', Array.isArray(res.blocks) && res.blocks.length > 0,
  String(res.blocks && res.blocks.length));
console.log(`  提交: id=${st.id} ms=${res.ms} nRoad=${res.nRoad} ` +
            `blocks=${res.blocks.length} 清掉 demand=${res.cleared.demand} road=${res.cleared.road}`);

/* ============================================================
 * B. 脏块范围必须覆盖"真正变化的区域格"
 * ============================================================ */
console.log('\n== B. 脏块范围 vs 实际变化 ==');
const after = fpRegion();
const changed = diffKeys(base3, after);
/* 复算块: 与 dirtyBlocksFor 同规则 (chunkOfTile + PAD), 断言 changed 的块都在返回的包围盒内 */
const blockset = new Set(res.blocks.map((b) => b[0] + ',' + b[1]));
let outside = 0; const outsideSample = [];
for (const k of changed) {
  const [i, j] = k.split(',').map(Number);
  /* 区域格 → 它覆盖的任一格 (取中心格) → 块 */
  const cc = MG.chunkOfTile(MG.regionInfo(i, j).q, MG.regionInfo(i, j).r);
  if (!blockset.has(cc.ca + ',' + cc.cb)) {
    outside++;
    if (outsideSample.length < 4) outsideSample.push(`${k}→块(${cc.ca},${cc.cb})`);
  }
}
check(`B1 实际变化的 ${changed.length} 个区域格全部落在脏块包围盒内 (pad=${DIRTY_PAD})`,
  changed.length > 0 && outside === 0,
  `越界 ${outside} 个: ${outsideSample.join(' ')}`);
/* 反向: 脏块必须含落点自己那块 —— 否则前端连新宗门都画不出来 */
const ownBlk = MG.chunkOfTile(st.q, st.r);
check('B2 脏块含落点自己所在的块', blockset.has(ownBlk.ca + ',' + ownBlk.cb),
  `(${ownBlk.ca},${ownBlk.cb})`);
/* 反向: 脏块范围不能小到"只有自己那一个块"; 也不能大到全图 (它是包围盒 + pad, 有上界) */
check('B3 脏块数在合理区间 [4, 400] (包围盒+pad, 非全图)',
  res.blocks.length >= 4 && res.blocks.length <= 400, String(res.blocks.length));
console.log(`  实际变化区域格 ${changed.length} 个 / 脏块 ${res.blocks.length} 个`);

/* ============================================================
 * D. roadVer 红线 (方案 §3.2 坑 C / 红线 4)
 * ============================================================ */
console.log('\n== D. roadVer 只能 +1 增量, 绝不归零 ==');
const v0 = MG.roadVersion();
check('D1 bumpRoadVer 恰好 +1', MG.bumpRoadVer() === v0 + 1, `${v0} → ${MG.roadVersion()}`);
MG.resetRoads();
check('D2 resetRoads 后 roadVer **不归零** (归零 ⇒ 宿主的 tile 缓存永远判不新鲜)',
  MG.roadVersion() > v0, `reset 后 ${MG.roadVersion()} (reset 前 ${v0})`);
const v2 = MG.roadVersion();
MG.configure({});
check('D3 configure 后 roadVer **不归零**', MG.roadVersion() > v2,
  `${v2} → ${MG.roadVersion()}`);
check('D4 单调: 连续 bump 三次严格递增', (() => {
  let a = MG.roadVersion(), ok = true;
  for (let n = 0; n < 3; n++) { const b = MG.bumpRoadVer(); if (!(b > a)) ok = false; a = b; }
  return ok;
})());

console.log(`\n========== 结果: ${failures ? failures + ' 项失败' : '全部通过 ✔'} ==========`);
process.exit(failures ? 1 : 0);
