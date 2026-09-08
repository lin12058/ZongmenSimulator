/* ============================================================
 * pb.js — 微型 protobuf 解码器 (与服务端契约一一对应)
 *   服务端契约: Server/Zongmen/Domain/MapMessages.cs (protobuf-net)
 *   仅解码(前端只读不写); 浏览器与 Node(对照验证) 复用。
 * ============================================================ */
(function (g) {
  'use strict';

  function Reader(u8) { this.b = u8; this.p = 0; this.end = u8.length; }

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
    if (p + len > this.end) throw new Error('bytes 越界');
    this.p = p + len;
    return n.subarray(p, p + len);
  };
  Reader.prototype.f32 = function () {         // fixed32 LE
    var n = this.b, p = this.p;
    if (p + 4 > this.end) throw new Error('f32 越界');
    this.p = p + 4;
    return new DataView(n.buffer, n.byteOffset, n.byteLength).getFloat32(p, true);
  };
  Reader.prototype.tag = function () {
    var v = this.vi();
    return { field: v >>> 3, wire: v & 7 };
  };
  Reader.prototype.skip = function (wire) {
    if (wire === 0) { this.vi(); return; }
    if (wire === 1) { this.p += 8; return; }
    if (wire === 5) { this.p += 4; return; }
    if (wire === 2) { this.p += this.vi(); return; }
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
    if (t.wire === 2) {          // packed varint
      var end = r.p + r.vi(), last = 0;
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
        var e1 = r.p + r.vi();
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
        var e2 = r.p + r.vi();
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
        var e3 = r.p + r.vi();
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
        var e = r.p + r.vi();
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

  g.PB = {
    decodeChunkMsg: decodeChunkMsg,
    chunkToArrays: chunkToArrays,
    decodeRegionMsg: decodeRegionMsg,
    decodeCommMsg: decodeCommMsg,
    decodeTileMsg: decodeTileMsg
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
