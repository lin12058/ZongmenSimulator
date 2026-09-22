/* ============================================================
 * infocard.js — 「他人宗门 / 聚落详情卡」独立模块
 *
 * 为什么独立成文件 (2026-09-23):
 *   · 左上角 #sectWrap 从「宗门录 + 择宗」改造成「本宗」面板 (只看玩家自己);
 *   · 「查看**其他**宗门/聚落的详情」(掌门/门人/地界/灵脉/山门营建/岁入)
 *     属于另一套 UI 体系 ⇒ 从 main.js 抽出来, 自成模块, 待那套 UI 定形后接线。
 *
 * 与 main.js 的关系 (照 minimap-vein.js 的单点注入姿势):
 *   · 本模块**不直接引用** main.js 的内部变量, 一切经 init(deps) 注入;
 *   · main.js 只在启动后调一次 initInfoCard() 把数据源接上 —— **不渲染**;
 *   · 将来接线: 调 InkInfoCard.describe(q, r) 拿 { found, kind, name, html },
 *     把 html 塞进那套 UI 的容器即可 (样式类 .sec-* 仍由 index.html 提供)。
 *
 * 边界:
 *   · 只读。不写任何 main.js 状态, 不触发重绘, 不发请求。
 *   · 数据源 (settleCells/regionCells/commCells) 以**取值函数**注入 ⇒
 *     即使 main.js 之后 .clear() 或换 seed, 本模块读到的仍是最新集合。
 * ============================================================ */
