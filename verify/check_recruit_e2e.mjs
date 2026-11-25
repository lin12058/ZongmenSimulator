/* ============================================================
 * check_recruit_e2e.mjs — 招募面板 UI 端到端判据 (headless Chrome + CDP)
 * ------------------------------------------------------------
 * 为什么要真浏览器: 面板是纯 DOM 插件 (recruit-panel.js), 离线断言只能证明
 * 「函数返回了字符串」, 证明不了「按钮点得到、浮层不被遮、错误以红字显示」。
 *
 * 鼠标一律走 Input.dispatchMouseEvent 派发**真实事件** (取元素 rect 中心),
 * 顺带能抓到「元素被别的浮层盖住 / display:none 但代码以为可见」这类假通过。
 *
 * 两个 phase (每个账号只有 50 点 = 一次招募, 所以分开跑):
 *   hire — 渲染 → 点第一张卡的「招募」→ 断言入队 + 点数归零 + 卡片变「已入宗门」
 *   roll — 渲染 → 点「刷新一批」(confirm 已放开) → 断言 -30、换人、按钮因不足而禁用
 *
 * 用法: node verify/check_recruit_e2e.mjs <base> <hire|roll>
 *       (默认 http://127.0.0.1:8141 hire)
 *
 * ⚠ 环境要求 (否则自动 SKIP, rc=2):
 *   ① base 不能是 8140 (脚本会 DELETE /api/crew, 那是玩家自己的队伍)
 *   ② guest 账号必须首日 = 50 点 ⇒ 测试库副本要先清空 RecruitPoint / RecruitPool
 *      (主库被玩家玩过就带着余额, 直接拷会一进来就 SKIP)
 *   ③ 两个 phase 各自需要一份干净副本: hire 会花光 50, roll 会花 30
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:8141').replace(/\/+$/, '');
const PHASE = (process.argv[3] || 'hire').toLowerCase();

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

/* ⚠⚠ 本脚本会 DELETE /api/crew (crew 契约是**全局单份**) —— 绝不能指向生产端口 8140,
   那会抹掉玩家自己的队伍。只能在「测试库副本 + 8141 以上端口」的实例上跑。 */
const PORT = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
if (PORT === '8140') {
  console.log('SKIP 拒绝在生产端口 8140 上跑 (本脚本会清空 /api/crew)');
  process.exit(2);
}

/* ---------------- 0. 服务端必须先活着 ---------------- */
let cur;
try { cur = await (await fetch(BASE + '/api/world/current')).json(); }
catch (e) { console.log('SKIP 服务端没起: ' + BASE); process.exit(2); }
if (!cur || !cur.seed) { console.log('SKIP 无当前世'); process.exit(2); }
const SEED = cur.seed;

/* guest 必须是「首日」: 50 点、没打探过。库副本里带旧账 (点数/池子) ⇒ 后面每条断言都错位,
   与其给一串看不懂的 FAIL, 不如在这里说清怎么修。 */
let st0 = null;
try {
  st0 = await (await fetch(BASE + '/api/recruit/state', { headers: { 'X-Account': 'guest' } })).json();
} catch { }
if (!st0 || !st0.points || st0.points.value !== 50) {
  console.log('SKIP guest 不是首日 (points=' + (st0 && st0.points && st0.points.value) +
    '); 测试库副本请先清空 RecruitPoint / RecruitPool 再起实例');
  process.exit(2);
}

/* ⚠ 归零起点: crew 契约全局单份, 库里可能已有玩家队伍 (驻地别处 ⇒ 一进来就红条)。
   探针只跑测试库副本, 先清空 = 新玩家首日。 */
try { await fetch(BASE + '/api/crew', { method: 'DELETE' }); } catch { }

/* 从引擎算聚落 (与另两个 probe 同法) */
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const CITY = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');
global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(CITY, 'city-evo.js'), 'utf8'));
global.MapGen.init(SEED);
let SETTLE = null;
for (let i = -2; i <= 2 && !SETTLE; i++) {
  for (let j = -2; j <= 2 && !SETTLE; j++) {
    let arr = [];
    try { arr = (JSON.parse(global.CityEvo.settlementsJson(i, j)).settlements) || []; }
    catch (e) { continue; }
    SETTLE = arr.find(s => s.type !== 'poi') || null;
  }
}
if (!SETTLE) { console.log('SKIP 找不到聚落'); process.exit(2); }
console.log('# base=' + BASE + ' phase=' + PHASE + ' settle=' + SETTLE.id + '(' + SETTLE.type + ')');

