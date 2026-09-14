/* ============================================================
 * check_preview_draw.mjs — 预览页「渲染层」可执行回归
 *
 * 为什么需要它（2026-09-12 事故）：
 *   灵脉预览.html 的渲染层（第 4 个 <script> 块）此前**只有静态检查**
 *   （check_preview_* 只查语法 / DOM id / 引擎导出，从不执行 draw()）。
 *   于是 drawTownPlan() 里用了裸 W / H（它们是 draw() 的局部变量）这种
 *   引用错误可以一路发布出去 —— 症状极其误导：
 *     · 每次 draw() 在聚落循环里抛 ReferenceError → 后面的图层（建筑足迹 /
 *       中枢 / 边界圈 / 统计行 / 提示条）全都不画；
 *     · 地形「分帧构建」terrainPumpFrame 结尾要调 draw()，异常一抛，
 *       后面的 setTimeout(续帧) 就排不上 → 光栅永远停在第一片，
 *       表现为「地形只显示顶部一条」（只显示一半）。
 *
 *   本脚本用最小 DOM / Canvas 2D 桩把渲染层真正执行一遍，断言：
 *     ① 4 个脚本块语法 OK
 *     ② 加载（含首次 draw）不抛异常
 *     ③ 反复 draw() 不抛异常，且能跑到底（统计行被写）
 *     ④ cb_build 勾选时确实画出建筑（rect / fill 计数显著高于关闭）
 *     ⑤ 分帧泵在 draw() 抛异常时仍会续帧（注入异常，光栅最终仍能建完）
 *     ⑥ 每个勾选框都挂了 onchange（否则点了没反应）
 *
 * 用法: node verify/check_preview_draw.mjs
 * 退出码: 0 = 全过; 1 = 有失败
 * ============================================================ */
import fs from 'node:fs';

const html = fs.readFileSync('灵脉预览.html', 'utf8');
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.log('  ✘ ' + msg + (extra ? '   → ' + extra : '')); }
}

/* ---------------- 脚本块 ---------------- */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log('== 1) 脚本块 ==');
ok(blocks.length === 4, `脚本块数 = ${blocks.length} (应为 4: noise / config / mapgen / 渲染)`);
blocks.forEach((b, i) => {
  let e = null;
  try { new Function(b); } catch (err) { e = err; }
  ok(!e, `块${i + 1} 语法 OK (len=${b.length})`, e && e.message);
});
if (blocks.length !== 4) process.exit(1);

/* ---------------- HTML 里的元素属性 ---------------- */
const attrs = new Map();
for (const m of html.matchAll(/<([a-zA-Z]+)\b([^>]*\bid="([A-Za-z0-9_]+)"[^>]*)>/g)) {
  const [, tag, rest, id] = m;
  const get = (k) => { const r = new RegExp('\\b' + k + '="([^"]*)"').exec(rest); return r ? r[1] : undefined; };
  attrs.set(id, {
    tag, value: get('value'), min: get('min'), max: get('max'),
    checked: /\bchecked\b/.test(rest),
  });
}

/* ---------------- Canvas 2D 桩 ---------------- */
const CTX_NAMES = [
  'save', 'restore', 'setTransform', 'clearRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'rect', 'quadraticCurveTo', 'setLineDash', 'fillRect', 'fillText', 'strokeText',
  'clip', 'translate', 'scale', 'rotate', 'fill', 'stroke', 'drawImage', 'putImageData',
  'createRadialGradient', 'createLinearGradient', 'createImageData', 'getImageData', 'measureText',
];
function mkCtx() {
  const st = { calls: {}, throwOn: null };
  const o = { __st: st };
  CTX_NAMES.forEach((name) => {
    o[name] = function () {
      st.calls[name] = (st.calls[name] || 0) + 1;
      if (st.throwOn === name) throw new Error('注入异常: ctx.' + name);
      if (name === 'createRadialGradient' || name === 'createLinearGradient') return { addColorStop() {} };
      if (name === 'createImageData' || name === 'getImageData') {
        const w = arguments[0] | 0, h = arguments[1] | 0;
        return { width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) };
      }
      if (name === 'measureText') return { width: 0 };
      return undefined;
    };
  });
  return o;
}
function resetCtx(ctx) { ctx.__st.calls = {}; ctx.__st.throwOn = null; }
function nCalls(ctx, n) { return ctx.__st.calls[n] || 0; }

