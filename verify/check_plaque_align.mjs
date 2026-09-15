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
 *       四修: **平手参照物换掉** (A6 红灯)。三修的参照物「截尾质心」自身会被离群均值
 *             污染: 它内部先按"含离群点的均值"排序取截尾子集, 于是远处多加一块农田/
 *             码头就换了保留集 ⇒ 质心移动 ⇒ 决序翻转 (实测 (1,0) ↔ (1,2), 且换方向/
 *             个数还会再变)。
 *             试过并**否决**的方案: 截断核分 Σ min(d,2R) (虽免疫, 但它是"局部紧致度"
 *             不是"中心性", 实测三参照系下 1.652/3.969, 比一修 col 还差);
 *             坐标中位数定序 (最差 3.126R); 多尺度计数阶梯 (1.490/3.329)。
 *             现行: 参照物改取**最密束的 2R 邻域并集质心** —— 与第一键同源, 免疫是
 *             恒等式 (远点不进任何 2R 邻域 ⇒ 计数表不变 ⇒ 最密束不变 ⇒ 并集不变 ⇒
 *             质心不变 ⇒ 决序不变), 且它是"村子真正扎堆的那一片"的中心, 不会被
 *             稀疏外圈的农地/水磨拽偏。顺带删掉已成死码的 trimmedCentroid。
 *             ⚠ 同时**改掉了 A13 的判据**: 旧 A13 只用「裸均值定序截尾质心」当参照系,
 *               而那恰好就是三修口径的目标函数 ⇒ 自证 (三修在它上面必然拿满分)。
 *               现改用三个**独立参照系** (trim/geo/bbf) 联合打分。
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
 *   ★★ 五修 (2026-09-16 · 口径订正: 落点 = **实体自己的中心点**, 覆盖 A 段默认与 C-c/C-c2)
 *       用户原话: 「要和当前的城市的中心点, 还有灵山的中心点位置一样, 而不是什么
 *       所谓的平均值或者什么参照物」。
 *       ⇒ 落点不再"估计"(统计量), 而是**读实体坐标**:
 *           · 聚落 = 中心格 (st.x, st.y)      · 灵脉 = 格心 (v.x, v.y)
 *       依据 (E1 引擎交叉源, 离线跑 mapgen 实测 seed42/777 共 90 座, dCore 恒 = 0):
 *       引擎把**核心建筑** (祠堂/村口/宗祠/集市/官衙/祖师殿…) 恒定放在中心格
 *       (`growTownFootprint` 的 `cell.d === 0` 那一支) ⇒ **中心格上永远有一座真建筑**。
 *       回头看原始病灶: "点悬在村里空地上"的真因是初版**合成点** (中心格 x + 建筑格 y 的
 *       p25), 不是"中心格不够中间" —— 前四修都在解一个本来不是问题的问题, 而且每一修都在
 *       给上一修的副作用打补丁 (副产物: 平手决序/参照物/A6 红灯)。
 *       免疫性也从"近似"升级为**恒等**: 锚点不读建筑清单 ⇒ 远处农田/码头无论怎么加都不影响。
 *       ⚠ 前四修 (合成点→列最近→中位格→最密格+平手参照物) 与 C-c/C-c2 的峰尖口径
 *         全部**降级为历史 A/B 档位** (`?ancgeo=densest|box|col|med|sum` / `?veinpt=apex`)。
 *         故 A 段 / B 段的断言含义随之改变: 它们现在证明的是"**历史档位仍可复现**",
 *         而**不再是**默认口径的属性 (A13 那套"对三个参照系更居中"的评比亦然)。
 *
 *   D  **灵脉名文案** = `<地貌名>·<档>`
 *       旧: `v.name + '灵脉·' + 档` ⇒ 地貌名池自带「脉/峰/谷」⇒ 叠字 (金属矿脉灵脉·大);
 *           且曾用半角括号。新: 单一真源 VS.label, 全角间隔号, 不缀「灵脉」。
 *
 * 断言:
 *   A. 聚落落点 (C-a) —— BldgInk.anchorOf 语义
 *      A1 默认 = 最密格 (与独立复算一致) / A2 real=true 带 q,r / A3 落点是输入里的一座
 *      A3b 缺省实参与 '' 同解 / A4 平手走「离参照质心近 → 更北 → 更西」全序
 *      A5 与输入序无关 / A6 离群地物不改变落点 / A6b 离群方向与个数也不影响
 *      / A7 y0 = 建筑格 y 的 p25
 *      A8 无建筑 → null / A9 'box' 退回包围盒中心 / A10 布尔 true 视同 'box'
 *      A11 'col' 复现一修行为 / A12 'med' 复现二修中位格 / A12b 'sum' 复现 medoid
 *      A13 ~ A13e 实测样本 (anc_fixture.json, 两套种子) 上默认口径对**三个独立参照系**
 *                (trim 截尾质心 / geo 几何中位数 / bbf 包围盒中心) 的平均与最差偏差:
 *                A13/A13b 对 col 的比例上界 / A13c **逐种子**不劣于 col /
 *                A13c2 与 med 的差距有界 (承认代价) / A13d 与 medoid 差距有界 / A13e 绝对上界
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
 *   E. 五修口径 (中心点) —— 直接拿 main.js 的**真实源码**跑行为, 不只是正则:
 *      E1 引擎交叉源: 核心建筑恒落在中心格 (seed42/777 逐座, terrain==='core' 且 d===0)
 *      E2 中心格恒在 buildings 里 ⇒ 落点恒落在真建筑上 (而非空地)
 *      E3 缺省档落点 == 实体坐标 / E4 加离群建筑后落点**逐位不变** (恒等免疫)
 *      E5 中心格无建筑 (灵脉格/深海) → 落点不动、real=false / E6 清单未到货不落缓存
 *      E7 历史档位 (?ancgeo=densest) 仍可复现求解器结果 / E8 缺省档解析
 *      E9 灵脉签: 默认落点取格心 (w2s(vb.x,vb.y)), 抬签由 gap 承担 (签位不变)
 *
 * 跨源断言 (coreElev == 引擎 LIFT_CORE) 在 check_vein_skin.mjs。
 * ⚠ 本契约原本**不加载引擎**; 五修起为给"落点 = 中心点"口径一条**引擎侧证据** (E1/E2 ——
 *   否则"中心格必有核心建筑"只是个口头前提), 这里也加载 noise/mapgen-config/mapgen 三件套
 *   (同 check_settle_spacing 的姿势: 先 global.window = globalThis)。
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
/* 默认口径「最密格」(C-a 四修): 2R 邻域邻居最多 → 离**最密束的 2R 邻域并集质心**近
   → 更北 → 更西。
   ⚠ 平手参照物**不能**用「离截尾质心近」: 截尾质心内部先按含离群点的均值排序取子集 ⇒
     远处多加一块农田就换了保留集, 质心随之移动 ⇒ 决序翻转 (A6 红灯根因)。
     现行参照物与第一键同源 (最密束 + 同一个 2R), 对远点是**恒等免疫**:
     远点不进任何 2R 邻域 ⇒ 计数表不变 ⇒ 最密束不变 ⇒ 并集不变 ⇒ 质心不变。 */
