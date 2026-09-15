/* ============================================================
 * check_vein_settle_gap.mjs — R11 聚落与灵脉的间距契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-15 原话):「有些城镇距离灵脉太近了」。
 * 旧版 siteScore 把「灵脉邻近」当**加分** (d<=1 +30 / d<=3 +10) ⇒ 城镇中心被主动
 * 吸到灵脉脚下。改前实测: 382 座聚落里 32 座中心距灵脉中心仅 1 格 (8.4%),
 * 最近建筑同样贴到 1 格 —— 视觉上就是"城镇压在灵脉峰边"。
 *
 * 断言:
 *   1. CFG 分级扣分**单调**: CENTER_PEN > CENTER_PEN2 (> 0)。
 *      这是本契约最容易踩的坑 —— 实测 PEN2 >= PEN 时反而冒出 2~10 座 d<=1 的中心
 *      (d=2 比 d=1 罚得更狠 ⇒ d=1 成了"两害相权取其轻"的最优解)。
 *   2. 无聚落**中心**落在距最近灵脉中心 d<=1 的格  (硬断言, 实测 0 座)
 *   3. 无聚落**建筑**落在距最近灵脉中心 d<=1 的格 (足迹缓冲 FOOT_PAD 生效)
 *   4. 建筑 d<=2 占比 < 2% (实测 0.3%; 残下的是"中心恰在 d=2"的核心殿 —— 中心格豁免缓冲)
 *   5. 灵脉域的聚落没被赶尽 (设定: 灵脉附近更繁华): 灵脉域内聚落占比 >= 10%
 *   6. 世界没被抽空: 每个 seed 聚落数 >= 100
 *
 * 用法: node verify/check_vein_settle_gap.mjs [seed...]
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

/* 1. 参数层: 分级扣分单调 + 缓冲开启 */
const PEN = CFG.SETTLE_VEIN_CENTER_PEN, PEN2 = CFG.SETTLE_VEIN_CENTER_PEN2;
const PAD = CFG.SETTLE_VEIN_FOOT_PAD | 0;
check('CFG 分级扣分单调 (CENTER_PEN > CENTER_PEN2 > 0)',
  PEN > 0 && PEN2 > 0 && PEN > PEN2, `PEN=${PEN} PEN2=${PEN2}`);
check('CFG 足迹缓冲开启 (FOOT_PAD >= 1)', PAD >= 1, `FOOT_PAD=${PAD}`);

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
const RSPAN = 7;

let nSettle = 0, nBldg = 0, centerTight = 0, bldgTight = 0, bldg2 = 0, minC = 99, minB = 99;
let inDomain = 0;
const worst = [];

check('\n== 真实世界: 逐 seed 摊开 ==', true);
for (const seed of SEEDS) {
  MG.init(seed);
  /* 灵脉中心 (跨群落去重) */
  const veins = [], seen = new Set();
  for (let i = -6; i <= 6; i++) {
    for (let j = -6; j <= 6; j++) {
      const cm = MG.communityOf(i, j);
      if (!cm) continue;
      for (const v of cm.veins) {
        const k = v.q + ',' + v.r;
        if (seen.has(k)) continue;
        seen.add(k); veins.push(v);
      }
    }
  }
  const nearV = (q, r) => {
    let bd = 99;
    for (const v of veins) { const d = MG.hexDist(q, r, v.q, v.r); if (d < bd) bd = d; }
    return bd;
  };
  let nSeed = 0;
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      for (const st of MG.settlementsFor(i, j)) {
        if (st.type === 'poi') continue;
        nSettle++; nSeed++;
        const dc = nearV(st.q, st.r);
        if (dc < minC) minC = dc;
        if (dc <= 1) { centerTight++; worst.push(`[${seed}] ${st.name}(${st.type}) 中心 d=${dc}`); }
        const cn = MG.communityNear(st.q, st.r);
        if (cn && cn.dist < CFG.COMM_R * 1.4) inDomain++;
        const foot = MG.growTownFootprint(st.id, st.type, st.q, st.r);
        for (const b of foot.buildings) {
          nBldg++;
          const db = nearV(b.q, b.r);
          if (db < minB) minB = db;
          if (db <= 1) bldgTight++;
          if (db <= 2) bldg2++;
        }
      }
    }
  }
  check(`seed ${seed}: 聚落数 >= 100`, nSeed >= 100, `实测 ${nSeed} 座`);
}

check('无聚落中心落在距灵脉 d<=1 的格', centerTight === 0,
  `违规 ${centerTight} 座 · 最近 ${minC}${worst.length ? '\n      ' + worst.slice(0, 8).join('\n      ') : ''}`);
check('无聚落建筑落在距灵脉 d<=1 的格 (足迹缓冲)', bldgTight === 0,
  `违规 ${bldgTight} 处 (共 ${nBldg} 座建筑) · 最近 ${minB}`);
const r2 = nBldg ? bldg2 / nBldg : 1;
check('建筑 d<=2 占比 < 2% (留出视觉缓冲)', r2 < 0.02,
  `实测 ${(r2 * 100).toFixed(2)}% (${bldg2}/${nBldg})`);
const rD = nSettle ? inDomain / nSettle : 0;
check('灵脉域内聚落占比 >= 10% (设定: 灵脉附近更繁华, 未被赶尽)', rD >= 0.10,
  `实测 ${(rD * 100).toFixed(1)}% (${inDomain}/${nSettle})`);

console.log(`\n  抽样: 聚落 ${nSettle} 座 · 建筑 ${nBldg} 座 · 最近中心距 ${minC} · 最近建筑距 ${minB}`);
console.log(`  参数: CENTER_PEN=${PEN} CENTER_PEN2=${PEN2} FOOT_PAD=${PAD}`);
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