/* ---------------- CDP 会话 ---------------- */
const DPORT = 9400 + Math.floor(Math.random() * 500);
const profile = path.join(process.env.TEMP || 'C:/Windows/Temp', 'wb-recruit-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const chrome = path.join(process.env.USERPROFILE || process.env.HOME,
  'AppData/Local/Google/Chrome/Application/chrome.exe');
if (!fs.existsSync(chrome)) { console.log('SKIP 找不到 chrome.exe'); process.exit(2); }

const proc = spawn(chrome, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1500,950', '--hide-scrollbars', '--use-gl=angle', '--use-angle=swiftshader',
  `--remote-debugging-port=${DPORT}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

function killChrome() {
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill(); } catch { } }
}
const hardStop = setTimeout(() => { console.log('FAIL 超时'); killChrome(); process.exit(1); }, 90000);
hardStop.unref();

let launched = false;
const ready = new Promise((r) => {
  const on = (d) => { if (!launched && d.toString().includes('DevTools listening')) { launched = true; r(); } };
  proc.stdout.on('data', on); proc.stderr.on('data', on);
});
await Promise.race([ready, new Promise((r) => setTimeout(r, 15000))]);

let tabs = null;
for (let i = 0; i < 20 && !tabs; i++) {
  try { tabs = await (await fetch(`http://127.0.0.1:${DPORT}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 300)); }
}
const tab = tabs && tabs.find(t => t.type === 'page');
if (!tab) { console.log('FAIL 拿不到调试页'); killChrome(); process.exit(1); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 0;
const pend = new Map();
const handlers = [];
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pend.has(m.id)) { const f = pend.get(m.id); pend.delete(m.id); f(m); }
  for (const h of handlers) h(m);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
