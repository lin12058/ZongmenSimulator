/* ============================================================
 * check_expand_rules.mjs — 城市扩张 (附属城镇 EXPAND_R) 契约
 * ------------------------------------------------------------
 * 用户原话 (2026-09-23): 「选完宗门后可以进行城市扩张, 建立附属城镇, 但**不能距离
 * 超过一个区块的边缘的大小**, 避免跨太多区块」。
 *
 * ⚠ 为什么能离线跑: 与 check_place_rules.mjs 同法 —— `mapgen-server.js` 是纯搬运层,
 *   加载 noise + mapgen-config + mapgen + mapgen-server 后, `MS.placeCheckJson` /
 *   `MS.commitPlace` 就是服务端真正调的那条路 (mapgen-server.js:340/429)。
 *   `MS.expandCheckJson` 是 MG.expandCheck 的只读出口, 供边界段直接对拍。
 *
 * 断言 (A~E 五段):
 *   A. 真源/常量: EXPAND_R === 10 === CHUNK_R (整片领地在块内) / EXPAND_TYPES 白名单
 *      (只 town/village) / 可玩性下界 (环带非空) / meta 下发 expandR+expandTypes
 *   B. expandCheck 边界语义: dist === maxR **放行** (<=), maxR+1 拒; maxR<=0 / 无锚点 = 不限
 *   C. placeCheckJson 扩张档判据链: bad_type 白名单 → **too_far 优先于深海/灵脉**
 *      (否则超距悬停只会看到无关的"深海"提示) → 半径内语义一格未被遮挡
 *   D. commitPlace 步 0 二次校验: 坏类型/超距被拒且**未写入 ext**; 合法路径落成
 *   E. 端到端用户故事「立宗后拓土」: 注入本宗为 ext ⇒ 半径内可建 / 半径外 too_far
 *
 * 用法: node verify/check_expand_rules.mjs [seed] [扫描半径]
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

MG.init(SEED);
console.log(`seed=${SEED}`);

const EXPR = MG.CFG.EXPAND_R | 0;
const CHUNK_R = MG.CHUNK_R | 0;
const ETYPES = MG.CFG.EXPAND_TYPES || {};

/* ============================================================
 * A. 真源 / 常量
 * ============================================================ */
console.log('\n== A. 真源与常量 ==');
check('A1 EXPAND_R 存在且为正整数', EXPR > 0, String(MG.CFG.EXPAND_R));
check('A2 EXPAND_R === CHUNK_R (整片附属领地必落在本宗所在区块内, 一格不出块)',
  EXPR === CHUNK_R, `EXPAND_R=${EXPR} vs CHUNK_R=${CHUNK_R}`);
check('A3 EXPAND_TYPES 白名单恰为 town/village (值=1)',
  ETYPES.town === 1 && ETYPES.village === 1 &&
  !ETYPES.sect && !ETYPES.city && !ETYPES.poi && !ETYPES.fishing,
  JSON.stringify(ETYPES));
/* 可玩性下界: 允许区 = 距本宗 (DOMAIN_R(本宗), EXPAND_R] 的**环带**。
   若 EXPAND_R <= 最大 DOMAIN_R ⇒ 环带为空 ⇒ 有合法本宗却无处拓土。
   最坏本宗 = 上品宗门 (DOMAIN_R.sect3 = 8) ⇒ 要求 EXPAND_R >= 8 + 2 (至少两圈可建)。 */
const dSect3 = MG.domainRadiusOf({ type: 'sect', tier: 3 }) | 0;
check('A4 可玩性: EXPAND_R >= DOMAIN_R_MAX(sect3) + 2 (环带非空, 上品宗门也有 ≥2 圈可拓)',
  EXPR >= dSect3 + 2, `EXPAND_R=${EXPR} vs sect3=${dSect3}+2`);
/* 与 DOMAIN_R 同真源的口径: 拓土档的领地半径仍由 DOMAIN_R 管, 与 EXPAND_R 无关 */
check('A5 拓土档领地半径取自 DOMAIN_R (town=6 / village=4), 与 EXPAND_R 解耦',
  (MG.domainRadiusOf({ type: 'town', tier: 1 }) | 0) === 6 &&
  (MG.domainRadiusOf({ type: 'village', tier: 1 }) | 0) === 4,
  `town=${MG.domainRadiusOf({ type: 'town', tier: 1 })} ` +
  `village=${MG.domainRadiusOf({ type: 'village', tier: 1 })}`);
