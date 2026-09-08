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
    /* 受光面 (左坡): 淡亮 wash, 参考图日光自左上来 */
    var gl2 = ctx.createLinearGradient(cx - w * 0.5, baseY, cx, apexY);
    gl2.addColorStop(0, 'rgba(214,210,196,0)');
    gl2.addColorStop(0.55, 'rgba(214,210,196,0.16)');
    gl2.addColorStop(1, 'rgba(226,222,208,0.30)');
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
    /* 岩层横裂: 右坡短促横向皴断 (参考图岩壁层理) */
    var nCrag = 2 + (trng() * 2 | 0);
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
   *       第 4 行   = 5 灵脉格底 (8金 9木 10水 11火 12土)
   *       第 5 行   = 立体精灵: 0/1 山 2/3 雪 4..7 林
   *       第 6 行   = 立体精灵: 0 沙 1 草丛 2..6 灵脉峰
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
    drawVeinFlower: drawVeinFlower
  };
})(window);
