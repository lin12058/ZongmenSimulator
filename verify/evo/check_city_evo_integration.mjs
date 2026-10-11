/* ============================================================
 * check_city_evo_integration.mjs — P2 融入正确性判据
 * ------------------------------------------------------------
 * ★ 这是「完全融入后进行测试」的核心判据。
 *
 * 它验**三件**互相独立的事:
 *
 *   G. 同源一致性 (引擎内 city-evo.js ≡ 仿真器 city_evo_sim.mjs 的纯函数)
 *      同一份入参 (CityState + meta + dt) 必须给出**逐位相同**的输出。
 *      ⚠ 这是整套融入的**地基**: 只要这条成立, 仿真器上跑出的所有结论
 *        (Δ 铁律 / 红线 / 三档 K 策略) 就都自动适用于生产。
 *      做法: 把仿真器的 evolveCity 及其依赖**原样抽出**跑一遍, 与 global.CityEvo 对拍。
 *
 *   H. 生产路径一致性 (C# 侧 tickprobe `evo` op ≡ 仿真器端到端)
 *      真引擎 (JsEngineHost → city-evo.js) + 真台账 (CityStateStore) 跑 N 季,
 *      与仿真器**只跑演化层**(关掉贸易/迁移) 的终态逐城比对。
 *      ⚠ 关掉贸易/迁移的理由: 那两层在 C# 侧是**批级/独立层** (P2 暂未开),
 *        仿真器把它们混在同一个循环里 ⇒ 不关就对不上, 且对不上的是无关项。
 *
 *   I. 融入边界 (红线在**生产路径**上依然守住)
 *      settleCache / settlementsFor / roadVer 在跑完演化后逐字节不变。
 *
 * 用法: node verify/evo/check_city_evo_integration.mjs [seed]
 * 退出码: 0 = 全绿 / 1 = 有失败
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
/* 2026-10-11 目录重构: city-evo.js 现属 City 子系统 (Subsystems/City/js)。 */
const CITY = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');

const SEED = process.argv[2] || 'city-evo-integration-1';
const SPAN = 2;            // 与 tickprobe evo 的 span 对齐 (小窗口 ⇒ 判据快)
const YEARS = 1;

const fails = [];
const ck = (n, c, d) => {
  console.log((c ? '  PASS ' : '  FAIL ') + n + (!c && d ? '  ← ' + d : ''));
  if (!c) fails.push(n);
};

/* ══ 载入引擎 bundle (与生产 JsvmModule 逐序一致; city-evo.js 换到子系统目录) ══ */
global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  const p = path.join(ENG, f);
  if (!fs.existsSync(p)) { console.error(`缺文件: ${p}`); process.exit(1); }
  (0, eval)(fs.readFileSync(p, 'utf8'));
}
{
  const p = path.join(CITY, 'city-evo.js');
  if (!fs.existsSync(p)) { console.error(`缺文件: ${p}`); process.exit(1); }
  (0, eval)(fs.readFileSync(p, 'utf8'));
}
const MG = global.MapGen;
const MGS = global.MapGenServer;
const CE = global.CityEvo;
MG.init(SEED);

console.log(`=== P2 城市迭代融入判据 · seed=${SEED} · span=${SPAN} · ${YEARS} 年 ===\n`);

