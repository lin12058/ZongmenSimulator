/* ============================================================
 * textures.js — 程序化水墨贴图工厂
 * 产出三张贴图供 WebGL 使用:
 *   atlas  2048×2048  共 8 行 (ATLAS_ROWS=8, 与 renderer.js 常量一致):
 *     第 0~3 行  8 群系 × 4 变体 (群系底纹)
 *     第 4 行    4 异灵根灵脉峰 (雷/风/冰/暗, 精灵位 32..35)
 *     第 5/6/7 行 立体精灵 (透明底: 山/雪/林/沙/草丛/灵脉峰/草丘/孤树)
 *   paper   512×512 无缝宣纸(纤维/斑驳)
 *   noise   256×256 R:枯笔噪声 G:细纤维 B:团渍
 *   clouds  6×(256×168) 云团变体 + 等长**云影** (仅 Canvas2D 云气层用, 不进 WebGL 图集)
 * 笔触引擎模拟: 叠层枯笔(飞白)、晕染水渍、皴笔、椿点。
 * ============================================================ */
(function (global) {
  'use strict';
  var NL = global.NoiseLib;

  /* COLS × ROWS = 「群系区块」尺寸: 8 个群系列 × 每群系 4 个变体行
     (对应格底编码 tile = biome*4 + variant, variant 由 mapgen 用 %4 保证 0..3)。
     ⚠ 注意 ROWS 不是「图集总行数」—— 图集为 COLS 列 × ATLAS_ROWS(8) 行:
       第 0~3 行群系变体 / 第 4 行异灵根灵脉峰(VEIN_ROW) / 第 5~7 行立体精灵。
       与着色器对齐的总行数一律用 ATLAS_ROWS。 */
  var TILE = 128, COLS = 8, ROWS = 4;  // TILE: 笔触绘制的逻辑坐标系
  var PX = TILE * 2;                   // 实际纹素(256px/格), 提升放大后的清晰度

  /* 贴图专用固定种子: 每次加载生成完全一致的贴图 */
  var trng = NL.mulberry32(20260906);

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* 墨色常量 {r,g,b} → css */
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  var INK = [42, 38, 32];        // 焦墨
  var INK_LIGHT = [90, 84, 72];  // 淡墨

  /* ---------- 笔触: 多层叠加 + 抖动 + 飞白 ---------- */
  function strokeInk(ctx, pts, opt) {
    opt = opt || {};
    var width = opt.width || 2.5;
    var color = opt.color || INK;
    var alpha = opt.alpha == null ? 0.8 : opt.alpha;
    var layers = opt.layers == null ? 3 : opt.layers;
    var fly = opt.fly == null ? true : opt.fly;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var L = 0; L < layers; L++) {
      ctx.beginPath();
      for (var i = 0; i < pts.length; i++) {
        var jit = width * 0.45 * (0.4 + L * 0.6);
        var px = pts[i][0] + (trng() - 0.5) * jit;
        var py = pts[i][1] + (trng() - 0.5) * jit;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = rgba(color, alpha * (L === 0 ? 0.8 : 0.4));
      ctx.lineWidth = Math.max(0.4, width * (1 - L * 0.26) * (0.75 + trng() * 0.5));
      ctx.stroke();
    }
    /* 飞白: 沿笔锋扫几丝纸色 */
    if (fly && width > 1.6) {
      ctx.strokeStyle = 'rgba(236,228,210,0.30)';
      for (var f = 0; f < 2; f++) {
        ctx.beginPath();
        for (i = 0; i < pts.length; i++) {
          var fy = pts[i][1] + (trng() - 0.5) * width * 0.8;
          if (i === 0) ctx.moveTo(pts[i][0], fy); else ctx.lineTo(pts[i][0], fy);
        }
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }
  }

  /* ---------- 晕染: 大块水渍 ---------- */
  function wash(ctx, x, y, r, color, alpha) {
    var g = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---------- 椿点(树叶点) ---------- */
  function dotCluster(ctx, x, y, n, color, rBase) {
    for (var i = 0; i < n; i++) {
      var a = trng() * Math.PI * 2, d = trng() * 5;
      var px = x + Math.cos(a) * d, py = y + Math.sin(a) * d * 0.7;
      ctx.fillStyle = rgba(color, 0.35 + trng() * 0.3);
      ctx.beginPath();
      ctx.arc(px, py, rBase * (0.5 + trng() * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- 山峰剪影 (水墨皴法) ---------- */
  function drawPeak(ctx, cx, baseY, w, h, dark, mid, inkA) {
    inkA = inkA == null ? 0.75 : inkA;
    var apexX = cx + (trng() - 0.5) * w * 0.10;
    var apexY = baseY - h;
    var g = ctx.createLinearGradient(0, apexY, 0, baseY);
    g.addColorStop(0, rgba(dark, 0.95));
    g.addColorStop(0.45, rgba(mid, 0.55));
    g.addColorStop(1, rgba(mid, 0.0));
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, baseY);
    ctx.quadraticCurveTo(cx - w * 0.30, baseY - h * 0.55, apexX - w * 0.06, apexY + h * 0.06);
    ctx.lineTo(apexX, apexY);
    ctx.lineTo(apexX + w * 0.08, apexY + h * 0.05);
    ctx.quadraticCurveTo(cx + w * 0.28, baseY - h * 0.5, cx + w * 0.5, baseY);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    /* 山脊轮廓 */
    strokeInk(ctx, [
      [cx - w * 0.5, baseY],
      [cx - w * 0.30, baseY - h * 0.55],
      [apexX - w * 0.05, apexY + h * 0.08],
      [apexX, apexY]
    ], { width: 1.6, color: INK, alpha: inkA * 0.55, fly: false, layers: 2 });
    /* 皴笔: 自脊向左下短披麻 */
    var nCun = 4 + (trng() * 3 | 0);
    for (var i = 0; i < nCun; i++) {
      var t = 0.15 + trng() * 0.7;
      var sx = cx - w * 0.30 + (apexX - cx + w * 0.30) * t;
      var sy = baseY - h * 0.55 - (baseY - h * 0.55 - apexY) * (1 - t) * 0.4;
      var len = (3 + trng() * 6) * (w / 40);
      strokeInk(ctx, [
        [sx, sy], [sx - len * 0.8, sy + len], [sx - len, sy + len * 1.5]
      ], { width: 1.1, color: INK, alpha: 0.28 + trng() * 0.2, fly: false, layers: 1 });
    }
  }

  /* ---------- 各群系格面绘制 ---------- */
  var painters = [];

  /* 0 深海: 碧蓝底 + 隐约长波 */
  painters[0] = function (ctx, v) {
    ctx.fillStyle = '#6d9aab';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, 30 + trng() * 60, 30 + trng() * 60, 60, [58, 96, 116], 0.10);
    wash(ctx, trng() * 128, trng() * 128, 46, [118, 158, 172], 0.12);
    for (var i = 0; i < 2; i++) {
      var yy = 15 + trng() * 100, xx = trng() * 60;
      strokeInk(ctx, [[xx, yy], [xx + 22 + trng() * 20, yy + (trng() - 0.5) * 5]],
        { width: 1.2, color: [52, 88, 108], alpha: 0.13, fly: false, layers: 1 });
    }
  };

  /* 1 浅海: 淡碧蓝底 + 水纹弧线 + 白沫碎点 */
  painters[1] = function (ctx, v) {
    ctx.fillStyle = '#9dc2c9';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [152, 192, 196], 0.25);
    wash(ctx, trng() * 128, trng() * 128, 40, [174, 208, 208], 0.20);
    var n = 5 + (trng() * 3 | 0);
    for (var i = 0; i < n; i++) {
      var xx = 8 + trng() * 90, yy = 10 + trng() * 108;
      var ww = 12 + trng() * 16;
      strokeInk(ctx, [
        [xx, yy], [xx + ww * 0.5, yy - 2.5 - trng() * 1.5], [xx + ww, yy]
      ], { width: 1.2, color: [76, 118, 128], alpha: 0.28, fly: false, layers: 1 });
    }
    /* 白色浪尖碎点 */
    for (i = 0; i < 8; i++) {
      ctx.fillStyle = 'rgba(238,244,242,' + (0.14 + trng() * 0.16).toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(trng() * 128, trng() * 128, 0.7 + trng() * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* 2 沙岸: 米黄 + 碎点 */
  painters[2] = function (ctx, v) {
    ctx.fillStyle = '#e0d3ae';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 50, [214, 195, 152], 0.25);
    for (var i = 0; i < 26; i++) {
      ctx.fillStyle = rgba([160, 140, 100], 0.12 + trng() * 0.12);
      ctx.beginPath();
      ctx.arc(trng() * 128, trng() * 128, 0.6 + trng() * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* 3 草地: 淡青绿 + 草笔 + 极淡小草坪斑块 (参考图: 近看才有细微色差) */
  painters[3] = function (ctx, v) {
    ctx.fillStyle = '#b4c3a0';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, 20 + trng() * 88, 20 + trng() * 88, 52, [168, 185, 142], 0.22);
    wash(ctx, trng() * 128, trng() * 128, 40, [196, 205, 172], 0.25);
    /* 微小草坪: 2.5~7px 亮/暗斑, 对比提到隐约可见 */
    var nPatch = 12 + (trng() * 6 | 0);
    for (var pi = 0; pi < nPatch; pi++) {
      var px = 6 + trng() * 116, py = 6 + trng() * 116, pr = 2.5 + trng() * 4.5;
      var lit = trng() > 0.4;
      ctx.fillStyle = lit ? 'rgba(210,220,180,' + (0.11 + trng() * 0.07).toFixed(3) + ')'
                          : 'rgba(140,156,108,' + (0.10 + trng() * 0.06).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(px, py, pr, pr * (0.6 + trng() * 0.4), trng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    var n = 14 + (trng() * 7 | 0);
    for (var i = 0; i < n; i++) {
      var xx = 6 + trng() * 116, yy = 14 + trng() * 108;
      var h = 4 + trng() * 7;
      strokeInk(ctx, [
        [xx, yy], [xx + (trng() - 0.5) * 3, yy - h * 0.6], [xx + (trng() - 0.5) * 4, yy - h]
      ], { width: 1.2, color: [110, 126, 88], alpha: 0.40, fly: false, layers: 1 });
    }
    /* 草丛簇 */
    for (i = 0; i < 3; i++) {
      var bx = 15 + trng() * 98, by = 20 + trng() * 100;
      for (var k = 0; k < 4; k++) {
        var ox = (trng() - 0.5) * 7;
        strokeInk(ctx, [[bx + ox, by], [bx + ox + (trng() - 0.5) * 2, by - 5 - trng() * 4]],
          { width: 1.1, color: [96, 112, 76], alpha: 0.45, fly: false, layers: 1 });
      }
    }
  };

  /* 4 林地: 草底 + 双色树冠团簇 (参考图斑驳林感: 暗底 + 亮冠 + 高光点) */
  painters[4] = function (ctx, v) {
    painters[3](ctx, v);
    var n = 6 + (trng() * 4 | 0);
    for (var i = 0; i < n; i++) {
      var xx = 14 + trng() * 100, yy = 16 + trng() * 100;
      var cr = 3.5 + trng() * 4.5;
      /* 暗色底冠 */
      ctx.fillStyle = rgba([52, 76, 46], 0.42 + trng() * 0.18);
      ctx.beginPath();
      ctx.arc(xx, yy + cr * 0.25, cr, 0, Math.PI * 2);
      ctx.fill();
      /* 亮色主冠 (偏右上) */
      ctx.fillStyle = rgba([76, 104, 56], 0.45 + trng() * 0.2);
      ctx.beginPath();
      ctx.arc(xx - cr * 0.18, yy - cr * 0.2, cr * 0.78, 0, Math.PI * 2);
      ctx.fill();
      /* 高光碎点 */
      dotCluster(ctx, xx - cr * 0.3, yy - cr * 0.4, 4, [104, 132, 70], cr * 0.28);
      /* 树干阴影 */
      strokeInk(ctx, [[xx, yy + 2], [xx, yy + 5 + trng() * 2]],
        { width: 1.0, color: [70, 60, 44], alpha: 0.4, fly: false, layers: 1 });
    }
  };

  /* 5 沙漠: 赭黄 + 沙丘弧线 + 风痕 */
  painters[5] = function (ctx, v) {
    ctx.fillStyle = '#dfc994';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, 20 + trng() * 90, 58, [206, 178, 120], 0.22);
    var n = 2 + (trng() * 2 | 0);
    for (var i = 0; i < n; i++) {
      var yy = 25 + trng() * 85, xx = 5 + trng() * 30;
      var ww = 55 + trng() * 60;
      strokeInk(ctx, [
        [xx, yy], [xx + ww * 0.4, yy - 7 - trng() * 5], [xx + ww * 0.8, yy - 1], [xx + ww, yy + 2]
      ], { width: 1.7, color: [166, 138, 88], alpha: 0.45, layers: 2 });
      strokeInk(ctx, [
        [xx + 6, yy + 6], [xx + ww * 0.5, yy - 2], [xx + ww - 4, yy + 5]
      ], { width: 1.0, color: [150, 122, 76], alpha: 0.22, fly: false, layers: 1 });
    }
    for (i = 0; i < 6; i++) {
      var fx = trng() * 100, fy = trng() * 128;
      strokeInk(ctx, [[fx, fy], [fx + 8 + trng() * 8, fy + (trng() - 0.5) * 2]],
        { width: 0.9, color: [172, 146, 98], alpha: 0.3, fly: false, layers: 1 });
    }
  };

  /* 6 山地: 岩灰地表 (山峰由立体精灵承担) */
  painters[6] = function (ctx, v) {
    ctx.fillStyle = '#b1aa9c';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [156, 148, 132], 0.25);
    wash(ctx, trng() * 128, trng() * 128, 40, [176, 168, 150], 0.20);
    /* 碎石点 */
    for (var i = 0; i < 18; i++) {
      ctx.fillStyle = rgba([120, 112, 96], 0.15 + trng() * 0.20);
      ctx.beginPath();
      ctx.arc(trng() * 128, trng() * 128, 0.8 + trng() * 2.0, 0, Math.PI * 2);
      ctx.fill();
    }
    /* 低矮丘影横皴 */
    for (i = 0; i < 3; i++) {
      var yy = 20 + trng() * 90, xx = trng() * 40;
      strokeInk(ctx, [[xx, yy], [xx + 26 + trng() * 30, yy - 4 - trng() * 4], [xx + 60 + trng() * 40, yy]],
        { width: 1.2, color: [110, 102, 88], alpha: 0.18, fly: false, layers: 1 });
    }
  };

  /* 7 雪峰: 雪原地表 (白头山由立体精灵承担) */
  painters[7] = function (ctx, v) {
    ctx.fillStyle = '#e2e0d6';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [214, 214, 206], 0.3);
    wash(ctx, trng() * 128, trng() * 128, 38, [246, 246, 240], 0.35);
    for (var i = 0; i < 10; i++) {
      ctx.fillStyle = rgba([190, 192, 188], 0.18 + trng() * 0.2);
      ctx.beginPath();
      ctx.arc(trng() * 128, trng() * 128, 0.7 + trng() * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  /* ---------- 灵脉配色已外移到 web/js/vein-skin.js (唯一真源) ----------
     此前的 VEIN_BASE(暗岩格底) / VEIN_TINT(灵根色表) 已随之删除:
     · 灵脉格底是死图 (tile 索引由 biome*4+variant 而来, 恒 ≤31, 走不到第 4 行);
     · 灵根色改由 VeinSkin.elements / VeinSkin.variants 提供 (本文件不再内联色值)。 */

  /* 灵根符纹 (TILE 坐标系内作画) */
  var drawSigil = [
    /* 金: 剑意竖锋 + 菱晶 */
    function (ctx, c) {
      strokeInk(ctx, [[64, 28], [64, 98]], { width: 2.2, color: c, alpha: 0.65, layers: 2 });
      strokeInk(ctx, [[50, 60], [64, 44], [78, 60], [64, 76], [50, 60]],
        { width: 1.6, color: [236, 228, 206], alpha: 0.6, layers: 2 });
      strokeInk(ctx, [[88, 34], [96, 26]], { width: 1.2, color: c, alpha: 0.4, layers: 1 });
      strokeInk(ctx, [[40, 90], [32, 98]], { width: 1.2, color: c, alpha: 0.4, layers: 1 });
    },
    /* 木: 主脉 + 羽状侧脉 */
    function (ctx, c) {
      strokeInk(ctx, [[64, 26], [64, 100]], { width: 2.0, color: c, alpha: 0.6, layers: 2 });
      for (var s = 0; s < 4; s++) {
        var y = 36 + s * 17;
        strokeInk(ctx, [[64, y], [44, y - 9]], { width: 1.2, color: c, alpha: 0.45, layers: 1 });
        strokeInk(ctx, [[64, y], [84, y - 9]], { width: 1.2, color: c, alpha: 0.45, layers: 1 });
      }
    },
    /* 水: 三叠浪弧 */
    function (ctx, c) {
      for (var s = 0; s < 3; s++) {
        var y = 42 + s * 22;
        strokeInk(ctx, [[34, y], [52, y - 8], [72, y + 4], [94, y - 4]],
          { width: 1.8, color: c, alpha: 0.55, layers: 2 });
      }
    },
    /* 火: 焰形主笔 + 飞火 */
    function (ctx, c) {
      strokeInk(ctx, [[64, 96], [50, 70], [64, 52], [56, 38], [70, 24], [76, 46], [68, 62], [80, 78]],
        { width: 2.0, color: c, alpha: 0.6, layers: 2 });
      strokeInk(ctx, [[40, 92], [34, 80], [42, 68]], { width: 1.2, color: c, alpha: 0.4, layers: 1 });
      strokeInk(ctx, [[88, 94], [94, 82], [86, 70]], { width: 1.2, color: c, alpha: 0.4, layers: 1 });
    },
    /* 土: 三层台地横皴 */
    function (ctx, c) {
      for (var s = 0; s < 3; s++) {
        var y = 40 + s * 20;
        strokeInk(ctx, [[30, y], [64, y - 6], [98, y]], { width: 1.8, color: c, alpha: 0.5, layers: 2 });
      }
      strokeInk(ctx, [[44, 52], [84, 52]], { width: 1.0, color: c, alpha: 0.3, fly: false, layers: 1 });
    }
  ];

  /* 异灵根符纹 (键名须与 vein-skin.js variants 的 key 一致) */
  var drawSigilVariant = {
    /* 雷: 折线电芒 */
    '雷': function (ctx, c) {
      strokeInk(ctx, [[70, 20], [52, 58], [68, 56], [46, 104]],
        { width: 2.0, color: c, alpha: 0.62, layers: 2 });
      strokeInk(ctx, [[86, 34], [74, 62], [88, 68]],
        { width: 1.2, color: c, alpha: 0.38, layers: 1 });
    },
    /* 风: 三叠回旋弧 */
    '风': function (ctx, c) {
      for (var s = 0; s < 3; s++) {
        var y = 40 + s * 20;
        strokeInk(ctx, [[30, y], [56, y - 10], [84, y + 6], [100, y - 2]],
          { width: 1.6, color: c, alpha: 0.50 - s * 0.08, layers: 2 });
      }
      strokeInk(ctx, [[64, 30], [78, 44], [64, 58]],
        { width: 1.2, color: c, alpha: 0.34, layers: 1 });
    },
    /* 冰: 六棱晶 */
    '冰': function (ctx, c) {
      strokeInk(ctx, [[64, 24], [64, 104]], { width: 1.8, color: c, alpha: 0.55, layers: 2 });
      strokeInk(ctx, [[44, 40], [84, 88]], { width: 1.4, color: c, alpha: 0.45, layers: 2 });
      strokeInk(ctx, [[84, 40], [44, 88]], { width: 1.4, color: c, alpha: 0.45, layers: 2 });
      strokeInk(ctx, [[40, 64], [88, 64]], { width: 1.2, color: c, alpha: 0.40, layers: 1 });
    },
    /* 暗: 涡旋 + 星点 */
    '暗': function (ctx, c) {
      strokeInk(ctx, [[62, 30], [82, 46], [70, 66], [46, 62], [42, 84], [70, 96], [92, 82]],
        { width: 1.8, color: c, alpha: 0.50, layers: 2 });
      for (var i = 0; i < 5; i++) {
        ctx.fillStyle = rgba(c, 0.30 + trng() * 0.30);
        ctx.beginPath();
        ctx.arc(36 + trng() * 56, 32 + trng() * 64, 0.8 + trng() * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  /* ============================================================
   * 立体精灵 (第 5/6/7 行): 透明底绘制, 超出格子压到邻格上
   * ============================================================ */

  /* 接地投影: 椭圆软墨 */
  function propShadow(ctx, cx, cy, rx, ry, a) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, (ry || rx * 0.35) / rx);
    var g = ctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx);
    g.addColorStop(0, 'rgba(48,42,34,' + (a == null ? 0.30 : a) + ')');
    g.addColorStop(1, 'rgba(48,42,34,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* 透明底山峰: 渐变山体 + 受光面/背光面 + 皴笔 + 岩层横裂 + 可选雪帽/雪线挂雪 */
  function drawPropPeak(ctx, cx, baseY, w, h, dark, mid, opt) {
    opt = opt || {};
    var apexY = baseY - h;
    var g = ctx.createLinearGradient(0, apexY, 0, baseY);
    /* opt.g0/g1 可放宽脊线对比 (灵脉峰比岩峰淡一档 → 不用焦墨般的 0.92) */
    g.addColorStop(0, rgba(dark, opt.g0 == null ? 0.92 : opt.g0));
    g.addColorStop(0.5, rgba(mid, opt.g1 == null ? 0.50 : opt.g1));
    g.addColorStop(1, rgba(mid, 0.0));
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, baseY);
    ctx.quadraticCurveTo(cx - w * 0.28, baseY - h * 0.5, cx - w * 0.04, apexY + h * 0.05);
    ctx.quadraticCurveTo(cx + w * 0.10, apexY, cx + w * 0.17, apexY + h * 0.11);
    ctx.quadraticCurveTo(cx + w * 0.30, baseY - h * 0.45, cx + w * 0.5, baseY);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    /* 受光面 (左坡): 淡亮 wash, 参考图日光自左上来
       (opt.lit0/1/2 可换色: 灵脉峰用青白, 岩峰用暖白) */
    var gl2 = ctx.createLinearGradient(cx - w * 0.5, baseY, cx, apexY);
    gl2.addColorStop(0, opt.lit0 || 'rgba(214,210,196,0)');
    gl2.addColorStop(0.55, opt.lit1 || 'rgba(214,210,196,0.16)');
    gl2.addColorStop(1, opt.lit2 || 'rgba(226,222,208,0.30)');
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, baseY);
    ctx.quadraticCurveTo(cx - w * 0.28, baseY - h * 0.5, cx - w * 0.04, apexY + h * 0.05);
    ctx.quadraticCurveTo(cx + w * 0.04, apexY + h * 0.10, cx + w * 0.02, baseY - h * 0.30);
    ctx.quadraticCurveTo(cx - w * 0.24, baseY - h * 0.22, cx - w * 0.5, baseY);
    ctx.closePath();
    ctx.fillStyle = gl2;
    ctx.fill();
    /* 背光面 (右坡): 深色压暗, 拉开体积 */
    ctx.beginPath();
    ctx.moveTo(cx + w * 0.5, baseY);
    ctx.quadraticCurveTo(cx + w * 0.30, baseY - h * 0.45, cx + w * 0.17, apexY + h * 0.11);
    ctx.quadraticCurveTo(cx + w * 0.10, apexY + h * 0.04, cx + w * 0.05, apexY + h * 0.16);
    ctx.quadraticCurveTo(cx + w * 0.16, baseY - h * 0.40, cx + w * 0.30, baseY);
    ctx.closePath();
    ctx.fillStyle = rgba(dark, 0.30);
    ctx.fill();
    /* 岩层横裂: 右坡短促横向皴断 (参考图岩壁层理)
       (opt.noCrag: 灵脉峰不画岩层, 改在外面叠「米点皴」) */
    var nCrag = opt.noCrag ? 0 : 2 + (trng() * 2 | 0);
    for (var ci = 0; ci < nCrag; ci++) {
      var ct = 0.30 + trng() * 0.45;
      var cxp = cx + w * (0.08 + ct * 0.16);
      var cyp = baseY - h * (0.30 + ct * 0.42);
      var cw = w * (0.10 + trng() * 0.12);
      strokeInk(ctx, [
        [cxp - cw, cyp], [cxp, cyp + 2.2], [cxp + cw, cyp - 1.5]
      ], { width: 1.0, color: INK, alpha: 0.20 + trng() * 0.15, fly: false, layers: 1 });
    }
    if (opt.snow) {
      /* 雪帽: 锯齿状下缘 */
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.03, apexY + h * 0.03);
      ctx.lineTo(cx + w * 0.10, apexY + h * 0.10);
      ctx.lineTo(cx + w * 0.05, apexY + h * 0.09);
      ctx.lineTo(cx + w * 0.13, apexY + h * 0.17);
      ctx.lineTo(cx + w * 0.04, apexY + h * 0.14);
      ctx.lineTo(cx + w * 0.06, apexY + h * 0.22);
      ctx.lineTo(cx - w * 0.04, apexY + h * 0.15);
      ctx.lineTo(cx - w * 0.02, apexY + h * 0.23);
      ctx.lineTo(cx - w * 0.12, apexY + h * 0.16);
      ctx.lineTo(cx - w * 0.09, apexY + h * 0.24);
      ctx.lineTo(cx - w * 0.18, apexY + h * 0.15);
      ctx.quadraticCurveTo(cx - w * 0.13, apexY + h * 0.06, cx + w * 0.03, apexY + h * 0.03);
      ctx.closePath();
      ctx.fillStyle = 'rgba(250,250,248,0.96)';
      ctx.fill();
      /* 挂雪沟槽: 沿两坡向下延伸的白色条痕 */
      var nStreak = 2 + (trng() * 2 | 0);
      for (var si = 0; si < nStreak; si++) {
        var st0 = 0.10 + trng() * 0.22;
        var sxp = cx + (trng() - 0.5) * w * 0.16;
        var syp = apexY + h * st0;
        var sl = h * (0.14 + trng() * 0.16);
        var sdx = (sxp < cx ? -1 : 1) * w * 0.10;
        ctx.beginPath();
        ctx.moveTo(sxp - 1.6, syp);
        ctx.quadraticCurveTo(sxp + sdx * 0.5, syp + sl * 0.55, sxp + sdx, syp + sl);
        ctx.quadraticCurveTo(sxp + sdx * 0.3 + 1.4, syp + sl * 0.6, sxp + 1.6, syp);
        ctx.closePath();
        ctx.fillStyle = 'rgba(248,249,247,' + (0.55 + trng() * 0.3).toFixed(2) + ')';
        ctx.fill();
      }
    }
    strokeInk(ctx, [
      [cx - w * 0.5, baseY],
      [cx - w * 0.27, baseY - h * 0.52],
      [cx - w * 0.02, apexY + h * 0.07]
    ], { width: 1.5, color: INK, alpha: 0.5, fly: false, layers: 2 });
    /* 披麻皴: 自脊向左下短披麻 */
    var nCun = 5 + (trng() * 3 | 0);
    for (var i = 0; i < nCun; i++) {
      var t = 0.2 + trng() * 0.6;
      var sx = cx - w * 0.27 + w * 0.25 * t;
      var sy = baseY - h * 0.52 - h * 0.40 * (1 - t);
      var len = (4 + trng() * 7) * (w / 50);
      strokeInk(ctx, [
        [sx, sy], [sx - len * 0.7, sy + len], [sx - len, sy + len * 1.6]
      ], { width: 1.0, color: INK, alpha: 0.20 + trng() * 0.18, fly: false, layers: 1 });
    }
  }

  /* ============================================================
   * 灵脉山体 (三改版, 定稿) —— 山形**直接复用 drawPropPeak 的已验证骨架**,
   *   只换「色 / 气 / 皴」: 大世界岩峰是深暖灰 + 焦墨勾脊 + 披麻皴 + 岩层横裂
   *   (硬朗、有骨、近); 灵脉峰是**青灰绿** + 收敛的峰顶渐变 (opt.g0/g1) +
   *   `noCrag`(免岩层横裂) + 米点皴 + 山脚「云断」横带 + 灵气敷色 + 元素符印
   *   ⇒ 同族山形, 换一身皮, 上屏读作「氤氲远峰」而非「另一物种」。
   *
   *   ⚠ 为什么不再自己造形 (前两版画崩的真因):
   *     (1) PROP_VS 把整个 128 格**非等比**映射到 W×H, W 常是 H 的 1.5~2.2 倍
   *         ⇒ 128 坐标里画的东西上屏被横向拉宽, 自造形状极易变矮胖/兔耳。
   *     (2) drawPropPeak 的凹左坡+偏右峰尖+凸右坡骨架**已过大世界实机验证**,
   *         站在巨人肩上比自己另捏山形稳得多。颜色/纹理差异足够拉开辨识度。
   * ============================================================ */
  /* 云气/米点两色 (灵脉峰只用这两个; 青灰绿山体色已内联在 propVein 的
     drawPropPeak 调用里, 免得两处维护) */
  var MIST_PAL = {
    pale: [228, 233, 221],   // 云气 / 留白 (云断横带)
    dark: [72, 88, 68]       // 米点皴
  };

  /* 米点皴: 沿坡面成串的横点 —— 米氏云山的招牌笔法。
     落在**渐隐线以上**的中上段 (下半已化开, 点在那儿会像悬空的黑点)。 */
  function miDian(ctx, cx, baseY, w, h, n, col) {
    for (var i = 0; i < n; i++) {
      var t = 0.44 + trng() * 0.48;
      var side = trng() < 0.5 ? -1 : 1;
      var px = cx + side * w * (0.5 - 0.28 * t) * (0.30 + trng() * 0.62);
      var py = baseY - h * t;
      var run = 2 + (trng() * 3 | 0);
      for (var j = 0; j < run; j++) {
        ctx.fillStyle = rgba(col, 0.18 + trng() * 0.24);
        ctx.beginPath();
        ctx.ellipse(px + (j - run / 2) * w * 0.045 + (trng() - 0.5) * 2,
                    py + (trng() - 0.5) * h * 0.05,
                    w * (0.022 + trng() * 0.016), w * (0.014 + trng() * 0.010),
                    0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* 云气横带: 一条水平软霭 (传统「云断」) —— 把山拦腰隔开, 立刻有氤氲气 */
  /* col 缺省 = 通用云气色; 灵脉峰传自己的 pal.mist (五行/异灵根各有云气色) */
  function mistBand(ctx, cx, y, w, h, a, col) {
    col = col || MIST_PAL.pale;
    var g = ctx.createLinearGradient(0, y - h, 0, y + h);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(0.5, rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, y, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /* 透明底树: 枯笔干 + 多层球冠 (暗底冠/主冠/高光) + 可选花色
   * pal: {trunk, c1 暗冠, c2 主冠, c3 高光, bloom 花色(可空)} */
  var TREE_PAL = {
    leaf:   { trunk: [74, 62, 46], c1: [50, 76, 44], c2: [72, 100, 54], c3: [102, 130, 66] },
    pine:   { trunk: [58, 48, 36], c1: [38, 60, 42], c2: [52, 76, 48], c3: [72, 96, 56] },
    blossom:{ trunk: [78, 62, 48], c1: [54, 80, 48], c2: [76, 104, 56], c3: [104, 132, 68],
              bloom: [216, 156, 168], bloom2: [190, 118, 140] },
    autumn: { trunk: [70, 56, 42], c1: [108, 78, 38], c2: [148, 106, 46], c3: [192, 142, 60] }
  };
  function propTree(ctx, x, baseY, h, palName) {
    var pal = TREE_PAL[palName || 'leaf'] || TREE_PAL.leaf;
    var lean = (trng() - 0.5) * 4;
    strokeInk(ctx, [
      [x, baseY],
      [x + lean * 0.5, baseY - h * 0.45],
      [x + lean, baseY - h * 0.86]
    ], { width: 1.7, color: pal.trunk, alpha: 0.62, fly: false, layers: 2 });
    /* 分枝 */
    strokeInk(ctx, [
      [x + lean * 0.3, baseY - h * 0.5], [x + lean * 0.3 + h * 0.12, baseY - h * 0.66]
    ], { width: 1.0, color: pal.trunk, alpha: 0.42, fly: false, layers: 1 });
    var cy = baseY - h * 0.74, cr = h * 0.40;
    /* 暗底冠 (左下) */
    dotCluster(ctx, x - cr * 0.34 + lean * 0.3, cy + cr * 0.18, 12, pal.c1, cr * 0.44);
    /* 主冠 */
    dotCluster(ctx, x + lean * 0.7, cy - cr * 0.10, 11, pal.c2, cr * 0.40);
    /* 高光 (右上, 受光面) */
    dotCluster(ctx, x + cr * 0.30 + lean * 0.8, cy - cr * 0.42, 9, pal.c3, cr * 0.30);
    /* 花色点缀 (花树/异色树) */
    if (pal.bloom) {
      dotCluster(ctx, x + lean * 0.5, cy - cr * 0.30, 7, pal.bloom, cr * 0.26);
      dotCluster(ctx, x - cr * 0.20 + lean * 0.4, cy + cr * 0.05, 4, pal.bloom2, cr * 0.20);
    }
  }

  /* ---- 第 5 行: 山 0/1 · 雪 2/3 · 林 4..7 (松/阔/花/秋 四种林相) ---- */
  function propMountain(ctx) {
    /* (接地投影椭圆已移除: 密排缩小时三圆连成黑线穿帮) */
    /* 远峰 (淡) + 主峰 (深): 前后层次
       (山脚碎石点与山脚晕染已移除: 密排时连成黑点线穿帮) */
    drawPropPeak(ctx, 46, 106, 64, 90, [70, 64, 54], [138, 132, 116], {});
    drawPropPeak(ctx, 86, 104, 50, 60, [90, 84, 72], [156, 148, 130], {});
  }
  function propSnow(ctx) {
    drawPropPeak(ctx, 88, 104, 46, 54, [112, 114, 118], [162, 164, 164], { snow: true });
    drawPropPeak(ctx, 48, 106, 64, 94, [96, 98, 102], [146, 148, 148], { snow: true });
  }
  function propForest(v) {
    return function (ctx) {
      propShadow(ctx, 64, 108, 34, 11, 0.26);
      /* 小而密的树丛: 树高 36~58, 每精灵 3~4 棵互相搭冠 (参考图密林感) */
      if (v === 0) {                          // 阔叶混交
        propTree(ctx, 44, 104, 52, 'leaf'); propTree(ctx, 72, 101, 42, 'leaf'); propTree(ctx, 90, 104, 34, 'leaf');
      } else if (v === 1) {                   // 松林高耸
        propTree(ctx, 60, 105, 58, 'pine'); propTree(ctx, 40, 102, 40, 'pine'); propTree(ctx, 82, 103, 36, 'pine');
      } else if (v === 2) {                   // 花树点缀
        propTree(ctx, 46, 104, 48, 'leaf'); propTree(ctx, 74, 102, 44, 'blossom'); propTree(ctx, 90, 105, 34, 'leaf');
      } else {                                // 秋色点染
        propTree(ctx, 50, 104, 50, 'leaf'); propTree(ctx, 78, 101, 40, 'autumn'); propTree(ctx, 92, 104, 34, 'leaf');
      }
      wash(ctx, 64, 100, 26, [96, 116, 80], 0.14);
    };
  }

  /* ---- 第 6 行: 沙 0 · 草丛 1 · 灵脉峰 2..6 (金木水火土) ---- */
  function propDesert(ctx) {
    propShadow(ctx, 64, 106, 34, 11, 0.22);
    var g = ctx.createLinearGradient(0, 56, 0, 106);
    g.addColorStop(0, 'rgba(224,198,140,0.92)');
    g.addColorStop(1, 'rgba(206,178,120,0)');
    ctx.beginPath();
    ctx.moveTo(20, 106);
    ctx.quadraticCurveTo(50, 50, 96, 96);
    ctx.quadraticCurveTo(106, 101, 112, 106);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    strokeInk(ctx, [[20, 106], [50, 64], [96, 98]],
      { width: 1.4, color: [150, 122, 76], alpha: 0.40, fly: false, layers: 2 });
    for (var i = 0; i < 3; i++) {
      ctx.fillStyle = rgba([140, 120, 88], 0.45 + trng() * 0.3);
      ctx.beginPath();
      ctx.arc(30 + trng() * 60, 86 + trng() * 14, 2 + trng() * 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    strokeInk(ctx, [[70, 40], [86, 36], [100, 40]],
      { width: 1.0, color: [180, 150, 100], alpha: 0.30, fly: false, layers: 1 });
  }
  function propBush(ctx) {
    propShadow(ctx, 64, 108, 24, 8, 0.20);
    dotCluster(ctx, 60, 96, 12, [70, 92, 62], 4.5);
    dotCluster(ctx, 74, 100, 9, [88, 110, 72], 3.6);
    dotCluster(ctx, 66, 92, 6, [106, 132, 76], 2.6);
    for (var i = 0; i < 5; i++) {
      var xx = 50 + trng() * 28;
      strokeInk(ctx, [[xx, 106], [xx + (trng() - 0.5) * 3, 96 - trng() * 6]],
        { width: 1.1, color: [96, 112, 76], alpha: 0.5, fly: false, layers: 1 });
    }
  }
  /* ============================================================
   * 灵脉峰 (2026-09-14 六版: 宽顶缓坡块面 + 下半截渐隐)
   * ------------------------------------------------------------
   * 美术方向对齐参考图: **宽而圆的顶 + 两肩 + 缓坡 + 山脚化进地形**。
   *   · 五版是「折线尖锥 + 硬切底边」⇒ 实机读作「三角形山」且下半不透, 已废弃;
   *   · 与大世界岩峰 (drawPropPeak) 的区分仍靠「色 / 气 / 皴」——
   *     五行/异灵根配色 + 米点皴 + 山脚云断 + 灵根符纹, 而**形**现在同源。
   *
   *   ⚠ 前提 (历次画崩的根因, 别再踩): renderer.js PROP_VS 把整个 128 格
   *     非等比映射到 W×H 方框。vein-skin.shape 的 hScale/wScale 已把灵脉峰的
   *     方框调成**近似正方形** (解出 W≈H), 所以 128 坐标里画的山形上屏不再
   *     被横向拉宽。若改 hScale/wScale 破坏了这一平衡, 山形会再次变形。
   * ============================================================ */

  /* 宽顶缓坡山形 (对齐参考图):
     左山脚 → 左坡 → 左肩 → 顶台(微隆) → 右肩 → 右坡 → 右山脚。
     · topW 决定顶台宽度 (0.44 ⇒ 宽顶, 不是尖锥);
     · 坡面剖面 x = 1-(1-t)^0.50 (钟形) ⇒ 山腰仍宽 (~0.79 底宽), 不是"喇叭口";
     · 顶面做成**圆拱** (sin 隆起 0.11h) ⇒ 免得读成"梯形台/方山"。 */
  function veinPeakPts(cx, baseY, w, h) {
    var S = VeinSkin.shape;
    var topW = S.topW == null ? 0.44 : S.topW;
    var N = Math.max(5, (S.seg | 0) || 9);
    var M = Math.max(3, (S.topSeg | 0) || 7);
    /* ⚠ 肩高/顶台中拱的偏移量在 vein-skin.js 的 SHAPE (shoulderU/archU) —— 不是
       这里的魔数: vein-skin 的 apexV() 要用它们反推「峰尖在方框里的位置」给灵脉签
       定位 (2026-09-16)。写死在这里 ⇒ 改峰形时签位静默错开。 */
    var shU = S.shoulderU == null ? 0.10 : S.shoulderU;
    var arU = S.archU == null ? 0.11 : S.archU;
    var apY = baseY - h, xL = cx - w * 0.5, xR = cx + w * 0.5;
    var shY = apY + h * shU;                         // 肩高 (顶台两端)
    var labX = cx - w * topW * 0.5, rabX = cx + w * topW * 0.5;
    var pts = [[xL, baseY]], i, t;
    for (i = 1; i <= N; i++) {                       // 左坡: 底 → 左肩
      t = i / N;
      pts.push([labX - (labX - xL) * Math.pow(1 - t, 0.50),
                baseY + (shY - baseY) * Math.pow(t, 0.94)]);
    }
    for (i = 1; i < M; i++) {                        // 顶台: 左肩 → 右肩
      t = i / M;
      pts.push([labX + (rabX - labX) * t, shY - Math.sin(Math.PI * t) * h * arU]);
    }
    for (i = N; i >= 0; i--) {                       // 右坡: 右肩 → 底
      t = i / N;
      pts.push([rabX + (xR - rabX) * Math.pow(1 - t, 0.50),
                baseY + (shY - baseY) * Math.pow(t, 0.94)]);
    }
    var apex = 0;                                    // 最高点 (顶台中部)
    for (i = 1; i < pts.length; i++) if (pts[i][1] < pts[apex][1]) apex = i;
    return { pts: pts, apex: apex };
  }
  function tracePts(ctx, pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  /* 单座灵脉峰: 宽顶块面 + **下半截渐隐** + 墨线只勾上段。
     ⚠ 关键: 山脚不做硬切 —— 山体不透明度自 fade 起连续降到 0, 上屏就"化进地形里"
       (这正是参考图的关键特征)。轮廓线同样**只勾到山腰以上**, 免得在已经化开的
       位置留一条硬边。 */
  function drawVeinPeak(ctx, cx, baseY, w, h, pal) {
    var g0 = veinPeakPts(cx, baseY, w, h);
    var pts = g0.pts, apex = g0.apex, ap = pts[apex], i;
    var F = VeinSkin.shape.fade == null ? 0.60 : VeinSkin.shape.fade;
    var ridgeFoot = [ap[0] + w * 0.11, baseY];
    /* ① 山体: 上实下虚 (fade 起连续衰减到 0) */
    ctx.beginPath(); tracePts(ctx, pts); ctx.closePath();
    var gb = ctx.createLinearGradient(0, ap[1], 0, baseY);
    gb.addColorStop(0, rgba(pal.mid, 0.96));
    gb.addColorStop(Math.max(0.02, F * 0.62), rgba(pal.mid, 0.90));
    gb.addColorStop(F, rgba(pal.mid, 0.58));
    gb.addColorStop(0.84, rgba(pal.mid, 0.15));
    gb.addColorStop(1, rgba(pal.mid, 0.0));
    ctx.fillStyle = gb; ctx.fill();
    /* ② 受光面 (左坡 → 山脊脚): 硬边亮面, 随山体一起收干净 */
    var litPoly = [ap];
    for (i = apex - 1; i >= 0; i--) litPoly.push(pts[i]);
    litPoly.push(ridgeFoot);
    ctx.beginPath(); tracePts(ctx, litPoly); ctx.closePath();
    var gl = ctx.createLinearGradient(0, ap[1], 0, baseY);
    gl.addColorStop(0, rgba(pal.lit, 0.24));
    gl.addColorStop(F, rgba(pal.lit, 0.10));
    gl.addColorStop(1, rgba(pal.lit, 0.0));
    ctx.fillStyle = gl; ctx.fill();
    /* ③ 背光面 (右坡 → 山脊脚): 暗面, 上浅下深后收干净 */
    var darkPoly = [ap];
    for (i = apex + 1; i < pts.length; i++) darkPoly.push(pts[i]);
    darkPoly.push(ridgeFoot);
    ctx.beginPath(); tracePts(ctx, darkPoly); ctx.closePath();
    var gd = ctx.createLinearGradient(0, ap[1], 0, baseY);
    gd.addColorStop(0, rgba(pal.back, 0.20));
    gd.addColorStop(F, rgba(pal.back, 0.40));
    gd.addColorStop(1, rgba(pal.back, 0.0));
    ctx.fillStyle = gd; ctx.fill();
    /* ④ 墨线轮廓 —— **只勾山腰以上** (开放路径): 山脚已化开, 在那儿勾线 =
       在雾里画一道硬边。 */
    var lim = baseY - h * (F + 0.02), iA = 0, iB = pts.length - 1;
    while (iA < pts.length && pts[iA][1] > lim) iA++;
    while (iB > 0 && pts[iB][1] > lim) iB--;
    if (iB > iA + 1) {
      strokeInk(ctx, pts.slice(iA, iB + 1),
        { width: 1.7, color: INK, alpha: 0.48, fly: false, layers: 2 });
    }
    /* 山脊线: 自峰顶沿背光侧下到中段 */
    strokeInk(ctx, [ap, [ap[0] + w * 0.20, baseY - h * 0.36]],
      { width: 1.1, color: INK, alpha: 0.20, fly: false, layers: 1 });
    /* ⑤ 石纹: 山体中上段短折线 (岩面分层), 低对比 */
    var nS = 2 + (trng() * 2 | 0);
    for (var s2 = 0; s2 < nS; s2++) {
      var ty = baseY - h * (F + 0.04 + trng() * 0.30);
      var tx = cx - w * 0.30 + trng() * w * 0.52;
      var tw = w * (0.10 + trng() * 0.14);
      strokeInk(ctx, [[tx - tw, ty], [tx, ty + h * 0.030], [tx + tw, ty - h * 0.010]],
        { width: 1.0, color: INK, alpha: 0.12 + trng() * 0.10, fly: false, layers: 1 });
    }
    /* ⑥ 米点皴 (米氏云山招牌) —— 落在渐隐线以上 */
    miDian(ctx, cx, baseY, w, h, ((VeinSkin.shape.miDian | 0) || 12) * (w / 60), pal.back);
    /* ⑦ (2026-09-14 移除) 原「山脚化雾」是往渐隐区**叠加** mist 色 (最高 0.50
       alpha) —— 它恰好把 ① 的渐隐重新糊实, 与「下半截半透明」互相抵消。
       实测: 带它时山脚逐行 alpha 只到最后 1 档才掉到 9 (几乎硬边)。
       现在渐隐由 ① 的 alpha 渐变独立负责, 云断交给外部 mistBand (已同降 alpha)。 */
  }

  function blendRGB(a, b, k) {
    return [0, 1, 2].map(function (i) { return Math.round(a[i] + (b[i] - a[i]) * k); });
  }

  /* 生成一个灵脉峰画师: pal = vein-skin 的一整套色, sigilFn = 该灵根符纹 */
  function veinPainter(pal, sigilFn) {
    /* 副峰压一档 (向背光色靠) → 前后拉开层次, 不然两座同色像贴纸 */
    var subPal = {
      back: pal.back,
      mid: blendRGB(pal.mid, pal.back, 0.34),
      lit: blendRGB(pal.lit, pal.back, 0.42),
      mist: pal.mist,
      glow: pal.glow,
      rune: pal.rune
    };
    return function (ctx) {
      var C = VeinSkin.shape.cell;
      var mist = pal.mist, glow = pal.glow;
      propShadow(ctx, (C.mainCx + C.subCx) * 0.5 + 12, C.mainBase + 3, 34, 8, 0.05);
      /* 山背雾光: 先垫一层淡霭 → 峰"浮"在气里 (被峰体压住, 只留边缘晕开) */
      wash(ctx, 58, 58, 50, mist, 0.18);
      /* 副峰 (左, 矮) 先画 → 被主峰压住, 出前后层次 */
      drawVeinPeak(ctx, C.subCx, C.subBase, C.subW, C.subH, subPal);
      drawVeinPeak(ctx, C.mainCx, C.mainBase, C.mainW, C.mainH, pal);
      /* 云断: 山脚一道横云埋掉山脚 → 山"浮"在云上 (岩峰是落地有影, 一眼可辨) */
      /* 云断: 只在下缘留一道**淡**霭 —— 0.70 会把山脚渐隐重新糊实 ⇒ 降档 */
      mistBand(ctx, 62, C.mainBase - 1, 60, 9, 0.46, mist);
      mistBand(ctx, 58, C.mainBase - 11, 40, 6, 0.18, mist);
      /* 山腰淡霭 (只压一层; 做成"带"会像玻璃反光) */
      mistBand(ctx, C.mainCx, 62, 30, 9, 0.18, mist);
      /* 灵气敷色: 只压山体中下段 (整座罩色会把山染成色块) */
      wash(ctx, 60, 86, 24, glow, 0.10);
      wash(ctx, 68, 54, 18, glow, 0.07);
      /* 灵根符纹: 缩到 0.46 并抬到**山腰以上** (原尺寸 y26~100 会盖满山体, 且落在
         底部已化开处会糊掉) */
      ctx.save();
      ctx.translate(64, 52); ctx.scale(0.46, 0.46); ctx.translate(-64, -52);
      sigilFn(ctx, pal.rune);
      ctx.restore();
      /* 灵气游丝: 只落山脚, 免得峰面变成"撒了糖霜" */
      for (var i = 0; i < 7; i++) {
        ctx.fillStyle = rgba(glow, 0.10 + trng() * 0.18);
        ctx.beginPath();
        ctx.arc(20 + trng() * 88, 44 + trng() * 44, 0.6 + trng() * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    };
  }

  /* 五行灵脉峰 (el: 0金 1木 2水 3火 4土 —— 与 vein-skin.elements 同序) */
  function propVein(el) {
    var i = (typeof el === 'number' && el >= 0 && el < 5) ? el : 0;
    return veinPainter(VeinSkin.elements[i], drawSigil[i] || drawSigil[0]);
  }
  /* 异灵根灵脉峰 (vi: 0雷 1风 2冰 3暗 —— 与 vein-skin.variants / mapgen VEIN_VARIANT_ORDER 同序) */
  function propVeinVariant(vi) {
    var V = VeinSkin.variants;
    var v = V[vi] || V[0];
    return veinPainter(v, drawSigilVariant[v.key] || drawSigilVariant['雷']);
  }

  /* ---- 第 7 行: 山 B 0/1 · 雪 B 2/3 (远山横岭构图, 打破壁纸感) ---- */
  function propMountainB(ctx) {
    /* (接地投影椭圆与碎石点已移除: 密排缩小时连成黑线穿帮) */
    /* 三峰横岭: 中高侧低, 走向相反 */
    drawPropPeak(ctx, 34, 106, 44, 52, [76, 70, 60], [146, 140, 124], {});
    drawPropPeak(ctx, 70, 105, 56, 84, [60, 54, 46], [130, 124, 108], {});
    drawPropPeak(ctx, 102, 106, 38, 42, [84, 78, 66], [152, 146, 130], {});
  }
  function propSnowB(ctx) {
    drawPropPeak(ctx, 38, 106, 42, 50, [104, 106, 110], [154, 156, 156], { snow: true });
    drawPropPeak(ctx, 74, 105, 54, 82, [90, 92, 96], [140, 142, 142], { snow: true });
    drawPropPeak(ctx, 104, 106, 34, 40, [116, 118, 120], [164, 166, 166], { snow: true });
  }

  /* ---- 草地精灵: 小山包 60/61 · 单棵孤树 62/63 (第 7 行 4..7 列) ---- */
  function propMound(v) {
    return function (ctx) {
      /* 低缓草丘: 亮草色渐变 + 淡墨脊线 (不闭合, 避免密排黑线穿帮) */
      propShadow(ctx, 64, 105, 42, 12, 0.13);
      var g = ctx.createLinearGradient(0, 58, 0, 106);
      g.addColorStop(0, 'rgba(206,217,174,0.98)');
      g.addColorStop(0.55, 'rgba(180,194,142,0.78)');
      g.addColorStop(1, 'rgba(158,174,122,0.18)');
      ctx.beginPath();
      if (v === 0) {                          // 单个缓坡圆丘
        ctx.moveTo(16, 106);
        ctx.quadraticCurveTo(42, 58, 80, 76);
        ctx.quadraticCurveTo(102, 88, 114, 106);
      } else {                                // 双丘错落
        ctx.moveTo(12, 106);
        ctx.quadraticCurveTo(34, 80, 56, 88);
        ctx.quadraticCurveTo(76, 58, 94, 84);
        ctx.quadraticCurveTo(108, 96, 118, 106);
      }
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      strokeInk(ctx, v === 0
        ? [[16, 106], [42, 60], [78, 77]]
        : [[12, 106], [35, 81], [56, 88], [76, 60], [93, 84]],
        { width: 1.3, color: [104, 120, 82], alpha: 0.52, fly: false, layers: 2 });
      /* 坡面零星小草笔 */
      for (var i = 0; i < 5; i++) {
        var gx = 34 + trng() * 60, gy = 80 + trng() * 22;
        strokeInk(ctx, [[gx, gy], [gx + (trng() - 0.5) * 3, gy - 4 - trng() * 4]],
          { width: 1.0, color: [104, 120, 82], alpha: 0.40, fly: false, layers: 1 });
      }
    };
  }
  function propSoloTree(v) {
    return function (ctx) {
      /* 单棵小树: 孤植, 复用 propTree (阔叶/松 两变体) */
      propShadow(ctx, 64, 107, 18, 6, 0.20);
      propTree(ctx, 64, 106, v === 0 ? 42 : 50, v === 0 ? 'leaf' : 'pine');
    };
  }

  /* ---------- 生成图集 ----------
   * 布局: 第 0~3 行 = 8 群系 × 4 变体 (列=群系, 行=变体)
   *       第 4 行   = 立体精灵: 0..3 异灵根灵脉峰 雷/风/冰/暗 (32..35, 4..7 留空)
   *       第 5 行   = 立体精灵: 0/1 山 2/3 雪 4..7 林
   *       第 6 行   = 立体精灵: 0 沙 1 草丛 2..6 五行灵脉峰 金木水火土 (50..54)
   *       第 7 行   = 立体精灵: 0/1 山B 2/3 雪B 4/5 草丘 6/7 孤树 (56..63) */
  var VEIN_ROW = 4;
  var ATLAS_ROWS = 8;
  /* R13: 各纹理构建函数在自身开头显式重置 trng 种子 —— 不再依赖 boot 的
     (atlas→paper→noise) 固定调用顺序; 中间插入任何消费 trng() 的代码不会
     再造成下游纹理外观漂移。种子为各自独立常量, 调用次序无关。 */
  var SEED_ATLAS = 20260906, SEED_PAPER = 20260906, SEED_NOISE = 20260906;
  function buildAtlas() {
    trng = NL.mulberry32(SEED_ATLAS);
    var cv = makeCanvas(PX * COLS, PX * ATLAS_ROWS);
    var ctx = cv.getContext('2d');
    for (var b = 0; b < 8; b++) {
      for (var v = 0; v < 4; v++) {
        ctx.save();
        ctx.translate(b * PX, v * PX);
        ctx.scale(PX / TILE, PX / TILE);  // 画师仍按 128 坐标系作画
        ctx.beginPath();
        ctx.rect(0, 0, TILE, TILE);
        ctx.clip();
        /* 每格独立小种子 → 稳定且多变体 */
        trng = NL.mulberry32(77777 + b * 131 + v * 31);
        painters[b](ctx, v);
        ctx.restore();
      }
    }
    /* 第 4 行: 异灵根灵脉峰 (雷风冰暗 → 32..35)。
       ⚠ 本行原为「灵脉格底」5 张 (金木水火土), 但格底 tile 索引自
         `tiles.push(f.biome*4 + f.variant)` 而来 (biome 恒 0..7 ⇒ ≤31),
         HEX_FS 的 `biome-8 → 第 4 行` 分支**不可达** ⇒ 那 5 张是死图。
         现整行改作异灵根峰; cols 4..7 (36..39) 留空, 供将来扩新灵气。
         ⚠ 索引 32..35 与「灵脉峰 50..54」同受 renderer.js PROP_VS 的
           灵脉分支管辖 (高度/宽度倍率见 vein-skin.shape)。 */
    for (var k = 0; k < VeinSkin.variants.length; k++) {
      ctx.save();
      ctx.translate(k * PX, VEIN_ROW * PX);
      ctx.scale(PX / TILE, PX / TILE);
      trng = NL.mulberry32(77777 + (k + 8) * 131);
      propVeinVariant(k)(ctx);
      ctx.restore();
    }
    /* 第 5 行: 山/雪/林 精灵 */
    var propRow = [propMountain, propMountain, propSnow, propSnow,
                   propForest(0), propForest(1), propForest(2), propForest(3)];
    for (var c5 = 0; c5 < 8; c5++) {
      ctx.save();
      ctx.translate(c5 * PX, 5 * PX);
      ctx.scale(PX / TILE, PX / TILE);
      trng = NL.mulberry32(88881 + c5 * 71);
      propRow[c5](ctx);
      ctx.restore();
    }
    /* 第 6 行: 沙/草丛/灵脉峰 精灵 */
    var propRow2 = [propDesert, propBush, propVein(0), propVein(1), propVein(2), propVein(3), propVein(4)];
    for (var c6 = 0; c6 < propRow2.length; c6++) {
      ctx.save();
      ctx.translate(c6 * PX, 6 * PX);
      ctx.scale(PX / TILE, PX / TILE);
      trng = NL.mulberry32(98891 + c6 * 97);
      propRow2[c6](ctx);
      ctx.restore();
    }
    /* 第 7 行: 山B/雪B 精灵 (56/57 山, 58/59 雪) + 草地精灵 (60/61 小山包, 62/63 孤树) */
    var propRow3 = [propMountainB, propMountainB, propSnowB, propSnowB,
                    propMound(0), propMound(1), propSoloTree(0), propSoloTree(1)];
    for (var c7 = 0; c7 < propRow3.length; c7++) {
      ctx.save();
      ctx.translate(c7 * PX, 7 * PX);
      ctx.scale(PX / TILE, PX / TILE);
      trng = NL.mulberry32(108881 + c7 * 83);
      propRow3[c7](ctx);
      ctx.restore();
    }
    return cv;
  }

  /* 各群系/灵脉格的平均色 (供着色器做格边晕染过渡) */
  function computeAvgColors(atlas) {
    var ctx = atlas.getContext('2d');
    var out = new Float32Array(13 * 3);
    for (var b = 0; b < 8; b++) {
      /* 群系: 4 变体格合并求均值 */
      var d = ctx.getImageData(b * PX, 0, PX, PX * 4).data;
      var r = 0, g = 0, bl = 0, n = 0;
      for (var i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++;
      }
      out[b * 3] = r / n / 255;
      out[b * 3 + 1] = g / n / 255;
      out[b * 3 + 2] = bl / n / 255;
    }
    for (var k = 0; k < 5; k++) {
      var d2 = ctx.getImageData(k * PX, VEIN_ROW * PX, PX, PX).data;
      var r2 = 0, g2 = 0, b2 = 0, n2 = 0;
      for (var j = 0; j < d2.length; j += 4) {
        r2 += d2[j]; g2 += d2[j + 1]; b2 += d2[j + 2]; n2++;
      }
      out[(k + 8) * 3] = r2 / n2 / 255;
      out[(k + 8) * 3 + 1] = g2 / n2 / 255;
      out[(k + 8) * 3 + 2] = b2 / n2 / 255;
    }
    return out;
  }

  /* ---------- 宣纸 ---------- */
  function buildPaper() {
    trng = NL.mulberry32(SEED_PAPER);      // R13: 显式重置, 不继承 atlas 残留流
    var S = 512;
    var cv = makeCanvas(S, S);
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#eee5d2';
    ctx.fillRect(0, 0, S, S);
    /* 大块斑驳 */
    for (var i = 0; i < 26; i++) {
      wash(ctx, trng() * S, trng() * S, 40 + trng() * 90,
        trng() > 0.5 ? [214, 199, 168] : [246, 240, 226], 0.06 + trng() * 0.05);
    }
    /* 纤维长丝 */
    for (i = 0; i < 130; i++) {
      var x0 = trng() * S, y0 = trng() * S;
      var len = 10 + trng() * 30, ang = trng() * Math.PI * 2;
      ctx.strokeStyle = rgba([178, 160, 128], 0.05 + trng() * 0.05);
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + Math.cos(ang) * len * 0.5 + (trng() - 0.5) * 6,
                           y0 + Math.sin(ang) * len * 0.5 + (trng() - 0.5) * 6,
                           x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
      ctx.stroke();
    }
    /* 细小深点 */
    for (i = 0; i < 240; i++) {
      ctx.fillStyle = rgba([150, 132, 100], 0.05 + trng() * 0.06);
      ctx.fillRect(trng() * S, trng() * S, 1, 1);
    }
    return cv;
  }

  /* ---------- 笔触噪声图 (R 枯笔 / G 纤维 / B 团渍) ---------- */
  function buildNoise() {
    trng = NL.mulberry32(SEED_NOISE);      // R13: 显式重置 (当前未消费 trng, 防御未来)
    var S = 256;
    var cv = makeCanvas(S, S);
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(S, S);
    var nA = new NL.SimplexNoise(NL.mulberry32(4321));
    var nB = new NL.SimplexNoise(NL.mulberry32(9876));
    var d = img.data;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = (y * S + x) * 4;
        var r = NL.fbm(nA, x * 0.03, y * 0.03, 4) * 0.5 + 0.5;
        var g = NL.fbm(nB, x * 0.11, y * 0.11, 3) * 0.5 + 0.5;
        var b = NL.fbm(nA, x * 0.012 + 40, y * 0.012 - 40, 3) * 0.5 + 0.5;
        d[i] = r * 255;
        d[i + 1] = g * 255;
        d[i + 2] = b * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  /* ============================================================
   * 云团 (云气层): 水墨祥云 (云头式)
   *   「云头」= 1 枚底座大瓣 + 沿**上缘**错落铺 3~5 枚小瓣 + 1 枚开放卷云钩;
   *   一条云 = 2~3 个云头横串 + 末端云尾长弧。瓣的下半压灰 = 上白下阴。
   *   ⚠ 两条踩过的坑 (别再回头):
   *     (1) 小瓣若**绕心一圈均匀铺** ⇒ 上屏读作花瓣/玫瑰 (已废);
   *     (2) 卷钩若**密绕 1.5 圈以上且居中** ⇒ 同样读作玫瑰花心 (已废);
   *     (3) 若全用同一尺寸的瓣平铺成链 ⇒ 读作"卵石链/毛毛虫" (已废)。
   *   · **6 个形态各异**的变体: 长云 / 团云 / 双团 / 高云 / 卷云带 / 小云 ——
   *     由 main.js 云毯按格号 hash 取用 ⇒ 天上是多种云, 不是同一朵复制粘贴。
   * 产出 6 张 128×84 逻辑像素 (2x 超采样) 位图, 仅 Canvas2D 云气层用, 不进 WebGL 图集。
   * ============================================================ */
  var CLOUD_PAL = {
    face: [252, 250, 245],   // 云体 (近白纸色)
    shade: [208, 211, 200],  // 云体阴面 (灰绿)
    ink: [52, 50, 46]        // 勾线墨 (浓, 参考图的线很实)
  };
  var CLOUD_W = 128, CLOUD_H = 84, CLOUD_N = 6;

  /* 一枚扁圆云瓣的**轮廓** (只建路径, 不填不描): 半径微抖 —— 死椭圆会读成气泡。
     ⚠ 云体与**云影**共用它 (见 buildCloudShadows) —— 两者必须同一轮廓, 否则影子对不上云。 */
  function puffPath(ctx, x, y, rx, ry, jit) {
    var n = 12, pts = [], i, a;
    for (i = 0; i < n; i++) {
      a = i / n * Math.PI * 2;
      var k = 1 + (trng() - 0.5) * jit;
      pts.push([x + Math.cos(a) * rx * k, y + Math.sin(a) * ry * k]);
    }
    ctx.beginPath();
    ctx.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
    for (i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
  }

  /* 一枚扁圆云瓣: 上述轮廓 + 上白下阴 + 浓墨勾边 */
  function cloudPuff(ctx, x, y, rx, ry, jit) {
    puffPath(ctx, x, y, rx, ry, jit);
    ctx.fillStyle = rgba(CLOUD_PAL.face, 0.98);
    ctx.fill();
    ctx.save();                        /* 阴面: 关在本瓣里, 免得糊到邻瓣上 */
    ctx.clip();
    var g = ctx.createLinearGradient(0, y - ry * 0.20, 0, y + ry * 1.05);
    g.addColorStop(0, rgba(CLOUD_PAL.shade, 0));
    g.addColorStop(1, rgba(CLOUD_PAL.shade, 0.52));
    ctx.fillStyle = g;
    ctx.fillRect(x - rx * 1.4, y - ry * 1.4, rx * 2.8, ry * 3.2);
    ctx.restore();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(CLOUD_PAL.ink, 0.62);
    ctx.stroke();
  }

  /* 开放卷云钩: 约 1 圈螺线, 外端自瓣边起、向内收 —— 别绕密 (会读成玫瑰心) */
  function cloudCurl(ctx, x, y, r, dir, alpha) {
    ctx.beginPath();
    var steps = 22, i;
    for (i = 0; i <= steps; i++) {
      var t = i / steps;
      var ang = t * 1.05 * Math.PI * 2 * dir + (dir > 0 ? 0.55 : -0.55);
      var rr = r * (1 - t * 0.78);
      var px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr * 0.94;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = rgba(CLOUD_PAL.ink, alpha == null ? 0.60 : alpha);
    ctx.stroke();
  }

  /* 云尾: 自云头末端甩出的几道长弧 (行云走势) */
  function cloudTail(ctx, x, y, len, dir) {
    for (var k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.moveTo(x, y + k * 2.0);
      ctx.quadraticCurveTo(x + dir * len * 0.55, y - 3.6 + k * 2.2, x + dir * len, y + 1.2 + k * 2.8);
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.5 - k * 0.24;
      ctx.strokeStyle = rgba(CLOUD_PAL.ink, 0.32 - k * 0.055);
      ctx.stroke();
    }
  }

  /* 一个「云头」: 底座大瓣 + 上缘错落小瓣 + 1 枚卷钩。返回卷钩参数, 由调用方统一后画。 */
  function cloudHead(x, y, r, dir, out) {
    var n = 3 + (trng() * 3 | 0), i, a;
    for (i = 0; i < n; i++) {                        /* 小瓣只铺**上缘** (π..2π 是上半) */
      a = Math.PI * (1.02 + 0.96 * (i + 0.5) / n);
      out.push({ x: x + Math.cos(a) * r * 0.68, y: y + Math.sin(a) * r * 0.54,
                 rx: r * (0.28 + trng() * 0.20), ry: r * (0.26 + trng() * 0.18) });
    }
    out.push({ x: x - dir * r * 0.74, y: y + r * 0.22, rx: r * 0.46, ry: r * 0.38 });  /* 侧后一瓣 */
    out.push({ x: x - dir * r * 0.30, y: y + r * 0.34, rx: r * 0.58, ry: r * 0.40 });  /* 下缘一瓣 */
    out.push({ x: x, y: y, rx: r, ry: r * 0.80 });                                     /* 底座大瓣 */
    return [x - dir * r * 0.10, y + r * 0.02, r * 0.44, dir];
  }

  /* 六种云型: 各异的云头串法 + 云尾 —— 保证上屏一眼可辨 */
  function cloudRecipe(v) {
    var W = CLOUD_W, H = CLOUD_H, cy = H * 0.50;
    var puff = [], curls = [], tails = [], i, a;
    if (v === 0) {                                   /* 长云: 三个云头横串 + 右长尾 */
      curls.push(cloudHead(W * 0.25, cy + 3, H * 0.20, 1, puff));
      curls.push(cloudHead(W * 0.47, cy - 3, H * 0.26, -1, puff));
      curls.push(cloudHead(W * 0.67, cy + 2, H * 0.21, 1, puff));
      tails.push([W * 0.80, cy + 6, W * 0.16, 1]);
    } else if (v === 1) {                            /* 团云: 三个云头抱团 */
      curls.push(cloudHead(W * 0.44, cy + 5, H * 0.26, 1, puff));
      curls.push(cloudHead(W * 0.32, cy - 4, H * 0.21, -1, puff));
      curls.push(cloudHead(W * 0.61, cy - 2, H * 0.21, 1, puff));
    } else if (v === 2) {                            /* 双团: 一大一小云头 + 中间细云 */
      curls.push(cloudHead(W * 0.65, cy + 1, H * 0.27, -1, puff));
      curls.push(cloudHead(W * 0.25, cy + 6, H * 0.18, 1, puff));
      for (i = 0; i < 4; i++) {
        a = i / 4 * Math.PI * 2 + 1.1;
        puff.push({ x: W * 0.44 + Math.cos(a) * W * 0.045, y: cy + 4 + Math.sin(a) * H * 0.075,
                    rx: H * 0.062, ry: H * 0.052 });
      }
      tails.push([W * 0.34, cy + 12, W * 0.13, -1]);
    } else if (v === 3) {                            /* 高云: 云头竖向叠 (拔起) */
      curls.push(cloudHead(W * 0.44, H * 0.62, H * 0.23, 1, puff));
      curls.push(cloudHead(W * 0.49, H * 0.34, H * 0.19, -1, puff));
      curls.push(cloudHead(W * 0.38, H * 0.15, H * 0.12, 1, puff));
      tails.push([W * 0.56, H * 0.72, W * 0.14, 1]);
    } else if (v === 4) {                            /* 卷云带: 两个云头 + 两端长尾 (最古典) */
      curls.push(cloudHead(W * 0.36, cy + 3, H * 0.23, 1, puff));
      curls.push(cloudHead(W * 0.63, cy - 2, H * 0.22, -1, puff));
      tails.push([W * 0.80, cy + 3, W * 0.15, 1], [W * 0.20, cy + 10, W * 0.13, -1]);
    } else {                                         /* 小云: 一个云头 + 一枚伴瓣 */
      curls.push(cloudHead(W * 0.46, cy + 1, H * 0.19, 1, puff));
      puff.push({ x: W * 0.70, y: cy + 5, rx: H * 0.075, ry: H * 0.062 });
      tails.push([W * 0.64, cy + 7, W * 0.12, 1]);
    }
    return { puff: puff, curls: curls, tails: tails };
  }

  function buildClouds() {
    var out = [];
    for (var v = 0; v < CLOUD_N; v++) {
      trng = NL.mulberry32(31337 + v * 977);        /* 每变体独立种子 (与纸/噪声同规矩) */
      var cv = makeCanvas(CLOUD_W * 2, CLOUD_H * 2);
      var ctx = cv.getContext('2d');
      ctx.scale(2, 2);
      var rec = cloudRecipe(v), k, f;
      for (k = 0; k < rec.tails.length; k++) {      /* 云尾在云头之下 (自头后甩出) */
        f = rec.tails[k];
        cloudTail(ctx, f[0], f[1], f[2], f[3]);
      }
      rec.puff.sort(function (p, q) { return p.ry - q.ry; });   /* 小瓣先画 ⇒ 大瓣压上层 */
      for (k = 0; k < rec.puff.length; k++) {
        f = rec.puff[k];
        cloudPuff(ctx, f.x, f.y, f.rx, f.ry, 0.24);
      }
      for (k = 0; k < rec.curls.length; k++) {
        f = rec.curls[k];
        cloudCurl(ctx, f[0], f[1], f[2], f[3], 0.60);
      }
      out.push(cv);
    }
    return out;
  }

  /* ---------- 云影 (云投在土地上的阴影) ----------
   * 「云在天上飘, 地上却没影子」会让云像贴纸浮在画面上。这里给每个云团再产一张
   * **纯墨色 + 高斯模糊**的软影:
   *   · 轮廓与云体**完全同源** (同种子同云型 ⇒ 逐瓣 puffPath 复用), 所以影随云形;
   *   · 只模糊**轮廓填充**, 不带勾线/阴面 ⇒ 不会出现"第二个云"的错读;
   *   · 与 buildClouds 等长, 索引即变体号, 由 main.js 云气层在云体**之前**偏移绘制。
   * 2026-09-14 七版新增 (用户: "土地上面也没有阴影, 这个要有")。 */
  var CLOUD_SHADOW = { col: [58, 56, 50], a: 0.40, blur: 7 };
  function buildCloudShadows() {
    var out = [];
    for (var v = 0; v < CLOUD_N; v++) {
      trng = NL.mulberry32(31337 + v * 977);   /* ⚠ 与 buildClouds 同种子 ⇒ 影子必与云体对齐 */
      var cv = makeCanvas(CLOUD_W * 2, CLOUD_H * 2);
      var ctx = cv.getContext('2d');
      ctx.scale(2, 2);
      var rec = cloudRecipe(v), k, f;
      rec.puff.sort(function (p, q) { return p.ry - q.ry; });
      ctx.save();
      try { ctx.filter = 'blur(' + CLOUD_SHADOW.blur + 'px)'; } catch (e) { /* 不支持则退化为硬边软影 */ }
      ctx.fillStyle = rgba(CLOUD_SHADOW.col, CLOUD_SHADOW.a);
      for (k = 0; k < rec.puff.length; k++) {
        f = rec.puff[k];
        puffPath(ctx, f.x, f.y, f.rx, f.ry, 0.24);
        ctx.fill();
      }
      ctx.restore();
      out.push(cv);
    }
    return out;
  }

  /* ---------- 灵脉灵气晕圈 (Canvas2D overlay 绘制) ----------
   * cx,cy: 中心格世界坐标; rgb: 灵根色; opts.level: 0大 1中 2小
   * (七星花连线/圆点/格底均已移除, 仅留淡晕圈) */
  function drawVeinFlower(ctx, cx, cy, armXY, rgb, opts) {
    opts = opts || {};
    var level = opts.level == null ? 2 : opts.level;
    var aCore = level === 0 ? 0.95 : level === 1 ? 0.8 : 0.62;
    var rgbS = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    var hr = level === 0 ? 48 : level === 1 ? 36 : 22;
    var g = ctx.createRadialGradient(cx, cy, hr * 0.1, cx, cy, hr);
    g.addColorStop(0, 'rgba(' + rgbS + ',' + (0.17 * aCore).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + rgbS + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fill();
  }

  global.InkTextures = {
    TILE: TILE,
    PX: PX,
    COLS: COLS,
    ROWS: ROWS,
    VEIN_ROW: VEIN_ROW,
    buildAtlas: buildAtlas,
    computeAvgColors: computeAvgColors,
    buildPaper: buildPaper,
    buildNoise: buildNoise,
    buildClouds: buildClouds,
    buildCloudShadows: buildCloudShadows,
    drawVeinFlower: drawVeinFlower
  };
})(window);
