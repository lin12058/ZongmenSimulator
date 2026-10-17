/* ============================================================
 * 宗门模拟器 · 角色生成核心 (CultivatorGen core)
 * ------------------------------------------------------------
 * ★ 为什么是 classic script (而不是 .mjs):
 *   本文件是**服务端 V8 子系统** (scope="characters") 的 bundle 之一 ——
 *   JsvmModule.BuildBundle() 把脚本原文顺序拼接后 `engine.Evaluate(bundle)`,
 *   V8 沙箱里**没有** Node 的 import/module/fs。故这里只写 classic script,
 *   并把全部出口挂到 `global.CultivatorGen`。
 *   Node 侧的 CLI (chargen.mjs) 用 `vm.runInThisContext` 求值**同一份**文件,
 *   ⇒ 生成逻辑只有一处真源, 不会出现「离线脚本对、线上服务错」的静默漂移。
 *
 * 数据流:
 *   C# CharactersModule.OnVmReady  →  CultivatorGen.setBase(<cultivation-base.json 文本>)
 *   之后每次 /api/characters 请求     →  CultivatorGen.batchJson(seed, count, offset)
 *
 * 设计纪律 (对齐工程铁律):
 *   - 确定性: 同一 (seed, index) ⇒ 逐字段可复现。绝不用 Math.random()/Date.now()。
 *     ⇒ 角色是 **seed 纯函数派生**, 不需要 1MB 落库表 (与 chunk/settle 同哲学)。
 *   - 正态分布: 年龄/六维/灵根纯度/修为进度 全部走「截断正态」(Box-Muller + 拒绝采样)。
 *   - 年龄从 0 开始: 年龄下界 = 0, 幼童与 newborn 皆可生成。
 *   - 数据驱动: 生成器不硬编码任何词条/名称/数值; 新增内容只改 JSON。
 * ============================================================ */