function densestRef(list, hexR) {
  const a = wsOf(list), rad = hexR * 2, r2 = rad * rad;
  const d2 = (p, q) => (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
  const cnt = a.map((w) => a.filter((o) => d2(o, w) <= r2 + 1e-9).length);
  const maxC = Math.max.apply(null, cnt);
  const inU = a.map(() => false);
  a.forEach((w, i) => {
    if (cnt[i] !== maxC) return;
    a.forEach((o, j) => { if (d2(o, w) <= r2 + 1e-9) inU[j] = true; });
  });
  const U = a.filter((_, j) => inU[j]);
  const ref = { x: U.reduce((s, w) => s + w.x, 0) / U.length, y: U.reduce((s, w) => s + w.y, 0) / U.length };
  /* ⚠ 决序必须与实现**同容差语义** (平方距离, 1e-9): 建筑格常有两座到参照质心的
     距离在浮点上"恰好相等"(实测 47.99999999999987 vs 48.000000000000064), 纯 sort
     会被尾数噪声决定 ⇒ 与实现不一致。这里照实现的滚动比较写, 但计数/并集/质心
     仍走**另一条代码路** (filter 而非下标循环), 保证不是抄实现。 */
  let bn = -1, bk = Infinity, by = Infinity, bx = Infinity, bi = 0;
  for (let i = 0; i < a.length; i++) {
    const kx = a[i].x - ref.x, ky = a[i].y - ref.y, k = kx * kx + ky * ky;
    if (cnt[i] > bn ||
        (cnt[i] === bn && (k < bk - 1e-9 ||
         (Math.abs(k - bk) <= 1e-9 && (a[i].y < by - 1e-9 ||
          (Math.abs(a[i].y - by) <= 1e-9 && a[i].x < bx - 1e-9)))))) {
      bn = cnt[i]; bi = i; bk = k; by = a[i].y; bx = a[i].x;
    }
  }
  return a[bi];
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

check('A1 默认落点 = **最密格** (2R 邻域邻居最多, 平手取离最密束并集质心近者, 与独立复算一致)',
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

/* 平手阶梯: CLUSTER 里 (0,0)/(1,0)/(2,0)/(0,2)/(1,2)/(2,2) 都是 3 个邻居 (并列),
   其中 (1,0)/(1,2) 又同样贴近参照质心 (距离并列) ⇒ 必须靠「更北 → 更西」的
   **全序** 落到 (1,0)。这条同时钉住「与输入序无关」(见 A5)。 */
const anRev = BI.anchorOf(CLUSTER.slice().reverse(), HEXW, HEXR, CENTERX_ECC, '');
check('A4 邻居数并列时按「离参照质心近 → 更北 → 更西」全序决出 (CLUSTER → (1,0))',
  an.q === 1 && an.r === 0, `实得 (${an.q},${an.r}) / 期望 (1,0)`);
check('A5 结论与建筑数组顺序**无关** (全序比较, 输入序反过来结果不变)',
  anRev.q === an.q && anRev.r === an.r,
  `正序 (${an.q},${an.r}) / 反序 (${anRev.q},${anRev.r})`);

/* 离群地物不改变落点 —— 两层保证:
     ① 计数 (2R 邻域邻居数) 天然不数远点;
     ② 平手参照物由**计数结构**导出 (最密束的 2R 邻域并集质心) ⇒ 远点达不到、也进不了并集。
   旧口径「离截尾质心近」两层都不满足 (还会换保留集) ⇒ 本组就是那次的回归。 */
const anWithFar = BI.anchorOf(BS, HEXW, HEXR, CENTERX_ECC, '');
check('A6 离群地物 (远方的农田/码头) **不**改变落点 (均值/包围盒/medoid 都会被拉走)',
  anWithFar.q === an.q && anWithFar.r === an.r,
  `无离群 (${an.q},${an.r}) / 有离群 (${anWithFar.q},${anWithFar.r})`);
/* A6b: 换一个方向/距离的离群点仍不动 —— 钉住「贡献恒 = 2R」这条恒等式 (不是巧合)。
   旧口径下 (9,9) 与 (-14,7) 会给出两个不同的答案。 */
const FAR2 = { q: -14, r: 7 };
const anFar2 = BI.anchorOf(CLUSTER.concat([FAR2]), HEXW, HEXR, CENTERX_ECC, '');
const anFarBoth = BI.anchorOf(CLUSTER.concat([FAR, FAR2]), HEXW, HEXR, CENTERX_ECC, '');
check('A6b 离群点的**方向/个数**也不影响 (远点进不了任何 2R 邻域 ⇒ 计数与并集都不动)',
  anFar2.q === an.q && anFar2.r === an.r && anFarBoth.q === an.q && anFarBoth.r === an.r,
  `(-14,7) → (${anFar2.q},${anFar2.r}) / 两个离群 → (${anFarBoth.q},${anFarBoth.r}) / 期望 (${an.q},${an.r})`);

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
 *
 *   ⚠⚠ 参照系选择是这一节的**核心教训** (C-a 四修踩到的坑):
 *     三修时代本节只用**一个**参照系 —— 「裸均值定序的截尾质心」; 而三修口径的定义
 *     恰恰就是"离它最近的 S 成员" ⇒ **自证**: 它当然拿满分 (A13c 的"最差 == 下界"
 *     就是这句话的同义反复)。换成三个**任何口径都没优化过**的参照系重打分, 三修
 *     并不占优: 三个参照系上的**最差偏差全面落后**于四修 (2.318→2.089 / 4.265→3.269)。
 *     ⇒ 本节的判据一律建立在**独立参照系**上, 且不再要求"== 理论最优"(那是自证)。
 *
 *   三个参照系:
 *     trim = 裸均值定序截尾质心 (丢最远 25%)  —— 历史口径, 保留作连续性对照
 *     geo  = 几何中位数 (Weiszfeld 迭代)      —— 标准空间中位数, 无参数
 *     bbf  = 建筑世界包围盒中心               —— 最朴素的几何中心
 *   期望: 默认口径在三个参照系上 **显著优于一修 col**、**不劣于二修 med 的最差**、
 *         且与"纯中心性上界" medoid 的差距有界 (medoid 会被远方农田拉走, 只能当上界)。
 * ============================================================ */
/* 几何中位数: Weiszfeld 迭代 (权重 1/d), 极简实现 —— 只当参照系, 不参与任何口径 */
function geoMedianOf(a) {
  let c = meanOf(a);
  for (let t = 0; t < 300; t++) {
    let sx = 0, sy = 0, sw = 0;
    for (const p of a) {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < 1e-12) continue;
      const w = 1 / d; sx += p.x * w; sy += p.y * w; sw += w;
    }
    if (sw < 1e-30) break;
    const n2 = { x: sx / sw, y: sy / sw };
    if (Math.hypot(n2.x - c.x, n2.y - c.y) < 1e-9) { c = n2; break; }
    c = n2;
  }
  return c;
}
const FIXTURE = path.join(__dirname, 'anc_fixture.json');
if (!fs.existsSync(FIXTURE)) {
  check('A13 实测样本 anc_fixture.json 存在 (=?plaqprobe=1 自回传的快照)', false, FIXTURE);
} else {
  const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const RULE = { '默认(最密格)': '', '一修 col': 'col', '二修 中位格': 'med', 'medoid': 'sum' };
  const REFS = ['trim', 'geo', 'bbf'];
  const acc = {};                       // acc[rule][ref] = [偏差...]
  const perSeed = [];                   // 逐种子的平均和/最差和 (防 pooled 掩盖)
  for (const k in RULE) { acc[k] = {}; for (const r of REFS) acc[k][r] = []; }
  let detail = '';
  for (const S of fx.seeds) {
    const per = {}; for (const k in RULE) { per[k] = {}; for (const r of REFS) per[k][r] = []; }
    for (const st of S.settles) {
      const cells = st.bldgs.map((b) => ({ q: b[0], r: b[1] }));
      const ws = cells.map((b) => ({ q: b.q, r: b.r, x: S.hexW * (b.q + b.r / 2), y: 1.5 * S.hexR * b.r }));
      const xs = ws.map((w) => w.x), ys = ws.map((w) => w.y);
      const refs = {
        trim: trimmedCentroidOf(ws, 0.25),
        geo: geoMedianOf(ws),
        bbf: { x: (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2,
               y: (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 }
      };
      for (const k in RULE) {
        const a = BI.anchorOf(cells, S.hexW, S.hexR, st.sx, RULE[k]);
        for (const r of REFS) per[k][r].push(Math.hypot(a.x - refs[r].x, a.y - refs[r].y) / S.hexR);
      }
    }
    const avg = (z) => z.reduce((p, q) => p + q, 0) / z.length;
    const wst = (z) => Math.max.apply(null, z);
    let line = `\n    seed ${S.seed} (${S.settles.length} 座):`;
    for (const k in RULE) {
      const tt = REFS.map((r) => avg(per[k][r]).toFixed(3) + '/' + wst(per[k][r]).toFixed(3)).join('  ');
      line += `\n      ${k.padEnd(12)} ${tt}     和 ${avg(REFS.map((r) => avg(per[k][r]))).toFixed(3)}`;
      for (const r of REFS) { acc[k][r].push.apply(acc[k][r], per[k][r]); }
    }
    /* 逐种子留存 (⚠ 只用 pooled 最差会**掩盖**单套种子上的翻车: 默认口径在 seed42 上
       的最差 (2.291R) 其实比 med (1.756R) 差, pooled 却被 seed777 的 med 3.126R 拉过去了)。 */
    perSeed.push({ seed: S.seed, sumA: {}, sumW: {} });
    const ps = perSeed[perSeed.length - 1];
    for (const k in RULE) {
      ps.sumA[k] = REFS.reduce((s, r) => s + avg(per[k][r]), 0);
      ps.sumW[k] = REFS.reduce((s, r) => s + wst(per[k][r]), 0);
    }
    detail += line;
  }
  const A = (k, r) => acc[k][r].reduce((p, q) => p + q, 0) / acc[k][r].length;
  const W = (k, r) => Math.max.apply(null, acc[k][r]);
  const sumA = (k) => REFS.reduce((s, r) => s + A(k, r), 0);
  const sumW = (k) => REFS.reduce((s, r) => s + W(k, r), 0);
  console.log('  实测四口径偏差 (R 倍数, 越小越居中; 三列依次 = trim/geo/bbf 参照系):' + detail);
  console.log('    逐种子 平均和/最差和:');
  for (const ps of perSeed) {
    console.log(`      seed ${ps.seed}: 默认 ${ps.sumA['默认(最密格)'].toFixed(3)}/${ps.sumW['默认(最密格)'].toFixed(3)}` +
      ` | col ${ps.sumA['一修 col'].toFixed(3)}/${ps.sumW['一修 col'].toFixed(3)}` +
      ` | med ${ps.sumA['二修 中位格'].toFixed(3)}/${ps.sumW['二修 中位格'].toFixed(3)}` +
      ` | sum ${ps.sumA['medoid'].toFixed(3)}/${ps.sumW['medoid'].toFixed(3)}`);
  }
  console.log(`    汇总 平均和: 默认 ${sumA('默认(最密格)').toFixed(3)} | col ${sumA('一修 col').toFixed(3)}` +
    ` | med ${sumA('二修 中位格').toFixed(3)} | sum ${sumA('medoid').toFixed(3)}`);
  console.log(`    汇总 最差和: 默认 ${sumW('默认(最密格)').toFixed(3)} | col ${sumW('一修 col').toFixed(3)}` +
    ` | med ${sumW('二修 中位格').toFixed(3)} | sum ${sumW('medoid').toFixed(3)}`);

  check('A13 默认口径在**三个独立参照系**上的平均偏差和 <= 一修 col 的 85% (修掉了被边缘孤屋拉走的病灶)',
    sumA('默认(最密格)') <= sumA('一修 col') * 0.85 + 1e-9,
    `${sumA('默认(最密格)').toFixed(3)} vs ${sumA('一修 col').toFixed(3)} (上限 ${(sumA('一修 col') * 0.85).toFixed(3)})`);
  check('A13b 默认口径的最差偏差和 <= 一修 col 的 75%',
    sumW('默认(最密格)') <= sumW('一修 col') * 0.75 + 1e-9,
    `${sumW('默认(最密格)').toFixed(3)} vs ${sumW('一修 col').toFixed(3)} (上限 ${(sumW('一修 col') * 0.75).toFixed(3)})`);
  /* A13c 走**逐种子**判定 —— pooled 的最差会让"每套种子上到底谁赢"这件事消失。
     ⚠ 这里刻意**分开断**两个量, 因为它们结论不同 (实测):
        · 最差和: 每套种子默认都明显优于 col (7.649 vs 9.284 / 8.077 vs 12.637) ⇒ 强断言;
        · 平均和: seed42 上只与 col 打平 (3.547 vs 3.464, 默认略差 0.083 = 每座每参照系
          0.002R ≈ 0.06px), seed777 上大幅更优 (3.371 vs 5.469) ⇒ 只断"不差于 col 的 110%"。
     不要把这两条合并成一条"平均和 <= col", 那在 seed42 上是假的。 */
  let worstOk = true, worstWhy = [], avgOk = true, avgWhy = [];
  for (const ps of perSeed) {
    if (!(ps.sumW['默认(最密格)'] <= ps.sumW['一修 col'] + 1e-9)) {
      worstOk = false; worstWhy.push(`seed${ps.seed} 默认 ${ps.sumW['默认(最密格)'].toFixed(3)} > col ${ps.sumW['一修 col'].toFixed(3)}`);
    }
    if (!(ps.sumA['默认(最密格)'] <= ps.sumA['一修 col'] * 1.10 + 1e-9)) {
      avgOk = false; avgWhy.push(`seed${ps.seed} 默认 ${ps.sumA['默认(最密格)'].toFixed(3)} > col ${ps.sumA['一修 col'].toFixed(3)} x1.10`);
    }
  }
  check('A13c 默认口径在**每一套种子**上的**最差偏差和**均不劣于一修 col',
    worstOk, worstWhy.join(' / ') || '两套种子最差和均不劣于 col');
  check('A13c1 默认口径在**每一套种子**上的**平均偏差和**不差于一修 col 的 110% (seed42 上仅打平, 见注释)',
    avgOk, avgWhy.join(' / ') || '两套种子平均和均在 col 的 110% 内');
  /* A13c2: 与二修 med 的差距**有界**并**明写在案** —— med 在 seed42 上确实更居中
     (平均和 2.554 vs 默认 3.547), 这是四修主动付的价 (换精确离群免疫, 见 §33);
     med 在另两列参照系上的最差反而更差 (geo 3.464 / bbf 4.330 vs 默认 2.692 / 3.269)。
     这里只把"代价有界"钉死, 不假装默认处处更优。阈值 0.30 = 实测 pooled 差 0.169 的 ~1.8 倍。 */
  const medGap = sumA('默认(最密格)') - sumA('二修 中位格');
  check('A13c2 默认口径与二修 med 的**平均偏差和**之差有界 (<= 0.30R; 承认 med 在部分种子更居中, 但它不免疫)',
    medGap <= 0.30 + 1e-9, `默认 ${sumA('默认(最密格)').toFixed(3)} - med ${sumA('二修 中位格').toFixed(3)} = +${medGap.toFixed(3)}R`);
  /* 阈值 0.60 / 1.35 由**本文件所依赖的那份 fixture** 实测标定 (平均差最大 0.506 出现在 bbf,
     最差差最大 1.120 出现在 geo) ⇒ 各留 ~20% 余量。fixture 是入库的静态样本, 不会自己漂;
     换 fixture / 换种子重新采集时必须重标并在此注明新值。 */
  let gapOk = true, gapWhy = [];
  for (const r of REFS) {
    const gm = A('默认(最密格)', r) - A('medoid', r), gw = W('默认(最密格)', r) - W('medoid', r);
    if (!(gm <= 0.60 + 1e-9)) { gapOk = false; gapWhy.push(`平均 ${r} +${gm.toFixed(3)}`); }
    if (!(gw <= 1.35 + 1e-9)) { gapOk = false; gapWhy.push(`最差 ${r} +${gw.toFixed(3)}`); }
  }
  check('A13d 默认与「纯中心性上界」medoid 的差距**有界** (medoid 会被远方农田拉走, 只作上界)',
    gapOk, gapWhy.join(' / ') || '差距均在界内');
  check('A13e 绝对上界: 默认锚点到**几何中位数**的平均偏差 <= 1.00R 且最差 <= 3.00R',
    A('默认(最密格)', 'geo') <= 1.00 + 1e-9 && W('默认(最密格)', 'geo') <= 3.00 + 1e-9,
    `${A('默认(最密格)', 'geo').toFixed(3)}R / ${W('默认(最密格)', 'geo').toFixed(3)}R`);
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

/* D6: main.js bldgAnchor —— 五修口径的**结构**守卫 (行为断言在 E 段) */
const aBody = (() => {
  const m = SRC['main.js'].match(/function bldgAnchor\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/);
  return m ? m[0] : '';
})();
const aLines = aBody.split('\n');
check('D6 main.js bldgAnchor 默认落点 = 聚落中心点 (x: st.x, y: st.y)',
  !!aBody && /x:\s*st\.x\s*,\s*y:\s*st\.y/.test(aBody));
/* 中心点分支**不许经过求解器** —— BI.anchorOf 只允许出现在 ANC_GEO 历史档位分支里。
   判据 (逐行, 避免跨行正则误伤): BI.anchorOf 那一行必须在 `ANC_GEO !== 'center'`
   那一行**之后**。 */
const gIdx = aLines.findIndex((l) => /if\s*\(\s*ANC_GEO\s*!==\s*'center'\s*\)/.test(l));
const cIdx = aLines.findIndex((l) => /BI\.anchorOf/.test(l));
check('D6b 中心点分支不调用求解器 (BI.anchorOf 只在 ANC_GEO 历史档位分支内)',
  gIdx >= 0 && cIdx > gIdx,
  gIdx < 0 ? "未找到 `if (ANC_GEO !== 'center')`" : 'BI.anchorOf 出现在守卫之前/缺失');
check('D6c 默认档位解析 = center (缺省 ?ancgeo= 时)',
  /if\s*\(\s*!q\.has\('ancgeo'\)\s*\)\s*return\s*'center'/.test(SRC['main.js']));
/* "清单未到货不落缓存" 精确判据 (五修: 位置恒对, 只有 real 可能错 ⇒ 仍要等清单到货)。
   逐行判定: 缓存写入那一行**自带** `bl && bl.length` 守卫。 */
const storeL = aLines.findIndex((l) => /st\._anc\s*=\s*rec/.test(l));
const guardLine = storeL >= 0 ? aLines[storeL] : '';
check('D7 建筑清单未到货时**不落缓存** (否则 real 会永久停在 false)',
  storeL >= 0 && /if\s*\(\s*bl\s*&&\s*bl\.length\s*\)/.test(guardLine),
  storeL < 0 ? '未找到 `st._anc = rec`' : '缓存写入未被 bl.length 守卫');
console.log('  缓存行: ' + guardLine.trim());

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

/* ============================================================
 * E. 五修口径: 落点 = 实体自己的**中心点** (2026-09-16)
 * ------------------------------------------------------------
 * 用户原话: 「要和当前的城市的中心点, 还有灵山的中心点位置一样, 而不是什么所谓的
 *   平均值或者什么参照物」。⇒ 落点不"估计", 直接读实体坐标。
 * E1/E2 是**引擎侧证据** (否则"中心格必有核心建筑"只是口头前提);
 * E3~E7 直接跑 main.js 的**真实源码** (抽 `var ANC_GEO = …` + `function bldgAnchor`,
 *   注入 geo / BI / location 三个外部依赖) —— 与 check_faction.mjs 同姿势, 测上屏那份。
 * ============================================================ */
console.log('\n== 匾额契约 E: 落点 = 实体中心点 (五修) ==');

const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
let MG = null;
try {
  for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
    (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
  }
  MG = global.MapGen;
} catch (e) { MG = null; }

if (!MG || !MG.settlementsFor || !MG.growTownFootprint) {
  check('E1 引擎可加载 (noise/mapgen-config/mapgen 三件套)', false,
    MG ? '缺 settlementsFor / growTownFootprint' : '加载异常');
} else {
  let tot = 0, nCore = 0, noCore = 0, offCell = 0, inList = 0;
  for (const seed of ['42', '777']) {
    MG.init(seed);
    for (let i = -10; i <= 10; i++) {
      for (let j = -10; j <= 10; j++) {
        for (const st of MG.settlementsFor(i, j)) {
          if (st.type === 'poi') continue;
          tot++;
          const bl = MG.growTownFootprint(st.id, st.type, st.q, st.r).buildings;
          const core = bl.filter((b) => b.terrain === 'core')[0];
          if (!core) { noCore++; continue; }
          nCore++;
          if (core.q === st.q && core.r === st.r) offCell += 0; else offCell++;
          if (bl.some((b) => b.q === st.q && b.r === st.r)) inList++;
        }
      }
    }
  }
  check('E1 引擎的**核心建筑**恒落在聚落中心格 (seed42/777 共 ' + tot + ' 座, d===0)',
    tot > 60 && nCore === tot && offCell === 0 && noCore === 0,
    'core 存在 ' + nCore + ' / 不在中心格 ' + offCell + ' / 无 core ' + noCore);
  check('E2 中心格恒在 buildings 清单里 ⇒ 落点恒落在**真建筑**上 (不是空地)',
    inList === nCore, inList + ' != ' + nCore);
}

/* ---- E3~E7: 跑 main.js 真实源码 ---- */
const ancSrc = (() => {
  const m1 = SRC['main.js'].match(/var ANC_GEO = \(function \(\) \{[\s\S]*?\}\)\(\);/);
  const m2 = SRC['main.js'].match(/function bldgAnchor\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/);
  return (m1 && m2) ? (m1[0] + '\n' + m2[0] + '\nreturn bldgAnchor;') : '';
})();
const anchorFn = (search) => new Function('geo', 'BI', 'location', ancSrc)(
  { hexW: HEXW, hexR: HEXR },
  { anchorOf: (b, w, r, cx, md) => BI.anchorOf(b, w, r, cx, md) },
  { search: search });
const mkSt = (q, r, bldgs) => ({ id: 'x', q: q, r: r, x: wx(q, r), y: wy(r), buildings: bldgs });

if (!ancSrc) {
  check('E3 能从 main.js 抽出 ANC_GEO + bldgAnchor 源码', false);
} else {
  const A = anchorFn('');
  const s1 = mkSt(0, 0, [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 0, r: 2 }]);
  const a1 = A(s1);
  check('E3 缺省档: 落点 == 实体中心坐标 (不再被建筑清单左右)',
    near(a1.x, wx(0, 0)) && near(a1.y, wy(0)) && a1.real === true,
    'x=' + a1.x + ' y=' + a1.y + ' real=' + a1.real);
  /* 恒等免疫 (不是旧 A6 的"近似免疫"): 锚点根本不读清单 ⇒ 加多远都不变 */
  const s2 = mkSt(0, 0, [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 0, r: 2 }, { q: 9, r: 9 }]);
  const a2 = A(s2);
  check('E4 加一块远处农田后落点**逐位不变** (恒等免疫)',
    a2.x === a1.x && a2.y === a1.y && a2.real === a1.real);
  /* 中心格是灵脉格/深海 ⇒ 引擎不落核心建筑: 点仍扎中心点, 只是 real=false */
  const s3 = mkSt(0, 0, [{ q: 1, r: 0 }, { q: 2, r: 0 }, { q: 0, r: 2 }]);
  const a3 = A(s3);
  check('E5 中心格无建筑 → 落点不动、real=false (签子少抬一档)',
    near(a3.x, wx(0, 0)) && near(a3.y, wy(0)) && a3.real === false);
  check('E6 建筑清单未到货 → **不落缓存** (到货后 real 能翻真)',
    (() => { const z = mkSt(0, 0, []); A(z); return z._anc === undefined; })() &&
    (() => { const z = mkSt(0, 0, [{ q: 0, r: 0 }]); A(z); return !!z._anc && z._anc.real === true; })());
  /* 历史档位没被删掉: densest 仍复现求解器 (最密格) */
  const AL = anchorFn('?ancgeo=densest');
  const cl = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 2, r: 0 }, { q: 0, r: 2 }, { q: 1, r: 2 }, { q: 2, r: 2 }];
  const sL = mkSt(0, 0, cl);
  const aL = AL(sL), aRef = BI.anchorOf(cl, HEXW, HEXR, sL.x, '');
  check('E7 ?ancgeo=densest 仍复现历史求解器 (最密格) 结果',
    !!aL && !!aRef && aL.q === aRef.q && aL.r === aRef.r,
    (aL && aRef) ? ('densest ' + aL.q + ',' + aL.r + ' vs ref ' + aRef.q + ',' + aRef.r) : 'null');
  const sC = mkSt(0, 0, cl);
  const aC = anchorFn('?ancgeo=col')(sC), aCol = BI.anchorOf(cl, HEXW, HEXR, sC.x, 'col');
  check('E7b ?ancgeo=col 仍复现一修口径 (A/B 对拍没被绕过)',
    !!aC && !!aCol && aC.q === aCol.q && aC.r === aCol.r);
}
/* ---- E8/E9: 灵脉签 (源码守卫 —— 绘制闭包不便抽出, 故只钉结构) ---- */
check('E8 灵脉签默认档 = center (?veinpt=apex 才回到峰尖口径)',
  /get\('veinpt'\)\s*===\s*'apex'\s*\?\s*'apex'\s*:\s*'center'/.test(SRC['main.js']));
check('E9 灵脉签默认落点 = 灵脉格心 w2s(vb.x, vb.y); 抬签改由 gap 承担 (签位不变)',
  /apex \? w2s\(vb\.x \+ \(vb\.jxU \|\| 0\) \* geo\.hexR, vb\.y\) : w2s\(vb\.x, vb\.y\)/.test(SRC['main.js']) &&
  /apex \? ps3\.y - lift : ps3\.y/.test(SRC['main.js']) &&
  /gap: apex \? 0 : lift/.test(SRC['main.js']));

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
