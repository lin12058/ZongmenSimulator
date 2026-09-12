/* ============================================================
 * check_preview_vein_marker.mjs — 校验预览页「灵脉六角形标记」
 * ------------------------------------------------------------
 * 需求: ① 灵脉必须画成【六角形标记】(不是按占地铺开的六边形色块、也不是圆)
 *          —— 曾试过六芒星(★式多角星)，用户判定不好看、已撤回，
 *             本脚本的回归断言会拦住任何"又改成星形/圆形"的改动。
 *       ② 尺寸的"自动放大缩小"必须与【聚落标记】同一套机制 ——
 *          正比于缩放但夹在像素区间内 → 任何缩放、地图任何位置都清晰可辨;
 *          而不是旧公式 rTiles*HEX_R*scale（缩小时 1.2px 看不见、
 *          放大时 64px+ 糊成一片，等于"只在地图的一点点位置"才看得出）。
 *       ③ 六角形必须与地块网格【同朝向】(顶点角 = 60k-90，尖角朝上下)
 *
 * 1) 4 个内联脚本块语法 + 渲染脚本引用的 DOM id
 * 2) 静态契约: markBase 唯一真源 / 聚落复用 markBase / 灵脉用 hexPath /
 *    level 系数 1.5-1.0-0.65 / 2.2px 下限 / 旧公式与旧门控必须消失
 * 3) 形状: hexPath 6 顶点、尖顶朝向、页内无星形残留(starPath/VEIN_STAR_INNER)
 * 4) 数值: 全缩放区间 大>中>小、都 ≥2.2px、都 ≤24px、随缩放单调不减且封顶
 * 5) 回归: 默认缩放下"可见"(旧公式 1.23px → 新公式 ≥2.2px)
 *          且默认缩放下不出现大灵脉名称（避免标签风暴）
 * 用法: node verify/check_preview_vein_marker.mjs
 * ============================================================ */
import fs from 'fs';

let ok = true;
const good = m => console.log('  ✔ ' + m);
const bad  = m => { ok = false; console.log('  ✘ ' + m); };

