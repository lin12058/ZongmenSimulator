/* ============================================================
 * crew-panel.js — 小队 / 能力 / 背包 / 任务 面板 · 可热拔插
 * ------------------------------------------------------------
 * 2026-11-24 第三轮口径 (用户逐条):
 *   1. 去掉顶部小队头像条 (改为在「队伍」页点行切人)
 *   2. 队伍与能力的属性都排成**一行**
 *   3. 人物框要有「修为」
 *   4. 没有「个人背包」—— 只有**全局背包**, 且要能按类别筛选
 *   5. 页签「人物」改名为「能力」
 *
 * 四个页签:
 *   队伍 → 每人一行: 头像 + 姓名/职司/境界 + 六项属性(一行; 全队最高的打朱砂) + 神通
 *   能力 → 人物框(气血/灵力/心境/修为) + 六项属性(一行) + 装备栏 5 槽 + 底蕴(灵根/天赋/特质)
 *   背包 → 全局背包 6×8 (48 格) + 类别筛选 + 物品详情 (可装备给当前弟子)
 *   任务 → 弟子 × 工种 优先级矩阵
 *
 * ⚠ 与 main.js 零耦合: 只依赖 window.CrewModel 与自己注入的 crew-panel.css。
 * 公开接口: init/open/close/toggle/isOpen/select/setTab/setFilter/setSquad/getState/probe
 * 演示 URL: ?crew=1  ?crewtab=squad|ability|bag|work  ?crewcount=3..9  ?crewsec=1
 * ============================================================ */
