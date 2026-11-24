/* ============================================================
 * check_domain_radius.mjs — 「规模 → 领地半径」真源与判定语义契约 (离线 Node)
 * ------------------------------------------------------------
 * 需求背景 (用户 2026-09-21):
 *   「城市之间不能太接近, 如果需要根据城镇的规模来设置属于的领地,
 *     如果玩家 8 格附近的有城市的中心就不允许建造」
 * ⇒ 三个必须钉死的口径:
 *   ① 半径**按对方（既有聚落）的规模**取, 不是一个固定 8 格;
 *   ② 边界是「dist < need 才拒」(dist === need 放行) —— 用户原话「8 格附近」= < 8;
 *   ③ 判定必须扫 2 环 (25 个区域格), 1 环不够 (方案 §2.7)。
 *
 * 断言:
 *   A. 真源表 CFG.DOMAIN_R 存在 / 键集固定 / city === 8 / 单调 / poi === 0
 *   B. domainRadiusOf 逐档取值; 表键集 ↔ archetypeOf 值域 **双向**覆盖
 *      (加了键没人用 / 有档位没键 都要红)
 *   C. 边界语义: 对每一档, dist === need 放行 且 dist === need-1 拒绝
 *   D. 扫描深度: 把 blocker 精确挂到 1/2/3 环 (靠 id 前两段), 断言
 *      「2 环内能查到、3 环外查不到」—— 这条用**放大 DOMAIN_R** 的手法证明,
 *      否则默认参数下 2 环的最近可能距离 (25.7) 本来就 > 8 ⇒ 空真。
 *   E. 单向语义: 用 village(need=4) 做**参照系反例** —— 若实现误用固定阈值 8,
 *      距 5 格会被误拒。这条断言必须有非空样本, 空了就红 (反空真纪律)。
 *   F. excludeId 语义 (升级/重建自己时不把自己算成障碍)
 *   G. 前端镜像: 必须从 meta 下发读表 (geo.domainR), 不得在前端复制一份常量表
 *
 * ⚠ 与 live 判据的分工: 深海 / 灵脉 / 灵气 三条判据住在服务端 CheckCore
 *   (要 V8 + PlayerSect 配额), 由 verify/w5_place_rev.mjs 走真 WS 覆盖。
 *   本脚本只测**引擎侧的几何判定**。
 *
 * 用法: node verify/check_domain_radius.mjs [seed...]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;
const CFG = MG.CFG;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

const SEEDS = process.argv.slice(2).length ? process.argv.slice(2) : ['42', 'check', '7'];
const RSPAN = 6;
/* 表键集是**契约**: 与 CFG.DOMAIN_R 的实际键逐字比对 (增删键必须回来登记) */
const KEYS = ['city', 'fishing', 'poi', 'sect1', 'sect2', 'sect3', 'town', 'village'];
/* 期望半径 (与 mapgen-config.js 的注释一并改) —— 这里写死是为了「改了参数就红」,
   而不是把参数抄一遍了事: 真要调档位, 必须同时改表 + 改本处 + 改文案。 */
const EXPECT = { city: 8, town: 6, sect3: 8, sect2: 7, sect1: 6, village: 4, fishing: 4, poi: 0 };

console.log('== A. 真源表 CFG.DOMAIN_R ==');
const DR = CFG.DOMAIN_R;
check('CFG.DOMAIN_R 存在且为对象', !!DR && typeof DR === 'object' && !Array.isArray(DR),
  String(DR));
check('键集与登记一致 (增删档位必须回来登记)', DR &&
  Object.keys(DR).sort().join(',') === KEYS.join(','),
  '实际 ' + Object.keys(DR || {}).sort().join(','));
check('city === 8 (用户原话「8 格附近有城市中心」)', DR && DR.city === 8, '实测 ' + (DR && DR.city));
check('每档取值与 EXPECT 一致', DR && KEYS.every((k) => DR[k] === EXPECT[k]),
  JSON.stringify(DR));
