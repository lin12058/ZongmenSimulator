/* ============================================================
 * bldg_ink.js — 建筑「实时水墨」绘制核心 (平台无关, 无 DOM 依赖)
 * ------------------------------------------------------------
 * 与旧版「一张静态贴图」的根本区别:
 *   1) 朝向驱动  —— 建筑按所在格的地缘朝向站立 (码头朝水/民房朝中枢/
 *                   殿宇坐北朝南/炉窑朝山), 朝向由 paint() 的 face 参数给定;
 *   2) 贴格而立  —— 每座建筑先落「六边格基座」(点顶六边形, 与地图网格同朝向),
 *                   再在格内起立体块: 墙体按视深排序遮挡, 屋面为真实投影坡面;
 *   3) 无背景    —— 透明底, 不画宣纸纹/印章, 只留建筑与极淡的接地阴影;
 *   4) 每格不同  —— 全部随机量取自 seed(q,r,kind,variant), 同种建筑千姿百态;
 *   5) 一处真源  —— 同一份绘制代码跑三种后端:
 *                    · 浏览器 Canvas2D  (预览页 / 游戏前端 实时绘制)
 *                    · Node SVG 字符串  (文档静态图 / 矢量存档)
 * 用法:
 *   var B = BldgInk.canvasBackend(ctx);
 *   BldgInk.paint(B, { kind:'码头', cx:100, cy:80, R:22, face:{x:1,y:0}, q:3, r:5, variant:2 });
 * ============================================================ */
