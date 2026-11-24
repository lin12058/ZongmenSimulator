/* ============================================================
 * people-layer.js — 地图人物分布「图层5」的前端表现层 (window.PeopleLayer)
 * ------------------------------------------------------------
 * 数据源: WS 块响应的 People 子消息 (稀疏 [{q,r,n,ps}]) —— 与既有图层同一条流水线。
 *   · n  = 该格人数   · ps = 该格战力总和
 * 职责 (方案 `待办事项/地图人物分布-实施方案.md` v2 · Q1/Q2/Q4):
 *   ① **人力热力图** —— 开关打开时, 按 ps 给每格涂暖色 (default 关; 关着时连请求都不带该位)
 *   ② **点击淡出**   —— 点某格的那一下, 把它周围「一个区块距离」内的格按**距离由近到远**
 *                       逐格淡出显示战力; 1.5s 后自动消失 (Q2「只在点击那一下显示」)
 *   ③ **点击详情**   —— 在 #infoBody 的「山川志」末尾追加「人烟」区: 该格小队按战力降序
 *                       (数据来自 GET /api/people?q=&r=, 服务端现算)
 *
 * ★ 为什么单独成模块: main.js 已经很长, 且这块是**可拔插的表层** —— 删掉本文件 +
 *   三处 hook (mask/wantBlock/onBlock/draw/noteClick/sectionHTML) 即完全回到旧行为。
 * ★ 本模块**不碰**静态层; 全部画在覆盖层 (随帧重绘, 天然支持淡出动画)。
 * ============================================================ */
