/* ============================================================
 * main.js — 山河图主程序 (服务端权威数据驱动版)
 *  - 区块流式加载: 向后端 /api/map/chunk 拉取 → 解码 → 上传 GPU
 *  - 覆盖层: 道路/聚落/区域/灵脉/浪线 全部基于后端下发数据绘制
 *  - 小地图字段采样 / 点击格详情: 后端即时计算
 *  - 前端不再执行任何地图生成/噪声/寻路判定
 * ============================================================ */
(function () {
  'use strict';
  var MC = MapClient, IT = InkTextures;

  var els = {};
  var renderer = null;
  var worldSeed = '';
  var metaReady = false;
  var geo = null;

  var cam = { x: 0, y: 0, zoom: 2.2, tx: 0, ty: 0, tzoom: 2.2 };
  var minZoom = 0.7, maxZoom = 6;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var hoverTile = null, selectedTile = null;
  var showVeins = true, showLabels = true;

  var chunkData = new Map();        // key -> {arrays, bbox}
  var regionCells = new Map();      // 'i,j' -> RegionPack
  var commCells = new Map();        // 'ci,cj' -> CommunityPack
  var chunkQueue = [], chunkBusy = new Map(), chunkFail = new Set();
  var regionBusy = new Set(), commBusy = new Set();
  var regionQueue = [], commQueue = [];
  var CONC_CHUNK = 3, CONC_EXTRA = 6;

  var timeSec = 0, lastT = 0;
  var minimapDirty = true, minimapTimer = 0;
  var mmReq = null, mmData = null;      // 小地图网格请求/数据
  var mmInFlight = false;               // 同窗口去重, 避免狂发同窗口请求

  /* ---------- 静态覆盖层缓存 ---------- */
  var staticLayer = null;
  var staticCam = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };
  var staticDirty = true;
  var lastPan = { x: 0, y: 0, zoom: 0 };

  function $(id) { return document.getElementById(id); }
  function chunkKey(ca, cb) { return ca + ',' + cb; }
  function cellKey(a, b) { return a + ',' + b; }

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

  /* ---------- 区块流式加载 (后端权威) ---------- */
  function tileBoundsOf(b, padTiles) {
    var c0 = MC.pxToTile(b.x0, b.y0), c1 = MC.pxToTile(b.x1, b.y1),
        c2 = MC.pxToTile(b.x0, b.y1), c3 = MC.pxToTile(b.x1, b.y0);
    var qmin = Math.min(c0.q, c1.q, c2.q, c3.q) - padTiles;
    var qmax = Math.max(c0.q, c1.q, c2.q, c3.q) + padTiles;
    var rmin = Math.min(c0.r, c1.r, c2.r, c3.r) - padTiles;
    var rmax = Math.max(c0.r, c1.r, c2.r, c3.r) + padTiles;
    return { qmin: qmin, qmax: qmax, rmin: rmin, rmax: rmax };
  }

  function updateStreaming() {
    var b = viewBounds();
    var t = tileBoundsOf(b, 2);
    /* 视野区域/群落格窗口 */
    var M = geo.regionM, CL = geo.commCl;
    var i0 = Math.floor(t.qmin / M) - 1, i1 = Math.floor(t.qmax / M) + 1;
    var j0 = Math.floor(t.rmin / M) - 1, j1 = Math.floor(t.rmax / M) + 1;
    var ci0 = Math.floor(t.qmin / CL) - 1, ci1 = Math.floor(t.qmax / CL) + 1;
    var cj0 = Math.floor(t.rmin / CL) - 1, cj1 = Math.floor(t.rmax / CL) + 1;

    /* 卸载视野外 (区块 + 区域/群落数据) */
    var keepR = new Set(), keepC = new Set();
    for (var ri = i0; ri <= i1; ri++) for (var rj = j0; rj <= j1; rj++) keepR.add(cellKey(ri, rj));
    for (var ui = ci0; ui <= ci1; ui++) for (var uj = cj0; uj <= cj1; uj++) keepC.add(cellKey(ui, uj));
    regionCells.forEach(function (_p, k) { if (!keepR.has(k)) regionCells.delete(k); });
    commCells.forEach(function (_p, k) { if (!keepC.has(k)) commCells.delete(k); });

    /* 区块 need 集合 */
    var pad = geo.hexW * 2;
    var tb = tileBoundsOf(
      { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, 0);
    var m2 = geo.chunkScan + geo.chunkS;
    var a0 = Math.floor((tb.qmin - m2) / geo.chunkS), a1 = Math.floor((tb.qmax + m2) / geo.chunkS);
    var b0 = Math.floor((tb.rmin - m2) / geo.chunkS), b1 = Math.floor((tb.rmax + m2) / geo.chunkS);
    var need = {};
    for (var ca = a0; ca <= a1; ca++) {
      for (var cb = b0; cb <= b1; cb++) need[chunkKey(ca, cb)] = { ca: ca, cb: cb };
    }
    chunkData.forEach(function (_info, key) {
      if (!need[key]) {
        renderer.dropChunk(key);
        chunkData.delete(key);
        staticDirty = true;
      }
    });

    /* 队列重建: 未加载 && 未在途 && 未失败, 距相机排序 */
    chunkQueue.length = 0;
    for (var key in need) {
      if (!chunkData.has(key) && !chunkBusy.has(key) && !chunkFail.has(key)) {
        var cc = need[key];
        var w = MC.tileToWorld(cc.ca * geo.chunkS, cc.cb * geo.chunkS);
        var d = (w.x - cam.x) * (w.x - cam.x) + (w.y - cam.y) * (w.y - cam.y);
        chunkQueue.push({ ca: cc.ca, cb: cc.cb, key: key, d: d });
      }
    }
    chunkQueue.sort(function (p, q) { return p.d - q.d; });
    pumpChunks();

    /* 区域/群落: 视野窗口格数据补齐 */
    regionQueue.length = 0;
    for (var ri2 = i0; ri2 <= i1; ri2++) {
      for (var rj2 = j0; rj2 <= j1; rj2++) {
        var rk = cellKey(ri2, rj2);
        if (!regionCells.has(rk) && !regionBusy.has(rk))
          regionQueue.push({ i: ri2, j: rj2, key: rk });
      }
    }
    pumpExtra(regionQueue, regionBusy, 'region');
    commQueue.length = 0;
    for (var ui2 = ci0; ui2 <= ci1; ui2++) {
      for (var uj2 = cj0; uj2 <= cj1; uj2++) {
        var ck = cellKey(ui2, uj2);
        if (!commCells.has(ck) && !commBusy.has(ck))
          commQueue.push({ ci: ui2, cj: uj2, key: ck });
      }
    }
    pumpExtra(commQueue, commBusy, 'comm');
  }

  /* 单个区块请求的生命周期独立成函数: job 必须被本次请求闭包独占。
     (此前 var job 在 while 循环里被所有并发回调共享, 回调里读到的永远是
      最后一个 job → chunkBusy 只删掉最后一个 key, 前两个 key 永久卡死,
      对应区块永不重试 → 屏幕中心出现菱形黑区。) */
  function loadChunk(job) {
    var gen = worldSeed;
    MC.chunk(gen, job.ca, job.cb).then(function (arrays) {
      if (gen !== worldSeed) return;                 // 世界已重铸, 丢弃旧响应
      if (!chunkData.has(job.key)) {
        renderer.uploadChunk(job.key, arrays);
        var bb = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
        var ct = arrays.centers;
        for (var i = 0; i < arrays.count; i++) {
          var x = ct[i * 2], y = ct[i * 2 + 1];
          if (x < bb.x0) bb.x0 = x; if (x > bb.x1) bb.x1 = x;
          if (y < bb.y0) bb.y0 = y; if (y > bb.y1) bb.y1 = y;
        }
        chunkData.set(job.key, { arrays: arrays, bbox: bb });
        minimapDirty = true;
        staticDirty = true;                          // 浪线等随新区块补齐
      }
    }).catch(function (err) {
      chunkFail.add(job.key);                        // 失败不再空转重试
      console.error('chunk 加载失败', job.key, err);
    }).then(function () {
      if (gen !== worldSeed) return;                 // 旧世界请求不动新世界的 busy 集
      chunkBusy.delete(job.key);
      pumpChunks();
    });
  }

  function pumpChunks() {
    while (chunkBusy.size < CONC_CHUNK && chunkQueue.length) {
      var job = chunkQueue.shift();
      if (chunkData.has(job.key) || chunkBusy.has(job.key) || chunkFail.has(job.key)) continue;
      chunkBusy.set(job.key, true);
      loadChunk(job);
    }
  }

  /* 区域/群落请求同样独立成函数 (与 loadChunk 同因: 共享 var 会互相踩 key) */
  function loadExtra(job, busy, kind) {
    var gen = worldSeed;
    var p = kind === 'region'
      ? MC.region(gen, job.i, job.j)
      : MC.comm(gen, job.ci, job.cj);
    p.then(function (pack) {
      if (gen !== worldSeed) return;
      if (kind === 'region') regionCells.set(job.key, pack);
      else commCells.set(job.key, pack);
      staticDirty = true;
    }).catch(function (err) {
      console.error(kind + ' 加载失败', job.key, err);
    }).then(function () {
      if (gen !== worldSeed) return;
      busy.delete(job.key);
    });
  }

  function pumpExtra(queue, busy, kind) {
    var launches = 0;
    while (busy.size < CONC_EXTRA && queue.length && launches < CONC_EXTRA) {
      var job = queue.shift();
      if (busy.has(job.key)) continue;
      var loaded = kind === 'region' ? regionCells.has(job.key) : commCells.has(job.key);
      if (loaded) continue;
      busy.add(job.key);
      launches++;
      loadExtra(job, busy, kind);
    }
  }

  /* ---------- 聚落图标 (Canvas2D 白描, 原样保留) ---------- */
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
  var TYPE_NAME = { sect: '宗门', city: '仙城', town: '坊市', village: '村落', poi: '秘境' };
  var VEIN_EL = ['金', '木', '水', '火', '土'];

  /* ---------- 小地图 (字段网格由后端采样) ---------- */
  var mmBase = null;
  function requestMinimap() {
    var W = 132, H = 88, SCALE = 6;
    var x0 = cam.x - W / 2 * SCALE, y0 = cam.y - H / 2 * SCALE;
    var x1 = cam.x + W / 2 * SCALE, y1 = cam.y + H / 2 * SCALE;
    var a = MC.pxToTile(x0, y0), b = MC.pxToTile(x1, y1);
    var c = MC.pxToTile(x0, y1), d = MC.pxToTile(x1, y0);
    var q0 = Math.min(a.q, b.q, c.q, d.q), q1 = Math.max(a.q, b.q, c.q, d.q);
    var r0 = Math.min(a.r, b.r, c.r, d.r), r1 = Math.max(a.r, b.r, c.r, d.r);
    var gen = worldSeed, req = { q0: q0, q1: q1, r0: r0, r1: r1, gen: gen };
    mmInFlight = true;
    MC.fieldGrid(gen, q0, q1, r0, r1).then(function (grid) {
      if (req.gen !== worldSeed) return;
      mmData = grid;
      minimapDirty = true;             // 数据就绪, 下一帧绘制
    }).catch(function (err) { console.error('小地图采样失败', err); })
      .then(function () { mmInFlight = false; });
  }
  function refreshMinimap() {
    var W = 132, H = 88, SCALE = 6;
    if (!mmBase) mmBase = document.createElement('canvas');
    mmBase.width = W; mmBase.height = H;
    var ctx = mmBase.getContext('2d');
    var img = ctx.createImageData(W, H);
    var colCache = {};
    for (var py = 0; py < H; py++) {
      for (var px = 0; px < W; px++) {
        var wx = cam.x + (px - W / 2) * SCALE;
        var wy = cam.y + (py - H / 2) * SCALE;
        var t = MC.pxToTile(wx, wy);
        var disp = -1;
        if (mmData && t.q >= mmData.q0 && t.q <= mmData.q1 && t.r >= mmData.r0 && t.r <= mmData.r1) {
          disp = mmData.data[(t.r - mmData.r0) * mmData.nq + (t.q - mmData.q0)];
        }
        var col = colCache[disp] || (colCache[disp] = disp < 0 ? '#b9ad92'
          : (geo.biomeMeta[disp] || { color: '#b9ad92' }).color);
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
    bctx.strokeStyle = 'rgba(166,58,44,0.95)';
    bctx.lineWidth = 2;
    bctx.strokeRect(mw / 2 - 3, mh / 2 - 3, 6, 6);
    bctx.fillStyle = 'rgba(50,42,34,0.7)';
    bctx.font = '10px "KaiTi","STKaiti",serif';
    bctx.textAlign = 'left';
    bctx.fillText('方圆百里', 6, mh - 6);
  }

  /* ---------- 标注层: 全部基于后端数据绘制 ---------- */
  function staticNeedsRedraw(vw, vh) {
    if (staticDirty) return true;
    var scale = 18 / (cam.zoom * 0.75 + 0.25);
    if (Math.abs(cam.x - staticCam.x) > scale) return true;
    if (Math.abs(cam.y - staticCam.y) > scale) return true;
    if (Math.abs(cam.zoom - staticCam.zoom) > 0.02) return true;
    if (vw !== staticCam.w || vh !== staticCam.h) return true;
    return false;
  }

  /* 逐块浪线 (数据来自已加载区块的 tiles/hashes/centers/neigh) */
  function drawChunkWaves(ctx, b) {
    var pad = 24;
    var w0 = MC.pxToTile(b.x0 - pad, b.y0 - pad), w1 = MC.pxToTile(b.x1 + pad, b.y1 + pad),
        w2 = MC.pxToTile(b.x0 - pad, b.y1 + pad), w3 = MC.pxToTile(b.x1 + pad, b.y0 - pad);
    var qmin = Math.min(w0.q, w1.q, w2.q, w3.q), qmax = Math.max(w0.q, w1.q, w2.q, w3.q);
    var rmin = Math.min(w0.r, w1.r, w2.r, w3.r), rmax = Math.max(w0.r, w1.r, w2.r, w3.r);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    chunkData.forEach(function (info) {
      var bb = info.bbox;
      if (bb.x1 < b.x0 - pad || bb.x0 > b.x1 + pad || bb.y1 < b.y0 - pad || bb.y0 > b.y1 + pad) return;
      var d = info.arrays, centers = d.centers, tiles = d.tiles, hashes = d.hashes, neigh = d.neigh;
      for (var i = 0; i < d.count; i++) {
        var biome = (tiles[i] / 4) | 0;
        if (biome > 1) continue;
        var wfq = Math.round((centers[i * 2] / geo.hexW) - (centers[i * 2 + 1] / (1.5 * geo.hexR)) / 2);
        var wfr = Math.round(centers[i * 2 + 1] / (1.5 * geo.hexR));
        if (wfq < qmin || wfq > qmax || wfr < rmin || wfr > rmax) continue;
        var hh = hashes[i];
        var fr1 = (hh * 913.7) % 1, fr2 = (hh * 517.3) % 1, fr3 = (hh * 271.1) % 1;
        var nearLand = false;
        if (biome === 1) {
          var nv = neigh[i];
          for (var wn = 0; wn < 6; wn++) {
            var nb = Math.floor(nv / Math.pow(8, wn)) % 8;
            if (nb > 1) { nearLand = true; break; }
          }
        }
        var hx = centers[i * 2], hy = centers[i * 2 + 1];
        if (nearLand) {
          var mcx = hx + (fr1 - 0.5) * geo.hexW * 0.8;
          var mcy = hy + (fr2 - 0.5) * geo.hexR * 0.8;
          var mr = geo.hexW * (0.20 + fr3 * 0.15);
          ctx.strokeStyle = 'rgba(126,152,150,' + (0.22 + fr2 * 0.10).toFixed(2) + ')';
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.arc(mcx, mcy, mr, Math.PI * 1.02 + fr1 * 0.8, Math.PI * 1.72 + fr1 * 0.8);
          ctx.stroke();
          ctx.fillStyle = 'rgba(226,236,232,' + (0.20 + fr3 * 0.14).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(mcx + mr * 1.25, mcy + 1.8, 0.8, 0, Math.PI * 2); ctx.fill();
          continue;
        }
        if (hh >= (biome === 0 ? 0.30 : 0.46)) continue;
        var wx0 = hx + (fr1 - 0.5) * geo.hexW * 1.2;
        var wy0 = hy + (fr2 - 0.5) * geo.hexR * 1.2;
        var wl = geo.hexW * (1.1 + fr3 * 1.5);
        var wtilt = (fr1 - 0.5) * 0.25;
        ctx.strokeStyle = 'rgba(64,94,104,' + (0.16 + fr2 * 0.10).toFixed(2) + ')';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(wx0 - wl * 0.5, wy0 + wtilt * wl * 0.5);
        ctx.quadraticCurveTo(wx0 - wl * 0.1, wy0 - wl * 0.13, wx0 + wl * 0.12, wy0 - wl * 0.02);
        ctx.quadraticCurveTo(wx0 + wl * 0.32, wy0 + wl * 0.06, wx0 + wl * 0.5, wy0 + wtilt * wl * 0.3);
        ctx.stroke();
        if (fr3 > 0.55) {
          ctx.strokeStyle = 'rgba(70,100,110,' + (0.10 + fr2 * 0.06).toFixed(2) + ')';
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(wx0 - wl * 0.16, wy0 + 2.4);
          ctx.quadraticCurveTo(wx0 + wl * 0.06, wy0 + 1.2, wx0 + wl * 0.26, wy0 + 2.6);
          ctx.stroke();
        }
      }
    });
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

    ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
      dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
      dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
    var z = cam.zoom;

    /* 浪线 (基于区块数据, 无动画) */
    drawChunkWaves(ctx, b);

    /* 道路 (后端 A* 路径点) */
    var haloV = [], coreV = [];
    function pushSeg(arr, ax, ay, bx, by, w) {
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var nx = -dy / len * w * 0.5, ny = dx / len * w * 0.5;
      arr.push(ax - nx, ay - ny, bx + nx, by + ny, ax + nx, ay + ny,
               ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny);
    }
    var drawn = {};
    regionCells.forEach(function (pack) {
      for (var rr = 0; rr < pack.roads.length; rr++) {
        var road = pack.roads[rr];
        if (drawn[road.key]) continue;
        drawn[road.key] = true;
        if (road.x1 < b.x0 - 200 || road.x0 > b.x1 + 200 ||
            road.y1 < b.y0 - 200 || road.y0 > b.y1 + 200) continue;
        var pts = road.pts;
        var rh = 0;
        for (var kc = 0; kc < road.key.length; kc++) rh = (rh * 31 + road.key.charCodeAt(kc)) % 997;
        var wBase = 1.4 + (rh / 997) * 1.5;
        for (var p2 = 0; p2 < pts.length / 2 - 1; p2++) {
          var segH = Math.sin(p2 * 12.9898 + rh * 0.7853) * 43758.5453;
          var wob = segH - Math.floor(segH);
          var wm = wBase * (0.60 + 0.8 * wob);
          pushSeg(haloV, pts[p2 * 2], pts[p2 * 2 + 1], pts[p2 * 2 + 2], pts[p2 * 2 + 3], wm * 2.4);
          pushSeg(coreV, pts[p2 * 2], pts[p2 * 2 + 1], pts[p2 * 2 + 2], pts[p2 * 2 + 3], Math.max(1.0, wm));
        }
      }
    });
    renderer.setRoads(new Float32Array(haloV), new Float32Array(coreV));

    /* 灵脉: 七星花 + 群落灵气晕圈 (后端群落数据) */
    var veinLabels = [];
    if (showVeins) {
      commCells.forEach(function (cm) {
        if (!cm.exists) return;
        var cRGB = cm.elementRGB || (cm.elementRGB = geoElementColor(cm.element));
        var auraR = geo.commR * geo.hexW * 1.15;
        var cS = cRGB[0] + ',' + cRGB[1] + ',' + cRGB[2];
        var ag = ctx.createRadialGradient(cm.x, cm.y, auraR * 0.06, cm.x, cm.y, auraR);
        ag.addColorStop(0, 'rgba(' + cS + ',0.085)');
        ag.addColorStop(0.6, 'rgba(' + cS + ',0.035)');
        ag.addColorStop(1, 'rgba(' + cS + ',0)');
        ctx.fillStyle = ag;
        ctx.beginPath(); ctx.arc(cm.x, cm.y, auraR, 0, Math.PI * 2); ctx.fill();
        for (var vv = 0; vv < cm.veins.length; vv++) {
          var v = cm.veins[vv];
          var rgb = v.variant ? geoVariantColor(v.variant) : cRGB;
          IT.drawVeinFlower(ctx, v.x, v.y, null, rgb, { level: v.level });
          veinLabels.push({ x: v.x, y: v.y, name: v.name + '灵脉（' + ['大', '中', '小'][v.level] + '）', rgb: rgb, level: v.level });
        }
      });
    }

    /* ---- 屏幕坐标系 ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var vw = els.app.clientWidth, vh = els.app.clientHeight;

    if (showLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      regionCells.forEach(function (pack) {
        var rg = pack.region;
        var ps = w2s(rg.x, rg.y);
        if (ps.x < -200 || ps.y < -100 || ps.x > vw + 200 || ps.y > vh + 100) return;
        var fs = Math.max(Math.sqrt(geo.regionM * geo.regionM) * 0.75, 12) * z;
        ctx.font = fs + 'px "KaiTi","STKaiti",serif';
        ctx.fillStyle = rg.biome <= 1 ? 'rgba(52,66,72,0.28)' : 'rgba(58,48,38,0.26)';
        ctx.fillText(rg.name, ps.x, ps.y);
      });
    }

    /* 灵脉名牌 */
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

    /* 聚落图标 + 名牌 */
    var zoomClamp = Math.max(z, 0.55);
    regionCells.forEach(function (pack) {
      var sts = pack.settlements;
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
    });

    staticCam.x = cam.x; staticCam.y = cam.y;
    staticCam.zoom = cam.zoom; staticCam.w = els.app.clientWidth; staticCam.h = els.app.clientHeight;
    staticDirty = false;
  }

  function geoElementColor(el) {
    return [[196, 176, 120], [104, 140, 86], [86, 116, 142], [176, 72, 50], [152, 120, 82]][el] || [150, 130, 100];
  }
  function geoVariantColor(name) {
    var V = { 雷: [142, 96, 190], 风: [118, 150, 148], 冰: [136, 168, 192], 暗: [96, 84, 110] };
    return V[name] || [150, 130, 100];
  }

  function drawOverlay() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    if (staticNeedsRedraw(vw, vh)) renderStaticInto();
    var ctx = els.overlayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    if (staticLayer && Math.abs(cam.zoom - staticCam.zoom) < 0.02) {
      var sdx = dpr * cam.zoom * (staticCam.x - cam.x);
      var sdy = dpr * cam.zoom * (staticCam.y - cam.y);
      ctx.drawImage(staticLayer, sdx, sdy);
    } else if (staticLayer) {
      ctx.drawImage(staticLayer, 0, 0);
    }
    function hexHi(t, alpha, pulse) {
      if (!t) return;
      var w = MC.tileToWorld(t.q, t.r);
      ctx.save();
      ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
        dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
        dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
      ctx.strokeStyle = 'rgba(48,36,24,' + alpha + ')';
      ctx.lineWidth = pulse ? 5 : 3.4;
      hexPath(ctx, w.x, w.y, geo.hexR * 0.94);
      ctx.stroke();
      ctx.restore();
    }
    hexHi(hoverTile, 0.7, false);
    hexHi(selectedTile, 0.95, true);
  }

  /* ---------- 相机 ---------- */
  function clampCam() {
    cam.tzoom = MC.clamp(cam.tzoom, minZoom, maxZoom);
  }

  /* ---------- 信息面板 (后端单格详情) ---------- */
  var panelBusy = false;
  function showInfo(tile) {
    if (!tile || panelBusy) return;
    panelBusy = true;
    els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">参详中…</span></div>';
    els.info.classList.remove('hidden');
    var gen = worldSeed, q = tile.q, r = tile.r;
    MC.tile(gen, q, r).then(function (m) {
      panelBusy = false;
      if (gen !== worldSeed) return;
      var rows = [];
      if (m.placeType) {
        rows.push('<div class="row"><span class="k">所在</span><span class="v">' + TYPE_NAME[m.placeType] + '</span></div>');
        rows.push('<div class="row"><span class="k">名号</span><span class="v big">' + m.placeName + '</span></div>');
        if (m.placeType !== 'poi') rows.push('<div class="row"><span class="k">生民</span><span class="v">约 ' + m.placePop.toLocaleString() + ' 口</span></div>');
        else rows.push('<div class="row"><span class="k">气数</span><span class="v">机缘未至, 探之莫测</span></div>');
        rows.push('<div class="sep"></div>');
      }
      rows.push('<div class="row"><span class="k">地界</span><span class="v">' + m.regionName + '</span></div>');
      rows.push('<div class="row"><span class="k">地貌</span><span class="v">' + (geo.biomeMeta[m.disp] || {}).name + '</span></div>');
      rows.push('<div class="row"><span class="k">位次</span><span class="v">' +
        (q < 0 ? '西 ' + (-q) : '东 ' + q) + ' · ' + (r < 0 ? '北 ' + (-r) : '南 ' + r) + '</span></div>');
      if (m.hasVein) {
        rows.push('<div class="sep"></div>');
        rows.push('<div class="row"><span class="k">灵脉</span><span class="v big">' + m.veinName + '</span></div>');
        rows.push('<div class="row"><span class="k">灵根</span><span class="v">' +
          (m.veinVariant ? m.veinVariant + '灵根 · 派自' + VEIN_EL[m.veinElement]
                         : VEIN_EL[m.veinElement] + '灵根') + '</span></div>');
        rows.push('<div class="row"><span class="k">位份</span><span class="v">' +
          (m.veinLevel === 0 ? '大灵脉·七星' : m.veinLevel === 1 ? '中灵脉·七星' : '独立小灵脉') + '</span></div>');
      }
      rows.push('<div class="row"><span class="k">海拔</span><span class="v">' + (m.e * 300 | 0) + ' 丈</span></div>');
      rows.push('<div class="row"><span class="k">润泽</span><span class="v">' + (m.m * 100 | 0) + '%</span></div>');
      var wd = m.waterD;
      rows.push('<div class="row"><span class="k">去水</span><span class="v">' +
        (m.biome <= 1 ? '滨水' : wd >= 1 && wd <= 4 ? wd + ' 里' : '较远') + '</span></div>');
      if (m.onRoad) rows.push('<div class="row"><span class="k">道路</span><span class="v">有墨路经此</span></div>');
      els.infoBody.innerHTML = rows.join('');
    }).catch(function (err) {
      panelBusy = false;
      console.error('格详情失败', err);
      els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">未察明</span></div>';
    });
  }
  function hideInfo() { els.info.classList.add('hidden'); }

  /* ---------- 世界重建 ---------- */
  function seedEra(seedStr) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    var gan = '甲乙丙丁戊己庚辛壬癸'.charAt(h % 10);
    var zhi = '子丑寅卯辰巳午未申酉戌亥'.charAt((h >>> 3) % 12);
    var season = '春夏秋冬'.charAt((h >>> 7) % 4);
    els.era.textContent = '岁次' + gan + zhi + ' · ' + season;
  }

  function regenerate(seedString) {
    worldSeed = String(seedString);
    chunkData.forEach(function (_info, key) { renderer.dropChunk(key); });
    chunkData.clear();
    regionCells.clear();
    commCells.clear();
    chunkQueue.length = 0;
    chunkFail.clear();
    chunkBusy.clear();                // 旧世界在途回调带 gen 守卫, 不会误删新世界标记
    regionBusy.clear();
    commBusy.clear();
    mmData = null;
    hoverTile = null;
    selectedTile = null;
    cam.tx = cam.x = 0;
    cam.ty = cam.y = 0;
    cam.tzoom = cam.zoom = 2.2;
    els.seedInput.value = worldSeed;
    els.seedShow.textContent = worldSeed;
    seedEra(worldSeed);
    hideInfo();
    minimapDirty = true;
    staticDirty = true;
  }

  function updateStats() {
    var st = 0, rd = 0, veins = 0;
    regionCells.forEach(function (pack) {
      st += pack.settlements.length;
      rd += pack.roads.length;
    });
    commCells.forEach(function (cm) { if (cm.exists) veins += cm.veins.length; });
    els.stats.textContent = '已探明 宗门村镇 ' + st + ' · 墨路 ' + rd + ' · 灵脉 ' + veins;
  }

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
        hoverTile = MC.pxToTile(w.x, w.y);
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
      selectedTile = MC.pxToTile(wpt.x, wpt.y);
      showInfo(selectedTile);
    });
    app.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = s2w(mx, my);
      cam.tzoom = MC.clamp(cam.tzoom * Math.exp(-e.deltaY * 0.0012), minZoom, maxZoom);
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
        cam.tzoom = MC.clamp(cam.tzoom * d / (this._pinch || d), minZoom, maxZoom);
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
  var frame = 0;
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

      if (metaReady) updateStreaming();
      renderer.render(cam, timeSec);
      drawOverlay();
      minimapTimer += dt;
      if ((minimapDirty && minimapTimer > 0.4) || minimapTimer > 1.5) {
        minimapTimer = 0;
        updateStats();
        if (minimapDirty && !mmInFlight) requestMinimap();
        if (mmData) { refreshMinimap(); minimapDirty = false; }
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

    try {
      renderer = new InkRenderer(els.glcanvas);
    } catch (err) {
      showFatal(err.message);
      return;
    }
    var atlas = IT.buildAtlas();
    renderer.setTextures(atlas, IT.buildPaper(), IT.buildNoise());
    renderer.setAvgColors(IT.computeAvgColors(atlas));
    renderer.dpr = dpr;
    renderer.noFade = new URLSearchParams(location.search).get('nofade') === '1';
    onResize();

    MC.fetchMeta().then(function (m) {
      metaReady = true;
      geo = MC.geo();
      renderer.hexR = geo.hexR;
      renderer.seaLevel = geo.seaLevel;
      console.log('[zongmen] meta 就绪 hexW=' + geo.hexW.toFixed(3) + ' chunkS=' + geo.chunkS);
      /* 图例 */
      var html = '';
      for (var i = 0; i < m.biomeMeta.length; i++) {
        html += '<div class="item"><span class="chip" style="background:' +
          m.biomeMeta[i].color + '"></span>' + m.biomeMeta[i].name + '</div>';
      }
      $('legendItems').innerHTML = html;

      var urlParams = new URLSearchParams(location.search);
      var urlSeed = urlParams.get('seed');
      regenerate(urlSeed || String(Date.now() % 100000000));
      if (urlParams.get('qt') != null) {
        var wp0 = MC.tileToWorld(+urlParams.get('qt'), +(urlParams.get('rt') || 0));
        cam.tx = cam.x = wp0.x;
        cam.ty = cam.y = wp0.y;
      }
      if (urlParams.get('zm') != null) {
        cam.tzoom = cam.zoom = MC.clamp(parseFloat(urlParams.get('zm')), minZoom, maxZoom);
      }
      bindInput();

      window.__cam = cam;
      window.__renderer = renderer;
      window.__data = function () { return { chunks: chunkData.size, regions: regionCells.size, comms: commCells.size }; };

      /* 调试钩子: capture=1 时, 4s 后把 canvas 合成图回传后端, 用于 headless 截图验证 */
      if (new URLSearchParams(location.search).get('capture') === '1') {
        setTimeout(function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = els.app.clientWidth;
            canvas.height = els.app.clientHeight;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(els.glcanvas, 0, 0, canvas.width, canvas.height);
            ctx.drawImage(els.overlay, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (b) {
              if (!b) return;
              fetch('/api/debug/snap', { method: 'POST', body: b }).catch(console.error);
            }, 'image/png');
          } catch (e) { console.error(e); }
        }, 4000);
      }

      requestAnimationFrame(loop);
    }).catch(function (err) {
      console.error('[zongmen] meta 获取失败', err);
      showFatal('后端世界服务不可用: ' + err.message +
        ' — 请先启动 Server/Zongmen (端口见 appsettings.json)');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
