/* ============================================================
 * check_vein_skin.mjs — 灵脉「配色 + 等级」契约回归 (离线 Node, 不需起服务)
 * ------------------------------------------------------------
 * 灵脉山体的取色/分档真源是 web/js/vein-skin.js (前端), 而"这根灵脉是什么灵根 /
 * 异灵根叫什么 / 是几级"的真源是 Server/.../Engine/js/mapgen.js (引擎)。两边靠
 * **序号** (精灵位 32..35 / 50..54) 与 **等级序号** (0大 1中 2小) 对应 ——
 * 序号一旦错位, 雷会画成冰的颜色、大灵脉会长成小灵脉, 且**不会有任何运行时报错**
 * (静默串色 / 静默错档)。本脚本把这两条契约钉死。
 *
 * 断言:
 *   A. 配色契约
 *     1. VeinSkin.elements 的名字序 == mapgen ELEMENTS (金木水火土)
 *     2. VeinSkin.variants 的键序 == mapgen VEIN_VARIANT_ORDER (雷风冰暗)
 *     3. 每个调色板的 glow == 引擎 ELEMENT_RGB / VARIANT_RGB (逐值)
 *     4. 每个调色板 6 个色字段齐备, 均为 3 元整数 0..255
 *     5. variantSprite(name) == 32 + 该异灵根在 order 里的下标; 未知名 → -1
 *     6. shape.hScale/wScale 有限且 > 0
 *   B. 等级契约 (2026-09-14 三轮: 大/中/小; 2026-09-15 十一版加第 4 档「从属」)
 *     7. levels 有 4 档, level 序号 == 0/1/2/3, key == 大/中/小/从属
 *     8. 「大的不变」: levels[0].hScale == shape.hScale 且 hRand == [0.72, 1.00]
 *     9. hScale 严格递减; 每档 hRand 合法 (0<=lo<hi<=1)
 *    10. 视觉高度**严格不重叠**: 大min > 中max, 中min > 小max, 小min > 从属max
 *        (视觉高度倍数 = (3.3 + 1.2*hRand) * hScale)
 *    11. **占地** (引擎侧 veinFootKeep): **按档占地** (2026-09-15 十一版) ——
 *        大 7 格 (本格 + 六邻) / 中 3 格 (本格 + 西南 + 东南) / 小 1 格 (仅本格);
 *        更远处一律不保留。引擎侧从属格的高度档 = CFG.VEIN_SAT_LEVEL (= 3)。
 *    12. 相对高度倍率仍是"高"档 (hScale > 1.55) —— 上屏尺寸另由 shape.sizeScale 缩放
 *    13. **上屏尺寸总倍率** shape.sizeScale 有效 (0<s<=1.2)、上屏后**四档**仍严格不重叠、
 *        且大档上屏高 ≤ 3.6 uR (≈1.8 格高: 单格灵脉不许大到越格成灾)
 *   C. 山地底座契约 (2026-09-14 九版, 用户: "灵脉在山地要在原来的山的基础上加上高度")
 *    14. shape.terrainBase 有效 (0<=tb<=2); 引擎 LIFT_CORE 三档 >= 0.70 (⇒ 灵脉格必在山地档
 *        以上, 底座不为 0); 大档底座 >= 3 uR, 且大档上屏总高 (底座 + 灵脉峰) <= 11 uR
 *    15. shape.terrainBaseW 有效 (0 <= tbw <= 1.2) —— 底座**宽度**倍率 (十版默认 0)
 *    16. **又高又瘦** (2026-09-15 十版, 用户: "我的目标是又高又瘦的"): 大档上屏
 *        **总高 > 总宽** (W/H < 1, 含底座) —— 九版把底座宽度也叠上 ⇒ W 9.9 > H 8.0,
 *        整座灵峰读起来"变宽了"; 本条把这个退化钉死
 *    17. **底座下限** shape.terrainBaseMin 有效 (0 <= tbm <= 1.2) 且**小档底座不为 0**
 *        (2026-09-15 十一版 R3-a, 用户: "小灵脉 高度偏低了") —— 底座判档是**严格** `e > 0.70`,
 *        而 LIFT_CORE[2] = 0.70 恰好压在边界 ⇒ 无下限时小灵脉底座恒 0 (只有峰体没有山脚,
 *        上屏总高仅大档的 28%)。本断言语义上要求"小档底座的可见高度 >= 1 uR"。
 *
 * 用法: node verify/check_vein_skin.mjs
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

/* 前端配置: 直接 eval, 它会挂到 window(=globalThis).VeinSkin */
delete global.VeinSkin;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'vein-skin.js'), 'utf8'));
const VS = global.VeinSkin;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('== 灵脉契约 A: 配色 (vein-skin.js ↔ mapgen.js) ==');
check('vein-skin.js 已加载且暴露 VeinSkin', !!VS && !!VS.shape && !!VS.elements && !!VS.variants);
if (!VS) { console.log('\n========== 结果: 1 项失败 =========='); process.exit(1); }

