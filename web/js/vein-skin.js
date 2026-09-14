/* ============================================================
 * vein-skin.js — 灵脉山体「配色 + 造型」配置 (唯一真源)
 * ------------------------------------------------------------
 * 想换灵脉山体的颜色/造型, **只改本文件**, 不必碰 textures.js / renderer.js。
 *
 * 【谁在读它】
 *   · web/js/textures.js  —— 逐个灵脉峰的**精灵绘制** (五行色 / 异灵根色)
 *   · web/js/renderer.js  —— PROP_VS 里灵脉峰的**屏幕高度/宽度倍率**
 *                            (levels[i].hScale / shape.wScale; 越大越高)
 *   · web/js/main.js      —— 灵脉名牌敷色
 *   ⇒ index.html 中必须**在 textures.js 之前**加载本文件。
 *
 * 【与引擎的契约 (改这里必须同步改那边; 有回归脚本断言)】
 *   · elements 的**顺序** == mapgen.js 的 ELEMENTS = ['金','木','水','火','土']
 *     ⇒ 精灵位 = 50 + 元素序 (图集第 6 行 2..6 列)
 *   · variants 的**键序** == mapgen.js 的 VEIN_VARIANT_ORDER = ['雷','风','冰','暗']
 *     ⇒ 精灵位 = 32 + 异灵根序 (图集第 4 行 0..3 列)
 *   · levels 的**下标** == mapgen.js 的 veins[].level (0大 / 1中 / 2小)
 *     ⇒ 本文件的 levels 只管**高度**; **占地**在引擎 mapgen.js veinFootKeep() (三档同本格)
 *   · 契约断言: verify/check_vein_skin.mjs / verify/w5_sprite_range.mjs
 *
 * 【怎么加一种新灵气或异灵根】
 *   1) 在 elements / variants 里**末尾追加**一条;
 *   2) mapgen.js 的 ELEMENTS / VEIN_VARIANT_ORDER 同样末尾追加同名;
 *   3) 精灵位不够用图集第 4 行剩余列 (36..39 仍空置, 见 textures.js buildAtlas);
 *   4) 跑 check_vein_skin + w5_sprite_range 确认契约。
 *
 * 【配色口径 (水墨)】
 *   back  背光面 / 山脊最暗处       → 拉开体量
 *   mid   山体主色                  → 决定"这座山是什么颜色"
 *   lit   受光面 (左坡)             → 与 back 成对
 *   mist  云气 / 山脚云断           → 氤氲感**只能来自这里**, 不能靠洗白山体
 *   glow  灵气色 (敷色晕 / 游丝 / 名牌) — 即引擎下发的 elementRGB / variantRGB
 *   rune  符纹色 (提亮后的 glow, 压在山体上看得清又不刺眼)
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 造型 (屏幕比例由 renderer.js PROP_VS 使用) ---------- */
  var SHAPE = {
    /* ⚠ 这两个是**屏幕方框**的倍率, 不是精灵内的画法。
       PROP_VS 把整个 128 格非等比映射到 W×H 方框:
         H = uR * (3.3 + 1.2*hash) * hScale
         W = uR * 3.464 * (1.55 + 0.65*hash) * (0.82 + 0.22*hScale) * wScale
       大世界山 hScale ∈ [0.55, 1.30] (山地) / [0.95, 1.55] (雪峰) ——
       **灵脉峰必须高于 1.55**, 否则在雪岭里认不出来 (实测 seed 74 的雷灵脉
       就淹没在同高的雪峰群里)。当前 1.90 ⇒ 比大世界最高档再高 ~23%。
       hScale/wScale 解出的 W/H ≈ 1.03 (近正方, 六版把 wScale 由 0.82 提到 0.95
       ⇒ 山体更宽, 对齐「宽顶块面」参考图)。想整体等比放大就两个同改 (保持 W/H)。
       ⚠ 分档后**高度倍率以 LEVELS 为准** (大/中/小各一档); 此处的 hScale 是
         「大」档的值, 同时充当 renderer.js 读不到 levels 时的兜底 ——
         必须与 LEVELS[0].hScale 一致 (check_vein_skin.mjs 断言)。 */
    hScale: 1.90,
    wScale: 0.95,
    /* ⚠ **上屏尺寸总倍率** (2026-09-14 七版新增): PROP_VS 里只对**灵脉峰**再乘一次,
       W 与 H **同乘** ⇒ 比值 W/H 不变、三档高矮关系不变, 相当于整座灵峰等比缩放。
       0.40 = 缩到六版的 40%。六版上屏高 ≈ 8.2 uR ≈ 4 格高 —— 在「单格占地」之后
       显得庞大到压掉半屏 (实测 zm=6 时峰体占 517×479px), 故整体收小。
       ⇒ **这是唯一的"灵脉大小"旋钮**, 想整体放大/缩小只改这一个数。
       ⚠ 已知代价: 缩小后灵脉**不再**恒高于大世界雪峰 (雪峰最高 6.98 uR), 识别改由
         「灵气晕圈 + 名牌 + 单格独立」承担, 不再靠"谁最高"。
       0.40 时上屏高: 大 3.16~3.42 | 中 2.74~2.84 | 小 2.03~2.17 (uR 倍数)。
       check_vein_skin.mjs 断言其有效、且大档上屏高 ≤ 3.6 uR。 */
    sizeScale: 0.40,

    /* ⚠ **山地底座** (2026-09-14 九版新增): 灵脉必落在被抬升过的山地上 (引擎 §八
       「灵脉地形迁就」: 灵脉中心格海拔被抬到 LIFT_CORE = [0.80,0.75,0.70]), 而该格的
       「格底山」精灵被灵脉峰替换 ⇒ 缩到 40% 后峰体**矮于周围大山**, 在群山里"看不见"。
       本旋钮把**该格真实海拔对应的那层山**垫在灵脉峰之下:
         上屏高 H = uR*(3.3+1.2*hash)*底座倍率 + uR*(3.3+1.2*hash)*hs*sizeScale
       底座用的是**大世界山同款公式** (海拔 0.70~0.84 山地档 / >0.84 雪峰档), 故平原格
       (海拔 < 0.70, 例如水中孤峰) 底座自动为 0 —— 只影响山地, 不影响平原上的小灵脉。
       1.0 = 完全按「原来的山」叠加 (用户 2026-09-14 要求); 0 = 关闭 (回到七版行为)。
       ⚠ 底座不参与分档: 等级仍只由 levels[] 决定 (底座是"地形", 不是"灵脉")。 */
    terrainBase: 1.0,

    /* 精灵内的画法 (TILE=128 坐标系; 上屏由 PROP_VS 拉到 W×H 方框)
       —— 2026-09-14 六版「宽顶缓坡块面」: 对齐美术参考图 (宽而圆的顶 + 两肩 +
       缓坡 + **下半截化进地形**), 废弃五版的「折线尖锥 + 硬切底边」。 */
    cell: {
      mainCx: 66, mainBase: 118, mainW: 100, mainH: 96,   // 主峰 (右, 高; 底座铺满 16..116)
      subCx: 30, subBase: 116, subW: 52, subH: 52         // 副峰 (左, 矮)
    },
    topW: 0.30,    // 顶部台面宽度 (占 w): 0.30 ⇒ 宽圆顶 (0.44 会读成"梯形台")
    seg: 11,       // 每坡采样段数 (越大坡面越圆滑)
    topSeg: 7,     // 顶台采样段数 (顶面微隆)
    fade: 0.50,    // 底部渐隐起点 (0=峰顶 1=山脚): 0.50 ⇒ 自山腰起下半截化开进地形
    miDian: 12     // 米点皴点数
  };

  /* ---------- 灵脉等级 (大 / 中 / 小) ----------
     等级真源在引擎 (mapgen.js 的 veins[].level: 0=大 1=中 2=小)。本表只管**屏幕高度**;
     **占地**由引擎 mapgen.js veinFootKeep() 决定 —— **三档一律只占本格** (2026-09-14
     六版): 灵脉是「一根独立的灵峰」, 不是山脉群 (早先按等级铺 7/3/1 格会连成一片
     「三角形山」)。两边共同构成「等级契约」, 由 verify/check_vein_skin.mjs 逐档断言。

       ⇒ **等级只影响高度, 不影响占地。**

     hScale  高度倍率 (PROP_VS: H = uR*(3.3 + 1.2*hash) * hScale)
     hRand   [lo,hi] **收窄**的高度随机包络 —— 灵脉要在同 hash 下恒高于大世界山,
             所以不能用全域 [0,1]; 越小的灵脉包络越靠下, 保证「等级越高越显眼」
             在随机抖动下依然成立 (否则小灵脉偶然比中灵脉高)。

     相对高度 (uR 倍数, **未乘 shape.sizeScale**) = (3.3 + 1.2*hRand) * hScale:
       大 7.91~8.55 | 中 6.85~7.11 | 小 5.08~5.43
       大世界参考: 山地 (40/41/56/57) ≤ 5.85, 雪峰 (42/43/58/59) ≤ 6.98
     ⇒ 三档**相对**关系恒成立: 大 > 中 > 小, 且两两不重叠。
     ⚠ 七版起上屏还要再乘 shape.sizeScale (0.40): 大 3.16~3.42 / 中 2.74~2.84 /
       小 2.03~2.17 ⇒ 已低于雪峰 —— 这是「缩小到 40%」的**有意代价**, 见 sizeScale 注释。
     ⚠ 九版起灵脉格还会**叠加「山地底座」** (shape.terrainBase): 该格真实海拔对应的山体
       高度垫在下面, 故山地上屏高 ≈ 底座山 (1.8~7.0) + 本表高度 —— 详见 terrainBase 注释。
       本表的"三档严格递减"只约束**灵脉峰自身**那一半, 与底座无关 (底座由海拔决定)。
     ⚠ 三级必须**严格递减且不重叠**: 大 min > 中 max > 小 max (脚本断言)。
     ⚠ shape.hScale 是「大」档的值, 二者必须一致 (脚本断言)。 */
  var LEVELS = [
    { key: '大', level: 0, hScale: 1.90, hRand: [0.72, 1.00] },
    { key: '中', level: 1, hScale: 1.58, hRand: [0.86, 1.00] },
    { key: '小', level: 2, hScale: 1.22, hRand: [0.72, 0.96] }
  ];

  /* ---------- 五行 (顺序 == 引擎 ELEMENTS: 0金 1木 2水 3火 4土) ----------
     ⚠ glow 必须**逐值等于**引擎的 ELEMENT_RGB (mapgen.js) —— 它是下发给前端的
       灵根色, 灵脉晕圈/名牌/峰上敷色共用一套; 不一致会出现"山是青色、圈是绿色"。
       契约断言: verify/check_vein_skin.mjs */
  var ELEMENTS = [
    { key: 'metal', name: '金',
      back: [70, 58, 32], mid: [142, 120, 68], lit: [216, 198, 150], mist: [238, 232, 212],
      glow: [196, 176, 120], rune: [242, 230, 182] },
    { key: 'wood', name: '木',
      back: [36, 58, 38], mid: [84, 118, 68], lit: [166, 190, 138], mist: [220, 232, 206],
      glow: [104, 140, 86], rune: [192, 224, 170] },
    { key: 'water', name: '水',
      back: [32, 48, 72], mid: [76, 106, 140], lit: [164, 188, 210], mist: [214, 228, 238],
      glow: [86, 116, 142], rune: [178, 208, 234] },
    { key: 'fire', name: '火',
      back: [74, 28, 20], mid: [154, 64, 42], lit: [218, 146, 108], mist: [240, 212, 192],
      glow: [176, 72, 50], rune: [246, 192, 142] },
    { key: 'earth', name: '土',
      back: [62, 46, 28], mid: [128, 100, 66], lit: [204, 178, 138], mist: [232, 220, 200],
      glow: [152, 120, 82], rune: [228, 202, 154] }
  ];

  /* ---------- 异灵根 (键序 == 引擎 VEIN_VARIANT_ORDER = 雷风冰暗) ----------
     ⚠ glow 必须逐值等于引擎的 VARIANT_RGB。 */
  var VARIANTS = [
    { key: '雷', back: [48, 28, 76], mid: [116, 74, 158], lit: [196, 174, 228], mist: [232, 222, 244],
      glow: [142, 96, 190], rune: [216, 192, 246] },
    { key: '风', back: [42, 60, 62], mid: [102, 134, 130], lit: [184, 206, 200], mist: [226, 236, 232],
      glow: [118, 150, 148], rune: [202, 224, 216] },
    { key: '冰', back: [40, 62, 90], mid: [114, 152, 184], lit: [206, 228, 242], mist: [234, 244, 250],
      glow: [136, 168, 192], rune: [218, 238, 250] },
    { key: '暗', back: [22, 18, 30], mid: [72, 60, 90], lit: [146, 136, 166], mist: [210, 206, 218],
      glow: [96, 84, 110], rune: [178, 166, 198] }
  ];

  /* 相冲/相合 → 异灵根。键用**引擎侧的元素序号对** (与 mapgen.js 的 DUAL 同键),
     纯文档/校验用 —— 实际选根在引擎, 前端只按名字取色。 */
  var DUAL = { '0|3': '雷', '1|2': '风', '0|2': '冰', '3|4': '暗' };

  /* ---------- 取色器 ---------- */
  function toRGB(c) { return [c[0], c[1], c[2]]; }
  /* 元素: 序号或 key 名都能取 (index 越界 → 兜底成金) */
  function elementPal(i) {
    var e = typeof i === 'number' ? ELEMENTS[i] : findKey(ELEMENTS, i);
    return e || ELEMENTS[0];
  }
  /* 异灵根: 名字取; 不认识 → null (调用方退回元素色) */
  function variantPal(name) {
    return name == null ? null : (findKey(VARIANTS, name) || null);
  }
  function findKey(arr, k) {
    for (var i = 0; i < arr.length; i++) if (arr[i].key === k || arr[i].name === k) return arr[i];
    return null;
  }
  /* 异灵根精灵位 (图集第 4 行 0..3 列): 名字 → spriteId, 不认识 → -1 */
  function variantSprite(name) {
    for (var i = 0; i < VARIANTS.length; i++) if (VARIANTS[i].key === name) return 32 + i;
    return -1;
  }

  /* 等级取用: 序号 (0/1/2) 或 key ('大'/'中'/'小') 都行; 越界 → 兜底成「大」 */
  function levelInfo(i) {
    if (typeof i === 'string') {
      for (var k = 0; k < LEVELS.length; k++) if (LEVELS[k].key === i) return LEVELS[k];
      return LEVELS[0];
    }
    var n = i | 0;
    return LEVELS[n >= 0 && n < LEVELS.length ? n : 0];
  }

  global.VeinSkin = {
    shape: SHAPE,
    levels: LEVELS,
    elements: ELEMENTS,
    variants: VARIANTS,
    dual: DUAL,
    elementPal: elementPal,
    variantPal: variantPal,
    variantSprite: variantSprite,
    levelInfo: levelInfo,
    toRGB: toRGB
  };
})(typeof window !== 'undefined' ? window : this);