check('宗门三档单调不减 (sect1 <= sect2 <= sect3)',
  DR && DR.sect1 <= DR.sect2 && DR.sect2 <= DR.sect3,
  [DR.sect1, DR.sect2, DR.sect3].join('/'));
check('poi (秘境) 不设领地 (=== 0)', DR && DR.poi === 0, String(DR && DR.poi));

console.log('\n== B. domainRadiusOf 逐档 + 双向覆盖 ==');
const mk = (type, tier) => ({ id: '0_0_u0', type, tier, q: 0, r: 0 });
for (const k of KEYS) {
  const st = k === 'poi' ? mk('poi', 0)
    : k.startsWith('sect') ? mk('sect', +k.slice(4))
    : mk(k, 1);
  check(`domainRadiusOf(${k}) === ${EXPECT[k]}`,
    MG.domainRadiusOf(st) === EXPECT[k],
    `type=${st.type} tier=${st.tier} → ${MG.domainRadiusOf(st)}`);
}
check('未知 type ⇒ 0 (不设领地, 不误挡)', MG.domainRadiusOf(mk('无名', 1)) === 0);
check('null ⇒ 0', MG.domainRadiusOf(null) === 0);
check('sect tier 越界被夹到 1..3 (0 → sect1, 9 → sect3)',
  MG.archetypeOf(mk('sect', 0)) === 'sect1' && MG.archetypeOf(mk('sect', 9)) === 'sect3',
  MG.archetypeOf(mk('sect', 0)) + '/' + MG.archetypeOf(mk('sect', 9)));

/* 双向覆盖: 真实世界里出现过的档位必须都在表里; 表里的键也必须都有真实档位用得上 */
const archSeen = new Set(), typeSeen = new Set();
let nSettle = 0;
for (const seed of SEEDS) {
  MG.init(seed);
  for (let i = -RSPAN; i <= RSPAN; i++) {
    for (let j = -RSPAN; j <= RSPAN; j++) {
      for (const s of MG.settlementsFor(i, j)) {
        nSettle++;
        typeSeen.add(s.type);
        archSeen.add(MG.archetypeOf(s));
      }
    }
  }
}
const archMissing = [...archSeen].filter((k) => !(k in DR));
check(`真实世界的档位全部在表内 (${[...archSeen].sort().join(' ')})`,
  archMissing.length === 0, '缺 ' + archMissing.join(' '));
const archUnused = KEYS.filter((k) => !archSeen.has(k) && k !== 'sect2' && k !== 'sect3');
check('表内键都有真实档位可用 (sect2/sect3 在 seeded 世界里可能不出现, 豁免)',
  archUnused.length === 0, '无人用 ' + archUnused.join(' '));
console.log(`  抽样聚落 ${nSettle} 座, 档位 ${[...archSeen].sort().join(' ')}, 类型 ${[...typeSeen].sort().join(' ')}`);

/* ============================================================
 * 落点/阻挡的构造: 全部用 ext 层 —— 坐标与**归属区域格**都可精确指定
 *   · 归属区域格 = id 的前两段 (setExternalSettlements 按 id 反解, 不重算)
 *     ⇒ 这是唯一能「把 blocker 精确挂到第 n 环」的手段 (真实世界做不到)。
 *   · ext 在 settleCache 之外 ⇒ 改完 ext **不必清任何缓存** 即可生效 ——
 *     C/D/E 段顺带就是这条的运行时验证。
 * ============================================================ */
function setBlockers(list) { MG.setExternalSettlements(list || []); }
function blocker(ring, q, r, type, tier) {
  /* ring = [di, dj] 相对基准区域格 的偏移 ⇒ 直接写进 id 前两段 (引擎按 id 定归属) */
  return { id: ring[0] + '_' + ring[1] + '_u0', type: type, tier: tier,
           q: q, r: r, name: '试锋宗', pop: 1000, owner: '', state: 0, expireTs: 0 };
}

