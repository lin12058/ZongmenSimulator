/* ============================================================
 * recruit-panel.js — 招募面板 (聚落打探 / 刷新 / 入队)
 * ------------------------------------------------------------
 * 方案: docs/游戏设计/招募系统-实施方案.md §八
 * 入口: 山川志 (#info) 面板里的「招募弟子」按钮 → RecruitPanel.open(settleId, name)
 *
 * ★ 只做一个"展示 + 转发"层:
 *   · 能不能招、点数够不够、队伍在不在本镇 —— 全部读服务端响应 (hireGate / points),
 *     前端**不自己算**(自己算就会和服务端漂, 玩家看到的和实际结果不一致)。
 *   · 刷新之后不本地改数字: 一律用响应里的 taken/points 重绘。
 *
 * ★ 幂等: 同一格重复点招募, 服务端回 duplicated:true 且不重复扣点 ⇒ 这里当成功处理。
 * ============================================================ */
(function (g) {
  'use strict';

  var EL = null;                 // DOM 句柄 (懒建)
  var st = {
    open: false,
    settle: '',                  // 当前聚落 id (i_j_k)
    name: '',                    // 聚落名 (仅展示)
    data: null,                  // 最近一次 pool/roll 响应
    busy: false,
    msg: '',
    msgKind: '',                 // ok | err
    pickSlot: -1                 // 入队浮层: 正在招的 slot (-1 = 未打开)
  };

  var TIER_CN = { common: '寻常', uncommon: '良', rare: '异禀', epic: '天命' };
  var ELEM = ['金', '木', '水', '火', '土'];

  function bridge() { return g.RecruitBridge || null; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- DOM ---------------- */

  function build() {
    if (EL) return EL;
    var wrap = document.createElement('div');
    wrap.id = 'recruitWrap';
    wrap.className = 'hidden';
    wrap.innerHTML =
      '<div class="rc-mask" data-rc="close"></div>' +
      '<div class="rc-box panel" role="dialog" aria-modal="true" aria-label="招募">' +
      '  <h3 class="rc-title"><span>招 募</span><button type="button" class="rc-x" data-rc="close" title="关闭 (Esc)">✕</button></h3>' +
      '  <div class="rc-head">' +
      '    <div class="rc-settle" id="rcSettle">—</div>' +
      '    <div class="rc-points" id="rcPoints"></div>' +
      '  </div>' +
      '  <div class="rc-gate hidden" id="rcGate"></div>' +
      '  <div class="rc-actions">' +
      '    <button type="button" class="rc-btn rc-roll" id="rcRoll">刷新一批</button>' +
      '    <span class="rc-msg" id="rcMsg"></span>' +
      '  </div>' +
      '  <div class="rc-list" id="rcList"></div>' +
      '  <div class="rc-pick hidden" id="rcPick">' +
      '    <div class="rc-pick-cap">入 哪 支 队</div>' +
      '    <div class="rc-pick-list" id="rcPickList"></div>' +
      '    <button type="button" class="rc-btn rc-pick-cancel" data-rc="pick-cancel">取消</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);

    EL = {
      wrap: wrap,
      settle: wrap.querySelector('#rcSettle'),
      points: wrap.querySelector('#rcPoints'),
      gate: wrap.querySelector('#rcGate'),
      roll: wrap.querySelector('#rcRoll'),
      msg: wrap.querySelector('#rcMsg'),
      list: wrap.querySelector('#rcList'),
      pick: wrap.querySelector('#rcPick'),
      pickList: wrap.querySelector('#rcPickList')
    };

    wrap.addEventListener('click', onClick);
    document.addEventListener('keydown', function (e) {
      if (!st.open) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    return EL;
  }

  function onClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;

    if (t.closest('[data-rc="close"]')) { close(); return; }
    if (t.closest('[data-rc="pick-cancel"]')) { st.pickSlot = -1; render(); return; }
    if (t.closest('#rcRoll')) { doRoll(); return; }

    var hireBtn = t.closest('[data-rc-hire]');
    if (hireBtn) { onHireClick(parseInt(hireBtn.getAttribute('data-rc-hire'), 10)); return; }

    var pickBtn = t.closest('[data-rc-squad]');
    if (pickBtn) {
      var slot = st.pickSlot;
      var sq = pickBtn.getAttribute('data-rc-squad');     // '__new' = 显式新建一支
      doHire(slot, sq);
    }
  }

  /* ---------------- 渲染 ---------------- */

  function pointsLine(p) {
    if (!p) return '';
    return '招募值 <b>' + p.value + '</b>/' + p.cap +
           '<i>影响力 ' + p.influence + ' · 每年 +' + p.perYear + '</i>';
  }

  function rootText(c) {
    var p = c.pawn || {}, v = (p.root && p.root.v) || [], meta = c.meta || {};
    var parts = [];
    for (var i = 0; i < 5; i++) if (v[i] > 0) parts.push(ELEM[i]);
    var pct = meta.rootPct;
    var pctTxt = '';
    if (pct && pct.length === 5) {
      var vals = [];
      for (var k = 0; k < 5; k++) if (v[k] > 0) vals.push(Math.round(pct[k]) + '%');
      if (vals.length) pctTxt = '（' + (vals.length === 1 ? vals[0] : '各 ' + vals[0]) + '）';
    }
    if (!parts.length) return '灵根未显';
    return '灵根 ' + parts.join('/') + pctTxt + ' · ' + (meta.rootCount || parts.length) + ' 系';
  }

  function cardHTML(c, taken, points, gate) {
    var p = c.pawn || {}, meta = c.meta || {};
    var traits = (p.traits || []).map(function (t) {
      var tier = TIER_CN[t.tier] || '';
      return esc(t.n) + (tier ? '<em>' + tier + '</em>' : '');
    }).join('、') || '无';

    var disabled = taken || !gate.allowed || !points || points.value < points.hireCost;
    var btnTxt = taken ? '已入宗门'
      : (!gate.allowed ? '不在驻地' : '招募（-' + (points ? points.hireCost : '?') + '）');
    var cls = 'rc-btn rc-hire' + (disabled ? ' off' : '');

    return '<div class="rc-card' + (taken ? ' taken' : '') + '">' +
      '<div class="rc-card-top"><span class="rc-name">' + esc(p.name) + '</span>' +
      '<span class="rc-tag">' + esc(p.gender) + ' · ' + esc(p.age) + '</span>' +
      '<span class="rc-tag rc-bg">' + esc(meta.background || '来历不明') + '</span></div>' +
      '<div class="rc-card-mid">' + rootText(c) + ' · 天赋 ' + esc(meta.talentTotal || 0) +
      ' · ' + esc(p.realm || '') + '</div>' +
      '<div class="rc-card-low">特质：' + traits + '</div>' +
      '<div class="rc-card-act"><button type="button" class="' + cls + '" data-rc-hire="' + c.slot + '"' +
      (disabled ? ' disabled' : '') + '>' + btnTxt + '</button></div>' +
      '</div>';
  }

  function gateHTML(gate) {
    if (!gate || gate.allowed) return '';
    /* 只列**有队员**的队的驻地: 空队本来就能迁, 列进来只会让提示里的地名多出一堆噪音 */
    var names = (gate.squads || []).filter(function (s) { return s.members > 0 && s.settle; })
      .map(function (s) { return s.settleName || s.settle; });
    var where = names.length ? '「' + names.join('」「') + '」' : '别处';
    return '队伍驻地在' + esc(where) + '，需回到驻地才能招募（刷新不受限制）';
  }

  function pickHTML() {
    var d = st.data;
    if (!d || st.pickSlot < 0) return '';
    var gate = d.hireGate || { squads: [] };
    var squads = gate.squads || [];
    /* 编制上限 / 队数上限一律读服务端下发的 squadCap / maxSquads (老响应才退回 9 / 6)。
       前端写死会和服务端漂: 之前这里写 9、服务端从契约里读到 8 ⇒ 界面显示 8/9 却报满员。 */
    var cap = gate.squadCap || 9;
    var maxSquads = gate.maxSquads || 6;
    var html = '', anyOn = false;
    for (var i = 0; i < squads.length; i++) {
      var s = squads[i];
      var full = s.full != null ? !!s.full : s.members >= cap;
      /* 能不能进这支队由服务端的 canEnter 说了算:
         空队 (可改绑驻地) / 驻地为空 (老存档, 可补绑) / 驻地就是本镇 ⇒ 可进。
         ⚠ 别用 `!s.here` 自己判 —— 那会把「空队」和「驻地为空」两类合法目标全置灰。 */
      var canEnter = s.canEnter != null ? !!s.canEnter
        : (s.members === 0 || s.here || !s.settle);
      var off = !canEnter || full;
      if (!off) anyOn = true;
      var note;
      if (full) note = '满员';
      else if (s.members === 0) note = s.here ? '空队' : '空队 · 迁到本聚落';
      else if (s.here || !s.settle) note = '';
      else note = '驻地：' + (s.settleName || s.settle || '未知');
      html += '<button type="button" class="rc-btn rc-pick-item' + (off ? ' off' : '') + '"' +
        ' data-rc-squad="' + esc(s.id) + '"' + (off ? ' disabled' : '') + '>' +
        esc(s.name) + '<i>' + s.members + '/' + cap + (note ? ' · ' + esc(note) : '') + '</i></button>';
    }
    if (squads.length < maxSquads) {
      html += '<button type="button" class="rc-btn rc-pick-item" data-rc-squad="__new">新建小队<i>驻地＝本聚落</i></button>';
      anyOn = true;
    }
    /* 一支都进不去又没得新建 ⇒ 说清原因, 否则玩家看到一屏灰按钮不知道该怎么办 */
    if (!anyOn) html += '<div class="rc-pick-tip">没有能进的队（满员或驻地不在本镇）</div>';
    return html;
  }

  function render() {
    if (!EL) return;
    var d = st.data;
    var gate = (d && d.hireGate) || { allowed: false, squads: [] };
    var pts = d && d.points;

    EL.settle.textContent = st.name || (d && d.settle && d.settle.name) || '—';
    EL.points.innerHTML = pointsLine(pts);

    var gtxt = gateHTML(gate);
    EL.gate.classList.toggle('hidden', !gtxt);
    EL.gate.innerHTML = gtxt;

    var cost = pts ? pts.rollCost : 0;
    EL.roll.textContent = '刷新一批（-' + cost + '）';
    EL.roll.disabled = st.busy || !pts || pts.value < cost;
    EL.msg.textContent = st.msg || '';
    EL.msg.className = 'rc-msg' + (st.msgKind ? ' ' + st.msgKind : '');

    var listHtml;
    if (!d) {
      listHtml = '<div class="rc-empty">' + (st.busy ? '打探中…' : '尚未打探') + '</div>';
    } else if (!d.candidates || !d.candidates.length) {
      listHtml = '<div class="rc-empty">此地无人应召（池量为 0）</div>';
    } else {
      var taken = d.taken || [];
      listHtml = d.candidates.map(function (c) {
        return cardHTML(c, taken.indexOf(c.slot) >= 0, pts, gate);
      }).join('');
    }
    EL.list.innerHTML = listHtml;

    var ph = pickHTML();
    EL.pick.classList.toggle('hidden', !ph);
    EL.pickList.innerHTML = ph;
  }

  /* ---------------- 动作 ---------------- */

  /* keepMsg: 招完人重新拉池子时**别把刚写好的「已入宗门」擦掉** ——
     否则提示闪一下就没了, 玩家只看到点数变 0。 */
  function load(keepMsg) {
    var B = bridge();
    if (!B) { st.msg = '招募网络层未加载 (recruit-bridge.js)'; st.msgKind = 'err'; render(); return; }
    var sid = st.settle;                    // 这次请求是针对哪个聚落的
    st.busy = true;
    if (!keepMsg) st.msg = '';
    render();
    B.pool(sid).then(function (res) {
      /* ⚠ 关掉面板又点了另一个镇: 旧响应可能比新的先回来, 不判就会把 A 镇的人
         画到 B 镇的标题下 (面板数据与聚落错位)。聚落变了直接丢弃, busy 交给新请求清。 */
      if (sid !== st.settle) return;
      st.busy = false;
      if (!res || res.ok === false) {
        st.msg = (res && res.error) || '打探失败';
        st.msgKind = 'err';
      } else {
        st.data = res;
        if (!st.name && res.settle) st.name = res.settle.name || '';
      }
      render();
    });
  }

  function doRoll() {
    if (st.busy) return;
    var B = bridge();
    if (!B) return;
    var d = st.data;
    var left = d ? (d.candidates || []).filter(function (c) {
      return (d.taken || []).indexOf(c.slot) < 0;
    }).length : 0;
    if (left > 0 && typeof g.confirm === 'function' &&
        !g.confirm('当前池中还有 ' + left + ' 人未招募，刷新将换一批（-' +
                   ((d.points && d.points.rollCost) || 0) + '）')) return;
    st.busy = true;
    st.msg = '换批中…';
    st.msgKind = '';
    render();
    var sid = st.settle;
    B.roll(sid).then(function (res) {
      if (sid !== st.settle) return;          // 换镇了 ⇒ 旧响应作废 (同上)
      st.busy = false;
      if (!res || res.ok === false) {
        st.msg = (res && res.error) || '刷新失败';
        st.msgKind = 'err';
        if (res && res.points && st.data) st.data.points = res.points;
      } else {
        st.data = {
          settle: (d && d.settle) || null, rollNo: res.rollNo, taken: res.taken,
          points: res.points, hireGate: res.hireGate, candidates: res.candidates
        };
        st.msg = '已换第 ' + (res.rollNo + 1) + ' 批（-' + (res.points ? res.points.rollCost : 0) + '）';
        st.msgKind = 'ok';
      }
      st.pickSlot = -1;
      render();
    });
  }

  function onHireClick(slot) {
    if (st.busy || slot < 0) return;
    var d = st.data;
    if (!d) return;
    var gate = d.hireGate || { squads: [] };
    if (!gate.allowed) return;
    /* 一支队都没有 ⇒ 直接招 (服务端自动新建, 驻地 = 本聚落); 有队则让玩家选进哪支 */
    if (!gate.squads || !gate.squads.length) { doHire(slot, ''); return; }
    st.pickSlot = slot;
    render();
  }

  /* squadId: 具体队 id；'__new' ⇒ 显式新建一支 (不复用空队, 驻地 = 本聚落)。 */
  function doHire(slot, squadId) {
    if (st.busy || slot < 0) return;
    var B = bridge();
    if (!B) return;
    var forceNew = squadId === '__new';
    var sid = forceNew ? '' : (squadId || '');
    var cand = null, list = (st.data && st.data.candidates) || [];
    for (var i = 0; i < list.length; i++) if (list[i].slot === slot) cand = list[i];
    var nm = (cand && cand.pawn && cand.pawn.name) || '此人';

    st.busy = true;
    st.msg = '招募中…';
    st.msgKind = '';
    st.pickSlot = -1;
    render();

    var at = st.settle;
    B.hire(at, slot, sid, forceNew ? { newSquad: true } : null).then(function (res) {
      if (at !== st.settle) return;          // 换镇了 ⇒ 旧响应作废 (同上)
      st.busy = false;
      if (!res || res.ok === false) {
        st.msg = (res && res.error) || '招募失败';
        st.msgKind = 'err';
        if (res && res.points && st.data) st.data.points = res.points;
        if (res && res.hireGate && st.data) st.data.hireGate = res.hireGate;
        render();
        return;
      }
      st.msg = res.duplicated ? ('「' + nm + '」已在宗门里（未重复扣点）') : ('「' + nm + '」已入宗门');
      st.msgKind = 'ok';
      /* ⚠ 不复用响应里的局部数据拼池子: taken/点数/闸门都会变, 直接重新打探一次
         (服务端池子是快照, 重取是幂等的、不扣点)。
         keepMsg=true ⇒ 保住上面那句「已入宗门」。 */
      load(true);
      refreshCrew();
    });
  }

  /* 入队后把队伍面板重装成服务端契约 (否则面板还停在演示数据 / 旧名单) */
  function refreshCrew() {
    var CB = g.CrewBridge;
    if (!CB || !CB.autoMount) return;
    CB.autoMount('api/crew').then(function (r) {
      if (r && r.ok && CB.configureEvents) {
        /* 服务端暂无 /api/crew/events (接口档 §14 未实现) ⇒ 关掉事件队列,
           否则每条拖动/换装都会往一个 404 端点重发。 */
        try { CB.configureEvents({ enabled: false }); } catch (e) { /* 忽略 */ }
      }
    });
  }

  /* ---------------- 对外 ---------------- */

  function open(settleId, name) {
    if (!settleId) { console.warn('[recruit] open() 缺 settleId'); return false; }
    build();
    st.open = true;
    st.settle = String(settleId);
    st.name = name || '';
    st.data = null;
    st.msg = '';
    st.msgKind = '';
    st.pickSlot = -1;
    EL.wrap.classList.remove('hidden');
    render();
    load();
    return true;
  }

  function close() {
    if (!EL) return;
    st.open = false;
    st.pickSlot = -1;
    EL.wrap.classList.add('hidden');
  }

  g.RecruitPanel = {
    open: open,
    close: close,
    reload: function () { if (st.open) load(); },
    isOpen: function () { return st.open; },
    /* headless 判据读数 (面板真的画出来了吗 / 闸门是什么) */
    probe: function () {
      var d = st.data;
      return {
        ready: !!EL,
        open: st.open,
        settle: st.settle,
        name: st.name,
        busy: st.busy,
        rollNo: d ? d.rollNo : null,
        points: d ? d.points : null,
        allowed: d && d.hireGate ? !!d.hireGate.allowed : null,
        gateReason: d && d.hireGate ? d.hireGate.reason : null,
        taken: d ? d.taken : null,
        candidates: d && d.candidates ? d.candidates.length : 0,
        cards: EL ? EL.list.querySelectorAll('.rc-card').length : 0,
        hireButtons: EL ? EL.list.querySelectorAll('[data-rc-hire]').length : 0,
        enabledButtons: EL ? EL.list.querySelectorAll('[data-rc-hire]:not([disabled])').length : 0,
        gateVisible: EL ? !EL.gate.classList.contains('hidden') : false,
        msg: st.msg
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})(typeof window !== 'undefined' ? window : globalThis);
