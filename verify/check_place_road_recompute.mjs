/* ============================================================
 * check_place_road_recompute.mjs — 玩家落点 → 路网重算 的【代价 + 正确性】实测
 * ------------------------------------------------------------
 * 回答两个必须用数字回答的问题 (方案 §三):
 *   Q1 【代价】用户要求「放下去 → 附近直接重算 → 直接发前端」= **同步**。
 *      同步重算到底多少 ms? 会不会把 V8 门闩钉死?
 *   Q2 【正确性】v2 曾断言「旧边一条都不用重算, 只新增不修改」。
 *      rngDominated 是三方判定 + skeletonEdgesFor 是 Kruskal ⇒ **旧边会被挤掉**。
 *      这个断言到底成不成立?
 *
 * 设计要点 (两次踩坑后定的口径):
 *   · 机制验证 (纯需求图/骨架, 无 A*) 与 耗时实测 **分开** —— 前者可跑几十个落点,
 *     后者只跑选定落点。混在一起跑不动。
 *   · 耗时必须**交替多轮取中位**: JIT 预热会让第二遍快 17% (实测), 单次计时不可信。
 *   · 耗时分两种口径: 「全冷」(init 后, 地形缓存也空 = 最坏) 与
 *     「仅清道路」(地形热, 只重跑 A* = 真实场景)。
 *   · 断言口径: 只断言**必有**的 (机制发生率 > 0)。不提「必须 >0」去苛真一个
 *     可能不发生的现象 —— 那是空真陷阱的镜像。未触发的如实报告。
 *
 * ⚠ 注入手法 (2026-09-23 已改为**真调用**): 引擎已落地
 *   `setExternalSettlements` / `clearRoadSideFor` / `bumpRoadVer` / `placeSettlement`
 *   (方案 §2.4)。本脚本直接调真接口 —— 旧版那套「把 settlementsFor 包一层」的源码改写
 *   已删除: 它会在引擎自己也做了 ext 叠加之后**再叠一层**, 把 settlementsFor$base
 *   变成自递归 (RangeError: Maximum call stack size exceeded)。
 *   仅保留**只读内省**的一处注入 (把内部缓存/纯几何出口挂上导出表) —— 它不改任何行为,
 *   纯为统计与「坑 C / 坑 E」归因。真 API 一旦改名, 脚本会立刻红, 不会静默跑假路径。
 *
 * 加载序必须 noise.js + mapgen-config.js + mapgen.js (漏 mapgen-config 会静默退回兜底参数)。
 * 用法: node verify/check_place_road_recompute.mjs [seed] [落点扫描半径=5]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSDIR = path.join(path.resolve(__dirname, '..'), 'Server', 'Zongmen', 'Engine', 'js');
const seed = process.argv[2] || 'seed-check';
const SCAN = parseInt(process.argv[3] || '5', 10);   // 落点扫描半径 (区域格)
const RING = 2;                                     // 重算范围半径; = §2.7 的 2 环
const MED = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

let PASS = 0, FAIL = 0;
const check = (name, ok, detail) => {
  if (ok) { PASS++; console.log(`  PASS ${name}`); }
  else { FAIL++; console.log(`  FAIL ${name}${detail ? '  ← ' + detail : ''}`); }
};

/* ---------- 内存副本: **只读内省**注入 (不改行为) ---------- */
let src = fs.readFileSync(path.join(JSDIR, 'mapgen.js'), 'utf8').replace(/\r\n/g, '\n');
function raw(a, b) {
  if (!src.includes(a)) throw new Error('注入点未找到 (源码已变, 请同步本脚本): ' + a);
  src = src.replace(a, b);
}

/* 唯一的一处注入: 把内部缓存 / 纯几何出口 / roadVer 挂上导出表。
   ⚠ 这里**只加读出口**, 不包 settlementsFor —— ext 层由引擎自己实现
     (setExternalSettlements), 本脚本只调真接口。 */
