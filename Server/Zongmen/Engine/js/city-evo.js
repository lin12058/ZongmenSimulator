/* ============================================================================
 * city-evo.js — 脚本化城市迭代 · 引擎侧纯函数演化器 (P2 融入)
 *
 * ---------------------------------------------------------------------------
 * ★★ 设计契约 (与 TickJobRegistry / TickVmPoolExecutor 的边界) ★★
 *
 *   本文件是「引擎侧演化器」, 只做**纯计算**, 绝不持有任何世界状态:
 *     入参 = { 聚落元数据(引擎只读出口派生) + CityState快照(C# 台账搬来) + dt }
 *     出参 = { 新 CityState 快照 + 本批解释性事件 }
 *
 *   ⚠ 为什么必须无状态: V8 实例由 `JsEngineHost` 池化复用 (多 seed / 多 job
 *     共用同一 VM), 且 `JsWorldVm.Call` 全程持 `_gate` 单线程串行。
 *     任何「挂在本文件闭包里的 CityState 表」都会在**换世 / 多 seed** 时串味。
 *     ⇒ 台账真源在 C# (`Storage/CityStateStore.cs`), 本文件只是转换函数。
 *
 * ---------------------------------------------------------------------------
 * 红线 (与 v2 方案 §0.3 一致, 任何一条破了都是静默错):
 *   R1. 本文件**只读**引擎的 seed 纯函数层 (settleCache / growTownFootprint /
 *       spiritAt / veinNear / hexDist), **绝不写**它们, 也绝不写
 *       chunk/region/settleCache/roadCache/roadFail 任何一格。
 *   R2. 演化只产出「派生层」数据 (pop / tier / stock / 演化建筑),
 *       骨架建筑与骨架产出**逐字节不变** (它们由 seed 派生)。
 *   R3. 演化新增建筑一律 `evo: 1`, 骨架建筑不带该位 ⇒ 拆屋只拆 evo:1
 *       (绝不碰骨架), 造田只造 kind:'field'。
 *   R4. 浮点人口真值 `popF` 内部全程保留; 只在**写回 / 比较 tier 阈值 /
 *       上报**时取整。逐子步 round 会抹平小增量 ⇒ dt 拆分后完全不长。
 *   R5. `dt <= 0` 必须是**严格 no-op** (含 tier 追升): 零长区间不得引发
 *       任何状态迁移, 否则断点续跑 / 相位对齐会凭空升级城市。
 *   R6. Δ 铁律 (dt 拆分不变): `step(s, 90) ≡ 连续9×step(s_i, 10)`。
 *       成立的**唯一前提** = K 在批内是常数 ⇒ 一切 rate 只依赖**冻结基期**
 *       (basePop / baseAge), 绝不读实时量。⚠ K 有**两个**漂移源 (basePop 与
 *       maturity(age)), 冻结必须**同时钉住两个** (只冻 basePop 实测 Δ=21)。
 *       由 `K_POLICY` 决定批间是否重估 (见下)。
 *
 * ---------------------------------------------------------------------------
 * 常量与 `verify/evo/city_evo_sim.mjs` 的 E 块**逐值一致**
 *   (该脚本是参数真源与回归判据; 本文件是它在引擎内的同口径落地)
 * ⚠ 改这里的任何动力学常数 ⇒ 必须同步改 city_evo_sim.mjs 并重跑
 *   `node verify/evo/city_evo_sim.mjs` (那边有 Δ 铁律 + 红线 4 条判据)。
 * ========================================================================== */
