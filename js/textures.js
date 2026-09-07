/* ============================================================
 * textures.js — 程序化水墨贴图工厂
 * 产出三张贴图供 WebGL 使用:
 *   atlas  1024×512  8 群系 × 4 变体, 每格 128px 的水墨底纹
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

  /* 6 山地: 岩灰底 + 主峰皴 */
  painters[6] = function (ctx, v) {
    ctx.fillStyle = '#b1aa9c';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [156, 148, 132], 0.25);
    var baseY = 96 + (trng() - 0.5) * 12;
    if (v % 2 === 0) {
      drawPeak(ctx, 46 + trng() * 10, baseY, 58 + trng() * 10, 62 + trng() * 12, [64, 58, 48], [128, 120, 104], 0.8);
      drawPeak(ctx, 92 + trng() * 8, baseY + 6, 40 + trng() * 8, 40 + trng() * 8, [84, 78, 66], [140, 132, 116], 0.55);
    } else {
      drawPeak(ctx, 84 + trng() * 10, baseY, 60 + trng() * 10, 66 + trng() * 10, [64, 58, 48], [128, 120, 104], 0.8);
      drawPeak(ctx, 34 + trng() * 8, baseY + 8, 38 + trng() * 8, 38 + trng() * 8, [84, 78, 66], [140, 132, 116], 0.5);
    }
  };

  /* 7 雪峰: 淡灰底 + 白头山 */
  painters[7] = function (ctx, v) {
    ctx.fillStyle = '#e2e0d6';
    ctx.fillRect(0, 0, TILE, TILE);
    wash(ctx, trng() * 128, trng() * 128, 55, [200, 200, 192], 0.3);
    var baseY = 98 + (trng() - 0.5) * 10;
    var cx = 64 + (trng() - 0.5) * 16;
    var apexY = baseY - (72 + trng() * 10);
    /* 山体淡墨 */
    var g = ctx.createLinearGradient(0, apexY, 0, baseY);
    g.addColorStop(0, 'rgba(120,122,124,0.85)');
    g.addColorStop(0.4, 'rgba(150,152,150,0.5)');
    g.addColorStop(1, 'rgba(170,170,164,0.05)');
    ctx.beginPath();
    ctx.moveTo(cx - 40, baseY);
    ctx.quadraticCurveTo(cx - 22, baseY - 40, cx, apexY);
    ctx.quadraticCurveTo(cx + 20, baseY - 42, cx + 40, baseY);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    /* 积雪: 上端留白 */
    ctx.beginPath();
    ctx.moveTo(cx, apexY);
    ctx.quadraticCurveTo(cx + 18, baseY - 46, cx + 26, baseY - 34);
    ctx.quadraticCurveTo(cx + 12, baseY - 40, cx + 2, baseY - 30);
    ctx.quadraticCurveTo(cx - 12, baseY - 42, cx - 24, baseY - 32);
    ctx.quadraticCurveTo(cx - 16, baseY - 44, cx, apexY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(246,244,238,0.92)';
    ctx.fill();
    strokeInk(ctx, [[cx - 24, baseY], [cx - 12, baseY - 44], [cx, apexY]],
      { width: 1.4, color: INK, alpha: 0.5, fly: false, layers: 2 });
    strokeInk(ctx, [[cx, apexY], [cx + 14, baseY - 42], [cx + 30, baseY]],
      { width: 1.3, color: INK, alpha: 0.38, fly: false, layers: 2 });
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
        wash(ctx, 64, 64, 80, tint, 0.14);
        wash(ctx, 20 + trng() * 88, 20 + trng() * 88, 46, tint, 0.20);
        wash(ctx, trng() * 128, trng() * 128, 36, [250, 244, 226], 0.10);
        /* 灵光星点 */
        for (var i = 0; i < 12; i++) {
          ctx.fillStyle = rgba(tint, 0.25 + trng() * 0.35);
          ctx.beginPath();
          ctx.arc(trng() * 128, trng() * 128, 0.7 + trng() * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        /* 山峰皴 (灵脉必是山) */
        drawPeak(ctx, 64 + (trng() - 0.5) * 10, 102 + (trng() - 0.5) * 6, 68, 56,
          [50, 46, 38], [108, 102, 90], 0.55);
        /* 灵根符纹 */
        drawSigil[b - 8](ctx, tint);
      };
    })(vb + 8);
  }

  /* ---------- 生成图集 ----------
   * 布局: 第 0~3 行 = 8 群系 × 4 变体 (列=群系, 行=变体)
   *       第 4 行   = 5 灵脉格 (8金 9木 10水 11火 12土) */
  var VEIN_ROW = 4;
  function buildAtlas() {
    var cv = makeCanvas(PX * COLS, PX * (ROWS + 1));
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