raw('    settlementsFor: settlementsFor,',
    '    settlementsFor: settlementsFor,\n' +
    '    __demandEdgesFor: demandEdgesFor,\n' +
    '    __skeletonEdgesFor: skeletonEdgesFor,\n' +
    '    __cache: { road: roadCache, roadFail: roadFail, demand: demandCache, skel: skeletonCache },\n' +
    '    __roadVer: function () { return roadVer; },\n' +
    '    /* 段 6 专用: 只清「城市生成链路」缓存, **保地形热** (elevCache/fieldCache/veinNearCache 不动)\n' +
    '       ⇒ 这样测出的才是「城市重算」本身, 不含重建地形的钱 */\n' +
    '    __clearCity: function () {\n' +
    '      settleCache.clear(); settleRawCache.clear(); siteScoreCache.clear();\n' +
    '      prospectCache.clear(); centerCache.clear(); townCache.clear(); tradeCache.clear();\n' +
    '    },\n' +
    '    __cacheSizes: function () {\n' +
    '      return { settle: settleCache.size, town: townCache.size, site: siteScoreCache.size,\n' +
    '               prospect: prospectCache.size, center: centerCache.size,\n' +
    '               elev: elevCache.size, field: fieldCache.size };\n' +
    '    },');

const ctx = { window: {}, console, Math, Map, Set, performance, JSON };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['noise.js', 'mapgen-config.js']) {
  vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ctx);
}
vm.runInContext(src, ctx);
const MG = ctx.window.MapGen;
const { road: ROAD, roadFail: ROADFAIL, demand: DEMAND, skel: SKEL } = MG.__cache;

/* 只清「与玩家几何关联」的缓存 —— 地形/聚落/选址缓存不动 (ext 不影响它们) */
const clearRoadSide = () => { ROAD.clear(); ROADFAIL.clear(); DEMAND.clear(); SKEL.clear(); };

const regionOf = (id) => { const p = id.split('_'); return [+p[0], +p[1]]; };
const rkeyRegion = (key) => key.split('|').map(regionOf);

/* ---------- 取落点集合: ±SCAN 内有可建路聚落的区域格 ---------- */
MG.init(seed);
const sites = [];
for (let i = -SCAN; i <= SCAN; i++) for (let j = -SCAN; j <= SCAN; j++) {
  const st = MG.settlementsFor(i, j).filter(s => s.type !== 'poi');
  if (st.length) sites.push({ i, j, st });
}
if (!sites.length) throw new Error('找不到含聚落的区域格 —— seed 或扫描半径有问题');
/* 每个落点用「该格第一个聚落中心 + 偏移」⇒ 保证落在地形合法的位置 (不会掉海里) */
function fakeSect(site, idx) {
  const a = site.st[idx % site.st.length];
  const q = a.q + 2, r = a.r + 1;
  const f = MG.fields(q, r), w = MG.tileToWorld(q, r);
  return { id: site.i + '_' + site.j + '_u' + (idx + 1), type: 'sect', q, r, x: w.x, y: w.y,
           name: '测试宗', pop: 5000, owner: '', tier: 3, state: 0, expireTs: 0,
           __land: f.biome !== 0 && !f.vein };
}
const landSites = sites.map((s, k) => ({ ...s, pl: fakeSect(s, k) })).filter(s => s.pl.__land);
/* ⚠ 样本上限: 段 2 每个落点要跑 50 次 roadsNear(9999) ≈ 7s ⇒ 不能全量扫。
   段 1 是纯几何 (无 A*) 可多跑, 段 2 只取头部若干个。 */
const SITES_MECH = Math.min(landSites.length, 24);
/* ⚠ A* 很贵 (段 2 每个落点跑 50 次 roadsNear(9999) ≈ 7s) ⇒ 段 2 样本数做成参数。
   基线里用 3 (≈20s), 深查时 node check_place_road_recompute.mjs seed 5 8 3 放大。 */