/* ⚠ 构造样本前必须先找一块「干净的落点」: 自动世界本来就可能有聚落, 拿 (0,0) 硬测
   会撞上它们 (症状是"传了 excludeId 仍拒绝"这种看着像 bug 的假红 —— 实际是别的聚落挡着)。
   干净 = 不加任何 ext 时 domainCheck 放行 (即离所有自动聚落都够远)。 */
const FIX_SEED = SEEDS[0];
MG.init(FIX_SEED);
function cleanSpot() {
  setBlockers([]);
  for (let q = -80; q <= 80; q++) {
    for (let r = -80; r <= 80; r++) {
      if (MG.domainCheck(q, r, '').ok) return { q: q, r: r };
    }
  }
  return null;
}
const P = cleanSpot();
check('构造样本前找到干净落点 (自动世界在此处无阻挡)', !!P,
  '已扫 ±80 区域仍未找到 ⇒ 世界太密, 换个 seed');
const CI = Math.floor(P.q / 18), CJ = Math.floor(P.r / 18);     // P 自己的区域格
const own = (d, type, tier) => blocker([CI, CJ], P.q + d, P.r, type, tier);

console.log('\n== C. 边界语义 (dist === need 放行 / need-1 拒绝) ==');
for (const k of ['city', 'town', 'village', 'sect1']) {
  const need = EXPECT[k], type = k.startsWith('sect') ? 'sect' : k;
  const tier = k.startsWith('sect') ? +k.slice(4) : 1;
  for (const [d, want] of [[need, true], [need - 1, false], [need + 1, true]]) {
    setBlockers([own(d, type, tier)]);
    const got = MG.domainCheck(P.q, P.r, '').ok;
    check(`C ${k}(need=${need}) dist=${d} ⇒ ${want ? '放行' : '拒绝'}`, got === want,
      '实测 ' + (got ? '放行' : '拒绝'));
  }
}

console.log('\n== D. 扫描深度: 2 环内能查到 / 3 环外查不到 ==');
/* ⚠ 为什么用"放大半径"的手法: 默认参数下 2 环格距落点的**最近可能**距离 ≈
   18×2 − 10.3 = 25.7 格, 本来就 > 8 ⇒ 直接测必然放行, 是**空真**。
   把半径临时放大到能覆盖那一段距离, 几何关系不变, 测的才是"窗口有多大"。
   另一处容易踩的: 六角立方距离下「对角格」并不近 —— 同一环内 |di|,|dj| 都取 2 时,
   最近可能是 18×2 − 10.3 = 25.7 (取 max(|q|,|r|) 那条方向), 所以对角格要用更大的
   半径才观测得到 (id 前两段才是"环", 坐标只是用来算距离的)。 */
const SAVE = CFG.DOMAIN_R.city;
try {
  /* D1 (CI+2, CJ) 环: 距落点 25 格, 半径 30 ⇒ 必须被查到 */
  CFG.DOMAIN_R.city = 30;
  setBlockers([blocker([CI + 2, CJ], P.q + 25, P.r, 'city', 3)]);
  const inRing2 = MG.domainCheck(P.q, P.r, '').ok;
  check('D1 2 环 (i+2) 的 blocker 被查到 (半径 30 下拒绝) ⇒ 扫到了 2 环',
    inRing2 === false, '实测 ' + (inRing2 ? '放行 (漏扫!)' : '拒绝'));

  /* D2 (CI+3, CJ) 环: 距 35 格, 半径 40 ⇒ 若扫到 3 环就会被查到。断言放行 ⇒ 窗口上界就是 2 环 */
  CFG.DOMAIN_R.city = 40;
  setBlockers([blocker([CI + 3, CJ], P.q + 35, P.r, 'city', 3)]);
  const outRing3 = MG.domainCheck(P.q, P.r, '').ok;
  check('D2 3 环 (i+3) 的 blocker 查不到 (半径 40 下仍放行) ⇒ 窗口恰好 2 环',
    outRing3 === true, '实测 ' + (outRing3 ? '放行' : '拒绝 (扫过头了?)'));

  /* D3 对角格 (CI+2, CJ+2) 也必须在窗内 (窗口是 5x5 方阵, 不是六角环)。
     ⚠ 六角立方距离下对角**并不近**: 该格最近可能约 18×2−10.3 = 25.7, 而格子左下角
       那个点距落点 72 格 —— 半径要开到 80 才观测得到"窗内/窗外"。 */
  CFG.DOMAIN_R.city = 80;
  setBlockers([blocker([CI + 2, CJ + 2], P.q + 36, P.r + 36, 'city', 3)]);   // hexDist = 72
  const diag = MG.domainCheck(P.q, P.r, '').ok;
  check('D3 2 环对角格 (i+2,j+2) 在窗内 (半径 80 下拒绝) ⇒ 窗口是 5x5 而非六角环',
    diag === false, '实测 ' + (diag ? '放行 (漏扫对角!)' : '拒绝'));
} finally {
  CFG.DOMAIN_R.city = SAVE;
  setBlockers([]);
}

