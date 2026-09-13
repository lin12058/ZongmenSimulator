#!/usr/bin/env node
/* ============================================================
 * tools/ink_buildings.mjs — 建筑水墨贴图生成器 (纯代码作画, 不调用任何 AI 生图)
 * ------------------------------------------------------------
 * 真源: Server/Zongmen/Engine/js/mapgen.js 的 BUILDINGS(地皮池) + CORE_KIND(核心池)
 *       共 26 种建筑, 与本脚本 BUILDS 表逐一对齐 (脚本会断言数量一致)。
 * 产出: docs/建筑贴图/<id>.svg          每种建筑一张 128×128 矢量水墨图
 *       docs/建筑贴图/建筑贴图总览.html  26 张并排总览 (可直接浏览/截图)
 * 画法: 与 web/js/textures.js 同一套笔法语言 —— 叠层枯笔(飞白)/晕染水渍/皴笔/椿点,
 *       只是载体从 Canvas2D 换成 SVG 字符串, 便于 Markdown 文档内嵌与无损缩放。
 * 用法: node tools/ink_buildings.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', '建筑贴图');

/* ---------- 墨色 (墨分五色: 焦/浓/重/淡/清) ---------- */
const INK = '#2b2621';    // 焦墨
const INK2 = '#3f382e';   // 浓墨
const INK3 = '#5b5343';   // 重墨
const INK4 = '#837a68';   // 淡墨
const INK5 = '#aca393';   // 清墨
const PAPER = '#f2ead8';  // 宣纸
const EARTH = '#b08a5e';  // 赭石 (夯土/木构)
const CINNABAR = '#b2452f'; // 朱砂 (门/柱/幡/印)
const AZURE = '#5d8496';  // 石青 (水)
const JADE = '#6f8f57';   // 草木
const GAMBOGE = '#c2a03c'; // 藤黄 (粮/灯)
const SPIRIT = '#8f7fc4'; // 灵气 (紫)

/* ---------- 确定性伪随机 (同一建筑每次生成完全一致) ---------- */
let R = mulberry32(1);
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let _gid = 0;
let NS = 'b0_';   // 命名空间前缀: 26 张图内联进同一张 HTML 时渐变 id 必须互不冲突
const nid = () => NS + (++_gid);
const f1 = (n) => (+n).toFixed(1);
const P = (pts) => pts.map((p) => f1(p[0]) + ',' + f1(p[1])).join(' ');

/* ============================================================
 * 笔法基元 (全部产出 SVG 片段字符串)
 * ============================================================ */