/* ---------------- DOM 桩 ---------------- */
const els = new Map();
function mkEl(id, a) {
  a = a || { tag: 'div' };
  const el = {
    id, tagName: (a.tag || 'div').toUpperCase(),
    value: a.value !== undefined ? a.value : (a.tag === 'input' ? '' : ''),
    checked: !!a.checked,
    min: a.min, max: a.max,
    textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, children: [], _handlers: {},
    clientWidth: 1400, clientHeight: 860, width: 1400, height: 860,
    offsetWidth: 1400, offsetHeight: 860,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(t, f) { (el._handlers[t] = el._handlers[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 1400, bottom: 860, width: 1400, height: 860 }; },
    getContext() { return el.__ctx || (el.__ctx = mkCtx()); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, blur() {}, click() {},
  };
  el.__ctx = null;
  return el;
}
const documentStub = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, mkEl(id, attrs.get(id)));
    return els.get(id);
  },
  createElement(tag) { return mkEl('', { tag }); },
  addEventListener() {}, removeEventListener() {},
  body: null, documentElement: null,
};
documentStub.body = mkEl('body', { tag: 'body' });
documentStub.documentElement = documentStub.body;

/* 定时器桩：不真跑，可手动泵，能数「还排着几轮」 */
const timers = [];
function timerPending() { return timers.filter((t) => !t.run && !t.dead).length; }
function runNextTimer() {
  const t = timers.find((x) => !x.run && !x.dead);
  if (!t) return null;
  t.run = true;
  try { t.fn(); } catch (e) { return e; }
  return null;
}
function drainTimers(max) {
  let errs = 0;
  for (let i = 0; i < max; i++) {
    if (!timerPending()) break;
    if (runNextTimer()) errs++;
  }
  return errs;
}

