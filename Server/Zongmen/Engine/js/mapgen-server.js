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
  /* P5: 逐段 b64 已并入 chunkJson 单段缓冲; b64FromBytes 仍用于
     单段缓冲 / 字段网格的整体编码 (T14: 原注释「不再需要」与事实不符, 已修正) */

  /* ---------- 区块: 相对区块中心 + u16 量化 ---------- */
  function chunkJson(ca, cb) {
    var built = MG.buildChunk(ca, cb);
    var d = built.data;
    var n = d.tiles.length;
    var cc = { q: ca * S, r: cb * S };            // 区块中心格 (与 mapgen chunkCenter 一致)
    var cqx = MG.tileToWorld(cc.q, cc.r);         // 区块中心世界像素 (绝对)

    /* P5: 全部定宽字段按段连续拼进单段缓冲 → 仅 1 次 base64 + 少量 JSON key,
       替代原先 13 段独立 base64 + JSON 序列化/双转码的开销。
       布局 (全部小端, 与 C# MapWorldService.BuildChunk 逐段切片严格对应):
         地块段: cq[n] | cr[n] | tiles[n] | elev[2n] | hash[2n] | neigh[4n]   (小计 11n)
         精灵段: pdx[4pn] | pdy[4pn] | psp[pn] | ph[2pn] | pe[2pn]            (小计 13pn) */
    var pn = d.propCenters.length / 2;
    var buf = new Uint8Array(n * 11 + pn * 13);
    var dv = new DataView(buf.buffer);
    var oCq = 0, oCr = n, oTiles = 2 * n;
    var oElev = 3 * n, oHash = 5 * n, oNeigh = 7 * n;
    var oPdx = 11 * n, oPdy = oPdx + 4 * pn, oPsp = oPdy + 4 * pn,
        oPh = oPsp + pn, oPe = oPh + 2 * pn;
    var i, k;
    /* R3: cq/cr 直接用 buildChunk 记录的实际轴向偏移 d.qrel/d.rrel (整数),
       不做「世界像素 → 反解轴坐标」的浮点往返 — 大坐标下避免错位一格。
       客户端仍按 ca*S+(cq-16) 正向还原绝对格坐标, 语义完全一致。 */
    for (i = 0; i < n; i++) {
      dv.setUint8(oCq + i, d.qrel[i] + 16);        // 相对区块中心, +16 偏移 (u8)
      dv.setUint8(oCr + i, d.rrel[i] + 16);
      dv.setUint8(oTiles + i, Math.round(d.tiles[i])); // biome*4+variant (整数语义)
      dv.setUint16(oElev + i * 2, Math.max(0, Math.min(65535, Math.round(d.elevs[i] * 65535))), true);
      dv.setUint16(oHash + i * 2, Math.max(0, Math.min(65535, Math.round(d.hashes[i] * 65535))), true);
      dv.setUint32(oNeigh + i * 4, Math.round(d.neigh[i]), true);
    }
    for (k = 0; k < pn; k++) {
      dv.setFloat32(oPdx + k * 4, d.propCenters[k * 2] - cqx.x, true);   // 相对区块中心世界像素 (px)
      dv.setFloat32(oPdy + k * 4, d.propCenters[k * 2 + 1] - cqx.y, true);
      dv.setUint8(oPsp + k, d.propSprites[k]);
      dv.setUint16(oPh + k * 2, Math.max(0, Math.min(65535, Math.round(d.propHashes[k] * 65535))), true);
      dv.setUint16(oPe + k * 2, Math.max(0, Math.min(65535, Math.round(d.propElevs[k] * 65535))), true);
    }
    return JSON.stringify({ ca: ca, cb: cb, count: n, pn: pn, d: b64FromBytes(buf) });
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
                   x: st.x, y: st.y, name: st.name, pop: st.pop,
                   owner: st.owner || '', tier: st.tier || 0,
                   state: st.state || 0, expireTs: st.expireTs || 0 });
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

  /* ---------- 单块归属映射 (WebSocket 单块接口, 设计 §6 方案 A) ----------
   * 主块 = 区块格 (ca, cb)。一个块天然覆盖若干区域格与群落格:
   *   region: 区域种子距块中心 ≤ CHUNK_SCAN + REGION_M
   *           (块胞腔最远 11 格 + 区域 Voronoi 胞腔最大延伸 ~REGION_M)
   *   comm:   群落主格距块中心 ≤ COMM_CL (群落晶格 150, 块胞腔 11 远小于它)
   * 服务端 GetTileBlock 据此把 chunk/region/settle/poi/comm 各图层
   * 拼进一个 TileResponse; 坐标映射只在此处权威定义。 */
  function blockLayersJson(ca, cb) {
    var ccq = ca * S, ccr = cb * S;
    var M = MG.REGION_M, CL = MG.CFG.COMM_CL;
    var reach = MG.CHUNK_SCAN + M;
    var i0 = Math.floor((ccq - reach) / M) - 1, i1 = Math.floor((ccq + reach) / M) + 1;
    var j0 = Math.floor((ccr - reach) / M) - 1, j1 = Math.floor((ccr + reach) / M) + 1;
    var regions = [];
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var ri = MG.regionInfo(i, j);
        if (MG.hexDist(ri.q, ri.r, ccq, ccr) <= reach) regions.push([i, j]);
      }
    }
    var k0 = Math.floor((ccq - CL) / CL) - 1, k1 = Math.floor((ccq + CL) / CL) + 1;
    var l0 = Math.floor((ccr - CL) / CL) - 1, l1 = Math.floor((ccr + CL) / CL) + 1;
    var comms = [];
    for (var ci = k0; ci <= k1; ci++) {
      for (var cj = l0; cj <= l1; cj++) {
        var cm = MG.communityOf(ci, cj);
        if (cm && MG.hexDist(cm.q, cm.r, ccq, ccr) <= CL) comms.push([ci, cj]);
      }
    }
    return JSON.stringify({ ca: ca, cb: cb, regions: regions, comms: comms });
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
    /* 是否在路上: 3x3 区域格只读已缓存道路 (预算 0 = 纯读 roadCache, 点击绝不触发 A*)。
       道路生成由「区域包流式加载」按区域一次性完成并写入 roadCache 供全局复用;
       未流式到的区域其路也未画到地图上, 此处保守返回 false 与画面一致。 */
    var onRoad = false;
    var ci = Math.floor(q / MG.REGION_M), cj = Math.floor(r / MG.REGION_M);
    outer:
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var roads = MG.roadsNear(ci + di, cj + dj, 0);
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
    blockLayersJson: blockLayersJson,
    tileJson: tileJson,
    fieldGridJson: fieldGridJson,
    metaJson: metaJson,
    /* 道路版本号: tile 缓存新鲜度校验用 (roadCache 新增道路即 +1) */
    roadVersion: function () { return MG.roadVersion(); },
    /* 统计/自检钩子 */
    _countVeins: function () { return JSON.stringify({ n: MG.countVeins() }); }
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
