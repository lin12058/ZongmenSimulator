/* ============================================================
 * check_sea_village.mjs — R5/D5 契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-15 原话): 「水上也可以有建筑了，变成海上渔村之类的」
 * ⇒ 新增 type='fishing': 中心落**近岸浅海**, 只出渔类建筑 (码头/渔船坞/渔亭/村口/祠堂)。
 *
 * 断言:
 *   1. 窗口内存在 type==='fishing' 的海上聚落
 *   2. 渔村中心 biome === OCEAN (浅海), 且非 DEEP; 且附近有陆地 (近岸)
 *   3. 渔村足迹建筑: 无 DEEP 格; 建筑种类 ⊆ {村口,祠堂,码头,渔船坞,渔亭,民房,仓库}
 *   4. 渔村 style === 'fishing' 且名字以「渔村」结尾
 *   5. 陆地聚落不受影响 (窗口内仍有非 fishing 聚落)
 *   6. **渔村的样子 (R5b)**: 以水上民居为主 (民房/仓库 ≥ 40%)、水工为辅 (≤ 45%),
 *      且不存在「一座民居都没有」的渔村 —— 钉死"渔村 ≠ 一片栈桥"这一形态要求。
 *
 * 用法: node verify/check_sea_village.mjs [seed...]
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
const BIOME = MG.BIOME;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
const RSPAN = 12;                                    // 区域格 ±12 (25x25)
const FISH_KINDS = new Set(['村口', '祠堂', '码头', '渔船坞', '渔亭', '民房', '仓库']);
/* R5b (2026-09-15 十一版): 「渔村的样子」= 水上民居为主、水工为辅。
   用户原话: 「渔村是渔村不是一个桥梁, 你要有渔村的样子」—— 旧口径下渔村 8 格全是
   码头/渔船坞/渔亭 (水岸池只有这 3 种) ⇒ 读起来是桥梁群。新增 '渔家' 地皮后
   民居类应占多数, 这里把该比例钉死。 */
const HOUSE_KINDS = new Set(['民房', '仓库']);
const PIER_KINDS = new Set(['码头', '渔船坞', '渔亭']);
/* A2 (2026-09-16 用户定案): 水面格允许的 kind = 渔家池 (民房/仓库/码头/渔船坞/渔亭)
   ∪ 核心建筑 (中心格恰在水上时, 见 CORE_KIND)。**不含** 农田/矿场/伐木场 等纯陆地建造。 */
const FW_OK = new Set(['民房', '仓库', '码头', '渔船坞', '渔亭',
  '官衙', '集市', '宗祠', '祠堂', '村口', '宗门大殿', '祖师殿']);

console.log('== R5 海上渔村 ==');
let nFish = 0, nLand = 0;
let badBiome = 0, deepCell = 0, badKind = 0, badStyle = 0, badName = 0, notNearLand = 0;
let nBuild = 0, nHouse = 0, nPier = 0, zeroHouse = 0;
const kindSeen = new Set();
const samples = [];

for (const seed of SEEDS) {
  MG.init(seed);
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      for (const st of MG.settlementsFor(i, j)) {
        if (st.type === 'poi') continue;
        if (st.type !== 'fishing') { nLand++; continue; }
        nFish++;
        const fc = MG.fields(st.q, st.r);
        if (fc.biome !== BIOME.OCEAN) badBiome++;
        /* 近岸: 半径 SEA_SETTLE_NEAR_LAND 内应有陆地 */
        let near = false;
        const RL = CFG.SEA_SETTLE_NEAR_LAND | 0 || 1;
        for (let dq = -RL; dq <= RL && !near; dq++)
          for (let dr = -RL; dr <= RL && !near; dr++) {
            if (MG.hexDist(st.q, st.r, st.q + dq, st.r + dr) > RL) continue;
            if (MG.fields(st.q + dq, st.r + dr).biome > BIOME.OCEAN) near = true;
          }
        if (!near) notNearLand++;
        const foot = MG.growTownFootprint(st.id, st.type, st.q, st.r);
        if (foot.style !== 'fishing') badStyle++;
        if (!/渔村$/.test(st.name)) badName++;
        let h = 0;
        for (const b of foot.buildings) {
          kindSeen.add(b.kind);
          nBuild++;
          if (HOUSE_KINDS.has(b.kind)) { h++; nHouse++; }
          if (PIER_KINDS.has(b.kind)) nPier++;
          if (MG.fields(b.q, b.r).biome === BIOME.DEEP) deepCell++;
          if (!FISH_KINDS.has(b.kind)) badKind++;
        }
        if (h === 0) zeroHouse++;
        if (samples.length < 4) samples.push('seed ' + seed + ' 「' + st.name + '」(' + st.q + ',' + st.r + ') tier' + st.tier + ' → ' + foot.buildings.map((b) => b.kind).join('/'));
      }
    }
  }
}
check('存在海上渔村 (type=\'fishing\')', nFish > 0, `实测 ${nFish} 座`);
check('渔村中心落在浅海 (biome === OCEAN)', badBiome === 0, `异常 ${badBiome}`);
check('渔村中心近岸 (邻域有陆地)', notNearLand === 0, `异常 ${notNearLand}`);
check('渔村建筑无深海格', deepCell === 0, `违规 ${deepCell}`);
check('渔村建筑种类 ⊆ 渔类集合', badKind === 0, `越界 ${badKind} (已见 ${[...kindSeen].join(' ')})`);
check('渔村 style === \'fishing\'', badStyle === 0, `异常 ${badStyle}`);
check('渔村名字以「渔村」结尾', badName === 0, `异常 ${badName}`);
check('陆地聚落不受影响 (仍有非渔聚落)', nLand > 0, `陆地 ${nLand} 座`);
/* R5b: 「渔村的样子」—— 民居为主, 水工为辅 (实测 58.8% / 28.7%, 阈值留足余量) */
const houseShare = nBuild ? nHouse / nBuild : 0;
const pierShare = nBuild ? nPier / nBuild : 0;
check('渔村以水上民居为主 (民房/仓库 占比 ≥ 40%)', houseShare >= 0.40,
  `实测 ${(houseShare * 100).toFixed(1)}% (${nHouse}/${nBuild})`);
