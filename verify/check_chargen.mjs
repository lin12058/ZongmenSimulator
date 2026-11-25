/* ============================================================
 * check_chargen.mjs — 弟子招募生成器 (Engine/js/chargen.js) 数值/边界契约
 * ------------------------------------------------------------
 * 覆盖审查批次: C1 (慧根文案↔效果) / C8 (usedNames 不得原地写) /
 *              C9 (池量随人口) + D1~D12 (口径注释、夹断、主系抽签、
 *              副手产出、副手队列下限、checkCandidate 灵根和闸、seedKey 同源…)
 *
 * ⚠ 与两个同名物的分工 (别混):
 *   - Engine/js/chargen.js      = **可招募弟子** (本脚本被测对象, 出口 Chargen)
 *   - chargen-core.js           = 世界人口 NPC       (出口 CultivatorGen)
 *   - crew-model.demoSquad      = 前端演示数据
 *
 * 用法: node verify/check_chargen.mjs    (任意 cwd; rc=0 通过, rc=1 失败)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'chargen.js'), 'utf8'));
const G = global.Chargen;

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

/* D3 */
ok('D3 VERSION 已 +1', G.VERSION === 2, 'v=' + G.VERSION);

/* C1 */
const hg = G.TRAITS.find(t => t.k === 'insight');
ok('C1 慧根 修炼速度 +6%', hg.v === '修炼速度 +6%', hg.v);

/* D5 + 全局自检 */
const st = G.selfTest(2000);
ok('D5 selfTest(2000) 全绿 (gear:false 不再被误判)', st.ok, st.ok ? 'n=' + st.n : st.errors.slice(0, 3).join(' | '));

/* checkCandidate 直接吃 gear:false */
const g0 = G.genCandidate({ worldSeed: 'x', slot: 0, gear: false });
ok('D5 checkCandidate 接受 gear:false (queue=[])', G.checkCandidate(g0).length === 0, JSON.stringify(G.checkCandidate(g0)));

/* D5 反空真: 有法宝槽但队列空必须报错 */
const gBad = JSON.parse(JSON.stringify(G.genCandidate({ worldSeed: 'x', slot: 3 })));
gBad.pawn.queue = [];
const badList = G.checkCandidate(gBad);
ok('D5 反空真: 有法宝槽却队列空仍判错', badList.some(x => x.includes('队列')), badList.join(' | '));

/* 分布 */
const s40 = G.stats(40000);
ok('分布 stats(40000) bad=0', s40.bad === 0, 'bad=' + s40.bad);
ok('天赋均值 ≈120 (平方偏斜) 且区间 90~180', s40.talentAvg >= 118 && s40.talentAvg <= 122 && s40.talentMin >= 90 && s40.talentMax <= 180,
  'avg=' + s40.talentAvg + ' min=' + s40.talentMin + ' max=' + s40.talentMax);

/* C8 确定性: 同一个 usedNames 对象调两次 */
const used = {};
const p1 = JSON.stringify(G.genPool({ worldSeed: 'w1', settle: { id: 'v1', type: 'town' }, round: 1, usedNames: used }));
const p2 = JSON.stringify(G.genPool({ worldSeed: 'w1', settle: { id: 'v1', type: 'town' }, round: 1, usedNames: used }));
ok('C8 同 usedNames 调两次逐字节相同', p1 === p2, p1 === p2 ? '' : '长度 ' + p1.length + ' vs ' + p2.length);
ok('C8 不污染调用方的 usedNames', Object.keys(used).length === 0, 'keys=' + Object.keys(used).length);

/* C9 pop 放大: 仙城 pop=200 不能掉到村落量级 */
let minCity = 99, maxCity = 0;
for (let i = 0; i < 60; i++) {
  const pl = G.genPool({ worldSeed: 'w2', settle: { id: 'c' + i, type: 'city', pop: 200 }, round: 0 });
  minCity = Math.min(minCity, pl.candidates.length);
  maxCity = Math.max(maxCity, pl.candidates.length);
}
ok('C9 pop=200 仙城池量 >= 6 (区间下限)', minCity >= 6, 'min=' + minCity + ' max=' + maxCity);
ok('C9 池量不超 POOL_MAX', maxCity <= G.CFG.POOL_MAX, 'max=' + maxCity);

/* D6 主系优先 */
let hit = 0, total = 0;
for (let e = 0; e < 5; e++) {
  for (let i = 0; i < 40; i++) {
    const c = G.genCandidate({ worldSeed: 'w3', slot: i, element: e });
    total++; if (c.pawn.root.main === e) hit++;
  }
}
ok('D6 指定灵脉五行 ⇒ 100% 当主系', hit === total, hit + '/' + total);

/* D7 offhand 产出 */
const c7 = G.genCandidate({ worldSeed: 'w4', slot: 1 });
ok('D7 起步件产出副手 (equip.offhand 非空)', !!c7.pawn.equip.offhand, String(c7.pawn.equip.offhand));
ok('D7 副手 id 在 items 里且 kind 对', c7.items.some(it => it.id === c7.pawn.equip.offhand && it.kind === 'offhand'),
  c7.items.map(i => i.kind).join(','));

/* D11 只改出生地不换人 */
const a = G.genCandidate({ worldSeed: 'w5', slot: 7 });
const b = G.genCandidate({ worldSeed: 'w5', slot: 7, background: a.meta.backgroundKey });
const sameCore = JSON.stringify(a.pawn.root) === JSON.stringify(b.pawn.root) &&
  JSON.stringify(a.pawn.talents) === JSON.stringify(b.pawn.talents) &&
  JSON.stringify(a.pawn.traits) === JSON.stringify(b.pawn.traits) &&
  a.pawn.name === b.pawn.name;
ok('D11 指定相同出身 ⇒ 灵根/天赋/特质/姓名完全不变', sameCore, 'a=' + a.meta.background + ' b=' + b.meta.background);

/* D4 外部 rng 返回 1 不越界 */
let threw = null;
try {
  G.genRoot(() => 1, { element: 2 });
  G.genTalents(() => 1, null);
  G.genTraits(() => 1);
} catch (e) { threw = e.message; }
ok('D4 rng()===1 不抛异常', threw === null, String(threw));
const r1 = G.genRoot(() => 1, {});
ok('D4 rng()===1 的灵根仍合法', r1.v.filter(x => x === 20).length === r1.count && r1.main >= 0 && r1.main <= 4,
  JSON.stringify(r1.v) + ' main=' + r1.main);

/* D9 反空真: 手改出 10 的灵根必须报错 */
const c9 = JSON.parse(JSON.stringify(G.genCandidate({ worldSeed: 'w6', slot: 2 })));
c9.pawn.root.v = [10, 30, 0, 0, 0];
const bad9 = G.checkCandidate(c9);
ok('D9 非零项 < 20 被抓出来', bad9.some(x => x.includes('非零项最小')) || bad9.some(x => x.includes('不是 0/20')),
  bad9.slice(0, 2).join(' | '));

/* D12 seedKey 与实际散列同源 */
const pl = G.genPool({ worldSeed: 'w7', settle: { id: 'v9', type: 'village' }, round: 3 });
const pl2 = G.genPool({ worldSeed: 'w7', settle: { id: 'v9', type: 'village' }, round: 3 });
ok('D12 同参数池 seedKey 与候选人一致', pl.seedKey === pl2.seedKey && JSON.stringify(pl.candidates) === JSON.stringify(pl2.candidates), pl.seedKey);

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
