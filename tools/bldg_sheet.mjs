#!/usr/bin/env node
/* ============================================================
 * tools/bldg_sheet.mjs — 建筑实时绘制「看板」渲染器 (纯代码作画)
 * ------------------------------------------------------------
 * 用途: 把 web/js/bldg_ink.js 的实时绘制结果拼成对照看板并截图,
 *       用于人工校验朝向 / 贴格 / 立体感 / 去背景后的效果。
 * 两种模式:
 *   node tools/bldg_sheet.mjs all               26 种 (默认坐北朝南)
 *   node tools/bldg_sheet.mjs dirs 码头 农田 民房  指定建筑 × 六朝向
 * 产出: verify/_bldg_sheet.html + verify/_bldg_sheet.png
 * 注意: 本机 Chrome 必须用旧版 --headless (--headless=new 忽略 --window-size)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_HTML = path.join(ROOT, 'verify', '_bldg_sheet.html');
const OUT_PNG = path.join(ROOT, 'verify', '_bldg_sheet.png');
/* ⚠ 不要硬编码用户目录: 旧版写死 C:/Users/Administrator (A 机) ⇒ 换机静默 ENOENT 渲染失败。
   与 verify/live_cap.mjs / tools/prop_sheet.mjs 同口径走 homedir(); 可用 CHROME_PATH 覆盖。 */
const CHROME = process.env.CHROME_PATH ||
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome: ' + CHROME + ' (可用 CHROME_PATH 指定)'); process.exit(2); }

/* ---------- 载入绘制核心 (浏览器/Node 双后端同一份真源) ---------- */
const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'bldg_ink.js'), 'utf8');
(0, eval)(src);
const BI = globalThis.BldgInk;
if (!BI) { console.error('bldg_ink.js 未导出 global.BldgInk'); process.exit(1); }

const DIR_W = 1.7320508;                 // hexW / R
const BOX = { x0: -1.35, x1: 1.35, y0: -1.6, y1: 2.4 };
const R = Number((process.argv.find((a) => /^--R=/.test(a)) || '').split('=')[1]) || 42;
const VW = (BOX.x1 - BOX.x0) * R, VH = (BOX.y1 - BOX.y0) * R;
const PAD = 7;

/* 六邻格心 (与 NEIGH_SLOTS 同序) + 本格 → 用于画"地图网格"参照 */
function hexPath(cx, cy, r) {
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = (60 * i - 90) * Math.PI / 180;
    d += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(1) + ' ' + (cy + r * Math.sin(a)).toFixed(1);
  }
  return d + 'Z';
}
function gridRefs() {
  const out = [`<path d="${hexPath(0, 0, R)}" fill="#e6dcc4" fill-opacity="0.55" stroke="#b9a98a"
     stroke-width="1" stroke-opacity="0.85"/>`];
  for (let k = 0; k < 6; k++) {
    const dq = BI.DIRS[k].x, dr = BI.DIRS[k].y;      // 单位向量
    const wx = (k === 0 ? 1 : k === 1 || k === 2 ? 0.5 : k === 3 ? -1 : -0.5) * DIR_W * R;
    const wy = (k === 1 || k === 2 ? 1 : k === 4 || k === 5 ? -1 : 0) * 1.5 * R;
    void dq; void dr;
    out.push(`<path d="${hexPath(wx, wy, R)}" fill="#e6dcc4" fill-opacity="0.26" stroke="#c3b394"
       stroke-width="0.8" stroke-opacity="0.5"/>`);
  }
  return out.join('');
}
function cell(kind, face, variant, label, sub) {
  const spec = { kind, cx: 0, cy: 0, R, q: 3 + (variant % 5), r: -2 + (variant % 3),
    variant, face: face || null, detail: 3, plate: false };
  const body = BI.svgBody(spec);
  return `<figure class="c">
  <div class="art">
    <svg viewBox="${BOX.x0 * R - PAD} ${BOX.y0 * R - PAD} ${VW + PAD * 2} ${VH + PAD * 2}">
      ${gridRefs()}
      ${body}
    </svg>
  </div>
  <figcaption><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</figcaption>
</figure>`;
}

const mode = process.argv[2] || 'all';
let cards = '', title = '', sub = '';
if (mode === 'dirs') {
  const kinds = process.argv.slice(3);
  const list = kinds.length ? kinds : ['码头', '农田', '民房', '矿山'];
  title = '建筑 × 六朝向 对照';
  sub = '同一座建筑按六个邻格方向站立 (中格 + 六邻格网格为参照); 朝向由 face 传入, 门/阶/栈桥/垄向随之改变';
  list.forEach((k) => {
    for (let d = 0; d < 6; d++) {
      cards += cell(k, { x: BI.DIRS[d][0], y: BI.DIRS[d][1] }, d,
        k, ['东', '东南', '西南', '西', '西北', '东北'][d]);
    }
  });
} else {
  title = '建筑实时绘制 · 26 种';
  sub = '真源 web/js/bldg_ink.js · 透明底 + 六边格基座 + 朝向投影 (默认坐北朝南) · 每格随机变体';
  BI.KIND_LIST.forEach((k, i) => {
    const rule = BI.FACE_RULE[k] || 'south';
    cards += cell(k, null, i, k, BI.FACE_DESC[rule].split(' ')[0]);
  });
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
 html,body{margin:0;background:#efe7d4;color:#3b352b}
 body{padding:20px 24px 34px;font:13px/1.5 "Noto Serif SC","Songti SC",serif}
 h1{margin:0 0 3px;font-size:19px;letter-spacing:.12em}
 .s{color:#7c7261;font-size:12px;margin-bottom:16px}
 .g{display:grid;grid-template-columns:repeat(7,1fr);gap:10px}
 .c{margin:0;background:#f5efe0;border:1px solid #ded3b8;border-radius:4px;padding:4px 4px 6px}
 .art svg{display:block;width:100%;height:auto}
 figcaption{display:flex;justify-content:space-between;gap:4px;margin-top:3px;font-size:12px}
 figcaption span{color:#8a7f6b;font-size:11px}
</style></head><body>
<h1>${title}</h1><div class="s">${sub}</div>
<div class="g">${cards}</div>
</body></html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');

function shot(htmlPath, outPng, w, h) {
  fs.rmSync(outPng, { force: true });
  const prof = path.join(os.tmpdir(), 'bldgprof');
  const r = spawnSync(CHROME, [
    '--headless', '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=' + w + ',' + h, '--screenshot=' + outPng, pathToFileURL(htmlPath).href
  ], { stdio: 'ignore', timeout: 120000 });
  const ok = fs.existsSync(outPng) && fs.statSync(outPng).size > 900;
  return { ok, code: r.status, size: ok ? fs.statSync(outPng).size : 0 };
}
const nCards = mode === 'dirs' ? (process.argv.slice(3).filter((a) => !/^--/.test(a)).length || 4) * 6 : 26;
const colsW = 1560 - 48 - 36;
const cardW = colsW / 7;
const artH = cardW * (VH + PAD * 2) / (VW + PAD * 2);
const h = Math.round(64 + Math.ceil(nCards / 7) * (artH + 30) + 26);
const r = shot(OUT_HTML, OUT_PNG, 1560, h);
console.log((r.ok ? '看板已渲染' : '渲染失败') + ' → ' + OUT_PNG +
  ' (' + r.size + 'B, code=' + r.code + ', h=' + h + ')');
process.exit(r.ok ? 0 : 1);
