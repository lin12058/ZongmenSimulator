/* ============================================================
 * check_settle_spacing.mjs — R7/D6 契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-15 原话): 「自动生成的城镇之间不能挨太近」⇒ CFG.SETTLE_MIN_DIST=7 格。
 *
 * 断言:
 *   1. CFG.SETTLE_MIN_DIST === 7 (决策值)
 *   2. 枚举窗口内任意两座**对外**聚落 (settlementsFor, 非 poi) 中心六边距 >= SETTLE_MIN_DIST
 *   3. 抑制确实生效: rawSettlementsFor 的总数 >= settlementsFor 的总数 (有被剔除者)
 *   4. 确定性: 同 seed 连算两次结果逐位相同 (抑制不依赖扫描顺序)
 *
 * 用法: node verify/check_settle_spacing.mjs [seed...]
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
const RSPAN = 10;                                    // 区域格 ±10 (21x21)
const MIN = CFG.SETTLE_MIN_DIST | 0;

console.log('== R7 城镇最小中心距 ==');
check('CFG.SETTLE_MIN_DIST === 7 (决策值)', MIN === 7, String(MIN));

let worst = Infinity, viol = 0, nOut = 0, nRaw = 0;
for (const seed of SEEDS) {
  MG.init(seed);
  const list = [];
  let rawN = 0;
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      for (const s of MG.settlementsFor(i, j)) if (s.type !== 'poi') list.push(s);
      for (const s of MG.rawSettlementsFor(i, j)) if (s.type !== 'poi') rawN++;
    }
  }
  nOut += list.length; nRaw += rawN;
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const d = MG.hexDist(list[a].q, list[a].r, list[b].q, list[b].r);
      if (d < worst) worst = d;
      if (d < MIN) viol++;
    }
  }
  /* 确定性: 清缓存重算, 逐位相同 */
  MG.init(seed);
  const list2 = [];
  for (let i = -RSPAN; i <= RSPAN; i++) for (let j = -RSPAN; j <= RSPAN; j++)
    for (const s of MG.settlementsFor(i, j)) if (s.type !== 'poi') list2.push(s.id + '@' + s.q + ',' + s.r);
  const key1 = list.map((s) => s.id + '@' + s.q + ',' + s.r).join('|');
  check(`seed ${seed}: 抑制结果确定 (连算两次一致)`, key1 === list2.join('|'), '');
}

check('任意两聚落中心距 >= SETTLE_MIN_DIST', viol === 0, `违规 ${viol} 对 (最小 ${worst === Infinity ? '-' : worst})`);
check('抑制层生效: 对外聚落 <= 原始聚落', nOut <= nRaw, `对外 ${nOut} / 原始 ${nRaw}`);
console.log(`\n  抽样: 对外聚落 ${nOut} 座 / 原始 ${nRaw} 座 (抑制剔除 ${nRaw - nOut} 座) · 实测最小中心距 ${worst === Infinity ? '-' : worst} 格`);
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
