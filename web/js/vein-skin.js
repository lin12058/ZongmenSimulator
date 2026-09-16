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
 *   · levels 的**下标** == mapgen.js 的 veins[].level (0大 / 1中 / 2小 / 3从属)
 *     ⇒ 本文件的 levels 只管**高度**; **占地**在引擎 mapgen.js veinFootKeep()
 *       (大 7 格 / 中 3 格 / 小 1 格; 从属档**不是**独立灵脉, 只作从属峰的高度档)
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

    /* ⚠ **大世界山的高度档位** (海拔 → 高度倍率) —— 2026-09-15 收口到本文件:
       灵脉的「山地底座」(bhs) 与大世界山用的是**同一组数字**, 原先 renderer.js:159-160
       另写了一份, 两边各自漂移过一次 (底座抬高 / 山变矮不同步)。
       现在 renderer.js 从这里读并生成 GLSL 字面量 ⇒ 单一真源。
         bhs = e>elevSnow ? mix(snowLo,snowHi,(e-elevSnow)/0.12)
             : e>elevMtn  ? mix(mtnLo, mtnHi,(e-elevMtn)/0.14) : 0
       分母 0.12 / 0.14 也一并在这里给 (tipU 与 shader 共用)。 */
    mtnLo: 0.55, mtnHi: 1.30, snowLo: 0.95, snowHi: 1.55,
    elevMtn: 0.70, elevSnow: 0.84, mtnSpan: 0.14, snowSpan: 0.12,

    /* 精灵方框在 shader 里的**底边偏移** (renderer.js:244 `bottom = iCenter.y + uR*0.95`)
       —— 就是它让「峰尖相对格心的上探量」= H - 0.95, 而不是 H。tipU 必须减掉。
       ⚠ 改 renderer 的 0.95 时, 这里必须同步 (契约 check_vein_skin 会断言)。 */
    propBottomU: 0.95,

    /* ⚠⚠ **方框 ≠ 山体** (2026-09-16 修「灵脉签悬在峰上」的正主因):
       PROP_VS 把 128 逻辑格**整格**非等比拉到 W×H 方框, 而 textures.js 作画时
       峰尖离格顶还有一段空白 (格 y=0..21 是空的) —— 于是**方框顶比真实峰尖高**
       一个固定比例。旧的 tipU 返回方框顶高度 ⇒ 圆点恒定悬在峰尖上方:
         偏差 = apexV * H (方框高的 14.9%): 大档 ≈ 1.19~1.49 uR ≈ 30~38px @hexZ=25.6
       (峰越高偏得越多 —— 所以它一开始在"小"档上不太显眼, 到了大档才被报出来)
       本组常量把「峰尖在方框里的相对位置」交给 tipU 复算, 不再是一个魔数:
         tile            : 逻辑坐标系边长 (textures.js TILE=128 作画)
         propBoxInset    : 采样留边 (renderer PROP_FS `uvL = vUv*0.95 + 0.025`)
         shoulderU/archU : 峰顶 → 肩 → 顶台中拱 的偏移量 (textures.js veinPeakPts 读)
       推导见 apexV()。改峰形/改留边都会被 verify/check_vein_skin.mjs 断言住。 */
    tile: 128, propBoxInset: 0.025,

    /* 精灵的**水平**随机抖动幅度 (uR 倍数) —— renderer PROP_VS
       `jx = (fract(iHash*3.77)-0.5)*uR*1.8` ⇒ ±0.9 uR。峰尖因此**不在格心正上方**,
       灵脉签的 x 必须跟着抖 (否则竖线落在峰的一侧)。0 = 关掉这条补偿。 */
    propJitterU: 0.9,

    /* ⚠ **山地底座** (2026-09-14 九版新增): 灵脉必落在被抬升过的山地上 (引擎 §八
       「灵脉地形迁就」: 灵脉中心格海拔被抬到 LIFT_CORE = [0.80,0.75,0.70]), 而该格的
       「格底山」精灵被灵脉峰替换 ⇒ 缩到 40% 后峰体**矮于周围大山**, 在群山里"看不见"。
       本旋钮把**该格真实海拔对应的那层山**的**高度**垫在灵脉峰之下 (高度的"海拔权重"):
         上屏高 H = uR*(3.3+1.2*hash)*底座倍率 + uR*(3.3+1.2*hash)*hs*sizeScale
       底座用的是**大世界山同款公式** (海拔 0.70~0.84 山地档 / >0.84 雪峰档), 故平原格
       (海拔 < 0.70, 例如水中孤峰) 底座自动为 0 —— 只影响山地, 不影响平原上的小灵脉。
       1.0 = 完全按「原来的山」高度叠加 (用户 2026-09-14 要求); 0 = 关闭 (回到七版行为)。
       ⚠ **只乘高度** —— 底座宽度另由下面的 terrainBaseW 控制 (十版起默认 **0 = 不加宽**;
         九版把宽度一并叠加, 结果整座灵峰读起来"变宽了", 见 terrainBaseW 注释)。
       ⚠ 底座不参与分档: 等级仍只由 levels[] 决定 (底座是"地形", 不是"灵脉")。 */
    terrainBase: 1.0,

    /* ⚠ **底座宽度倍率** (2026-09-15 十版): 底座**只加高、不加宽**。
       九版把底座宽度也按「大世界山同款公式」叠上去 (等价于 1.0) ⇒ 上屏总宽 ≈ 峰宽 3.1 +
       山宽 6.9 ≈ 9.9 uR, 而总高 ≈ 8.0 uR ⇒ **W/H ≈ 1.24 (宽大于高)** —— 与"又高又瘦"正相反
       (用户 2026-09-15 原话: "之前说的跟着高度来是在原来的基础上增加高度, 其次你这个怎么变成
       宽度了? 我的目标是又高又瘦的")。
       0 = 只加高不加宽 (**默认**): 上屏 = 峰宽 3.1 × 总高 8.0 uR ⇒ W/H ≈ 0.4 (瘦高 ≈2.5:1)。
       想让山脚留一点"外扩"就调到 0.2~0.4 (别回到 1.0); 想**再拔高**抬 terrainBase (只乘高度);
       想**更瘦**就收 wScale (只乘宽度)。
       契约断言: verify/check_vein_skin.mjs §C「又高又瘦 (总高 > 总宽)」。 */
    terrainBaseW: 0,

    /* ⚠ **山地底座下限** (2026-09-15 十一版, R3-a): 底座倍率的**下界**。
       背景: 底座公式是**严格**大于 (`ve > 0.84` 雪峰档 / `ve > 0.70` 山地档, 见 renderer.js
       PROP_VS), 而小灵脉中心海拔 `LIFT_CORE[2] = 0.70` **恰好压在边界上** ⇒ 小灵脉底座
       恒为 **0**: 只画峰体、没有山脚, 上屏总高 ≈2.1 uR (大档 ≈7.5 uR 的 **28%**);
       再经 u16 量化, 边界值还会在 0.6999…/0.7000… 之间抖动 (同格两帧可能不一致)。
       本旋钮把底座倍率**抬到不低于此值**: `bhs = max(bhs, terrainBaseMin)` —— 只兜住"山脚",
       不改峰体、不改大世界山 (大 0.80 / 中 0.75 的 bhs 已 > 0.30, 完全不受影响), 唯一
       受益者就是被卡在边界上的小灵脉 (用户 2026-09-15 原话: "小灵脉 高度偏低了")。
       0 = 关闭 (回到"只按海拔判档"的九/十版行为); 0.30 ⇒ 小灵脉山脚 ≈1.3 uR。
       ⚠ 只乘**高度** (与 terrainBase 同口径), 宽度仍由 terrainBaseW 控制。
       契约断言: verify/check_vein_skin.mjs §C「小档底座不为 0」。 */
    terrainBaseMin: 0.30,

    /* 精灵内的画法 (TILE=128 坐标系; 上屏由 PROP_VS 拉到 W×H 方框)
       —— 2026-09-14 六版「宽顶缓坡块面」: 对齐美术参考图 (宽而圆的顶 + 两肩 +
       缓坡 + **下半截化进地形**), 废弃五版的「折线尖锥 + 硬切底边」。 */
    cell: {
      mainCx: 66, mainBase: 118, mainW: 100, mainH: 96,   // 主峰 (右, 高; 底座铺满 16..116)
      subCx: 30, subBase: 116, subW: 52, subH: 52         // 副峰 (左, 矮)
    },
    topW: 0.30,    // 顶部台面宽度 (占 w): 0.30 ⇒ 宽圆顶 (0.44 会读成"梯形台")
    /* 峰顶 → 肩 → 顶台中拱 (textures.js veinPeakPts 从这里读, 原先写死在那):
       肩高 = (base-h) + h*shoulderU; 顶台再上拱 h*archU ⇒ 实际最高点 = 顶 - h*0.01。
       tipU 的 apexV() 靠这两个数 + cell 推「峰尖在方框里的位置」—— 改成别的形状
       (尖锥等) 时这里必须一起改, 否则签位与峰尖会重新错开。 */
    shoulderU: 0.10, archU: 0.11,
    seg: 11,       // 每坡采样段数 (越大坡面越圆滑)
    topSeg: 7,     // 顶台采样段数 (顶面微隆)
    fade: 0.50,    // 底部渐隐起点 (0=峰顶 1=山脚): 0.50 ⇒ 自山腰起下半截化开进地形
    miDian: 12     // 米点皴点数
  };

  /* ---------- 灵脉等级 (大 / 中 / 小 / 从属) ----------
     等级真源在引擎 (mapgen.js 的 veins[].level: 0=大 1=中 2=小; 3=从属 —— 只用于
     大/中灵脉的**从属峰**, 不是独立灵脉)。本表只管**屏幕高度**; **占地**由引擎
     mapgen.js veinFootKeep() 决定 —— **十一版起按档占地** (2026-09-15, 用户:
     "大灵脉 1 个中心旁边 6 个高度比较低的没有 / 中灵脉…左下角也右下角比他低的也没有"):
       大 → 本格 + 六邻 = **7 格**;  中 → 本格 + 西南 + 东南 = **3 格**;  小 → 本格 = **1 格**。
     ⚠ 六版曾把 7/3/1 砍成"一律只占本格" (理由: 密排后连成一片尖顶山簇, 实机读作
       「三角形山」)。十一版把它**加回来**, 同时用**专用从属档 (更低更收)** 破解当时的问题:
       从属峰比中心矮一大截 ⇒ 读作"一主众从的七星", 而不是"等高的一堆山尖"。
     两边共同构成「等级契约」, 由 verify/check_vein_skin.mjs 逐档断言。

       ⇒ **等级既影响高度, 也影响占地** (十一版起)。

     hScale  高度倍率 (PROP_VS: H = uR*(3.3 + 1.2*hash) * hScale)
     hRand   [lo,hi] **收窄**的高度随机包络 —— 灵脉要在同 hash 下恒高于大世界山,
             所以不能用全域 [0,1]; 越小的灵脉包络越靠下, 保证「等级越高越显眼」
             在随机抖动下依然成立 (否则小灵脉偶然比中灵脉高)。

     coreElev 该档灵脉**中心格抬升目标海拔** —— **镜像**引擎 MG.CFG.LIFT_CORE
             (mapgen-config.js = [0.80, 0.75, 0.70]); 「从属」档引擎无对应项 (从属格不抬升,
             只继承山地), 取 LIFT_CORE[2] 作**保守下界**。
             ⚠ 用途单一: tipU 在「本格海拔尚未到货」(elevAtTile 返 -1) 时用它当估计值 ——
               旧行为是落 terrainBaseMin, 签位**偏矮 3.4 uR** (≈85px), 就是用户看到的
               "刚打开时竖线特别短"。改用 coreElev 后收敛到"略偏矮"且**只偏矮不高抬**。
             ⚠ 这是镜像常量: 引擎改了这里不改, 签位会在"海拔未到货"那一小段再次对不上。
               故 verify/check_vein_skin.mjs 逐值断言 == 引擎 LIFT_CORE。

     相对高度 (uR 倍数, **未乘 shape.sizeScale**) = (3.3 + 1.2*hRand) * hScale:
       大 7.91~8.55 | 中 6.84~7.11 | 小 6.21~6.53
       大世界参考: 山地 (40/41/56/57) ≤ 5.85, 雪峰 (42/43/58/59) ≤ 6.98
     ⇒ 三档**相对**关系恒成立: 大 > 中 > 小, 且两两不重叠。
     ⚠ 七版起上屏还要再乘 shape.sizeScale (0.40): 大 3.16~3.42 / 中 2.74~2.84 /
       小 2.48~2.61 ⇒ 已低于雪峰 —— 这是「缩小到 40%」的**有意代价**, 见 sizeScale 注释。
     ⚠ 九版起灵脉格还会**叠加「山地底座」** (shape.terrainBase): 该格真实海拔对应的山体
       高度垫在下面, 故山地上屏高 ≈ 底座山 (1.8~7.0) + 本表高度 —— 详见 terrainBase 注释。
       本表的"三档严格递减"只约束**灵脉峰自身**那一半, 与底座无关 (底座由海拔决定)。
     ⚠ 三级必须**严格递减且不重叠**: 大 min > 中 max > 小 max (脚本断言)。
     ⚠ shape.hScale 是「大」档的值, 二者必须一致 (脚本断言)。
     ⚠ **十一版 (2026-09-15)**: 小档 hScale 1.22 → **1.45**、hRand → **[0.82, 1.00]**
       (用户: "小灵脉 高度偏低了") —— 小档上屏 2.03~2.17 → **2.48~2.61 uR (+20%)**,
       相对高 6.21~6.53 仍 < 中档下界 6.84 ⇒ 「不重叠」断言仍成立。
       这是**小档单独立项**的余量上限: 再高就撞中档下界 (要更高只能整体重排三档);
     ⚠ **十一版 D1 新增第 4 档「从属」** (level = 3): 大灵脉的六邻 / 中灵脉的西南·东南
       这两类**从属峰**用它单独一档 (比"独立小灵脉"更矮更收、语义清晰)。它**不参与**
       0/1/2 的"独立灵脉"语义 —— 引擎只在**从属格**的 `vein.level` 写 3 (见 mapgen.js
       veinFootKeep + fields), 而 **从属格一律不进 `comm.veins[]`** ⇒ 不生成名牌、不进统计、
       不污染群落五行发育。
       ⚠ 加第 4 档牵动**九版 u16 复合通道**: `main.js` 写 `iElev = (等级 + 海拔) / 4`,
       shader `vz = clamp(iElev,0,1)*4` → `等级 = floor(vz)` / `海拔 = frac(vz)`。
       除数 3→4 后上界 (3+1)/4 = 1.0 仍**恰好不溢出**。 */
  var LEVELS = [
    { key: '大', level: 0, hScale: 1.90, hRand: [0.72, 1.00], coreElev: 0.80 },
    { key: '中', level: 1, hScale: 1.58, hRand: [0.86, 1.00], coreElev: 0.75 },
    { key: '小', level: 2, hScale: 1.45, hRand: [0.82, 1.00], coreElev: 0.70 },
    { key: '从属', level: 3, hScale: 1.05, hRand: [0.70, 0.86], coreElev: 0.70 }
  ];

  /* ---------- 地盘环的「占地格」(2026-09-16 十四版, 用户报障) ----------
     用户原话: 「大灵脉 1 格外面 6 格, 中的是 1 格下面 2 格 —— 但是在显示地上的
     地盘彩环的时候没有对应的另外 6 格和 2 格格子显示」。
     即: **峰体**十一版起已按档占地 (7/3/1), 但 main.js 画的**地盘色环**只垫了中心 1 格。

     本表 = 「档位 → 保留哪些偏移」在**前端唯一的一份** (地盘环、将来的小地图/预览页共用),
     偏移语义与引擎逐字同源:

       偏移序 = 本格 + 六邻, 槽位序同 mapgen.NEIGH_SLOTS (0东 1东南 2西南 3西 4西北 5东北)
       ⇒ 中档的两个从属格正是「西南(-1,+1) + 东南(0,+1)」= 用户说的"下面那 2 格"。

     ⚠ 优先走引擎真源: MG.veinFootKeep 是纯函数, 引擎就绪时**不走下面的字面量**;
       引擎缺席 (EngineLocal.load 失败 ⇒ 主视图降级为服务端下发) 才用镜像表。
       镜像表由 verify/check_vein_cluster.mjs §D **跨源逐值断言** (与 check_faction 里的
       SECT_DOMAIN_R 同一手法) —— 引擎改档而这里没跟, 判据会红。 */
  var FOOT_OFF = [[0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  var FOOT_MIRROR = {
    0: [0, 1, 2, 3, 4, 5, 6],       // 大: 本格 + 六邻 (七星) = 7 格
    1: [0, 2, 3],                   // 中: 本格 + 东南(0,1) + 西南(-1,1) = 3 格
    2: [0],                         // 小: 仅本格 = 1 格
    3: [0]                          // 从属档不会作为「中心」出现, 兜底同小档
  };
  /* MG 可选: 传了 (MapGen 实例) 就按引擎判; 未传/不是引擎 ⇒ 镜像表 */
  function footOffsets(level, MG) {
    var lv = level | 0, out = [], i;
    if (MG && typeof MG.veinFootKeep === 'function') {
      for (i = 0; i < FOOT_OFF.length; i++) {
        if (MG.veinFootKeep(lv, FOOT_OFF[i][0], FOOT_OFF[i][1])) out.push(FOOT_OFF[i]);
      }
      return out;
    }
    var m = FOOT_MIRROR[lv] || FOOT_MIRROR[2];
    for (i = 0; i < m.length; i++) out.push(FOOT_OFF[m[i]]);
    return out;
  }

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
  /* 档位归一化。★ 2026-09-15 C 修: 越界/未知名一律返 **null**, 不再静默归一化成
     LEVELS[0] (「大」) —— 那会把异常数据悄悄读成**最强档**, 且与 veinLabel 文档口径
     「越界兜小」直接冲突 (旧实现 label(v,99) 实测得 `X·大`)。现在由调用方各自兜底:
       veinLabel → '小' (文案口径) ／ tipU → LEVELS[2]「小」(签位必须与文案同档,
       否则文案写"小"而签子挂在"大"的峰高上 —— 又一处"对不上")。 */
  function levelInfo(i) {
    if (typeof i === 'string') {
      for (var k = 0; k < LEVELS.length; k++) if (LEVELS[k].key === i) return LEVELS[k];
      return null;
    }
    if (i == null) return null;
    var n = i | 0;
    return (n >= 0 && n < LEVELS.length) ? LEVELS[n] : null;
  }

  /* ---------- 灵脉「呈示名」: 「<地貌名>·<档>」 (唯一真源) ----------
     三处消费点共用本函数 —— 大地图匾额名牌 / 侧栏「灵脉」字段 / 小地图悬停提示,
     档名从 LEVELS[].key 取 (与灵脉山体的档位定义同源, 不再各写一份 ['大','中','小'])。

     ⚠ **不要再缀「灵脉」二字**: v.name 来自引擎地貌名池 (mapgen.js LANDFORM:
       金属矿脉 / 白石岩峰 / 藤蔓深谷 / 熔岩裂隙 / 金刚台地…), 池里的名字本身已带
       「脉 / 峰 / 谷 / 林」等字 ⇒ 再缀就叠字: 金属矿脉 + 灵脉·大 = 「金属矿脉灵脉·大」
       (2026-09-15 实测)。只保留「名字 + 全角间隔号 + 档」。
     ⚠ 档位缺失/越界沿用旧口径兜「小」(不兜「大」—— 兜大反而误导成最强档)。 */
  function veinLabel(v, level) {
    var lv = (level && typeof level === 'object') ? level
           : (level == null ? null : levelInfo(level));
    return ((v && v.name) ? String(v.name) : '灵脉') + '·' + ((lv && lv.key) ? lv.key : '小');
  }

  /* ============================================================
   * 灵脉峰**精灵**的几何: 「方框里的峰尖在哪 / 峰尖偏格心多少」
   * ------------------------------------------------------------
   * 这一节存在的唯一理由: 签子/圆点要落在**看得见的峰尖**上, 而看得见的峰尖既不是
   * 方框顶 (差一个 apexV*H), 也不在格心正上方 (差一个 jx)。两处偏差在 2026-09-16
   * 之前都没补 ⇒ 用户报「竖线和点跟灵脉对不上」。
   * 数据真源全部来自本文件的 SHAPE (textures.js 与 renderer.js 反向读它) ⇒ 三处
   * 不会各自漂移。
   * ============================================================ */
  function fract01(x) { return x - Math.floor(x); }

  /* 精灵方框里「内容顶点」的相对位置 (0=方框顶, 1=方框底)。
     推导 (每一步都能在源码里指到):
       ① textures.js buildAtlas: `ctx.scale(PX/TILE)` ⇒ 画师坐标 = 逻辑格 128;
          逻辑格**整格**被 PROP_VS 映射到 W×H 方框。
       ② textures.js veinPeakPts(画在主峰上的那次调用是 h = cell.mainH):
            apY = mainBase - mainH            (峰顶基线上沿)
            shY = apY + mainH*shoulderU       (肩高 = 顶台两端)
            顶台按 i/M 采样中拱, 第 i 点的 y = shY - sin(pi*i/M) * mainH*archU
          ⇒ **实际最高点**是采样点里 y 最小的那个, 抬升量 = mainH*archU*K,
            K = max_{i=1..M-1} sin(pi*i/M)  (**离散**, 不是理想的 1 —— M=7 时 K=0.9749)。
          ⚠ 别用理想 K=1 化简: 会差 0.0022 方框高 (≈0.6px), 而本函数存在的全部意义就是
            把这点差抠掉。M 取 SHAPE.topSeg, 与 textures 同源。
       ③ renderer PROP_FS 采样留边: `uvL = vUv*(1-2*inset) + inset` ⇒ 方框 vv 对应
          逻辑格 y = tile * (inset + (1-2*inset)*vv)。
       联立 ②③ 解 vv:  apexV = (y_apex/tile - inset) / (1 - 2*inset)。
       代入现值: y_apex = (118-96) + 96*0.10 - 96*0.11*0.974928 = 21.3047
                 ⇒ apexV = (0.16644-0.025)/0.95 = 0.14889。
       ⚠⚠ 2026-09-16 修正: 旧代码写 `mainBase - mainH*(1 - (ar-sy))` (= 22.96) —— **符号反了**,
          把「中拱抬高」算成了「下压」, apexV 偏大 0.0158 ⇒ 签位再低 0.018*H (大档 ≈2px)。
          同时它用的是理想 K=1。两处一起修。 */
  function apexV() {
    var C = SHAPE.cell || { mainBase: 118, mainH: 96 };
    var T = SHAPE.tile || 128;
    var ins = SHAPE.propBoxInset != null ? SHAPE.propBoxInset : 0;
    var span = 1 - 2 * ins;
    if (!(span > 0)) span = 1;
    var sy = SHAPE.shoulderU != null ? SHAPE.shoulderU : 0.10;
    var ar = SHAPE.archU != null ? SHAPE.archU : 0.11;
    var M = Math.max(3, (SHAPE.topSeg | 0) || 7);
    var K = 0, i, s;
    for (i = 1; i < M; i++) { s = Math.sin(Math.PI * i / M); if (s > K) K = s; }
    var yApex = (C.mainBase - C.mainH) + C.mainH * sy - C.mainH * ar * K;
    var v = (yApex / T - ins) / span;
    return v < 0 ? 0 : (v > 1 ? 1 : v);      /* 保底: 越界时退回方框边 (不至于算出负高度) */
  }

  /* 精灵的**水平**抖动 (uR 倍数) —— 峰尖 x 相对格心的偏移。
     renderer PROP_VS: `jx = (fract(iHash*3.77)-0.5)*uR*1.8` (= ±propJitterU)。
     hash 未知 (区块未到货) ⇒ 0 (回落到格心, 区块到货会重绘自愈)。 */
  function apexJx(hash) {
    var a = SHAPE.propJitterU != null ? SHAPE.propJitterU : 0;
    if (!a || hash == null) return 0;
    return (fract01(hash * 3.77) - 0.5) * 2 * a;
  }

  /* ---------- 灵脉峰「格心 → 峰尖」的上屏高度 (uR 倍数) ----------
     这是灵脉签的**垂直落点**, 也是 C-c 的收口点: 数学只此一份, 大地图 (main.js
     veinTopU) 与离线契约 (verify/check_vein_skin.mjs) 都调它, 不再各写一遍公式。

     与 renderer.js PROP_VS 的逐项对应 (⚠ 改 shader 必须回来改这里):
       renderer.js:244  bottom = iCenter.y + uR*0.95        → SHAPE.propBottomU
       renderer.js:245  world.y = bottom - (1-vv)*H          → 方框顶 = center.y + uR*(0.95-H)
       renderer.js:207  hs   = VH(档)                       → LEVELS[档].hScale
       renderer.js:209  hrand= mix(lo,hi,随机)               → 有 hash 用真值, 否则取包络中点
       renderer.js:215  bhs  = 海拔档位 mix                  → SHAPE 的 mtn/snow/elev/span 组
       renderer.js:218  bhs  = max(bhs, terrainBaseMin)      → SHAPE.terrainBaseMin
       renderer.js:219  bhs *= terrainBase                   → SHAPE.terrainBase
       renderer.js:238  H = (3.3+1.2*hrand)*hs*ss + (3.3+1.2*hrand)*bhs

     ⚠ ★★ 落点用 **apexV()** 折算, 不是方框顶:
       「峰尖相对格心的上探量」= (1 - apexV()) * H - propBottomU
       旧式 `H - 0.95` 取的是**方框顶**, 而方框顶比真实峰尖高 apexV*H (大档 ≈1.19~1.49 uR
       ≈30~38px @hexZ=25.6) ⇒ 圆点恒定悬空。这是 2026-09-16 用户第二次报「对不上」的正主因
       (第一次是 C-c 的 +0.35 常数差, 已修; 两次叠加时悬空达 1.30+1.49 ≈ 2.8 uR ≈ 71px)。
     ⚠ hrand: 传入 hash (区块精灵数组里的 propHashes) 时用**该精灵的真值**
       fract(hash*5.17) ⇒ 零误差; 拿不到 hash 才退回本档包络中点 (最坏 ≈0.33 uR ≈ 8px,
       出现在大档高海拔; 区块到货即自愈 —— 见下)。
     ⚠ elev 未加载时传 -1 (或 null): 走该档的 coreElev (镜像引擎 LIFT_CORE) 当估计值 ——
       旧行为落 terrainBaseMin ⇒ 签位偏矮 3.4 uR (≈85px, 用户:"刚打开竖线特别短")。
       coreElev 是引擎对该格抬升的**下界** ⇒ 估计只偏矮、不会高抬; 区块到货会触发静态层
       重绘, 本函数被重新调用 ⇒ 精确值接管 (自愈)。
     ⚠ 档位越界/未知名: 与 veinLabel 同口径兜「小」(LEVELS[2]) —— 文案与签位必须同档,
       否则文案写"小"而签子挂在"大"的峰高上, 又是一处"对不上"。 */
  function tipU(level, elev, hash) {
    var lv = levelInfo(level) || LEVELS[2];
    var ss = SHAPE.sizeScale != null ? SHAPE.sizeScale : 1.0;
    var tb = SHAPE.terrainBase != null ? SHAPE.terrainBase : 1.0;
    var tbm = SHAPE.terrainBaseMin != null ? SHAPE.terrainBaseMin : 0;
    var e = elev;
    if (e == null || !(e >= 0)) e = (lv.coreElev != null) ? lv.coreElev : (SHAPE.elevMtn || 0.70);
    var bhs = 0;
    if (e > SHAPE.elevSnow) {
      bhs = SHAPE.snowLo + (SHAPE.snowHi - SHAPE.snowLo) *
            Math.min(1, (e - SHAPE.elevSnow) / SHAPE.snowSpan);
    } else if (e > SHAPE.elevMtn) {
      bhs = SHAPE.mtnLo + (SHAPE.mtnHi - SHAPE.mtnLo) *
            Math.min(1, (e - SHAPE.elevMtn) / SHAPE.mtnSpan);
    } else {
      /* 海拔低于山地档 (平原/水面格): 底座为 0 ⇒ 只画峰体。仍走 terrainBaseMin 下限,
         与 shader 的 max(bhs, terrainBaseMin) 严格同序。 */
      bhs = 0;
    }
    if (bhs < tbm) bhs = tbm;
    bhs *= tb;
    var lo = (lv.hRand && lv.hRand.length >= 2) ? lv.hRand[0] : 0.86;
    var hi = (lv.hRand && lv.hRand.length >= 2) ? lv.hRand[1] : 0.86;
    /* shader: hrand = mix(lo, hi, fract(iHash*5.17)) —— 有 hash 就是真值 */
    var hr = (hash == null) ? (lo + hi) * 0.5 : (lo + (hi - lo) * fract01(hash * 5.17));
    var H = (3.3 + 1.2 * hr) * lv.hScale * ss + (3.3 + 1.2 * hr) * bhs;
    var pb = SHAPE.propBottomU != null ? SHAPE.propBottomU : 0.95;
    return (1 - apexV()) * H - pb;
  }

  /* 灵脉签的完整落点: topU = 峰尖在格心之上多少 (uR); jxU = 峰尖 x 偏格心多少 (uR) */
  function apexOf(level, elev, hash) {
    return { topU: tipU(level, elev, hash), jxU: apexJx(hash) };
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
    /* 地盘环的占地偏移 (十四版): footOffsets(level, MG?) → [[dq,dr],...]; footOff = 偏移池 */
    footOffsets: footOffsets,
    footOff: FOOT_OFF,
    label: veinLabel,
    tipU: tipU,
    apexV: apexV,
    apexJx: apexJx,
    apexOf: apexOf,
    toRGB: toRGB
  };
})(typeof window !== 'undefined' ? window : this);
