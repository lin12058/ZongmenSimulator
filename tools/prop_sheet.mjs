#!/usr/bin/env node
/* ============================================================
 * tools/prop_sheet.mjs — 立体精灵看板 (山/雪/林/灵脉峰/草丘/孤树)
 * ------------------------------------------------------------
 * 为什么要两种视图:
 *   ① 原尺寸看板 — 看笔触/结构本身画得对不对 (2.4x 放大)。
 *   ② 实机尺寸条 — 精灵在游戏里**不是等比贴**的: PROP_VS 把整个 128 格
 *      映射到 W×H 的方框 (W 与 H 由 hash/海拔决定, 且 W 通常远大于 H),
 *      所以画面里是「横向拉宽」的。只看原图会把比例判错 —— 这一条正是
 *      「灵脉山体样子不对」最容易踩的坑。尺寸条含**灵脉 大/中/小 三档** (同一 hash
 *      并排) ⇒ 等级之间的高度差可直接比对; 高度倍率真源 web/js/vein-skin.js levels[]。
 * 用法:
 *   node tools/prop_sheet.mjs                 # 全部
 *   node tools/prop_sheet.mjs --R=8           # 换格半径 (默认 8 = 线上 hexR)
 * 产出: verify/_prop_sheet.html + verify/_prop_sheet.png
 * 注意: 本机 Chrome 必须用旧版 --headless (--headless=new 忽略 --window-size)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_HTML = path.join(ROOT, 'verify', '_prop_sheet.html');
const OUT_PNG = path.join(ROOT, 'verify', '_prop_sheet.png');
const CHROME = 'C:/Users/Administrator/AppData/Local/Google/Chrome/Application/chrome.exe';
const R = Number((process.argv.find((a) => /^--R=/.test(a)) || '').split('=')[1]) || 8;
const MODE = process.argv.includes('--hero') ? 'hero' : 'all';

/* 精灵清单: [spriteId, 名称] —— spriteId = row*8+col */
const SPRITES = [
  [40, '山 A'], [41, '山 B'], [42, '雪 A'], [43, '雪 B'],
  [44, '林·阔叶'], [45, '林·松'], [46, '林·花'], [47, '林·秋'],
  [48, '沙丘'], [49, '草丛'],
  [32, '异灵根·雷'], [33, '异灵根·风'], [34, '异灵根·冰'], [35, '异灵根·暗'],
  [50, '灵脉·金'], [51, '灵脉·木'], [52, '灵脉·水'], [53, '灵脉·火'], [54, '灵脉·土'],
  [56, '横岭 A'], [57, '横岭 B'], [58, '雪岭 A'], [59, '雪岭 B'],
  [60, '草丘'], [61, '草丘双'], [62, '孤树'], [63, '孤松']
];

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>立体精灵看板</title><style>
 html,body{margin:0;background:#efe7d4;color:#3b352b}
 body{padding:18px 22px 30px;font:13px/1.5 "Noto Serif SC","Songti SC",serif}
 h1{margin:0 0 2px;font-size:18px;letter-spacing:.12em}
 .s{color:#7c7261;font-size:12px;margin-bottom:14px}
 h2{margin:20px 0 6px;font-size:14px;letter-spacing:.08em;border-bottom:1px solid #ded3b8;padding-bottom:4px}
 .g{display:flex;flex-wrap:wrap;gap:8px}
 .c{margin:0;background:#f5efe0;border:1px solid #ded3b8;border-radius:3px;padding:3px 3px 4px;width:176px}
 .c.h{width:322px}
 .c.h canvas{width:314px;height:314px}
 .c canvas{display:block;width:170px;background:
   repeating-conic-gradient(#e9e0cb 0% 25%, #f2ecdb 0% 50%) 50% / 12px 12px}
 figcaption{display:flex;justify-content:space-between;margin-top:2px;font-size:11px;color:#8a7f6b}
 .zrow{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px;background:#cdd6ab;border:1px solid #a9b489;border-radius:3px;padding:6px 14px 10px;margin-bottom:8px} .zi{text-align:center}
 .zi canvas{display:block;image-rendering:auto}
 .zi span{font-size:11px;color:#5c6650}
 .pair{display:flex;gap:14px;align-items:flex-end}
</style></head><body>
<h1>立体精灵看板 · 灵脉山体 / 大世界山体</h1>
<div class="s">真源 web/js/textures.js (buildAtlas) · 格半径 R=${R} · 图集格 128 (纹素 ${R * 0})</div>
<div id="root"></div>
<script src="../web/js/noiselib.js"></script>
<script src="../web/js/vein-skin.js"></script>
<script src="../web/js/textures.js"></script>
<script>
var IT = globalThis.InkTextures || window.InkTextures;
var VS = globalThis.VeinSkin || window.VeinSkin;
var AT = IT.buildAtlas();
var PX = IT.PX, TILE = IT.TILE;
var R = ${R};
var MODE = '${MODE}';
var ZS = [0.8, 1.4, 2.2, 3.0];
/* 灵脉峰: 五行 50..54 与 异灵根 32..35 —— 与 renderer.js PROP_VS 的分支同口径 */
function isVein(id) { return (id > 31.5 && id < 35.5) || (id > 49.5 && id < 54.5); }

/* 取精灵格 (spriteId → 原图 canvas) */
function cellOf(id) {
  var row = Math.floor(id / 8), col = id % 8;
  var c = document.createElement('canvas'); c.width = PX; c.height = PX;
  c.getContext('2d').drawImage(AT, col * PX, row * PX, PX, PX, 0, 0, PX, PX);
  return c;
}
/* PROP_VS 的口径: 整个 128 格映射到 W×H; hs 按精灵类型 (此处与着色器分支同序)
   level: 灵脉峰专用 (0大 / 1中 / 2小; 缺省 0) —— 引擎经实例通道 iElev 下发, 这里显式传 */
function boxOf(id, z, hashSeed, level) {
  var h2 = ((hashSeed * 13.73) % 1), h5 = ((hashSeed * 5.17) % 1);
  var hs, ws = 1.0;
  /* 灵脉峰: 按**等级**取高度倍率 + 收窄的高度随机包络 (与 renderer.js PROP_VS 同口径) */
  if (isVein(id)) {
    var L = (VS.levels && VS.levels[level || 0]) || VS.shape;
    hs = (L.hScale != null) ? L.hScale : VS.shape.hScale;
    ws = VS.shape.wScale;
    var e0 = (L.hRand && L.hRand[0] != null) ? L.hRand[0] : 0.72;
    var e1 = (L.hRand && L.hRand[1] != null) ? L.hRand[1] : 1.00;
    h5 = e0 + (e1 - e0) * h5;
  }
  else if (id < 41.5 || (id > 55.5 && id < 57.5)) hs = 0.55 + 0.75 * 0.7;
  else if ((id > 41.5 && id < 43.5) || (id > 57.5 && id < 59.5)) hs = 0.95 + 0.6 * 0.6;
  else if (id < 49.5) hs = 0.62 + 0.34 * h5;
  else if (id > 59.5 && id < 61.5) hs = 0.52 + 0.24 * h5;
  else if (id > 61.5 && id < 63.5) hs = 0.72 + 0.30 * h5;
  else hs = 1.05;
  var ss = (id > 59.5 && id < 61.5) ? 0.30 : (isVein(id) ? (VS.shape.sizeScale || 1.0) : 1.0);
  var W = 3.4641016 * R * (1.55 + 0.65 * h2) * (0.82 + 0.22 * hs) * ss * ws;
  var H = R * (3.3 + 1.2 * h5) * hs * ss;
  return { W: W * z, H: H * z, W0: W, H0: H, hs: hs };
}

var root = document.getElementById('root');

/* 一条实机尺寸行: 同一 hash 取两个种子 → 同种精灵的两个实际大小 */
function sizeRow(z) {
  var line = document.createElement('div'); line.className = 'zrow';
  /* [名称, spriteId, level] —— 大/中/小 三档在同一 hash 下并排 ⇒ 高度差可直接比对 */
  [['灵脉·大', 50, 0], ['灵脉·中', 50, 1], ['灵脉·小', 50, 2],
   ['异灵根·雷(中)', 32, 1], ['大世界山A', 41, -1], ['横岭B', 57, -1]].forEach(function (gr) {
    var wrap = document.createElement('div'); wrap.className = 'pair';
    [0.13, 0.62].forEach(function (seed) {
      var b = boxOf(gr[1], z, seed, gr[2]);
      var cw = Math.ceil(b.W) + 8, chy = Math.ceil(b.H) + 8;
      var cv = document.createElement('canvas'); cv.width = cw; cv.height = chy;
      var cx = cv.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      /* 山脚落在距底 8px 处 (灵脉峰 crop 到 y=118, 大世界山 y=106); 整格按 W×H 贴 → 与着色器一致 */
      var baseY = isVein(gr[1]) ? 118 : 106;
      var top = chy - 8 - b.H * (baseY / 128);
      cx.drawImage(cellOf(gr[1]), 0, 0, PX, PX, (cw - b.W) / 2, top, b.W, b.H);
      var d = document.createElement('div'); d.className = 'zi';
      d.appendChild(cv);
      d.insertAdjacentHTML('beforeend', '<span>' + gr[0] + '<br>' + pad(b.W0, 1) + '×' + pad(b.H0, 1) + '</span>');
      wrap.appendChild(d);
    });
    line.appendChild(wrap);
  });
  var lg = document.createElement('div'); lg.className = 'zi';
  lg.innerHTML = '<b style="font-size:12px">z=' + z + '</b>';
  line.appendChild(lg);
  return line;
}

/* ---------- ① 原尺寸看板 (2.4x) ---------- */
var S1 = '2.4';
function pad(v, n) { return v.toFixed(n); }
var cards = '';
[['40,41,42,43,44,45,46,47', '第 5 行'], ['48,49,50,51,52,53,54', '第 6 行'], ['32,33,34,35,56,57,58,59', '第 4/7 行'], ['60,61,62,63', '第 7 行尾']].forEach(function (row) {
  var ids = row[0].split(',').map(Number);
  var names = { 32:'雷',33:'风',34:'冰',35:'暗',40:'山A',41:'山B',42:'雪A',43:'雪B',44:'林阔',45:'林松',46:'林花',47:'林秋',48:'沙丘',49:'草丛',50:'金',51:'木',52:'水',53:'火',54:'土',56:'岭A',57:'岭B',58:'雪岭A',59:'雪岭B',60:'丘',61:'丘双',62:'树',63:'松' };
  ids.forEach(function (id) {
    var c = cellOf(id);
    c.style.width = (PX * 2.4 / 2) + 'px'; c.style.height = (PX * 2.4 / 2) + 'px';
    cards += '<figure class="c" data-id="' + id + '" data-row="' + row[1] + '"><figcaption><b>' + names[id] + '</b><span>#' + id + '</span></figcaption></figure>';
  });
});
/* ---------- ③ 特写 (6x): 判笔触/轮廓/云断是否成立 ---------- */
var HERO = [[50,'灵脉·金'],[51,'灵脉·木'],[53,'灵脉·火'],[54,'灵脉·土'],[32,'异灵根·雷'],[34,'异灵根·冰'],[41,'大世界山B'],[57,'横岭B']];
var heroCards = '';
HERO.forEach(function (it) {
  heroCards += '<figure class="c h" data-hid="' + it[0] + '">' +
    '<figcaption><b>' + it[1] + '</b><span>#' + it[0] + '</span></figcaption></figure>';
});
if (MODE === 'hero') {
  root.insertAdjacentHTML('beforeend', '<h2>特写 (6x) — 灵脉峰 vs 大世界岩峰</h2><div class="g" id="g3">' + heroCards + '</div>');
} else {
  root.insertAdjacentHTML('beforeend', '<h2>③ 特写 (6x) — 灵脉峰 vs 大世界岩峰</h2><div class="g" id="g3">' + heroCards + '</div>');
  root.insertAdjacentHTML('beforeend', '<h2>① 原尺寸 (2.4x) — 看笔触与结构</h2><div class="g" id="g1"></div>');
  var g1 = document.getElementById('g1');
  g1.insertAdjacentHTML('beforeend', cards);
  Array.prototype.forEach.call(g1.querySelectorAll('figure.c'), function (f) {
    var id = +f.getAttribute('data-id');
    f.insertBefore(cellOf(id), f.firstChild);
  });
  /* ---------- ② 实机尺寸条 ---------- */
  root.insertAdjacentHTML('beforeend', '<h2>② 实机尺寸 (同一 hash 口径, 草地底) — 看真实比例与辨识度</h2>');
  ZS.forEach(function (z) { root.appendChild(sizeRow(z)); });
}
Array.prototype.forEach.call(document.querySelectorAll('figure.h'), function (f) {
  var c = cellOf(+f.getAttribute('data-hid'));
  c.style.width = '300px'; c.style.height = '300px';
  f.insertBefore(c, f.firstChild);
});
</script></body></html>`;

fs.writeFileSync(OUT_HTML, html, 'utf8');

function shot(htmlPath, outPng, w, h) {
  fs.rmSync(outPng, { force: true });
  const prof = path.join(os.tmpdir(), 'propprof');
  const r = spawnSync(CHROME, [
    '--headless', '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=' + w + ',' + h, '--screenshot=' + outPng, pathToFileURL(htmlPath).href
  ], { stdio: 'ignore', timeout: 120000 });
  const ok = fs.existsSync(outPng) && fs.statSync(outPng).size > 900;
  return { ok, code: r.status, size: ok ? fs.statSync(outPng).size : 0 };
}
/* ⚠ 全量模式的页高必须容下 ③特写 + ①原尺寸 + ②实机尺寸条 三段;
   1560 会把 ② 整段截在视口外 (Chrome --screenshot 只截视口) → 大/中/小 并排行看不到 */
const r = shot(OUT_HTML, OUT_PNG, MODE === 'hero' ? 1800 : 1520, MODE === 'hero' ? 1020 : 2100);
console.log((r.ok ? '看板已渲染' : '渲染失败') + ' → ' + OUT_PNG + ' (' + r.size + 'B, code=' + r.code + ')');
process.exit(r.ok ? 0 : 1);
