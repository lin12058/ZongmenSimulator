#!/usr/bin/env node
/* ============================================================
 * tools/bldg_town.mjs — 「真实聚落平面图」渲染器
 * ------------------------------------------------------------
 * 与 bldg_sheet.mjs (26 种逐个看) 互补: 这里取**引擎真实生成的一座聚落**,
 * 把它的每一座建筑按真实轴向格位铺在真实六边网格上, 用生产代码
 * (BldgInk.paint + BldgInk.faceSolver) 画出 —— 用于校验:
 *   · 贴格: 每座建筑是否落在自己的六边格心
 *   · 朝向: 码头朝水/炉窑朝山/民居朝中枢/殿宇坐北朝南 是否真的成立
 *   · 立体: 遮挡序 (远者先画) 是否正确
 *   · 变体: 同种建筑造型是否各不相同
 *
 * 用法:
 *   node tools/bldg_town.mjs [seed] [--q=N --r=N] [--R=34] [--type=town] [--nolabel]
 * 缺省: 取距原点最近的聚落。
 * 产出: verify/_bldg_town.html + verify/_bldg_town.png
 * 注意: 本机 Chrome 必须用旧版 --headless (--headless=new 忽略 --window-size)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const OUT_HTML = path.join(ROOT, 'verify', '_bldg_town.html');
const OUT_PNG = path.join(ROOT, 'verify', '_bldg_town.png');
const CHROME = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');

const argOf = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').split('=')[1];
const SEED = process.argv.slice(2).find((a) => !/^--/.test(a)) || '宗门模拟器';
const R = Number(argOf('R')) || 34;
const WANT_TYPE = argOf('type') || '';
const NO_LABEL = process.argv.includes('--nolabel');

/* ---------- 引擎 (顺序铁律: noise → mapgen-config → mapgen) ---------- */
const sb = { console, Math, JSON };
sb.window = sb; sb.globalThis = sb;
const ectx = vm.createContext(sb);
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ectx, { filename: f });
}
const MG = sb.MapGen;
if (!MG) { console.error('MapGen 未导出'); process.exit(1); }
MG.init(SEED);

/* ---------- 绘制核心 (前端真源) ---------- */
const biBox = { console, Math, JSON };
biBox.window = biBox; biBox.globalThis = biBox;
vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'js', 'bldg_ink.js'), 'utf8'),
  vm.createContext(biBox), { filename: 'bldg_ink.js' });
const BI = biBox.BldgInk;
if (!BI) { console.error('BldgInk 未导出'); process.exit(1); }

/* ---------- 选聚落 ---------- */
let st = null;
const qWant = Number(argOf('q')), rWant = Number(argOf('r'));
for (let i = -4; i <= 4 && !st; i++) {
  for (let j = -4; j <= 4 && !st; j++) {
    for (const s of (MG.settlementsFor(i, j) || [])) {
      if (s.type === 'poi') continue;
      if (WANT_TYPE && s.type !== WANT_TYPE) continue;
      if (!isNaN(qWant) && !isNaN(rWant)) { if (s.q === qWant && s.r === rWant) st = s; continue; }
      if (!st || MG.hexDist(0, 0, s.q, s.r) < MG.hexDist(0, 0, st.q, st.r)) st = s;
    }
  }
}
if (!st) { console.error('未找到符合条件的聚落'); process.exit(1); }
const plan = MG.growTownFootprint(st.id, st.type, st.q, st.r);
if (!plan || !plan.buildings.length) { console.error('该聚落无建筑'); process.exit(1); }

/* ---------- 生产求解器: 地类真值直接来自引擎 ---------- */
const solver = BI.faceSolver({
  biome: (q, r) => { const f = MG.fields(q, r); return f ? f.biome : -1; },
  hexW: MG.HEX_W, hexR: MG.HEX_R, ringMax: 3
});

/* ---------- 布局: 与地图同一套轴向→笛卡尔公式, 以 hexR 为 1 单位 ---------- */
const S3 = Math.sqrt(3);
const pos = (dq, dr) => [S3 * (dq + dr / 2) * R, 1.5 * dr * R];
/* 深度序 (与前端 drawBuildings 同规则: 世界 y 小者先画, 同深按 q) */
const list = plan.buildings.map((b) => {
  const fi = solver.faceInfo(b, st);
  const p = pos(b.q - st.q, b.r - st.r);
  return { b, fi, x: p[0], y: p[1], wy: b.r };
}).sort((a, b) => (a.wy - b.wy) || (a.b.q - b.b.q));

