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
    { key: 'deep',     name: '深海', color: '#6d9aab', water: true },
    { key: 'ocean',    name: '浅海', color: '#9dc2c9', water: true },
    { key: 'beach',    name: '沙岸', color: '#e0d3ae' },
    { key: 'grass',    name: '草地', color: '#b4c3a0' },
    { key: 'forest',   name: '林地', color: '#89a27f' },
    { key: 'desert',   name: '沙漠', color: '#dbc692' },
    { key: 'mountain', name: '山地', color: '#a19a8c' },
    { key: 'snow',     name: '雪峰', color: '#e8e5dc' },
    /* 灵脉格 (disp biome 8..12): 金木水火土 */
    { key: 'vein-metal', name: '金灵脉', color: '#c4b078' },
    { key: 'vein-wood',  name: '木灵脉', color: '#688c56' },
    { key: 'vein-water', name: '水灵脉', color: '#56748e' },
    { key: 'vein-fire',  name: '火灵脉', color: '#b04832' },
    { key: 'vein-earth', name: '土灵脉', color: '#98784f' }
  ];

  var SEA_LEVEL = 0.40;
  var HEX_R = 8;                          // 外接圆半径 → 直径 16
  var HEX_W = Math.sqrt(3) * HEX_R;
  var CHUNK_R = 10;                       // 区块六边形半径 (格)
  var CHUNK_S = 2 * CHUNK_R + 1;          // 区块中心间距 (21)
  var CHUNK_SCAN = 15;                    // 区块构建扫描半径: 胞腔最远可达 14 格, 15 保证全覆盖无缝
  var REGION_M = 18;                      // 区域晶格间距

  /* ---------- 灵脉驱动世界 (灵脉地图设定: 先定灵脉, 后造山河) ----------
   * §十二: 参数全部集中在 CFG, 可用 MapGen.configure(patch) 运行时覆写 */
  var CFG = {
    COMM_CL: 150,                           // 群落晶格间距 ≈ 大灵脉最小中心距 D_L_L
    COMM_R: 40,                             // 群落半径 (格)
    D_L_M: 18, D_L_S: 12, D_M: 14, D_SMALL: 8,   // 群内最小间距 (格)
    SPIRIT_R_TILES: 1000,                   // 灵气边界半径 (格): 距原点 1000 处灵气归零
    SPIRIT_CURVE: 0.8,                      // 灵气衰减曲线指数 (缓)
    COMM_P_MIN: 0.16, COMM_P_SPIRIT: 0.62,  // 群落存在概率 = MIN + SPIRIT × 灵气
    SUB_ATTEMPTS: 14,                       // 次级灵脉落位尝试次数
    LIFT_CORE: [0.80, 0.75, 0.70],          // 大/中/小灵脉中心抬升目标
    LIFT_ARM_OFF: 0.05,                     // 七星从属格抬升减量
    /* 灵根生态呼应 (§六): d≤3 湿度/温度偏置 (水/木湿润、火干热、金微干) */
    ECO_WATER: 0.25, ECO_WOOD: 0.18,
    ECO_FIRE_DRY: 0.22, ECO_FIRE_HEAT: 0.15,
    ECO_METAL: 0.08
  };
  /* 五行: 0金 1木 2水 3火 4土 */
  var ELEMENTS = ['金', '木', '水', '火', '土'];
  var SHENG = [2, 3, 1, 4, 0];            // 相生: 金生水 木生火 水生木 火生土 土生金
  var KE = [1, 4, 3, 0, 2];               // 相克: 金克木 木克土 水克火 火克金 土克水
  var DUAL = { '0|3': '雷', '1|2': '风', '0|2': '冰', '3|4': '暗' };  // 相冲/相合 → 异灵根
  var ELEMENT_RGB = [
    [196, 176, 120], [104, 140, 86], [86, 116, 142], [176, 72, 50], [152, 120, 82]
  ];
  var VARIANT_RGB = { 雷: [142, 96, 190], 风: [118, 150, 148], 冰: [136, 168, 192], 暗: [96, 84, 110] };
  var LANDFORM = [
    ['白石岩峰', '金属矿脉', '剑意石林', '铁锈山脊', '金刚台地'],
    ['原始灵木林', '藤蔓深谷', '灵植圃', '千年树冠', '青苔湿地'],
    ['深潭', '瀑布', '海眼', '雾瘴湖泽', '环山湖'],
    ['熔岩裂隙', '活火山', '地热温泉', '焦土熔流', '火晶洞窟'],
    ['厚土丘陵', '矿藏山腹', '石脉土台', '黄土地', '岩层断崖']
  ];
  var VARIANT_LANDFORM = {
    雷: ['雷击崖', '紫电渊'], 风: ['风口峡谷', '风蚀柱'],
    冰: ['冰川', '寒潭'], 暗: ['缚灵渊', '幽冥涧']
  };

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
  var commCache = new Map();     // "i,j" -> 群落 | null
  var veinNearCache = new Map(); // "q,r" -> 灵脉近邻 {d, v} | null
  var roadFail = new Set();      // "a|b" -> 不可达聚落对 (A* 失败, 终身跳过)
  /* P3: 地块级缓存固定容量 (Map 保持插入序)。超限时每次淘汰最旧 1 条,
     单条 delete 的开销摊薄到每次插入 → 不再有「超大 Map 一次性删半」的长停顿;
     内存有界; 淘汰仅影响命中率, 不改变确定性结果。 */
  /* T1: region/settle/road/comm/roadFail 同样加固定容量 — 长期漫游不再线性增长。
     淘汰只损失命中率 (全部可按坐标确定性重算), 不改变任何输出。 */
  var ELEV_CAP = 40000;    // 海拔缓存: 视野区 + 探路邻域 ≈ 数十区块
  var FIELD_CAP = 30000;   // 完整地块场缓存 (每项含对象, 容量略小)
  var VEIN_CAP = 40000;    // 灵脉近邻缓存
  var REGION_CAP = 512;    // 区域信息
  var SETTLE_CAP = 1024;   // 区域聚落数组
  var ROAD_CAP = 4096;     // A* 道路 (含 pts/tiles, 单条较大)
  var COMM_CAP = 1024;     // 群落
  var ROADFAIL_CAP = 1024; // 不可达聚落对 (只影响重试频率)
  function cacheSet(m, key, val, cap) {
    m.set(key, val);
    if (m.size > cap) m.delete(m.keys().next().value);   // 淘汰最旧插入项
  }
  function setAdd(s, key, cap) {
    s.add(key);
    if (s.size > cap) s.delete(s.values().next().value);
  }

  /* 道路版本号: roadCache 每新增一条 A* 道路即 +1。
     服务端据此为 tile 缓存做新鲜度校验 — onRoad 语义依赖 roadCache 热状态,
     只有「真有新路落成」才需要失效旧 tile 缓存 (比按区域包生成计数更精准)。 */
  var roadVer = 0;

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
    roadCache.clear(); commCache.clear(); veinNearCache.clear();
    roadFail.clear();
    roadVer = 0;
  }

  /* ---------- 海拔场 (纯函数, 带缓存) ---------- */
  function elevAt(q, r) {
    return elevAtVN(q, r, null);
  }

  /* 海拔内部实现: vn 由调用方传入时复用, 避免 fields() 对同一格重复做
     「灵脉近邻」全量扫描 (elevAt 需要它迁就地貌, fields 还要它做生态/覆写) */
  function elevAtVN(q, r, vn) {
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
    /* 灵脉地形迁就 (设定 §八): 灵脉必是山, 水中灵脉必是岛; 周边过渡山丘 */
    if (!vn) vn = veinNear(q, r);
    if (vn) {
      var coreE = CFG.LIFT_CORE[vn.v.level] || 0.70;
      if (vn.d === 0) {                       // 中心格: 高山档
        if (e < SEA_LEVEL) e = SEA_LEVEL + 0.16;   // 水中灵脉 → 岛
        if (e < coreE) e = coreE;
      } else if (vn.d === 1) {                // 七星从属格: 山态
        if (e < SEA_LEVEL) e = SEA_LEVEL + 0.12;
        if (e < coreE - CFG.LIFT_ARM_OFF) e = coreE - CFG.LIFT_ARM_OFF;
      } else if (vn.d === 2) {                // 过渡: 部分抬升
        var t2 = coreE - 0.10;
        if (t2 > e) e = e + (t2 - e) * 0.55;
      } else {
        var t3 = coreE - 0.16;
        if (t3 > e) e = e + (t3 - e) * 0.35;
      }
    }
    cacheSet(elevCache, key, e, ELEV_CAP);
    return e;
  }

  /* ---------- 完整地块场 ---------- */
  function fields(q, r) {
    var key = q + ',' + r;
    var c = fieldCache.get(key);
    if (c) return c;

    /* P3: 灵脉近邻只取一次, 同时供 海拔迁就(elevAtVN) 与 下方生态偏置/灵脉覆写 复用 */
    var vn = veinNear(q, r);
    var e = elevAtVN(q, r, vn);
    var s = 0.022;
    var m = NL.clamp(NL.fbm(nMoist, q * s * 0.55 + 31, r * s * 0.55 - 17, 4) * 0.5 + 0.5, 0, 1);
    // 气候带: 沿 y 方向的周期纬度 + 噪声 + 海拔递减
    var y = 1.5 * HEX_R * r;
    var band = Math.cos((y / 2600) * Math.PI);
    var t = NL.clamp(0.5 + 0.45 * band + NL.fbm(nDetail, q * s, r * s, 2) * 0.22
           - Math.max(0, e - 0.60) * 0.9, 0, 1);

    var h = hash01(q, r, 3);
    var variant = (h * 997.3) % 4 | 0;

    /* 灵根生态呼应 (设定 §六): 灵脉 d≤3 范围湿度/温度按灵根偏置
       水/木湿润生林, 火干热化焦土, 金微干石化 */
    if (vn && vn.d <= 3) {
      var ew = vn.d === 1 ? 1 : vn.d === 2 ? 0.55 : 0.25;
      var ee = vn.v.element;
      if (ee === 2) m = NL.clamp(m + CFG.ECO_WATER * ew, 0, 1);
      else if (ee === 1) m = NL.clamp(m + CFG.ECO_WOOD * ew, 0, 1);
      else if (ee === 3) {
        m = NL.clamp(m - CFG.ECO_FIRE_DRY * ew, 0, 1);
        t = NL.clamp(t + CFG.ECO_FIRE_HEAT * ew, 0, 1);
      }
      else if (ee === 0) m = NL.clamp(m - CFG.ECO_METAL * ew, 0, 1);
    }

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

    /* 灵脉格: 覆写显示用 biome (8..12 = 金木水火土灵脉格) */
    var vinfo = null;
    if (vn && vn.d <= 1) {
      vinfo = { element: vn.v.element, variant: vn.v.variant,
                level: vn.v.level, d: vn.d, name: vn.v.name };
    }
    var disp = vinfo ? 8 + vinfo.element : biome;

    var w = tileToWorld(q, r);
    c = { q: q, r: r, x: w.x, y: w.y, e: e, m: m, t: t,
          biome: biome, disp: disp, vein: vinfo, variant: variant, hash: h };
    cacheSet(fieldCache, key, c, FIELD_CAP);
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

  /* ---------- 立体精灵分配 (超出格子的山/树/灵脉峰) ----------
   * 精灵索引 = 图集行*8+列:
   *   第 5 行: 40/41 山地·两变体, 42/43 雪峰·两变体, 44..47 林地·四变体
   *   第 6 行: 48 沙丘岩石, 49 草丛, 50..54 金木水火土灵脉峰
   *   第 7 行: 56/57 山地·横岭变体, 58/59 雪峰·横岭变体, 60/61 草地小山包, 62/63 草地孤树 */
  function propSpriteFor(f) {
    var b = f.disp != null ? f.disp : f.biome;
    if (b >= 8) return b + 42;                          // 灵脉峰 (50+元素)
    var v2 = (f.hash * 2) | 0;                          // 0/1 成对变体
    if (b === 6) {
      return (f.hash * 913.7) % 1 < 0.5 ? 40 + v2 : 56 + v2;   // 山峰全量渲染 (不按海拔取消)
    }
    if (b === 7) return (f.hash * 721.3) % 1 < 0.5 ? 42 + v2 : 58 + v2;
    if (b === 4) {
      var h2 = (f.hash * 913.7) % 1;
      /* 森林 4 个变体 (图集第 5 行 44..47 / 着色器同一注释): 乘子 5.34 在
         h2 ∈ [0.749064, 0.75) 时会算出 4 → 44+4=48 溢出到第 6 行的沙漠精灵
         (实测 8/7620 森林格 = 0.105% 的森林画出沙漠)。此处钳到 3 变体,
         权重与阈值不变, 只把那点溢出并入 47。 */
      return h2 < 0.75 ? 44 + Math.min(3, (h2 * 5.34) | 0) : -1;
    }
    if (b === 5) return (f.hash * 721.3) % 1 < 0.30 ? 48 : -1;
    if (b === 3) {
      /* 草地: 小山包(噪声调制密度 → 起伏成片) + 单棵孤树 + 草丛 */
      var mb = NL.fbm(nDetail, f.q * 0.09 + 88.8, f.r * 0.09 - 12.3, 2) * 0.5 + 0.5;
      if (f.hash < 0.10 + mb * 0.12) return 60 + v2;   // 小山包 10~22%
      if (f.hash < 0.14 + mb * 0.13) return 62 + v2;   // 单棵孤树 ~4~6%
      if (f.hash > 0.90) return 49;                    // 草丛 10%
      return -1;
    }
    return -1;
  }

  /* ---------- 山体聚类偏移 (noise 势场聚类) ----------
   * 低频噪声作"山势势能场", 山峰精灵沿势场梯度向上坡方向位移,
   * 坡越陡拉力越大、势能低处不动 → 成片山地向局部高点聚拢成组团峰林,
   * 消除逐格横排的"横隔"感。纯函数 (只依赖坐标与种子), 跨区块/跨会话一致。 */
  var CLUSTER_S = 0.0016;    // 势场频率 (世界像素): 波长 ≈ 600px ≈ 38 格, 决定山群尺度
  var CLUSTER_MAX = 36;      // 最大位移 (px) ≈ 2.2 格 (聚拢幅度加大 50% 后)
  var CLUSTER_JIT = 5;       // 附加随机抖动 (px), 防止聚成一点
  var CLUSTER_EPS = 26;      // 梯度采样步长 (px) (T14: 内联魔数提为具名常量)
  function clusterOffset(f) {
    var P = function (wx, wy) {
      return NL.fbm(nWarp, wx * CLUSTER_S + 51.3, wy * CLUSTER_S - 27.8, 2) * 0.5 + 0.5;
    };
    var p0 = P(f.x, f.y);
    var gx = P(f.x + CLUSTER_EPS, f.y) - P(f.x - CLUSTER_EPS, f.y);
    var gy = P(f.x, f.y + CLUSTER_EPS) - P(f.x, f.y - CLUSTER_EPS);
    var g = Math.sqrt(gx * gx + gy * gy);
    var pull = g / (g + 0.10);                      // 坡度 → 拉力 (饱和曲线)
    var wsum = NL.smoothstep(0.36, 0.58, p0);       // 只在势能高的山区聚拢
    var mag = CLUSTER_MAX * pull * wsum;
    var ux = g > 1e-5 ? gx / g : 0, uy = g > 1e-5 ? gy / g : 0;
    var ox = ux * mag + (hash01(f.q, f.r, 71) - 0.5) * 2 * CLUSTER_JIT;
    var oy = uy * mag + (hash01(f.q, f.r, 72) - 0.5) * 2 * CLUSTER_JIT;
    return { ox: ox, oy: oy };
  }

  /* 构建一个区块的实例数据 (供渲染器上传)
     关键: 四候选最近中心虽保证归属唯一, 但胞腔在斜向可达 14 格,
     扫描半径必须 >= CHUNK_SCAN, 否则区块间出现楔形空洞 */
  function buildChunk(ca, cb) {
    var cc = chunkCenter(ca, cb);
    var R = CHUNK_SCAN;
    /* T6: 两遍扫描 — 第一遍把扫描盘 R+1 内的全部地块 fields() 一次算齐
       (先归属后取场 → 取场与归属判定解耦, 且冷地块只算一次),
       第二遍逐格用数组下标取自身/邻居场, 消除逐格 6 邻居
       「拼字符串 key + Map.get」×7 的重复查找开销。
       纯重排不改变任何计算结果 (fields 是纯函数 + 缓存)。 */
    var R1 = R + 1, W2 = 2 * R1 + 1;
    var grid = new Array(W2 * W2);
    var dq0, dr0;
    for (dq0 = -R1; dq0 <= R1; dq0++) {
      for (dr0 = -R1; dr0 <= R1; dr0++) {
        if (hexDist(0, 0, dq0, dr0) > R1) continue;
        grid[(dq0 + R1) * W2 + (dr0 + R1)] = fields(cc.q + dq0, cc.r + dr0);
      }
    }
    var centers = [], tiles = [], elevs = [], hashes = [], neigh = [];
    var qrel = [], rrel = [];       // R3: tile 相对区块中心的整数轴向偏移 (dq,dr),
                                    //     供服务端直存整数偏移, 不做浮点反解
    var propCenters = [], propSprites = [], propHashes = [], propElevs = [];
    var propList = [];
    var bbox = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
    for (var dq = -R; dq <= R; dq++) {
      for (var dr = -R; dr <= R; dr++) {
        if (hexDist(dq, dr, 0, 0) > CHUNK_SCAN) continue;
        var own = chunkOfTile(cc.q + dq, cc.r + dr);
        if (own.q !== cc.q || own.r !== cc.r) continue;
        var f = grid[(dq + R1) * W2 + (dr + R1)];
        centers.push(f.x, f.y);
        qrel.push(dq); rrel.push(dr);
        tiles.push(f.biome * 4 + f.variant);   // 格底回归自然地形, 灵脉不再覆写深色底 (精灵仍按 disp 出灵脉峰)
        elevs.push(f.e);
        hashes.push(f.hash);
        var packed = 0;
        for (var k = 0; k < 6; k++) {
          var nf = grid[(dq + NEIGH_SLOTS[k][0] + R1) * W2 + (dr + NEIGH_SLOTS[k][1] + R1)];
          packed |= Math.min(nf.biome, 7) << (k * 3);   // P2: 3bit/邻居, 移位打包 (等价 *8^k)
        }
        neigh.push(packed);
        /* 立体精灵: 山/雪峰加噪声聚类偏移; 灵脉峰/林/沙/草保持原位 */
        var sp = propSpriteFor(f);
        if (sp >= 0) {
          var off = (f.vein == null && (f.biome === 6 || f.biome === 7))
                  ? clusterOffset(f) : { ox: 0, oy: 0 };
          propList.push({ x: f.x + off.ox, y: f.y + off.oy,
                          sp: sp, hash: f.hash, e: f.e });
        }
        if (f.x < bbox.x0) bbox.x0 = f.x;
        if (f.x > bbox.x1) bbox.x1 = f.x;
        if (f.y < bbox.y0) bbox.y0 = f.y;
        if (f.y > bbox.y1) bbox.y1 = f.y;
      }
    }
    /* 聚类偏移打乱了行序, 按 最终 y 升序重排 → 遮挡序仍正确 */
    propList.sort(function (a, b) { return a.y - b.y; });
    for (var pi = 0; pi < propList.length; pi++) {
      var pr = propList[pi];
      propCenters.push(pr.x, pr.y);
      propSprites.push(pr.sp);
      propHashes.push(pr.hash);
      propElevs.push(pr.e);
    }
    return {
      key: chunkKey(ca, cb), ca: ca, cb: cb,
      count: tiles.length,
      data: {
        centers: new Float32Array(centers),
        qrel: qrel, rrel: rrel,          // R3: 整数轴向相对偏移 (与 centers 同序)
        tiles: new Float32Array(tiles),
        elevs: new Float32Array(elevs),
        hashes: new Float32Array(hashes),
        neigh: new Float32Array(neigh),
        propCenters: new Float32Array(propCenters),
        propSprites: new Float32Array(propSprites),
        propHashes: new Float32Array(propHashes),
        propElevs: new Float32Array(propElevs)
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
    cacheSet(regionCache, key, c, REGION_CAP);
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
    /* 灵气梯度 (设定 §九/§十): 聚落密度随灵气衰减, 1000 外无灵凡俗 */
    var spLoc = spiritAt(i * REGION_M, j * REGION_M);
    if (h0 < 0.20 + 0.38 * spLoc) {
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
        /* 灵脉亲和 (设定 §十一): 灵脉域内宗门概率与人口提升 */
        var cn = communityNear(placed.q, placed.r);
        var inVeinDomain = !!(cn && cn.dist < CFG.COMM_R * 1.4);
        var hr = hash01(i, j, 81 + k);
        var type = hr < (inVeinDomain ? 0.24 : 0.14) ? 'sect'
                 : hr < 0.28 ? 'city' : hr < 0.52 ? 'town' : 'village';
        if (type === 'sect' && !mountainNear(placed.q, placed.r, 6)) type = 'town';
        var pop = type === 'sect' ? (hash01(i, j, 91) * 4000 + 2000) | 0
                : type === 'city' ? (hash01(i, j, 92) * 30000 + 40000) | 0
                : type === 'town' ? (hash01(i, j, 93) * 6000 + 4000) | 0
                : (hash01(i, j, 94) * 900 + 200) | 0;
        if (inVeinDomain && type !== 'sect') pop = (pop * 1.3) | 0;
        /* 实体骨架字段 (WebSocket 单块接口设计 §3.4): tier 等级/规模,
           state 状态机位 (0活跃 1被毁 2刷新中 3事件态), owner 归属,
           expireTs 到期刷新 (0=永久)。当前世界为确定性无事件态:
           state 恒 0、owner 空、expireTs 恒 0, 字段先落地供事件系统接入。 */
        var tier = type === 'sect' ? 1 + ((hash01(i, j, 95) * 3) | 0)
                 : type === 'city' ? 3
                 : type === 'town' ? 2 : 1;
        arr.push({
          id: i + '_' + j + '_' + k, type: type,
          q: placed.q, r: placed.r, x: placed.x, y: placed.y,
          name: genName(type, i, j, k), pop: pop,
          owner: '', tier: tier, state: 0, expireTs: 0
        });
      }
      // 秘境: 8% 的区域格, 落在荒僻地块
      if (hash01(i, j, 71) < 0.08) {
        var pq = Math.round(i * REGION_M + (hash01(i, j, 72) - 0.5) * REGION_M * 0.8);
        var pr = Math.round(j * REGION_M + (hash01(i, j, 73) - 0.5) * REGION_M * 0.8);
        var pf = fields(pq, pr);
        if (pf.biome >= BIOME.FOREST && pf.biome !== BIOME.BEACH) {
          arr.push({ id: i + '_' + j + '_p', type: 'poi', q: pq, r: pr, x: pf.x, y: pf.y,
                     name: genName('poi', i, j, 9), pop: 0,
                     owner: '', tier: 1 + ((hash01(i, j, 96) * 2) | 0), state: 0, expireTs: 0 });
        }
      }
    }
    cacheSet(settleCache, key, arr, SETTLE_CAP);
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
    /* 迭代上限 ASTAR_GUARD: 必须只排除「本来就不可达/代价过高」的聚落对, 不能
       伤及真实可通行的路。原值 60000 的问题: 海岸破碎区里隔水不可达的聚落对,
       搜索会探完整片大陆才放弃 —— 单次 regionJson 实测最长 5.1s (最坏 10.7s),
       而该生成同步持有 V8 门闩 → 该 seed 所有请求排队超时 → 黑区 + 卡死 + CPU 满。
       基准 (verify/bench_guard.mjs + bench_roads_lost.mjs, 4000 region 采样):
         guard=60000 → 最慢 region 5053ms, 道路 371 条, 总耗时 53.1s
         guard=12000 → 最慢 region  540ms, 道路 371 条, 总耗时 16.3s
         guard=  6000 → 最慢 region   32ms, 道路 371 条, 总耗时 10.9s
       三档道路条数完全一致 (= 零道路损失)。取 12000: 相对实测所需 (无一对超过
       6000 步) 留 2x 余量, 同时把最坏卡顿压到亚秒级。回归见 verify/w3_astar_budget.mjs。 */
    var guard = 0;
    while (guard++ < 12000) {
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

  /* 某区域格内聚落的对外道路 (缓存, 全局去重, 预算制)
     maxNew: 本次调用允许新算的 A* 条数; 0 = 纯读缓存 (绘制帧用), 防止 A* 卡帧 */
  function roadsNear(i, j, maxNew) {
    var budget = maxNew | 0;
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
        if (roadFail.has(rkey)) continue;          // 已判定不可达: 终身跳过
        var road = roadCache.get(rkey);
        if (!road) {
          if (budget <= 0) continue;               // 预算用尽: 本帧不算
          budget--;
          /* 方向归一化: A* 端点固定按 id 序 (小→大), 使道路点列方向
             与「哪个聚落先发起建路」无关 —— 否则热缓存命中与冷生成
             会得到同一路径的相反点列, 破坏跨会话一致性。 */
          var pA = a, pB = b;
          if (b.id < a.id) { pA = b; pB = a; }
          var path = astar(pA.q, pA.r, pB.q, pB.r);
          if (!path) { setAdd(roadFail, rkey, ROADFAIL_CAP); continue; }
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
          cacheSet(roadCache, rkey, road, ROAD_CAP);
          roadVer++;                               // 新道路落成 → tile onRoad 缓存整体失效
        }
        out.push(road);
        linked++;
      }
    }
    return out;
  }

  /* ---------- 灵气场 / 群落 / 灵脉 (设定: 先定灵脉, 后造山河) ---------- */

  /* 灵气场 (设定 §九): 以 (0,0) 为灵气中枢, 欧氏直线距离单调衰减,
     半径 SPIRIT_R_TILES 处归零; 越近群落越密、聚落越繁华 */
  function spiritAt(q, r) {
    var w = tileToWorld(q, r);
    var d = Math.sqrt(w.x * w.x + w.y * w.y) / (CFG.SPIRIT_R_TILES * HEX_R * 2);
    var t = Math.max(0, 1 - d);
    return Math.pow(t, CFG.SPIRIT_CURVE);
  }

  /* 相冲/相合对 → 异灵根 */
  function dualOf(a, b) {
    return DUAL[Math.min(a, b) + '|' + Math.max(a, b)] || null;
  }

  function pickLandform(el, variant, i, j, k) {
    if (variant) {
      var vp = VARIANT_LANDFORM[variant];
      return vp[(hash01(i * 5 + k, j * 3 + k, 261) * vp.length) | 0];
    }
    var pool = LANDFORM[el];
    return pool[(hash01(i * 5 + k, j * 3 + k, 262) * pool.length) | 0];
  }

  /* 群落 (设定 §三/§四): 晶格哈希确定性播种大灵脉, 密度-灵气耦合;
     群内按 1大 + [0~3]中 + [0~7]小 向心聚敛 (越近中心越密),
     五行只在群落内部发育: 主灵根自持 → 相生支脉繁荣 → 相克支脉异变 */
  function communityOf(i, j) {
    var key = i + ',' + j;
    var c = commCache.get(key);
    if (c !== undefined) return c;
    var comm = null;
    var cq0 = i * CFG.COMM_CL, cr0 = j * CFG.COMM_CL;
    var sp = spiritAt(cq0, cr0);
    var p = sp < 0.03 ? 0 : CFG.COMM_P_MIN + CFG.COMM_P_SPIRIT * sp;   // 群落存在概率随灵气
    if (hash01(i, j, 201) < p) {
      var q = Math.round(cq0 + (hash01(i, j, 202) - 0.5) * CFG.COMM_CL * 0.44);
      var r = Math.round(cr0 + (hash01(i, j, 203) - 0.5) * CFG.COMM_CL * 0.44);
      var el = (hash01(i, j, 204) * 5) | 0;         // 主灵根
      var veins = [{ q: q, r: r, level: 0, element: el, variant: null,
                     name: pickLandform(el, null, i, j, 0) }];
      var nM = Math.min(3, (hash01(i, j, 205) * 4 * (0.35 + 0.65 * sp)) | 0);
      var nS = Math.min(7, (hash01(i, j, 206) * 8 * (0.30 + 0.70 * sp)) | 0);
      for (var k = 0; k < nM + nS; k++) {
        var isMid = k < nM;
        var level = isMid ? 1 : 2;
        var dMin0 = isMid ? CFG.D_L_M : CFG.D_L_S;          // 与大灵脉最小距
        var dMinO = isMid ? CFG.D_M : CFG.D_SMALL;          // 与其他次级最小距
        var radMax = isMid ? CFG.COMM_R * 0.82 : CFG.COMM_R * 0.95;
        var spot = null;
        for (var t = 0; t < CFG.SUB_ATTEMPTS && !spot; t++) {
          var u = hash01(i * 31 + k, j * 17 + k, 210 + t);
          var ang = hash01(i * 13 + k, j * 29 + k, 230 + t) * Math.PI * 2;
          var rad = dMin0 + (radMax - dMin0) * Math.pow(u, isMid ? 0.65 : 0.55);
          var tq = Math.round(q + rad * Math.cos(ang));
          var tr = Math.round(r + rad * Math.sin(ang));
          if (hexDist(tq, tr, q, r) < dMin0) continue;
          var ok = true;
          for (var v2 = 0; v2 < veins.length; v2++) {
            if (hexDist(tq, tr, veins[v2].q, veins[v2].r) < dMinO) { ok = false; break; }
          }
          if (ok) spot = { q: tq, r: tr };
        }
        if (!spot) continue;
        /* 五行发育 (设定 §4.3/§4.4): 相生相克只在群落内部 */
        var er = hash01(i * 7 + k, j * 11 + k, 250);
        var se = el, variant = null;
        if (er < 0.44) {
          se = el;                                   // 主灵根基调
        } else if (er < 0.78) {
          se = SHENG[el];                            // 相生支脉繁荣
          if (hash01(i * 7 + k, j * 11 + k, 251) < 0.30) variant = dualOf(el, se);
        } else if (er < 0.90) {
          se = SHENG[SHENG[el]];                     // 远相生
        } else {
          se = KE[el];                               // 相克制衡 → 异变
          variant = hash01(i * 7 + k, j * 11 + k, 252) < 0.55 ? dualOf(el, se) : null;
        }
        veins.push({ q: spot.q, r: spot.r, level: level, element: se, variant: variant,
                     name: pickLandform(se, variant, i, j, k + 1) });
      }
      comm = { i: i, j: j, q: q, r: r, element: el, spirit: sp,
               x: tileToWorld(q, r).x, y: tileToWorld(q, r).y, veins: veins };
    }
    cacheSet(commCache, key, comm, COMM_CAP);
    return comm;
  }

  /* 最近群落 (3×3 晶格扫描, 确定性) */
  function communityNear(q, r) {
    var i0 = Math.floor(q / CFG.COMM_CL), j0 = Math.floor(r / CFG.COMM_CL);
    var best = null, bd = 1e18;
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var cm = communityOf(i0 + di, j0 + dj);
        if (!cm) continue;
        var d = hexDist(q, r, cm.q, cm.r);
        if (d < bd) { bd = d; best = cm; }
      }
    }
    return best ? { comm: best, dist: bd } : null;
  }

  /* 某格附近最近灵脉: d ≤ 1 为七星格 (中心/从属), d ≤ 3 参与地形过渡 */
  function veinNear(q, r) {
    var key = q + ',' + r;
    var c = veinNearCache.get(key);
    if (c !== undefined) return c;
    var i0 = Math.floor(q / CFG.COMM_CL), j0 = Math.floor(r / CFG.COMM_CL);
    var best = null, bd = 1e18;
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var cm = communityOf(i0 + di, j0 + dj);
        if (!cm) continue;
        for (var v = 0; v < cm.veins.length; v++) {
          var d = hexDist(q, r, cm.veins[v].q, cm.veins[v].r);
          if (d < bd) { bd = d; best = cm.veins[v]; }
        }
      }
    }
    var out = (best && bd <= 3) ? { d: bd, v: best } : null;
    cacheSet(veinNearCache, key, out, VEIN_CAP);
    return out;
  }

  /* 已缓存群落中灵脉总数 (统计用) */
  function countVeins() {
    var n = 0;
    commCache.forEach(function (cm) { if (cm) n += cm.veins.length; });
    return n;
  }

  /* §十二: 运行时覆写参数 (合并进 CFG 并清空全部派生缓存)
     R11: region/settle/road/roadFail 也须一并清空 —— 若覆写参数影响区域生成
     (REGION_M 未来可配置等), 只清 comm/elev/field 会造成新旧参数混用。 */
  function configure(patch) {
    if (!patch) return;
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(CFG, k)) CFG[k] = patch[k];
    }
    commCache.clear(); veinNearCache.clear();
    elevCache.clear(); fieldCache.clear();
    regionCache.clear(); settleCache.clear();
    roadCache.clear(); roadFail.clear();
    roadVer = 0;
  }

  /* 当前道路版本号 (供宿主做 tile 缓存新鲜度校验) */
  function roadVersion() { return roadVer; }

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
    spiritAt: spiritAt,
    communityOf: communityOf,
    communityNear: communityNear,
    veinNear: veinNear,
    countVeins: countVeins,
    roadVersion: roadVersion,
    pxToTile: pxToTile,
    tileToWorld: tileToWorld,
    hexDist: hexDist,
    mountainNear: mountainNear,
    /* 精灵索引分配 (供 verify/w5_sprite_range.mjs 直接断言输出契约:
       各群系索引区间必须落在图集已绘制范围内, 不得溢出到别行素材) */
    propSpriteFor: propSpriteFor,
    roadCache: roadCache,
    settleCache: settleCache,
    commCache: commCache,
    NEIGH_SLOTS: NEIGH_SLOTS,
    HEX_R: HEX_R,
    HEX_W: HEX_W,
    CHUNK_R: CHUNK_R,
    CHUNK_S: CHUNK_S,
    CHUNK_SCAN: CHUNK_SCAN,
    REGION_M: REGION_M,
    CFG: CFG,
    configure: configure,
    ELEMENTS: ELEMENTS,
    ELEMENT_RGB: ELEMENT_RGB,
    VARIANT_RGB: VARIANT_RGB,
    SEA_LEVEL: SEA_LEVEL,
    BIOME: BIOME,
    BIOME_META: BIOME_META
  };
})(window);