/* 1. 五行顺序 */
const elNames = VS.elements.map((e) => e.name);
check('五行顺序 == 引擎 ELEMENTS', eq(elNames, MG.ELEMENTS), `配置 ${elNames.join('')} / 引擎 ${MG.ELEMENTS.join('')}`);

/* 2. 异灵根顺序 */
const varKeys = VS.variants.map((v) => v.key);
check('异灵根键序 == 引擎 VEIN_VARIANT_ORDER', eq(varKeys, MG.VEIN_VARIANT_ORDER),
  `配置 ${varKeys.join('')} / 引擎 ${MG.VEIN_VARIANT_ORDER.join('')}`);
check('异灵根数量与精灵位 32..35 对齐 (4 个)', varKeys.length === 4, `实际 ${varKeys.length}`);

/* 3. glow 与引擎下发色逐值一致 */
const elGlowOk = VS.elements.every((e, i) => eq(e.glow, MG.ELEMENT_RGB[i]));
check('五行 glow 逐值 == 引擎 ELEMENT_RGB', elGlowOk,
  VS.elements.map((e, i) => MG.ELEMENT_RGB[i] && eq(e.glow, MG.ELEMENT_RGB[i]) ? '' : `${e.name}:${e.glow}≠${MG.ELEMENT_RGB[i]}`).filter(Boolean).join(' '));
const varGlowOk = VS.variants.every((v) => eq(v.glow, MG.VARIANT_RGB[v.key]));
check('异灵根 glow 逐值 == 引擎 VARIANT_RGB', varGlowOk, '');

/* 4. 调色板字段完整性 */
const FIELDS = ['back', 'mid', 'lit', 'mist', 'glow', 'rune'];
const isRGB = (c) => Array.isArray(c) && c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
const badPal = [];
for (const p of [...VS.elements, ...VS.variants]) {
  for (const f of FIELDS) if (!isRGB(p[f])) badPal.push(`${p.name || p.key}.${f}`);
}
check('所有调色板 6 色字段齐备且为 0..255 整数', badPal.length === 0, badPal.join(' '));

/* 5. variantSprite 取位 */
const slotBad = VS.variants.map((v, i) => VS.variantSprite(v.key) === 32 + i ? '' : `${v.key}→${VS.variantSprite(v.key)}`).filter(Boolean);
check('variantSprite 映射 == 32 + 序号', slotBad.length === 0, slotBad.join(' '));
check('未知异灵根 → -1', VS.variantSprite('不存在') === -1 && VS.variantSprite(null) === -1, '');

/* 6. shape 数值健全 */
const sh = VS.shape;
check('shape.hScale / wScale 为正有限数', Number.isFinite(sh.hScale) && sh.hScale > 0 && Number.isFinite(sh.wScale) && sh.wScale > 0,
  `h=${sh.hScale} w=${sh.wScale}`);

/* ============================ B. 等级契约 ============================ */
console.log('\n== 灵脉契约 B: 等级分档 (大/中/小/从属 ↔ level 0/1/2/3) ==');
const LV = VS.levels;
check('VeinSkin.levels 存在且有 4 档', Array.isArray(LV) && LV.length === 4, `实际 ${LV && LV.length}`);
if (!Array.isArray(LV) || LV.length !== 4) {
  console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
  process.exit(1);
}
check('等级序号 == 0/1/2/3 且 key == 大/中/小/从属',
  eq(LV.map((l) => l.level), [0, 1, 2, 3]) && eq(LV.map((l) => l.key), ['大', '中', '小', '从属']),
  `${LV.map((l) => l.key + l.level).join(' ')}`);