/* 枯笔线条: n 层叠加 + 逐点抖动, 末层叠纸色虚线模拟「飞白」 */
function stroke(pts, o = {}) {
  const w = o.w == null ? 1.6 : o.w;
  const c = o.c || INK;
  const a = o.a == null ? 0.8 : o.a;
  const n = o.n == null ? 2 : o.n;
  const fly = o.fly !== false;
  const j = o.j == null ? w * 0.38 : o.j;
  let s = '';
  for (let L = 0; L < n; L++) {
    const jj = j * (1 + L * 0.85);
    const p2 = pts.map(([x, y]) => [x + (R() - 0.5) * jj, y + (R() - 0.5) * jj]);
    s += `<polyline points="${P(p2)}" fill="none" stroke="${c}" stroke-width="${(w * (1 - L * 0.3) * (0.8 + R() * 0.45)).toFixed(2)}" stroke-opacity="${(a * (L === 0 ? 0.92 : 0.44)).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  if (fly && w > 1.3) {
    const p2 = pts.map(([x, y]) => [x + (R() - 0.5) * w * 0.8, y + (R() - 0.5) * w * 0.8]);
    s += `<polyline points="${P(p2)}" fill="none" stroke="${PAPER}" stroke-width="${(w * 0.34).toFixed(2)}" stroke-opacity="0.42" stroke-dasharray="${(1.6 + R() * 3).toFixed(1)} ${(1.8 + R() * 4).toFixed(1)}" stroke-linecap="round"/>`;
  }
  return s;
}

/* 没骨铺面: 一个闭合多边形 (可给渐变) */
function face(pts, fill, a = 1, extra = '') {
  return `<polygon points="${P(pts)}" fill="${fill}" fill-opacity="${a}" ${extra}/>`;
}
/* 任意路径 */
function pathD(d, fill, a = 1, extra = '') {
  return `<path d="${d}" fill="${fill}" fill-opacity="${a}" ${extra}/>`;
}
/* 晕染水渍 */
function wash(cx, cy, r, c, a) {
  const id = nid();
  return `<defs><radialGradient id="${id}"><stop offset="0%" stop-color="${c}" stop-opacity="${a}"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="url(#${id})"/>`;
}
/* 椿点 (树叶/星点) */
function dots(cx, cy, n, c, rb, spread = 5, a = 0.45) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const ang = R() * Math.PI * 2, d = R() * spread;
    s += `<circle cx="${f1(cx + Math.cos(ang) * d)}" cy="${f1(cy + Math.sin(ang) * d * 0.72)}" r="${f1(rb * (0.5 + R() * 0.9))}" fill="${c}" fill-opacity="${(a * (0.6 + R() * 0.7)).toFixed(2)}"/>`;
  }
  return s;
}
/* 接地投影 */
function ground(cx, cy, rx, ry, a = 0.26) {
  const id = nid();
  return `<defs><radialGradient id="${id}"><stop offset="15%" stop-color="#302a22" stop-opacity="${a}"/><stop offset="100%" stop-color="#302a22" stop-opacity="0"/></radialGradient></defs>` +
    `<ellipse cx="${f1(cx)}" cy="${f1(cy)}" rx="${f1(rx)}" ry="${f1(ry)}" fill="url(#${id})"/>`;
}
/* 宣纸底: 米色 + 纤维斑驳 + 细点 */
function paperBase() {
  let s = `<rect width="128" height="128" fill="${PAPER}"/>`;
  s += wash(20 + R() * 88, 16 + R() * 96, 42, '#e2d7bd', 0.30);
  s += wash(R() * 128, R() * 128, 34, '#fbf6ea', 0.34);
  for (let i = 0; i < 26; i++) {
    const x = R() * 128, y = R() * 128, l = 4 + R() * 12, an = R() * Math.PI;
    s += `<line x1="${f1(x)}" y1="${f1(y)}" x2="${f1(x + Math.cos(an) * l)}" y2="${f1(y + Math.sin(an) * l)}" stroke="#c3b493" stroke-opacity="0.10" stroke-width="0.5"/>`;
  }
  for (let i = 0; i < 90; i++) {
    s += `<rect x="${f1(R() * 128)}" y="${f1(R() * 128)}" width="0.9" height="0.9" fill="#a08f6d" fill-opacity="${(0.05 + R() * 0.07).toFixed(2)}"/>`;
  }
  return s;
}

/* ============================================================
 * 建筑构件笔法
 * ============================================================ */

/* 屋面: 正坡梯形 + 瓦垄 + 正脊(鸱吻) + 檐口反宇起翘
 *   cx 中线 · ridgeY 脊高 · ridgeHW 脊半宽 · eaveY 檐口高 · eaveHW 檐半宽 */
function roof(cx, ridgeY, ridgeHW, eaveY, eaveHW, o = {}) {
  const tip = o.tip == null ? 2.6 : o.tip;
  const cols = o.tiles == null ? 7 : o.tiles;
  const fy = o.fill || '#d7cfbd';
  const fa = o.fa == null ? 0.95 : o.fa;
  const uY = (t) => eaveY - Math.abs(t - 0.5) * tip * 1.4;
  const eL = [cx - eaveHW - tip, uY(0)], eR = [cx + eaveHW + tip, uY(1)];
  let s = '';
  let d = `M ${f1(cx - ridgeHW)} ${f1(ridgeY)} L ${f1(cx + ridgeHW)} ${f1(ridgeY)} L ${f1(eR[0])} ${f1(eR[1])}`;
  d += ` Q ${f1(cx + eaveHW * 0.5)} ${f1(eaveY + tip * 0.7)} ${f1(cx)} ${f1(eaveY + tip * 0.45)}`;
  d += ` Q ${f1(cx - eaveHW * 0.5)} ${f1(eaveY + tip * 0.7)} ${f1(eL[0])} ${f1(eL[1])} Z`;
  s += pathD(d, fy, fa);
  /* 瓦垄 */
  for (let i = 1; i <= cols; i++) {
    const t = i / (cols + 1);
    const xr = cx - ridgeHW + 2 * ridgeHW * t;
    const xe = cx - eaveHW + 2 * eaveHW * t + (t - 0.5) * tip * 1.1;
    s += `<line x1="${f1(xr)}" y1="${f1(ridgeY + 0.8)}" x2="${f1(xe)}" y2="${f1(uY(t) + 0.4)}" stroke="${INK4}" stroke-opacity="0.28" stroke-width="0.7"/>`;
  }
  /* 正脊 + 两端鸱吻 */
  s += stroke([[cx - ridgeHW - 1, ridgeY + 0.5], [cx + ridgeHW + 1, ridgeY + 0.5]], { w: 2.8, c: INK, a: 0.85, n: 2, fly: false, j: 0.45 });
  s += stroke([[cx - ridgeHW - 0.8, ridgeY + 0.8], [cx - ridgeHW - 2.8, ridgeY - 1.8], [cx - ridgeHW - 1.2, ridgeY - 3.2]], { w: 1.5, c: INK, a: 0.72, n: 1, fly: false, j: 0.35 });
  s += stroke([[cx + ridgeHW + 0.8, ridgeY + 0.8], [cx + ridgeHW + 2.8, ridgeY - 1.8], [cx + ridgeHW + 1.2, ridgeY - 3.2]], { w: 1.5, c: INK, a: 0.72, n: 1, fly: false, j: 0.35 });
  /* 檐口 (反宇) */
  s += stroke([eL, [cx - eaveHW * 0.5, eaveY + tip * 0.72], [cx, eaveY + tip * 0.48], [cx + eaveHW * 0.5, eaveY + tip * 0.72], eR],
    { w: 2.1, c: INK, a: 0.78, n: 2, fly: false, j: 0.55 });
  return s;
}

/* 屋身: 没骨铺面 + 双勾 (土墙/木构通用) */
function body(cx, topY, botY, halfW, o = {}) {
  const fill = o.fill || '#cbbfa6';
  const a = o.fa == null ? 0.9 : o.fa;
  const taper = o.taper == null ? 0.06 : o.taper;   // 上窄下宽
  const tw = halfW * (1 - taper);
  let s = face([[cx - tw, topY], [cx + tw, topY], [cx + halfW, botY], [cx - halfW, botY]], fill, a);
  /* 墙皮剥落: 干笔扫纹 */
  const n = o.peel == null ? 5 : o.peel;
  for (let i = 0; i < n; i++) {
    const y = topY + (botY - topY) * (0.2 + R() * 0.7);
    const x0 = cx - halfW * (0.2 + R() * 0.7), l = 6 + R() * 12;
    s += stroke([[x0, y], [x0 + l, y + (R() - 0.5) * 2.2]], { w: 1.0, c: INK3, a: 0.22 + R() * 0.16, n: 1, fly: false, j: 0.5 });
  }
  /* 双勾轮廓 (左轻右重 → 受光) */
  s += stroke([[cx - tw, topY], [cx - halfW, botY]], { w: 1.3, c: INK2, a: 0.42, n: 1, fly: false, j: 0.5 });
  s += stroke([[cx + tw, topY], [cx + halfW, botY]], { w: 1.5, c: INK, a: 0.62, n: 2, fly: false, j: 0.5 });
  return s;
}

/* 台基: 梯形石台 + 披麻皴 + 压顶线 */
function platform(cx, topY, halfW, h, o = {}) {
  const bHW = halfW + (o.spread == null ? 4 : o.spread);
  let s = face([[cx - halfW, topY], [cx + halfW, topY], [cx + bHW, topY + h], [cx - bHW, topY + h]], o.fill || '#c2b8a2', o.fa == null ? 0.92 : o.fa);
  s += stroke([[cx - halfW, topY], [cx + halfW, topY]], { w: 1.8, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  s += stroke([[cx - bHW, topY + h], [cx + bHW, topY + h]], { w: 1.4, c: INK3, a: 0.5, n: 2, fly: false, j: 0.6 });
  const n = o.cun == null ? 7 : o.cun;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x0 = cx - halfW + 2 * halfW * t;
    const x1 = cx - bHW + 2 * bHW * t;
    const len = 3 + R() * 6;
    s += stroke([[x0, topY + h * 0.15], [x1 - len * 0.4, topY + h * 0.8]], { w: 0.9, c: INK3, a: 0.20 + R() * 0.14, n: 1, fly: false, j: 0.6 });
  }
  return s;
}

/* 踏道 (石阶): 正面 3~5 级 */
function stairs(cx, topY, w, steps, h, o = {}) {
  let s = '';
  for (let i = 0; i < steps; i++) {
    const y = topY + h * (i + 1) / steps;
    const hw = w * (0.55 + 0.45 * (i + 1) / steps);
    s += stroke([[cx - hw, y], [cx + hw, y]], { w: 1.2, c: INK3, a: 0.45, n: 1, fly: false, j: 0.4 });
  }
  const bhw = w * (0.55 + 0.45);
  s += face([[cx - w * 0.55, topY], [cx + w * 0.55, topY], [cx + bhw, topY + h], [cx - bhw, topY + h]], o.fill || '#c8bda6', 0.55);
  return s;
}

/* 立柱: 中锋渴笔竖线 (柱头略粗) */
function columns(cx, topY, botY, xs, o = {}) {
  let s = '';
  for (const x of xs) {
    const x2 = cx + x;
    s += stroke([[x2, topY], [x2 + (R() - 0.5) * 0.6, (topY + botY) / 2], [x2, botY]],
      { w: o.w == null ? 2.0 : o.w, c: o.c || INK2, a: o.a == null ? 0.66 : o.a, n: 2, fly: false, j: 0.4 });
  }
  return s;
}

/* 门洞: 深墨矩形/券门 */
function doorway(cx, botY, w, h, o = {}) {
  const arch = o.arch;
  let s = '';
  if (arch) {
    s += pathD(`M ${f1(cx - w / 2)} ${f1(botY)} L ${f1(cx - w / 2)} ${f1(botY - h + w / 2)} A ${f1(w / 2)} ${f1(w / 2)} 0 0 1 ${f1(cx + w / 2)} ${f1(botY - h + w / 2)} L ${f1(cx + w / 2)} ${f1(botY)} Z`, o.c || INK, o.a == null ? 0.72 : o.a);
  } else {
    s += face([[cx - w / 2, botY], [cx + w / 2, botY], [cx + w / 2, botY - h], [cx - w / 2, botY - h]], o.c || INK, o.a == null ? 0.7 : o.a);
  }
  /* 门框 (双勾) */
  s += stroke([[cx - w / 2, botY], [cx - w / 2, botY - h], [cx + w / 2, botY - h], [cx + w / 2, botY]], { w: 1.3, c: CINNABAR, a: 0.6, n: 1, fly: false, j: 0.4 });
  return s;
}

/* 窗: 细笔双勾方格 */
function window_(cx, cy, w, h, o = {}) {
  let s = face([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], PAPER, 0.85);
  s += stroke([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]], { w: 1.05, c: INK2, a: 0.6, n: 1, fly: false, j: 0.3 });
  if (o.grid !== false) {
    s += stroke([[cx, cy - h / 2], [cx, cy + h / 2]], { w: 0.8, c: INK3, a: 0.42, n: 1, fly: false, j: 0.2 });
    s += stroke([[cx - w / 2, cy], [cx + w / 2, cy]], { w: 0.8, c: INK3, a: 0.42, n: 1, fly: false, j: 0.2 });
  }
  return s;
}

/* 幡旗: 杆 + 三角旗 */
function flag(x, botY, h, o = {}) {
  const c = o.c || CINNABAR;
  const w = o.w == null ? 9 : o.w;
  const y0 = botY - h;
  let s = stroke([[x, botY], [x + (R() - 0.5) * 1.2, y0]], { w: 1.5, c: INK2, a: 0.7, n: 2, fly: false, j: 0.4 });
  s += face([[x, y0], [x - w, y0 + 3], [x - w * 0.75, y0 + 7.5], [x, y0 + h * 0.42]], c, 0.55);
  s += stroke([[x, y0], [x - w, y0 + 3], [x - w * 0.75, y0 + 7.5]], { w: 1.0, c, a: 0.6, n: 1, fly: false, j: 0.3 });
  return s;
}

/* 炊烟/丹烟: 淡墨晕柱 */
function smoke(x, y, h, o = {}) {
  let s = '';
  const n = o.n == null ? 4 : o.n;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    s += wash(x + (R() - 0.5) * h * 0.34, y - h * t, h * (0.16 + R() * 0.1), o.c || INK4, (o.a == null ? 0.24 : o.a) * (1 - t * 0.6));
  }
  return s;
}

/* 灵光晕圈 */
function aura(cx, cy, r, c = SPIRIT, a = 0.24) {
  let s = wash(cx, cy, r, c, a);
  s += wash(cx, cy, r * 0.45, c, a * 0.9);
  return s;
}

/* 竹篱 */
function fence(x0, y0, x1, y1, o = {}) {
  let s = '';
  const n = o.n == null ? 7 : o.n;
  const ys = [y0, y1];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    s += stroke([[x, y], [x + (R() - 0.5) * 0.5, y - (o.h || 6)]], { w: 1.0, c: o.c || EARTH, a: 0.55, n: 1, fly: false, j: 0.4 });
  }
  s += stroke([[x0, y0 - (o.h || 6) * 0.75], [x1, y1 - (o.h || 6) * 0.75]], { w: 0.9, c: o.c || EARTH, a: 0.45, n: 1, fly: false, j: 0.4 });
  return s;
}

/* 朱砂印 (左下角落款, 增强"画"的辨识度) */
function seal(x, y, s = 9) {
  let out = `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(s)}" height="${f1(s)}" fill="${CINNABAR}" fill-opacity="0.78" rx="1"/>`;
  for (let i = 1; i < 2; i++) {
    const p = y + s * i / 2;
    out += `<line x1="${f1(x)}" y1="${f1(p)}" x2="${f1(x + s)}" y2="${f1(p)}" stroke="${PAPER}" stroke-opacity="0.85" stroke-width="1"/>`;
  }
  out += `<line x1="${f1(x + s / 2)}" y1="${f1(y)}" x2="${f1(x + s / 2)}" y2="${f1(y + s)}" stroke="${PAPER}" stroke-opacity="0.85" stroke-width="1"/>`;
  return out;
}

/* 树: 枯笔干 + 三色冠 (复用场景/林相) */
function tree(x, baseY, h, o = {}) {
  const c1 = o.c1 || '#3c5a38', c2 = o.c2 || '#547a44', c3 = o.c3 || '#7c9c58';
  const lean = (R() - 0.5) * 3;
  let s = stroke([[x, baseY], [x + lean * 0.5, baseY - h * 0.45], [x + lean, baseY - h * 0.85]], { w: 1.7, c: '#4a3c2a', a: 0.62, n: 2, fly: false, j: 0.5 });
  s += stroke([[x + lean * 0.3, baseY - h * 0.5], [x + lean * 0.3 + h * 0.14, baseY - h * 0.68]], { w: 1.0, c: '#4a3c2a', a: 0.42, n: 1, fly: false, j: 0.4 });
  const cy = baseY - h * 0.76, cr = h * 0.4;
  s += dots(x - cr * 0.34, cy + cr * 0.18, 12, c1, cr * 0.44);
  s += dots(x + lean * 0.7, cy - cr * 0.1, 11, c2, cr * 0.4, 5, 0.5);
  s += dots(x + cr * 0.3, cy - cr * 0.42, 8, c3, cr * 0.3, 4, 0.5);
  return s;
}

/* 正圆环 (水车轮/日晕) */
function ring(cx, cy, r, w, c, a) {
  return `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="none" stroke="${c}" stroke-opacity="${a}" stroke-width="${w}"/>`;
}

