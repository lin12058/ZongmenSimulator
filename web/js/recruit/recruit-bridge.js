/* ============================================================
 * recruit-bridge.js — 招募系统 ↔ 服务端 (唯一网络层)
 * ------------------------------------------------------------
 * 方案: docs/游戏设计/招募系统-实施方案.md §八
 *
 * 四个端点 (全部由服务端权威, 前端不算任何数值):
 *   GET  api/recruit/state            招募值 + 常量 (rollCost/hireCost/cap/perYear)
 *   GET  api/recruit/pool?settle=ID   打探候选池 (首次自动生成并落库 = 防刷的核心)
 *   POST api/recruit/roll             刷新一批 (-rollCost)
 *   POST api/recruit/hire             招一人 (-hireCost)
 *
 * ★ 前端**不许**硬编码 30/50/300/10: 这些一律从响应里的 points 读。影响力系统上线后
 *   产量与上限会一起变, 写死的界面会立刻说谎。
 *
 * ★ 刷新网页看到同一批人 = 服务端把池子快照落了库; 这里只负责"照原样显示"。
 * ============================================================ */
(function (g) {
  'use strict';

  var BASE = 'api/recruit';
  var lastPool = null;      // 最近一次成功的 pool/roll 响应 (含 candidates)
  var lastPoints = null;    // 最近一次拿到的点数块

  function req(url, opts) {
    return fetch(url, opts).then(function (r) {
      /* 4xx/5xx 也带 JSON 业务体 (bad-settle / bad-slot), 不能按失败直接丢 */
      return r.json().catch(function () {
        return { ok: false, code: 'bad-response', error: '服务端返回非 JSON (' + r.status + ')' };
      }).then(function (body) {
        if (body && body.points) lastPoints = body.points;
        if (body && body.ok === false && !body.error) body.error = '请求失败 (' + r.status + ')';
        return body;
      });
    }).catch(function (e) {
      return { ok: false, code: 'network', error: '网络错误: ' + (e && e.message || e) };
    });
  }

  function post(url, body) {
    return req(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function remember(res) {
    if (res && res.ok && Array.isArray(res.candidates)) lastPool = res;
    return res;
  }

  g.RecruitBridge = {
    BASE: BASE,

    /** 点数 + 服务器常量 (面板头行用; 不依赖聚落)。 */
    state: function () { return req(BASE + '/state'); },

    /** 打探某聚落的候选池 (免费 · 幂等 · 首次自动落库)。 */
    pool: function (settleId) {
      return req(BASE + '/pool?settle=' + encodeURIComponent(settleId || '')).then(remember);
    },

    /** 换一批 (服务端扣 rollCost; 余额不足回 ok:false)。 */
    roll: function (settleId) {
      return post(BASE + '/roll', { settle: settleId }).then(remember);
    },

    /** 招一人。squadId 省略 = 服务端自选 (有队员的队 → 第一支空队);
     *  opts.newSquad = true ⇒ 不复用空队, 直接新建一支 (驻地 = 本次聚落)。 */
    hire: function (settleId, slot, squadId, opts) {
      var body = { settle: settleId, slot: slot };
      if (squadId) body.squadId = squadId;
      if (opts && opts.newSquad) body.newSquad = true;
      return post(BASE + '/hire', body);
    },

    lastPool: function () { return lastPool; },
    lastPoints: function () { return lastPoints; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
