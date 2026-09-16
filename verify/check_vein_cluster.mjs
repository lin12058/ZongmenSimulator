/* ============================================================
 * check_vein_cluster.mjs — 灵脉「七星群」占地结构契约 (离线 Node, 不需起服务)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-15 原话):
 *   「大灵脉 1 个中心旁边 6 个高度比较低的没有 / 中灵脉 1 个中心旁边, 左下角也右下角
 *     比他低的也没有」 ⇒ 十一版把六版砍掉的 7/3/1 占地加回来, 从属格挂**专用第 4 档**高度。
 *
 * 断言:
 *   A. 引擎占地形态 (veinFootKeep 逐格, 纯函数)
 *     1. 大 (level 0) → 本格 + 六邻 = 7 格; 中 (level 1) → 本格 + 西南(-1,+1) + 东南(0,+1) = 3 格;
 *        小 (level 2) → 仅本格 = 1 格; d >= 2 一律不保留
 *   B. 真实世界上的一致性 (fields() 的 vein 覆写)
 *     2. 每根灵脉的**中心格** level == 自己的 level (0/1/2)
 *     3. 每根灵脉的**从属格** level == CFG.VEIN_SAT_LEVEL (=3, 专用从属档)
 *     4. 大灵脉: 中心未被边界沉海时, 六邻**全部**有 vein 标记 (7/7)
 *     5. 中灵脉: 恰有 (-1,+1) 与 (0,+1) 两个从属格 (3/3)
 *     6. 小灵脉: 六邻**没有**自己的从属格 (1/1)
 *   C. 从属格不得污染「独立灵脉」层
 *     7. 每个群落恒有 1 根 level-0 大灵脉; veins[] 内不得出现 level=3 从属格; 群落内中心不重复
 *   D. 前端「地盘彩环」的档位表 (2026-09-16 十四版 — 用户:「大灵脉 1 格外面 6 格, 中的是
 *      1 格下面 2 格 … 但地盘彩环没有对应的另外 6 格和 2 格」⇒ 峰体早已按档, 只有地台漏了)
 *     8. web/js/vein-skin.js VS.footOffsets 的**镜像表**逐档 == 引擎 veinFootKeep (跨源)
 *     9. 偏移池序 == 引擎 NEIGH_SLOTS; 中档恰为 本格 + 东南(0,1) + 西南(-1,1)
 *    10. 源码守卫: main.js 走 VS.footOffsets, 旧「只画本格」写法不得复活;
 *        取数通道齐备 (?veinprobe=1 ⇒ __feat().veinRings 逐根格数)
 *
 * 已知非缺陷量 (不判失败, 仅打印):
 *   X. 跨群落中心撞格: 两个相邻群落各自把次级灵脉落在同一整数格 (各自的生成互不知情)。
 *      该格由 veinNear 全局最近优先裁决其一, 落败者不在自己中心格显形 (「幻影灵脉」)。
 *      只影响地名签叠字, 不影响 7/3/1 占地契约 —— 本用例对被遮蔽的灵脉**跳过**而不判错。
 *
 * 用法: node verify/check_vein_cluster.mjs [seed...]
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
const RING = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
const RINGS = ['东', '东南', '西南', '西', '西北', '东北'];

console.log('== A. 引擎占地形态 (veinFootKeep) ==');
const kept = (lv) => RING.filter(([q, r]) => MG.veinFootKeep(lv, q, r));
check('大 (level 0) = 本格 + 六邻 = 7 格', kept(0).length === 7, JSON.stringify(kept(0)));
check('中 (level 1) = 本格 + 西南 + 东南 = 3 格', eq(kept(1), [[0, 0], [0, 1], [-1, 1]]), JSON.stringify(kept(1)));
check('小 (level 2) = 仅本格 = 1 格', eq(kept(2), [[0, 0]]), JSON.stringify(kept(2)));
check('d >= 2 一律不保留', [[2, 0], [0, 2], [-2, 2], [2, -1], [-2, -2], [3, 3]]
  .every(([q, r]) => [0, 1, 2].every((lv) => MG.veinFootKeep(lv, q, r) === false)), '');
check('CFG.VEIN_SAT_LEVEL 指向第 4 档 (3)', (CFG.VEIN_SAT_LEVEL | 0) === 3, String(CFG.VEIN_SAT_LEVEL));

console.log('\n== B/C. 真实世界: 逐根灵脉核对占地与层隔离 ==');
const SAT = CFG.VEIN_SAT_LEVEL | 0;
let nBig = 0, nMid = 0, nSmall = 0, nSunk = 0, nShadow = 0, xcomm = 0;
let badCenter = 0, badSat = 0, bigShort = 0, midShort = 0, smallExtra = 0;
let noBig = 0, intraDup = 0, veinEntries = 0;
const SPAN = 4;                                     // ±4 区域格 (≈ ±72 格, 远离灵气边界)

for (const seed of SEEDS) {
  MG.init(seed);
  const owner = new Map();                          // "q,r" -> 声明它的群落数 (跨群落撞格)
  for (let i = -SPAN; i <= SPAN; i++) {
    for (let j = -SPAN; j <= SPAN; j++) {
      const cm = MG.communityOf(i, j);
      if (!cm) continue;
      /* C7a: 每个群落恒有 1 根 level-0 大灵脉 (中心恒在) */
      if (!cm.veins.some((v) => v.level === 0)) noBig++;
      const inComm = new Set();
      for (const v of cm.veins) {
        veinEntries++;
        if (v.level === SAT) badCenter++;            // 从属格混进 veins[] (统计虚高)
        if (!(v.level === 0 || v.level === 1 || v.level === 2)) badCenter++;
        const k = v.q + ',' + v.r;
        if (inComm.has(k)) intraDup++;               // 同一群落内中心重复 (不该发生)
        inComm.add(k);
        owner.set(k, (owner.get(k) || 0) + 1);
      }
      for (const v of cm.veins) {
        /* 中心格被边界沉海 → 不写 vein 标记, 跳过这一根 (不是缺陷) */
        const fc = MG.fields(v.q, v.r);
        if (!fc.vein) { nSunk++; continue; }
        /* 跨群落撞格: 中心被"别的灵脉"占住 ⇒ 幻影灵脉, 跳过 (见文件头 X) */
        if (fc.vein.name !== v.name) { nShadow++; continue; }
        if (v.level === 0) nBig++; else if (v.level === 1) nMid++; else nSmall++;
        const foot = kept(v.level);
        let hit = 0, satHit = 0, extra = 0;
        for (const [dq, dr] of RING) {
          const isCenter = (dq === 0 && dr === 0);
          const f = MG.fields(v.q + dq, v.r + dr);
          const mine = !!(f.vein && f.vein.element === v.element && f.vein.variant === v.variant &&
                          f.vein.name === v.name);
          if (!mine) continue;
          if (isCenter) {
            if (f.vein.level !== v.level) badCenter++;
          } else {
            if (f.vein.level !== SAT) badSat++;
            else satHit++;
            const inFoot = foot.some((p) => p[0] === dq && p[1] === dr);
            if (!inFoot) extra++;
          }
          hit++;
        }
        /* B4/B5/B6 */
        const want = foot.length;
        if (v.level === 0 && hit !== want) bigShort++;
        if (v.level === 1 && hit !== want) midShort++;
        if (v.level === 2 && (hit !== want || extra > 0 || satHit > 0)) smallExtra++;
      }
    }
  }
  for (const n of owner.values()) if (n > 1) xcomm++;
}
console.log(`  抽样近域: 大 ${nBig} / 中 ${nMid} / 小 ${nSmall} 根 (边界沉海跳过 ${nSunk} · 撞格遮蔽跳过 ${nShadow}) · veins[] 条目 ${veinEntries}`);
if (xcomm) console.log(`  [已知非缺陷] 跨群落中心撞格 ${xcomm} 处 (相邻群落次级灵脉落同格; 见文件头 X)`);
check('中心格 level == 自身 level', badCenter === 0, `异常 ${badCenter}`);
check('从属格 level == CFG.VEIN_SAT_LEVEL (专用从属档)', badSat === 0, `异常 ${badSat}`);
check('大灵脉占地 7/7 (中心 + 六邻 全部有 vein 标记)', bigShort === 0, `缺格 ${bigShort} 根`);
check('中灵脉占地 3/3 (本格 + 西南 + 东南)', midShort === 0, `缺格 ${midShort} 根`);
check('小灵脉无从属 (六邻不出现自己的从属格)', smallExtra === 0, `异常 ${smallExtra} 根`);
check('每群落恒有 1 根大灵脉 (level 0 中心)', noBig === 0, `缺中心 ${noBig} 个群落`);
check('群落内中心不重复', intraDup === 0, `重复 ${intraDup}`);