console.log('\n== E. 单向语义 (只看对方半径) + 参照系反例 ==');
/* E1 —— 构造反例 (精确且非空真):
   把 blocker 挂在**落点自己的区域格** (id 前缀 0_0), 落点取 (0,0) ⇒ 必在扫描窗内,
   于是"距 5 格"这件事完全由 blocker 的档位决定:
     village(4) 距 5 ⇒ 必须**放行**  ← 若实现用固定 8 格阈值, 这里会误拒 (反例生效)
     city(8)    距 5 ⇒ 必须拒绝     ← 同一位置换个档位就翻转 ⇒ 半径确实取自对方 */
{
  setBlockers([own(5, 'village', 1)]);
  const village5 = MG.domainCheck(P.q, P.r, '').ok;
  setBlockers([own(5, 'city', 3)]);
  const city5 = MG.domainCheck(P.q, P.r, '').ok;
  setBlockers([own(7, 'town', 1)]);
  const town7 = MG.domainCheck(P.q, P.r, '').ok;
  setBlockers([]);
  check('E1 同一落点: village(领 4) 距 5 ⇒ 放行 (固定 8 格口径会误拒)', village5 === true,
    '实测 ' + (village5 ? '放行' : '拒绝'));
  check('E1 同一落点: city(领 8) 距 5 ⇒ 拒绝', city5 === false,
    '实测 ' + (city5 ? '放行' : '拒绝'));
  check('E1 同一落点: town(领 6) 距 7 ⇒ 放行 (自己是谁的宗门不影响)', town7 === true,
    '实测 ' + (town7 ? '放行' : '拒绝'));
}