(function (g) {
  'use strict';

  /* ⚠ 自己的 <script> 元素必须在**解析时**抓: 面板是 DOMContentLoaded 才 init 的,
     那时 document.currentScript 已是 null; 算空 base 会让 CSS 404 且控制台不报错。 */
  var SELF = (typeof document !== 'undefined') ? document.currentScript : null;

  var M = g.CrewModel;
  var S = g.ZMStore;
  var LS_NS = 'crew';

  /* 背包筛选: 键 → 允许的 kind 列表 (null = 全部) */
  var FILTERS = [
    { k: 'all', n: '全部', kinds: null },
    { k: 'weapon', n: '武器', kinds: ['weapon'] },
    { k: 'body', n: '衣甲', kinds: ['body'] },
    { k: 'head', n: '头饰', kinds: ['head'] },
    { k: 'offhand', n: '副手', kinds: ['offhand'] },
    { k: 'talisman', n: '法宝', kinds: ['talisman'] },
    { k: 'pill', n: '丹药', kinds: ['pill'] },
    { k: 'material', n: '材料', kinds: ['material'] },
    { k: 'book', n: '功法', kinds: ['book'] }
  ];

  var els = {};
  var state = null;
  var selId = null;
  var tab = 'squad';
  var filter = 'all';
  var isOpen = false;
  var inited = false;
  var tickTimer = 0;
  var lastTickAt = 0;
  /* 本地推进开关: 演示态(true) 自己跑任务进度/耗气血;
     接了后台数据必须关掉(false) —— 否则 step() 会给「空闲」的人自动派活,
     把后端下发的 activity 覆盖成前端编的。 */
  var localTick = true;
  var nowLive = null;
  var stashSel = null;         // 全局背包里选中的真实格号
  var secOpen = true;          // 能力页「底蕴」默认展开 (页签就叫能力)
  var panelCols = 11;
  var moveFor = null;          // 队伍页里点了「移」的那名弟子 (显示「移到」菜单)
  var delAsk = null;           // 等二次确认解散的小队 id
  var delAskTimer = 0;
  var flashTimer = 0;          // 跳转后高亮的复位定时器

  /* ---------- 小工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function pawnById(id) {
    if (!state) return null;
    for (var i = 0; i < state.pawns.length; i++) if (state.pawns[i].id === id) return state.pawns[i];
    return null;
  }
  function curPawn() { return pawnById(selId) || (state && state.pawns[0]) || null; }
  /* ⚠ 名字缺失时 charAt 会抛 TypeError, 而两页都是整页 innerHTML 赋值 ⇒ 一条脏数据让整页空白 (审查 D20) */
  function avChar(p) { return String((p && p.name) || '').charAt(0) || '?'; }
  function isMobile() { return !!(g.matchMedia && g.matchMedia('(max-width: 760px)').matches); }
  function qText(v) { return M.QUALITY[(v || 1) - 1] + '品'; }
  /* ⚠ 任何数值进来都先过 finite 兜底 (审查 D19): 缺 w 会显示「重 NaN」,
     缺 exp 会显示「修为 undefined/1000 (NaN%)」 */
  function numOr(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function wt(v) { return (Math.round(numOr(+v, 0) * 10) / 10).toFixed(1); }
  function fmt(n) { return String(numOr(n, 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- 样式注入 ---------- */
  function injectCss() {
    var sc = SELF || document.currentScript || (function () {
      var list = document.getElementsByTagName('script');
      for (var i = list.length - 1; i >= 0; i--) if (/crew-panel\.js/.test(list[i].src || '')) return list[i];
      return null;
    })();
    var base = '';
    if (sc && sc.src) base = sc.src.replace(/crew-panel\.js.*$/, '');
    if (!base) {
      var all = document.getElementsByTagName('script');
      for (var j = 0; j < all.length; j++) {
        if (/\/crew\/crew-panel\.js/.test(all[j].src || '')) { base = all[j].src.replace(/crew-panel\.js.*$/, ''); break; }
      }
    }
    if (document.querySelector('link[data-crew-css]')) return;
    var lk = document.createElement('link');
    lk.rel = 'stylesheet';
    lk.href = base + 'crew-panel.css';
    lk.setAttribute('data-crew-css', '1');
    lk.setAttribute('data-crew-base', base || 'EMPTY');
    document.head.appendChild(lk);
  }

  /* ---------- DOM 骨架 ---------- */
  function buildDom() {
    /* 入口 = 多个独立的横条 (一支小队一条, 从上到下堆叠), 选中的那条放大成 tab
       (2026-11-25 00:08 用户口径: 原来那条"复制多份", 每条后面跟本队人数) */
    var entry = document.createElement('div');
    entry.id = 'crewEntry';
    entry.className = 'crew-entry';
    entry.setAttribute('role', 'group');
    entry.setAttribute('aria-label', '小队 · 弟子录');
    entry.title = '点任意一条进入对应小队';
    entry.innerHTML = '<div class="ce-list" id="ceSqs"></div>';

    var mask = document.createElement('div');
    mask.id = 'crewMask';
    mask.className = 'crew-mask';

    var panel = document.createElement('aside');
    panel.id = 'crewPanel';
    panel.className = 'crew-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '小队 · 弟子录');
    panel.innerHTML =
      '<div class="crew-head">' +
        '<div class="crew-hd-l">' +
          '<span class="crew-cap">小队<b>·</b>弟子录</span>' +
          '<span class="crew-sub" id="crewSub">-</span>' +
        '</div>' +
        '<button class="crew-x" id="crewClose" type="button" aria-label="收起面板">✕</button>' +
      '</div>' +
      '<div class="crew-tabs" id="crewTabs">' +
        '<button type="button" data-tab="squad" class="on">队伍</button>' +
        '<button type="button" data-tab="ability">能力</button>' +
        '<button type="button" data-tab="bag">背包</button>' +
        '<button type="button" data-tab="work">任务</button>' +
      '</div>' +
      '<div class="crew-body">' +
        '<div class="crew-page on" data-page="squad" id="pgSquad"></div>' +
        '<div class="crew-page" data-page="ability" id="pgAbility"></div>' +
        '<div class="crew-page" data-page="bag" id="pgBag"></div>' +
        '<div class="crew-page" data-page="work" id="pgWork"></div>' +
      '</div>';

    document.body.appendChild(mask);
    document.body.appendChild(panel);
    document.body.appendChild(entry);

    els.entry = entry;
    els.sqs = entry.querySelector('#ceSqs');
    els.mask = mask;
    els.panel = panel;
    els.close = panel.querySelector('#crewClose');
    els.sub = panel.querySelector('#crewSub');
    els.tabs = panel.querySelector('#crewTabs');
    els.squad = panel.querySelector('#pgSquad');
    els.ability = panel.querySelector('#pgAbility');
    els.bag = panel.querySelector('#pgBag');
    els.work = panel.querySelector('#pgWork');

    /* 入口: 点任意一条 ⇒ 打开面板并跳到那一支小队 */
    entry.addEventListener('click', function (e) {
      var it = e.target.closest ? e.target.closest('.ce-item') : null;
      if (!isOpen) setOpen(true);
      if (it) jumpToSquad(it.getAttribute('data-sq'));
    });
    els.close.addEventListener('click', function () { setOpen(false); });
    mask.addEventListener('click', function () { setOpen(false); });

    els.tabs.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-tab]') : null;
      if (b) setTab(b.getAttribute('data-tab'));
    });

    /* 队伍页: 各小队段(点队头定位/删/建) + 行尾「移」调队 + 点行 → 切人进「能力」页 */
    els.squad.addEventListener('click', function (e) {
      if (eatClick()) return;                                   // 刚拖动过, 别把这次 click 当点击
      var t = e.target;
      var del = t.closest ? t.closest('[data-sqdel]') : null;
      if (del) { removeSquad(del.getAttribute('data-sqdel')); return; }
      if (t.closest && t.closest('[data-sqadd]')) { addSquad(); return; }
      var mv = t.closest ? t.closest('[data-mv]') : null;
      if (mv) { movePawnTo(mv.getAttribute('data-pawn'), mv.getAttribute('data-mv')); return; }
      var hd = t.closest ? t.closest('.sq-hd') : null;
      if (hd) { if (!hd.classList.contains('editing')) jumpToSquad(hd.getAttribute('data-sq')); return; }
      var mvBtn = t.closest ? t.closest('[data-act="mv"]') : null;
      if (mvBtn) { toggleMoveMenu(mvBtn.getAttribute('data-pawn')); return; }
      var row = t.closest ? t.closest('.rp-row') : null;
      if (!row) return;
      select(row.getAttribute('data-id'));
      setTab('ability');
    });
    /* 双击队头 → 就地改名 */
    els.squad.addEventListener('dblclick', function (e) {
      var hd = e.target.closest ? e.target.closest('.sq-hd') : null;
      if (hd && !e.target.closest('[data-sqdel]')) beginRename(hd.getAttribute('data-sq'));
    });

    /* 能力页: 装备槽 → 详情(卸下) / 内嵌背包 → 先选中看详情, 再点按钮换 / 用 */
    els.ability.addEventListener('click', function (e) {
      var qf = e.target.closest ? e.target.closest('[data-qf]') : null;
      if (qf) { filter = qf.getAttribute('data-qf'); stashSel = null; withQkScroll(renderAbilityPage); save(); return; }
      var qc = e.target.closest ? e.target.closest('.qk-cell[data-qkidx]') : null;
      if (qc) {
        stashSel = +qc.getAttribute('data-qkidx');
        withQkScroll(renderAbilityPage);
        var host = $('pcInfo');
        if (host) { try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (err) { /* noop */ } }
        return;
      }
      var wear = e.target.closest ? e.target.closest('.wear-slot') : null;
      if (wear && !wear.classList.contains('empty')) { showWearDetail(wear.getAttribute('data-slot')); return; }
      var secBtn = e.target.closest ? e.target.closest('[data-act="toggle-sec"]') : null;
      if (secBtn) { secOpen = !secOpen; withQkScroll(renderAbilityPage); return; }
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      var a = act.getAttribute('data-act');
      if (a === 'unequip') doUnequip(act.getAttribute('data-slot'));
      else if (a === 'equip') doEquip();
      else if (a === 'use') doUse();
    });

    /* 背包页: 筛选 / 格子 / 详情按钮 */
    els.bag.addEventListener('click', function (e) {
      var f = e.target.closest ? e.target.closest('.bf') : null;
      if (f) { filter = f.getAttribute('data-f'); stashSel = null; renderBagPage(); save(); return; }
      var cell = e.target.closest ? e.target.closest('.bag-cell[data-idx]') : null;
      if (cell) { stashSel = +cell.getAttribute('data-idx'); renderBagPage(); return; }
      var act = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!act) return;
      /* ⚠ 本页详情卡对丹药/功法就输出 data-act="use" (showStashDetail), 与能力页同一个按钮形状。
         旧实现只处理 equip/unequip ⇒ 点「服用 / 研习」直接落到 else 之外, 什么也不发生
         (不弹提示、不消耗、无任何反馈 —— 用户只会以为界面卡了)。 */
      var a = act.getAttribute('data-act');
      if (a === 'equip') doEquip();
      else if (a === 'unequip') doUnequip(act.getAttribute('data-slot'));
      else if (a === 'use') doUse();
    });

    /* 任务页: 优先级矩阵 */
    els.work.addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('.cw-cell') : null;
      if (!cell) return;
      var p = pawnById(cell.getAttribute('data-pawn'));
      var jid = cell.getAttribute('data-job');
      if (!p || !jid) return;
      var v = M.cyclePriority(p, jid);
      cell.className = 'cw-cell p' + v;
      cell.textContent = v === 0 ? '禁' : String(v);
      if (p.id === selId) renderNow();
      if (p.id !== selId) select(p.id);
      save();
    });
  }

  /* ---------- 开合 ---------- */
  function setOpen(v) {
    isOpen = !!v;
    els.panel.classList.toggle('open', isOpen);
    els.entry.classList.toggle('off', isOpen);
    /* ⚠ 审查 D23: 关闭态只有 opacity:0 ⇒ 看不见但还能 tab 进去、读屏也会念。
       aria-hidden 管无障碍树, inert 管 Tab 序列与点击 (老浏览器没有 inert 就只降级成 aria-hidden)。 */
    els.panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    if ('inert' in els.panel) els.panel.inert = !isOpen;
    syncMask();
    if (isOpen) { renderAll(); startTick(); } else stopTick();
  }
  function syncMask() { els.mask.classList.toggle('on', isOpen && isMobile()); }

  /* ---------- 演示推进 ---------- */
  function startTick() {
    if (tickTimer) return;
    lastTickAt = Date.now();
    tickTimer = setInterval(function () {
      if (!isOpen || document.hidden) { lastTickAt = Date.now(); return; }
      var now = Date.now();
      var dt = Math.min(1200, now - lastTickAt);
      lastTickAt = now;
      if (localTick) M.step(state, dt);   // 后台数据模式下不本地推进 (交给服务端)
      updateLive();
    }, 500);
  }
  function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = 0; } }

  /* ============================================================
   * 头行统计 (小队条已按用户要求删除 —— 概况全靠这一行)
   * 队伍页现在是「各小队纵向分段」, 不再有"当前队过滤" ⇒ 这里按**全宗**算
   * ============================================================ */
  function updateSub() {
    if (!state) return;
    var mood = 0, busy = 0;
    for (var i = 0; i < state.pawns.length; i++) {
      var p = state.pawns[i];
      mood += p.mood;
      if (p.job && p.job.jobId) busy++;
    }
    var nSq = state.squads ? state.squads.length : 1;
    els.sub.innerHTML = '<b>' + nSq + '</b> 支小队 · <b>' + state.pawns.length + '</b> 人 · 心境 <b>' +
      Math.round(mood / Math.max(1, state.pawns.length)) + '</b> · 在役 <b>' + busy +
      /* ⚠ 审查 D18: 头行是「全宗含背包」, 队头是「本队穿戴」—— 两个口径不能都叫「负重」 */
      '</b> · 全宗负重 <b>' + wt(M.teamWeight(state)) + '</b>';
  }

  /* ---------- 属性行: 六项一行 (队伍/能力共用形状, 只是字号不同) ---------- */
  function attrStrip(pawn, cls, teamMax) {
    var rows = M.attrRows(pawn), s = '';
    for (var i = 0; i < rows.length; i++) {
      var top = teamMax && rows[i].v === teamMax[rows[i].k];
      s += '<span class="' + cls + (top ? ' top' : '') + '" title="' + rows[i].n + '道（' + rows[i].d + '）' + rows[i].v +
        (top ? ' · 全队最高' : '') + '"><i>' + rows[i].n + '</i><b>' + rows[i].v + '</b></span>';
    }
    return s;
  }
  function teamMaxMap(list) {
    var out = {}, i, j, src = list || (state ? state.pawns : []);
    for (i = 0; i < M.ATTR_META.length; i++) out[M.ATTR_META[i].k] = -1;
    for (j = 0; j < src.length; j++) {
      var rows = M.attrRows(src[j]);
      for (i = 0; i < rows.length; i++) out[rows[i].k] = Math.max(out[rows[i].k], rows[i].v);
    }
    return out;
  }

  /* ============================================================
   * 页一: 队伍 (小队条 + 当前小队弟子)
   * ------------------------------------------------------------
   * 2026-11-24 第六轮 (用户逐条):
   *   · 入口条不再竖排「演武」—— 改成一条横线, 横排列出各小队名, 人数在最右
   *   · 会有多支小队 ⇒ 队伍页顶部一个小队条; 队名可改 (≤4 字), 默认「小队」
   *   · 两层都要能拖: 小队之间拖排序 + 队内弟子拖排序
   *   · 队员可在队间调动 (行尾 ⇄), 否则新建队永远空 — 不留假功能
   * ============================================================ */
  function curSquad() {
    if (!state) return null;
    var sqs = M.normalizeSquads(state);
    return M.squadById(state, state.curSquad) || sqs[0] || null;
  }

  function renderSquadPage() {
    if (!state) return;
    var sqs = M.normalizeSquads(state);
    var secs = '', i;
    for (i = 0; i < sqs.length; i++) secs += squadSectionHtml(sqs[i], sqs.length);
    els.squad.innerHTML =
      '<div class="sq-secs" id="sqSecs">' + secs + '</div>' +
      '<button type="button" class="sq-add2" data-sqadd="1" title="新建小队">＋ 新建小队</button>' +
      '<div class="rp-tip">拖队头上下 → 调小队顺序 ｜ 拖弟子行 → 调队内站位</div>';
    renderEntry();
    bindSortables();
  }

  /* 一名弟子 (各小队段共用; 行尾「移」把人和菜单挂在自己后面) */
  function rowHtml(p, max, sqId) {
    var arts = [], j;
    for (j = 0; j < p.arts.slots.length; j++) arts.push(p.arts.slots[j].n);
    var e = M.expOf(p), v = M.vitalOf(p);
    return '<div class="rp-row' + (p.id === selId ? ' cur' : '') + '" data-id="' + esc(p.id) + '" role="button" tabindex="0">' +
      '<span class="rp-av">' + esc(avChar(p)) + '</span>' +
      '<span class="rp-main">' +
        '<span class="rp-line"><b class="rp-n">' + esc(p.name) + '</b>' +
          '<em class="rp-meta">' + esc(p.role) + ' · ' + esc(p.realm) + '</em>' +
          '<span class="rp-exp">修为 ' + fmt(e.v) + '</span>' +
          '<button type="button" class="rp-mvb" data-act="mv" data-pawn="' + esc(p.id) + '" ' +
            'title="移到其他小队">移</button>' +
        '</span>' +
        '<span class="rp-attrs">' + attrStrip(p, 'ra', max) + '</span>' +
        /* 气血/灵力 (战斗会变) + 五个装备位的缩略图标 */
        '<span class="rp-line3">' +
          '<span class="rp-vit" title="气血 ' + v.hp + ' / ' + v.maxHp + '（' + v.hpPct + '%）">' +
            '<em>血</em><i><b style="width:' + v.hpPct + '%"></b></i><u>' + v.hp + '/' + v.maxHp + '</u></span>' +
          '<span class="rp-vit mp" title="灵力 ' + v.mp + ' / ' + v.maxMp + '（' + v.mpPct + '%）">' +
            '<em>灵</em><i><b style="width:' + v.mpPct + '%"></b></i><u>' + v.mp + '/' + v.maxMp + '</u></span>' +
          '<span class="rp-gear">' + gearIcons(p) + '</span>' +
        '</span>' +
        '<span class="rp-line2"><span class="rp-lb">功法</span>' +
          '<span class="rp-skills">' + esc(arts.join(' · ')) + '</span></span>' +
      '</span>' +
    '</div>' + (moveFor === p.id ? moveMenuHtml(p.id, state.squads, sqId) : '');
  }

  /* 一支小队 = 一段 (队头可拖动 / 双击改名 / × 解散), 段内是该队弟子 */
  function squadSectionHtml(sq, total) {
    var list = M.squadPawns(state, sq.id);
    var max = teamMaxMap(list), rows = '', i;
    for (i = 0; i < list.length; i++) rows += rowHtml(list[i], max, sq.id);
    return '<section class="sq-sec' + (sq.id === state.curSquad ? ' cur' : '') + '" data-sq="' + esc(sq.id) + '">' +
      '<header class="sq-hd" data-sq="' + esc(sq.id) + '" ' +
        'title="' + esc(sq.name + ' · ' + list.length + ' 人 · 双击改名 · 拖住队头上下排序') + '">' +
        '<span class="sq-grip" aria-hidden="true"></span>' +
        '<span class="sq-n">' + esc(sq.name) + '</span>' +
        '<em class="sq-c">' + list.length + ' 人</em>' +
        '<span class="sq-wt" title="只算本队穿戴，不含宗门背包">穿戴 ' + wt(M.teamWeight(list)) + '</span>' +
        (total > 1
          ? '<button type="button" class="sq-x' + (delAsk === sq.id ? ' ask' : '') + '" data-sqdel="' + esc(sq.id) + '" ' +
            'title="' + (delAsk === sq.id ? '再点一次确认解散' : '解散此小队（人回第一队）') + '">' +
            (delAsk === sq.id ? '确认' : '×') + '</button>'
          : '') +
      '</header>' +
      /* ⚠ 空队也必须留一个真的 .rp-list 容器 —— 否则「新建的空队」接不住拖进来的人
         (2026-11-25 用户: 小队为空的时候也要能移动进来) */
      '<div class="rp-list' + (list.length ? '' : ' empty') + '" data-sq="' + esc(sq.id) + '">' +
        rows +
        (list.length ? '' : '<div class="rp-empty sm">此队暂无弟子 · 把别队弟子拖进来，或点行尾「移」</div>') +
      '</div>' +
    '</section>';
  }

  /* ---------- 入口条: 每支小队一条横条, 从上到下; 选中的那条放大成 tab ----------
     ⚠ 点某一条 ⇒ 打开面板并滚到那一段 (用户 23:54/00:08 要求) */
  function renderEntry() {
    if (!state) return;
    var sqs = state.squads || [];
    if (els.sqs) {
      var h = '';
      for (var i = 0; i < sqs.length; i++) {
        var on = sqs[i].id === state.curSquad;
        h += '<button type="button" class="ce-item' + (on ? ' on' : '') + '" data-sq="' + esc(sqs[i].id) + '" ' +
          'title="' + esc(sqs[i].name + ' · ' + sqs[i].members.length + ' 人 · 点这里进这一队') + '">' +
          '<span class="ce-n">' + esc(sqs[i].name) + '</span>' +
          '<em class="ce-c">' + sqs[i].members.length + '</em>' +
        '</button>';
      }
      els.sqs.innerHTML = h;
    }
    if (els.entry) {
      els.entry.title = sqs.length + ' 支小队 / 共 ' + state.pawns.length + ' 人 · 点哪条进哪队';
    }
  }

  function moveMenuHtml(pid, sqs, curId) {
    var b = '', i;
    for (i = 0; i < sqs.length; i++) {
      if (sqs[i].id === curId) continue;
      b += '<button type="button" class="mv-b" data-pawn="' + esc(pid) + '" data-mv="' + esc(sqs[i].id) + '">' +
        esc(sqs[i].name) + '</button>';
    }
    return '<div class="rp-move"><span class="mv-k">移到</span>' + (b || '<em>只有这一支小队</em>') + '</div>';
  }

  /* ---------- 队伍页动作 ---------- */
  /* 跳到某一支小队那一段: 设当前队 + 高亮闪一下 + 滚到段首
     (入口条点队名、新建队、点队头都走这里) */
  /* ⚠ 审查 C4: 不要用 '.sq-sec[data-sq="' + id + '"]' 拼选择器 —— id 里带引号会抛
     SyntaxError, 整个点击处理直接失效; 渲染侧用了 esc(), 读写必须同一套。 */
  function findSec(id) {
    var list = els.squad ? els.squad.querySelectorAll('.sq-sec') : [];
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-sq') === id) return list[i];
    return null;
  }

  function jumpToSquad(id, noScroll) {
    if (!state || !M.squadById(state, id)) return;
    state.curSquad = id;
    moveFor = null;
    /* ⚠ 审查 C20: 原来只 renderEntry ⇒ 入口条亮新队、队伍页仍高亮旧队,
       只剩 1.5s 的 flash 短暂指认; 顺带清掉残留的「移到」菜单 (moveFor 已置空) */
    renderEntry();
    renderSquadPage();
    var sec = findSec(id);
    if (!sec) { save(); return; }
    var olds = els.squad.querySelectorAll('.sq-sec.flash');
    for (var i = 0; i < olds.length; i++) olds[i].classList.remove('flash');
    void sec.offsetWidth;                       // 强制 reflow, 连点同一条也能重放动画
    sec.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { sec.classList.remove('flash'); }, 1500);
    if (!noScroll && sec.scrollIntoView) {
      try { sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      catch (e) { sec.scrollIntoView(); }
    }
    save();
  }
  var switchSquad = jumpToSquad;                // 旧名保留 (验收/外部调用)

  function addSquad() {
    var sqs = M.normalizeSquads(state);
    if (sqs.length >= M.SQUAD_DEFAULT_NAMES.length) { toast('最多 ' + M.SQUAD_DEFAULT_NAMES.length + ' 支小队'); return; }
    var name = M.SQUAD_DEFAULT_NAMES[sqs.length];
    var id = 'sq' + Date.now().toString(36);
    sqs.push({ id: id, name: name, members: [] });
    state.curSquad = id;
    moveFor = null;
    updateSub();
    renderSquadPage();
    jumpToSquad(id);                            // 新建后直接滚到新段
    notifyEvent('squad.create', { name: name });
    toast('新建「' + name + '」 · 用弟子行尾的「移」把人调进来');
  }
  function removeSquad(id) {
    var sqs = M.normalizeSquads(state);
    if (sqs.length <= 1) { toast('至少保留一支小队'); return; }
    var at = -1, i;
    for (i = 0; i < sqs.length; i++) if (sqs[i].id === id) { at = i; break; }
    if (at < 0) return;
    /* 二次确认: 第一次点只把 × 变成「确认」, 免得手一抖把队拆了 */
    if (delAsk !== id) {
      delAsk = id;
      clearTimeout(delAskTimer);
      delAskTimer = setTimeout(function () { if (delAsk === id) { delAsk = null; renderSquadPage(); } }, 3000);
      renderSquadPage();
      toast('再点一次「确认」解散 · 人不会丢');
      return;
    }
    /* ⚠ 审查 C3: × 换成「确认」是原地改字、按钮右边缘不动 ⇒ 双击第二下直接命中这里。
       解法不是时间窗 (那会把正常操作也挡住), 而是**换位置**: 确认态按钮用 CSS order:-1
       跳到队头最左, 双击第二下落在原来的位置 (队名/空白) 上, 打不中。见 .sq-x.ask */
    delAsk = null;
    clearTimeout(delAskTimer);
    var gone = sqs.splice(at, 1)[0];
    for (i = 0; i < gone.members.length; i++) sqs[0].members.push(gone.members[i]);
    if (state.curSquad === id) state.curSquad = sqs[0].id;
    moveFor = null;
    updateSub();
    renderSquadPage();
    save();
    notifyEvent('squad.disband', { squadId: id, toSquadId: sqs[0].id });
    toast('已解散「' + gone.name + '」 · ' + gone.members.length + ' 人回到「' + sqs[0].name + '」');
  }
  /* 移空提示: 小队没人了, 背包不跟着消失 —— 全宗只有一份背包, 负重归 0 */
  function emptySquadNote(sq) {
    return '「' + sq.name + '」已空 · 负重 0（物品都在宗门背包，不会丢）';
  }
  function movePawnTo(pid, sqId, toPos) {
    M.normalizeSquads(state);
    var r = M.movePawn(state, pid, sqId, toPos == null ? null : toPos);
    moveFor = null;
    if (!r.ok) { renderSquadPage(); return; }
    updateSub();
    renderSquadPage();
    save();
    var to = M.squadById(state, r.to), from = M.squadById(state, r.from);
    if (r.same) toast('已调整站位');
    else toast('已移到「' + (to ? to.name : '?') + '」' +
      (r.fromEmpty && from ? ' · ' + emptySquadNote(from) : ''));
  }
  function toggleMoveMenu(pid) { moveFor = (moveFor === pid ? null : pid); renderSquadPage(); }

  /* 双击队头 → 就地改名 (≤4 字; 回车/失焦提交, Esc 取消) */
  function beginRename(sqId) {
    var sec = findSec(sqId);
    var sq = M.squadById(state, sqId);
    if (!sec || !sq) return;
    var n = sec.querySelector('.sq-hd .sq-n');
    if (!n) return;
    var inp = document.createElement('input');
    inp.className = 'sq-ed';
    inp.type = 'text';
    inp.maxLength = M.SQUAD_NAME_MAX;
    inp.value = sq.name;
    sec.querySelector('.sq-hd').classList.add('editing');
    n.style.display = 'none';
    n.parentNode.insertBefore(inp, n);
    inp.focus();
    inp.select();
    var done = function (commit) {
      if (!inp.parentNode) return;
      var v = M.squadName(inp.value);
      if (commit) sq.name = v;
      inp.parentNode.removeChild(inp);
      n.style.display = '';
      renderSquadPage();
      if (commit) {
        save();
        notifyEvent('squad.rename', { squadId: sqId, name: sq.name });
        toast('已改名为「' + sq.name + '」');
      }
    };
    inp.addEventListener('keydown', function (ev) {
      if (ev.isComposing) return;                      // 输入法选字时的回车不算提交
      if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      ev.stopPropagation();
    });
    inp.addEventListener('blur', function () { done(true); });
    inp.addEventListener('pointerdown', function (ev) { ev.stopPropagation(); });
    inp.addEventListener('click', function (ev) { ev.stopPropagation(); });
    inp.addEventListener('dblclick', function (ev) { ev.stopPropagation(); });
  }

  /* ============================================================
   * 拖动排序 (原生 pointer 事件, 鼠标 + 触摸通用)
   * ------------------------------------------------------------
   * · 鼠标: 移动过 5px 阈值就开拖 (不影响单击)
   * · 触摸: 先长按 220ms 才开拖, 否则当成滚页面
   * · 开拖后只在「越过相邻元素中线」时才真的挪 DOM, 不抖
   * · 松手读 DOM 顺序 → onDone(ids) 写回数据层
   * ⚠ 拖动结束浏览器还会补一次 click ⇒ eatClick() 吃掉, 否则一拖就跳进能力页
   * ============================================================ */
  var _drag = null, _eatClick = false, _eatTimer = 0, _eatAt = 0;
  /* 只吃「拖动松手后紧跟的那一次」click。
     ⚠ 审查 D22: 原实现就是一个 400ms 时间窗 (标志 + 定时器), 窗口内玩家点解散/切队也照样被吞。
        现在窗口收到 120ms —— 浏览器补发的 click 在同一任务后立即到达, 人手连点至少 200ms。 */
  function eatClick() {
    if (!_eatClick) return false;
    _eatClick = false;
    clearTimeout(_eatTimer);
    return Date.now() - _eatAt < 120;
  }
  function markEatClick() {
    _eatClick = true;
    _eatAt = Date.now();
    clearTimeout(_eatTimer);
    _eatTimer = setTimeout(function () { _eatClick = false; }, 120);
  }

  function bindSortables() {
    /* 小队段: 只有队头是拖动手柄 (否则拖弟子行会连整段一起挪) */
    var secs = $('sqSecs');
    if (secs) bindSort(secs, '.sq-sec', 'y', applySquadOrder, { handle: '.sq-hd' });
    /* 弟子行: 绑在整块 #sqSecs 上, 允许拖到**别的队**那一段 (2026-11-25) */
    bindPawnDrags(secs);
  }

  function bindSort(host, sel, axis, onDone, opts) {
    if (!host || host.__sortBound) return;
    host.__sortBound = true;
    var cls = sel.replace(/^\./, '');
    var handle = opts && opts.handle;
    host.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var it = e.target.closest ? e.target.closest(sel) : null;
      if (!it || it.parentNode !== host) return;
      if (e.target.closest('input, .sq-x, .sq-add2, .mv-b, .rp-mvb')) return;
      if (handle) {
        var h = e.target.closest(handle);
        if (!h || !it.contains(h)) return;          // 段内拖弟子行时不会命中这一段
      }
      var st = {
        el: it, host: host, cls: cls, axis: axis, x0: e.clientX, y0: e.clientY,
        id: e.pointerId, on: false, done: onDone, timer: 0
      };
      _drag = st;
      if (e.pointerType === 'mouse') return;                        // 鼠标交给 move 的阈值判定
      st.timer = setTimeout(function () { startDrag(st); }, 220);   // 触摸: 长按才拖
    });
  }

  /* ============================================================
   * 弟子行拖动: 队内换位 + 跨队搬运 (拖到另一段 = 换队)
   * ------------------------------------------------------------
   * · 目标段按指针 y 落在哪个 .sq-sec 判定, 松手才写数据
   * · 空队也渲染了真的 .rp-list ⇒ 新建的空队能接人 (2026-11-25)
   * · 位置 = 目标行中线; 落在段末 = 追加到队尾
   * ============================================================ */
  var _pDrag = null;

  function bindPawnDrags(secs) {
    if (!secs || secs.__pawnBound) return;
    secs.__pawnBound = true;
    secs.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var row = e.target.closest ? e.target.closest('.rp-row') : null;
      if (!row || !secs.contains(row)) return;
      /* 行内按钮 / 「移到」菜单 / 输入框都不是拖动起点 */
      if (e.target.closest('button, input, .rp-move')) return;
      var list = row.parentNode;
      if (!list || !list.getAttribute || !list.getAttribute('data-sq')) return;
      var st = {
        el: row, secs: secs, fromSq: list.getAttribute('data-sq'), toSq: null,
        x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false, timer: 0
      };
      _pDrag = st;
      if (e.pointerType === 'mouse') return;
      st.timer = setTimeout(function () { startPawnDrag(st); }, 220);
    });
  }

  function startPawnDrag(st) {
    if (!st || st.on || _pDrag !== st) return;
    st.on = true;
    /* 开拖就收起「移到」菜单, 免得它跟着行一起被搬走 */
    var mvs = st.secs.querySelectorAll('.rp-move');
    for (var i = 0; i < mvs.length; i++) if (mvs[i].parentNode) mvs[i].parentNode.removeChild(mvs[i]);
    moveFor = null;
    st.el.classList.add('dragging');
    document.body.classList.add('crew-sorting');
    try { st.secs.setPointerCapture(st.id); } catch (e) { /* noop */ }
  }

  function pawnDragMove(st, e) {
    var y = e.clientY, secsAll = st.secs.querySelectorAll('.sq-sec'), target = null, i;
    for (i = 0; i < secsAll.length; i++) {
      var r = secsAll[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { target = secsAll[i]; break; }
    }
    for (i = 0; i < secsAll.length; i++) secsAll[i].classList[secsAll[i] === target ? 'add' : 'remove']('drop');
    if (!target) return;                        // 拖到所有段之外: 不挪, 松手回原位
    var list = target.querySelector('.rp-list');
    if (!list) return;
    var hint = list.querySelector('.rp-empty');
    if (hint && hint.parentNode === list) list.removeChild(hint);
    if (st.el.parentNode !== list) list.appendChild(st.el);
    /* 段内按行中线让位 */
    var kids = [], k;
    for (k = 0; k < list.children.length; k++) {
      var c = list.children[k];
      if (c === st.el || !c.classList || !c.classList.contains('rp-row')) continue;
      kids.push(c);
    }
    var before = null;
    for (i = 0; i < kids.length; i++) {
      var rr = kids[i].getBoundingClientRect();
      if (y < rr.top + rr.height / 2) { before = kids[i]; break; }
    }
    if (before) {
      if (st.el.nextElementSibling !== before) list.insertBefore(st.el, before);
    } else {
      var last = kids[kids.length - 1];
      if (last && last.nextElementSibling !== st.el) list.insertBefore(st.el, last.nextSibling);
      else if (!last && list.lastElementChild !== st.el) list.appendChild(st.el);
    }
    st.toSq = list.getAttribute('data-sq');
  }

  function endPawnDrag(st) {
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    if (_pDrag === st) _pDrag = null;
    if (!st.on) return;
    st.on = false;
    st.el.classList.remove('dragging');
    document.body.classList.remove('crew-sorting');
    var drops = st.secs.querySelectorAll('.sq-sec.drop');
    for (var i = 0; i < drops.length; i++) drops[i].classList.remove('drop');
    try { st.secs.releasePointerCapture(st.id); } catch (e) { /* noop */ }
    markEatClick();                                    // 松手后浏览器补的 click 要吃掉
    applyPawnDrop(st);
  }

  /* 松手: 按 DOM 里各段的行序写回 members (位置 = 数组下标) */
  function applyPawnDrop(st) {
    var lists = st.secs.querySelectorAll('.sq-sec .rp-list'), i, j;
    var seen = {};
    for (i = 0; i < lists.length; i++) {
      var sq = M.squadById(state, lists[i].getAttribute('data-sq'));
      if (!sq) continue;
      var ids = [], rows = lists[i].querySelectorAll('.rp-row');
      for (j = 0; j < rows.length; j++) {
        var pid = rows[j].getAttribute('data-id');
        if (!pid || seen[pid]) continue;
        seen[pid] = 1; ids.push(pid);
      }
      sq.members = ids;
    }
    /* 兜底: 没落在任何列表里的人回第一队 —— 拖到段外也不许丢人 */
    var sqs = state.squads || [];
    for (i = 0; i < state.pawns.length; i++) {
      var pid2 = state.pawns[i].id;
      if (!seen[pid2]) { seen[pid2] = 1; if (sqs[0]) sqs[0].members.push(pid2); }
    }
    var from = M.squadById(state, st.fromSq), to = M.squadById(state, st.toSq);
    var emptied = !!(from && from.members.length === 0);
    /* §14.6: 一次拖动 = 一条 member.move, 只发被拖的那个人 */
    if (st.el && st.toSq) {
      var draggedId = st.el.getAttribute ? st.el.getAttribute('data-id') : null;
      var posOut = 0;
      for (i = 0; i < lists.length; i++) {
        if (lists[i].getAttribute('data-sq') !== st.toSq) continue;
        var rowsOut = lists[i].querySelectorAll('.rp-row');
        for (j = 0; j < rowsOut.length; j++) {
          if (rowsOut[j].getAttribute('data-id') === draggedId) { posOut = j; break; }
        }
        break;
      }
      if (draggedId) notifyEvent('member.move', { pawnId: draggedId, toSquadId: st.toSq, toPos: posOut });
    }
    updateSub();
    renderSquadPage();
    save();
    if (emptied) toast(emptySquadNote(from));
    else if (to && from && to.id !== from.id) toast('已移到「' + to.name + '」');
  }

  function startDrag(st) {
    if (!st || st.on || _drag !== st) return;
    st.on = true;
    st.el.classList.add('dragging');
    st.host.classList.add('sorting');
    document.body.classList.add('crew-sorting');
    try { st.host.setPointerCapture(st.id); } catch (e) { /* noop */ }
  }

  function dragMove(st, e) {
    var pos = st.axis === 'x' ? e.clientX : e.clientY, kids = [], i;
    for (i = 0; i < st.host.children.length; i++) {
      var k = st.host.children[i];
      if (k === st.el || !k.classList || !k.classList.contains(st.cls)) continue;
      kids.push(k);
    }
    var before = null;
    for (i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      var mid = st.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
      if (pos < mid) { before = kids[i]; break; }
    }
    if (before) {
      if (st.el.nextElementSibling !== before) st.host.insertBefore(st.el, before);
    } else if (kids.length) {
      var last = kids[kids.length - 1];
      if (last.nextElementSibling !== st.el) st.host.insertBefore(st.el, last.nextSibling);
    }
  }

  function endDrag(st) {
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    if (_drag === st) _drag = null;
    if (!st.on) return;
    st.on = false;
    st.el.classList.remove('dragging');
    st.host.classList.remove('sorting');
    document.body.classList.remove('crew-sorting');
    try { st.host.releasePointerCapture(st.id); } catch (e) { /* noop */ }
    markEatClick();                                    // 松手后浏览器补的那一次 click 要吃掉
    var ids = [], i;
    for (i = 0; i < st.host.children.length; i++) {
      var k = st.host.children[i];
      if (!k.classList || !k.classList.contains(st.cls)) continue;
      ids.push(st.cls === 'sq-sec' ? k.getAttribute('data-sq') : k.getAttribute('data-id'));
    }
    if (st.done) st.done(ids, st.host, st.el);
  }

  document.addEventListener('pointermove', function (e) {
    var st = _drag;
    if (!st || st.id !== e.pointerId) return;
    if (!st.on) {
      var d = Math.abs(e.clientY - st.y0) + Math.abs(e.clientX - st.x0);
      if (d < 5) return;
      if (e.pointerType === 'mouse') startDrag(st);
      else { if (st.timer) { clearTimeout(st.timer); st.timer = 0; } _drag = null; }  // 触摸先滑 = 滚屏
      return;
    }
    if (e.cancelable && e.preventDefault) e.preventDefault();
    dragMove(st, e);
  }, { passive: false });

  document.addEventListener('pointerup', function (e) {
    var st = _drag;
    if (st && st.id === e.pointerId) endDrag(st);
  });
  document.addEventListener('pointercancel', function (e) {
    var st = _drag;
    if (st && st.id === e.pointerId) endDrag(st);
  });

  /* 弟子行拖动 (跨队) 的全局指针跟踪 */
  document.addEventListener('pointermove', function (e) {
    var st = _pDrag;
    if (!st || st.id !== e.pointerId) return;
    if (!st.on) {
      var d = Math.abs(e.clientY - st.y0) + Math.abs(e.clientX - st.x0);
      if (d < 5) return;
      if (e.pointerType === 'mouse') startPawnDrag(st);
      else { if (st.timer) { clearTimeout(st.timer); st.timer = 0; } _pDrag = null; }
      if (!st.on) return;
    }
    if (e.cancelable && e.preventDefault) e.preventDefault();
    pawnDragMove(st, e);
  }, { passive: false });

  document.addEventListener('pointerup', function (e) {
    var st = _pDrag;
    if (st && st.id === e.pointerId) endPawnDrag(st);
  });
  document.addEventListener('pointercancel', function (e) {
    var st = _pDrag;
    if (st && st.id === e.pointerId) endPawnDrag(st);
  });

  /* 按给定顺序重排一支队 (外部/验收调用; 拖动走 applyPawnDrop)
     sqId 缺省 = 当前队; 只接受本队已有的人, 缺的人按原序补到末尾 */
  function applyPawnOrder(ids, sqId) {
    var sq = M.squadById(state, sqId) || curSquad();
    if (!sq) return;
    var next = [], i;
    for (i = 0; i < ids.length; i++) if (sq.members.indexOf(ids[i]) >= 0) next.push(ids[i]);
    for (i = 0; i < sq.members.length; i++) if (next.indexOf(sq.members[i]) < 0) next.push(sq.members[i]);
    sq.members = next;
    renderSquadPage();
    save();
  }
  function applySquadOrder(ids, host, el) {
    var list = [], i;
    for (i = 0; i < ids.length; i++) { var s = M.squadById(state, ids[i]); if (s) list.push(s); }
    for (i = 0; i < state.squads.length; i++) if (list.indexOf(state.squads[i]) < 0) list.push(state.squads[i]);
    state.squads = list;
    renderSquadPage();
    save();
    /* §14.6: 拖队头 = 1 条 squad.move (只发被拖的那一支, 不是整份顺序) */
    var movedId = el && el.getAttribute ? el.getAttribute('data-sq') : null;
    if (movedId) {
      for (i = 0; i < list.length; i++) {
        if (list[i].id === movedId) { notifyEvent('squad.move', { squadId: movedId, toIndex: i }); break; }
      }
    }
  }

  /* 五个装备位的缩略图标 (队伍页一行摆完); 空位用淡色槽名首字占位 */
  var WEAR_ORDER = ['weapon', 'offhand', 'body', 'head', 'talisman'];
  function gearIcons(p) {
    var s = '';
    for (var i = 0; i < WEAR_ORDER.length; i++) {
      var it = p.gear[WEAR_ORDER[i]];
      s += it
        ? '<i class="rp-g q' + it.q + '" title="' + esc(M.SLOT_NAMES[WEAR_ORDER[i]] + ' · ' + it.n) + '">' + esc(it.ch) + '</i>'
        : '<i class="rp-g none" title="' + esc(M.SLOT_NAMES[WEAR_ORDER[i]] + ' · 空') + '">' +
            esc(M.SLOT_NAMES[WEAR_ORDER[i]].charAt(0)) + '</i>';
    }
    return s;
  }

  /* ============================================================
   * 页二: 能力 (人物框 + 属性 + 装备栏 + 底蕴)
   * ============================================================ */
  function renderAbilityPage() {
    var p = curPawn();
    if (!p) { els.ability.innerHTML = '<div class="sec-empty">小队空无一人</div>'; return; }
    var a = M.attrs(p), e = M.expOf(p), v = M.vitalOf(p), i;

    /* 全部按「当前 / 上限」画百分比 —— 气血/灵力战斗会掉, 心境/修为本就有进度 */
    var bars =
      barRow('气血', v.hp, v.maxHp, '') +
      barRow('灵力', v.mp, v.maxMp, 'mp') +
      barRow('心境', p.mood, 100, 'mood') +
      barRow('修为', e.v, e.max, 'exp', fmt(e.v) + '/' + fmt(e.max));

    var hero =
      '<div class="pc-hero">' +
        '<div class="pc-av">' + esc(avChar(p)) + '</div>' +
        '<div class="pc-id">' +
          '<div class="pc-name">' + esc(p.name) + '</div>' +
          '<div class="pc-meta">' + esc(p.role) + ' · ' + esc(p.realm) + ' · ' + p.age + ' 岁 ' + esc(p.gender) + '</div>' +
          '<div class="pc-bars">' + bars + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="pc-attrs">' + attrStrip(p, 'pa', null) + '</div>' +
      /* 六道是「属性」, 攻防命闪是它派生出来的战斗值 —— 分两行摆, 别混成一个口径 */
      '<div class="pc-combat">' +
        '<span class="cb"><i>攻击</i><b>' + a.atk + '</b></span>' +
        '<span class="cb"><i>防御</i><b>' + a.def + '</b></span>' +
        '<span class="cb"><i>命中</i><b>' + a.hit + '</b></span>' +
        '<span class="cb"><i>闪避</i><b>' + a.dodge + '</b></span>' +
        '<span class="cb' + (M.overload(p) ? ' over' : '') + '"><i>负重</i><b>' + wt(M.weightOf(p)) + '/' + M.loadMax(p) + '</b></span>' +
      '</div>';

    /* 装备栏: 头 + 衣 在上排 (衣跨两格), 武/副/宝 下排 */
    var wear = '', order = ['head', 'body', 'weapon', 'offhand', 'talisman'];
    for (i = 0; i < order.length; i++) {
      var sk = order[i], it = p.gear[sk];
      wear += '<button type="button" class="wear-slot' + (it ? '' : ' empty') + '" data-slot="' + sk + '" ' +
        'title="' + esc(M.SLOT_NAMES[sk]) + (it ? ' · ' + esc(it.n) : ' · 空') + '">' +
        '<span class="ws-k">' + M.SLOT_NAMES[sk] + '</span>' +
        (it ? '<span class="ws-g q' + it.q + '">' + esc(it.ch) + '</span>' +
              '<span class="ws-n q' + it.q + '">' + esc(it.n) + '</span>' +
              '<span class="ws-q">' + (it.qty > 1 ? '×' + it.qty : qText(it.q)) + '</span>'
            : '<span class="ws-g none">空</span><span class="ws-n">—</span><span class="ws-q">&nbsp;</span>') +
      '</button>';
    }

    els.ability.innerHTML =
      hero +
      '<div class="cp-sec"><div class="cp-sec-h"><span class="t">装备</span>' +
        '<span class="s">' + (p.gear.talisman ? '法宝队列 ' + p.queue.length + ' / ' + M.CFG.TALISMAN_MAX + ' · ' + esc(p.queueFrom) : '未佩法宝') +
        '</span></div><div class="wear-grid">' + wear + '</div>' +
      '</div>' +
      quickBagHtml(p) +
      '<div class="cp-sec">' +
        '<div class="cp-sec-h"><span class="t">底蕴</span>' +
          '<button type="button" class="sec-btn" data-act="toggle-sec">' + (secOpen ? '收起 ▴' : '展开 ▾') + '</button>' +
        '</div>' +
        (secOpen ? renderEssence(p) : '<div class="sec-closed">灵根 · 天赋 · 特质 · 神通 —— 点「展开」查看</div>') +
      '</div>';
    /* 重画后把选中物件的详情接回去 (选中状态要跨重绘存活) */
    if (stashSel != null) showStashDetail('pcInfo');
  }

  /* ---------- 能力页内嵌背包 (分类筛选 + 先看详情再决定) ---------- */
  function quickBagHtml(p) {
    var kinds = filterKinds(), i, it, used = 0, shown = 0, cells = '', cnt = {};
    for (i = 0; i < state.stash.length; i++) {
      it = state.stash[i];
      if (!it) continue;
      used++;
      cnt[it.kind] = (cnt[it.kind] || 0) + 1;
    }
    var fbar = '';
    for (i = 0; i < FILTERS.length; i++) {
      var f = FILTERS[i], n = 0, k;
      if (f.kinds) { for (k = 0; k < f.kinds.length; k++) n += (cnt[f.kinds[k]] || 0); }
      else n = used;
      fbar += '<button type="button" class="qkfb' + (filter === f.k ? ' on' : '') + (n ? '' : ' dim') + '" data-qf="' + f.k + '">' +
        f.n + ' <em>' + n + '</em></button>';
    }
    for (i = 0; i < state.stash.length; i++) {
      it = state.stash[i];
      if (!it) continue;
      if (kinds && kinds.indexOf(it.kind) < 0) continue;
      shown++;
      var slot = M.slotOf(it.kind);
      cells += '<button type="button" class="qk-cell' + (slot ? ' can' : '') + (stashSel === i ? ' sel' : '') +
        '" data-qkidx="' + i + '" title="' + esc(it.n + ' · ' + qText(it.q) + ' · 点一下看详情') + '">' +
        '<span class="qk-g q' + it.q + '">' + esc(it.ch) + '</span>' +
        '<span class="qk-t">' +
          '<span class="qk-n q' + it.q + '">' + esc(it.n) + '</span>' +
          '<span class="qk-s">' + (slot ? M.SLOT_NAMES[slot] : kindName(it.kind)) +
            (it.qty > 1 ? ' ×' + it.qty : '') + '</span>' +
        '</span>' +
      '</button>';
    }
    if (!shown) {
      cells = '<div class="qk-none">' + (kinds ? '此类暂无物件' : '背包是空的') + '</div>';
    } else {
      for (i = shown % 3; i > 0 && i < 3; i++) cells += '<span class="qk-cell empty"></span>';
    }
    return '<div class="cp-sec qk">' +
      '<div class="cp-sec-h"><span class="t">背包</span>' +
        '<span class="s">点物件看词条与对比 · 再点按钮才动手</span></div>' +
      '<div class="qk-f">' + fbar + '</div>' +
      /* 详情卡夹在分类与网格之间: 点上面任何一格, 卡片都在旁边, 不用去页面另一头找 */
      '<div id="pcInfo" class="item-info"><div class="ii-empty">点背包物件或上方装备槽 → 这里显示词条、换装对比与按钮</div></div>' +
      '<div class="qk-grid">' + cells + '</div>' +
    '</div>';
  }

  /* data-bar = 稳定句柄: 实时刷新 (updateVitals) 按它定位, 不靠 nth-child 顺序 */
  function barRow(label, cur, max, cls, text) {
    cur = numOr(cur, 0); max = numOr(max, 1);
    var pct = Math.max(0, Math.min(100, Math.round(cur / Math.max(1, max) * 100)));
    return '<div class="pb ' + cls + '" data-bar="' + (cls || 'hp') + '" title="' + label + ' ' + cur + ' / ' + max + '（' + pct + '%）">' +
      '<span class="pb-k">' + label + '</span>' +
      '<span class="pb-g"><i style="width:' + pct + '%"></i></span>' +
      '<span class="pb-v">' + (text || (cur + '/' + max)) + '</span></div>';
  }

  /* --- 物品详情 (能力页: 已穿戴 → 卸下) --- */
  function showWearDetail(slot) {
    var host = $('pcInfo'), p = curPawn();
    if (!host || !p) return;
    var it = p.gear[slot];
    if (!it) return;
    host.innerHTML = itemCard(it, '<button type="button" class="ii-btn" data-act="unequip" data-slot="' + slot + '">卸下（回全局背包）</button>');
    try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (err) { /* noop */ }
  }

  function itemCard(it, btns, cmp) {
    var stats = [];
    if (it.atk) stats.push('攻 +' + it.atk);
    if (it.def) stats.push('防 +' + it.def);
    if (it.acc) stats.push('命中 ' + (it.acc > 0 ? '+' : '') + it.acc);
    if (it.hp) stats.push('气血 +' + it.hp);
    if (it.mp) stats.push('灵力 +' + it.mp);
    if (it.heal) stats.push('回血 ' + it.heal);
    stats.push('重 ' + wt(it.w));
    return '<div class="ii">' +
      '<div class="ii-h"><span class="ii-g q' + it.q + '">' + esc(it.ch) + '</span>' +
        '<span class="ii-n q' + it.q + '">' + esc(it.n) + '</span>' +
        '<span class="ii-tag">' + qText(it.q) + ' · ' + kindName(it.kind) +
          (it.qty > 1 ? ' · 叠 ' + it.qty : '') + '</span></div>' +
      '<div class="ii-a">' + esc(stats.join(' · ')) + '</div>' +
      (cmp && cmp.slot ? cmpRow(cmp) : '') +
      (btns ? '<div class="ii-btns">' + btns + '</div>' : '') +
    '</div>';
  }

  /* 换装对比: 这件换上去, 相对于身上那件差多少 —— 玩家据此决定装不装 */
  function cmpRow(cmp) {
    var d = cmp.delta, out = [], lb = [['atk', '攻'], ['def', '防'], ['acc', '命中'], ['hp', '气血'], ['mp', '灵力']];
    for (var i = 0; i < lb.length; i++) {
      var v = d[lb[i][0]];
      if (!v) continue;
      out.push('<span class="cmp-i ' + (v > 0 ? 'up' : 'down') + '">' + lb[i][1] + ' ' +
        (v > 0 ? '+' : '') + v + '</span>');
    }
    if (!out.length) out.push('<span class="cmp-i">词条相当</span>');
    return '<div class="ii-cmp">' +
      '<span class="cmp-k">对比</span>' +
      '<span class="cmp-now">' + (cmp.now ? '现戴 ' + esc(cmp.now.n) : '此槽空着') + '</span>' +
      out.join('') +
      (d.w ? '<span class="cmp-w">重 ' + (d.w > 0 ? '+' : '') + (Math.round(d.w * 10) / 10) + '</span>' : '') +
    '</div>';
  }
  function kindName(k) {
    return { weapon: '武器', offhand: '副手', body: '衣甲', head: '头饰', talisman: '法宝',
             pill: '丹药', material: '材料', book: '功法' }[k] || k;
  }

  /* --- 底蕴 --- */
  function renderEssence(p) {
    var i, j, E = M.ELEMENTS;
    var rootBar = '', rootLeg = '';
    for (i = 0; i < E.length; i++) {
      var rv = p.root.v[i];
      if (rv > 0) rootBar += '<i style="width:' + rv + '%;background:' + E[i].c + '"></i>';
      rootLeg += '<span class="rl' + (rv === 0 ? ' zero' : '') + '"><i style="background:' + E[i].c + '"></i>' +
        E[i].n + ' <b>' + rv + '</b></span>';
    }
    var daoRows = '';
    for (i = 0; i < M.DAO.length; i++) {
      var d = M.DAO[i], arr = p.talents.v[d.k] || [], sum = 0, cells = '';
      for (j = 0; j < arr.length; j++) {
        sum += arr[j];
        cells += '<div class="tal-cell' + (arr[j] === 0 ? ' zero' : '') + '" title="' + esc(d.talents[j] + ' ' + arr[j]) + '">' +
          '<span class="tn">' + esc(d.talents[j]) + '</span>' +
          '<span class="tg"><i style="height:' + Math.max(3, Math.round(arr[j] / M.CFG.TALENT_CAP * 100)) + '%"></i></span>' +
          '<span class="tv">' + arr[j] + '</span></div>';
      }
      daoRows += '<div class="tal"><span class="tal-n">' + d.n + '</span>' +
        '<span class="tal-d">' + d.d + '</span><div class="tal-grid">' + cells + '</div>' +
        '<span class="tal-sum">' + sum + '</span></div>';
    }
    var trRows = '';
    for (i = 0; i < p.traits.length; i++) {
      /* ⚠ 审查 C10: 有些特质文案承诺了数值, 但游戏里还没有对应系统 (食量/昼夜/突破…)。
         不标出来, 玩家会一直等一个不会发生的变化。 */
      var pend = M.PENDING_TRAITS ? M.PENDING_TRAITS[p.traits[i].n] : null;
      trRows += '<div class="tr-row"><span class="tr ' + p.traits[i].kind + '">' + esc(p.traits[i].n) + '</span>' +
        '<span class="tr-v">' + esc(p.traits[i].v) +
          (pend ? '<em class="tr-pend" title="「' + esc(pend) + '」系统还没做，这一条暂时只作记录">未开放·' + esc(pend) + '</em>' : '') +
        '</span></div>';
    }
    var artRows = '';
    for (i = 0; i < p.arts.slots.length; i++) {
      var a2 = p.arts.slots[i], pips = '';
      for (j = 0; j < M.CFG.ART_MAX_COST; j++) pips += '<i' + (j < a2.cost ? ' class="on"' : '') + '></i>';
      artRows += '<div class="art"><span class="an">' + esc(a2.n) + '</span><span class="ar">' + a2.rank + ' 阶</span>' +
        '<span class="ac">' + pips + '</span></div>';
    }
    return '<div class="ess">' +
      '<div class="ess-h">灵根 <span>合计 ' + M.rootSum(p) + ' / 100</span></div>' +
      '<div class="root-bar">' + rootBar + '</div><div class="root-leg">' + rootLeg + '</div>' +
      '<div class="ess-h">天赋 <span>合计 ' + M.talentTotal(p) + ' 点 · 单项 ≤ ' + M.CFG.TALENT_CAP + '</span></div>' +
      daoRows +
      '<div class="ess-h">特质 <span>先天 ' + p.traits.length + ' 条</span></div>' + trRows +
      '<div class="ess-h">神通 <span>携 ' + p.arts.cap + ' 格 · ' + esc(p.arts.from) + '</span></div>' + artRows +
    '</div>';
  }

  /* ============================================================
   * 页三: 全局背包 (48 格 + 类别筛选)
   * ============================================================ */
  function filterKinds() {
    for (var i = 0; i < FILTERS.length; i++) if (FILTERS[i].k === filter) return FILTERS[i].kinds;
    return null;
  }
  function renderBagPage() {
    var kinds = filterKinds(), i;
    var used = 0, weight = 0, cnt = {}, shown = 0;
    for (i = 0; i < state.stash.length; i++) {
      var it = state.stash[i];
      if (!it) continue;
      used++;
      weight += it.w * (it.qty || 1);
      cnt[it.kind] = (cnt[it.kind] || 0) + 1;
      if (!kinds || kinds.indexOf(it.kind) >= 0) shown++;
    }

    var fbar = '';
    for (i = 0; i < FILTERS.length; i++) {
      var f = FILTERS[i], n = 0;
      if (f.kinds) { for (var k = 0; k < f.kinds.length; k++) n += (cnt[f.kinds[k]] || 0); }
      else n = used;
      fbar += '<button type="button" class="bf' + (filter === f.k ? ' on' : '') + '" data-f="' + f.k + '">' +
        f.n + '<em>' + n + '</em></button>';
    }

    /* 网格: 「全部」按 48 固定格位画 (空格也画, 看得出容量); 筛选后只列命中项, 紧凑排列 */
    var cells = '';
    if (!kinds) {
      for (i = 0; i < state.stash.length; i++) cells += cellHtml(state.stash[i], i);
    } else if (!shown) {
      cells = '<div class="bag-none">此类暂无物品</div>';
    } else {
      for (i = 0; i < state.stash.length; i++) {
        var it2 = state.stash[i];
        if (!it2 || kinds.indexOf(it2.kind) < 0) continue;
        cells += cellHtml(it2, i);
      }
      for (i = shown; i < 12; i++) cells += cellHtml(null, -1);   // 补空格, 免得一行只摆两件
    }

    var pct = Math.round(used / Math.max(1, state.stash.length) * 100);
    els.bag.innerHTML =
      '<div class="bag-stat">' +
        '<span>在用 <b>' + used + '</b> / ' + state.stash.length + '</span>' +
        '<span>总重 <b>' + wt(weight) + '</b></span>' +
        '<span class="bs-w">装备给 <b>' + esc(curPawn() ? curPawn().name : '-') + '</b></span>' +
      '</div>' +
      '<div class="bag-cap"><i style="width:' + pct + '%"></i></div>' +
      '<div class="bag-filter">' + fbar + '</div>' +
      /* ⚠ 审查 C19: 详情卡原在 6x8 网格之后 (约 480px 高), 768px 窗口里点第一行物品后
         卡片与「装备」按钮都在可视区外 ⇒ 玩家以为没反应。与能力页同序: 筛选 → 详情 → 网格 */
      '<div id="stkInfo" class="item-info"></div>' +
      '<div class="bag-grid stash-grid">' + cells + '</div>';
    showStashDetail();
  }

  function cellHtml(it, idx) {
    if (!it) return '<span class="bag-cell empty-slot"></span>';
    return '<button type="button" class="bag-cell has q' + it.q + (stashSel === idx ? ' sel' : '') + '" data-idx="' + idx + '" ' +
      'title="' + esc(it.n + ' · ' + qText(it.q) + ' · 重 ' + wt(it.w)) + '">' +
      '<span class="bc-g">' + esc(it.ch) + '</span>' +
      '<span class="bc-n q' + it.q + '">' + esc(it.n) + '</span>' +
      (it.qty > 1 ? '<span class="bc-q">' + it.qty + '</span>' : '') +
    '</button>';
  }

  function showStashDetail(hostId) {
    var host = $(hostId || 'stkInfo');
    if (!host) return;
    var it = stashSel != null ? state.stash[stashSel] : null;
    if (!it) {
      host.innerHTML = '<div class="ii-empty">点格子看词条 · 可穿戴的还要再点一次「装备」才会换上</div>';
      return;
    }
    var p = curPawn(), slot = M.slotOf(it.kind), btn = '', cmp = null;
    if (slot) {
      cmp = p ? M.compareGear(p, state.stash, stashSel) : null;
      btn = '<button type="button" class="ii-btn primary" data-act="equip">' +
        (cmp && cmp.now ? '替换' + M.SLOT_NAMES[slot] + '（现 ' + esc(cmp.now.n) + '）' : '装备到' + M.SLOT_NAMES[slot]) +
        '</button>';
      if (!p) btn = '<span class="ii-no">先选一名弟子</span>';
    } else if (it.kind === 'pill') {
      btn = '<button type="button" class="ii-btn primary" data-act="use">服用（气血 +' + (it.heal || 0) +
        (it.mp ? ' · 灵力 +' + it.mp : '') + '）</button>';
    } else if (it.kind === 'book') {
      btn = '<button type="button" class="ii-btn primary" data-act="use">研习（修为 +' + (it.exp || 40 * (it.q || 1)) + '）</button>';
    } else {
      btn = '<span class="ii-no">材料 · 炼丹炼器才用得上，不能直接吃</span>';
    }
    host.innerHTML = itemCard(it, btn, cmp);
  }

  /* 这些动作都会重建 DOM: 记住内层背包的滚动位置, 别让人每点一次就跳回顶部 */
  function withQkScroll(fn) {
    var grid = document.querySelector('#pgAbility .qk-grid');
    var sc = grid ? grid.scrollTop : 0;
    fn();
    var g2 = document.querySelector('#pgAbility .qk-grid');
    if (g2) g2.scrollTop = sc;
  }

  /* 能力页: 先用一次 (丹药/功法), 用完继续看这个格子还剩什么 */
  function doUse() {
    var p = curPawn();
    if (!p || stashSel == null) return;
    var it = state.stash[stashSel];
    var idx = stashSel;
    var res = M.useItem(p, state.stash, idx);
    if (!res.ok) { toast(res.why); return; }
    /* 用完了: 还有叠就留在原格; 没了就清掉选中 */
    if (!res.left) stashSel = null;
    withQkScroll(function () {
      renderAbilityPage();
      renderSquadPage();
      renderBagPage();
    });
    if (res.kind === 'pill') toast('服下 ' + res.name + '：气血 +' + res.hp + (res.mp ? ' · 灵力 +' + res.mp : ''));
    else toast('研习 ' + res.name + '：修为 +' + res.exp);
  }

  /* ============================================================
   * 页四: 任务 (优先级矩阵 + 当前任务 + 全队动态)
   * ============================================================ */
  function renderWorkPage() {
    var jobs = state.jobs, i, j;
    panelCols = 1 + jobs.length;
    var tmpl = 'grid-template-columns:58px repeat(' + jobs.length + ', minmax(26px,1fr));';
    var head = '<div class="cw-mh corner" style="grid-column:1"><span class="mjn">弟子</span></div>';
    for (i = 0; i < jobs.length; i++) {
      head += '<div class="cw-mh" title="' + esc(jobs[i].n + ' · ' + jobs[i].target) + '">' +
        '<span class="mj">' + jobs[i].ch + '</span><span class="mjn">' + esc(jobs[i].n) + '</span></div>';
    }
    var body = '';
    for (i = 0; i < state.pawns.length; i++) {
      var p = state.pawns[i];
      body += '<div class="cw-mn' + (p.id === selId ? ' cur' : '') + '" title="' + esc(p.name) + '">' +
        '<span class="dot"></span>' + esc(p.name) + '</div>';
      for (j = 0; j < jobs.length; j++) {
        var v = M.priorityOf(p, jobs[j].id);
        body += '<button type="button" class="cw-cell p' + v + '" data-pawn="' + p.id + '" data-job="' + jobs[j].id +
          '" title="' + esc(p.name + ' · ' + jobs[j].n + ' · 优先级 ' + v) + '">' + (v === 0 ? '禁' : v) + '</button>';
      }
    }
    els.work.innerHTML =
      '<div class="cw-hint">点格子改优先级：<b>1</b> 最急 → <b>2</b> → <b>3</b> → <b>4</b> 最缓 → <b>禁</b>（再点回 1）。弟子按最急的一项干活。</div>' +
      '<div class="cw-scroll"><div class="cw-matrix" style="' + tmpl + '">' + head + body + '</div></div>' +
      '<div id="cwNow"></div>' +
      '<div class="cw-crew"><div class="cw-crew-h">全队动态</div><div id="cwCrew"></div></div>';
    renderNow();
    renderCrewList();
  }

  function renderCrewList() {
    var host = $('cwCrew');
    if (!host) return;
    var html = '';
    for (var i = 0; i < state.pawns.length; i++) {
      var p = state.pawns[i];
      var job = p.job && p.job.jobId ? M.jobById(p.job.jobId) : null;
      var pg = job ? Math.min(100, p.job.progress) : 0;
      html += '<div class="cw-row' + (p.id === selId ? ' cur' : '') + '">' +
        '<span class="cw-rn" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
        '<span class="cw-rt">' + (job ? esc(p.job.task) + ' <em>@ ' + esc(job.target) + '</em>' : '空闲') + '</span>' +
        '<span class="cw-rp"><i style="width:' + pg + '%"></i></span>' +
        '<span class="cw-rd">' + ((p.job && p.job.done) || 0) + ' 件</span>' +
      '</div>';
    }
    host.innerHTML = html;
  }

  function renderNow() {
    var host = $('cwNow');
    if (!host) return;
    var p = curPawn();
    if (!p) { host.innerHTML = ''; nowLive = null; return; }
    var job = p.job && p.job.jobId ? M.jobById(p.job.jobId) : null;
    var next = nextJob(p);
    nowLive = { pawnId: p.id, jobId: job ? job.id : null, task: p.job ? p.job.task : null };
    host.innerHTML =
      '<div class="cw-now">' +
        '<div class="cw-now-h"><span class="who">' + esc(p.name) + '</span>' +
          '<span>' + esc(p.role) + ' · 优先级 ' + (job ? M.priorityOf(p, job.id) : '禁') + '</span></div>' +
        '<div class="cw-task">' +
          (job ? '<span class="tt">' + esc(p.job.task) + '</span> <span class="tg2">@ ' + esc(job.target) + '</span>'
               : '<span class="tg2">无事可做（十项全禁）</span>') +
        '</div>' +
        '<div class="cw-prog"><i data-live="prog" style="width:' + (job ? Math.min(100, p.job.progress) : 0) + '%"></i></div>' +
        '<div class="cw-meta"><span data-live="progTx">' + (job ? Math.round(p.job.progress) + '%' : '—') + '</span>' +
          '<span data-live="done">已成 ' + ((p.job && p.job.done) || 0) + ' 件</span></div>' +
        (next ? '<div class="cw-next">其次：<b>' + esc(next.n) + '</b> · 优先级 ' + M.priorityOf(p, next.id) + '</div>'
              : '<div class="cw-next">其次：无</div>') +
      '</div>';
  }
  function nextJob(p) {
    var best = null, bp = 99;
    for (var i = 0; i < state.jobs.length; i++) {
      var jb = state.jobs[i];
      if (p.job && p.job.jobId === jb.id) continue;
      var v = M.priorityOf(p, jb.id);
      if (!v) continue;
      if (v < bp) { bp = v; best = jb; }
    }
    return best;
  }

  /* ---------- 活节点更新 ---------- */
  function updateLive() {
    if (!state) return;
    /* ★ 气血/灵力/心境/修为 是**全页签**都会变的量 (startTick 每 500ms 推进, 约 6s 掉一次)。
       旧实现只在 tab==='work' 时重绘节点 ⇒ 停在队伍页/能力页时血条、灵力条、心境永久定格,
       非点一下不跳变。这里改成「就地改 style / 文本」: 不重建 DOM, 所以不会打断拖动,
       也不会把滚动位置弹回顶部。 */
    updateVitals();
    var cp = curPawn();
    if (tab === 'work' && cp) {
      var jid2 = cp.job && cp.job.jobId ? cp.job.jobId : null;
      var stale = !nowLive || nowLive.pawnId !== cp.id || nowLive.jobId !== jid2 ||
                  nowLive.task !== (cp.job ? cp.job.task : null);
      if (stale) renderNow();
      else if (cp.job) {
        var pg = $('cwNow') && $('cwNow').querySelector('[data-live="prog"]');
        var tx = $('cwNow') && $('cwNow').querySelector('[data-live="progTx"]');
        var dn = $('cwNow') && $('cwNow').querySelector('[data-live="done"]');
        if (pg) pg.style.width = Math.min(100, cp.job.progress) + '%';
        if (tx) tx.textContent = Math.round(cp.job.progress) + '%';
        if (dn) dn.textContent = '已成 ' + ((cp.job.done) || 0) + ' 件';
      }
      renderCrewList();
    }
    updateSub();
  }

  /* ---------- 血量/心境/修为的「就地刷新」(不重绘) ---------- */
  function paintRowVit(row, v) {
    var vs = row.querySelectorAll('.rp-vit');
    for (var k = 0; k < vs.length; k++) {
      var isMp = vs[k].classList.contains('mp');
      var cur = isMp ? v.mp : v.hp;
      var max = isMp ? v.maxMp : v.maxHp;
      var pct = isMp ? v.mpPct : v.hpPct;
      var b = vs[k].querySelector('b');
      if (b) b.style.width = pct + '%';
      var u = vs[k].querySelector('u');
      if (u) u.textContent = cur + '/' + max;
      vs[k].title = (isMp ? '灵力 ' : '气血 ') + cur + ' / ' + max + '（' + pct + '%）';
    }
  }
  function paintBar(host, key, label, cur, max, text) {
    var el = host.querySelector('[data-bar="' + key + '"]');
    if (!el) return;
    var pct = Math.max(0, Math.min(100, Math.round(cur / Math.max(1, max) * 100)));
    var tx = el.querySelector('.pb-v');
    if (tx) tx.textContent = text;
    /* innerHTML 里那条 <i> 是进度条本体 (barRow 输出的 .pb-g > i) */
    var fill = el.querySelector('.pb-g i');
    if (fill) fill.style.width = pct + '%';
    el.title = label + ' ' + cur + ' / ' + max + '（' + pct + '%）';
  }
  function updateVitals() {
    /* 队伍页: 每行两条 (气血 / 灵力) —— 能力页的条在换人/换装时会整页重绘, 这里只补「时间流逝」那部分 */
    if (els.squad) {
      var rows = els.squad.querySelectorAll('.rp-row');
      for (var i = 0; i < rows.length; i++) {
        var p = pawnById(rows[i].getAttribute('data-id'));
        if (p) paintRowVit(rows[i], M.vitalOf(p));
      }
    }
    var cp = curPawn();
    if (!cp || !els.ability) return;
    var v = M.vitalOf(cp), e = M.expOf(cp);
    paintBar(els.ability, 'hp', '气血', v.hp, v.maxHp, v.hp + '/' + v.maxHp);
    paintBar(els.ability, 'mp', '灵力', v.mp, v.maxMp, v.mp + '/' + v.maxMp);
    paintBar(els.ability, 'mood', '心境', cp.mood, 100, cp.mood + '/100');
    paintBar(els.ability, 'exp', '修为', e.v, e.max, fmt(e.v) + '/' + fmt(e.max));
  }

  /* ============================================================
   * 装备 / 卸下 (全部走全局背包)
   * ============================================================ */
  function doEquip() {
    var p = curPawn();
    if (!p || stashSel == null) return;
    var it = state.stash[stashSel];
    var res = M.equip(p, state.stash, stashSel);
    if (!res.ok) { toast(res.why); return; }
    stashSel = null;
    withQkScroll(function () {
      renderAbilityPage();
      renderSquadPage();
      renderBagPage();
    });
    toast('已装备 ' + (it ? it.n : '') + (res.old ? '，换下 ' + res.old.n : ''));
  }
  function doUnequip(slot) {
    var p = curPawn();
    if (!p) return;
    var it = p.gear[slot];
    var res = M.unequip(p, state.stash, slot);
    if (!res.ok) { toast(res.why); return; }
    stashSel = res.stashIdx != null ? res.stashIdx : null;
    /* ⚠ 审查 D17: doEquip/doUse 都包了 withQkScroll, 这里漏了 ⇒ 能力页卸装备后内层背包滚回顶部 */
    withQkScroll(function () {
      renderAbilityPage();
      renderBagPage();
      renderSquadPage();
    });
    toast('已卸下 ' + (it ? it.n : '') + ' → 全局背包');
  }
  /* ---- 事件出口 (§14 的 9 条) ----
     bridge 未加载 (纯面板演示) 或没接后台时静默; 接了就由 bridge 排队 + 合并窗口发送。
     ⚠ 事件只放 id 与目标值, 不放派生值 (人数/负重/攻防)。 */
  function notifyEvent(type, data) {
    var B = g.CrewBridge;
    if (!B || !B.notify) return;
    try { B.notify(type, data); } catch (e) { /* 事件失败不许影响 UI */ }
  }

  function toast(msg) {
    if (!msg) return;
    var t = $('crewToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'crewToast';
      t.className = 'crew-toast';
      els.panel.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  /* ---------- 总渲染 ---------- */
  function renderAll() {
    if (!state) return;
    if (!selId || !pawnById(selId)) selId = state.pawns[0] ? state.pawns[0].id : null;
    updateSub();
    renderSquadPage();
    renderAbilityPage();
    renderBagPage();
    renderWorkPage();
    applyTab();
  }

  /* ---------- 选中 / 页签 ---------- */
  function select(id) {
    if (!pawnById(id)) return;
    selId = id;
    stashSel = null;
    updateSub();
    renderSquadPage();
    renderAbilityPage();
    renderBagPage();
    renderWorkPage();
    save();
  }
  function setTab(t) {
    tab = (t === 'ability' || t === 'bag' || t === 'work') ? t : 'squad';
    if (tab === 'ability') renderAbilityPage();
    if (tab === 'bag') renderBagPage();
    applyTab();
    save();
  }
  function applyTab() {
    var bs = els.tabs.querySelectorAll('button[data-tab]');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-tab') === tab);
    var pages = els.panel.querySelectorAll('.crew-page');
    for (var j = 0; j < pages.length; j++) pages[j].classList.toggle('on', pages[j].getAttribute('data-page') === tab);
    var body = els.panel.querySelector('.crew-body');
    if (body) body.scrollTop = 0;
  }

  /* ---------- 持久化 ---------- */
  function save() {
    if (!S || !S.write || !state) return;
    var prio = {}, squads = [], i, j;
    for (i = 0; i < state.pawns.length; i++) prio[state.pawns[i].id] = state.pawns[i].prio;
    var src = state.squads || [];
    for (i = 0; i < src.length; i++) {
      squads.push({ id: src[i].id, name: src[i].name, members: src[i].members.slice() });
    }
    S.write(LS_NS, {
      sel: selId, tab: tab, prio: prio, filter: filter,
      squads: squads, curSquad: state.curSquad || null
    });
  }
  function load() {
    if (!S || !S.read || !state) return;
    var saved = S.read(LS_NS, null);
    if (!saved) return;
    if (saved.prio) {
      for (var i = 0; i < state.pawns.length; i++) {
        var p = state.pawns[i], sp = saved.prio[p.id];
        if (!sp) continue;
        for (var k in sp) {
          if (Object.prototype.hasOwnProperty.call(p.prio, k)) {
            var v = sp[k];
            if (v === 0 || (v >= 1 && v <= 4)) p.prio[k] = v;
          }
        }
      }
    }
    /* 小队顺序 / 队名 / 队内顺序 / 当前队 —— 结构残缺一律交给 normalizeSquads 兜
       ⚠ ?squads=N 是演示参数, 优先级高于存档, 否则截图上看到的队数跟 URL 不符 */
    var forceSquads = /[?&]squads=\d/.test(g.location && g.location.search ? g.location.search : '');
    if (!forceSquads && Array.isArray(saved.squads) && saved.squads.length) {
      var list = [];
      for (var si = 0; si < saved.squads.length; si++) {
        var ss = saved.squads[si];
        if (!ss || !Array.isArray(ss.members)) continue;
        list.push({ id: String(ss.id || ('sq' + (si + 1))), name: ss.name, members: ss.members.slice() });
      }
      if (list.length) state.squads = list;
    }
    if (!forceSquads && saved.curSquad) state.curSquad = saved.curSquad;
    M.normalizeSquads(state);
    if (saved.tab === 'ability' || saved.tab === 'bag' || saved.tab === 'work' || saved.tab === 'squad') tab = saved.tab;
    if (saved.sel && pawnById(saved.sel)) selId = saved.sel;
    if (saved.filter) { for (var f = 0; f < FILTERS.length; f++) if (FILTERS[f].k === saved.filter) filter = saved.filter; }
  }

  /* ---------- 初始化 ---------- */
  function init(opts) {
    if (inited) {
      if (opts && opts.data) setSquad(opts.data, true);
      return g.CrewPanel;
    }
    if (!M) {
      console.warn('[crew] 缺少 web/js/crew/crew-model.js — 小队面板未挂载');
      return null;
    }
    opts = opts || {};
    injectCss();
    var q = g.location && g.location.search ? g.location.search : '';
    var cnt = opts.count;
    if (!cnt) {
      var mC = /[?&]crewcount=(\d+)/.exec(q);
      cnt = mC ? parseInt(mC[1], 10) : 6;
    }
    /* ?squads=2 演示多小队 (默认 1 支, 名字「小队」) */
    var mSq = /[?&]squads=(\d+)/.exec(q);
    state = opts.data || M.demoSquad(cnt, null, mSq ? parseInt(mSq[1], 10) : 1);
    if (!state.jobs) state.jobs = M.JOBS.slice();
    if (!state.stash) state.stash = new Array(M.CFG.STASH_COLS * M.CFG.STASH_ROWS).fill(null);
    M.normalizeSquads(state);
    var firstList = M.squadPawns(state, state.curSquad);
    selId = firstList[0] ? firstList[0].id : (state.pawns[0] ? state.pawns[0].id : null);
    buildDom();
    load();
    inited = true;
    renderAll();

    /* ?crewapi= 表示数据来自后台 ⇒ 一开始就关本地推进, 避免启动那几百毫秒给空闲弟子派活 */
    if (/[?&]crewapi=/.test(q)) localTick = false;
    var mTab = /[?&]crewtab=(squad|ability|bag|work)/.exec(q);
    if (mTab) tab = mTab[1];
    if (/[?&]crewsec=1/.test(q)) secOpen = true;
    /* 截图/演示用: ?qksel=eq 选第一件可换装且槽位非空的, =pill 选第一颗丹药 */
    var mSel = /[?&]qksel=(\w+)/.exec(q);
    if (mSel) {
      var want = mSel[1];
      for (var si = 0; si < state.stash.length; si++) {
        var sit = state.stash[si];
        if (!sit) continue;
        var sslot = M.slotOf(sit.kind);
        if (want === 'eq' && sslot && (state.pawns[0].gear[sslot] || null)) { stashSel = si; break; }
        if (want === 'pill' && sit.kind === 'pill') { stashSel = si; break; }
      }
      if (stashSel != null && tab === 'ability') renderAbilityPage();
    }
    if (/[?&]crew=1/.test(q)) setOpen(true);
    return g.CrewPanel;
  }

  /* 拖动进行中数据被整体换掉 (bridge patch / 服务端推) ⇒ 必须作废拖动:
     它抓的是**旧 DOM**, 按旧顺序写回新 state 会把人塞错队、把删掉的人写回来 (审查 C6)。 */
  function abortDrags() {
    var st = _pDrag;
    if (st) {
      if (st.timer) clearTimeout(st.timer);
      try { st.secs.releasePointerCapture(st.id); } catch (e) { /* noop */ }
      if (st.el && st.el.classList) st.el.classList.remove('dragging');
      _pDrag = null;
    }
    var d = _drag;
    if (d) {
      if (d.timer) clearTimeout(d.timer);
      try { d.host.releasePointerCapture(d.id); } catch (e) { /* noop */ }
      if (d.el && d.el.classList) d.el.classList.remove('dragging');
      if (d.host && d.host.classList) d.host.classList.remove('sorting');
      _drag = null;
    }
    document.body.classList.remove('crew-sorting');
  }

  function setSquad(data, keepSel) {
    if (!data || !data.pawns) return false;
    abortDrags();
    if (!data.jobs) data.jobs = M.JOBS.slice();
    if (!data.stash) data.stash = new Array(M.CFG.STASH_COLS * M.CFG.STASH_ROWS).fill(null);
    M.normalizeSquads(data);
    var old = keepSel ? selId : null;
    state = data;
    selId = (old && pawnById(old)) ? old : (state.pawns[0] ? state.pawns[0].id : null);
    if (inited) { renderAll(); if (isOpen) startTick(); }
    return true;
  }

  function probe() {
    var cp = curPawn();
    var sq = curSquad();
    var mp = state ? M.probe(state) : null;
    var out = {
      inited: inited, open: isOpen, tab: tab, sel: selId, filter: filter, localTick: localTick,
      pawns: state ? state.pawns.length : 0,
      /* 多小队: 结构 / 当前队 / 界面上真的画出来的东西 */
      squads: state && state.squads ? state.squads.map(function (s) {
        return { id: s.id, name: s.name, n: s.members.length, members: s.members.slice() };
      }) : [],
      curSquad: state ? state.curSquad : null,
      curSquadName: sq ? sq.name : null,
      curSquadN: sq ? sq.members.length : 0,
      squadChips: els.squad ? els.squad.querySelectorAll('.sq-sec').length : 0,   // 队数(旧名保留)
      squadSections: els.squad ? els.squad.querySelectorAll('.sq-sec').length : 0,
      sectionTops: els.squad ? (function () {
        var box = els.squad.closest('.crew-body') || els.squad;
        var bt = box.getBoundingClientRect().top;
        return [].slice.call(els.squad.querySelectorAll('.sq-sec')).map(function (s) {
          return Math.round(s.getBoundingClientRect().top - bt);
        });
      })() : [],
      secHeads: els.squad ? els.squad.querySelectorAll('.sq-hd').length : 0,
      flashes: els.squad ? els.squad.querySelectorAll('.sq-sec.flash').length : 0,
      entrySquads: els.sqs ? els.sqs.querySelectorAll('.ce-item').length : 0,
      entryText: els.entry ? els.entry.textContent : '',
      entrySizes: els.sqs ? [].slice.call(els.sqs.querySelectorAll('.ce-item')).map(function (e) {
        var r = e.getBoundingClientRect();
        return { on: e.classList.contains('on'), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
      }) : [],
      rosters: els.squad ? els.squad.querySelectorAll('.rp-row').length : 0,
      chips: els.panel ? els.panel.querySelectorAll('.chip').length : 0,
      wearSlots: els.ability ? els.ability.querySelectorAll('.wear-slot').length : 0,
      quickCells: els.ability ? els.ability.querySelectorAll('.qk-cell[data-qkidx]').length : 0,
      squadGear: els.squad ? els.squad.querySelectorAll('.rp-g').length : 0,
      squadVitals: els.squad ? els.squad.querySelectorAll('.rp-vit').length : 0,
      cells: els.bag ? els.bag.querySelectorAll('.bag-cell[data-idx]').length : 0,
      filters: els.bag ? els.bag.querySelectorAll('.bf').length : 0,
      workCells: els.work ? els.work.querySelectorAll('.cw-cell').length : 0,
      mobile: isMobile(),
      model: mp,
      /* 每人「在哪支队 / 第几位」的显式标记 (派生自 members 数组顺序) */
      assign: mp ? mp.assign : [],
      emptyLists: els.squad ? els.squad.querySelectorAll('.rp-list.empty').length : 0,
      cur: cp ? {
        name: cp.name, attrs: M.attrs(cp), exp: M.expOf(cp), vital: M.vitalOf(cp), weight: M.weightOf(cp), load: M.loadMax(cp),
        queue: cp.queue.length
      } : null,
      panelRect: null, entryRect: null
    };
    try {
      var r = els.panel.getBoundingClientRect();
      out.panelRect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      var r2 = els.entry.getBoundingClientRect();
      out.entryRect = { x: Math.round(r2.left), y: Math.round(r2.top), w: Math.round(r2.width), h: Math.round(r2.height) };
    } catch (e) { out.rectErr = String(e); }
    return out;
  }

  g.CrewPanel = {
    init: function (o) { return init(o); },
    /* ⚠ 审查 D21: init() 可能返回 null (crew-model 没加载) ⇒ setOpen 里 els.panel 是 undefined,
       直接 classList 抛 TypeError。close() 反而做了保护。 */
    open: function () { if (!inited && !init()) return false; setOpen(true); return true; },
    close: function () { if (inited) setOpen(false); },
    toggle: function () { if (!inited && !init()) return false; setOpen(!isOpen); return true; },
    isOpen: function () { return isOpen; },
    select: function (id) { if (inited) select(id); },
    setTab: function (t) { if (inited) setTab(t); },
    setFilter: function (f) { if (inited) { filter = f; renderBagPage(); } },
    setSquad: setSquad,
    /* 多小队 (2026-11-24 第六轮) —— 验收/调试用 */
    getSquads: function () { return state && state.squads ? state.squads : []; },
    getCurSquad: function () { var q = curSquad(); return q ? q.id : null; },
    switchSquad: function (id) { if (inited) switchSquad(id); },
    addSquad: function () { if (inited) addSquad(); },
    removeSquad: function (id) { if (inited) removeSquad(id); },
    renameSquad: function (id, name) {
      var s = M.squadById(state, id);
      if (!s) return null;
      s.name = M.squadName(name);
      renderSquadPage();
      save();
      return s.name;
    },
    movePawn: function (pid, sqId) { if (inited) movePawnTo(pid, sqId); },
    movePawnAt: function (pid, sqId, pos) { if (inited) movePawnTo(pid, sqId, pos); },
    orderPawns: function (ids) { if (inited) applyPawnOrder(ids); },
    orderSquads: function (ids) { if (inited) applySquadOrder(ids); },
    getState: function () { return state; },
    /* 接后台数据时调 setLocalTick(false): 停掉本地任务推进, 数据完全由服务端说了算 */
    setLocalTick: function (on) { localTick = !!on; },
    isLocalTick: function () { return localTick; },
    probe: probe
  };

  function auto() { if (!inited) init(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})(typeof window !== 'undefined' ? window : globalThis);