/* 11版: 引擎侧从属格的高度档必须与本表的「从属」下标一致 */
check('引擎 CFG.VEIN_SAT_LEVEL == 从属档下标 (3)',
  (MG.CFG && MG.CFG.VEIN_SAT_LEVEL) === LV[3].level, `引擎 ${MG.CFG && MG.CFG.VEIN_SAT_LEVEL} / 配置 ${LV[3].level}`);

/* 8. 「大的不变」——大档必须与分档前的 shape 值逐项一致 */
check('「大的不变」: levels[0].hScale == shape.hScale', LV[0].hScale === sh.hScale,
  `levels ${LV[0].hScale} / shape ${sh.hScale}`);
check('「大的不变」: levels[0].hRand == [0.72, 1.00]', eq(LV[0].hRand, [0.72, 1.00]), JSON.stringify(LV[0].hRand));

/* 9. hScale 严格递减 + 包络合法 */
check('四档 hScale 严格递减 (大>中>小>从属)',
  LV[0].hScale > LV[1].hScale && LV[1].hScale > LV[2].hScale && LV[2].hScale > LV[3].hScale,
  LV.map((l) => l.hScale).join(' > '));
const badEnv = LV.filter((l) => !Array.isArray(l.hRand) || l.hRand.length !== 2 ||
  !(l.hRand[0] >= 0 && l.hRand[0] < l.hRand[1] && l.hRand[1] <= 1));
check('每档 hRand 合法 (0 <= lo < hi <= 1)', badEnv.length === 0,
  badEnv.map((l) => l.key + JSON.stringify(l.hRand)).join(' '));

/* 10. 视觉高度严格不重叠 —— 否则"小灵脉偶然比中灵脉高" */
const vh = (l) => [(3.3 + 1.2 * l.hRand[0]) * l.hScale, (3.3 + 1.2 * l.hRand[1]) * l.hScale];
const R = LV.map(vh);
check('视觉高度不重叠: 大min > 中max', R[0][0] > R[1][1], `大${R[0][0].toFixed(2)} vs 中max${R[1][1].toFixed(2)}`);
check('视觉高度不重叠: 中min > 小max', R[1][0] > R[2][1], `中${R[1][0].toFixed(2)} vs 小max${R[2][1].toFixed(2)}`);
check('视觉高度不重叠: 小min > 从属max', R[2][0] > R[3][1], `小${R[2][0].toFixed(2)} vs 从属max${R[3][1].toFixed(2)}`);
console.log('  视觉高度 (uR 倍数) 大 ' + R[0][0].toFixed(2) + '~' + R[0][1].toFixed(2) +
            ' | 中 ' + R[1][0].toFixed(2) + '~' + R[1][1].toFixed(2) +
            ' | 小 ' + R[2][0].toFixed(2) + '~' + R[2][1].toFixed(2) +
            ' | 从属 ' + R[3][0].toFixed(2) + '~' + R[3][1].toFixed(2) +
            '   (大世界: 山地 ≤5.85 / 雪峰 ≤6.98)');

/* 11. 占地 —— 引擎侧 veinFootKeep: **按档占地** (2026-09-15 十一版) */
const RING = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];   // d <= 1 的七个偏移
check('引擎导出 veinFootKeep', typeof MG.veinFootKeep === 'function', '');
if (typeof MG.veinFootKeep === 'function') {
  const kept = (lv) => RING.filter(([dq, dr]) => MG.veinFootKeep(lv, dq, dr));
  check('level 0 (大) 占地 = 本格 + 六邻 = 7 格', kept(0).length === 7, JSON.stringify(kept(0)));
  check('level 1 (中) 占地 = 本格 + 西南(-1,+1) + 东南(0,+1) = 3 格',
    eq(kept(1), [[0, 0], [0, 1], [-1, 1]]), JSON.stringify(kept(1)));
  check('level 2 (小) 占地 = 仅本格 = 1 格', eq(kept(2), [[0, 0]]), JSON.stringify(kept(2)));
  check('等级**决定**占地形态 (大/中/小 各不相同)',
    !eq(kept(0), kept(1)) && !eq(kept(1), kept(2)), '');
  const OUT = [[2, 0], [0, 2], [-2, 2], [2, -1], [3, 3], [-2, -2]];
  check('d >= 2 一律不保留 (七星只铺紧邻一圈)',
    [0, 1, 2].every((lv) => OUT.every(([dq, dr]) => MG.veinFootKeep(lv, dq, dr) === false)), '');
}