/* 水面 (石青淡晕 + 横波) */
function water(y, o = {}) {
  const w = o.w || 128;
  let s = '';
  s += wash(64, y + 6, 54, AZURE, 0.22);
  for (let i = 0; i < (o.n || 4); i++) {
    const yy = y + i * 3.6 + R() * 2, x0 = 6 + R() * 40, ww = 26 + R() * 44;
    s += stroke([[x0, yy], [x0 + ww * 0.5, yy - 1.4 - R()], [x0 + ww, yy]], { w: 1.1, c: AZURE, a: 0.3, n: 1, fly: false, j: 0.4 });
  }
  return s;
}

/* ============================================================
 * 26 种建筑
 * ============================================================ */

/* ---------- 核心建筑 (CORE_KIND) ---------- */

/* 官衙 — 三开间悬山官署, 朱门, 八字墙, 石狮 */
function guanYa() {
  let s = ground(64, 108, 46, 10, 0.22);
  s += body(64, 74, 100, 34, { fill: '#d3c8b0', peel: 4 });
  /* 两侧八字墙 */
  s += face([[30, 74], [22, 100], [16, 100], [26, 74]], '#c9bda4', 0.9);
  s += face([[98, 74], [106, 100], [112, 100], [102, 74]], '#c9bda4', 0.9);
  s += roof(64, 58, 12, 74, 36, { tiles: 9 });
  s += columns(64, 74, 100, [-28, -9, 9, 28], { w: 2.2 });
  s += doorway(64, 100, 13, 20, { c: '#5a2420', a: 0.8 });
  s += window_(44, 84, 9, 7); s += window_(84, 84, 9, 7);
  /* 匾额 */
  s += face([[54, 66], [74, 66], [74, 72], [54, 72]], '#3a3128', 0.72);
  s += stroke([[55.5, 68], [58, 71], [61, 67]], { w: 1.2, c: GAMBOGE, a: 0.75, n: 1, fly: false, j: 0.2 });
  s += stroke([[67, 68], [71, 71]], { w: 1.2, c: GAMBOGE, a: 0.75, n: 1, fly: false, j: 0.2 });
  /* 石狮 */
  s += dots(40, 100, 5, INK3, 2.4, 3, 0.6); s += dots(88, 100, 5, INK3, 2.4, 3, 0.6);
  s += platform(64, 100, 36, 8, { cun: 9 });
  s += stairs(64, 108, 16, 3, 0);
  return s;
}

