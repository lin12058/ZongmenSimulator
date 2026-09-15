/* ============================================================
 * check_plaque_align.mjs — 「匾额/名牌落点对齐」契约回归 (离线 Node, 不需起服务)
 * ------------------------------------------------------------
 * 病症 (用户 2026-09-15 / 09-16 两次反馈):
 *   「村庄的名字下面的那个竖线和点和当前的村庄、灵脉对不上」
 *   ⇒ 三条独立的病因, 本脚本各钉一组断言:
 *
 *   C-a **聚落名牌落点** = 扎在建筑群**正中**的**真实建筑格**上
 *       初版: 横向取「聚落中心格 x」+ 纵向取「建筑格 y 的 p25」拼成**合成点**
 *             ⇒ 该点通常不对应任何建筑 (落在村里的空隙/边缘)。
 *       一修: 「世界 x 离聚落中心列最近的真建筑格」—— 仍是合成思路的残留:
 *             聚落的**选址格** (siteScore 挑出来的那格) 常在聚落一侧 ⇒ 落点被拉到
 *             边缘那座孤屋上 (实测 seed42 归元宗 偏 3.00 R ≈ 77px)。
 *       二修: 取**中位格** (建筑 x/y 中位数 → 中位点 → 最近的真建筑)。比一修好,
 *             但聚落细长/拐角时中位点会落到两簇之间, 最近的那座仍可能偏在一侧。
 *       三修: 取**最密格** —— 2·hexR 邻域内建筑数最多的那座 (平手按「离截尾质心近
 *             → 更北 → 更西」全序)。它直接回答"村子扎堆的地方在哪", 对远处农田/
 *             码头完全免疫。真机两套种子离线评比 (verify/anc_fixture.json):
 *               seed42  最密 0.723R  <  中位 0.840  <  medoid 0.855  <<  col 1.329
 *               seed777 最密 0.905R  <  medoid 0.950  <  中位 1.207  <<  col 1.762
 *             且最差偏差 == 「离截尾质心最近的那座」可达下界 (即已是理论最优)。
 *
 *   C-c **灵脉签垂直落点** = 峰尖 (两层误差, 分两次修)
 *       初版: 返回 H + 0.35, 而方框底 = 格心 + uR*0.95 ⇒ 恒定多抬 1.30 uR (≈33px)。
 *       一修: VS.tipU 返回 H - propBottomU。
 *       二修: 但 H - propBottomU 是**方框顶**的绝对高度, 而 128 逻辑格里峰尖上方还有
 *             一段空白 (格 y 0..~21) ⇒ 方框顶比真实峰尖高 apexV*H (大档 1.19~1.49 uR
 *             ≈30~38px)。现在返回 (1 - apexV()) * H - propBottomU。
 *             两次叠加时圆点悬空共 ≈2.8 uR (≈71px)。
 *
 *   C-c2 **灵脉签水平落点** = 峰尖 (也是二修新增)
 *       峰体在 shader 里按 hash 横向抖动 jx = (fract(hash*3.77)-0.5)*uR*1.8 (±0.9 uR
 *       ≈ ±23px), 而签子原先固定挂格心 ⇒ 竖线落在峰的一侧。现在跟 jx 走。
 *
 *   D  **灵脉名文案** = `<地貌名>·<档>`
 *       旧: `v.name + '灵脉·' + 档` ⇒ 地貌名池自带「脉/峰/谷」⇒ 叠字 (金属矿脉灵脉·大);
 *           且曾用半角括号。新: 单一真源 VS.label, 全角间隔号, 不缀「灵脉」。
 *
 * 断言:
 *   A. 聚落落点 (C-a) —— BldgInk.anchorOf 语义
 *      A1 默认 = 最密格 (与独立复算一致) / A2 real=true 带 q,r / A3 落点是输入里的一座
 *      A3b 缺省实参与 '' 同解 / A4 平手走「近截尾质心 → 北 → 西」全序
 *      A5 与输入序无关 / A6 离群地物不改变落点 / A7 y0 = 建筑格 y 的 p25
 *      A8 无建筑 → null / A9 'box' 退回包围盒中心 / A10 布尔 true 视同 'box'
 *      A11 'col' 复现一修行为 / A12 'med' 复现二修中位格 / A12b 'sum' 复现 medoid
 *      A13 实测样本 (anc_fixture.json, 两套种子) 上默认口径的均值/最差/接近最优
 *   B. 灵脉签位 (C-c / C-c2) —— VS.apexV / VS.tipU / VS.apexJx
 *      B0 propBottomU==0.95 / B1 apexV == 复刻 textures 峰形采样解出的 (方框内峰尖位置)
 *      / B2 tipU == (1-apexV)*H - propBottomU (4 档 × 7 海拔) / B3 本轮相对"方框顶口径"
 *      的新增下移 == apexV*H / B4 相对初版 (H+0.35) 的总下移 == apexV*H + 1.30 且大档
 *      >= 2.5 uR / B5 峰尖随档递减 / B6 coreElev 单调 / B7 海拔未到货走 coreElev
 *      / B8 同档内只偏矮不高抬 / B8b 记录既有 snowLo<mtnHi 断点 / B9 相对旧口径改善
 *      >= 2 uR / B10 不抛异常 / B11 越界档兜「小」 / B12 有 hash 时走真值 hrand
 *      / B13 hash 精修相对包络中点的偏差有界且非零 / B14 apexJx 有界·零 hash→0·可复算
 *      / B15 apexOf = { tipU, apexJx } 的打包
 *   C. 文案 (D)       —— VS.label 格式 / 分隔符 / 兜底 / 不叠字 / 四档 key 对齐
 *   D. 源码守卫       —— 前端文件里不许再出现"第二份公式"/硬编码/旧拼接
 *
 * 跨源断言 (coreElev == 引擎 LIFT_CORE) 在 check_vein_skin.mjs —— 只有那里加载了引擎。
 *
 * 用法: node verify/check_plaque_align.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'js');

global.window = globalThis;

/* ---- 载入前端两个模块 (均无 DOM 依赖, 可裸 eval) ---- */
function loadMod(f) {
  const p = path.join(WEB, f);
  (0, eval)(fs.readFileSync(p, 'utf8'));
}
delete global.VeinSkin; delete global.BldgInk;
loadMod('vein-skin.js');
loadMod('bldg_ink.js');
const VS = global.VeinSkin;
const BI = global.BldgInk;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* ============================================================
 * A. 聚落名牌落点 = 建筑群正中的真实建筑格 (C-a 二修)
 * ============================================================ */
