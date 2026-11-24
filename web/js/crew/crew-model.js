/* ============================================================
 * crew-model.js — 小队 / 弟子 数据模型 (纯逻辑, 不碰 DOM)
 * ------------------------------------------------------------
 * 口径来源: docs/游戏设计/角色系统设定表.md (v6)
 *   一个弟子 = 灵根 + 天赋 + 特质 + 装备 + 神通
 *     · 灵根: 金木水火土 吸收比例, **合计恒 100**
 *     · 天赋: 出生 90~180 点, 六道(体/气/神/器/丹/阵) × 每道 6 项, 单项 ≤60
 *     · 特质: 1~3 条, 只做数值加减, 正反互斥
 *     · 装备: 穿戴 5 槽 + 法宝队列 1~4
 *     · 神通: 功法书学, 携 3 格 (凝神 +1), 一至七阶, 耗灵 1~6
 *
 * 行为层 (2026-11-24 二次定案: 要 RPG 的"人物框 + 装备栏 + 背包", 参考战场兄弟):
 *   · 属性不单独存 —— 全部由 天赋 + 装备 + 特质 现算 (attrs), 换装备立刻变
 *   · 每个弟子有自己的 4×4 背包; 小队另有一格共用仓库 (stash)
 *   · 物品有品阶 (一至六品) / 重量 / 词条; 丹药可叠放
 *
 * 公开接口 (window.CrewModel):
 *   CFG ELEMENTS DAO JOBS TRAITS QUALITY SLOT_NAMES
 *   demoSquad(n)
 *   attrs(pawn) attrRows(pawn) weightOf(pawn) overload(pawn)
 *   slotOf(kind) equip(pawn, bagIdx) unequip(pawn, slotKey)
 *   priorityOf / cyclePriority / jobById
 *   step(state, dtMs) probe(state)
 * ============================================================ */