const html = fs.readFileSync('灵脉预览.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
console.log('脚本块数:', blocks.length, '(应为 4: noise / config / mapgen / 渲染)');
blocks.forEach((b, i) => {
  try { console.log('  块' + (i + 1) + ' 语法 OK  len=' + b.length); }
  catch (e) { bad('块' + (i + 1) + ' 语法错误: ' + e.message); }
});
try { blocks.forEach(b => new Function(b)); }
catch (e) { bad('语法: ' + e.message); }

const render = blocks[blocks.length - 1];
const ids = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
const refs = [...new Set([...render.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
const miss = refs.filter(r => !ids.includes(r));
console.log('\n渲染脚本引用 id 共 %d 个，缺失: %s', refs.length, miss.length ? '✘ ' + miss.join(',') : '✔ 无');
if (miss.length) ok = false;

/* ---------------- 引擎口径（与预览页内联的同一份 mapgen 对齐） ---------------- */
const cfgBlock = blocks.find(b => /MapGenConfig/.test(b)) || '';
const mgBlock  = blocks.find(b => /MapGen\s*=/.test(b)) || '';
const HEX_R = +(html.match(/HEX_R\s*=\s*([\d.]+)/) || [])[1] || 8;
const HEX_W = Math.sqrt(3) * HEX_R;
const REGION_M = +(html.match(/REGION_M\s*[:=]\s*(\d+)/) || [])[1] || 18;
console.log('\n=== 口径 ===');
console.log('  HEX_R=%s HEX_W=%s REGION_M=%s', HEX_R, HEX_W.toFixed(3), REGION_M);
cfgBlock && mgBlock ? good('config / mapgen 两个引擎块都在页内') : bad('缺引擎块');

/* ---------------- 静态契约 ---------------- */
console.log('\n=== 静态契约：灵脉标记 ===');
const veinAt = render.indexOf('灵脉标识');
const veinBlk = veinAt >= 0 ? render.slice(veinAt, veinAt + 1900) : '';

/* ① 尺寸取自共用基准 markBase，且带 2.2px 下限 */
/var markBase\s*=\s*Math\.max\(2,\s*Math\.min\(16,\s*MapGen\.REGION_M \* HEX_W \* scale \* 0\.16\)\)/
  .test(render) ? good('markBase = clamp(REGION_M×HEX_W×scale×0.16, 2, 16)（唯一真源）')
                : bad('markBase 公式不符（必须与聚落同一套）');

/var vrr = Math\.max\(2\.2, Math\.max\(markBase, 3\.0\) \* vf\)/.test(veinBlk)
  ? good('灵脉半径 = max(2.2px, max(markBase,3.0) × 等级系数) —— 有下限，任何缩放都可见')
  : bad('灵脉半径未取 markBase/无下限');

/var vf\s*=\s*v\.level===0 \? 1\.5 : v\.level===1 \? 1\.0 : 0\.65/.test(veinBlk)
  ? good('大/中/小 = 1.5 / 1.0 / 0.65（与聚落 tier 系数同构）')
  : bad('等级系数不符（大1.5/中1.0/小0.65）');

/* ② 形状必须是六角形（hexPath），且不再用圆 */
/hexPath\(sv\.x, sv\.y, vrr\)/.test(veinBlk)
  ? good('灵脉标记用 hexPath() 画（六角形，与地块网格同朝向）')
  : bad('灵脉标记不是六角形（应为 hexPath(sv.x, sv.y, vrr)）');
/ctx\.arc\(/.test(veinBlk) ? bad('灵脉块里仍有圆形绘制 ctx.arc') : good('灵脉块无圆形绘制残留');

/* ③ 星形方案必须彻底消失（用户试过、判定太丑 → 不许留残骸/半成品） */
/starPath|VEIN_STAR_INNER|veinStarPath/.test(render)
  ? bad('页内仍有星形方案残留（starPath / VEIN_STAR_INNER / veinStarPath）')
  : good('星形方案已彻底移除（无 starPath / VEIN_STAR_INNER / veinStarPath 残留）');
/swatch star|swatch\.star/.test(html)
  ? bad('仍保留 .swatch.star 星形图例样式')
  : good('图例无星形色块残留');

/* ---------------- 形状：六角形顶点（6 顶点 + 尖顶朝向） ---------------- */
console.log('\n=== 形状：六角形顶点 ===');
{
  const hexV = Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 180 * (60 * k - 90);
    return [Math.cos(a), Math.sin(a)];
  });
  /* 6 个顶点，且严格 60° 等分、半径相等 ⇒ 正六边形 */
  let eq = true, r0 = Math.hypot(hexV[0][0], hexV[0][1]);
  for (let k = 0; k < 6; k++) {
    if (Math.abs(Math.hypot(hexV[k][0], hexV[k][1]) - r0) > 1e-9) eq = false;
    const a = Math.atan2(hexV[k][1], hexV[k][0]);
    const want = (-90 + 60 * k) * Math.PI / 180;
    if (Math.abs(((a - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 1e-9) eq = false;
  }
  eq ? good('6 顶点等半径、每 60° 一个 ⇒ 正六边形')
     : bad('顶点不均分 → 不是正六边形');
  /* 尖顶：第 0 个顶点在正上方 (0,-1) ⇒ 上下有尖、左右为平边，与地块格同朝向 */
  Math.abs(hexV[0][0]) < 1e-12 && hexV[0][1] < 0
    ? good('尖顶(pointy-top)朝向：顶点在正上/正下 ⇒ 与地块六边形格同朝向（不歪 30°）')
    : bad('不是尖顶朝向 → 会与地形格错位');
  /* 边长 = R ⇒ 与地块格同尺寸；配合"每 60° 一个顶点"，R=HEX_R 时与地块晶格严格平铺 */
  const edge = Math.hypot(hexV[0][0] - hexV[1][0], hexV[0][1] - hexV[1][1]);
  const opp  = Math.hypot(hexV[0][0] - hexV[3][0], hexV[0][1] - hexV[3][1]);
  Math.abs(edge - 1) < 1e-9 && Math.abs(opp - 2) < 1e-9
    ? good('边长 = R、对角 = 2R ⇒ 与地块六边形格（半径 HEX_R）严格平铺')
    : bad('边长/对角不符（edge=' + edge.toFixed(6) + 'R, 对=' + opp.toFixed(6) + 'R）');
}

/* ③ 旧公式 / 旧门控必须消失 */
/var vrr = Math\.max\(0\.8, rTiles \* HEX_R \* scale\)/.test(render)
  ? bad('仍是旧公式(0.8, rTiles*HEX_R*scale) → 缩放不受控')
  : good('旧公式 rTiles*HEX_R*scale 已移除');
/rTiles \* HEX_R \* scale/.test(render)
  ? bad('页内仍有 rTiles*HEX_R*scale 的屏幕尺寸计算')
  : good('无 rTiles*HEX_R*scale 残留');
/showVein && cellPx > 1\.5/.test(render)
  ? bad('灵脉仍被 cellPx>1.5 门控 → 缩小后整层不画')
  : good('灵脉不再被 cellPx 门控（改为逐标记视口裁剪）');

/* ④ 与聚落"同一机制"：聚落必须复用 markBase 而不是自己再算一套 */
/var mBase = markBase;/.test(render)
  ? good('聚落 mBase = markBase（两层共用同一套自动缩放）')
  : bad('聚落未复用 markBase → 两套机制会各自漂移');

/* ⑤ 图例仍是六角形色块 */
const hexSwatch = (html.match(/class="swatch hex"/g) || []).length;
hexSwatch >= 3 ? good('图例 3 行灵脉色块都是 .swatch.hex（六角形）')
               : bad('图例六角形色块只有 ' + hexSwatch + ' 个');
{
  const m = html.match(/\.swatch\.hex\{[^}]*clip-path:polygon\(([^)]*)\)/);
  if (!m) bad('缺 .swatch.hex 样式');
  else {
    const pts = m[1].split(',').map(s => s.trim());
    pts.length === 6 ? good('图例六角形 clip-path = 6 顶点（与画布 hexPath 同构）')
                     : bad('图例六角形顶点数 ' + pts.length + ' ≠ 6');
  }
}

/* ---------------- 数值：全缩放区间 ---------------- */
console.log('\n=== 数值（全缩放区间）===');
const MIN_SCALE = +(render.match(/MIN_SCALE\s*=\s*([\d.]+)/) || [])[1] || 0.005;
const MAX_SCALE = +(render.match(/MAX_SCALE\s*=\s*([\d.]+)/) || [])[1] || 4;
const markBase = s => Math.max(2, Math.min(16, REGION_M * HEX_W * s * 0.16));
const vr = (s, f) => Math.max(2.2, Math.max(markBase(s), 3.0) * f);
const LV = [['大', 1.5], ['中', 1.0], ['小', 0.65]];

let mono = true, order = true, floorOK = true, ceilOK = true;
const prevByLv = LV.map(() => -1);
const SC = [0.005, 0.01, 0.02, 0.038, 0.077, 0.134, 0.2, 0.28, 0.4, 1.0, 2.0, 4.0];
for (let s = MIN_SCALE; s <= MAX_SCALE + 1e-9; s = +(s * 1.08).toFixed(6)) {
  LV.forEach(([, f], li) => {
    const r = vr(s, f);
    if (r < prevByLv[li] - 1e-9) mono = false;   // 每级各自：随缩放单调不减（封顶后持平）
    prevByLv[li] = r;
    if (r < 2.2 - 1e-9) floorOK = false;
    if (r > 24 + 1e-9) ceilOK = false;
  });
  if (!(vr(s, 1.5) > vr(s, 1.0) && vr(s, 1.0) > vr(s, 0.65))) order = false;
}
mono    ? good('随 scale 单调不减（缩小不骤失、放大不失控）') : bad('半径非单调');
order   ? good('任何缩放下 大 > 中 > 小（等级仍可辨）') : bad('大/中/小 尺寸序被打乱');
floorOK ? good('任何缩放都 ≥2.2px（地图任何位置都看得见六角形）') : bad('存在 <2.2px 的不可见标记');
ceilOK  ? good('任何缩放都 ≤24px（放大不会糊成一整片）') : bad('存在 >24px 的巨大色块');

console.log('\n  scale      基准px   大      中      小     （旧公式·大）');
for (const s of SC) {
  console.log('  ' + String(s).padEnd(10) + markBase(s).toFixed(2).padStart(6) + '  ' +
    vr(s, 1.5).toFixed(1).padStart(6) + '  ' + vr(s, 1.0).toFixed(1).padStart(6) + '  ' +
    vr(s, 0.65).toFixed(1).padStart(6) + '   ' + (2 * HEX_R * s).toFixed(1).padStart(6));
}

/* 封顶：放大到 2× 之后尺寸不再变（=夹住，而不是无限放大） */
Math.abs(vr(2.0, 1.5) - vr(MAX_SCALE, 1.5)) < 1e-9
  ? good('放大到 2× 以上后标记尺寸封顶（不再随缩放变大）')
  : bad('高倍缩放仍在放大标记');

/* ---------------- 回归：默认视野 ---------------- */
console.log('\n=== 回归：默认视野同时可见（这就是"只在地图一点点位置"的反面）===');
const baseScale = Math.min(1200, 800) / (5 * Math.sqrt(3) * HEX_R * 150);   // initScaleOnce 的口径
const oldR = 2 * HEX_R * baseScale, newR = vr(baseScale, 1.5);
console.log('  默认 scale ≈ %s：旧公式 大灵脉 %s px → 新公式 %s px',
  baseScale.toFixed(4), oldR.toFixed(2), newR.toFixed(1));
oldR < 2.2 && newR >= 2.2
  ? good('默认视野下由"不可见(旧)"变为"可见六角形(新)"')
  : bad('默认视野可见性未改善 (旧 ' + oldR.toFixed(2) + ' / 新 ' + newR.toFixed(1) + ')');
vr(baseScale, 1.5) < 7
  ? good('默认视野下大灵脉标记 <7px → 名称阈值未触发，不会标签风暴')
  : bad('默认视野下就会标名称，会糊成一片');

console.log('\n结论: ' + (ok ? '✔ 全部通过' : '✘ 有失败项'));
process.exit(ok ? 0 : 1);