/* E2 —— 真实世界 + **独立复算**对拍:
   期望值由「自己写的半径映射 + 更宽的 4 环窗口 + hexDist」算出 (不复用被测函数),
   与 domainCheck 的结果逐一比对。这条能抓住"漏扫 1 环/2 环里某个方向"的错。 */
{
  const radiusIndep = (st) => {
    if (!st) return 0;
    const k = (st.type === 'sect')
      ? 'sect' + Math.min(3, Math.max(1, st.tier | 0)) : String(st.type);
    return CFG.DOMAIN_R[k] || 0;
  };
  let n = 0, mismatch = 0, probed = 0;
  const seed0 = SEEDS[0];
  MG.init(seed0);
  const probes = [];
  for (let i = -RSPAN; i <= RSPAN && probes.length < 60; i++) {
    for (let j = -RSPAN; j <= RSPAN && probes.length < 60; j++) {
      for (const s of MG.settlementsFor(i, j)) {
        if (s.type === 'poi') continue;
        const need = radiusIndep(s);
        if (need <= 0) continue;
        probes.push({ q: s.q + need, r: s.r, id: s.id });          // 边界上
        probes.push({ q: s.q + need - 1, r: s.r, id: s.id });      // 边界内
        probes.push({ q: s.q + need + 3, r: s.r - 2, id: s.id });  // 外侧
        if (probes.length >= 60) break;
      }
    }
  }
  for (const p of probes) {
    probed++;
    /* 4 环窗口 = 比实现 (2 环) 更宽 ⇒ 若实现漏扫, 这里会算出 reject 而实现给 ok */
    let expected = true, best = null;
    for (let di = -4; di <= 4; di++) {
      for (let dj = -4; dj <= 4; dj++) {
        for (const st of MG.settlementsFor(Math.floor(p.q / 18) + di, Math.floor(p.r / 18) + dj)) {
          if (st.id === p.id) continue;
          const need = radiusIndep(st);
          if (need <= 0) continue;
          const d = MG.hexDist(p.q, p.r, st.q, st.r);
          if (d < need && (!best || d - need < best)) best = d - need;
        }
      }
    }
    if (best != null) expected = false;
    const got = MG.domainCheck(p.q, p.r, p.id).ok;
    if (got !== expected) {
      mismatch++;
      if (mismatch <= 4)
        console.log(`    ⚠ 落点 (${p.q},${p.r}) 独立复算=${expected ? '放行' : '拒绝'} ` +
                    `实现=${got ? '放行' : '拒绝'}`);
    }
    n++;
  }
  check(`E2 真实世界 ${n} 个落点与独立复算逐一致 (4 环宽窗口 + 自算半径映射)`,
    n > 0 && mismatch === 0, `不一致 ${mismatch}/${n}`);
}

console.log('\n== F. excludeId (升级/重建自己时不把自己算成障碍) ==');
{
  const mine = own(3, 'sect', 3);                        // 领地 8, 距落点 3 ⇒ 必拒
  setBlockers([mine]);
  const without = MG.domainCheck(P.q, P.r, '').ok;
  const withId = MG.domainCheck(P.q, P.r, mine.id).ok;
  check('F 挡路时拒绝 / 传 excludeId 放行', without === false && withId === true,
    `无 excludeId=${without ? '放行' : '拒绝'} 有=${withId ? '放行' : '拒绝'}`);
  /* 只豁免"那一座": 再放一座**不同 id** 的, 传第一座的 id 仍必须拒 */
  const second = { ...own(4, 'city', 3), id: CI + '_' + CJ + '_u1' };
  setBlockers([mine, second]);
  const onlyOne = MG.domainCheck(P.q, P.r, mine.id).ok;
  check('F excludeId 只豁免指定那一座 (另一座仍挡)', onlyOne === false,
    '实测 ' + (onlyOne ? '放行 (豁免过宽!)' : '拒绝'));
  setBlockers([]);
}

console.log('\n== G. 前端镜像: 半径表只能来自 meta ==');
const mainSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'main.js'), 'utf8');
const mcsSrc = fs.readFileSync(path.join(ROOT, 'web', 'js', 'mapclient.js'), 'utf8');
check('G main.js 有 domainRof 且从 geo.domainR 取表',
  /function domainRof\(/.test(mainSrc) && /geo\.domainR/.test(mainSrc));
check('G mapclient.js 的 geo() 暴露 domainR (来自 meta)',
  /domainR:\s*meta\.domainR/.test(mcsSrc));
/* 反向: 前端**不得**复制常量表 —— 否则服务端调档位, 前端领地圈全是错的 (静默) */
const hardcoded = ['city: 8', 'sect3: 8', 'village: 4', 'town: 6'].filter((t) => mainSrc.includes(t));
check('G main.js 未硬编码半径常量表 (必须走 meta)', hardcoded.length === 0,
  '命中 ' + hardcoded.join(' / '));

console.log(`\n========== 结果: ${failures ? failures + ' 项失败' : '全部通过 ✔'} ==========`);
process.exit(failures ? 1 : 0);