(function (g) {
  'use strict';

  /* ---------- 数值约束 (与设定表一一对应) ---------- */
  var CFG = {
    ROOT_SUM: 100,
    TALENT_MIN: 90, TALENT_MAX: 180, TALENT_CAP: 60, DAO_CAP: 60,
    TRAIT_MIN: 1, TRAIT_MAX: 3,
    WEAR_SLOTS: 5,
    TALISMAN_MIN: 1, TALISMAN_MAX: 4,
    ART_MIN: 3, ART_MAX: 4, ART_MAX_RANK: 7, ART_MAX_COST: 6,
    /* 只有**全局背包**一种容器 (2026-11-24 用户: 没有"个人背包"这一说法):
       全队共用 6 列 × 8 行 = 48 格, 装备穿在身上, 卸下回到这里。 */
    STASH_COLS: 6, STASH_ROWS: 8,
    /* 修为: 由天赋总量定上限, 演示给一个 15%~95% 的进度 (没有真实升级链) */
    EXP_MIN_RATE: 0.15, EXP_MAX_RATE: 0.95
  };

  var ELEMENTS = [
    { k: 'metal', n: '金', c: '#a89463' },
    { k: 'wood',  n: '木', c: '#63805a' },
    { k: 'water', n: '水', c: '#4f7288' },
    { k: 'fire',  n: '火', c: '#a63a2c' },
    { k: 'earth', n: '土', c: '#8b7351' }
  ];

  var DAO = [
    { k: 'body', n: '体', d: '炼体', talents: ['铁骨', '蛮力', '坚韧', '疾行', '气血', '硬功'] },
    { k: 'qi',   n: '气', d: '吐纳', talents: ['纳灵', '周天', '绵息', '速引', '灵压', '御风'] },
    { k: 'mind', n: '神', d: '神魂', talents: ['凝神', '观微', '定心', '神识', '梦引', '慑魂'] },
    { k: 'gear', n: '器', d: '炼器', talents: ['控火', '辨材', '淬锋', '急就', '器灵', '重铸'] },
    { k: 'pill', n: '丹', d: '炼丹', talents: ['识药', '控炉', '保性', '提纯', '复方', '丹毒'] },
    { k: 'array', n: '阵', d: '阵法', talents: ['布阵', '阵眼', '连纹', '速设', '掩息', '破阵'] }
  ];

  var TRAIT_PAIRS = [
    { pair: 'diligence', pos: { n: '勤勉', v: '劳作效率 +35%' }, neg: { n: '懒散', v: '劳作效率 -30%' } },
    { pair: 'grit',      pos: { n: '坚毅', v: '受伤恢复 +50%' }, neg: { n: '怯懦',  v: '受伤恢复 -40%' } },
    { pair: 'insight',   pos: { n: '慧根', v: '修炼速度 +25%' }, neg: { n: '愚钝',  v: '修炼速度 -25%' } },
    { pair: 'social',    pos: { n: '亲和', v: '同门心境 +8' },   neg: { n: '孤僻',  v: '同门心境 -8' } },
    { pair: 'nocturne',  pos: { n: '夜行', v: '夜间效率 +20%' }, neg: { n: '嗜睡',  v: '夜间效率 -25%' } },
    { pair: 'temper',    pos: { n: '沉静', v: '突破成功率 +10%' }, neg: { n: '急躁', v: '突破成功率 -10%' } },
    { pair: 'appetite',  pos: { n: '辟谷', v: '食量 -50%' },     neg: { n: '大胃',  v: '食量 +50%' } },
    { pair: 'hands',     pos: { n: '巧手', v: '炼器成器 +20%' }, neg: { n: '笨拙',  v: '炼器成器 -20%' } },
    { pair: 'nerve',     pos: { n: '胆识', v: '近战伤害 +10%' }, neg: { n: '畏战',  v: '近战伤害 -15%' } },
    { pair: 'focus',     pos: { n: '专注', v: '工序失误 -30%' }, neg: { n: '走神',  v: '工序失误 +30%' } },
    { pair: 'blood',     pos: { n: '血旺', v: '气血上限 +15%' }, neg: { n: '亏血',  v: '气血上限 -15%' } }
  ];
  var TRAITS = (function () {
    var out = {};
    for (var i = 0; i < TRAIT_PAIRS.length; i++) {
      var p = TRAIT_PAIRS[i];
      out[p.pos.n] = { n: p.pos.n, v: p.pos.v, kind: 'pos', pair: p.pair };
      out[p.neg.n] = { n: p.neg.n, v: p.neg.v, kind: 'neg', pair: p.pair };
    }
    return out;
  })();

  var JOBS = [
    { id: 'gather', ch: '采', n: '采集', target: '灵草', dao: 'qi' },
    { id: 'wood',   ch: '伐', n: '伐木', target: '灵木', dao: 'body' },
    { id: 'mine',   ch: '矿', n: '采矿', target: '灵石', dao: 'body' },
    { id: 'farm',   ch: '耕', n: '耕田', target: '灵谷', dao: 'qi' },
    { id: 'alchemy',ch: '丹', n: '炼丹', target: '丹炉', dao: 'pill' },
    { id: 'forge',  ch: '器', n: '炼器', target: '器炉', dao: 'gear' },
    { id: 'array',  ch: '阵', n: '布阵', target: '阵盘', dao: 'array' },
    { id: 'patrol', ch: '巡', n: '巡山', target: '山门', dao: 'mind' },
    { id: 'guard',  ch: '守', n: '值守', target: '阵眼', dao: 'mind' },
    { id: 'study',  ch: '经', n: '研经', target: '藏经阁', dao: 'mind' }
  ];
  var JOB_INDEX = {};
  (function () { for (var i = 0; i < JOBS.length; i++) JOB_INDEX[JOBS[i].id] = JOBS[i]; })();

  var SURNAMES = ['沈', '陆', '顾', '谢', '裴', '苏', '宁', '温', '江', '柳', '岑', '褚'];
  var GIVEN = ['青筠', '玄策', '砚秋', '知白', '素心', '无咎', '砚雪', '照野', '拾遗', '长庚',
               '怀瑾', '听澜', '慎之', '寒山', '疏影', '问津', '承光', '漱石'];
  var ROLES = ['剑修', '丹修', '器修', '阵修', '体修', '符修', '杂役'];
  var REALM = ['炼气', '筑基', '金丹', '元婴'];

  var ART_BOOK = [
    { n: '引气诀', rank: 1, cost: 1 }, { n: '松风剑式', rank: 1, cost: 2 },
    { n: '流火符', rank: 2, cost: 2 }, { n: '寒潭印', rank: 2, cost: 3 },
    { n: '三才阵图', rank: 3, cost: 3 }, { n: '洗髓经', rank: 3, cost: 4 },
    { n: '雷池引', rank: 4, cost: 4 }, { n: '万木回春', rank: 4, cost: 5 },
    { n: '太虚剑意', rank: 5, cost: 5 }, { n: '九幽锁魂', rank: 6, cost: 6 },
    { n: '混元一气', rank: 7, cost: 6 }
  ];

  var TASK_NAMES = {
    gather: ['采三叶青', '采赤灵芝', '采露水藤'],
    wood: ['伐青冈木', '伐老松', '伐铁心木'],
    mine: ['凿灵石矿', '取玄铁', '挖寒玉'],
    farm: ['锄灵谷田', '收灵麦', '引水灌田'],
    alchemy: ['炼聚气丹', '炼回元丹', '焙药'],
    forge: ['锻剑胚', '修护甲', '淬锋'],
    array: ['补阵纹', '立引灵阵', '校准阵眼'],
    patrol: ['巡后山', '巡药圃', '查界碑'],
    guard: ['守山门', '守丹房', '值夜'],
    study: ['抄经', '参悟残卷', '听讲']
  };

  /* ============================================================
   * 物品: 品阶 / 重量 / 词条
   * ------------------------------------------------------------
   * kind 决定能装到哪个槽: weapon/offhand/body/head/talisman
   * 其余 (pill/material/book) 只能待在背包或仓库里
   * ============================================================ */
  var QUALITY = ['一', '二', '三', '四', '五', '六'];
  var SLOT_NAMES = { weapon: '武器', offhand: '副手', body: '身体', head: '头部', talisman: '法宝' };

  /* atk 攻 / def 防 / acc 命中 / mp 灵力 / hp 气血 / w 重量 */
  var ITEM_DEFS = [
    /* ---- 武器 ---- */
    { n: '青锋剑', kind: 'weapon', ch: '剑', q: 2, w: 7, atk: 9, acc: 4 },
    { n: '斩木刀', kind: 'weapon', ch: '刀', q: 1, w: 9, atk: 7, acc: 0 },
    { n: '铁骨杖', kind: 'weapon', ch: '杖', q: 2, w: 11, atk: 11, acc: -2 },
    { n: '游丝鞭', kind: 'weapon', ch: '鞭', q: 3, w: 5, atk: 10, acc: 3 },
    { n: '断岳枪', kind: 'weapon', ch: '枪', q: 3, w: 12, atk: 14, acc: -3 },
    { n: '桃木剑', kind: 'weapon', ch: '桃', q: 1, w: 4, atk: 4, acc: 6 },
    { n: '寒月短匕', kind: 'weapon', ch: '匕', q: 3, w: 3, atk: 8, acc: 8 },
    /* ---- 副手 ---- */
    { n: '木盾', kind: 'offhand', ch: '盾', q: 1, w: 6, def: 6 },
    { n: '铁卫盾', kind: 'offhand', ch: '卫', q: 3, w: 10, def: 12 },
    { n: '灵符夹', kind: 'offhand', ch: '符', q: 2, w: 2, def: 2, mp: 8 },
    { n: '飞梭', kind: 'offhand', ch: '梭', q: 2, w: 3, atk: 3, acc: 2 },
    { n: '短匕', kind: 'offhand', ch: '匕', q: 1, w: 2, atk: 4 },
    /* ---- 身体 ---- */
    { n: '粗布道袍', kind: 'body', ch: '袍', q: 1, w: 5, def: 4 },
    { n: '云纹内甲', kind: 'body', ch: '甲', q: 3, w: 15, def: 14, hp: 10 },
    { n: '藤甲', kind: 'body', ch: '藤', q: 2, w: 10, def: 9 },
    { n: '水合纱衣', kind: 'body', ch: '纱', q: 3, w: 4, def: 6, mp: 12 },
    { n: '玄铁软甲', kind: 'body', ch: '玄', q: 4, w: 18, def: 18, hp: 16 },
    /* ---- 头部 ---- */
    { n: '束发巾', kind: 'head', ch: '巾', q: 1, w: 1, def: 2 },
    { n: '竹笠', kind: 'head', ch: '笠', q: 1, w: 2, def: 3 },
    { n: '铁冠', kind: 'head', ch: '冠', q: 2, w: 4, def: 6 },
    { n: '素银簪', kind: 'head', ch: '簪', q: 2, w: 1, mp: 6 },
    /* ---- 法宝 ---- */
    { n: '铜铃', kind: 'talisman', ch: '铃', q: 1, w: 1, mp: 6 },
    { n: '小乾坤袋', kind: 'talisman', ch: '袋', q: 2, w: 1, mp: 4 },
    { n: '避尘珠', kind: 'talisman', ch: '珠', q: 3, w: 1, def: 4, mp: 8 },
    { n: '锁灵环', kind: 'talisman', ch: '环', q: 3, w: 2, atk: 4, mp: 10 },
    { n: '照影镜', kind: 'talisman', ch: '镜', q: 4, w: 2, acc: 6, mp: 14 },
    { n: '三寸玉印', kind: 'talisman', ch: '印', q: 4, w: 3, atk: 6, def: 6 },
    /* ---- 丹药 (可叠) ---- */
    { n: '聚气丹', kind: 'pill', ch: '聚', q: 1, w: 0.2, heal: 20, mp: 24, qtyMax: 9 },
    { n: '回元丹', kind: 'pill', ch: '回', q: 2, w: 0.3, heal: 60, qtyMax: 9 },
    { n: '洗髓丹', kind: 'pill', ch: '洗', q: 4, w: 0.4, heal: 120, qtyMax: 5 },
    /* ---- 材料 ---- */
    { n: '三叶青', kind: 'material', ch: '草', q: 1, w: 0.2, qtyMax: 20 },
    { n: '赤灵芝', kind: 'material', ch: '芝', q: 2, w: 0.3, qtyMax: 20 },
    { n: '灵石', kind: 'material', ch: '石', q: 2, w: 0.5, qtyMax: 20 },
    { n: '玄铁', kind: 'material', ch: '铁', q: 3, w: 1.5, qtyMax: 20 },
    { n: '青冈木', kind: 'material', ch: '木', q: 1, w: 0.8, qtyMax: 20 },
    /* ---- 功法书 ---- */
    { n: '《松风剑式》', kind: 'book', ch: '书', q: 2, w: 0.6 },
    { n: '《三才阵图》', kind: 'book', ch: '阵', q: 3, w: 0.6 },
    { n: '《洗髓经》', kind: 'book', ch: '经', q: 3, w: 0.6 }
  ];

  /* ---------- 伪随机 (演示数据可复现) ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function rint(rng, lo, hi) { return lo + Math.floor(rng() * (hi - lo + 1)); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ---------- 物品实例 ---------- */
  var itemSeq = 0;
  function makeItem(def, qty) {
    var it = {
      id: 'i' + (++itemSeq),
      n: def.n, kind: def.kind, ch: def.ch, q: def.q || 1,
      w: def.w || 0, atk: def.atk || 0, def: def.def || 0, acc: def.acc || 0,
      mp: def.mp || 0, hp: def.hp || 0, heal: def.heal || 0,
      qty: qty || 1, qtyMax: def.qtyMax || 1
    };
    return it;
  }
  function itemsOfKind(kind) {
    var out = [];
    for (var i = 0; i < ITEM_DEFS.length; i++) if (ITEM_DEFS[i].kind === kind) out.push(ITEM_DEFS[i]);
    return out;
  }
  function slotOf(kind) {
    return (kind === 'weapon' || kind === 'offhand' || kind === 'body' || kind === 'head' || kind === 'talisman') ? kind : null;
  }

  /* ============================================================
   * 灵根 / 天赋 / 特质 生成 (与上一版同口径)
   * ============================================================ */
  function genRoot(rng) {
    var main = rint(rng, 0, 4), sub = (main + rint(rng, 1, 4)) % 5;
    var w = [];
    for (var i = 0; i < 5; i++) {
      if (i === main) w.push(40 + rng() * 40);
      else if (i === sub) w.push(10 + rng() * 25);
      else w.push(rng() * 10);
    }
    var sum = 0, k;
    for (k = 0; k < 5; k++) sum += w[k];
    var out = [], acc = 0;
    for (k = 0; k < 5; k++) { var v = Math.round(w[k] / sum * 100); out.push(v); acc += v; }
    out[main] += CFG.ROOT_SUM - acc;
    var diff = CFG.ROOT_SUM - out.reduce(function (a, b) { return a + b; }, 0);
    if (diff !== 0) {
      var mi = 0;
      for (k = 1; k < 5; k++) if (out[k] > out[mi]) mi = k;
      out[mi] += diff;
    }
    return { order: ELEMENTS.map(function (e) { return e.k; }), v: out, main: main };
  }

  /* 角色 → 主/次两道 (决定天赋往哪偏); 面板上六道才不会出现一排 0 */
  var ROLE_DAO = {
    '剑修': ['body', 'qi'], '丹修': ['pill', 'qi'], '器修': ['gear', 'body'],
    '阵修': ['array', 'mind'], '体修': ['body', 'gear'], '符修': ['array', 'qi'],
    '杂役': ['qi', 'body']
  };

  /* 天赋: 总量 90~180 落到六道, **每道 ≤ 60** (设定表「单个上限最大为 60」按单道读, 180 恰好 3×60)。
     权重 主 3 / 次 1.8 / 其余 0.5, 且每道先给 2~6 点底 —— 六道都是有效数字, 不会一半是 0。 */
  function genTalents(rng, role) {
    var total = rint(rng, CFG.TALENT_MIN, CFG.TALENT_MAX);
    var bias = ROLE_DAO[role] || ['body', 'qi'];
    var d, sums = [], weights = [], sumAll = 0, wsum = 0;
    for (d = 0; d < DAO.length; d++) {
      var base = Math.min(CFG.DAO_CAP, rint(rng, 2, 6));
      sums.push(base);
      sumAll += base;
      var w = (DAO[d].k === bias[0]) ? 3 : (DAO[d].k === bias[1] ? 1.8 : 0.5);
      weights.push(w);
      wsum += w;
    }
    var left = total - sumAll, guard = 0;
    while (left > 0 && guard++ < 6000) {
      var x = rng() * wsum, acc = 0, di = 0;
      for (d = 0; d < weights.length; d++) { acc += weights[d]; if (x <= acc) { di = d; break; } }
      var room = CFG.DAO_CAP - sums[di];
      if (room <= 0) continue;                        // 这道满了, 重新抽
      var add = Math.min(room, left, rint(rng, 2, 9));
      sums[di] += add;
      left -= add;
    }
    /* 道合计 → 六个天赋 (每格 ≤ TALENT_CAP) */
    var byDao = {};
    for (d = 0; d < DAO.length; d++) {
      var arr = [0, 0, 0, 0, 0, 0], rest = sums[d], g2 = 0;
      while (rest > 0 && g2++ < 900) {
        var ti = rint(rng, 0, 5);
        var room2 = CFG.TALENT_CAP - arr[ti];
        if (room2 <= 0) continue;
        var a2 = Math.min(room2, rest, rint(rng, 1, 12));
        arr[ti] += a2;
        rest -= a2;
      }
      byDao[DAO[d].k] = arr;
    }
    return { v: byDao, total: total };
  }

  function genTraits(rng) {
    var n = rint(rng, CFG.TRAIT_MIN, CFG.TRAIT_MAX);
    var pairs = shuffle(rng, TRAIT_PAIRS).slice(0, n);
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      out.push(TRAITS[(rng() < 0.55 ? p.pos : p.neg).n]);
    }
    if (out.length >= 2) {
      var hasPos = out.some(function (x) { return x.kind === 'pos'; });
      var hasNeg = out.some(function (x) { return x.kind === 'neg'; });
      if (!hasPos || !hasNeg) {
        var p2 = shuffle(rng, TRAIT_PAIRS)[0];
        if (!out.some(function (x) { return x.pair === p2.pair; })) out[0] = hasPos ? p2.neg : p2.pos;
      }
    }
    return out;
  }

  function genArts(rng) {
    var n = rng() < 0.45 ? CFG.ART_MAX : CFG.ART_MIN;
    var pool = shuffle(rng, ART_BOOK).slice(0, n).sort(function (a, b) { return a.rank - b.rank; });
    return { slots: pool, cap: n, from: n > CFG.ART_MIN ? '凝神 1' : '本命三格' };
  }

  /* ============================================================
   * 属性: 全部现算 (天赋 → 底子, 装备 → 加成, 特质 → 修正)
   * ------------------------------------------------------------
   * 不做成长曲线: 演示阶段只保证"换一件甲, 防御立刻变"这条因果可见。
   * ============================================================ */
  function sumDao(pawn, k) {
    var a = pawn.talents.v[k] || [];
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s;
  }
  function hasTrait(pawn, name) {
    for (var i = 0; i < pawn.traits.length; i++) if (pawn.traits[i].n === name) return true;
    return false;
  }
  function gearOf(pawn) {
    var out = [];
    var keys = ['weapon', 'offhand', 'body', 'head', 'talisman'];
    for (var i = 0; i < keys.length; i++) if (pawn.gear[keys[i]]) out.push(pawn.gear[keys[i]]);
    return out;
  }
  function attrs(pawn) {
    var B = sumDao(pawn, 'body'), Q = sumDao(pawn, 'qi'), S = sumDao(pawn, 'mind');
    var gs = gearOf(pawn), i;
    var a = {
      hp: 60 + Math.round(B * 1.1), mp: 24 + Math.round(Q * 0.7),
      atk: 8 + Math.round(B * 0.12), def: 4 + Math.round(B * 0.05),
      hit: 55 + Math.round(S * 0.22), dodge: 8 + Math.round(S * 0.10) + Math.round(B * 0.05)
    };
    for (i = 0; i < gs.length; i++) {
      a.hp += gs[i].hp; a.mp += gs[i].mp;
      a.atk += gs[i].atk; a.def += gs[i].def; a.hit += gs[i].acc;
    }
    if (hasTrait(pawn, '血旺')) a.hp = Math.round(a.hp * 1.15);
    if (hasTrait(pawn, '亏血')) a.hp = Math.round(a.hp * 0.85);
    if (hasTrait(pawn, '胆识')) a.atk = Math.round(a.atk * 1.10);
    if (hasTrait(pawn, '畏战')) a.atk = Math.round(a.atk * 0.85);
    if (hasTrait(pawn, '坚毅')) a.hp += 10;
    if (hasTrait(pawn, '怯懦')) a.hp -= 8;
    return a;
  }

  /* ============================================================
   * 当前气血 / 灵力 (战斗与劳作会变, 所以条按「当前/上限」的百分比画)
   * ------------------------------------------------------------
   * 上限不从 vit 读, 永远由 attrs() 现算 —— 换装抬高上限时当前值不动,
   * 换装压低上限时 clamp 到新上限 (不会出现 90/70 这种越界读数)。
   * ============================================================ */
  function vitalOf(pawn) {
    var a = attrs(pawn);
    if (!pawn.vit) pawn.vit = { hp: a.hp, mp: a.mp };
    var v = pawn.vit;
    if (!(v.hp >= 0)) v.hp = a.hp;
    if (!(v.mp >= 0)) v.mp = a.mp;
    v.hp = Math.max(0, Math.min(a.hp, Math.round(v.hp)));
    v.mp = Math.max(0, Math.min(a.mp, Math.round(v.mp)));
    return {
      hp: v.hp, maxHp: a.hp, mp: v.mp, maxMp: a.mp,
      hpPct: Math.round(v.hp / Math.max(1, a.hp) * 100),
      mpPct: Math.round(v.mp / Math.max(1, a.mp) * 100)
    };
  }
  /* 展示用: 六个属性 + 队伍里谁是该项最高 (由面板打标记, 这里只给顺序) */
  /* 六项属性 = 设定表的六道 (体/气/神/器/丹/阵), 取该道六个天赋之和 (0~60)。
     ⚠ 气血/攻击/防御/命中/闪避 是**派生战斗值** (attrs()), 不是「属性」——
        早先拿它们当六项属性挂在队伍页, 与设定表不符 (用户: 和我写的 6 个属性不一样)。 */
  var ATTR_META = [
    { k: 'body',  n: '体', d: '炼体' },
    { k: 'qi',    n: '气', d: '吐纳' },
    { k: 'mind',  n: '神', d: '神魂' },
    { k: 'gear',  n: '器', d: '炼器' },
    { k: 'pill',  n: '丹', d: '炼丹' },
    { k: 'array', n: '阵', d: '阵法' }
  ];
  function attrRows(pawn) {
    var out = [];
    for (var i = 0; i < ATTR_META.length; i++) {
      out.push({ k: ATTR_META[i].k, n: ATTR_META[i].n, d: ATTR_META[i].d, v: sumDao(pawn, ATTR_META[i].k) });
    }
    return out;
  }
  /* 负重: 个人只算**身上穿的** (没有个人背包); 全队负重 = 各人装备 + 全局背包 */
  function weightOf(pawn) {
    var w = 0, gs = gearOf(pawn);
    for (var i = 0; i < gs.length; i++) w += gs[i].w * (gs[i].qty || 1);
    return Math.round(w * 10) / 10;
  }
  function stashWeight(stash) {
    var w = 0;
    for (var i = 0; i < stash.length; i++) if (stash[i]) w += stash[i].w * (stash[i].qty || 1);
    return Math.round(w * 10) / 10;
  }
  /* 可传 state (全队) 或直接用 arrays of pawns (当前小队) —— 多小队下按队算负重 */
  function teamWeight(src) {
    var arr = Array.isArray(src) ? src : ((src && src.pawns) || []);
    var w = src && !Array.isArray(src) && src.stash ? stashWeight(src.stash) : 0;
    for (var i = 0; i < arr.length; i++) w += weightOf(arr[i]);
    return Math.round(w * 10) / 10;
  }
  /* 负重上限: 甲+兵常态 40~60 ⇒ 底数给 55, 再按体天赋加 (体修扛得更多) */
  function loadMax(pawn) { return 55 + Math.round(sumDao(pawn, 'body') * 0.9); }
  function overload(pawn) { return weightOf(pawn) > loadMax(pawn); }

  /* 修为: 上限由天赋总量推, 进度演示给一个固定比例 (同一 seed 稳定) */
  function expOf(pawn) {
    var max = 600 + Math.round(talentTotal(pawn) * 6);
    return { v: pawn.exp, max: max, pct: Math.round(pawn.exp / max * 100) };
  }

  /* ============================================================
   * 生成: 个人背包 / 小队仓库 / 装备
   * ============================================================ */
  function genGear(rng, role) {
    var gear = {
      weapon: makeItem(pick(rng, itemsOfKind('weapon'))),
      offhand: role === '体修' ? makeItem(ITEM_DEFS.filter(function (d) { return d.n === '木盾'; })[0])
                               : (rng() < 0.6 ? makeItem(pick(rng, itemsOfKind('offhand'))) : null),
      body: makeItem(pick(rng, itemsOfKind('body'))),
      head: makeItem(pick(rng, itemsOfKind('head'))),
      talisman: null
    };
    /* 法宝队列: 1~4 件 (默认 1, 分神 +1, 万器归宗 +2); 队列首位 = 当前佩戴 */
    var qn = rint(rng, CFG.TALISMAN_MIN, CFG.TALISMAN_MAX);
    var pool = shuffle(rng, itemsOfKind('talisman'));
    var queue = [];
    for (var i = 0; i < qn; i++) queue.push(makeItem(pool[i]));
    gear.talisman = queue[0];
    return { gear: gear, queue: queue, queueFrom: qn === 1 ? '本命一件' : (qn === 2 ? '分神 1' : '分神 1 · 万器归宗 2') };
  }

  /* 全局背包 (小队共用): 演示给 30~42 件, 48 格装得下。
     物品按"抽签"决定类别权重 —— 材料/丹药最多, 装备与功法少量, 便于筛选用。 */
  function genStash(rng) {
    var stash = new Array(CFG.STASH_COLS * CFG.STASH_ROWS).fill(null);
    var n = rint(rng, 30, 42);
    var slots = shuffle(rng, stash.map(function (_, i) { return i; })).slice(0, n);
    for (var i = 0; i < slots.length; i++) {
      var r = rng(), def;
      if (r < 0.28) def = pick(rng, itemsOfKind('material'));
      else if (r < 0.48) def = pick(rng, itemsOfKind('pill'));
      else if (r < 0.63) def = pick(rng, itemsOfKind('weapon'));
      else if (r < 0.74) def = pick(rng, itemsOfKind('body'));
      else if (r < 0.83) def = pick(rng, itemsOfKind('head'));
      else if (r < 0.93) def = pick(rng, itemsOfKind('talisman'));
      else def = pick(rng, itemsOfKind('book'));
      var qty = 1;
      if (def.qtyMax && def.qtyMax > 1) qty = rint(rng, 1, Math.min(def.qtyMax, 15));
      stash[slots[i]] = makeItem(def, qty);
    }
    return stash;
  }

  /* ---------- 优先级 ---------- */
  function cyclePriority(pawn, jobId) {
    var cur = pawn.prio[jobId] == null ? 4 : pawn.prio[jobId];
    var next = cur === 1 ? 2 : cur === 2 ? 3 : cur === 3 ? 4 : cur === 4 ? 0 : 1;
    pawn.prio[jobId] = next;
    return next;
  }
  function priorityOf(pawn, jobId) { return pawn.prio[jobId] == null ? 0 : pawn.prio[jobId]; }

  function genPawn(rng, i) {
    var root = genRoot(rng);
    var role = ROLES[i % ROLES.length];
    var tal = genTalents(rng, role);
    var traits = genTraits(rng);
    var gg = genGear(rng, role);
    var arts = genArts(rng);
    var total = tal.total;
    var realmIdx = total < 112 ? 0 : (total < 148 ? 1 : (total < 170 ? 2 : 3));
    var expMax = 600 + Math.round(total * 6);
    var pawn = {
      id: 'p' + (i + 1),
      name: pick(rng, SURNAMES) + pick(rng, GIVEN),
      role: role,
      age: rint(rng, 16, 42),
      gender: i % 2 === 0 ? '男' : '女',
      realm: REALM[realmIdx] + '期 · ' + rint(rng, 1, 9) + ' 层',
      exp: Math.round(expMax * (CFG.EXP_MIN_RATE + rng() * (CFG.EXP_MAX_RATE - CFG.EXP_MIN_RATE))),
      root: root,
      talents: tal,
      traits: traits,
      gear: gg.gear,
      queue: gg.queue,
      queueFrom: gg.queueFrom,
      arts: arts,
      mood: rint(rng, 52, 92),
      job: null,
      prio: {}
    };
    for (var j = 0; j < JOBS.length; j++) {
      var jb = JOBS[j];
      var v = (jb.dao === DAO[(i + j) % 6].k) ? rint(rng, 1, 2) : rint(rng, 2, 4);
      if (rng() < 0.08) v = 0;
      pawn.prio[jb.id] = v;
    }
    /* 当前气血/灵力: 演示态故意不满 (战斗/劳作会掉), 上限由 attrs() 现算 */
    var a0 = attrs(pawn);
    pawn.vit = {
      hp: Math.round(a0.hp * (0.52 + rng() * 0.44)),
      mp: Math.round(a0.mp * (0.40 + rng() * 0.50))
    };
    return pawn;
  }

  function demoSquad(n, seed, teams) {
    n = Math.max(3, Math.min(9, n || 6));
    var rng = mulberry32(seed == null ? 20261124 : seed);
    var pawns = [], used = {};
    for (var i = 0; i < n; i++) {
      var p = genPawn(rng, i);
      while (used[p.name]) p.name = pick(rng, SURNAMES) + pick(rng, GIVEN);
      used[p.name] = 1;
      pawns.push(p);
    }
    return { pawns: pawns, jobs: JOBS.slice(), stash: genStash(rng), tickAt: 0,
             squads: splitSquads(pawns, teams) };
  }

  /* ============================================================
   * 多小队 (2026-11-24 第六轮)
   * ------------------------------------------------------------
   * 铁律: state.pawns **永远是全量弟子**, 小队只存 id 引用与顺序 ——
   *   squads: [{ id, name, members: ['p3','p1',…] }]
   * 这样 model 里所有按 state.pawns 遍历的算法 (attrs/step/teamWeight/probe)
   * 一行都不用改, 队伍页只负责「按 id 取人 + 按 members 顺序排」。
   * 队名上限 🔴 4 字 (SQUAD_NAME_MAX), 入口条与 chip 都按这个宽度画。
   * ============================================================ */
  var SQUAD_NAME_MAX = 4;
  var SQUAD_DEFAULT_NAMES = ['小队', '二队', '三队', '四队', '五队', '六队'];

  function squadName(s) {
    s = String(s == null ? '' : s).replace(/\s+/g, '');
    if (!s) return SQUAD_DEFAULT_NAMES[0];
    return s.length > SQUAD_NAME_MAX ? s.slice(0, SQUAD_NAME_MAX) : s;
  }

  /* 按队数把弟子轮流分配 (保证每队都有人, 队数不会超过人数) */
  function splitSquads(pawns, teams) {
    var ids = [], out = [], i;
    for (i = 0; i < pawns.length; i++) ids.push(pawns[i].id);
    teams = Math.max(1, Math.min(SQUAD_DEFAULT_NAMES.length, Math.min(teams || 1, ids.length)));
    for (i = 0; i < teams; i++) out.push({ id: 'sq' + (i + 1), name: SQUAD_DEFAULT_NAMES[i], members: [] });
    for (i = 0; i < ids.length; i++) out[(i % teams)].members.push(ids[i]);
    return out;
  }

  /* 兜住后台/存档里任何残缺形态: 补队、修名、去重、捡回没归队的弟子。
     ⚠ 幂等 —— 每次渲染前都能安全调一次。 */
  function normalizeSquads(state) {
    if (!state) return [];
    var pawns = state.pawns || [], i, j, k;
    var byId = {}, sq = state.squads, out = [], taken = {};
    for (i = 0; i < pawns.length; i++) byId[pawns[i].id] = pawns[i];
    if (!Array.isArray(sq) || !sq.length) {
      sq = [{ id: 'sq1', name: SQUAD_DEFAULT_NAMES[0], members: pawns.map(function (p) { return p.id; }) }];
    }
    for (i = 0; i < sq.length; i++) {
      var src = sq[i] || {};
      var id = String(src.id || ('sq' + (i + 1)));
      var ids = [], ms = Array.isArray(src.members) ? src.members : [];
      for (j = 0; j < ms.length; j++) {
        var p = byId[ms[j]];
        if (!p || taken[p.id]) continue;           // 不存在 或 已在前面某队
        taken[p.id] = 1;
        ids.push(p.id);
      }
      out.push({ id: id, name: squadName(src.name), members: ids });
    }
    /* 队 id 去重 (存档被手改会撞) */
    var seenId = {};
    for (i = 0; i < out.length; i++) {
      var base = out[i].id;
      while (seenId[out[i].id]) out[i].id = base + '_' + (i + 1);
      seenId[out[i].id] = 1;
    }
    /* 没归队的弟子 (新招的人 / 存档漏了) 落到第一队末尾, 不能凭空消失 */
    for (i = 0; i < pawns.length; i++) {
      if (!taken[pawns[i].id]) { taken[pawns[i].id] = 1; out[0].members.push(pawns[i].id); }
    }
    state.squads = out;
    var hasCur = false;
    for (i = 0; i < out.length; i++) if (out[i].id === state.curSquad) hasCur = true;
    if (!hasCur) state.curSquad = out[0].id;
    return out;
  }

  function squadById(state, id) {
    var list = (state && state.squads) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* 按 members 顺序取出该队的真实弟子对象 */
  function squadPawns(state, id) {
    if (!state) return [];
    var map = {}, out = [], i;
    for (i = 0; i < state.pawns.length; i++) map[state.pawns[i].id] = state.pawns[i];
    var sq = squadById(state, id) || (state.squads && state.squads[0]);
    if (!sq) return state.pawns.slice();
    for (i = 0; i < sq.members.length; i++) if (map[sq.members[i]]) out.push(map[sq.members[i]]);
    return out;
  }

  /* 数组内挪位 (拖动排序用), 返回是否真的动了 */
  function moveInArray(arr, from, to) {
    if (!arr || from === to || from < 0 || from >= arr.length) return false;
    if (to < 0) to = 0;
    if (to > arr.length - 1) to = arr.length - 1;
    var v = arr.splice(from, 1)[0];
    arr.splice(to, 0, v);
    return true;
  }

  /* ============================================================
   * 弟子「在哪支队 / 第几位」的显式读数
   * ------------------------------------------------------------
   * ⚠ 不存字段: 唯一真源是 squads[].members 的**数组顺序**。
   *   这里只是把顺序翻译成可读标记 (队伍页/探针/接口映射共用),
   *   任何写操作都必须回到 members 数组, 不许另存一份 position。
   * ============================================================ */
  function locatePawn(state, pid) {
    if (!state || !Array.isArray(state.squads)) return null;
    for (var i = 0; i < state.squads.length; i++) {
      var at = state.squads[i].members.indexOf(pid);
      if (at >= 0) {
        return { id: pid, squad: state.squads[i].id, name: state.squads[i].name,
                 pos: at, size: state.squads[i].members.length };
      }
    }
    return null;
  }

  /* 跨队移动 (拖动 / 「移」菜单共用)
     · toPos 缺省 = 插到目标队末尾; 目标队为空也照样能收 (空队不是死路)
     · 返回 fromEmpty  ⇒ 原队被移空, 调用方据此提示「物品并入宗门背包」
     · 同一支队内调用等价于 moveInArray */
  function movePawn(state, pid, toSqId, toPos) {
    var sqs = (state && state.squads) || [];
    var from = null, fromAt = -1, to = null, i;
    for (i = 0; i < sqs.length; i++) {
      if (sqs[i].id === toSqId) to = sqs[i];
      var at = sqs[i].members.indexOf(pid);
      if (at >= 0) { from = sqs[i]; fromAt = at; }
    }
    if (!from || !to) return { ok: false, reason: 'no-squad' };
    if (from.id === to.id) {
      var p0 = toPos == null ? fromAt : Math.max(0, Math.min(to.members.length - 1, toPos));
      var same = moveInArray(from.members, fromAt, p0);
      return { ok: true, same: true, from: from.id, to: to.id, pos: p0, fromEmpty: false };
    }
    var toWasEmpty = to.members.length === 0;
    from.members.splice(fromAt, 1);
    var at2 = toPos == null ? to.members.length : Math.max(0, Math.min(to.members.length, toPos));
    to.members.splice(at2, 0, pid);
    return {
      ok: true, same: false, from: from.id, to: to.id, pos: at2,
      fromEmpty: from.members.length === 0, toWasEmpty: toWasEmpty
    };
  }

  /* ============================================================
   * 装备 / 卸下 (全局背包 ⇄ 槽位)
   * ------------------------------------------------------------
   * 没有「个人背包」: 全队共用 state.stash。换装只做"换"不做"丢" ——
   * 换下来的旧件回到刚腾出的那一格, 背包永远不凭空多/少东西。
   * ============================================================ */
  function equip(pawn, stash, idx) {
    var it = stash[idx];
    if (!it) return { ok: false, why: '空格' };
    var slot = slotOf(it.kind);
    if (!slot) return { ok: false, why: '此物不可穿戴' };
    if (slot === 'talisman') {
      /* 法宝: 只换队列首位 (队列长度不变), 旧首位回到刚腾出的格子 ——
         ⚠ 不能 unshift 再塞背包: 同一个对象会同时存在于 queue 与 stash (探针会判重)。 */
      var oldT = pawn.queue.length ? pawn.queue[0] : null;
      if (pawn.queue.length) pawn.queue[0] = it; else pawn.queue.push(it);
      pawn.gear.talisman = it;
      stash[idx] = oldT || null;
      return { ok: true, slot: 'talisman', old: oldT };
    }
    var old = pawn.gear[slot];
    pawn.gear[slot] = it;
    stash[idx] = old || null;
    return { ok: true, slot: slot, old: old };
  }
  function firstEmpty(stash) {
    for (var i = 0; i < stash.length; i++) if (!stash[i]) return i;
    return -1;
  }
  function unequip(pawn, stash, slot) {
    var it = pawn.gear[slot];
    if (!it) return { ok: false, why: '空槽' };
    var idx = firstEmpty(stash);
    if (idx < 0) return { ok: false, why: '背包已满' };
    stash[idx] = it;
    pawn.gear[slot] = null;
    if (slot === 'talisman') {
      for (var i = 0; i < pawn.queue.length; i++) if (pawn.queue[i] === it) { pawn.queue.splice(i, 1); break; }
      pawn.gear.talisman = pawn.queue[0] || null;
    }
    return { ok: true, stashIdx: idx };
  }

  /* ============================================================
   * 换装前的对比 (面板必须先让玩家看到「换了会变成什么」)
   * ============================================================ */
  var CMP_KEYS = ['atk', 'def', 'acc', 'hp', 'mp', 'w'];
  function compareGear(pawn, stash, idx) {
    var it = stash[idx];
    if (!it) return null;
    var slot = slotOf(it.kind);
    if (!slot) return { slot: null, now: null, next: it, delta: null };
    var now = pawn.gear[slot] || null;
    var delta = {}, i, k;
    for (i = 0; i < CMP_KEYS.length; i++) {
      k = CMP_KEYS[i];
      delta[k] = (it[k] || 0) - (now ? (now[k] || 0) : 0);
    }
    return { slot: slot, now: now, next: it, delta: delta };
  }

  /* ============================================================
   * 使用物品 (丹药服用 / 功法研习), 材料不可用
   * ============================================================ */
  function takeOne(stash, idx) {
    var it = stash[idx];
    if (!it) return 0;
    if ((it.qty || 1) > 1) { it.qty -= 1; return it.qty; }
    stash[idx] = null;
    return 0;
  }
  function useItem(pawn, stash, idx) {
    var it = stash[idx];
    if (!it) return { ok: false, why: '空格' };
    if (it.kind === 'pill') {
      var v = vitalOf(pawn);
      var hp0 = v.hp, mp0 = v.mp;
      pawn.vit.hp = Math.min(v.maxHp, v.hp + (it.heal || 0));
      pawn.vit.mp = Math.min(v.maxMp, v.mp + (it.mp || 0));
      var gh = pawn.vit.hp - hp0, gm = pawn.vit.mp - mp0;
      if (!gh && !gm) return { ok: false, why: '气血与灵力都已满' };
      return { ok: true, kind: 'pill', name: it.n, hp: gh, mp: gm, left: takeOne(stash, idx) };
    }
    if (it.kind === 'book') {
      var em = 600 + Math.round(talentTotal(pawn) * 6);
      var add = it.exp || 40 * (it.q || 1);
      var e0 = pawn.exp;
      pawn.exp = Math.min(em, pawn.exp + add);
      var got = pawn.exp - e0;
      if (!got) return { ok: false, why: '修为已至瓶颈' };
      return { ok: true, kind: 'book', name: it.n, exp: got, left: takeOne(stash, idx) };
    }
    return { ok: false, why: '此物不可使用' };
  }

  /* ============================================================
   * 演示推进 (任务) —— 与上一版一致, 只让面板"活着"
   * ============================================================ */
  function rateOf(pawn, job) {
    var t = pawn.talents.v[job.dao] || [];
    var avg = 0;
    for (var i = 0; i < t.length; i++) avg += t[i];
    avg = avg / 6;
    var r = 0.55 + avg / 45;
    if (hasTrait(pawn, '勤勉')) r *= 1.35;
    if (hasTrait(pawn, '懒散')) r *= 0.70;
    return r;
  }
  function pickJob(pawn) {
    var best = null, bestP = 99, bestT = -1;
    for (var i = 0; i < JOBS.length; i++) {
      var jb = JOBS[i], p = priorityOf(pawn, jb.id);
      if (!p) continue;
      var t = (pawn.talents.v[jb.dao] || [0]).reduce(function (a, b) { return a + b; }, 0);
      if (p < bestP || (p === bestP && t > bestT)) { best = jb; bestP = p; bestT = t; }
    }
    return best;
  }
  function step(state, dtMs) {
    var changed = false;
    for (var i = 0; i < state.pawns.length; i++) {
      var p = state.pawns[i];
      if (!p.job) {
        var jb = pickJob(p);
        if (!jb) { p.job = { jobId: null, task: '无事可做', progress: 0, done: 0 }; changed = true; continue; }
        var names = TASK_NAMES[jb.id] || [jb.n];
        p.job = { jobId: jb.id, task: names[i % names.length], progress: 0, done: 0 };
        changed = true;
        continue;
      }
      if (!p.job.jobId) continue;
      var job = JOB_INDEX[p.job.jobId];
      if (!job) continue;
      p.job.progress += (dtMs / 240) * rateOf(p, job);
      if (p.job.progress >= 100) {
        p.job.done = (p.job.done || 0) + 1;
        p.job.progress = 0;
        var names2 = TASK_NAMES[job.id] || [job.n];
        p.job.task = names2[(p.job.done + i) % names2.length];
        /* 干成一件事给修为 (演示: 小步涨, 让修为条也动) */
        var em = 600 + Math.round(talentTotal(p) * 6);
        p.exp = Math.min(em, p.exp + 10 + rint(Math.random, 0, 14));
        changed = true;
      }
    }
    state.tickAt = (state.tickAt || 0) + dtMs;
    if (state.tickAt > 6000) {
      state.tickAt = 0;
      for (var k = 0; k < state.pawns.length; k++) {
        var q = state.pawns[k];
        q.mood = Math.max(20, Math.min(100, q.mood + (Math.random() < 0.5 ? -1 : 1)));
        /* 气血/灵力: 在役者耗、空闲者回; 偶发「交手」掉一截 —— 条必须是活的,
           否则玩家看不出「百分比」的意义 (用户: 战斗有变化)。 */
        var vv = vitalOf(q), maxHp = vv.maxHp, maxMp = vv.maxMp;
        var busy = !!(q.job && q.job.jobId);
        if (Math.random() < 0.18) {                       // 遭遇战
          q.vit.hp = Math.max(1, q.vit.hp - rint(Math.random, Math.round(maxHp * 0.12), Math.round(maxHp * 0.26)));
          q.vit.mp = Math.max(0, q.vit.mp - rint(Math.random, 2, 9));
          q.mood = Math.max(20, q.mood - rint(Math.random, 1, 4));
        } else if (busy) {                                // 劳作消耗
          q.vit.hp = Math.max(Math.round(maxHp * 0.2), q.vit.hp - rint(Math.random, 1, 4));
          q.vit.mp = Math.max(0, q.vit.mp - rint(Math.random, 1, 3));
        } else {                                          // 静养回复
          q.vit.hp = Math.min(maxHp, q.vit.hp + rint(Math.random, 2, 6));
          q.vit.mp = Math.min(maxMp, q.vit.mp + rint(Math.random, 3, 8));
        }
      }
      changed = true;
    }
    return changed;
  }

  function talentTotal(pawn) {
    var s = 0, v = pawn.talents.v;
    for (var k in v) for (var i = 0; i < v[k].length; i++) s += v[k][i];
    return s;
  }
  function rootSum(pawn) { return pawn.root.v.reduce(function (a, b) { return a + b; }, 0); }
  function jobById(id) { return JOB_INDEX[id] || null; }

  function probe(state) {
    var bad = [];
    var seenItem = {};
    if (state.stash.length !== CFG.STASH_COLS * CFG.STASH_ROWS) bad.push('全局背包格数 ' + state.stash.length);
    for (var s0 = 0; s0 < state.stash.length; s0++) {
      var si0 = state.stash[s0];
      if (!si0) continue;
      if (seenItem[si0.id]) bad.push('全局背包: 物品重复 ' + si0.n);
      seenItem[si0.id] = 1;
      if (!si0.n || !(si0.w >= 0)) bad.push('全局背包: 物品字段坏 ' + s0);
    }
    for (var i = 0; i < state.pawns.length; i++) {
      var p = state.pawns[i];
      if (rootSum(p) !== CFG.ROOT_SUM) bad.push(p.name + ': 灵根合计 ' + rootSum(p));
      if (talentTotal(p) !== p.talents.total) bad.push(p.name + ': 天赋合计不符');
      if (p.talents.total < CFG.TALENT_MIN || p.talents.total > CFG.TALENT_MAX) bad.push(p.name + ': 天赋总量越界');
      if (p.traits.length < CFG.TRAIT_MIN || p.traits.length > CFG.TRAIT_MAX) bad.push(p.name + ': 特质条数 ' + p.traits.length);
      var seen = {};
      for (var t = 0; t < p.traits.length; t++) {
        if (seen[p.traits[t].pair]) bad.push(p.name + ': 特质正反同现');
        seen[p.traits[t].pair] = 1;
      }
      if (p.queue.length < CFG.TALISMAN_MIN || p.queue.length > CFG.TALISMAN_MAX) bad.push(p.name + ': 法宝队列 ' + p.queue.length);
      if (p.arts.slots.length < CFG.ART_MIN || p.arts.slots.length > CFG.ART_MAX) bad.push(p.name + ': 神通格 ' + p.arts.slots.length);
      /* 槽位里的东西必须与槽位类型一致 (换装写错槽 = 面板上「刀装在头上」) */
      var keys = ['weapon', 'offhand', 'body', 'head', 'talisman'];
      for (var k2 = 0; k2 < keys.length; k2++) {
        var g2 = p.gear[keys[k2]];
        if (!g2) continue;
        if (g2.kind !== keys[k2]) bad.push(p.name + ': 槽位错配 ' + keys[k2] + '←' + g2.kind);
        if (seenItem[g2.id]) bad.push(p.name + ': 物品重复(槽) ' + g2.n);
        seenItem[g2.id] = 1;
      }
      if (!p.gear.talisman && p.queue.length) bad.push(p.name + ': 法宝槽空但队列有件');
      var e0 = expOf(p);
      if (!(e0.v > 0 && e0.v <= e0.max)) bad.push(p.name + ': 修为越界 ' + e0.v + '/' + e0.max);
      var v0 = vitalOf(p);
      if (!(v0.hp >= 0 && v0.hp <= v0.maxHp)) bad.push(p.name + ': 气血越界 ' + v0.hp + '/' + v0.maxHp);
      if (!(v0.mp >= 0 && v0.mp <= v0.maxMp)) bad.push(p.name + ': 灵力越界 ' + v0.mp + '/' + v0.maxMp);
    }
    /* 多小队: 队名 ≤4 字 / 队 id 唯一 / 每人只在一队 / 没有孤儿 id */
    var assign = [];
    if (Array.isArray(state.squads)) {
      var sqSeen = {}, sqMembers = {};
      for (var q = 0; q < state.squads.length; q++) {
        var qs = state.squads[q];
        if (sqSeen[qs.id]) bad.push('小队 id 重复 ' + qs.id);
        sqSeen[qs.id] = 1;
        if (!qs.name || qs.name.length > 4) bad.push('小队名超 4 字/为空: ' + qs.name);
        for (var qm = 0; qm < qs.members.length; qm++) {
          var qid = qs.members[qm];
          if (sqMembers[qid]) bad.push('弟子 ' + qid + ' 同时在两队');
          sqMembers[qid] = 1;
          /* 位置 = 数组下标, 一人一条, 供验收/接口映射直接读 */
          assign.push({ id: qid, squad: qs.id, pos: qm });
          if (!state.pawns.some(function (pp) { return pp.id === qid; })) bad.push('小队含不存在的弟子 ' + qid);
        }
      }
      for (var qp = 0; qp < state.pawns.length; qp++) {
        if (!sqMembers[state.pawns[qp].id]) bad.push('弟子 ' + state.pawns[qp].name + ' 未归任何小队');
      }
    }
    return { pawns: state.pawns.length, jobs: state.jobs.length, stash: state.stash.length,
             assign: assign, violations: bad, ok: bad.length === 0 };
  }

  g.CrewModel = {
    CFG: CFG, ELEMENTS: ELEMENTS, DAO: DAO, JOBS: JOBS, TRAITS: TRAITS,
    QUALITY: QUALITY, SLOT_NAMES: SLOT_NAMES, ATTR_META: ATTR_META,
    ITEM_DEFS: ITEM_DEFS,               // 只读参考 (掉落/商店将来从这里取)
    demoSquad: demoSquad,
    /* 多小队: 结构工具 + 名字清洗 (队名上限 4 字) */
    SQUAD_NAME_MAX: SQUAD_NAME_MAX, SQUAD_DEFAULT_NAMES: SQUAD_DEFAULT_NAMES,
    squadName: squadName, normalizeSquads: normalizeSquads, squadById: squadById,
    squadPawns: squadPawns, moveInArray: moveInArray, splitSquads: splitSquads,
    locatePawn: locatePawn, movePawn: movePawn,
    makeNamed: function (name, qty) {   // 按名字造一件 (验收/调试用)
      for (var i = 0; i < ITEM_DEFS.length; i++) if (ITEM_DEFS[i].n === name) return makeItem(ITEM_DEFS[i], qty);
      return null;
    },
    attrs: attrs, attrRows: attrRows, weightOf: weightOf, loadMax: loadMax, overload: overload,
    expOf: expOf, vitalOf: vitalOf, stashWeight: stashWeight, teamWeight: teamWeight,
    slotOf: slotOf, equip: equip, unequip: unequip, compareGear: compareGear, useItem: useItem,
    priorityOf: priorityOf, cyclePriority: cyclePriority, jobById: jobById,
    talentTotal: talentTotal, rootSum: rootSum, rateOf: rateOf,
    step: step, probe: probe, makeItem: makeItem
  };
})(typeof window !== 'undefined' ? window : globalThis);
