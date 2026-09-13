/* ============================================================
 * mapclient.js — 后端数据客户端 (WebSocket 单块 + HTTP 辅助)
 *   图数据 (chunk/region/settle/poi/comm) 全部走 ws://…/ws/map:
 *   一个块一个 TileRequest, 响应为多图层子消息的 TileResponse
 *   (设计 §三), mask 全量拉取, rev 按块缓存实现增量失效 (§四)。
 *   HTTP 仅保留 meta / tile / fields (单格详情与字段网格)。
 *   前端不运行任何地图生成/噪声/寻路判定。
 * ============================================================ */
(function (g) {
  'use strict';

  var PB = g.PB;
  var meta = null;                 // 世界几何/图例常量
  var metaPromise = null;
  var base = '';

  function enc(v) { return encodeURIComponent(String(v)); }

  function fetchMeta(force) {
    if (metaPromise && !force) return metaPromise;
    /* T15: seed=1 仅为后端 metaJson 的占位参数 — meta 是世界无关的
       几何/图例常量 (hexR/chunkS/biomeMeta 等), 不随 seed 变化。 */
    metaPromise = fetch(base + '/api/map/meta?seed=1')
      .then(function (r) { return r.json(); })
      .then(function (m) {
        meta = m;
        return m;
      });
    return metaPromise;
  }
  /* T15: geo() 结果复用 — meta 就绪后几何常量不可变, 缓存单例对象。
     此前每次调用新建对象, 而小地图刷新对 132×88 每像素各调一次
     pxToTile/tileToWorld (内含 geo()) ≈ 1.1 万次对象分配/次刷新。 */
  var geoCache = null;
  function geo() {
    if (!geoCache) {
      geoCache = {
        hexR: meta.hexR, hexW: meta.hexW, chunkS: meta.chunkS,
        chunkScan: meta.chunkScan, regionM: meta.regionM,
        commCl: meta.commCl, commR: meta.commR, seaLevel: meta.seaLevel,
        biomeMeta: meta.biomeMeta,
        /* 色板由 meta 单点下发 (缺失时由调用方字面兜底, 见 main.js) */
        elementRGB: meta.elementRGB, variantRGB: meta.variantRGB
      };
    }
    return geoCache;
  }

  /* ---------- 几何工具 (纯公式, 与原 mapgen.js 常量一致) ---------- */
  function tileToWorld(q, r) {
    var G = geo();
    return { x: G.hexW * (q + r / 2), y: 1.5 * G.hexR * r };
  }
  function pxToTile(wx, wy) {
    var G = geo();
    var rf = wy / (1.5 * G.hexR);
    var qf = wx / G.hexW - rf / 2;
    var xf = qf, yf = -qf - rf, zf = rf;
    var x = Math.round(xf), y = Math.round(yf), z = Math.round(zf);
    var dx = Math.abs(x - xf), dy = Math.abs(y - yf), dz = Math.abs(z - zf);
    if (dx > dy && dx > dz) x = -y - z;
    else if (dy > dz) y = -x - z;
    else z = -x - y;
    return { q: x, r: z };
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ============================================================
   * WebSocket 单块客户端 (设计 §三/§四/§五)
   *   帧格式 [1B 类型][载荷]; TileResponse 载荷 gzip(protobuf)。
   *   - 连接即 Login (demo 账号 guest); 登录前不发块请求。
   *   - 纯请求/响应: block(i,j) 返回 Promise, 按 seq 关联。
   *   - revs: 每块缓存最近一次响应的图层 rev, 下次请求携带 →
   *     未变化图层服务端缺省下发 (验收 §8.6); forgetBlock 清缓存。
   *   - 断线自动重连 (指数退避 0.5s→15s), 在途请求以网络错误拒绝,
   *     由上层重试逻辑恢复。
   * ============================================================ */
  var sock = null;                 // 当前 WebSocket
  var sockReady = null;            // Promise: 连接+登录完成 (每次连接重建)
  var sockReadyRes = null, sockReadyRej = null;
  var seq = 0;                     // 请求序号 (回显关联)
  var pending = new Map();         // seq -> {resolve, reject, timer}
  var revs = new Map();            // 'i,j' -> [chunk,region,settle,poi,comm]
  var reconnectAt = 0;             // 下次允许重连时刻 (指数退避)
  var reconnectDelay = 500;        // 当前退避时长 0.5s → ×2 → 15s 封顶
  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') +
               location.host + '/ws/map';
  var REQ_TIMEOUT = 20000;         // 单请求超时 (视为可重试网络错误)

  function wsSend(u8) {
    try { sock.send(u8); return true; } catch (e) { return false; }
  }

  function gunzip(u8) {
    /* TileResponse 载荷 gzip → ArrayBuffer (浏览器/Node 通用 DecompressionStream) */
    var ds = new DecompressionStream('gzip');
    return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
  }

  function connect() {
    if (sock && (sock.readyState === 0 || sock.readyState === 1)) return sockReady;
    /* 退避冷却: 服务端刚宕机/刚断开时, 在此直接拒绝 (可重试错误),
       由上层 chunkRetry 决定何时再试 —— 避免每次 block() 都立刻发起新握手。 */
    if (Date.now() < reconnectAt) return Promise.reject(new Error('WS 重连冷却中'));
    sock = null;
    sockReady = new Promise(function (resolve, reject) {
      sockReadyRes = resolve;
      sockReadyRej = reject;
      var s;
      try { s = new WebSocket(WS_URL); } catch (e) { reject(e); return; }
      s.binaryType = 'arraybuffer';
      sock = s;
      s.onopen = function () {
        /* 连接即登录 (设计 §五): demo 账号 guest */
        var login = PB.encodeLogin({ account: 'guest', token: 'demo' });
        var frame = new Uint8Array(1 + login.length);
        frame[0] = PB.FRAME.LOGIN;
        frame.set(login, 1);
        wsSend(frame);
      };
      s.onmessage = function (ev) { onFrame(new Uint8Array(ev.data)); };
      s.onclose = function () {
        sock = null;
        failAllPending(new Error('WS 连接已断开'));
        if (sockReadyRej) { sockReadyRej(new Error('WS 连接已断开')); sockReadyRej = null; }
        scheduleReconnect();
      };
      s.onerror = function () { /* onclose 随后触发, 统一走 onclose */ };
    });
    sockReady.catch(function () { /* 防未处理 rejection; 重连由 onclose 驱动 */ });
    return sockReady;
  }

  function scheduleReconnect() {
    reconnectAt = Date.now() + reconnectDelay;              // 0.5s → 1s → 2s … → 15s 封顶
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  }
  /* 暴露给 main.js: 距下次可重连的毫秒数 (<0 = 立即可连) */
  function reconnectDue() { return Date.now() >= reconnectAt; }

  /* D8: 容错扫描 —— 在 TileResponse 顶层找 field 6 (seq, varint)。
     仅在「正常解码已失败」时调用, 用途是把失败精确归到某一条在途请求,
     而不是把全部在途请求一起 reject (帧与帧互相独立, 一帧坏不该拖死整批)。
     任何越界/非法 wire 立即返回 null, 由调用方退回「全拒」。 */
  function scanSeq(u8) {
    var p = 0, end = u8.length;
    try {
      while (p < end) {
        var v = 0, s = 0, b;
        do {
          if (p >= end || s > 42) return null;
          b = u8[p++]; v += (b & 0x7f) * Math.pow(2, s); s += 7;
        } while (b & 0x80);
        var field = v >>> 3, wire = v & 7;
        if (wire === 0) {
          var w = 0, s2 = 0, b2;
          do {
            if (p >= end || s2 > 42) return null;
            b2 = u8[p++]; w += (b2 & 0x7f) * Math.pow(2, s2); s2 += 7;
          } while (b2 & 0x80);
          if (field === 6) return w;
        } else if (wire === 1) {
          if (p + 8 > end) return null;
          p += 8;
        } else if (wire === 5) {
          if (p + 4 > end) return null;
          p += 4;
        } else if (wire === 2) {
          var l = 0, s3 = 0, b3;
          do {
            if (p >= end || s3 > 42) return null;
            b3 = u8[p++]; l += (b3 & 0x7f) * Math.pow(2, s3); s3 += 7;
          } while (b3 & 0x80);
          if (p + l > end) return null;
          p += l;
        } else return null;
      }
      return null;
    } catch (e) { return null; }
  }

  function onFrame(u8) {
    if (!u8.length) return;
    var type = u8[0], payload = u8.subarray(1);
    if (type === PB.FRAME.LOGIN) {
      var lr = PB.decodeLoginResponse(payload);
      if (lr.ok) {
        reconnectDelay = 500;                  // 连接恢复 → 退避重置
        if (sockReadyRes) { sockReadyRes(lr); sockReadyRes = null; sockReadyRej = null; }
      }
      else {
        if (sockReadyRej) { sockReadyRej(new Error('登录失败: ' + lr.err)); sockReadyRej = null; sockReadyRes = null; }
        try { sock.close(); } catch (e) { /* 忽略 */ }
      }
      return;
    }
    if (type === PB.FRAME.PING) return;         // 服务器不应主动 ping; 忽略
    if (type === PB.FRAME.TILE) {
      gunzip(payload).then(function (buf) {
        var resp;
        try {
          resp = PB.decodeTileResponse(buf);
        } catch (e) {
          /* D8: 解码失败只拒绝「失败的那一条」—— 先容错扫出 seq 精确定位;
             实在定位不出才退回全拒 (原实现无条件全拒, 一帧坏拖死整批在途请求)。 */
          var badSeq = scanSeq(new Uint8Array(buf));
          console.error('TileResponse 解码失败', badSeq != null ? ('seq=' + badSeq) : '', e);
          if (badSeq != null && pending.has(badSeq)) {
            var bp = pending.get(badSeq);
            pending.delete(badSeq);
            clearTimeout(bp.timer);
            bp.reject(new Error('TileResponse 解码失败'));
          } else {
            failAllPending(new Error('TileResponse 解码失败'));
          }
          return;
        }
        var p = pending.get(resp.seq);
        if (!p) return;                         // 重连前的迟到响应: 丢弃
        pending.delete(resp.seq);
        clearTimeout(p.timer);
        /* 记录 rev 供下次增量请求 (设计 §四)。
           只更新 resp.mask 命中位 —— 未命中位保持原值(无记录则 0=未持有),
           否则「用非全量 mask 请求」或「未登录被拒」时会把根本没收到数据的
           图层 rev 记为已持有 → 下次请求服务端判 rev 未变而缺省下发 →
           该图层(聚落/景点/灵脉)永久缺失。 */
        if (resp.revs && resp.revs.length) {
          var k2 = resp.i + ',' + resp.j;
          var next = (revs.get(k2) || [0, 0, 0, 0, 0]).slice(0, 5);
          var bits = [PB.MASK.CHUNK, PB.MASK.REGION, PB.MASK.SETTLE, PB.MASK.POI, PB.MASK.COMM];
          for (var b = 0; b < 5; b++) {
            if ((resp.mask & bits[b]) !== 0 && b < resp.revs.length) next[b] = resp.revs[b];
          }
          revs.set(k2, next);
        }
        p.resolve(resp);
      }, function (err) {
        /* gunzip 失败: 载荷边界已不可知, 无法定位是哪条请求 → 只能全拒
           (快速失败, 由上层 scheduleChunkRetry 指数退避重取, 避免块长时间悬挂)。 */
        console.error('TileResponse 解压失败', err);
        failAllPending(new Error('TileResponse 解压失败'));
      });
    }
  }

  function failAllPending(err) {
    pending.forEach(function (p) { clearTimeout(p.timer); p.reject(err); });
    pending.clear();
  }

  /* 请求一个块 (mask 全量; rev 增量)。主块坐标 = 区块格 (i,j) = (ca,cb)。 */
  function block(seed, i, j) {
    return connect().then(function () {
      return new Promise(function (resolve, reject) {
        if (!sock || sock.readyState !== 1) { reject(new Error('WS 未就绪')); return; }
        var last = revs.get(i + ',' + j);
        var sseq = ++seq;
        var body = PB.encodeTileRequest({
          op: 1, seed: seed, i: i, j: j,
          mask: PB.MASK.ALL, seq: sseq,
          lastRevs: last || []
        });
        var frame = new Uint8Array(1 + body.length);
        frame[0] = PB.FRAME.TILE;
        frame.set(body, 1);
        var entry = {
          resolve: resolve, reject: reject,
          timer: setTimeout(function () {
            pending.delete(sseq);
            reject(new Error('WS 请求超时'));
          }, REQ_TIMEOUT)
        };
        pending.set(sseq, entry);
        if (!wsSend(frame)) {
          pending.delete(sseq);
          clearTimeout(entry.timer);
          reject(new Error('WS 发送失败'));
        }
      });
    });
  }

  /* 块数据被上层卸载时必须调用: 否则 rev 命中会导致服务端缺省下发,
     而客户端已无该块数据 (设计 §四 rev 失效的正确性前提) */
  function blockForget(key) { revs.delete(key); }
  function blockForgetAll() { revs.clear(); }

  /* ---------- 单格详情 / 字段网格 (保留 HTTP) ---------- */
  function getProto(url, signal) {
    return fetch(base + url, signal ? { signal: signal } : undefined).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
      return r.arrayBuffer();     // Content-Encoding:gzip 由 fetch 透明解压
    });
  }

  /* D6: 单格详情请求上限 —— 原实现无超时, 服务端慢/卡时面板会永久停在「参详中…」。
     用 AbortController 主动放弃 (fetch 会被 abort, 走 catch 路径)。 */
  var TILE_TIMEOUT_MS = 8000;
  function tile(seed, q, r) {
    var url = '/api/map/tile?seed=' + enc(seed) + '&q=' + q + '&r=' + r;
    if (typeof AbortController === 'undefined') {
      return getProto(url).then(function (buf) { return PB.decodeTileMsg(buf); });
    }
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, TILE_TIMEOUT_MS);
    return getProto(url, ctl.signal).then(function (buf) {
      clearTimeout(to);
      return PB.decodeTileMsg(buf);
    }, function (e) {
      clearTimeout(to);
      throw e;
    });
  }

  function fieldGrid(seed, q0, q1, r0, r1) {
    return fetch(base + '/api/map/fields?seed=' + enc(seed) +
      '&q0=' + q0 + '&q1=' + q1 + '&r0=' + r0 + '&r1=' + r1)
      .then(function (r) { return r.json(); })
      .then(function (m) {
        m.data = new Uint8Array(base64ToBytes(m.d));
        return m;
      });
  }
  function base64ToBytes(b64) {
    if (typeof atob === 'function') {
      var bin = atob(b64), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    }
    return Uint8Array.from(Buffer.from(b64, 'base64'));
  }

  g.MapClient = {
    fetchMeta: fetchMeta,
    geo: geo,
    tileToWorld: tileToWorld,
    pxToTile: pxToTile,
    clamp: clamp,
    /* WebSocket 单块接口 */
    block: block,
    blockForget: blockForget,
    blockForgetAll: blockForgetAll,
    reconnectDue: reconnectDue,
    /* HTTP 辅助接口 */
    tile: tile,
    fieldGrid: fieldGrid
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
