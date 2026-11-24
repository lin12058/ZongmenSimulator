/* ============================================================
 * crew-bridge.js — 小队数据契约层 (前后端唯一交接面)
 * ------------------------------------------------------------
 * 顶层就**两棵树** (2026-11-24 用户定案):
 *
 *   squad  小队  —— 有哪些人, 每个人在干什么
 *   bag    背包  —— 有哪些东西 (全队共用一套)
 *
 * ⚠ 与内部视图模型的区别:
 *   面板 (crew-panel.js) 为了少改 UI, 内部仍用平面的 { pawns[], jobs[], stash[48] }。
 *   本文件负责 **契约 ⇄ 内部** 的双向转换, 于是:
 *     · UI 一行不用动
 *     · 后端只按契约出/收 JSON, 不需要知道 stash 三个字
 *
 * 契约的可序列化承诺 (给后端):
 *   1. 属性是**源数据**, 不传派生值 (气血/攻击/防御/命中/闪避/负重 全部由前端现算)。
 *      realm / role / age / gender 是纯展示文本, 不参与任何公式。
 *   2. 装备用 **itemId 引用**, 物品本体只在 bag.items 里出现一次 (不重复搬运)。
 *      cell = 整数 ⇒ 在背包第 N 格; cell = null ⇒ 穿戴在某名成员身上 (或法宝队列里)。
 *   3. id 全局唯一且由服务端生成 (推荐前缀 srv-, 避免与前端自增 i1/i2 撞车)。
 *   4. 每条成员必须自带 activity (在干什么), 即使空闲也要给 kind='idle'。
 *
 * 公开接口 (window.CrewBridge):
 *   VERSION
 *   validate(contract)            → { ok, errors[], warnings[] }
 *                                   ⚠ 会**就地修正**个别字段 (越界/冲突的 cell → null),
 *                                     于是 hydrate 能接着用同一份对象; 要原样保留请先深拷贝。
 *   hydrate(contract)             → { ok, errors, warnings, state }   契约 → 内部
 *   dump(state)                   → contract                          内部 → 契约
 *   mount(contract)               → 校验 + 装载进面板 (不改 UI)
 *   patch(partial)                → 增量合并后重新装载
 *   onChange(fn)                  → 订阅玩家改数据 (equip/unequip/use/prio)
 *   autoMount(url)                → GET 契约并装载 (?crewapi=1 自动调用)
 *   getContract()                 → 当前面板数据的契约快照
 * ============================================================ */
