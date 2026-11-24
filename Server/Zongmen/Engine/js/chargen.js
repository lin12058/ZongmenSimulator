/* ============================================================
 * chargen.js — 可招募弟子生成器 (纯函数, 无依赖, classic script)
 * ------------------------------------------------------------
 * 方案: docs/游戏设计/角色生成器-实施方案.md
 * 口径: 角色系统设定表.md + 六道属性体系.md + 用户 2026-11-25 四条定案
 *   1. 灵根 五项合计恒 100, 每系 >= 20, 系数量 1/2/3/4/5 = 1%/2.5%/20%/30%/46.5%
 *   2. 天赋 90~180 **均匀**, 单道 <= 60, 每道 6 项单项 <= 60
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

  var VERSION = 1;

  /* ============================================================
   * 常量 —— 判据直接读这里, UI 不许再抄一份
   * ============================================================ */
  var CFG = {
    /* 灵根 */
    ROOT_TOTAL: 100,          // 五项合计恒 100
    ROOT_MIN_PER: 20,         // 有灵根的系, 最低 20
    ROOT_MAIN_WEIGHT: 3,      // 主系权重 (其余各 1)
    /* 系数量分布 (1/2/3/4/5) —— 累计阈值 */
    ROOT_K_CUT: [0.010, 0.035, 0.235, 0.535],   // <0.010→1系, <0.035→2系, <0.235→3系, <0.535→4系, 其余→5系
    ROOT_K_PCT: ['1%', '2.5%', '20%', '30%', '46.5%'],

    /* 天赋 */
    TALENT_MIN: 90,
    TALENT_MAX: 180,
    DAO_CAP: 60,              // 单道上限
    TALENT_CAP: 60,           // 单项上限
    DAO_BASE_MIN: 2,          // 每道底 (避免一排 0)
    DAO_BASE_MAX: 6,

    /* 特质 */
    TRAIT_MIN: 1,
    TRAIT_MAX: 3,
    TRAIT_POS_RATE: 0.55,

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

  /* 特质 11 对 (正反互斥; 效果由属性层实现, 本文件只发数据) */
  var TRAIT_PAIRS = [
    { pair: 'diligence', pos: { n: '勤勉', v: '劳作效率 +35%' }, neg: { n: '懒散', v: '劳作效率 -30%' } },
    { pair: 'grit',      pos: { n: '坚毅', v: '受伤恢复 +50%' }, neg: { n: '怯懦', v: '受伤恢复 -40%' } },
    { pair: 'insight',   pos: { n: '慧根', v: '修炼速度 +25%' }, neg: { n: '愚钝', v: '修炼速度 -25%' } },
    { pair: 'social',    pos: { n: '亲和', v: '同门心境 +8' },   neg: { n: '孤僻', v: '同门心境 -8' } },
    { pair: 'nocturne',  pos: { n: '夜行', v: '夜间效率 +20%' }, neg: { n: '嗜睡', v: '夜间效率 -25%' } },
    { pair: 'temper',    pos: { n: '沉静', v: '突破成功率 +10%' }, neg: { n: '急躁', v: '突破成功率 -10%' } },
    { pair: 'appetite',  pos: { n: '辟谷', v: '食量 -50%' },     neg: { n: '大胃', v: '食量 +50%' } },
    { pair: 'hands',     pos: { n: '巧手', v: '炼器成器 +20%' }, neg: { n: '笨拙', v: '炼器成器 -20%' } },
    { pair: 'nerve',     pos: { n: '胆识', v: '近战伤害 +10%' }, neg: { n: '畏战', v: '近战伤害 -15%' } },
    { pair: 'focus',     pos: { n: '专注', v: '工序失误 -30%' }, neg: { n: '走神', v: '工序失误 +30%' } },
    { pair: 'blood',     pos: { n: '血旺', v: '气血上限 +15%' }, neg: { n: '亏血', v: '气血上限 -15%' } }
  ];
  /* 名字 → pair/正负 (自检与去重要用) */
  var TRAIT_INDEX = (function () {
    var m = {}, i, p;
    for (i = 0; i < TRAIT_PAIRS.length; i++) {
      p = TRAIT_PAIRS[i];
      m[p.pos.n] = { pair: p.pair, kind: 'pos', v: p.pos.v };
      m[p.neg.n] = { pair: p.pair, kind: 'neg', v: p.neg.v };
    }
    return m;
  })();

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
  function rint(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
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
  /** 把 total 按 weights 拆成整数, 每份 >= 0, 和恒 = total */
  function splitWeighted(rng, total, weights) {
    var i, raw = [], s = 0;
    for (i = 0; i < weights.length; i++) { var r = rng() * weights[i]; raw.push(r); s += r; }
    var out = [], used = 0;
    for (i = 0; i < weights.length; i++) {
      var v = s > 0 ? Math.floor(total * raw[i] / s) : 0;
      out.push(v); used += v;
    }
    var left = total - used;
    /* 余数按小数部分从大到小补 (确定性; 并列按索引) */
    var order = [], frac = [];
    for (i = 0; i < weights.length; i++) {
      frac.push(s > 0 ? (total * raw[i] / s) - Math.floor(total * raw[i] / s) : 0);
      order.push(i);
    }
    order.sort(function (a, b) { return (frac[b] - frac[a]) || (a - b); });
    for (i = 0; left > 0; i++) { out[order[i % order.length]]++; left--; }
    return out;
  }
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
   * k 由分布抽; k 个系先各 20, 余数按「主系 3 : 其余 1」切;
   * main = 值最大的下标 (并列随机)。
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

    var weights = [];
    for (i = 0; i < present.length; i++) weights.push(i === 0 ? CFG.ROOT_MAIN_WEIGHT : 1);

    var surplus = CFG.ROOT_TOTAL - CFG.ROOT_MIN_PER * k;
    var share = (surplus > 0 && present.length) ? splitWeighted(rng, surplus, weights) : null;

    var v = [0, 0, 0, 0, 0], mainVal = -1, ties = [];
    for (i = 0; i < present.length; i++) v[present[i]] = CFG.ROOT_MIN_PER + (share ? share[i] : 0);
    for (i = 0; i < 5; i++) {
      if (v[i] > mainVal) { mainVal = v[i]; ties = [i]; }
      else if (v[i] === mainVal) ties.push(i);
    }
    var main = ties.length > 1 ? ties[Math.floor(rng() * ties.length)] : ties[0];

    return {
      order: ELEMENTS.map(function (e) { return e.k; }),
      v: v,
      main: main,
      count: present.length
    };
  }

  /* ============================================================
   * 天赋 (90~180 均匀, 单道 <=60, 每道 6 项 <=60)
   * ============================================================ */
  function genTalents(rng, bias) {
    var total = rint(rng, CFG.TALENT_MIN, CFG.TALENT_MAX);
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
   * 特质 (1~3 条, 正反互斥, >=2 条时强制一正一负)
   * ============================================================ */
  function genTraits(rng) {
    var n = rint(rng, CFG.TRAIT_MIN, CFG.TRAIT_MAX);
    var pairs = shuffle(rng, TRAIT_PAIRS).slice(0, n);
    var out = [], i;
    for (i = 0; i < pairs.length; i++) {
      out.push(rng() < CFG.TRAIT_POS_RATE ? { p: pairs[i], t: pairs[i].pos }
                                          : { p: pairs[i], t: pairs[i].neg });
    }
    if (out.length >= 2) {
      var hasPos = false, hasNeg = false;
      /* ⚠ 不能读 out[i].t.kind: TRAIT_PAIRS 的 pos/neg 只有 {n,v}, kind 在 TRAIT_INDEX 里。
         读错 ⇒ hasPos 恒 false ⇒ 第一条特质恒被翻成负面 (55% 正率被打穿) */
      for (i = 0; i < out.length; i++) {
        if (TRAIT_INDEX[out[i].t.n].kind === 'pos') hasPos = true; else hasNeg = true;
      }
      if (!hasPos || !hasNeg) {
        var first = out[0];
        out[0] = { p: first.p, t: (first.t === first.p.pos) ? first.p.neg : first.p.pos };
      }
    }
    var res = [];
    for (i = 0; i < out.length; i++) res.push({ n: out[i].t.n });
    return res;
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
    mk('body', STARTER.body);
    mk('head', STARTER.head);
    var t = mk('talisman', STARTER.talisman);
    var equip = { weapon: w.id, offhand: null, body: gear.body.id, head: gear.head.id, talisman: t.id };
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
    if (!bg) bg = pickBackground(rng);

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
  function genPool(opts) {
    opts = opts || {};
    var st = opts.settle || {};
    var type = st.type || 'village';
    var range = CFG.POOL[type] || CFG.POOL.village;
    var poolRng = mulberry32(seedOf([opts.worldSeed == null ? 'w0' : opts.worldSeed,
                                     st.id == null ? 's0' : st.id,
                                     opts.round == null ? 0 : opts.round, 'pool']));

    var size = opts.size != null ? Math.round(opts.size) : rint(poolRng, range[0], range[1]);
    if (st.pop) size = Math.min(size, Math.max(1, Math.round(st.pop / 50)));
    size = clamp(size, 0, CFG.POOL_MAX);

    /* 一村多同姓: 70% 整池共用一个姓, 否则每人五五开 */
    var villageSurname = pick(poolRng, SURNAMES);
    var shareSurname = poolRng() < 0.7;

    var used = opts.usedNames || {};
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
      seedKey: [opts.worldSeed == null ? 'w0' : opts.worldSeed,
                st.id == null ? 's0' : st.id,
                opts.round == null ? 0 : opts.round, 'pool'].join('|'),
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
    if (rs !== CFG.ROOT_TOTAL) bad.push(p.name + ': 灵根合计 ' + rs);
    if (p.root.v.length !== 5) bad.push(p.name + ': 灵根不是 5 项');
    var nz = 0, minNz = 999;
    for (i = 0; i < 5; i++) {
      if (p.root.v[i] < 0) bad.push(p.name + ': 灵根负值');
      if (p.root.v[i] > 0) { nz++; if (p.root.v[i] < minNz) minNz = p.root.v[i]; }
    }
    if (nz < 1 || nz > 5) bad.push(p.name + ': 灵根系数量 ' + nz);
    if (nz && minNz < CFG.ROOT_MIN_PER) bad.push(p.name + ': 有灵根的系低于 20');
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
    var seen = {};
    for (i = 0; i < p.traits.length; i++) {
      var def = TRAIT_INDEX[p.traits[i].n];
      if (!def) { bad.push(p.name + ': 特质不在表内 ' + p.traits[i].n); continue; }
      if (seen[def.pair]) bad.push(p.name + ': 特质正反同现');
      seen[def.pair] = 1;
    }

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
    if (p.queue.length < CFG.TALISMAN_MIN || p.queue.length > CFG.TALISMAN_MAX) bad.push(p.name + ': 法宝队列 ' + p.queue.length);
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
    var kc = [0, 0, 0, 0, 0, 0], tsum = 0, tmin = 999, tmax = 0, bad = 0, i;
    for (i = 0; i < n; i++) {
      var c;
      try { c = genCandidate({ worldSeed: 'stats', settleId: 's' + (i % 31), round: i % 7, slot: i }); }
      catch (e) { bad++; continue; }
      var k = c.meta.rootCount;
      kc[k] = (kc[k] || 0) + 1;
      var t = c.pawn.talents.total;
      tsum += t; if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      if (checkCandidate(c).length) bad++;
    }
    var out = { n: n, bad: bad, talentAvg: Math.round(tsum / Math.max(1, n - bad)), talentMin: tmin, talentMax: tmax, rootK: {} };
    for (i = 1; i <= 5; i++) out.rootK[i] = { n: kc[i], pct: Math.round(kc[i] / Math.max(1, n) * 10000) / 100 };
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
    TRAIT_PAIRS: TRAIT_PAIRS,
    TRAIT_INDEX: TRAIT_INDEX,
    BACKGROUNDS: BACKGROUNDS,
    STARTER: STARTER,
    hash32: hash32,
    seedOf: seedOf,
    mulberry32: mulberry32,
    genRoot: genRoot,
    genTalents: genTalents,
    genTraits: genTraits,
    genCandidate: genCandidate,
    genPool: genPool,
    checkCandidate: checkCandidate,
    selfTest: selfTest,
    stats: stats
  };
  global.Chargen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 兜底: CJS 环境
})(typeof window !== 'undefined' ? window : this);