(function (global) {
  'use strict';

  /* ============================================================
   * 0. 墨色 (墨分五色) 与几何常量
   * ============================================================ */
  var INK = '#2b2621';      // 焦墨
  var INK2 = '#3f382e';     // 浓墨
  var INK3 = '#5b5343';     // 重墨
  var INK4 = '#837a68';     // 淡墨
  var INK5 = '#aca393';     // 清墨
  var EARTH = '#b08a5e';    // 赭石
  var CINNABAR = '#b2452f'; // 朱砂
  var AZURE = '#5d8496';    // 石青
  var JADE = '#6f8f57';     // 草木
  var GAMBOGE = '#c2a03c';  // 藤黄
  var SPIRIT = '#8f7fc4';   // 灵气
  var STONE = '#bdb29a';    // 石材
  var WALL = '#c3b697';     // 土墙
  var TILE = '#b3a88f';     // 瓦顶
  var THATCH = '#cdc4ae';   // 茅草
  var WOOD = '#a89066';     // 木材

  var KY = 0.62;            // 地面纵深压扁系数 (俯角投影): 越大越"俯视"
  var SQ3 = 1.7320508;

  /* 地皮 → 基座底色 (极淡, 只为让"格子"可读, 不是背景图案) */
  var LANDUSE_TINT = {
    core: '#d8c79a', '灵枢': '#c9b6e6', '高阶灵地': '#c3b0d8', '水岸': '#bcd9e4',
    '良田': '#d3dda8', '矿脉': '#ccc3b0', '林地': '#c2d3b4', '灼壤': '#dcc4a4',
    '村落': '#d8d2c4'
  };

  /* ============================================================
   * 1. 确定性随机 (同一格永远画出同一座建筑 → 不闪不跳)
   * ============================================================ */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  /* 三维整数哈希 → 32 位 (用于 seed 派生的变体选择) */
  function hash3(a, b, c) {
    var h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 1442695041;
    h = (h ^ (h >>> 13)) * 1274126177;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* ============================================================
   * 2. 后端: 把「路径 / 面 / 晕染」落到具体载体
   *    两套后端接口完全一致, 绘制代码只认接口 → 一份代码两处跑
   * ============================================================ */
  function CanvasBk(ctx) {
    this.ctx = ctx;
  }
  CanvasBk.prototype.poly = function (pts, fill, a) {
    if (!pts.length) return;
    var c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.globalAlpha = a == null ? 1 : a;
    c.fillStyle = fill;
    c.fill();
    c.globalAlpha = 1;
  };
  CanvasBk.prototype.line = function (pts, o) {
    if (pts.length < 2) return;
    var c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.globalAlpha = o.a == null ? 1 : o.a;
    c.strokeStyle = o.c || INK;
    c.lineWidth = o.w == null ? 1 : o.w;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (o.dash) c.setLineDash(o.dash);
    c.stroke();
    if (o.dash) c.setLineDash([]);
    c.globalAlpha = 1;
  };
  CanvasBk.prototype.circle = function (x, y, r, fill, a) {
    if (r <= 0) return;
    var c = this.ctx;
    c.globalAlpha = a == null ? 1 : a;
    c.fillStyle = fill;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 1;
  };
  CanvasBk.prototype.ellipse = function (x, y, rx, ry, fill, a) {
    if (rx <= 0 || ry <= 0) return;
    var c = this.ctx;
    c.globalAlpha = a == null ? 1 : a;
    c.fillStyle = fill;
    c.beginPath();
    if (c.ellipse) c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    else { c.save(); c.translate(x, y); c.scale(1, ry / rx); c.arc(0, 0, rx, 0, Math.PI * 2); c.restore(); }
    c.fill();
    c.globalAlpha = 1;
  };
  /* 径向晕染 (水渍/灵光/落影) */
  CanvasBk.prototype.radial = function (x, y, r, col, a, rx, ry) {
    if (r <= 0 || a <= 0) return;
    var c = this.ctx;
    var g = c.createRadialGradient(x, y, r * 0.06, x, y, r);
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(0.55, rgba(col, a * 0.42));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    if (c.ellipse && rx != null) c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    else c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  };
  CanvasBk.prototype.dpath = function (d, fill, a) {
    var c = this.ctx;
    c.globalAlpha = a == null ? 1 : a;
    c.fillStyle = fill;
    var p = new Path2D(d);
    c.fill(p);
    c.globalAlpha = 1;
  };

  /* SVG 后端: 收集字符串片段 (供 Node 端出矢量图 / 文档内联) */
  function SvgBk() {
    this.out = [];
    this.ns = 'bk';
    this._id = 0;
  }
  SvgBk.prototype._nid = function () { return this.ns + (++this._id); };
  SvgBk.prototype._f = function (v) { return (Math.round(v * 100) / 100); };
  SvgBk.prototype._pts = function (pts) {
    var s = [];
    for (var i = 0; i < pts.length; i++) s.push(this._f(pts[i][0]) + ',' + this._f(pts[i][1]));
    return s.join(' ');
  };
  SvgBk.prototype.poly = function (pts, fill, a) {
    if (!pts.length) return;
    this.out.push('<polygon points="' + this._pts(pts) + '" fill="' + fill +
      '" fill-opacity="' + (a == null ? 1 : a).toFixed(3) + '"/>');
  };
  SvgBk.prototype.line = function (pts, o) {
    if (pts.length < 2) return;
    var dash = o.dash ? ' stroke-dasharray="' + o.dash[0] + ' ' + o.dash[1] + '"' : '';
    this.out.push('<polyline points="' + this._pts(pts) + '" fill="none" stroke="' + (o.c || INK) +
      '" stroke-width="' + (o.w == null ? 1 : Math.round(o.w * 100) / 100).toFixed(2) +
      '" stroke-opacity="' + (o.a == null ? 1 : o.a).toFixed(3) +
      '" stroke-linecap="round" stroke-linejoin="round"' + dash + '/>');
  };
  SvgBk.prototype.circle = function (x, y, r, fill, a) {
    if (r <= 0) return;
    this.out.push('<circle cx="' + this._f(x) + '" cy="' + this._f(y) + '" r="' + this._f(r) +
      '" fill="' + fill + '" fill-opacity="' + (a == null ? 1 : a).toFixed(3) + '"/>');
  };
  SvgBk.prototype.ellipse = function (x, y, rx, ry, fill, a) {
    if (rx <= 0 || ry <= 0) return;
    this.out.push('<ellipse cx="' + this._f(x) + '" cy="' + this._f(y) + '" rx="' + this._f(rx) +
      '" ry="' + this._f(ry) + '" fill="' + fill + '" fill-opacity="' +
      (a == null ? 1 : a).toFixed(3) + '"/>');
  };
  SvgBk.prototype.radial = function (x, y, r, col, a, rx, ry) {
    if (r <= 0 || a <= 0) return;
    var id = this._nid();
    this.out.push('<defs><radialGradient id="' + id + '"><stop offset="0%" stop-color="' + col +
      '" stop-opacity="' + a.toFixed(3) + '"/><stop offset="55%" stop-color="' + col +
      '" stop-opacity="' + (a * 0.42).toFixed(3) + '"/><stop offset="100%" stop-color="' + col +
      '" stop-opacity="0"/></radialGradient></defs>');
    if (rx != null) {
      this.out.push('<ellipse cx="' + this._f(x) + '" cy="' + this._f(y) + '" rx="' + this._f(rx) +
        '" ry="' + this._f(ry) + '" fill="url(#' + id + ')"/>');
    } else {
      this.out.push('<circle cx="' + this._f(x) + '" cy="' + this._f(y) + '" r="' + this._f(r) +
        '" fill="url(#' + id + ')"/>');
    }
  };
  SvgBk.prototype.dpath = function (d, fill, a) {
    this.out.push('<path d="' + d + '" fill="' + fill + '" fill-opacity="' +
      (a == null ? 1 : a).toFixed(3) + '"/>');
  };

  function rgba(hex, a) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ============================================================
   * 3. 画架 (frame): 局部坐标 → 屏幕
   *    局部坐标系: u = 建筑右手方向, v = 建筑正面朝向, h = 高度
   *    投影: 世界地面 (fx,fy) 为朝向; 纵深按 KY 压扁; 高度竖直向上
   *    → 建筑朝向一转, 墙面遮挡关系/门开在哪面/屋面正脊走向全部随之改变
   * ============================================================ */
  function frameOf(o) {
    var fx = (o.face && o.face.x) || 0, fy = (o.face && o.face.y) || 0;
    var L = Math.sqrt(fx * fx + fy * fy);
    if (!L) { fx = 0; fy = 1; L = 1; }      // 缺省: 坐北朝南
    fx /= L; fy /= L;
    var R = o.R || 16;
    var U = R * (o.unit || 0.78);          // 局部 1 单位 = U 像素
    var S = {
      B: o.B, cx: o.cx, cy: o.cy, R: R, U: U,
      fx: fx, fy: fy, rx: fy, ry: -fx,
      q: o.q || 0, r: o.r || 0, kind: o.kind || '',
      detail: o.detail == null ? 3 : o.detail,    // 3=全 2=中 1=剪影
      tier: o.tier || 1,
      /* 地缘标记: 该格环内有可用水面 —— 决定水车/水碓一类构件是否成立。
         缺省 true (不影响不读它的建筑); 由调用方按地类探针给出。 */
      water: o.water !== false,
      rand: mulberry32(o.seed == null ? 1 : o.seed)
    };
    /* ⚠ 投影必须从 S 读朝向: 若闭包捕获 fx/fy, 之后 paint() 按规则推导出的
       朝向就改不动投影 → 所有建筑塌成一条竖线 (2026-09-13 实测踩过)。 */
    /* 局部 (u,v,h) → 屏幕 */
    S.p = function (u, v, h) {
      var wx = u * this.rx + v * this.fx, wy = u * this.ry + v * this.fy;
      return [this.cx + wx * this.U, this.cy + wy * this.U * KY - (h || 0) * this.U];
    };
    /* 地面点 (h=0) */
    S.g = function (u, v) { return this.p(u, v, 0); };
    /* 视深: 越大越靠近观察者 (面片排序用) */
    S.d = function (u, v) { return -u * this.fx + v * this.fy; };
    /* 重设朝向 (保持单位长度, 右轴随动) */
    S.setFace = function (f) {
      var l = Math.sqrt(f.x * f.x + f.y * f.y) || 1;
      this.fx = f.x / l; this.fy = f.y / l;
      this.rx = this.fy; this.ry = -this.fx;
      return this;
    };
    return S;
  }

  /* ============================================================
   * 4. 笔法基元 (枯笔叠层 + 飞白 + 椿点 + 晕染)
   * ============================================================ */
  /* 枯笔线: n 层叠加 + 逐点抖动, 末层叠底色虚线模拟飞白 */
  function ink(S, pts, o) {
    o = o || {};
    var B = S.B;
    var w = o.w == null ? 1.4 : o.w;
    var col = o.c || INK, a = o.a == null ? 0.8 : o.a;
    var n = S.detail <= 1 ? 1 : (o.n == null ? 2 : o.n);
    var j = o.j == null ? w * 0.36 : o.j;
    var fly = o.fly !== false && w > 1.05 && S.detail >= 3;
    for (var L = 0; L < n; L++) {
      var jj = j * (1 + L * 0.85);
      var p2 = [];
      for (var i = 0; i < pts.length; i++) {
        p2.push([pts[i][0] + (S.rand() - 0.5) * jj, pts[i][1] + (S.rand() - 0.5) * jj]);
      }
      B.line(p2, { w: w * (1 - L * 0.28) * (0.82 + S.rand() * 0.36), c: col, a: a * (L === 0 ? 0.94 : 0.42) });
    }
    if (fly) {
      var p3 = [];
      for (i = 0; i < pts.length; i++) {
        p3.push([pts[i][0] + (S.rand() - 0.5) * w * 0.8, pts[i][1] + (S.rand() - 0.5) * w * 0.8]);
      }
      B.line(p3, { w: w * 0.32, c: o.flyC || '#f2ead8', a: 0.40, dash: [1.4 + S.rand() * 3, 1.6 + S.rand() * 4] });
    }
  }
  /* 没骨铺面 */
  function faceOf(S, pts, fill, a) { S.B.poly(pts, fill, a == null ? 1 : a); }
  /* 椿点 (叶簇/火星/星点) */
  function dots(S, x, y, n, col, rb, spread, a) {
    if (S.detail <= 1) { S.B.circle(x, y, rb * 1.5, col, (a || 0.5) * 0.9); return; }
    spread = spread == null ? 5 : spread;
    a = a == null ? 0.45 : a;
    for (var i = 0; i < n; i++) {
      var an = S.rand() * Math.PI * 2, d = S.rand() * spread;
      S.B.circle(x + Math.cos(an) * d, y + Math.sin(an) * d * 0.72,
        rb * (0.5 + S.rand() * 0.9), col, a * (0.6 + S.rand() * 0.7));
    }
  }
  /* 地面落影 (椭圆墨晕) */
  function shade(S, u, v, r, a) {
    var p = S.g(u, v);
    S.B.radial(p[0], p[1], r, '#302a22', a == null ? 0.3 : a, r, r * KY);
  }

  /* 点顶六边形 (与地图网格同朝向: 顶点在正上/正下) */
  function hexPts(cx, cy, r) {
    var out = [];
    for (var i = 0; i < 6; i++) {
      var a = (60 * i - 90) * Math.PI / 180;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  }

  /* ============================================================
   * 5. 立体构件 (全部走 frame 投影 → 自然带朝向与遮挡)
   * ============================================================ */
  /* 5.1 六边格基座 = 建筑的「场地」: 与地图网格同朝向同半径的地皮色块 + 墨边
     2026-09-14 七版加强 (用户: "建筑背景应该有一个场地, 避免 svg 太浅被背景覆盖"):
       · 地皮色块不透明度默认 0.32 (旧 0.22 太淡, 浅色墙/茅顶会直接糊进群系底纹);
       · 墨边降到 detail>=1 就画 (旧仅 detail>=2), 让"这块地有边界"一眼可读;
       · 六边**之外**再铺一圈渐隐柔光 —— 建筑与地形之间有一层过渡, 不再硬切。
     opts.tint 取地皮底色 (LANDUSE_TINT); halo=false 可关柔光 (小尺寸省一层)。 */
  function hexPlate(S, o) {
    o = o || {};
    var B = S.B, r = S.R * (o.rMul == null ? 1.0 : o.rMul);
    var pts = hexPts(S.cx, S.cy, r);
    if (o.halo !== false && S.detail >= 2) {
      var g0 = S.g(0, 0);
      B.radial(g0[0], g0[1], r * 1.18, o.haloCol || '#efe6d2',
        o.haloA == null ? 0.28 : o.haloA, r * 1.18, r * 1.18 * KY);
    }
    B.poly(pts, o.tint || STONE, o.a == null ? 0.32 : o.a);
    if (S.detail >= 1) {
      B.line(pts.concat([pts[0]]), { w: o.lw || Math.max(0.5, r * 0.045), c: o.lc || INK4,
        a: o.la == null ? 0.40 : o.la });
    }
  }
  /* 5.2 墙: 一段竖直墙面 (由局部线段 a→b + 高度区间 [h0,h1] 定义) */
  function wallRect(S, w, t0, t1, h0, h1, fill, alpha) {
    var au = w.a[0], av = w.a[1], bu = w.b[0], bv = w.b[1];
    var u0 = au + (bu - au) * t0, v0 = av + (bv - av) * t0;
    var u1 = au + (bu - au) * t1, v1 = av + (bv - av) * t1;
    var p00 = S.p(u0, v0, h0), p10 = S.p(u1, v1, h0);
    var p11 = S.p(u1, v1, h1), p01 = S.p(u0, v0, h1);
    faceOf(S, [p00, p10, p11, p01], fill, alpha);
    return [p00, p10, p11, p01];
  }
  function wallInk(S, quad, o) {
    o = o || {};
    var w1 = o.w1 == null ? 1.05 : o.w1, a0 = o.a == null ? 0.46 : o.a;
    ink(S, [quad[0], quad[1]], { w: w1, c: o.c || INK, a: a0, n: 1, fly: false, j: 0.45 });
    ink(S, [quad[0], quad[3]], { w: w1, c: o.c || INK, a: a0 * 0.66, n: 1, fly: false, j: 0.45 });
    ink(S, [quad[3], quad[2]], { w: w1 * 0.85, c: o.c || INK2, a: a0 * 0.7, n: 1, fly: false, j: 0.45 });
  }
  /* 5.3 墙体四片: 按视深排序铺面 (远的先画 → 近的压住) + 双勾轮廓
     返回 { walls, front, visible } 供门/窗定位 */
  function boxWalls(S, o) {
    var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
    var u0 = at[0] - W, u1 = at[0] + W, v0 = at[1] - D, v1 = at[1] + D;
    var h0 = o.h0 || 0, h1 = o.h1;
    var walls = [
      { a: [u0, v0], b: [u1, v0], n: [0, -1], side: 'back' },
      { a: [u0, v1], b: [u1, v1], n: [0, 1], side: 'front' },
      { a: [u0, v0], b: [u0, v1], n: [-1, 0], side: 'left' },
      { a: [u1, v0], b: [u1, v1], n: [1, 0], side: 'right' }
    ];
    var i;
    for (i = 0; i < 4; i++) {
      var w = walls[i];
      var mu = (w.a[0] + w.b[0]) / 2, mv = (w.a[1] + w.b[1]) / 2;
      w.depth = S.d(mu, mv);                       // 中点视深
      w.vis = S.d(w.n[0], w.n[1]);                 // 法线朝向 (<=0 背对观察者)
      w.quad = null;
    }
    walls.sort(function (p, q) { return p.depth - q.depth; });
    for (i = 0; i < 4; i++) {
      var ww = walls[i];
      var fill = o.fill || WALL;
      var alpha = ww.vis > 0.05 ? (o.fa == null ? 0.97 : o.fa) : (o.fa == null ? 0.97 : o.fa) * 0.82;
      var q = wallRect(S, ww, 0, 1, h0, h1, fill, alpha);
      ww.quad = q;
      /* 背光面压一层淡墨 (体积感) */
      if (ww.vis <= 0.05 && S.detail >= 2) faceOf(S, q, INK5, 0.30);
      /* 墙皮剥落: 干笔扫纹 */
      if (S.detail >= 3 && ww.vis > -0.3) {
        var n = o.peel == null ? 3 : o.peel;
        for (var k = 0; k < n; k++) {
          var t = 0.12 + S.rand() * 0.72, hh = h0 + (h1 - h0) * (0.22 + S.rand() * 0.5);
          var pa = S.p(ww.a[0] + (ww.b[0] - ww.a[0]) * t, ww.a[1] + (ww.b[1] - ww.a[1]) * t, hh);
          ink(S, [pa, [pa[0] + (S.rand() - 0.5) * 10 + (ww.vis > 0 ? 4 : -4), pa[1] + (S.rand() - 0.5) * 2]],
            { w: 0.95, c: INK3, a: 0.18 + S.rand() * 0.14, n: 1, fly: false, j: 0.4 });
        }
      }
      /* 墙裙 (底部一道深色带 → 体块落地, 不再像悬空纸片) */
      if (ww.vis > -0.2 && S.detail >= 2) {
        var kh = h0 + (h1 - h0) * (o.plinth == null ? 0.2 : o.plinth);
        var kq = [S.p(ww.a[0], ww.a[1], h0), S.p(ww.b[0], ww.b[1], h0),
                  S.p(ww.b[0], ww.b[1], kh), S.p(ww.a[0], ww.a[1], kh)];
        faceOf(S, kq, o.plinthC || EARTH, ww.vis > 0.05 ? 0.34 : 0.24);
      }
      wallInk(S, q, o);
    }
    /* 找出"正面墙"(法线 = +v) 与可见侧墙 */
    var front = null, bestVis = -2;
    for (i = 0; i < 4; i++) {
      var c = walls[i];
      var sc = c.vis + (c.side === 'front' ? 0.35 : 0);      // 优先正面
      if (sc > bestVis) { bestVis = sc; front = c; }
    }
    return { walls: walls, front: front, at: at, W: W, D: D, h0: h0, h1: h1 };
  }
  /* 5.4 开门: 落在"最可见的墙"上, 位置偏向正面端 → 朝向一变, 门就换面 */
  function placeDoor(S, bx, o) {
    o = o || {};
    var w = bx.front;
    if (!w || w.vis < -0.15) w = null;
    if (!w) {
      /* 正面完全背对: 门落在唯一可见的侧墙上, 且靠前端 */
      for (var i = 0; i < bx.walls.length; i++) { if (bx.walls[i].vis > 0.05) { w = bx.walls[i]; break; } }
      if (!w) return;
    }
    var t = o.t == null ? 0.5 : o.t;
    var hw = o.hw == null ? 0.11 : o.hw;
    var t0 = Math.max(0.06, t - hw), t1 = Math.min(0.94, t + hw);
    var dh = o.h == null ? (bx.h1 - bx.h0) * 0.62 : o.h;
    var q = wallRect(S, w, t0, t1, bx.h0, bx.h0 + dh, o.c || INK, o.a == null ? 0.74 : o.a);
    ink(S, [q[0], q[1], q[2], q[3], q[0]], { w: 1.25, c: o.frame || CINNABAR, a: 0.62, n: 1, fly: false, j: 0.35 });
    return q;
  }
  /* 5.5 窗: 在可见墙上开小方格窗 (u01 = 沿墙参数) */
  function placeWin(S, bx, sideName, t, h01, ww, wh) {
    var w = null, i;
    for (i = 0; i < bx.walls.length; i++) if (bx.walls[i].side === sideName) w = bx.walls[i];
    if (!w || w.vis <= -0.3) return;
    var h = bx.h0 + (bx.h1 - bx.h0) * (h01 == null ? 0.55 : h01);
    var q = wallRect(S, w, t - ww, t + ww, h - wh, h + wh, '#f6efdc', 0.92);
    ink(S, [q[0], q[1], q[2], q[3], q[0]], { w: 1.0, c: INK2, a: 0.6, n: 1, fly: false, j: 0.3 });
    if (S.detail >= 3) {
      ink(S, [q[3], q[2]], { w: 0.75, c: INK3, a: 0.4, n: 1, fly: false, j: 0.2 });
      ink(S, [[(q[0][0] + q[3][0]) / 2, (q[0][1] + q[3][1]) / 2], [(q[1][0] + q[2][0]) / 2, (q[1][1] + q[2][1]) / 2]],
        { w: 0.75, c: INK3, a: 0.4, n: 1, fly: false, j: 0.2 });
    }
  }
  /* 5.6 屋面 (悬山/硬山): ridge 沿 u 或 v; 两坡按视深排序 + 瓦垄 + 正脊 + 鸱吻 + 反宇檐
     o: {at,w,d,h0(=檐口高),rise,eave,ridge:'u'|'v',inset,fill,tiles,chiwen,collinear} */
  function roofGable(S, o) {
    var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
    var u0 = at[0] - W, u1 = at[0] + W, v0 = at[1] - D, v1 = at[1] + D;
    var hv = o.h0, hr = o.h0 + o.rise;                   // 檐口高 / 脊高
    var ev = o.eave == null ? 0.1 : o.eave;
    var ins = o.inset == null ? W * 0.28 : o.inset;
    var ridgeU = (o.ridge || 'v') === 'u';
    var a0, a1, b0, b1, rA, rB, slopes;
    if (ridgeU) {                                        // 脊沿 u: 两坡朝 ±v
      a0 = [u0 - ev, v0 - ev]; a1 = [u1 + ev, v0 - ev];
      b0 = [u0 - ev, v1 + ev]; b1 = [u1 + ev, v1 + ev];
      rA = [u0 + ins, at[1]]; rB = [u1 - ins, at[1]];
      slopes = [
        { q: [S.p(rA[0], rA[1], hr), S.p(a0[0], a0[1], hv), S.p(a1[0], a1[1], hv), S.p(rB[0], rB[1], hr)],
          dep: S.d((rA[0] + rB[0]) / 2, v0 - ev * 0.5) },
        { q: [S.p(rA[0], rA[1], hr), S.p(b0[0], b0[1], hv), S.p(b1[0], b1[1], hv), S.p(rB[0], rB[1], hr)],
          dep: S.d((rA[0] + rB[0]) / 2, v1 + ev * 0.5) }
      ];
    } else {                                             // 脊沿 v: 两坡朝 ±u
      a0 = [u0 - ev, v0 - ev]; a1 = [u0 - ev, v1 + ev];
      b0 = [u1 + ev, v0 - ev]; b1 = [u1 + ev, v1 + ev];
      rA = [at[0], v0 + ins]; rB = [at[0], v1 - ins];
      slopes = [
        { q: [S.p(rA[0], rA[1], hr), S.p(a0[0], a0[1], hv), S.p(a1[0], a1[1], hv), S.p(rB[0], rB[1], hr)],
          dep: S.d(u0 - ev * 0.5, (rA[1] + rB[1]) / 2) },
        { q: [S.p(rA[0], rA[1], hr), S.p(b0[0], b0[1], hv), S.p(b1[0], b1[1], hv), S.p(rB[0], rB[1], hr)],
          dep: S.d(u1 + ev * 0.5, (rA[1] + rB[1]) / 2) }
      ];
    }
    var far = slopes[0].dep < slopes[1].dep ? 0 : 1;
    var near = 1 - far;
    var i;
    /* 背面坡 (先画, 后面被近坡压住): 面 + 压墨 (背光) */
    faceOf(S, slopes[far].q, o.fill || TILE, (o.fa == null ? 0.97 : o.fa) * 0.82);
    faceOf(S, slopes[far].q, INK5, 0.30);
    /* 山花 (两端三角, 悬山露出山墙) */
    if (!ridgeU && S.detail >= 2) {
      for (i = 0; i < 2; i++) {
        var vv = i === 0 ? v0 - ev : v1 + ev;
        if (S.d(0, i === 0 ? -1 : 1) > 0) {
          faceOf(S, [S.p(u0 - ev, vv, hv), S.p(u1 + ev, vv, hv), S.p(at[0], vv, hr)], o.gable || '#c9bda4', 0.92);
          ink(S, [S.p(at[0], vv, hr), S.p(u1 + ev, vv, hv), S.p(u0 - ev, vv, hv), S.p(at[0], vv, hr)],
            { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
        }
      }
    }
    /* 近坡 */
    faceOf(S, slopes[near].q, o.fill || TILE, o.fa == null ? 0.97 : o.fa);
    /* 坡面墨带 (平行于脊的淡墨条 → 屋面有"瓦色深浅", 不再是白纸片) */
    if (S.detail >= 2) {
      var sp0 = slopes[near].q, lerp2 = function (A, B, t) { return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; };
      for (i = 1; i <= 2; i++) {
        /* ⚠ 循环变量不得用 a1/b1 —— 会覆盖屋面四角的檐点数组, 檐线随即飞出画面 */
        var tb0 = (i * 2 - 1) / 6, tb1 = (i * 2 + 0.35) / 6;
        var pA0 = lerp2(sp0[0], sp0[1], tb0), pA1 = lerp2(sp0[0], sp0[1], tb1);
        var pB0 = lerp2(sp0[3], sp0[2], tb0), pB1 = lerp2(sp0[3], sp0[2], tb1);
        faceOf(S, [pA0, pA1, pB1, pB0], INK4, 0.13);
      }
      /* 檐口内侧最暗一档 (压檐) */
      faceOf(S, [lerp2(sp0[0], sp0[1], 0.86), sp0[1], sp0[2], lerp2(sp0[3], sp0[2], 0.86)], INK3, 0.16);
    }
    /* 瓦垄: 沿坡向短线, 平行于脊排布 (只画近坡, 轻笔) */
    if (S.detail >= 3) {
      var cols = o.tiles == null ? 7 : o.tiles;
      var sp = slopes[near].q;
      for (i = 1; i <= cols; i++) {
        var t = i / (cols + 1);
        var x0 = sp[0][0] + (sp[1][0] - sp[0][0]) * t, y0 = sp[0][1] + (sp[1][1] - sp[0][1]) * t;
        var x1 = sp[3][0] + (sp[2][0] - sp[3][0]) * t, y1 = sp[3][1] + (sp[2][1] - sp[3][1]) * t;
        S.B.line([[x0, y0], [x1, y1]], { w: 0.62, c: INK4, a: 0.22 });
      }
    }
    /* 正脊 + 压脊线 */
    var RA = S.p(rA[0], rA[1], hr), RB = S.p(rB[0], rB[1], hr);
    ink(S, [RA, RB], { w: o.ridgeW == null ? 2.0 : o.ridgeW, c: INK, a: 0.8, n: 2, fly: false, j: 0.35 });
    ink(S, [[RA[0], RA[1] + o.rise * S.U * 0.14], [RB[0], RB[1] + o.rise * S.U * 0.14]],
      { w: 0.85, c: INK2, a: 0.36, n: 1, fly: false, j: 0.35 });
    /* 鸱吻 (两端起翘) */
    if (o.chiwen !== false && S.detail >= 2) {
      var dirA = [RA[0] - RB[0], RA[1] - RB[1]];
      var lA = Math.sqrt(dirA[0] * dirA[0] + dirA[1] * dirA[1]) || 1;
      dirA = [dirA[0] / lA, dirA[1] / lA];
      var k = S.U * 0.30;
      ink(S, [RA, [RA[0] + dirA[0] * k * 0.7, RA[1] + dirA[1] * k * 0.7 - k * 0.9],
        [RA[0] + dirA[0] * k * 0.15, RA[1] + dirA[1] * k * 0.15 - k * 1.25]],
        { w: 1.15, c: INK, a: 0.64, n: 1, fly: false, j: 0.3 });
      ink(S, [RB, [RB[0] - dirA[0] * k * 0.7, RB[1] - dirA[1] * k * 0.7 - k * 0.9],
        [RB[0] - dirA[0] * k * 0.15, RB[1] - dirA[1] * k * 0.15 - k * 1.25]],
        { w: 1.15, c: INK, a: 0.64, n: 1, fly: false, j: 0.3 });
    }
    /* 反宇檐口: 一条"两端上翘、中段下垂"的檐线 (不再另加挑角斜线,
       否则每座屋顶都会长出两根飞出去的杆 —— 2026-09-13 实测踩过) */
    /* 檐口线取"近坡那条檐"(与近坡同侧), 两侧参数同构 → 一个分支即可 */
    var e0 = near === 0 ? a0 : b0, e1 = near === 0 ? a1 : b1;
    var eA = S.p(e0[0], e0[1], hv), eB = S.p(e1[0], e1[1], hv);
    var curl = S.U * (o.curl == null ? 0.1 : o.curl);
    var midE = [(eA[0] + eB[0]) / 2, (eA[1] + eB[1]) / 2 + S.U * o.rise * 0.2];
    var eL2 = [eA[0] + (eB[0] - eA[0]) * 0.14, eA[1] + (eB[1] - eA[1]) * 0.14 - curl * 0.7];
    var eR2 = [eA[0] + (eB[0] - eA[0]) * 0.86, eA[1] + (eB[1] - eA[1]) * 0.86 - curl * 0.7];
    ink(S, [[eA[0], eA[1] - curl], eL2, midE, eR2, [eB[0], eB[1] - curl]],
      { w: o.eaveW == null ? 1.35 : o.eaveW, c: INK, a: 0.66, n: 1, fly: false, j: 0.4 });
    return { hr: hr, hv: hv, RA: RA, RB: RB };
  }
  /* 5.7 歇山: 大 inset 的脊 + 端部斜面补角 (比悬山多一层"腰") */
  function roofHip(S, o) {
    var o2 = {};
    for (var k in o) o2[k] = o[k];
    o2.inset = (o.inset == null) ? (o.ridge === 'u' ? o.w : o.d) * 0.5 * 0.94 : o.inset;
    var res = roofGable(S, o2);
    /* 端部斜面 (歇山的"歇"): 脊两端到檐角的戗脊 */
    if (S.detail >= 2) {
      var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
      var u0 = at[0] - W, u1 = at[0] + W, v0 = at[1] - D, v1 = at[1] + D;
      var ev = o.eave == null ? 0.1 : o.eave;
      var apex = S.p(at[0], v1 - (o2.inset), res.hr);
      ink(S, [apex, S.p(u0 - ev, v1 + ev, res.hv)], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
      ink(S, [apex, S.p(u1 + ev, v1 + ev, res.hv)], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
    }
    return res;
  }
  /* 5.8 攒尖顶 (亭/塔): 四坡聚于一点 */
  function roofPyr(S, o) {
    var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
    var hv = o.h0, hr = o.h0 + o.rise, ev = o.eave == null ? 0.12 : o.eave;
    var c = [S.p(at[0], at[1], hr), at[0], at[1]];
    var cor = [
      S.p(at[0] - W - ev, at[1] - D - ev, hv), S.p(at[0] + W + ev, at[1] - D - ev, hv),
      S.p(at[0] + W + ev, at[1] + D + ev, hv), S.p(at[0] - W - ev, at[1] + D + ev, hv)
    ];
    var order = [0, 1, 2, 3];
    order.sort(function (i, j) {
      var di = [at[0] + (i === 0 || i === 3 ? -1 : 1) * W, at[1] + (i < 2 ? -1 : 1) * D];
      var dj = [at[0] + (j === 0 || j === 3 ? -1 : 1) * W, at[1] + (j < 2 ? -1 : 1) * D];
      return S.d(di[0] - at[0], di[1] - at[1]) - S.d(dj[0] - at[0], dj[1] - at[1]);
    });
    var i;
    for (i = 0; i < 4; i++) {
      var a = order[i], b = order[(i + 1) % 4];
      faceOf(S, [c[0], cor[a], cor[b]], o.fill || TILE, i >= 2 ? 0.97 : 0.82);
      ink(S, [cor[a], c[0]], { w: 1.1, c: INK3, a: 0.42, n: 1, fly: false, j: 0.4 });
    }
    ink(S, [cor[0], cor[1], cor[2], cor[3], cor[0]], { w: 1.8, c: INK, a: 0.7, n: 2, fly: false, j: 0.5 });
    if (S.detail >= 3) {
      var cols = o.tiles == null ? 7 : o.tiles;
      for (i = 0; i < 4; i++) {
        var ca = cor[order[i]], cb = cor[order[(i + 1) % 4]];
        for (var t = 1; t < cols; t++) {
          var tt = t / cols;
          S.B.line([[c[0][0] + (ca[0] - c[0][0]) * tt, c[0][1] + (ca[1] - c[0][1]) * tt],
                    [c[0][0] + (cb[0] - c[0][0]) * tt, c[0][1] + (cb[1] - c[0][1]) * tt]],
            { w: 0.6, c: INK4, a: 0.22 });
        }
      }
    }
    /* 宝顶 */
    ink(S, [[c[0][0], c[0][1]], [c[0][0], c[0][1] - S.U * 0.18]], { w: 1.6, c: INK, a: 0.66, n: 1, fly: false, j: 0.3 });
    dots(S, c[0][0], c[0][1] - S.U * 0.2, 3, o.topCol || INK2, S.U * 0.05, S.U * 0.05, 0.6);
    return { hr: hr, hv: hv };
  }
  /* 5.9 茅草圆锥顶 (仓/草棚): 尖顶 + 大出檐 + 散锋 */
  function roofCone(S, o) {
    var at = o.at || [0, 0], rw = o.w / 2, rd = o.d / 2;
    var hv = o.h0, hr = o.h0 + o.rise;
    var apex = S.p(at[0], at[1], hr);
    var n = S.detail >= 3 ? 14 : 8, pts = [], i;
    for (i = 0; i <= n; i++) {
      var a = (i / n) * Math.PI * 2;
      pts.push(S.p(at[0] + Math.cos(a) * rw, at[1] + Math.sin(a) * rd, hv));
    }
    var poly = [apex].concat(pts);
    faceOf(S, poly, o.fill || THATCH, o.fa == null ? 0.96 : o.fa);
    if (S.detail >= 3) {
      for (i = 0; i < 9; i++) {
        var aa = S.rand() * Math.PI * 2, rr = 0.35 + S.rand() * 0.6;
        var ep = S.p(at[0] + Math.cos(aa) * rw * rr, at[1] + Math.sin(aa) * rd * rr, hv);
        S.B.line([apex, ep], { w: 0.7, c: INK4, a: 0.22 });
      }
      for (i = 0; i < 12; i++) {
        var t = S.rand(), an2 = S.rand() * Math.PI * 2;
        var bx = at[0] + Math.cos(an2) * rw, by = at[1] + Math.sin(an2) * rd;
        var bp = S.p(bx, by, hv);
        ink(S, [bp, [bp[0] + (S.rand() - 0.5) * S.U * 0.2, bp[1] + S.U * (0.05 + S.rand() * 0.12)]],
          { w: 0.9, c: INK3, a: 0.3, n: 1, fly: false, j: 0.5 });
      }
    }
    var out = [pts[0]].concat([]);
    for (i = 0; i <= n; i++) out.push(pts[i]);
    if (S.detail >= 2) ink(S, pts, { w: 1.5, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
    ink(S, [apex, S.p(at[0], at[1], hr + 0.1)], { w: 1.5, c: INK, a: 0.6, n: 1, fly: false, j: 0.3 });
    faceOf(S, [apex, pts[0], pts[Math.floor(n / 2)]], o.fill || THATCH, 0.5);
    return { hr: hr, hv: hv };
  }
  /* 5.10 台基 (石台 + 披麻皴 + 压顶) */
  function slab(S, o) {
    var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
    var h0 = o.h0 || 0, h1 = h0 + o.h;
    var spread = o.spread == null ? 0.12 : o.spread;
    var box = boxWalls(S, { at: at, w: o.w, d: o.d, h0: h0, h1: h1,
      fill: o.fill || STONE, fa: 0.94, peel: o.cun == null ? 3 : o.cun });
    /* 披麻皴: 正面纵向短线 */
    if (S.detail >= 3) {
      var w = box.front;
      var nn = o.cun == null ? 7 : o.cun;
      for (var i = 0; i < nn; i++) {
        var t = (i + 0.5) / nn;
        var a = S.p(w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t, h1 * 0.88);
        var b = S.p(w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t, h1 * 0.12);
        ink(S, [a, b], { w: 0.85, c: INK3, a: 0.2 + S.rand() * 0.12, n: 1, fly: false, j: 0.5 });
      }
    }
    /* 压顶线 */
    var tp = [S.p(at[0] - W - spread, at[1] - D - spread, h1), S.p(at[0] + W + spread, at[1] - D - spread, h1),
              S.p(at[0] + W + spread, at[1] + D + spread, h1), S.p(at[0] - W - spread, at[1] + D + spread, h1)];
    faceOf(S, tp, o.fill || STONE, 0.9);
    ink(S, [tp[0], tp[1], tp[2], tp[3], tp[0]], { w: 1.5, c: INK, a: 0.6, n: 2, fly: false, j: 0.45 });
    return box;
  }
  /* 5.11 踏道 (正面石阶) */
  function stairs(S, o) {
    var at = o.at || [0, 0], n = o.n || 3, w = o.w / 2;
    var vFront = at[1] + (o.d || 0) / 2;
    for (var i = 0; i < n; i++) {
      var t = (i + 1) / n;
      var y0 = o.topY + (o.botY - o.topY) * (1 - t);
      var hw = w * (0.62 + 0.38 * (1 - t));
      var vv = vFront + (o.out || 0.3) * t;
      ink(S, [S.p(at[0] - hw, vv, y0), S.p(at[0] + hw, vv, y0)],
        { w: 1.15, c: INK3, a: 0.46, n: 1, fly: false, j: 0.4 });
    }
    var q = [S.p(at[0] - w * 0.62, vFront, o.topY), S.p(at[0] + w * 0.62, vFront, o.topY),
             S.p(at[0] + w, vFront + (o.out || 0.3), o.botY), S.p(at[0] - w, vFront + (o.out || 0.3), o.botY)];
    faceOf(S, q, o.fill || STONE, 0.62);
  }
  /* 5.12 立柱 (中锋渴笔, 立在可见墙前) */
  function posts(S, o) {
    var at = o.at || [0, 0], n = o.n || 4, W = o.w / 2;
    var vv = at[1] + (o.d || 0) / 2;
    for (var i = 0; i < n; i++) {
      var t = n === 1 ? 0.5 : i / (n - 1);
      var u = at[0] - W * 0.9 + 1.8 * W * t;
      var a = S.p(u, vv, o.h1), b = S.p(u, vv, o.h0);
      ink(S, [a, [(a[0] + b[0]) / 2 + (S.rand() - 0.5) * 0.6, (a[1] + b[1]) / 2], b],
        { w: o.w2 == null ? 1.9 : o.w2, c: o.c || INK2, a: o.a == null ? 0.66 : o.a, n: 2, fly: false, j: 0.4 });
    }
  }
  /* 5.13 幡旗 (杆 + 三角旗) */
  function flag(S, o) {
    var a = S.p(o.u, o.v, o.h0 == null ? 0 : o.h0);
    var b = S.p(o.u, o.v, o.h1);
    var col = o.c || CINNABAR, w = S.U * (o.w || 0.34);
    ink(S, [a, b], { w: 1.5, c: INK2, a: 0.7, n: 2, fly: false, j: 0.35 });
    faceOf(S, [b, [b[0] - w, b[1] + w * 0.34], [b[0] - w * 0.72, b[1] + w * 0.86], [b[0], b[1] + (b[1] - a[1]) * -0.4]],
      col, 0.58);
    ink(S, [b, [b[0] - w, b[1] + w * 0.34], [b[0] - w * 0.72, b[1] + w * 0.86]],
      { w: 1.0, c: col, a: 0.62, n: 1, fly: false, j: 0.3 });
  }
  /* 5.14 树 (枯笔干 + 三色冠) */
  function tree(S, o) {
    var base = S.p(o.u, o.v, o.h0 == null ? 0 : o.h0);
    var h = S.U * (o.h || 0.9);
    var lean = (S.rand() - 0.5) * h * 0.12;
    ink(S, [base, [base[0] + lean * 0.5, base[1] - h * 0.5], [base[0] + lean, base[1] - h * 0.86]],
      { w: o.tk == null ? 1.7 : o.tk, c: '#4a3c2a', a: 0.64, n: 2, fly: false, j: 0.45 });
    ink(S, [[base[0] + lean * 0.3, base[1] - h * 0.52], [base[0] + lean * 0.3 + h * 0.16, base[1] - h * 0.7]],
      { w: 1.0, c: '#4a3c2a', a: 0.42, n: 1, fly: false, j: 0.4 });
    var cx = base[0] + lean, cy = base[1] - h * 0.86, cr = h * 0.44;
    dots(S, cx - cr * 0.3, cy + cr * 0.24, 11, o.c1 || '#3d5340', cr * 0.42, cr * 0.5, 0.5);
    dots(S, cx + cr * 0.16, cy - cr * 0.06, 10, o.c2 || '#4b6647', cr * 0.38, cr * 0.46, 0.52);
    dots(S, cx + cr * 0.06, cy - cr * 0.42, 7, o.c3 || '#5b7550', cr * 0.28, cr * 0.34, 0.5);
  }
  /* 5.15 炊烟/丹烟 */
  function smoke(S, o) {
    if (S.detail <= 1) return;
    var n = o.n || 4;
    for (var i = 0; i < n; i++) {
      var t = i / n;
      var p = S.p(o.u + (S.rand() - 0.5) * 0.16, o.v + (S.rand() - 0.5) * 0.12, o.h0 + (o.h || 0.6) * t);
      S.B.radial(p[0], p[1], S.U * (0.16 + S.rand() * 0.12), o.c || INK4, (o.a == null ? 0.22 : o.a) * (1 - t * 0.6));
    }
  }
  /* 5.16 灵光晕圈 */
  function aura(S, o) {
    var p = S.p(o.u == null ? 0 : o.u, o.v == null ? 0 : o.v, o.h || 0);
    S.B.radial(p[0], p[1], S.U * (o.r || 1), o.c || SPIRIT, o.a == null ? 0.22 : o.a);
  }
  /* 5.17 竹篱 (沿局部线段) */
  function fence(S, o) {
    var n = o.n || 7, i;
    for (i = 0; i <= n; i++) {
      var t = i / n;
      var u = o.u0 + (o.u1 - o.u0) * t, v = o.v0 + (o.v1 - o.v0) * t;
      var a = S.p(u, v, o.h0 || 0), b = S.p(u, v, (o.h0 || 0) + (o.h || 0.3));
      ink(S, [a, [b[0] + (S.rand() - 0.5) * 0.4, b[1]]], { w: 0.95, c: o.c || EARTH, a: 0.52, n: 1, fly: false, j: 0.35 });
    }
    var a1 = S.p(o.u0, o.v0, (o.h0 || 0) + (o.h || 0.3) * 0.72);
    var b1 = S.p(o.u1, o.v1, (o.h0 || 0) + (o.h || 0.3) * 0.72);
    ink(S, [a1, b1], { w: 0.9, c: o.c || EARTH, a: 0.44, n: 1, fly: false, j: 0.35 });
  }
  /* 5.18 水面 (前方朝向侧的水光扇 + 波纹) */
  function waterFan(S, o) {
    var n = S.detail >= 3 ? (o.n || 4) : 2;
    var c = S.g(o.u || 0, o.v || 0.9);
    S.B.radial(c[0], c[1], S.U * (o.r || 1.1), AZURE, o.a == null ? 0.26 : o.a, S.U * (o.r || 1.1), S.U * (o.r || 1.1) * 0.5);
    if (S.detail <= 1) return;
    for (var i = 0; i < n; i++) {
      var v = (o.v || 0.9) + i * 0.28;
      var a = S.p(-(o.hw || 0.9), v, 0), b = S.p(0, v + 0.06, 0), d = S.p((o.hw || 0.9), v, 0);
      ink(S, [a, b, d], { w: 1.0, c: AZURE, a: 0.30, n: 1, fly: false, j: 0.4 });
    }
  }
  /* 5.19 石堆/矿渣/柴堆 (地面椎体) */
  function heap(S, o) {
    var a = S.p(o.u - (o.w || 0.3), o.v + (o.d || 0.3) * 0.5, 0);
    var b = S.p(o.u, o.v - (o.d || 0.3) * 0.5, o.h || 0.22);
    var c = S.p(o.u + (o.w || 0.3), o.v + (o.d || 0.3) * 0.5, 0);
    faceOf(S, [a, b, c], o.fill || STONE, 0.9);
    ink(S, [a, b, c, a], { w: 1.1, c: o.c || INK3, a: 0.45, n: 1, fly: false, j: 0.45 });
    if (S.detail >= 3) dots(S, (a[0] + c[0]) / 2, (a[1] + c[1]) / 2 - S.U * 0.05, 6, o.dotC || INK2, S.U * 0.045, S.U * 0.16, 0.4);
  }

  /* ============================================================
   * 6. 地面平面构件 (俯视: 与地图六边网格同一平面, 不压扁)
   *    —— 田垄/畦垄/符阵/坛面 走这里, 让它们"贴"在格面上
   * ============================================================ */
  function gpOf(S, u, v) {
    var wx = u * S.rx + v * S.fx, wy = u * S.ry + v * S.fy;
    return [S.cx + wx * S.U, S.cy + wy * S.U];
  }
  function gpQuad(S, u0, v0, u1, v1, fill, a) {
    faceOf(S, [gpOf(S, u0, v0), gpOf(S, u1, v0), gpOf(S, u1, v1), gpOf(S, u0, v1)], fill, a);
  }
  function gpLine(S, pts, o) {
    var p = [];
    for (var i = 0; i < pts.length; i++) p.push(gpOf(S, pts[i][0], pts[i][1]));
    ink(S, p, o);
  }
  function gpWash(S, u, v, r, col, a) {
    var c = gpOf(S, u, v);
    S.B.radial(c[0], c[1], S.U * r, col, a);
  }
  function gpHexRing(S, r, o) {
    var c = gpOf(S, 0, 0), pts = hexPts(c[0], c[1], r * S.U);
    pts.push(pts[0]);
    ink(S, pts, o);
  }
  /* 干栏高脚 */
  function stiltPosts(S, o) {
    var n = o.n || 4, i;
    for (i = 0; i < n; i++) {
      var t = n === 1 ? 0.5 : i / (n - 1);
      var u = o.u0 + (o.u1 - o.u0) * t;
      var a = S.p(u, o.v0, o.h1), b = S.p(u, o.v0, o.h0);
      ink(S, [a, b], { w: 1.7, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.35 });
      a = S.p(u, o.v1, o.h1); b = S.p(u, o.v1, o.h0);
      ink(S, [a, b], { w: 1.5, c: EARTH, a: 0.5, n: 1, fly: false, j: 0.35 });
    }
  }
  /* 席棚 / 作坊棚: 柱 + 单坡顶 (集市/炼器/伐木共用) */
  function shedOf(S, o) {
    var at = o.at || [0, 0], W = o.w / 2, D = o.d / 2;
    var h0 = o.h0 || 0, h1 = o.h1, hi = o.hi == null ? h1 * 0.26 : o.hi;
    var u0 = at[0] - W, u1 = at[0] + W, v0 = at[1] - D, v1 = at[1] + D;
    var i;
    /* 四柱 */
    for (i = 0; i < 4; i++) {
      var uu = (i === 0 || i === 3) ? u0 + W * 0.06 : u1 - W * 0.06;
      var vv = (i < 2) ? v0 + D * 0.06 : v1 - D * 0.06;
      var hh = (i < 2) ? h1 + hi : h1;          // 后柱高 → 单坡
      ink(S, [S.p(uu, vv, hh), S.p(uu, vv, h0)], { w: o.pw || 1.4, c: o.pc || INK2, a: 0.6, n: 2, fly: false, j: 0.35 });
    }
    /* 坡面 (后高前低) */
    var q = [S.p(u0 - 0.08, v0 - 0.08, h1 + hi), S.p(u1 + 0.08, v0 - 0.08, h1 + hi),
             S.p(u1 + 0.08, v1 + 0.08, h1), S.p(u0 - 0.08, v1 + 0.08, h1)];
    faceOf(S, q, o.fill || THATCH, o.fa == null ? 0.95 : o.fa);
    if (S.detail >= 3) {
      for (i = 0; i <= 4; i++) {
        var t = i / 4;
        S.B.line([[q[0][0] + (q[1][0] - q[0][0]) * t, q[0][1] + (q[1][1] - q[0][1]) * t],
                  [q[3][0] + (q[2][0] - q[3][0]) * t, q[3][1] + (q[2][1] - q[3][1]) * t]],
          { w: 0.6, c: INK4, a: 0.24 });
      }
    }
    ink(S, [q[0], q[1]], { w: 1.5, c: INK, a: 0.55, n: 1, fly: false, j: 0.45 });
    ink(S, [q[3], q[2]], { w: 1.6, c: INK, a: 0.62, n: 2, fly: false, j: 0.5 });
    ink(S, [q[0], q[3]], { w: 1.2, c: INK2, a: 0.45, n: 1, fly: false, j: 0.4 });
  }
  /* ============================================================
   * 7. 房屋合成器 (墙体 + 台基 + 屋面 + 门 + 窗 + 立柱)
   * ============================================================ */
  function houseCore(S, o) {
    var at = o.at || [0, 0];
    var plat = o.plat == null ? 0.07 : o.plat;
    if (plat > 0) {
      slab(S, { at: at, w: o.w * 1.05, d: o.d * 1.08, h: plat, cun: o.cun == null ? 6 : o.cun,
        fill: o.platFill || STONE });
    }
    var h0 = plat, h1 = plat + o.wall;
    var box = boxWalls(S, { at: at, w: o.w, d: o.d, h0: h0, h1: h1,
      fill: o.fill || WALL, peel: o.peel == null ? 3 : o.peel, fa: o.fa });
    var roofO = { at: at, w: o.w, d: o.d, h0: h1, rise: o.rise,
      eave: o.eave == null ? 0.1 : o.eave, ridge: o.ridge || 'u',
      fill: o.roofFill || TILE, tiles: o.tiles, inset: o.inset, curl: o.curl, fa: o.roofFa };
    var rf = o.hip ? roofHip(S, roofO) : roofGable(S, roofO);
    if (o.postsN) posts(S, { at: at, w: o.w, d: o.d, h0: h0, h1: h1, n: o.postsN, w2: o.postW, a: o.postA });
    if (o.door !== false) placeDoor(S, box, o.door || {});
    if (o.wins) {
      for (var i = 0; i < o.wins.length; i++) {
        var wn = o.wins[i];
        placeWin(S, box, wn[0], wn[1], wn[2], wn[3] == null ? 0.075 : wn[3], wn[4] == null ? 0.07 : wn[4]);
      }
    }
    if (o.plaque) {
      var fw = box.front;
      if (fw) {
        var ph = h1 + (o.rise || 0.2) * 0.30;
        var pq = wallRect(S, fw, 0.4, 0.6, ph - 0.075, ph, '#3a3128', 0.78);
        ink(S, [pq[0], pq[1], pq[2], pq[3], pq[0]], { w: 1.0, c: GAMBOGE, a: 0.6, n: 1, fly: false, j: 0.25 });
      }
    }
    return { box: box, roof: rf, h0: h0, h1: h1 };
  }
  /* 重檐 (腰檐 + 上层): 大殿/灵枢殿/祖师殿 用 */
  function twoTier(S, o) {
    var at = o.at || [0, 0];
    var lower = houseCore(S, o);
    /* 上层收进 */
    var up = houseCore(S, {
      at: at, w: o.w * (o.shrink || 0.68), d: o.d * (o.shrink || 0.68),
      plat: o.h1 + o.riseLower * 0.92, wall: o.wall2 || o.wall * 0.72,
      rise: o.rise2 || o.rise * 0.85, ridge: o.ridge || 'u', tiles: (o.tiles || 8) - 2,
      fill: o.fill2 || o.fill, roofFill: o.roofFill, cun: 0, eave: o.eave,
      door: false, hip: o.hip2, plaque: o.plaque
    });
    return up;
  }
  /* 屋脊宝顶 (灵枢殿) */
  function finial(S, o) {
    var at = o.at || [0, 0], h = o.h;
    var a = S.p(at[0], at[1], h), b = S.p(at[0], at[1], h + 0.16);
    ink(S, [a, b], { w: 1.9, c: INK, a: 0.7, n: 1, fly: false, j: 0.3 });
    dots(S, b[0], b[1], 5, o.c || SPIRIT, S.U * 0.055, S.U * 0.05, 0.6);
    S.B.radial(b[0], b[1], S.U * 0.34, o.c || SPIRIT, 0.34);
  }
  /* 石栏 (台基前沿) */
  function rail(S, o) {
    var n = o.n || 8, i;
    var vv = (o.v == null ? 0.55 : o.v);
    for (i = 0; i <= n; i++) {
      var t = i / n, u = o.u0 + (o.u1 - o.u0) * t;
      ink(S, [S.p(u, vv, o.h), S.p(u, vv, o.h + 0.055)], { w: 0.95, c: INK4, a: 0.46, n: 1, fly: false, j: 0.3 });
    }
    ink(S, [S.p(o.u0, vv, o.h + 0.06), S.p(o.u1, vv, o.h + 0.06)], { w: 1.15, c: INK3, a: 0.48, n: 1, fly: false, j: 0.4 });
  }
  /* 长案 / 货担 */
  function table_(S, o) {
    var at = o.at, W = o.w / 2, h = o.h == null ? 0.2 : o.h;
    var q = [S.p(at[0] - W, at[1], h), S.p(at[0] + W, at[1], h),
             S.p(at[0] + W, at[1] + 0.07, h), S.p(at[0] - W, at[1] + 0.07, h)];
    faceOf(S, q, o.fill || EARTH, 0.62);
    ink(S, [q[0], q[1]], { w: 1.3, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
    ink(S, [[q[0][0], q[0][1]], [q[0][0], q[0][1] + h * S.U * 0.85]], { w: 1.1, c: INK2, a: 0.5, n: 1, fly: false, j: 0.3 });
    ink(S, [[q[1][0], q[1][1]], [q[1][0], q[1][1] + h * S.U * 0.85]], { w: 1.1, c: INK2, a: 0.5, n: 1, fly: false, j: 0.3 });
    if (o.goods) {
      dots(S, q[0][0] + (q[1][0] - q[0][0]) * 0.35, (q[0][1] + q[1][1]) / 2 - S.U * 0.04, 5,
        o.goods, S.U * 0.06, S.U * 0.13, 0.6);
      dots(S, q[0][0] + (q[1][0] - q[0][0]) * 0.7, (q[0][1] + q[1][1]) / 2 - S.U * 0.04, 4,
        o.goods2 || CINNABAR, S.U * 0.05, S.U * 0.11, 0.5);
    }
  }

  /* ============================================================
   * 8. 26 种建筑 (全部以「+v 为正面」作图 → 朝向自动成立)
   * ============================================================ */
  var KINDS = {};

  /* --- 宗城/礼制核心 --- */
  KINDS['官衙'] = function (S) {
    houseCore(S, { w: 1.12, d: 0.74, plat: 0.09, wall: 0.32, rise: 0.25, ridge: 'u',
      tiles: 9, postsN: 4, plaque: true, fill: '#d3c8b0', door: { c: '#5a2420', a: 0.8 },
      wins: [['left', 0.62, 0.55], ['right', 0.38, 0.55]] });
    /* 八字墙 */
    var i;
    for (i = 0; i < 2; i++) {
      var sgn = i === 0 ? -1 : 1;
      var q = [S.p(sgn * 0.68, 0.28, 0), S.p(sgn * 0.94, 0.44, 0), S.p(sgn * 0.94, 0.44, 0.16), S.p(sgn * 0.68, 0.28, 0.16)];
      faceOf(S, q, '#c9bda4', 0.9);
      ink(S, [q[3], q[2], q[1]], { w: 1.3, c: INK2, a: 0.52, n: 1, fly: false, j: 0.4 });
    }
    /* 石狮 */
    for (i = 0; i < 2; i++) {
      var uu = i === 0 ? -0.68 : 0.68;
      var a = S.p(uu, 0.62, 0.14), b = S.p(uu, 0.62, 0);
      ink(S, [a, b], { w: 1.4, c: INK2, a: 0.6, n: 1, fly: false, j: 0.3 });
      dots(S, a[0], a[1] - S.U * 0.03, 4, INK3, S.U * 0.05, S.U * 0.04, 0.6);
    }
    stairs(S, { at: [0, 0.39], w: 0.3, n: 3, topY: 0.09, botY: 0, out: 0.28 });
  };

  KINDS['集市'] = function (S) {
    shedOf(S, { at: [-0.42, -0.22], w: 0.5, d: 0.42, h0: 0, h1: 0.26, hi: 0.1 });
    shedOf(S, { at: [0.34, 0.14], w: 0.62, d: 0.48, h0: 0, h1: 0.36, hi: 0.13 });
    shedOf(S, { at: [-0.3, 0.42], w: 0.4, d: 0.36, h0: 0, h1: 0.22, hi: 0.09 });
    table_(S, { at: [-0.05, 0.42], w: 0.3, h: 0.18, goods: GAMBOGE });
    table_(S, { at: [0.52, 0.5], w: 0.2, h: 0.15, goods: EARTH, goods2: JADE });
    flag(S, { u: -0.78, v: 0.34, h1: 0.62, c: CINNABAR });
    flag(S, { u: 0.82, v: 0.02, h1: 0.5, c: '#3f5a6b', w: 0.28 });
  };

  KINDS['宗祠'] = function (S) {
    /* 主殿 (歇山) */
    houseCore(S, { at: [0, -0.06], w: 1.02, d: 0.62, plat: 0.1, wall: 0.32, rise: 0.26,
      hip: true, tiles: 8, ridge: 'u', fill: '#d6cdb8', door: { c: '#5b2a20' },
      wins: [['left', 0.6, 0.6], ['right', 0.4, 0.6]] });
    /* 门屋 */
    houseCore(S, { at: [0, 0.52], w: 0.62, d: 0.26, plat: 0.04, wall: 0.2, rise: 0.14,
      tiles: 6, eave: 0.09, fill: '#c9bda4', door: { c: '#5b2a20' }, cun: 0 });
    /* 牌坊 */
    var i;
    for (i = 0; i < 2; i++) {
      var uu = i === 0 ? -0.52 : 0.52;
      ink(S, [S.p(uu, 0.66, 0.62), S.p(uu, 0.66, 0)], { w: 2.1, c: INK, a: 0.72, n: 2, fly: false, j: 0.35 });
    }
    ink(S, [S.p(-0.6, 0.66, 0.58), S.p(0.6, 0.66, 0.58)], { w: 2.5, c: INK, a: 0.72, n: 2, fly: false, j: 0.45 });
    ink(S, [S.p(-0.52, 0.66, 0.66), S.p(0.52, 0.66, 0.66)], { w: 1.4, c: INK2, a: 0.6, n: 1, fly: false, j: 0.35 });
    faceOf(S, [S.p(-0.12, 0.66, 0.66), S.p(0.12, 0.66, 0.66), S.p(0.12, 0.66, 0.72), S.p(-0.12, 0.66, 0.72)], '#3a3128', 0.72);
    /* 香炉 */
    heap(S, { u: 0.0, v: 0.86, w: 0.1, d: 0.08, h: 0.2, fill: '#6b6250', c: INK2 });
    smoke(S, { u: 0, v: 0.86, h0: 0.2, h: 0.5, n: 3, a: 0.2 });
  };

  KINDS['祠堂'] = function (S) {
    houseCore(S, { at: [-0.05, 0], w: 0.94, d: 0.6, plat: 0.08, wall: 0.32, rise: 0.25,
      tiles: 8, postsN: 4, fill: '#d2c8b0', door: { c: '#5b2a20' },
      wins: [['left', 0.6, 0.58], ['right', 0.4, 0.58]] });
    /* 门楼矮墙 */
    var i;
    for (i = 0; i < 2; i++) {
      var sgn = i === 0 ? -1 : 1;
      var q = [S.p(sgn * 0.62, 0.42, 0), S.p(sgn * 1.02, 0.5, 0), S.p(sgn * 1.02, 0.5, 0.2), S.p(sgn * 0.62, 0.42, 0.2)];
      faceOf(S, q, '#c6bba2', 0.88);
      ink(S, [q[3], q[2], q[1]], { w: 1.4, c: INK2, a: 0.55, n: 1, fly: false, j: 0.45 });
    }
    tree(S, { u: 0.82, v: 0.42, h: 0.72 });
  };

  KINDS['村口'] = function (S) {
    /* 土墙缺口 (两侧) */
    var i;
    for (i = 0; i < 2; i++) {
      var sgn = i === 0 ? -1 : 1;
      var q = [S.p(sgn * 0.42, 0.3, 0), S.p(sgn * 1.12, 0.36, 0), S.p(sgn * 1.12, 0.36, 0.26), S.p(sgn * 0.42, 0.3, 0.26)];
      faceOf(S, q, '#c9bda2', 0.86);
      ink(S, [q[3], q[2], q[1]], { w: 1.45, c: INK2, a: 0.55, n: 2, fly: false, j: 0.45 });
      ink(S, [q[3], q[0]], { w: 1.1, c: INK3, a: 0.4, n: 1, fly: false, j: 0.4 });
    }
    /* 木牌坊 */
    for (i = 0; i < 2; i++) {
      var uu = i === 0 ? -0.24 : 0.24;
      ink(S, [S.p(uu, 0.52, 0.66), S.p(uu, 0.52, 0)], { w: 2.2, c: INK, a: 0.76, n: 2, fly: false, j: 0.35 });
    }
    ink(S, [S.p(-0.32, 0.52, 0.62), S.p(0.32, 0.52, 0.62)], { w: 2.4, c: INK, a: 0.76, n: 2, fly: false, j: 0.45 });
    ink(S, [S.p(-0.26, 0.52, 0.7), S.p(0.26, 0.52, 0.7)], { w: 1.35, c: INK2, a: 0.6, n: 1, fly: false, j: 0.35 });
    faceOf(S, [S.p(-0.11, 0.52, 0.7), S.p(0.11, 0.52, 0.7), S.p(0.11, 0.52, 0.76), S.p(-0.11, 0.52, 0.76)], '#3a3128', 0.72);
    /* 石敢当 */
    faceOf(S, [S.p(0.3, 0.72, 0), S.p(0.4, 0.72, 0), S.p(0.4, 0.72, 0.2), S.p(0.3, 0.72, 0.2)], '#8b8578', 0.86);
    tree(S, { u: 0.72, v: 0.5, h: 0.86 });
    tree(S, { u: -0.78, v: 0.22, h: 0.56 });
  };

  KINDS['宗门大殿'] = function (S) {
    aura(S, { u: 0, v: -0.1, h: 0.6, r: 1.5, a: 0.14 });
    /* 配殿 (左右) */
    var i;
    for (i = 0; i < 2; i++) {
      var sgn = i === 0 ? -1 : 1;
      var tc = i === 0 ? -1.0 : 1.0;
      houseCore(S, { at: [tc, -0.02], w: 0.44, d: 0.42, plat: 0.05, wall: 0.2, rise: 0.14,
        tiles: 5, eave: 0.08, fill: '#cdc3ac', door: { hw: 0.16 }, cun: 0 });
      void sgn;
    }
    /* 主殿 (重檐歇山) */
    houseCore(S, { at: [0, 0], w: 1.06, d: 0.62, plat: 0.11, wall: 0.32, rise: 0.28,
      hip: true, tiles: 10, postsN: 5, fill: '#d8cfba', plaque: true,
      door: { c: '#57261f', a: 0.82 }, wins: [['left', 0.62, 0.6], ['right', 0.38, 0.6]] });
    houseCore(S, { at: [0, 0], w: 0.72, d: 0.46, plat: 0.12 + 0.3 * 0.96, wall: 0.24, rise: 0.22,
      hip: true, tiles: 8, eave: 0.14, fill: '#d8cfba', door: false, cun: 0 });
    /* 广场幡 */
    flag(S, { u: -1.02, v: 0.5, h1: 0.72, c: CINNABAR });
    flag(S, { u: 1.02, v: 0.5, h1: 0.72, c: CINNABAR });
    flag(S, { u: -0.62, v: 0.86, h1: 0.54, c: '#3f5a6b', w: 0.28 });
    flag(S, { u: 0.62, v: 0.86, h1: 0.54, c: '#3f5a6b', w: 0.28 });
    stairs(S, { at: [0, 0.33], w: 0.34, n: 3, topY: 0.12, botY: 0, out: 0.3 });
  };

  KINDS['祖师殿'] = function (S) {
    /* 背后淡灵峰 (交代气场; 画在最底) */
    if (S.detail >= 2) {
      var i;
      for (i = 0; i < 2; i++) {
        var sgn = i === 0 ? -1 : 1;
        var a = S.p(sgn * 0.86, -0.5, 0), b = S.p(sgn * 0.5, -0.34, 0.95), c = S.p(sgn * 0.14, -0.5, 0);
        faceOf(S, [a, b, c], INK5, 0.5);
        ink(S, [a, b, c], { w: 1.1, c: INK4, a: 0.4, n: 1, fly: false, j: 0.5 });
      }
    }
    houseCore(S, { at: [0, 0], w: 1.04, d: 0.74, plat: 0.11, wall: 0.34, rise: 0.28,
      hip: true, tiles: 9, postsN: 5, fill: '#d5cbb4', door: { c: '#57261f' } });
    houseCore(S, { at: [0, -0.02], w: 0.56, d: 0.46, plat: 0.11 + 0.28 * 0.95, wall: 0.22, rise: 0.16,
      tiles: 6, eave: 0.1, fill: '#d5cbb4', door: false, cun: 0 });
    heap(S, { u: 0, v: 0.7, w: 0.11, d: 0.09, h: 0.22, fill: '#6b6250', c: INK2 });
    aura(S, { u: 0, v: 0.7, h: 0.24, r: 0.42, c: CINNABAR, a: 0.16 });
    smoke(S, { u: 0, v: 0.7, h0: 0.22, h: 0.6, n: 4, a: 0.2 });
    aura(S, { u: 0, v: -0.1, h: 0.7, r: 1.2, a: 0.13 });
  };

  /* --- 灵脉地皮 --- */
  KINDS['灵枢殿'] = function (S) {
    aura(S, { u: 0, v: -0.05, h: 0.7, r: 1.4, a: 0.24 });
    houseCore(S, { at: [0, 0], w: 0.86, d: 0.62, plat: 0.24, wall: 0.26, rise: 0.2,
      tiles: 8, cun: 7, fill: '#d9d0bd', door: { c: '#4a3a5c', a: 0.75 } });
    houseCore(S, { at: [0, 0], w: 0.52, d: 0.42, plat: 0.24 + 0.2 * 0.94, wall: 0.2, rise: 0.16,
      tiles: 6, eave: 0.11, fill: '#d9d0bd', door: false, cun: 0 });
    finial(S, { at: [0, 0], h: 0.24 + 0.2 * 0.94 + 0.2 + 0.16 + 0.06, c: SPIRIT });
    rail(S, { u0: -0.52, u1: 0.52, v: 0.72, h: 0.24, n: 7 });
    if (S.detail >= 3) {
      var i;
      for (i = 0; i < 14; i++) {
        var p = S.p((S.rand() - 0.5) * 1.5, (S.rand() - 0.5) * 1.0, 0.2 + S.rand() * 0.8);
        S.B.circle(p[0], p[1], S.U * 0.035, SPIRIT, 0.35 + S.rand() * 0.3);
      }
    }
  };

  KINDS['聚灵阵'] = function (S) {
    /* 全套唯一的俯视符阵: 与地图格面同一平面, 朝向决定阵轴 */
    aura(S, { u: 0, v: 0, h: 0.1, r: 1.1, a: 0.22 });
    gpHexRing(S, 0.82, { w: 1.5, c: SPIRIT, a: 0.5, n: 2, fly: false, j: 0.6 });
    gpHexRing(S, 0.55, { w: 1.3, c: SPIRIT, a: 0.42, n: 1, fly: false, j: 0.6 });
    gpHexRing(S, 0.28, { w: 1.2, c: SPIRIT, a: 0.5, n: 1, fly: false, j: 0.5 });
    var i;
    for (i = 0; i < 6; i++) {
      var an = (60 * i - 90) * Math.PI / 180;
      var cu = Math.cos(an) * 0.28, cv = Math.sin(an) * 0.28;
      var eu = Math.cos(an) * 0.82, ev = Math.sin(an) * 0.82;
      gpLine(S, [[cu, cv], [eu, ev]], { w: 0.85, c: SPIRIT, a: 0.3, n: 1, fly: false, j: 0.4 });
      /* 六角石桩 (立在阵环顶点) */
      var bn = [Math.cos(an) * 0.82, Math.sin(an) * 0.82];
      faceOf(S, [S.p(bn[0] - 0.07, bn[1], 0), S.p(bn[0] + 0.07, bn[1], 0),
                 S.p(bn[0] + 0.05, bn[1], 0.17), S.p(bn[0] - 0.05, bn[1], 0.17)], '#b7ae99', 0.92);
      ink(S, [S.p(bn[0] - 0.07, bn[1], 0), S.p(bn[0] - 0.05, bn[1], 0.17),
        S.p(bn[0] + 0.05, bn[1], 0.17), S.p(bn[0] + 0.07, bn[1], 0)], { w: 1.05, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
      dots(S, S.p(bn[0], bn[1], 0.19)[0], S.p(bn[0], bn[1], 0.19)[1], 4, SPIRIT, S.U * 0.04, S.U * 0.05, 0.6);
    }
    /* 中心灵柱 */
    faceOf(S, [S.p(-0.09, 0, 0), S.p(0.09, 0, 0), S.p(0.06, 0, 0.44), S.p(-0.06, 0, 0.44)], '#c9c0ab', 0.92);
    ink(S, [S.p(-0.09, 0, 0), S.p(-0.06, 0, 0.44), S.p(0.06, 0, 0.44), S.p(0.09, 0, 0)], { w: 1.4, c: INK2, a: 0.58, n: 2, fly: false, j: 0.45 });
    ink(S, [S.p(0, 0, 0.44), S.p(0, 0, 0.62)], { w: 1.9, c: SPIRIT, a: 0.6, n: 1, fly: false, j: 0.35 });
    S.B.radial(S.p(0, 0, 0.56)[0], S.p(0, 0, 0.56)[1], S.U * 0.5, SPIRIT, 0.34);
    dots(S, S.p(0, 0, 0.62)[0], S.p(0, 0, 0.62)[1], 10, SPIRIT, S.U * 0.045, S.U * 0.34, 0.55);
  };

  KINDS['祭坛'] = function (S) {
    aura(S, { u: 0, v: 0, h: 0.3, r: 1.0, a: 0.16 });
    slab(S, { at: [0, 0], w: 1.26, d: 1.14, h: 0.09, h0: 0, cun: 9, fill: '#c6bca6' });
    slab(S, { at: [0, 0], w: 0.92, d: 0.84, h: 0.1, h0: 0.09, cun: 8, fill: '#cec4ae' });
    slab(S, { at: [0, 0], w: 0.58, d: 0.54, h: 0.11, h0: 0.19, cun: 6, fill: '#d4cab4' });
    table_(S, { at: [0, 0.06], w: 0.2, h: 0.19, fill: '#9b8f76', goods: GAMBOGE });
    heap(S, { u: 0, v: 0.3, w: 0.055, d: 0.05, h: 0.15, fill: '#6b6250', c: INK2 });
    smoke(S, { u: 0, v: 0.3, h0: 0.3, h: 0.62, n: 4, a: 0.22 });
    aura(S, { u: 0, v: 0.3, h: 0.34, r: 0.36, c: CINNABAR, a: 0.14 });
    flag(S, { u: -0.62, v: 0.34, h0: 0.09, h1: 0.68, c: CINNABAR, w: 0.3 });
    flag(S, { u: 0.62, v: 0.34, h0: 0.09, h1: 0.68, c: CINNABAR, w: 0.3 });
  };

  /* --- 高阶灵地 --- */
  KINDS['炼丹殿'] = function (S) {
    houseCore(S, { at: [-0.16, 0.02], w: 0.78, d: 0.58, plat: 0.08, wall: 0.3, rise: 0.24,
      tiles: 7, postsN: 3, fill: '#d2c8b2', door: { c: '#4b3a2c' } });
    /* 三足丹炉 */
    var cu = 0.62, cv = 0.34;
    faceOf(S, [S.p(cu - 0.16, cv, 0), S.p(cu + 0.16, cv, 0), S.p(cu + 0.12, cv, 0.24), S.p(cu - 0.12, cv, 0.24)], '#8d8267', 0.92);
    faceOf(S, [S.p(cu - 0.2, cv, 0.24), S.p(cu + 0.2, cv, 0.24), S.p(cu + 0.15, cv, 0.32), S.p(cu - 0.15, cv, 0.32)], '#a1957a', 0.92);
    ink(S, [S.p(cu - 0.2, cv, 0.24), S.p(cu + 0.2, cv, 0.24)], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(cu - 0.16, cv, 0), S.p(cu - 0.12, cv, 0.24), S.p(cu - 0.15, cv, 0.32)], { w: 1.1, c: INK2, a: 0.5, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(cu + 0.16, cv, 0), S.p(cu + 0.12, cv, 0.24), S.p(cu + 0.15, cv, 0.32)], { w: 1.1, c: INK2, a: 0.5, n: 1, fly: false, j: 0.35 });
    S.B.radial(S.p(cu, cv, 0.12)[0], S.p(cu, cv, 0.12)[1], S.U * 0.3, CINNABAR, 0.2);
    smoke(S, { u: cu, v: cv, h0: 0.32, h: 0.72, n: 5, a: 0.26, c: INK4 });
  };

  KINDS['炼器殿'] = function (S) {
    houseCore(S, { at: [-0.3, 0], w: 0.7, d: 0.56, plat: 0.08, wall: 0.28, rise: 0.22,
      tiles: 7, postsN: 3, fill: '#cfc5ad', door: { c: '#43362a' } });
    /* 作坊棚 (半开) */
    shedOf(S, { at: [0.5, 0.06], w: 0.5, d: 0.46, h0: 0, h1: 0.24, hi: 0.11, fill: '#dbd3c0' });
    /* 炉 + 铁砧 */
    faceOf(S, [S.p(0.4, 0.42, 0), S.p(0.6, 0.42, 0), S.p(0.56, 0.42, 0.2), S.p(0.44, 0.42, 0.2)], '#7d7259', 0.92);
    ink(S, [S.p(0.4, 0.42, 0), S.p(0.44, 0.42, 0.2), S.p(0.56, 0.42, 0.2), S.p(0.6, 0.42, 0)], { w: 1.2, c: INK, a: 0.55, n: 1, fly: false, j: 0.4 });
    S.B.radial(S.p(0.5, 0.42, 0.22)[0], S.p(0.5, 0.42, 0.22)[1], S.U * 0.24, CINNABAR, 0.34);
    faceOf(S, [S.p(0.62, 0.7, 0), S.p(0.86, 0.7, 0), S.p(0.82, 0.7, 0.12), S.p(0.66, 0.7, 0.12)], '#6f6653', 0.9);
    dots(S, S.p(0.5, 0.5, 0.34)[0], S.p(0.5, 0.5, 0.34)[1], 10, CINNABAR, S.U * 0.035, S.U * 0.2, 0.66);
  };

  /* --- 水岸地皮 (朝向 = 水面 → 栈桥/船台/台阶自格心伸向水面) --- */
  KINDS['码头'] = function (S) {
    waterFan(S, { u: 0, v: 1.35, r: 1.5, hw: 1.3, n: 5, a: 0.28 });
    /* 岸 (背侧半格) */
    gpQuad(S, -0.78, -0.72, 0.78, 0.16, '#d6cbaa', 0.55);
    tree(S, { u: -0.6, v: -0.3, h: 0.66 });
    /* 栈桥: 自岸边 v=0.1 伸到 v=1.5 (入水) */
    var q = [S.p(-0.22, 0.1, 0.06), S.p(0.22, 0.1, 0.06), S.p(0.22, 1.5, 0.06), S.p(-0.22, 1.5, 0.06)];
    faceOf(S, q, '#c2b491', 0.95);
    ink(S, [q[0], q[1]], { w: 1.5, c: INK2, a: 0.55, n: 1, fly: false, j: 0.45 });
    ink(S, [q[3], q[2]], { w: 1.4, c: INK2, a: 0.55, n: 1, fly: false, j: 0.45 });
    ink(S, [q[0], q[3]], { w: 1.5, c: INK, a: 0.6, n: 2, fly: false, j: 0.4 });
    var i;
    for (i = 0; i < 7; i++) {
      var v = 0.2 + i * 0.2;
      ink(S, [S.p(-0.22, v, 0.06), S.p(-0.22, v, -0.1)], { w: 1.0, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.3 });
      ink(S, [S.p(0.22, v, 0.06), S.p(0.22, v, -0.1)], { w: 1.0, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.3 });
    }
    /* 系船柱 */
    for (i = 0; i < 3; i++) {
      var vv = 1.05 + i * 0.24;
      ink(S, [S.p(0.3, vv, 0.4), S.p(0.3, vv, 0.06)], { w: 1.6, c: EARTH, a: 0.72, n: 1, fly: false, j: 0.3 });
    }
    /* 缆 + 泊船 (斜靠栈桥) */
    ink(S, [S.p(0.3, 1.1, 0.36), S.p(0.62, 1.42, 0.1)], { w: 0.8, c: INK3, a: 0.4, n: 1, fly: false, j: 0.5 });
    faceOf(S, [S.p(0.5, 1.25, 0.02), S.p(1.02, 1.5, 0.02), S.p(0.86, 1.66, 0.02), S.p(0.42, 1.44, 0.02)], WOOD, 0.92);
    ink(S, [S.p(0.5, 1.25, 0.02), S.p(1.02, 1.5, 0.02), S.p(0.86, 1.66, 0.02), S.p(0.42, 1.44, 0.02), S.p(0.5, 1.25, 0.02)],
      { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(0.66, 1.4, 0.02), S.p(0.7, 1.4, 0.28)], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
    /* 远处小舟 */
    if (S.detail >= 2) {
      faceOf(S, [S.p(-0.9, 1.9, 0.02), S.p(-0.3, 2.0, 0.02), S.p(-0.36, 2.08, 0.02), S.p(-0.86, 2.0, 0.02)], '#b09a72', 0.82);
    }
  };

  KINDS['渔船坞'] = function (S) {
    waterFan(S, { u: 0, v: 1.5, r: 1.4, hw: 1.2, n: 3, a: 0.24 });
    gpQuad(S, -0.78, -0.78, 0.78, 0.3, '#d6cbaa', 0.5);
    /* 半开船棚: 单坡背高前低 + 四柱 (正面全开) */
    shedOf(S, { at: [0, -0.14], w: 1.1, d: 0.56, h1: 0, h0: 0, hi: 0.52, fill: '#dcd4c1', fa: 0.9 });
    /* 船架 + 倒扣船腹 (朝水的一侧) */
    faceOf(S, [S.p(-0.5, 0.62, 0.02), S.p(-0.34, 0.46, 0.14), S.p(0.0, 0.4, 0.2),
               S.p(0.34, 0.46, 0.14), S.p(0.5, 0.62, 0.02)], WOOD, 0.94);
    ink(S, [S.p(-0.5, 0.62, 0.02), S.p(-0.34, 0.46, 0.14), S.p(0.0, 0.4, 0.2),
      S.p(0.34, 0.46, 0.14), S.p(0.5, 0.62, 0.02)], { w: 1.55, c: INK, a: 0.62, n: 2, fly: false, j: 0.45 });
    ink(S, [S.p(-0.26, 0.52, 0.11), S.p(0.26, 0.52, 0.11)], { w: 0.9, c: INK3, a: 0.35, n: 1, fly: false, j: 0.45 });
    /* 斜靠的桨 */
    ink(S, [S.p(0.6, 0.86, 0), S.p(0.86, 0.42, 0.3)], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.35 });
  };

  KINDS['渔亭'] = function (S) {
    waterFan(S, { u: 0, v: 1.3, r: 1.4, hw: 1.2, n: 3, a: 0.24 });
    /* 礁石 */
    heap(S, { u: -0.62, v: 0.5, w: 0.28, d: 0.2, h: 0.24, fill: '#a9a292', c: INK3, dotC: INK3 });
    heap(S, { u: 0.66, v: 0.72, w: 0.22, d: 0.16, h: 0.18, fill: '#b0a998', c: INK3 });
    /* 四柱 + 攒尖顶 */
    posts(S, { at: [0, -0.06], w: 0.66, d: 0.5, h0: 0, h1: 0.4, n: 4, w2: 1.8, a: 0.66 });
    roofPyr(S, { at: [0, -0.06], w: 0.66, d: 0.5, h0: 0.4, rise: 0.34, eave: 0.18, tiles: 7, fill: '#d8d0bd' });
    ink(S, [S.p(-0.33, 0.19, 0.4), S.p(0.33, 0.19, 0.4)], { w: 1.1, c: INK3, a: 0.42, n: 1, fly: false, j: 0.4 });
    /* 挂网 */
    ink(S, [S.p(0.36, 0.1, 0.38), S.p(0.6, 0.62, 0.02)], { w: 0.9, c: INK4, a: 0.45, n: 1, fly: false, j: 0.5 });
    if (S.detail >= 3) {
      var i;
      for (i = 0; i < 5; i++) {
        ink(S, [S.p(0.36 + i * 0.05, 0.1 + i * 0.1, 0.38 - i * 0.07), S.p(0.6 - i * 0.01, 0.3 + i * 0.06, 0.2 - i * 0.04)],
          { w: 0.55, c: INK4, a: 0.28, n: 1, fly: false, j: 0.3 });
      }
    }
  };

  /* --- 压水 (2026-09-14 新增) ---
   * 水面上的建筑不再画房子, 改画「栈桥」: 水面即被桥面覆盖。
   * 本 kind 只由前端按「格是水」派生 (main.js drawBuildings), 不在 mapgen 的
   * BUILDINGS/CORE_KIND 里 ⇒ 不进 KIND_LIST, 与「26 种 = 服务端全集」的对齐不被打破。
   * 朝向沿用建筑朝向 (朝水面), 桥面即沿该方向横跨本格。 */
  KINDS['栈桥'] = function (S) {
    waterFan(S, { u: 0, v: 0.95, r: 1.35, hw: 1.15, n: 4, a: 0.26 });
    /* 桥面 (地面系, 跨满本格) */
    gpQuad(S, -0.30, -0.98, 0.30, 0.98, '#c6b794', 0.95);
    gpWash(S, 0, 0, 0.62, WOOD, 0.10);
    /* 桥板横纹 */
    var i, n = S.detail >= 3 ? 9 : 5;
    for (i = 0; i < n; i++) {
      var pv = -0.90 + (i / (n - 1)) * 1.80;
      ink(S, [S.p(-0.30, pv, 0.05), S.p(0.30, pv, 0.05)],
        { w: 0.85, c: EARTH, a: 0.40, n: 1, fly: false, j: 0.3 });
    }
    /* 两侧栏杆: 立柱 + 压顶横木 */
    var sgn, k;
    for (sgn = -1; sgn <= 1; sgn += 2) {
      for (k = 0; k < 4; k++) {
        var pv2 = -0.72 + k * 0.48;
        ink(S, [S.p(sgn * 0.32, pv2, 0.05), S.p(sgn * 0.32, pv2, 0.34)],
          { w: 1.35, c: EARTH, a: 0.62, n: 1, fly: false, j: 0.3 });
      }
      ink(S, [S.p(sgn * 0.32, -0.78, 0.34), S.p(sgn * 0.32, 0.78, 0.34)],
        { w: 1.5, c: INK2, a: 0.52, n: 1, fly: false, j: 0.45 });
      /* 桥面边梁 */
      ink(S, [S.p(sgn * 0.30, -0.98, 0.03), S.p(sgn * 0.30, 0.98, 0.03)],
        { w: 1.6, c: INK, a: 0.60, n: 2, fly: false, j: 0.4 });
    }
    /* 桥墩: 两端入水的木桩 (只画两根, 免得密排连线) */
    ink(S, [S.p(-0.24, 0.86, 0.04), S.p(-0.24, 0.86, -0.26)], { w: 1.7, c: EARTH, a: 0.70, n: 1, fly: false, j: 0.3 });
    ink(S, [S.p(0.24, 0.86, 0.04), S.p(0.24, 0.86, -0.26)], { w: 1.7, c: EARTH, a: 0.70, n: 1, fly: false, j: 0.3 });
    /* 桥下水纹 */
    if (S.detail >= 2) {
      ink(S, [S.p(-0.88, 0.42, 0), S.p(-0.52, 0.30, 0)], { w: 0.8, c: AZURE, a: 0.32, n: 1, fly: false, j: 0.5 });
      ink(S, [S.p(0.54, -0.34, 0), S.p(0.92, -0.24, 0)], { w: 0.8, c: AZURE, a: 0.32, n: 1, fly: false, j: 0.5 });
    }
  };

  /* --- 良田 --- */
  KINDS['农田'] = function (S) {
    /* 俯视田块: 长边沿朝向 → 4 垄 + 田埂 + 水光 + 禾苗 */
    gpQuad(S, -0.8, -0.62, 0.8, 0.62, '#cbd6a6', 0.6);
    gpWash(S, 0, 0, 0.7, AZURE, 0.13);
    var i, j;
    for (i = 1; i < 4; i++) {
      var u = -0.8 + 1.6 * i / 4;
      gpLine(S, [[u, -0.62], [u, 0.62]], { w: 1.5, c: EARTH, a: 0.5, n: 1, fly: false, j: 0.5 });
    }
    if (S.detail >= 2) {
      for (i = 0; i < 4; i++) {
        for (j = 0; j < 5; j++) {
          var uu = -0.8 + 1.6 * (i + 0.5) / 4 + (S.rand() - 0.5) * 0.1;
          var vv = -0.62 + 1.24 * (j + 0.5) / 5;
          var p = gpOf(S, uu, vv);
          ink(S, [[p[0], p[1] + S.U * 0.06], [p[0] + (S.rand() - 0.5) * S.U * 0.1, p[1] - S.U * (0.06 + S.rand() * 0.07)]],
            { w: 1.0, c: JADE, a: 0.4 + S.rand() * 0.22, n: 1, fly: false, j: 0.4 });
        }
      }
    }
    gpLine(S, [[-0.8, -0.62], [0.8, -0.62], [0.8, 0.62], [-0.8, 0.62], [-0.8, -0.62]],
      { w: 1.8, c: INK3, a: 0.5, n: 2, fly: false, j: 0.7 });
    if (S.detail >= 3) dots(S, gpOf(S, 0.3, 0.1)[0], gpOf(S, 0.3, 0.1)[1], 7, GAMBOGE, S.U * 0.03, S.U * 0.5, 0.3);
  };

  KINDS['磨坊'] = function (S) {
    /* ⚠ 磨坊的地皮是「良田」—— 绝大多数并不临水。水车/引水槽/水花只在
       S.water (地类探针确认环内确有水面) 时成立; 否则改画旱碾,
       免得在纯陆地块上竖一架「无源水车」。(2026-09-13 对拍发现) */
    var wet = !!S.water;
    if (wet) waterFan(S, { u: 0, v: 1.15, r: 1.3, hw: 1.1, n: 4, a: 0.26 });
    houseCore(S, { at: [-0.3, -0.06], w: 0.66, d: 0.54, plat: 0.06, wall: 0.26, rise: 0.2,
      tiles: 6, fill: '#cbbfa2', door: { c: '#4b3a2c' }, wins: [['left', 0.7, 0.5, 0.06, 0.055]] });
    var i;
    if (wet) {
    /* 立式水车: 轮面在 (u,h) 竖直平面 → 正圆投影 */
    var cu = 0.56, cv = 0.3, r = 0.42;
    for (i = 0; i < 24; i++) {
      var a = i / 24 * Math.PI * 2;
      var b = (i + 1) / 24 * Math.PI * 2;
      S.B.line([S.p(cu + Math.cos(a) * r, cv, r + Math.sin(a) * r),
                S.p(cu + Math.cos(b) * r, cv, r + Math.sin(b) * r)], { w: 1.6, c: INK2, a: 0.6 });
    }
    for (i = 0; i < 16; i++) {
      var an = i / 16 * Math.PI * 2;
      S.B.line([S.p(cu + Math.cos(an) * r * 0.68, cv, r + Math.sin(an) * r * 0.68),
                S.p(cu + Math.cos(an) * r * 0.94, cv, r + Math.sin(an) * r * 0.94)], { w: 1.4, c: EARTH, a: 0.55 });
    }
    for (i = 0; i < 8; i++) {
      var a2 = i / 8 * Math.PI * 2;
      ink(S, [S.p(cu, cv, r), S.p(cu + Math.cos(a2) * r * 0.68, cv, r + Math.sin(a2) * r * 0.68)],
        { w: 0.95, c: INK3, a: 0.45, n: 1, fly: false, j: 0.4 });
    }
    dots(S, S.p(cu, cv, r)[0], S.p(cu, cv, r)[1], 4, INK2, S.U * 0.045, S.U * 0.05, 0.6);
    /* 轮架 */
    ink(S, [S.p(cu, cv, 0), S.p(cu, cv, r)], { w: 1.3, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.35 });
    /* 引水槽 (自水车向屋) */
    faceOf(S, [S.p(-0.02, 0.16, 0.36), S.p(cu, cv, 0.44), S.p(cu, cv, 0.5), S.p(-0.02, 0.16, 0.42)], '#c2b491', 0.85);
    ink(S, [S.p(-0.02, 0.16, 0.42), S.p(cu, cv, 0.5)], { w: 1.1, c: INK2, a: 0.45, n: 1, fly: false, j: 0.35 });
    /* 水花 */
    S.B.radial(S.p(cu, cv + 0.16, 0.04)[0], S.p(cu, cv + 0.16, 0.04)[1], S.U * 0.36, AZURE, 0.3);
    if (S.detail >= 3) dots(S, S.p(cu, cv + 0.2, 0.06)[0], S.p(cu, cv + 0.2, 0.06)[1], 8, '#dfeaea', S.U * 0.03, S.U * 0.18, 0.5);
    } else {
      /* 旱碾: 碾盘 (地面平面构件, 随朝向一起转) + 中轴 + 碾杆 + 谷袋 */
      var mu = 0.52, mv = 0.34, mr = 0.40;
      gpWash(S, mu, mv, mr * 1.3, STONE, 0.24);
      var ring = [];
      for (i = 0; i < 15; i++) {
        var aa = i / 15 * Math.PI * 2;
        ring.push([mu + Math.cos(aa) * mr, mv + Math.sin(aa) * mr]);
      }
      ring.push(ring[0]);
      gpLine(S, ring, { w: 1.5, c: INK2, a: 0.68 });
      ink(S, [S.p(mu, mv, 0), S.p(mu, mv, 0.30)], { w: 1.6, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
      ink(S, [S.p(mu, mv, 0.30), S.p(mu + 0.36, mv + 0.10, 0.24)],
        { w: 1.4, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.3 });
      if (S.detail >= 2) {
        heap(S, { u: 0.88, v: 0.54, w: 0.16, d: 0.14, h: 0.15, fill: THATCH });
        heap(S, { u: 0.76, v: 0.74, w: 0.13, d: 0.12, h: 0.12, fill: THATCH });
      }
    }
    smoke(S, { u: -0.34, v: -0.28, h0: 0.36, h: 0.5, n: 3, a: 0.16 });
  };

  KINDS['谷仓'] = function (S) {
    /* 干栏高脚仓 */
    stiltPosts(S, { u0: -0.36, u1: 0.36, v0: -0.24, v1: 0.24, h0: 0, h1: 0.24, n: 4 });
    var box = boxWalls(S, { at: [0, 0], w: 0.76, d: 0.52, h0: 0.24, h1: 0.6, fill: '#cfc3a4', peel: 3 });
    void box;
    roofCone(S, { at: [0, 0], w: 0.88, d: 0.66, h0: 0.6, rise: 0.54, fill: THATCH });
    ink(S, [S.p(-0.38, 0.26, 0.44), S.p(0.38, 0.26, 0.44)], { w: 1.0, c: INK3, a: 0.38, n: 1, fly: false, j: 0.45 });
    /* 梯 */
    ink(S, [S.p(0.42, 0.2, 0.24), S.p(0.72, 0.5, 0)], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
    ink(S, [S.p(0.34, 0.28, 0.26), S.p(0.64, 0.58, 0.02)], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
    var i;
    for (i = 1; i < 3; i++) {
      S.B.line([S.p(0.42 + i * 0.1, 0.2 + i * 0.1, 0.24 - i * 0.08), S.p(0.34 + i * 0.1, 0.28 + i * 0.1, 0.26 - i * 0.08)],
        { w: 0.8, c: EARTH, a: 0.45 });
    }
    /* 粮囤 (圆锥顶矮仓) */
    heap(S, { u: -0.66, v: 0.44, w: 0.24, d: 0.2, h: 0.28, fill: '#c9b47f', c: INK2 });
    faceOf(S, [S.p(-0.9, 0.34, 0), S.p(-0.42, 0.34, 0), S.p(-0.42, 0.54, 0), S.p(-0.9, 0.54, 0)], '#c9b47f', 0.62);
    dots(S, gpOf(S, -0.66, 0.44)[0], gpOf(S, -0.66, 0.44)[1] - S.U * 0.06, 4, GAMBOGE, S.U * 0.045, S.U * 0.16, 0.5);
  };

  /* --- 矿脉 --- */
  KINDS['矿山'] = function (S) {
    /* 山体断面 (背面) */
    faceOf(S, [S.p(-0.95, -0.2, 0), S.p(-0.6, -0.06, 0.34), S.p(-0.16, 0.04, 0.86),
               S.p(0.3, 0.0, 0.56), S.p(0.66, -0.08, 0.8), S.p(0.95, -0.2, 0)],
      '#b8b0a0', 0.95);
    var i;
    if (S.detail >= 2) {
      for (i = 0; i < 12; i++) {
        var u = -0.7 + S.rand() * 1.5, h = 0.1 + S.rand() * 0.6;
        var a = S.p(u, -0.1, h), b = S.p(u - 0.14 - S.rand() * 0.1, -0.1, h - 0.14 - S.rand() * 0.1);
        ink(S, [a, b], { w: 0.95, c: INK3, a: 0.18 + S.rand() * 0.16, n: 1, fly: false, j: 0.6 });
      }
    }
    ink(S, [S.p(-0.95, -0.2, 0), S.p(-0.6, -0.06, 0.34), S.p(-0.16, 0.04, 0.86),
      S.p(0.3, 0.0, 0.56), S.p(0.66, -0.08, 0.8), S.p(0.95, -0.2, 0)], { w: 1.7, c: INK, a: 0.55, n: 2, fly: false, j: 0.7 });
    /* 矿洞口 (朝前) */
    var dq = [S.p(-0.3, 0.34, 0), S.p(0.3, 0.34, 0), S.p(0.3, 0.34, 0.28), S.p(-0.3, 0.34, 0.28)];
    faceOf(S, [dq[0], dq[1], dq[2], dq[3]], INK, 0.8);
    ink(S, [dq[0], dq[3], dq[2]], { w: 1.6, c: INK, a: 0.7, n: 2, fly: false, j: 0.45 });
    /* 支撑木架 */
    ink(S, [S.p(-0.3, 0.34, 0.3), S.p(0.3, 0.34, 0.3)], { w: 2.0, c: EARTH, a: 0.72, n: 1, fly: false, j: 0.4 });
    ink(S, [S.p(-0.3, 0.34, 0.36), S.p(0.3, 0.34, 0.36)], { w: 1.5, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.4 });
    ink(S, [S.p(-0.36, 0.34, 0.34), S.p(-0.36, 0.34, 0)], { w: 1.8, c: EARTH, a: 0.7, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(0.36, 0.34, 0.34), S.p(0.36, 0.34, 0)], { w: 1.8, c: EARTH, a: 0.7, n: 1, fly: false, j: 0.35 });
    /* 矿渣 + 镐 */
    heap(S, { u: 0.6, v: 0.52, w: 0.3, d: 0.24, h: 0.22, fill: '#a79e8c', c: INK3, dotC: INK2 });
    ink(S, [S.p(-0.66, 0.56, 0), S.p(-0.44, 0.38, 0.3)], { w: 1.35, c: EARTH, a: 0.62, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(-0.52, 0.34, 0.34), S.p(-0.34, 0.44, 0.28)], { w: 1.35, c: INK2, a: 0.6, n: 1, fly: false, j: 0.3 });
    if (S.detail >= 3) dots(S, gpOf(S, 0.1, 0.5)[0], gpOf(S, 0.1, 0.5)[1], 4, GAMBOGE, S.U * 0.035, S.U * 0.2, 0.45);
  };

  KINDS['熔炉'] = function (S) {
    /* 高炉 (上收) */
    var bowl = [S.p(-0.34, 0.2, 0), S.p(0.34, 0.2, 0), S.p(0.24, 0.2, 0.56), S.p(-0.24, 0.2, 0.56)];
    faceOf(S, bowl, '#a99b83', 0.95);
    ink(S, [bowl[0], bowl[3], bowl[2], bowl[1]], { w: 1.6, c: INK, a: 0.6, n: 2, fly: false, j: 0.55 });
    /* 炉口火光 */
    faceOf(S, [S.p(-0.14, 0.2, 0), S.p(0.14, 0.2, 0), S.p(0.1, 0.2, 0.24), S.p(-0.1, 0.2, 0.24)], '#6b3a22', 0.9);
    S.B.radial(S.p(0, 0.2, 0.14)[0], S.p(0, 0.2, 0.14)[1], S.U * 0.36, CINNABAR, 0.5);
    if (S.detail >= 3) dots(S, S.p(0, 0.2, 0.14)[0], S.p(0, 0.2, 0.14)[1], 12, '#e08040', S.U * 0.032, S.U * 0.16, 0.6);
    /* 烟囱 */
    faceOf(S, [S.p(0.34, 0.04, 0), S.p(0.54, 0.04, 0), S.p(0.52, 0.04, 0.74), S.p(0.38, 0.04, 0.74)], '#9d9078', 0.95);
    ink(S, [S.p(0.38, 0.04, 0.74), S.p(0.52, 0.04, 0.74), S.p(0.54, 0.04, 0), S.p(0.34, 0.04, 0)], { w: 1.3, c: INK2, a: 0.55, n: 2, fly: false, j: 0.45 });
    ink(S, [S.p(0.34, 0.04, 0.76), S.p(0.54, 0.04, 0.76)], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.35 });
    smoke(S, { u: 0.45, v: 0.04, h0: 0.78, h: 0.66, n: 5, a: 0.28, c: INK4 });
    /* 炉渣 */
    heap(S, { u: -0.6, v: 0.4, w: 0.28, d: 0.2, h: 0.2, fill: '#8f8778', c: INK3 });
  };

  /* --- 林地 --- */
  KINDS['伐木场'] = function (S) {
    shedOf(S, { at: [-0.16, -0.26], w: 0.86, d: 0.5, h0: 0, h1: 0.22, hi: 0.12, fill: '#dcd4c1' });
    /* 原木堆 (圆柱截面) */
    var i, j;
    var rows = [[-0.34, 0.26], [-0.02, 0.26], [0.3, 0.26], [-0.18, 0.46], [0.14, 0.46]];
    for (i = 0; i < rows.length; i++) {
      var cu = rows[i][0], cv = rows[i][1], r = 0.13;
      var c = S.p(cu, cv, r);
      S.B.circle(c[0], c[1], r * S.U, '#c0a780', 0.95);
      S.B.circle(c[0], c[1], r * S.U * 0.48, EARTH, 0.4);
      if (S.detail >= 3) {
        for (j = 0; j < 5; j++) {
          var a = j / 5 * Math.PI * 2;
          S.B.line([[c[0] + Math.cos(a) * r * S.U * 0.1, c[1] + Math.sin(a) * r * S.U * 0.1],
                    [c[0] + Math.cos(a) * r * S.U * 0.5, c[1] + Math.sin(a) * r * S.U * 0.5]],
            { w: 0.55, c: EARTH, a: 0.35 });
        }
      }
    }
    /* 锯木架 */
    ink(S, [S.p(0.5, 0.62, 0), S.p(0.7, 0.44, 0.26)], { w: 1.5, c: EARTH, a: 0.65, n: 1, fly: false, j: 0.35 });
    ink(S, [S.p(0.92, 0.62, 0), S.p(0.74, 0.44, 0.26)], { w: 1.5, c: EARTH, a: 0.65, n: 1, fly: false, j: 0.35 });
    faceOf(S, [S.p(0.62, 0.44, 0.26), S.p(0.82, 0.44, 0.26), S.p(0.82, 0.44, 0.34), S.p(0.62, 0.44, 0.34)], '#c0a780', 0.9);
    ink(S, [S.p(0.62, 0.44, 0.35), S.p(0.82, 0.44, 0.35)], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.35 });
    /* 斧 */
    ink(S, [S.p(-0.78, 0.62, 0), S.p(-0.68, 0.5, 0.24)], { w: 1.25, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
    faceOf(S, [S.p(-0.7, 0.5, 0.26), S.p(-0.6, 0.5, 0.34), S.p(-0.6, 0.5, 0.24), S.p(-0.7, 0.5, 0.22)], '#8b8578', 0.9);
  };

  KINDS['药圃'] = function (S) {
    var row, i;
    for (row = 0; row < 3; row++) {
      var v = -0.34 + row * 0.36;
      var hw = 0.46 + row * 0.14;
      gpLine(S, [[-hw, v], [hw, v]], { w: 1.3, c: INK3, a: 0.4, n: 1, fly: false, j: 0.5 });
      for (i = 0; i < 6; i++) {
        var u = -hw + 2 * hw * (i + 0.5) / 6;
        var p = gpOf(S, u, v);
        dots(S, p[0], p[1] - S.U * 0.03, 5, JADE, S.U * 0.05, S.U * 0.07, 0.5);
        if (S.detail >= 3) dots(S, p[0] + S.U * 0.03, p[1] - S.U * 0.07, 3, '#7d9463', S.U * 0.04, S.U * 0.05, 0.42);
      }
    }
    /* 竹篱 (正面) */
    fence(S, { u0: -0.8, u1: 0.8, v0: 0.62, v1: 0.62, n: 8, h: 0.24 });
    /* 一株药草特写 */
    var p2 = gpOf(S, -0.66, 0.2);
    ink(S, [[p2[0], p2[1]], [p2[0] - S.U * 0.03, p2[1] - S.U * 0.24]], { w: 1.2, c: JADE, a: 0.6, n: 1, fly: false, j: 0.35 });
    dots(S, p2[0] - S.U * 0.04, p2[1] - S.U * 0.3, 7, '#7d9463', S.U * 0.055, S.U * 0.1, 0.55);
    dots(S, p2[0] - S.U * 0.04, p2[1] - S.U * 0.3, 2, CINNABAR, S.U * 0.04, S.U * 0.07, 0.7);
  };

  /* --- 灼壤 --- */
  KINDS['炼炉'] = function (S) {
    S.B.radial(gpOf(S, 0, 0.2)[0], gpOf(S, 0, 0.2)[1], S.U * 1.3, '#c07a44', 0.14);
    /* 圆穹砖窑 (半圆拱顶) */
    var i, pts = [], n = S.detail >= 3 ? 12 : 7;
    for (i = 0; i <= n; i++) {
      var t = i / n, uu = -0.54 + 1.08 * t;
      var hh = 0.62 * Math.sqrt(Math.max(0, 1 - Math.pow((uu) / 0.56, 2)));
      pts.push(S.p(uu, 0.14, hh));
    }
    faceOf(S, pts.concat([S.p(0.54, 0.14, 0), S.p(-0.54, 0.14, 0)]), '#b3a288', 0.95);
    if (S.detail >= 2) {
      for (i = 1; i <= 3; i++) {
        var tt = i / 4, hh2 = 0.62 * tt;
        var wq = 0.56 * Math.sqrt(Math.max(0.05, 1 - tt * tt));
        ink(S, [S.p(-wq, 0.14, hh2), S.p(0, 0.14, hh2 + 0.03), S.p(wq, 0.14, hh2)],
          { w: 0.85, c: INK4, a: 0.3, n: 1, fly: false, j: 0.5 });
      }
    }
    ink(S, pts, { w: 1.6, c: INK, a: 0.58, n: 2, fly: false, j: 0.6 });
    /* 炉口 (大火) */
    faceOf(S, [S.p(-0.2, 0.34, 0), S.p(0.2, 0.34, 0), S.p(0.16, 0.34, 0.26), S.p(-0.16, 0.34, 0.26)], '#5e2c18', 0.92);
    S.B.radial(S.p(0, 0.34, 0.16)[0], S.p(0, 0.34, 0.16)[1], S.U * 0.42, CINNABAR, 0.52);
    if (S.detail >= 3) dots(S, S.p(0, 0.34, 0.16)[0], S.p(0, 0.34, 0.16)[1], 14, '#e08a48', S.U * 0.035, S.U * 0.18, 0.6);
    ink(S, [S.p(-0.2, 0.34, 0), S.p(-0.16, 0.34, 0.26), S.p(0.16, 0.34, 0.26), S.p(0.2, 0.34, 0)], { w: 1.4, c: INK, a: 0.6, n: 2, fly: false, j: 0.45 });
    smoke(S, { u: 0, v: 0.14, h0: 0.7, h: 0.7, n: 5, a: 0.26, c: INK4 });
    /* 炭堆 + 铁钳 */
    heap(S, { u: 0.66, v: 0.46, w: 0.28, d: 0.22, h: 0.24, fill: '#7d7261', c: INK3, dotC: INK });
    ink(S, [S.p(-0.66, 0.56, 0), S.p(-0.44, 0.4, 0.26)], { w: 1.25, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  };

  KINDS['焦炭窑'] = function (S) {
    /* 低矮土馒头 (顶点明显低于炼炉, 无拱线) */
    var i, pts = [], n = S.detail >= 3 ? 12 : 7;
    for (i = 0; i <= n; i++) {
      var t = i / n, uu = -0.58 + 1.16 * t;
      var hh = 0.34 * Math.sqrt(Math.max(0, 1 - Math.pow(uu / 0.6, 2)));
      pts.push(S.p(uu, 0.1, hh));
    }
    faceOf(S, pts.concat([S.p(0.58, 0.1, 0), S.p(-0.58, 0.1, 0)]), '#b0996f', 0.95);
    if (S.detail >= 2) {
      for (i = 0; i < 5; i++) {
        var tt = (i + 1) / 6, hh2 = 0.34 * tt;
        var wq = 0.6 * Math.sqrt(Math.max(0.08, 1 - tt * tt));
        ink(S, [S.p(-wq * 0.86, 0.1, hh2), S.p(0, 0.1, hh2 + 0.02), S.p(wq * 0.86, 0.1, hh2)],
          { w: 0.95, c: INK3, a: 0.16 + S.rand() * 0.12, n: 1, fly: false, j: 0.55 });
      }
    }
    ink(S, pts, { w: 1.5, c: INK, a: 0.52, n: 2, fly: false, j: 0.6 });
    /* 闷烟 (只冒烟不见火) */
    smoke(S, { u: -0.06, v: 0.1, h0: 0.36, h: 0.74, n: 6, a: 0.28, c: INK4 });
    smoke(S, { u: 0.14, v: 0.1, h0: 0.34, h: 0.44, n: 3, a: 0.2, c: INK4 });
    /* 窑门 (闷口) */
    faceOf(S, [S.p(-0.16, 0.3, 0), S.p(0.16, 0.3, 0), S.p(0.13, 0.3, 0.18), S.p(-0.13, 0.3, 0.18)], '#5b4b38', 0.85);
    /* 柴堆 */
    for (i = 0; i < 7; i++) {
      var uu2 = -0.86 + i * 0.06;
      ink(S, [S.p(uu2, 0.54 + i * 0.012, 0), S.p(uu2 + 0.24, 0.4 + i * 0.012, 0.1)], { w: 1.8, c: '#8a6a46', a: 0.6, n: 1, fly: false, j: 0.4 });
    }
  };

  /* --- 村落 --- */
  KINDS['民房'] = function (S) {
    /* 前屋 (略大) + 后屋错落 */
    houseCore(S, { at: [-0.2, 0.14], w: 0.62, d: 0.46, plat: 0.05, wall: 0.26, rise: 0.2,
      tiles: 6, cun: 4, fill: '#d2c6a6', door: { c: '#4b3a2c' }, wins: [['left', 0.72, 0.5, 0.06, 0.055]] });
    houseCore(S, { at: [0.5, -0.26], w: 0.5, d: 0.4, plat: 0.05, wall: 0.22, rise: 0.17,
      tiles: 5, eave: 0.1, cun: 3, fill: '#cdc0a0', door: { c: '#4b3a2c' } });
    /* 茅草散锋 (檐口) */
    if (S.detail >= 3) {
      var i;
      for (i = 0; i < 9; i++) {
        var p = S.p(-0.5 + S.rand() * 0.6, 0.37, 0.3 + S.rand() * 0.04);
        ink(S, [p, [p[0] + (S.rand() - 0.5) * S.U * 0.1, p[1] + S.U * (0.05 + S.rand() * 0.06)]],
          { w: 0.95, c: INK3, a: 0.32, n: 1, fly: false, j: 0.5 });
      }
    }
    fence(S, { u0: -0.82, u1: -0.36, v0: 0.52, v1: 0.52, n: 4, h: 0.22 });
    /* 晒竿 + 布 */
    ink(S, [S.p(0.16, 0.62, 0), S.p(0.16, 0.62, 0.42)], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
    ink(S, [S.p(0.16, 0.62, 0.38), S.p(0.6, 0.66, 0.36)], { w: 1.2, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.3 });
    faceOf(S, [S.p(0.26, 0.64, 0.36), S.p(0.44, 0.66, 0.35), S.p(0.44, 0.66, 0.14), S.p(0.26, 0.64, 0.15)], '#9aa9b0', 0.6);
    smoke(S, { u: 0.42, v: -0.4, h0: 0.34, h: 0.52, n: 3, a: 0.16 });
  };

  KINDS['仓库'] = function (S) {
    houseCore(S, { at: [0, -0.04], w: 1.22, d: 0.58, plat: 0.07, wall: 0.28, rise: 0.22,
      tiles: 9, postsN: 5, fill: '#cfc4a8', door: { c: '#7a6042', a: 0.9, hw: 0.13, h: 0.2 } });
    /* 门闩 */
    ink(S, [S.p(-0.14, 0.27, 0.13), S.p(0.14, 0.27, 0.13)], { w: 1.5, c: INK2, a: 0.6, n: 1, fly: false, j: 0.35 });
    /* 粮囤 (两侧) */
    var i;
    for (i = 0; i < 2; i++) {
      var uu = i === 0 ? -0.72 : 0.72;
      heap(S, { u: uu, v: 0.42, w: 0.2, d: 0.17, h: 0.26, fill: '#c9b47f', c: INK2 });
      dots(S, gpOf(S, uu, 0.42)[0], gpOf(S, uu, 0.42)[1] - S.U * 0.05, 4, GAMBOGE, S.U * 0.04, S.U * 0.13, 0.5);
    }
    /* 板车 */
    faceOf(S, [S.p(-0.2, 0.66, 0.1), S.p(0.1, 0.66, 0.1), S.p(0.1, 0.66, 0.18), S.p(-0.2, 0.66, 0.18)], WOOD, 0.8);
    ink(S, [S.p(-0.2, 0.66, 0.18), S.p(0.1, 0.66, 0.18)], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.35 });
    S.B.circle(S.p(-0.13, 0.66, 0)[0], S.p(-0.13, 0.66, 0)[1], S.U * 0.045, INK2, 0.7);
    S.B.circle(S.p(0.03, 0.66, 0)[0], S.p(0.03, 0.66, 0)[1], S.U * 0.045, INK2, 0.7);
  };

  /* ============================================================
   * 9. 朝向: 六邻方向向量 + 规则表 + 探针
   *    DIRS 与 mapgen.NEIGH_SLOTS 同序 (k=0 东 → k=5 东北, 顺时针)
   * ============================================================ */
  /* 六邻方向的屏幕单位向量 —— 必须与地图网格严格同源:
     世界坐标 world(q,r) = (hexW*(q + r/2), 1.5*hexR*r), hexW = √3·hexR;
     故轴向步 (dq,dr) 归一化后 ∝ (dq + dr/2, √3/2·dr)。
     ⚠ 这里必须用 √3/2 的精确值而非 0.866 近似: DIRS 既当朝向桶基准,
       又参与 resolveFace 的角度比较, 近似值会让对拍出现 2.5e-5 级偏差。 */
  var SQ3_2 = Math.sqrt(3) / 2;
  var DIRS = [[1, 0], [0.5, SQ3_2], [-0.5, SQ3_2], [-1, 0], [-0.5, -SQ3_2], [0.5, -SQ3_2]];
  var SOUTH = { x: 0, y: 1 };
  /* 朝向规则: 决定"建筑的正面朝哪" —— 由地缘决定, 不是随机 */
  var FACE_RULE = {
    '码头': 'water', '渔船坞': 'water', '渔亭': 'water', '磨坊': 'water',
    '农田': 'open', '药圃': 'open',
    '民房': 'center', '仓库': 'center', '集市': 'center',
    '村口': 'away',
    '官衙': 'south', '宗祠': 'south', '祠堂': 'south', '宗门大殿': 'south',
    '祖师殿': 'south', '炼丹殿': 'south', '炼器殿': 'south', '灵枢殿': 'south',
    '矿山': 'rock', '熔炉': 'rock', '炼炉': 'rock', '焦炭窑': 'rock',
    '伐木场': 'wood',
    '聚灵阵': 'flat', '祭坛': 'flat'
  };
  /* 规则 → 中文说明 (文档/调试用) */
  var FACE_DESC = {
    water: '朝水面 (栈桥/水车/船台伸向邻水方向)',
    open: '朝最开阔方向 (田垄垂直于该向)',
    center: '朝聚落中枢 (街门面向核心格)',
    away: '背对中枢 (村口朝外)',
    south: '坐北朝南 (礼制固定朝向, 带轻微抖动)',
    rock: '朝山体 (洞口/炉口面向山)',
    wood: '朝林地 (料场面向林相)',
    flat: '俯视无正面 (仅按格位旋转阵轴)'
  };
  function resolveFace(kind, S, probe) {
    var rule = FACE_RULE[kind] || 'south', f = null;
    if (probe) {
      var r = rule === 'away' ? 'center' : rule;
      if (probe[r]) f = probe[r]();
      if (rule === 'away' && f) f = { x: -f.x, y: -f.y };
    }
    if (!f || (!f.x && !f.y)) {
      if (rule === 'flat') {
        var k = (S.rand() * 6) | 0;
        f = { x: DIRS[k][0], y: DIRS[k][1] };
      } else {
        f = { x: (S.rand() - 0.5) * 0.18, y: 1 };      // 坐北朝南 + 轻微抖动
      }
    }
    return f;
  }

  /* ============================================================
   * 9b. 朝向求解器 (地缘探针) —— 所有「实时绘制方」共用同一份实现
   * ------------------------------------------------------------
   * 绘制核心不认识地形, 只知道「朝哪」。地形由调用方以一个 biome(q,r)
   * 回调注入, 于是同一份求解器可跑三种数据源:
   *   · 浏览器前端 : 已加载区块 tiles 反查 (web/js/main.js biomeAt)
   *   · 离线预览页 : 直接 MapGen.fields(q,r).biome
   *   · 对拍脚本   : 同上 (verify/w6 直接跑本函数, 不另写一份)
   * ⚠ 环枚举顺序固定 (rad → dq → dr) 且取首个命中 → 同一格结果恒定,
   *   不会因重绘而改朝向。
   * ============================================================ */
  var BM_WATER = 1, BM_FOREST = 4, BM_ROCK = 6;
  /* 轴向六边距 (与 mapgen hexDist 同式) */
  function axDist(dq, dr) {
    var a = dq < 0 ? -dq : dq, b = dr < 0 ? -dr : dr, c = dq + dr;
    return (a + b + (c < 0 ? -c : c)) >> 1;
  }
  /* o = { biome(q,r) -> 0..7 或 -1(未知), hexW, hexR, ringMax=3 } */
  function faceSolver(o) {
    var biome = o.biome, hw = o.hexW, h15 = 1.5 * o.hexR;
    var RING_MAX = o.ringMax == null ? 3 : o.ringMax;
    var curB = null, curSt = null;
    /* 轴向步 → 屏幕单位向量。与 DIRS 同源: 世界 x = hexW*(dq+dr/2), y = 1.5*hexR*dr */
    function dirOf(dq, dr) {
      var wx = hw * (dq + dr / 2), wy = h15 * dr;
      var L = Math.sqrt(wx * wx + wy * wy) || 1;
      return { x: wx / L, y: wy / L };
    }
    function match(bm, code) {
      if (bm == null || bm < 0) return false;
      if (code === BM_WATER) return bm <= 1;      // 深海 / 浅海
      if (code === BM_ROCK) return bm >= 6;       // 山地 / 雪峰
      return bm === code;                         // 林地
    }
    /* 最近的目标地类方向 (由近及远逐环, 环内固定枚举序) */
    function nearest(code) {
      if (!curB) return null;
      var bq = curB.q, br = curB.r;
      for (var rad = 1; rad <= RING_MAX; rad++) {
        for (var dq = -rad; dq <= rad; dq++) {
          for (var dr = -rad; dr <= rad; dr++) {
            if (axDist(dq, dr) !== rad) continue;
            if (!match(biome(bq + dq, br + dr), code)) continue;
            return dirOf(dq, dr);
          }
        }
      }
      return null;
    }
    /* 一次性查询 (不依赖 curB 状态): 供对拍脚本核对「某格朝某地类的方向」 */
    function nearestAt(b, code) {
      var pb = curB; curB = b;
      var f = nearest(code);
      curB = pb;
      return f;
    }
    /* 中枢向: 建筑格 → 聚落中心格 (open 取其反向 = 背离城外) */
    function toCenter() {
      if (!curB || !curSt) return null;
      var dq = curSt.q - curB.q, dr = curSt.r - curB.r;
      if (!dq && !dr) return null;                 // 建筑即中枢格 → 交给回退
      return dirOf(dq, dr);
    }
    /* 单例探针表 (同步使用, 靠 curB/curSt 换当前格; 避免逐座新建 5 个闭包) */
    var probe = {
      center: toCenter,
      open: function () { var f = toCenter(); return f ? { x: -f.x, y: -f.y } : null; },
      water: function () { return nearest(BM_WATER); },
      rock: function () { return nearest(BM_ROCK); },
      wood: function () { return nearest(BM_FOREST); }
    };
    /* 逐座求解: 返回 { face, water }。
       water=false 表示「该格环内无水面」—— 磨坊据此改画旱碾而非水车。 */
    function faceInfo(b, st) {
      curB = b; curSt = st;
      var S = frameOf({ B: null, cx: 0, cy: 0, R: 20, q: b.q, r: b.r,
                        kind: b.kind, seed: hash3(b.q | 0, b.r | 0, 7919) });
      var face = resolveFace(b.kind, S, probe);
      var rule = FACE_RULE[b.kind] || 'south';
      var water = rule === 'water' ? !!nearest(BM_WATER) : true;
      curB = null; curSt = null;
      return { face: face, water: water };
    }
    return { faceInfo: faceInfo, dirOf: dirOf, nearest: nearest, nearestAt: nearestAt, axDist: axDist };
  }

  /* ============================================================
   * 10. 绘制入口
   * ============================================================ */
  /* 26 种建筑全集 (与 mapgen.js 的 BUILDINGS + CORE_KIND 逐一对齐) */
  var KIND_LIST = ['官衙', '集市', '宗祠', '祠堂', '村口', '宗门大殿', '祖师殿',
    '灵枢殿', '聚灵阵', '祭坛', '炼丹殿', '炼器殿',
    '码头', '渔船坞', '渔亭', '农田', '磨坊', '谷仓',
    '矿山', '熔炉', '伐木场', '药圃', '炼炉', '焦炭窑', '民房', '仓库'];
  var KIND_ID = {};
  (function () { for (var i = 0; i < KIND_LIST.length; i++) KIND_ID[KIND_LIST[i]] = i + 1; })();
  var KIND_TERRAIN = {
    '官衙': 'core', '集市': 'core', '宗祠': 'core', '祠堂': 'core', '村口': 'core',
    '宗门大殿': 'core', '祖师殿': 'core',
    '灵枢殿': '灵枢', '聚灵阵': '灵枢', '祭坛': '灵枢',
    '炼丹殿': '高阶灵地', '炼器殿': '高阶灵地',
    '码头': '水岸', '渔船坞': '水岸', '渔亭': '水岸',
    '农田': '良田', '磨坊': '良田', '谷仓': '良田',
    '矿山': '矿脉', '熔炉': '矿脉',
    '伐木场': '林地', '药圃': '林地',
    '炼炉': '灼壤', '焦炭窑': '灼壤',
    '民房': '村落', '仓库': '村落'
  };

  function seedOf(spec) {
    var kid = KIND_ID[spec.kind] || 99;
    return hash3((spec.q | 0) * 73856093 ^ (spec.r | 0) * 19349663, kid * 2654435761,
      (spec.variant | 0) * 40503 + (spec.seed | 0));
  }

  /* 主入口: 画一座建筑 (B 为后端, spec 见文件头注释) */
  function paint(B, spec) {
    var R = spec.R || 16;
    var detail = spec.detail != null ? spec.detail : (R >= 9 ? 3 : (R >= 5.2 ? 2 : 1));
    var S = frameOf({
      B: B, cx: spec.cx, cy: spec.cy, R: R, q: spec.q, r: spec.r, kind: spec.kind,
      tier: spec.tier, detail: detail, unit: spec.unit,
      face: spec.face, seed: seedOf(spec), water: spec.water
    });
    /* 朝向: 未显式给定则按规则 + 探针推导 */
    if (!spec.face) S.setFace(resolveFace(spec.kind, S, spec.probe));
    else S.setFace(spec.face);
    var fn = KINDS[spec.kind] || KINDS['民房'];
    /* 六边格基座 = 「场地」(网格感 + 地皮色 + 墨边 + 柔光) + 落影 */
    if (spec.plate !== false) {
      hexPlate(S, { tint: spec.tint || LANDUSE_TINT[KIND_TERRAIN[spec.kind]] || STONE,
        a: spec.plateA == null ? 0.32 : spec.plateA });
    }
    if (detail >= 2) {
      var g0 = S.g(0, 0.06);
      B.radial(g0[0], g0[1], R * 0.92, '#302a22', 0.26, R * 0.92, R * 0.92 * KY);
    }
    fn(S, spec);
    return S;
  }

  /* ---------- Node/SVG 便捷出口 ---------- */
  function svgBody(spec) {
    var B = new SvgBk();
    B.ns = 'k' + (KIND_ID[spec.kind] || 0) + '_';
    paint(B, spec);
    return B.out.join('');
  }

  /* ---------- 浏览器端 sprite 缓存 (实时绘制用: 同 kind/朝向/变体 只画一次) ----------
     缓存盒: 以格心为原点, 单位 R —— 建筑可越格 (栈桥 2.0R / 树冠 1.15R / 幡 0.7R) */
  var SPR_BOX = { x0: -1.35, x1: 1.35, y0: -1.6, y1: 2.4 };
  var _spr = new Map();
  var SPR_CAP = 512;
  function dirIdxOf(face) {
    if (!face) return -1;
    var best = 0, bd = -2;
    for (var k = 0; k < 6; k++) {
      var L = Math.sqrt(face.x * face.x + face.y * face.y) || 1;
      var d = (face.x / L) * DIRS[k][0] + (face.y / L) * DIRS[k][1];
      if (d > bd) { bd = d; best = k; }
    }
    return best;
  }
  function spriteOf(spec) {
    if (typeof document === 'undefined') return null;
    var R = spec.R || 16;
    var detail = spec.detail != null ? spec.detail : (R >= 9 ? 3 : (R >= 5.2 ? 2 : 1));
    var key = spec.kind + '|' + dirIdxOf(spec.face) + '|' + (spec.variant | 0) + '|' +
              (Math.round(R * 2) / 2) + '|' + detail + '|' + (spec.tier | 0) + '|' +
              (spec.water === false ? 'd' : 'w');
    var hit = _spr.get(key);
    if (hit) return hit;
    var w = Math.max(6, Math.ceil((SPR_BOX.x1 - SPR_BOX.x0) * R));
    var h = Math.max(6, Math.ceil((SPR_BOX.y1 - SPR_BOX.y0) * R));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx2 = cv.getContext('2d');
    paint(new CanvasBk(ctx2), {
      kind: spec.kind, q: spec.q, r: spec.r, variant: spec.variant, tier: spec.tier,
      face: spec.face, probe: spec.probe, R: R, detail: detail, water: spec.water,
      cx: -SPR_BOX.x0 * R, cy: -SPR_BOX.y0 * R,
      plate: spec.plate, tint: spec.tint, plateA: spec.plateA
    });
    var rec = { cv: cv, ox: SPR_BOX.x0 * R, oy: SPR_BOX.y0 * R, w: w, h: h };
    if (_spr.size >= SPR_CAP) {
      var it = _spr.keys(), first = it.next();
      if (!first.done) _spr.delete(first.value);
    }
    _spr.set(key, rec);
    return rec;
  }
  function spriteClear() { _spr.clear(); }

  global.BldgInk = {
    INK: INK, INK2: INK2, INK3: INK3, INK4: INK4, INK5: INK5,
    EARTH: EARTH, CINNABAR: CINNABAR, AZURE: AZURE, JADE: JADE,
    GAMBOGE: GAMBOGE, SPIRIT: SPIRIT, STONE: STONE, WALL: WALL,
    TILE: TILE, THATCH: THATCH, WOOD: WOOD, KY: KY,
    LANDUSE_TINT: LANDUSE_TINT, KIND_LIST: KIND_LIST, KIND_TERRAIN: KIND_TERRAIN,
    FACE_RULE: FACE_RULE, FACE_DESC: FACE_DESC, DIRS: DIRS, SOUTH: SOUTH,
    resolveFace: resolveFace, dirIdxOf: dirIdxOf, kindIdOf: function (k) { return KIND_ID[k] || 0; },
    faceSolver: faceSolver, axDist: axDist,
    canvasBackend: function (ctx) { return new CanvasBk(ctx); },
    svgBackend: function () { return new SvgBk(); },
    frameOf: frameOf, hash3: hash3, mulberry32: mulberry32,
    paint: paint, svgBody: svgBody, KINDS: KINDS,
    spriteOf: spriteOf, spriteClear: spriteClear, SPR_BOX: SPR_BOX,
    hexPts: hexPts, gpOf: gpOf,
    _ink: ink, _face: faceOf, _dots: dots, _shade: shade,
    _rgba: rgba, hexPlate: hexPlate, boxWalls: boxWalls, wallRect: wallRect,
    placeDoor: placeDoor, placeWin: placeWin, roofGable: roofGable, roofHip: roofHip,
    roofPyr: roofPyr, roofCone: roofCone, slab: slab, stairs: stairs, posts: posts,
    flag: flag, tree: tree, smoke: smoke, aura: aura, fence: fence,
    waterFan: waterFan, heap: heap, shedOf: shedOf, houseCore: houseCore,
    gpQuad: gpQuad, gpLine: gpLine, gpWash: gpWash, gpHexRing: gpHexRing
  };
})(typeof window !== 'undefined' ? window : globalThis);