/* meta 下发 (前端 geo.expandR / geo.expandTypes 的真源) */
const meta = JSON.parse(MS.metaJson());
check('A6 meta 下发 expandR === CFG.EXPAND_R', (meta.expandR | 0) === EXPR, String(meta.expandR));
check('A7 meta 下发 expandTypes 与 CFG 逐键一致',
  meta.expandTypes && meta.expandTypes.town === 1 && meta.expandTypes.village === 1 &&
  Object.keys(meta.expandTypes).length === Object.keys(ETYPES).length,
  JSON.stringify(meta.expandTypes));

/* ============================================================
 * B. expandCheck 边界语义 (纯函数, 与世界无关)
 * ============================================================ */
console.log('\n== B. expandCheck 边界语义 ==');
/* 轴向坐标下 (d, 0) 到 (0,0) 的六边距恰为 d */
const on = (d) => MG.expandCheck(d, 0, 0, 0, EXPR);
check('B1 dist === maxR ⇒ 放行 (判据用 <=, 同 domainCheck 边界口径)',
  on(EXPR).ok === true && on(EXPR).dist === EXPR, JSON.stringify(on(EXPR)));
check('B2 dist === maxR + 1 ⇒ 拒绝', on(EXPR + 1).ok === false, JSON.stringify(on(EXPR + 1)));
check('B3 dist === maxR - 1 ⇒ 放行', on(EXPR - 1).ok === true, JSON.stringify(on(EXPR - 1)));
check('B4 dist === 0 (锚点本格) ⇒ 放行', on(0).ok === true, JSON.stringify(on(0)));
check('B5 maxR <= 0 ⇒ 不限 (立宗档传 0, 恒放行)',
  MG.expandCheck(999, 999, 0, 0, 0).ok === true && MG.expandCheck(999, 999, 0, 0, -3).ok === true);
check('B6 无锚点 (null) ⇒ 不限 (恒放行, 静默降级)',
  MG.expandCheck(999, 999, null, null, EXPR).ok === true);
check('B7 dist 由 hexDist 真算 (非曼哈顿/切比雪夫)',
  on(5).dist === MG.hexDist(5, 0, 0, 0) && on(7).dist === MG.hexDist(-7, 7, 0, 0),
  `${on(5).dist} / ${on(7).dist}`);
/* expandCheckJson 出口 == 纯函数 */
const ej = JSON.parse(MS.expandCheckJson(EXPR + 1, 0, 0, 0, EXPR));
check('B8 expandCheckJson 出口与 MG.expandCheck 同判', ej.ok === false && ej.dist === EXPR + 1,
  JSON.stringify(ej));

/* ============================================================
 * C. placeCheckJson 扩张档判据链
 * ============================================================ */
console.log('\n== C. placeCheckJson 扩张档判据链 ==');
/* 选一个"像样"的锚点 (本宗) 位置 —— 一份合法立宗落点 */
let anchor = null;
outer:
for (let i = -SCAN; i <= SCAN; i++) {
  for (let j = -SCAN; j <= SCAN; j++) {
    for (const s of MG.settlementsFor(i, j)) {
      if (s.type === 'poi') continue;
      const need = Math.max(1, MG.domainRadiusOf(s));
      for (let dq = need; dq <= need + 10 && !anchor; dq++) {
        for (let dr = -3; dr <= 3 && !anchor; dr++) {
          const q = s.q + dq, r = s.r + dr;
          if (!MG.domainCheck(q, r, '').ok) continue;
          anchor = { q, r, near: s }; break outer;
        }
      }
    }
  }
}
check('C0 找到合法锚点样本 (供扩张档判据用)', !!anchor,
  '±' + SCAN + ' 内无 ⇒ 换 seed 或放大扫描半径');
if (!anchor) {
  console.log('\n========== 结果: 无法取样 ==========');
  process.exit(1);
}
const AQ = anchor.q, AR = anchor.r;
const pc = (q, r, type) =>
  JSON.parse(MS.placeCheckJson(q, r, '', JSON.stringify({ type, aq: AQ, ar: AR, maxR: EXPR })));

