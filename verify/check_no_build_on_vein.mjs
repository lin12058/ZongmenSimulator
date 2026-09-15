/* ============================================================
 * check_no_build_on_vein.mjs — R4/D3/D4 契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-15 原话):
 *   「建筑不能在灵脉上建造 (就是上面说的 1,2,3 的新位置)」——"新位置"= 十一版 R1/R2
 *   铺出来的灵脉 7/3/1 占地格 (中心 + 从属)。
 *
 * 断言:
 *   A. 引擎判定层
 *     1. landuseOf(灵脉格) === 'vein' (不可建地皮, 不在 BUILDINGS 里)
 *     2. siteScore(灵脉格) 恒为 -1e18 (城镇中心永不落灵脉)
 *   B. 足迹层 (真实世界: 逐座聚落摊开建筑)
 *     3. 任何聚落 growTownFootprint 的建筑格, 其 fields().vein 必须为 null
 *        (中心 + 从属一律不落)
 *   C. D4: 5 种建筑改判宗门附属
 *     4. 抽样宗门 (type='sect') 足迹里出现 '宗门附属' 地皮
 *     5. 灵枢殿 / 聚灵阵 / 祭坛 / 炼丹殿 / 炼器殿 5 种在全图统计中仍可产出
 *
 * 用法: node verify/check_no_build_on_vein.mjs [seed...]
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

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
const RSPAN = 7;                                     // 区域格 ±7 (15x15 = 225 个区域格)

const SECT_KINDS = ['灵枢殿', '聚灵阵', '祭坛', '炼丹殿', '炼器殿'];

console.log('== A. 引擎判定层 (landuseOf / siteScore) ==');
let badLU = 0, badScore = 0, veinCells = 0;
console.log('\n== B/C. 真实世界: 逐座聚落摊开建筑 ==');
let bldgOnVein = 0, nSettle = 0, nSect = 0, sectFoot = 0;
const sectKindsSeen = new Set();

for (const seed of SEEDS) {
  MG.init(seed);
  /* A: 找灵脉格 (中心 + 从属) 断言判定 */
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const cm = MG.communityOf(i, j);
      if (!cm) continue;
      for (const v of cm.veins) {
        for (const [dq, dr] of [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]) {
          const f = MG.fields(v.q + dq, v.r + dr);
          if (!f.vein) continue;
          veinCells++;
          if (MG.landuseOf(f) !== 'vein') badLU++;
          if (MG.siteScore(f.q, f.r) > -1e17) badScore++;
        }
      }
    }
  }
  /* B/C: 逐座聚落摊开建筑 */
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      const arr = MG.settlementsFor(i, j);
      for (const st of arr) {
        if (st.type === 'poi') continue;
        nSettle++;
        const foot = MG.growTownFootprint(st.id, st.type, st.q, st.r);
        if (st.type === 'sect') { nSect++; if (foot.buildings.some((b) => b.terrain === '宗门附属')) sectFoot++; }
        for (const b of foot.buildings) {
          if (MG.fields(b.q, b.r).vein) bldgOnVein++;
          if (st.type === 'sect' && b.terrain === '宗门附属') sectKindsSeen.add(b.kind);
        }
      }
    }
  }
}
check('landuseOf(灵脉格) === \'vein\' (不可建地皮)', badLU === 0, `异常 ${badLU}/${veinCells}`);
check('siteScore(灵脉格) === -1e18 (中心永不落灵脉)', badScore === 0, `异常 ${badScore}/${veinCells}`);
check('无建筑落在灵脉格 (中心 + 从属)', bldgOnVein === 0, `违规 ${bldgOnVein} 处 (共 ${nSettle} 座聚落)`);
check('抽样宗门足迹出现 \'宗门附属\' 地皮', nSect === 0 || sectFoot > 0, `宗门 ${nSect} 座 / 含附属 ${sectFoot} 座`);
check('D4 五种建筑仍可产出 (灵枢殿/聚灵阵/祭坛/炼丹殿/炼器殿)',
  SECT_KINDS.every((k) => sectKindsSeen.has(k)),
  `已见 ${[...sectKindsSeen].join(' ')} (抽样宗门 ${nSect} 座)`);

console.log(`\n  抽样: 聚落 ${nSettle} 座 (宗门 ${nSect}) · 灵脉格 ${veinCells} 个 · 附属建筑种类 ${sectKindsSeen.size}/5`);
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
