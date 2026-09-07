/* ============================================================
 * main.js — 山河图主程序 (无限流式区块版)
 * 区块加载队列 / 相机 / Canvas2D 标注层(区域格驱动) / 局部小地图 / UI
 * ============================================================ */
(function () {
  'use strict';
  var NL = NoiseLib, MG = MapGen, IT = InkTextures;

  var els = {};
  var renderer = null;
  var cam = { x: 0, y: 0, zoom: 2.2, tx: 0, ty: 0, tzoom: 2.2 };
  var minZoom = 0.7, maxZoom = 6;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var hoverTile = null, selectedTile = null;    // {q, r}
  var showVeins = true, showLabels = true;
  var chunks = new Map();                       // key -> {bbox}
  var genQueue = [];                            // 待生成区块 [{ca, cb, key, d}]
  var timeSec = 0, lastT = 0;
  var minimapDirty = true, minimapTimer = 0;

  /* ---------- 渲染节流状态 ----------
   * 静态图层缓存 + 相机位移阈值:
   *   浪线/道路带/区域名/灵脉花/聚落图标 全部是世界锚定的确定性内容,
   *   只在相机确实移动/缩放/视口变化超过阈值时整层重绘;
   *   相机静止时直接 blit 复用静态图层, 不再每帧全量重算 Canvas2D。 */
  var staticLayer = null;                       // 离屏静态图层
  var staticCam = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };  // 缓存生成时的相机/视口
  var staticDirty = true;                       // 首帧强制重建
  var lastPan = { x: 0, y: 0, zoom: 0 };   // 上次流式扫描位置
  var streamIdle = true;                        // 相机静止 && 区块已就绪
  var warmGap = 3, warmFrame = 0;               // 道路预热: 每 3 帧推进一次

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return NL.clamp(v, a, b); }
  function chunkKey(ca, cb) { return ca + ',' + cb; }

  function showFatal(msg) {
    var d = $('fatal');
    d.style.display = 'flex';
    $('fatalMsg').textContent = String(msg);
  }
  window.addEventListener('error', function (e) {
    showFatal(e.message + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  });

  function s2w(sx, sy) {
    return {
      x: (sx - els.app.clientWidth / 2) / cam.zoom + cam.x,
      y: (sy - els.app.clientHeight / 2) / cam.zoom + cam.y
    };
  }
  function w2s(wx, wy) {
    return {
      x: (wx - cam.x) * cam.zoom + els.app.clientWidth / 2,
      y: (wy - cam.y) * cam.zoom + els.app.clientHeight / 2
    };
  }
  function viewBounds() {
    var a = s2w(0, 0), b = s2w(els.app.clientWidth, els.app.clientHeight);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }

  function hexPath(ctx, cx, cy, R) {
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var a = Math.PI / 180 * (60 * k - 30);
      var px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /* ---------- 区块流式加载 ----------
   * 相机位移 < PAN_EPS 且视野内区块均已就绪时直接跳过,
   * 避免静止画面每帧全量重扫"需要的区块集合 + 排序 + 逐帧生成"。 */
  function updateStreaming() {
    var b = viewBounds();
    var _panChanged =
      Math.abs(cam.x - lastPan.x) > 18 * (1 / (cam.zoom * 0.75 + 0.25)) ||
      Math.abs(cam.y - lastPan.y) > 18 * (1 / (cam.zoom * 0.75 + 0.25)) ||
      Math.abs(cam.zoom - lastPan.zoom) > 0.02;
    if (!_panChanged && genQueue.length === 0) {
      streamIdle = true;
      return;                                   // 静止且无积压 → 零开销
    }
    streamIdle = false;

    var pad = MG.HEX_W * 2;
    var corners = [
      MG.pxToTile(b.x0 - pad, b.y0 - pad), MG.pxToTile(b.x1 + pad, b.y0 - pad),
      MG.pxToTile(b.x0 - pad, b.y1 + pad), MG.pxToTile(b.x1 + pad, b.y1 + pad)
    ];
    /* 视野四角的格坐标包围盒 (轴坐标有剪切, 取四角极值) */
    var qmin = 1e18, qmax = -1e18, rmin = 1e18, rmax = -1e18;
    for (var i = 0; i < 4; i++) {
      qmin = Math.min(qmin, corners[i].q); qmax = Math.max(qmax, corners[i].q);
      rmin = Math.min(rmin, corners[i].r); rmax = Math.max(rmax, corners[i].r);
    }
    /* 外扩: 胞腔半径 (区块归属最远 14 格) + 预载一圈, 保证丝滑 */
    var m = MG.CHUNK_SCAN + MG.CHUNK_S;
    qmin -= m; qmax += m; rmin -= m; rmax += m;
    var S = MG.CHUNK_S;
    var need = {};
    var a0 = Math.floor(qmin / S), a1 = Math.floor(qmax / S);
    var b0 = Math.floor(rmin / S), b1 = Math.floor(rmax / S);
    for (var ca = a0; ca <= a1; ca++) {
      for (var cb = b0; cb <= b1; cb++) {
        need[chunkKey(ca, cb)] = { ca: ca, cb: cb };
      }
    }
    /* 卸载视野外区块 */
    chunks.forEach(function (info, key) {
      if (!need[key]) {
        renderer.dropChunk(key);
        chunks.delete(key);
      }
    });
    /* 生成队列: 距相机排序, 积压多时每帧至多 2 个, 平时 1 个 */
    genQueue.length = 0;
    for (var key in need) {
      if (!chunks.has(key)) {
        var cc = need[key];
        var center = { q: cc.ca * S, r: cc.cb * S };
        var w = MG.tileToWorld(center.q, center.r);
        var d = (w.x - cam.x) * (w.x - cam.x) + (w.y - cam.y) * (w.y - cam.y);
        genQueue.push({ ca: cc.ca, cb: cc.cb, key: key, d: d });
      }
    }
    genQueue.sort(function (p, q) { return p.d - q.d; });
    var budget = genQueue.length > 6 ? 2 : 1;
    while (budget-- > 0 && genQueue.length) {
      var job = genQueue.shift();
      var built = MG.buildChunk(job.ca, job.cb);
      renderer.uploadChunk(job.key, built.data);
      chunks.set(job.key, { bbox: built.bbox });
      lastPan.x = cam.x; lastPan.y = cam.y; lastPan.zoom = cam.zoom;
      minimapDirty = true;
    }
  }

  /* ---------- 聚落图标 (Canvas2D 白描) ---------- */
  function iconBase(ctx) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(45,38,30,0.95)';
    ctx.fillStyle = 'rgba(242,236,220,0.92)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }
  function drawSect(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-6.5, 6.5, 13, 3); ctx.strokeRect(-6.5, 6.5, 13, 3);
    ctx.fillRect(-4.5, 1.5, 9, 5); ctx.strokeRect(-4.5, 1.5, 9, 5);
    ctx.beginPath();
    ctx.moveTo(-8.5, 1.5); ctx.quadraticCurveTo(-6.5, 0.2, -5, -2.5);
    ctx.lineTo(5, -2.5); ctx.quadraticCurveTo(6.5, 0.2, 8.5, 1.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(-3, -7.5, 6, 5); ctx.strokeRect(-3, -7.5, 6, 5);
    ctx.beginPath();
    ctx.moveTo(-6.5, -7.5); ctx.quadraticCurveTo(-5, -8.8, -3.8, -11);
    ctx.lineTo(3.8, -11); ctx.quadraticCurveTo(5, -8.8, 6.5, -7.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, -14.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -15.5, 1.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawCity(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-8, -2, 16, 9); ctx.strokeRect(-8, -2, 16, 9);
    for (var i = -8; i < 8; i += 4) { ctx.fillRect(i, -4.5, 2.6, 2.5); ctx.strokeRect(i, -4.5, 2.6, 2.5); }
    ctx.beginPath();
    ctx.moveTo(-2.5, 7); ctx.lineTo(-2.5, 2); ctx.arc(0, 2, 2.5, Math.PI, 0); ctx.lineTo(2.5, 7);
    ctx.closePath(); ctx.fillStyle = 'rgba(60,50,40,0.55)'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 1); ctx.lineTo(13, -1); ctx.lineTo(13, 5); ctx.lineTo(8, 3);
    ctx.closePath(); ctx.fillStyle = 'rgba(166,58,44,0.8)'; ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawTown(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-6, -1, 12, 8); ctx.strokeRect(-6, -1, 12, 8);
    ctx.beginPath();
    ctx.moveTo(-8.5, -1); ctx.lineTo(0, -8); ctx.lineTo(8.5, -1); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,50,40,0.55)';
    ctx.fillRect(-1.8, 2.5, 3.6, 4.5); ctx.strokeRect(-1.8, 2.5, 3.6, 4.5);
    ctx.restore();
  }
  function drawVillage(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-4.5, 0, 9, 6); ctx.strokeRect(-4.5, 0, 9, 6);
    ctx.beginPath();
    ctx.moveTo(-6.5, 0); ctx.quadraticCurveTo(0, -9, 6.5, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,50,40,0.5)';
    ctx.fillRect(-1.4, 2, 2.8, 4);
    ctx.restore();
  }
  function drawPoi(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(150,52,38,0.95)';
    ctx.fillStyle = 'rgba(214,120,92,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(6, 0); ctx.lineTo(0, 8); ctx.lineTo(-6, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(150,52,38,0.95)'; ctx.fill();
    ctx.restore();
  }
  var ICON_FN = { sect: drawSect, city: drawCity, town: drawTown, village: drawVillage, poi: drawPoi };

  /* ---------- 小地图: 以相机为中心的局部勘探图 ---------- */
  var mmBase = null;
  function refreshMinimap() {
    var W = 132, H = 88, SCALE = 6;         // 每像素 6 世界像素
    if (!mmBase) mmBase = document.createElement('canvas');
    mmBase.width = W; mmBase.height = H;
    var ctx = mmBase.getContext('2d');
    var img = ctx.createImageData(W, H);
    for (var py = 0; py < H; py++) {
      for (var px = 0; px < W; px++) {
        var wx = cam.x + (px - W / 2) * SCALE;
        var wy = cam.y + (py - H / 2) * SCALE;
        var t = MG.pxToTile(wx, wy);
        var f = MG.fields(t.q, t.r);
        var col = MG.BIOME_META[f.disp != null ? f.disp : f.biome].color;
        var i = (py * W + px) * 4;
        img.data[i] = parseInt(col.slice(1, 3), 16);
        img.data[i + 1] = parseInt(col.slice(3, 5), 16);
        img.data[i + 2] = parseInt(col.slice(5, 7), 16);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function drawMinimap() {
    var box = els.minimap, bctx = box.getContext('2d');
    var mw = box.width, mh = box.height;
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, mw, mh);
    if (!mmBase) return;
    bctx.drawImage(mmBase, 0, 0, mw, mh);
    /* 中心: 玩家所在 */
    bctx.strokeStyle = 'rgba(166,58,44,0.95)';
    bctx.lineWidth = 2;
    bctx.strokeRect(mw / 2 - 3, mh / 2 - 3, 6, 6);
    /* 缩放比例注记 */
    bctx.fillStyle = 'rgba(50,42,34,0.7)';
    bctx.font = '10px "KaiTi","STKaiti",serif';
    bctx.textAlign = 'left';
    bctx.fillText('方圆百里', 6, mh - 6);
  }

  /* ---------- 标注层 ----------
   * 静态世界锚定内容全部确定性绘制到离屏 staticLayer:
   *   相机位移/缩放/视口变化超阈值时才整层重绘 (renderStaticInto),
   *   其余帧仅把 staticLayer blit 叠到 overlay 并重画动态悬停/选中高亮。
   */

  function staticNeedsRedraw(vw, vh) {
    if (staticDirty) return true;
    var scale = 18 / (cam.zoom * 0.75 + 0.25);
    if (Math.abs(cam.x - staticCam.x) > scale) return true;
    if (Math.abs(cam.y - staticCam.y) > scale) return true;
    if (Math.abs(cam.zoom - staticCam.zoom) > 0.02) return true;
    if (vw !== staticCam.w || vh !== staticCam.h) return true;
    return false;
  }

  function renderStaticInto() {
    var cw = els.overlay.width, ch = els.overlay.height;
    if (!staticLayer) staticLayer = document.createElement('canvas');
    if (staticLayer.width !== cw || staticLayer.height !== ch) {
      staticLayer.width = cw; staticLayer.height = ch;
    }
    var ctx = staticLayer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    var b = viewBounds();

    /* ---- 世界坐标系 ---- */
    ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
      dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
      dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
    var z = cam.zoom;

    /* 视野内区域格 (轴坐标包围盒 + 余量) */
    var c0 = MG.pxToTile(b.x0, b.y0), c1 = MG.pxToTile(b.x1, b.y1),
        c2 = MG.pxToTile(b.x0, b.y1), c3 = MG.pxToTile(b.x1, b.y0);
    var qmin = Math.min(c0.q, c1.q, c2.q, c3.q) - 2, qmax = Math.max(c0.q, c1.q, c2.q, c3.q) + 2;
    var rmin = Math.min(c0.r, c1.r, c2.r, c3.r) - 2, rmax = Math.max(c0.r, c1.r, c2.r, c3.r) + 2;
    var M = MG.REGION_M;
    var i0 = Math.floor(qmin / M) - 1, i1 = Math.floor(qmax / M) + 1;
    var j0 = Math.floor(rmin / M) - 1, j1 = Math.floor(rmax / M) + 1;

    /* 海面波浪: 静态白描浪线 (参考图风, hash 确定性 → 跨帧跨会话一致, 无动画, 无 LOD) */
    {
    var wq0 = MG.pxToTile(b.x0 - 24, b.y0 - 24), wq1 = MG.pxToTile(b.x1 + 24, b.y1 + 24),
        wq2 = MG.pxToTile(b.x0 - 24, b.y1 + 24), wq3 = MG.pxToTile(b.x1 + 24, b.y0 - 24);
    var wqmin = Math.min(wq0.q, wq1.q, wq2.q, wq3.q) - 1, wqmax = Math.max(wq0.q, wq1.q, wq2.q, wq3.q) + 1;
    var wrmin = Math.min(wq0.r, wq1.r, wq2.r, wq3.r) - 1, wrmax = Math.max(wq0.r, wq1.r, wq2.r, wq3.r) + 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var wq = wqmin; wq <= wqmax; wq++) {
      for (var wr = wrmin; wr <= wrmax; wr++) {
        var wf = MG.fields(wq, wr);
        if (wf.biome > 1) continue;
        var hh = wf.hash;
        var fr1 = (hh * 913.7) % 1, fr2 = (hh * 517.3) % 1, fr3 = (hh * 271.1) % 1;
        /* 近岸浅海: 白沫弧 + 沫点 (邻格有陆地) */
        var nearLand = false;
        if (wf.biome === 1) {
          for (var wn = 0; wn < 6; wn++) {
            if (MG.fields(wq + MG.NEIGH_SLOTS[wn][0], wr + MG.NEIGH_SLOTS[wn][1]).biome > 1) { nearLand = true; break; }
          }
        }
        if (nearLand) {
          var mcx = wf.x + (fr1 - 0.5) * MG.HEX_W * 0.8;
          var mcy = wf.y + (fr2 - 0.5) * MG.HEX_R * 0.8;
          var mr = MG.HEX_W * (0.20 + fr3 * 0.15);
          /* 近岸沫弧: 细笔淡墨 (水墨风: 不用高光白, 用偏灰墨绿) */
          ctx.strokeStyle = 'rgba(126,152,150,' + (0.22 + fr2 * 0.10).toFixed(2) + ')';
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.arc(mcx, mcy, mr, Math.PI * 1.02 + fr1 * 0.8, Math.PI * 1.72 + fr1 * 0.8);
          ctx.stroke();
          ctx.fillStyle = 'rgba(226,236,232,' + (0.20 + fr3 * 0.14).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(mcx + mr * 1.25, mcy + 1.8, 0.8, 0, Math.PI * 2); ctx.fill();
          continue;
        }
        /* 开阔海面: 水墨浪线 — 细笔淡墨, 一波三折, 尾端回锋短笔 */
        if (hh >= (wf.biome === 0 ? 0.30 : 0.46)) continue;
        var wx0 = wf.x + (fr1 - 0.5) * MG.HEX_W * 1.2;
        var wy0 = wf.y + (fr2 - 0.5) * MG.HEX_R * 1.2;
        var wl = MG.HEX_W * (1.1 + fr3 * 1.5);
        var wtilt = (fr1 - 0.5) * 0.25;
        ctx.strokeStyle = 'rgba(64,94,104,' + (0.16 + fr2 * 0.10).toFixed(2) + ')';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(wx0 - wl * 0.5, wy0 + wtilt * wl * 0.5);
        ctx.quadraticCurveTo(wx0 - wl * 0.1, wy0 - wl * 0.13, wx0 + wl * 0.12, wy0 - wl * 0.02);
        ctx.quadraticCurveTo(wx0 + wl * 0.32, wy0 + wl * 0.06, wx0 + wl * 0.5, wy0 + wtilt * wl * 0.3);
        ctx.stroke();
        /* 回锋短笔 (更淡更细, 错位半笔) */
        if (fr3 > 0.55) {
          ctx.strokeStyle = 'rgba(70,100,110,' + (0.10 + fr2 * 0.06).toFixed(2) + ')';
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(wx0 - wl * 0.16, wy0 + 2.4);
          ctx.quadraticCurveTo(wx0 + wl * 0.06, wy0 + 1.2, wx0 + wl * 0.26, wy0 + 2.6);
          ctx.stroke();
        }
      }
    }
    } /* 浪线层结束 (无 LOD) */

    /* 道路: GL 贴地小径 (三角面画进底图 FBO → 树等立体精灵渲染其上, 树压路;
       无 LOD, 全缩放绘制; 无路缘、宽窄随路段起伏) */
    var haloV = [], coreV = [];
    function pushSeg(arr, ax, ay, bx, by, w) {
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len * w * 0.5, ny = dx / len * w * 0.5;
      arr.push(ax - nx, ay - ny, bx + nx, by + ny, ax + nx, ay + ny,
               ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny);
    }
    var drawn = {};
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var roads = MG.roadsNear(i, j, 0);     // 绘制帧纯读缓存, A* 由主循环预热
        for (var rr = 0; rr < roads.length; rr++) {
          var road = roads[rr];
          if (drawn[road.key]) continue;
          drawn[road.key] = true;
          if (road.x1 < b.x0 - 200 || road.x0 > b.x1 + 200 || road.y1 < b.y0 - 200 || road.y0 > b.y1 + 200) continue;
          var pts = road.pts;
          var rh = 0;
          for (var kc = 0; kc < road.key.length; kc++) rh = (rh * 31 + road.key.charCodeAt(kc)) % 997;
          var wBase = 1.4 + (rh / 997) * 1.5;
          for (var p2 = 0; p2 < pts.length - 1; p2++) {
            var segH = Math.sin(p2 * 12.9898 + rh * 0.7853) * 43758.5453;
            var wob = segH - Math.floor(segH);            // 0..1 段宽噪声
            var wm = wBase * (0.60 + 0.8 * wob);
            pushSeg(haloV, pts[p2].x, pts[p2].y, pts[p2 + 1].x, pts[p2 + 1].y, wm * 2.4);
            pushSeg(coreV, pts[p2].x, pts[p2].y, pts[p2 + 1].x, pts[p2 + 1].y, Math.max(1.0, wm));
          }
        }
      }
    }
    renderer.setRoads(new Float32Array(haloV), new Float32Array(coreV));

    /* 灵脉: 七星花 + 群落灵气晕圈 (世界坐标等比, 设定 §三/§七/§九) */
    var veinLabels = [];
    if (showVeins) {
      var CL = MG.CFG.COMM_CL;
      var ci0 = Math.floor(qmin / CL) - 1, ci1 = Math.floor(qmax / CL) + 1;
      var cj0 = Math.floor(rmin / CL) - 1, cj1 = Math.floor(rmax / CL) + 1;
      /* 群落灵气晕圈: 中心富、边缘贫 */
      for (var ci = ci0; ci <= ci1; ci++) {
        for (var cj = cj0; cj <= cj1; cj++) {
          var cm = MG.communityOf(ci, cj);
          if (!cm) continue;
          var cRGB = MG.ELEMENT_RGB[cm.element];
          var auraR = MG.CFG.COMM_R * MG.HEX_W * 1.15;
          var cS = cRGB[0] + ',' + cRGB[1] + ',' + cRGB[2];
          var ag = ctx.createRadialGradient(cm.x, cm.y, auraR * 0.06, cm.x, cm.y, auraR);
          ag.addColorStop(0, 'rgba(' + cS + ',0.085)');
          ag.addColorStop(0.6, 'rgba(' + cS + ',0.035)');
          ag.addColorStop(1, 'rgba(' + cS + ',0)');
          ctx.fillStyle = ag;
          ctx.beginPath(); ctx.arc(cm.x, cm.y, auraR, 0, Math.PI * 2); ctx.fill();
        }
      }
      /* 灵脉灵气晕圈 (连线/圆点已删, 仅淡晕圈 + 名牌) */
      for (ci = ci0; ci <= ci1; ci++) {
        for (cj = cj0; cj <= cj1; cj++) {
          cm = MG.communityOf(ci, cj);
          if (!cm) continue;
          for (var vv = 0; vv < cm.veins.length; vv++) {
            var v = cm.veins[vv];
            var vw = MG.tileToWorld(v.q, v.r);
            var rgb = v.variant ? MG.VARIANT_RGB[v.variant] : MG.ELEMENT_RGB[v.element];
            IT.drawVeinFlower(ctx, vw.x, vw.y, null, rgb, { level: v.level });
            veinLabels.push({ x: vw.x, y: vw.y, name: v.name + '灵脉（' + ['大', '中', '小'][v.level] + '）', rgb: rgb, level: v.level });
          }
        }
      }
    }

    /* 悬停/选中格高亮不在静态层绘制 (会烙进缓存, 鼠标移开后残留),
       由 drawOverlay() 每帧动态绘制 */

    /* ---- 屏幕坐标系 ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var vw = els.app.clientWidth, vh = els.app.clientHeight;

    if (showLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      /* 区域名 (按区域格世界字号, 等比) */
      for (i = i0; i <= i1; i++) {
        for (j = j0; j <= j1; j++) {
          var rg = MG.regionInfo(i, j);
          var ps = w2s(rg.x, rg.y);
          if (ps.x < -200 || ps.y < -100 || ps.x > vw + 200 || ps.y > vh + 100) continue;
          var fs = Math.max(Math.sqrt(M * M) * 0.75, 12) * z;
          ctx.font = fs + 'px "KaiTi","STKaiti",serif';
          ctx.fillStyle = rg.biome <= 1 ? 'rgba(52,66,72,0.28)' : 'rgba(58,48,38,0.26)';
          ctx.fillText(rg.name, ps.x, ps.y);
        }
      }
    }

    /* 灵脉名牌 (屏幕坐标, 近景显示) */
    if (showLabels && z >= 1.0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (var vl = 0; vl < veinLabels.length; vl++) {
        var vb = veinLabels[vl];
        var ps3 = w2s(vb.x, vb.y);
        if (ps3.x < -80 || ps3.y < -40 || ps3.x > vw + 80 || ps3.y > vh + 40) continue;
        var vfs = 12 * Math.max(z, 0.8);
        ctx.font = vfs + 'px "KaiTi","STKaiti",serif';
        var ty = ps3.y + (vb.level === 0 ? 14 : 12) * Math.max(z, 0.8);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(240,232,214,0.85)';
        ctx.strokeText(vb.name, ps3.x, ty);
        ctx.fillStyle = 'rgba(' + vb.rgb[0] + ',' + vb.rgb[1] + ',' + vb.rgb[2] + ',0.95)';
        ctx.fillText(vb.name, ps3.x, ty);
      }
    }

    /* 聚落图标 + 名牌 (世界坐标等比, 下限防缩没) */
    var zoomClamp = Math.max(z, 0.55);
    for (i = i0; i <= i1; i++) {
      for (j = j0; j <= j1; j++) {
        var sts = MG.settlementsFor(i, j);
        for (var s2 = 0; s2 < sts.length; s2++) {
          var st = sts[s2];
          var ps2 = w2s(st.x, st.y);
          if (ps2.x < -60 || ps2.y < -70 || ps2.x > vw + 60 || ps2.y > vh + 70) continue;
          var baseSize = { sect: 17, city: 15, town: 12, village: 10, poi: 11 }[st.type];
          ICON_FN[st.type](ctx, ps2.x, ps2.y, baseSize * zoomClamp);
          var showName = st.type === 'sect' || st.type === 'city' || st.type === 'poi' || z > 0.72;
          if (showLabels && showName) {
            var nfs = 11.5 * Math.max(z, 0.75);
            ctx.font = nfs + 'px "KaiTi","STKaiti",serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.lineWidth = 3 * Math.max(z, 0.75);
            ctx.strokeStyle = 'rgba(240,232,214,0.88)';
            var ly = ps2.y + baseSize * zoomClamp * 0.75 + 3 * Math.max(z, 0.75);
            ctx.strokeText(st.name, ps2.x, ly);
            ctx.fillStyle = st.type === 'poi' ? 'rgba(140,48,34,0.95)' : 'rgba(50,42,34,0.92)';
            ctx.fillText(st.name, ps2.x, ly);
          }
        }
      }
    }

    staticCam.x = cam.x; staticCam.y = cam.y;
    staticCam.zoom = cam.zoom; staticCam.w = els.app.clientWidth; staticCam.h = els.app.clientHeight;
    staticDirty = false;
  }

  /* 每帧: blit 静态层 + 重画动态悬停/选中高亮 */
  function drawOverlay() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    if (staticNeedsRedraw(vw, vh)) renderStaticInto();
    var ctx = els.overlayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    /* staticLayer 在 staticCam 相机位置下绘制世界锚定内容; 当前相机每帧平滑移动,
     * 故用平移补偿 (cam - staticCam)*zoom*dpr 让图标跟随相机逐帧滑移,
     * 避免"重绘时的含量不变, 只有跳变"造成的一卡一卡。
     * 仅当 zoom 与缓存时的缩放高度接近时施加平移 (缩放差异>阈值会触发重绘, 此处几乎不会发生)。 */
    if (staticLayer && Math.abs(cam.zoom - staticCam.zoom) < 0.02) {
      /* 世界锚定内容跟随相机反向平移:
       * staticLayer 按 staticCam 绘制, 当前相机 cam 右移→内容整体左移(负偏移),
       * so 使用 staticCam - cam。 */
      var sdx = dpr * cam.zoom * (staticCam.x - cam.x);
      var sdy = dpr * cam.zoom * (staticCam.y - cam.y);
      ctx.drawImage(staticLayer, sdx, sdy);
    } else if (staticLayer) {
      ctx.drawImage(staticLayer, 0, 0);
    }
    function hexHi(t, alpha, pulse) {
      if (!t) return;
      var w = MG.tileToWorld(t.q, t.r);
      ctx.save();
      ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
        dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
        dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
      ctx.strokeStyle = 'rgba(48,36,24,' + alpha + ')';
      ctx.lineWidth = pulse ? 5 : 3.4;
      hexPath(ctx, w.x, w.y, MG.HEX_R * 0.94);
      ctx.stroke();
      ctx.restore();
    }
    hexHi(hoverTile, 0.7, false);
    hexHi(selectedTile, 0.95, true);
  }

  /* ---------- 相机 ---------- */
  function clampCam() {
    cam.tzoom = clamp(cam.tzoom, minZoom, maxZoom);
  }

  /* ---------- 生成 / 重建 ---------- */
  function regenerate(seedString) {
    MG.init(seedString);
    chunks.forEach(function (_info, key) { renderer.dropChunk(key); });
    chunks.clear();
    genQueue.length = 0;
    renderer.hexR = MG.HEX_R;
    renderer.seaLevel = MG.SEA_LEVEL;
    hoverTile = null;
    selectedTile = null;
    cam.tx = cam.x = 0;
    cam.ty = cam.y = 0;
    cam.tzoom = cam.zoom = 2.2;
    els.seedInput.value = seedString;
    els.seedShow.textContent = seedString;

    var hs = NL.hashSeed(seedString);
    var gan = '甲乙丙丁戊己庚辛壬癸'.charAt(hs % 10);
    var zhi = '子丑寅卯辰巳午未申酉戌亥'.charAt((hs >>> 3) % 12);
    var season = '春夏秋冬'.charAt((hs >>> 7) % 4);
    els.era.textContent = '岁次' + gan + zhi + ' · ' + season;
    hideInfo();
    minimapDirty = true;
  }

  function updateStats() {
    var st = 0, rd = MG.roadCache.size;
    MG.settleCache.forEach(function (arr) { st += arr.length; });
    els.stats.textContent = '已探明 宗门村镇 ' + st + ' · 墨路 ' + rd + ' · 灵脉 ' + MG.countVeins();
  }

  /* ---------- 信息面板 ---------- */
  var TYPE_NAME = { sect: '宗门', city: '仙城', town: '坊市', village: '村落', poi: '秘境' };
  function waterDist(q, r) {
    for (var d = 1; d <= 4; d++) {
      for (var dq = -d; dq <= d; dq++) {
        for (var dr = -d; dr <= d; dr++) {
          if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) !== d) continue;
          if (MG.elevAt(q + dq, r + dr) < MG.SEA_LEVEL - 0.02) return d;
        }
      }
    }
    return -1;
  }
  function showInfo(tile) {
    var f = MG.fields(tile.q, tile.r);
    var rs = MG.regionSeedOf(tile.q, tile.r);
    var ri = MG.regionInfo(rs.i, rs.j);
    var rows = [];
    var cell = MG.settlementsFor(rs.i, rs.j);
    var st = null;
    for (var s = 0; s < cell.length; s++) if (cell[s].q === tile.q && cell[s].r === tile.r) { st = cell[s]; break; }
    if (st) {
      rows.push('<div class="row"><span class="k">所在</span><span class="v">' + TYPE_NAME[st.type] + '</span></div>');
      rows.push('<div class="row"><span class="k">名号</span><span class="v big">' + st.name + '</span></div>');
      if (st.type !== 'poi') rows.push('<div class="row"><span class="k">生民</span><span class="v">约 ' + st.pop.toLocaleString() + ' 口</span></div>');
      else rows.push('<div class="row"><span class="k">气数</span><span class="v">机缘未至, 探之莫测</span></div>');
      rows.push('<div class="sep"></div>');
    }
    rows.push('<div class="row"><span class="k">地界</span><span class="v">' + ri.name + '</span></div>');
    rows.push('<div class="row"><span class="k">地貌</span><span class="v">' + MG.BIOME_META[f.biome].name + '</span></div>');
    rows.push('<div class="row"><span class="k">位次</span><span class="v">' +
      (tile.q < 0 ? '西 ' + (-tile.q) : '东 ' + tile.q) + ' · ' +
      (tile.r < 0 ? '北 ' + (-tile.r) : '南 ' + tile.r) + '</span></div>');
    if (f.vein) {
      rows.push('<div class="sep"></div>');
      rows.push('<div class="row"><span class="k">灵脉</span><span class="v big">' + f.vein.name + '</span></div>');
      rows.push('<div class="row"><span class="k">灵根</span><span class="v">' +
        (f.vein.variant ? f.vein.variant + '灵根 · 派自' + MG.ELEMENTS[f.vein.element]
                        : MG.ELEMENTS[f.vein.element] + '灵根') + '</span></div>');
      rows.push('<div class="row"><span class="k">位份</span><span class="v">' +
        (f.vein.level === 0 ? '大灵脉·七星' : f.vein.level === 1 ? '中灵脉·七星' : '独立小灵脉') + '</span></div>');
    }
    rows.push('<div class="row"><span class="k">海拔</span><span class="v">' + (f.e * 300 | 0) + ' 丈</span></div>');
    rows.push('<div class="row"><span class="k">润泽</span><span class="v">' + (f.m * 100 | 0) + '%</span></div>');
    var wd = f.biome <= 1 ? 0 : waterDist(tile.q, tile.r);
    rows.push('<div class="row"><span class="k">去水</span><span class="v">' + (wd === 0 ? '滨水' : wd > 0 ? wd + ' 里' : '较远') + '</span></div>');
    /* 道路探测 */
    var onRoad = false;
    var ci = Math.floor(tile.q / MG.REGION_M), cj = Math.floor(tile.r / MG.REGION_M);
    outer:
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var roads = MG.roadsNear(ci + di, cj + dj, 1);   // 点击事件帧: 预算 1 条
        for (var r2 = 0; r2 < roads.length; r2++) {
          if (roads[r2].tiles.has(tile.q + ',' + tile.r)) { onRoad = true; break outer; }
        }
      }
    }
    if (onRoad) rows.push('<div class="row"><span class="k">道路</span><span class="v">有墨路经此</span></div>');
    els.infoBody.innerHTML = rows.join('');
    els.info.classList.remove('hidden');
  }
  function hideInfo() { els.info.classList.add('hidden'); }

  /* ---------- 输入 ---------- */
  var drag = null;
  function bindInput() {
    var app = els.app;
    app.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      drag = { sx: e.clientX, sy: e.clientY, cx: cam.tx, cy: cam.ty, moved: false };
    });
    window.addEventListener('mousemove', function (e) {
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (drag) {
        var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          cam.tx = drag.cx - dx / cam.zoom;
          cam.ty = drag.cy - dy / cam.zoom;
          cam.x = cam.tx; cam.y = cam.ty;
        }
      } else if (mx >= 0 && my >= 0 && mx < rect.width && my < rect.height) {
        var w = s2w(mx, my);
        hoverTile = MG.pxToTile(w.x, w.y);
        app.style.cursor = 'pointer';
      }
    });
    window.addEventListener('mouseup', function (e) {
      if (!drag) return;
      var wasClick = !drag.moved;
      drag = null;
      if (!wasClick) return;
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
      var wpt = s2w(mx, my);
      selectedTile = MG.pxToTile(wpt.x, wpt.y);
      showInfo(selectedTile);
    });
    app.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = s2w(mx, my);
      cam.tzoom = clamp(cam.tzoom * Math.exp(-e.deltaY * 0.0012), minZoom, maxZoom);
      cam.zoom = cam.tzoom;
      var after = s2w(mx, my);
      cam.tx += before.x - after.x;
      cam.ty += before.y - after.y;
      cam.x = cam.tx; cam.y = cam.ty;
    }, { passive: false });
    app.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        drag = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, cx: cam.tx, cy: cam.ty, moved: false };
      } else if (e.touches.length === 2) {
        drag = null;
        this._pinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    app.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (e.touches.length === 1 && drag) {
        var dx = e.touches[0].clientX - drag.sx, dy = e.touches[0].clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          cam.tx = drag.cx - dx / cam.zoom;
          cam.ty = drag.cy - dy / cam.zoom;
          cam.x = cam.tx; cam.y = cam.ty;
        }
      } else if (e.touches.length === 2) {
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        cam.tzoom = clamp(cam.tzoom * d / (this._pinch || d), minZoom, maxZoom);
        this._pinch = d;
        cam.zoom = cam.tzoom;
      }
    }, { passive: false });
    app.addEventListener('touchend', function () { drag = null; });

    var keys = {};
    window.addEventListener('keydown', function (e) { keys[e.key] = true; });
    window.addEventListener('keyup', function (e) { keys[e.key] = false; });
    setInterval(function () {
      var sp = 480 / cam.zoom;
      if (keys.ArrowLeft || keys.a || keys.A) cam.tx -= sp;
      if (keys.ArrowRight || keys.d || keys.D) cam.tx += sp;
      if (keys.ArrowUp || keys.w || keys.W) cam.ty -= sp;
      if (keys.ArrowDown || keys.s || keys.S) cam.ty += sp;
    }, 33);

    els.minimap.addEventListener('mousedown', function (e) {
      var rect = els.minimap.getBoundingClientRect();
      var fx = (e.clientX - rect.left) / rect.width - 0.5;
      var fy = (e.clientY - rect.top) / rect.height - 0.5;
      /* 小地图基准画布 132x88, 每像素 6 世界像素 (与 refreshMinimap 一致) */
      cam.tx = cam.x + fx * 132 * 6;
      cam.ty = cam.y + fy * 88 * 6;
    });

    $('btnRegen').addEventListener('click', function () {
      regenerate(String(Date.now() % 100000000));
    });
    $('btnSeed').addEventListener('click', function () {
      var v = els.seedInput.value.trim();
      if (v) regenerate(v);
    });
    els.seedInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('btnSeed').click();
    });
    $('btnVeins').addEventListener('click', function () {
      showVeins = !showVeins;
      this.classList.toggle('off', !showVeins);
    });
    $('btnLabels').addEventListener('click', function () {
      showLabels = !showLabels;
      this.classList.toggle('off', !showLabels);
    });
    $('infoClose').addEventListener('click', hideInfo);
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    renderer.resize(Math.round(vw * dpr), Math.round(vh * dpr));
    els.overlay.width = Math.round(vw * dpr);
    els.overlay.height = Math.round(vh * dpr);
    els.overlay.style.width = vw + 'px';
    els.overlay.style.height = vh + 'px';
  }

  /* ---------- 主循环 ---------- */
  function loop(t) {
    try {
      timeSec = t / 1000;
      var dt = Math.min((t - lastT) / 1000, 0.1);
      lastT = t;
      cam.x += (cam.tx - cam.x) * Math.min(1, dt * 10);
      cam.y += (cam.ty - cam.y) * Math.min(1, dt * 10);
      cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 10);
      if (Math.abs(cam.tx - cam.x) < 0.1) cam.x = cam.tx;
      if (Math.abs(cam.ty - cam.y) < 0.1) cam.y = cam.ty;
      clampCam();

      /* 道路渐进预热: 绘制帧只读缓存, 新 A* 每 3 帧至多补 1 条;
         相机在平移/缩放期间照常预热, 静止时也不空转 (因区块就绪后 updateStreaming 直接返回) */
      if (warmFrame++ % warmGap === 0) {
        var wct = MG.pxToTile(cam.x, cam.y);
        MG.warmRoadsStep(wct.q, wct.r);
      }

      updateStreaming();
      renderer.render(cam, timeSec);
      drawOverlay();
      minimapTimer += dt;
      /* 节流: 区块生成期间不逐帧重绘小地图 (一次 ~1.2 万格采样), 0.4s 下限 */
      if ((minimapDirty && minimapTimer > 0.4) || minimapTimer > 1.5) {
        refreshMinimap();
        minimapDirty = false;
        minimapTimer = 0;
        updateStats();
      }
      drawMinimap();
    } catch (err) {
      showFatal('渲染循环异常: ' + err.message);
      throw err;
    }
    requestAnimationFrame(loop);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    els = {
      app: $('app'),
      overlay: $('overlay'),
      overlayCtx: $('overlay').getContext('2d'),
      glcanvas: $('glcanvas'),
      minimap: $('minimap'),
      seedInput: $('seedInput'),
      era: $('era'),
      stats: $('stats'),
      info: $('info'),
      infoBody: $('infoBody'),
      seedShow: $('seedShow')
    };

    (function () {
      var html = '';
      for (var i = 0; i < MG.BIOME_META.length; i++) {
        html += '<div class="item"><span class="chip" style="background:' +
          MG.BIOME_META[i].color + '"></span>' + MG.BIOME_META[i].name + '</div>';
      }
      $('legendItems').innerHTML = html;
    })();

    try {
      renderer = new InkRenderer(els.glcanvas);
    } catch (err) {
      showFatal(err.message);
      return;
    }

    var atlas = IT.buildAtlas();
    renderer.setTextures(atlas, IT.buildPaper(), IT.buildNoise());
    renderer.setAvgColors(IT.computeAvgColors(atlas));
    renderer.hexR = MG.HEX_R;
    renderer.seaLevel = MG.SEA_LEVEL;
    renderer.dpr = dpr;   // 世界坐标按 CSS 像素换算, 与相机/流式加载一致

    onResize();
    /* URL 定点预览参数: seed / qt,rt (格坐标定位) / zm (缩放) / nofade (跳过渐入, 供 headless 截图) */
    var urlParams = new URLSearchParams(location.search);
    var urlSeed = urlParams.get('seed');
    regenerate(urlSeed || String(Date.now() % 100000000));
    if (urlParams.get('qt') != null) {
      var wp0 = MG.tileToWorld(+urlParams.get('qt'), +(urlParams.get('rt') || 0));
      cam.tx = cam.x = wp0.x;
      cam.ty = cam.y = wp0.y;
    }
    if (urlParams.get('zm') != null) {
      cam.tzoom = cam.zoom = clamp(parseFloat(urlParams.get('zm')), minZoom, maxZoom);
    }
    renderer.noFade = urlParams.get('nofade') === '1';
    bindInput();

    /* 调试钩子 */
    window.__cam = cam;
    window.__renderer = renderer;
    window.__MapGen = MG;
    window.__snap = function () {
      var c = document.createElement('canvas');
      c.width = els.glcanvas.width;
      c.height = els.glcanvas.height;
      var ctx = c.getContext('2d');
      ctx.drawImage(els.glcanvas, 0, 0);
      ctx.drawImage(els.overlay, 0, 0);
      return c.toDataURL('image/png');
    };
    window.__step = function () {
      updateStreaming();
      renderer.render(cam, timeSec || 1);
      drawOverlay();
      refreshMinimap();
      drawMinimap();
    };

    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