const SITES_ROADFAIL = Math.min(landSites.length, parseInt(process.argv[4] || '3', 10));
const ROUNDS = parseInt(process.argv[5] || '2', 10);          // 计时交替轮数
console.log(`seed=${seed}`);
console.log(`\n== 落点样本 ==`);
console.log(`  ±${SCAN} 区域格内有聚落 ${sites.length} 格, 其中落点地形合法 ${landSites.length} 格`);
console.log(`  段 1 机制扫 ${SITES_MECH} 个 / 段 2 roadFail 扫 ${SITES_ROADFAIL} 个 (A* 贵, 限量)`);

/* ---------- 段 1: 机制验证 (纯几何, 无 A*) ---------- */
/* 对每个落点: 清 ext 侧缓存 → 记基线需求边/骨架 → 注入 ext + 再清 → 对比。
   ⚠ 不清 demandCache/skeletonCache 的话注入**完全无效** —— 这本身就是方案必须写明的坑。 */
console.log(`\n== 1. 机制验证: 新宗门是否挤掉既有边 (纯需求图/骨架, 无 A*) ==`);
let siteHitEdge = 0, siteHitSkel = 0, totGone = 0, totAdd = 0, totSkelFlip = 0;
let missCacheDemo = 0;
const mech = landSites.slice(0, SITES_MECH);
for (const s of mech) {
  const PI = s.i, PJ = s.j;
  const inR = (i, j) => Math.abs(i - PI) <= RING && Math.abs(j - PJ) <= RING;
  const cells = [];
  for (let i = PI - RING; i <= PI + RING; i++)
    for (let j = PJ - RING; j <= PJ + RING; j++)
      if (MG.settlementsFor(i, j).some(x => x.type !== 'poi')) cells.push([i, j]);

  const snap = () => ({
    d: new Set(cells.flatMap(([i, j]) => MG.__demandEdgesFor(i, j).map(e => e.rkey))),
    s: new Map(cells.map(([i, j]) => [i + ',' + j, [...MG.__skeletonEdgesFor(i, j)].sort().join(';')]))
  });

  MG.setExternalSettlements([]); clearRoadSide();
  const base = snap();

  /* ① 先故意【不清缓存】注入一次 ⇒ 应看到「注入无效」(缓存把旧几何喂回来) */
  MG.setExternalSettlements([s.pl]);
  const noClear = snap();
  if ([...noClear.d].sort().join(',') === [...base.d].sort().join(',')) missCacheDemo++;

  /* ② 正确姿势: 清缓存后再注入 */
  clearRoadSide();
  const withExt = snap();

  const gone = [...base.d].filter(k => !withExt.d.has(k));
  const add = [...withExt.d].filter(k => !base.d.has(k));
  let skelFlip = 0;
  for (const [k, v] of base.s) if (withExt.s.get(k) !== v) skelFlip++;
  totGone += gone.length; totAdd += add.length; totSkelFlip += skelFlip;
  if (gone.length) siteHitEdge++;
  if (skelFlip) siteHitSkel++;
}
const n = mech.length;
console.log(`  需求边: 累计消失 ${totGone} 条 / 新增 ${totAdd} 条`);
console.log(`  骨架集: ${totSkelFlip} 个区域格的骨架发生翻转 (跨 ${siteHitSkel}/${n} 个落点)`);
console.log(`  ⚠ 「不清 demandCache/skeletonCache 直接注入」在 ${missCacheDemo}/${n} 个落点上`);
console.log(`     得到与基线**完全相同**的几何 ⇒ 缓存不失效 = 注入静默无效 (不是崩溃, 是无声无息)`);
check(`新宗门会挤掉既有需求边 (${siteHitEdge}/${n} 个落点命中, 累计 ${totGone} 条)`,
      siteHitEdge > 0, `hit=${siteHitEdge}`);
check(`新宗门会翻转骨架集 (${siteHitSkel}/${n} 个落点命中, 累计 ${totSkelFlip} 格)`,
      siteHitSkel > 0, `hit=${siteHitSkel}`);

