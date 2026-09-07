/* ============================================================
 * textures.js — 程序化水墨贴图工厂
 * 产出三张贴图供 WebGL 使用:
 *   atlas  2048×1792  共 7 行:
 *     第 0~3 行  8 群系 × 4 变体 (群系底纹)
 *     第 4 行    5 灵脉格底
 *     第 5/6 行  立体精灵 (透明底: 山/雪/林/沙/草丛/灵脉峰)
 *   paper   512×512 无缝宣纸(纤维/斑驳)
 *   noise   256×256 R:枯笔噪声 G:细纤维 B:团渍
 * 笔触引擎模拟: 叠层枯笔(飞白)、晕染水渍、皴笔、椿点。
 * ============================================================ */
(function (global) {
  'use strict';
  var NL = global.NoiseLib;

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

  /* 0 深海: 灰青底 + 隐约长波 */
  painters[0] = function (ctx, v) {
    ctx.fillStyle = '#95a5ad';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, 30 + trng() * 60, 30 + trng() * 60, 60, [76, 92, 100], 0.07);
    wash(ctx, trng() * 128, trng() * 128, 46, [152, 168, 172], 0.09);
    for (var i = 0; i < 2; i++) {
      var yy = 15 + trng() * 100, xx = trng() * 60;
      strokeInk(ctx, [[xx, yy], [xx + 22 + trng() * 20, yy + (trng() - 0.5) * 5]],
        { width: 1.2, color: [70, 88, 96], alpha: 0.13, fly: false, layers: 1 });
    }
  };

  /* 1 浅海: 淡青底 + 水纹弧线 */
  painters[1] = function (ctx, v) {
    ctx.fillStyle = '#b4c2c4';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [176, 195, 192], 0.25);
    var n = 5 + (trng() * 3 | 0);
    for (var i = 0; i < n; i++) {
      var xx = 8 + trng() * 90, yy = 10 + trng() * 108;
      var ww = 12 + trng() * 16;
      strokeInk(ctx, [
        [xx, yy], [xx + ww * 0.5, yy - 2.5 - trng() * 1.5], [xx + ww, yy]
      ], { width: 1.2, color: [92, 110, 114], alpha: 0.30, fly: false, layers: 1 });
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

  /* 3 草地: 淡青绿 + 草笔 */
  painters[3] = function (ctx, v) {
    ctx.fillStyle = '#b4c3a0';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, 20 + trng() * 88, 20 + trng() * 88, 52, [168, 185, 142], 0.22);
    wash(ctx, trng() * 128, trng() * 128, 40, [196, 205, 172], 0.25);
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

  /* 4 林地: 草底 + 椿点树冠 */
  painters[4] = function (ctx, v) {
    painters[3](ctx, v);
    var n = 5 + (trng() * 3 | 0);
    for (var i = 0; i < n; i++) {
      var xx = 14 + trng() * 100, yy = 16 + trng() * 100;
      dotCluster(ctx, xx, yy, 6 + (trng() * 4 | 0), [74, 94, 66], 2.6);
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

  /* ---------- 灵脉格 (8金 9木 10水 11火 12土): 暗岩底 + 灵根色晕 + 符纹 ---------- */
  var VEIN_BASE = ['#6e685c', '#5c6650', '#54626b', '#6b5248', '#6e6353'];
  var VEIN_TINT = [
    [206, 186, 128], [116, 152, 92], [96, 128, 152], [190, 82, 56], [162, 130, 88]
  ];

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

  for (var vb = 0; vb < 5; vb++) {
    (function (b) {
      painters[b] = function (ctx) {
        ctx.fillStyle = VEIN_BASE[b - 8];
        ctx.fillRect(0, 0, TILE, TILE);
        var tint = VEIN_TINT[b - 8];
        wash(ctx, 64, 64, 80, tint, 0.10);
        wash(ctx, 20 + trng() * 88, 20 + trng() * 88, 46, tint, 0.14);
        wash(ctx, trng() * 128, trng() * 128, 36, [250, 244, 226], 0.08);
        /* 灵光星点 (灵峰本体由立体精灵承担) */
        for (var i = 0; i < 12; i++) {
          ctx.fillStyle = rgba(tint, 0.22 + trng() * 0.32);
          ctx.beginPath();
          ctx.arc(trng() * 128, trng() * 128, 0.7 + trng() * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      };
    })(vb + 8);
  }

  /* ============================================================
   * 立体精灵 (第 5/6 行): 透明底绘制, 超出格子压到邻格上
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

  /* 透明底山峰: 渐变山体 + 脊线 + 披麻皴 + 可选雪帽 */
  function drawPropPeak(ctx, cx, baseY, w, h, dark, mid, opt) {
    opt = opt || {};
    var apexY = baseY - h;
    var g = ctx.createLinearGradient(0, apexY, 0, baseY);
    g.addColorStop(0, rgba(dark, 0.92));
    g.addColorStop(0.5, rgba(mid, 0.50));
    g.addColorStop(1, rgba(mid, 0.0));
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5, baseY);
    ctx.quadraticCurveTo(cx - w * 0.28, baseY - h * 0.5, cx - w * 0.04, apexY + h * 0.05);
    ctx.quadraticCurveTo(cx + w * 0.10, apexY, cx + w * 0.17, apexY + h * 0.11);
    ctx.quadraticCurveTo(cx + w * 0.30, baseY - h * 0.45, cx + w * 0.5, baseY);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    if (opt.snow) {
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.03, apexY + h * 0.03);
      ctx.quadraticCurveTo(cx + w * 0.22, baseY - h * 0.70, cx + w * 0.28, baseY - h * 0.58);
      ctx.quadraticCurveTo(cx + w * 0.13, baseY - h * 0.68, cx + w * 0.01, baseY - h * 0.56);
      ctx.quadraticCurveTo(cx - w * 0.13, baseY - h * 0.68, cx - w * 0.22, baseY - h * 0.58);
      ctx.quadraticCurveTo(cx - w * 0.13, baseY - h * 0.72, cx + w * 0.03, apexY + h * 0.03);
      ctx.closePath();
      ctx.fillStyle = 'rgba(249,247,241,0.95)';
      ctx.fill();
    }
    strokeInk(ctx, [
      [cx - w * 0.5, baseY],
      [cx - w * 0.27, baseY - h * 0.52],
      [cx - w * 0.02, apexY + h * 0.07]
    ], { width: 1.5, color: INK, alpha: 0.5, fly: false, layers: 2 });
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

  /* 透明底树: 枯笔干 + 椿点冠 */
  function propTree(ctx, x, baseY, h) {
    strokeInk(ctx, [
      [x, baseY],
      [x + (trng() - 0.5) * 3, baseY - h * 0.45],
      [x + (trng() - 0.5) * 4, baseY - h]
    ], { width: 1.7, color: [72, 60, 44], alpha: 0.6, fly: false, layers: 2 });
    var cy = baseY - h * 0.74, cr = h * 0.40;
    dotCluster(ctx, x - cr * 0.32, cy - cr * 0.15, 11, [56, 76, 50], cr * 0.42);
    dotCluster(ctx, x + cr * 0.36, cy + cr * 0.05, 9, [66, 90, 58], cr * 0.38);
    dotCluster(ctx, x - cr * 0.02, cy - cr * 0.45, 9, [88, 112, 70], cr * 0.34);
  }

  /* ---- 第 5 行: 山 0/1 · 雪 2/3 · 林 4..7 ---- */
  function propMountain(ctx) {
    propShadow(ctx, 64, 108, 38, 13);
    drawPropPeak(ctx, 84, 104, 48, 56, [92, 86, 74], [152, 144, 128], {});
    drawPropPeak(ctx, 48, 106, 66, 94, [58, 52, 44], [128, 120, 104], {});
    wash(ctx, 60, 102, 26, [130, 122, 104], 0.15);
  }
  function propSnow(ctx) {
    propShadow(ctx, 64, 108, 36, 12);
    drawPropPeak(ctx, 86, 104, 44, 50, [118, 120, 122], [166, 168, 166], { snow: true });
    drawPropPeak(ctx, 50, 106, 62, 92, [102, 104, 106], [148, 150, 148], { snow: true });
  }
  function propForest(v) {
    return function (ctx) {
      propShadow(ctx, 64, 108, 34, 11, 0.26);
      if (v === 0) { propTree(ctx, 48, 104, 76); propTree(ctx, 78, 100, 56); }
      else if (v === 1) { propTree(ctx, 40, 102, 58); propTree(ctx, 66, 106, 86); propTree(ctx, 88, 100, 44); }
      else if (v === 2) { propTree(ctx, 64, 104, 84); propTree(ctx, 90, 100, 52); }
      else { propTree(ctx, 34, 102, 50); propTree(ctx, 58, 106, 76); propTree(ctx, 84, 102, 62); }
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
    dotCluster(ctx, 60, 96, 12, [74, 94, 66], 4.5);
    dotCluster(ctx, 74, 100, 9, [92, 112, 76], 3.6);
    for (var i = 0; i < 5; i++) {
      var xx = 50 + trng() * 28;
      strokeInk(ctx, [[xx, 106], [xx + (trng() - 0.5) * 3, 96 - trng() * 6]],
        { width: 1.1, color: [96, 112, 76], alpha: 0.5, fly: false, layers: 1 });
    }
  }
  function propVein(el) {
    return function (ctx) {
      var tint = VEIN_TINT[el];
      var hi = [Math.min(255, tint[0] + 36), Math.min(255, tint[1] + 36), Math.min(255, tint[2] + 36)];
      propShadow(ctx, 64, 108, 38, 13, 0.32);
      drawPropPeak(ctx, 64, 106, 70, 88, [46, 42, 36], [104, 100, 90], {});
      wash(ctx, 64, 66, 42, tint, 0.30);
      wash(ctx, 64, 96, 30, tint, 0.20);
      drawSigil[el](ctx, hi);
      for (var i = 0; i < 14; i++) {
        ctx.fillStyle = rgba(tint, 0.28 + trng() * 0.4);
        ctx.beginPath();
        ctx.arc(18 + trng() * 92, 18 + trng() * 90, 0.7 + trng() * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    };
  }

  /* ---------- 生成图集 ----------
   * 布局: 第 0~3 行 = 8 群系 × 4 变体 (列=群系, 行=变体)
   *       第 4 行   = 5 灵脉格底 (8金 9木 10水 11火 12土)
   *       第 5 行   = 立体精灵: 0/1 山 2/3 雪 4..7 林
   *       第 6 行   = 立体精灵: 0 沙 1 草丛 2..6 灵脉峰 */
  var VEIN_ROW = 4;
  var ATLAS_ROWS = 7;
  function buildAtlas() {
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
    for (var k = 0; k < 5; k++) {
      ctx.save();
      ctx.translate(k * PX, VEIN_ROW * PX);
      ctx.scale(PX / TILE, PX / TILE);
      ctx.beginPath();
      ctx.rect(0, 0, TILE, TILE);
      ctx.clip();
      trng = NL.mulberry32(77777 + (k + 8) * 131);
      painters[k + 8](ctx, 0);
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

  /* ---------- 七星灵脉花 (Canvas2D overlay 绘制, 设定 §七) ----------
   * cx,cy: 中心格世界坐标; armXY: 6 从属格世界坐标 (小灵脉传 null);
   * rgb: 灵根色; opts.level: 0大 1中 2小 */
  function drawVeinFlower(ctx, cx, cy, armXY, rgb, opts) {
    opts = opts || {};
    var level = opts.level == null ? 2 : opts.level;
    var aCore = level === 0 ? 0.95 : level === 1 ? 0.8 : 0.62;
    var rgbS = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    /* 灵气晕圈 */
    var hr = level === 0 ? 48 : level === 1 ? 36 : 22;
    var g = ctx.createRadialGradient(cx, cy, hr * 0.1, cx, cy, hr);
    g.addColorStop(0, 'rgba(' + rgbS + ',' + (0.17 * aCore).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + rgbS + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, hr, 0, Math.PI * 2); ctx.fill();
    /* 六触手 → 从属格 */
    if (armXY) {
      ctx.strokeStyle = 'rgba(' + rgbS + ',' + (0.5 * aCore).toFixed(3) + ')';
      ctx.lineWidth = level === 0 ? 2.2 : 1.8;
      ctx.lineCap = 'round';
      for (var k = 0; k < armXY.length; k++) {
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(armXY[k].x, armXY[k].y); ctx.stroke();
        ctx.beginPath(); ctx.arc(armXY[k].x, armXY[k].y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + rgbS + ',' + (0.42 * aCore).toFixed(3) + ')'; ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(58,48,38,0.45)'; ctx.stroke();
        ctx.strokeStyle = 'rgba(' + rgbS + ',' + (0.5 * aCore).toFixed(3) + ')';
        ctx.lineWidth = level === 0 ? 2.2 : 1.8;
      }
    }
    /* 中心花蕊 */
    var cr = level === 0 ? 7 : level === 1 ? 5.5 : 4;
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(244,238,222,0.92)'; ctx.fill();
    ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(' + rgbS + ',' + aCore.toFixed(3) + ')'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, level === 0 ? 2.8 : 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + rgbS + ',' + aCore.toFixed(3) + ')'; ctx.fill();
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
    drawVeinFlower: drawVeinFlower
  };
})(window);