/* 变体: 与前端一致 (hash3(q,r,kindId) % 8) */
const variantOf = (b) => BI.hash3(b.q | 0, b.r | 0, BI.kindIdOf(b.kind)) % 8;

/* ---------- 网格参照: 铺满所有建筑所在环, 每格按【引擎真实地类】上色 ----------
   · 底色 = fields().disp 的 BIOME_META 色 (与 /api/map/meta 下发给客户端的同源)
   · 粗描边 = 该格属于本聚落足迹 —— 「贴格」的判据就在这一笔上
   · 灵脉格 (disp 8..12 金木水火土) 另缀一枚白菱点, 便于核对
     聚灵阵/祭坛/灵枢殿是否真落在灵脉上, 也便于核对炉窑朝山、渔船坞朝水 */
let RMAX = 1;
for (const it of list) RMAX = Math.max(RMAX, MG.hexDist(0, 0, it.b.q - st.q, it.b.r - st.r));
const GRID_R = RMAX + 1;
const inTown = new Set();
for (const it of list) inTown.add((it.b.q - st.q) + ',' + (it.b.r - st.r));
const BMETA = MG.BIOME_META;
function hexPath(cx, cy, r) {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = (60 * i - 90) * Math.PI / 180;
    d += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(1) + ' ' + (cy + r * Math.sin(a)).toFixed(1);
  }
  return d + 'Z';
}
let gridSvg = '', nVein = 0, nWater = 0;
for (let a = -GRID_R; a <= GRID_R; a++) {
  for (let b = -GRID_R; b <= GRID_R; b++) {
    if (MG.hexDist(0, 0, a, b) > GRID_R) continue;
    const p = pos(a, b);
    const f = MG.fields(st.q + a, st.r + b);
    const disp = f ? f.disp : -1;
    const meta = BMETA[disp] || null;
    const isTown = inTown.has(a + ',' + b);
    const isVein = disp >= 8, isWater = disp <= 1;
    if (isVein) nVein++;
    if (isWater) nWater++;
    gridSvg += `<path d="${hexPath(p[0], p[1], R)}" fill="${meta ? meta.color : '#d9d2c2'}"` +
      ` fill-opacity="${isTown ? '0.90' : '0.52'}"` +
      ` stroke="${isTown ? '#463c2c' : '#b3a68c'}" stroke-width="${isTown ? 1.4 : 0.7}"` +
      ` stroke-opacity="${isTown ? '0.9' : '0.45'}"/>`;
    if (isVein) {
      const s = R * 0.17;
      gridSvg += `<path d="M${p[0].toFixed(1)} ${(p[1] - s).toFixed(1)}L${(p[0] + s).toFixed(1)} ${p[1].toFixed(1)}` +
        `L${p[0].toFixed(1)} ${(p[1] + s).toFixed(1)}L${(p[0] - s).toFixed(1)} ${p[1].toFixed(1)}Z"` +
        ` fill="#ffffff" fill-opacity="0.78"/>`;
    }
  }
}

/* ---------- 建筑 (生产代码: paint 的 SVG 后端) + 朝向指示箭头 ---------- */
const RULE_COL = { water: '#2f7d95', rock: '#8a6a4a', wood: '#4f7a44',
  center: '#a8927a', away: '#a8927a', south: '#a8927a', open: '#a8927a', flat: null };