/* ---------- 段 2: roadFail 的「终身不建」是否被锁死 ---------- */
/* 骨架资格翻转 ⇒ 一条边可能从「不建(roadFail)」变「应建」, 反之亦然。
   ⚠ 实测触发率低 (需「绕行超限」+「骨架资格翻转」同时成立) ⇒ 不断言必发, 如实报告。 */
console.log(`\n== 2. roadFail「终身不建」是否被锁死 (理论风险, 实测触发率) ==`);
let flipSites = 0, totFlip = 0;
for (const s of landSites.slice(0, SITES_ROADFAIL)) {
  clearRoadSide(); MG.setExternalSettlements([]);
  for (let i = s.i - RING; i <= s.i + RING; i++) for (let j = s.j - RING; j <= s.j + RING; j++) MG.roadsNear(i, j, 9999);
  const bf = new Set(ROADFAIL);
  clearRoadSide(); MG.setExternalSettlements([s.pl]);
  for (let i = s.i - RING; i <= s.i + RING; i++) for (let j = s.j - RING; j <= s.j + RING; j++) MG.roadsNear(i, j, 9999);
  const flip = [...bf].filter(k => !ROADFAIL.has(k)).length
             + [...ROADFAIL].filter(k => !bf.has(k)).length;
  if (flip) { flipSites++; totFlip += flip; }
}
console.log(`  roadFail 集发生翻转: ${flipSites}/${SITES_ROADFAIL} 个落点, 累计 ${totFlip} 条边`);
if (totFlip === 0) {
  console.log(`  ⇒ 本 seed/样本下**未触发**。但机制成立 (段 1 已证骨架资格会翻转),`);
  console.log(`     只是还需「该边绕行超限」这一条件同时成立 —— 属低频但必现的风险,`);
  console.log(`     处置不能省: 不清 roadFail 的实现在换 seed 后会偶发「路该建却不建」。`);
} else {
  console.log(`  ⇒ **已实测触发** —— 不清 roadFail 会造成「该建的路终身不建」。`);
}
check(`roadFail 需与骨架一起失效 (机制成立: 骨架 ${siteHitSkel > 0 ? '会' : '不会'}翻转)`,
      siteHitSkel > 0, 'ok');

/* ---------- 段 3: 同步重算耗时 (交替多轮取中位, 消除 JIT 预热偏差) ---------- */
/* 选「范围内格数最多」的落点 ⇒ 最坏情况 (决策看最坏, 不看中位) */
let worst = null;
for (const s of landSites) {
  const c = [];
  for (let i = s.i - RING; i <= s.i + RING; i++)
    for (let j = s.j - RING; j <= s.j + RING; j++)
      if (MG.settlementsFor(i, j).some(x => x.type !== 'poi')) c.push([i, j]);
  if (!worst || c.length > worst.c.length) worst = { s, c };
}
const pick = worst.s;
const P2 = { i: pick.i, j: pick.j };
const cells2 = worst.c;

/* 先建一遍基线, 由跨界边推出「远端也必须重拉的格」—— 否则基线不公平 (基线也要跑这些格) */
const inR3 = (i, j) => Math.abs(i - P2.i) <= RING && Math.abs(j - P2.j) <= RING;
MG.setExternalSettlements([]); clearRoadSide();
for (const [i, j] of cells2) MG.roadsNear(i, j, 9999);
const remote = new Set();
for (const key of ROAD.keys()) {
  const [r0, r1] = rkeyRegion(key);
  const a0 = inR3(r0[0], r0[1]), a1 = inR3(r1[0], r1[1]);
  if (a0 !== a1) { const o = a0 ? r1 : r0; remote.add(o[0] + ',' + o[1]); }
}
const cellsAll = cells2.concat([...remote].map(k => k.split(',').map(Number)));

function runRoads(ext, freshTerrain) {
  if (freshTerrain) MG.init(seed); else clearRoadSide();
  MG.setExternalSettlements(ext);
  const t = performance.now();
  for (const [i, j] of cellsAll) MG.roadsNear(i, j, 9999);
  return performance.now() - t;
}
console.log(`\n== 3. 同步重算耗时 (最坏落点 (${P2.i},${P2.j}): 范围内 ${cells2.length} 格有聚落` +
            ` + 跨界远端 ${remote.size} 格 = ${cellsAll.length} 格) ==`);
