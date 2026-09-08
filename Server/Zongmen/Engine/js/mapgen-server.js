/* ============================================================
 * mapgen-server.js — 服务端适配层 (ClearScript V8 / Node 通用)
 * 依赖: noise.js + mapgen.js 已按序执行, 全局暴露 NoiseLib / MapGen
 * 职责: 把 MapGen 的权威计算结果转成紧凑 JSON 字符串交给宿主
 *       (C# 侧解析后组装 protobuf + gzip 落库/下发; Node 侧用于对照验证)
 * 说明: 本文件不改动任何原始生成逻辑, 只做数据搬运与位打包;
 *       数值打包 = 原始 Float32 语义, 客户端用同一份解码规则还原。
 * ============================================================ */
(function (global) {
  'use strict';
  var MG = global.MapGen;
  if (!MG) throw new Error('mapgen-server: MapGen 未加载');

  var S = MG.CHUNK_S;                 // 区块中心间距 21
  var HEX_W = MG.HEX_W;               // 13.8564
  var HEX_R = MG.HEX_R;               // 8

  /* ---------- base64 / 定宽字节打包 ---------- */
  var _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64FromBytes(u8) {
    var out = '', i = 0, n = u8.length;
    for (; i + 2 < n; i += 3) {
      var a = u8[i], b = u8[i + 1], c = u8[i + 2];
      out += _b64chars[a >> 2] + _b64chars[((a & 3) << 4) | (b >> 4)] +
             _b64chars[((b & 15) << 2) | (c >> 6)] + _b64chars[c & 63];
    }
    if (i + 1 === n) {
      var d = u8[i];
      out += _b64chars[d >> 2] + _b64chars[(d & 3) << 4] + '==';
    } else if (i + 2 === n) {
      var e = u8[i], f = u8[i + 1];
      out += _b64chars[e >> 2] + _b64chars[((e & 3) << 4) | (f >> 4)] + _b64chars[(f & 15) << 2] + '=';
    }
    return out;
  }
  function toU8(ta) { return new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); }

  /* Float32Array → uint8 (LE 字节序直出) */
  function f32bytes(ta) {
    var u = toU8(ta);
    return b64FromBytes(u);           // 本机一律小端, V8 强制小端
  }
  function u16bytes(ta) {
    var u = new Uint8Array(ta.length * 2), dv = new DataView(u.buffer);
    for (var i = 0; i < ta.length; i++) dv.setUint16(i * 2, ta[i], true);
    return b64FromBytes(u);
  }
  function u32bytes(ta) {
    var u = new Uint8Array(ta.length * 4), dv = new DataView(u.buffer);
    for (var i = 0; i < ta.length; i++) dv.setUint32(i * 4, ta[i], true);
    return b64FromBytes(u);
  }
  function u8bytes(ta) {
    var u = new Uint8Array(ta.length), dv = new DataView(u.buffer);
    for (var i = 0; i < ta.length; i++) dv.setUint8(i, ta[i]);
    return b64FromBytes(u);
  }
  /* 地块字节: Float32Array 中存放的是整数语义 biome*4+variant, 逐值转 u8 */
  function tileBytes(ta) {
    var u = new Uint8Array(ta.length);
    for (var i = 0; i < ta.length; i++) u[i] = Math.round(ta[i]);
    return b64FromBytes(u);
  }
  /* 全局降噪: V8 里个别 .NET 宿主不会给 Math.imul 之外的标准库, 无需处理 */

  /* ---------- 区块: 相对区块中心 + u16 量化 ---------- */
  function chunkJson(ca, cb) {
    var built = MG.buildChunk(ca, cb);
    var d = built.data;
    var n = d.tiles.length;
    var cc = { q: ca * S, r: cb * S };            // 区块中心格 (与 mapgen chunkCenter 一致)
    var cqx = MG.tileToWorld(cc.q, cc.r);         // 区块中心世界像素 (绝对)

    var cq = new Uint8Array(n), cr = new Uint8Array(n);
    var elev = new Uint16Array(n), hash = new Uint16Array(n);
    var neigh = new Uint32Array(n);
    var dx = d.centers, dy = d.centers;       // centers 交错 x,y
    var cy;
    for (var i = 0; i < n; i++) {
      var fx = dx[i * 2], fy = dy[i * 2 + 1];
      /* 反解轴坐标: y=12r(精确), x=HEX_W*(q+r/2) */
      var r = Math.round(fy / (1.5 * HEX_R));
      var q = Math.round(fx / HEX_W - r / 2);
      cq[i] = (q - cc.q) + 16;                // 相对区块中心, +16 偏移
      cr[i] = (r - cc.r) + 16;
      var e = d.elevs[i];
      elev[i] = Math.max(0, Math.min(65535, Math.round(e * 65535)));
      var h = d.hashes[i];
      hash[i] = Math.max(0, Math.min(65535, Math.round(h * 65535)));
      neigh[i] = Math.round(d.neigh[i]);
    }
    var pc = d.propCenters, pn = pc.length / 2;
    var pdx = new Float32Array(pn), pdy = new Float32Array(pn);
    var psp = new Uint8Array(pn), ph = new Uint16Array(pn), pe = new Uint16Array(pn);
    for (var k = 0; k < pn; k++) {
      pdx[k] = pc[k * 2] - cqx.x;             // 相对区块中心世界坐标 (px)
      pdy[k] = pc[k * 2 + 1] - cqx.y;
      psp[k] = d.propSprites[k];
      ph[k] = Math.max(0, Math.min(65535, Math.round(d.propHashes[k] * 65535)));
      pe[k] = Math.max(0, Math.min(65535, Math.round(d.propElevs[k] * 65535)));
    }
    return JSON.stringify({
      ca: ca, cb: cb, count: n,
      cq: b64FromBytes(cq), cr: b64FromBytes(cr),
      tiles: tileBytes(d.tiles),
      elev: u16bytes(elev), hash: u16bytes(hash), neigh: u32bytes(neigh),
      pn: pn, pdx: f32bytes(pdx), pdy: f32bytes(pdy),
      psp: u8bytes(psp), ph: u16bytes(ph), pe: u16bytes(pe)
    });
  }

  /* ---------- 区域包: 区域信息 + 聚落 + 道路(A* 权威) ---------- */
  function regionJson(i, j) {
    var ri = MG.regionInfo(i, j);
    var sts = MG.settlementsFor(i, j);
    var roads = MG.roadsNear(i, j, 9999);     // 服务端权威: 预算充足, 一次算全
    var stArr = [], rdArr = [];
    for (var s = 0; s < sts.length; s++) {
      var st = sts[s];
      stArr.push({ id: st.id, type: st.type, q: st.q, r: st.r,
                   x: st.x, y: st.y, name: st.name, pop: st.pop });
    }
    for (var m = 0; m < roads.length; m++) {
      var rd = roads[m], pts = [];
      for (var p = 0; p < rd.pts.length; p++) pts.push(rd.pts[p].x, rd.pts[p].y);
      rdArr.push({ key: rd.key, x0: rd.x0, y0: rd.y0, x1: rd.x1, y1: rd.y1, pts: pts });
    }
    return JSON.stringify({
      i: i, j: j,
      region: { q: ri.q, r: ri.r, x: ri.x, y: ri.y, biome: ri.biome, name: ri.name },
      settlements: stArr, roads: rdArr
    });
  }

  /* ---------- 群落包: 群落 + 灵脉 ---------- */
  function commJson(ci, cj) {
    var cm = MG.communityOf(ci, cj);
    if (!cm) return JSON.stringify({ exists: false, ci: ci, cj: cj });
    var vArr = [];
    for (var v = 0; v < cm.veins.length; v++) {
      var vn = cm.veins[v];
      var w = MG.tileToWorld(vn.q, vn.r);
      vArr.push({ name: vn.name, element: vn.element, variant: vn.variant || null,
                  level: vn.level, q: vn.q, r: vn.r, x: w.x, y: w.y });
    }
    return JSON.stringify({ exists: true, ci: ci, cj: cj,
      q: cm.q, r: cm.r, x: cm.x, y: cm.y, element: cm.element, spirit: cm.spirit,
      veins: vArr });
  }

  /* ---------- 单格详情 (信息面板权威数据) ---------- */
  function tileJson(q, r) {
    var f = MG.fields(q, r);
    var rs = MG.regionSeedOf(q, r);
    var ri = MG.regionInfo(rs.i, rs.j);
    var sts = MG.settlementsFor(rs.i, rs.j);
    var st = null;
    for (var s = 0; s < sts.length; s++) {
      if (sts[s].q === q && sts[s].r === r) { st = sts[s]; break; }
    }
    /* 去水距离: 与 main.js waterDist 一致的 4 环扫描 */
    var wd = 0;
    if (f.biome > 1) {
      var found = -1;
      for (var dist = 1; dist <= 4; dist++) {
        var hit = false;
        for (var dq = -dist; dq <= dist && !hit; dq++) {
          for (var dr = -dist; dr <= dist; dr++) {
            if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) !== dist) continue;
            if (MG.elevAt(q + dq, r + dr) < MG.SEA_LEVEL - 0.02) { hit = true; break; }
          }
        }
        if (hit) { found = dist; break; }
      }
      wd = found;
    }
    /* 是否在路上: 3x3 区域格 roadsNear 的 tiles 集合成员判定 */
    var onRoad = false;
    var ci = Math.floor(q / MG.REGION_M), cj = Math.floor(r / MG.REGION_M);
    outer:
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var roads = MG.roadsNear(ci + di, cj + dj, 9999);
        for (var t = 0; t < roads.length; t++) {
          if (roads[t].tiles && roads[t].tiles.has(q + ',' + r)) { onRoad = true; break outer; }
        }
      }
    }
    return JSON.stringify({
      q: q, r: r,
      f: { q: f.q, r: f.r, x: f.x, y: f.y, e: f.e, m: f.m, t: f.t,
           biome: f.biome, disp: f.disp, variant: f.variant, hash: f.hash },
      vein: f.vein ? { element: f.vein.element, variant: f.vein.variant, level: f.vein.level,
                       d: f.vein.d, name: f.vein.name } : null,
      region: { i: rs.i, j: rs.j, q: ri.q, r: ri.r, x: ri.x, y: ri.y, biome: ri.biome, name: ri.name },
      place: st ? { type: st.type, name: st.name, pop: st.pop } : null,
      waterD: wd, onRoad: onRoad
    });
  }

  /* ---------- 字段网格 (小地图/批量采样) ---------- */
  function fieldGridJson(q0, q1, r0, r1) {
    var nq = q1 - q0 + 1, nr = r1 - r0 + 1;
    var u = new Uint8Array(nq * nr), dv = new DataView(u.buffer);
    var idx = 0;
    for (var r = r0; r <= r1; r++) {
      for (var q = q0; q <= q1; q++) {
        var f = MG.fields(q, r);
        var disp = f.disp != null ? f.disp : f.biome;
        dv.setUint8(idx++, disp);
      }
    }
    return JSON.stringify({ q0: q0, r0: r0, nq: nq, nr: nr, d: b64FromBytes(u) });
  }

  /* 世界元信息: 客户端几何/图例常量 (不含任何地形判定) */
  function metaJson() {
    var meta = {
      hexR: MG.HEX_R, hexW: MG.HEX_W, chunkS: MG.CHUNK_S, chunkScan: MG.CHUNK_SCAN,
      regionM: MG.REGION_M, commCl: MG.CFG.COMM_CL, commR: MG.CFG.COMM_R,
      seaLevel: MG.SEA_LEVEL, biomeMeta: MG.BIOME_META
    };
    return JSON.stringify(meta);
  }

  global.MapGenServer = {
    init: function (seed) { MG.init(String(seed)); return JSON.stringify({ ok: 1 }); },
    chunkJson: chunkJson,
    regionJson: regionJson,
    commJson: commJson,
    tileJson: tileJson,
    fieldGridJson: fieldGridJson,
    metaJson: metaJson,
    /* 统计/自检钩子 */
    _countVeins: function () { return JSON.stringify({ n: MG.countVeins() }); }
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
