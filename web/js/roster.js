/* ============================================================
 * roster.js — 「众生录」角色窗口 (独立模块 · window.SectRoster)
 * ------------------------------------------------------------
 * 数据源: **服务端实时生成** —— `GET /api/characters` (可加 ?count=&offset=)
 *   (C# CharactersSubsystem → V8 "characters" scope → js/chargen-core.js)。
 *   ⚠ 不再读任何预生成的静态快照: 角色是 (seed,index) 的纯函数派生, 服务端按当前世现算。
 *     seed 由服务端补 (前端不给 —— 种子是服务端资产)。
 *
 * 与 main.js 的关系 (照 infocard.js / minimap-vein.js 的单点注入姿势):
 *   · 本模块**不直接引用** main.js 的内部变量; DOM 与 esc 全由 init(deps) 注入;
 *   · main.js 只在 boot 里调一次 initRoster() 把根节点接上 —— **不渲染**;
 *   · 打开/关闭由本模块自己管 (按钮、遮罩、Esc 都在这里绑)。
 *
 * 边界:
 *   · 只读。不写任何 main.js 状态, 不触发地图重绘, 不发除 dataUrl 之外的请求。
 *   · 渲染全部走**纯函数** (rowHTML / detailHTML / normalize), 可在 Node 中裸跑断言 ——
 *     见 Subsystems/Characters/verify_roster.mjs。
 *   · 标签不硬编码: 一律优先取载荷里的 dict (真源 = cultivation-base.json), 仅当 dict
 *     缺失时才回落本文件末尾的兜底表。
 * ============================================================ */