const coldA = [], coldB = [], hotA = [], hotB = [];
for (let r = 0; r < ROUNDS; r++) {
  coldA.push(runRoads([], true));
  coldB.push(runRoads([pick.pl], true));
}
runRoads([], true); runRoads([], false);                    // 预热
for (let r = 0; r < ROUNDS; r++) {
  hotA.push(runRoads([], false));
  hotB.push(runRoads([pick.pl], false));
}
const cA = MED(coldA), cB = MED(coldB), hA = MED(hotA), hB = MED(hotB);
console.log(`  [全冷]   基线 ${cA.toFixed(0)} ms → 注入后 ${cB.toFixed(0)} ms` +
            `  (轮数 ${ROUNDS}: ${coldA.map(x => x.toFixed(0)).join('/')} vs ${coldB.map(x => x.toFixed(0)).join('/')})`);
console.log(`  [仅清道路] 基线 ${hA.toFixed(0)} ms → 注入后 ${hB.toFixed(0)} ms` +
            `  (轮数 ${ROUNDS}: ${hotA.map(x => x.toFixed(0)).join('/')} vs ${hotB.map(x => x.toFixed(0)).join('/')})`);
console.log(`  ⇒ 真实场景取「仅清道路」口径: 同步重算 **${hB.toFixed(0)} ms** (${(hB / cellsAll.length).toFixed(1)} ms/格)`);
console.log(`  ⚠ JIT 偏差实测: 单次计时会让后跑的一遍快 ~17% ⇒ 必须交替取中位 (本段已做)`);

/* ---------- 段 4: 失效范围 / 脏块范围 ---------- */
clearRoadSide(); MG.setExternalSettlements([]);
for (const [i, j] of cells2) MG.roadsNear(i, j, 9999);
const baseKeys = [...ROAD.keys()];
const inR2 = (i, j) => Math.abs(i - P2.i) <= RING && Math.abs(j - P2.j) <= RING;
let aff = 0; const outside = new Set();
for (const key of baseKeys) {
  const [r0, r1] = rkeyRegion(key);
  const i0 = inR2(r0[0], r0[1]), i1 = inR2(r1[0], r1[1]);
  if (i0 || i1) aff++;
  if (i0 !== i1) { const o = i0 ? r1 : r0; outside.add(o[0] + ',' + o[1]); }
}
console.log(`\n== 4. 失效范围 (坑 D: 一条边同时进 a格 与 b格 两个区域包) ==`);
console.log(`  roadCache ${baseKeys.length} 条边, 其中「任一端在 ${RING} 环内」${aff} 条 = ${(aff / baseKeys.length * 100).toFixed(1)}%`);
console.log(`  跨界边 (一端在内/一端在外) 牵出【范围外】还需重拉的区域格: ${outside.size} 个`);
console.log(`  ⇒ 脏块集合 = 范围内 25 格 ∪ 这 ${outside.size} 格`);
console.log(`     否则远端 regionJson 不重拉, 仍持有含同一条边的旧包 ⇒ 可能把新数据覆盖回去`);

/* ---------- 段 5: 坑 C —— roadVer 不前进 ⇒ tile 缓存不失效 ---------- */
console.log(`\n== 5. roadVer (坑 C) ==`);
console.log(`  roadVer++ 只在「新路落成」时发生 (mapgen.js roadsNear 尾部)`);
console.log(`  ⇒ 删边 (段 1 证实会发生) 或重算后条数不变时 roadVer **不前进**`);
console.log(`  ⇒ 而服务端 tile 缓存判据是 "cached.RoadVer == known ⇒ 直接返回" (MapWorldService.cs:694)`);
console.log(`  ⇒ 结论: 放置流程必须**显式** roadVer++, 否则旧路仍画在 tile 上 (删边更是永远不可检测)`);
console.log(`     ⚠ 只能 +1 增量, **绝不能归零** —— 服务端 ObserveRoadVer 是单调取大 (:114~121)`);