let bodySvg = '', labelSvg = '', arrowSvg = '';
list.forEach((it) => {
  const b = it.b;
  const v = variantOf(b);
  const rule = BI.FACE_RULE[b.kind] || 'south';
  /* 朝向指示: 由格心沿 face 单位向量拉一根虚线 + 箭头 (flat 类无方向, 不画)。
     核对口径: 蓝=朝水, 褐=朝山, 绿=朝林, 灰=朝中枢/背城/朝南 */
  const ac = RULE_COL[rule];
  if (ac && it.fi.face && (it.fi.face.x || it.fi.face.y)) {
    const fx = it.fi.face.x, fy = it.fi.face.y;
    const L = R * 1.5;
    const ex = it.x + fx * L, ey = it.y + fy * L;
    const nx = -fy, ny = fx, hs = R * 0.16;
    arrowSvg += `<path d="M${it.x.toFixed(1)} ${it.y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}"` +
      ` stroke="${ac}" stroke-width="1.1" stroke-opacity="0.75" stroke-dasharray="3 2.6" fill="none"/>` +
      `<path d="M${ex.toFixed(1)} ${ey.toFixed(1)}` +
      `L${(ex - fx * hs * 2 + nx * hs).toFixed(1)} ${(ey - fy * hs * 2 + ny * hs).toFixed(1)}` +
      `L${(ex - fx * hs * 2 - nx * hs).toFixed(1)} ${(ey - fy * hs * 2 - ny * hs).toFixed(1)}Z"` +
      ` fill="${ac}" fill-opacity="0.9"/>`;
  }
  bodySvg += BI.svgBody({
    kind: b.kind, cx: it.x, cy: it.y, R, q: b.q, r: b.r,
    variant: v, tier: b.tier, face: it.fi.face, water: it.fi.water,
    detail: 3, plate: true, plateA: 0.20,
    /* A (2026-09-15): 渔村 → 走 KINDS_FISH 渔家画法 (吊脚楼/渔获仓)。
       生产代码同一判据 = main.js `isFish: it.st.type === 'fishing'`。 */
    fishVillage: st.type === 'fishing',
    /* R5b: 建筑格是水 → 生产代码会垫干栏木台 (水上人家)。地类真值取自引擎。 */
    onWater: (() => { const f = MG.fields(b.q, b.r); return !!f && f.biome <= 1; })()
  });
  if (!NO_LABEL) {
    /* 名牌带浅底描边 (paint-order=stroke), 密集聚落里也压不糊 */
    const ly = it.y + R * 1.30;
    const lab = b.kind + (b.tier === 3 ? '·核心' : '');
    const halo = ' paint-order="stroke" stroke="#f4eddc" stroke-width="2.6" stroke-linejoin="round"';
    labelSvg += `<text x="${it.x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle"` +
      ` font-size="${(R * 0.36).toFixed(1)}" fill="#3b352b"${halo}>${lab}</text>`;
    labelSvg += `<text x="${it.x.toFixed(1)}" y="${(ly + R * 0.38).toFixed(1)}" text-anchor="middle"` +
      ` font-size="${(R * 0.26).toFixed(1)}" fill="#6d6152"${halo}>${b.terrain} · 变体${v}</text>`;
  }
});

/* viewBox: 按实际建筑与画布内容外扩 (建筑可越格: 上 2.4R / 侧 1.35R) */
let x0 = -GRID_R * S3 * R, x1 = GRID_R * S3 * R, y0 = -GRID_R * 1.5 * R, y1 = GRID_R * 1.5 * R;
for (const it of list) {
  x0 = Math.min(x0, it.x - 1.4 * R); x1 = Math.max(x1, it.x + 1.4 * R);
  y0 = Math.min(y0, it.y - 2.6 * R); y1 = Math.max(y1, it.y + 2.6 * R);
}
y1 += NO_LABEL ? 0.3 * R : 1.1 * R;
const PAD = 0.35 * R;
x0 -= PAD; x1 += PAD; y0 -= PAD; y1 += PAD;
const VB = [x0, y0, x1 - x0, y1 - y0];

const TIER_NAME = { sect: '宗门', city: '城', town: '镇', village: '村', fishing: '渔村' };
const title = `${st.name} · ${TIER_NAME[st.type] || st.type} 平面（格位 ${st.q},${st.r}）`;
const sub = `种子「${SEED}」· 真源 web/js/bldg_ink.js + 引擎真值地类 · ` +
  `${list.length} 座建筑 · 半径 ${R}px · 六边格为地图同款网格 · 朝向/贴格/遮挡序均由生产代码推出`;
const kinds = {};
for (const it of list) kinds[it.b.kind] = (kinds[it.b.kind] || 0) + 1;
const legend = Object.keys(kinds).map((k) =>
  `${k}×${kinds[k]}[${BI.FACE_DESC[BI.FACE_RULE[k] || 'south'].split(' ')[0]}]`).join('　');