/* C1 类型白名单: 扩张档传 'city' ⇒ bad_type (placeSettlement 不校验 ⇒ 必须白名单兜住) */
const cCity = pc(AQ + 3, AR, 'city');
check('C1 扩张档 type=city ⇒ bad_type (否则静默得 8 格领地, 绕开间距规则)',
  cCity.reason === 'bad_type', cCity.reason);
const cPoi = pc(AQ + 3, AR, 'poi');
check('C2 扩张档 type=poi ⇒ bad_type (否则静默得 0 格 = 可贴脸建)',
  cPoi.reason === 'bad_type', cPoi.reason);
/* C3 too_far 优先于深海/灵脉: 取一个距锚点 > maxR 的格 ⇒ reason 必须是 too_far
   (无论那格是什么地形 —— 这保证超距悬停给出的是本次动作相关的解释)。 */
const cf = pc(AQ + EXPR + 20, AR, 'town');
check('C3 超距 (dist > maxR) 恒判 too_far (优先于 deep_water/on_vein, 解释才切题)',
  cf.reason === 'too_far', `${cf.reason} dist=${cf.expand && cf.expand.dist}`);
check('C4 回传 expand.dist / expand.maxR / anchor 三项 (前端画辖域环与离宗行靠它们)',
  cf.expand && cf.expand.dist === MG.hexDist(AQ + EXPR + 20, AR, AQ, AR) &&
  cf.expand.maxR === EXPR && cf.anchor && cf.anchor.q === AQ && cf.anchor.r === AR,
  JSON.stringify({ expand: cf.expand, anchor: cf.anchor }));
/* C5 半径内 + 合法 ⇒ 不得因扩张判据被拒 (reason !== 'too_far'); 若其余判据也全过则 can=true */
const cIn = pc(AQ + EXPR, AR, 'town');
check('C5 半径内 (dist === maxR) ⇒ reason !== too_far (边界放行, 其余判据照旧)',
  cIn.reason !== 'too_far' && cIn.can !== undefined,
  `${cIn.reason} dist=${cIn.expand && cIn.expand.dist}`);

/* ============================================================
 * D. commitPlace 步 0 二次校验 (在动引擎状态之前拒)
 * ============================================================ */
console.log('\n== D. commitPlace 步 0 二次校验 ==');
MG.setExternalSettlements([]);
MG.init(SEED);
const ext0 = MG.externalSettlements().length;
/* D1 坏类型 ⇒ 拒且未写入 ext */
const d1 = JSON.parse(MS.commitPlace(AQ, AR, JSON.stringify(
  { type: 'city', tier: 1, name: '伪城', maxR: EXPR, aq: AQ, ar: AR })));
check('D1 扩张档 type=city ⇒ {ok:0, reason:bad_type}',
  d1.ok === 0 && d1.reason === 'bad_type', JSON.stringify(d1));
check('D2 被拒的提交**未写入** ext (坏落点绝不进 ext 层)',
  MG.externalSettlements().length === ext0,
  `${ext0} → ${MG.externalSettlements().length}`);
/* D3 超距 ⇒ 拒 */
const d3 = JSON.parse(MS.commitPlace(AQ + EXPR + 20, AR, JSON.stringify(
  { type: 'town', tier: 1, name: '远镇', maxR: EXPR, aq: AQ, ar: AR })));
check('D3 扩张档超距 ⇒ {ok:0, reason:too_far}',
  d3.ok === 0 && d3.reason === 'too_far', JSON.stringify(d3));
/* D4 立宗档 (maxR=0) 传 town ⇒ bad_type (立宗只认 sect) */
const d4 = JSON.parse(MS.commitPlace(AQ, AR, JSON.stringify(
  { type: 'town', tier: 1, name: '伪宗', maxR: 0 })));
check('D4 立宗档 (maxR=0) type=town ⇒ bad_type (立宗只认 sect)',
  d4.ok === 0 && d4.reason === 'bad_type', JSON.stringify(d4));
check('D5 同上未写入 ext', MG.externalSettlements().length === ext0,
  String(MG.externalSettlements().length));

/* ============================================================
 * E. 端到端用户故事: 立宗后拓土
 * ============================================================ */