(function () {
  'use strict';

  var deps = null;      // { root, btn, esc?, dataUrl, onOpen?, onClose? }
  var dom = null;       // root 内被 data-ro 标记的节点句柄

  /* 视图状态 (与渲染无关的纯数据) */
  var state = {
    open: false,
    loading: false,
    loaded: false,
    error: '',
    dict: null,
    chars: [],
    view: [],
    filter: 'all',
    query: '',
    selId: null,
    seed: '',
    count: 0,
  };

  /* ---------- 通用 ---------- */
  function escOf(s) {
    if (deps && typeof deps.esc === 'function') return deps.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function num(n) { return (n == null || isNaN(n)) ? '0' : Number(n).toLocaleString(); }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  /* ---------- 标签 (dict 优先, 兜底表垫底) ---------- */
  var FALLBACK = {
    attributes: [
      { key: 'gengu', name: '根骨' }, { key: 'wuxing', name: '悟性' }, { key: 'shenshi', name: '神识' },
      { key: 'qiyun', name: '气运' }, { key: 'xinjing', name: '心境' }, { key: 'meili', name: '魅力' },
    ],
    derived: [{ key: 'zizhi', name: '资质' }, { key: 'qianli', name: '潜力' }, { key: 'shengwang', name: '声望' }],
    resources: [{ key: 'qi', name: '灵力' }, { key: 'qixue', name: '气血' }, { key: 'jingshen', name: '精神' }],
  };
  function labels(kind, dict) {
    var d = dict || state.dict || {};
    var list = d[kind];
    return (Array.isArray(list) && list.length) ? list : FALLBACK[kind] || [];
  }

  /* ============================================================
   * 纯函数区 (无 DOM 依赖 —— Node 里可直接断言)
   * ============================================================ */

  /** 载荷 → 内部规整视图。容错: 缺 dict / 缺 characters 都不炸。 */
  function normalize(payload) {
    var p = payload || {};
    var chars = Array.isArray(p.characters) ? p.characters : [];
    return {
      seed: p.seed || '',
      count: typeof p.count === 'number' ? p.count : chars.length,
      schema: p.schema || '',
      dict: p.dict || null,
      chars: chars,
    };
  }

  /** 出现过的境界 (按 dict 的 seq 排序), 供筛选芯片用。 */
  function presentRealms(chars, dict) {
    var order = (dict && Array.isArray(dict.realms)) ? dict.realms.slice() : [];
    var nameById = {}, seqById = {};
    for (var i = 0; i < order.length; i++) { nameById[order[i].id] = order[i].name; seqById[order[i].id] = order[i].seq; }
    var seen = {};
    for (var j = 0; j < chars.length; j++) {
      var r = chars[j].realm || {};
      if (!r.id) continue;
      seen[r.id] = (seen[r.id] || 0) + 1;
    }
    var ids = Object.keys(seen).sort(function (a, b) {
      var d = (seqById[a] == null ? 99 : seqById[a]) - (seqById[b] == null ? 99 : seqById[b]);
      return d !== 0 ? d : (a < b ? -1 : 1);
    });
    return ids.map(function (id) {
      return { id: id, name: nameById[id] || id, n: seen[id] };
    });
  }

  /** 过滤 (境界 + 姓名/道号搜索)。 */
  function applyFilter(chars, filter, query) {
    var q = String(query || '').trim().toLowerCase();
    return chars.filter(function (c) {
      if (filter && filter !== 'all') {
        var seq = (c.realm && c.realm.seq) || 0;
        if (filter === 'mortal') { if (seq !== 0) return false; }
        else if ((c.realm && c.realm.id) !== filter) return false;
      }
      if (!q) return true;
      var nm = c.name || {};
      return String(nm.full || '').toLowerCase().indexOf(q) >= 0 ||
             String(nm.daohao || '').toLowerCase().indexOf(q) >= 0 ||
             String(c.id || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  /** 名册一行。selectedId 可选 (纯函数化: 不读 state)。 */
  function rowHTML(c, selectedId) {
    var nm = c.name || {}, r = c.realm || {}, sr = c.spiritRoot || {};
    var sub = [r.stage || r.name || '', sr.gradeName || ''].filter(Boolean).join(' · ');
    return '<div class="ro-item' + (c.id === selectedId ? ' on' : '') + '" data-ro-id="' +
      escOf(c.id) + '"><div class="nm">' + escOf(nm.full || c.id) +
      (nm.daohao ? '<span class="dh">' + escOf(nm.daohao) + '</span>' : '') +
      '</div><div class="sub">' + escOf(sub) + '</div></div>';
  }

  function barHTML(name, value, max) {
    var pct = clamp(max > 0 ? (value / max) * 100 : 0, 0, 100);
    return '<div class="ro-bar"><span class="bn">' + escOf(name) + '</span>' +
      '<span class="bt"><span class="bf" style="width:' + pct.toFixed(1) + '%"></span></span>' +
      '<span class="bv">' + num(value) + '</span></div>';
  }
  function kv(k, v) {
    return '<div class="ro-kv"><span class="k">' + escOf(k) + '</span><span class="v">' + v + '</span></div>';
  }
  function gradeName(kind, id, dict) {
    var d = dict || state.dict || {};
    var g = d.grades && d.grades[kind];
    for (var i = 0; Array.isArray(g) && i < g.length; i++) if (g[i].id === id) return g[i];
    return null;
  }
  function chip(name, color, extra) {
    return '<span class="ro-chip-s"><i style="background:' + escOf(color || 'rgba(120,98,66,0.5)') +
      '"></i>' + escOf(name) + (extra ? '<b>' + escOf(extra) + '</b>' : '') + '</span>';
  }
  function catName(kind, id, dict) {
    var d = dict || state.dict || {};
    var list = kind === 'tech' ? d.techniqueCategories : d.itemCategories;
    for (var i = 0; Array.isArray(list) && i < list.length; i++) if (list[i].id === id) return list[i].name;
    return id || '';
  }

  /** 角色详情 (HTML)。dict 可显式传入 (纯函数化); 缺省用 state.dict, 再缺省走兜底表。 */
  function detailHTML(c, dict) {
    var D = dict || state.dict || null;
    var nm = c.name || {}, r = c.realm || {}, sr = c.spiritRoot || {};
    var bag = c.storageBag || {}, out = [];

    out.push('<div class="ro-top"><div class="ro-name">' + escOf(nm.full || c.id) +
      (nm.daohao ? '<span class="ro-dh">道号 · ' + escOf(nm.daohao) + '</span>' : '') +
      '</div><div class="ro-seal">' + escOf(String(nm.full || '?').slice(0, 2)) + '</div></div>');
    out.push('<div class="ro-sub">' + escOf(c.gender || '') + ' · ' + num(c.age) + ' 岁 · ' +
      '<span class="ro-realm">' + escOf(r.stage || r.name || '') + '</span>' +
      '<span class="ro-prog">修为 ' + Math.round(((r.progress || 0) * 100)) + '%</span></div>');
    out.push('<div class="ink-rule"></div>');

    /* 灵根 / 寿元 */
    out.push(kv('灵根', '<span style="color:' + escOf(sr.color || 'inherit') + '">' +
      escOf(sr.gradeName || '') + '</span> · ' + escOf(sr.element || '') +
      ' · ' + escOf(sr.purityName || '') + ' ' + num(sr.purity)));
    out.push(kv('寿元', num(c.lifespan) + ' 载'));

    /* 六维 (条形) */
    out.push('<div class="ro-sec">六 维</div><div class="ro-bars">');
    labels('attributes', D).forEach(function (a) {
      out.push(barHTML(a.name, (c.attributes || {})[a.key] | 0, 100));
    });
    out.push('</div>');

    /* 天分 (派生) */
    var dv = labels('derived', D);
    if (dv.length) {
      out.push('<div class="ro-sec">天 分</div>');
      dv.forEach(function (a) { out.push(kv(a.name, num((c.derived || {})[a.key] | 0))); });
    }

    /* 资源 */
    var rs = labels('resources', D);
    if (rs.length) {
      out.push('<div class="ro-sec">资 源</div>');
      rs.forEach(function (a) { out.push(kv(a.name, num((c.resources || {})[a.key] | 0) + (a.unit || ''))); });
    }

    /* 特质 */
    out.push('<div class="ro-sec">特 质</div>');
    if ((c.traits || []).length) {
      out.push('<div class="ro-traits">');
      c.traits.forEach(function (t) { out.push(chip(t.name, t.color, null)); });
      out.push('</div>');
    } else {
      out.push('<div class="ro-none">无</div>');
    }

    /* 功法 */
    out.push('<div class="ro-sec">功 法</div>');
    var tech = c.techniques || {};
    if (tech.main) {
      var mg = gradeName('techniques', tech.main.grade, D);
      out.push(kv('主修心法', escOf(tech.main.name) +
        (mg ? ' <span style="color:' + escOf(mg.color) + '">· ' + escOf(mg.name) + '</span>' : '')));
    } else {
      out.push('<div class="ro-none">凡人未入道 · 无主修心法</div>');
    }
    if ((tech.aux || []).length) {
      out.push('<div class="ro-traits">');
      tech.aux.forEach(function (t) {
        out.push(chip(t.name, null, Math.round((t.proficiency || 0) * 100) + '%'));
      });
      out.push('</div>');
    }

    /* 储物袋 */
    out.push('<div class="ro-sec">储 物 袋</div>');
    out.push(kv('容量', num(bag.used) + ' / ' + num(bag.slots) + ' 格'));
    out.push(kv('灵石', num(bag.lingshi)));
    if ((bag.items || []).length) {
      out.push('<div class="ro-items">');
      bag.items.forEach(function (it) {
        var ig = gradeName('items', it.grade, D);
        out.push('<div class="ro-item-row"><i style="background:' +
          escOf(ig ? ig.color : '') + '"></i><span class="inm">' + escOf(it.name) + '</span>' +
          '<span class="icat">' + escOf(catName('item', it.cat, D)) + '</span>' +
          '<span class="ict">×' + num(it.count) + '</span></div>');
      });
      out.push('</div>');
    } else {
      out.push('<div class="ro-none">囊中空空</div>');
    }

    /* 出身 / 阵营 */
    var bg = c.background || {}, fac = c.faction || {}, al = fac.alignment || {};
    out.push('<div class="ro-sec">来 历</div>');
    out.push(kv('出身', escOf(bg.name || '—')));
    out.push(kv('阵营', '<span style="color:' + escOf(al.color || 'inherit') + '">' +
      escOf(al.name || '—') + '</span>'));
    out.push(kv('宗门', fac.sect ? escOf(fac.sect.name) : '无门无派'));
    out.push(kv('编号', escOf(c.id) + ' <span style="color:var(--ink-faint)">· ' + escOf(c.genSeed || '') + '</span>'));

    return out.join('');
  }

  /* ============================================================
   * DOM 区 (只在浏览器里跑)
   * ============================================================ */

  function pick(root, key) { return root ? root.querySelector('[data-ro="' + key + '"]') : null; }

  function bindDom(d) {
    var root = d.root;
    if (!root) return null;
    return {
      root: root,
      mask: pick(root, 'mask'),
      close: pick(root, 'close'),
      meta: pick(root, 'meta'),
      filters: pick(root, 'filters'),
      search: pick(root, 'search'),
      list: pick(root, 'list'),
      detail: pick(root, 'detail'),
      msg: pick(root, 'msg'),
    };
  }

  function renderFilters() {
    if (!dom || !dom.filters) return;
    var chips = [{ id: 'all', name: '全部', n: state.chars.length }]
      .concat(presentRealms(state.chars, state.dict));
    var h = '';
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      h += '<button class="ro-fchip' + (state.filter === c.id ? ' on' : '') + '" data-ro-f="' + escOf(c.id) + '">' +
        escOf(c.name) + '<b>' + num(c.n) + '</b></button>';
    }
    dom.filters.innerHTML = h;
  }

  function renderList() {
    if (!dom || !dom.list) return;
    if (!state.view.length) {
      dom.list.innerHTML = '<div class="ro-none">' + (state.query ? '无匹配' : '暂无角色') + '</div>';
      return;
    }
    var h = '';
    for (var i = 0; i < state.view.length; i++) h += rowHTML(state.view[i], state.selId);
    dom.list.innerHTML = h;
  }

  function renderDetail() {
    if (!dom || !dom.detail) return;
    var c = null;
    for (var i = 0; i < state.view.length; i++) if (state.view[i].id === state.selId) { c = state.view[i]; break; }
    if (!c && state.view.length) { c = state.view[0]; state.selId = c.id; }
    dom.detail.innerHTML = c
      ? detailHTML(c, state.dict)
      : '<div class="ro-none">从左侧名册点选一人，或改改筛选条件</div>';
  }

  function renderMeta() {
    if (dom && dom.meta) {
      dom.meta.textContent = state.loaded
        ? (state.count + ' 人 · seed ' + (state.seed || '-') + ' · 现显 ' + state.view.length)
        : (state.loading ? '读取中…' : (state.error || '未加载'));
    }
    if (dom && dom.msg) {
      dom.msg.textContent = state.error ? (
        state.error + ' —— 数据来自服务端 /api/characters (需先启动后端)'
      ) : '';
      dom.msg.classList.toggle('bad', !!state.error);
    }
  }

  function renderAll() {
    if (!dom) return;
    renderFilters();
    renderList();
    renderDetail();
    renderMeta();
    if (dom.search && dom.search.value !== state.query) dom.search.value = state.query;
  }

  function recompute() {
    state.view = applyFilter(state.chars, state.filter, state.query);
    var has = false;
    for (var i = 0; i < state.view.length; i++) if (state.view[i].id === state.selId) has = true;
    if (!has) state.selId = state.view.length ? state.view[0].id : null;
  }

  function setOpen(open) {
    state.open = !!open;
    if (dom && dom.root) dom.root.classList.toggle('hidden', !state.open);
    if (deps && typeof deps.onToggle === 'function') deps.onToggle(state.open);
    /* 首次打开才拉数据 (没点过的人不该付一次 1MB 请求) */
    if (state.open && !state.loaded && !state.loading) load();
  }

  function load() {
    if (state.loading) return Promise.resolve();
    state.loading = true; state.error = '';
    renderMeta();
    var url = (deps && deps.dataUrl) || 'api/characters';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (payload) {
        var n = normalize(payload);
        state.dict = n.dict;
        state.chars = n.chars;
        state.seed = n.seed;
        state.count = n.count;
        state.loaded = true;
        state.loading = false;
        state.selId = n.chars.length ? n.chars[0].id : null;
        recompute();
        renderAll();
      })
      .catch(function (err) {
        state.loading = false;
        state.loaded = false;
        state.error = '读取角色数据失败: ' + ((err && err.message) || err);
        renderAll();
      });
  }

  function bindEvents() {
    if (!dom) return;
    if (deps.btn) {
      deps.btn.addEventListener('click', function (e) { e.stopPropagation(); setOpen(!state.open); });
    }
    if (dom.close) dom.close.addEventListener('click', function () { setOpen(false); });
    if (dom.mask) dom.mask.addEventListener('click', function () { setOpen(false); });
    if (dom.filters) {
      dom.filters.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-ro-f]') : null;
        if (!b) return;
        state.filter = b.getAttribute('data-ro-f') || 'all';
        recompute(); renderAll();
      });
    }
    if (dom.list) {
      dom.list.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-ro-id]') : null;
        if (!b) return;
        state.selId = b.getAttribute('data-ro-id');
        renderList(); renderDetail();
      });
    }
    if (dom.search) {
      dom.search.addEventListener('input', function () {
        state.query = this.value || '';
        recompute(); renderAll();
      });
    }
    /* Esc 关窗。⚠ 与卜居/设置的 Esc 各自独立判断 (各查各的开态), 互不吞噬 ——
       与 main.js 里那两条监听同款口径。 */
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (state.open) setOpen(false);
    });
  }

  /* ============================================================
   * 对外
   * ============================================================ */
  function init(d) {
    deps = d || null;
    if (!deps) return false;
    dom = (typeof document !== 'undefined') ? bindDom(deps) : null;
    if (dom) bindEvents();
    return !!dom;
  }

  window.SectRoster = {
    init: init,
    ready: function () { return !!dom; },
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!state.open); },
    isOpen: function () { return state.open; },
    load: load,
    /* 纯函数出口 (供 verify_roster.mjs 在 Node 中裸跑) */
    normalize: normalize,
    presentRealms: presentRealms,
    applyFilter: applyFilter,
    rowHTML: rowHTML,
    detailHTML: detailHTML,
    /* 只读探针 (headless 断言「窗口就位 / 数据到货 / 选的是谁」) */
    probe: function () {
      return {
        ready: !!dom,
        open: state.open,
        loaded: state.loaded,
        loading: state.loading,
        error: state.error,
        count: state.chars.length,
        shown: state.view.length,
        filter: state.filter,
        query: state.query,
        selected: state.selId,
        realms: presentRealms(state.chars, state.dict).length,
      };
    },
  };
})();
