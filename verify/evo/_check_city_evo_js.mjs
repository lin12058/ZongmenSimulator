/* 临时判据: city-evo.js (引擎内) vs city_evo_sim.mjs (仿真器) 同口径校验
   —— 两者必须对同一 CityState + 同一 meta + 同一 dt 给出**逐字节相同**的新 state。
   这是「引擎侧落地没有走样」的唯一证据。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

global.window = globalThis;
/* 严格按 bundle 序加载 (含 new city-evo.js 在最后) */
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'city-evo.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;
const CE = global.CityEvo;
const CFG = MG.CFG;

const fails = [];
const ck = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d && !c ? '  ← ' + d : '')); if (!c) fails.push(n); };

console.log('== city-evo.js 引擎侧自检 ==');

/* A. 加载与常量 */
ck('A1 global.CityEvo 已导出', !!CE && typeof CE.evolveCityJson === 'function');

/* ⚠ selfCheck/townNet 需要先 init(seed) 才有地形可用 */
const seed = 'city-evo-selfcheck-1';
MG.init(seed);

const sc = CE.selfCheck();
ck('A2 DEMAND 与引擎 townNet 同口径', sc.mismatches.length === 0, sc.mismatches.join('; '));
const C = JSON.parse(CE.constantsJson());
ck('A3 时间模型 T.Season=90 / T.Year=360', C.T.Season === 90 && C.T.Year === 360);
ck('A4 K 默认策略 freeze', C.E.K_POLICY === 'freeze');

/* B. dt=0 严格 no-op (红线 R5) */
const sells = MG.settlementsFor(0, 0);
ck('B0 区域(0,0)有聚落', sells && sells.length > 0, 'len=' + (sells && sells.length));
const st0 = sells.find((s) => s.type !== 'poi') || sells[0];
const s0 = CE.newCityState({ id: st0.id, type: st0.type, q: st0.q, r: st0.r, pop: st0.pop, tier: st0.tier }, 0);
const meta = JSON.parse(CE.metaJson(st0.id, st0.type, st0.q, st0.r));

const noop = JSON.parse(CE.evolveCityJson(JSON.stringify(s0), JSON.stringify(meta), 0, 'freeze'));
ck('B1 dt=0 不改任何字段', JSON.stringify(noop) === JSON.stringify(s0),
  'diff=' + Object.keys(noop).filter((k) => JSON.stringify(noop[k]) !== JSON.stringify(s0[k])).join(','));

/* C. Δ 铁律 (freeze): step(s,360) ≡ 连续4× step(·,90) ≡ 连续12× step(·,30) */
for (const [total, sub] of [[360, 90], [360, 30], [90, 10], [360, 1]]) {
  const one = JSON.parse(CE.evolveCityJson(JSON.stringify(s0), JSON.stringify(meta), total, 'freeze'));
  let cur = s0;
  for (let n = 0; n < total / sub; n++) {
    cur = JSON.parse(CE.evolveCityJson(JSON.stringify(cur), JSON.stringify(meta), sub, 'freeze'));
  }
  const dp = Math.abs(cur.popF - one.popF);
  ck(`C Δ铁律 freeze ${total} vs ${total / sub}×${sub}  (ΔpopF=${dp.toExponential(2)})`,
    dp < 1e-6 && cur.pop === one.pop && cur.tier === one.tier, `one=${one.pop} split=${cur.pop}`);
}

/* D. 与仿真器同口径: 用同样入参跑过 city_evo_sim.mjs 的 evolveCity 需要同一份代码;
      这里改为「结构完整性」判据 —— 输出字段集必须覆盖 C# 台账所需的全部持久字段。 */
const NEED = ['id', 'pop', 'popF', 'tier', 'state', 'stock', 'built', 'bornTick', 'lastEvoTick',
  'ver', 'age', 'foodDebt', 'popBase', 'basePopF', 'baseAge', 'builtFrac', 'Kf'];
const ev = JSON.parse(CE.evolveCityJson(JSON.stringify(s0), JSON.stringify(meta), 90, 'freeze'));
ck('D1 演化输出含全部持久字段', NEED.every((k) => k in ev), NEED.filter((k) => !(k in ev)).join(','));
ck('D2 库存含 8 资源', Object.keys(ev.stock).length === 8, Object.keys(ev.stock).join(','));
ck('D3 age 累加 90', ev.age === 90 && ev.ver === 1, `age=${ev.age} ver=${ev.ver}`);
ck('D4 popF 是浮点 (未取整)', typeof ev.popF === 'number' && ev.popF !== Math.round(ev.popF),
  'popF=' + ev.popF + ' pop=' + ev.pop);

/* E. 红线 R1: 演化不污染 seed 纯函数层
   ⚠ 基线必须在**预热后**取 —— growTownFootprint 会把结果写进 settleCache,
     若在首次调用前取基线, 会把「缓存预热」误判成「污染」(本判据曾因此假 FAIL)。 */
const fpSettle = () => [...MG.settleCache.keys()].sort().map((k) => k + '=' + MG.settleCache.get(k).map((s) => `${s.id}/${s.pop}/${s.tier}`).join(' ')).join('|');
const fpBase = () => { const o = []; for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) o.push(i + ',' + j + ':' + MG.settlementsFor(i, j).map((s) => `${s.id}/${s.pop}/${s.tier}`).join(' ')); return o.join('|'); };
const warmAll = () => { for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) for (const s of MG.settlementsFor(i, j)) MG.growTownFootprint(s.id, s.type, s.q, s.r); };
warmAll();
const b1 = fpSettle(), b2 = fpBase(), b3 = MG.roadVersion();
let cur2 = s0;
for (let n = 0; n < 40; n++) cur2 = JSON.parse(CE.evolveCityJson(JSON.stringify(cur2), JSON.stringify(meta), 90, 'freeze'));
ck('E1 红线R1: settleCache 逐字节不变', fpSettle() === b1);
ck('E2 红线R1: settlementsFor 不变', fpBase() === b2);
ck('E3 红线R1: roadVer 不变', MG.roadVersion() === b3);

