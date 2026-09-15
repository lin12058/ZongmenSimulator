/* ============================================================
 * cdp_feat.mjs — 定点特性「验数 + 截图」。
 *
 * 为什么不用 cdp_screenshot.mjs:
 *   · 那个只等固定 9s 并抓一张图; 表现升级的开关 (匾额/云气) 需要
 *     **先等数据真到位再读运行期事实**, 否则读到的是空场景;
 *   · headless 下我(模型)看不了 PNG 像素, 只能靠 window.__feat() 的
 *     整数事实 (桥数/签数/虚线段数/让位裁掉多少精灵) 判定"到底生效没";
 *   · 小地图 rate limit 之类的无害 console 噪声要过滤, 只留异常。
 *
 * 用法: node verify/cdp_feat.mjs <url> <outPng> [waitMs]
 * 产出: <outPng> + 一行 JSON (FEAT ...)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL_ = process.argv[2];
const OUT = path.resolve(ROOT, process.argv[3] || 'verify/shot_feat.png');
const EXTRA_WAIT = +(process.argv[4] || 1500);
if (!URL_) { console.error('用法: node verify/cdp_feat.mjs <url> <outPng> [waitMs]'); process.exit(2); }

const PORT = 9400 + Math.floor(Math.random() * 500);
const profile = path.join(process.env.TEMP || 'C:/Windows/Temp', `wb-feat-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const chrome = path.join(process.env.USERPROFILE || process.env.HOME,
  'AppData/Local/Google/Chrome/Application/chrome.exe');
const args = [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1500,950', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, 'about:blank',
];
const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });

const watchdog = setTimeout(() => {
  console.error('[feat] 超时: 15s 未收到 DevTools listening');
  try { proc.kill(); } catch { /* noop */ }
  process.exit(2);
}, 15000);
watchdog.unref();

let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });
let launched = false;
function onLine(s) {
  if (!launched && s.includes('DevTools listening')) { launched = true; resolveReady(); }
}
proc.stdout.on('data', (d) => onLine(d.toString()));
proc.stderr.on('data', (d) => onLine(d.toString()));

function killChrome() {
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill(); } catch { /* noop */ } }
}
/* 硬看门狗: 页面/JS 线程一旦卡死, Runtime.evaluate 永不回 ⇒ 脚本会静默挂住
   (实测挂 6 分钟无输出)。这里 100s 一律判死并留下阶段日志, 便于定位卡在哪一步。 */
const stage = { at: 'start' };
const HARD = setTimeout(() => {
  console.error('[feat] 硬超时 100s, 卡在: ' + stage.at);
  killChrome();
  process.exit(9);
}, 100000);
HARD.unref();

await ready;
clearTimeout(watchdog);
stage.at = 'chrome-ready';
console.log('[feat] chrome ready, port ' + PORT);
await new Promise((r) => setTimeout(r, 400));

let tabs = null;
/* ⚠ /json 偶尔返回非数组 (并发起多个 Chrome 时命中半启动状态/错误体),
   直接 .find() 会 TypeError → 整个截图任务夭折。改成「两个 host × /json 与
   /json/list 轮询到真数组为止」。 */
for (let i = 0; i < 40 && !Array.isArray(tabs); i++) {
  for (const host of ['127.0.0.1', 'localhost']) {
    for (const p of ['/json/list', '/json']) {
      try {
        const r = await fetch(`http://${host}:${PORT}${p}`);
        const j = await r.json();
        if (Array.isArray(j) && j.length) { tabs = j; break; }
      } catch { /* 端口未就绪, 继续 */ }
    }
    if (Array.isArray(tabs)) break;
  }
  if (!Array.isArray(tabs)) await new Promise((r) => setTimeout(r, 300));
}
if (!Array.isArray(tabs)) { console.error('[feat] 无法获取 /json 页面列表'); killChrome(); process.exit(2); }
stage.at = 'tabs-ok';
const tab = tabs.find((t) => t.type === 'page');
if (!tab) { console.error('[feat] 无 page tab'); killChrome(); process.exit(2); }
console.log('[feat] tabs ok, page=' + tab.url);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 0;
const pendings = new Map();
const evHandlers = [];
ws.onmessage = (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pendings.has(msg.id)) { const p = pendings.get(msg.id); pendings.delete(msg.id); p(msg); }
  for (const h of evHandlers) h(msg);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