(function (global) {
  'use strict';

  /* ========================= 确定性随机 ========================= */

  /** FNV-1a 32bit —— 与工程内 hash01 同源的纯函数哈希。 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** hash01(...parts) ∈ [0,1): 把任意键序列映射成一个确定性小数。 */
  function hash01() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
    return fnv1a(parts.join('\u0001')) / 4294967296;
  }

  /** mulberry32 种子 PRNG —— 同种子同序列。 */
  function makeRng(seed) {
    var a = (typeof seed === 'number' ? seed : fnv1a(String(seed))) >>> 0;
    if (a === 0) a = 0x9e3779b9;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 标准正态 (Box-Muller)。 */
  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 截断正态采样: 落在 [min,max] 之外就重采样, 超次数则夹断。spec={mean,sd,min?,max?} */
  function truncNormal(rng, spec) {
    var mean = spec.mean, sd = spec.sd;
    var min = spec.min === undefined ? -Infinity : spec.min;
    var max = spec.max === undefined ? Infinity : spec.max;
    var s = Math.abs(sd) || 0;
    if (s === 0) return Math.min(max, Math.max(min, mean));
    for (var i = 0; i < 128; i++) {
      var x = mean + s * gauss(rng);
      if (x >= min && x <= max) return x;
    }
    return Math.min(max, Math.max(min, mean + s * gauss(rng)));
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function intNormal(rng, spec) { return Math.round(truncNormal(rng, spec)); }

  /** 按 weight 字段加权抽样。 */
  function weightedPick(rng, list, weightOf) {
    if (!weightOf) weightOf = function (x) { return x.weight === undefined ? 1 : x.weight; };
    var total = 0;
    for (var i = 0; i < list.length; i++) total += Math.max(0, weightOf(list[i]));
    if (total <= 0) return list[Math.floor(rng() * list.length)];
    var r = rng() * total;
    for (var j = 0; j < list.length; j++) {
      r -= Math.max(0, weightOf(list[j]));
      if (r <= 0) return list[j];
    }
    return list[list.length - 1];
  }

  /** 不放回抽 n 个 (保持权重)。 */
  function pickSome(rng, list, n, weightOf) {
    var pool = list.slice();
    var out = [];
    n = clamp(n, 0, pool.length);
    while (out.length < n && pool.length) {
      var it = weightedPick(rng, pool, weightOf);
      out.push(it);
      pool.splice(pool.indexOf(it), 1);
    }
    return out;
  }

  /** 抽 [lo,hi] 区间内的整数。 */
  function randInt(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  /* ========================= 数据装载 ========================= */

  var BASE = null;

  function rankMap(grades) {
    var m = {};
    for (var i = 0; i < grades.length; i++) m[grades[i].id] = grades[i].rank;
    return m;
  }

  /** 给 base 建索引 (加速查表)。幂等 —— 先删旧索引再建。 */
  function indexBase(data) {
    var realmById = {}, techById = {}, itemById = {}, traitById = {}, bgById = {}, rootRankById = {};
    var i;
    for (i = 0; i < data.realms.list.length; i++) realmById[data.realms.list[i].id] = data.realms.list[i];
    for (i = 0; i < data.techniques.list.length; i++) techById[data.techniques.list[i].id] = data.techniques.list[i];
    for (i = 0; i < data.items.list.length; i++) itemById[data.items.list[i].id] = data.items.list[i];
    for (i = 0; i < data.traits.list.length; i++) traitById[data.traits.list[i].id] = data.traits.list[i];
    for (i = 0; i < data.backgrounds.list.length; i++) bgById[data.backgrounds.list[i].id] = data.backgrounds.list[i];
    for (i = 0; i < data.spiritRoots.grades.length; i++) {
      var g = data.spiritRoots.grades[i];
      rootRankById[g.id] = g.rank;
    }
    data.$index = {
      realmById: realmById,
      techniqueById: techById,
      itemById: itemById,
      traitById: traitById,
      bgById: bgById,
      rootRankById: rootRankById,
      gradeRank: { techniques: rankMap(data.techniques.grades), items: rankMap(data.items.grades) },
    };
    data.$fn = {
      realmSeq: function (id) {
        var r = data.$index.realmById[id];
        return r ? (r.seq || 0) : 0;
      },
      rootRank: function (id) {
        var v = data.$index.rootRankById[id];
        return v === undefined ? 0 : v;
      },
    };
    return data;
  }

  /** 注入基础数据 (字符串或对象)。V8 侧由 C# OnVmReady 调用一次。 */
  function setBase(x) {
    BASE = (typeof x === 'string') ? JSON.parse(x) : x;
    indexBase(BASE);
    return true;
  }

  function ready() { return !!BASE; }

  /* ========================= 生成管线 ========================= */

  var DIVINE_REALMS = { dacheng: 1, dujie: 1, heti: 1 };

  function pickElements(rng, D, rootGrade) {
    var order = D.elements.order;
    var n = rootGrade.elementCount === undefined ? 1 : rootGrade.elementCount;
    var mutChance = rootGrade.mutChance === undefined ? 0 : rootGrade.mutChance;
    if (rng() < mutChance) {
      var muts = [];
      for (var k in D.elements.mutations) {
        if (k.charAt(0) === '_') continue;
        if (Object.prototype.hasOwnProperty.call(D.elements.mutations, k)) muts.push([k, D.elements.mutations[k]]);
      }
      var m = muts[Math.floor(rng() * muts.length)];
      return { base: m[1].base, mutation: m[0], label: m[0], color: m[1].color, desc: m[1].desc };
    }
    var picked = pickSome(rng, order, n, function () { return 1; }).map(function (e) {
      return typeof e === 'string' ? e : e.name;
    });
    var first = D.elements.attrs[picked[0]];
    return { base: picked, mutation: null, label: picked.join('·'), color: first ? first.color : undefined, desc: '' };
  }

  /** 特质: 1~3 条, 遵守冲突表, 按品质权重。 */
  function rollTraits(rng, D, range) {
    var lo = range[0], hi = range[1];
    var want = randInt(rng, lo, hi);
    var chosen = [];
    var T = D.traits.list;
    for (var guard = 0; guard < 200 && chosen.length < want; guard++) {
      var cand = weightedPick(rng, T, function (t) {
        var q = null;
        for (var i = 0; i < D.traits.quality.length; i++) if (D.traits.quality[i].id === t.quality) { q = D.traits.quality[i]; break; }
        return (t.weight === undefined ? 10 : t.weight) * (q ? q.weight : 1);
      });
      if (chosen.indexOf(cand) >= 0) continue;
      var clash = false;
      for (var c = 0; c < D.traits.conflicts.length; c++) {
        var pair = D.traits.conflicts[c], a = pair[0], b = pair[1];
        var hasA = false, hasB = false;
        for (var s = 0; s < chosen.length; s++) {
          if (chosen[s].id === a) hasA = true;
          if (chosen[s].id === b) hasB = true;
        }
        if ((a === cand.id && hasB) || (b === cand.id && hasA)) { clash = true; break; }
      }
      if (clash) continue;
      chosen.push(cand);
    }
    return chosen;
  }

  /** 目标境界: 基础权重 × 天赋偏置。 */
  function rollRealm(rng, D, talentNorm) {
    var pol = D.generate;
    var bias = pol.realmBias;
    var list = D.realms.list;
    return weightedPick(rng, list, function (r) {
      var w = pol.realmWeights[r.id];
      var base = w === undefined ? 0.01 : w;
      return base * Math.pow(bias.base, talentNorm * (r.seq - bias.pivot));
    });
  }

  /** 挑选功法: 1 主修心法 + 若干辅修/技艺。硬门槛: 境界 + 灵根品级。 */
  function rollTechniques(rng, D, o) {
    var realm = o.realm, root = o.root, elements = o.elements, talentNorm = o.talentNorm, alignId = o.alignId;
    var T = D.techniques.list;
    var grades = D.techniques.grades;
    var realmSeq = D.$fn.realmSeq, rootRank = D.$fn.rootRank;
    var maxRank = clamp(1 + Math.floor(realm.seq / 2) + (talentNorm > 0.4 ? 1 : 0), 1, 5);
    var eligible = T.filter(function (t) {
      var g = null;
      for (var i = 0; i < grades.length; i++) if (grades[i].id === t.grade) { g = grades[i]; break; }
      return g.rank <= maxRank &&
        realm.seq >= realmSeq(t.minRealm) &&
        (root ? (root.rank || 0) : 0) >= rootRank(t.minRoot);
    });
    var elSet = {};
    for (var e = 0; e < elements.base.length; e++) elSet[elements.base[e]] = 1;
    function score(t) {
      var s = 1;
      if (t.element && elSet[t.element]) s += 2.5;
      if (t.element === '全') s += 0.6;
      var g = null;
      for (var i = 0; i < grades.length; i++) if (grades[i].id === t.grade) { g = grades[i]; break; }
      s *= 0.5 + g.rank * 0.35;
      if (alignId === 'modao' && (t.element === '暗' || t.element === '雷')) s += 1.2;
      return s;
    }

    var xinfa = eligible.filter(function (t) { return t.cat === 'xinfa'; });
    var main = xinfa.length ? weightedPick(rng, xinfa, score) : null;

    var auxPool = eligible.filter(function (t) { return t.cat !== 'xinfa'; });
    var want = randInt(rng, D.generate.extraAuxTechniques[0], D.generate.extraAuxTechniques[1]);
    var aux = pickSome(rng, auxPool, want, score).map(function (t) {
      return {
        id: t.id, name: t.name, cat: t.cat, grade: t.grade,
        element: t.element, proficiency: Number((0.1 + rng() * 0.6).toFixed(2)),
      };
    });

    return {
      main: main
        ? { id: main.id, name: main.name, cat: main.cat, grade: main.grade, element: main.element, desc: main.desc }
        : null,
      aux: aux,
    };
  }

  /** 储物袋: 容量 + 灵石 + 物品 (背景起始 + 境界礼包 + 随机零碎)。 */
  function rollStorageBag(rng, D, o) {
    var realm = o.realm, bg = o.bg, traitMul = o.traitMul;
    var cfg = D.storageBag;
    var slots = clamp(cfg.baseSlots + realm.seq * cfg.slotsPerRealm, cfg.baseSlots, cfg.maxSlots);
    var lingshi = Math.round((cfg.startingLingshi[realm.id] || 0) * (bg.lingshiMul || 1) * (traitMul.lingshiMul || 1));

    var bag = [];
    function push(id, count) {
      if (count === undefined) count = 1;
      var it = D.$index.itemById[id];
      if (!it) return;
      if (D.$fn.realmSeq(it.minRealm) > realm.seq) return;   // 境界门槛: 低境界不得持高阶物
      var ex = null;
      for (var i = 0; i < bag.length; i++) if (bag[i].id === id) { ex = bag[i]; break; }
      var stack = 1;
      for (var c = 0; c < D.items.categories.length; c++) if (D.items.categories[c].id === it.cat) { stack = D.items.categories[c].stack || 1; break; }
      if (ex) ex.count = Math.min(stack, ex.count + count);
      else bag.push({ id: id, name: it.name, cat: it.cat, grade: it.grade, count: count });
    }

    var startItems = bg.startItems || [];
    for (var s = 0; s < startItems.length; s++) push(startItems[s], 1);
    var kit = D.generate.starterKits[realm.id] || [];
    for (var k = 0; k < kit.length; k++) push(kit[k], 1);

    // 随机零碎: 按境界允许的品阶 + minRealm 门槛抽样
    var items = D.items.list.filter(function (i) { return i.cat !== 'lingshi'; });
    var rolls = randInt(rng, D.generate.startingItemRolls.min, D.generate.startingItemRolls.max);
    var maxRank = clamp(1 + Math.floor(realm.seq / 2), 1, 5);
    var cand = items.filter(function (i) {
      var r = D.$index.gradeRank.items[i.grade];
      return (r === undefined ? 0 : r) <= maxRank && realm.seq >= D.$fn.realmSeq(i.minRealm);
    });
    pickSome(rng, cand, rolls, function (i) {
      var r = D.$index.gradeRank.items[i.grade];
      return 10 / (1 + (r === undefined ? 0 : r));
    }).forEach(function (i) { push(i.id, 1); });

    // 灵石入袋 (按面额拆)
    if (lingshi > 0) {
      var left = lingshi;
      var denoms = [
        ['lingshi_jipin', 1000000], ['lingshi_shang', 10000],
        ['lingshi_zhong', 100], ['lingshi_xia', 1],
      ];
      for (var d = 0; d < denoms.length; d++) {
        var n = Math.floor(left / denoms[d][1]);
        if (n > 0) { push(denoms[d][0], n); left -= n * denoms[d][1]; }
      }
    }

    return { slots: slots, used: bag.length, lingshi: lingshi, items: bag.slice(0, slots) };
  }

  /** 姓 + 名 + 道号 (先定性别再定名 —— 生成顺序依赖)。凡人无道号。 */
  function rollName(rng, D, gender, realmSeq) {
    if (realmSeq === undefined) realmSeq = 0;
    var N = D.names;
    var surname = N.surnames[Math.floor(rng() * N.surnames.length)];
    var pool = gender === '女' ? N.givenFemale : gender === '男' ? N.givenMale : N.givenNeutral;
    var given = pool[Math.floor(rng() * pool.length)];
    var full = surname + given;
    var daohao = null;
    if (realmSeq >= 1) {
      var pfx = N.courtesyTitle.prefixes, sfx = N.courtesyTitle.suffixes;
      daohao = pfx[Math.floor(rng() * pfx.length)] + sfx[Math.floor(rng() * sfx.length)];
    }
    return { surname: surname, given: given, full: full, daohao: daohao };
  }

  /** 核心: 生成单个角色。同一 (base, {index, seed}) ⇒ 结果逐字段一致。 */
  function generateCharacter(base, opts) {
    var index = 0, seed = 'zongmen';
    if (opts) { if (opts.index !== undefined) index = opts.index; if (opts.seed !== undefined) seed = opts.seed; }
    var D = base;
    var G = D.generate;
    var rng = makeRng(seed + '|' + index);
    var key = seed + '|' + index;

    // 1. 性别
    var gw = [];
    for (var gname in G.genderWeights) {
      if (Object.prototype.hasOwnProperty.call(G.genderWeights, gname)) gw.push({ name: gname, weight: G.genderWeights[gname] });
    }
    var gender = weightedPick(rng, gw).name;

    // 2. 出身背景
    var bg = weightedPick(rng, D.backgrounds.list);

    // 3. 阵营 / 门派
    var align = weightedPick(rng, D.factions.alignments);
    if (bg.id === 'modao_yigu') align = find(D.factions.alignments, 'modao');
    else if (bg.id === 'fomen_huansu' || bg.id === 'daoguan_qitu') align = find(D.factions.alignments, 'zhengdao');
    var sect = null;
    if (align.id !== 'sanxiu' && rng() < 0.62) {
      var pool2 = D.factions.sampleSects.filter(function (s) { return s.align === align.id; });
      if (pool2.length) sect = weightedPick(rng, pool2);
    }

    // 4. 灵根
    var rootGrade = weightedPick(rng, D.spiritRoots.grades);
    var el = pickElements(rng, D, rootGrade);
    var purity = Math.round(truncNormal(rng, D.spiritRoots.purity));
    var purTier = null;
    for (var p = 0; p < D.spiritRoots.purityTiers.length; p++) if (purity >= D.spiritRoots.purityTiers[p].min) { purTier = D.spiritRoots.purityTiers[p]; break; }
    var spiritRoot = {
      grade: rootGrade.id, gradeName: rootGrade.name, rank: rootGrade.rank,
      elements: el.base, element: el.label, mutation: el.mutation,
      purity: purity, purityName: purTier ? purTier.name : '驳杂',
      speedMul: rootGrade.speedMul, color: rootGrade.color, desc: rootGrade.desc,
    };

    // 5. 特质 (先于属性, 因其会改属性)
    var traits = rollTraits(rng, D, G.traitCount);

    // 6. 六维属性 (截断正态 + 灵根加成 + 出身修正 + 特质修正)
    var attrs = {};
    for (var ai = 0; ai < D.attributes.core.length; ai++) {
      var a = D.attributes.core[ai];
      var v = truncNormal(rng, { mean: a.mean, sd: a.sd, min: G.coreAttr.min, max: G.coreAttr.max });
      if (rootGrade.attrBonus && rootGrade.attrBonus[a.key] !== undefined) v += rootGrade.attrBonus[a.key];
      if (bg.attrMod && bg.attrMod[a.key] !== undefined) v += bg.attrMod[a.key];
      for (var ti = 0; ti < traits.length; ti++) {
        if (traits[ti].effects && traits[ti].effects[a.key] !== undefined) v += traits[ti].effects[a.key];
      }
      attrs[a.key] = clamp(Math.round(v), G.coreAttr.min, G.coreAttr.max);
    }

    // 7. 天赋评分 → 决定境界偏置
    var talentScore =
      rootGrade.speedMul * 26 +
      purity * 0.28 +
      spiritRoot.rank * 1.5 +
      attrs.wuxing * 0.4 +
      attrs.shenshi * 0.2;
    var talentNorm = clamp((talentScore - G.realmBias.talentCenter) / G.realmBias.talentDivisor, -1, 1);

    // 8. 境界 + 层 + 修为进度
    var realm = rollRealm(rng, D, talentNorm);
    var layerW = [];
    for (var li = 0; li < realm.layers.length; li++) {
      layerW.push({ i: li, n: realm.layers[li], weight: Math.pow(realm.layers.length - li, G.layerBias.power) });
    }
    var layerIdx = weightedPick(rng, layerW).i;
    var progress = Number(truncNormal(rng, G.realmProgress).toFixed(3));

    // 9. 功法 (心法会改寿元)
    var tech = rollTechniques(rng, D, { realm: realm, root: rootGrade, elements: el, talentNorm: talentNorm, alignId: align.id });
    var mainTech = tech.main ? D.$index.techniqueById[tech.main.id] : {};

    // 10. 特质乘子 (寿命/灵石)
    var traitMul = { lifespanMul: 1, lingshiMul: 1 };
    for (var tm = 0; tm < traits.length; tm++) {
      if (traits[tm].effects && traits[tm].effects.lifespanMul) traitMul.lifespanMul *= traits[tm].effects.lifespanMul;
      if (traits[tm].effects && traits[tm].effects.lingshiMul) traitMul.lingshiMul *= traits[tm].effects.lingshiMul;
    }

    // 11. 寿元 = 境界基准 × 根骨修正 × 特质 × 心法加成 + 心法 flat
    var lifespan = realm.lifespan * (1 + (attrs.gengu - 50) / D.lifespan.genguDivisor) * traitMul.lifespanMul;
    lifespan += (mainTech.effects && mainTech.effects.lifespan) ? mainTech.effects.lifespan : 0;
    lifespan = Math.max(D.lifespan.minLifespan, Math.round(lifespan));

    // 12. 年龄 (从 0 开始, 落在境界年龄带内, 正态偏中)
    var band = G.realmAgeBand[realm.id] || [0, lifespan];
    var lo = Math.max(0, Math.min(band[0], lifespan - 1));
    var hi = Math.max(lo, Math.min(band[1], lifespan - 1));
    var age = intNormal(rng, { mean: (lo + hi) / 2, sd: Math.max(1, (hi - lo) / 2.6), min: lo, max: hi });

    // 13. 储物袋
    var bag = rollStorageBag(rng, D, { realm: realm, bg: bg, traitMul: traitMul });

    // 14. 资源 (灵力/气血/精神): 随境界与相关属性
    var layerFactor = 1 + layerIdx / Math.max(1, realm.layers.length);
    var resources = {
      qi: Math.round(realm.qiBase * layerFactor * (1 + purity / 200)),
      qixue: Math.round((100 + realm.seq * 220 * layerFactor) * (1 + (attrs.gengu - 50) / 120)),
      jingshen: Math.round((60 + realm.seq * 90 * layerFactor) * (1 + (attrs.shenshi - 50) / 120)),
    };

    // 15. 派生属性
    var derived = {
      zizhi: Math.round(rootGrade.speedMul * 40 + attrs.wuxing * 0.4 + attrs.shenshi * 0.2),
      qianli: Math.round(((attrs.gengu + attrs.wuxing + attrs.shenshi + attrs.xinjing) / 4) * (0.6 + purity / 250)),
      shengwang: 0,
    };

    // 16. 姓名 (性别已定)
    var name = rollName(rng, D, gender, realm.seq);

    // 17. 外观
    var ap = D.appearance;
    var appearance = {
      build: ap.builds[Math.floor(rng() * ap.builds.length)],
      face: ap.faces[Math.floor(rng() * ap.faces.length)],
      temperament: ap.temperaments[Math.floor(rng() * ap.temperaments.length)],
    };

    // 18. 组装
    return {
      v: 1,
      id: 'c' + String(index).padStart(5, '0'),
      genSeed: key,
      name: name,
      gender: gender,
      age: age,
      lifespan: lifespan,
      realm: {
        id: realm.id, name: realm.name, seq: realm.seq,
        layer: realm.layers[layerIdx], layerIndex: layerIdx,
        stage: realm.name + '·' + realm.layers[layerIdx],
        progress: progress, talentScore: Number(talentScore.toFixed(1)), talentNorm: Number(talentNorm.toFixed(3)),
      },
      spiritRoot: spiritRoot,
      attributes: attrs,
      derived: derived,
      resources: resources,
      traits: traits.map(function (t) {
        var q = null;
        for (var qi = 0; qi < D.traits.quality.length; qi++) if (D.traits.quality[qi].id === t.quality) { q = D.traits.quality[qi]; break; }
        return {
          id: t.id, name: t.name, type: t.type, quality: t.quality,
          color: q ? q.color : undefined, effects: t.effects, desc: t.desc,
        };
      }),
      background: { id: bg.id, name: bg.name, desc: bg.desc, lingshiMul: bg.lingshiMul === undefined ? 1 : bg.lingshiMul },
      faction: {
        alignment: { id: align.id, name: align.name, color: align.color },
        sect: sect ? { id: sect.id, name: sect.name, tier: sect.tier } : null,
      },
      techniques: tech,
      storageBag: bag,
      appearance: appearance,
      relations: { master: null, disciples: [], partner: null, allies: [], enemies: [] }, // 占位: 社会关系 P0 不做
      history: [], // 传记/经历占位
      ext: {},      // 扩展槽: 为后续系统(功法实战/丹方/灵兽…)预留
    };
  }

  function find(arr, id) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return arr[0];
  }

  /** 批量生成。 */
  function generateBatch(base, opts) {
    var count = 10, seed = 'zongmen', startIndex = 0;
    if (opts) {
      if (opts.count !== undefined) count = opts.count;
      if (opts.seed !== undefined) seed = opts.seed;
      if (opts.startIndex !== undefined) startIndex = opts.startIndex;
    }
    var out = [];
    for (var i = 0; i < count; i++) out.push(generateCharacter(base, { index: startIndex + i, seed: seed }));
    return out;
  }

  /* ========================= 载荷 (payload) ========================= */

  /**
   * 展示字典 —— 把「表内的分类标签」随载荷一起发出去。
   * 为什么: 角色的六维是 `{gengu:57, wuxing:61…}` 这样的**键**, 键名到中文名只有基础数据知道。
   * 前端窗口若自己硬编码一份标签表, 就出现了第二真源 (改 JSON 不改前端 = 静默错名)。
   * ⇒ 单真源仍在 cultivation-base.json, 这里只是把它「随数据一起带出去」。
   */
  function buildDict(base) {
    function pick(arr, keys) {
      return (arr || []).map(function (x) {
        var o = {};
        for (var i = 0; i < keys.length; i++) if (x[keys[i]] !== undefined) o[keys[i]] = x[keys[i]];
        return o;
      });
    }
    return {
      attributes: pick(base.attributes.core, ['key', 'name', 'abbr', 'desc']),
      derived: pick(base.attributes.derived, ['key', 'name', 'desc']),
      resources: pick(base.attributes.resourceBars, ['key', 'name', 'unit', 'desc']),
      realms: pick(base.realms.list, ['id', 'name', 'seq']),
      spiritRoots: pick(base.spiritRoots.grades, ['id', 'name', 'rank', 'speedMul', 'color']),
      purityTiers: pick(base.spiritRoots.purityTiers, ['min', 'name', 'mul']),
      traitsTypes: pick(base.traits.types, ['id', 'name']),
      traitsQuality: pick(base.traits.quality, ['id', 'name', 'rank', 'color']),
      techniqueCategories: pick(base.techniques.categories, ['id', 'name', 'slot']),
      itemCategories: pick(base.items.categories, ['id', 'name', 'stack']),
      grades: {
        techniques: pick(base.techniques.grades, ['id', 'name', 'rank', 'color']),
        items: pick(base.items.grades, ['id', 'name', 'rank', 'color']),
      },
      backgrounds: pick(base.backgrounds.list, ['id', 'name']),
      alignments: pick(base.factions.alignments, ['id', 'name', 'color']),
    };
  }

  /** 组装完整载荷 (CLI / 服务端端点 / 判据共用同一份结构 —— 避免多处各拼一次)。 */
  function buildPayload(base, opts) {
    var count = 10, seed = 'zongmen', startIndex = 0;
    if (opts) {
      if (opts.count !== undefined) count = opts.count;
      if (opts.seed !== undefined) seed = opts.seed;
      if (opts.startIndex !== undefined) startIndex = opts.startIndex;
    }
    var characters = generateBatch(base, { count: count, seed: seed, startIndex: startIndex });
    return {
      schema: 'cultivators/v1',
      generatedAt: null, // 刻意留空: 保持输出纯净可 diff (无时间戳)
      seed: seed,
      count: characters.length,
      offset: startIndex,
      baseMeta: { schema: base.meta.schema, version: base.meta.version },
      dict: buildDict(base),
      characters: characters,
    };
  }

  /* ========================= V8 出口 (用注入的 BASE) ========================= */

  function ensureReady() {
    if (!BASE) throw new Error('CultivatorGen 未初始化: 先调 setBase(base)');
  }

  /** [V8] 一次取整批: {schema,seed,count,offset,dict,characters[]} —— /api/characters 的返回体。 */
  function batchJson(seed, count, offset) {
    ensureReady();
    return JSON.stringify(buildPayload(BASE, { count: count, seed: seed, startIndex: offset }));
  }

  /** [V8] 单个人物 (调试/详情按需取用)。 */
  function oneJson(seed, index) {
    ensureReady();
    return JSON.stringify(generateCharacter(BASE, { index: index, seed: seed }));
  }

  /** [V8] 常量摘要 (诊断: 境界档数/功法数/物品数…)。 */
  function constantsJson() {
    ensureReady();
    return JSON.stringify({
      schema: BASE.meta.schema,
      version: BASE.meta.version,
      realms: BASE.realms.list.length,
      spiritRoots: BASE.spiritRoots.grades.length,
      techniques: BASE.techniques.list.length,
      items: BASE.items.list.length,
      traits: BASE.traits.list.length,
      backgrounds: BASE.backgrounds.list.length,
    });
  }

  var api = {
    version: '1',
    /* 数据 */
    setBase: setBase,
    indexBase: indexBase,
    isReady: ready,
    getBase: function () { return BASE; },
    /* 纯函数 (可显式传 base, 便于判据) */
    fnv1a: fnv1a,
    hash01: hash01,
    makeRng: makeRng,
    gauss: gauss,
    truncNormal: truncNormal,
    clamp: clamp,
    intNormal: intNormal,
    weightedPick: weightedPick,
    generateCharacter: generateCharacter,
    generateBatch: generateBatch,
    buildDict: buildDict,
    buildPayload: buildPayload,
    /* V8 出口 (用注入的 BASE) */
    batchJson: batchJson,
    oneJson: oneJson,
    constantsJson: constantsJson,
  };

  /* ========================= 地图人物分布: 战力 / 小队 (方案 v2) =========================
   * 为什么放在这里: 「战力」要从角色六维/资源算, 而六维只有本文件知道怎么派生。
   * 落人格在**另一个 VM** (核心 VM, 有骨架/地形) —— 两个 V8 各管一段, 经 C# 拼装。
   * ===================================================================================== */

  /** 战力: **只看基本属性与资源** (Q3: 开局人人是筑基、演化未接, 故不吃境界)。
   *  ⚠ 纯展示口径, 不改任何既有字段; 接上 SectCultivation 后再补「境界绝对优先」项。 */
  function powerOf(ch) {
    var a = ch.attributes || {}, rs = ch.resources || {};
    var v = 3.0 * (a.shenshi || 0) + 2.0 * (a.gengu || 0) + 1.5 * (a.wuxing || 0)
          + 1.5 * (a.xinjing || 0) + 1.0 * (a.qiyun || 0) + 1.0 * (a.meili || 0)
          + 0.5 * (rs.qi || 0) + 0.25 * (rs.qixue || 0) + 0.33 * (rs.jingshen || 0);
    return Math.max(1, Math.round(v));
  }

  /** 单人摘要 (小队列表里显示代表/成员用)。 */
  function personBrief(ch, index) {
    return {
      index: index, id: ch.id, name: ch.name.full,
      gender: ch.gender, age: ch.age,
      realm: ch.realm.name, stage: ch.realm.stage,
      power: powerOf(ch),
    };
  }

  /** 小队切分: n 个人按 **1~12 人**一组 (Q4「单位就是小队; 单人 = 规模 1 的小队」)。
   *  纯派生 —— 同一 (seed, base, n) 结果逐项一致。 */
  function splitSquads(seed, base, n) {
    var out = [], k = 0, guard = 0;
    while (k < n && guard++ < 4096) {
      var sz = 1 + Math.floor(hash01(seed, 'sq', base, k) * 12);   // 1~12
      if (sz > n - k) sz = n - k;
      if (sz < 1) sz = 1;
      out.push({ from: k, size: sz });
      k += sz;
    }
    return out;
  }

  /** [V8] 单格小队列表 (点击详情): { n, ps, squads:[{id,size,power,rep}] } —— 按战力降序。 */
  function squadBatchJson(seed, base, n) {
    ensureReady();
    n = n | 0;
    if (n <= 0) return JSON.stringify({ n: 0, ps: 0, squads: [] });
    if (n > 64) n = 64;                          // 与引擎 PPL_CAP 对齐
    var chars = [], i, j;
    for (i = 0; i < n; i++) chars.push(generateCharacter(BASE, { index: base + i, seed: seed }));
    var parts = splitSquads(seed, base, n), squads = [], ps = 0;
    for (i = 0; i < parts.length; i++) {
      var p = parts[i], sum = 0, rep = null, repIdx = 0;
      for (j = 0; j < p.size; j++) {
        var idx = base + p.from + j, pw = powerOf(chars[p.from + j]);
        sum += pw;
        if (rep === null || pw > rep.power) { rep = { power: pw, ch: chars[p.from + j] }; repIdx = idx; }
      }
      ps += sum;
      squads.push({ id: 'sq-' + base + '-' + p.from, size: p.size, power: sum,
                    rep: personBrief(rep.ch, repIdx) });
    }
    squads.sort(function (a, b) { return b.power - a.power; });
    return JSON.stringify({ n: n, ps: ps, squads: squads });
  }

  /** [V8] 批量战力合计 (区块热力图): 入参 = [[base,n],…] ⇒ { sums:[…] } 同序。
   *  ⚠ 只回战力合计, 不回身份 —— 热力图用不到「谁」, 少生成一堆名字/功法。 */
  function powerSumsJson(seed, pairsJson) {
    ensureReady();
    var pairs = [];
    try { pairs = typeof pairsJson === 'string' ? JSON.parse(pairsJson) : (pairsJson || []); }
    catch (e) { pairs = []; }
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var base = pairs[i][0], n = pairs[i][1] | 0, sum = 0;
      if (n > 64) n = 64;
      for (var k = 0; k < n; k++) sum += powerOf(generateCharacter(BASE, { index: base + k, seed: seed }));
      out.push(sum);
    }
    return JSON.stringify({ sums: out });
  }

  global.CultivatorGen = api;
  /* 地图人物分布 (方案 v2) 的出口 —— 单独挂, 与主 api 表分开, 便于判据按名取用。 */
  api.powerOf = powerOf;
  api.personBrief = personBrief;
  api.splitSquads = splitSquads;
  api.squadBatchJson = squadBatchJson;
  api.powerSumsJson = powerSumsJson;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // 兜底: CJS 环境
})(typeof globalThis !== 'undefined' ? globalThis : this);