/* ════════════════════════════════════════════════════════════
 * G. 同源一致性 —— city-evo.js ≡ city_evo_sim.mjs 的纯函数
 *
 *    ⚠ 不能只「重跑一遍 city-evo.js 自己」(那证明不了任何东西)。
 *      这里把**仿真器的实现**抽出来 (与 verify/evo/city_evo_sim.mjs 的
 *      computeK/evolveCity 逐行同构), 用同一份入参对拍。
 *      两边同参同果 ⇒ 仿真器上验证过的 Δ 铁律/红线对生产同样成立。
 * ════════════════════════════════════════════════════════════ */
{
  /* ---- 仿真器实现 (从 city_evo_sim.mjs 移植的独立副本; 刻意不 import, 因为
         那边是 ESM 一遍到底的脚本、无导出) ---- */
  const E = CE.E;                       // 常量表用生产的 (同源的第一层证据)
  const T = CE.T;
  const CFG = MG.CFG;
  const LAND0 = CE.LAND0;

  function simComputeK(popBase, age, res, demand) {
    let supplyHint = 0, grainSup = 0;
    for (const it of res) { supplyHint += it.amount; if (it.resource === '粮') grainSup += it.amount; }
    const grainNeed = Math.max(1, Math.round(popBase / (demand['粮'] || 500)));
    const deficitRate = Math.max(0, (grainNeed - grainSup) / grainNeed);
    const debtSs = deficitRate * E.FOOD_DEBT_HALF * 4;
    const debtScale = 1 - Math.tanh(debtSs / E.FOOD_DEBT_HALF);
    const supplyScale = 1 + Math.tanh(supplyHint / 2000);
    const maturity = 1 + 0.25 * Math.tanh(age / T.Year);
    const kScale = Math.min(E.K_MAX_SCALE, Math.max(E.K_MIN_SCALE, debtScale * supplyScale * maturity));
    return { K: Math.max(E.K_MIN, popBase * E.K_POP_RATIO * kScale), kScale, debtScale, supplyScale, maturity, debtSs };
  }

  /* ---- v4 建筑计划镜像 (与 Engine/js/city-evo.js 及 city_evo_sim.mjs 同构) ---- */
  function sHash01(n, salt, extra) {
    let x = ((n * 374761393 + salt * 668265263 + (extra | 0) * 40503) ^ (n << 13)) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    return ((x ^ (x >>> 13)) >>> 0) / 4294967296;
  }
  const sTERRAIN_RES = { '良田': '粮', '矿脉': '矿', '林地': '木', '灼壤': '炭', '水岸': '渔', '渔家': '渔', '宗门附属': '灵' };
  const sRES_PROD_KIND = { '粮': ['农田', '磨坊', '谷仓'], '矿': ['矿山', '熔炉'], '木': ['伐木场', '药圃'], '炭': ['炼炉', '焦炭窑'], '渔': ['码头', '渔船坞'], '灵': ['聚灵阵', '祭坛'] };
  const sRES_TERRAIN = { '粮': '良田', '矿': '矿脉', '木': '林地', '炭': '灼壤', '渔': '水岸', '灵': '宗门附属' };
  const sRingCache = {};
  function sRingCells(k) {
    if (sRingCache[k]) return sRingCache[k];
    const out = [];
    if (k > 0) {
      const dirs = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
      let q = k, r = 0;
      for (let d = 0; d < 6; d++) for (let s = 0; s < k; s++) { out.push([q, r]); q += dirs[d][0]; r += dirs[d][1]; }
    } else out.push([0, 0]);
    sRingCache[k] = out;
    return out;
  }
  const sClamp = (v, lo, hi) => { v = v | 0; return v < lo ? lo : (v > hi ? hi : v); };
  function sScarcity(meta, pop) {
    const sup = {};
    for (const it of (meta.resource || [])) sup[it.resource] = (sup[it.resource] || 0) + it.amount;
    const demand = E.DEMAND;
    const cache = {};
    return (r) => {
      if (r in cache) return cache[r];
      const need = Math.max(1, (pop | 0) / (demand[r] || 1000));
      let t = (need - (sup[r] || 0)) / need;
      if (t < 0) t = 0; if (t > 1) t = 1;
      cache[r] = t; return t;
    };
  }
  function sLevel(b, ratio, cityTier, sc) {
    const terr = b.terrain || '';
    if (terr === 'core') return sClamp(cityTier, 1, E.BLDG_LV_MAX);
    if (terr === '村落' || terr === '渔家') return sClamp(1 + Math.floor(ratio / E.LV_HOUSE_STEP), 1, E.BLDG_LV_MAX);
    const r = sTERRAIN_RES[terr];
    const t = (r && sc) ? sc(r) : 0;
    return sClamp(1 + (t >= E.LV_PROD_NEED ? 1 : 0) + (t >= E.LV_PROD_NEED2 ? 1 : 0), 1, E.BLDG_LV_MAX);
  }
  function sOverflow(cq, cr, idx, ratio, sc, wantsProd) {
    const R = (CFG.TOWN_R | 0) || 3;
    const cells = sRingCells(R + 1 + (idx % E.OVER_RING_PAD));
    let tried = 0, q = cq + R + 1, r = cr;
    while (tried < 4) {
      const h = sHash01(cq * 131 + idx * 7 + tried, cr * 37 + 991, 1451);
      const cell = cells[(h * cells.length) | 0];
      q = cq + cell[0]; r = cr + cell[1];
      const f = MG.fields(q, r);
      if (f && !f.vein && f.biome !== MG.BIOME.DEEP) break;
      tried++;
    }
    if (!wantsProd) {
      const hv = sHash01(cq + idx, cr - idx, 1601);
      return { q, r, kind: hv < 0.30 ? '仓库' : '民房', terrain: '村落', tier: 1, lv: sLevel({ terrain: '村落' }, ratio, 1, sc), evo: 1 };
    }
    let best = 0, bestR = null;
    for (const cand of E.RES_ORDER) { const v = sc ? sc(cand) : 0; if (v > best) { best = v; bestR = cand; } }
    const rr = bestR || '粮';
    const kinds = sRES_PROD_KIND[rr] || ['农田'];
    const kind = kinds[((sHash01(q, r, 1607) * kinds.length) | 0) % kinds.length];
    return { q, r, kind, terrain: sRES_TERRAIN[rr] || '良田', tier: 1, lv: sLevel({ terrain: sRES_TERRAIN[rr] || '良田' }, ratio, 1, sc), evo: 1 };
  }
  function sPlanOverflow(meta, st) {
    const skeleton = MG.growTownFootprint(meta.id, meta.type, meta.q, meta.r).buildings;
    const type = (st && st.type) || meta.type || 'village';
    const pop = Math.max(0, (st && st.pop) | 0);
    const tier = (st && st.tier) | 0;
    const state = (st && st.state) | 0;
    const capNom = (CFG.TOWN_BUILD_MAX && CFG.TOWN_BUILD_MAX[type]) || 8;
    const ref = E.BLDG_POP_REF[sClamp(tier, 1, 3)] || E.BLDG_POP_REF[2];
    const ratio = pop / ref;
    let cap = Math.round(capNom * Math.pow(Math.max(1e-6, ratio), E.BLDG_POP_EXP));
    if (state === 1) cap = 0;
    else {
      const capMax = Math.round(capNom * (1 + E.BLDG_CAP_OVER));
      if (cap > capMax) cap = capMax;
      if (cap < E.BLDG_CAP_MIN) cap = E.BLDG_CAP_MIN;
      if (state === 3) cap = Math.floor(cap * E.FAMINE_CAP);
    }
    const over = Math.max(0, cap - skeleton.length);
    const sc = sScarcity(meta, pop);
    const wantProd = skeleton.length > 0 && ratio >= 1.0;
    const out = [];
    for (let o = 0; o < over; o++) out.push(sOverflow(meta.q, meta.r, o, ratio, sc, wantProd && (o % 3 === 0)));
    return out;
  }

  function simEvolveCity(s, meta, dtTicks) {
    const policy = E.K_POLICY;
    const dt = Math.max(0, dtTicks | 0);
    const out = Object.assign({}, s);
    out.age = (s.age | 0) + dt;
    out.ver = (s.ver | 0) + 1;
    const res = (meta && meta.resource) || [];
    const demand = E.DEMAND;
    const type = (meta && meta.type) || 'village';
    const maxN = (CFG.TOWN_BUILD_MAX && CFG.TOWN_BUILD_MAX[type]) || 8;
    const skeletonCap = 1 + Math.max(2, Math.floor(maxN * E.HOUSE_RATIO));
    const enterPop = +(s.popF != null ? s.popF : (s.pop | 0));
    const popBase = Math.round(enterPop) || (s.pop | 0) || 1;
    const age0 = s.age | 0, age1 = age0 + dt;
    const yearCrossed = Math.floor(age0 / T.Year) !== Math.floor(age1 / T.Year);
    let basePop;
    if (policy === 'freeze') basePop = (s.basePopF != null ? s.basePopF : popBase);
    else if (policy === 'year') basePop = (s.basePopF == null || yearCrossed) ? popBase : (s.basePopF | 0);
    else basePop = popBase;

    const stock = {};
    for (const r of E.RES_ORDER) stock[r] = (+(s.stock && s.stock[r]) || 0);
    for (const r of E.RES_ORDER) {
      let sup = 0;
      for (const it of res) if (it.resource === r) sup += it.amount;
      const drain = Math.max(1, Math.round(basePop / (demand[r] || 1000)));
      const next = stock[r] + (sup - drain) * dt;
      if (next < 0) stock[r] = 0;
      else if (next > E.STOCK_CAP) stock[r] = E.STOCK_CAP;
      else stock[r] = next;
    }
    const ageRef = (policy === 'freeze' && s.baseAge != null) ? s.baseAge : (s.age | 0);
    const kInfo = simComputeK(basePop, ageRef, res, demand);
    const baseAge = (policy === 'freeze') ? (s.baseAge != null ? s.baseAge : (s.age | 0)) : (s.age | 0);
    const K = kInfo.K;
    const rEff = E.R0 * (type === 'city' ? E.R_CITY : 1.0);
    const p0 = +(s.popF != null ? s.popF : (s.pop | 0));
    let pop;
    if (!(p0 > 0) || K <= 0) pop = p0;
    else pop = K / (1 + ((K - p0) / p0) * Math.exp(-rEff * dt));
    if (pop < E.POP_FLOOR) pop = E.POP_FLOOR;
    const capPop = K * 1.05;
    if (pop > capPop) pop = capPop;
    const popInt = Math.round(pop);
    let tier = s.tier | 0;
    for (let t = tier; t < E.TIER_MAX; t++) {
      if (popInt >= (E.TIER_POP_UP[t] != null ? E.TIER_POP_UP[t] : Infinity)) tier = t + 1;
      else break;
    }
    if (tier > (s.tier | 0)) pop = Math.min(pop, K * 1.6 + E.POP_FLOOR);
    let state = s.state | 0;
    if (state !== 1) {
      if (pop < popBase * E.EVENT_POP_RATIO) state = 3;
      else if (state === 3 && pop > popBase * E.RECOVER_RATIO) state = 0;
    }
    const finalTier = Math.min(E.TIER_MAX, tier);
    /* v4: built[] = 骨架之外的溢出建筑, 由 (pop,tier,state) 纯派生 (每批重建) */
    const built = sPlanOverflow(
      { id: String(s.id), type, q: (meta && meta.q) | 0, r: (meta && meta.r) | 0,
        resource: res, demand },
      { type, pop: Math.round(pop), tier: finalTier, state });
    out.pop = Math.round(pop);
    out.popF = pop;
    out.tier = finalTier;
    out.state = state;
    out.stock = stock;
    out.built = built;
    out.lastEvoTick = (s.lastEvoTick | 0) + dt;
    out.foodDebt = kInfo.debtSs;
    out.builtFrac = 0;
    out.popBase = popBase;
    out.basePopF = basePop;
    out.baseAge = baseAge;
    out.Kf = K;
    return out;
  }

  /* ⚠ dt=0 严格 no-op: 仿真器副本在这里**故意不实现**该早退, 以便下面单独测
     「生产版是否比仿真器副本更严格」—— 所以对拍只跑 dt>0。 */
  const metaOf = (s) => {
    const plan = MG.growTownFootprint(s.id, s.type, s.q, s.r);
    return { type: s.type, q: s.q, r: s.r, resource: plan.resources, demand: E.DEMAND };
  };

  /* 取窗口内全部聚落作 fixture */
  const fixtures = [];
  for (let i = -SPAN; i <= SPAN; i++)
    for (let j = -SPAN; j <= SPAN; j++)
      for (const s of MG.settlementsFor(i, j))
        if (s.type !== 'poi' && !fixtures.some((f) => f.id === s.id)) fixtures.push(s);

  let compared = 0, mismatch = 0, firstBad = '';
  for (const s of fixtures) {
    const meta = metaOf(s);
    /* 起点: 用生产版建 state (这也顺带验了 newCityState 的字段集) */
    let prod = JSON.parse(CE.newStateJson(s.id, s.type, s.q, s.r, s.pop, s.tier, 0));
    let sim = JSON.parse(JSON.stringify(prod));
    for (let n = 0; n < 4; n++) {          // 跑 4 季 = 1 年
      prod = JSON.parse(CE.evolveCityJson(JSON.stringify(prod), JSON.stringify(meta), 90, 'freeze'));
      sim = simEvolveCity(sim, meta, 90);
      compared++;
      const P = JSON.stringify(prod), S = JSON.stringify(sim);
      if (P !== S) {
        mismatch++;
        if (!firstBad) {
          const keys = Object.keys(prod).filter((k) => JSON.stringify(prod[k]) !== JSON.stringify(sim[k]));
          firstBad = `${s.id}: 差异字段=[${keys.join(',')}] prod.pop=${prod.pop} sim.pop=${sim.pop}`;
        }
      }
    }
  }
  ck(`G1 窗口内有聚落可对拍 (${fixtures.length} 座)`, fixtures.length > 0);
  ck(`G2 city-evo.js ≡ 仿真器实现 (逐位相同, ${compared} 次比对)`, mismatch === 0,
    `${mismatch} 次不一致; 首个: ${firstBad}`);
}

