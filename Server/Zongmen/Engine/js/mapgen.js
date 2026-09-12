/* ============================================================
 * mapgen.js — 无限流式世界生成 (我的世界式区块)
 *  - 地块: 尖顶六边形, 直径 16px, 轴坐标 (q, r), y 轴向下
 *  - 区块: 半径 CHUNK_R 格的六边形, 中心间距 S=2R+1,
 *          地块归属四候选最近中心 (确定性平局裁决) → 六边形区块
 *  - 内容: 海拔/湿度/气候带 = 坐标的纯噪声函数 (含出生岛保障),
 *          区域/聚落/灵脉 = 全球晶格哈希, 道路 = A* 寻路(三重剪枝)
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
  /* ---------- 边界沉海 (设定 §九.3) ----------
     灵气边界外是"凡俗无灵地带": 地形一律沉为海洋, 不产聚落也不出灵脉峰。
     下沉目标高度 = EDGE_SEA_FLOOR + (e - 0.5) * EDGE_SEA_VAR,
     取值区间 [0.24, 0.36] 恒 < SEA_LEVEL → 保证界外必为海(含深海), 且保留一点海底起伏。 */
  var EDGE_SEA_FLOOR = 0.30;
  var EDGE_SEA_VAR   = 0.12;
  var HEX_R = 8;                          // 外接圆半径 → 直径 16
  var HEX_W = Math.sqrt(3) * HEX_R;
  var CHUNK_R = 10;                       // 区块六边形半径 (格)
  var CHUNK_S = 2 * CHUNK_R + 1;          // 区块中心间距 (21)
  var CHUNK_SCAN = 15;                    // 区块构建扫描半径: 胞腔最远可达 14 格, 15 保证全覆盖无缝
  var REGION_M = 18;                      // 区域晶格间距

  /* ---------- 灵脉驱动世界 (灵脉地图设定: 先定灵脉, 后造山河) ----------
   * §十二: 参数集中在【同目录 mapgen-config.js】(global.MapGenConfig, 唯一真源),
   *        本文件不再自带默认值; 运行时仍可用 MapGen.configure(patch) 局部覆写。
   *        若宿主未加载配置 (老 bundle), 退回内置兜底值, 保证不崩。 */
  var CFG = global.MapGenConfig || {
    COMM_CL: 150, COMM_R: 40,
    D_L_M: 18, D_L_S: 12, D_M: 14, D_SMALL: 8,
    SPIRIT_R_TILES: 1000, SPIRIT_CURVE: 0.8,
    EDGE_SEA_SP: 0.30, EDGE_SETTLE_SP: 0.35,
    COMM_P_MIN: 0.16, COMM_P_SPIRIT: 0.62,
    SUB_ATTEMPTS: 14,
    LIFT_CORE: [0.80, 0.75, 0.70], LIFT_ARM_OFF: 0.05,
    ECO_WATER: 0.25, ECO_WOOD: 0.18,
    ECO_FIRE_DRY: 0.22, ECO_FIRE_HEAT: 0.15, ECO_METAL: 0.08,
    ROAD_COST_MAX: 120, ROAD_STEPS_MAX: 40, ROAD_W: [4, 4, 4, 3, 5, 3, 8, 8],
    PROSPECT_R: 4, PROSPECT_REFINE: 6, TOWN_R: 3, TOWN_INNER_R: 1, TOWN_HOUSE_RATIO: 0.3, TERR_SCAN_R: 1, FARM_SPIRIT: 0.35,
    TOWN_BUILD_MAX: { village: 8, town: 16, city: 25, sect: 16 },
    TRADE_REACH: 40
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
  var siteScoreCache = new Map();// "q,r" -> 选址打分 (纯函数, 只依赖地形/灵脉)
  var prospectCache = new Map(); // "aq,ar"-> 勘测结果 {tiles:[{q,r,score}]}
  var centerCache = new Map();   // "aq,ar"-> 选中中心 {q,r,score} | null
  var townCache = new Map();     // "聚落id" -> 足迹规划 {style, buildings, resources}
  var tradeCache = new Map();    // "i,j" -> 该区域格城镇的贸易边数组
  var roadFail = new Set();      // "a|b" -> 不可达聚落对 (寻路失败, 终身跳过)
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
  var SITE_SCORE_CAP = 40000; // 选址打分 (勘测扫描逐格, 容量须覆盖视野内候选)
  var PROSPECT_CAP = 8192; // 勘测结果 (按锚点)
  var CENTER_CAP = 8192;   // 选中中心 (按锚点)
  var TOWN_CAP = 4096;     // 城镇足迹规划 (按聚落)
  var TRADE_CAP = 4096;    // 贸易边 (按区域格)

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
    siteScoreCache.clear(); prospectCache.clear(); centerCache.clear(); townCache.clear(); tradeCache.clear();
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
    /* 边界沉海 (设定 §九.3): 灵气强度向外衰减 → 海拔按同一条曲线压入海底。
       必须放在灵脉抬升【之后】: 否则边界带上的灵脉峰会被 LIFT_CORE 抬回水面,
       出现"界外灵脉山"。系数 EDGE_SEA_SP 越大 → 衰减带越宽、越早开始沉。
       沉没权重 = 1 - edgeKeep (edgeKeep 是"保留", 别直接用) */
    var gSea = 1 - edgeKeep(spiritAt(q, r), CFG.EDGE_SEA_SP);
    if (gSea > 0) {
      var sunk = EDGE_SEA_FLOOR + (e - 0.5) * EDGE_SEA_VAR;
      e = e * (1 - gSea) + sunk * gSea;
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

    /* 灵脉格: 覆写显示用 biome (8..12 = 金木水火土灵脉格)
       仅陆地出灵脉 —— 边界带被沉海的灵脉不再覆写, 否则会在海面上留"无根灵脉峰" */
    var vinfo = null;
    if (vn && vn.d <= 1 && e >= SEA_LEVEL) {
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

  /* ============================================================
   * 城镇生成 (§三): 勘测(prospect) → 选址(pick center) → 生长(grow)
   * ------------------------------------------------------------
   * 取代原先「锚点处 4 次试投、命中即落」的直接落点:
   *   ① 勘测: 以锚点为中心六边扫描 PROSPECT_R 圈, 逐格打分 (不钉死一格);
   *   ② 选址: 取最高分格作真实中心 (保证周边确实有「好空间」);
   *   ③ 生长: 中心 hexDist ≤ TOWN_R 内按 灵气×地形 → 地皮 → 建筑,
   *          生产型卫星先行、民房殿后, 产出聚合为城镇资源清单。
   * 三者皆为纯函数 (只依赖 seed 地形/灵脉/坐标), 结果按 key 缓存 → 跨区块、
   * 跨会话完全一致 (服务端与客户端各自算出的中心/足迹必须逐格相同)。
   * ============================================================ */
  var LANDUSE_PRI = { '灵枢': 0, '高阶灵地': 1, '水岸': 2, '良田': 3, '矿脉': 4, '林地': 5, '灼壤': 6, '村落': 9 };
  /* 地皮 → 建筑候选池 (r/a = 主产出, x/xa = 附加产出); 村落皮为民房/仓库 (无产出) */
  var BUILDINGS = {
    '灵枢':     [{ k: '灵枢殿', r: '灵', a: 3 }, { k: '聚灵阵', r: '灵', a: 2 }, { k: '祭坛', r: '灵', a: 2 }],
    '高阶灵地': [{ k: '炼丹殿', r: '丹', a: 2 }, { k: '炼器殿', r: '器', a: 2 }],
    '水岸':     [{ k: '码头', r: '渔', a: 2 }, { k: '渔船坞', r: '渔', a: 2 }, { k: '渔亭', r: '渔', a: 1 }],
    '良田':     [{ k: '农田', r: '粮', a: 2 }, { k: '磨坊', r: '粮', a: 3 }, { k: '谷仓', r: '粮', a: 1 }],
    '矿脉':     [{ k: '矿山', r: '矿', a: 2 }, { k: '熔炉', r: '矿', a: 3 }],
    '林地':     [{ k: '伐木场', r: '木', a: 2 }, { k: '药圃', r: '木', a: 1, x: '灵', xa: 1 }],
    '灼壤':     [{ k: '炼炉', r: '炭', a: 2 }, { k: '焦炭窑', r: '炭', a: 1, x: '矿', xa: 1 }],
    '村落':     [{ k: '民房' }, { k: '仓库' }]
  };
  var CORE_KIND = {
    city: ['官衙', '集市', '宗祠'], town: ['集市', '祠堂'],
    village: ['祠堂', '村口'], sect: ['宗门大殿', '祖师殿']
  };
  var RES_ORDER = ['粮', '木', '矿', '渔', '炭', '灵', '丹', '器'];
  var STYLE_NAME = { spirit: '灵修', river: '水乡', farm: '田园', mine: '矿镇',
                     wood: '山林', desert: '沙镇', plain: '平原', coast: '海滨', mountain: '山城' };
  var STYLE_BY_LANDUSE = { '灵枢': 'spirit', '高阶灵地': 'spirit', '水岸': 'river',
                           '良田': 'farm', '矿脉': 'mine', '林地': 'wood', '灼壤': 'desert' };

  /* 地皮判定: 灵脉(灵枢/高阶灵地) > 邻水(水岸) > 地貌 (林/荒漠/山 → 木材/灼壤/矿脉,
     草地按灵气分 良田 / 村落) —— 即「灵气 → 地皮」, 地皮再决定建筑种类 */
  function landuseOf(f) {
    if (f.vein) return f.vein.d === 0 ? '灵枢' : '高阶灵地';
    if (f.biome === BIOME.BEACH) return '水岸';
    if (f.biome === BIOME.FOREST) return '林地';
    if (f.biome === BIOME.DESERT) return '灼壤';
    if (f.biome >= BIOME.MOUNTAIN) return '矿脉';
    if (f.biome === BIOME.GRASS) {
      return spiritAt(f.q, f.r) >= CFG.FARM_SPIRIT ? '良田' : '村落';
    }
    return '村落';
  }
  /* 是否陆上且邻水 (六邻居中含水面) → 可设码头等水岸设施 */
  function coastalAt(q, r) {
    for (var k = 0; k < 6; k++) {
      if (elevAt(q + NEIGH_SLOTS[k][0], r + NEIGH_SLOTS[k][1]) < SEA_LEVEL - 0.02) return true;
    }
    return false;
  }

  /* 单格选址基础分: 地形宜居 + 海拔适中 + 灵气。水/雪峰 → -Inf (排除)。
     资源邻近项不在这里做 (它要扫邻域, 贵) —— 由 prospectArea 对头部候选精算。 */
  function siteScore(q, r) {
    var key = q + ',' + r;
    var c = siteScoreCache.get(key);
    if (c !== undefined) return c;
    var f = fields(q, r);
    var s;
    if (f.biome <= BIOME.OCEAN || f.biome === BIOME.SNOW) {
      s = -1e18;                                  // 海洋 / 雪峰: 排除
    } else {
      var terr = [0, 0, 20, 80, 60, 30, 20, 0][f.biome];   // 草地80 林地60 沙漠30 沙岸/山地20
      var e = f.e, elev;
      if (e >= 0.45 && e <= 0.75) elev = 100;               // 海拔 0.45~0.75 最优
      else if (e < 0.45) elev = Math.max(0, 100 - (0.45 - e) * 400);
      else elev = Math.max(0, 100 - (e - 0.75) * 400);
      var vn = veinNear(q, r);
      var spir = (vn ? (vn.d === 0 ? 60 : vn.d <= 1 ? 30 : 10) : 0) + spiritAt(q, r) * 20;
      s = terr + elev + spir;
    }
    cacheSet(siteScoreCache, key, s, SITE_SCORE_CAP);
    return s;
  }

  /* 资源邻近加成: 扫描半径内 水源/森林/山地/荒漠 格 (越近权重越高), 上限 40 */
  function resourceBonus(q, r) {
    var R = CFG.TERR_SCAN_R | 0 || 2, bonus = 0;
    for (var dq = -R; dq <= R; dq++) {
      for (var dr = -R; dr <= R; dr++) {
        var d = hexDist(0, 0, dq, dr);
        if (d < 1 || d > R) continue;
        var b = fields(q + dq, r + dr).biome;
        var w = (R - d + 1) / R;
        if (b <= BIOME.OCEAN) bonus += 6 * w;              // 水源
        else if (b === BIOME.MOUNTAIN) bonus += 5 * w;      // 矿脉
        else if (b === BIOME.FOREST) bonus += 4 * w;        // 林木
        else if (b === BIOME.DESERT) bonus += 2 * w;
      }
    }
    return Math.min(bonus, 40);
  }

  /* 阶段一 勘测: 锚点周围 PROSPECT_R 圈逐格打分 → 适宜度图 (按锚点缓存)
     严格取「已勘测区内的最高分格」(不加提前收敛 —— 实测提前收敛会改变 37.8%
     的城镇中心, 违背 §三.2「取最高分格」)。成本控制改在两项上:
       · PROSPECT_REFINE: 资源邻近只对基础分前 N 名精算 (它要扫邻域, 是主要开销);
       · TERR_SCAN_R: 资源扫描半径取 1 (6 邻格)。
     实测: 精算 12×19=228 次/镇 → 6×6=36 次/镇, 冷启动由 6780ms 降到 ~1.4s。
     服务端只对「单个区域格的 1~2 座城镇」勘测 (≈2ms), 不受此影响。 */
  function prospectArea(aq, ar) {
    var key = aq + ',' + ar;
    var c = prospectCache.get(key);
    if (c) return c;
    var R = CFG.PROSPECT_R | 0 || 4;
    var tiles = [];
    for (var dq = -R; dq <= R; dq++) {
      for (var dr = -R; dr <= R; dr++) {
        if (hexDist(0, 0, dq, dr) > R) continue;
        var q = aq + dq, r = ar + dr;
        var base = siteScore(q, r);
        if (base < -1e17) continue;                       // 水/雪峰: 不入候选
        tiles.push({ q: q, r: r, score: base });
      }
    }
    /* 排序 (分数降序, 同分按 q,r → 确定性), 对前 N 名补算「资源邻近」 */
    tiles.sort(function (a, b) { return (b.score - a.score) || (a.q - b.q) || (a.r - b.r); });
    var refine = Math.min(tiles.length, CFG.PROSPECT_REFINE | 0 || 6);
    for (var t2 = 0; t2 < refine; t2++) tiles[t2].score += resourceBonus(tiles[t2].q, tiles[t2].r);
    var out = { aq: aq, ar: ar, radius: R, tiles: tiles };
    cacheSet(prospectCache, key, out, PROSPECT_CAP);
    return out;
  }

  /* 阶段二 选址: 勘测区内取最高分格为城镇真实中心 (无可选格 → null) */
  function pickSettlementCenter(aq, ar) {
    var key = aq + ',' + ar;
    var c = centerCache.get(key);
    if (c !== undefined) return c;
    var tiles = prospectArea(aq, ar).tiles;
    var best = null;
    for (var i = 0; i < tiles.length; i++) {
      if (!best || tiles[i].score > best.score) best = tiles[i];   // 严格 > : 同分取表序首 (确定性)
    }
    var out = best ? { q: best.q, r: best.r, score: best.score } : null;
    cacheSet(centerCache, key, out, CENTER_CAP);
    return out;
  }

  /* 阶段三 生长: 以选定中心为锚, hexDist ≤ TOWN_R 内铺建筑 + 聚合产出。
     结构 (空间分工, 见下方 ⚠ 说明):
       中心格   → 核心建筑 (集市/祠堂/官衙/宗门大殿, 依 type)
       内环     → 民房/仓库 (城区); 灵枢/高阶灵地/水岸 等特殊地皮仍出自己的建筑
       外环     → 生产型卫星建筑 (码头>农田>矿场>林场>炉窑, 依地皮)
     上限按规模分档 (CFG.TOWN_BUILD_MAX)。纯函数 + 按聚落 id 缓存。

     ⚠ 与文档 §三.4「生产铺完后剩余可用格补民房」的差异 (有意为之):
       实测草地上「良田」地皮占比极高 (灵气 ≥ FARM_SPIRIT 即判良田),
       若严格按「生产先行」铺满, 城镇将 100% 是农田/磨坊、一座民房都没有
       (实测民房仅占 1.4%), 视觉上不成立。
       故按「卫星 = 环绕中心的外环」的空间语义分工: 内环为城区(民房),
       外环为生产卫星。生产上限与产出聚合口径不变, 仅位置分工不同。 */
  function growTownFootprint(id, type, cq, cr) {
    var c = townCache.get(id);
    if (c) return c;
    var R = CFG.TOWN_R | 0 || 3;
    var innerR = CFG.TOWN_INNER_R | 0;
    var cells = [];
    for (var dq = -R; dq <= R; dq++) {
      for (var dr = -R; dr <= R; dr++) {
        var d = hexDist(0, 0, dq, dr);
        if (d > R) continue;
        cells.push({ q: cq + dq, r: cr + dr, d: d });
      }
    }
    /* 固定序 (环 → q → r): 与扫描顺序无关, 保证确定性 */
    cells.sort(function (a, b) { return (a.d - b.d) || (a.q - b.q) || (a.r - b.r); });

    var maxN = (CFG.TOWN_BUILD_MAX && CFG.TOWN_BUILD_MAX[type]) || 8;
    var coreNames = CORE_KIND[type] || CORE_KIND.village;
    var core = null, inner = [], outer = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var f = fields(cell.q, cell.r);
      if (f.biome <= BIOME.OCEAN) continue;                 // 水上不落建筑
      if (cell.d === 0) {
        core = { q: cell.q, r: cell.r, kind: coreNames[(hash01(cq, cr, 301) * coreNames.length) | 0],
                 terrain: 'core', tier: 3 };
        continue;
      }
      var lu = landuseOf(f);
      var special = (lu === '灵枢' || lu === '高阶灵地');
      if (!special && lu !== '水岸' && f.biome !== BIOME.BEACH &&
          coastalAt(cell.q, cell.r)) lu = '水岸';           // 邻水 (且非灵脉) → 水岸地皮
      /* 内环: 非灵脉地皮一律作城区民居 (城区不种田不开矿) */
      if (!special && lu !== '水岸' && cell.d <= innerR) lu = '村落';
      var pool = BUILDINGS[lu] || BUILDINGS['村落'];
      var b = pool[(hash01(cell.q, cell.r, 311) * pool.length) | 0];
      var item = { q: cell.q, r: cell.r, kind: b.k, terrain: lu,
                   tier: b.a ? 2 : 1, res: b };
      (lu === '村落' ? inner : outer).push(item);
    }
    /* 生产型卫星先行 (码头>农田>矿场>林场>炉窑), 同级按环序; 民房殿后补余量 */
    outer.sort(function (a, b) {
      return (LANDUSE_PRI[a.terrain] - LANDUSE_PRI[b.terrain]) || (a.q - b.q) || (a.r - b.r);
    });

    var queue = [];
    if (core) {
      queue.push({ q: core.q, r: core.r, kind: core.kind, terrain: core.terrain,
                   tier: core.tier, res: null });
    }
    /* 配额: 民居保底 (否则 maxN 会被 24 格外环卫星吃光 → 城镇一座民房都没有)。
       TOWN_HOUSE_RATIO 给城区民居预留名额, 其余归生产型卫星; 卫星不足时民居自然补位。 */
    var coreN = core ? 1 : 0;
    var houseTarget = Math.min(inner.length,
      Math.max(2, Math.floor(maxN * (CFG.TOWN_HOUSE_RATIO != null ? CFG.TOWN_HOUSE_RATIO : 0.3))));
    var satTake = Math.max(0, maxN - coreN - houseTarget);
    for (var os = 0; os < outer.length && os < satTake; os++) queue.push(outer[os]);
    for (var hs = 0; hs < inner.length; hs++) queue.push(inner[hs]);

    var buildings = [], res = {};
    for (var q2 = 0; q2 < queue.length && buildings.length < maxN; q2++) {
      var it = queue[q2];
      buildings.push({ q: it.q, r: it.r, kind: it.kind, terrain: it.terrain, tier: it.tier });
      if (it.res) {
        if (it.res.r) res[it.res.r] = (res[it.res.r] || 0) + it.res.a;
        if (it.res.x) res[it.res.x] = (res[it.res.x] || 0) + it.res.xa;
      }
    }
    /* 产出聚合 → 城镇资源清单 (按固定资源序, 只留 >0 项) */
    var resources = [];
    for (var ri = 0; ri < RES_ORDER.length; ri++) {
      var nm = RES_ORDER[ri];
      if (res[nm] > 0) resources.push({ resource: nm, amount: res[nm] });
    }
    /* 城镇风格: 主导地皮 (灵脉/水岸/良田/矿脉/林地/灼壤) → 风格;
       无特殊地貌时按区域主导 biome 派生 (§五 styles 兜底) */
    var styleKey = null, cnt = {}, bn = 0;
    for (var bk = 0; bk < buildings.length; bk++) {
      var kk = STYLE_BY_LANDUSE[buildings[bk].terrain];
      if (!kk) continue;
      cnt[kk] = (cnt[kk] || 0) + 1;
      if (cnt[kk] > bn) { bn = cnt[kk]; styleKey = kk; }
    }
    if (!styleKey) {
      var rs = regionSeedOf(cq, cr);
      var rb = regionInfo(rs.i, rs.j).biome;
      styleKey = rb <= BIOME.BEACH ? 'coast'
               : rb === BIOME.FOREST ? 'wood'
               : rb === BIOME.DESERT ? 'desert'
               : rb >= BIOME.MOUNTAIN ? 'mountain' : 'plain';
    }
    var out = { style: styleKey, styleName: STYLE_NAME[styleKey] || '聚落',
                buildings: buildings, resources: resources };
    cacheSet(townCache, id, out, TOWN_CAP);
    return out;
  }

  /* ============================================================
   * 贸易网络 (§四): 城镇产出聚合 → 供需缺口 → tradeEdge
   * ------------------------------------------------------------
   * 纯计算层 (不落库): 供需按人口折算「每单位资源可养多少口人」,
   * 同镇内部先自给, 剩余为盈余 / 缺口; 相邻城镇 (六边距 ≤ TRADE_REACH)
   * 之间按「盈余 × 缺口」配对, 取缺口最大的资源建一条贸易边。
   * 与道路 A* 寻路同理: 每对只算一次 (按 id 序归一化), 固定资源序 → 确定性。
   * ============================================================ */
  var TRADE_DEMAND = { 粮: 500, 木: 800, 渔: 900, 炭: 1200, 矿: 1500, 灵: 5000, 丹: 8000, 器: 8000 };

  function townNet(st) {
    var plan = growTownFootprint(st.id, st.type, st.q, st.r);
    var sup = {}, net = {}, k, r;
    for (k = 0; k < plan.resources.length; k++) sup[plan.resources[k].resource] = plan.resources[k].amount;
    for (k = 0; k < RES_ORDER.length; k++) {
      r = RES_ORDER[k];
      var need = Math.max(1, Math.round((st.pop || 0) / (TRADE_DEMAND[r] || 1000)));
      net[r] = (sup[r] || 0) - need;
    }
    return net;
  }

  function tradeEdgesFor(i, j) {
    var key = i + ',' + j;
    var c = tradeCache.get(key);
    if (c) return c;
    var reach = CFG.TRADE_REACH | 0 || 40;
    var mine = settlementsFor(i, j);
    var towns = [];
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var others = settlementsFor(i + di, j + dj);
        for (var o = 0; o < others.length; o++) if (others[o].type !== 'poi') towns.push(others[o]);
      }
    }
    var out = [];
    for (var ai = 0; ai < mine.length; ai++) {
      var a = mine[ai];
      if (a.type === 'poi') continue;
      var na = null;
      for (var bi = 0; bi < towns.length; bi++) {
        var b = towns[bi];
        if (b.id === a.id || a.id > b.id) continue;      // 每对只算一次 (小 id 发起)
        var d = hexDist(a.q, a.r, b.q, b.r);
        if (d > reach) continue;
        if (!na) na = townNet(a);
        var nb = townNet(b);
        var bestR = null, bestAmt = 0, dir = 0;
        for (var k = 0; k < RES_ORDER.length; k++) {
          var r = RES_ORDER[k];
          var ab = Math.min(Math.max(na[r], 0), Math.max(-nb[r], 0));   // a 余 → b 缺
          var ba = Math.min(Math.max(nb[r], 0), Math.max(-na[r], 0));   // b 余 → a 缺
          if (ab > bestAmt) { bestAmt = ab; bestR = r; dir = 1; }
          if (ba > bestAmt) { bestAmt = ba; bestR = r; dir = -1; }
        }
        if (!bestR || bestAmt <= 0) continue;
        var from = dir > 0 ? a : b, to = dir > 0 ? b : a;
        out.push({ key: from.id + '|' + to.id, from: from.id, to: to.id,
                   resource: bestR, amount: bestAmt, dist: d,
                   x0: from.x, y0: from.y, x1: to.x, y1: to.y });
      }
    }
    cacheSet(tradeCache, key, out, TRADE_CAP);
    return out;
  }

  /* ---------- 聚落 (区域格内的城镇/宗门/村庄 + 秘境) ---------- */
  function settlementsFor(i, j) {
    var key = i + ',' + j;
    var c = settleCache.get(key);
    if (c) return c;
    var arr = [];
    var h0 = hash01(i, j, 7);
    /* 灵气梯度 (设定 §九/§十): 聚落密度随灵气衰减;
       边界衰减: 再乘一次"灵气强度 → 0..1"的衰减系数, 强度归零处概率归零
       → 灵气边界外(含界外海洋)不再生成任何聚落与秘境 */
    var spLoc = spiritAt(i * REGION_M, j * REGION_M);
    var pSpawn = (0.20 + 0.38 * spLoc) * edgeKeep(spLoc, CFG.EDGE_SETTLE_SP);
    if (h0 < pSpawn) {
      var count = h0 < 0.30 ? 1 : 2;
      for (var k = 0; k < count; k++) {
        var sq = i * REGION_M + (hash01(i, j, 21 + k) - 0.5) * REGION_M * 0.7;
        var sr = j * REGION_M + (hash01(i, j, 31 + k) - 0.5) * REGION_M * 0.7;
        /* 阶段一/二 (勘测 → 选址): 锚点只是「候选点」, 真正落点由周围空间打分选出
           —— 不再「钉死一格再来补建筑」, 也不再 4 次试投命中即落 (§三.4) */
        var center = pickSettlementCenter(Math.round(sq), Math.round(sr));
        if (!center) continue;
        var placed = fields(center.q, center.r);
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

  /* ---------- 道路 (A* 寻路: Dial 桶优先队列 + 三重剪枝; 跳板剪枝去重) ----------
   * 权重表 ROAD_W 见 mapgen-config.js (水4 / 平地3 / 林5 / 山8)。
   * 路网拓扑 (roadsNear): 每个聚落 × 3x3 邻域格内全部聚落, 按距离升序逐对跑 A*,
   *   预算内可达即建路 —— 但先过「跳板剪枝」: 若存在中间聚落 m 严格位于两点
   *   之间且直线绕行 ≤ 直达的 30%, 则不建 a-b 直路 (走 m 即可) —— 消除「跳板
   *   路线与直达路并行」的三角捆绑重复路。剪枝是纯几何判定 (全整数, 不读缓
   *   存), 跳板池取 3x3(a格)∪3x3(b格) —— 从任一端评估同一对结果相同 ⇒ 与访
   *   问顺序无关, 跨会话确定。m 严格介于两点之间 ⇒ 最近邻对与 MST 边永不被
   *   剪 (环性质) ⇒ 每聚落至少 1 路且路网不碎裂。创建顺序按规模大者先
   *   (hubBefore), 跳板本身不限规模。
   * A* 本体 (bfsRoad) 的三个剪枝:
   *   ① 放弃「跨大陆找路」—— 剪枝把搜索限制在城镇周边邻域:
   *        · 累计权重 > CFG.ROAD_COST_MAX 的分支不再扩展 (权重剪枝);
   *        · 距起点层数 > CFG.ROAD_STEPS_MAX 的格不入队 (步数剪枝);
   *        · 剩余代价可采纳下界 使 g+h > 预算 的格直接跳过 —
   *          可采纳 ⇒ 不改变任何 ≤预算 路径的存在性与最优值, 只砍掉「注定失败」
   *          分支的无效扩散。
   *      A* 时代 guard=12000 步 + 海岸破碎区最长 5.1s 持 V8 门闩的病灶一并消除;
   *      实测最慢单 region(含 roadsNear+跳板剪枝) ~60ms, 远低于回归预算 250ms。
   *   ② 实现用 Dial 桶队列做 A* 的优先队列, 桶下标 = f = g + h:
   *      h = 最小权重 × ⌊笛卡尔欧氏距离⌋ (cartDist: 两端点经 tileToWorld 的
   *      实际世界坐标代入勾股定理, 借恒等式 dx²+dy² = HEX_W²·(dq²+dq·dr+dr²)
   *      整数化, 无浮点开方 —— 非 hexDist 步数)。欧氏启发使等代价路径
   *      向直线收敛 (hexDist 分层会让平地整片同 f, 路形随扩展序锯齿), 更接近真实路网;
   *      权重为小整数 3..8 且 h 为整数 ⇒ f 仍为 0..COST_MAX 的整数, 桶数固定;
   *      h 一致 (consistent) ⇒ 按 f 升序出队即标准 A* 展开序, 目标首次出队即最优。
   *      ⚠ 桶内仍是 FIFO + NEIGH_SLOTS 固定顺序 + 端点按 id 序归一化 ⇒ 确定性。
   *   ③ 确定性: 上述固定序 + 全整数判定 ⇒ 跨区块/跨会话/冷热缓存完全一致。 */
  function roadWeight(f) {
    var w = CFG.ROAD_W;
    return (w && w[f.biome] != null) ? w[f.biome] : 4;
  }
  /* 全域最小通行权重 (可采纳下界用): 取 ROAD_W 最小值, 兜底 3 */
  function roadMinWeight() {
    var w = CFG.ROAD_W, m = Infinity;
    if (w) for (var i = 0; i < w.length; i++) if (w[i] != null && w[i] < m) m = w[i];
    return isFinite(m) ? m : 3;
  }

  /* ⌊√n⌋ 纯整数牛顿迭代 (无任何浮点运算 → 无浮点不确定性): 收敛即返回。
     调用方 n ≤ 3×(2×ROAD_STEPS_MAX)² = 19200, 远小于 2^31, 无溢出风险 */
  function isqrt(n) {
    if (n < 2) return n;
    var x = n, y = ((x + (n / x | 0)) >> 1) | 0;
    while (y < x) { x = y; y = ((x + (n / x | 0)) >> 1) | 0; }
    return x;
  }

  /* 两格间的「实际笛卡尔直线距离」(以格间距 HEX_W 为单位取整)。
     由 tileToWorld: x = HEX_W·(q+r/2), y = 1.5·HEX_R·r, HEX_W = √3·HEX_R ⇒
       dx² + dy² = HEX_W²·(dq² + dq·dr + dr²)   —— 精确恒等式, 无任何近似
     ⇒ 实际欧氏距离 / HEX_W = √(dq² + dq·dr + dr²), isqrt 取整即整数化。
     这不是「六边格步数」(hexDist), 而是把两端点的笛卡尔世界坐标代入
     勾股定理的结果 —— 只是借恒等式避开浮点开方。供 A* 启发 / 跳板剪枝 /
     候选排序等一切「直线距离」语义使用。 */
  function cartDist(q1, r1, q2, r2) {
    var dq = q1 - q2, dr = r1 - r2;
    return isqrt(dq * dq + dr * dr + dq * dr);
  }

  /* 跳板优先级 (全序, 确定性): 规模(pop)大者优先; 同规模离灵气原点(0,0)近者
     优先 (轴向平方欧氏距 q²+r²+qr, 纯整数不开方); 再同按 id 字典序 ——
     任意聚落集合内「最大者」唯一, 剪枝结果与遍历顺序无关 */
  function hubBefore(p, q2) {
    if (p.pop !== q2.pop) return p.pop > q2.pop;
    var dp = p.q * p.q + p.r * p.r + p.q * p.r;
    var dq2 = q2.q * q2.q + q2.r * q2.r + q2.q * q2.r;
    if (dp !== dq2) return dp < dq2;
    return p.id < q2.id;
  }

  /* 跳板剪枝判定: 中间聚落 m 能否替代 a-b 直路 (笛卡尔实际位置, 全整数)。
     距离全部用 cartDist (真实笛卡尔直线距离, 非 hexDist 步数)。
     两个条件缺一不可:
       ① m 严格位于两点之间 (到两端都严格更近) —— 两重连通性保证:
          · 最近邻对永不被剪 (m 更近与「b 是 a 的最近邻」矛盾)
            ⇒ 每个聚落至少保住到它最近邻的 1 条路;
          · MST 的边也不可能被剪 (环性质: 若 m 到两端都严格更近, 则 (a,b)
            是环 a-m-b 上的最重边, 不属于任何 MST) ⇒ 路网不碎裂。
       ② a→m→b 直线绕行 ≤ 直达的 30% (10/13 整数比值, 不用浮点) ——
          绕行更多说明 m 不顺路, 直达路有独立价值, 保留。
     注意跳板不限规模: 资格门槛会放过「大城-小镇直达 + 小村跳板」并行的
     三角捆绑 (实测主线), 去掉门槛后这类冗余由几何条件统一剪掉。 */
  function hopPrune(a, b, m, dab) {
    if (m.id === a.id || m.id === b.id) return false;
    var dam = cartDist(a.q, a.r, m.q, m.r);
    if (dam >= dab) return false;
    var dmb = cartDist(m.q, m.r, b.q, b.r);
    if (dmb >= dab) return false;
    return 10 * (dam + dmb) <= 13 * dab;
  }

  /* A* 寻路 (f = g + h, Dial 桶优先队列): 返回 [[q,r], ...] 或 null (超预算/不可达)
     函数名保留 bfsRoad: 语义为「道路段寻路」, 且 verify/w3_bfs_road.mjs 以此名调用 */
  function bfsRoad(sq, sr, tq, tr) {
    var maxCost = CFG.ROAD_COST_MAX | 0;
    var maxSteps = CFG.ROAD_STEPS_MAX | 0;
    var minW = roadMinWeight();
    var d0 = hexDist(sq, sr, tq, tr);
    if (d0 > maxSteps || d0 * minW > maxCost) return null;   // 直线下界即超预算, 直接放弃

    var buckets = [];
    for (var b = 0; b <= maxCost; b++) buckets.push([]);
    var dist = new Map(), prev = new Map(), closed = new Set();
    var sk = sq + ',' + sr;
    dist.set(sk, 0);
    buckets[0].push(sq, sr);        // 扁平存 [q,r] 对, 省一次数组分配

    for (var f = 0; f <= maxCost; f++) {
      var bucket = buckets[f];
      for (var i = 0; i < bucket.length; i += 2) {
        var cq = bucket[i], cr = bucket[i + 1], ck = cq + ',' + cr;
        if (closed.has(ck)) continue;               // 已被更低 f 结算过
        closed.add(ck);
        if (cq === tq && cr === tr) {
          var path = [], p = ck;
          while (p !== undefined) {
            var parts = p.split(',');
            path.push([+parts[0], +parts[1]]);
            p = prev.get(p);
          }
          path.reverse();
          return path;
        }
        var g = dist.get(ck);
        for (var k = 0; k < 6; k++) {
          var nx = cq + NEIGH_SLOTS[k][0], ny = cr + NEIGH_SLOTS[k][1];
          var ds = hexDist(sq, sr, nx, ny);
          if (ds > maxSteps) continue;                         // 步数剪枝 (距起点层数)
          var dn = hexDist(nx, ny, tq, tr);
          /* 步数透镜: 前缀 ≥ ds 步 + 后缀 ≥ dn 步 > 预算 ⇒ 该格不可能在预算内完成
             (两侧都是下界, 故为可采纳剪枝, 不改变可行路径集合) */
          if (ds + dn > maxSteps) continue;
          /* h = 最小权重 × ⌊笛卡尔欧氏距离⌋ (cartDist: 两端点世界坐标的实际
             直线距离, 以格间距为单位取整 —— 恒等式见 cartDist 注释, 非六边格
             步数)。欧氏启发优于 hexDist: 平地上 hexDist 会让所有单调格 f 相同
             (整片同桶, 路形随扩展序锯齿), 欧氏则让直线走廊的格 f 最低、最先
             展开 ⇒ 等代价路径向直线收敛。向下取整 ⇒ h 仍是可采纳下界 */
          var h = minW * cartDist(nx, ny, tq, tr);             // 剩余代价可采纳下界 (实际笛卡尔欧氏距离)
          if (g + h > maxCost) continue;                       // 下界剪枝: 该分支必超预算 (省一次 fields)
          var nk = nx + ',' + ny;
          if (closed.has(nk)) continue;
          var ng = g + roadWeight(fields(nx, ny));
          if (ng + h > maxCost) continue;                      // 权重剪枝 (实际权重 ≥ 下界)
          var old = dist.has(nk) ? dist.get(nk) : 1e18;
          if (ng < old) {
            dist.set(nk, ng);
            prev.set(nk, ck);
            buckets[ng + h].push(nx, ny);                      // 桶下标 = f
          }
        }
      }
      buckets[f] = null;      // 该层已处理完, 及时释放
    }
    return null;
  }

  /* 某区域格内聚落的对外道路 (缓存, 全局去重, 预算制)
     配对语义: 每个聚落与 3x3 邻域格内全部 n 个聚落 (含跨格) 按六边距离升序
     逐对跑 A*, 预算内可达即建路 —— 但先过「跳板剪枝」(hopPrune): 存在严格
     顺路的中间聚落 (两点之间 + 直线绕行 ≤30%) 就不建直达路, 消除跳板/直达
     并行的三角捆绑重复路; 跳板不限规模, MST 边 + 最近邻对保证不被剪。
     候选池半径 (~40 格) 已覆盖 ROAD_STEPS_MAX, 池外的对必被 A* 直线下界剪掉。
     maxNew: 本次调用允许新算的道路条数; 0 = 纯读缓存 (绘制帧用), 防止寻路卡帧 */
  function roadsNear(i, j, maxNew) {
    var budget = maxNew | 0;
    var cellKey = i + ',' + j;
    /* 创建顺序: 规模大者先 (同规模离原点近者先) —— hubBefore 全序, 确定性;
       slice 后排序, 不动 settlementsFor 的缓存数组 */
    var mine = settlementsFor(i, j).slice().sort(function (p, q2) {
      return hubBefore(p, q2) ? -1 : 1;
    });
    var out = [];
    for (var s = 0; s < mine.length; s++) {
      var a = mine[s];
      if (a.type === 'poi') continue;
      // 3x3 邻域格内全部其他聚落 (候选池)
      var cands = [], aPoolIds = new Set();
      for (var di = -1; di <= 1; di++) {
        for (var dj = -1; dj <= 1; dj++) {
          var others = settlementsFor(i + di, j + dj);
          for (var o = 0; o < others.length; o++) {
            if (others[o].id === a.id || others[o].type === 'poi') continue;
            aPoolIds.add(others[o].id);
            cands.push(others[o]);
          }
        }
      }
      /* 距离升序 (实际笛卡尔直线距离): 先近后远, 近的对几乎必成且便宜,
         远的对由预算自然截断 */
      cands.sort(function (p, q2) {
        return cartDist(a.q, a.r, p.q, p.r) - cartDist(a.q, a.r, q2.q, q2.r);
      });
      /* 全部候选逐一尝试 (同一对两端各发起一次也只建一条, rkey 去重) */
      for (var c2 = 0; c2 < cands.length; c2++) {
        var b = cands[c2];
        var rkey = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (roadFail.has(rkey)) continue;          // 已判定不可达: 终身跳过
        var road = roadCache.get(rkey);
        if (!road) {
          /* 跳板剪枝: 跳板池 = 3x3(a格) ∪ 3x3(b格) —— 取并集使从 a 侧与从 b 侧
             评估同一对时池子相同 ⇒ 剪枝与「哪侧先处理该对」无关 (跨会话确定)。
             剪枝判定全整数且不读缓存; 不消耗 A* 预算, 也不记 roadFail (可达,
             只是无需直达) */
          var dab = cartDist(a.q, a.r, b.q, b.r);  // 实际笛卡尔直线距离 (非步数)
          var pruned = false;
          for (var h2 = 0; h2 < cands.length && !pruned; h2++)
            pruned = hopPrune(a, b, cands[h2], dab);
          if (!pruned) {
            var bp = b.id.split('_');
            var bic = +bp[0], bjc = +bp[1];        // b 的区域格 (id 前缀 i_j_k)
            for (var ei = -1; ei <= 1 && !pruned; ei++) {
              for (var ej = -1; ej <= 1 && !pruned; ej++) {
                var extras = settlementsFor(bic + ei, bjc + ej);
                for (var e3 = 0; e3 < extras.length && !pruned; e3++) {
                  var mm = extras[e3];
                  if (mm.type === 'poi' || aPoolIds.has(mm.id)) continue;
                  pruned = hopPrune(a, b, mm, dab);
                }
              }
            }
          }
          if (pruned) continue;
          if (budget <= 0) continue;               // 预算用尽: 本帧不算
          budget--;
          /* 方向归一化: 端点固定按 id 序 (小→大), 使道路点列方向
             与「哪个聚落先发起建路」无关 —— 否则热缓存命中与冷生成
             会得到同一路径的相反点列, 破坏跨会话一致性。 */
          var pA = a, pB = b;
          if (b.id < a.id) { pA = b; pB = a; }
          var path = bfsRoad(pA.q, pA.r, pB.q, pB.r);
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
      }
    }
    return out;
  }

  /* ---------- 灵气场 / 群落 / 灵脉 (设定: 先定灵脉, 后造山河) ---------- */

  /* 灵气归零的世界半径 (世界单位) —— 引擎内部唯一真源。
     预览页边界圈、客户端边界显示都必须用它, 否则会"圈内看着是界外" */
  function spiritEdgeWorld() { return CFG.SPIRIT_R_TILES * HEX_R * 2; }

  /* 灵气场 (设定 §九): 以 (0,0) 为灵气中枢, 欧氏直线距离单调衰减,
     半径 SPIRIT_R_TILES(×HEX_R×2 世界单位) 处归零; 越近群落越密、聚落越繁华 */
  function spiritAt(q, r) {
    var w = tileToWorld(q, r);
    var d = Math.sqrt(w.x * w.x + w.y * w.y) / spiritEdgeWorld();
    var t = Math.max(0, 1 - d);
    return Math.pow(t, CFG.SPIRIT_CURVE);
  }

  /* 边界"保持系数" edgeKeep (设定 §九.3): 把「灵气强度 sp」映射成 0..1 的**保留**权重。
     sp ≥ band → 1 (完全保留, 不衰减);  sp = 0 (边界外) → 0 (彻底衰减)。
     band(=EDGE_SEA_SP / EDGE_SETTLE_SP) 即"灵气降到多少才开始衰减",
     取 0 时退化为硬边界(只要有一点灵气就全保留)。

     ⚠ 语义只有一个方向: 这是"保留"，不是"衰减"。
       要拿"衰减/沉没"权重必须写 1 - edgeKeep(…)，别直接当权重乘 —
       两者写反的画面是: 灵气越浓越沉海 → 内圈全淹、边界反而不动。 */
  function edgeKeep(sp, band) {
    if (!(band > 0)) return sp > 0 ? 1 : 0;
    return NL.smoothstep(0, band, sp);
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
    /* 群落存在概率随灵气; 再乘界面沉海的同一衰减系数
       (灵脉属地形的立体产出: 群落落进沉海带会变成"水下空壳", 必须在播群落这一步就衰减掉) */
    var p = sp < 0.03 ? 0 : (CFG.COMM_P_MIN + CFG.COMM_P_SPIRIT * sp) * edgeKeep(sp, CFG.EDGE_SEA_SP);
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
    siteScoreCache.clear(); prospectCache.clear(); centerCache.clear(); townCache.clear(); tradeCache.clear();
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
    /* 城镇三段式生成 (§三): 供 mapgen-server.regionJson 与预览页/前端直接调用。
       prospectArea = 勘测适宜度图; pickSettlementCenter = 选址中心;
       growTownFootprint = 足迹/建筑/产出/风格 (纯函数 + 按聚落 id 缓存) */
    prospectArea: prospectArea,
    pickSettlementCenter: pickSettlementCenter,
    growTownFootprint: growTownFootprint,
    siteScore: siteScore,
    landuseOf: landuseOf,
    coastalAt: coastalAt,
    /* 贸易网络 (§四): 产出–供需缺口 → 相邻城镇 tradeEdge (纯计算, 不落库) */
    tradeEdgesFor: tradeEdgesFor,
    townNet: townNet,
    spiritAt: spiritAt,
    communityOf: communityOf,
    communityNear: communityNear,
    veinNear: veinNear,
    countVeins: countVeins,
    roadVersion: roadVersion,
    pxToTile: pxToTile,
    tileToWorld: tileToWorld,
    hexDist: hexDist,
    cartDist: cartDist,
    mountainNear: mountainNear,
    /* 精灵索引分配 (供 verify/w5_sprite_range.mjs 直接断言输出契约:
       各群系索引区间必须落在图集已绘制范围内, 不得溢出到别行素材) */
    propSpriteFor: propSpriteFor,
    /* 纯函数 A* 寻路 (只依赖 seed 地形, 不读 roadCache/roadFail) — 供
       verify/w3_bfs_road.mjs 逐对隔离断言「预算上限 / 邻域连通 / 权重累加」,
       避免经 roadsNear 时被跨区域的 roadFail/缓存淘汰状态混淆 */
    bfsRoad: bfsRoad,
    roadWeight: roadWeight,
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
    /* 边界衰减: 预览页/客户端画"灵气边界圈"必须用 spiritEdgeWorld(),
       不得各自硬编码半径 —— 否则会出现"圈内是海、圈外有山"的错位 */
    spiritEdgeWorld: spiritEdgeWorld,
    edgeKeep: edgeKeep,
    EDGE_SEA_FLOOR: EDGE_SEA_FLOOR,
    BIOME: BIOME,
    BIOME_META: BIOME_META
  };
})(window);