(function (g) {
  'use strict';

  var VERSION = 1;

  /* 面板延迟取: 没加载 panel.js 时仍能用 validate/hydrate/dump 做纯逻辑测试 */
  function panel() { return g.CrewPanel || null; }
  function model() { return g.CrewModel || null; }

  var SLOTS = ['weapon', 'offhand', 'body', 'head', 'talisman'];

  /* 契约里保留但内部没有的字段 (since / note / kind), 往返时从上次契约里续上 */
  var lastContract = null;

  /* ---------------- 小工具 ---------------- */
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function num(x, d) { return typeof x === 'number' && isFinite(x) ? x : d; }
  function str(x, d) { return typeof x === 'string' ? x : (d == null ? '' : d); }

  /* ============================================================
   * 校验 —— 后端推来的东西先过这道, 别让坏数据把面板打崩
   *   error   : 拒绝装载 (缺关键字段 / 引用断了)
   *   warning : 修正后照装 (数值越界 / 冗余字段对不上, 以源数据重算为准)
   * ============================================================ */
  function validate(c) {
    var M = model();
    var errors = [], warnings = [];
    if (!isObj(c)) { errors.push('契约不是对象'); return { ok: false, errors: errors, warnings: warnings }; }
    if (!isObj(c.squad)) errors.push('缺少 squad');
    if (!isObj(c.bag)) errors.push('缺少 bag');
    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    var members = c.squad.members;
    if (!Array.isArray(members) || !members.length) errors.push('squad.members 必须是非空数组');

    var items = c.bag.items;
    if (!Array.isArray(items)) errors.push('bag.items 必须是数组');

    if (errors.length) return { ok: false, errors: errors, warnings: warnings };

    var bagCap = num(c.bag.capacity, M ? M.CFG.STASH_COLS * M.CFG.STASH_ROWS : 48);

    /* ---- 物品: id 唯一 / cell 不冲突 ---- */
    var byId = {}, cellUsed = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!isObj(it)) { errors.push('bag.items[' + i + '] 不是对象'); continue; }
      if (!it.id) { errors.push('bag.items[' + i + '] 缺 id'); continue; }
      if (byId[it.id]) { errors.push('物品 id 重复: ' + it.id); continue; }
      byId[it.id] = 1;
      if (!it.name && !it.n) warnings.push('物品 ' + it.id + ' 缺 name');
      if (it.cell != null) {
        var ci = Math.round(num(it.cell, -1));
        if (!(ci >= 0 && ci < bagCap)) {
          warnings.push('物品 ' + it.id + ' 的 cell 越界(' + it.cell + '), 改为自动排');
          it.cell = null;
        } else if (cellUsed[ci]) {
          /* ⚠ 格位冲突只能降级成 warning: 后端两次 patch 之间必然存在瞬时冲突
             (把 A 挪到 B 的格子, 再让 B 走开), 若判 error 会让整份存档都装不进去。 */
          warnings.push('格 ' + ci + ' 被两件物品占用 (' + cellUsed[ci] + ' / ' + it.id + '), 后到者自动找空格');
          it.cell = null;
        } else {
          cellUsed[ci] = it.id;
        }
      }
    }

    /* ---- 成员 ---- */
    var mid = {};
    for (var m = 0; m < members.length; m++) {
      var p = members[m], tag = 'members[' + m + ']';
      if (!isObj(p)) { errors.push(tag + ' 不是对象'); continue; }
      if (!p.id) { errors.push(tag + ' 缺 id'); continue; }
      if (mid[p.id]) { errors.push('成员 id 重复: ' + p.id); continue; }
      mid[p.id] = 1;
      tag = p.name || p.id;

      /* 灵根 */
      if (!isObj(p.root) || !Array.isArray(p.root.v)) { errors.push(tag + ': 缺 root.v'); continue; }
      if (p.root.v.length !== 5) errors.push(tag + ': root.v 必须 5 项');
      var rs = 0;
      for (var r = 0; r < p.root.v.length; r++) rs += num(p.root.v[r], 0);
      if (rs !== (M ? M.CFG.ROOT_SUM : 100)) {
        warnings.push(tag + ': 灵根合计 ' + rs + ' (应为 ' + (M ? M.CFG.ROOT_SUM : 100) + '), 按比例归一到 100');
      }

      /* 天赋: 六道 × 6 项 */
      var tv = isObj(p.talents) && isObj(p.talents.v) ? p.talents.v : null;
      if (!tv) { errors.push(tag + ': 缺 talents.v'); continue; }
      var daoKeys = M ? M.DAO.map(function (d) { return d.k; }) : ['body', 'qi', 'mind', 'gear', 'pill', 'array'];
      var sum = 0;
      for (var d = 0; d < daoKeys.length; d++) {
        var arr = tv[daoKeys[d]];
        if (!Array.isArray(arr)) { errors.push(tag + ': talents.v.' + daoKeys[d] + ' 缺失'); continue; }
        if (arr.length !== 6) warnings.push(tag + ': ' + daoKeys[d] + ' 应有 6 项, 实际 ' + arr.length);
        for (var t = 0; t < arr.length; t++) sum += num(arr[t], 0);
      }
      var declared = num(p.talents && p.talents.total, -1);
      if (declared >= 0 && declared !== sum) {
        warnings.push(tag + ': talents.total 声明 ' + declared + ' ≠ 实际合计 ' + sum + ' (以实际为准)');
      }
      if (M && (sum < M.CFG.TALENT_MIN || sum > M.CFG.TALENT_MAX)) {
        warnings.push(tag + ': 天赋总量 ' + sum + ' 超出 ' + M.CFG.TALENT_MIN + '~' + M.CFG.TALENT_MAX);
      }

      /* 特质 */
      if (!Array.isArray(p.traits)) { errors.push(tag + ': 缺 traits'); continue; }
      if (M && (p.traits.length < M.CFG.TRAIT_MIN || p.traits.length > M.CFG.TRAIT_MAX)) {
        warnings.push(tag + ': 特质 ' + p.traits.length + ' 条 (应为 ' + M.CFG.TRAIT_MIN + '~' + M.CFG.TRAIT_MAX + ')');
      }
      var pairSeen = {};
      for (var q = 0; q < p.traits.length; q++) {
        var tn = isObj(p.traits[q]) ? p.traits[q].n : p.traits[q];
        if (!tn) { errors.push(tag + ': 特质缺 n'); continue; }
        var def = M && M.TRAITS ? M.TRAITS[tn] : null;
        if (M && !def) warnings.push(tag + ': 特质「' + tn + '」不在表内, 只显示不生效');
        else if (def) {
          if (pairSeen[def.pair]) errors.push(tag + ': 特质正反同现 (' + tn + ')');
          pairSeen[def.pair] = 1;
        }
      }

      /* 装备引用 */
      var eq = p.equip || {};
      for (var s = 0; s < SLOTS.length; s++) {
        var ref = eq[SLOTS[s]];
        if (ref == null) continue;
        if (!byId[ref]) errors.push(tag + ': 槽位 ' + SLOTS[s] + ' 引用了不存在的物品 ' + ref);
      }
      if (!Array.isArray(p.queue)) warnings.push(tag + ': 缺 queue, 按空队列处理');
      else {
        for (var k = 0; k < p.queue.length; k++) {
          if (!byId[p.queue[k]]) errors.push(tag + ': 法宝队列引用了不存在的物品 ' + p.queue[k]);
        }
        if (M && (p.queue.length < M.CFG.TALISMAN_MIN || p.queue.length > M.CFG.TALISMAN_MAX)) {
          warnings.push(tag + ': 法宝队列 ' + p.queue.length + ' 件 (应为 ' + M.CFG.TALISMAN_MIN + '~' + M.CFG.TALISMAN_MAX + ')');
        }
        if (p.queue.length && eq.talisman && eq.talisman !== p.queue[0]) {
          warnings.push(tag + ': equip.talisman 与 queue[0] 不一致, 以 queue[0] 为准');
        }
      }

      /* 神通 */
      var arts = p.arts && p.arts.slots;
      if (!Array.isArray(arts)) warnings.push(tag + ': 缺 arts.slots, 按空处理');
      else if (M && (arts.length < M.CFG.ART_MIN || arts.length > M.CFG.ART_MAX)) {
        warnings.push(tag + ': 神通 ' + arts.length + ' 格 (应为 ' + M.CFG.ART_MIN + '~' + M.CFG.ART_MAX + ')');
      }

      /* 修为 / 气血 */
      var expMax = 600 + Math.round(sum * 6);
      var exp = num(p.exp, -1);
      if (exp < 0) warnings.push(tag + ': 缺 exp, 按 0 处理');
      else if (exp === 0) warnings.push(tag + ': exp = 0 (探测会判越界, 面板按 0% 显示)');
      else if (exp > expMax) warnings.push(tag + ': exp ' + exp + ' 超过上限 ' + expMax + ', 前端会截断');
      if (isObj(p.vit)) {
        if (num(p.vit.hp, -1) < 0) warnings.push(tag + ': vit.hp 非法');
        if (num(p.vit.mp, -1) < 0) warnings.push(tag + ': vit.mp 非法');
      } else {
        warnings.push(tag + ': 缺 vit, 按满血处理');
      }

      /* 在干什么 */
      if (!isObj(p.activity)) warnings.push(tag + ': 缺 activity (在干什么), 按空闲处理');
      else if (!p.activity.kind) warnings.push(tag + ': activity.kind 缺省为 idle');
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ============================================================
   * hydrate —— 契约 → 内部视图模型
   *   物品以 bag.items 为唯一真源, 先建索引, 再按 itemId 解析到槽位。
   *   同一件物品只实例化**一次**, 于是内部天然没有"两份副本"的问题。
   * ============================================================ */
  function hydrate(c) {
    var M = model();
    var v = validate(c);
    var out = { ok: v.ok, errors: v.errors, warnings: v.warnings, state: null };
    if (!v.ok || !M) return out;

    var bagCap = M.CFG.STASH_COLS * M.CFG.STASH_ROWS;

    /* 1. 物品实例表 (id → 内部 item) */
    var index = {};
    var items = c.bag.items || [];
    var autoCell = 0;
    for (var i = 0; i < items.length; i++) {
      var src = items[i];
      var it = {
        id: src.id,
        n: str(src.name || src.n),
        kind: str(src.kind, 'material'),
        ch: str(src.ch, str(src.name || src.n).charAt(0) || '物'),
        q: Math.max(1, Math.min(6, Math.round(num(src.q, 1)))),
        w: num(src.w, 0),
        atk: num(src.atk, 0), def: num(src.def, 0), acc: num(src.acc, 0),
        hp: num(src.hp, 0), mp: num(src.mp, 0), heal: num(src.heal, 0),
        qty: Math.max(1, Math.round(num(src.qty, 1))),
        qtyMax: Math.max(1, Math.round(num(src.qtyMax, 1)))
      };
      index[it.id] = it;
    }

    /* 2. 背包格子: 有 cell 的按位放, 没 cell 的依次补空位 */
    var stash = new Array(bagCap).fill(null);
    var overflow = [];
    for (var j = 0; j < items.length; j++) {
      var s2 = items[j], inst = index[s2.id];
      if (!inst) continue;
      if (s2.cell != null) {
        var ci = Math.round(num(s2.cell, -1));
        if (ci >= 0 && ci < bagCap && !stash[ci]) stash[ci] = inst;
        else overflow.push(inst);
      } else if (!isWorn(c, s2.id)) {
        overflow.push(inst);      // 不穿戴也没格子 ⇒ 需要补位
      }
      /* 穿戴中的物品不进 stash (与内部"对象搬移"语义一致) */
    }
    for (var o = 0; o < overflow.length; o++) {
      var placed = false;
      while (autoCell < bagCap && !placed) {
        if (!stash[autoCell]) { stash[autoCell] = overflow[o]; placed = true; }
        autoCell++;
      }
      if (!placed) out.warnings.push('背包溢出: ' + overflow[o].n + ' 未放入 (容量 ' + bagCap + ')');
    }

    /* 3. 成员 */
    var daoKeys = M.DAO.map(function (d) { return d.k; });
    var pawns = [];
    for (var m = 0; m < c.squad.members.length; m++) {
      var src2 = c.squad.members[m];

      /* 灵根归一 (合计必须 100) */
      var rv = [], rsum = 0, k;
      for (k = 0; k < 5; k++) { rv.push(Math.round(num(src2.root.v[k], 0))); rsum += rv[k]; }
      if (rsum !== M.CFG.ROOT_SUM) {
        if (rsum <= 0) rv = [20, 20, 20, 20, 20];
        else {
          var acc = 0, scaled = [];
          for (k = 0; k < 5; k++) { scaled.push(Math.round(rv[k] / rsum * M.CFG.ROOT_SUM)); acc += scaled[k]; }
          scaled[0] += M.CFG.ROOT_SUM - acc;
          rv = scaled;
        }
      }

      /* 天赋 (每道补齐 6 项) */
      var tv2 = {}, total = 0;
      for (var d2 = 0; d2 < daoKeys.length; d2++) {
        var raw = (src2.talents.v[daoKeys[d2]] || []).slice(0, 6);
        while (raw.length < 6) raw.push(0);
        var row = [];
        for (var t2 = 0; t2 < 6; t2++) {
          var x = Math.max(0, Math.min(M.CFG.TALENT_CAP, Math.round(num(raw[t2], 0))));
          row.push(x); total += x;
        }
        tv2[daoKeys[d2]] = row;
      }

      /* 特质: 名字对不上表的保留显示 (但不会生效), 这是有意的 */
      var traits = [];
      for (var tr = 0; tr < src2.traits.length; tr++) {
        var tn2 = isObj(src2.traits[tr]) ? src2.traits[tr].n : src2.traits[tr];
        if (!tn2) continue;
        var dflt = M.TRAITS[tn2];
        traits.push(dflt ? { n: dflt.n, v: dflt.v || '', kind: dflt.kind, pair: dflt.pair }
                         : { n: tn2, v: isObj(src2.traits[tr]) ? str(src2.traits[tr].v) : '', kind: 'pos', pair: 'custom-' + tn2 });
      }

      /* 装备: itemId → 实例 */
      var gear = { weapon: null, offhand: null, body: null, head: null, talisman: null };
      for (var s3 = 0; s3 < SLOTS.length; s3++) {
        var ref2 = src2.equip ? src2.equip[SLOTS[s3]] : null;
        gear[SLOTS[s3]] = ref2 && index[ref2] ? index[ref2] : null;
      }
      var queue = [];
      var qsrc = Array.isArray(src2.queue) ? src2.queue : [];
      for (var qi = 0; qi < qsrc.length; qi++) if (index[qsrc[qi]]) queue.push(index[qsrc[qi]]);
      /* 法宝槽必须等于队列首位 (内部不变量) */
      gear.talisman = queue.length ? queue[0] : gear.talisman;
      if (gear.talisman && queue.indexOf(gear.talisman) < 0) queue.unshift(gear.talisman);

      /* 神通 */
      var artSlots = [];
      var asrc = (src2.arts && src2.arts.slots) || [];
      for (var ai = 0; ai < asrc.length; ai++) {
        var a = asrc[ai];
        if (!isObj(a) || !a.n) continue;
        artSlots.push({ n: a.n, rank: Math.round(num(a.rank, 1)), cost: Math.round(num(a.cost, 1)) });
      }

      /* 在干什么 → 内部 job */
      var act = src2.activity || {};
      var jobId = typeof act.jobId === 'string' && M.jobById(act.jobId) ? act.jobId : null;
      var job = jobId
        ? { jobId: jobId, task: str(act.taskName, (M.jobById(jobId) || {}).n || '劳作'),
            progress: Math.max(0, Math.min(100, num(act.progress, 0))), done: Math.max(0, Math.round(num(act.done, 0))) }
        : null;

      /* 优先级矩阵 */
      var prio = {};
      if (isObj(src2.prio)) {
        for (var pk in src2.prio) {
          if (!Object.prototype.hasOwnProperty.call(src2.prio, pk)) continue;
          var pv = Math.round(num(src2.prio[pk], 0));
          prio[pk] = (pv >= 1 && pv <= 4) ? pv : 0;
        }
      }
      if (!Object.keys(prio).length) {
        for (var jj = 0; jj < M.JOBS.length; jj++) prio[M.JOBS[jj].id] = 0;
      }

      var pawn = {
        id: src2.id,
        name: str(src2.name, src2.id),
        role: str(src2.role, '弟子'),
        age: Math.round(num(src2.age, 20)),
        gender: str(src2.gender, '男'),
        realm: str(src2.realm, '炼气期 · 1 层'),
        exp: Math.max(0, Math.round(num(src2.exp, 1))),
        root: { order: M.ELEMENTS.map(function (e) { return e.k; }), v: rv, main: Math.round(num(src2.root.main, 0)) || 0 },
        talents: { v: tv2, total: total },
        traits: traits,
        gear: gear,
        queue: queue,
        queueFrom: str(src2.queueFrom, queue.length > 1 ? '分神 ' + (queue.length - 1) : '本命一件'),
        arts: { slots: artSlots, cap: Math.round(num(src2.arts && src2.arts.cap, artSlots.length)), from: str(src2.arts && src2.arts.from, '本命三格') },
        mood: Math.max(0, Math.min(100, Math.round(num(src2.mood, 70)))),
        job: job,
        prio: prio
      };

      /* 当前气血/灵力: 上限由 attrs 现算, 这里只存当前值 */
      var vit = isObj(src2.vit) ? src2.vit : null;
      if (vit) {
        pawn.vit = { hp: Math.round(num(vit.hp, 0)), mp: Math.round(num(vit.mp, 0)) };
      }
      pawns.push(pawn);
    }

    /* 4. 副作用: 修 vit 到上限内 (attrs 需要完整 pawn) */
    for (var pi = 0; pi < pawns.length; pi++) {
      var pv0 = pawns[pi];
      if (!pv0.vit) continue;
      var aa = M.attrs(pv0);
      pv0.vit.hp = Math.max(0, Math.min(aa.hp, pv0.vit.hp));
      pv0.vit.mp = Math.max(0, Math.min(aa.mp, pv0.vit.mp));
    }

    out.state = {
      revision: num(c.revision, 0),
      squadId: str(c.squad.id, 'squad-1'),
      squadName: str(c.squad.name, '小队'),
      capacity: Math.round(num(c.squad.capacity, M.CFG.STASH_ROWS)),
      pawns: pawns,
      jobs: (Array.isArray(c.jobs) && c.jobs.length) ? c.jobs : M.JOBS.slice(),
      stash: stash,
      tickAt: 0
    };
    lastContract = JSON.parse(JSON.stringify(c));
    return out;
  }

  function isWorn(c, itemId) {
    var ms = (c.squad && c.squad.members) || [];
    for (var i = 0; i < ms.length; i++) {
      var eq = ms[i].equip || {};
      for (var s = 0; s < SLOTS.length; s++) if (eq[SLOTS[s]] === itemId && itemId) return true;
      if (Array.isArray(ms[i].queue) && ms[i].queue.indexOf(itemId) >= 0) return true;
    }
    return false;
  }

  /* ============================================================
   * dump —— 内部视图模型 → 契约
   *   物品全量列出 (格中 + 身上), 格中的给 cell, 身上的给 cell=null + wornBy。
   * ============================================================ */
  function dump(state) {
    if (!state || !state.pawns) return null;
    var M = model();

    /* 1. 收集物品: 背包格 + 每人身上 + 法宝队列 (按 id 去重, 只导一次) */
    var seen = {}, items = [], inBag = {};

    function pushItem(it, cell, wornBy) {
      if (!it || !it.id || seen[it.id]) return;
      seen[it.id] = 1;
      items.push({
        id: it.id, cell: cell == null ? null : cell, wornBy: wornBy || null,
        name: it.n, kind: it.kind, ch: it.ch, q: it.q, w: it.w,
        atk: it.atk, def: it.def, acc: it.acc, hp: it.hp, mp: it.mp, heal: it.heal,
        qty: it.qty, qtyMax: it.qtyMax
      });
    }

    for (var i = 0; i < state.stash.length; i++) {
      var it = state.stash[i];
      if (!it) continue;
      inBag[it.id] = i;
      pushItem(it, i, null);
    }
    for (var p = 0; p < state.pawns.length; p++) {
      var pw = state.pawns[p];
      for (var s = 0; s < SLOTS.length; s++) pushItem(pw.gear[SLOTS[s]], null, pw.id);
      for (var q = 0; q < pw.queue.length; q++) pushItem(pw.queue[q], null, pw.id);
    }

    /* 2. 成员 */
    var oldMembers = {};
    if (lastContract && lastContract.squad && lastContract.squad.members) {
      for (var om = 0; om < lastContract.squad.members.length; om++) {
        oldMembers[lastContract.squad.members[om].id] = lastContract.squad.members[om];
      }
    }

    var members = [];
    for (var m = 0; m < state.pawns.length; m++) {
      var pm = state.pawns[m];
      var eqId = {};
      for (var s2 = 0; s2 < SLOTS.length; s2++) {
        var gi = pm.gear[SLOTS[s2]];
        eqId[SLOTS[s2]] = gi && gi.id ? gi.id : null;
      }
      var qIds = [];
      for (var q2 = 0; q2 < pm.queue.length; q2++) if (pm.queue[q2] && pm.queue[q2].id) qIds.push(pm.queue[q2].id);

      /* activity: 内部只有 job, kind/since/note 从旧契约续 */
      var oldAct = oldMembers[pm.id] && oldMembers[pm.id].activity ? oldMembers[pm.id].activity : {};
      var job = pm.job;
      var activity = {
        kind: job && job.jobId ? 'work' : (oldAct.kind && !job ? oldAct.kind : 'idle'),
        jobId: job ? (job.jobId || null) : null,
        taskName: job ? str(job.task, '') : (oldAct.taskName || ''),
        progress: job ? Math.round(num(job.progress, 0)) : 0,
        done: job ? Math.round(num(job.done, 0)) : 0,
        since: num(oldAct.since, 0),
        note: str(oldAct.note, '')
      };
      /* 空闲时不该带旧的任务名 (否则界面会出现"空闲 · 采灵草") */
      if (activity.kind === 'idle') { activity.jobId = null; activity.taskName = ''; activity.progress = 0; }

      members.push({
        id: pm.id,
        name: pm.name,
        role: pm.role,
        gender: pm.gender,
        age: pm.age,
        realm: pm.realm,
        exp: pm.exp,
        mood: pm.mood,
        root: { order: pm.root.order.slice(), v: pm.root.v.slice(), main: pm.root.main },
        talents: { v: cloneTalents(pm.talents.v), total: pm.talents.total },
        traits: pm.traits.map(function (t) { return t.n ? { n: t.n } : t; }),
        equip: eqId,
        queue: qIds,
        queueFrom: pm.queueFrom,
        arts: { slots: pm.arts.slots.map(function (a) { return { n: a.n, rank: a.rank, cost: a.cost }; }),
                cap: pm.arts.cap, from: pm.arts.from },
        vit: { hp: pm.vit ? pm.vit.hp : 0, mp: pm.vit ? pm.vit.mp : 0 },
        activity: activity,
        prio: clonePrio(pm.prio)
      });
    }

    var out = {
      version: VERSION,
      revision: num(state.revision, 0),
      updatedAt: Date.now(),
      squad: {
        id: state.squadId || 'squad-1',
        name: state.squadName || '小队',
        capacity: state.capacity || (M ? M.CFG.STASH_ROWS : 8),
        members: members
      },
      bag: {
        capacity: state.stash.length,
        cols: M ? M.CFG.STASH_COLS : 6,
        rows: Math.round(state.stash.length / (M ? M.CFG.STASH_COLS : 6)),
        items: items
      },
      jobs: (state.jobs || []).map(function (j) { return { id: j.id, ch: j.ch, n: j.n, target: j.target, dao: j.dao }; })
    };
    lastContract = JSON.parse(JSON.stringify(out));
    return out;
  }

  function cloneTalents(v) {
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k].slice();
    return out;
  }
  function clonePrio(src) {
    var out = {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
    return out;
  }

  /* ============================================================
   * 装载 / 增量 / 事件
   * ============================================================ */
  function mount(c, opts) {
    var r = hydrate(c);
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings };
    var P = panel();
    if (!P) return { ok: false, errors: ['面板未加载 (window.CrewPanel 不存在)'], warnings: r.warnings, state: r.state };
    /* ⚠ 顺序要紧: 先关本地推进, 再 setSquad —— setSquad 里若面板已展开会立刻 startTick,
       那一帧就可能把后端刚给的 activity 派活覆盖掉。 */
    if (opts && typeof opts.localTick === 'boolean' && P.setLocalTick) P.setLocalTick(opts.localTick);
    P.setSquad(r.state);
    return { ok: true, errors: [], warnings: r.warnings, state: r.state };
  }

  /* 增量: 只做"字段级合并", 不做业务规则 (业务在前端模型里, 由 click 触发) */
  function patch(partial) {
    var base = lastContract;
    if (!base) return { ok: false, errors: ['还没有装载过契约, 无法增量'] };
    var next = JSON.parse(JSON.stringify(base));

    if (partial.squad) {
      if (partial.squad.name != null) next.squad.name = partial.squad.name;
      if (partial.squad.capacity != null) next.squad.capacity = partial.squad.capacity;
    }
    /* 成员 upsert */
    if (Array.isArray(partial.members)) {
      for (var i = 0; i < partial.members.length; i++) {
        var inc = partial.members[i], hit = -1;
        for (var j = 0; j < next.squad.members.length; j++) if (next.squad.members[j].id === inc.id) { hit = j; break; }
        if (hit >= 0) next.squad.members[hit] = deepMerge(next.squad.members[hit], inc);
        else next.squad.members.push(inc);
      }
    }
    if (Array.isArray(partial.removeMembers)) {
      next.squad.members = next.squad.members.filter(function (m) { return partial.removeMembers.indexOf(m.id) < 0; });
    }
    /* 物品 upsert */
    if (Array.isArray(partial.items)) {
      for (var k = 0; k < partial.items.length; k++) {
        var ii = partial.items[k], h2 = -1;
        for (var b = 0; b < next.bag.items.length; b++) if (next.bag.items[b].id === ii.id) { h2 = b; break; }
        if (h2 >= 0) next.bag.items[h2] = deepMerge(next.bag.items[h2], ii);
        else next.bag.items.push(ii);
      }
    }
    if (Array.isArray(partial.removeItems)) {
      next.bag.items = next.bag.items.filter(function (x) { return partial.removeItems.indexOf(x.id) < 0; });
    }
    next.revision = num(base.revision, 0) + 1;
    return mount(next);
  }

  function deepMerge(a, b) {
    if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }

  /* ---- 事件: 玩家改数据 → 后端要知道 ---- */
  var listeners = [];

  function emit(kind, detail) {
    var ev = { kind: kind, at: Date.now(), detail: detail || null, contract: null };
    for (var i = 0; i < listeners.length; i++) {
      try {
        /* 延迟到调用方用完栈再 dump, 避免事件里拿到半截状态 */
        (function (fn, e2) {
          setTimeout(function () {
            e2.contract = getContract();
            try { fn(e2); } catch (err) { console.error('[crew] onChange 抛错', err); }
          }, 0);
        })(listeners[i], ev);
      } catch (err) { console.error('[crew] onChange 失败', err); }
    }
  }

  function onChange(fn) {
    if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  /* 包装写操作: 面板里 `var M = g.CrewModel` 存的是对象引用,
     替换属性后它照样走包装版 —— UI 代码零改动。 */
  var wrapped = false;
  function wrapWrites() {
    if (wrapped) return;
    var M = model();
    if (!M) return;
    wrapped = true;
    var names = ['equip', 'unequip', 'useItem', 'cyclePriority'];
    var kinds = { equip: 'equip', unequip: 'unequip', useItem: 'use', cyclePriority: 'prio' };
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        var orig = M[name];
        if (typeof orig !== 'function') return;
        M[name] = function () {
          var res = orig.apply(M, arguments);
          if (res && res.ok !== false) {
            emit(kinds[name], { args: Array.prototype.slice.call(arguments, 0, 2), res: res });
          }
          return res;
        };
      })(names[i]);
    }
  }

  function getContract() {
    var P = panel();
    if (!P || !P.getState) return null;
    return dump(P.getState());
  }

  /* ---- 自动拉取: ?crewapi=1 → GET /api/crew ---- */
  function autoMount(url) {
    var u = url || '/api/crew';
    return fetch(u, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (c) {
        /* 从后台拿的数据一律关掉本地推进: 谁在干什么由服务端说了算 */
        var res = mount(c, { localTick: false });
        if (!res.ok) console.error('[crew] 契约装载失败', res.errors);
        else if (res.warnings.length) console.warn('[crew] 契约告警', res.warnings);
        return res;
      })
      .catch(function (e) { console.warn('[crew] 拉取小队数据失败: ' + e.message + ' (回落演示数据)'); return { ok: false, errors: [String(e)] }; });
  }

  g.CrewBridge = {
    VERSION: VERSION,
    validate: validate,
    hydrate: hydrate,
    dump: dump,
    mount: mount,
    patch: patch,
    onChange: onChange,
    getContract: getContract,
    autoMount: autoMount,
    wrapWrites: wrapWrites
  };

  /* 面板与模型都在时自动接管写操作 (不等外部调用) */
  if (model()) wrapWrites();

  /* ---- 演示/联调开关: ?crewapi=1 走后台数据, ?crewapi=/自定义 路径 ---- */
  (function () {
    if (typeof document === 'undefined') return;
    var q = (g.location && g.location.search) || '';
    var m = /[?&]crewapi=([^&]*)/.exec(q);
    if (!m) return;
    var url = m[1] && m[1] !== '1' ? decodeURIComponent(m[1]) : '/api/crew';
    function go() {
      /* 等面板 init 完 (它自己也在 DOMContentLoaded 上排队) 再覆盖 */
      setTimeout(function () {
        if (model()) wrapWrites();
        autoMount(url);
      }, 0);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  })();
})(typeof window !== 'undefined' ? window : globalThis);