(function (global) {
  'use strict';

  var MG = global.MapGen;
  if (!MG) throw new Error('city-evo.js 必须在 mapgen.js 之后加载 (顺序: noise, mapgen-config, mapgen, mapgen-server, city-evo)');

  var CFG = MG.CFG;

  /* ── 时间模型 (与 Server/Zongmen/Time/GameClock.cs 逐项一致) ── */
  var T = { Day: 1, Month: 30, Season: 90, Year: 360 };

  /* ============================================================
   * A. 演化动力学常数 (v2 方案 §二) —— 与 city_evo_sim.mjs E 块同口径
   * ============================================================ */
  var E = {
    RES_ORDER: ['粮', '木', '矿', '渔', '炭', '灵', '丹', '器'],

    /* 每单位资源可养多少口人 —— 真源是 mapgen.js 闭包内的 TRADE_DEMAND (未导出)。
       这里作为「契约常量」声明, 并由 selfCheck() 用 townNet 反解交叉校验 (见 §0)。 */
    DEMAND: { 粮: 500, 木: 800, 渔: 900, 炭: 1200, 矿: 1500, 灵: 5000, 丹: 8000, 器: 8000 },

    R0: 8.3e-5,                   // 内禀增长率 / 日 (年 ~3%)
    R_CITY: 1.4,                  // 城市规模放大
    K_POP_RATIO: 4.0,             // K_base = pop0 × 该比例
    K_MIN: 30,                    // K 下限 (防死锁)
    K_MIN_SCALE: 0.35,
    K_MAX_SCALE: 3.0,
    TIER_POP_UP: { 1: 4000, 2: 20000 },   // pop 跨过 ⇒ tier+1 (只升不降)
    TIER_MAX: 3,
    HOUSE_RATIO: 0.30,            // 骨架民房比例 (与 CFG.TOWN_HOUSE_RATIO 同口径)
    BUILD_RATE: 0.0015,           // 超容量每口人每天的建屋速率
    BUILD_CAP_PAD: 2.0,
    POP_FLOOR: 50,                // ★ R4 灾荒死锁防护

    /* ⚠ state=3 判据必须相对**自身入口人口基准** popBase, 不能相对 kBase(=popBase×4):
       否则阈值 = popBase×4×0.35 = popBase×1.4 > popBase ⇒ 判据恒真 ⇒ 全城假事件态。 */
    EVENT_POP_RATIO: 0.70,        // pop < popBase×该值 ⇒ state=3 事件态
    RECOVER_RATIO: 0.90,          // 恢复到该比例 ⇒ state=0

    TRADE_CARRY_MAX: 400,         // 单边单次最大搬运
    STOCK_CAP: 1e6,
    FOOD_DEBT_HALF: 720,          // 粮荒债的 tanh 半衰尺度 (日)

    /* ★★ K 基期策略 —— 见文件头 R6 与 city_evo_sim.mjs 的长判决实验注释。
       'freeze' : 首算后全程冻结 ............. Δ ≡ 0 (严格可拼接), 世界 +0.36%
       'year'   : 只在 age 跨整年时重估 ....... Δ 有界 (≤21 口),      世界 +0.65%
       'roll'   : 每批按入口人口重估 .......... Δ 有界 (≤22 口),      世界 +0.94%
       默认 'freeze': 生产主循环恒以 dt=90 调用一次 ⇒ 拆分在运行期从不发生,
       ⇒ 用「严格可拼接」换 0.6 个百分点的增长, 是「可验证性优先」的取舍。
       ⚠ 生产侧可在 JobSpec.Payload 里逐城覆盖 (payload.kPolicy)。 */
    K_POLICY: 'freeze',

    /* ── v3 价格层 ── */
    PRICE_ELASTIC: 1.6,
    PRICE_MIN_MULT: 0.35,
    PRICE_MAX_MULT: 4.0,
    LAND_POP_W: 1.2,
    LAND_CROWD_W: 1.0,
    LAND_MAINT_W: 0.5,
    SOUL_SCALE: 20000,

    /* ── v3 贸易套利 ── */
    TRADE_FLOW_K: 12,

    /* ── v3 迁移 ── */
    MIGRATE_REACH: 25,
    MIGRATE_DEADZONE: 0.012,
    MIGRATE_K: 0.9,
    MIGRATE_REF_DT: 90,
    MIGRATE_MAX_FRAC: 0.02,
    ATTRACT_RES_W: 1.0,
    ATTRACT_LAND_W: 0.8,

    /* ── v3 建筑增减 ── */
    FIELD_TRIGGER: 0.25,
    FIELD_MAX: 6,
    DEMO_RATE: 0.02,

    /* ── v3.2 加工层 (城市 = 加工中心: 吃 粮/木/矿, 吐 器/丹 卖回小城) ── */
    RECIPE: {
      器: { 矿: 2.0, 木: 1.0 },
      丹: { 粮: 3.0, 灵: 1.0 }
    },
    CRAFT_TYPES: ['city', 'town'],
    CRAFT_RATE: { city: 0.0022, town: 0.0011 },
    CRAFT_MAX_FRAC: 0.35,

    /* ── v3.2 灵力溢价 (修仙类商品) ──
       ⚠ 实测 spiritAt ∈ [0.727, 0.993] 区间极窄 (中枢半径 500 格 >> 世界 ±150 格)
         ⇒ 必须**重新拉伸**才有区分度。 */
    SPIRIT_LO: 0.70,
    SPIRIT_HI: 1.00,
    SPIRIT_GOODS: ['灵', '丹', '器'],
    SPIRIT_PREMIUM: 2.2,

    /* ── v3.2 双向拉力 ── */
    OPP_SCALE: 30000,
    OPP_W: 1.3,

    /* ══════════════════════════════════════════════════════════════════
     * v4 建筑计划 (2026-10-10 用户定案 · b 方案) —— 「整座城随人口重排/消失重建 + 分级」
     *
     *   背景: 旧版 `built[]` 只增不减 (buildCap 一顶满就死), 且骨架建筑的存亡
     *   完全由 seed 决定 ⇒ 人口再怎么变, 画面上的建筑一动不动。
     *
     *   ★ 本层的切法 (与 §1.3 「不能改 maxN」的结论一致, 但不是同一条路):
     *     · 骨架建筑 (growTownFootprint 产物) **逐字节不变** —— 它仍是 seed 纯函数,
     *       进 townCache、参与 townNet, 一切照旧 (红线 R1/R2 不破)。
     *     · 变的是「**哪几座骨架被点亮**」+「骨架之外新盖了什么」——
     *       这两者都是 (pop, tier, state, type, 骨架产出) 的**纯函数**, 不落库、
     *       不进 townCache、不参与 townNet ⇒ 对贸易/道路/前端自算地形**零影响**。
     *     · 于是「建筑消失/重建」= 点亮集合的变化; 「等级」= 每座建筑的一个整数档。
     *
     *   ⚠ 为什么可以纯派生而不落库: 见 §7.5 头注释 (Δ 铁律 + 缓存纪律)。
     * ============================================================ */
    /* 各规模等级的「标准人口」—— 建筑数的锚。骨架 maxN 是按 type 定的,
       这里把 pop 归一成「相对标准人口的倍数」再折算建筑数。 */
    BLDG_POP_REF: { 1: 3000, 2: 15000, 3: 50000 },
    BLDG_POP_EXP: 0.6,        // 人口 → 建筑数 的幂次 (次线性: 大城不会无限膨胀)
    BLDG_CAP_MIN: 1,          // 非被毁城市的最少建筑数 (>0 才像个聚落)
    BLDG_CAP_OVER: 1.0,       // 溢出上限 = 骨架 maxN × 该值 (向外扩张的极限倍数)
    FAMINE_CAP: 0.65,         // state=3 (灾荒/战乱) 的点亮数折减
    BLDG_LV_MAX: 3,           // 建筑最高等级
    LV_HOUSE_STEP: 0.9,       // 民房: 人口倍数每涨该值 ⇒ 升 1 级
    LV_PROD_NEED: 0.25,       // 生产建筑: 资源紧缺度 ≥ 该值 ⇒ +1 级
    LV_PROD_NEED2: 0.60,      // 生产建筑: 紧缺度 ≥ 该值 ⇒ 再 +1 级
    OVER_RING_PAD: 3          // 溢出建筑落在骨架环 (TOWN_R) 之外的环数上限
  };

  /* 资源基准价 / 地价基准 (相对价; 与 DEMAND 稀缺度同序) */
  var PRICE0 = { 粮: 1.0, 木: 1.2, 矿: 2.0, 渔: 1.6, 炭: 2.4, 灵: 6.0, 丹: 9.0, 器: 9.0 };
  var LAND0 = 1.0;

  /* 半径 1 的六邻居偏移 (六边形 axial 坐标) —— 「拥挤度」口径 */
  var HEX6 = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  var SPIRIT_ELEM = ['金', '木', '水', '火', '土'];

  /* ============================================================
   * §0. 契约自查: DEMAND 与引擎同口径 (用 townNet 反解, 不照抄)
   *     真实契约: townNet(st)[r] = 骨架产出[r] − max(1, round(pop/DEMAND[r]))
   *     ⇒ DEMAND[r] = pop / (骨架产出[r] − townNet[r])
   * ============================================================ */
  var _selfCheck = null;
  function selfCheck() {
    if (_selfCheck) return _selfCheck;
    var mismatches = [];
    var probe = { id: 'selfcheck_0_0_0', type: 'village', q: 0, r: 0, pop: 4000 };
    var net = MG.townNet(probe);
    var plan = MG.growTownFootprint(probe.id, probe.type, probe.q, probe.r);
    var sup = {};
    for (var i = 0; i < plan.resources.length; i++) {
      sup[plan.resources[i].resource] = plan.resources[i].amount;
    }
    for (var k = 0; k < E.RES_ORDER.length; k++) {
      var r = E.RES_ORDER[k];
      var need = Math.max(1, Math.round(probe.pop / E.DEMAND[r]));
      /* 反解: 引擎在 townNet 内部用的分子必须是同一个 DEMAND[r] */
      var engineNeed = (sup[r] || 0) - (net[r] || 0);
      if (engineNeed !== need) mismatches.push(r + ': 引擎 ' + engineNeed + ' vs 本文件 ' + need);
    }
    _selfCheck = { demand: E.DEMAND, mismatches: mismatches };
    return _selfCheck;
  }

  /* ============================================================
   * §1. CityState —— 数据结构与 C# 台账 (`CityStateStore`) 的字段一一对应
   *
   *  持久字段 (进 SQLite): id/pop/popF/tier/state/stock/built/bornTick/
   *                        lastEvoTick/ver/age/foodDebt/popBase/basePopF/
   *                        baseAge/builtFrac
   *  瞬时字段 (每批重算, 不落库): Kf / px / land / attr / crowd / spirit*
   * ============================================================ */
  function newCityState(st, tick) {
    var p = st.pop | 0;
    return {
      id: String(st.id),
      /* ⚠ 身份三字段必须进 CityState 并**逐批带下去**: EvolveOne 每批要调
         cityMetaJson(id,type,q,r) 取骨架产出, 缺了 type 会把城当村算 (K 塌到
         K_MIN ⇒ 人口永远停在 30 且不报错); 缺 q/r 则加工业/灵力溢价全按原点算。
         (实测踩过: 台账 42 行 Type='' / Q=R=0 —— 见 2026-10-10 诊断。) */
      type: String(st.type || 'village'),
      q: st.q | 0,
      r: st.r | 0,
      pop: p,
      popF: p,                    // 浮点人口真值 (Δ 铁律载体, 绝不中途取整)
      tier: st.tier | 0,
      state: 0,
      stock: {},                  // 八资源库存 (靠本地产出积累)
      built: [],                  // 演化新增建筑 (骨架之外; evo:1)
      upg: [],
      bornTick: tick | 0,
      lastEvoTick: tick | 0,
      ver: 0,
      /* ── Δ 铁律所需的累加器 (绝不由 tick 差反推) ── */
      age: 0,
      foodDebt: 0,
      popBase: p,
      builtFrac: 0,
      basePopF: null,             // K 基期人口 (null ⇒ 尚未算过)
      baseAge: null,              // K 基期年龄 (freeze 档用来钉住 maturity)
      Kf: 0                       // 本批实际使用的 K (审计)
    };
  }

  /* ============================================================
   * §2. 承载力 K (批首算一次 ⇒ 批内常量; Verhulst 闭式精确的前提)
   * ============================================================ */
  function computeK(popBase, ageRef, res, demand) {
    var supplyHint = 0, grainSup = 0;
    for (var i = 0; i < res.length; i++) {
      supplyHint += res[i].amount;
      if (res[i].resource === '粮') grainSup += res[i].amount;
    }
    /* 稳态粮债: 用「长期缺口率 × 半衰尺度」直接给饱和值 (不随 dt 累加 ⇒ K 无漂移)。
       ⚠ 产出与消耗同量纲 (日), 直接相减。 */
    var grainNeed = Math.max(1, Math.round(popBase / (demand['粮'] || 500)));
    var deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
    var debtSs = deficitRate * E.FOOD_DEBT_HALF * 4;
    var debtScale = 1 - Math.tanh(debtSs / E.FOOD_DEBT_HALF);
    var supplyScale = 1 + Math.tanh(supplyHint / 2000);
    var maturity = 1 + 0.25 * Math.tanh(ageRef / T.Year);
    var kScale = Math.min(E.K_MAX_SCALE, Math.max(E.K_MIN_SCALE, debtScale * supplyScale * maturity));
    return {
      K: Math.max(E.K_MIN, popBase * E.K_POP_RATIO * kScale),
      kScale: kScale, debtScale: debtScale, supplyScale: supplyScale,
      maturity: maturity, debtSs: debtSs
    };
  }

  /* ============================================================
   * §3. 城内演化 —— evolveCity(state, meta, dt, kPolicy) → newState
   *     meta = { type, q, r, resource:[{resource,amount}], demand }
   * ============================================================ */
  function evolveCity(s, meta, dtTicks, kPolicy) {
    var policy = (kPolicy === 'freeze' || kPolicy === 'year' || kPolicy === 'roll') ? kPolicy : E.K_POLICY;
    var dt = Math.max(0, dtTicks | 0);

    /* ★ R5: dt=0 严格 no-op —— 连 age/ver 都不动, 保证断点/相位对齐不改状态 */
    if (dt === 0) {
      var noop = {};
      for (var kk in s) if (Object.prototype.hasOwnProperty.call(s, kk)) noop[kk] = s[kk];
      return noop;
    }

    var out = {};
    for (var k0 in s) if (Object.prototype.hasOwnProperty.call(s, k0)) out[k0] = s[k0];
    out.age = (s.age | 0) + dt;
    out.ver = (s.ver | 0) + 1;

    var res = (meta && meta.resource) || [];
    var demand = (meta && meta.demand) || E.DEMAND;
    var type = (meta && meta.type) || 'village';

    /* ---- 骨架规模: b 方案下不再直接决定建筑数 (改由 planCityBuildings 按人口算),
           这里只在下面算溢出建筑时作锚 (TOWN_BUILD_MAX[type] 仍是骨架的生成上限)。 ---- */

    /* ---- K 基期 (策略见 E.K_POLICY) ---- */
    var enterPop = (s.popF != null ? +s.popF : (s.pop | 0));
    var popBase = Math.round(enterPop) || (s.pop | 0) || 1;
    var age0 = s.age | 0, age1 = age0 + dt;
    var yearCrossed = Math.floor(age0 / T.Year) !== Math.floor(age1 / T.Year);
    var basePop;
    if (policy === 'freeze') {
      basePop = (s.basePopF != null ? s.basePopF : popBase);
    } else if (policy === 'year') {
      basePop = (s.basePopF == null || yearCrossed) ? popBase : (s.basePopF | 0);
    } else {
      basePop = popBase;
    }

    /* ---- ① 库存积分 (产出 − 消耗) × dt 线性 (同量纲: 都是「每日」) ---- */
    var stock = {};
    var r, i;
    for (i = 0; i < E.RES_ORDER.length; i++) {
      r = E.RES_ORDER[i];
      stock[r] = (+(s.stock && s.stock[r]) || 0);
    }
    for (i = 0; i < E.RES_ORDER.length; i++) {
      r = E.RES_ORDER[i];
      var sup = 0;
      for (var j = 0; j < res.length; j++) if (res[j].resource === r) sup += res[j].amount;
      var drain = Math.max(1, Math.round(basePop / (demand[r] || 1000)));
      var next = stock[r] + (sup - drain) * dt;
      /* 「越界才夹」: 夹断只在真越界时发生 (保 Δ 恒等) */
      if (next < 0) stock[r] = 0;
      else if (next > E.STOCK_CAP) stock[r] = E.STOCK_CAP;
      else stock[r] = next;
    }

    /* ---- ② 承载力 K: 批首由 basePop 算一次 ⇒ 批内常数 ----
       ⚠⚠ 第二漂移源: K = f(basePop, age) 里**两个**量都会随批变。
       只冻 basePop 而让 maturity(age) 用累计 age ⇒ K 仍逐批变 ⇒ Δ 仍 >0 (实测 Δ=21)。
       ⇒ freeze 档必须**连 age 一起钉住**。 */
    var ageRef = (policy === 'freeze' && s.baseAge != null) ? s.baseAge : (s.age | 0);
    var kInfo = computeK(basePop, ageRef, res, demand);
    var baseAge = (policy === 'freeze') ? (s.baseAge != null ? s.baseAge : (s.age | 0)) : (s.age | 0);
    var K = kInfo.K;

    /* ---- ③ Verhulst 闭式积分 (K 常数 ⇒ 精确) ----
       ★ 绝不在此处 round(pop): 单日增量可能 < 0.5, round 会抹平 ⇒ dt 拆分后完全不长。 */
    var rEff = E.R0 * (type === 'city' ? E.R_CITY : 1.0);
    var p0 = (s.popF != null ? +s.popF : (s.pop | 0));
    var pop;
    if (!(p0 > 0) || K <= 0) pop = p0;
    else pop = K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
    if (pop < E.POP_FLOOR) pop = E.POP_FLOOR;       // 越界才夹
    var capPop = K * 1.05;
    if (pop > capPop) pop = capPop;                 // 越界才夹

    /* ---- ④ tier 升级 (只升不降; 只在比较阈值处取整) ---- */
    var popInt = Math.round(pop);
    var tier = s.tier | 0;
    for (var t = tier; t < E.TIER_MAX; t++) {
      var need = (E.TIER_POP_UP[t] != null ? E.TIER_POP_UP[t] : Infinity);
      if (popInt >= need) tier = t + 1;
      else break;
    }
    if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + E.POP_FLOOR);

    /* ---- ⑤ state 事件态 (灾荒 ⇒ 3, 恢复 ⇒ 0; 绝不自杀)
       判据相对**本批入口人口 popBase** (滚动), 不是 basePop / kBase×4。 ---- */
    var state = s.state | 0;
    if (state !== 1) {
      if (pop < popBase * E.EVENT_POP_RATIO) state = 3;
      else if (state === 3 && pop > popBase * E.RECOVER_RATIO) state = 0;
    }
    var finalTier = Math.min(E.TIER_MAX, tier);

    /* ---- ⑥ 溢出建筑 (b 方案): built[] = 骨架之外新盖的, 由 (pop,tier,state)
       **纯派生 ⇒ 每批重建** (不是累加)。这同时是「建筑消失/重建」的载体:
       人口涨 ⇒ 溢出增多 (城市向外长); 人口跌 / 灾荒 ⇒ 溢出清空 (外圈先塌)。
       ⚠ 纯派生 ⇒ Δ 铁律天然成立 (末态 = 末态人口的函数, 与拆分路径无关);
         旧版「余数累加器」在人口回退时会留下幽灵建筑 (且 buildCap 一顶满就死), 已废弃。 ---- */
    var built = planOverflowOnly(
      { id: String(s.id), type: type, q: (meta && meta.q) | 0, r: (meta && meta.r) | 0,
        resource: res, demand: demand },
      { type: type, pop: Math.round(pop), tier: finalTier, state: state });

    out.pop = Math.round(pop);      // ★ 只在写回时取整
    out.popF = pop;                 // 浮点真值 (供 Δ 判据与下一批积分)
    out.tier = finalTier;
    out.state = state;
    out.stock = stock;
    out.built = built;
    out.lastEvoTick = (s.lastEvoTick | 0) + dt;
    out.foodDebt = kInfo.debtSs;
    out.builtFrac = 0;              // 旧字段保留 (累加器已废弃, 恒 0)
    out.popBase = popBase;          // 滚动入口人口 (事件态判据用)
    out.basePopF = basePop;         // K 基期人口
    out.baseAge = baseAge;          // K 基期年龄
    out.Kf = K;                     // 本批实际 K (审计)
    return out;
  }

  /* 确定性伪随机 (整数哈希 → [0,1)) —— 绝不用运行时 RNG, 保重放一致。
     ⚠ extra 是**可选**第三盐 (缺省 0 ⇒ 与原两参调用逐位一致)。v4 建筑计划用它
       把「环内取第几格」与「本格取哪个 kind」分开, 免得同 idx 的两个抉择强相关。 */
  function hash01(n, salt, extra) {
    var x = ((n * 374761393 + salt * 668265263 + (extra | 0) * 40503) ^ (n << 13)) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
  }

  /* ============================================================
   * §4. 价格层 —— 资源价 + 地价 (「城市越大维护成本越高价格越高」)
   * ============================================================ */

  /* 灵力场 (读只读出口) —— 「灵力提升修仙类商品价格」 */
  function spiritInfoOf(st) {
    var raw = MG.spiritAt(st.q, st.r);
    var t = (raw - E.SPIRIT_LO) / (E.SPIRIT_HI - E.SPIRIT_LO);   // 重新拉伸
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    var vn = MG.veinNear(st.q, st.r);
    var vein = (vn && vn.v) ? {
      d: vn.d, level: vn.v.level | 0,
      element: SPIRIT_ELEM[vn.v.element | 0] || '?', name: vn.v.name
    } : null;
    var veinBonus = vein ? Math.max(0, (3 - vein.d) / 3) * 0.3 : 0;   // d=0 最浓
    var rich = t + veinBonus;
    if (rich > 1) rich = 1;
    return { raw: raw, t: t, rich: rich, vein: vein };
  }

  function resourcePrices(pop, res, demand, spiritRich) {
    var out = {};
    var sup = {};
    var i;
    for (i = 0; i < res.length; i++) sup[res[i].resource] = (sup[res[i].resource] || 0) + res[i].amount;
    for (i = 0; i < E.RES_ORDER.length; i++) {
      var r = E.RES_ORDER[i];
      var need = Math.max(1, (pop | 0) / (demand[r] || 1000));
      var have = sup[r] || 0;
      var tension = (need - have) / Math.max(need, 1);
      var tt = Math.tanh(tension * 1.5);
      var p = PRICE0[r] * (1 + tt * E.PRICE_ELASTIC);
      if (E.SPIRIT_GOODS.indexOf(r) >= 0 && spiritRich > 0) {
        p *= 1 + (E.SPIRIT_PREMIUM - 1) * spiritRich;   // ★ 灵力溢价
      }
      if (p < PRICE0[r] * E.PRICE_MIN_MULT) p = PRICE0[r] * E.PRICE_MIN_MULT;
      if (p > PRICE0[r] * E.PRICE_MAX_MULT) p = PRICE0[r] * E.PRICE_MAX_MULT;
      out[r] = p;
    }
    return out;
  }

  /* 地价 = 基准 × (1 + 规模项 + 拥挤项 + 维护项) */
  function landPrice(pop, builtCount, crowdRate) {
    var scale = Math.tanh((pop | 0) / E.SOUL_SCALE);
    var maint = Math.tanh((builtCount | 0) / 40);
    var crowd = Math.max(0, Math.min(1, crowdRate || 0));
    var land = LAND0 * (1 + E.LAND_POP_W * scale + E.LAND_CROWD_W * crowd + E.LAND_MAINT_W * maint);
    if (land < LAND0) land = LAND0;
    return { land: land, scale: scale, crowd: crowd, maint: maint };
  }

  /* 半径 1 的 6 邻居格占用率 ∈ [0,1] (用户指定口径) */
  function crowdRateOf(st, occSet) {
    if (!occSet || !occSet.length) return 0;
    var c = 0;
    for (var i = 0; i < HEX6.length; i++) {
      var key = (st.q + HEX6[i][0]) + ',' + (st.r + HEX6[i][1]);
      if (occSet.indexOf(key) >= 0) c++;
    }
    return c / 6;
  }

  /* ============================================================
   * §5. 加工层 —— 城市把原料加工成工商业品 (器/丹) 再外销
   *     器 ← 矿 + 木     丹 ← 粮 + 灵
   * ============================================================ */
  function craftOutput(type, pop, res) {
    var rate = E.CRAFT_RATE[type] || 0;
    if (!(rate > 0)) return null;                  // 非城/镇 ⇒ 无加工业
    var sup = {};
    for (var i = 0; i < res.length; i++) sup[res[i].resource] = (sup[res[i].resource] || 0) + res[i].amount;
    var capacity = (pop | 0) * rate * T.Season;    // 每季理论产能
    var capLimit = (pop | 0) * E.CRAFT_MAX_FRAC;
    if (capacity > capLimit) capacity = capLimit;  // 越界才夹
    var out = {};
    for (var good in E.RECIPE) {
      if (!Object.prototype.hasOwnProperty.call(E.RECIPE, good)) continue;
      var recipe = E.RECIPE[good];
      var minRatio = 1;
      for (var mat in recipe) {
        if (!Object.prototype.hasOwnProperty.call(recipe, mat)) continue;
        var need = capacity * recipe[mat];
        var avail = sup[mat] || 0;
        var ratio = need > 0 ? Math.min(1, avail / need) : 1;
        if (ratio < minRatio) minRatio = ratio;
      }
      var produced = capacity * minRatio;
      if (produced > 0) out[good] = produced;
    }
    return { capacity: capacity, out: out };
  }

  /* ============================================================
   * §6. 吸引力 (双向拉力: 规模机会(拉) + 低价宜居(拉) − 地价压力(推))
   * ============================================================ */
  function attractivenessOf(pop, px, land) {
    var pull = 0;
    for (var i = 0; i < E.RES_ORDER.length; i++) {
      var r = E.RES_ORDER[i];
      pull += (1 - px[r] / PRICE0[r]);           // <1 便宜 (富余) ⇒ 宜居
    }
    pull /= E.RES_ORDER.length;
    var opp = Math.tanh((pop | 0) / E.OPP_SCALE);      // 规模机会
    var push = Math.tanh((land - LAND0) / LAND0);      // 地价推力
    return E.ATTRACT_RES_W * pull + E.OPP_W * opp - E.ATTRACT_LAND_W * push;
  }

  /* ============================================================
   * §7. 建筑增减 —— 开田造产房 / 萎缩拆屋
   *     ⚠ 只动 `evo: 1` 的演化建筑, **绝不碰骨架** (红线 R2/R3)
   * ============================================================ */
  function harvestAndBuild(cs, meta, res, demand) {
    var built = cs.built;
    var out = { built: 0, demolished: 0, newFields: [] };

    /* ── 造产房: 找最紧缺的资源, 人口有余力则产出一座 ── */
    var worstR = null, worstTension = 0;
    var sup = {};
    var i;
    for (i = 0; i < res.length; i++) sup[res[i].resource] = (sup[res[i].resource] || 0) + res[i].amount;
    for (i = 0; i < E.RES_ORDER.length; i++) {
      var r = E.RES_ORDER[i];
      var need = Math.max(1, cs.pop | 0) / (demand[r] || 1000);
      var t = (need - (sup[r] || 0)) / Math.max(need, 1);
      if (t > worstTension) { worstTension = t; worstR = r; }
    }
    var fieldCount = 0;
    for (i = 0; i < built.length; i++) if (built[i].kind === 'field') fieldCount++;
    if (worstR && worstTension > E.FIELD_TRIGGER && fieldCount < E.FIELD_MAX) {
      var n = built.length + 1;
      built.push({
        q: ((meta.q | 0) + Math.round((hash01(n, 911) - 0.5) * 10)),
        r: ((meta.r | 0) + Math.round((hash01(n, 917) - 0.5) * 10)),
        kind: 'field', resource: worstR, tier: 1, evo: 1
      });
      out.built++; out.newFields.push(worstR);
    }

    /* ── 拆屋: 人口跌破骨架容量 ⇒ 按地价档位拆 (地价越高拆得越多) ── */
    var maxN = (CFG.TOWN_BUILD_MAX && CFG.TOWN_BUILD_MAX[meta.type]) || 8;
    var skeletonCap = 1 + Math.max(2, Math.floor(maxN * E.HOUSE_RATIO));
    if (cs.pop < skeletonCap) {
      var rate = E.DEMO_RATE * (1 + Math.max(0, (cs.land || LAND0) - LAND0));
      var want = Math.max(1, Math.floor(built.length * rate));
      var houses = 0;
      for (i = 0; i < built.length; i++) if (built[i].kind !== 'field') houses++;
      if (want > houses) want = houses;
      var removed = 0;
      for (var k2 = built.length - 1; k2 >= 0 && removed < want; k2--) {
        if (built[k2].kind === 'field') continue;    // 只拆屋不拆田
        built.splice(k2, 1); removed++;
      }
      out.demolished = removed;
    }
    return out;
  }

  /* ============================================================
   * §7.5 建筑计划 (2026-10-10 · b 方案) —— 「点亮集合 + 等级 + 溢出」
   *
   *   ★ 全部是**纯派生**: 输入 (骨架建筑[] + 城元数据 + pop/tier/state),
   *     输出「这一批该画哪几座、各是几级」。**不落库、不写任何缓存**。
   *
   *   ⚠ 为什么能纯派生 (与红线的关系):
   *     · 骨架 (growTownFootprint) 逐字节不变 ⇒ R1/R2 不破, townCache/townNet 照旧;
   *     · 计划只被**渲染路径** (settlePlanJson) 与审计消费 ⇒ 不进 townCache、不进
   *       settleCache, 前端自算地形契约不受影响;
   *     · 输入只有 pop/tier/state (+ seed 常量 q/r) ⇒ 同一状态必得同一结果,
   *       Δ 铁律天然成立 (末态是末态人口的函数, 与拆分路径无关)。
   *
   *   ⚠ 为什么「点亮集合」而不是「重排坐标」:
   *     骨架格位是 seed 派生的 (spreadPick 定死), 若按 pop 重排 ⇒ 删一座会级联改
   *     其余位置 (§1.3 的硬结论: 「整座城重排」而不是「几间房子塌了」)。
   *     点亮集合的做法: 格位不动, 只决定**显不显示 / 几级** ⇒ 视觉变化平滑,
   *     且与「城市向外扩张」(溢出建筑) 天然衔接。
   * ============================================================ */

  function clampInt(v, lo, hi) { v = v | 0; return v < lo ? lo : (v > hi ? hi : v); }

  /* 地皮 → 主导资源 (仅用于「生产建筑该升到几级」的紧缺度判定)。
     ⚠ 这是**渲染派生**的近似, 不是经济真源 (真源在 mapgen 的 BUILDINGS 表)。 */
  var TERRAIN_RES = {
    '良田': '粮', '矿脉': '矿', '林地': '木', '灼壤': '炭',
    '水岸': '渔', '渔家': '渔', '宗门附属': '灵'
  };
  /* 资源 → 可用的生产建筑 kind (溢出建筑用) */
  var RES_PROD_KIND = {
    '粮': ['农田', '磨坊', '谷仓'], '矿': ['矿山', '熔炉'], '木': ['伐木场', '药圃'],
    '炭': ['炼炉', '焦炭窑'], '渔': ['码头', '渔船坞'], '灵': ['聚灵阵', '祭坛']
  };
  var RES_TERRAIN = { '粮': '良田', '矿': '矿脉', '木': '林地', '炭': '灼壤', '渔': '水岸', '灵': '宗门附属' };

  /* 半径 k 的六边环格 (确定性枚举; 缓存)。用于把溢出建筑摆在骨架之外。 */
  var _ringCache = {};
  function ringCells(k) {
    if (_ringCache[k]) return _ringCache[k];
    var out = [];
    if (k > 0) {
      var dirs = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
      var q = k, r = 0;
      for (var d = 0; d < 6; d++) {
        for (var s = 0; s < k; s++) { out.push([q, r]); q += dirs[d][0]; r += dirs[d][1]; }
      }
    } else { out.push([0, 0]); }
    _ringCache[k] = out;
    return out;
  }

  /* 骨架建筑的点亮优先级 (越小越先亮; 人口萎缩时**后**消失)。
     组序: 0 核心 → 1 城区民居 → 2 生产卫星; 组内离城心越近越先亮, 再按 (q,r)。 */
  function skeletonRank(b, cq, cr) {
    var terr = b.terrain || '';
    var grp = (terr === 'core') ? 0 : (terr === '村落' || terr === '渔家' ? 1 : 2);
    return [grp, MG.hexDist(cq, cr, b.q, b.r), b.q, b.r];
  }

  /* 紧缺度函数: tension(r) = (需求 − 骨架产出) / 需求, 夹到 [0,1]。
     ⚠ 用**骨架产出** (meta.resource) 而不是实时库存 —— 骨架是标准量, 库存是结果量;
       拿库存判「该不该升级」会把贸易的噪声引进建筑等级。 */
  function makeScarcity(meta, pop) {
    var sup = {};
    var res = (meta && meta.resource) || [];
    for (var i = 0; i < res.length; i++) sup[res[i].resource] = (sup[res[i].resource] || 0) + res[i].amount;
    var demand = (meta && meta.demand) || E.DEMAND;
    var cache = {};
    return function (r) {
      if (r in cache) return cache[r];
      var need = Math.max(1, (pop | 0) / (demand[r] || 1000));
      var t = (need - (sup[r] || 0)) / need;
      if (t < 0) t = 0; if (t > 1) t = 1;
      cache[r] = t;
      return t;
    };
  }

  /* 单座建筑的等级 (1..3): 核心=城等级; 民房=人口密度; 生产=该资源紧缺度。 */
  function bldgLevel(b, ratio, cityTier, scarcityOf) {
    var terr = b.terrain || '';
    if (terr === 'core') return clampInt(cityTier, 1, E.BLDG_LV_MAX);
    if (terr === '村落' || terr === '渔家')
      return clampInt(1 + Math.floor(ratio / E.LV_HOUSE_STEP), 1, E.BLDG_LV_MAX);
    var r = TERRAIN_RES[terr];
    var sc = (r && scarcityOf) ? scarcityOf(r) : 0;
    return clampInt(1 + (sc >= E.LV_PROD_NEED ? 1 : 0) + (sc >= E.LV_PROD_NEED2 ? 1 : 0),
                    1, E.BLDG_LV_MAX);
  }

  /* 溢出建筑 (骨架之外新盖的): 确定性放在骨架环之外的若干环上。
     ⚠ 位置仍以 q,r 的 hash 为准 ⇒ 与「谁先算」无关 (跨端一致)。
     ⚠ 避开灵脉格与深海 (只读 fields, 不写任何缓存)。 */
  function overflowBuilding(cq, cr, idx, ratio, scarcityOf, wantsProd) {
    var R = (CFG.TOWN_R | 0) || 3;
    var ring = R + 1 + (idx % E.OVER_RING_PAD);
    var cells = ringCells(ring);
    var tried = 0, q = cq + ring, r = cr;
    while (tried < 4) {
      var h = hash01(cq * 131 + idx * 7 + tried, cr * 37 + 991, 1451);
      var cell = cells[(h * cells.length) | 0];
      q = cq + cell[0]; r = cr + cell[1];
      var f = MG.fields(q, r);
      if (f && !f.vein && f.biome !== MG.BIOME.DEEP) break;
      tried++;
    }
    var prod = wantsProd;
    var rr = '粮';
    if (prod) {
      /* 溢出的生产建筑优先补最紧缺的资源 */
      var best = 0, bestR2 = null;
      for (var k = 0; k < E.RES_ORDER.length; k++) {
        var cand = E.RES_ORDER[k];
        var sc = scarcityOf ? scarcityOf(cand) : 0;
        if (sc > best) { best = sc; bestR2 = cand; }
      }
      rr = bestR2 || '粮';
    }
    if (!prod) {
      var hv = hash01(cq + idx, cr - idx, 1601);
      return { q: q, r: r, kind: hv < 0.30 ? '仓库' : '民房', terrain: '村落',
               tier: 1, lv: bldgLevel({ terrain: '村落' }, ratio, 1, scarcityOf), evo: 1 };
    }
    var kinds = RES_PROD_KIND[rr] || ['农田'];
    var kind = kinds[((hash01(q, r, 1607) * kinds.length) | 0) % kinds.length];
    return { q: q, r: r, kind: kind, terrain: RES_TERRAIN[rr] || '良田',
             tier: 1, lv: bldgLevel({ terrain: RES_TERRAIN[rr] || '良田' }, ratio, 1, scarcityOf), evo: 1 };
  }

  /* 主入口: 算「这一批该画什么」。
     入参: skeleton = 骨架建筑[] (growTownFootprint().buildings, 只读不改);
           meta     = { type, q, r, resource, demand };  st = { pop, tier, state }。
     出参: { cap, ratio, buildings:[{q,r,kind,terrain,tier,evo}], skeletonOn, overflow } */
  function planCityBuildings(skeleton, meta, st) {
    var type = (st && st.type) || (meta && meta.type) || 'village';
    var pop = Math.max(0, (st && st.pop) | 0);
    var tier = (st && st.tier) | 0;
    var state = (st && st.state) | 0;
    var capNom = (CFG.TOWN_BUILD_MAX && CFG.TOWN_BUILD_MAX[type]) || 8;
    var ref = E.BLDG_POP_REF[clampInt(tier, 1, 3)] || E.BLDG_POP_REF[2];
    var ratio = pop / ref;

    /* 目标建筑数 = 骨架规模 × (人口/标准人口)^次线性指数 */
    var cap = Math.round(capNom * Math.pow(Math.max(1e-6, ratio), E.BLDG_POP_EXP));
    if (state === 1) {
      cap = 0;                                                   // 被毁: 全灭
    } else {
      var capMax = Math.round(capNom * (1 + E.BLDG_CAP_OVER));
      if (cap > capMax) cap = capMax;
      if (cap < E.BLDG_CAP_MIN) cap = E.BLDG_CAP_MIN;
      /* ⚠ 灾荒折减必须在 CAP_MIN 夹断**之后** —— 否则「只点亮 1 座的荒村」在灾荒时
         会被 CAP_MIN 拉回 1 ⇒ 建筑数不减 ⇒ 灾荒在画面上**毫无表现** (实测 C5d 抓到)。 */
      if (state === 3) cap = Math.floor(cap * E.FAMINE_CAP);
    }

    var ordered = (skeleton || []).slice();
    ordered.sort(function (a, b) {
      var ra = skeletonRank(a, meta.q, meta.r), rb = skeletonRank(b, meta.q, meta.r);
      for (var k = 0; k < 4; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k];
      return 0;
    });

    var scarcityOf = makeScarcity(meta, pop);
    var out = [];
    var on = Math.min(cap, ordered.length);
    for (var i = 0; i < on; i++) {
      var b = ordered[i];
      out.push({ q: b.q, r: b.r, kind: b.kind, terrain: b.terrain,
                 tier: b.tier | 0, lv: bldgLevel(b, ratio, tier, scarcityOf), evo: 0, on: 1 });
    }
    var over = Math.max(0, cap - ordered.length);
    var wantProd = ordered.length > 0 && ratio >= 1.0;   // 人口达标才向外扩生产
    for (var o = 0; o < over; o++) {
      out.push(overflowBuilding(meta.q, meta.r, o, ratio, scarcityOf,
                                wantProd && (o % 3 === 0)));
    }
    return { cap: cap, ratio: ratio, buildings: out, skeletonOn: on, overflow: over };
  }

  /* 演化侧只需要「骨架之外的溢出建筑」(进 CityState.built[])。
     ⚠ 与 planCityBuildings 同源 ⇒ 渲染层再算一次必得同一集合 (无二义)。 */
  function planOverflowOnly(meta, st) {
    var skeleton = MG.growTownFootprint(meta.id, meta.type, meta.q, meta.r).buildings;
    var plan = planCityBuildings(skeleton, meta, st);
    var out = [];
    for (var i = 0; i < plan.buildings.length; i++)
      if (plan.buildings[i].evo) out.push(plan.buildings[i]);
    return out;
  }

  /* ============================================================
   * §8. 对外出口 —— 全部是无状态纯函数, 由 JsEngineHost.Call 的 switch 转发
   * ============================================================ */

  /* 8.1 newStateJson(id, type, q, r, pop, tier, tick) → CityState */
  function newStateJson(id, type, q, r, pop, tier, tick) {
    return JSON.stringify(newCityState({ id: id, type: type, q: q, r: r, pop: pop, tier: tier }, tick | 0));
  }

  /* 8.2 metaJson(id, type, q, r) —— 单城演化元数据 (骨架产出 + 需求表) */
  function metaJson(id, type, q, r) {
    var plan = MG.growTownFootprint(id, type, q, r);
    return JSON.stringify({
      id: id, type: type, q: q | 0, r: r | 0,
      resource: plan.resources,
      demand: E.DEMAND
    });
  }

  /* 8.3 evolveCityJson(stateJson, metaJsonStr, dtTicks, kPolicy) → CityState
     stateJson 由 C# 从 CityStateStore 取出后传入 (无状态契约)。 */
  function evolveCityJson(stateJson, metaJsonStr, dtTicks, kPolicy) {
    var s = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
    var meta = typeof metaJsonStr === 'string' ? JSON.parse(metaJsonStr) : metaJsonStr;
    return JSON.stringify(evolveCity(s, meta, dtTicks | 0, kPolicy));
  }

  /* 8.4 priceLayerJson —— 「每城一批」的价格层: 输入世界快照, 输出价格/地价/吸引力
     入参 nodesJson = [{id,type,q,r,pop,tier,state,builtCount,craftRes?}...]
     出参 = { demand, cities:[{id, px, land, crowd, spirit, spiritRaw, vein, attr, craft}], }
     用途: ① 单城定价 (批量传入) ② tick 侧贸易/迁移的统一输入 */
  function priceLayerJson(nodesJson, occJson) {
    var nodes = typeof nodesJson === 'string' ? JSON.parse(nodesJson) : nodesJson;
    var occ = typeof occJson === 'string' ? JSON.parse(occJson || '[]') : (occJson || []);
    var cities = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.type === 'poi') continue;
      var plan = MG.growTownFootprint(n.id, n.type, n.q, n.r);
      var res = plan.resources;
      /* 加工层: 城市有效产出 = 骨架产出 + 工商业品 (器/丹) */
      var craft = craftOutput(n.type, n.pop, res);
      var effRes = res;
      if (craft && Object.keys(craft.out).length) {
        effRes = res.slice();
        for (var g in craft.out) {
          if (Object.prototype.hasOwnProperty.call(craft.out, g)) {
            effRes.push({ resource: g, amount: craft.out[g] / T.Season });
          }
        }
      }
      var st = { id: n.id, type: n.type, q: n.q | 0, r: n.r | 0, pop: n.pop | 0 };
      var sp = spiritInfoOf(st);
      var px = resourcePrices(n.pop, effRes, E.DEMAND, sp.rich);
      var crowd = crowdRateOf(st, occ);
      var lp = landPrice(n.pop, n.builtCount | 0, crowd);
      var attr = attractivenessOf(n.pop, px, lp.land);
      cities.push({
        id: n.id, px: px, land: lp.land, crowd: crowd,
        spirit: sp.rich, spiritRaw: sp.raw, vein: sp.vein,
        attr: attr, craft: (craft ? craft.out : null)
      });
    }
    cities.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    return JSON.stringify({ demand: E.DEMAND, cities: cities });
  }

  /* 8.5 tradeEdgesJson —— 价格套利边 (纯计算, 不落库; 由 tick 侧结算搬运库存)
     入参 = priceLayerJson 的结果 (含每城 px) + reach
     出参 = [{key, resource, amount, from, to, spread}...] 按价差降序 */
  function tradeEdgesJson(pricedJson, reach) {
    var priced = typeof pricedJson === 'string' ? JSON.parse(pricedJson) : pricedJson;
    var nodes = priced.cities;
    var R = reach | 0 || 40;
    var edges = [];
    for (var i = 0; i < nodes.length; i++) {
      var A = nodes[i];
      for (var j = i + 1; j < nodes.length; j++) {
        var B = nodes[j];
        /* 用中心格距离 (调用方在 nodes 里带 q/r) */
        if (A._q == null) continue;
        if (MG.hexDist(A._q, A._r, B._q, B._r) > R) continue;
        var bestR = null, bestSpread = 0, dir = 0;
        for (var k = 0; k < E.RES_ORDER.length; k++) {
          var r = E.RES_ORDER[k];
          var d = A.px[r] - B.px[r];
          var ad = Math.abs(d);
          if (ad > bestSpread) { bestSpread = ad; bestR = r; dir = d > 0 ? 1 : -1; }
        }
        if (!bestR) continue;
        var from = dir > 0 ? B : A;    // 价低者出
        var to = dir > 0 ? A : B;      // 价高者入
        var amount = Math.max(0, Math.round(bestSpread * E.TRADE_FLOW_K));
        if (amount <= 0) continue;
        edges.push({
          key: 'trade:' + from.id + '|' + to.id + ':' + bestR, resource: bestR,
          amount: amount, from: from.id, to: to.id, spread: bestSpread
        });
      }
    }
    edges.sort(function (a, b) {
      return (b.spread - a.spread) || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    });
    return JSON.stringify(edges);
  }

  /* 8.6 migrateEdgesJson —— 按吸引力差的迁移边 (纯计算; 由 tick 侧改人口)
     入参 = [{id, q, r, pop, attr, land, px}...] + dt
     出参 = [{from, to, amount}...] (按迁出方 id 规范序) */
  function migrateEdgesJson(nodesJson, dtTicks) {
    var nodes = typeof nodesJson === 'string' ? JSON.parse(nodesJson) : nodesJson;
    var dt = Math.max(0, dtTicks | 0);
    var moved = [];
    for (var i = 0; i < nodes.length; i++) {
      var A = nodes[i];
      for (var j = i + 1; j < nodes.length; j++) {
        var B = nodes[j];
        if (MG.hexDist(A.q, A.r, B.q, B.r) > E.MIGRATE_REACH) continue;
        var d = A.attr - B.attr;
        if (Math.abs(d) < E.MIGRATE_DEADZONE) continue;
        var src = d > 0 ? B : A, dst = d > 0 ? A : B;
        var amt = Math.abs(d) * E.MIGRATE_K * (src.pop | 0) * (dt / E.MIGRATE_REF_DT);
        var cap = (src.pop | 0) * E.MIGRATE_MAX_FRAC;
        if (amt > cap) amt = cap;
        if (amt < 1) continue;
        amt = Math.round(amt);
        if ((src.pop | 0) - amt < E.POP_FLOOR) amt = Math.max(0, (src.pop | 0) - E.POP_FLOOR);
        if (amt <= 0) continue;
        moved.push({ from: src.id, to: dst.id, amount: amt });
      }
    }
    moved.sort(function (a, b) {
      return (a.from < b.from ? -1 : a.from > b.from ? 1 : (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    });
    return JSON.stringify(moved);
  }

  /* 8.7 harvestAndBuildJson(stateJson, metaJsonStr) → {state, built, demolished, newFields}
     ⚠ 造田/拆屋会改 built 数组 ⇒ 返回**新 state** (调用方负责写回台账)。 */
  function harvestAndBuildJson(stateJson, metaJsonStr) {
    var s = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
    var meta = typeof metaJsonStr === 'string' ? JSON.parse(metaJsonStr) : metaJsonStr;
    /* 复制一份再改, 保调用方原对象不变 (无状态契约) */
    var cs = {};
    for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) cs[k] = s[k];
    cs.built = Array.isArray(s.built) ? s.built.slice() : [];
    /* land 由调用方先经 priceLayer 填入 (cs.land); 未填则取基准 */
    var res = meta.resource || [];
    var out = harvestAndBuild(cs, meta, res, meta.demand || E.DEMAND);
    return JSON.stringify({ state: cs, built: out.built, demolished: out.demolished, newFields: out.newFields });
  }

  /* 8.8 constantsJson —— 供 C# / 判据读取本文件的常量真源 (跨源钉死, 防漂移) */
  function constantsJson() {
    var sc = selfCheck();
    return JSON.stringify({
      T: T, E: E, PRICE0: PRICE0, LAND0: LAND0, HEX6: HEX6,
      demandMismatches: sc.mismatches
    });
  }

  /* 8.9 settlementsJson(i, j) —— 演化器要的「聚落身份清单」。     ⚠ 为什么不复用 mapgen-server 的 settleJson: 那个是**给前端画图**的包,
       只带 id/style/buildings/resources —— **没有 type/q/r/pop/tier**。
       演化器需要的恰是这些身份字段 (type 决定 R_CITY 与加工业档位,
       漏了会把城当村算 ⇒ K 塌到 K_MIN ⇒ 人口停滞。实测就是这样静默错的)。
       这里从 MG.settlementsFor 直取, 只导出演化层真正需要的字段。 */
  function settlementsJson(i, j) {
    var sts = MG.settlementsFor(i | 0, j | 0);
    var out = [];
    for (var k = 0; k < sts.length; k++) {
      var s = sts[k];
      out.push({
        id: s.id, type: s.type, q: s.q, r: s.r,
        pop: s.pop | 0, tier: s.tier | 0,
        /* 骨架预演: 需求表与承载力的输入 (与 growTownFootprint 同源, 不另算) */
        resource: MG.growTownFootprint(s.id, s.type, s.q, s.r).resources
      });
    }
    return JSON.stringify({ i: i | 0, j: j | 0, settlements: out });
  }

  /* 8.10 settlePlanJson(i, j, overlayJson) —— 渲染权威: **骨架 ⊕ 建筑计划**。
     overlayJson = {"<id>":{pop,tier,state}, ...} (C# 从 CityStateStore 摘要而来)。
     ⚠ 没有 overlay 的城市 ⇒ 原样吐骨架, **逐字节等同 settleJson** (保证「未演化世界」
       与改造前完全一致 —— 这也是判据 check_preview_settle 的回归前提)。
     ⚠ 与 settleJson 的输出结构**逐字段相同** (id/style/styleName/buildings/resources),
       C# 侧 BuildSettle 可复用同一解析器 (只换 VM 出口名)。 */
  function settlePlanJson(i, j, overlayJson) {
    i = i | 0; j = j | 0;
    var ov = {};
    if (overlayJson) {
      try { ov = typeof overlayJson === 'string' ? JSON.parse(overlayJson) : overlayJson; }
      catch (e) { ov = {}; }
    }
    var sts = MG.settlementsFor(i, j);
    var towns = [];
    for (var s = 0; s < sts.length; s++) {
      var st = sts[s];
      if (st.type === 'poi') continue;
      var plan = MG.growTownFootprint(st.id, st.type, st.q, st.r);
      var o = ov[st.id];
      var bs = [];
      var list;
      if (o) {
        var meta = { id: st.id, type: st.type, q: st.q, r: st.r,
                     resource: plan.resources, demand: E.DEMAND };
        list = planCityBuildings(plan.buildings, meta,
                 { type: st.type, pop: o.pop | 0, tier: o.tier | 0, state: o.state | 0 }).buildings;
      } else {
        list = plan.buildings;          // 未演化: 原样骨架
      }
      for (var b = 0; b < list.length; b++) {
        var bd = list[b];
        /* ⚠ 两个字段语义不同, 不可合并: `tier` = 骨架建筑自身的档 (seed 派生, 前端旧口径);
           `lv` = 演化等级 (人口/紧缺度派生, 前端新口径)。 */
        bs.push({ q: bd.q, r: bd.r, kind: bd.kind, terrain: bd.terrain,
                  tier: bd.tier | 0, lv: bd.lv | 0 });
      }
      var rs = [];
      for (var r = 0; r < plan.resources.length; r++)
        rs.push({ resource: plan.resources[r].resource, amount: plan.resources[r].amount });
      towns.push({ id: st.id, style: plan.style, styleName: plan.styleName,
                   buildings: bs, resources: rs });
    }
    return JSON.stringify({ i: i, j: j, towns: towns });
  }

  global.CityEvo = {
    /* 常量与自查 */
    T: T, E: E, PRICE0: PRICE0, LAND0: LAND0,
    selfCheck: selfCheck,
    constantsJson: constantsJson,
    /* 纯函数 (供 C# 直调 / 判据驱动) */
    newCityState: newCityState,
    computeK: computeK,
    evolveCity: evolveCity,
    spiritInfoOf: spiritInfoOf,
    resourcePrices: resourcePrices,
    landPrice: landPrice,
    crowdRateOf: crowdRateOf,
    attractivenessOf: attractivenessOf,
    craftOutput: craftOutput,
    harvestAndBuild: harvestAndBuild,
    /* ── v4 建筑计划 (b 方案) ── */
    planCityBuildings: planCityBuildings,
    planOverflowOnly: planOverflowOnly,
    ringCells: ringCells,
    /* JSON 出口 (JsEngineHost.Call 的 switch 逐个转发; 漏一个 = 运行期未知 JS 函数) */
    newStateJson: newStateJson,
    metaJson: metaJson,
    evolveCityJson: evolveCityJson,
    priceLayerJson: priceLayerJson,
    tradeEdgesJson: tradeEdgesJson,
    migrateEdgesJson: migrateEdgesJson,
    harvestAndBuildJson: harvestAndBuildJson,
    settlementsJson: settlementsJson,
    settlePlanJson: settlePlanJson
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
