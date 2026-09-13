/* ============================================================
 * main.js — 山河图主程序 (WebSocket 单块流式版)
 *  - 单块流式加载: 视野切块 → ws TileRequest → TileResponse 多图层
 *    子消息 (chunk/region/settle/poi/comm) 分发 (设计 §三)
 *  - 覆盖层: 道路/聚落/景点/区域/灵脉/浪线 全部基于后端下发数据绘制
 *  - 小地图字段采样 / 点击格详情: HTTP 后端即时计算
 *  - 前端不再执行任何地图生成/噪声/寻路判定
 * ============================================================ */
(function () {
  'use strict';
  var MC = MapClient, IT = InkTextures, PB = window.PB;

  var els = {};
  var renderer = null;
  var worldSeed = '';
  var metaReady = false;
  var geo = null;

  var cam = { x: 0, y: 0, zoom: 2.2, tx: 0, ty: 0, tzoom: 2.2 };
  var minZoom = 0.7, maxZoom = 6;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  /* R10: 调试句柄门控 —— 仅 URL 带 debug=1 (或 capture=1 的 headless 验证) 时暴露,
     平时不向全局泄漏内部状态。 */
  var DEBUG = new URLSearchParams(location.search).get('debug') === '1' ||
              new URLSearchParams(location.search).get('capture') === '1';
  var hoverTile = null, selectedTile = null;
  var showVeins = true, showLabels = true;
  /* 建筑层开关 (headless 视觉验证用, 与 nofade/capture 同族):
     nobldg=1 → 不画建筑层, 同机位可与开启态做逐像素 A/B, 判定
     「建筑确实画上去了 / 画在哪里」。日常游玩不传此参数。 */
  var NO_BLDG = new URLSearchParams(location.search).get('nobldg') === '1';

  /* ---------- 宗门录 (左上角水墨面板) ----------
     数据源: 地图实体层 settleCells 中 type==='sect' 的实体 (id/name/pop/tier/
     styleName/buildings/resources), 不新增任何后端契约。
     「掌门」一栏: 后端 mapgen 尚无归属系统 (owner 恒为空串, 见 mapgen.js 注释),
     故由 seed+sect.id 确定性派生一个道号作演示 —— 事件系统接入后改为直接读 owner。 */
  var sect = { auto: true, pinId: '', curId: '', cur: null, items: [] };

  var chunkData = new Map();        // 'ca,cb' -> {arrays, bbox}
  var regionCells = new Map();      // 'i,j'  -> {region, roads}   (图层1: 区域名+道路)
  var commCells = new Map();        // 'ci,cj'-> CommunityPack     (图层4: 灵脉群落)
  /* 图层2/3 动态实体 (设计 §二): 按 key '区域i,j' 分组缓存, 与服务端
     EntityGroup 键一致 → 邻块重复携带同一区域时以键覆盖去重 */
  var settleCells = new Map();      // 'i,j' -> [PlaceEntity]  聚落实体
  var poiCells = new Map();         // 'i,j' -> [PlaceEntity]  景点实体
  var chunkQueue = [], chunkBusy = new Map();
  var chunkRetry = new Map();   // key -> { attempt, at }: 可重试失败(网络/超时)的退避计划, at 为下次可入队时间
  /* R12: 并发/重试等网络常数收敛到单一配置对象, 不再散落魔法数字 */
  var NET_CFG = {
    concChunk: 4,          // 单块 WebSocket 并发请求数
    retryBaseMs: 800,      // 失败重试指数退避基数
    retryMaxMs: 30000      // 单次退避上限
  };
  /* R4: 当前视野窗口内的 chunk/region/comm key 集合 (updateStreaming 全量重建时
     刷新; 异步回调落库前据此校验, 防止把已卸载格子数据回填/重复上传 GPU) */
  var keepChunk = new Set(), keepR = new Set(), keepC = new Set();

  var timeSec = 0, lastT = 0;
  var frameCount = 0;              // 渲染帧计数 (capture=1 截图须等「数据到达后至少渲染过一帧」)
  var minimapDirty = true, minimapTimer = 0, mmDrawTimer = 0, mmBoxDirty = true;
  var mmReq = null, mmData = null;      // 小地图网格请求/数据
  var mmInFlight = false;               // 同窗口去重, 避免狂发同窗口请求
  var mmCam = { x: NaN, y: NaN };       // 上次真正绘制小地图位图时的相机位置 (D3/D16)

  /* ---------- 静态覆盖层缓存 ---------- */
  var staticLayer = null;
  var staticCam = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };
  var staticDirty = true;
  /* R1: 静态层 dirty 200ms 节流合并 —— 连续加载 N 个 chunk/区域/群落时,
     各上传回调不再逐一置 staticDirty(每帧全量重绘 N 次), 而是合并到
     最后一次标记后 200ms 统一重绘一次。 */
  var staticSchedTimer = null;
  var lastStaticDraw = 0;          // performance.now() 上次静态层重绘时刻
  /* T7: 道路几何缓存 — 路网顶点只依赖 regionCells 数据 (世界坐标, 与相机无关),
     平移/缩放触发的静态层重绘不再重复重建顶点 + 重传 GPU;
     仅在新区域数据到达 / 世界重铸时置脏重建一次。 */
  var roadsDirty = true;

  /* 数据到达类脏标记(浪线/地名/道路补齐): 距上次重绘 <200ms 时延迟合并,
     已 ≥200ms 或 staticDirty 已挂起则立即置位由下一帧消费 */
  function markStaticDirty() {
    if (staticDirty) return;
    var now = performance.now();
    if (now - lastStaticDraw >= 200 || lastStaticDraw === 0) { staticDirty = true; return; }
    if (staticSchedTimer) return;
    staticSchedTimer = setTimeout(function () {
      staticSchedTimer = null;
      staticDirty = true;          // 下一帧 staticNeedsRedraw 消费
    }, 200);
  }
  /* 卸载/重铸等必须尽快消除残影的置位: 不节流 */
  function forceStaticDirty() {
    if (staticSchedTimer) { clearTimeout(staticSchedTimer); staticSchedTimer = null; }
    staticDirty = true;
  }
  var lastPan = { x: 0, y: 0, zoom: 0 };
  /* P1: 流式需求集增量阈值 —— 记录上次全量重算时的相机状态,
     NaN 初始值强制首帧重算; regenerate() 时重置回 NaN。 */
  var lastStream = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };

  function $(id) { return document.getElementById(id); }
  function chunkKey(ca, cb) { return ca + ',' + cb; }
  function cellKey(a, b) { return a + ',' + b; }

  function showFatal(msg) {
    var d = $('fatal');
    d.style.display = 'flex';
    $('fatalMsg').textContent = String(msg);
  }
  /* T10: 全局 error 只落 console, 不再弹致命面板 — 第三方脚本/上下文丢失等
     次要异常不应中断渲染主循环; 渲染循环自身已有 try/catch 兜底 (loop 内)。 */
  window.addEventListener('error', function (e) {
    console.error('[zongmen] 全局异常:', e.message,
      e.filename ? '@' + e.filename.split('/').pop() + ':' + e.lineno : '');
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
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    /* P1: 相机位移/缩放/视口尺寸超过阈值才全量重建需求集 (阈值公式与
       staticNeedsRedraw 的 scale 同思路, 随 zoom 缩小);
       相机静止且无到期重试时, 只推进存量队列, 不做象限扫描/卸载/排序。 */
    var stScale = 16 / (cam.zoom * 0.75 + 0.25);
    var moved = lastStream.x !== lastStream.x ||          // 首帧 / regenerate 后为 NaN → 必须重算
                vw !== lastStream.w || vh !== lastStream.h ||
                Math.abs(cam.x - lastStream.x) > stScale ||
                Math.abs(cam.y - lastStream.y) > stScale ||
                Math.abs(cam.zoom - lastStream.zoom) > 0.02;
    if (!moved) {
      var tNow0 = performance.now();
      var retryDue = false;
      chunkRetry.forEach(function (rr) { if (rr.at <= tNow0) retryDue = true; });
      if (!retryDue) {
        pumpChunks();                                     // 在途完成回调也会自 pump
        return;
      }
    }
    lastStream.x = cam.x; lastStream.y = cam.y;
    lastStream.zoom = cam.zoom; lastStream.w = vw; lastStream.h = vh;

    var b = viewBounds();
    var t = tileBoundsOf(b, 2);
    /* 视野区域/群落格窗口: 供 regionCells/commCells/settleCells/poiCells
       窗口失活与回填校验 (块响应的子消息可能落在窗口外, 交给邻块负责) */
    var M = geo.regionM, CL = geo.commCl;
    var i0 = Math.floor(t.qmin / M) - 1, i1 = Math.floor(t.qmax / M) + 1;
    var j0 = Math.floor(t.rmin / M) - 1, j1 = Math.floor(t.rmax / M) + 1;
    var ci0 = Math.floor(t.qmin / CL) - 1, ci1 = Math.floor(t.qmax / CL) + 1;
    var cj0 = Math.floor(t.rmin / CL) - 1, cj1 = Math.floor(t.rmax / CL) + 1;

    /* 卸载视野外 (区域/群落数据 + 实体层) */
    keepR = new Set(); keepC = new Set();   // 模块级: 供异步回调校验回填 (R4)
    for (var ri = i0; ri <= i1; ri++) for (var rj = j0; rj <= j1; rj++) keepR.add(cellKey(ri, rj));
    for (var ui = ci0; ui <= ci1; ui++) for (var uj = cj0; uj <= cj1; uj++) keepC.add(cellKey(ui, uj));
    regionCells.forEach(function (_p, k) { if (!keepR.has(k)) regionCells.delete(k); });
    commCells.forEach(function (_p, k) { if (!keepC.has(k)) commCells.delete(k); });
    settleCells.forEach(function (_l, k) { if (!keepR.has(k)) settleCells.delete(k); });
    poiCells.forEach(function (_l, k) { if (!keepR.has(k)) poiCells.delete(k); });

    /* 单块 need 集合 (主块 = 区块格, 设计 §六 方案 A) */
    var pad = geo.hexW * 2;
    var tb = tileBoundsOf(
      { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, 0);
    var m2 = geo.chunkScan + geo.chunkS;
    var a0 = Math.floor((tb.qmin - m2) / geo.chunkS), a1 = Math.floor((tb.qmax + m2) / geo.chunkS);
    var b0 = Math.floor((tb.rmin - m2) / geo.chunkS), b1 = Math.floor((tb.rmax + m2) / geo.chunkS);
    var need = {};
    keepChunk = new Set();   // 模块级: 本帧仍需的块 key, 供 loadChunk 回调校验 (R4)
    for (var ca = a0; ca <= a1; ca++) {
      for (var cb = b0; cb <= b1; cb++) {
        var kk = chunkKey(ca, cb);
        need[kk] = { ca: ca, cb: cb };
        keepChunk.add(kk);
      }
    }
    chunkData.forEach(function (_info, key) {
      if (!need[key]) {
        renderer.dropChunk(key);
        chunkData.delete(key);
        MC.blockForget(key);                 // rev 缓存同步失效: 重进视野须全量重取
        forceStaticDirty();                  // 内容移除: 尽快重绘清除残影 (R1)
      }
    });

    /* 队列重建: 未加载 && 未在途 && 不在退避期内, 距相机排序 */
    chunkQueue.length = 0;
    var tNow = performance.now();
    for (var key in need) {
      var rr = chunkRetry.get(key);
      if (!chunkData.has(key) && !chunkBusy.has(key) &&
          (!rr || rr.at <= tNow)) {
        var cc = need[key];
        var w = MC.tileToWorld(cc.ca * geo.chunkS, cc.cb * geo.chunkS);
        var d = (w.x - cam.x) * (w.x - cam.x) + (w.y - cam.y) * (w.y - cam.y);
        chunkQueue.push({ ca: cc.ca, cb: cc.cb, key: key, d: d });
      }
    }
    /* 已离开视野的退避记录及时清理, 防止无界增长; 重回视野时重试窗口从零计 */
    chunkRetry.forEach(function (_v, key) { if (!need[key]) chunkRetry.delete(key); });
    chunkQueue.sort(function (p, q) { return p.d - q.d; });
    pumpChunks();
  }

  /* 单个块请求的生命周期独立成函数: job 必须被本次请求闭包独占。
     (此前 var job 在 while 循环里被所有并发回调共享, 回调里读到的永远是
      最后一个 job → chunkBusy 只删掉最后一个 key, 前几个 key 永久卡死。) */
  function loadChunk(job) {
    var gen = worldSeed;
    MC.block(gen, job.ca, job.cb).then(function (resp) {
      /* 修复「个别色块无贴图」(待办/色块无贴图bug排查): MapClient.onFrame 收到
         响应即无条件写 revs 缓存; 若本块此刻已被丢弃 (出视野/世界重铸), 数据不会
         经 applyBlock 落 chunkData —— revs 残留会让下次请求携带旧 lastRevs,
         服务端按 rev 未变缺省下发 → 块永久空白。故两个丢弃分支都主动 blockForget,
         维持不变量「revs 有记录 ⇒ chunkData 有数据」。 */
      if (gen !== worldSeed) { MC.blockForget(job.key); return; }   // 世界已重铸, 丢弃旧响应
      if (!keepChunk.has(job.key)) { MC.blockForget(job.key); return; }  // R4: 已出视野被卸载
      applyBlock(job, resp);
    }).catch(function (err) {
      console.error('块加载失败', job.key, err);
      if (gen !== worldSeed) return;                 // 旧世界失败不记账
      scheduleChunkRetry(job);                       // 网络/超时/断线: 指数退避后自动重试
    }).then(function () {
      if (gen !== worldSeed) return;                 // 旧世界请求不动新世界的 busy 集
      chunkBusy.delete(job.key);
      pumpChunks();
    });
  }

  /* TileResponse 子消息分发 (设计 §3.2): chunk→GPU, region→道路/地名,
     settle/poi→实体层, comm→灵脉。rev 未变的图层服务端缺省, 保留旧数据。 */
  function applyBlock(job, resp) {
    if (resp.err) console.warn('块 ' + job.key + ' 部分图层不可用:', resp.err);

    /* 图层0 静态地形 (子消息缺省 = rev 未变, 保留已上传 GPU 的数据) */
    var arrays = resp.chunk ? PB.chunkToArrays(resp.chunk, geo) : null;
    /* 兜底防御: chunk 缺省 (=服务端按 rev 未变不重发) 但本地从未持有该块 —
       说明 revs 缓存与 chunkData 不一致 (旧版竞态已造成的坏状态, 或不可达
       的遗漏路径)。清 rev 后重新入队, 下一次请求不带 lastRevs → 服务端全量
       下发, 消除永久空白。
       ★ 但服务端**明确报错**时 (resp.err) 不能直接重排: 错误响应几乎立即返回,
         pumpChunks 会马上再发 → 无退避自旋, 单连接被打满。改走指数退避。 */
    if (!arrays && !chunkData.has(job.key)) {
      MC.blockForget(job.key);
      if (resp.err) {
        scheduleChunkRetry(job);       // 0.8s→30s 退避, 由 updateStreaming 到期检查重新入队
      } else {
        chunkQueue.push(job);          // 纯 rev 不一致: 一次往返即自愈, 无需退避
      }
      return;
    }
    if (arrays && !chunkData.has(job.key)) {
      var bb = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
      var ct = arrays.centers;
      for (var i = 0; i < arrays.count; i++) {
        var x = ct[i * 2], y = ct[i * 2 + 1];
        if (x < bb.x0) bb.x0 = x; if (x > bb.x1) bb.x1 = x;
        if (y < bb.y0) bb.y0 = y; if (y > bb.y1) bb.y1 = y;
      }
      renderer.uploadChunk(job.key, arrays, bb);   // R7: bbox 供渲染粗剔除
      chunkData.set(job.key, { arrays: arrays, bbox: bb });
      minimapDirty = true;
      markStaticDirty();                   // R1: 连续 N 个块合并 200ms 重绘一次
    }

    /* 图层1 区域 (区域名 + 道路; 实体已拆分到图层2/3) */
    var regionsApplied = false;
    for (var rg2 = 0; rg2 < resp.regions.length; rg2++) {
      var rg = resp.regions[rg2];
      var rk = rg.i + ',' + rg.j;
      if (!keepR.has(rk)) continue;                // 窗口外: 交给覆盖该区域的邻块
      regionCells.set(rk, { region: rg.region, roads: rg.roads });
      roadsDirty = true;                           // T7: 路网数据变化 → 重绘重建道路几何
      regionsApplied = true;
    }
    /* ★ 必须与 chunk/settle/poi/comm 分支一样置静态脏: roadsDirty 与区域名绘制
       (renderStaticInto 内 584/648 行) 都在 staticDirty 门控的重绘函数里消费。
       若只置 roadsDirty 而不置 staticDirty, 当「相机静止 + 本块 chunk 未变化」
       (如重试时该块 chunkData 已存在 → 上面的 chunk 分支整个跳过) 时,
       renderStaticInto 不会被调用 → 道路几何与区域名一直不刷新。 */
    if (regionsApplied) markStaticDirty();

    /* 图层2/3 实体 (按区域格键覆盖, 天然去重邻块重复携带) */
    if (resp.settle) {
      for (var sg = 0; sg < resp.settle.groups.length; sg++) {
        var g = resp.settle.groups[sg];
        var gk = g.i + ',' + g.j;
        if (keepR.has(gk)) settleCells.set(gk, g.items);
      }
      markStaticDirty();
      updateSectPanel(false);   // 实体层更新即刷新宗门录 (id 未变时内部直接返回)
    }
    if (resp.poi) {
      for (var pg = 0; pg < resp.poi.groups.length; pg++) {
        var gp = resp.poi.groups[pg];
        var gk2 = gp.i + ',' + gp.j;
        if (keepR.has(gk2)) poiCells.set(gk2, gp.items);
      }
      markStaticDirty();
    }

    /* 图层4 灵脉群落 */
    for (var cm2 = 0; cm2 < resp.comms.length; cm2++) {
      var cm = resp.comms[cm2];
      var ck = cm.ci + ',' + cm.cj;
      if (!keepC.has(ck)) continue;
      commCells.set(ck, cm);
      markStaticDirty();
    }
  }

  /* 指数退避: 0.8s→1.6→3.2→6.4→12.8→…→30s 封顶, 之后保持 30s 周期重试,
     直至块离开视野(记录被清理)或 regenerate() 重铸世界。不永久放弃, 服务抖动恢复后地图可自愈。 */
  function scheduleChunkRetry(job) {
    var r = chunkRetry.get(job.key);
    var attempt = r ? r.attempt : 0;
    attempt++;
    var delay = Math.min(NET_CFG.retryBaseMs * Math.pow(2, attempt - 1), NET_CFG.retryMaxMs);
    chunkRetry.set(job.key, { attempt: attempt, at: performance.now() + delay });
  }

  function pumpChunks() {
    while (chunkBusy.size < NET_CFG.concChunk && chunkQueue.length) {
      var job = chunkQueue.shift();
      if (chunkData.has(job.key) || chunkBusy.has(job.key)) continue;
      chunkBusy.set(job.key, true);
      loadChunk(job);
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
    /* ★ 服务端 /api/map/fields 的响应键是 { q0, r0, nq, nr, d } —— 没有 q1/r1。
       此前这里直接读 mmData.q1/r1 (恒为 undefined), 于是 `t.q <= undefined` 恒假
       → 每个像素都被判为「窗口外」→ 整幅小地图恒为兜底色 #b9ad92 的空框
       (小地图自上线起就从未显示过地形)。上界必须由 q0+nq-1 / r0+nr-1 推出。 */
    var mq1 = mmData ? mmData.q0 + mmData.nq - 1 : -1;
    var mr1 = mmData ? mmData.r0 + mmData.nr - 1 : -1;
    for (var py = 0; py < H; py++) {
      for (var px = 0; px < W; px++) {
        var wx = cam.x + (px - W / 2) * SCALE;
        var wy = cam.y + (py - H / 2) * SCALE;
        var t = MC.pxToTile(wx, wy);
        var disp = -1;
        if (mmData && t.q >= mmData.q0 && t.q <= mq1 && t.r >= mmData.r0 && t.r <= mr1) {
          disp = mmData.data[(t.r - mmData.r0) * mmData.nq + (t.q - mmData.q0)];
        }
        /* D3: 色值预解析成 [r,g,b] —— 原实现每像素 3 次 parseInt(col.slice(...)),
           单次刷新 132×88×3 ≈ 3.5 万次字符串切片 + 解析。 */
        var rgb = colCache[disp];
        if (!rgb) {
          if (disp < 0) {
            rgb = colCache[disp] = [185, 173, 146];          // 窗口外兜底色 #b9ad92
          } else {
            var col = (geo.biomeMeta[disp] || { color: '#b9ad92' }).color;
            rgb = colCache[disp] = [parseInt(col.slice(1, 3), 16),
                                    parseInt(col.slice(3, 5), 16),
                                    parseInt(col.slice(5, 7), 16)];
          }
        }
        var i = (py * W + px) * 4;
        img.data[i] = rgb[0];
        img.data[i + 1] = rgb[1];
        img.data[i + 2] = rgb[2];
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    mmCam.x = cam.x; mmCam.y = cam.y;      // 记录本次绘制所用相机 → mmCamMoved 判据
    mmBoxDirty = true;                     // 位图变了 → 外层画布需重绘一次
  }
  /* D16: 小地图数据窗口是否已不覆盖当前相机窗口 (平移久了必须重采样, 否则大片兜底色) */
  function minimapWindowStale() {
    var W = 132, H = 88, SCALE = 6;
    if (!mmData) return true;
    var x0 = cam.x - W / 2 * SCALE, y0 = cam.y - H / 2 * SCALE;
    var x1 = cam.x + W / 2 * SCALE, y1 = cam.y + H / 2 * SCALE;
    var a = MC.pxToTile(x0, y0), b = MC.pxToTile(x1, y1);
    var c = MC.pxToTile(x0, y1), d = MC.pxToTile(x1, y0);
    var q0 = Math.min(a.q, b.q, c.q, d.q), q1 = Math.max(a.q, b.q, c.q, d.q);
    var r0 = Math.min(a.r, b.r, c.r, d.r), r1 = Math.max(a.r, b.r, c.r, d.r);
    return q0 < mmData.q0 || r0 < mmData.r0 ||
           q1 > mmData.q0 + mmData.nq - 1 || r1 > mmData.r0 + mmData.nr - 1;
  }
  /* mmBase 是「以相机为中心」的窗口 ⇒ 相机没动、也没新数据时位图内容不变 */
  function mmCamMoved() {
    return !(Math.abs(cam.x - mmCam.x) <= 1.5 && Math.abs(cam.y - mmCam.y) <= 1.5);
  }
  /* D4: 小地图画布按 dpr 对齐 —— 原先 width/height 写死 432×282 (= CSS 216×141 × 固定 2),
     在 dpr=1 屏幕上等于每次 blit 都做 2× 降采样, dpr=3 又糊。 */
  function syncMinimapSize() {
    var box = els.minimap;
    if (!box) return;
    var cw = box.clientWidth || 216, chh = box.clientHeight || 141;
    var w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(chh * dpr));
    if (box.width !== w || box.height !== h) {
      box.width = w; box.height = h;
      mmBoxDirty = true;
    }
  }
  /* D4: 外层小地图画布只在位图/尺寸变化时重绘 (原先每帧 blit + 描边 + 文字) */
  function drawMinimap() {
    if (!mmBoxDirty) return;
    var box = els.minimap, bctx = box.getContext('2d');
    var mw = box.width, mh = box.height;
    mmBoxDirty = false;
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, mw, mh);
    if (!mmBase) return;
    bctx.drawImage(mmBase, 0, 0, mw, mh);
    /* 覆盖标记按画布比例缩放 (原写死 2 线宽 / 6×6 方块 / 10px 字, 换画布尺寸即失真) */
    var k = mw / 132;
    bctx.strokeStyle = 'rgba(166,58,44,0.95)';
    bctx.lineWidth = Math.max(1, 2 * k);
    bctx.strokeRect(mw / 2 - 3 * k, mh / 2 - 3 * k, 6 * k, 6 * k);
    bctx.fillStyle = 'rgba(50,42,34,0.7)';
    bctx.font = Math.round(10 * k) + 'px "KaiTi","STKaiti",serif';
    bctx.textAlign = 'left';
    bctx.fillText('方圆百里', 6 * k, mh - 6 * k);
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
        /* T7: 先做近岸判定与出线概率筛 — 深海 ~70% 的格在此被跳过,
           免去 3 个浮点哈希与后续全部绘制计算 (输出与原顺序完全一致) */
        var nearLand = false;
        if (biome === 1) {
          var nv = neigh[i];
          for (var wn = 0; wn < 6; wn++) {
            var nb = (nv >> (wn * 3)) & 7;      // P2: 3bit/邻居 移位掩码解码, 免逐邻居 Math.pow(8,wn)
            if (nb > 1) { nearLand = true; break; }
          }
        }
        if (!nearLand && hh >= (biome === 0 ? 0.30 : 0.46)) continue;
        var fr1 = (hh * 913.7) % 1, fr2 = (hh * 517.3) % 1, fr3 = (hh * 271.1) % 1;
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

  /* ---------- 建筑层: 在六边格上实时绘制 (真源 web/js/bldg_ink.js) ----------
     与「图标代替建筑」的区别:
       · 贴格  —— 每座建筑落在后端下发的 (q,r) 格心, 半径/朝向与地图网格同源;
       · 朝向  —— 按地类推导: 码头朝水面 / 炉窑朝山 / 料场朝林 / 民房朝中枢 /
                  殿宇坐北朝南, 探针失败才回退默认朝向;
       · 变体  —— 逐格取自 hash3(q,r,kind) → 同格恒定 (平移不闪), 异格各异;
       · 缓存  —— 绘制结果按 (种类+朝向+变体+等级+尺寸档) 存小位图, 平移只做贴图。
     ⚠ 必须整块绘制在 drawEntityList 之前 (建筑在地面, 名牌/标记在其上)。 */
  var BI = window.BldgInk;
  var CS_OFF = 16;                 // 后端 chunk 覆盖 ca*chunkS ± 16 (=33 格边长)
  var CS_SPAN = 33;
  /* 精灵渲染半径档 (设备像素): 随 zoom 拾级而上, 换档即清缓存 → 单档位内条数有界 */
  var R_BUCKETS = [8, 11, 15, 20, 27, 36, 48, 64];
  var lastRBucket = -1;
  var bldgShown = false;           // 本帧建筑层是否已绘制 (供实体图标让位)
  var bldgPlan = [];               // 复用的绘制计划数组
  /* 格 → 地类 (biome)。数据来自已加载区块; 未加载返回 -1 (探针自动放弃)。
     ⚠ 区块归属**不能**用 round(q/chunkS): 引擎 chunkOfTile 是「区块格心四候选
       取六边距最近 + 固定平局序」, 与四舍五入不等价 (chunkS=21 时 (32,32) 归
       (2,1) 而 round 给 (2,2))。这里改为枚举 4 个候选区块、直接问「索引里有没有
       这一格」—— 索引本身由服务端 qrel 生成, 归属天然权威, 无需复制平局规则。
       (2026-09-13 w6 对拍: round 版本 3 区块中 2 个整体错位) */
  function buildTileIdx(info, ca, cb) {
    var d = info.arrays, S = geo.chunkS;
    var idx = new Int16Array(CS_SPAN * CS_SPAN);
    idx.fill(-1);
    var hw = geo.hexW, h15 = 1.5 * geo.hexR;
    for (var i = 0; i < d.count; i++) {
      /* centers 由 (qa,ra) 用同一公式正算 → 反解取整即精确还原 */
      var ra = Math.round(d.centers[i * 2 + 1] / h15);
      var qa = Math.round(d.centers[i * 2] / hw - ra / 2);
      var cq = qa - ca * S + CS_OFF, cr = ra - cb * S + CS_OFF;
      if (cq >= 0 && cq < CS_SPAN && cr >= 0 && cr < CS_SPAN) idx[cr * CS_SPAN + cq] = i;
    }
    info.tileIdx = idx;
  }
  function biomeAt(q, r) {
    if (!geo) return -1;
    var S = geo.chunkS;
    var qb = Math.floor(q / S) * S, rb = Math.floor(r / S) * S;
    for (var a = 0; a < 4; a++) {
      var ca = (qb + (a % 2) * S) / S, cb = (rb + (a >> 1) * S) / S;
      var info = chunkData.get(chunkKey(ca, cb));
      if (!info) continue;
      if (!info.tileIdx) buildTileIdx(info, ca, cb);
      var cq = q - ca * S + CS_OFF, cr = r - cb * S + CS_OFF;
      if (cq < 0 || cq >= CS_SPAN || cr < 0 || cr >= CS_SPAN) continue;
      var i = info.tileIdx[cr * CS_SPAN + cq];
      if (i >= 0) return (info.arrays.tiles[i] / 4) | 0;
    }
    return -1;
  }
  /* 朝向求解器来自绘制核心 (web/js/bldg_ink.js 的 faceSolver):
     朝向规则表/回退逻辑/环枚举与离线预览页、对拍脚本共用同一份实现,
     本文件只负责把「浏览器侧的 biomeAt」注入进去。geo 就绪后建一次即可。 */
  var bldgSolver = null;
  function solverFor() {
    if (!bldgSolver && geo && BI && BI.faceSolver) {
      bldgSolver = BI.faceSolver({ biome: biomeAt, hexW: geo.hexW, hexR: geo.hexR, ringMax: 3 });
    }
    return bldgSolver;
  }
  /* 逐格变体: 同 kind 同格恒定 → 平移/重绘不闪; 异格不同 → 去掉重复感。
     精灵缓存键不含格位, 故变体个数即「同种建筑可见造型数」→ 取 8 档。 */
  function variantOf(b) {
    return BI.hash3(b.q | 0, b.r | 0, BI.kindIdOf(b.kind)) % 8;
  }
  function bucketOf(rDev) {
    for (var i = 0; i < R_BUCKETS.length; i++) if (rDev <= R_BUCKETS[i]) return i;
    return R_BUCKETS.length - 1;
  }
  /* 屏幕空间 (dpr 变换下) 逐格贴图。六边格半径 <5px 时不画, 交给聚落图标。 */
  function drawBuildings(ctx, vw, vh, z) {
    bldgShown = false;
    if (NO_BLDG) return;                       // headless A/B 验证开关 (见顶部 NO_BLDG)
    var solver = solverFor();
    if (!BI || !BI.spriteOf || !geo || !solver) return;
    if (geo.hexR * z < 5) return;
    var tgt = geo.hexR * z * dpr;                 // 目标半径 (设备像素)
    var bkt = bucketOf(tgt);
    if (bkt !== lastRBucket) { BI.spriteClear(); lastRBucket = bkt; }
    var R = R_BUCKETS[bkt], scale = tgt / R;
    var detail = z >= 1.35 ? 3 : (z >= 0.9 ? 2 : 1);
    var list = bldgPlan;
    list.length = 0;
    settleCells.forEach(function (ents) {
      for (var i = 0; i < ents.length; i++) {
        var st = ents[i];
        if (st.state === 1 || !st.buildings || !st.buildings.length) continue;
        for (var j = 0; j < st.buildings.length; j++) {
          var b = st.buildings[j];
          var w = MC.tileToWorld(b.q, b.r);
          var ps = w2s(w.x, w.y);
          /* 留足余量: 栈桥/树冠/幡可越出本格 (SPR_BOX 上界 2.4R) */
          if (ps.x < -70 || ps.y < -100 || ps.x > vw + 70 || ps.y > vh + 100) continue;
          list.push({ b: b, st: st, x: ps.x * dpr, y: ps.y * dpr, d: w.y });
        }
      }
    });
    if (!list.length) return;
    /* 深度序: 世界 y 小者远, 先画; 同深按 q 定序, 保证遮挡关系稳定不闪 */
    list.sort(function (p, q2) { return (p.d - q2.d) || (p.b.q - q2.b.q); });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);           // 精灵为设备像素位图 → 原样贴
    for (var k = 0; k < list.length; k++) {
      var it = list[k], b = it.b;
      var fi = solver.faceInfo(b, it.st);
      var rec = BI.spriteOf({
        kind: b.kind, q: b.q, r: b.r, variant: variantOf(b), tier: b.tier,
        face: fi.face, water: fi.water, R: R, detail: detail, plateA: 0.16
      });
      if (!rec) continue;
      ctx.drawImage(rec.cv, it.x + rec.ox * scale, it.y + rec.oy * scale,
                    rec.w * scale, rec.h * scale);
    }
    ctx.restore();
    bldgShown = true;
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

    /* 道路 (后端 A* 路径点) — T7: 仅路网数据变化时重建几何并重传 GPU */
    if (roadsDirty) {
      roadsDirty = false;
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
        /* D2: 区域包降级/半截时 roads/region 可能缺省 —— 直接取属性会抛异常,
           异常从 renderStaticInto 冒到主循环 → showFatal 整页不可用。 */
        var roads = pack.roads || [];
        for (var rr = 0; rr < roads.length; rr++) {
          var road = roads[rr];
          if (drawn[road.key]) continue;
          drawn[road.key] = true;
          /* 不做逐路视野裁剪: regionCells 本身随视野窗口卸载, 集合有界;
             若按重建时刻的视野裁剪, 平移离开后 roadsDirty=false 会导致远路缺失 */
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
    }

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
        if (!rg) return;                        // D2: 缺 region 的降级包直接跳过
        var ps = w2s(rg.x, rg.y);
        if (ps.x < -200 || ps.y < -100 || ps.x > vw + 200 || ps.y > vh + 100) return;
        var fs = Math.max(Math.sqrt(geo.regionM * geo.regionM) * 0.75, 12) * z;
        ctx.font = fs + 'px "KaiTi","STKaiti",serif';
        ctx.fillStyle = rg.biome <= 1 ? 'rgba(52,66,72,0.28)' : 'rgba(58,48,38,0.26)';
        ctx.fillText(rg.name, ps.x, ps.y);
      });
    }

    /* 建筑层 (地面实体 → 压在淡淡的区域名之上, 名牌/灵脉标之下) */
    drawBuildings(ctx, vw, vh, z);

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

    /* 聚落/景点实体图标 + 名牌 (图层2/3: 动态实体独立于静态地形层, 设计 §二) */
    var zoomClamp = Math.max(z, 0.55);
    function drawEntityList(entities) {
      for (var s2 = 0; s2 < entities.length; s2++) {
        var st = entities[s2];
        if (st.state === 1) continue;              // 被毁实体: 不再绘制 (事件系统接入后可改残迹)
        var ps2 = w2s(st.x, st.y);
        if (ps2.x < -60 || ps2.y < -70 || ps2.x > vw + 60 || ps2.y > vh + 70) continue;
        var fn = ICON_FN[st.type];
        if (!fn) continue;
        var baseSize = { sect: 17, city: 15, town: 12, village: 10, poi: 11 }[st.type] || 10;
        /* 建筑层已把聚落实体化 → 叠在上面的示意图标让位, 只留名牌;
           景点无建筑, 图标照旧。远景 (格半径不足, 建筑层未画) 两种都保留。 */
        var solid = bldgShown && st.type !== 'poi';
        if (!solid) fn(ctx, ps2.x, ps2.y, baseSize * zoomClamp);
        var showName = st.type === 'sect' || st.type === 'city' || st.type === 'poi' || z > 0.72;
        if (showLabels && showName) {
          var nfs = 11.5 * Math.max(z, 0.75);
          ctx.font = nfs + 'px "KaiTi","STKaiti",serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.lineWidth = 3 * Math.max(z, 0.75);
          ctx.strokeStyle = 'rgba(240,232,214,0.88)';
          /* 实体化时名牌落在建筑群外沿之下 (TOWN_R 格 ≈ 4.5·hexR) */
          var ly = solid
            ? ps2.y + (4.8 * geo.hexR * z + 4)
            : ps2.y + baseSize * zoomClamp * 0.75 + 3 * Math.max(z, 0.75);
          ctx.strokeText(st.name, ps2.x, ly);
          ctx.fillStyle = st.type === 'poi' ? 'rgba(140,48,34,0.95)' : 'rgba(50,42,34,0.92)';
          ctx.fillText(st.name, ps2.x, ly);
        }
      }
    }
    settleCells.forEach(drawEntityList);
    poiCells.forEach(drawEntityList);

    /* 「本宗」朱砂标记: 双圈 + 四角斜标 (与宗门录面板同源, 标明当前展示的是哪一座) */
    if (sect.cur) {
      var sc = w2s(sect.cur.x, sect.cur.y);
      if (sc.x > -70 && sc.y > -70 && sc.x < vw + 70 && sc.y < vh + 70) {
        var sr = 15 * Math.max(z, 0.7);
        ctx.save();
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(166,58,44,0.88)'; ctx.lineWidth = 1.7;
        ctx.beginPath(); ctx.arc(sc.x, sc.y, sr, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(166,58,44,0.32)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sc.x, sc.y, sr + 3.4, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(166,58,44,0.85)'; ctx.lineWidth = 2;
        for (var s4 = 0; s4 < 4; s4++) {
          var sa = Math.PI / 4 + s4 * Math.PI / 2;
          var sx2 = sc.x + Math.cos(sa) * (sr + 6.5), sy2 = sc.y + Math.sin(sa) * (sr + 6.5);
          ctx.beginPath();
          ctx.moveTo(sx2 - Math.cos(sa) * 4, sy2 - Math.sin(sa) * 4);
          ctx.lineTo(sx2 + Math.cos(sa) * 4, sy2 + Math.sin(sa) * 4);
          ctx.stroke();
        }
        ctx.font = 11.5 * Math.max(z, 0.75) + 'px "KaiTi","STKaiti",serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(240,232,214,0.88)';
        ctx.strokeText('本宗', sc.x, sc.y - sr - 5);
        ctx.fillStyle = 'rgba(166,58,44,0.95)';
        ctx.fillText('本宗', sc.x, sc.y - sr - 5);
        ctx.restore();
      }
    }

    staticCam.x = cam.x; staticCam.y = cam.y;
    staticCam.zoom = cam.zoom; staticCam.w = els.app.clientWidth; staticCam.h = els.app.clientHeight;
    staticDirty = false;
    lastStaticDraw = performance.now();      // R1: 供 markStaticDirty 判断合并窗口
    if (staticSchedTimer) { clearTimeout(staticSchedTimer); staticSchedTimer = null; }  // 本轮已含最新数据, 取消挂起节流
  }

  /* 五行/异灵根配色 —— 优先用 meta 下发的色板 (与 biomeMeta 同理, 单点真源);
     下面的字面量只作 meta 缺失时的兜底, 必须与
     Server/Zongmen/Engine/js/mapgen.js 的 ELEMENT_RGB / VARIANT_RGB 一致
     (frontend_smoke 的「色板契约」段会断言两者逐值相同)。 */
  var ELEMENT_RGB_FB = [[196, 176, 120], [104, 140, 86], [86, 116, 142], [176, 72, 50], [152, 120, 82]];
  var VARIANT_RGB_FB = { 雷: [142, 96, 190], 风: [118, 150, 148], 冰: [136, 168, 192], 暗: [96, 84, 110] };
  function geoElementColor(el) {
    return (geo && geo.elementRGB && geo.elementRGB[el]) || ELEMENT_RGB_FB[el] || [150, 130, 100];
  }
  function geoVariantColor(name) {
    return (geo && geo.variantRGB && geo.variantRGB[name]) || VARIANT_RGB_FB[name] || [150, 130, 100];
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
  /* D6: 原实现用单一 panelBusy 布尔早退 —— 连点时新请求被静默丢弃 (面板停在旧格);
     且 MC.tile 无超时, 请求挂住则「参详中…」可能永久滞留。
     现改为「请求序号 + 最新者胜」: 每次请求带自增 rid, 回调里 rid != 最新则丢弃;
     超时由 mapclient 侧的 AbortController 兜底 (8s)。 */
  var infoSeq = 0;
  /* R5: tile 详情请求 150ms 防抖 —— 连点多个格子时只发最后一次的请求 */
  var infoTimer = null, infoPending = null;
  function showInfo(tile) {
    if (!tile) return;
    infoPending = tile;                        // 保留最近一次点击目标
    if (infoTimer) clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      infoTimer = null;
      var t = infoPending; infoPending = null;
      requestTileInfo(t);
    }, 150);
  }
  function requestTileInfo(tile) {
    if (!tile) return;
    var rid = ++infoSeq;
    els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">参详中…</span></div>';
    els.info.classList.remove('hidden');
    var gen = worldSeed, q = tile.q, r = tile.r;
    MC.tile(gen, q, r).then(function (m) {
      if (rid !== infoSeq) return;                 // 已被更晚的点击取代 → 静默丢弃
      if (gen !== worldSeed) return;
      var rows = [];
      /* D13: 服务端字符串一律过 esc() (与宗门录面板一致) —— 原实现直接拼进
         innerHTML, 名称里含 < & 等字符就会破坏结构/注入。 */
      if (m.placeType) {
        rows.push('<div class="row"><span class="k">所在</span><span class="v">' +
          esc(TYPE_NAME[m.placeType] || m.placeType) + '</span></div>');
        rows.push('<div class="row"><span class="k">名号</span><span class="v big">' + esc(m.placeName) + '</span></div>');
        if (m.placeType !== 'poi') rows.push('<div class="row"><span class="k">生民</span><span class="v">约 ' + m.placePop.toLocaleString() + ' 口</span></div>');
        else rows.push('<div class="row"><span class="k">气数</span><span class="v">机缘未至, 探之莫测</span></div>');
        rows.push('<div class="sep"></div>');
      }
      rows.push('<div class="row"><span class="k">地界</span><span class="v">' + esc(m.regionName) + '</span></div>');
      rows.push('<div class="row"><span class="k">地貌</span><span class="v">' + esc((geo.biomeMeta[m.disp] || {}).name || '未名') + '</span></div>');
      rows.push('<div class="row"><span class="k">位次</span><span class="v">' +
        (q < 0 ? '西 ' + (-q) : '东 ' + q) + ' · ' + (r < 0 ? '北 ' + (-r) : '南 ' + r) + '</span></div>');
      if (m.hasVein) {
        rows.push('<div class="sep"></div>');
        rows.push('<div class="row"><span class="k">灵脉</span><span class="v big">' + esc(m.veinName) + '</span></div>');
        rows.push('<div class="row"><span class="k">灵根</span><span class="v">' +
          (m.veinVariant ? esc(m.veinVariant) + '灵根 · 派自' + (VEIN_EL[m.veinElement] || '?')
                         : (VEIN_EL[m.veinElement] || '?') + '灵根') + '</span></div>');
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
      if (rid !== infoSeq) return;                 // 过期请求的失败不再覆盖面板
      console.error('格详情失败', err);
      els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">未察明</span></div>';
    });
  }
  function hideInfo() {
    if (infoTimer) { clearTimeout(infoTimer); infoTimer = null; infoPending = null; }  // R5: 关闭面板取消挂起的防抖请求
    els.info.classList.add('hidden');
  }

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
    settleCells.clear();
    poiCells.clear();
    MC.blockForgetAll();                             // rev 缓存随世界重铸失效
    keepChunk = new Set();                            // R4: 世界重铸后旧窗口失效, 待 updateStreaming 重建
    keepR = new Set(); keepC = new Set();
    if (BI && BI.spriteClear) BI.spriteClear();       // 建筑精灵缓存随世界重铸失效
    lastRBucket = -1;
    chunkQueue.length = 0;
    chunkRetry.clear();
    chunkBusy.clear();                // 旧世界在途回调带 gen 守卫, 不会误删新世界标记
    roadsDirty = true;                // T7: 世界重铸 → 路网几何强制重建
    lastStream.x = NaN;               // P1: 重置流式增量状态 → 首帧强制全量重建
    mmData = null;
    hoverTile = null;
    selectedTile = null;
    cam.tx = cam.x = 0;
    cam.ty = cam.y = 0;
    cam.tzoom = cam.zoom = 2.2;
    els.seedInput.value = worldSeed;
    seedEra(worldSeed);
    /* 世界重铸: 旧世界的宗门 id 全部失效 → 清固定选择, 回到随行 */
    sect.auto = true; sect.pinId = ''; sect.curId = ''; sect.curFp = ''; sect.cur = null;
    openSectMenu(false);
    updateSectPanel(true);
    hideInfo();
    minimapDirty = true;
    mmCam.x = NaN; mmCam.y = NaN; mmDrawTimer = 1;   // D3/D16: 新世界 → 小地图窗口与位图都要重做
    forceStaticDirty();               // R1: 重铸需立即全量重绘 (清节流定时器)
  }

  function updateStats() {
    var st = 0, rd = 0, veins = 0;
    settleCells.forEach(function (list) { st += list.length; });
    poiCells.forEach(function (list) { st += list.length; });
    regionCells.forEach(function (pack) { rd += (pack.roads ? pack.roads.length : 0); });
    commCells.forEach(function (cm) { if (cm.exists) veins += cm.veins.length; });
    els.stats.textContent = '已探明 宗门村镇 ' + st + ' · 墨路 ' + rd + ' · 灵脉 ' + veins;
  }

  /* ---------- 宗门录: 数据整理 + 面板渲染 ---------- */
  var MASTER_CH = '玄清太云素无孤寒沧离明虚重白赤青洞霄寂衍真澄空'.split('');
  var MASTER_TAIL = ['真人', '上人', '道人', '散人', '老祖', '尊主'];
  var TIER_NAME = ['', '下品宗门', '中品宗门', '上品宗门'];
  var VEIN_LEVEL = ['大', '中', '小'];

  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* 距离一律用「格子」: 轴向 (q,r) 的六角立方距离 */
  function hexDist(q0, r0, q1, r1) {
    var dq = q1 - q0, dr = r1 - r0;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }
  function tileDistFrom(wx, wy, q, r) {
    var t = MC.pxToTile(wx, wy);
    return Math.round(hexDist(q, r, t.q, t.r));
  }
  function masterOf(ent) {
    if (ent.owner) return ent.owner;
    var h = hash32(worldSeed + '#' + ent.id);
    return MASTER_CH[h % MASTER_CH.length] +
           MASTER_CH[(h >>> 6) % MASTER_CH.length] +
           MASTER_TAIL[(h >>> 11) % MASTER_TAIL.length];
  }
  function regionNameAt(q, r) {
    if (!geo) return '';
    var pack = regionCells.get(cellKey(Math.floor(q / geo.regionM), Math.floor(r / geo.regionM)));
    return pack && pack.region ? pack.region.name : '';
  }
  /* 最近灵脉: 遍历已加载的群落包 (随视野窗口有界, 无额外请求)。
     VEIN_NEAR 格以外视为「未附」—— 免得写出一条几百格外的灵脉充数。 */
  var VEIN_NEAR = 60;
  function nearestVein(q, r) {
    var best = null;
    commCells.forEach(function (cm) {
      if (!cm.exists || !cm.veins) return;
      for (var i = 0; i < cm.veins.length; i++) {
        var v = cm.veins[i];
        var d = tileDistFrom(v.x, v.y, q, r);
        if (!best || d < best.d) best = { v: v, d: d };
      }
    });
    return best && best.d <= VEIN_NEAR ? best : null;
  }
  /* 视野内宗门, 按距相机中心的格距升序 */
  function collectSects() {
    var out = [], seen = {}, ct = MC.pxToTile(cam.x, cam.y);
    settleCells.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (ent.type !== 'sect' || ent.state === 1) continue;   // 非宗门 / 已毁
        if (seen[ent.id]) continue;                            // 邻块重复携带 → 去重
        seen[ent.id] = true;
        out.push({ ent: ent, d: Math.round(hexDist(ct.q, ct.r, ent.q, ent.r)) });
      }
    });
    out.sort(function (a, b) { return a.d - b.d; });
    return out;
  }
  function pickSect() {
    sect.items = collectSects();
    if (!sect.auto) {
      for (var i = 0; i < sect.items.length; i++)
        if (sect.items[i].ent.id === sect.pinId) return sect.items[i];
      sect.auto = true;                       // 所择宗门已出视野/被毁 → 回退随行
    }
    return sect.items.length ? sect.items[0] : null;
  }
  function tagList(list) {
    var h = '<div class="chips">';
    for (var i = 0; i < list.length && i < 8; i++)
      h += '<span class="tag">' + esc(list[i].name) + '<b>' + list[i].n + '</b></span>';
    return h + '</div>';
  }
  function kindsOf(buildings) {
    var c = {}, order = [];
    for (var i = 0; i < buildings.length; i++) {
      var k = buildings[i].kind || '屋舍';
      if (c[k] == null) { c[k] = 0; order.push(k); }
      c[k]++;
    }
    return order.map(function (k) { return { name: k, n: c[k] }; })
                .sort(function (a, b) { return b.n - a.n; });
  }
  function sectBodyHTML(pick) {
    var ent = pick.ent, row = [];
    function kv(k, v) {
      return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    }
    row.push('<div class="sec-top"><div class="sec-name">' + esc(ent.name) + '</div>' +
             '<div class="sec-seal">' + esc(String(ent.name).slice(0, 2)) + '</div></div>');
    row.push('<div class="sec-sub">' + (TIER_NAME[ent.tier] || '宗门') +
             (ent.styleName ? ' · ' + esc(ent.styleName) : '') + '</div>');
    row.push('<div class="ink-rule"></div>');
    row.push(kv('掌门', esc(masterOf(ent))));
    row.push(kv('门人', (ent.pop || 0).toLocaleString() + ' 口'));
    row.push(kv('地界', esc(regionNameAt(ent.q, ent.r) || '未探明')));
    row.push(kv('位次', (ent.q < 0 ? '西 ' + (-ent.q) : '东 ' + ent.q) + ' · ' +
                         (ent.r < 0 ? '北 ' + (-ent.r) : '南 ' + ent.r)));
    row.push(kv('距此', '<span class="sec-dist">' + pick.d + '</span> 格'));
    var nv = nearestVein(ent.q, ent.r);
    row.push(kv('灵脉', nv
      ? esc(nv.v.name) + '灵脉（' + (VEIN_LEVEL[nv.v.level] || '小') + '）· ' + nv.d + ' 格'
      : '未附灵脉'));
    var bl = ent.buildings || [], rs = ent.resources || [];
    if (bl.length) {
      row.push('<div class="sec-cap">山门营建</div>');
      row.push(tagList(kindsOf(bl)));
    }
    if (rs.length) {
      row.push('<div class="sec-cap">岁入</div>');
      row.push(tagList(rs.map(function (x) { return { name: x.resource, n: x.amount }; })));
    }
    return row.join('');
  }
  function sectMenuHTML() {
    var h = '<div class="mm-item' + (sect.auto ? ' cur' : '') + '" data-id="">随行 · 就近择宗</div>';
    for (var i = 0; i < sect.items.length && i < 30; i++) {
      var it = sect.items[i];
      h += '<div class="mm-item' + (!sect.auto && it.ent.id === sect.pinId ? ' cur' : '') +
           '" data-id="' + esc(it.ent.id) + '"><span class="mm-nm">' + esc(it.ent.name) +
           '</span><span class="mm-d">' + it.d + ' 格</span></div>';
    }
    if (!sect.items.length) h += '<div class="mm-empty">此方地界，未闻宗门</div>';
    return h;
  }
  function openSectMenu(open) {
    if (open) els.sectMenu.innerHTML = sectMenuHTML();
    els.sectMenu.classList.toggle('open', open);
    els.sectMenuBtn.classList.toggle('on', open);
  }
  /* 每 1.5s (与统计/小地图同节拍) 刷新一次。
     ★ 重建判据除「当前宗门 id 变化」外还必须含「图层规模变化」: 区块响应的
       settle/region/comm 是分先后到达的, 宗门实体往往先到 → 首帧渲染时
       regionCells/commCells 还是空的, 「地界/灵脉」会算成未探明/未附并**永久滞留**
       (id 不再变化 → 不再重建)。加了规模指纹后数据补到即自动纠正。 */
  function layerFingerprint() {
    return settleCells.size + '|' + regionCells.size + '|' + commCells.size;
  }
  /* D14: 单遍 O(n) 扫描 (不排序、不建数组) —— 层指纹未变时用它回答
     「选中的宗门会不会变」: 随行模式看最近宗门是否换人, 指定模式看所择宗门是否还在视野。
     只有结论确实要变时才落到全量 collectSects()+sort+innerHTML 重建。 */
  function scanSects() {
    var ct = MC.pxToTile(cam.x, cam.y);
    var best = null, bd = Infinity, pin = null, seen = {};
    settleCells.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (ent.type !== 'sect' || ent.state === 1) continue;
        if (seen[ent.id]) continue;
        seen[ent.id] = true;
        var d = hexDist(ct.q, ct.r, ent.q, ent.r);
        if (sect.pinId && ent.id === sect.pinId) pin = { id: ent.id, d: Math.round(d), ent: ent };
        if (d < bd) { bd = d; best = { id: ent.id, d: Math.round(d), ent: ent }; }
      }
    });
    return { best: best, pin: pin };
  }
  function updateSectPanel(force) {
    if (!metaReady || !geo) return;
    var fp = layerFingerprint();
    /* D14: 原实现每次都先跑 collectSects() (全量收集 + 排序), 之后才比指纹 ——
       1.5s 一次的固定开销里, 九成以上的调用结论完全没变。 */
    if (!force && fp === sect.curFp) {
      var sc = scanSects();
      var want = sect.auto ? sc.best : (sc.pin || null);
      var wantId = want ? want.id : '';
      if (wantId === sect.curId) {
        if (want) {
          sect.cur = want.ent;               // 刷新实体引用 (同 id 的新对象)
          var dEl0 = els.sectBody.querySelector('.sec-dist');
          if (dEl0) dEl0.textContent = want.d;
        }
        return;
      }
      /* 结论要变 → 落到下面的全量重建路径 */
    }
    var pick = pickSect();
    var ent = pick ? pick.ent : null;
    var id = ent ? ent.id : '';
    if (id !== sect.curId || fp !== sect.curFp || force) {
      sect.curFp = fp;
      sect.curId = id; sect.cur = ent;
      els.sectBody.innerHTML = ent ? sectBodyHTML(pick)
                                   : '<div class="sec-empty">此方地界，未闻宗门</div>';
      if (els.sectMenu.classList.contains('open')) openSectMenu(true);
      forceStaticDirty();        // 本宗朱砂标记随选中宗门移动 (相机静止时也须重绘)
    } else {
      sect.cur = ent;
      var dEl = els.sectBody.querySelector('.sec-dist');
      if (dEl && pick) dEl.textContent = pick.d;
    }
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
      } else {
        /* D9: 鼠标移出画布时清掉悬停格与指针样式 —— 原实现只在「画布内」分支赋值,
           走出画布后 hover 高亮与 cursor:pointer 一直残留。 */
        hoverTile = null;
        app.style.cursor = '';
      }
    });
    app.addEventListener('mouseleave', function () {
      hoverTile = null;
      app.style.cursor = '';
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
      /* D12: 归一化 deltaMode —— Firefox 滚轮 deltaMode=1 (行), 直接乘 deltaY 会让
         缩放几乎不动 (deltaY 只有 ±3)。行 16px / 页 100px 折成像素当量。 */
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
      cam.tzoom = MC.clamp(cam.tzoom * Math.exp(-e.deltaY * unit * 0.0012), minZoom, maxZoom);
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
        /* D11: 双指捏合加锚点补偿 —— 以两指中点为不动点缩放 (与滚轮同口径),
           原实现只改 zoom 不补平移, 捏合时地图中心会「跑」。 */
        var rect = app.getBoundingClientRect();
        var px = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        var py = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        var before = s2w(px, py);
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        cam.tzoom = MC.clamp(cam.tzoom * d / (this._pinch || d), minZoom, maxZoom);
        this._pinch = d;
        cam.zoom = cam.tzoom;
        var after = s2w(px, py);
        cam.tx += before.x - after.x;
        cam.ty += before.y - after.y;
        cam.x = cam.tx; cam.y = cam.ty;
      }
    }, { passive: false });
    app.addEventListener('touchend', function (e) {
      /* D11: 抬起一指后剩下那指要能继续拖动 —— 原实现无条件 drag=null,
         必须松手重按才能再拖 (多点触控下的常见挫败点)。 */
      if (e.touches && e.touches.length === 1) {
        this._pinch = 0;
        drag = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                 cx: cam.tx, cy: cam.ty, moved: false };
        return;
      }
      drag = null;
      this._pinch = 0;
    });

    var keys = {};
    window.addEventListener('keydown', function (e) { keys[e.key] = true; });
    window.addEventListener('keyup', function (e) { keys[e.key] = false; });
    /* D10: 失焦时清空按键状态 —— 原实现只靠 keyup, Alt+Tab 切走再回来时
       「按下的方向键」永远收不到 keyup → 相机持续漂移。 */
    window.addEventListener('blur', function () { keys = {}; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) keys = {};
    });
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
      /* ★ 开关只改数据不改相机, 而 staticNeedsRedraw 在相机静止时返回 false →
         不置脏则静态层 (灵脉晕圈/七星花/名牌) 不会重绘, 要等下一次平移/缩放
         才生效。这里必须立即置脏 (用户点击应即时反馈)。 */
      forceStaticDirty();
    });
    $('btnLabels').addEventListener('click', function () {
      showLabels = !showLabels;
      this.classList.toggle('off', !showLabels);
      forceStaticDirty();          // 同上: 区域名/聚落名/灵脉名牌都在静态层
    });
    /* 择宗菜单: 按钮开合 / 选项落定 / 点空白处收起 */
    els.sectMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSectMenu(!els.sectMenu.classList.contains('open'));
    });
    els.sectMenu.addEventListener('click', function (e) {
      var it = e.target && e.target.closest ? e.target.closest('.mm-item') : null;
      if (!it) return;
      var id = it.getAttribute('data-id') || '';
      sect.auto = !id;                    // 空 id = 「随行」项
      sect.pinId = id;
      openSectMenu(false);
      updateSectPanel(true);              // 立即重排面板 + 移动朱砂标记
    });
    window.addEventListener('mousedown', function (e) {
      if (!els.sectMenu.classList.contains('open')) return;
      if (els.sectBox.contains(e.target) || els.sectMenu.contains(e.target)) return;
      openSectMenu(false);
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
    syncMinimapSize();          // D4: 小地图画布按 CSS 尺寸 × dpr 对齐
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

      /* D5: 静止降帧 —— 相机已收敛 + 无脏图层 + 无在途加载 + 无拖拽时, 每两帧才渲染一帧
         (动画继续, 约 30fps), 把「静止时仍每帧全跑 3-pass WebGL + 全屏后处理 + 覆盖层」
         的功耗砍半。任何交互 (拖拽/滚轮/点击)、数据到达、脏标记都会立刻恢复满帧。 */
      var settled = Math.abs(cam.tx - cam.x) < 0.5 && Math.abs(cam.ty - cam.y) < 0.5 &&
                    Math.abs(cam.tzoom - cam.zoom) < 0.004;
      if (settled && !staticDirty && !minimapDirty && !drag && chunkBusy.size === 0 &&
          (frameCount & 1)) {
        requestAnimationFrame(loop);
        return;
      }

      if (metaReady) updateStreaming();
      renderer.render(cam, timeSec);
      drawOverlay();
      frameCount++;
      minimapTimer += dt;
      mmDrawTimer += dt;
      if (minimapTimer > 1.5) {
        minimapTimer = 0;
        updateStats();
        updateSectPanel(false);     // 「距此」随相机移动, 与统计同节拍刷新
      }
      /* D3/D16: 小地图不再 1.5s 无条件全量重建 (132×88 逐像素 + parseInt×3):
         · 数据窗口只在「相机窗口越出已采样范围」时重采 —— 原先从不按相机重采,
           长时间平移后位图大片落回兜底色;
         · 位图只在「有新数据 或 相机真的移动了」时重绘, 相机静止即完全跳过。 */
      if (!mmInFlight && ((minimapDirty && minimapTimer > 0.4) ||
                          (minimapTimer === 0 && minimapWindowStale()))) requestMinimap();
      if (mmData && mmDrawTimer > 0.4 && (minimapDirty || mmCamMoved())) {
        mmDrawTimer = 0;
        refreshMinimap();
        minimapDirty = false;
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
      sectBox: $('sectBox'),
      sectBody: $('sectBody'),
      sectMenu: $('sectMenu'),
      sectMenuBtn: $('sectMenuBtn')
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

      /* R10: 调试句柄仅 DEBUG 模式 (debug=1 / capture=1) 暴露 */
      if (DEBUG) {
        window.__cam = cam;
        window.__renderer = renderer;
        window.__data = function () { return { chunks: chunkData.size, regions: regionCells.size, comms: commCells.size }; };
      }

      /* 调试钩子: capture=1 时等待块数据真实到达 (≥3 块或 25s 兜底) 再把
         canvas 合成图回传后端, 用于 headless 截图验证。
         不用固定 4s 定时: WS 单块首次构建含 V8 冷启动+A* 道路, 耗时波动大。
         ★ 还必须等「就绪之后至少渲染过一帧」(frameCount 前进): headless 虚拟
           时钟下 timer 会跑到 WS 数据之前, 若立刻合成, drawImage 读到的是从未
           渲染过的 framebuffer (alpha:false → 不透明白黑), 截出全黑图
           (这正是此前 capture.png 全黑的根因)。
           注: 合成**不放进 rAF 回调** —— 虚拟时钟可能饿死 rAF, 那样会永不截图;
           改为「帧计数门槛 + 超时兜底」, 两种时钟下都必然会产出文件。 */
      if (new URLSearchParams(location.search).get('capture') === '1') {
        var snapStart = Date.now();
        var readyFrame = -1;
        var trySnap = function () {
          var ready = chunkData.size >= 3 && regionCells.size >= 1;
          if (ready && readyFrame < 0) readyFrame = frameCount;
          var timedOut = Date.now() - snapStart >= 25000;
          if (!timedOut && (!ready || frameCount <= readyFrame)) { setTimeout(trySnap, 200); return; }
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
        };
        setTimeout(trySnap, 1000);
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