console.log('== 匾额契约 A: 聚落落点扎在建筑群正中的真实建筑格 (C-a) ==');
check('vein-skin.js / bldg_ink.js 已加载且暴露所需出口',
  !!VS && !!VS.shape && !!VS.levels && !!VS.tipU && !!VS.label && !!VS.apexV && !!VS.apexJx &&
  !!BI && typeof BI.anchorOf === 'function');

if (!BI || typeof BI.anchorOf !== 'function') {
  console.log('\n========== 结果: 缺 anchorOf, 终止 ==========');
  process.exit(1);
}

/* 几何: 世界 x = hexW*(q + r/2), y = 1.5*hexR*r (与 mapclient.tileToWorld / bldg_ink DIRS 同式) */
const HEXW = 1.0, HEXR = 1.0;
const wx = (q, r) => HEXW * (q + r / 2);
const wy = (r) => 1.5 * HEXR * r;

/* 建筑群: 8 座 (2 列 × 4 行的六边形团) —— 数量足够让"最密/中位"都稳定 */
const CLUSTER = [
  { q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 },
  { q: 0, r: 2 }, { q: 1, r: 2 }, { q: 2, r: 2 },
  { q: 0, r: 4 }, { q: 1, r: 4 }
];
/* 离群地物: 远方的农田/码头 —— 均值/包围盒/medoid 都会被它拉走, 最密/中位不会 */
const FAR = { q: 9, r: 9 };
const BS = CLUSTER.concat([FAR]);

/* 「离聚落中心列最近」的 A/B 对拍参照: 故意把中心列放在建筑群**西缘** (偏心选址格),
   模拟 siteScore 选出的格子落在聚落一侧的真实情形。 */
const CENTERX_ECC = wx(0, 0);      // = 0.0 —— 建筑群西缘那一列

/* ---- 三条口径的**独立复算** (刻意换一种写法: 排序取键 vs 库里的滚动比较,
        两条路一致才说明"契约没跟着实现一起漂") ---- */
function wsOf(list) { return list.map((b) => ({ q: b.q, r: b.r, x: wx(b.q, b.r), y: wy(b.r) })); }
function meanOf(a) {
  return { x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length };
}
/* 截尾质心: 先取均值, 丢掉离它最远的 dropFrac, 再取均值 */
function trimmedCentroidOf(a, dropFrac) {
  const c0 = meanOf(a);
  const ds = a.map((w) => ({ w: w, d: Math.hypot(w.x - c0.x, w.y - c0.y) })).sort((p, q) => p.d - q.d);
  const keep = Math.max(3, Math.min(a.length, Math.round(a.length * (1 - dropFrac))));
  return meanOf(ds.slice(0, keep).map((o) => o.w));
}
/* 默认口径「最密格」: 2R 邻域邻居最多 → 离截尾质心近 → 更北 → 更西 */
function densestRef(list, hexR) {
  const a = wsOf(list), ref = trimmedCentroidOf(a, 0.25), r2 = (hexR * 2) * (hexR * 2);
  const keyed = a.map((w) => {
    let c = 0;
    for (const o of a) { const dx = w.x - o.x, dy = w.y - o.y; if (dx * dx + dy * dy <= r2 + 1e-9) c++; }
    return { w: w, c: c, k: Math.hypot(w.x - ref.x, w.y - ref.y), y: w.y, x: w.x };
  });
  keyed.sort((p, q) => (q.c - p.c) || (p.k - q.k) || (p.y - q.y) || (p.x - q.x));
  return keyed[0].w;
}
/* 二修口径「中位格」 */
function medianRef(list) {
  const a = wsOf(list);
  const xs = a.map((w) => w.x).sort((p, q) => p - q), ys = a.map((w) => w.y).sort((p, q) => p - q);
  const mx = xs[(a.length - 1) >> 1], my = ys[(a.length - 1) >> 1];
  return a.slice().sort((p, q) => {
    const dp = (p.x - mx) ** 2 + (p.y - my) ** 2, dq = (q.x - mx) ** 2 + (q.y - my) ** 2;
    return (dp - dq) || (p.y - q.y);
  })[0];
}
/* 二修备选 medoid */
function medoidRef(list) {
  const a = wsOf(list);
  return a.slice().sort((p, q) => {
    const sp = a.reduce((s, o) => s + Math.hypot(p.x - o.x, p.y - o.y), 0);
    const sq = a.reduce((s, o) => s + Math.hypot(q.x - o.x, q.y - o.y), 0);
    return (sp - sq) || (p.y - q.y);
  })[0];
}

const expD = densestRef(CLUSTER, HEXR);
const an = BI.anchorOf(CLUSTER, HEXW, HEXR, CENTERX_ECC, '');
console.log('  最密格复算期望: q=' + expD.q + ' r=' + expD.r +
            ' → x=' + expD.x.toFixed(3) + ' y=' + expD.y.toFixed(3));
console.log('  实得 anchorOf  : q=' + an.q + ' r=' + an.r +
            ' → x=' + an.x.toFixed(3) + ' y=' + an.y.toFixed(3) + ' real=' + an.real);

