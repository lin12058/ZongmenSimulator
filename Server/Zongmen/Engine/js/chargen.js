/* ============================================================
 * chargen.js — 可招募弟子生成器 (纯函数, 无依赖, classic script)
 * ------------------------------------------------------------
 * 方案: docs/游戏设计/角色生成器-实施方案.md
 * 口径: 角色系统设定表.md + 六道属性体系.md + 用户 2026-11-25 四条定案
 *   1. 灵根 每系只有 0 / 20 两档, 合计 = 20 x 系数量 (20/40/60/80/100);
 *      纯度 = 本系 / 合计; 系数量 1/2/3/4/5 = 1%/2.5%/20%/30%/46.5%
 *   2. 天赋 90~180 **平方偏斜** (90 + 90*rng^2, 均值 120, 150+ 约 18%), 单道 <= 60, 每道 6 项单项 <= 60
 *   3. 只生成凡人: 炼气期 1~3 层 (境界不由天赋推)
 *   4. 神通 0 已学 (cap 3, 靠功法书 + 闭关时间)
 *   5. 装备只发起步件 (灵力驱动规则待做)
 *
 * ★ 为什么是 classic script:
 *   本文件要能同时被 ① 服务端 V8 (bundle 里 Evaluate, 无 import/module/fs)
 *   ② Node 判据 (require / vm) ③ 浏览器 (前端预览) 加载 ⇒ 只用一个 IIFE, 挂 global.Chargen。
 *   Node 侧用法: global.window = globalThis; require('./chargen.js')
 *
 * ★ 确定性:
 *   同一 (worldSeed, settleId, round, slot) ⇒ 逐字段一致, 绝不用 Math.random()/Date.now()。
 *   世界种子是服务端资产, 本文件只**消费**, 不产生。
 *
 * ★ 输出形状 = CrewBridge 的 **contract member**:
 *   装备只给 itemId (equip 五槽 + queue 法宝队列), 物品本体在 items[] 里各出现一次,
 *   属性一个都不存 (气血/攻防/命中全由 CrewModel.attrs 现算)。
 *
 * ★ 与另两个生成器的边界 (别混):
 *   crew-model.demoSquad   前端演示数据 (境界由天赋推, 会出元婴)
 *   CultivatorGen          世界人口 NPC (Subsystems/Characters/js/chargen-core.js, 另一套字段)
 *   Chargen (本文件)       玩家可招募弟子
 * ============================================================ */
