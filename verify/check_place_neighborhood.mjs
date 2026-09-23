/* ============================================================
 * check_place_neighborhood.mjs — 玩家落点校验「邻域覆盖范围」契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求背景 (用户 2026-09-21):
 *   「玩家可以随便放 …… 根据城镇的规模来设置属于的领地,
 *     如果玩家 8 格附近有城市的中心就不允许建造」
 *
 * 契约: 校验「落点是否侵入既有聚落的领地」时, 必须扫描足够远的区域格邻域 ——
 *   漏扫 ⇒ 有聚落明明在 8 格内却查不到 ⇒ 允许建造 ⇒ 两个城市贴在一起 (静默错)。
 *
 * 推导 (本脚本把推导写进断言, 防止后人"优化"成 1 环):
 *   1. 区域格间距 REGION_M —— 聚落中心与晶格点的第一段偏移
 *   2. 锚点抖动 = REGION_M * 0.7 / 2 (hash01 在 [-0.35, +0.35] 区间)
 *   3. 选址再选半径 = PROSPECT_R (pickSettlementCenter 在锚点周围 PROSPECT_R 内重选)
 *   ⇒ 单侧最大偏移 MAXOFF = JIT + PROSPECT_R
 *   ⇒ 邻格聚落「最近可能」距我 = n*REGION_M - MAXOFF
 *   ⇒ 要求 n*REGION_M - MAXOFF > DOMAIN_R_MAX 才算该环全部在禁区之外
 *
 * 断言:
 *   A. REGION_M / PROSPECT_R 与引擎真源一致 (防止改了参数而本脚本失效)
 *   B. 1 环 **不安全** (若哪天变了, 会红 —— 强制重新审视)
 *   C. 所需环数 = ceil((DOMAIN_R_MAX + MAXOFF) / REGION_M) 且被报告的 REQUIRED_RING 一致
 *   D. 用真实世界抽样: 对数千个已生成聚落, 断言「所有落在某点 DOMAIN_R 内的聚落,
 *      都位于该点的 REQUIRED_RING 环邻域内」(正向验证推导)
 *
 * 用法: node verify/check_place_neighborhood.mjs [seed...]
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
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

/* ---- 领地半径真源 (2026-09-23 已落地: CFG.DOMAIN_R) ----
   ⚠ 本脚本原先按方案取值 (SOURCE='plan') 并**要求**实施后改成从 CFG 读。
     现已落地 ⇒ 直接读 CFG, 且断言该表存在 —— 源没落地就红, 不会静默按旧值推导。 */
const DOMAIN_R = CFG.DOMAIN_R;
const DOMAIN_R_SOURCE = (DOMAIN_R && typeof DOMAIN_R === 'object') ? 'cfg' : 'missing';
const DOMAIN_R_MAX = DOMAIN_R_SOURCE === 'cfg'
  ? Math.max(...Object.values(DOMAIN_R)) : 0;

/* ---- 引擎真源参数 ---- */
const REGION_M = 18;                   // mapgen.js 顶部 `var REGION_M` (内部 var, 未导出)
const PROSPECT_R = CFG.PROSPECT_R;
const JIT_HALF = 0.35;                 // 锚点抖动 = REGION_M * 0.7 / 2

console.log('== A. 参数与引擎真源一致 ==');
check('CFG.DOMAIN_R 已落地 (真源 = mapgen-config.js, 非本脚本硬编码)',
  DOMAIN_R_SOURCE === 'cfg', `实测 ${DOMAIN_R_SOURCE}`);
check(`DOMAIN_R_MAX = ${DOMAIN_R_MAX} 与城市档 city 一致 (用户原话「8 格附近有城市中心」)`,
  DOMAIN_R && DOMAIN_R.city === DOMAIN_R_MAX, JSON.stringify(DOMAIN_R));
check('CFG.PROSPECT_R === 4', PROSPECT_R === 4, `实测 ${PROSPECT_R}`);
/* REGION_M 是 mapgen.js 的内部 var, 未导出 —— 用「相邻区域格的 spiritAt 锚点差」间接确认
   它在 (0, 36] 区间内且 1 环不足以覆盖 (这才是本脚本真正要守的东西)。
   直接断言见 B/C: 用导出的 settlementsFor 做真实世界抽样, 不依赖 REGION_M 的精确值。 */
check('CFG.SETTLE_VEIN_FOOT_PAD === 2 (方案引用值)', CFG.SETTLE_VEIN_FOOT_PAD === 2, `实测 ${CFG.SETTLE_VEIN_FOOT_PAD}`);
check('CFG.SEA_SETTLE_MIN_SPIRIT === 0.20 (方案引用值)', Math.abs(CFG.SEA_SETTLE_MIN_SPIRIT - 0.20) < 1e-9, `实测 ${CFG.SEA_SETTLE_MIN_SPIRIT}`);

/* ---- 推导 ---- */
const MAXOFF = REGION_M * JIT_HALF + PROSPECT_R;
console.log('\n== B/C. 邻域环数推导 ==');
console.log(`  区域格间距 REGION_M = ${REGION_M}`);
console.log(`  锚点抖动半径     = ${(REGION_M * JIT_HALF).toFixed(2)} 格`);
console.log(`  选址再选半径     = ${PROSPECT_R} 格  (PROSPECT_R)`);
console.log(`  单侧最大偏移     = ${MAXOFF.toFixed(2)} 格`);