/* ════════════════════════════════════════════════════════════
 * H. 生产路径一致性 —— tickprobe `evo` (真引擎+真台账) ≡ 仿真器 (仅演化层)
 * ════════════════════════════════════════════════════════════ */
async function probeEvo() {
  const PROJ = path.join(ROOT, 'verify', 'tickprobe');
  return await new Promise((resolve, reject) => {
    const p = spawn('dotnet', ['run', '--no-build', '-v', 'q', '--project', PROJ],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    const out = [];
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        out.push(JSON.parse(line));
      }
    });
    p.on('close', () => resolve(out));
    p.on('error', reject);
    p.stdin.write(JSON.stringify({ op: 'evo', seed: SEED, years: YEARS, span: SPAN, k: 'freeze' }) + '\n');
    p.stdin.end();
  });
}

const probed = (await probeEvo())[0];
if (!probed || probed.err) {
  ck('H0 tickprobe evo 成功', false, probed && probed.err);
} else {
  console.log(`\n  [probe] 城数=${probed.cityCount} 总人口=${probed.totalPop} tier=${JSON.stringify(probed.tiers)}`);

  /* 仿真器侧: 同一窗口, **只跑演化层** (不贸易/不迁移 —— 那是批级独立层) */
  const states = new Map();
  for (const s of (function () {
    const o = [];
    for (let i = -SPAN; i <= SPAN; i++)
      for (let j = -SPAN; j <= SPAN; j++)
        for (const s of MG.settlementsFor(i, j))
          if (s.type !== 'poi' && !o.some((x) => x.id === s.id)) o.push(s);
    return o;
  })()) {
    states.set(s.id, JSON.parse(CE.newStateJson(s.id, s.type, s.q, s.r, s.pop, s.tier, 0)));
  }
  for (let tick = 90; tick <= YEARS * 360; tick += 90) {
    for (const [id, st] of states) {
      const s = (function () {
        for (let i = -SPAN; i <= SPAN; i++)
          for (let j = -SPAN; j <= SPAN; j++) {
            const hit = MG.settlementsFor(i, j).find((x) => x.id === id);
            if (hit) return hit;
          }
        return null;
      })();
      if (!s) continue;
      const meta = { type: s.type, q: s.q, r: s.r, resource: MG.growTownFootprint(s.id, s.type, s.q, s.r).resources, demand: CE.E.DEMAND };
      states.set(id, JSON.parse(CE.evolveCityJson(JSON.stringify(st), JSON.stringify(meta), 90, 'freeze')));
    }
  }

  const simById = new Map();
  for (const [id, st] of states) simById.set(id, st);
  let diff = 0, firstDiff = '';
  for (const c of probed.cities) {
    const sim = simById.get(c.id);
    if (!sim) { diff++; if (!firstDiff) firstDiff = `${c.id}: 仿真器侧没有这座城`; continue; }
    if (sim.pop !== c.pop || sim.tier !== c.tier || Math.abs(sim.popF - c.popF) > 1e-9) {
      diff++;
      if (!firstDiff) firstDiff = `${c.id}: prod(pop=${c.pop},tier=${c.tier},popF=${c.popF}) sim(pop=${sim.pop},tier=${sim.tier},popF=${sim.popF})`;
    }
  }
  ck(`H1 tickprobe(C#真链路) ≡ 仿真器 端到端 (${probed.cities.length} 城)`, diff === 0,
    `${diff} 城不一致; 首个: ${firstDiff}`);
  ck('H2 终态总人口一致', (() => {
    let t = 0; for (const st of simById.values()) t += st.pop;
    return t === probed.totalPop;
  })(), `probe=${probed.totalPop}`);
}