console.log('\n== E. 立宗后拓土 (端到端) ==');
MG.setExternalSettlements([]);
MG.init(SEED);
/* 注入本宗 (下品宗门 tier=1 ⇒ DOMAIN_R=6) 到锚点 —— 引擎会自算 id `{i}_{j}_u{n}` */
const inj = MS.setExternalSettlements(JSON.stringify([
  { type: 'sect', tier: 1, q: AQ, r: AR, name: '试锋宗', owner: 'u1' },
]));
check('E1 本宗已注入 ext', JSON.parse(inj).n === 1, inj);
const mainNeed = MG.domainRadiusOf({ type: 'sect', tier: 1 }) | 0;      // 6
/* 在环带 [mainNeed, EXPAND_R] 里找一个合法拓土点 (扫锚点周边 2R+1 方窗再按 hexDist 过滤) */
let annex = null, bandScanned = 0;
for (let dq = -EXPR; dq <= EXPR && !annex; dq++) {
  for (let dr = -EXPR; dr <= EXPR && !annex; dr++) {
    const q = AQ + dq, r = AR + dr;
    const d = MG.hexDist(q, r, AQ, AR);
    if (d < mainNeed || d > EXPR) continue;           // 必须在环带内
    bandScanned++;
    const f = MG.fields(q, r);
    if (f.biome === MG.BIOME.DEEP || f.biome === MG.BIOME.OCEAN || f.vein) continue;
    if (MG.spiritAt(q, r) < MG.CFG.SEA_SETTLE_MIN_SPIRIT) continue;
    const vn = MG.veinNear(q, r);
    if (vn && vn.d < (MG.CFG.SETTLE_VEIN_FOOT_PAD | 0)) continue;
    if (!MG.domainCheck(q, r, '').ok) continue;
    annex = { q, r, d };
  }
}
check(`E2 环带 [${mainNeed},${EXPR}] 内找到合法拓土点`, !!annex,
  `扫了 ${bandScanned} 格仍无 ⇒ EXPAND_R 相对本宗领地太小 (可玩性下界 A4 的实测印证)`);
if (annex) {
  const okc = JSON.parse(MS.placeCheckJson(annex.q, annex.r, '',
    JSON.stringify({ type: 'town', aq: AQ, ar: AR, maxR: EXPR })));
  check('E3 半径内拓土点 ⇒ placeCheckJson can=true (全判据通过)',
    okc.can === true, okc.reason);
  const rc = JSON.parse(MS.commitPlace(annex.q, annex.r, JSON.stringify(
    { type: 'town', tier: 1, name: '试锋别院', owner: 'u1', maxR: EXPR, aq: AQ, ar: AR })));
  check('E4 commitPlace 拓土成功 (ok=1)', rc.ok === 1, JSON.stringify(rc).slice(0, 160));
  const st = rc.st || {};
  check('E5 落成实体 type=town 且 id 形态合法 (`{i}_{j}_u{n}`)',
    st.type === 'town' && /^-?\d+_-?\d+_u\d+$/.test(String(st.id)), `${st.type} ${st.id}`);
  check('E6 实际距本宗 <= EXPAND_R (落库位置不越辖域)',
    MG.hexDist(st.q, st.r, AQ, AR) <= EXPR,
    `${MG.hexDist(st.q, st.r, AQ, AR)} > ${EXPR}`);
  check('E7 ext 现在有 2 座 (本宗 + 附属)', MG.externalSettlements().length === 2,
    String(MG.externalSettlements().length));
  /* 半径外一点 (距本宗 > EXPAND_R) ⇒ too_far (用户故事的另一半) */
  const far = JSON.parse(MS.placeCheckJson(AQ + EXPR + 3, AR, '',
    JSON.stringify({ type: 'town', aq: AQ, ar: AR, maxR: EXPR })));
  check('E8 半径外 ⇒ too_far (用户: 「不能距离超过一个区块的边缘的大小」)',
    far.reason === 'too_far', far.reason);
  console.log(`  拓土点 (${annex.q},${annex.r}) 距本宗 ${annex.d} 格 · 道路 ${rc.nRoad} 条 / ${rc.ms}ms`);
}

console.log(`\n========== 结果: ${failures ? failures + ' 项失败' : '全部通过 ✔'} ==========`);
process.exit(failures ? 1 : 0);
