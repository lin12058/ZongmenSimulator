/* ============================================================
 * renderer.js — WebGL2 水墨渲染器 (区块流式版)
 *   Pass1  每个可见区块一次实例化绘制 → 离屏 FBO
 *          (uFade 控制区块墨色渐入: 纸色 → 墨色, 丝滑加载)
 *   Pass2  全屏水墨后处理 → 屏幕
 *          (等比墨线/海岸双线/晕染外渗/宣纸正片叠底/暗角)
 * ============================================================ */
(function (global) {
  'use strict';

  /* T9: 图集行数唯一常量 — HEX_FS/PROP_FS 的硬编码 8.0 与 atlasRows 全部引用此处;
     调整图集行数只改这一个值 (textures.js 的 ATLAS_ROWS 须保持一致,
     setTextures 里有构建期校验兜底, 不一致会直接抛错而非静默丢精灵)。 */
  var ATLAS_ROWS = 8;

  var HEX_VS = [
    '#version 300 es',
    'layout(location=0) in vec2 aPos;',
    'layout(location=1) in vec2 iCenter;',
    'layout(location=2) in float iTile;',
    'layout(location=3) in float iElev;',
    'layout(location=4) in float iHash;',
    'layout(location=5) in float iNeigh;',
    'uniform vec2 uRes;',
    'uniform vec2 uCam;',
    'uniform float uZoom;',
    'uniform float uR;',
    'out vec2 vLocal;',
    'out vec2 vUv;',
    'out float vTile;',
    'out float vElev;',
    'out float vHash;',
    'out float vNeigh;',
    'void main(){',
    '  float SQ3 = 1.7320508;',
    '  vec2 qsize = vec2(SQ3*uR*0.5, uR) * 1.04;',
    '  vec2 world = iCenter + aPos*qsize;',
    '  vec2 screen = (world - uCam)*uZoom + uRes*0.5;',
    '  vec2 clip = screen/uRes*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  vLocal = aPos * vec2(SQ3*uR*0.5, uR);',
    '  vUv = aPos*0.5+0.5;',
    '  vTile = iTile; vElev = iElev; vHash = iHash; vNeigh = iNeigh;',
    '}'
  ].join('\n');

  var HEX_FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vLocal;',
    'in vec2 vUv;',
    'in float vTile;',
    'in float vElev;',
    'in float vHash;',
    'in float vNeigh;',
    'uniform sampler2D uAtlas;',
    'uniform float uApo;',
    'uniform float uSeaLevel;',
    'uniform float uTime;',
    'uniform vec3 uAvg[13];',
    'uniform float uFade;',        // 区块渐入 0..1
    'uniform vec3 uPaperTint;',
    'out vec4 fragColor;',
    'void main(){',
    '  float d = max(abs(vLocal.x), 0.5*abs(vLocal.x)+0.8660254*abs(vLocal.y)) - uApo;',
    '  if (d > 0.6) discard;',
    '  float biome = floor(vTile/4.0 + 0.001);',   // vTile = biome*4+variant, 精确解码
    '  float variant = vTile - biome*4.0;',
    '  float pad = 0.045;',
    '  vec2 uvL = vUv*(1.0-2.0*pad)+pad;',
    /* 图集寻址: 群系 0..7 = (列=群系, 行=变体); 灵脉格 8..12 = 第 4 行
       图集共 ATLAS_ROWS 行 (第 5/6/7 行为立体精灵), 必须按 ATLAS_ROWS 除,
       否则灵脉行采样越界 → 黑格 */
    '  vec2 cell = biome < 7.5 ? vec2(biome, variant) : vec2(biome - 8.0, 4.0);',
    '  vec2 uv = (cell + uvL)/vec2(' + ATLAS_ROWS + '.0, ' + ATLAS_ROWS + '.0);',
    '  vec3 base = texture(uAtlas, uv).rgb;',
    // —— 邻居晕染 (灵脉格跳过, 保持灵气贴图完整; 山/雪不参与 —— 其边界由山峰精灵承担, 晕染会出黑边) ——
    '  if (biome < 7.5) {',
    '  for (int k = 0; k < 6; k++) {',
    '    float nb = mod(floor(vNeigh / pow(8.0, float(k))), 8.0);',
    '    if (abs(nb - biome) > 0.5 && nb < 5.5 && biome < 5.5) {',
    '      float ang = 1.0471976 * float(k);',
    '      vec2 n = vec2(cos(ang), sin(ang));',
    '      float t = clamp((dot(vLocal, n) - (uApo - 6.5)) / 6.5, 0.0, 1.0);',
    '      t = t*t*(3.0-2.0*t);',
    '      base = mix(base, uAvg[int(nb)], t * 0.55);',
    '    }',
    '  }',
    '  }',
    '  if (biome < 1.5) {',
    '    float depth = clamp((uSeaLevel - vElev)*5.0, 0.0, 1.0);',
    '    base *= mix(1.10, 0.84, depth);',
    '    float w1 = sin(vLocal.x*0.10 + vLocal.y*0.045 + vHash*6.2832);',
    '    float w2 = sin(vLocal.x*0.05 - vLocal.y*0.07 + vHash*12.0);',
    '    base *= 1.0 + 0.05*w1 + 0.035*w2;',
    '    base *= 0.975 + 0.05*vHash;',
    '  } else {',
    '    base *= 0.92 + 0.16*clamp((vElev-uSeaLevel)/0.5, 0.0, 1.0);',
    '    base *= 0.95 + 0.10*vHash;',
    '  }',
    '  float edge = smoothstep(-2.6, -0.6, d);',
    '  base *= 1.0 - (biome < 1.5 ? 0.03 : 0.05)*edge;',
    // —— 区块渐入: 纸色 → 墨色 ——
    '  base = mix(uPaperTint, base, uFade);',
    '  fragColor = vec4(base, (biome+1.0)/16.0);',
    '}'
  ].join('\n');

  /* ---- 立体精灵 (超出格子的山/树/灵脉峰, Battle Brothers 式压格) ---- */
  /* 灵脉峰的屏幕比例 —— 取自 web/js/vein-skin.js 的 shape (唯一真源)。
     兜底值须与 vein-skin.js 的默认值一致 (漏载时只是比例退化, 不崩)。
     ⚠ 二者解出的 W≈H (近似正方方框) ⇒ 128 格里的山形不被横向拉宽。 */
  var VEIN_SHAPE = (function () {
    var vs = (typeof window !== 'undefined' && window.VeinSkin) || null;
    var s = (vs && vs.shape) || null;
    var out = { h: (s && s.hScale) || 1.55, w: (s && s.wScale) || 0.80,
                sc: (s && s.sizeScale) || 1.0,
                tb: (s && s.terrainBase != null) ? s.terrainBase : 1.0,
                tbm: (s && s.terrainBaseMin != null) ? s.terrainBaseMin : 0,
                tbw: (s && s.terrainBaseW != null) ? s.terrainBaseW : 0, lv: [],
                /* 大世界山的高度档位 —— 2026-09-15 从 vein-skin.js 收口 (原先本文件
                   另写一份, 两边漂移过一次)。灵脉「山地底座」与大世界山共用同一组。 */
                mtnLo: (s && s.mtnLo != null) ? s.mtnLo : 0.55,
                mtnHi: (s && s.mtnHi != null) ? s.mtnHi : 1.30,
                snowLo: (s && s.snowLo != null) ? s.snowLo : 0.95,
                snowHi: (s && s.snowHi != null) ? s.snowHi : 1.55,
                elevMtn: (s && s.elevMtn != null) ? s.elevMtn : 0.70,
                elevSnow: (s && s.elevSnow != null) ? s.elevSnow : 0.84,
                mtnSpan: (s && s.mtnSpan != null) ? s.mtnSpan : 0.14,
                snowSpan: (s && s.snowSpan != null) ? s.snowSpan : 0.12,
                propBottomU: (s && s.propBottomU != null) ? s.propBottomU : 0.95,
                /* 采样留边 + 精灵水平抖动幅度 —— 真源同样在 vein-skin.js:
                   它们决定「看得见的峰尖」在方框里的位置与横向偏移, 灵脉签的落点
                   (vein-skin.apexV/apexJx) 必须与这两个 GLSL 字面量严格一致,
                   所以**不许**在这里另写一份 (2026-09-16)。 */
                boxInset: (s && s.propBoxInset != null) ? s.propBoxInset : 0.025,
                jitterU: (s && s.propJitterU != null) ? s.propJitterU : 0.9 };
    /* 四档 (大/中/小/从属) 的高度倍率与收窄包络; 缺配置 → 一律退回 shape.hScale
       ⚠ 顺序即 mapgen.js 的 level (0大 / 1中 / 2小 / 3从属), 契约见 verify/check_vein_skin.mjs */
    var EPS = 1.0 / 1024.0;                       // 浮点字面量精度 (避免 GLSL 里出现 0.7200001)
    var nlv = (vs && vs.levels && vs.levels.length) || 3;
    for (var i = 0; i < nlv; i++) {
      var L = vs && vs.levels && vs.levels[i];
      var lo = (L && L.hRand && L.hRand[0] != null) ? L.hRand[0] : 0.72;
      var hi = (L && L.hRand && L.hRand[1] != null) ? L.hRand[1] : 1.00;
      out.lv.push({
        h: (L && L.hScale != null) ? L.hScale : out.h,
        lo: Math.round(lo / EPS) * EPS,
        hi: Math.round(hi / EPS) * EPS
      });
    }
    return out;
  })();
  /* GLSL 字面量取用: 第 i 档 (0大/1中/2小) 的高度倍率 / 包络下界 / 上界。
     ⚠ 必须 toFixed(3) 落成 `1.900` 这类字面量 —— 直接拼 JS number 会出现
       1.9000000000000001 / 0.7200000000000001 这种尾数进着色器。 */
  var VH  = function (i) { return VEIN_SHAPE.lv[i].h.toFixed(3); };
  var VLO = function (i) { return VEIN_SHAPE.lv[i].lo.toFixed(3); };
  var VHI = function (i) { return VEIN_SHAPE.lv[i].hi.toFixed(3); };
  /* 灵脉峰**上屏尺寸总倍率** (vein-skin.js shape.sizeScale): W/H 同乘 ⇒ 等比缩放,
     比值与三档相对高矮都不变。只作用在灵脉峰分支, 不动大世界山/林/沙。 */
  var VSIZE = VEIN_SHAPE.sc.toFixed(3);
  /* 灵脉格「山地底座」倍率 (vein-skin.js shape.terrainBase): 见 PROP_VS 灵脉分支 ——
     把该格真实海拔对应的**那层山**垫在灵脉峰之下 (平原格自动为 0)。 */
  var VBASE = VEIN_SHAPE.tb.toFixed(3);
  /* 灵脉格「山地底座」的**宽度**倍率 (vein-skin.js shape.terrainBaseW): 十版起默认 0
     —— 底座只加高、不加宽。九版宽度也叠加 ⇒ 上屏总宽 ≈ 9.9 uR > 总高 8.0 uR,
     整座灵峰读起来"变宽了" (用户 2026-09-15: "你这个怎么变成宽度了? 我要又高又瘦的")。 */
  var VBASEW = VEIN_SHAPE.tbw.toFixed(3);
  /* 灵脉格「山地底座」的**下限** (vein-skin.js shape.terrainBaseMin): 十一版 R3-a ——
     小灵脉中心海拔 LIFT_CORE[2]=0.70 恰好压在底座判档的严格边界 (`ve > 0.70`) 上,
     底座恒为 0 ⇒ 只画峰体没有山脚 (上屏总高仅大档的 28%)。这里给底座倍率兜一个下界。 */
  var VBMIN = VEIN_SHAPE.tbm.toFixed(3);
  /* 精灵采样留边 + 水平抖动 (renderer 侧的字面量来自 vein-skin.js, 见 VEIN_SHAPE):
     ⚠ 改这两个数 = 改「峰尖出现在哪」⇒ vein-skin.apexV()/apexJx() 的结论跟着变,
       灵脉签落点自动跟手。别在这里写死。 */
  var BOX_INSET = VEIN_SHAPE.boxInset.toFixed(4);
  var BOX_SPAN = (1 - 2 * VEIN_SHAPE.boxInset).toFixed(4);
  var JIT_U = (VEIN_SHAPE.jitterU * 2).toFixed(3);
  /* 大世界山/雪峰的高度倍率档位 + 判档阈值 —— 2026-09-15 起**真源在 vein-skin.js**
     (shape.mtnLo/mtnHi/snowLo/snowHi/elevMtn/elevSnow/mtnSpan/snowSpan), 这里只做
     缺配置兜底。灵脉「山地底座」与地形分支共用同一组 ⇒ 不会一边改了另一边没改。
     ⚠ 阈值/分母也一并来自真源: 旧实现把 0.70/0.84/0.14/0.12 硬编码在 GLSL 里,
       vein-skin.tipU 复算时只能另抄一份 —— 那就是「签位对不上峰尖」的温床。 */
  var MTN_LO = VEIN_SHAPE.mtnLo.toFixed(3), MTN_HI = VEIN_SHAPE.mtnHi.toFixed(3);
  var SNOW_LO = VEIN_SHAPE.snowLo.toFixed(3), SNOW_HI = VEIN_SHAPE.snowHi.toFixed(3);
  var E_MTN = VEIN_SHAPE.elevMtn.toFixed(3), E_SNOW = VEIN_SHAPE.elevSnow.toFixed(3);
  var S_MTN = VEIN_SHAPE.mtnSpan.toFixed(3), S_SNOW = VEIN_SHAPE.snowSpan.toFixed(3);
  var PROP_VS = [
    '#version 300 es',
    'layout(location=0) in vec2 aPos;',        // [-1..1] 方块
    'layout(location=1) in vec2 iCenter;',
    'layout(location=2) in float iSprite;',    // row*8+col
    'layout(location=3) in float iHash;',
    'layout(location=4) in float iElev;',      // 大世界山=海拔; 灵脉峰=(等级+海拔)/4, 见下
    'uniform vec2 uRes;',
    'uniform vec2 uCam;',
    'uniform float uZoom;',
    'uniform float uR;',
    'out vec2 vUv;',
    'out float vSprite;',
    'out float vHash;',
    'void main(){',
    '  float h2 = fract(iHash*13.73);',
    /* 高度系数: 山 40/41·56/57 与 雪 42/43·58/59 按海拔档位缩放 (noise 驱动, 非固定高);
       林 44..47 / 沙 48 / 草 49 只做轻微随机;
       灵脉峰 32..35(异灵根) 与 50..54(五行) 用 vein-skin.js 的**分档**倍率:
         大/中/小 三档高度不同 (levels[].hScale), 且各自收窄随机包络 (levels[].hRand);
       ⚠ 通道复用 (九版, 十一版除数改 4): 灵脉峰的 iElev **既不是海拔、也不只是等级**, 而是
         **归一化复合值** `(灵脉等级 + 该格真实海拔) / 4` —— 精灵段的海拔通道是 u16 量化
         (值域 [0,1]), 装不下「等级 0..3」+「海拔 0..1」两个量, 故在 main.js refreshChunkProps
         里先压进 [0,1], 这里再还原 (等级 = floor(4*iElev), 海拔 = frac(4*iElev))。见下面的
         ve/bhs 分支。上界 (3+1)/4 = 1.0 **恰好不溢出** (换档位数时必须重算这个上界)。
         大世界山照旧直接下发海拔 (else-if 分支里 iElev 就是 e)。
       wScale 收窄 + hScale 抬高 ⇒ 方框近似正方, 山形不被横向拉宽 (历史画崩的根因)。
       ⚠ 灵脉峰还**额外收窄高度随机包络** —— 否则同一 hash 抖动区间会盖过倍率差:
         极端情形下 (灵脉 hrand=0, 雪峰 hrand=1) 雪峰反而更高, 出现实测 seed 74
         那样"灵脉淹没在雪岭里"。分档后 大/中 恒 > 任何大世界山 (小 ≈ 山地峰高)。
       ⚠ 七版: 灵脉峰再乘 shape.sizeScale (整体等比缩小, W/H 同乘) —— 只改**上屏尺寸**,
         不改这套相对高矮; 但缩小后灵脉不再恒高于雪峰, 识别改由晕圈/名牌承担。
       ⚠ 九版: 灵脉格再垫一层「**山地底座**」(vein-skin.js shape.terrainBase) —— 该格真实
         海拔对应的那层山 (与大世界山同档公式), 不乘 sizeScale; 峰体叠在它之上。
         平原/水面格 (海拔 < 0.70) 底座为 0 ⇒ 只影响山地, 不影响水中孤峰。
       ⚠ 十版: 底座**只加高、不加宽** (shape.terrainBaseW, 默认 0) —— 九版把底座宽度
         一并叠加 ⇒ 上屏总宽 ≈9.9 uR > 总高 ≈8.0 uR, 灵峰读起来"变宽了" (用户 2026-09-15:
         "我的目标是又高又瘦的")。现在 W 只剩灵脉峰自身 (≈3.1 uR, 见 vbw=0), 总高不变
         ⇒ **W/H ≈ 0.4 的瘦高峰**; 要更瘦收 wScale, 要更高抬 terrainBase (只乘高度)。 */
    '  float hs; float ws = 1.0; float hrand = fract(iHash*5.17);',
    '  float vbaseH = 0.0; float vbaseW = 0.0;',      // 山地底座 (仅灵脉格非 0)
    '  if ((iSprite > 31.5 && iSprite < 35.5) || (iSprite > 49.5 && iSprite < 54.5)) {',
    '    float vz = clamp(iElev, 0.0, 1.0) * 4.0;',   // 复合通道 → 等级 + 海拔 (除数 4 = 四档)
    '    float vlv = min(floor(vz), 3.0);',           // 灵脉等级 (0大/1中/2小/3从属)
    '    float ve  = vz - floor(vz);',                // 该格真实海拔 (0..1)
    '    ws = ' + VEIN_SHAPE.w.toFixed(3) + ';',
    '    hs = (vlv < 0.5) ? ' + VH(0) + ' : ((vlv < 1.5) ? ' + VH(1) +
           ' : ((vlv < 2.5) ? ' + VH(2) + ' : ' + VH(3) + '));',
    '    hrand = (vlv < 0.5) ? mix(' + VLO(0) + ', ' + VHI(0) + ', hrand)',
    '          : (vlv < 1.5) ? mix(' + VLO(1) + ', ' + VHI(1) + ', hrand)',
    '          : (vlv < 2.5) ? mix(' + VLO(2) + ', ' + VHI(2) + ', hrand)',
    '          :               mix(' + VLO(3) + ', ' + VHI(3) + ', hrand);',
    /* 「原来的山」: 与大世界山**同一档公式** (海拔 → 高度倍率), 平原/水面 → 0 */
    '    float bhs = 0.0;',
    '    if (ve > ' + E_SNOW + ')      bhs = mix(' + SNOW_LO + ', ' + SNOW_HI + ', clamp((ve-' + E_SNOW + ')/' + S_SNOW + ', 0.0, 1.0));',
    '    else if (ve > ' + E_MTN + ') bhs = mix(' + MTN_LO + ', ' + MTN_HI + ', clamp((ve-' + E_MTN + ')/' + S_MTN + ', 0.0, 1.0));',
    /* 十一版 R3-a: 底座**下限** —— 小灵脉 (LIFT_CORE[2]=0.70) 恰卡在严格边界上, 否则底座恒 0 */
    '    bhs = max(bhs, ' + VBMIN + ');',
    '    bhs *= ' + VBASE + ';',
    '    vbaseH = uR*(3.3+1.2*hrand) * bhs;',
    '    vbaseW = 3.4641016*uR*(1.55+0.65*h2) * (0.82 + 0.22*bhs) * ' + VBASEW + ';',
    '  }',
    '  else if (iSprite < 41.5 || (iSprite > 55.5 && iSprite < 57.5))',
    '    hs = mix(' + MTN_LO + ', ' + MTN_HI + ', clamp((iElev-' + E_MTN + ')/' + S_MTN + ', 0.0, 1.0));',
    '  else if ((iSprite > 41.5 && iSprite < 43.5) || (iSprite > 57.5 && iSprite < 59.5))',
    '    hs = mix(' + SNOW_LO + ', ' + SNOW_HI + ', clamp((iElev-' + E_SNOW + ')/' + S_SNOW + ', 0.0, 1.0));',
    '  else if (iSprite < 49.5) hs = 0.62 + 0.34*fract(iHash*9.13);',
    '  else if (iSprite > 59.5 && iSprite < 61.5) hs = 0.52 + 0.24*fract(iHash*9.13);',  // 草地小山包: 更矮缓
    '  else if (iSprite > 61.5 && iSprite < 63.5) hs = 0.72 + 0.30*fract(iHash*9.13);',  // 草地孤树: 中等
    '  else                     hs = 1.05;',
    '  float ss = 1.0;',
    '  if (iSprite > 59.5 && iSprite < 61.5) ss = 0.30;',   // 小山包整体缩至 30%
    '  else if ((iSprite > 31.5 && iSprite < 35.5) || (iSprite > 49.5 && iSprite < 54.5))',
    '    ss = ' + VSIZE + ';',   // 灵脉峰整体尺寸倍率 (vein-skin.js shape.sizeScale)
    /* ⚠ 十版: vbaseW 由 shape.terrainBaseW 乘出来 (默认 0 ⇒ **底座只加高不加宽**):
       W 只剩灵脉峰自身, H 仍含底座 ⇒ 又高又瘦 (九版宽度也叠加 ⇒ 反被读成"变宽了")。 */
    '  float W = 3.4641016*uR*(1.55+0.65*h2) * (0.82 + 0.22*hs) * ss * ws + vbaseW;',
    '  float H = uR*(3.3+1.2*hrand) * hs * ss + vbaseH;',  // 底座山 (不缩, 只贡献高度) + 灵脉峰 (乘 sizeScale)
    '  float jx = (fract(iHash*3.77)-0.5)*uR*' + JIT_U + ';',   // ±jitterU uR (vein-skin.js)
    '  float flip = step(0.5, fract(iHash*7.31));',
    '  float u0 = aPos.x*0.5+0.5;',
    '  float u = mix(u0, 1.0-u0, flip);',
    '  float vv = 1.0-(aPos.y*0.5+0.5);',                // 0=精灵顶部
    '  float bottom = iCenter.y + uR*0.95;',             // 底部压向下一格 → 立体堆叠
    '  vec2 world = vec2(iCenter.x + jx + aPos.x*W*0.5, bottom - (1.0-vv)*H);',
    '  vec2 screen = (world - uCam)*uZoom + uRes*0.5;',
    '  vec2 clip = screen/uRes*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '  vUv = vec2(u, vv); vSprite = iSprite; vHash = iHash;',
    '}'
  ].join('\n');

  var PROP_FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec2 vUv;',
    'in float vSprite;',
    'in float vHash;',
    'uniform sampler2D uAtlas;',
    'uniform float uRows;',
    'uniform float uFade;',
    'uniform vec3 uPaperTint;',
    'out vec4 fragColor;',
    'void main(){',
    '  float col = mod(vSprite, ' + ATLAS_ROWS + '.0);',
    '  float row = floor(vSprite/' + ATLAS_ROWS + '.0 + 0.001);',   // 精确取整: +0.5 会把 44~47 错算到第 6 行
    /* 采样留边 (vein-skin.js shape.propBoxInset): 方框 vv 对应逻辑格 y
       = tile*(inset + span*vv) —— vein-skin.apexV() 的解就是从这里来的, 同一份数。 */
    '  vec2 uvL = vUv*' + BOX_SPAN + '+' + BOX_INSET + ';',
    '  vec2 uv = (vec2(col, row)+uvL)/vec2(' + ATLAS_ROWS + '.0, uRows);',
    '  vec4 tex = texture(uAtlas, uv);',
    '  if (tex.a < 0.10) discard;',
    '  vec3 rgb = tex.rgb * (0.90 + 0.20*fract(vHash*3.17));',
    '  rgb = mix(uPaperTint, rgb, uFade);',
    '  fragColor = vec4(rgb, tex.a*uFade);',
    '}'
  ].join('\n');

  /* ---- 道路: 贴地小径 (画进底图 FBO, 位于立体精灵之下 → 树压路) ---- */
  var ROAD_VS = [
    '#version 300 es',
    'layout(location=0) in vec2 aWorld;',
    'uniform vec2 uRes;',
    'uniform vec2 uCam;',
    'uniform float uZoom;',
    'void main(){',
    '  vec2 screen = (aWorld - uCam)*uZoom + uRes*0.5;',
    '  vec2 clip = screen/uRes*2.0 - 1.0;',
    '  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);',
    '}'
  ].join('\n');
  var ROAD_FS = [
    '#version 300 es',
    'precision mediump float;',
    'uniform vec4 uColor;',
    'out vec4 fragColor;',
    'void main(){ fragColor = uColor; }'
  ].join('\n');

  var POST_VS = [
    '#version 300 es',
    'layout(location=0) in vec2 aPos;',
    'out vec2 vUv;',
    'void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  var POST_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv;',
    'uniform sampler2D uScene;',
    'uniform sampler2D uProps;',   // 立体精灵层 (rgba)
    'uniform sampler2D uPaper;',
    'uniform sampler2D uNoise;',
    'uniform vec2 uRes;',
    'uniform vec2 uTexel;',
    'uniform vec2 uCam;',
    'uniform float uZoom;',
    'uniform vec2 uMapSize;',      // 不再用于图外判定, 保留兼容 (传 0)
    'uniform float uPaperScale;',
    'out vec4 fragColor;',
    'float biomeAt(vec2 uv){ return floor(texture(uScene, uv).a*16.0+0.5)-1.0; }',
    'float cat(float id){ return id < 1.5 ? 0.0 : id; }',
    'void main(){',
    '  vec2 uv = vUv;',
    // 屏幕 → 世界: WebGL v=0 在屏幕底部, 世界 y 轴向下 → 翻转
    '  vec2 world = vec2((uv.x - 0.5)*uRes.x, (0.5 - uv.y)*uRes.y)/uZoom + uCam;',
    '  vec4 sc = texture(uScene, uv);',
    '  vec3 col = sc.rgb;',
    '  float id = floor(sc.a*16.0+0.5)-1.0;',
    '  bool iWater = id < 1.5;',
    // —— 晕染外渗 (等比, 只作用底图, 精灵保持清晰前景) ——
    '  float pxw = max(uZoom, 0.5) * 0.85;',
    '  vec2 ob = uTexel * pxw * vec2(1.7, 0.9);',
    '  vec3 blur = ( texture(uScene, uv+ob).rgb + texture(uScene, uv-ob).rgb',
    '              + texture(uScene, uv+ob.yx).rgb + texture(uScene, uv-ob.yx).rgb )*0.25;',
    '  col = mix(col, blur, 0.30);',
    // —— 立体精灵合成 ——
    '  vec4 pr = texture(uProps, uv);',
    '  col = mix(col, pr.rgb, pr.a);',
    // —— 底图边缘检测 → 墨线 (等比: 采样半径随缩放) ——
    '  float e1 = 0.0; float coast = 0.0; float coast2 = 0.0;',
    '  float mtnEdge = (id > 5.5 && id < 7.5) ? 1.0 : 0.0;',   // 本格是山/雪
    '  vec2 o0 = uTexel * pxw; vec2 o1 = vec2(0.0, uTexel.y) * pxw;',
    '  for (int i=0;i<4;i++){',
    '    vec2 o = (i==0)? o0 : (i==1)? -o0 : (i==2)? o1 : -o1;',
    '    float nid = biomeAt(uv+o);',
    '    e1 = max(e1, (cat(nid) != cat(id)) ? 1.0 : 0.0);',
    '    if (iWater != (nid<1.5)) coast = 1.0;',
    '    if (nid > 5.5 && nid < 7.5) mtnEdge = 1.0;',          // 邻格是山/雪 → 边界墨线交给山峰精灵勾边
    '  }',
  '  vec2 o2 = o0*3.4; vec2 o3 = o1*3.4;',
  '  for (int i=0;i<4;i++){',
  '    vec2 o = (i==0)? o2 : (i==1)? -o2 : (i==2)? o3 : -o3;',
  '    float nid = biomeAt(uv+o);',
  '    if (iWater != (nid<1.5)) coast2 = 1.0;',
  '  }',
  '  vec2 o6 = o0*7.5; vec2 o7 = o1*7.5;',
  '  float coast3 = 0.0;',
  '  for (int i=0;i<4;i++){',
  '    vec2 o = (i==0)? o6 : (i==1)? -o6 : (i==2)? o7 : -o7;',
  '    float nid = biomeAt(uv+o);',
  '    if (iWater != (nid<1.5)) coast3 = 1.0;',
  '  }',
  '  float br = texture(uNoise, world*0.013).r;',
  '  float fine = texture(uNoise, world*0.06).g;',
  '  // —— 海岸浅水提亮 + 静态近岸白沫 (世界锚定, 无动画) ——',
  '  float ring = max(coast*1.0, max(coast2*0.66, coast3*0.38));',
  '  if (iWater) {',
  '    col += vec3(0.05, 0.06, 0.05) * ring;',                          // 近岸浅水泛亮
  '    float wob = texture(uNoise, world*0.045).g;',
  '    float ph = world.x*0.085 + world.y*0.06 + wob*4.2;',
  '    float crest = pow(0.5 + 0.5*sin(ph*6.2832), 4.5);',               // 平行岸线的白沫脊 (收细)
  '    float foamA = ring * (0.18 + 0.82*crest) * (0.55 + 0.45*wob);',
  '    col = mix(col, vec3(0.90, 0.94, 0.92), clamp(foamA*0.42, 0.0, 0.28));',
  '  }',
    // —— 精灵近邻遮罩: 山/树精灵脚下 (含接地阴影) 的底图 hex 墨线穿帮, 就近衰减 ——
    '  float pa = pr.a;',
    '  float paDn = texture(uProps, uv + vec2(0.0, uTexel.y*pxw*2.6)).a;',
    '  float paUp = texture(uProps, uv - vec2(0.0, uTexel.y*pxw*2.6)).a;',
    '  float propNear = clamp(max(pa, max(paDn, paUp))*1.4, 0.0, 1.0);',
    '  float inkLine = e1 * (0.30 + 0.70*smoothstep(0.22, 0.55, br)) * (1.0 - propNear*0.92) * (1.0 - mtnEdge);',
    '  float coastLine = max(coast, coast2*0.22) * (0.45+0.55*smoothstep(0.18, 0.5, br));',
    '  vec3 inkCol = vec3(0.15, 0.13, 0.115);',
    '  col = mix(col, inkCol, clamp(inkLine*0.55 + coastLine*0.38, 0.0, 0.8));',
    // —— 精灵轮廓墨线 (剪影梯度 → 枯笔勾边) ——
    '  float pe = 0.0;',
    '  for (int i=0;i<4;i++){',
    '    vec2 o = (i==0)? o0 : (i==1)? -o0 : (i==2)? o1 : -o1;',
    '    pe = max(pe, abs(texture(uProps, uv+o).a - pa));',
    '  }',
    '  float propInk = pe * (0.28 + 0.55*smoothstep(0.22, 0.55, br));',
    '  col = mix(col, inkCol, clamp(propInk, 0.0, 0.5));',
    // —— 精灵接地投影 (剪影下移采样, 只落在本体之外、陆地之上) ——
    '  float sh = texture(uProps, uv + vec2(0.0, uTexel.y*pxw*3.2)).a;',
    '  sh *= (1.0 - pa) * step(1.5, id);',
    '  col *= 1.0 - 0.15*sh;',
    // —— 整体提亮 (修复全局偏暗) ——
    '  col = col*1.08 + 0.022;',
    // —— 宣纸正片叠底 + 纤维 (减淡, 保留纸理不压暗画面) ——
    '  vec3 paper = texture(uPaper, world/uPaperScale).rgb;',
    '  col *= mix(vec3(1.0), paper*1.28, 0.38);',
    '  col += (fine-0.5)*0.045;',
    '  col *= 1.0 - 0.10*smoothstep(0.55, 1.35, length((uv-0.5)*vec2(1.05,1.25))*2.0);',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ================= 渲染器 ================= */
  function InkRenderer(canvas) {
    var gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.canvas = canvas;

    this.progHex = this._build(HEX_VS, HEX_FS);
    this.progProp = this._build(PROP_VS, PROP_FS);
    this.progPost = this._build(POST_VS, POST_FS);
    this.progRoad = this._build(ROAD_VS, ROAD_FS);
    this.roadBufHalo = gl.createBuffer();   // 道路柔光底层 (宽而淡)
    this.roadBufCore = gl.createBuffer();   // 道路主路面
    this.roadBufWater = gl.createBuffer();  // 过水段: 虚线航道 (石青墨, 与陆上路面分色)
    this.roadCounts = [0, 0, 0];

    var quad = new Float32Array([
      -1, -1, 1, -1, 1, 1,
      -1, -1, 1, 1, -1, 1
    ]);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    var tri = new Float32Array([-1, -1, 3, -1, -1, 3]);
    this.triBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);

    this.chunks = new Map();     // key -> {vao, bufs, count, born}
    this.hexR = 8;
    this.seaLevel = 0.40;
    this.paperTint = new Float32Array([0.93, 0.89, 0.80]);
    this.paperScale = 512;

    this.fbo = null; this.fboTex = null; this.fboW = 0; this.fboH = 0;
    this.propFbo = null; this.propTex = null;   // 立体精灵层 (单独 FBO, 不污染底图 biome alpha)
    this.atlasRows = ATLAS_ROWS;   // T9: 与着色器同源常量
    this.dpr = 1;               // 设备像素比: 世界坐标换算一律用 CSS 像素 (与 main.js 相机一致)

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  InkRenderer.prototype._build = function (vsSrc, fsSrc) {
    var gl = this.gl;
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(s));
      }
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
    }
    return p;
  };

  InkRenderer.prototype._makeTexture = function (source, filter) {
    var gl = this.gl;
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return t;
  };

  InkRenderer.prototype.setTextures = function (atlas, paper, noise) {
    var gl = this.gl;
    /* T9: 构建期断言 — 图集宽高比必须推出 ATLAS_ROWS 行 (8 列固定),
       不一致直接抛错, 杜绝「调行数 → 精灵静默丢失」 */
    var cols = 8;
    var rows = Math.round(atlas.height / (atlas.width / cols));
    if (rows !== ATLAS_ROWS) {
      throw new Error('图集行数不符: 实际 ' + rows + ' 行, 着色器常量 ' + ATLAS_ROWS + ' 行');
    }
    if (this.texAtlas) gl.deleteTexture(this.texAtlas);
    if (this.texAtlasLin) gl.deleteTexture(this.texAtlasLin);
    if (this.texPaper) gl.deleteTexture(this.texPaper);
    if (this.texNoise) gl.deleteTexture(this.texNoise);
    this.texAtlas = this._makeTexture(atlas, gl.NEAREST);
    this.texAtlasLin = this._makeTexture(atlas, gl.LINEAR);   // 精灵用线性过滤, 放大更柔
    this.texPaper = this._makeTexture(paper, gl.LINEAR);
    this.texNoise = this._makeTexture(noise, gl.LINEAR);
  };

  InkRenderer.prototype.setAvgColors = function (arr) {
    this.avgColors = arr;
  };

  /* 上传道路三角面 (世界坐标, CPU 展宽成 quad; 每帧由 main.js 调用)
     water: 过水段的虚线航道 (可为空数组). 三档分开画 ⇒ 陆上路面与水上航道不同色。 */
  InkRenderer.prototype.setRoads = function (halo, core, water) {
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufHalo);
    gl.bufferData(gl.ARRAY_BUFFER, halo, gl.DYNAMIC_DRAW);
    this.roadCounts[0] = halo.length / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufCore);
    gl.bufferData(gl.ARRAY_BUFFER, core, gl.DYNAMIC_DRAW);
    this.roadCounts[1] = core.length / 2;
    water = water || new Float32Array(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufWater);
    gl.bufferData(gl.ARRAY_BUFFER, water, gl.DYNAMIC_DRAW);
    this.roadCounts[2] = water.length / 2;
  };

  /* 上传一个区块的实例数据, 建独立 VAO (底图 + 立体精灵两套) */
  InkRenderer.prototype.uploadChunk = function (key, data, bbox) {
    var gl = this.gl;
    this.dropChunk(key);
    /* R7: 记录该 chunk 世界 AABB (来自地块中心 min/max), 供渲染循环粗剔除。
       精灵可高出格面, 剔除时另加余量(见 render 的 propPad)。 */
    if (!bbox) {
      bbox = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
      var ct = data.centers;
      for (var bi = 0; bi < data.count; bi++) {
        var bx = ct[bi * 2], by = ct[bi * 2 + 1];
        if (bx < bbox.x0) bbox.x0 = bx; if (bx > bbox.x1) bbox.x1 = bx;
        if (by < bbox.y0) bbox.y0 = by; if (by > bbox.y1) bbox.y1 = by;
      }
    }
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    var bufs = [];
    var datas = [data.centers, data.tiles, data.elevs, data.hashes, data.neigh];
    var locs = [1, 2, 3, 4, 5];
    var sizes = [2, 1, 1, 1, 1];
    for (var k = 0; k < 5; k++) {
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, datas[k], gl.STATIC_DRAW);
      gl.enableVertexAttribArray(locs[k]);
      gl.vertexAttribPointer(locs[k], sizes[k], gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(locs[k], 1);
      bufs.push(buf);
    }
    gl.bindVertexArray(null);

    /* 立体精灵实例 (可为空) */
    var prop = this._buildPropVao(data);
    this.chunks.set(key, { vao: vao, bufs: bufs, count: data.tiles.length,
                           propVao: prop.vao, propBufs: prop.bufs, propCount: prop.count,
                           bbox: bbox, born: performance.now() / 1000 });
  };

  /* 建/重建一个区块的立体精灵 VAO (uploadChunk 与 updateProps 共用)
     data: { propCenters, propSprites, propHashes, propElevs }
     ⚠ 4 通道必须全绑: 漏绑 iElev 会让山/雪峰高度恒为最低档。 */
  InkRenderer.prototype._buildPropVao = function (data) {
    var gl = this.gl;
    var vao = null, bufs = [], count = 0;
    if (!data.propCenters || !data.propCenters.length) return { vao: null, bufs: [], count: 0 };
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    var pd = [data.propCenters, data.propSprites, data.propHashes, data.propElevs];
    var pl = [1, 2, 3, 4];
    for (var k = 0; k < 4; k++) {
      var pb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pb);
      gl.bufferData(gl.ARRAY_BUFFER, pd[k], gl.STATIC_DRAW);
      gl.enableVertexAttribArray(pl[k]);
      gl.vertexAttribPointer(pl[k], pl[k] === 1 ? 2 : 1, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(pl[k], 1);
      bufs.push(pb);
    }
    gl.bindVertexArray(null);
    return { vao: vao, bufs: bufs, count: data.propSprites.length };
  };

  /* 只换某区块的立体精灵 (地形网格与原 VAO 不动)。
     用途: 道路/建筑覆盖格上的树·山要被"抹平" —— 前端过滤后重传精灵实例。
     不动 born ⇒ 不触发二次墨色渐入 (那是区块初次到达时的事)。 */
  InkRenderer.prototype.updateProps = function (key, data) {
    var gl = this.gl;
    var c = this.chunks.get(key);
    if (!c) return;                       // 区块已被卸载: 丢弃 (rev 缓存已同步失效)
    if (c.propVao) {
      gl.deleteVertexArray(c.propVao);
      for (var i = 0; i < c.propBufs.length; i++) gl.deleteBuffer(c.propBufs[i]);
    }
    var prop = this._buildPropVao(data);
    c.propVao = prop.vao; c.propBufs = prop.bufs; c.propCount = prop.count;
  };

  InkRenderer.prototype.dropChunk = function (key) {
    var gl = this.gl;
    var c = this.chunks.get(key);
    if (!c) return;
    gl.deleteVertexArray(c.vao);
    for (var k = 0; k < c.bufs.length; k++) gl.deleteBuffer(c.bufs[k]);
    if (c.propVao) {
      gl.deleteVertexArray(c.propVao);
      for (k = 0; k < c.propBufs.length; k++) gl.deleteBuffer(c.propBufs[k]);
    }
    this.chunks.delete(key);
  };

  InkRenderer.prototype.resize = function (w, h) {
    var gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboW = w;
    this.fboH = h;

    /* 精灵层 FBO */
    if (this.propTex) gl.deleteTexture(this.propTex);
    if (this.propFbo) gl.deleteFramebuffer(this.propFbo);
    this.propTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.propTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.propFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.propFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.propTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  /* R7: 可视世界矩形 + bbox 相交测试 —— 只绘制与视口相交的 chunk。
     世界可视宽/高 = FBO CSS 尺寸 / zoom (uRes 以 CSS px 计, 与相机同空间) */
  InkRenderer.prototype._viewBox = function (cam) {
    var w = this.fboW / this.dpr, h = this.fboH / this.dpr;
    var hw = w * 0.5 / cam.zoom, hh = h * 0.5 / cam.zoom;
    return { x0: cam.x - hw, y0: cam.y - hh, x1: cam.x + hw, y1: cam.y + hh };
  };
  function boxHits(box, vb, pad) {
    return box && box.x1 >= vb.x0 - pad && box.x0 <= vb.x1 + pad &&
           box.y1 >= vb.y0 - pad && box.y0 <= vb.y1 + pad;
  }

  InkRenderer.prototype.render = function (cam, timeSec) {
    var gl = this.gl;
    var w = this.fboW, h = this.fboH;
    if (!w || !this.texAtlas || !this.chunks.size) {
      // 无内容也要清屏为纸色, 避免黑屏
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.93, 0.89, 0.80, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    var u = this._uHex || (this._uHex = {
      res: gl.getUniformLocation(this.progHex, 'uRes'),
      cam: gl.getUniformLocation(this.progHex, 'uCam'),
      zoom: gl.getUniformLocation(this.progHex, 'uZoom'),
      r: gl.getUniformLocation(this.progHex, 'uR'),
      apo: gl.getUniformLocation(this.progHex, 'uApo'),
      sea: gl.getUniformLocation(this.progHex, 'uSeaLevel'),
      time: gl.getUniformLocation(this.progHex, 'uTime'),
      atlas: gl.getUniformLocation(this.progHex, 'uAtlas'),
      avg: gl.getUniformLocation(this.progHex, 'uAvg[0]'),
      fade: gl.getUniformLocation(this.progHex, 'uFade'),
      tint: gl.getUniformLocation(this.progHex, 'uPaperTint')
    });

    /* ---- Pass1: 各区块 → FBO ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progHex);
    /* uRes 用 CSS 像素: 裁剪坐标与分辨率无关, FBO 仍按设备分辨率渲染,
       保证 GL 视野范围与 main.js 的 CSS 相机/流式加载完全一致 (dpr>1 时不错位) */
    gl.uniform2f(u.res, w / this.dpr, h / this.dpr);
    gl.uniform2f(u.cam, cam.x, cam.y);
    gl.uniform1f(u.zoom, cam.zoom);
    gl.uniform1f(u.r, this.hexR);
    gl.uniform1f(u.apo, this.hexR * 0.8660254);
    gl.uniform1f(u.sea, this.seaLevel);
    gl.uniform1f(u.time, timeSec);
    if (this.avgColors) gl.uniform3fv(u.avg, this.avgColors);
    gl.uniform3fv(u.tint, this.paperTint);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texAtlas);
    gl.uniform1i(u.atlas, 0);

    /* R7: Pass1 只画与视口相交的 chunk (六边形盘 ± 少量余量); 精灵遍另加高余量 */
    var vb = this._viewBox(cam);
    var hexPad = this.hexR * 2.2;
    var it = this.chunks.values();
    var node;
    while ((node = it.next())) {
      if (node.done) break;
      var c = node.value;
      if (!boxHits(c.bbox, vb, hexPad)) continue;
      var age = timeSec - c.born;
      var fade = this.noFade ? 1 : Math.min(1, age / 0.6);
      fade = fade * fade * (3 - 2 * fade);
      gl.uniform1f(u.fade, fade);
      gl.bindVertexArray(c.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, c.count);
    }
    gl.bindVertexArray(null);

    /* ---- Pass1.2: 道路 → 底图 FBO (RGB 混合, alpha 通道保持 biome 编码不变) ---- */
    if (this.roadCounts[0] || this.roadCounts[1] || this.roadCounts[2]) {
      var ur = this._uRoad || (this._uRoad = {
        res: gl.getUniformLocation(this.progRoad, 'uRes'),
        cam: gl.getUniformLocation(this.progRoad, 'uCam'),
        zoom: gl.getUniformLocation(this.progRoad, 'uZoom'),
        color: gl.getUniformLocation(this.progRoad, 'uColor')
      });
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.useProgram(this.progRoad);
      gl.uniform2f(ur.res, w / this.dpr, h / this.dpr);
      gl.uniform2f(ur.cam, cam.x, cam.y);
      gl.uniform1f(ur.zoom, cam.zoom);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufHalo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(ur.color, 0.808, 0.776, 0.627, 0.16);
      gl.drawArrays(gl.TRIANGLES, 0, this.roadCounts[0]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufCore);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(ur.color, 0.878, 0.831, 0.674, 0.55);
      gl.drawArrays(gl.TRIANGLES, 0, this.roadCounts[1]);
      /* 过水段: 虚线航道 —— 石青偏墨, 比陆上路面冷且透 (压在水色上才看得出来) */
      gl.bindBuffer(gl.ARRAY_BUFFER, this.roadBufWater);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4f(ur.color, 0.325, 0.435, 0.500, 0.62);
      gl.drawArrays(gl.TRIANGLES, 0, this.roadCounts[2]);
      gl.disable(gl.BLEND);
    }

    /* ---- Pass1.5: 立体精灵 → 独立 FBO (alpha 混合, y 序压格) ---- */
    if (!this._uProp) {
      this._uProp = {
        res: gl.getUniformLocation(this.progProp, 'uRes'),
        cam: gl.getUniformLocation(this.progProp, 'uCam'),
        zoom: gl.getUniformLocation(this.progProp, 'uZoom'),
        r: gl.getUniformLocation(this.progProp, 'uR'),
        rows: gl.getUniformLocation(this.progProp, 'uRows'),
        fade: gl.getUniformLocation(this.progProp, 'uFade'),
        tint: gl.getUniformLocation(this.progProp, 'uPaperTint'),
        atlas: gl.getUniformLocation(this.progProp, 'uAtlas')
      };
    }
    var up = this._uProp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.propFbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progProp);
    gl.uniform2f(up.res, w / this.dpr, h / this.dpr);
    gl.uniform2f(up.cam, cam.x, cam.y);
    gl.uniform1f(up.zoom, cam.zoom);
    gl.uniform1f(up.r, this.hexR);
    gl.uniform1f(up.rows, this.atlasRows);
    gl.uniform3fv(up.tint, this.paperTint);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texAtlasLin);
    gl.uniform1i(up.atlas, 0);
    /* 精灵可高出格面, 余量取较大值避免山顶/树冠被误剔 */
    var propPad = this.hexR * 12;
    it = this.chunks.values();
    while ((node = it.next())) {
      if (node.done) break;
      var cp = node.value;
      if (!cp.propCount) continue;
      if (!boxHits(cp.bbox, vb, propPad)) continue;
      var ageP = timeSec - cp.born;
      var fadeP = this.noFade ? 1 : Math.min(1, ageP / 0.6);
      fadeP = fadeP * fadeP * (3 - 2 * fadeP);
      gl.uniform1f(up.fade, fadeP);
      gl.bindVertexArray(cp.propVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cp.propCount);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    /* ---- Pass2: 水墨后处理 → 屏幕 ---- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progPost);
    var p = this._uPost || (this._uPost = {
      res: gl.getUniformLocation(this.progPost, 'uRes'),
      texel: gl.getUniformLocation(this.progPost, 'uTexel'),
      cam: gl.getUniformLocation(this.progPost, 'uCam'),
      zoom: gl.getUniformLocation(this.progPost, 'uZoom'),
      paperScale: gl.getUniformLocation(this.progPost, 'uPaperScale'),
      scene: gl.getUniformLocation(this.progPost, 'uScene'),
      props: gl.getUniformLocation(this.progPost, 'uProps'),
      paper: gl.getUniformLocation(this.progPost, 'uPaper'),
      noise: gl.getUniformLocation(this.progPost, 'uNoise')
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texPaper);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texNoise);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.propTex);
    gl.uniform1i(p.scene, 0);
    gl.uniform1i(p.paper, 1);
    gl.uniform1i(p.noise, 2);
    gl.uniform1i(p.props, 3);
    gl.uniform2f(p.res, w / this.dpr, h / this.dpr);
    gl.uniform2f(p.texel, 1 / w, 1 / h);
    gl.uniform2f(p.cam, cam.x, cam.y);
    gl.uniform1f(p.zoom, cam.zoom);
    gl.uniform1f(p.paperScale, this.paperScale);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  global.InkRenderer = InkRenderer;
})(window);