/* 集市 — 三座高低席棚 + 朱幡 + 长案货担 */
function jiShi() {
  let s = ground(64, 108, 48, 10, 0.22);
  const shed = (cx, topY, hw, botY) => {
    let t = '';
    t += face([[cx - hw, topY + 6], [cx + hw, topY + 6], [cx + hw * 0.8, topY], [cx - hw * 0.8, topY]], '#ddd5c2', 0.95);
    t += stroke([[cx - hw, topY + 6], [cx + hw, topY + 6]], { w: 1.6, c: INK, a: 0.55, n: 1, fly: false, j: 0.5 });
    for (let k = -2; k <= 2; k++) t += stroke([[cx + k * hw * 0.32, topY + 1], [cx + k * hw * 0.38, topY + 6]], { w: 0.8, c: INK4, a: 0.3, n: 1, fly: false, j: 0.3 });
    t += columns(cx, topY + 6, botY, [-hw * 0.85, hw * 0.85], { w: 1.3, a: 0.5 });
    return t;
  };
  s += shed(40, 70, 18, 102);
  s += shed(70, 62, 22, 104);
  s += shed(98, 72, 14, 103);
  /* 长案 + 货担 */
  s += face([[30, 96], [56, 96], [56, 99], [30, 99]], EARTH, 0.6);
  s += stroke([[30, 96], [56, 96]], { w: 1.4, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += dots(40, 93, 6, GAMBOGE, 2.0, 4, 0.6);
  s += dots(48, 93, 4, CINNABAR, 1.8, 3, 0.5);
  s += face([[64, 100], [84, 100], [84, 103], [64, 103]], '#b79a6c', 0.6);
  /* 幡 */
  s += flag(24, 100, 30, { c: CINNABAR });
  s += flag(106, 102, 24, { c: '#3f5a6b' });
  return s;
}

/* 宗祠 — 牌坊 + 门屋 + 歇山主殿 + 香炉 */
function zongCi() {
  let s = ground(64, 110, 50, 10, 0.22);
  /* 主殿 (歇山: 下层腰檐 + 上层顶) */
  s += body(64, 80, 100, 30, { fill: '#d6cdb8', peel: 3 });
  s += roof(64, 70, 26, 80, 40, { tiles: 8, fill: '#cfc6b0' });
  s += roof(64, 52, 13, 68, 30, { tiles: 7 });
  s += columns(64, 80, 100, [-24, -13, 0, 13, 24], { w: 2.0 });
  s += doorway(64, 100, 12, 18, { c: '#5b2a20' });
  s += window_(42, 88, 8, 6); s += window_(86, 88, 8, 6);
  s += platform(64, 100, 34, 8, { cun: 8 });
  /* 门屋 (前) */
  s += body(64, 96, 108, 22, { fill: '#c9bda4', fa: 0.92, peel: 2 });
  s += roof(64, 88, 9, 96, 26, { tiles: 7, tip: 2.2 });
  s += doorway(64, 108, 10, 12, { c: '#5b2a20' });
  /* 门前牌坊 */
  s += columns(64, 74, 108, [-30, 30], { w: 2.2, c: INK, a: 0.72 });
  s += stroke([[30, 76], [98, 76]], { w: 2.6, c: INK, a: 0.72, n: 2, fly: false, j: 0.5 });
  s += stroke([[34, 71], [94, 71]], { w: 1.6, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += face([[58, 66], [70, 66], [70, 71], [58, 71]], '#3a3128', 0.7);
  /* 香炉 */
  s += face([[60, 104], [68, 104], [66, 100], [62, 100]], '#6b6250', 0.8);
  s += smoke(64, 99, 14, { a: 0.2, n: 3 });
  return s;
}

/* 祠堂 — 单进悬山 + 门楼 + 院中老树 */
function ciTang() {
  let s = ground(64, 108, 42, 9, 0.22);
  s += body(64, 78, 102, 26, { fill: '#d2c8b0', peel: 4 });
  s += roof(64, 60, 10, 78, 30, { tiles: 8 });
  s += columns(64, 78, 102, [-20, -7, 7, 20], { w: 2.0 });
  s += doorway(64, 102, 11, 19, { c: '#5b2a20' });
  s += window_(43, 88, 8, 6); s += window_(85, 88, 8, 6);
  s += platform(64, 102, 28, 7, { cun: 7 });
  /* 门楼 (左右矮墙 + 木柱) */
  s += face([[24, 88], [40, 88], [40, 106], [22, 106]], '#c6bba2', 0.85);
  s += face([[88, 88], [104, 88], [106, 106], [88, 106]], '#c6bba2', 0.85);
  s += stroke([[24, 88], [40, 88]], { w: 1.6, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += stroke([[88, 88], [104, 88]], { w: 1.6, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  /* 老树 */
  s += tree(104, 106, 46, { c1: '#3a5636', c2: '#547a44', c3: '#7c9c58' });
  return s;
}

/* 村口 — 老树 + 木牌坊 + 石敢当 + 矮土墙 */
function cunKou() {
  let s = ground(64, 108, 46, 9, 0.2);
  /* 土墙缺口 (两段) */
  s += face([[10, 92], [40, 90], [40, 104], [8, 104]], '#c9bda2', 0.85);
  s += stroke([[10, 92], [40, 90]], { w: 1.5, c: INK2, a: 0.55, n: 2, fly: false, j: 0.5 });
  s += face([[88, 90], [118, 92], [120, 104], [88, 104]], '#c9bda2', 0.85);
  s += stroke([[88, 90], [118, 92]], { w: 1.5, c: INK2, a: 0.55, n: 2, fly: false, j: 0.5 });
  /* 木牌坊 (缺口中) */
  s += columns(64, 72, 106, [-16, 16], { w: 2.2, c: INK, a: 0.75 });
  s += stroke([[42, 74], [86, 74]], { w: 2.4, c: INK, a: 0.75, n: 2, fly: false, j: 0.5 });
  s += stroke([[46, 69], [82, 69]], { w: 1.4, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += face([[58, 64], [70, 64], [70, 69], [58, 69]], '#3a3128', 0.7);
  /* 石敢当 */
  s += face([[46, 96], [52, 96], [52, 106], [46, 106]], '#8b8578', 0.85);
  /* 老槐树 */
  s += tree(104, 106, 56, { c1: '#3a5636', c2: '#527844', c3: '#7ba058' });
  s += tree(26, 104, 36, { c1: '#40583a', c2: '#587c46', c3: '#809c5c' });
  return s;
}

/* 宗门大殿 — 重檐歇山 + 大台基 + 双配殿 + 广场幡 */
function zongMenDian() {
  let s = ground(64, 112, 54, 11, 0.26);
  s += aura(64, 66, 46, SPIRIT, 0.16);
  /* 配殿 (左右) */
  s += body(26, 90, 104, 14, { fill: '#cdc3ac', peel: 3 });
  s += roof(26, 84, 5, 90, 17, { tiles: 5, tip: 1.8 });
  s += body(102, 90, 104, 14, { fill: '#cdc3ac', peel: 3 });
  s += roof(102, 84, 5, 90, 17, { tiles: 5, tip: 1.8 });
  /* 主殿: 腰檐 + 上层歇山顶 */
  s += body(64, 78, 104, 34, { fill: '#d8cfba', peel: 3 });
  s += roof(64, 68, 30, 78, 44, { tiles: 10, fill: '#cfc6b0', tip: 3.4 });
  s += roof(64, 46, 15, 64, 33, { tiles: 8, tip: 3.0 });
  s += columns(64, 78, 104, [-26, -13, 0, 13, 26], { w: 2.2 });
  s += doorway(64, 104, 14, 22, { c: '#57261f', a: 0.82 });
  for (const x of [-34, 34]) s += window_(64 + x, 90, 9, 7);
  s += platform(64, 104, 38, 8, { cun: 11 });
  /* 广场幡 (朱/青) */
  s += flag(16, 112, 34, { c: CINNABAR });
  s += flag(112, 112, 34, { c: CINNABAR });
  s += flag(34, 112, 26, { c: '#3f5a6b', w: 7 });
  s += flag(94, 112, 26, { c: '#3f5a6b', w: 7 });
  return s;
}

/* 祖师殿 — 单檐歇山深进深 + 丹墀香炉 + 背后淡灵峰 */
function zuShiDian() {
  let s = '';
  /* 背景灵峰 (淡墨, 交代"祖师"气场) */
  s += pathD('M 84 100 Q 100 52 112 62 Q 120 70 126 100 Z', INK5, 0.5);
  s += pathD('M 6 102 Q 22 62 34 74 Q 44 84 50 102 Z', INK5, 0.42);
  s += ground(64, 110, 46, 10, 0.24);
  s += body(64, 80, 104, 30, { fill: '#d5cbb4', peel: 3 });
  s += roof(64, 64, 28, 80, 38, { tiles: 9, fill: '#cec5af' });
  s += roof(64, 50, 12, 62, 26, { tiles: 6, tip: 2.2 });
  s += columns(64, 80, 104, [-22, -11, 0, 11, 22], { w: 2.0 });
  s += doorway(64, 104, 13, 20, { c: '#57261f' });
  s += platform(64, 104, 34, 8, { cun: 9 });
  /* 丹墀香炉 + 灵光 */
  s += face([[58, 104], [70, 104], [67, 98], [61, 98]], '#6b6250', 0.85);
  s += aura(64, 96, 18, CINNABAR, 0.16);
  s += smoke(64, 97, 18, { a: 0.2, n: 4 });
  s += aura(64, 72, 40, SPIRIT, 0.14);
  return s;
}

/* ---------- 灵脉地皮 ---------- */

/* 灵枢殿 — 高台重檐 + 宝顶 + 灵光晕圈 + 石栏 */
function lingShuDian() {
  let s = '';
  s += aura(64, 62, 52, SPIRIT, 0.26);
  s += ground(64, 110, 46, 10, 0.24);
  s += body(64, 76, 100, 26, { fill: '#d9d0bd', peel: 3 });
  s += roof(64, 66, 24, 76, 34, { tiles: 8, fill: '#cfc6b0', tip: 3.0 });
  s += roof(64, 48, 11, 62, 24, { tiles: 6, tip: 2.6 });
  /* 宝顶 */
  s += stroke([[64, 46], [64, 40]], { w: 2.0, c: INK, a: 0.7, n: 1, fly: false, j: 0.3 });
  s += dots(64, 37, 6, SPIRIT, 2.2, 3.2, 0.6);
  s += wash(64, 36, 11, SPIRIT, 0.34);
  /* 石栏 (台下) */
  for (let i = 0; i < 9; i++) {
    const x = 36 + i * 7;
    s += stroke([[x, 108], [x, 103]], { w: 1.0, c: INK4, a: 0.45, n: 1, fly: false, j: 0.3 });
  }
  s += stroke([[36, 103.5], [93, 103.5]], { w: 1.2, c: INK3, a: 0.45, n: 1, fly: false, j: 0.4 });
  s += columns(64, 76, 100, [-18, -6, 6, 18], { w: 2.0 });
  s += doorway(64, 100, 12, 20, { c: '#4a3a5c', a: 0.75 });
  s += platform(64, 100, 30, 8, { cun: 9 });
  /* 灵脉符纹星点 */
  s += dots(64, 60, 16, SPIRIT, 1.4, 40, 0.5);
  return s;
}

/* 聚灵阵 — 俯视符阵: 同心环 + 六角石桩 + 中心灵柱 */
function juLingZhen() {
  let s = '';
  s += aura(64, 74, 46, SPIRIT, 0.24);
  s += ground(64, 100, 40, 14, 0.22);
  /* 同心环 (用多边形近似六边形环, 与「六边形格」世界呼应) */
  const ring = (r, a, w, c) => {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const an = (60 * i - 90) * Math.PI / 180;
      pts.push([64 + r * Math.cos(an), 78 + r * Math.sin(an) * 0.52]);
    }
    return stroke(pts, { w, c, a, n: 2, j: 0.8, fly: false });
  };
  s += ring(36, 0.5, 1.6, SPIRIT);
  s += ring(24, 0.42, 1.4, SPIRIT);
  s += ring(13, 0.5, 1.2, SPIRIT);
  /* 辐条 */
  for (let i = 0; i < 6; i++) {
    const an = (60 * i - 90) * Math.PI / 180;
    s += stroke([[64 + 13 * Math.cos(an), 78 + 13 * Math.sin(an) * 0.52],
                 [64 + 36 * Math.cos(an), 78 + 36 * Math.sin(an) * 0.52]], { w: 0.9, c: SPIRIT, a: 0.3, n: 1, fly: false, j: 0.4 });
  }
  /* 六角石桩 */
  for (let i = 0; i < 6; i++) {
    const an = (60 * i - 90) * Math.PI / 180;
    const x = 64 + 36 * Math.cos(an), y = 78 + 36 * Math.sin(an) * 0.52;
    s += face([[x - 4, y], [x + 4, y], [x + 3, y - 12], [x - 3, y - 12]], '#b7ae99', 0.9);
    s += stroke([[x - 4, y], [x - 3, y - 12], [x + 3, y - 12], [x + 4, y]], { w: 1.1, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
    s += dots(x, y - 14, 4, SPIRIT, 1.5, 2.6, 0.6);
  }
  /* 中心灵柱 */
  s += face([[59, 78], [69, 78], [67, 44], [61, 44]], '#c9c0ab', 0.9);
  s += stroke([[59, 78], [61, 44], [67, 44], [69, 78]], { w: 1.5, c: INK2, a: 0.6, n: 2, fly: false, j: 0.5 });
  s += stroke([[64, 44], [64, 30]], { w: 2.0, c: SPIRIT, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += wash(64, 40, 18, SPIRIT, 0.36);
  s += dots(64, 34, 12, SPIRIT, 1.6, 14, 0.55);
  return s;
}

/* 祭坛 — 三层方台 + 供案 + 双幡 */
function jiTan() {
  let s = '';
  s += aura(64, 74, 42, SPIRIT, 0.18);
  s += ground(64, 110, 44, 10, 0.22);
  s += platform(64, 96, 36, 7, { cun: 10 });
  s += platform(64, 88, 27, 8, { cun: 8 });
  s += platform(64, 78, 18, 10, { cun: 6 });
  /* 供案 */
  s += face([[54, 78], [74, 78], [74, 74], [54, 74]], '#9b8f76', 0.9);
  s += stroke([[54, 74], [74, 74]], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += dots(64, 71, 6, GAMBOGE, 1.8, 4, 0.6);
  s += face([[62, 74], [66, 74], [65, 68], [63, 68]], '#6b6250', 0.8);
  s += smoke(64, 68, 20, { a: 0.22, n: 4 });
  s += aura(64, 66, 22, CINNABAR, 0.14);
  /* 双幡 */
  s += flag(28, 106, 36, { c: CINNABAR, w: 8 });
  s += flag(100, 106, 36, { c: CINNABAR, w: 8 });
  return s;
}

/* 炼丹殿 — 单层殿 + 侧面丹炉 + 淡墨丹烟 */
function lianDanDian() {
  let s = ground(64, 106, 40, 9, 0.22);
  s += body(58, 80, 100, 22, { fill: '#d2c8b2', peel: 3 });
  s += roof(58, 64, 9, 80, 26, { tiles: 7 });
  s += columns(58, 80, 100, [-15, 0, 15], { w: 1.9 });
  s += doorway(58, 100, 11, 18, { c: '#4b3a2c' });
  /* 丹炉 (三足鼎) */
  s += face([[92, 100], [108, 100], [105, 84], [95, 84]], '#8d8267', 0.9);
  s += stroke([[95, 84], [92, 100]], { w: 1.2, c: INK2, a: 0.55, n: 1, fly: false, j: 0.4 });
  s += stroke([[105, 84], [108, 100]], { w: 1.2, c: INK2, a: 0.55, n: 1, fly: false, j: 0.4 });
  s += face([[90, 84], [110, 84], [108, 80], [92, 80]], '#a1957a', 0.9);
  s += stroke([[90, 84], [110, 84]], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += stroke([[100, 80], [100, 76]], { w: 1.4, c: INK2, a: 0.5, n: 1, fly: false, j: 0.3 });
  s += smoke(100, 74, 26, { a: 0.26, n: 5, c: INK4 });
  s += aura(100, 88, 16, CINNABAR, 0.2);
  s += platform(64, 100, 28, 7, { cun: 7 });
  return s;
}

/* 炼器殿 — 单层殿 + 侧作坊棚 + 铁砧 + 火星 */
function lianQiDian() {
  let s = ground(64, 106, 40, 9, 0.22);
  s += body(52, 80, 100, 20, { fill: '#cfc5ad', peel: 3 });
  s += roof(52, 65, 8, 80, 24, { tiles: 7 });
  s += columns(52, 80, 100, [-13, 0, 13], { w: 1.9 });
  s += doorway(52, 100, 10, 17, { c: '#43362a' });
  /* 作坊棚 (半开) */
  s += face([[74, 78], [112, 78], [106, 74], [80, 74]], '#dbd3c0', 0.95);
  s += stroke([[74, 78], [112, 78]], { w: 1.6, c: INK, a: 0.55, n: 1, fly: false, j: 0.5 });
  s += columns(93, 78, 102, [-16, 16], { w: 1.4, a: 0.5 });
  /* 炉 + 铁砧 */
  s += face([[78, 102], [90, 102], [88, 92], [80, 92]], '#7d7259', 0.9);
  s += aura(84, 96, 12, CINNABAR, 0.34);
  s += face([[96, 102], [110, 102], [108, 98], [98, 98]], '#6f6653', 0.9);
  s += stroke([[98, 98], [110, 98]], { w: 1.3, c: INK, a: 0.55, n: 1, fly: false, j: 0.4 });
  /* 火星 */
  s += dots(84, 88, 12, CINNABAR, 1.2, 9, 0.7);
  s += platform(56, 100, 26, 7, { cun: 6 });
  return s;
}

/* ---------- 水岸地皮 ---------- */

/* 码头 — 岸树 + 木栈桥入水 + 系船柱 + 双舟 */
function maTou() {
  let s = water(88, { n: 5 });
  /* 岸 (左上, 抬到画面中段) */
  s += face([[0, 60], [40, 56], [46, 86], [0, 92]], '#d6cbaa', 0.92);
  s += stroke([[0, 60], [40, 56]], { w: 1.5, c: INK2, a: 0.5, n: 2, fly: false, j: 0.6 });
  s += stroke([[40, 56], [46, 86], [0, 92]], { w: 1.4, c: INK3, a: 0.42, n: 2, fly: false, j: 0.7 });
  s += tree(20, 62, 40, { c1: '#3d5836', c2: '#557a44', c3: '#7e9e58' });
  /* 栈桥 (自岸伸向水中) */
  s += face([[42, 68], [112, 60], [114, 68], [44, 76]], '#c2b491', 0.95);
  s += stroke([[42, 68], [112, 60]], { w: 1.5, c: INK2, a: 0.55, n: 1, fly: false, j: 0.5 });
  s += stroke([[44, 76], [114, 68]], { w: 1.4, c: INK3, a: 0.5, n: 1, fly: false, j: 0.5 });
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const x = 44 + 68 * t, y = 68 - 8 * t;
    s += stroke([[x, y + 0.5], [x + 1.6, y + 9]], { w: 1.0, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  }
  /* 系船柱 + 缆 */
  for (const x of [56, 80, 104]) s += stroke([[x, 68 - (x - 44) * 0.11], [x, 58 - (x - 44) * 0.11]], { w: 1.7, c: EARTH, a: 0.72, n: 1, fly: false, j: 0.3 });
  s += stroke([[56, 58], [72, 74]], { w: 0.8, c: INK3, a: 0.4, n: 1, fly: false, j: 0.5 });
  /* 泊船 (系在桥下) */
  s += pathD('M 58 82 Q 74 90 90 80 Q 74 76 58 82 Z', '#a89066', 0.92);
  s += stroke([[58, 82], [90, 80]], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.3 });
  s += stroke([[74, 78], [76, 66]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  /* 远处小舟 */
  s += pathD('M 96 102 Q 106 106 116 100 Q 106 97 96 100 Z', '#b09a72', 0.8);
  /* 晒网 */
  s += stroke([[80, 58], [104, 60]], { w: 0.9, c: INK4, a: 0.4, n: 1, fly: false, j: 0.6 });
  for (let i = 0; i < 6; i++) s += stroke([[80 + i * 4, 58 + i * 0.4], [86 + i * 3.4, 66 + i * 0.4]], { w: 0.6, c: INK4, a: 0.28, n: 1, fly: false, j: 0.3 });
  return s;
}

/* 渔船坞 — 半开船棚 + 船架 + 倒扣船腹 */
function yuChuanWu() {
  let s = water(102, { n: 3 });
  s += ground(64, 106, 40, 8, 0.2);
  /* 船棚: 单坡 + 立柱 */
  s += face([[20, 76], [92, 82], [92, 78], [22, 70]], '#dcd4c1', 0.95);
  s += stroke([[22, 70], [92, 78]], { w: 1.8, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  s += stroke([[20, 76], [92, 82]], { w: 1.6, c: INK2, a: 0.55, n: 1, fly: false, j: 0.5 });
  for (let i = 0; i < 6; i++) {
    const x = 26 + i * 13;
    s += stroke([[x, 74 + i * 0.9], [x + 1, 78 + i * 0.9]], { w: 0.8, c: INK4, a: 0.3, n: 1, fly: false, j: 0.3 });
  }
  s += columns(64, 82, 106, [-36, -12, 12, 36], { w: 1.8, a: 0.55 });
  /* 船架 + 倒扣船腹 */
  s += face([[34, 104], [40, 96], [54, 90], [68, 96], [74, 104]], '#b09a72', 0.92);
  s += stroke([[34, 104], [40, 96], [54, 90], [68, 96], [74, 104]], { w: 1.6, c: INK, a: 0.62, n: 2, fly: false, j: 0.5 });
  s += stroke([[44, 99], [64, 99]], { w: 0.9, c: INK3, a: 0.35, n: 1, fly: false, j: 0.5 });
  /* 斜靠的桨 */
  s += stroke([[78, 106], [94, 84]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.4 });
  return s;
}

/* 渔亭 — 四角亭 + 礁石 + 挂网 */
function yuTing() {
  let s = water(100, { n: 3 });
  /* 礁石 */
  s += face([[30, 106], [42, 92], [52, 98], [58, 106]], '#a9a292', 0.9);
  s += stroke([[30, 106], [42, 92], [52, 98]], { w: 1.3, c: INK3, a: 0.5, n: 1, fly: false, j: 0.5 });
  s += face([[74, 108], [86, 96], [96, 104], [98, 108]], '#b0a998', 0.85);
  /* 亭: 攒尖顶 */
  s += pathD('M 64 58 L 92 80 Q 78 84 64 84 Q 50 84 36 80 Z', '#d8d0bd', 0.95);
  s += stroke([[64, 58], [92, 80], [64, 84], [36, 80], [64, 58]], { w: 1.6, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  /* 宝顶 */
  s += stroke([[64, 58], [64, 52]], { w: 1.6, c: INK, a: 0.6, n: 1, fly: false, j: 0.3 });
  s += dots(64, 50, 3, INK2, 1.6, 1.6, 0.6);
  /* 瓦垄 */
  for (let i = -3; i <= 3; i++) {
    s += stroke([[64 + i * 3.4, 60 + Math.abs(i) * 0.6], [64 + i * 4.6, 82 - Math.abs(i) * 0.9]], { w: 0.7, c: INK4, a: 0.3, n: 1, fly: false, j: 0.3 });
  }
  /* 四柱 */
  s += columns(64, 82, 100, [-20, 20], { w: 1.9 });
  s += stroke([[44, 82], [84, 82]], { w: 1.2, c: INK3, a: 0.45, n: 1, fly: false, j: 0.4 });
  /* 挂网 */
  s += stroke([[84, 84], [96, 100]], { w: 0.9, c: INK4, a: 0.45, n: 1, fly: false, j: 0.5 });
  for (let i = 0; i < 5; i++) s += stroke([[84 + i * 2.4, 84 + i * 3.2], [96 - i * 0.4, 92 + i * 0.6]], { w: 0.6, c: INK4, a: 0.3, n: 1, fly: false, j: 0.3 });
  return s;
}

/* ---------- 良田地皮 ---------- */

/* 农田 — 透视田块 + 纵横向垄 + 禾苗点 + 水光 (俯视微透视) */
function nongTian() {
  let s = '';
  s += ground(64, 106, 46, 11, 0.14);
  /* 田块外框 (左近右远的透视四边形) */
  const TL = [16, 70], TR = [112, 64], BR = [102, 103], BL = [24, 105];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  s += face([TL, TR, BR, BL], '#c6d29f', 0.82);
  s += wash(64, 88, 30, AZURE, 0.14);
  /* 横向垄线 (浅弧, 随透视收紧) */
  const ROWS = 7;
  for (let r = 1; r < ROWS; r++) {
    const t = r / ROWS;
    const a = lerp(TL, BL, t), b = lerp(TR, BR, t), m = lerp(a, b, 0.5);
    s += stroke([a, [m[0], m[1] + 1.5], b], { w: 1.1, c: '#9fae78', a: 0.5, n: 1, fly: false, j: 0.7 });
  }
  /* 纵向田埂 3 条, 把田分成 4 垄 */
  for (let c = 1; c < 4; c++) {
    const t = c / 4;
    s += stroke([lerp(TL, TR, t), lerp(BL, BR, t)], { w: 1.6, c: EARTH, a: 0.52, n: 1, fly: false, j: 0.6 });
  }
  /* 禾苗: 每垄按行密排短竖笔 */
  for (let r = 0; r < ROWS; r++) {
    const t0 = r / ROWS, t1 = (r + 1) / ROWS;
    for (let c = 0; c < 4; c++) {
      for (let k = 0; k < 4; k++) {
        const v = t0 + (t1 - t0) * ((k + 0.5) / 4);
        const p = lerp(lerp(TL, BL, v), lerp(TR, BR, v), (c + 0.5) / 4);
        s += stroke([[p[0], p[1] + 1.8], [p[0] + (R() - 0.5) * 2.6, p[1] - 3 - R() * 3.4]],
          { w: 1.05, c: JADE, a: 0.42 + R() * 0.22, n: 1, fly: false, j: 0.4 });
      }
    }
  }
  /* 田埂外圈 (最后压线, 让田块边界清楚) */
  s += stroke([TL, TR, BR, BL, TL], { w: 1.9, c: INK3, a: 0.52, n: 2, fly: false, j: 0.9 });
  /* 田边小路 + 零星草 */
  s += stroke([[16, 70], [8, 74], [4, 84]], { w: 1.2, c: EARTH, a: 0.4, n: 1, fly: false, j: 0.5 });
  for (let i = 0; i < 5; i++) {
    const x = 6 + R() * 14, y = 78 + R() * 18;
    s += stroke([[x, y], [x + (R() - 0.5) * 3, y - 4 - R() * 4]], { w: 0.9, c: JADE, a: 0.4, n: 1, fly: false, j: 0.4 });
  }
  s += dots(64, 86, 10, GAMBOGE, 1.2, 28, 0.3);
  return s;
}

/* 磨坊 — 立式水车 (轮辐式圆轮) + 茅顶小屋 + 引水槽 */
function moFang() {
  let s = water(98, { n: 4 });
  s += ground(56, 106, 38, 9, 0.2);
  /* 小屋 */
  s += body(42, 80, 102, 20, { fill: '#cbbfa2', peel: 4, taper: 0.08 });
  s += roof(42, 66, 8, 80, 24, { tiles: 6, fill: '#d3cab4' });
  s += doorway(42, 102, 10, 16, { c: '#4b3a2c' });
  s += window_(28, 90, 7, 6);
  /* 水车: 双圈轮辋 + 8 辐 + 外缘水斗 + 轮毂 */
  const wx = 90, wy = 84, wr = 21;
  s += ring(wx, wy, wr, 1.7, INK2, 0.6);
  s += ring(wx, wy, wr * 0.72, 1.0, INK3, 0.45);
  for (let i = 0; i < 8; i++) {
    const an = i / 8 * Math.PI * 2;
    s += stroke([[wx, wy], [wx + Math.cos(an) * wr * 0.72, wy + Math.sin(an) * wr * 0.72]],
      { w: 1.0, c: INK3, a: 0.45, n: 1, fly: false, j: 0.4 });
  }
  for (let i = 0; i < 12; i++) {
    const an = i / 12 * Math.PI * 2;
    s += stroke([[wx + Math.cos(an) * wr, wy + Math.sin(an) * wr],
                 [wx + Math.cos(an) * (wr + 4.2), wy + Math.sin(an) * (wr + 4.2)]],
      { w: 1.5, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.3 });
  }
  s += dots(wx, wy, 5, INK2, 1.6, 2.2, 0.6);
  /* 水花 */
  s += wash(wx, 104, 20, AZURE, 0.26);
  s += dots(wx, 102, 10, '#dfeaea', 1.2, 10, 0.5);
  /* 引水槽 */
  s += face([[52, 90], [70, 88], [70, 92], [52, 94]], '#c2b491', 0.85);
  s += stroke([[52, 90], [70, 88]], { w: 1.1, c: INK2, a: 0.45, n: 1, fly: false, j: 0.4 });
  /* 轮架 */
  s += stroke([[90, 105], [90, 88]], { w: 1.4, c: EARTH, a: 0.55, n: 1, fly: false, j: 0.4 });
  s += smoke(38, 64, 14, { a: 0.16, n: 3 });
  return s;
}

/* 谷仓 — 干栏高脚仓 + 圆锥茅顶 + 梯 + 圆锥粮囤 */
function guCang() {
  let s = ground(64, 108, 38, 9, 0.22);
  /* 高脚 (干栏) */
  s += columns(64, 96, 106, [-20, -7, 7, 20], { w: 1.8, a: 0.6, c: EARTH });
  s += stroke([[64 - 22, 102], [64 + 22, 102]], { w: 1.0, c: EARTH, a: 0.35, n: 1, fly: false, j: 0.5 });
  /* 仓身 */
  s += body(64, 74, 96, 24, { fill: '#cfc3a4', peel: 3, taper: 0.05 });
  s += stroke([[64, 88], [88, 88]], { w: 1.1, c: INK3, a: 0.4, n: 1, fly: false, j: 0.5 });
  s += face([[56, 90], [64, 90], [64, 82], [56, 82]], '#7a6042', 0.8);
  /* 圆锥茅顶 (矮阔, 出檐大) */
  s += pathD('M 64 50 L 98 78 Q 78 82 64 82 Q 50 82 30 78 Z', '#ddd5c2', 0.95);
  s += stroke([[64, 50], [98, 78]], { w: 1.5, c: INK, a: 0.55, n: 2, fly: false, j: 0.5 });
  s += stroke([[64, 50], [30, 78]], { w: 1.5, c: INK, a: 0.55, n: 2, fly: false, j: 0.5 });
  s += stroke([[30, 78], [46, 80.5], [64, 81.5], [82, 80.5], [98, 78]], { w: 1.7, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  /* 茅草散锋 */
  for (let i = 0; i < 16; i++) {
    const t = R();
    const x = 32 + 64 * t, y = 78 + Math.abs(t - 0.5) * 6;
    s += stroke([[x, y], [x + (R() - 0.5) * 3, y - 4 - R() * 7]], { w: 1.0, c: INK3, a: 0.34, n: 1, fly: false, j: 0.6 });
  }
  s += stroke([[64, 50], [64, 44]], { w: 1.5, c: INK, a: 0.6, n: 1, fly: false, j: 0.3 });
  /* 梯 */
  s += stroke([[92, 96], [104, 106]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  s += stroke([[88, 92], [100, 102]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  for (let i = 1; i < 4; i++) s += stroke([[92 + i * 3, 96 + i * 2.6], [88 + i * 3, 92 + i * 2.6]], { w: 0.8, c: EARTH, a: 0.45, n: 1, fly: false, j: 0.2 });
  /* 圆锥粮囤 (左下) */
  s += face([[12, 106], [34, 106], [32, 96], [14, 96]], '#c9b47f', 0.9);
  s += pathD('M 13 96 Q 23 84 33 96 Z', '#ddd5c2', 0.95);
  s += stroke([[13, 96], [23, 84], [33, 96]], { w: 1.3, c: INK2, a: 0.52, n: 2, fly: false, j: 0.4 });
  s += stroke([[14, 96], [32, 96]], { w: 1.1, c: INK3, a: 0.42, n: 1, fly: false, j: 0.4 });
  s += stroke([[23, 84], [23, 79]], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.3 });
  s += dots(23, 93, 5, GAMBOGE, 1.4, 4, 0.5);
  return s;
}

/* ---------- 矿脉地皮 ---------- */

/* 矿山 — 矿洞口 + 支撑木架 + 矿渣堆 + 镐 */
function kuangShan() {
  let s = ground(64, 108, 44, 10, 0.24);
  /* 山体断面 */
  s += pathD('M 12 106 Q 30 62 62 56 Q 86 52 104 66 Q 116 76 118 106 Z', '#b8b0a0', 0.95);
  s += wash(64, 78, 40, '#c4bcac', 0.3);
  /* 皴笔 */
  for (let i = 0; i < 14; i++) {
    const x = 22 + R() * 80, y = 64 + R() * 34;
    s += stroke([[x, y], [x - 5 - R() * 7, y + 6 + R() * 5]], { w: 1.0, c: INK3, a: 0.2 + R() * 0.16, n: 1, fly: false, j: 0.7 });
  }
  s += stroke([[12, 106], [40, 62], [64, 55], [96, 64], [118, 106]], { w: 1.8, c: INK, a: 0.55, n: 2, fly: false, j: 0.8 });
  /* 洞口 */
  s += pathD('M 48 106 L 48 84 Q 64 74 80 84 L 80 106 Z', INK, 0.82);
  s += stroke([[48, 106], [48, 84], [64, 74], [80, 84], [80, 106]], { w: 1.6, c: INK, a: 0.7, n: 2, fly: false, j: 0.5 });
  /* 支撑木架 */
  s += stroke([[48, 84], [80, 84]], { w: 2.0, c: EARTH, a: 0.72, n: 1, fly: false, j: 0.4 });
  s += stroke([[48, 86], [80, 86]], { w: 1.6, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += stroke([[44, 106], [44, 84]], { w: 1.8, c: EARTH, a: 0.7, n: 1, fly: false, j: 0.4 });
  s += stroke([[84, 106], [84, 84]], { w: 1.8, c: EARTH, a: 0.7, n: 1, fly: false, j: 0.4 });
  /* 矿渣堆 */
  s += face([[92, 106], [104, 92], [116, 106]], '#a79e8c', 0.9);
  s += dots(104, 100, 9, INK3, 1.6, 10, 0.4);
  /* 镐 */
  s += stroke([[28, 106], [40, 88]], { w: 1.4, c: EARTH, a: 0.65, n: 1, fly: false, j: 0.4 });
  s += stroke([[34, 86], [46, 92]], { w: 1.4, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
  /* 矿苗 (矿石高光) */
  s += dots(70, 90, 6, GAMBOGE, 1.4, 6, 0.45);
  return s;
}

/* 熔炉 — 高炉 + 烟囱 + 火光 + 炉渣 */
function rongLu() {
  let s = ground(64, 108, 40, 10, 0.26);
  /* 高炉本体 */
  s += pathD('M 40 106 L 44 72 Q 64 64 84 72 L 88 106 Z', '#a99b83', 0.95);
  s += stroke([[40, 106], [44, 72], [64, 64], [84, 72], [88, 106]], { w: 1.7, c: INK, a: 0.6, n: 2, fly: false, j: 0.6 });
  /* 炉口 (火光) */
  s += pathD('M 54 106 L 56 88 Q 64 84 72 88 L 74 106 Z', '#6b3a22', 0.9);
  s += aura(64, 98, 20, CINNABAR, 0.5);
  s += dots(64, 96, 14, '#e08040', 1.4, 8, 0.62);
  /* 烟囱 */
  s += face([[86, 106], [98, 106], [96, 60], [88, 60]], '#9d9078', 0.95);
  s += stroke([[88, 60], [96, 60], [98, 106], [86, 106]], { w: 1.4, c: INK2, a: 0.55, n: 2, fly: false, j: 0.5 });
  s += stroke([[86, 62], [98, 62]], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += smoke(92, 58, 30, { a: 0.3, n: 6, c: INK4 });
  /* 炉渣堆 */
  s += face([[22, 106], [34, 96], [44, 106]], '#8f8778', 0.85);
  s += dots(33, 102, 7, INK3, 1.5, 8, 0.4);
  return s;
}

/* ---------- 林地区皮 ---------- */

/* 伐木场 — 原木堆 + 棚架 + 锯木架 */
function faMuChang() {
  let s = ground(64, 108, 44, 10, 0.22);
  /* 棚架 */
  s += face([[16, 74], [70, 78], [70, 74], [18, 68]], '#dcd4c1', 0.95);
  s += stroke([[18, 68], [70, 74]], { w: 1.7, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  s += columns(43, 78, 106, [-25, 0, 25], { w: 1.8, a: 0.55 });
  /* 原木堆 (圆截面 + 侧线) */
  const log = (x, y, r) => {
    let t = `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" fill="#c0a780" fill-opacity="0.95"/>`;
    t += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r * 0.5)}" fill="none" stroke="${EARTH}" stroke-opacity="0.5" stroke-width="0.8"/>`;
    t += stroke([[x + r, y], [x + r, y]], { w: 0.5, c: INK3, a: 0.1, n: 1, fly: false, j: 0.1 });
    return t;
  };
  s += log(30, 96, 7); s += log(44, 96, 7); s += log(58, 96, 7);
  s += log(37, 84, 7); s += log(51, 84, 7);
  s += stroke([[23, 102], [65, 102]], { w: 1.4, c: INK2, a: 0.5, n: 1, fly: false, j: 0.6 });
  /* 锯木架 */
  s += stroke([[80, 106], [90, 92]], { w: 1.5, c: EARTH, a: 0.65, n: 1, fly: false, j: 0.4 });
  s += stroke([[104, 106], [94, 92]], { w: 1.5, c: EARTH, a: 0.65, n: 1, fly: false, j: 0.4 });
  s += face([[82, 92], [102, 92], [102, 96], [82, 96]], '#c0a780', 0.9);
  s += stroke([[82, 92], [102, 92]], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
  /* 斧 */
  s += stroke([[108, 106], [114, 94]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  s += face([[112, 94], [118, 90], [118, 96], [112, 97]], '#8b8578', 0.9);
  return s;
}

/* 药圃 — 畦垄 + 药草笔点 + 竹篱 */
function yaoPu() {
  let s = ground(64, 106, 46, 10, 0.14);
  /* 畦垄 (三列, 微透视) */
  for (let row = 0; row < 3; row++) {
    const y = 74 + row * 12;
    const hw = 30 + row * 5;
    s += stroke([[64 - hw, y - 8], [64 - hw + 4, y + 3]], { w: 1.3, c: INK3, a: 0.42, n: 1, fly: false, j: 0.5 });
    s += stroke([[64 + hw, y - 8], [64 + hw - 4, y + 3]], { w: 1.3, c: INK3, a: 0.42, n: 1, fly: false, j: 0.5 });
    for (let j = 0; j < 7; j++) {
      const t = (j + 0.5) / 7;
      const x = 64 - hw + 2 * hw * t;
      const yy = y + 2.6 * (1 - Math.abs(t - 0.5) * 0.4);
      s += dots(x, yy - 3, 5, JADE, 1.9, 3.2, 0.5);
      s += dots(x + 2, yy - 6, 3, '#8fae66', 1.5, 2.4, 0.42);
    }
  }
  /* 竹篱 (前景) */
  s += fence(16, 106, 112, 104, { n: 8, h: 7 });
  /* 一株药草特写 */
  s += stroke([[24, 100], [22, 88]], { w: 1.2, c: JADE, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += dots(22, 85, 7, '#8fae66', 2.2, 4, 0.55);
  s += dots(22, 85, 2, CINNABAR, 1.6, 3, 0.7);
  return s;
}

/* ---------- 灼壤地皮 ---------- */

/* 炼炉 — 圆穹砖窑 (弧顶) + 砖层弧 + 炉口大火 + 炭堆 */
function lianLu() {
  let s = ground(64, 108, 40, 10, 0.24);
  s += wash(64, 104, 46, '#c07a44', 0.16);
  /* 圆穹 (弧顶, 不同于焦炭窑的土馒头) */
  s += pathD('M 24 106 C 24 56 42 44 64 44 C 86 44 104 56 104 106 Z', '#b3a288', 0.95);
  s += stroke([[24, 106], [26, 74], [40, 50], [64, 44]], { w: 1.7, c: INK, a: 0.58, n: 2, fly: false, j: 0.7 });
  s += stroke([[104, 106], [102, 74], [88, 50], [64, 44]], { w: 1.7, c: INK, a: 0.58, n: 2, fly: false, j: 0.7 });
  /* 砖层弧 (三层, 明确是砖砌窑) */
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const y = 106 - 52 * t, hw = 30 * Math.sqrt(Math.max(0.08, 1 - t * t)) + 8;
    s += pathD(`M ${f1(64 - hw)} ${f1(y + 3)} Q 64 ${f1(y - 6)} ${f1(64 + hw)} ${f1(y + 3)}`, 'none', 0,
      `stroke="${INK4}" stroke-opacity="0.30" stroke-width="0.9"`);
  }
  /* 炉口 (大火, 拱形) */
  s += pathD('M 52 106 L 53 92 Q 64 84 75 92 L 76 106 Z', '#5e2c18', 0.92);
  s += aura(64, 96, 22, CINNABAR, 0.52);
  s += dots(64, 95, 14, '#e08a48', 1.4, 7, 0.62);
  s += stroke([[52, 106], [53, 92], [64, 85], [75, 92], [76, 106]], { w: 1.5, c: INK, a: 0.6, n: 2, fly: false, j: 0.5 });
  /* 烟 */
  s += smoke(64, 44, 28, { a: 0.26, n: 5, c: INK4 });
  /* 炭堆 */
  s += face([[96, 106], [106, 95], [118, 106]], '#7d7261', 0.9);
  s += dots(107, 100, 8, INK, 1.6, 8, 0.5);
  s += stroke([[96, 106], [106, 95], [118, 106]], { w: 1.1, c: INK3, a: 0.4, n: 1, fly: false, j: 0.5 });
  /* 铁钳 */
  s += stroke([[16, 106], [30, 92]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  return s;
}

/* 焦炭窑 — 低矮土馒头窑 (夯土横纹) + 闷烟 + 柴堆 (无明火) */
function jiaoTanYao() {
  let s = ground(64, 108, 42, 10, 0.2);
  s += wash(64, 106, 40, '#6f6552', 0.08);
  /* 土馒头: 低宽圆丘 (顶点比炼炉低 12px, 且无拱顶轮廓) */
  s += pathD('M 20 106 C 22 84 38 72 64 72 C 90 72 106 84 108 106 Z', '#b0996f', 0.95);
  /* 夯土横纹 (5 道, 越下越宽) */
  for (let i = 0; i < 5; i++) {
    const t = i / 6;
    const y = 76 + i * 6.2, hw = 26 * Math.sqrt(Math.max(0.1, 1 - t * t)) + 10;
    s += pathD(`M ${f1(64 - hw)} ${f1(y)} Q 64 ${f1(y - 4)} ${f1(64 + hw)} ${f1(y)}`, 'none', 0,
      `stroke="${INK3}" stroke-opacity="${(0.16 + R() * 0.12).toFixed(2)}" stroke-width="1.0"`);
  }
  s += stroke([[20, 106], [26, 86], [44, 74], [64, 72]], { w: 1.5, c: INK, a: 0.5, n: 2, fly: false, j: 0.7 });
  s += stroke([[108, 106], [102, 86], [84, 74], [64, 72]], { w: 1.5, c: INK, a: 0.5, n: 2, fly: false, j: 0.7 });
  /* 窑顶闷烟 (闷烧: 只冒烟不见火) */
  s += smoke(64, 70, 30, { a: 0.28, n: 6, c: INK4 });
  s += smoke(66, 72, 16, { a: 0.2, n: 3, c: INK4 });
  /* 窑门 (闷口, 无火光) */
  s += pathD('M 56 106 L 57 96 Q 64 92 71 96 L 72 106 Z', '#5b4b38', 0.85);
  s += stroke([[56, 106], [57, 96], [64, 93], [71, 96], [72, 106]], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
  /* 柴堆 (左下) */
  for (let i = 0; i < 8; i++) {
    const x = 8 + i * 3.0, y = 106 - i * 0.55;
    s += stroke([[x, y], [x + 13, y - 9]], { w: 1.9, c: '#8a6a46', a: 0.62, n: 1, fly: false, j: 0.4 });
  }
  s += stroke([[8, 106], [9, 96]], { w: 1.2, c: INK3, a: 0.4, n: 1, fly: false, j: 0.4 });
  s += dots(20, 99, 5, INK2, 1.4, 5, 0.4);
  return s;
}

/* ---------- 村落皮 ---------- */

/* 民房 — 两间茅屋前后错落 + 竹篱 + 晒竿 */
function minFang() {
  let s = ground(64, 108, 42, 9, 0.22);
  /* 后屋 */
  s += body(84, 82, 104, 18, { fill: '#cdc0a0', peel: 4, taper: 0.08 });
  s += roof(84, 68, 7, 82, 22, { tiles: 6, fill: '#d6cdb8' });
  s += doorway(84, 104, 9, 14, { c: '#4b3a2c' });
  s += window_(70, 92, 7, 6);
  /* 前屋 (略大) */
  s += body(40, 80, 106, 22, { fill: '#d2c6a6', peel: 4, taper: 0.08 });
  s += roof(40, 64, 8, 80, 26, { tiles: 7, fill: '#d8cfba' });
  s += doorway(40, 106, 10, 17, { c: '#4b3a2c' });
  s += window_(24, 90, 8, 6);
  /* 茅草散锋 (檐口) */
  for (let i = 0; i < 12; i++) {
    const x = 14 + R() * 52, y = 78 + R() * 2;
    s += stroke([[x, y], [x + (R() - 0.5) * 3, y + 4 + R() * 4]], { w: 1.0, c: INK3, a: 0.34, n: 1, fly: false, j: 0.6 });
  }
  /* 竹篱 + 晒竿 */
  s += fence(10, 106, 26, 104, { n: 5, h: 6 });
  s += stroke([[52, 98], [52, 84]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  s += stroke([[52, 88], [72, 86]], { w: 1.3, c: EARTH, a: 0.6, n: 1, fly: false, j: 0.3 });
  s += face([[56, 88], [66, 87], [66, 94], [56, 95]], '#9aa9b0', 0.6);
  s += smoke(84, 66, 14, { a: 0.16, n: 3 });
  return s;
}

/* 仓库 — 长条悬山房 + 门板 + 粮囤 */
function cangKu() {
  let s = ground(64, 108, 46, 10, 0.22);
  s += body(64, 76, 102, 34, { fill: '#cfc4a8', peel: 4, taper: 0.04 });
  s += roof(64, 58, 11, 76, 38, { tiles: 9, fill: '#d6cdb8' });
  s += columns(64, 76, 102, [-28, -14, 0, 14, 28], { w: 1.9 });
  /* 大仓门 (门板 + 横闩) */
  s += face([[52, 102], [76, 102], [76, 78], [52, 78]], '#7a6042', 0.9);
  s += stroke([[64, 102], [64, 78]], { w: 1.4, c: INK, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += stroke([[52, 88], [76, 88]], { w: 1.6, c: INK2, a: 0.6, n: 1, fly: false, j: 0.4 });
  s += stroke([[52, 78], [76, 78], [76, 102], [52, 102], [52, 78]], { w: 1.3, c: INK, a: 0.55, n: 1, fly: false, j: 0.4 });
  /* 粮囤 (两侧) */
  for (const x of [24, 104]) {
    s += face([[x - 9, 106], [x + 9, 106], [x + 7, 94], [x - 7, 94]], '#c9b47f', 0.9);
    s += pathD(`M ${f1(x - 9)} 94 Q ${f1(x)} 82 ${f1(x + 9)} 94 Z`, '#ddd5c2', 0.95);
    s += stroke([[x - 9, 94], [x, 82], [x + 9, 94]], { w: 1.2, c: INK2, a: 0.5, n: 1, fly: false, j: 0.4 });
    s += dots(x, 90, 5, GAMBOGE, 1.5, 4, 0.5);
  }
  /* 板车 */
  s += face([[80, 106], [94, 106], [94, 100], [80, 100]], '#a89066', 0.8);
  s += dots(84, 107, 2, INK2, 2.2, 2, 0.7); s += dots(90, 107, 2, INK2, 2.2, 2, 0.7);
  return s;
}

/* ============================================================
 * 建筑总表 — 与 mapgen.js 的 BUILDINGS + CORE_KIND 逐一对齐
 *   n = 三 seed ±360 格实测出现次数 (2026-09-13 verify/stats_buildings.mjs)
 * ============================================================ */
const BUILDS = [
  { id: 'guan_ya', name: '官衙', landuse: 'core:city', res: '—', n: 42, draw: guanYa, note: '城治所在, 三开间悬山官署' },
  { id: 'ji_shi', name: '集市', landuse: 'core:city|town', res: '—', n: 429, draw: jiShi, note: '席棚+朱幡+长案, 城镇中心' },
  { id: 'zong_ci', name: '宗祠', landuse: 'core:city', res: '—', n: 58, draw: zongCi, note: '牌坊+门屋+歇山主殿' },
  { id: 'ci_tang', name: '祠堂', landuse: 'core:town|village', res: '—', n: 1008, draw: ciTang, note: '单进悬山+门楼+院中老树' },
  { id: 'cun_kou', name: '村口', landuse: 'core:village', res: '—', n: 651, draw: cunKou, note: '老树+木牌坊+石敢当+土墙缺口' },
  { id: 'zong_men_dadian', name: '宗门大殿', landuse: 'core:sect', res: '—', n: 187, draw: zongMenDian, note: '重檐歇山+大台基+配殿+广场幡' },
  { id: 'zu_shi_dian', name: '祖师殿', landuse: 'core:sect', res: '—', n: 176, draw: zuShiDian, note: '单檐歇山深进深+丹墀+背后灵峰' },

  { id: 'ling_shu_dian', name: '灵枢殿', landuse: '灵枢', res: '灵3', n: 137, draw: lingShuDian, note: '高台重檐+宝顶+灵光晕圈+石栏' },
  { id: 'ju_ling_zhen', name: '聚灵阵', landuse: '灵枢', res: '灵2', n: 127, draw: juLingZhen, note: '俯视符阵: 同心环+六角石桩+灵柱' },
  { id: 'ji_tan', name: '祭坛', landuse: '灵枢', res: '灵2', n: 116, draw: jiTan, note: '三层方台+供案+双幡' },
  { id: 'lian_dan_dian', name: '炼丹殿', landuse: '高阶灵地', res: '丹2', n: 1147, draw: lianDanDian, note: '单层殿+三足丹炉+淡墨丹烟' },
  { id: 'lian_qi_dian', name: '炼器殿', landuse: '高阶灵地', res: '器2', n: 1127, draw: lianQiDian, note: '单层殿+作坊棚+炉火火星' },

  { id: 'ma_tou', name: '码头', landuse: '水岸', res: '渔2', n: 901, draw: maTou, note: '木栈桥入水+系船柱+小舟' },
  { id: 'yu_chuan_wu', name: '渔船坞', landuse: '水岸', res: '渔2', n: 871, draw: yuChuanWu, note: '半开船棚+船架+倒扣船腹' },
  { id: 'yu_ting', name: '渔亭', landuse: '水岸', res: '渔1', n: 802, draw: yuTing, note: '四角攒尖亭+礁石+挂网' },

  { id: 'nong_tian', name: '农田', landuse: '良田', res: '粮2', n: 4076, draw: nongTian, note: '俯视田垄条格+水光+禾苗点' },
  { id: 'mo_fang', name: '磨坊', landuse: '良田', res: '粮3', n: 4084, draw: moFang, note: '立式水车+茅顶小屋+引水槽' },
  { id: 'gu_cang', name: '谷仓', landuse: '良田', res: '粮1', n: 4113, draw: guCang, note: '干栏高脚仓+圆锥茅顶+梯' },

  { id: 'kuang_shan', name: '矿山', landuse: '矿脉', res: '矿2', n: 1316, draw: kuangShan, note: '矿洞+支撑木架+矿渣堆+镐' },
  { id: 'rong_lu', name: '熔炉', landuse: '矿脉', res: '矿3', n: 1252, draw: rongLu, note: '高炉+烟囱+炉口火光' },

  { id: 'fa_mu_chang', name: '伐木场', landuse: '林地', res: '木2', n: 731, draw: faMuChang, note: '原木堆+棚架+锯木架+斧' },
  { id: 'yao_pu', name: '药圃', landuse: '林地', res: '木1·灵1', n: 736, draw: yaoPu, note: '畦垄+药草点+竹篱' },

  { id: 'lian_lu', name: '炼炉', landuse: '灼壤', res: '炭2', n: 37, draw: lianLu, note: '穹顶窑+砖层弧+火口+炭堆' },
  { id: 'jiao_tan_yao', name: '焦炭窑', landuse: '灼壤', res: '炭1·矿1', n: 44, draw: jiaoTanYao, note: '土馒头窑+闷烟+柴堆' },

  { id: 'min_fang', name: '民房', landuse: '村落', res: '—', n: 3593, draw: minFang, note: '两间茅屋错落+竹篱+晒竿' },
  { id: 'cang_ku', name: '仓库', landuse: '村落', res: '—', n: 3620, draw: cangKu, note: '长条悬山房+大仓门+粮囤' }
];

/* ---------- 产出 ---------- */
/* 单张 SVG 的 body 片段 (不含 XML 声明 / 不派命名空间), 供内联到 HTML 复用 */
function bodyOf(b, ns) {
  NS = ns; _gid = 0;
  R = mulberry32(0x5EED ^ b.id.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 7), 0));
  return paperBase() + b.draw() + seal(106, 110, 10);
}
function svgOf(b) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 128 128" shape-rendering="geometricPrecision">
${bodyOf(b, 'own_')}
</svg>
`;
}

function galleryHTML() {
  const rows = BUILDS.map((b, bi) => `
  <figure class="card">
    <div class="art"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" shape-rendering="geometricPrecision">${bodyOf(b, 'b' + bi + '_')}</svg></div>
    <figcaption><b>${b.name}</b><span class="lu">${b.landuse}</span><span class="res">${b.res}</span><span class="n">×${b.n}</span></figcaption>
    <div class="note">${b.note}</div>
  </figure>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>建筑水墨贴图总览</title>
<style>
 body{margin:0;padding:28px 32px 48px;background:#efe7d4;color:#3b352b;
      font:14px/1.6 "Noto Serif SC","Songti SC",serif}
 h1{font-size:22px;letter-spacing:.14em;margin:0 0 4px}
 .sub{color:#7c7261;margin-bottom:22px;font-size:13px}
 .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
 .card{margin:0;background:#f6f0e2;border:1px solid #ded3b8;border-radius:4px;
       padding:6px 6px 8px;box-shadow:0 1px 0 #e6dcc6 inset}
 .art{aspect-ratio:1/1;background:#f2ead8;border-radius:3px;overflow:hidden}
 .art svg{display:block;width:100%;height:100%}
 figcaption{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;margin-top:6px;font-size:13px}
 .lu,.res,.n{font-size:11px;color:#8a7f6b}
 .res{color:#7a6a45}
 .note{font-size:11px;color:#948a76;margin-top:2px;line-height:1.45}
</style></head><body>
<h1>建筑水墨贴图总览 · 26 种</h1>
<div class="sub">真源 mapgen.js 的 BUILDINGS + CORE_KIND；×N = 三 seed ±360 格实测出现次数。全部由 tools/ink_buildings.mjs 代码作画，无 AI 生图。</div>
<div class="grid">${rows}</div>
</body></html>
`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let n = 0;
for (const b of BUILDS) {
  fs.writeFileSync(path.join(OUT_DIR, b.id + '.svg'), svgOf(b), 'utf8');
  n++;
}
fs.writeFileSync(path.join(OUT_DIR, '建筑贴图总览.html'), galleryHTML(), 'utf8');

/* 契约自检: 数量与名称必须与 mapgen.js 完全一致 */
const mg = fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', 'mapgen.js'), 'utf8');
const names = new Set();
const mb = mg.match(/var BUILDINGS = \{([\s\S]*?)\n  \};/);
for (const m of mb[1].matchAll(/k:\s*'([^']+)'/g)) names.add(m[1]);
const mc = mg.match(/var CORE_KIND = \{([\s\S]*?)\n  \};/);
for (const m of mc[1].matchAll(/'([^']+)'/g)) names.add(m[1]);
const mine = new Set(BUILDS.map((b) => b.name));
const miss = [...names].filter((x) => !mine.has(x));
const extra = [...mine].filter((x) => !names.has(x));
console.log('生成 ' + n + ' 张 SVG + 1 张总览 → ' + OUT_DIR);
console.log('mapgen 建筑全集 ' + names.size + ' 种 · 本表 ' + mine.size + ' 种');
console.log('缺失: ' + (miss.length ? miss.join('、') : '无') + ' · 多余: ' + (extra.length ? extra.join('、') : '无'));
if (miss.length || extra.length) process.exit(1);