check('A1 默认落点 = **最密格** (2R 邻域邻居最多, 平手取离截尾质心近者, 与独立复算一致)',
  an.q === expD.q && an.r === expD.r &&
  near(an.x, wx(expD.q, expD.r)) && near(an.y, wy(expD.r)),
  `实得 (${an.q},${an.r}) vs 期望 (${expD.q},${expD.r})`);
check('A2 real === true 且带真实格坐标 q/r (不是合成点)',
  an.real === true && an.q !== null && an.r !== null, JSON.stringify({ real: an.real, q: an.q, r: an.r }));
check('A3 落点**是输入里的一座建筑** (逐座比对, 不是凭空算出来的点)',
  CLUSTER.some((b) => b.q === an.q && b.r === an.r),
  `(${an.q},${an.r}) 不在输入里`);

/* 缺省实参 (不传 mode) 与显式 '' 同解 —— main.js 走 ANC_GEO='' 那条路 */
const an4 = BI.anchorOf(CLUSTER, HEXW, HEXR, CENTERX_ECC);
check('A3b 缺省实参 (4 参调用) 与显式 \'\' 同解',
  an4 && an4.q === an.q && an4.r === an.r, `4参 (${an4 && an4.q},${an4 && an4.r})`);

/* 平手阶梯: CLUSTER 里 (0,0)/(1,0)/(2,0)/(2,3)/(3,3) 都是 3 个邻居 (并列),
   其中 (1,0)/(2,0)/(2,3) 又同样贴近截尾质心 ⇒ 必须靠「更北 → 更西」的**全序**
   落到 (1,0)。这条同时钉住「与输入序无关」(见 A5)。 */
const anRev = BI.anchorOf(CLUSTER.slice().reverse(), HEXW, HEXR, CENTERX_ECC, '');
check('A4 邻居数并列时按「离截尾质心近 → 更北 → 更西」全序决出 (CLUSTER → (1,0))',
  an.q === 1 && an.r === 0, `实得 (${an.q},${an.r}) / 期望 (1,0)`);
check('A5 结论与建筑数组顺序**无关** (全序比较, 输入序反过来结果不变)',
  anRev.q === an.q && anRev.r === an.r,
  `正序 (${an.q},${an.r}) / 反序 (${anRev.q},${anRev.r})`);

/* 离群地物不改变落点 —— 最密格只数邻居, 远处农田连邻居都算不上 */
const anWithFar = BI.anchorOf(BS, HEXW, HEXR, CENTERX_ECC, '');
check('A6 离群地物 (远方的农田/码头) **不**改变落点 (均值/包围盒/medoid 都会被拉走)',
  anWithFar.q === an.q && anWithFar.r === an.r,
  `无离群 (${an.q},${an.r}) / 有离群 (${anWithFar.q},${anWithFar.r})`);

/* y0 = 建筑格 y 的 p25 (旧口径保留 —— 让位/旧路径还要用) */
const ysSorted = CLUSTER.map((b) => wy(b.r)).sort((a, b) => a - b);
const y0Exp = ysSorted[Math.min(ysSorted.length - 1, Math.floor(0.25 * ysSorted.length))];
check('A7 y0 仍返回建筑格 y 的 p25 (旧口径保留, 供让位逻辑)',
  near(an.y0, y0Exp), '实得 ' + an.y0 + ' / 期望 ' + y0Exp);

/* 空建筑 → null (调用方必须**不落缓存** —— 由源码守卫 D 钉) */
check('A8 无建筑 → null (调用方须待建筑到货再算, 不许缓存退化值)',
  BI.anchorOf([], HEXW, HEXR, 0, '') === null &&
  BI.anchorOf(null, HEXW, HEXR, 0, '') === null);

/* ?ancgeo=box → 退回包围盒中心 (只作同机位 A/B 差分用) */
const anBox = BI.anchorOf(CLUSTER, HEXW, HEXR, 7.7, 'box');
const xsAll = CLUSTER.map((b) => wx(b.q, b.r));
const boxX = (Math.min.apply(null, xsAll) + Math.max.apply(null, xsAll)) / 2;
check('A9 ?ancgeo=box → 退回旧「包围盒中心」且 real=false (同机位 A/B 差分可用)',
  anBox.real === false && anBox.q === null && near(anBox.x, boxX),
  'x=' + anBox.x + ' / 期望 ' + boxX);
const anTrue = BI.anchorOf(CLUSTER, HEXW, HEXR, 7.7, true);
check('A10 布尔 true 视同 \'box\' (兼容 ?ancgeo=1 的老调用)',
  anTrue.real === false && near(anTrue.x, boxX), 'x=' + anTrue.x);

/* ?ancgeo=col → 复现「一修」口径 (离中心列最近), 供同机位对拍; 偏心中心列时
   它正好落在建筑群**西缘那座孤屋**上 —— 这就是三修要修的病症。 */
const anCol = BI.anchorOf(CLUSTER, HEXW, HEXR, CENTERX_ECC, 'col');
check('A11 ?ancgeo=col 复现一修口径 (离中心列最近, 并列取北) —— 同机位 A/B 对拍可用',
  anCol.real === true && anCol.q === 0 && anCol.r === 0,
  `实得 (${anCol.q},${anCol.r}) / 期望 (0,0)`);

/* A12: 二修口径 ('med') 与 medoid ('sum') 都能被复现 —— 三条 A/B 档位都在 */
const anMed = BI.anchorOf(CLUSTER, HEXW, HEXR, CENTERX_ECC, 'med');
const expMed = medianRef(CLUSTER);
const anSum = BI.anchorOf(CLUSTER, HEXW, HEXR, CENTERX_ECC, 'sum');
const expSum = medoidRef(CLUSTER);
check('A12 ?ancgeo=med 复现二修「中位格」口径', anMed.q === expMed.q && anMed.r === expMed.r,
  `实得 (${anMed.q},${anMed.r}) vs 期望 (${expMed.q},${expMed.r})`);
