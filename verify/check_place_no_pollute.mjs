/* ============================================================
 * check_place_no_pollute.mjs — ext 叠加层「不污染自动世界」契约 (离线 Node)
 * ------------------------------------------------------------
 * 方案 §2.4 的切法: 把「纯的部分」与「可变的部分」在**缓存边界**上切开 ——
 *   settlementsFor$base = 自动生成层 (纯函数 + settleCache)
 *   extIn(i,j)          = 玩家放置层 (可增删, 不缓存)
 *   settlementsFor      = 两层拼接 = 唯一对外入口
 * ⇒ 硬性要求: 未放置玩家宗门的世界与改造前**逐字节相同**; 放置不改变自动层,
 *   也不改变自动层之间的间距抑制 (两套规则各管各的)。
 *
 * ⚠ 这一区全是「静默错」的重灾区: 污染不报错, 只表现为"地图上少了一个村子"
 *   或"重启后聚落漂移" —— 所以必须用指纹断言, 不能靠眼看。
 *
 * 断言:
 *   A. id 契约: {区域i}_{区域j}_u{n} / 前两段可被引擎 split 反解为整数 / u 不复用 /
 *      坏 id 兜底现算 (绝不产生 NaN 前缀 —— 那会让需求边池静默扫空)
 *   B. 零拷贝 + 自动层指纹不变 + settleCache 不受影响 + ext 归属格 = id 前两段
 *   C. 增删对称: 加一座再删掉, 全域指纹回到基线
 *   D. 两套间距规则并存: ext 落在自动聚落 3 格处 (远小于 SETTLE_MIN_DIST=7)
 *      ⇒ 自动那座**不得**被挤掉
 *
 * 用法: node verify/check_place_no_pollute.mjs [seed]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;
const CFG = MG.CFG;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

const SEED = process.argv[2] || 'seed-check';
const SPAN = 6;
MG.init(SEED);
console.log(`seed=${SEED}`);

/* ---------- 全域指纹 (自动层 / 对外层 各一份) ---------- */
function fpRaw() {
  const out = [];
  for (let i = -SPAN; i <= SPAN; i++)
    for (let j = -SPAN; j <= SPAN; j++)
      out.push(i + ',' + j + ':' + MG.rawSettlementsFor(i, j).map((s) => s.id).join(' '));
  return out.join('|');
}
function fpAll() {
  const out = [];
  for (let i = -SPAN; i <= SPAN; i++)
    for (let j = -SPAN; j <= SPAN; j++)
      out.push(i + ',' + j + ':' + MG.settlementsFor(i, j).map((s) => s.id).join(' '));
  return out.join('|');
}
function fpCache() {
  const keys = [...MG.settleCache.keys()].sort();
  return keys.map((k) => k + '=' + MG.settleCache.get(k).map((s) => s.id).join(' ')).join('|');
}

/* ============================================================
 * A. id 契约
 * ============================================================ */
console.log('\n== A. id 契约 {区域i}_{区域j}_u{n} ==');
/* 找一个真实聚落当锚点 (落点自然、离它远一点避免 domainCheck 干扰无所谓 —— 这里不判领地) */
let anchor = null;
for (let i = -SPAN; i <= SPAN && !anchor; i++) {
  for (let j = -SPAN; j <= SPAN && !anchor; j++) {
    const l = MG.settlementsFor(i, j).filter((s) => s.type !== 'poi');
    if (l.length) anchor = l[0];
  }
}
const spot = { q: anchor.q + 20, r: anchor.r + 7 };      // 远离锚点, 避免与既有聚落纠缠

