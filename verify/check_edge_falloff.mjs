/* ============================================================
 * check_edge_falloff.mjs — 校验「灵气边界衰减」（界外全海洋 + 无聚落）
 * ------------------------------------------------------------
 * 需求: 灵气边界（spiritAt=0 处）之外的整个世界必须是海洋, 且不产聚落/灵脉峰。
 *      两者各由一个衰减系数驱动 (EDGE_SEA_SP / EDGE_SETTLE_SP), 参考灵气强度曲线。
 *
 * 加载方式: 直接跑 灵脉预览.html 里内联的 3 个引擎脚本块
 *   （= 与预览页跑的完全同一份代码, 避免"测源码而页面跑的是旧副本"）
 *
 * 断言:
 *  A 引擎口径: spiritEdgeWorld / edgeFade 的边界与端点语义
 *  B 地形: 边界外每一圈采样点 e < SEA_LEVEL 且 biome ∈ {DEEP,OCEAN}
 *  C 灵脉峰: 界外不出现 disp >= 8（灵脉格覆写）
 *  D 聚落: 界外 0 个; 界内非空且内环明显多于外环
 *  E 群落: 界外（sp=0 的晶格）0 个
 *  F 回归: 沉海必须在灵脉抬升之后 + 两处守卫必须在位（防被改回去）
 * 用法: node verify/check_edge_falloff.mjs
 * ============================================================ */
import fs from 'fs';

const html = fs.readFileSync('灵脉预览.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let ok = true;
const bad = (m) => { ok = false; console.log('  ✘ ' + m); };
const good = (m) => console.log('  ✔ ' + m);

globalThis.window = globalThis;
new Function(blocks[0])();   // noise.js   → window.NoiseLib
new Function(blocks[1])();   // mapgen-config.js → window.MapGenConfig
new Function(blocks[2])();   // mapgen.js  → window.MapGen
const MG = globalThis.MapGen;
const CFG = globalThis.MapGenConfig;
if (!MG) { console.log('✘ 引擎未加载'); process.exit(1); }

const HEX_R = MG.HEX_R, HEX_W = MG.HEX_W, TILE_H = 1.5 * HEX_R;
const EDGE_W = MG.spiritEdgeWorld();
const EDGE_TILES = EDGE_W / HEX_W;

/* 世界坐标 → 最近地块（轴坐标反解） */
function worldToTile(wx, wy) {
  const r = Math.round(wy / TILE_H);
  const q = Math.round(wx / HEX_W - r * 0.5);
  return { q, r };
}
/* 按世界角度取一环采样点（世界半径 = EDGE_W * k） */
function ring(k, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    out.push(worldToTile(Math.cos(a) * EDGE_W * k, Math.sin(a) * EDGE_W * k));
  }
  return out;
}

