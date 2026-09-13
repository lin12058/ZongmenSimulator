/* ============================================================
 * pb.js — 微型 protobuf 解码器 (与服务端契约一一对应)
 *   服务端契约: Server/Zongmen/Domain/MapMessages.cs (protobuf-net)
 *   仅解码(前端只读不写); 浏览器与 Node(对照验证) 复用。
 * ============================================================ */
(function (g) {
  'use strict';

  /* D7: DataView / TextDecoder 复用 —— 原实现「每读一个 f32 就 new DataView,
     每读一个字符串就 new TextDecoder」, 单块响应里数百次分配。
     DataView 按 Reader 各持一份 (视图与底层 buffer 绑定, 不可跨 Reader 共用)。 */
  function Reader(u8) {
    this.b = u8; this.p = 0; this.end = u8.length;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  var _TD = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;

  Reader.prototype.vi = function () {          // varint (无符号)
    var r = 0, s = 0, b, n = this.b;
    for (;;) {
      if (this.p >= this.end) throw new Error('varint 越界');
      b = n[this.p++];
      r += (b & 0x7f) * Math.pow(2, s);
      if (!(b & 0x80)) return r;
      s += 7;
      if (s > 42) throw new Error('varint 过长');
    }
  };
  Reader.prototype.zz = function () {          // sint32
    var v = this.vi();
    return (v >>> 1) ^ -(v & 1);
  };
  Reader.prototype.bin = function (len) {      // length-delimited
    var n = this.b, p = this.p;
    if (len < 0 || p + len > this.end) throw new Error('bytes 越界');
    this.p = p + len;
    return n.subarray(p, p + len);
  };
  Reader.prototype.f32 = function () {         // fixed32 LE
    var p = this.p;
    if (p + 4 > this.end) throw new Error('f32 越界');
    this.p = p + 4;
    return this.dv.getFloat32(p, true);
  };
  Reader.prototype.tag = function () {
    var v = this.vi();
    return { field: v >>> 3, wire: v & 7 };
  };
  /* D8: 未识别的字段也要做越界校验 —— 原实现直接 `this.p += 8/4/len`,
     越界后 p 越过 end 会让外层的 `while (r.p < r.end)` 静默结束,
     半截消息被当成「正常读完」的数据用 (不抛异常、数据静默缺失/错位)。 */
  Reader.prototype.skip = function (wire) {
    if (wire === 0) { this.vi(); return; }
    if (wire === 1) { if (this.p + 8 > this.end) throw new Error('skip 越界'); this.p += 8; return; }
    if (wire === 5) { if (this.p + 4 > this.end) throw new Error('skip 越界'); this.p += 4; return; }
    if (wire === 2) {
      var len = this.vi();
      if (this.p + len > this.end) throw new Error('skip 越界');
      this.p += len; return;
    }
    throw new Error('不支持的 wire=' + wire);
  };

  function toU16(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var out = new Uint16Array(u8.length >> 1);
    for (var i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }
  function toU32(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var out = new Uint32Array(u8.length >> 2);
    for (var i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
    return out;
  }
  function toF32(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var out = new Float32Array(u8.length >> 2);
    for (var i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  function toStr(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  function rdF32(r, t) {                       // 按 wire 取 float
    if (t.wire === 5) return r.f32();
    if (t.wire === 0) return r.vi();
    r.skip(t.wire);
    return 0;
  }
  function rdStr(r, t) {
    if (t.wire !== 2) { r.skip(t.wire); return ''; }
    return toStr(r.bin(r.vi()));
  }
  function rdInt(r, t) {
    if (t.wire === 0) return r.vi();
    if (t.wire === 2) {          // packed varint: 先读长度前缀, 再据「已推进的 p」算终点
      var len = r.vi(), end = r.p + len, last = 0;
      while (r.p < end) last = r.vi();
      return last;
    }
    r.skip(t.wire);
    return 0;
  }
  function rdSInt(r, t) {
    if (t.wire === 0) return r.zz();
    r.skip(t.wire);
    return 0;
  }

  /* ---------------- ChunkPayload ---------------- */
  /* 1ca 2cb sint32 | 3count u32 | 4..9 bytes | 10 pn u32 | 11..15 bytes */
  function decodeChunkMsg(buf) {
    var u8 = new Uint8Array(buf), r = new Reader(u8);
    var m = { ca: 0, cb: 0, count: 0, pn: 0 };
    while (r.p < r.end) {
      var t = r.tag();
      switch (t.field) {
        case 1: m.ca = (t.wire === 0) ? r.zz() : (r.skip(t.wire), 0); break;
        case 2: m.cb = (t.wire === 0) ? r.zz() : (r.skip(t.wire), 0); break;
        case 3: m.count = rdInt(r, t); break;
        case 4: m.cq = r.bin(rdLen(r, t)); break;
        case 5: m.cr = r.bin(rdLen(r, t)); break;
        case 6: m.tiles = r.bin(rdLen(r, t)); break;
        case 7: m.elev = r.bin(rdLen(r, t)); break;
        case 8: m.hash = r.bin(rdLen(r, t)); break;
        case 9: m.neigh = r.bin(rdLen(r, t)); break;
        case 10: m.pn = rdInt(r, t); break;
        case 11: m.pdx = r.bin(rdLen(r, t)); break;
        case 12: m.pdy = r.bin(rdLen(r, t)); break;
        case 13: m.psp = r.bin(rdLen(r, t)); break;
        case 14: m.ph = r.bin(rdLen(r, t)); break;
        case 15: m.pe = r.bin(rdLen(r, t)); break;
        default: r.skip(t.wire);
      }
    }
    return m;
  }
  function rdLen(r, t) {
    if (t.wire !== 2) { r.skip(t.wire); return 0; }
    return r.vi();
  }

  /* 还原为渲染器原语义 Float32Array (相对坐标 → 绝对像素, 公式与原 mapgen 一致) */
  function chunkToArrays(m, geo) {
    var n = m.count, i;
    /* D8: 先自检字段长度 —— 半截/损坏消息若继续解, centers 里会出现成片 0 坐标,
       表现为「莫名其妙的色块」且不报错 (静默数据缺失远比抛异常难查)。 */
    if (!(m.cq && m.cr && m.tiles && m.elev && m.hash && m.neigh) ||
        m.cq.length < n || m.cr.length < n || m.tiles.length < n ||
        m.elev.length < n * 2 || m.hash.length < n * 2 || m.neigh.length < n * 4) {
      throw new Error('chunk 地块段长度与 count 不符 (count=' + n + ')');
    }
    if (m.pn > 0 &&
        (!(m.pdx && m.pdy && m.psp && m.ph && m.pe) ||
         m.pdx.length < m.pn * 4 || m.pdy.length < m.pn * 4 ||
         m.psp.length < m.pn || m.ph.length < m.pn * 2 || m.pe.length < m.pn * 2)) {
      throw new Error('chunk 精灵段长度与 pn 不符 (pn=' + m.pn + ')');
    }
    var centers = new Float32Array(n * 2);
    var tiles = new Float32Array(n), elevs = new Float32Array(n);
    var hashes = new Float32Array(n), neigh = new Float32Array(n);
    var cq = m.cq, cr = m.cr, tb = m.tiles;
    var e16 = toU16(m.elev), h16 = toU16(m.hash), nb = toU32(m.neigh);
    for (i = 0; i < n; i++) {
      var qa = m.ca * geo.chunkS + (cq[i] - 16);
      var ra = m.cb * geo.chunkS + (cr[i] - 16);
      centers[i * 2] = geo.hexW * (qa + ra / 2);
      centers[i * 2 + 1] = 1.5 * geo.hexR * ra;
      tiles[i] = tb[i];
      elevs[i] = e16[i] / 65535;
      hashes[i] = h16[i] / 65535;
      neigh[i] = nb[i];
    }
    var pn = m.pn, pc = null, ps = null, phs = null, pes = null;
    if (pn > 0) {
      var pdx = toF32(m.pdx), pdy = toF32(m.pdy);
      var ox = geo.hexW * (m.ca * geo.chunkS + m.cb * geo.chunkS / 2);
      var oy = 1.5 * geo.hexR * (m.cb * geo.chunkS);
      pc = new Float32Array(pn * 2);
      ps = new Float32Array(pn); phs = new Float32Array(pn); pes = new Float32Array(pn);
      var ph16 = toU16(m.ph), pe16 = toU16(m.pe);
      for (i = 0; i < pn; i++) {
        pc[i * 2] = ox + pdx[i];
        pc[i * 2 + 1] = oy + pdy[i];
        ps[i] = m.psp[i];
        phs[i] = ph16[i] / 65535;
        pes[i] = pe16[i] / 65535;
      }
    }
    return { ca: m.ca, cb: m.cb, count: n,
      centers: centers, tiles: tiles, elevs: elevs, hashes: hashes, neigh: neigh,
      propCenters: pc, propSprites: ps, propHashes: phs, propElevs: pes };
  }

  /* ---------------- RegionPack ---------------- */
  /* 1i 2j sint | 3 region | 4 settlements[] | 5 roads[] */
  function parseRegion(r, t) {
    var m = { i: 0, j: 0, region: null, settlements: [], roads: [] };
    while (r.p < r.end) {
      t = r.tag();
      if (t.field === 3 && t.wire === 2) {
        var l1 = r.vi(); var e1 = r.p + l1;     // 长度前缀已消费 → 以推进后的 p 为基准
        var reg = { q: 0, r: 0, x: 0, y: 0, biome: 0, name: '' };
        while (r.p < e1) {
          var tt = r.tag();
          if (tt.field === 1) reg.q = rdSInt(r, tt);
          else if (tt.field === 2) reg.r = rdSInt(r, tt);
          else if (tt.field === 3) reg.x = rdF32(r, tt);
          else if (tt.field === 4) reg.y = rdF32(r, tt);
          else if (tt.field === 5) reg.biome = rdInt(r, tt);
          else if (tt.field === 6) reg.name = rdStr(r, tt);
          else r.skip(tt.wire);
        }
        m.region = reg;
      } else if (t.field === 4 && t.wire === 2) {
        var l2 = r.vi(); var e2 = r.p + l2;
        var st = { id: '', type: '', q: 0, r: 0, x: 0, y: 0, name: '', pop: 0 };
        while (r.p < e2) {
          var t2 = r.tag();
          if (t2.field === 1) st.id = rdStr(r, t2);
          else if (t2.field === 2) st.type = rdStr(r, t2);
          else if (t2.field === 3) st.q = rdSInt(r, t2);
          else if (t2.field === 4) st.r = rdSInt(r, t2);
          else if (t2.field === 5) st.x = rdF32(r, t2);
          else if (t2.field === 6) st.y = rdF32(r, t2);
          else if (t2.field === 7) st.name = rdStr(r, t2);
          else if (t2.field === 8) st.pop = rdInt(r, t2);
          else r.skip(t2.wire);
        }
        m.settlements.push(st);
      } else if (t.field === 5 && t.wire === 2) {
        var l3 = r.vi(); var e3 = r.p + l3;
        var rd = { key: '', x0: 0, y0: 0, x1: 0, y1: 0, pts: null };
        while (r.p < e3) {
          var t3 = r.tag();
          if (t3.field === 1) rd.key = rdStr(r, t3);
          else if (t3.field === 2) rd.x0 = rdF32(r, t3);
          else if (t3.field === 3) rd.y0 = rdF32(r, t3);
          else if (t3.field === 4) rd.x1 = rdF32(r, t3);
          else if (t3.field === 5) rd.y1 = rdF32(r, t3);
          else if (t3.field === 6) rd.pts = toF32(r.bin(rdLen(r, t3)));
          else r.skip(t3.wire);
        }
        m.roads.push(rd);
      } else if (t.field === 1) m.i = rdSInt(r, t);
      else if (t.field === 2) m.j = rdSInt(r, t);
      else r.skip(t.wire);
    }
    return m;
  }
  function decodeRegionMsg(buf) {
    return parseRegion(new Reader(new Uint8Array(buf)), null);
  }

  /* ---------------- CommunityPack ---------------- */
  /* 1ci 2cj sint | 3 exists bool | 4q 5r sint | 6x 7y f32 | 8element u32 | 9spirit f32 | 10 veins[] */
  function decodeCommMsg(buf) {
    var r = new Reader(new Uint8Array(buf));
    var m = { ci: 0, cj: 0, exists: false, q: 0, r: 0, x: 0, y: 0, element: 0, spirit: 0, veins: [] };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 10 && t.wire === 2) {
        var lv = r.vi(); var e = r.p + lv;
        var v = { name: '', element: 0, variant: '', level: 0, q: 0, r: 0, x: 0, y: 0 };
        while (r.p < e) {
          var vt = r.tag();
          if (vt.field === 1) v.name = rdStr(r, vt);
          else if (vt.field === 2) v.element = rdInt(r, vt);
          else if (vt.field === 3) v.variant = rdStr(r, vt);
          else if (vt.field === 4) v.level = rdInt(r, vt);
          else if (vt.field === 5) v.q = rdSInt(r, vt);
          else if (vt.field === 6) v.r = rdSInt(r, vt);
          else if (vt.field === 7) v.x = rdF32(r, vt);
          else if (vt.field === 8) v.y = rdF32(r, vt);
          else r.skip(vt.wire);
        }
        m.veins.push(v);
      } else if (t.field === 1) m.ci = rdSInt(r, t);
      else if (t.field === 2) m.cj = rdSInt(r, t);
      else if (t.field === 3) m.exists = (t.wire === 0) ? r.vi() === 1 : (r.skip(t.wire), false);
      else if (t.field === 4) m.q = rdSInt(r, t);
      else if (t.field === 5) m.r = rdSInt(r, t);
      else if (t.field === 6) m.x = rdF32(r, t);
      else if (t.field === 7) m.y = rdF32(r, t);
      else if (t.field === 8) m.element = rdInt(r, t);
      else if (t.field === 9) m.spirit = rdF32(r, t);
      else r.skip(t.wire);
    }
    return m;
  }

  /* ---------------- TileQuery ---------------- */
  function decodeTileMsg(buf) {
    var r = new Reader(new Uint8Array(buf));
    var m = { q: 0, r: 0, e: 0, m: 0, t: 0, biome: 0, disp: 0, variant: 0,
      hasVein: false, veinElement: 0, veinVariant: '', veinLevel: 0, veinD: 0, veinName: '',
      regionI: 0, regionJ: 0, regionName: '', regionBiome: 0,
      placeType: '', placeName: '', placePop: 0, waterD: 0, onRoad: false };
    while (r.p < r.end) {
      var t = r.tag();
      switch (t.field) {
        case 1: m.q = rdSInt(r, t); break;
        case 2: m.r = rdSInt(r, t); break;
        case 3: m.e = rdF32(r, t); break;
        case 4: m.m = rdF32(r, t); break;
        case 5: m.t = rdF32(r, t); break;
        case 6: m.biome = rdInt(r, t); break;
        case 7: m.disp = rdInt(r, t); break;
        case 8: m.variant = rdInt(r, t); break;
        case 9: m.veinElement = rdInt(r, t); break;
        case 10: m.veinVariant = rdStr(r, t); break;
        case 11: m.veinLevel = rdInt(r, t); break;
        case 12: m.veinD = rdInt(r, t); break;
        case 13: m.veinName = rdStr(r, t); break;
        case 14: m.hasVein = (t.wire === 0) ? r.vi() === 1 : (r.skip(t.wire), false); break;
        case 15: m.regionI = rdSInt(r, t); break;
        case 16: m.regionJ = rdSInt(r, t); break;
        case 17: m.regionName = rdStr(r, t); break;
        case 18: m.regionBiome = rdInt(r, t); break;
        case 19: m.placeType = rdStr(r, t); break;
        case 20: m.placeName = rdStr(r, t); break;
        case 21: m.placePop = rdInt(r, t); break;
        case 22: m.waterD = rdInt(r, t); break;
        case 23: m.onRoad = (t.wire === 0) ? r.vi() === 1 : (r.skip(t.wire), false); break;
        default: r.skip(t.wire);
      }
    }
    return m;
  }

  /* ============================================================
   * WebSocket 单块协议 (设计 §三)
   *   帧格式: [1 字节类型][载荷]; TileResponse 载荷为 gzip(protobuf)。
   *   服务端契约: Server/Zongmen/Domain/MapMessages.cs (WsFrame 起始)。
   * ============================================================ */

  var FRAME = { LOGIN: 1, TILE: 2, PING: 3 };
  var MASK = { CHUNK: 1, REGION: 2, SETTLE: 4, POI: 8, COMM: 16, ALL: 31 };

  /* ---------------- 微型编码器 (仅覆盖本协议所需) ---------------- */
  function Writer() { this.a = []; }              // 字节数组 (Array<number> → Uint8Array)
  Writer.prototype.done = function () { return new Uint8Array(this.a); };
  function wvi(w, v) {                            // 无符号 varint (v ≥ 0, ≤ 2^53)
    v = Math.round(v);
    while (v >= 128) { w.a.push((v % 128) | 128); v = Math.floor(v / 128); }
    w.a.push(v);
  }
  function wzz(w, v) { wvi(w, v >= 0 ? v * 2 : -v * 2 - 1); }   // sint zigzag
  function wtag(w, field, wire) { wvi(w, field * 8 + wire); }
  function wstr(w, field, s) {
    var u = new TextEncoder().encode(s || '');
    wtag(w, field, 2); wvi(w, u.length);
    for (var i = 0; i < u.length; i++) w.a.push(u[i]);
  }
  function wbytes(w, field, u8) {
    wtag(w, field, 2); wvi(w, u8.length);
    for (var i = 0; i < u8.length; i++) w.a.push(u8[i]);
  }
  /* encodeTileRequest({op,seed,i,j,mask,seq,lastRevs}) → Uint8Array */
  function encodeTileRequest(o) {
    var w = new Writer();
    if (o.op) { wtag(w, 1, 0); wvi(w, o.op); }
    if (o.seed) wstr(w, 2, o.seed);
    wtag(w, 3, 0); wzz(w, o.i | 0);
    wtag(w, 4, 0); wzz(w, o.j | 0);
    wtag(w, 5, 0); wvi(w, o.mask || 0);
    if (o.seq) { wtag(w, 6, 0); wvi(w, o.seq); }
    if (o.lastRevs && o.lastRevs.length) {
      var tmp = new Writer();
      for (var k = 0; k < o.lastRevs.length; k++) wvi(tmp, Math.max(0, o.lastRevs[k] | 0));
      wbytes(w, 7, tmp.a.length ? new Uint8Array(tmp.a) : new Uint8Array(0));
    }
    return w.done();
  }
  /* encodeLogin({account,token}) → Uint8Array */
  function encodeLogin(o) {
    var w = new Writer();
    if (o.account) wstr(w, 1, o.account);
    if (o.token) wstr(w, 2, o.token);
    return w.done();
  }

  function decodeLoginResponse(buf) {
    var r = new Reader(new Uint8Array(buf));
    var m = { ok: false, err: '', account: '' };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1) m.ok = (t.wire === 0) ? r.vi() === 1 : (r.skip(t.wire), false);
      else if (t.field === 2) m.err = rdStr(r, t);
      else if (t.field === 3) m.account = rdStr(r, t);
      else r.skip(t.wire);
    }
    return m;
  }

  /* ---------------- TileResponse ---------------- */
  /* 1i 2j zz | 3mask 4deniedMask u32 | 5err str | 6seq u32 | 7revs packed |
     10 chunk(ChunkPayload 原始字节) | 11 regions[] | 12 settle | 13 poi | 14 comms[] */
  function decodeTileResponse(buf) {
    var r = new Reader(new Uint8Array(buf));
    var m = { i: 0, j: 0, mask: 0, deniedMask: 0, err: '', seq: 0, revs: [],
              chunk: null, regions: [], settle: null, poi: null, comms: [] };
    while (r.p < r.end) {
      var t = r.tag();
      switch (t.field) {
        case 1: m.i = rdSInt(r, t); break;
        case 2: m.j = rdSInt(r, t); break;
        case 3: m.mask = rdInt(r, t); break;
        case 4: m.deniedMask = rdInt(r, t); break;
        case 5: m.err = rdStr(r, t); break;
        case 6: m.seq = rdInt(r, t); break;
        case 7:                                     // repeated int32 (packed / 非packed 兼容)
          if (t.wire === 2) {
            var l7 = r.vi(), e7 = r.p + l7;
            while (r.p < e7) m.revs.push(r.vi());
          } else if (t.wire === 0) m.revs.push(r.vi());
          else r.skip(t.wire);
          break;
        case 10: m.chunk = decodeChunkMsg(r.bin(rdLen(r, t))); break;
        case 11: m.regions.push(parseRegionData(r.bin(rdLen(r, t)))); break;
        case 12: m.settle = parseEntityData(r.bin(rdLen(r, t))); break;
        case 13: m.poi = parseEntityData(r.bin(rdLen(r, t))); break;
        case 14: m.comms.push(decodeCommMsg(r.bin(rdLen(r, t)))); break;
        default: r.skip(t.wire);
      }
    }
    return m;
  }

  /* RegionData: 1i 2j zz | 3 region 信息 | 4 roads[] */
  function parseRegionData(u8) {
    var r = new Reader(u8);
    var m = { i: 0, j: 0, region: null, roads: [] };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1) m.i = rdSInt(r, t);
      else if (t.field === 2) m.j = rdSInt(r, t);
      else if (t.field === 3 && t.wire === 2) m.region = parseRegionInfo(r.bin(rdLen(r, t)));
      else if (t.field === 4 && t.wire === 2) m.roads.push(parseRoad(r.bin(rdLen(r, t))));
      else r.skip(t.wire);
    }
    return m;
  }
  function parseRegionInfo(u8) {
    var r = new Reader(u8);
    var m = { q: 0, r: 0, x: 0, y: 0, biome: 0, name: '' };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1) m.q = rdSInt(r, t);
      else if (t.field === 2) m.r = rdSInt(r, t);
      else if (t.field === 3) m.x = rdF32(r, t);
      else if (t.field === 4) m.y = rdF32(r, t);
      else if (t.field === 5) m.biome = rdInt(r, t);
      else if (t.field === 6) m.name = rdStr(r, t);
      else r.skip(t.wire);
    }
    return m;
  }
  function parseRoad(u8) {
    var r = new Reader(u8);
    var m = { key: '', x0: 0, y0: 0, x1: 0, y1: 0, pts: null };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1) m.key = rdStr(r, t);
      else if (t.field === 2) m.x0 = rdF32(r, t);
      else if (t.field === 3) m.y0 = rdF32(r, t);
      else if (t.field === 4) m.x1 = rdF32(r, t);
      else if (t.field === 5) m.y1 = rdF32(r, t);
      else if (t.field === 6 && t.wire === 2) m.pts = toF32(r.bin(rdLen(r, t)));
      else r.skip(t.wire);
    }
    return m;
  }

  /* SettleData/PoiData: 1 groups[] */
  function parseEntityData(u8) {
    var r = new Reader(u8);
    var m = { groups: [] };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1 && t.wire === 2) m.groups.push(parseEntityGroup(r.bin(rdLen(r, t))));
      else r.skip(t.wire);
    }
    return m;
  }
  /* EntityGroup: 1i 2j zz | 3 items[] */
  function parseEntityGroup(u8) {
    var r = new Reader(u8);
    var m = { i: 0, j: 0, items: [] };
    while (r.p < r.end) {
      var t = r.tag();
      if (t.field === 1) m.i = rdSInt(r, t);
      else if (t.field === 2) m.j = rdSInt(r, t);
      else if (t.field === 3 && t.wire === 2) m.items.push(parsePlaceEntity(r.bin(rdLen(r, t))));
      else r.skip(t.wire);
    }
    return m;
  }
  /* 建筑/产出子表 (→ 城镇足迹, 与 place 实体同层)
     注意: C# 侧是 repeated 消息字段 (每个元素一组 tag+len+payload),
     与 EntityGroup.items[] 同理 —— 每次出现即一个元素, 因此这里解析
     「单个元素」, 由调用方 push。切勿写成「容器套 field1 条目」:
     ResourceQuantDto 的 field1 恰是 string, 会被误判为条目而把 UTF-8
     字节当子消息解 → wire=7 之类 desync。 */
  function parseBuilding(u8) {                 // BuildingDto: 1q 2r zz | 3kind | 4terrain | 5tier
    var br = new Reader(u8);
    var o = { q: 0, r: 0, kind: '', terrain: '', tier: 0 };
    while (br.p < br.end) {
      var tb = br.tag();
      if (tb.field === 1) o.q = rdSInt(br, tb);
      else if (tb.field === 2) o.r = rdSInt(br, tb);
      else if (tb.field === 3) o.kind = rdStr(br, tb);
      else if (tb.field === 4) o.terrain = rdStr(br, tb);
      else if (tb.field === 5) o.tier = rdInt(br, tb);
      else br.skip(tb.wire);
    }
    return o;
  }
  function parseResource(u8) {                 // ResourceQuantDto: 1resource | 2amount
    var rr = new Reader(u8);
    var o = { resource: '', amount: 0 };
    while (rr.p < rr.end) {
      var tr = rr.tag();
      if (tr.field === 1) o.resource = rdStr(rr, tr);
      else if (tr.field === 2) o.amount = rdInt(rr, tr);
      else rr.skip(tr.wire);
    }
    return o;
  }

  /* PlaceEntity: 1id 2type | 3q 4r zz | 5x 6y f32 | 7name | 8pop | 9owner | 10tier | 11state | 12expireTs
                   | 13style 14styleName | 15buildings[] | 16resources[] */
  function parsePlaceEntity(u8) {
    var r = new Reader(u8);
    var m = { id: '', type: '', q: 0, r: 0, x: 0, y: 0, name: '', pop: 0,
              owner: '', tier: 0, state: 0, expireTs: 0,
              style: '', styleName: '', buildings: [], resources: [] };
    while (r.p < r.end) {
      var t = r.tag();
      switch (t.field) {
        case 1: m.id = rdStr(r, t); break;
        case 2: m.type = rdStr(r, t); break;
        case 3: m.q = rdSInt(r, t); break;
        case 4: m.r = rdSInt(r, t); break;
        case 5: m.x = rdF32(r, t); break;
        case 6: m.y = rdF32(r, t); break;
        case 7: m.name = rdStr(r, t); break;
        case 8: m.pop = rdInt(r, t); break;
        case 9: m.owner = rdStr(r, t); break;
        case 10: m.tier = rdInt(r, t); break;
        case 11: m.state = rdInt(r, t); break;
        case 12: m.expireTs = rdInt(r, t); break;
        case 13: m.style = rdStr(r, t); break;
        case 14: m.styleName = rdStr(r, t); break;
        case 15: m.buildings.push(parseBuilding(r.bin(rdLen(r, t)))); break;
        case 16: m.resources.push(parseResource(r.bin(rdLen(r, t)))); break;
        default: r.skip(t.wire);
      }
    }
    return m;
  }

  g.PB = {
    decodeChunkMsg: decodeChunkMsg,
    chunkToArrays: chunkToArrays,
    decodeRegionMsg: decodeRegionMsg,
    decodeCommMsg: decodeCommMsg,
    decodeTileMsg: decodeTileMsg,
    FRAME: FRAME,
    MASK: MASK,
    encodeTileRequest: encodeTileRequest,
    encodeLogin: encodeLogin,
    decodeLoginResponse: decodeLoginResponse,
    decodeTileResponse: decodeTileResponse
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