/* ------------------------------------------------------------------
   D. 前端「地盘彩环」的档位表 (2026-09-16 十四版)
   病灶 (用户原话): 「大灵脉 1 格外面 6 格, 中的是 1 格下面 2 格 —— 但是在显示地上的
   地盘彩环的时候没有对应的另外 6 格和 2 格格子显示」。
   ⇒ 峰体的 7/3/1 十一版就有了 (B 段), 但 main.js 画的**地盘色环只垫了中心 1 格**。
   修法: 偏移表下沉到 web/js/vein-skin.js (VS.footOffsets) —— 引擎就绪时**问引擎**
   (MG.veinFootKeep), 引擎缺席才用镜像表。本段把「镜像表 == 引擎」跨源逐值钉死
   (与 check_faction 里的 SECT_DOMAIN_R 同一手法: 引擎改档而前端没跟 ⇒ 这里必红)。
   ------------------------------------------------------------------ */
console.log('\n== D. 前端地盘环档位 (web/js/vein-skin.js VS.footOffsets) ==');
global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'vein-skin.js'), 'utf8'));
const VS = global.VeinSkin;
const mainSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'main.js'), 'utf8');
const fk = (a) => JSON.stringify(a);
check('D0 VeinSkin.footOffsets 已导出', !!(VS && typeof VS.footOffsets === 'function'), '');
check('D1 偏移池序 == 引擎 NEIGH_SLOTS (0东 1东南 2西南 3西 4西北 5东北)',
  fk(VS.footOff) === fk([[0, 0]].concat(MG.NEIGH_SLOTS)), fk(VS.footOff));