(function (global) {
  'use strict';

  /* ⚠ 改语义就 +1: 灵根含义(0/20 二值)/特质表/天赋分布三处已变更 ⇒ v:1 与新数据必须可区分 (审查 D3) */
  var VERSION = 2;

  /* ============================================================
   * 常量 —— 判据直接读这里, UI 不许再抄一份
   * ============================================================ */
  var CFG = {
    /* 灵根 —— ⚠ 初始只有两档: 0(这系不通) 或 20(通了), 没有中间值。
       合计 = 20 × 系数量 (20/40/60/80/100), 不再强行凑 100。
       纯度 (面板/占比) = 本系 / 合计, 单系即 100%, 五系各 20%。 */
    ROOT_STEP: 20,            // 初始每系唯一取值
    ROOT_TOTAL: 100,          // 五系全通时的合计 (纯度换算的分母上限, 不是硬校验)
    ROOT_MIN_PER: 20,         // 与非零项同值, 保留供旧断言读
    ROOT_MAIN_WEIGHT: 3,      // (预留: 后续强化加点时主系权重)
    /* 系数量分布 (1/2/3/4/5) —— 累计阈值 */
    ROOT_K_CUT: [0.010, 0.035, 0.235, 0.535],   // <0.010→1系, <0.035→2系, <0.235→3系, <0.535→4系, 其余→5系
    ROOT_K_PCT: ['1%', '2.5%', '20%', '30%', '46.5%'],

    /* 天赋 */
    TALENT_MIN: 90,
    TALENT_MAX: 180,
    /* 总量偏斜: total = MIN + (MAX-MIN) * rng^SKEW
       SKEW=1 均匀 (旧) ⇒ 均值 135, 150+ 占 33%, 满街双道 60 的苗子
       SKEW=2 ⇒ 均值 120, 150+ 约 18%, 大多数人挤在 90~120
       SKEW=3 ⇒ 均值 112.5, 150+ 约 12.6%  (想更苦就往上调) */
    TALENT_SKEW: 2,
    DAO_CAP: 60,              // 单道上限
    TALENT_CAP: 60,           // 单项上限
    DAO_BASE_MIN: 2,          // 每道底 (避免一排 0)
    DAO_BASE_MAX: 6,

    /* 特质 —— 只发正面, 负面一律不出 (玩家体验优先)
       抽取走「量化加成 → 权重 → 累计和轮盘」: 权重 = TRAIT_W_BASE / bonus^TRAIT_W_EXP
       bonus 2→17.7, 4→3.1, 7→0.76, 10→0.316; 再乘档位系数 ⇒
       辟谷(common 17.7) : 天生道体(epic 0.095) = 186 : 1 (审查 D8: 旧注释 316 倍是错的) */
    TRAIT_MIN: 1,
    TRAIT_MAX: 3,
    TRAIT_W_BASE: 100,
    TRAIT_W_EXP: 2.5,
    /* 档位再乘一道系数 —— 让"高档很稀"和"bonus 是游戏内强度"两件事解耦,
       不用为了压概率去扭曲 bonus 语义 */
    TRAIT_TIER_MULT: { common: 1, uncommon: 0.85, rare: 0.6, epic: 0.3 },
    TRAIT_HIGH_CAP: 1,        // 每人 rare+epic 合计最多几条 (防"三条神体")
    TRAIT_BONUS_CAP: 10,      // 单人加成合计上限 (3 条都偏高就够不着 18+)

    /* 境界 / 修为 */
    REALM_FIXED: '炼气',       // 只出凡人
    LAYER_MIN: 1,
    LAYER_MAX: 3,
    EXP_STAGE_MAX: 600,       // 炼气段上限 (不是 600+total*6)
    EXP_RATE_MIN: 0.05,
    EXP_RATE_MAX: 0.60,

    /* 神通 / 装备 */
    ART_CAP: 3,               // 格数; 已学恒 0
    TALISMAN_MIN: 1,
    TALISMAN_MAX: 4,

    /* 池量 (按聚落类型) */
    POOL: { village: [3, 4], town: [4, 6], city: [6, 9], sect: [2, 5], fishing: [3, 5], poi: [0, 0] },
    POOL_MAX: 9
  };

  /* 五行 —— 顺序必须与 web/js/crew/crew-model.js 的 ELEMENTS 逐位一致 */
  var ELEMENTS = [
    { k: 'metal', n: '金' }, { k: 'wood', n: '木' }, { k: 'water', n: '水' },
    { k: 'fire', n: '火' }, { k: 'earth', n: '土' }
  ];

  /* 六道 —— 顺序即契约 (crew-model 的 DAO 同序) */
  var DAO = [
    { k: 'body',  n: '体', talents: ['铁骨', '蛮力', '坚韧', '疾行', '气血', '硬功'] },
    { k: 'qi',    n: '气', talents: ['纳灵', '周天', '绵息', '速引', '灵压', '御风'] },
    { k: 'mind',  n: '神', talents: ['凝神', '观微', '定心', '神识', '梦引', '慑魂'] },
    { k: 'gear',  n: '器', talents: ['控火', '辨材', '淬锋', '急就', '器灵', '重铸'] },
    { k: 'pill',  n: '丹', talents: ['识药', '控炉', '保性', '提纯', '复方', '丹毒'] },
    { k: 'array', n: '阵', talents: ['布阵', '阵眼', '连纹', '速设', '掩息', '破阵'] }
  ];

  /* 特质 —— 24 条, **全正面**, 同一 k 互斥 (不出重复)
     tier: common 寻常 / uncommon 良 / rare 异禀 / epic 天命 (展示与后期限定用, 不再直接决定概率)
     bonus: 加成强度量化 (1~10), **抽取权重 = BASE / bonus^EXP** —— 越强越难出
     抽法: 把候选按权重累加成一条数轴, rng() 落点决定抽到谁 (权重轮盘)
     ⚠ 百分比一律按「原值 ÷4」定档 (2026-11-25 定案): 别写 +20%, 写 +5%;
       点数值 (气血 +10 / 心境 +8 / 神识 +1 格) 不缩, 它们本来就是绝对量。 */
  var TRAITS = [
    { k: 'quiet',     n: '辟谷',     tier: 'common',   bonus: 2,  v: '食量 -13%' },
    { k: 'diligence', n: '勤勉',     tier: 'common',   bonus: 2,  v: '劳作效率 +9%' },
    { k: 'night',     n: '夜行',     tier: 'common',   bonus: 2,  v: '夜间效率 +5%' },
    { k: 'hands',     n: '巧手',     tier: 'common',   bonus: 2,  v: '炼器成器 +5%' },
    { k: 'focus',     n: '专注',     tier: 'common',   bonus: 2,  v: '工序失误 -8%' },
    { k: 'nerve',     n: '胆识',     tier: 'common',   bonus: 2,  v: '近战伤害 +3%' },
    { k: 'grit',      n: '坚毅',     tier: 'common',   bonus: 3,  v: '受伤恢复 +13%，气血上限 +10' },
    { k: 'blood',     n: '血旺',     tier: 'common',   bonus: 3,  v: '气血上限 +4%' },

    { k: 'social',    n: '亲和',     tier: 'uncommon', bonus: 3,  v: '同门心境 +8' },
    { k: 'senses',    n: '耳目清明', tier: 'uncommon', bonus: 3,  v: '命中 +8，闪避 +2%' },
    { k: 'herb',      n: '妙手回春', tier: 'uncommon', bonus: 3,  v: '疗伤效果 +8%' },
    { k: 'calm',      n: '心如止水', tier: 'uncommon', bonus: 3,  v: '心境下限 +15，遇挫不馁' },
    { k: 'insight',   n: '慧根',     tier: 'uncommon', bonus: 4,  v: '修炼速度 +6%' },
    { k: 'temper',    n: '沉静',     tier: 'uncommon', bonus: 4,  v: '突破成功率 +3%' },
    { k: 'memory',    n: '过目不忘', tier: 'uncommon', bonus: 4,  v: '参悟功法速度 +10%' },
    { k: 'ironbone',  n: '铜皮铁骨', tier: 'uncommon', bonus: 4,  v: '防御 +5%' },

    { k: 'spiriteye', n: '天生灵眸', tier: 'rare',     bonus: 5,  v: '神识范围 +1 格，可窥禁制' },
    { k: 'lucky',     n: '福缘深厚', tier: 'rare',     bonus: 5,  v: '奇遇与拾遗概率 +8%' },
    { k: 'fivemix',   n: '五行亲和', tier: 'rare',     bonus: 5,  v: '聚气速度 +4%' },
    { k: 'charm',     n: '天生魅体', tier: 'rare',     bonus: 6,  v: '容仪摄人：同门心境 +12，招揽与议价极易见效' },
    { k: 'mighty',    n: '力大无穷', tier: 'rare',     bonus: 6,  v: '近战伤害 +5%，负重 +5%' },
    { k: 'dragon',    n: '龙象之力', tier: 'rare',     bonus: 7,  v: '气血上限 +6%，近战伤害 +4%' },

    { k: 'daoheart',  n: '道心通明', tier: 'epic',     bonus: 9,  v: '突破成功率 +5%，心境不堕' },
    { k: 'daobody',   n: '天生道体', tier: 'epic',     bonus: 10, v: '修炼速度 +10%，聚气 +3%' }
  ];
  /* 名字 → {n,v,k,tier,bonus,kind,pair}: 纯正面, pair 用 k 自身 (同 key 互斥) */
  var TRAIT_INDEX = (function () {
    var m = {}, i, t;
    for (i = 0; i < TRAITS.length; i++) {
      t = TRAITS[i];
      m[t.n] = { n: t.n, v: t.v, k: t.k, tier: t.tier, bonus: t.bonus, kind: 'pos', pair: 'solo-' + t.k };
    }
    return m;
  })();
  /* 抽取权重: 加成越强越低, 档位再乘系数
     bonus=2 → 17.7, 4 → 3.1, 7 → 0.76, 10 → 0.316; epic 再 x0.3
     ⇒ 真实比值 17.7 : (0.316*0.3) = 186 : 1 (不是 316) */
  function traitWeight(t) {
    return CFG.TRAIT_W_BASE / Math.pow(t.bonus, CFG.TRAIT_W_EXP) * (CFG.TRAIT_TIER_MULT[t.tier] || 1);
  }

  /* 出身 (凡人没有职司; 入宗后再转) —— bias = 六道主/次 */
  var BACKGROUNDS = [
    { k: 'farmer',   n: '农户',     bias: ['qi', 'body'],    weight: 26, mood: [52, 78] },
    { k: 'hunter',   n: '猎户',     bias: ['body', 'gear'],  weight: 16, mood: [55, 82] },
    { k: 'fisher',   n: '渔家',     bias: ['qi', 'array'],   weight: 12, mood: [50, 80] },
    { k: 'smith',    n: '铁匠',     bias: ['gear', 'body'],  weight: 12, mood: [48, 75] },
    { k: 'healer',   n: '游医',     bias: ['pill', 'qi'],    weight: 9,  mood: [50, 80] },
    { k: 'wanderer', n: '流民',     bias: ['body', 'qi'],    weight: 18, mood: [30, 55] },
    { k: 'scholar',  n: '落第书生', bias: ['mind', 'array'], weight: 7,  mood: [40, 70] }
  ];
  var BG_TOTAL = (function () { var s = 0, i; for (i = 0; i < BACKGROUNDS.length; i++) s += BACKGROUNDS[i].weight; return s; })();

  var SURNAMES = ['沈', '陆', '顾', '谢', '裴', '苏', '宁', '温', '江', '柳', '岑', '褚',
                  '闵', '殷', '阮', '宋', '卫', '邵', '毕', '费', '鲁', '柏', '郝', '昌',
                  '鲍', '董', '仇', '禹', '荣', '弘', '燕', '边', '隗', '晏', '扈', '虞'];

  var GIVEN = ['青筠', '玄策', '砚秋', '知白', '素心', '无咎', '砚雪', '照野', '拾遗', '长庚',
               '怀瑾', '听澜', '慎之', '寒山', '疏影', '问津', '承光', '漱石', '维桑', '其琛',
               '子槊', '归荑', '维叶', '令仪', '肃雍', '鹿鸣', '嘉卉', '有邰', '其雷', '殷雷',
               '秉心', '塞渊', '考槃', '硕人', '芄兰', '芣苡', '采苓', '椒聊', '式微', '旄丘',
               '彤弓', '采薇', '斯干', '无衣', '权舆', '宛丘', '泽陂', '羔裘', '陟岵', '淇奥'];

  /* 起步件 (占位: 等装备表进引擎后由 gearGen 钩子替换) */
  var STARTER = {
    weapon:   { name: '桃木剑',   kind: 'weapon',   ch: '桃', q: 1, w: 4, atk: 4, acc: 6 },
    offhand:  { name: '木盾',     kind: 'offhand',  ch: '盾', q: 1, w: 6, def: 6 },
    body:     { name: '粗布道袍', kind: 'body',     ch: '袍', q: 1, w: 5, def: 4 },
    head:     { name: '束发巾',   kind: 'head',     ch: '巾', q: 1, w: 1, def: 2 },
    talisman: { name: '铜铃',     kind: 'talisman', ch: '铃', q: 1, w: 1, mp: 6 }
  };

  /* ============================================================
   * 确定性随机
   * ============================================================ */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function hash32() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    return fnv1a(parts.join('\u0001'));
  }
  /** seedOf(['w',settleId,round,slot]) → uint32; 也可直接给数字/字符串 */
  function seedOf(parts) {
    if (typeof parts === 'number') return (parts >>> 0) || 0x9e3779b9;
    if (typeof parts === 'string') return fnv1a(parts) || 0x9e3779b9;
    return hash32.apply(null, parts || ['seed']);
  }
  function mulberry32(a) {
    a = (typeof a === 'number' ? a : fnv1a(String(a))) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 小工具 ---------- */
  /* ⚠ 内部 mulberry32 恒 <1, 但本文件把 mulberry32/rng 一起导出 ⇒ 外部注入的 rng 返回 1 时
     rint 会越到 hi+1、pick 会取到 arr[length] (undefined), 一路炸到 traits/ties (审查 D4) */
  function rint(rng, lo, hi) { return Math.min(hi, Math.max(lo, lo + Math.floor(rng() * (hi - lo + 1)))); }
  function pick(rng, arr) { return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(rng() * arr.length)))]; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  /* ⚠ j 必须夹在 [0,i]: 外部 rng 返回 1 时 Math.floor(rng()*(i+1))===i+1 ⇒ 换进 undefined (审查 D4) */
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.min(i, Math.floor(rng() * (i + 1))); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function sumArr(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return s; }
  function weightedPick(rng, weights) {
    var s = 0, i;
    for (i = 0; i < weights.length; i++) s += weights[i];
    var x = rng() * s, acc = 0;
    for (i = 0; i < weights.length; i++) { acc += weights[i]; if (x <= acc) return i; }
    return weights.length - 1;
  }
  /* ⚠ 旧的 splitWeighted(按权重切余数) 已删: 灵根改成 0/20 二值后不再需要,
     留着只会被人再拿去切出 22/25/28 这种中间值。 */
  function pickBackground(rng) {
    var x = rng() * BG_TOTAL, acc = 0;
    for (var i = 0; i < BACKGROUNDS.length; i++) {
      acc += BACKGROUNDS[i].weight;
      if (x <= acc) return BACKGROUNDS[i];
    }
    return BACKGROUNDS[0];
  }

  /* ============================================================
   * 灵根
   * ------------------------------------------------------------
   * k 由分布抽; 被选中的 k 个系各 20, 未选中为 0 —— **不切余数** (旧算法的 22/25/28 已删);
   * main = 值最大的下标 (指定灵脉五行时该系优先, 否则全 20 并列随机)。
   * ============================================================ */
  function genRoot(rng, opts) {
    opts = opts || {};
    var k, x = rng();
    if (x < CFG.ROOT_K_CUT[0]) k = 1;
    else if (x < CFG.ROOT_K_CUT[1]) k = 2;
    else if (x < CFG.ROOT_K_CUT[2]) k = 3;
    else if (x < CFG.ROOT_K_CUT[3]) k = 4;
    else k = 5;

    /* 挑哪几系: 若指定了本地灵脉五行, 该系必进 (作为主系候选) */
    var present = [], i, rest = [0, 1, 2, 3, 4];
    var elem = (typeof opts.element === 'number' && opts.element >= 0 && opts.element <= 4) ? opts.element : null;
    if (elem != null) {
      present.push(elem);
      rest = rest.filter(function (v) { return v !== elem; });
    }
    rest = shuffle(rng, rest);
    while (present.length < k) present.push(rest.pop());

    var v = [0, 0, 0, 0, 0], mainVal = -1, ties = [];
    /* 通了就是 20, 没通就是 0 —— 不切余数 (旧算法会切出 22/25/28 这种中间值) */
    for (i = 0; i < present.length; i++) v[present[i]] = CFG.ROOT_STEP;
    for (i = 0; i < 5; i++) {
      if (v[i] > mainVal) { mainVal = v[i]; ties = [i]; }
      else if (v[i] === mainVal) ties.push(i);
    }
    /* 主系: 指定了本地灵脉五行 ⇒ 该系就是主系 («主系优先»);
       否则全 20 并列时随机取一个 (旧代码默认 0, 会让所有人的主灵根都像「金」)
       ⚠ 审查 D6: 原实现让 elem 混在 ties 里均匀随机, 实测只有 1/k ≈ 25.7% 命中 */
    var main;
    if (elem != null) main = elem;
    else main = ties.length > 1 ? ties[Math.min(ties.length - 1, Math.floor(rng() * ties.length))] : ties[0];

    return {
      order: ELEMENTS.map(function (e) { return e.k; }),
      v: v,
      main: main,
      count: present.length,
      sum: present.length * CFG.ROOT_STEP
    };
  }

  /* ============================================================
   * 天赋 (90~180 均匀, 单道 <=60, 每道 6 项 <=60)
   * ============================================================ */
  function genTalents(rng, bias) {
    /* 平方偏斜: 低天赋是常态, 180 是万里挑一 (见 CFG.TALENT_SKEW) */
    var total = Math.round(CFG.TALENT_MIN +
      (CFG.TALENT_MAX - CFG.TALENT_MIN) * Math.pow(rng(), CFG.TALENT_SKEW));
    var d, sums = [], weights = [], sumAll = 0;

    for (d = 0; d < DAO.length; d++) {
      var b = rint(rng, CFG.DAO_BASE_MIN, CFG.DAO_BASE_MAX);
      sums.push(b); sumAll += b;
      var w = 0.5;
      if (bias && DAO[d].k === bias[0]) w = 3;
      else if (bias && DAO[d].k === bias[1]) w = 1.8;
      weights.push(w);
    }

    var left = total - sumAll, guard = 0;
    while (left > 0 && guard++ < 20000) {
      var di = weightedPick(rng, weights);
      if (sums[di] >= CFG.DAO_CAP) continue;
      var add = Math.min(CFG.DAO_CAP - sums[di], left, rint(rng, 2, 9));
      sums[di] += add; left -= add;
    }
    /* 兜底: 权重抽不出来时按顺序填 (总量 <=180 < 6*60, 一定有位置) */
    if (left > 0) {
      for (d = 0; d < DAO.length && left > 0; d++) {
        var room = CFG.DAO_CAP - sums[d], a = Math.min(room, left);
        sums[d] += a; left -= a;
      }
    }

    var v = {}, real = 0;
    for (d = 0; d < DAO.length; d++) {
      var arr = [0, 0, 0, 0, 0, 0], rest = sums[d], g = 0;
      while (rest > 0 && g++ < 5000) {
        var ti = rint(rng, 0, 5), room2 = CFG.TALENT_CAP - arr[ti];
        if (room2 <= 0) continue;
        var a2 = Math.min(room2, rest, rint(rng, 1, 12));
        arr[ti] += a2; rest -= a2;
      }
      if (rest > 0) {                       /* 理论上不可达, 仍兜一层 */
        for (var q = 0; q < 6 && rest > 0; q++) {
          var r3 = CFG.TALENT_CAP - arr[q], a3 = Math.min(r3, rest);
          arr[q] += a3; rest -= a3;
        }
      }
      v[DAO[d].k] = arr;
      real += sumArr(arr);
    }
    return { v: v, total: real };           /* total 以实际为准, 永不失配 */
  }

  /* ============================================================
   * 特质 1~3 条, 全正面, 不重复
   * ------------------------------------------------------------
   * 不再「先掷档再抽条目」—— 那样档位概率是常数, 三档叠加很容易出双神体。
   * 现在:
   *   1) 每条候选按 w = TRAIT_W_BASE / bonus^TRAIT_W_EXP 给权重 (越强越短)
   *   2) 把候选权重累加成一条数轴, x = rng()*总权重 落点决定抽谁 (权重轮盘)
   *   3) 抽走即从池子里删 (不重复); rare+epic 全局最多 TRAIT_HIGH_CAP 条
   *   4) 单人 bonus 合计不超过 TRAIT_BONUS_CAP (三条都高档也堆不起来)
   * ============================================================ */
  function genTraits(rng) {
    var want = rint(rng, CFG.TRAIT_MIN, CFG.TRAIT_MAX);
    var pool = TRAITS.slice(), out = [], high = 0, budget = CFG.TRAIT_BONUS_CAP;
    var j, t, x, wsum, cands, chosen;   /* ⚠ 别叫 pick: 会遮蔽模块级 pick(rng, arr) (审查 D10) */

    while (out.length < want) {
      cands = [];
      wsum = 0;
      for (j = 0; j < pool.length; j++) {
        t = pool[j];
        if (t.bonus > budget) continue;                                        /* 预算不够 */
        if ((t.tier === 'rare' || t.tier === 'epic') && high >= CFG.TRAIT_HIGH_CAP) continue;
        cands.push(t);
        wsum += traitWeight(t);
      }
      if (!cands.length || wsum <= 0) break;

      x = rng() * wsum;
      chosen = cands[cands.length - 1];      /* 浮点兜底, 最后一格必中 */
      for (j = 0; j < cands.length; j++) {
        x -= traitWeight(cands[j]);
        if (x <= 0) { chosen = cands[j]; break; }
      }

      out.push({ n: chosen.n, v: chosen.v, tier: chosen.tier, bonus: chosen.bonus });
      budget -= chosen.bonus;
      if (chosen.tier === 'rare' || chosen.tier === 'epic') high++;
      pool.splice(pool.indexOf(chosen), 1);
    }
    return out;
  }

  /* ============================================================
   * 起步装备 (只给 id, 物品本体进 items[])
   * ============================================================ */
  function makeItem(def, id) {
    return {
      id: id, name: def.name, kind: def.kind, ch: def.ch, q: def.q || 1,
      w: def.w || 0, atk: def.atk || 0, def: def.def || 0, acc: def.acc || 0,
      hp: def.hp || 0, mp: def.mp || 0, heal: def.heal || 0,
      qty: 1, qtyMax: def.qtyMax || 1, cell: null
    };
  }
  function genStarter(idBase) {
    var items = [], gear = {}, i;
    function mk(slot, def) { var it = makeItem(def, idBase + '-' + slot); items.push(it); gear[slot] = it; return it; }
    var w = mk('weapon', STARTER.weapon);
    /* ⚠ 以前只声明 STARTER.offhand 不产出 ⇒ equip.offhand 恒 null, 而 STARTER 是导出对象,
       UI 遍历时会多画一个永远空的副手槽 (审查 D7) */
    var o = mk('offhand', STARTER.offhand);
    mk('body', STARTER.body);
    mk('head', STARTER.head);
    var t = mk('talisman', STARTER.talisman);
    var equip = { weapon: w.id, offhand: o.id, body: gear.body.id, head: gear.head.id, talisman: t.id };
    return { gear: gear, equip: equip, queue: [t.id], queueFrom: '本命一件', items: items };
  }
  function emptyKit() {
    return {
      gear: {}, items: [], queue: [], queueFrom: '无',
      equip: { weapon: null, offhand: null, body: null, head: null, talisman: null }
    };
  }

  /* 与 crew-model.attrs() 的 hp/mp 口径一致 (那边 atk/def 仍是旧公式, 但 hp/mp 相同) */
  function maxVitalsOf(talents, gear) {
    var B = sumArr(talents.v.body), Q = sumArr(talents.v.qi);
    var hp = 60 + Math.round(B * 1.1), mp = 24 + Math.round(Q * 0.7);
    var keys = ['weapon', 'offhand', 'body', 'head', 'talisman'], i;
    for (i = 0; i < keys.length; i++) {
      var it = gear[keys[i]];
      if (it) { hp += it.hp || 0; mp += it.mp || 0; }
    }
    return { hp: hp, mp: mp };
  }

  /* ============================================================
   * 单个人
   * ------------------------------------------------------------
   * opts = { worldSeed, settleId, round, slot, salt, surname, element,
   *          background, gear:false, q, r }
   * ============================================================ */
  function genCandidate(opts) {
    opts = opts || {};
    var parts = [
      opts.worldSeed == null ? 'w0' : opts.worldSeed,
      opts.settleId == null ? 's0' : opts.settleId,
      opts.round == null ? 0 : opts.round,
      opts.slot == null ? 0 : opts.slot,
      opts.salt || 'c'
    ];
    var seed = seedOf(parts);
    var rng = mulberry32(seed);
    var seedKey = parts.join('|');
    var idBase = 'srv-c-' + (hash32(seedKey) >>> 0).toString(16).padStart(8, '0');

    var bg = null;
    if (opts.background) {
      for (var bi = 0; bi < BACKGROUNDS.length; bi++) {
        if (BACKGROUNDS[bi].k === opts.background || BACKGROUNDS[bi].n === opts.background) { bg = BACKGROUNDS[bi]; break; }
      }
    }
    /* ⚠ 出生地走**独立** rng: 与主随机流分开 ⇒ 传 / 不传 opts.background 不会平移后面的
       灵根 / 天赋 / 姓名 (审查 D11: 原来差一次 rng 消耗, 只改出生地就换掉整个人) */
    if (!bg) bg = pickBackground(mulberry32(seed ^ 0x85ebca6b));

    var root = genRoot(rng, { element: opts.element });
    var tal = genTalents(rng, bg.bias);
    var traits = genTraits(rng);
    var kit = opts.gear === false ? emptyKit() : genStarter(idBase);

    var layer = rint(rng, CFG.LAYER_MIN, CFG.LAYER_MAX);
    var expMax = CFG.EXP_STAGE_MAX;
    var exp = Math.max(1, Math.round(expMax * (CFG.EXP_RATE_MIN + rng() * (CFG.EXP_RATE_MAX - CFG.EXP_RATE_MIN))));
    var age = clamp(13 + layer * 5 + rint(rng, 0, 5), 14, 40);
    var gender = rng() < 0.5 ? '男' : '女';

    /* 姓名: 同村多同姓 (姓由池子给), 重名由调用方 used 表 + salt 挡 */
    var surname = opts.surname || pick(rng, SURNAMES);
    var name = surname + pick(rng, GIVEN);

    var vit0 = maxVitalsOf(tal, kit.gear);
    var moodRange = bg.mood || [45, 85];

    /* ===== contract member 形状: 装备只给 itemId, 派生值一个都不存 ===== */
    var pawn = {
      id: idBase,
      name: name,
      role: '凡人',
      age: age,
      gender: gender,
      realm: CFG.REALM_FIXED + '期 · ' + layer + ' 层',
      exp: exp,
      mood: rint(rng, moodRange[0], moodRange[1]),
      root: { order: root.order, v: root.v, main: root.main },
      talents: { v: tal.v, total: tal.total },
      traits: traits,
      equip: kit.equip,
      queue: kit.queue,
      queueFrom: kit.queueFrom,
      arts: { slots: [], cap: CFG.ART_CAP, from: '未习' },
      vit: {
        hp: Math.round(vit0.hp * (0.60 + rng() * 0.35)),
        mp: Math.round(vit0.mp * (0.50 + rng() * 0.45))
      },
      activity: { kind: 'idle', jobId: null, taskName: '', progress: 0, done: 0, since: 0, note: '' },
      prio: {}
    };

    return {
      v: VERSION,
      seedKey: seedKey,
      id: idBase,
      pawn: pawn,
      items: kit.items,
      meta: {
        background: bg.n,
        backgroundKey: bg.k,
        rootCount: root.count,
        rootMain: ELEMENTS[root.main].n,
        rootSum: root.sum,                                                    // 20 × 系数量
        rootPct: root.v.map(function (x) { return Math.round(x / root.sum * 1000) / 10; }),   // 纯度
        talentTotal: tal.total,
        layer: layer,
        expMax: expMax,
        bornAt: { q: opts.q == null ? null : opts.q, r: opts.r == null ? null : opts.r },
        settleId: opts.settleId == null ? null : opts.settleId
      }
    };
  }

  /* ============================================================
   * 一池候选
   * ------------------------------------------------------------
   * opts = { worldSeed, settle:{id,type,pop,element,q,r}, round, size?, usedNames? }
   * 同 (worldSeed, settleId, round) ⇒ 池子稳定; slot 即下标, 招走的人占位不重排。
   * ============================================================ */
  /* ⚠ 池子的「散列键」与「返回的 seedKey」必须是同一份: 原来两处各写一遍默认值填充,
     改默认值就会让返回的键与实际散列的键不一致 (审查 D12) */
  function poolKeyParts(opts, st) {
    return [opts.worldSeed == null ? 'w0' : opts.worldSeed,
            st.id == null ? 's0' : st.id,
            opts.round == null ? 0 : opts.round, 'pool'];
  }

  function genPool(opts) {
    opts = opts || {};
    var st = opts.settle || {};
    var type = st.type || 'village';
    var range = CFG.POOL[type] || CFG.POOL.village;
    var poolRng = mulberry32(seedOf(poolKeyParts(opts, st)));

    var size = opts.size != null ? Math.round(opts.size) : rint(poolRng, range[0], range[1]);
    /* ⚠ pop 只做**放大**参考 (文档: «pop 可再放大»): 原来只用 Math.min, pop=200 的仙城
       会被压到 4 人 (村落量级), 直接跌破类型的区间下限 (审查 C9) */
    if (st.pop) size = Math.max(size, Math.min(CFG.POOL_MAX, Math.max(1, Math.round(st.pop / 50))));
    size = clamp(size, 0, CFG.POOL_MAX);

    /* 一村多同姓: 70% 整池共用一个姓, 否则每人五五开 */
    var villageSurname = pick(poolRng, SURNAMES);
    var shareSurname = poolRng() < 0.7;

    /* ⚠ 浅拷贝: 原地写调用方的 usedNames ⇒ 同参数调第二次时每格都撞名、重试到 guard 上限,
       整池换人 (方案档 §十二.4 «同参数两次结果相同» 会 FAIL) —— 审查 C8 */
    var used = Object.assign({}, opts.usedNames || {});
    var out = [], i, guard;
    for (i = 0; i < size; i++) {
      var surname = (shareSurname || poolRng() < 0.5) ? villageSurname : null;
      var cand = null;
      for (guard = 0; guard < 24; guard++) {
        cand = genCandidate({
          worldSeed: opts.worldSeed,
          settleId: st.id,
          round: opts.round,
          slot: i,
          /* ⚠ 重试必须换 salt: seed 由 (worldSeed,settleId,round,slot) 决定,
             不换则每次都是同一个人 (同一个姓名), 撞名永远解不开 */
          salt: 'c' + guard,
          surname: surname || undefined,
          element: st.element,
          q: st.q, r: st.r
        });
        if (!used[cand.pawn.name]) break;
      }
      used[cand.pawn.name] = 1;
      out.push(cand);
    }
    return {
      v: VERSION,
      seedKey: poolKeyParts(opts, st).join('|'),
      settle: { id: st.id == null ? null : st.id, type: type,
                pop: st.pop == null ? null : st.pop, element: st.element == null ? null : st.element },
      candidates: out
    };
  }

  /* ============================================================
   * 自检 / 分布
   * ============================================================ */
  function checkCandidate(c) {
    var bad = [], p = c.pawn, i, d, k;
    var rs = sumArr(p.root.v);
    if (p.root.v.length !== 5) bad.push(p.name + ': 灵根不是 5 项');
    var nz = 0, minNz = 999;
    for (i = 0; i < 5; i++) {
      if (p.root.v[i] < 0) bad.push(p.name + ': 灵根负值');
      if (p.root.v[i] > 0) { nz++; if (p.root.v[i] < minNz) minNz = p.root.v[i]; }
      /* ⚠ 初始只有两档: 0 或 ROOT_STEP(20), 22/25/28 这种中间值一律非法 */
      if (p.root.v[i] !== 0 && p.root.v[i] !== CFG.ROOT_STEP) {
        bad.push(p.name + ': 灵根取值不是 0/' + CFG.ROOT_STEP + ' → ' + p.root.v[i]);
      }
    }
    if (nz < 1 || nz > 5) bad.push(p.name + ': 灵根系数量 ' + nz);
    /* ⚠ 这两行以前只算不判 (minNz 写而不读, 审查 D9): 非零项必须 >= ROOT_MIN_PER,
       否则「每系 >= 20」的口径没有任何判据守 */
    if (nz > 0 && minNz < CFG.ROOT_MIN_PER) bad.push(p.name + ': 灵根非零项最小 ' + minNz + ' < ' + CFG.ROOT_MIN_PER);
    if (rs !== nz * CFG.ROOT_STEP) bad.push(p.name + ': 灵根合计 ' + rs + '，应为 ' + (nz * CFG.ROOT_STEP));
    if (c.meta.rootCount !== nz) bad.push(p.name + ': meta.rootCount 与实际不符');
    if (p.root.v[p.root.main] !== Math.max.apply(null, p.root.v)) bad.push(p.name + ': main 不是最大系');

    var tt = 0;
    for (d = 0; d < DAO.length; d++) {
      var arr = p.talents.v[DAO[d].k];
      if (!arr || arr.length !== 6) { bad.push(p.name + ': ' + DAO[d].n + ' 道不是 6 项'); continue; }
      var ds = 0;
      for (k = 0; k < 6; k++) {
        ds += arr[k];
        if (arr[k] < 0 || arr[k] > CFG.TALENT_CAP) bad.push(p.name + ': ' + DAO[d].n + ' 单项越界 ' + arr[k]);
      }
      if (ds > CFG.DAO_CAP) bad.push(p.name + ': ' + DAO[d].n + ' 道超 60');
      tt += ds;
    }
    if (tt !== p.talents.total) bad.push(p.name + ': 天赋合计失配');
    if (tt < CFG.TALENT_MIN || tt > CFG.TALENT_MAX) bad.push(p.name + ': 天赋总量 ' + tt);

    if (p.traits.length < CFG.TRAIT_MIN || p.traits.length > CFG.TRAIT_MAX) bad.push(p.name + ': 特质条数');
    var seen = {}, highN = 0, bonusSum = 0;
    for (i = 0; i < p.traits.length; i++) {
      var def = TRAIT_INDEX[p.traits[i].n];
      if (!def) { bad.push(p.name + ': 特质不在表内 ' + p.traits[i].n); continue; }
      if (def.kind !== 'pos') bad.push(p.name + ': 发出了负面特质 ' + p.traits[i].n);
      if (seen[def.k]) bad.push(p.name + ': 特质重复 ' + p.traits[i].n);
      seen[def.k] = 1;
      if (!(def.bonus >= 1 && def.bonus <= 10)) bad.push(p.name + ': 特质加成分越界 ' + p.traits[i].n);
      if (def.tier === 'rare' || def.tier === 'epic') highN++;
      bonusSum += def.bonus;
    }
    if (highN > CFG.TRAIT_HIGH_CAP) bad.push(p.name + ': 异禀以上 ' + highN + ' 条 (上限 ' + CFG.TRAIT_HIGH_CAP + ')');
    if (bonusSum > CFG.TRAIT_BONUS_CAP) bad.push(p.name + ': 特质加成合计 ' + bonusSum + ' (上限 ' + CFG.TRAIT_BONUS_CAP + ')');

    if (!/^炼气期 · [1-3] 层$/.test(p.realm)) bad.push(p.name + ': 境界 ' + p.realm);
    if (!(p.exp > 0 && p.exp <= c.meta.expMax)) bad.push(p.name + ': 修为 ' + p.exp);
    if (p.arts.slots.length !== 0 || p.arts.cap !== CFG.ART_CAP) bad.push(p.name + ': 神通应为 0 已学 / cap 3');

    /* 物品: id 唯一; 槽位/队列引用必须存在且类型对 */
    var byId = {};
    for (i = 0; i < c.items.length; i++) {
      if (byId[c.items[i].id]) bad.push(p.name + ': 物品 id 重复');
      byId[c.items[i].id] = c.items[i];
    }
    var slots = ['weapon', 'offhand', 'body', 'head', 'talisman'];
    for (i = 0; i < slots.length; i++) {
      var ref = p.equip[slots[i]];
      if (ref == null) continue;
      var it = byId[ref];
      if (!it) { bad.push(p.name + ': 槽位引用了不存在的物品 ' + slots[i]); continue; }
      if (it.kind !== slots[i]) bad.push(p.name + ': 槽位错配 ' + slots[i] + '<-' + it.kind);
    }
    /* ⚠ gear:false 是官方支持用例 (queue=[] / equip 全 null) ⇒ 下限只在「有法宝槽」时校验;
       原实现把它判成错误, 于是 selfTest 的边界用例恰好绕开了 checkCandidate (审查 D5) */
    if (p.queue.length > CFG.TALISMAN_MAX) bad.push(p.name + ': 法宝队列 ' + p.queue.length);
    if (p.equip.talisman && p.queue.length < CFG.TALISMAN_MIN) {
      bad.push(p.name + ': 有法宝槽但队列 ' + p.queue.length + ' (< ' + CFG.TALISMAN_MIN + ')');
    }
    for (i = 0; i < p.queue.length; i++) {
      if (!byId[p.queue[i]]) bad.push(p.name + ': 队列引用了不存在的物品');
    }
    if (!p.equip.talisman && p.queue.length) bad.push(p.name + ': 法宝槽空但队列有件');
    if (p.queue.length && p.equip.talisman !== p.queue[0]) bad.push(p.name + ': 法宝槽与队列首位不一致');

    if (!p.activity || p.activity.kind !== 'idle') bad.push(p.name + ': activity 应为 idle');
    return bad;
  }

  function selfTest(n) {
    n = n || 1000;
    var errors = [], i, j;
    for (i = 0; i < n; i++) {
      var cand;
      try {
        cand = genCandidate({ worldSeed: 'selftest', settleId: 's' + (i % 17), round: i % 5, slot: i % 9 });
      } catch (e) {
        errors.push('抛异常 @' + i + ': ' + (e && e.message));
        if (errors.length > 20) break;
        continue;
      }
      var bad = checkCandidate(cand);
      for (j = 0; j < bad.length; j++) errors.push(bad[j]);
      if (errors.length > 40) break;
    }
    /* 确定性: 同参数两次必须逐字节一致 */
    var a = JSON.stringify(genCandidate({ worldSeed: 'det', settleId: 's7', round: 2, slot: 1 }));
    var b = JSON.stringify(genCandidate({ worldSeed: 'det', settleId: 's7', round: 2, slot: 1 }));
    if (a !== b) errors.push('确定性失败: 同参数两次结果不同');
    /* 边界: 无装备 / 指定五行 / 高 slot 都不能抛 */
    try {
      var g0 = genCandidate({ worldSeed: 'x', slot: 0, gear: false });
      if (g0.pawn.queue.length !== 0 || g0.items.length !== 0) errors.push('gear:false 仍产出了装备');
      genCandidate({ worldSeed: 'x', slot: 1, element: 3 });
      genCandidate({ worldSeed: 'x', slot: 99, element: 0 });
    } catch (e2) { errors.push('边界用例抛异常: ' + (e2 && e2.message)); }

    return { ok: errors.length === 0, errors: errors, n: n, version: VERSION };
  }

  function stats(n) {
    n = n || 20000;
    var kc = [0, 0, 0, 0, 0, 0], tb = [0, 0, 0, 0, 0, 0], tsum = 0, tmin = 999, tmax = 0, bad = 0, i;
    var highP = 0, epicP = 0, bonusSum = 0;
    for (i = 0; i < n; i++) {
      var c;
      try { c = genCandidate({ worldSeed: 'stats', settleId: 's' + (i % 31), round: i % 7, slot: i }); }
      catch (e) { bad++; continue; }
      var k = c.meta.rootCount;
      kc[k] = (kc[k] || 0) + 1;
      var t = c.pawn.talents.total;
      tsum += t; if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      tb[t < 105 ? 0 : t < 120 ? 1 : t < 135 ? 2 : t < 150 ? 3 : t < 165 ? 4 : 5]++;
      /* 高档占比: 看"人均神体"有没有压住 */
      var ts2 = c.pawn.traits, hasH = false, hasE = false, q2, tf;
      for (q2 = 0; q2 < ts2.length; q2++) {
        tf = TRAIT_INDEX[ts2[q2].n];
        if (!tf) continue;
        if (tf.tier === 'rare' || tf.tier === 'epic') hasH = true;
        if (tf.tier === 'epic') hasE = true;
        bonusSum += tf.bonus;
      }
      if (hasH) highP++;
      if (hasE) epicP++;
      if (checkCandidate(c).length) bad++;
    }
    var out = { n: n, bad: bad, talentAvg: Math.round(tsum / Math.max(1, n - bad)), talentMin: tmin, talentMax: tmax,
                rootK: {}, talentBands: [],
                highPct: Math.round(highP / Math.max(1, n) * 10000) / 100,
                epicPct: Math.round(epicP / Math.max(1, n) * 10000) / 100,
                traitBonusAvg: Math.round(bonusSum / Math.max(1, n) * 100) / 100 };
    for (i = 1; i <= 5; i++) out.rootK[i] = { n: kc[i], pct: Math.round(kc[i] / Math.max(1, n) * 10000) / 100 };
    /* 天赋分档 (看偏斜用): 90-104 / 105-119 / 120-134 / 135-149 / 150-164 / 165-180 */
    for (i = 0; i < 6; i++) out.talentBands.push(Math.round(tb[i] / Math.max(1, n) * 1000) / 10);
    return out;
  }

  /* ============================================================
   * 出口
   * ============================================================ */
  var api = {
    VERSION: VERSION,
    CFG: CFG,
    ELEMENTS: ELEMENTS,
    DAO: DAO,
    TRAITS: TRAITS,
    TRAIT_INDEX: TRAIT_INDEX,
    BACKGROUNDS: BACKGROUNDS,
    STARTER: STARTER,
    hash32: hash32,
    seedOf: seedOf,
    mulberry32: mulberry32,
    genRoot: genRoot,
    genTalents: genTalents,
    genTraits: genTraits,
    traitWeight: traitWeight,
    genCandidate: genCandidate,
    genPool: genPool,
    checkCandidate: checkCandidate,
    selfTest: selfTest,
    stats: stats
  };
  global.Chargen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 兜底: CJS 环境
})(typeof window !== 'undefined' ? window : this);