check('A12b ?ancgeo=sum 复现二修备选 medoid 口径', anSum.q === expSum.q && anSum.r === expSum.r,
  `实得 (${anSum.q},${anSum.r}) vs 期望 (${expSum.q},${expSum.r})`);

/* ============================================================
 * A-fixture: 用**真机实测**的建筑格快照横向评比四条口径。
 *   参照系 = 截尾质心 (丢最远 25%) —— 远处农田/码头被剔掉。
 *   ⚠ 别拿裸均值当参照: 它会被同一批离群地物拉走, 于是"离参照最近"的恰恰是
 *     被拉偏的那条规则 (一修 col 就吃过这个假好评)。
 *   期望 (两套种子一致): 最密格 <= 中位格 <= medoid << 一修 col。
 * ============================================================ */
const FIXTURE = path.join(__dirname, 'anc_fixture.json');
if (!fs.existsSync(FIXTURE)) {
  check('A13 实测样本 anc_fixture.json 存在 (=?plaqprobe=1 自回传的快照)', false, FIXTURE);
} else {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const RULE = { '最密格(默认)': '', '一修 col': 'col', '二修 中位格': 'med', 'medoid': 'sum' };
  let allMeanOk = true, allWorstOk = true, nearOpt = true, detail = '';
  for (const S of fx.seeds) {
    const acc = {}, opt = [];
    for (const k in RULE) acc[k] = [];
    for (const st of S.settles) {
      const cells = st.bldgs.map((b) => ({ q: b[0], r: b[1] }));
      const ws = cells.map((b) => ({ q: b.q, r: b.r, x: S.hexW * (b.q + b.r / 2), y: 1.5 * S.hexR * b.r }));
      const ref = trimmedCentroidOf(ws, 0.25);
      for (const k in RULE) {
        const a = BI.anchorOf(cells, S.hexW, S.hexR, st.sx, RULE[k]);
        acc[k].push(Math.hypot(a.x - ref.x, a.y - ref.y) / S.hexR);
      }
      opt.push(Math.min.apply(null, ws.map((w) => Math.hypot(w.x - ref.x, w.y - ref.y))) / S.hexR);
    }
    const avg = (a) => a.reduce((p, q) => p + q, 0) / a.length;
    const wst = (a) => Math.max.apply(null, a);
    const dm = avg(acc['最密格(默认)']), dw = wst(acc['最密格(默认)']);
    detail += `\n    seed ${S.seed} (${S.settles.length} 座): 默认 ${dm.toFixed(3)}/${dw.toFixed(3)}` +
      ` | col ${avg(acc['一修 col']).toFixed(3)}/${wst(acc['一修 col']).toFixed(3)}` +
      ` | med ${avg(acc['二修 中位格']).toFixed(3)}/${wst(acc['二修 中位格']).toFixed(3)}` +
      ` | sum ${avg(acc['medoid']).toFixed(3)}/${wst(acc['medoid']).toFixed(3)}` +
      ` ‖ 最优可达 ${avg(opt).toFixed(3)}/${wst(opt).toFixed(3)}`;
    for (const k of ['一修 col', '二修 中位格', 'medoid']) {
      if (!(dm <= avg(acc[k]) + 1e-9)) allMeanOk = false;
      if (!(dw <= wst(acc[k]) + 1e-9)) allWorstOk = false;
    }
    if (!(dm <= avg(opt) + 0.10)) nearOpt = false;         // 平均偏差距最优 <= 0.10R
    if (!near(dw, wst(opt), 1e-9)) nearOpt = false;        // 最差偏差 == 最优可达
  }
  console.log('  实测四口径偏差 (R 倍数, 越小越居中):' + detail);
  check('A13 默认「最密格」的**平均偏差**不劣于 col / 中位格 / medoid (两套种子)', allMeanOk);
  check('A13b 默认「最密格」的**最差偏差**不劣于 col / 中位格 / medoid (两套种子)', allWorstOk);
  check('A13c 默认口径接近**理论最优** (平均偏差距最优 <= 0.10R 且最差偏差 == 可达下界)', nearOpt);
}

/* ============================================================
 * B. 灵脉签落点 = 峰尖 (C-c 垂直 + C-c2 水平)
 * ============================================================ */
console.log('\n== 匾额契约 B: 灵脉签位对齐峰尖 (C-c 垂直 / C-c2 水平) ==');
const SH = VS.shape;
const PBU = SH.propBottomU;      // = shader 的 uR*0.95
const AV = VS.apexV();           // 峰尖在精灵方框里的相对位置 (0=方框顶)

check('B0 shape.propBottomU 存在且 == 0.95 (与 PROP_VS 的 uR*0.95 同源)',
  PBU != null && near(PBU, 0.95), 'propBottomU=' + PBU);

/* B1: 独立复刻 textures.js 的峰形采样, 解出「峰尖在方框里的位置」。
   与 apexV() 的实现**故意不同路** —— 这里是照 textures.js 的建点循环真跑一遍取 min-y,
   而 apexV() 走 shoulder/arch/topSeg 的闭式。两条路一致 ⇒ 三处几何不会各漂各的。 */
function apexVRef() {
  const T = SH.tile, ins = SH.propBoxInset, span = 1 - 2 * ins;
  const C = SH.cell;
  const baseY = C.mainBase, h = C.mainH, cx = C.mainCx, w = C.mainW;
  const apY = baseY - h, shY = apY + h * SH.shoulderU;
  const xL = cx - w * 0.5, xR = cx + w * 0.5, topW = SH.topW;
  const labX = cx - w * topW * 0.5, rabX = cx + w * topW * 0.5;
  const N = SH.seg, M = SH.topSeg;
  const pts = [[xL, baseY]];
  for (let i = 1; i <= N; i++) { const t = i / N; pts.push([labX - (labX - xL) * Math.pow(1 - t, 0.5), baseY + (shY - baseY) * Math.pow(t, 0.94)]); }
  for (let i = 1; i < M; i++) { const t = i / M; pts.push([labX + (rabX - labX) * t, shY - Math.sin(Math.PI * t) * h * SH.archU]); }
  for (let i = N; i >= 0; i--) { const t = i / N; pts.push([rabX + (xR - rabX) * Math.pow(1 - t, 0.5), baseY + (shY - baseY) * Math.pow(t, 0.94)]); }
  let ap = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[ap][1]) ap = i;
  return (pts[ap][1] / T - ins) / span;
}
const AV_REF = apexVRef();
check('B1 apexV() == 照 textures.js 峰形采样真跑一遍解出的「峰尖在方框里的位置」',
  near(AV, AV_REF, 1e-12), 'apexV=' + AV + ' / 复刻=' + AV_REF);