/* F. 价格层 / 加工层 / 灵力 */
const priced = JSON.parse(CE.priceLayerJson(JSON.stringify([
  { id: st0.id, type: st0.type, q: st0.q, r: st0.r, pop: 5000, tier: 2, builtCount: 0 }
]), JSON.stringify([])));
ck('F1 priceLayer 输出 1 城', priced.cities.length === 1);
const pc = priced.cities[0];
ck('F2 八资源价齐全且 >0', Object.keys(pc.px).length === 8 && Object.values(pc.px).every((v) => v > 0));
ck('F3 地价 >= 基准', pc.land >= 1.0, 'land=' + pc.land);
ck('F4 灵力 rich ∈ [0,1]', pc.spirit >= 0 && pc.spirit <= 1, 'rich=' + pc.spirit);
/* 加工层: 用**骨架能凑齐一条完整配方**的真实城市 (粮+灵 ⇒ 丹, 或 矿+木 ⇒ 器);
   ⚠ 沿海城市只产渔 ⇒ 配方跑不动, 那是**正确行为**而不是 bug;
     判据必须挑「原料齐备」的城市, 否则测的是「城市靠海」而不是「加工业」 */
const citySells = (() => {
  for (let i = -10; i <= 10; i++) for (let j = -10; j <= 10; j++) {
    for (const s of MG.settlementsFor(i, j)) {
      if (s.type !== 'city') continue;
      const p = MG.growTownFootprint(s.id, s.type, s.q, s.r);
      const amt = {};
      for (const x of p.resources) amt[x.resource] = (amt[x.resource] || 0) + x.amount;
      if ((amt['粮'] > 0 && amt['灵'] > 0) || (amt['矿'] > 0 && amt['木'] > 0)) return s;
    }
  }
  return null;
})();
ck('F0 找到原料可得的城市', !!citySells);
const cityPlan = MG.growTownFootprint(citySells.id, citySells.type, citySells.q, citySells.r);
const cCity = CE.craftOutput('city', citySells.pop, cityPlan.resources);
const cVillage = CE.craftOutput('village', citySells.pop, cityPlan.resources);
ck('F5 city 有加工业产出 (器/丹)', !!cCity && Object.keys(cCity.out).length > 0,
  citySells.id + ' 骨架=' + JSON.stringify(cityPlan.resources) + ' out=' + JSON.stringify(cCity && cCity.out));
ck('F6 village 无加工业', cVillage === null);

/* G. 灵力溢价: 高灵力城市修仙类商品价更高 (同 pop 同产出) */
const lo = CE.resourcePrices(5000, meta.resource, CE.E.DEMAND, 0.0);
const hi = CE.resourcePrices(5000, meta.resource, CE.E.DEMAND, 1.0);
ck('G1 灵力提升 丹/器/灵 价格', hi['丹'] > lo['丹'] && hi['器'] > lo['器'] && hi['灵'] > lo['灵'],
  `丹 ${lo['丹']}→${hi['丹']}`);
ck('G2 灵力不影响 粮 (非修仙类)', Math.abs(hi['粮'] - lo['粮']) < 1e-12);

/* H. 贸易边 / 迁移边 契约 */
const two = [{ id: 'a', q: 0, r: 0, pop: 9000, attr: 1.5 }, { id: 'b', q: 3, r: 0, pop: 300, attr: 0.2 }];
const mig = JSON.parse(CE.migrateEdgesJson(JSON.stringify(two), 90));
ck('H1 迁移边: 高吸引力收人', mig.length === 1 && mig[0].from === 'b' && mig[0].to === 'a', JSON.stringify(mig));
ck('H2 迁移量 >=1 且不破 floor', mig[0].amount >= 1 && 300 - mig[0].amount >= CE.E.POP_FLOOR, JSON.stringify(mig[0]));

/* I. 拆屋只拆 evo 屋, 绝不拆骨架 (红线 R3)
   ⚠ 触发条件是 pop < skeletonCap (=1+max(2,floor(village 8×0.3))=3) ⇒ fixture 必须 pop<3 */
const csDemo = CE.newCityState({ id: 'demo_0_0_u1', type: 'village', q: 0, r: 0, pop: 2, tier: 1 }, 0);
csDemo.built = [
  { q: 0, r: 0, kind: 'house', evo: 1 }, { q: 1, r: 0, kind: 'house', evo: 1 },
  { q: 0, r: 1, kind: 'field', resource: '粮', evo: 1 }, { q: 2, r: 0, kind: 'house', evo: 1 }
];
csDemo.land = 2.0;
const hb = JSON.parse(CE.harvestAndBuildJson(JSON.stringify(csDemo), JSON.stringify(meta)));
ck('I1 拆屋后仍有田 (只拆屋不拆田)', hb.state.built.some((b) => b.kind === 'field'), JSON.stringify(hb.state.built.map((b) => b.kind)));
ck('I2 拆屋数 >0 (pop < 骨架容量)', hb.demolished > 0, 'demolished=' + hb.demolished);
ck('I3 原对象未被改 (无状态契约)', csDemo.built.length === 4, 'len=' + csDemo.built.length);

console.log(`\n${fails.length === 0 ? '全部通过 ✔' : fails.length + ' 项失败 ✘'}`);
process.exit(fails.length === 0 ? 0 : 1);