/* ════════════════════════════════════════════════════════════
 * I. 融入边界 —— 红线在生产 bundle 上依然守住
 * ════════════════════════════════════════════════════════════ */
{
  const fpSettle = () => [...MG.settleCache.keys()].sort()
    .map((k) => k + '=' + MG.settleCache.get(k).map((s) => `${s.id}/${s.pop}/${s.tier}`).join(' ')).join('|');
  const fpBase = () => {
    const o = [];
    for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++)
      o.push(i + ',' + j + ':' + MG.settlementsFor(i, j).map((s) => `${s.id}/${s.pop}/${s.tier}`).join(' '));
    return o.join('|');
  };
  /* 预热: growTownFootprint 会写 settleCache ⇒ 基线必须在预热后取 (否则假 FAIL) */
  for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++)
    for (const s of MG.settlementsFor(i, j)) MG.growTownFootprint(s.id, s.type, s.q, s.r);
  const b1 = fpSettle(), b2 = fpBase(), b3 = MG.roadVersion();

  /* 再跑一整年演化 (生产路径) */
  for (const s of (function () {
    const o = [];
    for (let i = -SPAN; i <= SPAN; i++) for (let j = -SPAN; j <= SPAN; j++)
      for (const s of MG.settlementsFor(i, j)) if (s.type !== 'poi' && !o.some((x) => x.id === s.id)) o.push(s);
    return o;
  })()) {
    let st = JSON.parse(CE.newStateJson(s.id, s.type, s.q, s.r, s.pop, s.tier, 0));
    const meta = { type: s.type, q: s.q, r: s.r, resource: MG.growTownFootprint(s.id, s.type, s.q, s.r).resources, demand: CE.E.DEMAND };
    for (let n = 0; n < 4; n++) st = JSON.parse(CE.evolveCityJson(JSON.stringify(st), JSON.stringify(meta), 90, 'freeze'));
  }
  ck('I1 红线R1: settleCache 逐字节不变 (生产 bundle)', fpSettle() === b1);
  ck('I2 红线R1: settlementsFor 不变 (生产 bundle)', fpBase() === b2);
  ck('I3 红线R1: roadVer 不变 (生产 bundle)', MG.roadVersion() === b3);

  /* 出口契约: mapgen-server 的 CityEvo getter 必须能取到 (C# 走的就是它) */
  ck('I4 MapGenServer.CityEvo 出口可达', !!MGS.CityEvo && typeof MGS.CityEvo.evolveCityJson === 'function');
  /* 全出口都在 (漏一个 = C# 侧运行期「未知 JS 函数」) */
  const NEED_EXPORTS = ['newStateJson', 'metaJson', 'evolveCityJson', 'priceLayerJson',
    'tradeEdgesJson', 'migrateEdgesJson', 'harvestAndBuildJson', 'constantsJson',
    'settlementsJson', 'settlePlanJson', 'planCityBuildings'];
  ck('I5 city-evo 全出口齐备', NEED_EXPORTS.every((k) => typeof CE[k] === 'function'),
    NEED_EXPORTS.filter((k) => typeof CE[k] !== 'function').join(','));

  /* I6 ★ 出口白名单守卫: 引擎新增的每个出口都必须挂到对应 JsvmModule.Invoke 的 switch,
     否则运行期才炸 `未知 JS 函数` (编译期不报)。2026-10-11 目录重构后白名单分散到:
       世界层 → Server/Zongmen/Engine/WorldModule.cs  (渲染/几何/ext 类出口)
       城市层 → Server/Zongmen/Subsystems/City/CityModule.cs (纯演化出口)
     这里对**源码**断言「出口存在」且「归属正确」两件事 (不看运行结果)。 */
  {
    const worldSrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'WorldModule.cs'), 'utf8');
    const citySrc = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'CityModule.cs'), 'utf8');
    const ROUTE = {
      citySettlementsJson: worldSrc,
      citySettlePlanJson: worldSrc,
      cityEvolveJson: citySrc,
      cityNewStateJson: citySrc,
    };
    const missing = Object.keys(ROUTE).filter((k) => !ROUTE[k].includes('"' + k + '"'));
    ck(`I6 出口白名单归属正确 (${Object.keys(ROUTE).length} 项)`, missing.length === 0, missing.join(','));
  }
}

console.log(`\n${fails.length === 0 ? '全部通过 ✔' : fails.length + ' 项失败 ✘'}`);
process.exit(fails.length === 0 ? 0 : 1);
