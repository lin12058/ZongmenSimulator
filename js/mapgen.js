/* ============================================================
 * mapgen.js — 无限流式世界生成 (我的世界式区块)
 *  - 地块: 尖顶六边形, 直径 16px, 轴坐标 (q, r), y 轴向下
 *  - 区块: 半径 CHUNK_R 格的六边形, 中心间距 S=2R+1,
 *          地块归属四候选最近中心 (确定性平局裁决) → 六边形区块
 *  - 内容: 海拔/湿度/气候带 = 坐标的纯噪声函数 (含出生岛保障),
 *          区域/聚落/灵脉 = 全球晶格哈希, 道路 = 纯函数代价场 A*
 *          → 无限世界跨区块、跨会话完全一致
 * ============================================================ */
(function (global) {
  'use strict';
  var NL = global.NoiseLib;

  var BIOME = { DEEP: 0, OCEAN: 1, BEACH: 2, GRASS: 3, FOREST: 4, DESERT: 5, MOUNTAIN: 6, SNOW: 7 };

  var BIOME_META = [
    { key: 'deep',     name: '深海', color: '#93a4ac', water: true },
    { key: 'ocean',    name: '浅海', color: '#b2c1c3', water: true },
    { key: 'beach',    name: '沙岸', color: '#e0d3ae' },
    { key: 'grass',    name: '草地', color: '#b4c3a0' },
    { key: 'forest',   name: '林地', color: '#89a27f' },
    { key: 'desert',   name: '沙漠', color: '#dbc692' },
    { key: 'mountain', name: '山地', color: '#a19a8c' },
    { key: 'snow',     name: '雪峰', color: '#e8e5dc' }
  ];

  var SEA_LEVEL = 0.40;
  var HEX_R = 8;                          // 外接圆半径 → 直径 16
  var HEX_W = Math.sqrt(3) * HEX_R;
  var CHUNK_R = 10;                       // 区块六边形半径 (格)
  var CHUNK_S = 2 * CHUNK_R + 1;          // 区块中心间距 (21)
  var CHUNK_SCAN = 15;                    // 区块构建扫描半径: 胞腔最远可达 14 格, 15 保证全覆盖无缝
  var REGION_M = 18;                      // 区域晶格间距
  var VEIN_V = 44;                        // 灵脉晶格间距

  /* 邻居槽位 (轴坐标) 按 60°*k 排列: 0:东 1:东南 2:西南 3:西 4:西北 5:东北 */
  var NEIGH_SLOTS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

  /* ---------- 命名词库 (觅长生风) ---------- */
  var NAME = {
    sectPre: ['青云', '太虚', '玄天', '紫霄', '万剑', '丹霞', '天机', '御灵', '幽冥', '凌霄',
              '沧澜', '昆吾', '流月', '星宿', '百花', '落霞', '无极', '太一', '白帝', '赤霄',
              '紫阳', '归元', '掩月', '化剑', '黄枫', '掩日'],
    sectSuf: ['剑宗', '剑派', '丹宗', '宗', '门', '谷', '阁', '山庄', '寺', '教'],
    cityPre: ['青州', '临仙', '白玉', '建木', '云京', '望舒', '承天', '安宁', '朔方', '江都',
              '天南', '元武', '庆云', '金鳌'],
    townPre: ['落雁', '清风', '石桥', '柳林', '甘泉', '白沙', '铜锣', '乌衣', '枫桥', '梅溪',
              '赤水', '黄泥', '青石', '芦渡'],
    villPre: ['杏花', '溪头', '竹里', '南塘', '上河', '枣阳', '古井', '桑园', '芦花', '石磨',
              '桃溪', '坡底', '东陵', '西泽'],
    regionByBiome: {
      3: { pre: ['青云', '苍梧', '白鹿', '栖霞', '临水', '云梦', '平芜', '清河', '金穗', '龙泉', '广济', '安丰'], suf: ['郡', '原', '川', '野', '州', '乡'] },
      4: { pre: ['苍莽', '翠微', '青冥', '迷雾', '落木', '万木', '云杉', '藤萝', '幽篁', '百草'], suf: ['林', '泽', '谷', '坞'] },
      5: { pre: ['黄沙', '大漠', '流金', '鸣沙', '白龙', '燕然', '阳关', '玉门', '居延', '瀚海'], suf: ['沙', '漠', '碛', '原'] },
      6: { pre: ['苍山', '昆仑', '太乙', '斜月', '断魂', '摘星', '凌云', '天柱', '剑门', '悬空', '摩天', '铁背'], suf: ['山脉', '岭', '嶂', '山区'] },
      7: { pre: ['朔风', '苍雪', '长白', '寒酥', '霜天', '苦寒'], suf: ['雪原', '冰原', '岭'] },
      2: { pre: ['碧波', '金沙', '月牙', '听潮', '观澜'], suf: ['滩', '湾', '海岸'] }
    },
    sea: ['沧澜海', '东冥海', '北溟海', '碧落海', '无涯海', '归墟海', '流波海', '弱水海'],
    poi: ['星坠秘境', '古修洞府', '灵泉福地', '上古遗迹', '锁妖塔残址', '仙人遗冢', '藏经洞', '剑冢', '丹炉遗谷', '缚灵渊']
  };

  /* ---------- 状态 ---------- */
  var seedStr = '', seed = 0;
  var nElev, nRidge, nMoist, nWarp, nMask, nDetail;
  var elevCache = new Map();
  var fieldCache = new Map();
  var regionCache = new Map();   // "i,j" -> 区域信息
  var settleCache = new Map();   // "i,j" -> 聚落数组
  var roadCache = new Map();     // "a|b" -> 道路
  var veinCache = new Map();     // "i,j" -> 灵脉 | null

  /* ---------- 基础工具 ---------- */
  function hash01(a, b, salt) {
    var h = (seed ^ Math.imul(salt + 1, 0x9E3779B9)) >>> 0;
    h = Math.imul(h ^ (a | 0), 0x85EBCA6B) >>> 0;
    h = Math.imul(h ^ (b | 0), 0xC2B2AE35) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function hexDist(aq, ar, bq, br) {
    var dq = aq - bq, dr = ar - br;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }
  function tileToWorld(q, r) {
    return { x: HEX_W * (q + r / 2), y: 1.5 * HEX_R * r };
  }
  /* 世界像素 → 格 (立方取整) */
  function pxToTile(wx, wy) {
    var rf = wy / (1.5 * HEX_R);
    var qf = wx / HEX_W - rf / 2;
    var xf = qf, yf = -qf - rf, zf = rf;
    var x = Math.round(xf), y = Math.round(yf), z = Math.round(zf);
    var dx = Math.abs(x - xf), dy = Math.abs(y - yf), dz = Math.abs(z - zf);
    if (dx > dy && dx > dz) x = -y - z;
    else if (dy > dz) y = -x - z;
    else z = -x - y;
    return { q: x, r: z };
  }

  /* ---------- 初始化 ---------- */
  function init(seedString) {
    seedStr = String(seedString);
    seed = NL.hashSeed(seedStr);
    var rng = NL.mulberry32(seed ^ 0x9E3779B9);
    nElev = new NL.SimplexNoise(rng);
    nRidge = new NL.SimplexNoise(rng);
    nMoist = new NL.SimplexNoise(rng);
    nWarp = new NL.SimplexNoise(rng);
    nMask = new NL.SimplexNoise(rng);
    nDetail = new NL.SimplexNoise(rng);
    elevCache.clear(); fieldCache.clear();
    regionCache.clear(); settleCache.clear();
    roadCache.clear(); veinCache.clear();
  }

  /* ---------- 海拔场 (纯函数, 带缓存) ---------- */
  function elevAt(q, r) {
    var key = q + ',' + r;
    var c = elevCache.get(key);
    if (c !== undefined) return c;
    var s = 0.022;
    var q1 = NL.fbm(nWarp, q * s * 0.6 + 13.7, r * s * 0.6 + 91.2, 2);
    var q2 = NL.fbm(nWarp, q * s * 0.6 - 45.1, r * s * 0.6 + 7.4, 2);
    var e01 = NL.fbm(nElev, (q + q1 * 10) * s, (r + q2 * 10) * s, 5) * 0.5 + 0.5;
    var rg = NL.ridged(nRidge, q * s * 0.5, r * s * 0.5, 4);
    var mask = NL.smoothstep(0.34, 0.60, NL.fbm(nMask, q * s * 0.24 + 7.3, r * s * 0.24 - 3.1, 3) * 0.5 + 0.5);
    // 出生地岛屿: 保证原点附近有成片陆地
    var d0 = Math.sqrt(q * q + r * r);
    var spawn = Math.max(0, 1 - d0 / 70);
    var e = NL.clamp(0.06 + e01 * (0.50 + 0.60 * mask) + Math.pow(rg, 2.6) * 0.55 * mask
           + spawn * spawn * 0.30, 0, 1);
    if (elevCache.size > 150000) elevCache.clear();
    elevCache.set(key, e);
    return e;
  }

  /* ---------- 完整地块场 ---------- */
  function fields(q, r) {
    var key = q + ',' + r;
    var c = fieldCache.get(key);
    if (c) return c;

    var e = elevAt(q, r);
    var s = 0.022;
    var m = NL.clamp(NL.fbm(nMoist, q * s * 0.55 + 31, r * s * 0.55 - 17, 4) * 0.5 + 0.5, 0, 1);
    // 气候带: 沿 y 方向的周期纬度 + 噪声 + 海拔递减
    var y = 1.5 * HEX_R * r;
    var band = Math.cos((y / 2600) * Math.PI);
    var t = NL.clamp(0.5 + 0.45 * band + NL.fbm(nDetail, q * s, r * s, 2) * 0.22
           - Math.max(0, e - 0.60) * 0.9, 0, 1);

    var h = hash01(q, r, 3);
    var variant = (h * 997.3) % 4 | 0;

    var biome;
    if (e < SEA_LEVEL - 0.060) biome = BIOME.DEEP;
    else if (e < SEA_LEVEL) biome = BIOME.OCEAN;
    else if (e < SEA_LEVEL + 0.016 + h * 0.010) {
      // 沙滩需真正邻水 (六邻探测, 纯局部 → 跨区块一致)
      var nearWater = false;
      for (var k = 0; k < 6; k++) {
        if (elevAt(q + NEIGH_SLOTS[k][0], r + NEIGH_SLOTS[k][1]) < SEA_LEVEL - 0.02) { nearWater = true; break; }
      }
      biome = nearWater ? BIOME.BEACH : (m > 0.62 ? BIOME.FOREST : BIOME.GRASS);
    }
    else if (e > 0.84) biome = BIOME.SNOW;
    else if (e > 0.70) biome = BIOME.MOUNTAIN;
    else if (m < 0.32 && t > 0.60) biome = BIOME.DESERT;
    else if (m + Math.max(0, 0.14 - (e - SEA_LEVEL) * 1.4) > 0.62) biome = BIOME.FOREST; // 海岸加湿
    else biome = BIOME.GRASS;

    var w = tileToWorld(q, r);
    c = { q: q, r: r, x: w.x, y: w.y, e: e, m: m, t: t, biome: biome, variant: variant, hash: h };
    if (fieldCache.size > 150000) fieldCache.clear();
    fieldCache.set(key, c);
    return c;
  }

  /* ---------- 六边形区块 ---------- */
  function chunkKey(ca, cb) { return ca + ',' + cb; }
  function chunkCenter(ca, cb) { return { q: ca * CHUNK_S, r: cb * CHUNK_S }; }

  /* 地块 → 所属区块中心 (四候选最近 + 固定平局顺序) */
  function chunkOfTile(q, r) {
    var S = CHUNK_S;
    var q0 = Math.floor(q / S) * S, r0 = Math.floor(r / S) * S;
    var cq = q0, cr = r0, bd = 1e18;
    for (var i = 0; i < 4; i++) {
      var tq = q0 + (i % 2) * S, tr = r0 + (i >> 1) * S;
      var d = hexDist(q, r, tq, tr);
      if (d < bd - 1e-9) { bd = d; cq = tq; cr = tr; }
    }
    return { ca: cq / S, cb: cr / S, q: cq, r: cr };
  }

  /* 构建一个区块的实例数据 (供渲染器上传)
     关键: 四候选最近中心虽保证归属唯一, 但胞腔在斜向可达 14 格,
     扫描半径必须 >= CHUNK_SCAN, 否则区块间出现楔形空洞 */
  function buildChunk(ca, cb) {
    var cc = chunkCenter(ca, cb);
    var R = CHUNK_SCAN;
    var centers = [], tiles = [], elevs = [], hashes = [], neigh = [];
    var bbox = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
    for (var dq = -R; dq <= R; dq++) {
      for (var dr = -R; dr <= R; dr++) {
        var q = cc.q + dq, r = cc.r + dr;
        if (hexDist(q, r, cc.q, cc.r) > CHUNK_SCAN) continue;
        var own = chunkOfTile(q, r);
        if (own.q !== cc.q || own.r !== cc.r) continue;
        var f = fields(q, r);
        centers.push(f.x, f.y);
        tiles.push(f.biome * 4 + f.variant);
        elevs.push(f.e);
        hashes.push(f.hash);
        var packed = 0;
        for (var k = 0; k < 6; k++) {
          var nf = fields(q + NEIGH_SLOTS[k][0], r + NEIGH_SLOTS[k][1]);
          packed += nf.biome * Math.pow(8, k);
        }
        neigh.push(packed);
        if (f.x < bbox.x0) bbox.x0 = f.x;
        if (f.x > bbox.x1) bbox.x1 = f.x;
        if (f.y < bbox.y0) bbox.y0 = f.y;
        if (f.y > bbox.y1) bbox.y1 = f.y;
      }
    }
    return {
      key: chunkKey(ca, cb), ca: ca, cb: cb,
      count: tiles.length,
      data: {
        centers: new Float32Array(centers),
        tiles: new Float32Array(tiles),
        elevs: new Float32Array(elevs),
        hashes: new Float32Array(hashes),
        neigh: new Float32Array(neigh)
      },
      bbox: bbox
    };
  }

  /* ---------- 区域 (晶格抖动 Voronoi) ---------- */
  function regionSeedOf(q, r) {
    var M = REGION_M;
    var i0 = Math.floor(q / M), j0 = Math.floor(r / M);
    var bi = i0, bj = j0, bd = 1e18, bq = 0, br = 0;
    for (var di = 0; di <= 1; di++) {
      for (var dj = 0; dj <= 1; dj++) {
        var i = i0 + di, j = j0 + dj;
        var sq = i * M + (hash01(i, j, 11) - 0.5) * M * 0.6;
        var sr = j * M + (hash01(i, j, 12) - 0.5) * M * 0.6;
        var d = hexDist(q, r, Math.round(sq), Math.round(sr));
        if (d < bd - 1e-9) { bd = d; bi = i; bj = j; bq = Math.round(sq); br = Math.round(sr); }
      }
    }
    return { i: bi, j: bj, q: bq, r: br };
  }

  function regionInfo(i, j) {
    var key = i + ',' + j;
    var c = regionCache.get(key);
    if (c) return c;
    var sq = Math.round(i * REGION_M + (hash01(i, j, 11) - 0.5) * REGION_M * 0.6);
    var sr = Math.round(j * REGION_M + (hash01(i, j, 12) - 0.5) * REGION_M * 0.6);
    var f = fields(sq, sr);
    var name;
    if (f.biome <= BIOME.OCEAN) {
      name = NAME.sea[(hash01(i, j, 13) * NAME.sea.length) | 0];
    } else {
      var pool = NAME.regionByBiome[f.biome] || NAME.regionByBiome[3];
      name = pool.pre[(hash01(i, j, 14) * pool.pre.length) | 0] +
             pool.suf[(hash01(i, j, 15) * pool.suf.length) | 0];
    }
    c = { i: i, j: j, q: sq, r: sr, x: tileToWorld(sq, sr).x, y: tileToWorld(sq, sr).y, biome: f.biome, name: name };
    regionCache.set(key, c);
    return c;
  }

  /* ---------- 聚落 ---------- */
  function mountainNear(q, r, rad) {
    for (var dq = -rad; dq <= rad; dq++) {
      for (var dr = -rad; dr <= rad; dr++) {
        if (hexDist(q, r, q + dq, r + dr) > rad) continue;
        var b = fields(q + dq, r + dr).biome;
        if (b === BIOME.MOUNTAIN || b === BIOME.SNOW) return true;
      }
    }
    return false;
  }

  function genName(type, i, j, k) {
    function pick(arr, salt) { return arr[(hash01(i * 7 + k, j * 13 + k, salt) * arr.length) | 0]; }
    if (type === 'sect') return pick(NAME.sectPre, 1) + pick(NAME.sectSuf, 2);
    if (type === 'city') return pick(NAME.cityPre, 3) + '城';
    if (type === 'town') return pick(NAME.townPre, 4) + pick(NAME.townSuf || ['坊市', '镇', '集'], 5);
    if (type === 'poi') return pick(NAME.poi, 6);
    return pick(NAME.villPre, 7) + '村';
  }
  NAME.townSuf = ['坊市', '镇', '集'];

  function settlementsFor(i, j) {
    var key = i + ',' + j;
    var c = settleCache.get(key);
    if (c) return c;
    var arr = [];
    var h0 = hash01(i, j, 7);
    if (h0 < 0.46) {
      var count = h0 < 0.30 ? 1 : 2;
      for (var k = 0; k < count; k++) {
        var sq = i * REGION_M + (hash01(i, j, 21 + k) - 0.5) * REGION_M * 0.7;
        var sr = j * REGION_M + (hash01(i, j, 31 + k) - 0.5) * REGION_M * 0.7;
        var placed = null;
        for (var t = 0; t < 4; t++) {
          var tq = Math.round(sq + (hash01(i, j, 41 + k * 4 + t) - 0.5) * 12);
          var tr = Math.round(sr + (hash01(i, j, 61 + k * 4 + t) - 0.5) * 12);
          var f = fields(tq, tr);
          if (f.biome >= BIOME.GRASS && f.biome <= BIOME.DESERT) { placed = f; break; }
        }
        if (!placed) continue;
        var hr = hash01(i, j, 81 + k);
        var type = hr < 0.16 ? 'sect' : hr < 0.28 ? 'city' : hr < 0.52 ? 'town' : 'village';
        if (type === 'sect' && !mountainNear(placed.q, placed.r, 6)) type = 'town';
        var pop = type === 'sect' ? (hash01(i, j, 91) * 4000 + 2000) | 0
                : type === 'city' ? (hash01(i, j, 92) * 30000 + 40000) | 0
                : type === 'town' ? (hash01(i, j, 93) * 6000 + 4000) | 0
                : (hash01(i, j, 94) * 900 + 200) | 0;
        arr.push({
          id: i + '_' + j + '_' + k, type: type,
          q: placed.q, r: placed.r, x: placed.x, y: placed.y,
          name: genName(type, i, j, k), pop: pop
        });
      }
      // 秘境: 8% 的区域格, 落在荒僻地块
      if (hash01(i, j, 71) < 0.08) {
        var pq = Math.round(i * REGION_M + (hash01(i, j, 72) - 0.5) * REGION_M * 0.8);
        var pr = Math.round(j * REGION_M + (hash01(i, j, 73) - 0.5) * REGION_M * 0.8);
        var pf = fields(pq, pr);
        if (pf.biome >= BIOME.FOREST && pf.biome !== BIOME.BEACH) {
          arr.push({ id: i + '_' + j + '_p', type: 'poi', q: pq, r: pr, x: pf.x, y: pf.y,
                     name: genName('poi', i, j, 9), pop: 0 });
        }
      }
    }
    settleCache.set(key, arr);
    return arr;
  }

  /* ---------- 道路 (纯函数代价场 A*) ---------- */
  function roadCost(f) {
    if (f.biome <= BIOME.OCEAN) return -1;
    var base = [0, 0, 1.4, 1.0, 1.7, 2.6, 7.0, 5.0][f.biome];
    return base * (0.9 + f.hash * 0.2);
  }

  /* 二叉小顶堆: 元素 [q, r], 权值 f */
  function Heap() { this.a = []; this.p = []; }
  Heap.prototype.push = function (v, pri) {
    var a = this.a, p = this.p, i = a.length;
    a.push(v); p.push(pri);
    while (i > 0) {
      var par = (i - 1) >> 1;
      if (p[par] <= p[i]) break;
      var tv = a[i]; a[i] = a[par]; a[par] = tv;
      var tp = p[i]; p[i] = p[par]; p[par] = tp;
      i = par;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a, p = this.p;
    if (!a.length) return null;
    var top = a[0], lv = a.pop(), lp = p.pop();
    if (a.length) {
      a[0] = lv; p[0] = lp;
      var i = 0, n = a.length;
      for (;;) {
        var l = i * 2 + 1, r2 = l + 1, m = i;
        if (l < n && p[l] < p[m]) m = l;
        if (r2 < n && p[r2] < p[m]) m = r2;
        if (m === i) break;
        var tv = a[i]; a[i] = a[m]; a[m] = tv;
        var tp = p[i]; p[i] = p[m]; p[m] = tp;
        i = m;
      }
    }
    return top;
  };

  function astar(sq, sr, tq, tr) {
    var g = new Map(), prev = new Map(), closed = new Set();
    var open = new Heap();
    var sk = sq + ',' + sr;
    g.set(sk, 0);
    open.push([sq, sr], hexDist(sq, sr, tq, tr));
    var guard = 0;
    while (guard++ < 60000) {
      var cur = open.pop();
      if (!cur) return null;
      var cq = cur[0], cr = cur[1], ck = cq + ',' + cr;
      if (closed.has(ck)) continue;
      closed.add(ck);
      if (cq === tq && cr === tr) {
        var path = [], p = ck;
        while (p) {
          var parts = p.split(',');
          path.push([+parts[0], +parts[1]]);
          p = prev.get(p);
        }
        path.reverse();
        return path;
      }
      for (var k = 0; k < 6; k++) {
        var nx = cq + NEIGH_SLOTS[k][0], ny = cr + NEIGH_SLOTS[k][1];
        var f = fields(nx, ny);
        var c = roadCost(f);
        if (c < 0) continue;
        var nk = nx + ',' + ny;
        if (closed.has(nk)) continue;
        var ng = g.get(ck) + c;
        if (ng < (g.has(nk) ? g.get(nk) : 1e18)) {
          g.set(nk, ng);
          prev.set(nk, ck);
          open.push([nx, ny], ng + hexDist(nx, ny, tq, tr));
        }
      }
    }
    return null;
  }

  /* 某区域格内聚落的对外道路 (缓存, 全局去重) */
  function roadsNear(i, j) {
    var cellKey = i + ',' + j;
    var mine = settlementsFor(i, j);
    var out = [];
    for (var s = 0; s < mine.length; s++) {
      var a = mine[s];
      if (a.type === 'poi') continue;
      // 3x3 邻域格内其他聚落
      var cands = [];
      for (var di = -1; di <= 1; di++) {
        for (var dj = -1; dj <= 1; dj++) {
          var others = settlementsFor(i + di, j + dj);
          for (var o = 0; o < others.length; o++) {
            if (others[o].id === a.id || others[o].type === 'poi') continue;
            cands.push(others[o]);
          }
        }
      }
      cands.sort(function (p, q2) {
        return hexDist(a.q, a.r, p.q, p.r) - hexDist(a.q, a.r, q2.q, q2.r);
      });
      var want = a.type === 'sect' ? 2 : 1;
      var linked = 0;
      for (var c2 = 0; c2 < cands.length && linked < want; c2++) {
        var b = cands[c2];
        var rkey = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        var road = roadCache.get(rkey);
        if (!road) {
          var path = astar(a.q, a.r, b.q, b.r);
          if (!path) continue;
          var pts = [], tset = new Set();
          for (var pj = 0; pj < path.length; pj++) {
            var w = tileToWorld(path[pj][0], path[pj][1]);
            pts.push({ x: w.x + (hash01(path[pj][0], path[pj][1], 5) - 0.5) * 4,
                       y: w.y + (hash01(path[pj][0], path[pj][1], 6) - 0.5) * 4 });
            tset.add(path[pj][0] + ',' + path[pj][1]);
          }
          road = { key: rkey, pts: pts, tiles: tset,
                   x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
                   y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
          roadCache.set(rkey, road);
        }
        out.push(road);
        linked++;
      }
    }
    return out;
  }

  /* ---------- 灵脉 (晶格哈希, 高山发源, 下山入海) ---------- */
  function veinAt(i, j) {
    var key = i + ',' + j;
    var c = veinCache.get(key);
    if (c !== undefined) return c;
    var vein = null;
    if (hash01(i, j, 77) < 0.38) {
      var sq = i * VEIN_V + (hash01(i, j, 78) - 0.5) * VEIN_V * 0.5;
      var sr = j * VEIN_V + (hash01(i, j, 79) - 0.5) * VEIN_V * 0.5;
      var q = Math.round(sq), r = Math.round(sr);
      if (elevAt(q, r) > 0.72) {
        var pts = [], tiles2 = [];
        for (var step = 0; step < 90; step++) {
          var e0 = elevAt(q, r);
          pts.push(tileToWorld(q, r));
          tiles2.push(q + ',' + r);
          var bestT = -1, bestE = e0;
          for (var k = 0; k < 6; k++) {
            var nq = q + NEIGH_SLOTS[k][0], nr = r + NEIGH_SLOTS[k][1];
            var ne = elevAt(nq, nr) - hash01(nq, nr, 88) * 0.02;
            if (ne < bestE) { bestE = ne; bestT = k; }
          }
          if (bestT < 0) break;
          q += NEIGH_SLOTS[bestT][0];
          r += NEIGH_SLOTS[bestT][1];
          if (elevAt(q, r) < SEA_LEVEL - 0.02) break;   // 入海而止
        }
        if (pts.length > 10) {
          vein = { name: '灵脉·' + i + '_' + j, pts: pts, tiles: tiles2 };
        }
      }
    }
    veinCache.set(key, vein);
    return vein;
  }

  /* ---------- 导出 ---------- */
  global.MapGen = {
    init: init,
    fields: fields,
    elevAt: elevAt,
    buildChunk: buildChunk,
    chunkOfTile: chunkOfTile,
    chunkKey: chunkKey,
    regionSeedOf: regionSeedOf,
    regionInfo: regionInfo,
    settlementsFor: settlementsFor,
    roadsNear: roadsNear,
    veinAt: veinAt,
    pxToTile: pxToTile,
    tileToWorld: tileToWorld,
    hexDist: hexDist,
    mountainNear: mountainNear,
    roadCache: roadCache,
    settleCache: settleCache,
    veinCache: veinCache,
    HEX_R: HEX_R,
    HEX_W: HEX_W,
    CHUNK_R: CHUNK_R,
    CHUNK_S: CHUNK_S,
    CHUNK_SCAN: CHUNK_SCAN,
    REGION_M: REGION_M,
    VEIN_V: VEIN_V,
    SEA_LEVEL: SEA_LEVEL,
    BIOME: BIOME,
    BIOME_META: BIOME_META
  };
})(window);