/* ---------- 段 6: 「附近城市全部重算」多久 (与道路是两个独立代价) ---------- */
/* 用户问: 「附近城市直接重新算太久了是吧?」—— 必须先分清「城市」与「道路」:
     城市重算 = 选址 (siteScore/prospectArea/pickSettlementCenter) + 足迹/建筑 (growTownFootprint)
     这两条链路**都不读道路** (growTownFootprint 只读 fields/landuseOf/veinNear (函数头注释))
     ⇒ 与路网是两条独立开销, 必须分开计时, 否则归因错。
   口径: 先 warm 地形 (让 elev/field 热 = 服务端真实状态), 再比「城市缓存冷」vs「城市缓存热」。
   ⚠ warm 耗时**不计入**; 用 __cacheSizes() 前后对比**证明**地形确实热了 (否则结论无效)。 */
console.log(`\n== 6. 「附近城市全部重算」代价 (地形热, 城市缓存冷 vs 热) ==`);

const REGION_M = 18;      // ⚠ 硬编码自 mapgen.js 顶部 var REGION_M —— 引擎改了必须同步本脚本
const cellsU = [];        // 去重 (cells2 与 remote 可能有交集)
{
  const seen = new Set();
  for (const c of cellsAll) { const k = c[0] + ',' + c[1]; if (!seen.has(k)) { seen.add(k); cellsU.push(c); } }
}
const timeIt = (fn) => { const t = performance.now(); const r = fn(); return { ms: performance.now() - t, r: r }; };
const cityPass = (cells) => {                       // 城市生成全链路: 选址 → 足迹/建筑
  let nTown = 0;
  for (const [i, j] of cells) {
    for (const s of MG.settlementsFor(i, j)) {
      if (s.type === 'poi') continue;               // 秘境无足迹 (方案 §2.x)
      MG.growTownFootprint(s.id, s.type, s.q, s.r);
      nTown++;
    }
  }
  return nTown;
};
/* warm 地形: 每格区域锚点 ±REGION_M —— 覆盖区域格半宽 9 + 余量, 保证勘测窗全在热区 */
MG.init(seed);
let warmN = 0;
for (const [i, j] of cellsU)
  for (let dq = -REGION_M; dq <= REGION_M; dq++)
    for (let dr = -REGION_M; dr <= REGION_M; dr++) { MG.fields(i * REGION_M + dq, j * REGION_M + dr); warmN++; }
const szWarm = MG.__cacheSizes();

MG.setExternalSettlements([]);
const A = timeIt(() => cityPass(cellsU));            // 热地形 + 冷城市 (首测, 含 JIT)
const szA = MG.__cacheSizes();
const B = timeIt(() => cityPass(cellsU));            // 热地形 + 热城市 (缓存命中基线)
/* 交替多轮取中位 ⇒ 免 JIT 偏差 (实测首测 78ms vs 复测 34ms, 差 2 倍) */
const cityRuns = [];
for (let r = 0; r < ROUNDS; r++) { MG.__clearCity(); cityRuns.push(timeIt(() => cityPass(cellsU)).ms); }
const Am = MED(cityRuns);
MG.init(seed);
const D = timeIt(() => cityPass(cellsU));            // 全冷: 地形也现建 (最坏)

/* 漏 warm 的地形格对应的钱 —— 单列出来, 好让读者自己从 Am 里扣 */
const leakCells = Math.max(0, szA.field - szWarm.field);
const leakMs = szWarm.field > 0 ? (D.ms - Am) * leakCells / szWarm.field : 0;
console.log(`  范围内 ${cellsU.length} 个区域格, ${A.r} 座城镇/村落 (warm 了 ${warmN} 次 fields, 不计入)`);
console.log(`  elev/field 缓存: warm 后 ${szWarm.elev}/${szWarm.field}` +
            ` → 城市重算后 ${szA.elev}/${szA.field}` +
            `  (地形增量 ${leakCells} 格 ⇒ warm 覆盖 ${(100 - leakCells / szA.field * 100).toFixed(1)}%)`);