check('渔村水工设施不占多数 (码头/渔船坞/渔亭 ≤ 45%)', pierShare <= 0.45,
  `实测 ${(pierShare * 100).toFixed(1)}% (${nPier}/${nBuild})`);
check('没有「一座民居都没有」的渔村', zeroHouse === 0,
  `异常 ${zeroHouse} 座 / 共 ${nFish} 座`);
/* ============================================================
 * A2 (2026-09-16 用户定案): 「你把中心格子这个判定去掉，只要是水里面的建筑必须有这些」
 *   ⇒ 水面格判 '渔家' 不再看聚落 type。这里对**非渔**聚落单独断言: 它们的水面格
 *     也必须出「水上民居」(而不是旧口径的"清一色水工 = 一片栈桥")。
 * ⚠ 与上面 R5 段互补: 上面只管 type==='fishing' 的渔村; 本段只管**非渔**聚落。
 * ============================================================ */
let nfw = 0, nfwHouse = 0, nfwPier = 0, nfwBad = 0, nfwSettle = 0, nfwSettleHouse = 0;
const nfwKinds = new Set();
for (const seed of SEEDS) {
  MG.init(seed);
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      for (const st of MG.settlementsFor(i, j)) {
        if (st.type === 'poi' || st.type === 'fishing') continue;
        const foot = MG.growTownFootprint(st.id, st.type, st.q, st.r);
        let hasW = false, hasH = false;
        for (const b of foot.buildings) {
          if (MG.fields(b.q, b.r).biome > BIOME.OCEAN) continue;    // 只看水面格 (浅海)
          hasW = true; nfw++; nfwKinds.add(b.kind);
          if (HOUSE_KINDS.has(b.kind)) { nfwHouse++; hasH = true; }
          if (PIER_KINDS.has(b.kind)) nfwPier++;
          if (!FW_OK.has(b.kind)) nfwBad++;
        }
        if (hasW) { nfwSettle++; if (hasH) nfwSettleHouse++; }
      }
    }
  }
}
check('A2 非渔聚落也有水面格建筑 (去掉「中心格判定」后覆盖到集镇/村落)', nfwSettle > 0,
  `含水面格的非渔聚落 ${nfwSettle} 座`);
check('A2 非渔水面格建筑种类 ⊆ 渔家池 ∪ 核心建筑 (不越权到农田/矿场等)', nfwBad === 0,
  `越界 ${nfwBad} (已见 ${[...nfwKinds].join(' ')})`);
const nfwHouseShare = nfw ? nfwHouse / nfw : 0;
check('A2 非渔水面格以水上民居为主 (民房/仓库 ≥ 40%, 不是"一片栈桥")', nfwHouseShare >= 0.40,
  `实测 ${(nfwHouseShare * 100).toFixed(1)}% (${nfwHouse}/${nfw}; 水工 ${nfwPier})`);
check('A2 确实存在「带水上民居的非渔聚落」(不是只有水工)', nfwSettleHouse > 0,
  `带水上民居的非渔聚落 ${nfwSettleHouse} 座 / 共 ${nfwSettle} 座`);
console.log(`  非渔水面格: 民居 ${nfwHouse} / 水工 ${nfwPier} / 共 ${nfw}  (聚落 ${nfwSettle} 座)`);
if (samples.length) { console.log('  例:'); samples.forEach((s) => console.log('    ' + s)); }
console.log(`\n  抽样: 渔村 ${nFish} 座 / 陆聚落 ${nLand} 座`);
console.log(`  渔村构成: 民居 ${nHouse} / 水工 ${nPier} / 其他(核心) ${nBuild - nHouse - nPier}  (共 ${nBuild} 格)`);
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