console.log('=== 引擎口径 ===');
console.log(`  HEX_R=${HEX_R} HEX_W=${HEX_W.toFixed(3)} SEA_LEVEL=${MG.SEA_LEVEL}`);
console.log(`  SPIRIT_R_TILES=${CFG.SPIRIT_R_TILES} → 归零世界半径 ${EDGE_W} = ${EDGE_TILES.toFixed(1)} 格`);
console.log(`  EDGE_SEA_SP=${CFG.EDGE_SEA_SP}  EDGE_SETTLE_SP=${CFG.EDGE_SETTLE_SP}`);
{
  const want = CFG.SPIRIT_R_TILES * HEX_R * 2;
  EDGE_W === want ? good(`spiritEdgeWorld() = SPIRIT_R_TILES×HEX_R×2 = ${want}`)
                  : bad(`spiritEdgeWorld() = ${EDGE_W}, 期望 ${want}`);
  /* 端点语义: 边界外(sp=0) → keep 0；足量灵气(sp>=band) → keep 1 */
  MG.edgeKeep(0, 0.3) === 0 ? good('edgeKeep(0,band)=0（界外彻底衰减）') : bad('edgeKeep(0,band)≠0');
  MG.edgeKeep(0.5, 0.3) === 1 ? good('edgeKeep(sp≥band)=1（界内不衰减）') : bad('edgeKeep(sp≥band)≠1');
  MG.edgeKeep(0, 0) === 0 && MG.edgeKeep(0.2, 0) === 1
    ? good('edgeKeep(·,0) 退化为硬边界') : bad('edgeKeep band=0 语义错');
  let mono = true, rng = true, prev = -1;
  for (let sp = 0; sp <= 1.0001; sp += 0.01) {
    const v = MG.edgeKeep(sp, 0.3);
    if (v < prev - 1e-9) mono = false;
    if (v < 0 || v > 1) rng = false;
    prev = v;
  }
  mono ? good('edgeKeep 单调不减') : bad('edgeKeep 非单调');
  rng ? good('edgeKeep 值域 [0,1]') : bad('edgeKeep 越界');
  /* 方向性断言: 灵气越浓 → 保留越多（反了就说明又被当成"衰减"乘了） */
  MG.edgeKeep(0.9, 0.3) >= MG.edgeKeep(0.1, 0.3)
    ? good('edgeKeep 随灵气递增（方向正确: 内保留、外衰减）')
    : bad('edgeKeep 方向反了');
}

for (const seed of ['EDGETEST', 'EDGETEST2']) {
  MG.init(seed);
  console.log(`\n=== seed=${seed} ===`);

  /* ---- B 地形: 界外全海洋 ---- */
  let outWater = 0, outTot = 0, outDispBad = 0;
  for (const k of [1.0, 1.02, 1.1, 1.3, 2.0]) {
    for (const t of ring(k, 48)) {
      const f = MG.fields(t.q, t.r);
      outTot++;
      if (f.e < MG.SEA_LEVEL && f.biome <= 1) outWater++;
      if (f.disp >= 8) outDispBad++;
    }
  }
  outWater === outTot ? good(`界外采样 ${outTot} 格全部为海 (e<SEA_LEVEL 且 biome∈{DEEP,OCEAN})`)
                      : bad(`界外有 ${outTot - outWater}/${outTot} 格不是海`);
  outDispBad === 0 ? good('界外无灵脉格覆写 (disp<8)') : bad(`界外有 ${outDispBad} 格 disp>=8`);

  /* 环带陆地占比（只报告; 界内占比由自然地形决定, 不能当单调不变式用） */
  console.log('  环带（世界半径 × 边界）  陆地占比   平均 e');
  const rings = [];
  for (const k of [0.3, 0.6, 0.75, 0.85, 0.9, 0.95, 1.0, 1.05]) {
    const ts = ring(k, 72);
    let land = 0, esum = 0;
    for (const t of ts) { const f = MG.fields(t.q, t.r); esum += f.e; if (f.e >= MG.SEA_LEVEL) land++; }
    const pct = land / ts.length;
    rings.push({ k, pct });
    console.log(`    ${k.toFixed(2).padStart(5)}                  ${(pct * 100).toFixed(0).padStart(3)}%    ${(esum / ts.length).toFixed(3)}`);
  }
  const last = rings[rings.length - 1].pct;
  last === 0 ? good('边界(k=1.0)及其外陆地占比 0%') : bad(`k=1.0 处仍有 ${(last * 100).toFixed(0)}% 陆地`);
  rings.slice(0, 4).reduce((a, b) => a + b.pct, 0) > 0
    ? good('界内仍有陆地（没被整体淹掉 → 衰减方向正确）')
    : bad('界内全淹 → 衰减权重方向反了（灵气越浓越沉海）');
  /* 边界带(0.9~1.0)应介于"界内自然地形"与"界外全海"之间 → 说明是渐变不是硬切 */
  const bandLand = rings[4].pct + rings[5].pct + rings[6].pct;
  console.log(`    边界带 0.90~1.00 累计陆地占比 ${(bandLand / 3 * 100).toFixed(0)}%（过渡区, 可为 0）`);

  /* ---- D 聚落: 界外 0，界内非空、内环多于外环 ---- */
  const RINGS = [[0, 0.5], [0.5, 0.75], [0.75, 0.9], [0.9, 1.0], [1.0, 3.0]];
  const cnt = RINGS.map(() => 0);
  let total = 0, beyond = 0, maxDist = 0;
  const N = 70;                                  // 区域格范围 ±70 → ±1260 格 > 边界
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    for (const st of MG.settlementsFor(i, j)) {
      total++;
      const d = Math.sqrt(st.x * st.x + st.y * st.y) / EDGE_W;
      if (d > maxDist) maxDist = d;
      if (d > 1) beyond++;
      for (let k = 0; k < RINGS.length; k++) if (d >= RINGS[k][0] && d < RINGS[k][1]) { cnt[k]++; break; }
    }
  }
  console.log('  聚落按"距中枢 / 边界半径"分布：');
  RINGS.forEach((r2, k) => console.log(`    ${r2[0].toFixed(2)}~${r2[1].toFixed(2)}  ${String(cnt[k]).padStart(5)} 个`));
  console.log(`    合计 ${total} 个, 最远 ${maxDist.toFixed(3)} × 边界`);
  beyond === 0 ? good('边界外 0 个聚落/秘境') : bad(`边界外有 ${beyond} 个聚落`);
  total > 0 ? good(`界内仍有 ${total} 个聚落（衰减没有把世界清空）`) : bad('界内聚落被清空了');
  cnt[0] > cnt[3] ? good('内环(0~0.5)明显多于外环(0.9~1.0)') : bad('聚落密度没有向外递减');

  /* ---- E 群落: 界外 0 ---- */
  let commOut = 0, commTot = 0;
  for (let i = -14; i <= 14; i++) for (let j = -14; j <= 14; j++) {
    const cm = MG.communityOf(i, j);
    if (!cm) continue;
    commTot++;
    const sp = MG.spiritAt(i * CFG.COMM_CL, j * CFG.COMM_CL);
    if (sp <= 0) commOut++;
  }
  commOut === 0 ? good(`界外 0 个群落（共 ${commTot} 个）`) : bad(`界外有 ${commOut} 个群落`);
}