check('B1b apexV 落在 (0, 0.25) —— 峰尖在方框**上部**且不是顶边 (旧符号写反会偏大)',
  AV > 0 && AV < 0.25, 'apexV=' + AV);

/* 独立复算 PROP_VS 的 H (renderer.js:265-266) */
function mtnBhs(e) {
  if (e > SH.elevSnow) return SH.snowLo + (SH.snowHi - SH.snowLo) * Math.min(1, (e - SH.elevSnow) / SH.snowSpan);
  if (e > SH.elevMtn) return SH.mtnLo + (SH.mtnHi - SH.mtnLo) * Math.min(1, (e - SH.elevMtn) / SH.mtnSpan);
  return 0;
}
function HOfH(lv, e, hr) {
  let bhs = mtnBhs(e);
  if (bhs < SH.terrainBaseMin) bhs = SH.terrainBaseMin;
  bhs *= SH.terrainBase;
  return (3.3 + 1.2 * hr) * lv.hScale * SH.sizeScale + (3.3 + 1.2 * hr) * bhs;
}
const ELEVS = [0.0, 0.62, 0.70, 0.75, 0.84, 0.90, 1.0];   // 有效海拔 (不含"未到货"哨兵 -1)
const midOf = (lv) => (lv.hRand[0] + lv.hRand[1]) * 0.5;

let worst = 0, worstAt = '';
for (let lv = 0; lv < VS.levels.length; lv++) {
  for (const e of ELEVS) {
    const want = (1 - AV) * HOfH(VS.levels[lv], e, midOf(VS.levels[lv])) - PBU;
    const got = VS.tipU(lv, e);                  // 不传 hash ⇒ 走包络中点, 与 HOfH 的口径对齐
    const d = Math.abs(got - want);
    if (d > worst) { worst = d; worstAt = `档 ${lv} / 海拔 ${e}`; }
  }
}
check('B2 tipU == (1 - apexV) * H - propBottomU (4 档 × 7 个有效海拔, 逐值)', worst < 1e-9,
  '最大偏差 ' + worst + ' @ ' + worstAt);

/* 本轮 (二修) 相对「一修: 方框顶口径 H - propBottomU」新增的下移量 = apexV * H */
let w2 = 0;
for (let lv = 0; lv < VS.levels.length; lv++) {
  for (const e of ELEVS) {
    const H = HOfH(VS.levels[lv], e, midOf(VS.levels[lv]));
    const drop = (H - PBU) - VS.tipU(lv, e);
    w2 = Math.max(w2, Math.abs(drop - AV * H));
  }
}
check('B3 二修相对「方框顶口径 (H - propBottomU)」的新增下移 == apexV * H (逐值)',
  w2 < 1e-9, '最大偏差 ' + w2);

/* 相对**初版** (H + 0.35) 的总下移 = apexV*H + propBottomU + 0.35 = apexV*H + 1.30 */
let w3 = 0, dropBig = 0;
for (let lv = 0; lv < VS.levels.length; lv++) {
  for (const e of ELEVS) {
    const H = HOfH(VS.levels[lv], e, midOf(VS.levels[lv]));
    const drop = (H + 0.35) - VS.tipU(lv, e);
    w3 = Math.max(w3, Math.abs(drop - (AV * H + PBU + 0.35)));
  }
}
dropBig = (HOfH(VS.levels[0], 1.0, midOf(VS.levels[0])) + 0.35) - VS.tipU(0, 1.0);
check('B4 相对初版 (H + 0.35) 的总下移 == apexV*H + propBottomU + 0.35 (逐值)', w3 < 1e-9,
  '最大偏差 ' + w3);
check('B4b 大档最高海拔的总下移 >= 2.5 uR (≈64px) —— 用户报的「点悬在峰上半空」已消',
  dropBig >= 2.5, '实得 ' + dropBig.toFixed(3) + ' uR (≈' + (dropBig * 25.6).toFixed(0) + 'px @R=25.6)');

/* 峰尖排序: 同海拔下 大 > 中 > 小 > 从属 (与档一致 —— 签子不会挂错层) */
const tips = VS.levels.map((_, i) => VS.tipU(i, 0.80));
check('B5 同海拔下峰尖高度严格递减 (大 > 中 > 小 > 从属)',
  tips.every((v, i) => i === 0 || tips[i - 1] > v),
  tips.map((v) => v.toFixed(2)).join(' > '));

/* 海拔未到货 (elevAtTile 返 -1 / null) → 走该档 coreElev (镜像引擎 LIFT_CORE) */
check('B6 coreElev 逐档存在、单调不增、在 [0,1] (大 >= 中 >= 小)',
  VS.levels.every((l) => l.coreElev != null && l.coreElev >= 0 && l.coreElev <= 1) &&
  VS.levels[0].coreElev >= VS.levels[1].coreElev &&
  VS.levels[1].coreElev >= VS.levels[2].coreElev,
  VS.levels.map((l) => l.key + '=' + l.coreElev).join(' '));