MG.setExternalSettlements([]);
const p1 = MG.placeSettlement(spot.q, spot.r, { type: 'sect', tier: 3, name: '甲宗' });
const p2 = MG.placeSettlement(spot.q, spot.r, { type: 'sect', tier: 1, name: '乙宗' });
const p3 = MG.placeSettlement(spot.q, spot.r, { type: 'sect', tier: 2, name: '丙宗' });
const rs = MG.regionSeedOf(spot.q, spot.r);
check('A1 placeSettlement 的 id 形态 {i}_{j}_u{n}', /^-?\d+_-?\d+_u\d+$/.test(p1.id), p1.id);
check('A2 id 前两段 == regionSeedOf(落点) 的区域格', (() => {
  const sp = p1.id.split('_');
  return (+sp[0]) === rs.i && (+sp[1]) === rs.j;
})(), `${p1.id} vs ${rs.i},${rs.j}`);
check('A3 同格连放三座: u 序号不复用 (u0/u1/u2)',
  /_u0$/.test(p1.id) && /_u1$/.test(p2.id) && /_u2$/.test(p3.id),
  [p1.id, p2.id, p3.id].join(' '));
/* 坏 id 兜底: 引擎会 id.split('_') 反解前两段; `p_3_1` ⇒ NaN ⇒ 需求边池静默扫空。
   setExternalSettlements 必须**现算**一个合法 id, 绝不把 NaN 前缀放进去。 */
MG.setExternalSettlements([{ id: 'p_3_1', type: 'sect', q: spot.q + 5, r: spot.r, name: '坏名' }]);
{
  const list = MG.externalSettlements();
  const sp = String(list[0] && list[0].id).split('_');
  check('A4 坏 id (p_3_1) 被现算成合法 id (前两段是整数, 绝不放 NaN 进去)',
    list.length === 1 && isFinite(+sp[0]) && isFinite(+sp[1]),
    JSON.stringify(list.map((s) => s.id)));
}
check('A5 引擎**生成**的 id 前两段一律可反解为整数 (全局不变量: rngDominated 靠它)',
  (() => {
    let bad = 0, n = 0;
    MG.setExternalSettlements([]);
    for (let i = -SPAN; i <= SPAN; i++)
      for (let j = -SPAN; j <= SPAN; j++)
        for (const s of MG.settlementsFor(i, j)) {
          n++;
          const sp = s.id.split('_');
          if (!isFinite(+sp[0]) || !isFinite(+sp[1])) bad++;
        }
    console.log(`  抽样 ${n} 座, 前两段非法 ${bad}`);
    return bad === 0;
  })());

/* ============================================================
 * B. 零拷贝 / 自动层与缓存不受影响 / 归属格由 id 决定
 * ============================================================ */
console.log('\n== B. 自动世界不污染 ==');
MG.setExternalSettlements([]);
const raw0 = fpRaw();
/* 预热 settleCache 再取指纹: 否则第二次调用只是"填缓存", 指纹天然会变 */
const all0 = fpAll();
const cache0 = fpCache();
/* B1 零拷贝: ext 为空时 settlementsFor 直接返回缓存里那个数组 (同一引用) */
check('B1 ext 为空时 settlementsFor 返回同一数组引用 (零拷贝, 未放置世界逐字节不变)',
  (() => { const a = MG.settlementsFor(0, 0), b = MG.settlementsFor(0, 0); return a === b; })());

/* 往**远处**放一座 —— 邻域内的自动层本来就看不到它 */
MG.placeSettlement(anchor.q - 60, anchor.r - 60, { type: 'sect', tier: 3, name: '远宗' });
check('B2 放置后: 自动层 (rawSettlementsFor) 全域指纹**逐格不变**', fpRaw() === raw0);
check('B3 放置后: settleCache 键集与内容**逐键不变** (ext 不进纯函数缓存 —— 本次改造的立身之本)',
  fpCache() === cache0,
  `键数 ${MG.settleCache.size}`);
{
  const all1 = fpAll();
  const changed = all0.split('|').filter((v, n) => all1.split('|')[n] !== v).length;
  check('B4 放置后: 对外层只有"远处那一格"多出实体 (其余逐格不变)', changed <= 1,
    `变化 ${changed} 格`);
}
/* B5 ext 归属格 = id 前两段 (**不重算** regionSeedOf) —— 这条钉死 §4.3 的硬约束:
   同一份持久化记录只能有一种归属, 否则"区域包里的位置"与"明细面板查到的位置"会分叉 */
{
  const fake = { id: '3_2_u7', type: 'sect', q: spot.q, r: spot.r, name: '异地宗' };
  MG.setExternalSettlements([fake]);
  const inLabel = MG.settlementsFor(3, 2).filter((s) => s.id === '3_2_u7').length === 1;
  const natCell = MG.regionSeedOf(spot.q, spot.r);
  const inNat = MG.settlementsFor(natCell.i, natCell.j).filter((s) => s.id === '3_2_u7').length === 1;
  check('B5 ext 归属格由 id 前两段决定 (不按坐标重算)', inLabel && !inNat,
    `标的格(3,2)=${inLabel} 坐标自然格(${natCell.i},${natCell.j})=${inNat}`);
}