/* 地类色板 (只列本图出现过的) + 朝向箭头图例 */
const usedDisp = new Set();
for (let a = -GRID_R; a <= GRID_R; a++)
  for (let b = -GRID_R; b <= GRID_R; b++)
    if (MG.hexDist(0, 0, a, b) <= GRID_R) {
      const f = MG.fields(st.q + a, st.r + b);
      if (f && BMETA[f.disp]) usedDisp.add(f.disp);
    }
const biomeLegend = [...usedDisp].sort((x, y) => x - y).map((d) =>
  `<span class="sw"><i style="background:${BMETA[d].color}"></i>${BMETA[d].name}</span>`).join('');
const arrowLegend = [...new Set(list.map((it) => BI.FACE_RULE[it.b.kind] || 'south'))]
  .filter((k) => RULE_COL[k])
  .map((k) => `<span class="sw"><i class="ar" style="color:${RULE_COL[k]}">→</i>${BI.FACE_DESC[k].split(' ')[0]}</span>`)
  .join('');
const stat = `足迹格 ${list.length} · 图内地类 ${usedDisp.size} 种 · 灵脉格 ${nVein} · 水格 ${nWater}`;

/* ---------- 版面尺寸 (须在拼 HTML 前算好: SVG 高度写死, 否则图例换行会吃掉画布) ---------- */
const CW = 1180;                               // 内容宽 (CSS px)
const artW = CW - 44 - 12;
const artH = Math.round(artW * (VB[3] / VB[2]));
const headH = 246;                             // 标题+副题+建筑清单+双行图例+统计 的实测高度

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
 html,body{margin:0;background:#efe7d4;color:#3b352b}
 body{padding:18px 22px 26px;font:13px/1.55 "Noto Serif SC","Songti SC",serif}
 h1{margin:0 0 3px;font-size:19px;letter-spacing:.1em}
 .s{color:#7c7261;font-size:12px}
 .l{margin-top:7px;color:#6d6152;font-size:12px;line-height:1.7}
 .lg{margin-top:6px;font-size:12px;color:#5f5545;line-height:1.9}
 .lg b{font-weight:600;color:#463c2c;margin-right:4px}
 .sw{display:inline-block;margin-right:11px;white-space:nowrap}
 .sw i{display:inline-block;width:11px;height:11px;border:1px solid #a99b80;
        border-radius:2px;vertical-align:-1px;margin-right:4px}
 .sw i.ar{width:auto;height:auto;border:0;font-style:normal;font-size:15px;line-height:1;
        vertical-align:-2px;font-weight:700}
 .art{margin-top:12px;background:#f4eddc;border:1px solid #ded3b8;border-radius:4px;padding:6px}
 .art svg{display:block;width:100%;height:${artH}px}
</style></head><body>
<h1>${title}</h1><div class="s">${sub}</div>
<div class="l">${legend}</div>
<div class="lg"><b>地类</b>${biomeLegend}<br><b>朝向</b>${arrowLegend}</div>
<div class="s" style="margin-top:3px">${stat}</div>
<div class="art"><svg viewBox="${VB.map((v) => v.toFixed(1)).join(' ')}">
  ${gridSvg}${arrowSvg}${bodySvg}${labelSvg}
</svg></div>
</body></html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');
console.log('  ' + title + ' · 建筑 ' + list.length + ' 座 · ' + legend);
console.log('  ' + stat);

/* ---------- 截图 ---------- */
function shot(htmlPath, outPng, w, h) {
  fs.rmSync(outPng, { force: true });
  const prof = path.join(os.tmpdir(), 'bldgtownprof');
  const r = spawnSync(CHROME, [
    '--headless', '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=' + w + ',' + h, '--screenshot=' + outPng, pathToFileURL(htmlPath).href
  ], { stdio: 'ignore', timeout: 120000 });
  const ok = fs.existsSync(outPng) && fs.statSync(outPng).size > 900;
  return { ok, code: r.status, size: ok ? fs.statSync(outPng).size : 0 };
}
const h = headH + artH + 26;
const r = shot(OUT_HTML, OUT_PNG, CW, h);
console.log((r.ok ? '平面图已渲染' : '渲染失败') + ' → ' + OUT_PNG +
  ' (' + r.size + 'B, code=' + r.code + ', ' + CW + 'x' + h + ')');
process.exit(r.ok ? 0 : 1);