stage.at = 'ws-open';
console.log('[feat] ws open');
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId; pendings.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const exceptions = [];
const interesting = [];

async function evalJs(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  return r && r.result && r.result.result ? r.result.result.value : undefined;
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');
  evHandlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const ed = m.params.exceptionDetails || {};
      exceptions.push((ed.exception && ed.exception.description) || ed.text || 'exception');
    } else if (m.method === 'Runtime.consoleAPICalled') {
      if (m.params.type !== 'error' && m.params.type !== 'warning') return;
      const a = m.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
      if (/rate limit/.test(a)) return;              // 小地图采样限流: 与本改动无关
      interesting.push(a);
    }
  });

  const loadP = new Promise((r) => {
    const h = (m) => { if (m.method === 'Page.loadEventFired') r(); };
    evHandlers.push(h);
  });
  stage.at = 'navigate';
  await send('Page.navigate', { url: URL_ });
  await loadP;
  stage.at = 'load-fired';
  console.log('[feat] page loaded');

  /* 等数据真到位: __feat 存在 + 至少 3 块 + 至少 1 个区域包 */
  let ready_ = false;
  const t0 = Date.now();
  stage.at = 'waiting-data';
  while (Date.now() - t0 < 30000) {
    const v = await evalJs(`(function(){try{ if(!window.__feat||!window.__data) return null;
      var d=window.__data(); if(!d||d.chunks<3||d.regions<1) return null; return d;}catch(e){return null;}})()`);
    if (v) { ready_ = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('[feat] dataReady=' + ready_ + ' after ' + (Date.now() - t0) + 'ms');
  stage.at = 'extra-wait';
  await new Promise((r) => setTimeout(r, EXTRA_WAIT));

  stage.at = 'evaluate';
  const feat = await evalJs('JSON.stringify(window.__feat ? window.__feat() : null)');
  const spots = await evalJs('JSON.stringify(window.__spots ? window.__spots() : null)');
  const fatal = await evalJs('/后端世界服务不可用/.test(document.body.innerText||"")');
  /* 2026-09-16: 右上角那排开关已收进设置弹窗 (齿轮) ⇒ HUD 只量齿轮与弹窗的几何。
     开关的**状态**不再住在按钮 class 里, 读 window.__feat().settingsStore (见 feat 段)。 */
  const hud = await evalJs(`(function(){var o=[];['btnGear','settingsWrap','settingsBox'].forEach(function(id){
      var el=document.getElementById(id); if(!el){o.push(id+':absent');return;}
      var r=el.getBoundingClientRect(); o.push(id+':'+Math.round(r.left)+','+Math.round(r.top)+','+Math.round(r.width)+','+Math.round(r.height)+(/\bhidden\b/.test(el.className)?'[hidden]':''));});
      return o.join(' ');})()`);

  stage.at = 'screenshot';
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result || !shot.result.data) { console.error('[feat] 截图失败'); killChrome(); process.exit(3); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));

  console.log('FEAT ' + JSON.stringify({
    url: URL_, png: OUT, bytes: fs.statSync(OUT).size, dataReady: ready_,
    fatalShown: !!fatal, hud: hud, feat: feat ? JSON.parse(feat) : null,
    spots: spots ? JSON.parse(spots) : null,
    exceptions: exceptions, consoleErrors: interesting
  }));
  ws.close(); killChrome(); process.exit(0);
}

main().catch((e) => { console.error('[feat] 异常', e); killChrome(); process.exit(1); });