let badFallback = '';
for (let lv = 0; lv < VS.levels.length; lv++) {
  const want = VS.tipU(lv, VS.levels[lv].coreElev);
  if (!near(VS.tipU(lv, -1), want) || !near(VS.tipU(lv, null), want)) badFallback += ` 档${lv}`;
}
check('B7 海拔未到货 (e=-1 或 null) ⇒ 用 coreElev 估计 (与 e=coreElev 逐值相同)',
  badFallback === '', '不符档:' + (badFallback || ' 无'));

/* 引擎把灵脉中心格海拔抬到 >= LIFT_CORE[level] ⇒ 真值恒 >= coreElev。H 对 e 单调不减,
   故同档内 (coreElev <= e <= elevSnow) 估计值必 <= 真值 ⇒ **只偏矮不高抬**。

   ⚠ 已知**既有**断点 (非本次改动引入, 记录不动): 海拔跨过 elevSnow=0.84 时 bhs 从
     「山地档上界 mtnHi=1.30」**向下跳**到「雪峰档下界 snowLo=0.95」(差 0.35)。
     该不连续在 renderer.js 的 GLSL 与引擎同式, 影响所有大世界山 (不只是灵脉);
     它使「e 落在 0.84~≈0.88 的雪峰带起始段」时估计值可能略高于真值
     (≈0.09 bhs ≈ 0.4 uR ≈ 9px, 且随即自愈)。要根治需重排两档包络, 超出本次范围。 */
const snowLo = SH.elevSnow;
let monoBad = '';
for (let lv = 0; lv < VS.levels.length; lv++) {
  const ce = VS.levels[lv].coreElev, base = VS.tipU(lv, -1);
  for (const e of [ce, ce + 0.02, ce + 0.05, (ce + snowLo) / 2, snowLo]) {
    if (e < ce || e > snowLo) continue;
    if (VS.tipU(lv, e) < base - 1e-9) monoBad += ` 档${lv}@e=${e}`;
  }
}
check('B8 同档内 (coreElev <= e <= ' + snowLo + ') 估计值 <= 真值 ⇒ **只偏矮不高抬** (不会签子悬空)',
  monoBad === '', '违例:' + (monoBad || ' 无'));
check('B8b 已知断点已记录: snowLo (' + SH.snowLo + ') < mtnHi (' + SH.mtnHi + ') ⇒ 0.84 处有向下跳变',
  SH.snowLo < SH.mtnHi,
  `跳变幅度 ${(SH.mtnHi - SH.snowLo).toFixed(2)} bhs (既有, 非本次引入)`);

/* 对照: 落 terrainBaseMin 的旧口径偏矮量 (十一版前的老病) */
const oldTip = (i) => HOfH(VS.levels[i], -1, midOf(VS.levels[i])) - PBU;   // -1 走 bhs=0 → max(·,terrainBaseMin)
const dBig = VS.tipU(0, -1) - oldTip(0);
check('B9 相对旧口径 (terrainBaseMin) 大档少偏矮 >= 2 uR (≈50px, 用户:"刚打开竖线特别短")',
  dBig >= 2, '改善 ' + dBig.toFixed(2) + ' uR (旧 ' + oldTip(0).toFixed(2) + ' → 新 ' + VS.tipU(0, -1).toFixed(2) + ')');

/* 档位越界 / 未知名 → 不抛异常, 且与 veinLabel 同口径兜「小」 */
let threw = null, fb = [];
try {
  fb = [VS.tipU(99, 0.8), VS.tipU(-1, 0.8), VS.tipU('大', 0.8), VS.tipU(null, 0.8)];
} catch (e) { threw = e.message; }
check('B10 档位越界/未知名/字符串档 → 不抛异常', threw === null, String(threw));
check('B11 越界档兜「小」 —— 与 veinLabel 同口径 (文案与签位必须同档)',
  threw === null && fb[0] === VS.tipU(2, 0.8) && fb[1] === VS.tipU(2, 0.8) && fb[3] === VS.tipU(2, 0.8) &&
  fb[2] === VS.tipU(0, 0.8),
  'tipU(99)=' + fb[0] + ' / tipU(2)=' + VS.tipU(2, 0.8) + ' / tipU("大")=' + fb[2]);

/* B12: 传 hash → hrand 用**该精灵的真值** fract(hash*5.17) (shader PROP_VS:228 同式) */
const fr01 = (x) => x - Math.floor(x);
const HASHES = [0, 0.1, 0.37, 0.5, 0.9, -1.3, 7.77, 3.333];
let wHash = 0, wHashAt = '';
for (let lv = 0; lv < VS.levels.length; lv++) {
  const L = VS.levels[lv];
  for (const e of [0.62, 0.70, 0.80, 0.84, 0.90, 1.0]) {
    for (const h of HASHES) {
      const hr = L.hRand[0] + (L.hRand[1] - L.hRand[0]) * fr01(h * 5.17);
      const want = (1 - AV) * HOfH(L, e, hr) - PBU;
      const d = Math.abs(VS.tipU(lv, e, h) - want);
      if (d > wHash) { wHash = d; wHashAt = `档${lv} e=${e} h=${h}`; }
    }
  }
}
check('B12 有 hash 时 tipU 走该精灵的**真值 hrand** fract(hash*5.17) (逐值精确)',
  wHash < 1e-9, '最大偏差 ' + wHash + ' @ ' + wHashAt);

/* B13: 拿不到 hash 时退回包络中点 —— 偏差必须**有界且非零** (说明这条精修真在起作用) */
let devMax = 0, devMaxAt = '';
for (let lv = 0; lv < VS.levels.length; lv++) {
  for (const e of [0.62, 0.70, 0.80, 0.84, 0.90, 1.0]) {
    for (const h of HASHES) {
      const d = Math.abs(VS.tipU(lv, e, h) - VS.tipU(lv, e));
      if (d > devMax) { devMax = d; devMaxAt = `档${lv} e=${e} h=${h}`; }
    }
  }
}
check('B13 hash 精修相对包络中点的偏差 > 0 且 <= 0.35 uR (≈9px, 区块到货即自愈)',
  devMax > 0.01 && devMax <= 0.35, '最大 ' + devMax.toFixed(4) + ' uR @ ' + devMaxAt);

