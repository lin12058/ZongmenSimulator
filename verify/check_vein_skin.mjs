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
 *   B. 等级契约 (2026-09-14 三轮: 大/中/小 分档)
 *     7. levels 有 3 档, level 序号 == 0/1/2, key == 大/中/小
 *     8. 「大的不变」: levels[0].hScale == shape.hScale 且 hRand == [0.72, 1.00]
 *     9. hScale 严格递减; 每档 hRand 合法 (0<=lo<hi<=1)
 *    10. 视觉高度**严格不重叠**: 大min > 中max, 中min > 小max
 *        (视觉高度倍数 = (3.3 + 1.2*hRand) * hScale)
 *    11. **占地格数** (引擎侧 veinFootKeep): 大=7格(本格+六邻) / 中=3格(本格+下方两格)
 *        / 小=1格; 且三级**嵌套** (小 ⊂ 中 ⊂ 大), 中的额外两格 dr 必须 == +1 (正下方一行)
 *    12. 大档仍高于大世界雪峰最高档 (hScale > 1.55)
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
console.log('\n== 灵脉契约 B: 等级分档 (大/中/小 ↔ level 0/1/2) ==');
const LV = VS.levels;
check('VeinSkin.levels 存在且有 3 档', Array.isArray(LV) && LV.length === 3, `实际 ${LV && LV.length}`);
if (!Array.isArray(LV) || LV.length !== 3) {
  console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
  process.exit(1);
}
check('等级序号 == 0/1/2 且 key == 大/中/小',
  eq(LV.map((l) => l.level), [0, 1, 2]) && eq(LV.map((l) => l.key), ['大', '中', '小']),
  `${LV.map((l) => l.key + l.level).join(' ')}`);

/* 8. 「大的不变」——大档必须与分档前的 shape 值逐项一致 */
check('「大的不变」: levels[0].hScale == shape.hScale', LV[0].hScale === sh.hScale,
  `levels ${LV[0].hScale} / shape ${sh.hScale}`);
check('「大的不变」: levels[0].hRand == [0.72, 1.00]', eq(LV[0].hRand, [0.72, 1.00]), JSON.stringify(LV[0].hRand));

/* 9. hScale 严格递减 + 包络合法 */
check('三档 hScale 严格递减 (大>中>小)',
  LV[0].hScale > LV[1].hScale && LV[1].hScale > LV[2].hScale,
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
console.log('  视觉高度 (uR 倍数) 大 ' + R[0][0].toFixed(2) + '~' + R[0][1].toFixed(2) +
            ' | 中 ' + R[1][0].toFixed(2) + '~' + R[1][1].toFixed(2) +
            ' | 小 ' + R[2][0].toFixed(2) + '~' + R[2][1].toFixed(2) +
            '   (大世界: 山地 ≤5.85 / 雪峰 ≤6.98)');

/* 11. 占地格数 —— 引擎侧 veinFootKeep */
const RING = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];   // d <= 1 的七个偏移
check('引擎导出 veinFootKeep / VEIN_LVL_BELOW', typeof MG.veinFootKeep === 'function' && Array.isArray(MG.VEIN_LVL_BELOW), '');
if (typeof MG.veinFootKeep === 'function') {
  const kept = (lv) => RING.filter(([dq, dr]) => MG.veinFootKeep(lv, dq, dr));
  const k0 = kept(0), k1 = kept(1), k2 = kept(2);
  check('大(0) 占地 = 本格 + 六邻 = 7 格 (原样)', k0.length === 7, `实际 ${k0.length}`);
  check('中(1) 占地 = 本格 + 下方两格 = 3 格', eq(k1, [[0, 0], [0, 1], [-1, 1]]), JSON.stringify(k1));
  check('小(2) 占地 = 仅本格 = 1 格', eq(k2, [[0, 0]]), JSON.stringify(k2));
  check('三级嵌套: 小 ⊂ 中 ⊂ 大', k2.every((c) => k1.some((d) => eq(c, d))) && k1.every((c) => k0.some((d) => eq(c, d))), '');
  const below = k1.filter(([dq, dr]) => !(dq === 0 && dr === 0));
  check('中档的额外两格都在正下方一行 (dr == +1)', below.length === 2 && below.every(([, dr]) => dr === 1),
    JSON.stringify(below));
  check('「下方两格」== tileToWorld 的 r+1 方向 ([0,1] / [-1,1])', eq(MG.VEIN_LVL_BELOW, [[0, 1], [-1, 1]]), JSON.stringify(MG.VEIN_LVL_BELOW));
}

/* 12. 大档仍高于大世界雪峰最高档 (1.55) */
check('大档 hScale > 1.55 (灵脉高于大世界雪峰最高档)', LV[0].hScale > 1.55, String(LV[0].hScale));
check('中档 hScale > 1.55 (中灵脉亦高于雪峰档位倍率)', LV[1].hScale > 1.55, String(LV[1].hScale));

/* 信息: 解出屏幕方框的 W/H (renderer.js PROP_VS 的公式), 提示是否近似正方 */
const h2 = 0.5;
const W = 3.4641016 * (1.55 + 0.65 * h2) * (0.82 + 0.22 * sh.hScale) * sh.wScale;
const H = (3.3 + 1.2 * 0.5) * sh.hScale;
console.log(`  屏幕方框 (大档, hash 中位): W/H = ${(W / H).toFixed(3)} (1.00 = 正方, 山形不被横向拉宽)`);

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