for (const lv of [0, 1, 2, 3]) {
  const mirror = VS.footOffsets(lv);
  const viaMG = VS.footOffsets(lv, MG);
  const eng = RING.filter(([q, r]) => MG.veinFootKeep(lv, q, r));
  check(`D2 [level ${lv}] 镜像表 == 引擎 veinFootKeep`, fk(mirror) === fk(eng),
    `镜像 ${fk(mirror)} vs 引擎 ${fk(eng)}`);
  check(`D3 [level ${lv}] 传引擎时逐值相同`, fk(viaMG) === fk(eng), fk(viaMG));
}
check('D4 中档 = 本格 + 东南(0,1) + 西南(-1,1) (用户说的"下面 2 格")',
  fk(VS.footOffsets(1)) === fk([[0, 0], [0, 1], [-1, 1]]), fk(VS.footOffsets(1)));
check('D5 大档 7 格 / 小档 1 格', VS.footOffsets(0).length === 7 && VS.footOffsets(2).length === 1,
  `${VS.footOffsets(0).length}/${VS.footOffsets(2).length}`);
/* 源码守卫 (防回退): 地盘环必须走档位表; 旧的「只画 v.x,v.y 一格」写法不得复活 */
check('D6 main.js 已接线 VS.footOffsets', /VS\.footOffsets\(\s*v\.level/.test(mainSrc), '');
check('D7 旧「地盘环只画本格」写法已消失',
  mainSrc.indexOf('hexPath(ctx, v.x, v.y, geo.hexR * 0.94)') < 0, '');
check('D8 取数通道齐备 (__feat 暴露 veinRing/veinRings + ?veinprobe=1 出口)',
  /veinRing: statVeinRing, veinRingLv: statVeinRingLv\.slice\(\)/.test(mainSrc) &&
  /veinRings: statVeinRingRows\.slice\(/.test(mainSrc) &&
  /veinprobe=1/.test(mainSrc), '');

/* 采样几根大灵脉, 打印七星方位自检 */
MG.init(SEEDS[0]);
outer:
for (let i = -SPAN; i <= SPAN; i++) {
  for (let j = -SPAN; j <= SPAN; j++) {
    const cm = MG.communityOf(i, j);
    if (!cm) continue;
    for (const v of cm.veins) {
      if (v.level !== 0) continue;
      if (!MG.fields(v.q, v.r).vein) continue;
      const list = [];
      for (let k = 0; k < 6; k++) {
        const f = MG.fields(v.q + RING[k + 1][0], v.r + RING[k + 1][1]);
        list.push(RINGS[k] + (f.vein && f.vein.level === SAT ? ':从属' : f.vein ? ':异脉' : ':-'));
      }
      console.log(`  例 [seed ${SEEDS[0]}] 大灵脉「${v.name}」(${v.q},${v.r}) 六邻 → ${list.join(' ')}`);
      break outer;
    }
  }
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
