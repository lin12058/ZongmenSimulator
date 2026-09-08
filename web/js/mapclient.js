/* ============================================================
 * mapclient.js — 后端数据客户端 (权威世界数据拉取/解码/几何工具)
 *   前端不再运行任何地图生成/噪声/寻路判定;
 *   区块/区域/群落/单格详情/字段网格 全部由 /api/map 提供。
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
    metaPromise = fetch(base + '/api/map/meta?seed=1')
      .then(function (r) { return r.json(); })
      .then(function (m) {
        meta = m;
        return m;
      });
    return metaPromise;
  }
  function geo() {
    return {
      hexR: meta.hexR, hexW: meta.hexW, chunkS: meta.chunkS,
      chunkScan: meta.chunkScan, regionM: meta.regionM,
      commCl: meta.commCl, commR: meta.commR, seaLevel: meta.seaLevel
    };
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

  /* ---------- 拉取解码 ---------- */
  function getProto(url) {
    return fetch(base + url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
      return r.arrayBuffer();     // Content-Encoding:gzip 由 fetch 透明解压
    });
  }

  /* 区块: 返回 renderer.uploadChunk 同构的 Float32Array 数据集 */
  function chunk(seed, ca, cb) {
    return fetchMeta()
      .then(function () {
        return getProto('/api/map/chunk?seed=' + enc(seed) + '&ca=' + ca + '&cb=' + cb);
      })
      .then(function (buf) {
        var msg = PB.decodeChunkMsg(buf);
        return PB.chunkToArrays(msg, geo());
      });
  }

  function region(seed, i, j) {
    return getProto('/api/map/region?seed=' + enc(seed) + '&i=' + i + '&j=' + j)
      .then(function (buf) { return PB.decodeRegionMsg(buf); });
  }

  function comm(seed, ci, cj) {
    return getProto('/api/map/comm?seed=' + enc(seed) + '&ci=' + ci + '&cj=' + cj)
      .then(function (buf) { return PB.decodeCommMsg(buf); });
  }

  function tile(seed, q, r) {
    return getProto('/api/map/tile?seed=' + enc(seed) + '&q=' + q + '&r=' + r)
      .then(function (buf) { return PB.decodeTileMsg(buf); });
  }

  /* 字段网格 (小地图/批量采样): 只返回显示用的 disp 编号字节 */
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
    chunk: chunk,
    region: region,
    comm: comm,
    tile: tile,
    fieldGrid: fieldGrid
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