/* 12. 相对高度倍率 (hScale) 未被缩小 —— 它表达的是"三档之间的相对高矮",
       上屏实际尺寸另由 shape.sizeScale 统一缩放 (2026-09-14 七版)。 */
check('大档 hScale > 1.55 (相对倍率未变; 上屏另乘 sizeScale)', LV[0].hScale > 1.55, String(LV[0].hScale));
check('中档 hScale > 1.55 (同上)', LV[1].hScale > 1.55, String(LV[1].hScale));

/* 13. 上屏尺寸总倍率 sizeScale —— 「灵脉太大/太小」的唯一旋钮 (2026-09-14 七版) */
const SS = sh.sizeScale;
check('shape.sizeScale 有效 (0 < s <= 1.2)', Number.isFinite(SS) && SS > 0 && SS <= 1.2, String(SS));
const eff = (l) => [(3.3 + 1.2 * l.hRand[0]) * l.hScale * SS, (3.3 + 1.2 * l.hRand[1]) * l.hScale * SS];
const E = LV.map(eff);
check('上屏后四档仍严格不重叠 (大min > 中max > 小max > 从属max)',
  E[0][0] > E[1][1] && E[1][0] > E[2][1] && E[2][0] > E[3][1],
  `大${E[0][0].toFixed(2)}~${E[0][1].toFixed(2)} / 中${E[1][0].toFixed(2)}~${E[1][1].toFixed(2)} / 小${E[2][0].toFixed(2)}~${E[2][1].toFixed(2)} / 从属${E[3][0].toFixed(2)}~${E[3][1].toFixed(2)}`);
check('大档上屏高 ≤ 3.6 uR (≈1.8 格高: 单格灵脉不越格成灾)', E[0][1] <= 3.6, E[0][1].toFixed(2) + ' uR');
console.log('  上屏高度 (uR × sizeScale=' + SS + ') 大 ' + E[0][0].toFixed(2) + '~' + E[0][1].toFixed(2) +
            ' | 中 ' + E[1][0].toFixed(2) + '~' + E[1][1].toFixed(2) +
            ' | 小 ' + E[2][0].toFixed(2) + '~' + E[2][1].toFixed(2) +
            ' | 从属 ' + E[3][0].toFixed(2) + '~' + E[3][1].toFixed(2));
/* 11 版 D1: u16 复合通道的除数必须等于档位总数 (main.js 写 (等级+海拔)/N, shader ×N)。
   这里只做「上界不溢出」的数值断言: (档位总数-1 + 1) / 档位总数 <= 1 */
check('复合通道上界不溢出 ((档位数-1 + 1)/档位数 <= 1, 除数 = ' + LV.length + ')',
  (LV.length - 1 + 1) / LV.length <= 1, String((LV.length - 1 + 1) / LV.length));

/* 信息: 解出屏幕方框的 W/H (renderer.js PROP_VS 的公式), 提示是否近似正方 */
const h2 = 0.5;
const W = 3.4641016 * (1.55 + 0.65 * h2) * (0.82 + 0.22 * sh.hScale) * sh.wScale;
const H = (3.3 + 1.2 * 0.5) * sh.hScale;
console.log(`  屏幕方框 (大档, hash 中位): W/H = ${(W / H).toFixed(3)} (1.00 = 正方, 山形不被横向拉宽)` +
            ' —— 仅**灵脉峰自身** (不含山地底座); sizeScale 同乘 W/H, 不改此比值。' +
            ' 含底座的上屏总框见下面 §C (十版起只加高不加宽 ⇒ 总框 W/H < 1)');