(function () {
  'use strict';

  var deps = null;

  /* ---- 与本模块强绑定、原属 main.js「宗门录」区的常量 (已随迁) ----
     ⚠ TIER_NAME (品阶名) **不在此处** —— 它是全局命名口径, 留在 main.js,
     由 init({ tierName }) 注入 (本宗面板与将来的立宗 UI 同样要用)。 */
  var MASTER_CH = '玄清太云素无孤寒沧离明虚重白赤青洞霄寂衍真澄空'.split('');
  var MASTER_TAIL = ['真人', '上人', '道人', '散人', '老祖', '尊主'];
  /* 最近灵脉: 遍历已加载的群落包 (随视野窗口有界, 无额外请求)。
     VEIN_NEAR 格以外视为「未附」—— 免得写出一条几百格外的灵脉充数。 */
  var VEIN_NEAR = 60;

  function must(name) {
    if (!deps) throw new Error('InkInfoCard.init() 未调用');
    if (typeof deps[name] !== 'function') throw new Error('InkInfoCard 依赖缺失: ' + name);
    return deps[name];
  }

  /* ---------- 派生量 (全是纯函数, 无缓存) ---------- */
  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hexDist(q0, r0, q1, r1) {
    var dq = q1 - q0, dr = r1 - r0;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }
  function tileDistFrom(wx, wy, q, r) {
    var t = must('pxToTile')(wx, wy);
    return Math.round(hexDist(q, r, t.q, t.r));
  }
  /* 掌门: 有 owner 用 owner; 否则由 seed + id 确定性派生道号
     (事件系统接入后改为直接读 owner)。 */
  function masterOf(ent) {
    if (ent.owner) return ent.owner;
    var h = hash32(must('worldSeed')() + '#' + ent.id);
    return MASTER_CH[h % MASTER_CH.length] +
           MASTER_CH[(h >>> 6) % MASTER_CH.length] +
           MASTER_TAIL[(h >>> 11) % MASTER_TAIL.length];
  }
  function regionNameAt(q, r) {
    var m = must('regionM')();
    if (!m) return '';
    var pack = must('regionCells')().get(Math.floor(q / m) + ',' + Math.floor(r / m));
    return pack && pack.region ? pack.region.name : '';
  }
  function nearestVein(q, r) {
    var best = null;
    must('commCells')().forEach(function (cm) {
      if (!cm.exists || !cm.veins) return;
      for (var i = 0; i < cm.veins.length; i++) {
        var v = cm.veins[i];
        var d = tileDistFrom(v.x, v.y, q, r);
        if (!best || d < best.d) best = { v: v, d: d };
      }
    });
    return best && best.d <= VEIN_NEAR ? best : null;
  }

  /* ---------- 找: 该格属于哪座聚落 ---------- */
  /* 该格是否属于某座聚落的营建 (宗址格或它的山门建筑格) */
  function tileInBuildings(ent, q, r) {
    var bl = ent.buildings || [];
    for (var i = 0; i < bl.length; i++) if (bl[i].q === q && bl[i].r === r) return true;
    return false;
  }
  /* 找 q,r 格上的聚落 (中心格 或 任一营建格)。找不到返回 null。 */
  function findAt(q, r) {
    var hit = null;
    must('settleCells')().forEach(function (list) {
      if (hit) return;
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (ent.type !== 'sect' || ent.state === 1) continue;   // 非宗门 / 已毁
        if ((ent.q === q && ent.r === r) || tileInBuildings(ent, q, r)) { hit = ent; return; }
      }
    });
    return hit;
  }

  /* ---------- 渲染: 详情卡 HTML ---------- */
  function tagList(list) {
    var h = '<div class="chips">';
    for (var i = 0; i < list.length && i < 8; i++)
      h += '<span class="tag">' + must('esc')(list[i].name) + '<b>' + list[i].n + '</b></span>';
    return h + '</div>';
  }
  function kindsOf(buildings) {
    var c = {}, order = [];
    for (var i = 0; i < buildings.length; i++) {
      var k = buildings[i].kind || '屋舍';
      if (c[k] == null) { c[k] = 0; order.push(k); }
      c[k]++;
    }
    return order.map(function (k) { return { name: k, n: c[k] }; })
                .sort(function (a, b) { return b.n - a.n; });
  }
  /* ent = 聚落实体, d = 参考点距它多少格 (无参考点时传 0) */
  function cardHTML(ent, d) {
    var esc = must('esc'), row = [];
    function kv(k, v) {
      return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    }
    row.push('<div class="sec-top"><div class="sec-name">' + esc(ent.name) + '</div>' +
             '<div class="sec-seal">' + esc(String(ent.name).slice(0, 2)) + '</div></div>');
    row.push('<div class="sec-sub">' + (must('tierName')()[ent.tier] || '宗门') +
             (ent.styleName ? ' · ' + esc(ent.styleName) : '') + '</div>');
    row.push('<div class="ink-rule"></div>');
    row.push(kv('掌门', esc(masterOf(ent))));
    row.push(kv('门人', (ent.pop || 0).toLocaleString() + ' 口'));
    row.push(kv('地界', esc(regionNameAt(ent.q, ent.r) || '未探明')));
    row.push(kv('位次', (ent.q < 0 ? '西 ' + (-ent.q) : '东 ' + ent.q) + ' · ' +
                         (ent.r < 0 ? '北 ' + (-ent.r) : '南 ' + ent.r)));
    row.push(kv('距此', '<span class="sec-dist">' + d + '</span> 格'));
    var nv = nearestVein(ent.q, ent.r);
    row.push(kv('灵脉', nv
      ? esc(must('veinLabel')(nv.v)) + ' · ' + nv.d + ' 格'
      : '未附灵脉'));
    var bl = ent.buildings || [], rs = ent.resources || [];
    if (bl.length) {
      row.push('<div class="sec-cap">山门营建</div>');
      row.push(tagList(kindsOf(bl)));
    }
    if (rs.length) {
      row.push('<div class="sec-cap">岁入</div>');
      row.push(tagList(rs.map(function (x) { return { name: x.resource, n: x.amount }; })));
    }
    return row.join('');
  }

  /* ---------- 对外 ---------- */
  /* 一站式: 给一格 → 拿该格聚落的完整详情。
     refQ/refR = 算「距此」用的参考格 (一般是相机中心), 省略则不算距离。 */
  function describe(q, r, refQ, refR) {
    var ent = findAt(q, r);
    if (!ent) return { found: false, kind: 'none', name: '', ent: null, html: '' };
    var d = (refQ == null) ? 0 : Math.round(hexDist(refQ, refR, ent.q, ent.r));
    return {
      found: true,
      kind: ent.type,
      name: ent.name,
      ent: ent,
      q: ent.q, r: ent.r,
      dist: d,
      html: cardHTML(ent, d)
    };
  }

  window.InkInfoCard = {
    init: function (d) {
      deps = d || null;
      return !!deps;
    },
    ready: function () { return !!deps; },
    findAt: findAt,
    cardHTML: cardHTML,
    describe: describe,
    /* 供 headless 判据读数 (本模块当前不渲染, 只能证明"模块就位 + 数据源已接") */
    probe: function () {
      if (!deps) return { ready: false };
      var n = 0;
      must('settleCells')().forEach(function (list) {
        for (var i = 0; i < list.length; i++)
          if (list[i].type === 'sect' && list[i].state !== 1) n++;
      });
      return { ready: true, sects: n, hasDescribe: typeof describe === 'function' };
    }
  };
})();
