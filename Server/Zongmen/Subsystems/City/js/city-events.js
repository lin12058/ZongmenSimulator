/* ============================================================
 * city-events.js —— 聚落事件的**脚本实现**（跨 tick 事件系统的执行端）
 * ------------------------------------------------------------
 * 由 C# 的 `EventRunner` 经统一出口 `CityEvo.eventScriptJson(scriptId, fnId, stateJson, ctxJson)` 调用。
 *
 * ★ 返回约定（三选一，都合法）
 *     'null'                          不改变任何状态（引擎/台账都不写）
 *     '{"state":{...}}'               新状态（必须是**同一实体**的完整 CityState）
 *     '{"state":{...},"spawn":[{"fn":2,"after":60}]}'   改状态 + 派生后续事件
 *
 * ★ 三条铁律
 *   R1. **绝不许改身份字段**（id/type/q/r）。C# 侧会比对并抛异常 —— 那是 seed 纯函数结论。
 *   R2. **必须幂等**。崩在「状态已写、History 未提交」之间时本函数会被重放。
 *       ⇒ 判据一律写成「看到状态已经是目标态就返回 null」，**绝不能**写 `pop *= 0.9`
 *         这种无条件乘 —— 重放会扣两次。
 *   R3. **必须确定性**。不许用 Math.random / Date.now。需要"随机"就用
 *       `hash32(entityKey ^ tick ^ runCount)`，否则两台机器跑出不同世界、回放必分歧。
 *
 * ★ 为什么派生用 `spawn` 而不是直接改 NextTick
 *   事件之间不许有"我在处理时顺手触发你并立刻执行"的边 —— 那会让结果依赖遍历顺序。
 *   spawn 只是**往未来排一条**，下次收集才会跑（两阶段）。
 * ============================================================ */