/* B14: apexJx —— 水平抖动 (C-c2) */
const JU = SH.propJitterU;
check('B14a apexJx(null/undefined) === 0 (区块未到货 → 回落格心, 不猜方向)',
  VS.apexJx(null) === 0 && VS.apexJx(undefined) === 0);
let jxBad = '', jxMax = 0, jxMin = 0;
for (const h of HASHES) {
  const got = VS.apexJx(h);
  const want = (fr01(h * 3.77) - 0.5) * 2 * JU;      // renderer PROP_VS:267 同式
  if (!near(got, want, 1e-12)) jxBad += ` h=${h}`;
  if (got > jxMax) jxMax = got;
  if (got < jxMin) jxMin = got;
}
check('B14b apexJx == (fract(hash*3.77) - 0.5) * 2 * propJitterU (与 shader 逐值一致)',
  jxBad === '', '不符:' + (jxBad || ' 无'));
check('B14c |apexJx| <= propJitterU 且确实双向取到 (不是恒 0)',
  jxMax <= JU + 1e-12 && jxMin >= -JU - 1e-12 && jxMax > 0.1 && jxMin < -0.1,
  '范围 [' + jxMin.toFixed(3) + ', ' + jxMax.toFixed(3) + '] uR, propJitterU=' + JU);

/* B15: apexOf = { topU, jxU } 的打包 (大地图一次取两个落点分量) */
let aofBad = '';
for (const lv of [0, 1, 2, 3]) {
  for (const h of HASHES) {
    const o = VS.apexOf(lv, 0.8, h);
    if (!o || !near(o.topU, VS.tipU(lv, 0.8, h), 1e-12) || !near(o.jxU, VS.apexJx(h), 1e-12)) aofBad += ` 档${lv}/h${h}`;
  }
}
check('B15 apexOf(level, elev, hash) == { topU: tipU(...), jxU: apexJx(hash) } (逐值)',
  aofBad === '', '不符:' + (aofBad || ' 无'));

/* ============================================================
 * C. 灵脉名文案 = <地貌名>·<档> (D)
 * ============================================================ */
console.log('\n== 匾额契约 C: 灵脉名文案 (D) ==');
const DOT = '\u00B7';   // 全角间隔号 (用户指定的那个"中文的 ·")
check('C1 label 存在且是函数', typeof VS.label === 'function');
if (typeof VS.label === 'function') {
  const L0 = VS.label({ name: '金属矿脉' }, 0);
  const L2 = VS.label({ name: '白石岩峰' }, 2);
  console.log('  样例: ' + JSON.stringify(L0) + ' / ' + JSON.stringify(L2));

  check('C2 格式 == <地貌名>·<档>', L0 === '金属矿脉' + DOT + '大' && L2 === '白石岩峰' + DOT + '小',
    L0 + ' / ' + L2);
  check('C3 分隔符是全角间隔号 U+00B7 (不是 U+2027 / U+30FB / "-" / "(")',
    L0.indexOf(DOT) > 0 && L0.indexOf('\u2027') < 0 && L0.indexOf('\u30FB') < 0);
  check('C4 不缀「灵脉」二字 (地貌名池自带 脉/峰/谷 ⇒ 再缀必叠字)',
    L0.indexOf('灵脉') < 0 && VS.label({ name: '藤蔓深谷' }, 1).indexOf('灵脉') < 0);
  check('C5 无半角/全角括号', !/[()（）]/.test(VS.label({ name: '熔岩裂隙' }, 0)));
  check('C6 地貌名只在结果里出现**一次** (无叠字)',
    (VS.label({ name: '金属矿脉' }, 0).match(/金属矿脉/g) || []).length === 1);

  /* 档位口径: 越界/缺失 → 兜「小」(不兜「大」—— 兜大反而误导成最强档) */
  check('C7 档位缺失/越界 → 兜「小」',
    VS.label({ name: 'X' }, null) === 'X' + DOT + '小' &&
    VS.label({ name: 'X' }, 99) === 'X' + DOT + '小' &&
    VS.label({ name: 'X' }) === 'X' + DOT + '小',
    VS.label({ name: 'X' }, 99));
  check('C8 名缺失 → 兜「灵脉」二字 (仅此时才出现, 便于肉眼识别缺数据)',
    VS.label({}, 0) === '灵脉' + DOT + '大' && VS.label(null, 0) === '灵脉' + DOT + '大');
  /* 四档 key 与 level 序一致 */
  const keys = VS.levels.map((l) => l.key);
  check('C9 四档 key == 大/中/小/从属 且 label 用 level 序号取档',
    keys.join('') === '大中小从属' &&
    VS.levels.every((l, i) => VS.label({ name: 'N' }, i) === 'N' + DOT + l.key),
    keys.join('/'));
}

/* ============================================================
 * D. 源码守卫 —— 不许再出现"第二份公式"/硬编码/旧拼接
 * ============================================================ */