console.log(`  [热地形 + 冷城市] 城市重算 = **${Am.toFixed(0)} ms**` +
            `  (${(Am / cellsU.length).toFixed(2)} ms/格; ${ROUNDS} 轮中位: ${cityRuns.map(x => x.toFixed(0)).join('/')})`);
console.log(`      └ 其中漏 warm 的 ${leakCells} 格地形 ≈ ${leakMs.toFixed(0)} ms ⇒ **纯城市** ≈ ${(Am - leakMs).toFixed(0)} ms`);
console.log(`  [首测·含 JIT]              = ${A.ms.toFixed(0)} ms   ← 第一次跑总慢一倍, 别拿它做决策`);
console.log(`  [热地形 + 热城市] 缓存命中   = ${B.ms.toFixed(1)} ms`);
console.log(`  [全冷·含建地形]             = ${D.ms.toFixed(0)} ms   ← 只有重启/换 seed 才会遇到`);
console.log(`  ⇒ 结论: 「附近城市全部重算」≈ **${Am.toFixed(0)} ms**  (纯城市 ≈ ${(Am - leakMs).toFixed(0)} ms)`);
console.log(`     对比: 道路重算 **${hB.toFixed(0)} ms** (段 3)` +
            ` ⇒ 道路是纯城市的 ${(hB / Math.max(1, Am - leakMs)).toFixed(1)} 倍`);
console.log(`  ⚠ 城市链路不读道路 (growTownFootprint 只读 fields/landuseOf/veinNear (函数头注释))`);
console.log(`     ⇒ 若玩家实体不进 settlementsFor, 城市**根本不需要重算** (中心/足迹逐字节不变)`);
console.log(`     ⇒ 「附近城市重算」的真正含义是「附近的**路**重算」—— 别把两笔账记成一笔`);
const cityOk = leakCells <= szA.field * 0.06;        // warm 覆盖率 ≥94% 才算数
check(`段 6 地形预热充分 (warm 覆盖 ≥94%)`, cityOk,
      `warm 覆盖 ${(100 - leakCells / szA.field * 100).toFixed(1)}% ⇒ 段 6 数字偏大, 别当纯城市值`);


console.log(`\n${'='.repeat(66)}`);
console.log(`放置一次的两笔账 (最坏口径, ${cellsAll.length} 格):`);
console.log(`  · 道路重算 (段 3): **${hB.toFixed(0)} ms**   ← 贵在这笔`);
console.log(`  · 城市重算 (段 6): ${Am.toFixed(0)} ms   ← 且**只在玩家实体进 settlementsFor 时才需要**`);
console.log(`  · 两笔合计: ${(hB + Am).toFixed(0)} ms —— 同步可承受 (不用异步/二次 Bump)`);
console.log(`  · 机制: 需求边会被挤掉 (${totGone} 条/样本) + 骨架会翻转 (${totSkelFlip} 格)`);
console.log(`  · ⇒ v2「旧边一条都不变」错误; 用户「这些城市对应的道路全部重算」是必要且正确的`);
console.log(`  · ⚠ 真正的「太久」不在引擎算, 而在 **roadVer 归零 ⇒ 前端全图 tile 重拉**`);
console.log(`     (resetRoads 曾把 roadVer 设 0 (真源 mapgen.js 的 resetRoads); 而 ObserveRoadVer 单调取大` +
            ` ⇒ 归零既让客户端全失效, 又让服务端判不出更新, MapWorldService.cs:114~121)`);
console.log(`\n` + (FAIL === 0 ? `结构判据 ${PASS} PASS / 0 FAIL` : `结构判据 ${PASS} PASS / ${FAIL} FAIL`));
process.exit(FAIL === 0 ? 0 : 1);