/* ---- G 系数确实生效: EDGE_SEA_SP 越大 → 界内水域越多 ---- */
console.log('\n=== 系数生效（同 seed 扫 EDGE_SEA_SP） ===');
{
  MG.init('EDGECOEFF');
  const GS = 20, LIM = 640;
  const tiles = [];
  for (let q = -LIM; q <= LIM; q += GS) for (let r = -LIM; r <= LIM; r += GS) tiles.push({ q, r });
  const waterCount = () => { let w = 0; for (const t of tiles) if (MG.elevAt(t.q, t.r) < MG.SEA_LEVEL) w++; return w; };
  const rows = [];
  for (const v of [0, 0.15, 0.30, 0.45, 0.60]) {
    MG.configure({ EDGE_SEA_SP: v });          // 清缓存 → 用新系数重算
    rows.push({ v, w: waterCount() });
  }
  rows.forEach(r => console.log(`  EDGE_SEA_SP=${String(r.v).padEnd(5)} → 水域 ${String(r.w).padStart(5)}/${tiles.length} (${(r.w / tiles.length * 100).toFixed(0)}%)`));
  rows.every((r, i) => i === 0 || r.w >= rows[i - 1].w)
    ? good('系数增大 → 水域单调不减') : bad('系数与水域不单调');
  rows[4].w > rows[0].w ? good('系数确实起作用（0.60 比 0 淹得多）') : bad('系数不起作用');
  MG.configure({ EDGE_SEA_SP: CFG.EDGE_SEA_SP });   // 还原
}

/* ---- H 边界圈 = 海岸线: 从原点向外径向扫, 陆地最远到哪 ----
   这是"圈内外不错位"最强的不变式: 陆地必须止于圈上, 且不能远早于圈结束。 */