(function (g) {
  'use strict';

  var PL = {};
  var deps = null;
  var on = false;                        // 与 ZMStore.settings.people 同步
  var byBlock = new Map();               // 'ca,cb' -> [{q,r,n,ps}]
  var click = null;                      // { q, r, at }  最近一次点击
  var CLICK_FADE_MS = 1500;              // 点击战力的存活时间
  var HEAT_MAX_ALPHA = 0.55;

  function now() { return g.performance ? g.performance.now() : Date.now(); }
  function readStore() {
    var S = g.ZMStore;
    return !!(S && S.settings && S.settings.get && S.settings.get('people'));
  }

  PL.init = function (d) {
    deps = d || {};
    on = readStore();
    /* 直接订阅 store (不依赖 main.js 的 applySettings 转发): 两条路都走也安全 ——
       refresh() 幂等 (开关没变就直接返回)。 */
    try {
      var S = g.ZMStore;
      if (S && S.settings && S.settings.on) {
        S.settings.on(function (key) { if (key === 'people' || key === '*') PL.refresh(); });
      }
    } catch (e) { /* 无 store: 静默 (本层非必需) */ }
  };

  /* ---------- 与块流水线的三处接口 ---------- */

  /* ⚠ 请求掩码的那一位**不在这里**做 —— main.js 在组装 mask 时统一
     `mask &= ~PB.MASK.PEOPLE`（关着时剔掉 = 服务端一个字节都不算），
     故原先的 PL.maskBit 无调用者，已删（避免留一个「看起来会用」的死 API）。 */

  /** 开关翻转: 已加载的块必须重新入队 —— updateStreaming 的入队条件是
   *  `!chunkData.has(key)`, 不重排的话「开了开关什么也没有」。 */
  PL.refresh = function () {
    var next = readStore();
    if (next === on) return;
    on = next;
    byBlock.clear();
    if (deps && deps.forceRescan) deps.forceRescan();
  };
  PL.enabled = function () { return on; };

  /** 该块是否还缺这一层 (供 main.js 的入队条件)。 */
  PL.wantBlock = function (key) { return on && !byBlock.has(key); };
  PL.dropBlock = function (key) { byBlock.delete(key); };

  /** 块到货: 落表。⚠ 服务端**明确没给**这一层时也要落一张空表 ——
   *  否则 wantBlock 恒真 ⇒ 无限重排请求风暴 (未登录就是这种情形)。 */
  PL.onBlock = function (resp, key) {
    if (!on) return;
    var tiles = (resp && resp.people && resp.people.tiles) || null;
    byBlock.set(key, tiles || []);
  };

  /* ---------- 交互 ---------- */

  /** 点选某格 (main.js selectTile 里调) —— 记下时刻, 触发「战力淡出」。 */
  PL.noteClick = function (tile) {
    if (!tile) return;
    click = { q: tile.q, r: tile.r, at: now() };
  };

  /* ---------- 绘制 (main.js drawOverlay 每帧调) ---------- */
  PL.draw = function (ctx) {
    if (!deps || byBlock.size === 0) return;
    if (!on && !(click && now() - click.at < CLICK_FADE_MS)) return;
    var geo = deps.geo();
    if (!geo) return;
    var v = deps.view();
    var k = v.dpr * v.zoom;
    if (!(k > 0)) return;

    ctx.save();
    ctx.setTransform(k, 0, 0, k, k * (v.vw / 2 - v.x), k * (v.vh / 2 - v.y));

    /* 上限: 用来把 ps 归一化到 0..1 (同视野内的最大值 ⇒ 每次平移会略变, 可接受)。 */
    var maxP = 1, i, j, arr;
    byBlock.forEach(function (a) {
      for (var t = 0; t < a.length; t++) if (a[t].ps > maxP) maxP = a[t].ps;
    });

    var hr = geo.hexR;
    var pad = hr * 2;
    var worldL = v.x - v.vw / 2 / v.zoom - pad, worldR = v.x + v.vw / 2 / v.zoom + pad;
    var worldT = v.y - v.vh / 2 / v.zoom - pad, worldB = v.y + v.vh / 2 / v.zoom + pad;

    /* ① 人力热力图: 每格战力总和 → 暖色深浅 */
    if (on) {
      byBlock.forEach(function (a) {
        for (var t = 0; t < a.length; t++) {
          var c = a[t];
          if (c.ps <= 0) continue;
          var w = deps.tileToWorld(c.q, c.r);
          if (w.x < worldL || w.x > worldR || w.y < worldT || w.y > worldB) continue;
          var f = Math.min(1, c.ps / maxP);
          ctx.fillStyle = 'rgba(178, 58, 44, ' + (0.10 + HEAT_MAX_ALPHA * f).toFixed(3) + ')';
          deps.hexPath(ctx, w.x, w.y, hr * 0.92);
          ctx.fill();
        }
      });
    }

    /* ② 点击淡出: 点击格 + 一个区块距离内的全部格, 按距离由近到远变淡; 1.5s 后消失 */
    if (click) {
      var age = now() - click.at;
      if (age >= CLICK_FADE_MS) { click = null; }
      else {
        var tf = 1 - age / CLICK_FADE_MS;              // 时间淡出
        var R = geo.chunkScan || 15;                   // 「一个区块的距离」
        var cw = deps.tileToWorld(click.q, click.r);
        ctx.lineWidth = 1.2 / v.zoom;
        byBlock.forEach(function (a) {
          for (var t = 0; t < a.length; t++) {
            var c = a[t];
            if (!c.ps) continue;
            var d = deps.hexDist(c.q, c.r, click.q, click.r);
            if (d > R) continue;
            var w2 = deps.tileToWorld(c.q, c.r);
            if (w2.x < worldL || w2.x > worldR || w2.y < worldT || w2.y > worldB) continue;
            var near = 1 - d / R;                      // 距离淡出 (越远越淡)
            var al = (0.18 + 0.62 * near) * tf;
            ctx.fillStyle = 'rgba(206, 116, 36, ' + al.toFixed(3) + ')';
            deps.hexPath(ctx, w2.x, w2.y, hr * 0.92);
            ctx.fill();
            ctx.strokeStyle = 'rgba(120, 50, 16, ' + (al * 0.9).toFixed(3) + ')';
            ctx.stroke();
          }
        });
        /* 点击那一刻的「中心注记」: 该格战力合计 */
        var cs = lookup(click.q, click.r);
        if (cs && cs.ps) {
          ctx.save();
          ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
          ctx.globalAlpha = tf;
          ctx.font = '600 13px system-ui, "Segoe UI", sans-serif';
          ctx.textAlign = 'center';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(255,252,244,0.92)';
          ctx.fillStyle = 'rgba(140, 44, 18, 1)';
          var sx = (cw.x - v.x) * v.zoom + v.vw / 2;
          var sy = (cw.y - v.y) * v.zoom + v.vh / 2 - 16;
          var label = '战力 ' + cs.ps.toLocaleString();
          ctx.strokeText(label, sx, sy);
          ctx.fillText(label, sx, sy);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  };

  function lookup(q, r) {
    var found = null;
    byBlock.forEach(function (a) {
      if (found) return;
      for (var t = 0; t < a.length; t++) if (a[t].q === q && a[t].r === r) { found = a[t]; return; }
    });
    return found;
  }

  /* ---------- 点击详情 (山川志面板里的「人烟」区) ---------- */

  /** 同步返回占位 HTML; 真正的小队列表异步填入 (#plSection)。 */
  PL.sectionHTML = function (q, r) {
    if (!on) return '';            // 热力图关: 连「人烟」区都不显示、也不发请求 (Q2「只在开启时才要」)
    var timer = g.setTimeout || setTimeout;
    timer(function () { loadSquads(q, r); }, 0);
    return '<div class="sep"></div><div id="plSection">' +
           '<div class="row"><span class="k">人烟</span><span class="v">探察中…</span></div></div>';
  };

  function loadSquads(q, r) {
    g.fetch('api/people?q=' + q + '&r=' + r)
      .then(function (res) { return res.json(); })
      .then(function (d) {
        var box = g.document.getElementById('plSection');
        if (!box) return;                       // 面板已换格 / 已关闭: 静默丢弃 (最新者胜)
        box.innerHTML = squadsHTML(d);
      })
      .catch(function () {
        var box = g.document.getElementById('plSection');
        if (!box) return;
        box.innerHTML = '<div class="row"><span class="k">人烟</span><span class="v">未察明</span></div>';
      });
  }

  function squadsHTML(d) {
    var esc = (deps && deps.esc) || function (x) { return String(x == null ? '' : x); };
    var n = d && d.n ? (d.n | 0) : 0;
    if (!n) return '<div class="row"><span class="k">人烟</span><span class="v">此地无人</span></div>';
    var out = ['<div class="row"><span class="k">人烟</span><span class="v big">' + n + ' 人</span></div>',
               '<div class="row"><span class="k">战力</span><span class="v">' +
               (d.ps | 0).toLocaleString() + '</span></div>'];
    var sq = d.squads || [], lim = Math.min(sq.length, 8), i;
    for (i = 0; i < lim; i++) {
      var s = sq[i], rep = s.rep || {};
      out.push('<div class="row"><span class="k">' + (i + 1) + ' 队</span><span class="v">' +
               esc(rep.name || '无名') + ' · ' + esc(rep.stage || rep.realm || '') +
               ' · ' + (s.size | 0) + ' 人 · 战力 ' + (s.power | 0) + '</span></div>');
    }
    if (sq.length > lim)
      out.push('<div class="row"><span class="k"></span><span class="v">另有 ' + (sq.length - lim) + ' 队</span></div>');
    return out.join('');
  }

  /* 自检/调试快照 */
  PL.debug = function () {
    var n = 0, tiles = 0;
    byBlock.forEach(function (a) { n++; tiles += a.length; });
    return { on: on, blocks: n, tiles: tiles, click: click };
  };

  g.PeopleLayer = PL;
})(typeof window !== 'undefined' ? window : globalThis);