console.log('\n== 匾额契约 D: 源码守卫 (禁第二真源) ==');
/* 词法级注释剥离 (字符串感知) —— 否则注释里的公式/旧代码文本会误报 */
function stripComments(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) { if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const FILES = ['main.js', 'renderer.js', 'vein-skin.js', 'textures.js', 'bldg_ink.js'];
const SRC = {};
for (const f of FILES) SRC[f] = stripComments(fs.readFileSync(path.join(WEB, f), 'utf8'));

/* D1: main.js veinTopU 必须转调 VS.tipU (并**把 hash 传下去**), 不许内联 H 公式 */
const mBody = (() => {
  const m = SRC['main.js'].match(/function veinTopU\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  return m ? m[0] : '';
})();
check('D1 main.js veinTopU 存在且**转调 VS.tipU** (不内联公式)',
  !!mBody && /VS\.tipU/.test(mBody), mBody ? '未调 VS.tipU' : '函数体未匹配到');
check('D1b main.js veinTopU 把**精灵 hash** 作第三实参传下去 (峰高随 hash, 不是包络估计)',
  !!mBody && /VS\.tipU\([^)]*propHashAt\s*\(/.test(mBody), mBody ? '未传 propHashAt(...)' : '');
check('D2 main.js veinTopU 体内**不含**内联 H 公式 (3.3+1.2 / hScale / sizeScale)',
  !!mBody && !/3\.3\s*\+\s*1\.2/.test(mBody) && !/hScale/.test(mBody) && !/sizeScale/.test(mBody));

/* D2b: 横向抖动同理 —— main.js 必须转调 VS.apexJx */
const jBody = (() => {
  const m = SRC['main.js'].match(/function veinJxU\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  return m ? m[0] : '';
})();
check('D2b main.js 有 veinJxU 且**转调 VS.apexJx** (水平落点同样只此一份公式)',
  !!jBody && /VS\.apexJx/.test(jBody), jBody ? '未调 VS.apexJx' : '函数体未匹配到');
check('D2c main.js veinJxU 体内不含硬编码抖动常数 (3.77 / 1.8)',
  !!jBody && !/3\.77/.test(jBody) && !/\b1\.8\b/.test(jBody));

/* D3: 灵脉签真源不得再出现手写档位名数组 */
check('D3 三份前端文件均无 `VEIN_LEVEL = [` 手写档位数组 (真源在 VS.levels)',
  ['main.js', 'renderer.js', 'vein-skin.js'].every((f) => !/VEIN_LEVEL\s*=\s*\[/.test(SRC[f])));

/* D4: 不许再现 `+ '灵脉·'` 旧拼接 */
check('D4 无 `+ \'灵脉·\'` 旧拼接 (文案真源在 VS.label)',
  FILES.every((f) => !/['"]灵脉\u00B7['"]/.test(SRC[f]) && !/['"]灵脉·['"]/.test(SRC[f])));

/* D5: renderer.js 的 GLSL 不许硬编码海拔判档阈值 (必须走 E_MTN/S_MTN/E_SNOW/S_SNOW) */
check('D5 renderer.js GLSL 无硬编码判档阈值 ((iElev-0.70)/0.14 之类)',
  !/iElev\s*-\s*0\.70/.test(SRC['renderer.js']) && !/iElev\s*-\s*0\.84/.test(SRC['renderer.js']) &&
  !/ve\s*-\s*0\.70/.test(SRC['renderer.js']) && !/ve\s*-\s*0\.84/.test(SRC['renderer.js']));

/* D5b: 峰体几何常量必须**注入** GLSL (从 vein-skin.shape 读), 不许写死 */
check('D5b renderer.js 有 JIT_U / BOX_INSET, 且 GLSL 里 jx 幅度不再是写死的 1.8',
  /JIT_U/.test(SRC['renderer.js']) && /BOX_INSET/.test(SRC['renderer.js']) &&
  !/\*\s*1\.8\s*;/.test(SRC['renderer.js']));
check('D5c textures.js 峰形 读 SHAPE.shoulderU / SHAPE.archU (不再内联 0.10 / 0.11)',
  /S\.shoulderU/.test(SRC['textures.js']) && /S\.archU/.test(SRC['textures.js']));

/* D6: main.js bldgAnchor 必须走 BI.anchorOf 且"无建筑不缓存" */
const aBody = (() => {
  const m = SRC['main.js'].match(/function bldgAnchor\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/);
  return m ? m[0] : '';
})();
check('D6 main.js bldgAnchor 走 BI.anchorOf', !!aBody && /BI\.anchorOf/.test(aBody));
check('D6b main.js bldgAnchor 把 ANC_GEO 传下去 (A/B 档位切换不被绕过)',
  !!aBody && /ANC_GEO/.test(aBody));
/* "无建筑不缓存" 精确判据: `if (!an) return {...}` 这条语句**自身**不含 `_anc =`,
   且 `st._anc = an` 出现在它**之后** (逐行判定, 避免跨行正则误伤)。 */
const aLines = aBody.split('\n');
const guardIdx = aLines.findIndex((l) => /if\s*\(\s*!an\s*\)/.test(l));
const storeIdx = aLines.findIndex((l) => /_anc\s*=\s*an/.test(l));
const guardLine = guardIdx >= 0 ? aLines[guardIdx] : '';
check('D7 main.js bldgAnchor 无建筑时**不落缓存**',
  guardIdx >= 0 && storeIdx > guardIdx && !/_anc/.test(guardLine),
  guardIdx < 0 ? '未找到 `if (!an)`' : (storeIdx <= guardIdx ? '`_anc = an` 未在守卫之后' : '守卫行内出现 _anc'));
console.log('  守卫行: ' + guardLine.trim());

/* D8: drawNameBanner 引线终点 == 落点 (同 x, 线从 bottomY 连到 anchorY) */
const dBody = (() => {
  const m = SRC['main.js'].match(/function drawNameBanner\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  return m ? m[0] : '';
})();
check('D8 drawNameBanner 引线: moveTo(x,bottomY) → lineTo(x,anchorY), 圆点在 (x,anchorY)',
  !!dBody && /moveTo\(\s*x\s*,\s*bottomY\s*\)/.test(dBody) &&
  /lineTo\(\s*x\s*,\s*anchorY\s*\)/.test(dBody) &&
  /arc\(\s*x\s*,\s*anchorY\s*,/.test(dBody));
check('D9 drawNameBanner 签底 = anchorY - lead - gap ⇒ 点不动、只抬签',
  !!dBody && /bottomY\s*=\s*anchorY\s*-\s*lead\s*-\s*\(\s*opt\.gap\s*\|\|\s*0\s*\)/.test(dBody));

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