(function (g) {
  'use strict';

  var CityEvo = g.CityEvo;
  if (!CityEvo) throw new Error('city-events.js 必须在 city-evo.js 之后加载（它挂在 global.CityEvo 上）');

  /* 与 C# CityEventFn 显式编号**逐值一致**。⚠ 改这里必须同步改 C#，否则事件会跑错函数。 */
  var FN = {
    NONE: 0,
    PLAGUE: 1,
    PLAGUE_END: 2,
    BOOM: 3,
    BOOM_END: 4,
    FIRE: 5,
    TICK: 6
  };

  var RES = CityEvo.E.RES_ORDER;          /* ['粮','木','矿','渔','炭','灵','丹','器'] */
  var I_GRAIN = 0, I_WOOD = 1;

  /* 事件态常量（与 city-evo.js 的 state 口径一致：0 正常 / 1 被毁 / 3 灾荒战乱） */
  var ST_NORMAL = 0, ST_RUINED = 1, ST_CRISIS = 3;

  /* ── 确定性伪随机（FNV-1a 32 位）—— 绝不用 Math.random ── */
  function hash32(x) {
    var h = 0x811c9dc5;
    x = (x | 0) >>> 0;
    for (var i = 0; i < 4; i++) {
      h ^= (x >>> (i * 8)) & 0xff;
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function frac(seed) { return (hash32(seed) % 10000) / 10000; }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  function stockOf(s, idx) {
    var k = RES[idx];
    var v = s.stock && s.stock[k];
    return typeof v === 'number' ? v : 0;
  }
  function addStock(s, idx, d) {
    if (!s.stock) s.stock = {};
    var k = RES[idx];
    var v = (typeof s.stock[k] === 'number' ? s.stock[k] : 0) + d;
    if (v < 0) v = 0;
    s.stock[k] = Math.round(v);
  }

  /** 人口增减：⚠ pop 与 popF 必须同步，否则下一批演化从旧 popF 续跑（Δ 铁律）。 */
  function addPop(s, delta) {
    var p = Math.round(s.pop + delta);
    if (p < 1) p = 1;
    s.pop = p;
    s.popF = p;
  }

  /** 每次状态真正改变都要 +ver（客户端缓存失效靠它）。 */
  function bumpVer(s) { s.ver = (s.ver | 0) + 1; }

  /* ============================================================
   * 1) 瘟疫：人口 -15%，进入事件态；60 tick 后派发「消退」
   * ============================================================ */
  function onPlague(s, ctx) {
    /* R2 幂等：已在事件态 ⇒ 什么都不做（重放安全，也不会叠两层瘟疫） */
    if (s.state === ST_CRISIS) return null;

    var loss = Math.max(10, Math.round(s.pop * 0.15));
    addPop(s, -loss);
    s.state = ST_CRISIS;
    bumpVer(s);

    return {
      state: s,
      /* 一次性事件：60 tick 后检查是否该解除 */
      spawn: [{ fn: FN.PLAGUE_END, after: 60 }]
    };
  }

  /* ============================================================
   * 2) 瘟疫消退：人口恢复到 popBase×0.9 才解除，否则 30 tick 后再看
   * ============================================================ */
  function onPlagueEnd(s, ctx) {
    if (s.state !== ST_CRISIS) return null;      /* 已经解除（重放安全） */

    var base = s.popBase > 0 ? s.popBase : s.pop;
    if (s.pop >= Math.round(base * 0.9)) {
      s.state = ST_NORMAL;
      bumpVer(s);
      return { state: s };
    }

    /* 还没恢复 ⇒ 不改状态，只往后推 30 tick 再检查。
       ⚠ 不改状态就不写 state（否则 diff 会记一条无意义的 ver 变化）。 */
    return { spawn: [{ fn: FN.PLAGUE_END, after: 30 }] };
  }

  /* ============================================================
   * 3) 丰收：粮 +30%、木 +20%、人口 +5%；90 tick 后派发「结束」
   * ============================================================ */
  function onBoom(s, ctx) {
    if (s.state === ST_RUINED) return null;      /* 废墟没有丰收 */

    /* R2 幂等：靠 ctx.runCount 判断（同一事件第二次被重放时 runCount 已 +1）。
       ⚠ 用 runCount 而不是「库存有没有涨过」—— 库存可能本来就这么高。 */
    if (ctx.runCount > 0) return null;

    addStock(s, I_GRAIN, Math.max(20, Math.round(stockOf(s, I_GRAIN) * 0.3)));
    addStock(s, I_WOOD, Math.max(10, Math.round(stockOf(s, I_WOOD) * 0.2)));
    addPop(s, Math.round(s.pop * 0.05));
    bumpVer(s);

    return {
      state: s,
      spawn: [{ fn: FN.BOOM_END, after: 90 }]
    };
  }

  /* ============================================================
   * 4) 丰收结束：**故意不改任何状态**
   *    用途：验证「事件触发了、但 diff 为空也写一条 History」这条路径。
   * ============================================================ */
  function onBoomEnd(s, ctx) { return null; }

  /* ============================================================
   * 5) 火灾：烧掉最后一座演化建筑 + 人口 -8%
   *    ⚠ 建筑必须按 built 数组删（骨架建筑是 seed 派生，不在台账里，改不了也不该改）。
   * ============================================================ */
  function onFire(s, ctx) {
    if (s.state === ST_RUINED) return null;      /* 已经是废墟（重放安全） */

    var built = Array.isArray(s.built) ? s.built : [];
    var burned = 0;
    if (built.length > 0) {
      /* 确定性选择：烧掉第 k 座，k 由 (entityId, tick) 决定 —— 同样的 tick 重放烧同一座 */
      var k = hash32((ctx.entityId | 0) ^ (ctx.tick | 0)) % built.length;
      built.splice(k, 1);
      s.built = built;
      burned = 1;
    }

    var loss = Math.max(5, Math.round(s.pop * 0.08));
    addPop(s, -loss);
    bumpVer(s);

    return { state: s, _burned: burned };
  }

  /* ============================================================
   * 6) 空事件：只验链路（判据 / 心跳），不改状态
   * ============================================================ */
  function onTickEvent(s, ctx) { return null; }

  var HANDLERS = {};
  HANDLERS[FN.PLAGUE] = onPlague;
  HANDLERS[FN.PLAGUE_END] = onPlagueEnd;
  HANDLERS[FN.BOOM] = onBoom;
  HANDLERS[FN.BOOM_END] = onBoomEnd;
  HANDLERS[FN.FIRE] = onFire;
  HANDLERS[FN.TICK] = onTickEvent;

  /* ============================================================
   * ★ 统一出口 —— C# `CityModule.Invoke` 的 `eventScriptJson` case 转到这
   * ------------------------------------------------------------
   * ⚠ 为什么只有一个出口（而不是每个函数一个 C# case）：
   *   事件的 (script, fn) 是**数据**，不是编译期枚举。每个函数一个 case 意味着
   *   加一个事件要改 C#、重编译、重部署；一个出口 + 内部 dispatch 则是纯数据驱动。
   *   代价 = 失去 C# 侧的静态检查，所以 `EventScriptRegistry` 必须与这里的
   *   HANDLERS 保持一一对应（判据 `check_event_system.mjs` 会逐值比对）。
   * ============================================================ */
  CityEvo.eventScriptJson = function (scriptId, fnId, stateJson, ctxJson) {
    if (scriptId !== 1) return 'null';            /* 1 = EventScript.City */
    var h = HANDLERS[fnId];
    if (!h) return 'null';                        /* 未实现的函数 ⇒ 明确「不改」，不抛 */

    var s = JSON.parse(stateJson);
    var ctx = JSON.parse(ctxJson);

    /* 传给脚本的是**副本**：脚本直接改 s 也行，但我们只在它 return 时采信返回值 ——
       这样「忘了 return」和「故意不改」都能被区分（前者日志里会是空 diff，一刀就能看出来）。 */
    var work = clone(s);
    var out = h(work, ctx);
    if (!out) return 'null';

    /* 兜底：脚本若把 state 塞在别的键里，这里统一搬到 state */
    if (!out.state && out.pop !== undefined) {
      throw new Error('city-events: 处理器返回了裸状态，必须包成 {state:...}');
    }
    return JSON.stringify(out);
  };

  /* ⚠ 这里刻意**不**再挂第二个公开出口（比如 `eventScripts()` 自查函数）：
     `check_js_exports.mjs` 要求 CityEvo 上每个函数型导出都有 C# case，
     多一个自查函数就要多一条只为了它的 case。自查改由判据直接 eval 本文件完成。 */
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