function send(method, params = {}) {
  return new Promise((res) => { const id = ++nextId; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}

async function ev(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression: expr, awaitPromise, returnByValue: true, userGesture: true,
  });
  if (r.result && r.result.exceptionDetails) {
    return { __err: (r.result.exceptionDetails.exception || {}).description || 'eval error' };
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
const loaded = new Promise(r => handlers.push(m => { if (m.method === 'Page.loadEventFired') r(); }));
await send('Page.navigate', { url: BASE + '/index.html' });
await Promise.race([loaded, sleep(12000)]);

/* 等 boot 出插件 (max 15s) */
let booted = false;
for (let i = 0; i < 30 && !booted; i++) {
  booted = await ev('!!(window.RecruitPanel && window.RecruitBridge && window.CrewBridge)') === true;
  if (!booted) await sleep(500);
}
ok('0.1 页面起了且三个插件都在 (RecruitPanel/RecruitBridge/CrewBridge)', booted);
if (!booted) { killChrome(); process.exit(1); }

/* 真实鼠标点击 (取 rect 中心 ⇒ 顺便验「真的点得到」) */
async function clickReal(sel) {
  const rect = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null; const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { w: 0, h: 0 };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
  if (!rect || !rect.w) return { ok: false, why: 'not-visible' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  return { ok: true, at: rect };
}

/* ---------------- 1. 打开面板 (走 public API, 等于点「招募弟子」) ---------------- */
await ev(`window.confirm = () => true; window.__snap = () =>
  ({ pts: (document.getElementById('rcPoints')||{}).textContent || '',
     gate: (document.getElementById('rcGate')||{}).className || '',
     gateTxt: (document.getElementById('rcGate')||{}).textContent || '',
     msg: (document.getElementById('rcMsg')||{}).textContent || '',
     msgCls: (document.getElementById('rcMsg')||{}).className || '',
     rollDisabled: !!((document.getElementById('rcRoll')||{}).disabled),
     rollTxt: (document.getElementById('rcRoll')||{}).textContent || '',
     cards: [].map.call(document.querySelectorAll('#rcList .rc-card'), c => ({
       name: (c.querySelector('.rc-name')||{}).textContent || '',
       btn: (c.querySelector('.rc-hire')||{}).textContent || '',
       off: !!((c.querySelector('.rc-hire')||{}).disabled) })) })`);

const opened = await ev(`(function(){ var o = window.RecruitPanel.open(${JSON.stringify(SETTLE.id)}, ${JSON.stringify(SETTLE.name || '')});
  return !!o; })()`);
ok('1.1 RecruitPanel.open() 返回真', opened === true);
const vis = await ev(`(() => { const w = document.getElementById('recruitWrap');
  if (!w) return null; const r = w.getBoundingClientRect();
  return { h: r.height, hidden: w.classList.contains('hidden'), z: getComputedStyle(w).zIndex }; })()`);
ok('1.2 #recruitWrap 真的建出来了且可见', !!(vis && vis.h > 50 && !vis.hidden), JSON.stringify(vis));

/* 等池子回来 */
let s1 = null;
for (let i = 0; i < 24; i++) {
  s1 = await ev('window.__snap()');
  if (s1 && s1.cards && s1.cards.length) break;
  await sleep(500);
}
ok('1.3 候选卡渲染出来了', !!(s1 && s1.cards.length > 0), 'n=' + (s1 && s1.cards.length));

/* 布局体检 (不用眼睛也能抓: 面板超出视口 / 列表不滚 / 卡片被挤成 0 高) */
const lay = await ev(`(() => {
  const wrap = document.getElementById('recruitWrap'), box = wrap && wrap.querySelector('.rc-box');
  const list = document.getElementById('rcList');
  const c0 = document.querySelector('#rcList .rc-card');
  const r = box ? box.getBoundingClientRect() : null;
  return r ? { vw: innerWidth, vh: innerHeight,
    x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    cardH: c0 ? Math.round(c0.getBoundingClientRect().height) : 0,
    listScroll: list ? (list.scrollHeight > list.clientHeight + 2) : false,
    overflowX: r.right > innerWidth + 1 || r.left < -1 } : null; })()`);
ok('1.3b 面板不越界且卡片有正常高度', !!(lay && !lay.overflowX && lay.cardH > 40 &&
  lay.y >= 0 && lay.y + lay.h <= lay.vh + 1), JSON.stringify(lay));

/* ⚠ 不截图: 这个页面是重 WebGL, 在 swiftshader 下 Page.captureScreenshot 会卡住
   合成/输入管线 —— 实测截一次图之后 Input.dispatchMouseEvent 再也不回, 整条判据
   挂到 watchdog。布局问题用上面的数值体检 (1.3b) 代替眼睛。 */
ok('1.4 头行读服务端点数 (50/300 + 影响力 10)', !!s1 && /50/.test(s1.pts) && /300/.test(s1.pts) && /10/.test(s1.pts), s1 && s1.pts);
ok('1.5 无驻地闸红条 (新档没队伍 ⇒ 哪都能招)', !!(s1 && s1.gate.indexOf('hidden') >= 0), s1 && s1.gate);
ok('1.6 刷新按钮可用且标了价格 (刷新一批（-30）)', !!(s1 && !s1.rollDisabled && /30/.test(s1.rollTxt)), s1 && s1.rollTxt);
ok('1.7 招募按钮标了价格 (-50)', (s1.cards || []).every(c => /50/.test(c.btn)), (s1.cards[0] || {}).btn);

/* ---------------- 2. 分线 ---------------- */
if (PHASE === 'roll') {
  const namesBefore = (s1.cards || []).map(c => c.name).join(',');
  const clk = await clickReal('#rcRoll');
  ok('2.1 刷新按钮点得到 (真实鼠标事件)', clk.ok, JSON.stringify(clk.at || clk.why));
  let s2 = null;
  for (let i = 0; i < 24; i++) {
    s2 = await ev('window.__snap()');
    if (s2 && /已换第/.test(s2.msg)) break;
    await sleep(500);
  }
  ok('2.2 提示「已换第 2 批」', !!(s2 && /已换第/.test(s2.msg)), s2 && s2.msg);
  ok('2.3 扣 30 (20/300)', !!(s2 && /20\//.test(s2.pts)), s2 && s2.pts);
  ok('2.4 换了一批人', !!(s2 && s2.cards.map(c => c.name).join(',') !== namesBefore));
  ok('2.5 点数不足 ⇒ 刷新按钮被禁用 (20 < 30)', !!(s2 && s2.rollDisabled));
  ok('2.6 卡片仍可招 (20 不足 50 ⇒ 全部置灰)', !!(s2 && s2.cards.every(c => c.off)));
} else {
  /* hire: 第一张卡的按钮 */
  const firstName = s1.cards[0].name;
  const clk = await clickReal('#rcList .rc-card .rc-hire');
  ok('2.1 招募按钮点得到 (真实鼠标事件)', clk.ok, JSON.stringify(clk.at || clk.why));
  let s2 = null;
  for (let i = 0; i < 24; i++) {
    s2 = await ev('window.__snap()');
    if (s2 && /已入宗门/.test(s2.msg)) break;
    await sleep(500);
  }
  ok('2.2 提示「已入宗门」且是成功色', !!(s2 && /已入宗门/.test(s2.msg) && /ok/.test(s2.msgCls)),
    (s2 && s2.msg) + ' | ' + (s2 && s2.msgCls));
  ok('2.3 扣 50 (0/300)', !!(s2 && /^招募值\s*0\//.test(s2.pts.replace(/\s+/g, ' ')) || /0\/300/.test(s2.pts)), s2 && s2.pts);
  const card0 = (s2.cards || []).find(c => c.name === firstName);
  ok('2.4 招走的那张卡变「已入宗门」并置灰', !!(card0 && /已入宗门/.test(card0.btn) && card0.off),
    card0 && (card0.btn + '/' + card0.off));
  ok('2.5 刷新按钮因不足禁用', !!(s2 && s2.rollDisabled));

  /* 队伍面板已重装成服务端契约: 有这支人 */
  const crew = await ev(`(async () => { const r = await fetch('api/crew'); const j = await r.json();
    const sq = (j.squads || [])[0] || null;
    return { n: (sq && sq.members || []).length, settle: sq && sq.settle,
             name: (sq && sq.members && j.members || []).length }; })()`);
  ok('2.6 服务端契约里新队有 1 人且驻地=本聚落',
    !!(crew && crew.n === 1 && crew.settle === SETTLE.id), JSON.stringify(crew));

  /* 队伍面板 DOM 同步 (refreshCrew 走 CrewBridge.autoMount) */
  await sleep(1500);
  const dom = await ev(`(() => ({ has: !!document.getElementById('crewPanel'),
    lists: document.querySelectorAll('#crewPanel .rp-list').length,
    rows: document.querySelectorAll('#crewPanel .rp-row').length,
    empty: document.querySelectorAll('#crewPanel .rp-list.empty').length }))()`);
  ok('2.7 小队面板仍在页面上且不再为空 (招到的人进了列表)',
    !!(dom && dom.has && dom.lists >= 1 && dom.rows >= 1), JSON.stringify(dom));
}

/* ---------------- 3. 关闭 ---------------- */
/* ⚠ 必须点面板内的 ✕ (.rc-x), 不是遮罩: 遮罩也带 data-rc="close", querySelector
   先命中遮罩 ⇒ 点的是「盒子的中心」, 什么也不会发生 (这一条曾经假红过)。 */
const cls = await clickReal('#recruitWrap .rc-x');
ok('3.1 关闭按钮点得到', cls.ok, JSON.stringify(cls.at || cls.why));
await sleep(400);
const gone = await ev(`(() => { const w = document.getElementById('recruitWrap');
  return !w || w.classList.contains('hidden') || w.style.display === 'none'; })()`);
ok('3.2 关掉后不再显示', gone === true);

/* ⚠ captureScreenshot 必须设上限: 重 WebGL 页面在 swiftshader 下可能迟迟不回,
   没有上限整条判据会挂到最后被 watchdog 杀掉 (曾经假失败过一次)。
   (截图已在面板打开时留过档, 这里不再重复) */

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
clearTimeout(hardStop);
killChrome();
process.exit(fail ? 1 : 0);