console.log('\n=== 边界圈 vs 海岸线（径向扫描 48 方向） ===');
{
  MG.init('EDGEALIGN');
  const N = 48, ratios = [];
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2;
    let last = 0;
    for (let k = 0.05; k <= 1.20; k += 0.01) {
      const t = worldToTile(Math.cos(a) * EDGE_W * k, Math.sin(a) * EDGE_W * k);
      if (MG.elevAt(t.q, t.r) >= MG.SEA_LEVEL) last = k;
    }
    ratios.push(last);
  }
  const sorted = [...ratios].sort((x, y) => x - y);
  const minLand = sorted[0], med = sorted[N >> 1], maxLand = sorted[N - 1];
  console.log(`  陆地最远半径(×边界): 最小 ${minLand.toFixed(2)} / 中位 ${med.toFixed(2)} / 最大 ${maxLand.toFixed(2)}`);
  maxLand <= 1.0001 ? good('无任何方向的陆地越过边界圈') : bad(`最远 ${maxLand.toFixed(2)} 越过边界`);
  med >= 0.80 ? good(`中位方向陆地延伸到 ${med.toFixed(2)} 边界（不是被早早切掉）`)
              : bad(`中位只到 ${med.toFixed(2)} 边界, 陆地被切得过早`);
  minLand >= 0.40 ? good(`最"海"的方向陆地也到 ${minLand.toFixed(2)} 边界`)
                  : bad(`有方向陆地只到 ${minLand.toFixed(2)} 边界（疑似把内圈也淹了）`);
}

/* ---- F 回归断言: 锁死本次两个坑不被改回去 ---- */
console.log('\n=== 回归断言（防改回） ===');
{
  const src = fs.readFileSync('Server/Zongmen/Engine/js/mapgen.js', 'utf8');
  const lift = src.indexOf('LIFT_CORE[vn.v.level]');
  const sink = src.indexOf('var gSea = 1 - edgeKeep(spiritAt(q, r)');
  lift >= 0 && sink > lift ? good('沉海发生在灵脉抬升【之后】（否则界外会留灵脉山）')
                           : bad('沉海位置不对: 必须在 LIFT_CORE 抬升之后');
  /1 - edgeKeep\(spiritAt/.test(src)
    ? good('沉海用 1 - edgeKeep（方向正确）')
    : bad('沉海权重方向错了: 必须写 1 - edgeKeep(…)，直接乘 keep 会内圈全淹');
  /vinfo\s*=\s*null;\s*\n\s*if \(vn && vn\.d <= 1 && e >= SEA_LEVEL\)/.test(src)
    ? good('fields(): 灵脉覆写带 "e >= SEA_LEVEL" 陆地守卫')
    : bad('fields() 缺陆地守卫 → 海面上会留无根灵脉峰');
  /pSpawn = \(0\.20 \+ 0\.38 \* spLoc\) \* edgeKeep\(spLoc, CFG\.EDGE_SETTLE_SP\)/.test(src)
    ? good('settlementsFor(): 概率乘了 EDGE_SETTLE_SP 衰减')
    : bad('settlementsFor() 缺边界衰减');
  /\(CFG\.COMM_P_MIN \+ CFG\.COMM_P_SPIRIT \* sp\) \* edgeKeep\(sp, CFG\.EDGE_SEA_SP\)/.test(src)
    ? good('communityOf(): 概率乘了 EDGE_SEA_SP 衰减')
    : bad('communityOf() 缺边界衰减');
  /spiritEdgeWorld: spiritEdgeWorld/.test(src) ? good('导出 spiritEdgeWorld（预览页/客户端共用口径）')
                                               : bad('未导出 spiritEdgeWorld');
}

console.log(ok ? '\n=== 结论: ✔ 全部通过 ===' : '\n=== 结论: ✘ 有失败项 ===');
process.exit(ok ? 0 : 1);