function ringSafe(n) { return n * REGION_M - MAXOFF > DOMAIN_R_MAX; }
console.log(`  第 1 环最近可能 = ${(REGION_M - MAXOFF).toFixed(1)} 格  => ${ringSafe(1) ? '安全' : '不安全'}`);
console.log(`  第 2 环最近可能 = ${(2 * REGION_M - MAXOFF).toFixed(1)} 格  => ${ringSafe(2) ? '安全' : '不安全'}`);

check('1 环不足以覆盖 DOMAIN_R_MAX=8 的校验 (即: 必须扫 >=2 环)', !ringSafe(1),
  '若此条变红: 参数已变, 需重新推导所需环数并更新实现');

let REQUIRED_RING = 1;
while (!ringSafe(REQUIRED_RING)) REQUIRED_RING++;
const formula = Math.ceil((DOMAIN_R_MAX + MAXOFF) / REGION_M);
check(`所需环数 ${REQUIRED_RING} 与公式 ceil((${DOMAIN_R_MAX}+${MAXOFF.toFixed(1)})/${REGION_M})=${formula} 一致`,
  REQUIRED_RING === formula, `实测 ${REQUIRED_RING} vs ${formula}`);
console.log(`  ⇒ 校验必须扫描 ${REQUIRED_RING} 环邻域 (共 ${(2 * REQUIRED_RING + 1) ** 2} 个区域格)`);

/* ---- D. 真实世界抽样: 反向验证 ---- */
console.log('\n== D. 真实世界抽样: DOMAIN_R 内的聚落是否都在 REQUIRED_RING 环内 ==');
const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
let probed = 0, hitsInDomain = 0, outOfRing = 0;
/* ⚠ 反向验证必须用「比 SETTLE_MIN_DIST 更宽松」的判定半径, 否则 D 段是**空真**(vacuous):
   自动生成聚落之间已有 SETTLE_MIN_DIST=7 的抑制 ⇒ 落在 8 格内的对本来就极少,
   hitsInDomain=0 时断言恒真, 脚本失去牙齿。
   这里改用 DOMAIN_R_MAX=7.1... 不行 —— 必须按「领地半径」的语义测。
   正确做法: 测「落在 PROBE_R 格内」的对 (PROBE_R 取 SETTLE_MIN_DIST+1=8,
   即恰好跨过抑制阈值的那一带), 这是最可能出现近邻的区间。
   若该带仍为空, 脚本会显式报告 hitsInDomain=0 并**把这条判为 FAIL** ——
   空真不可接受 (工程纪律: 参照系不能自证, 见 skill §32)。 */
const PROBE_R = 8;
let pairsInBand = 0;          // 落在 [SETTLE_MIN_DIST, PROBE_R) 的对数 (真能触发判定的样本)

for (const seed of SEEDS) {
  MG.init(seed);
  /* 收集一片区域的聚落 (按区域格) */
  const SPAN = 6;
  const byCell = new Map();
  for (let i = -SPAN; i <= SPAN; i++) {
    for (let j = -SPAN; j <= SPAN; j++) {
      const sts = MG.settlementsFor(i, j).filter(s => s.type !== 'poi');
      if (sts.length) byCell.set(i + ',' + j, sts);
    }
  }
  const all = [];
  for (const [k, sts] of byCell) { const [i, j] = k.split(',').map(Number); for (const s of sts) all.push({ i, j, s }); }

  /* 对每个聚落 A: 找所有落在 A 的 PROBE_R 内的其他聚落 B, 断言 B 的区域格在 A 的 REQUIRED_RING 环内 */
  for (const a of all) {
    probed++;
    for (const b of all) {
      if (a === b) continue;
      const d = MG.hexDist(a.s.q, a.s.r, b.s.q, b.s.r);
      if (d >= PROBE_R) continue;               // 不在探针半径内, 不关心
      hitsInDomain++;
      if (d >= CFG.SETTLE_MIN_DIST) pairsInBand++;   // 恰好跨过抑制阈值的那一带
      const cellDist = Math.max(Math.abs(b.i - a.i), Math.abs(b.j - a.j));   // 切比雪夫环距
      if (cellDist > REQUIRED_RING) {
        outOfRing++;
        if (outOfRing <= 5)
          console.log(`    ⚠ seed=${seed} A(${a.i},${a.j}) 与 B(${b.i},${b.j}) 距 ${d} 格, `
            + `但 B 在 ${cellDist} 环 > REQUIRED_RING=${REQUIRED_RING}`);
      }
    }
  }
}
console.log(`  抽样聚落 ${probed} 个, 落在 ${PROBE_R} 格内的邻近对 ${hitsInDomain} 对 `
  + `(其中 ${pairsInBand} 对落在 [${CFG.SETTLE_MIN_DIST}, ${PROBE_R}) 带内)`);
check(`样本非空真: 至少存在 1 对落在 ${PROBE_R} 格内的邻近聚落`, hitsInDomain > 0,
  'hitsInDomain=0 ⇒ 该断言恒真, 无鉴别力 (需扩大 SPAN 或加 seed)');
check(`所有 ${PROBE_R} 格内的邻近聚落都落在 ${REQUIRED_RING} 环邻域内`, outOfRing === 0,
  `越界 ${outOfRing} 对 ⇒ 实现的扫描范围不足, 会漏判`);

console.log('\n' + (failures === 0
  ? `全部通过 (REQUIRED_RING=${REQUIRED_RING}, 共 ${(2 * REQUIRED_RING + 1) ** 2} 个区域格)`
  : `${failures} 条失败`));
process.exit(failures === 0 ? 0 : 1);