/* ============================================================
 * C. 增删对称
 * ============================================================ */
console.log('\n== C. 增删对称 ==');
MG.setExternalSettlements([]);
const rawC = fpRaw(), allC = fpAll(), cacheC = fpCache();
const pX = MG.placeSettlement(anchor.q + 30, anchor.r - 25, { type: 'town', tier: 1, name: '试镇' });
check('C1 放置后外部实体数 = 1', MG.externalSettlements().length === 1);
check('C2 removeExternalSettlement 返回 true 且实体数回到 0',
  MG.removeExternalSettlement(pX.id) === true && MG.externalSettlements().length === 0);
check('C3 删除后: 自动层 / 对外层 / settleCache 三份指纹全部回到基线',
  fpRaw() === rawC && fpAll() === allC && fpCache() === cacheC);
check('C4 删除不存在的 id 返回 false (幂等)', MG.removeExternalSettlement('no_such_id') === false);

/* ============================================================
 * D. 两套间距规则并存 (§2.4)
 * ============================================================ */
console.log('\n== D. ext 与自动层是两套独立的间距规则 ==');
MG.setExternalSettlements([]);
{
  /* 取一座真实的自动聚落 S, 在它旁边 3 格放一座 ext。
     若 ext 进了**自动层**, S 会被 SETTLE_MIN_DIST(=7) 的抑制挤掉;
     ext 在缓存之外 ⇒ S 必须原样保留, 且 ext 也在 (两者共存)。 */
  let S = null, cell = null;
  for (let i = -SPAN; i <= SPAN && !S; i++) {
    for (let j = -SPAN; j <= SPAN && !S; j++) {
      const l = MG.settlementsFor(i, j).filter((s) => s.type !== 'poi');
      if (l.length) { S = l[0]; cell = { i, j }; }
    }
  }
  const extQ = S.q + 3, extR = S.r;
  const pE = MG.placeSettlement(extQ, extR, { type: 'village', tier: 1, name: '贴邻村' });
  const here = MG.settlementsFor(cell.i, cell.j);
  const stillThere = here.filter((s) => s.id === S.id).length === 1;
  const extThere = MG.externalSettlements().filter((s) => s.id === pE.id).length === 1;
  console.log(`  S=${S.id} (${S.type}) @ (${S.q},${S.r}); ext ${pE.id} @ (${extQ},${extR}) ` +
              `距 ${MG.hexDist(S.q, S.r, extQ, extR)} 格 (< SETTLE_MIN_DIST=${CFG.SETTLE_MIN_DIST})`);
  check('D1 ext 落在自动聚落 3 格处 ⇒ 自动那座**不**被间距抑制挤掉', stillThere);
  check('D2 同时 ext 自己也在 (两套规则各管各的, 共存)', extThere);
  check('D3 自动层指纹仍与基线一致 (抑制只看自动层)', fpRaw() === rawC);
  /* D4: domainCheck 仍会拦 (领地规则是**另一条**判据, 与间距抑制不冲突) */
  check('D4 领地判据照旧拦 (间距不抑制 ≠ 领地放行)',
    MG.domainCheck(S.q + 2, S.r, '').ok === false ||
    MG.domainCheck(S.q + 2, S.r, pE.id).ok === false,
    '注意: 若 S 的领地为 0 (poi), 本条会红 —— 那说明样本选错了');
}

MG.setExternalSettlements([]);
console.log(`\n========== 结果: ${failures ? failures + ' 项失败' : '全部通过 ✔'} ==========`);
process.exit(failures ? 1 : 0);