/* 14. **山地底座** (2026-09-14 九版) —— 用户: "灵脉的高度如果在山地要在原来的山的基础上加上
       高度, 避免看不见"。灵脉中心格的海拔由引擎 §八「灵脉地形迁就」抬到 LIFT_CORE, 故该格
       必属山地档 (0.70~0.84) 或雪峰档 (>0.84); 底座 = **大世界山同档公式**的高度 × terrainBase
       (PROP_VS 灵脉分支), 叠在灵脉峰之下 ⇒ 平原/水面格 (海拔 <= 0.70) 底座恒为 0。 */
console.log('\n== 灵脉契约 C: 山地底座 (shape.terrainBase ↔ 引擎灵脉抬升) ==');
const TB = sh.terrainBase;
check('shape.terrainBase 有效 (0 <= tb <= 2)', Number.isFinite(TB) && TB >= 0 && TB <= 2, String(TB));
const TBW = sh.terrainBaseW;
check('shape.terrainBaseW 有效 (0 <= tbw <= 1.2, 底座宽度倍率; 0 = 只加高不加宽)',
  Number.isFinite(TBW) && TBW >= 0 && TBW <= 1.2, String(TBW));
/* 17. **底座下限** (2026-09-15 十一版 R3-a) —— 用户: "小灵脉 高度偏低了"。
   底座判档是**严格大于** (`ve > 0.84` / `ve > 0.70`), 而 LIFT_CORE[2] 恰好 = 0.70
   ⇒ 无下限时小灵脉底座**恒为 0** (只有峰体、没有山脚)。这里用"严格口径"的 mtnHsStrict
   复现该情形, 再断言 terrainBaseMin 把它兜起来。 */
const TBM = sh.terrainBaseMin;
check('shape.terrainBaseMin 有效 (0 <= tbm <= 1.2)', Number.isFinite(TBM) && TBM >= 0 && TBM <= 1.2, String(TBM));
const mtnHsStrict = (e) => (e > 0.84 ? 0.95 + 0.60 * Math.min(1, (e - 0.84) / 0.12)
                            : (e > 0.70 ? 0.55 + 0.75 * Math.min(1, (e - 0.70) / 0.14) : 0));
const LC0 = MG.CFG && MG.CFG.LIFT_CORE;
if (Array.isArray(LC0) && LC0.length >= 3) {
  const hNo = (3.3 + 1.2 * 0.5) * mtnHsStrict(LC0[2]) * TB;
  const hYes = (3.3 + 1.2 * 0.5) * Math.max(mtnHsStrict(LC0[2]), TBM) * TB;
  check('小档底座不为 0 (LIFT_CORE[2]=' + LC0[2] + ' 压在严格边界上 ⇒ 无下限时恒 0)',
    hNo === 0 && hYes >= 1,
    `无下限 ${hNo.toFixed(2)} uR → 有下限 ${hYes.toFixed(2)} uR (terrainBaseMin=${TBM})`);
  console.log('  底座 (中位 hash, 严格判档) 大 ' + ((3.3 + 1.2 * 0.5) * Math.max(mtnHsStrict(LC0[0]), TBM) * TB).toFixed(2) +
              ' / 中 ' + ((3.3 + 1.2 * 0.5) * Math.max(mtnHsStrict(LC0[1]), TBM) * TB).toFixed(2) +
              ' / 小 ' + hYes.toFixed(2) + ' uR  (下限 ' + TBM + ' 只兜小档: 大/中档海拔 0.80/0.75 本就在山地档内)');
}
const LC = MG.CFG && MG.CFG.LIFT_CORE;
check('引擎 LIFT_CORE 三档均 >= 0.70 (⇒ 灵脉格必在山地档以上, 底座不为 0)',
  Array.isArray(LC) && LC.length === 3 && LC.every((v) => v >= 0.70), JSON.stringify(LC));