/* ---------------- 装上下文并执行 ---------------- */
const winHandlers = {};
const g = global;
g.window = g;
g.document = documentStub;
g.devicePixelRatio = 1;
g.innerWidth = 1400; g.innerHeight = 900;
g.addEventListener = (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); };
g.removeEventListener = () => {};
g.alert = () => {};
g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
/* Node 22 的 navigator 是只读 getter，必须 defineProperty 覆盖（不需要就跳过） */
try { Object.defineProperty(g, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch (e) { /* noop */ }
g.location = { href: 'file:///preview', search: '', hash: '' };
g.setTimeout = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };
g.clearTimeout = (id) => { if (id > 0 && timers[id - 1]) timers[id - 1].dead = true; };
g.requestAnimationFrame = (fn) => { timers.push({ fn, ms: 16 }); return timers.length; };
g.cancelAnimationFrame = () => {};

/* 引擎三块（与 check_preview_settle_road 同法：window 指回 global） */
(0, eval)(blocks[0] + '\n' + blocks[1] + '\n' + blocks[2]);
/* 固定种子（避免每次跑两个不同的世界） */
g.document.getElementById('seed').value = 'PREVIEWDRAW';

/* 渲染块：注入探针（放在 'use strict' 之后，用 getter 保证即使加载中途抛异常也能取到） */
{
  const key = "'use strict';";
  const i = blocks[3].indexOf(key);
  if (i < 0) { console.log('✘ 渲染块未找到 use strict 锚点'); process.exit(1); }
  const hook = `
window.__api = {
  get draw(){ return draw; }, get cbs(){ return cbs; },
  get townN(){ return townLocal.size; },
  /* 摆相机：屏幕 = wrap/2 + 世界*scale + cam */
  setView: function (s, wx, wy) { scale = s; camX = -(wx || 0) * s; camY = -(wy || 0) * s; },
  /* 探针：记录 drawTownPlan 实际收到的「一格屏幕半径」。
     这是 2026-09-12「建筑墙」事故的契约点 —— 调用方曾误传群落格半径。 */
  probePlan: function (on) {
    if (on && !window.__planOrig) {
      window.__planPx = []; window.__planOrig = drawTownPlan;
      drawTownPlan = function (plan, sst, px) {
        window.__planPx.push(px);
        return window.__planOrig.apply(null, arguments);
      };
    } else if (!on && window.__planOrig) { drawTownPlan = window.__planOrig; window.__planOrig = null; }
  },
  st: function(){ return { mode: terrainMode, lv: Object.keys(terrainLv),
    job: terrainJob ? (terrainJob.done + '/' + terrainJob.total) : 'null',
    builds: terrainBuilds, want: terrainWant, scale: scale }; }
};`;
  blocks[3] = blocks[3].slice(0, i + key.length) + hook + blocks[3].slice(i + key.length);
}

console.log('\n== 2) 加载渲染层（含首次 draw）==');
let loadErr = null;
try { (0, eval)(blocks[3]); } catch (e) { loadErr = e; }
ok(!loadErr, '加载 + 首次绘制不抛异常', loadErr && (loadErr.name + ': ' + loadErr.message));

const api = g.__api;
const cvCtx = documentStub.getElementById('cv').__ctx;
if (!api || !api.draw) {
  console.log('  ✘ 渲染层未暴露 draw（加载即中断），后续断言无法进行');
  fail++;
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
console.log('  状态: ' + JSON.stringify(api.st()));

console.log('\n== 3) 反复 draw() ==');
for (let k = 1; k <= 3; k++) {
  let e = null;
  try { api.draw(); } catch (err) { e = err; }
  ok(!e, `第 ${k} 次 draw() 不抛异常`, e && (e.name + ': ' + e.message));
}
ok(String(documentStub.getElementById('stats').innerHTML).indexOf('灵气边界') >= 0,
  'draw() 跑到底（统计行已写入）',
  'stats.innerHTML = ' + JSON.stringify(String(documentStub.getElementById('stats').innerHTML).slice(0, 60)));

console.log('\n== 4) 城镇足迹 / 建筑层 ==');
const HEX_R = g.MapGen.HEX_R;
const CL0 = +documentStub.getElementById('commCl').value;
let eOn = null, eOff = null, eZoom = null;
api.cbs.build.checked = false;
resetCtx(cvCtx);
try { api.draw(); } catch (e) { eOff = e; }
const rectOff = nCalls(cvCtx, 'rect'), fillOff = nCalls(cvCtx, 'fill');
api.probePlan(true);
api.cbs.build.checked = true;
resetCtx(cvCtx);
try { api.draw(); } catch (e) { eOn = e; }
const rectOn = nCalls(cvCtx, 'rect'), fillOn = nCalls(cvCtx, 'fill');
const pxSeen = g.__planPx || [];
api.probePlan(false);
ok(!eOff && !eOn, '开 / 关建筑层都不抛异常',
  (eOff || eOn) && ((eOff || eOn).name + ': ' + (eOff || eOn).message));
const s0 = api.st().scale;
const tilePxWant = HEX_R * s0, cellPxWant = HEX_R * CL0 * s0;
ok(pxSeen.length > 0, `drawTownPlan 被调用（${pxSeen.length} 个城镇）`);
ok(pxSeen.length > 0 && Math.abs(pxSeen[0] - tilePxWant) < 0.01,
  `传入的是一格【地块】屏幕半径 ${tilePxWant.toFixed(2)}px（不是群落格 ${cellPxWant.toFixed(1)}px）`,
  '实际收到 ' + pxSeen[0]);
ok(fillOn > fillOff, `默认视野下画出足迹底框 (fill ${fillOn} > ${fillOff})`);
ok(rectOn === rectOff,
  `默认视野(1 格 ≈ ${tilePxWant.toFixed(1)}px)只留足迹、不画建筑芯（避免 2px 噪点）`,
  `rect ${rectOn} vs ${rectOff}`);
/* 放大到 1 格 ≈ 7px：C1 起改画**真实建筑精灵**（bldg_ink.spriteOf → drawImage），
   不再是「六边格 + 方块芯」的示意图；tilePx ≥ SPRITE_MIN_PX(5) 触发。 */
api.setView(0.9, 0, 0);
resetCtx(cvCtx);
try { api.draw(); } catch (e) { eZoom = e; }
const imgZoom = nCalls(cvCtx, 'drawImage');
ok(!eZoom, '放大后 draw() 不抛异常', eZoom && (eZoom.name + ': ' + eZoom.message));
ok(imgZoom > 0, `放大到 1 格 ≈ ${(HEX_R * 0.9).toFixed(1)}px 时绘制真实建筑精灵 (drawImage ${imgZoom})`);
ok(api.townN > 0, `城镇足迹已生成 (townLocal = ${api.townN} 个)`);

console.log('\n== 5) 分帧泵抗异常（地形「只显示一半」的根因防线）==');
/* 注入：主画布 ctx.fill 一律抛异常 → 模拟渲染层某处再次写错。
   泵若把 draw() 放在 try/finally（或自行 catch）里续帧，光栅最终仍能建完；
   若直接让异常穿出去，续帧的 setTimeout 排不上 → 光栅永远停在第一片。 */
let firstErr = null;
try {
  drainTimers(6);
  resetCtx(cvCtx);
  cvCtx.__st.throwOn = 'fill';
  firstErr = runNextTimer();
  drainTimers(400);
} finally {
  cvCtx.__st.throwOn = null;
}
const st5 = api.st();
ok(st5.lv.length > 0,
  `draw() 抛异常时地形光栅仍建完 (缓存级 [${st5.lv.join(', ')}], 注入异常=${!!firstErr})`);
ok(timerPending() === 0, `泵已正常收尾（无残留定时器 = ${timerPending()}）`);
ok(st5.lv.indexOf('0') < 0, `没有 stepT=0 的畸形光栅级（[${st5.lv.join(', ')}]）`);

console.log('\n== 6) 勾选框接线 ==');
for (const id of ['cb_terrain', 'cb_comm', 'cb_vein', 'cb_name', 'cb_spirit', 'cb_grid',
  'cb_settle', 'cb_sname', 'cb_build', 'cb_trade']) {
  const el = documentStub.getElementById(id);
  ok(typeof el.onchange === 'function', `#${id} 已挂 onchange（点勾有反应）`);
}
ok(typeof documentStub.getElementById('cb_road').onchange === 'function', '#cb_road 已挂 onchange');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
console.log(fail === 0 ? '========== 全部通过 ==========' : '========== 有失败项 ==========');
process.exit(fail === 0 ? 0 : 1);