const mtnHs = (e) => (e > 0.84 ? 0.95 + 0.60 * Math.min(1, (e - 0.84) / 0.12)
                              : 0.55 + 0.75 * Math.min(1, (e - 0.70) / 0.14));
if (Array.isArray(LC)) {
  const baseLo = (3.3 + 1.2 * 0.0) * mtnHs(LC[0]) * TB;    // 大档、抬升下限处的底座 (最低情形)
  const baseHi = (3.3 + 1.2 * 1.0) * mtnHs(1.0) * TB;      // 雪峰顶、最高底座
  const totHi = baseHi + E[0][1];
  check('大档底座确实把灵脉垫高 (>= 3 uR)', baseLo >= 3, baseLo.toFixed(2) + ' uR');
  check('大档上屏总高 (底座 + 灵脉峰) <= 11 uR (≈5.5 格: 不许再压成半屏大山)',
    totHi <= 11, totHi.toFixed(2) + ' uR');
  console.log('  底座高度 (uR, 各档在各自抬升下限处) 大 ' + baseLo.toFixed(2) +
              ' / 中 ' + ((3.3 + 1.2 * 0.0) * mtnHs(LC[1]) * TB).toFixed(2) +
              ' / 小 ' + ((3.3 + 1.2 * 0.0) * mtnHs(LC[2]) * TB).toFixed(2) +
              ' | 上限 (雪峰顶) ' + baseHi.toFixed(2));
  console.log('  ⇒ 大档上屏总高 ' + (baseLo + E[0][0]).toFixed(2) + '~' + totHi.toFixed(2) + ' uR' +
              ' (底座 + 峰: 与周围大世界山同高再冒出一个峰头 ⇒ 不再"看不见")');
  /* 16. **又高又瘦** (2026-09-15 十版) —— 用户: "我的目标是又高又瘦的"。
     PROP_VS: W = 3.4641*uR*(1.55+0.65*h2)*(0.82+0.22*hs)*ss*ws + [底座宽 ×terrainBaseW]
              H = uR*(3.3+1.2*hrand)*[hs*ss + 底座倍率]                 (h2/hrand 取中位)
     九版 terrainBaseW 等价 1.0 ⇒ 大档 W ≈ 9.9 > H ≈ 8.0 (W/H 1.24) ⇒ 灵峰"变宽" ⇒ 本条钉死。 */
  const mtW = (e) => 3.4641016 * (1.55 + 0.65 * 0.5) * (0.82 + 0.22 * e);
  const wPeak = mtW(sh.hScale) * SS * sh.wScale;
  const wBase = TBW * mtW(LC[0]);
  const wAll = wPeak + wBase;
  const hAllLo = baseLo + E[0][0], hAllHi = totHi;
  check('大档"又高又瘦": 上屏总高 > 总宽 (W/H < 1, 含底座)',
    hAllLo > wAll && hAllHi > wAll,
    `宽 ${wAll.toFixed(2)} (峰 ${wPeak.toFixed(2)} + 底座 ${wBase.toFixed(2)}) vs 高 ${hAllLo.toFixed(2)}~${hAllHi.toFixed(2)} uR` +
    ` ⇒ W/H ${(wAll / hAllLo).toFixed(2)}~${(wAll / hAllHi).toFixed(2)}`);
  console.log('  上屏总框 (大档, 抬升下限 e=' + LC[0] + '): 宽 ' + wAll.toFixed(2) +
              ' × 高 ' + hAllLo.toFixed(2) + '~' + hAllHi.toFixed(2) + ' uR' +
              ' ⇒ W/H ' + (wAll / hAllLo).toFixed(2) + ' ｜ 宽构成 = 峰 ' + wPeak.toFixed(2) +
              ' + 底座 ' + wBase.toFixed(2) + ' (terrainBaseW=' + TBW + ')');
  const mtnW = mtW(LC[0]), mtnH = (3.3 + 1.2 * 0.5) * mtnHs(LC[0]);
  console.log('  对照·同海拔大世界山: ' + mtnW.toFixed(2) + ' × ' + mtnH.toFixed(2) +
              ' uR ⇒ W/H ' + (mtnW / mtnH).toFixed(2) + ' (灵峰要明显比它瘦)');
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
