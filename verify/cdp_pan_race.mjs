/* ============================================================
 * cdp_pan_race.mjs — 复现/验证「个别色块无贴图」竞态 (待办/色块无贴图bug排查)
 *
 * 原理: 页面刚加载 (块请求在途) 时瞬移相机把初始块丢出视野窗口 →
 *       在途响应到达时被 keepChunk 丢弃 → 修复前 revs 残留 →
 *       移回后该块请求携带旧 lastRevs → 服务端缺省下发 → 块永久空白。
 * 验证: 往返 N 次后 chunkData 块数应等于静止基线 (无永久缺失块)。
 *
 * 用法: node verify/cdp_pan_race.mjs [still|pan]
 * 产出: verify/race_{mode}.png + 控制台计数
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODE = process.argv[2] || 'pan';
const OUT = path.join(ROOT, 'verify', `race_${MODE}.png`);
/* 调试端口防残留: 动态 */
const PORT = 9500 + Math.floor(Math.random() * 200);

/* 种子固定 + debug=1 暴露 __cam/__data; nofade 提速; qt/rt/zm 固定相机中心 */
const URL = 'http://127.0.0.1:8140/index.html?seed=20260909&debug=1&nofade=1&qt=0&rt=0&zm=2.5';

const profile = path.join(process.env.TEMP || 'C:/Windows/Temp', `wb-race-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const chrome = path.join(process.env.USERPROFILE || process.env.HOME,
  'AppData/Local/Google/Chrome/Application/chrome.exe');
const args = [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1500,950', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, 'about:blank',
];
console.log('[cdp] 模式 =', MODE, '| chrome port', PORT);
const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });

const watchdog = setTimeout(() => {
  console.error('[cdp] 超时: 15s 未收到 DevTools listening');
  try { proc.kill(); } catch { /* noop */ }
  process.exit(2);
}, 15000);
watchdog.unref();

let resolveReady;
const readyPromise = new Promise((r) => { resolveReady = r; });
let launched = false;
function onChromeLine(s) {
  if (!launched && s.includes('DevTools listening')) { launched = true; resolveReady(); }
}
proc.stdout.on('data', (d) => onChromeLine(d.toString()));
proc.stderr.on('data', (d) => onChromeLine(d.toString()));

async function fetchJSON(u) { const r = await fetch(u); return r.json(); }
function killChrome() {
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill(); } catch { /* noop */ } }
}

await readyPromise;
clearTimeout(watchdog);
await new Promise((r) => setTimeout(r, 500));
let tabs = null;
for (let i = 0; i < 15 && !tabs; i++) {
  try { tabs = await fetchJSON(`http://127.0.0.1:${PORT}/json`); }
  catch { await new Promise((r) => setTimeout(r, 400)); }
}
if (!tabs) { console.error('无法获取 /json'); killChrome(); process.exit(2); }
const tab = tabs.find((t) => t.type === 'page');
const wsUrl = tab.webSocketDebuggerUrl;

const ws = new WebSocket(wsUrl);
let nextId = 0;
const pendings = new Map();
const evHandlers = [];
const pageLogs = [];
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pendings.has(msg.id)) {
    const p = pendings.get(msg.id); pendings.delete(msg.id); p(msg);
  }
  for (const h of evHandlers) h(msg);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('WebSocket 连接失败'));
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pendings.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/* 在页面上下文执行表达式, 返回 value (awaitPromise) */
async function evalv(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    return 'EXC:' + ((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text);
  }
  return r.result && r.result.result ? r.result.result.value : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');
  evHandlers.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const ed = m.params.exceptionDetails || {};
      pageLogs.push('EXC:' + (ed.exception && ed.exception.description || ed.text));
    }
  });
  const loadPromise = new Promise((r) => {
    const h = (m) => { if (m.method === 'Page.loadEventFired') { r(); } };
    evHandlers.push(h);
  });
  await send('Page.navigate', { url: URL });
  await loadPromise;
  console.log('[cdp] load 完成');

  /* 等首块数据到达 (存在在途请求) */
  for (let i = 0; i < 30; i++) {
    const n = await evalv('window.__data ? window.__data().chunks : -1');
    if (n >= 1) break;
    await sleep(250);
  }

  if (MODE === 'pan') {
    const ROUNDS = 3;   // 3 次「拖走→回位」往返, 每次都在新块加载在途时触发
    for (let round = 1; round <= ROUNDS; round++) {
      /* 当前有块在加载途中 (并发槽 4), 先等 1~2 块在途再瞬移 */
      await sleep(400);
      /* 瞬移出窗口: 世界坐标 +6000 (≈几百块距离) */
      await evalv('window.__cam.tx = window.__cam.x = 6000; window.__cam.ty = window.__cam.y = 6000; true');
      await sleep(900);   // 让 updateStreaming 卸载 + 在途响应到达并进入丢弃分支
      /* 瞬移回原位 */
      await evalv('window.__cam.tx = window.__cam.x = 0; window.__cam.ty = window.__cam.y = 0; true');
      const n = await evalv('window.__data ? window.__data().chunks : -1');
      console.log(`[cdp] round ${round}: 拖走→回位, 当前 chunks=${n}`);
      await sleep(600);   // 给新窗口重载让路
    }
    /* 最终静止等加载收敛 */
    let last = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const d = await evalv('window.__data ? JSON.stringify(window.__data()) : null');
      let o = {}; try { o = JSON.parse(d); } catch { /* noop */ }
      if (o.chunks === last) { stable++; } else { stable = 0; last = o.chunks; }
      if (stable >= 6) break;   // 连续 3s 无变化 → 收敛
    }
    const final = await evalv('window.__data ? JSON.stringify(window.__data()) : null');
    console.log('[cdp] 往返后收敛 =>', final);
  } else {
    /* 静止基线: 不移动相机, 直接等收敛 */
    let last = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const d = await evalv('window.__data ? JSON.stringify(window.__data()) : null');
      let o = {}; try { o = JSON.parse(d); } catch { /* noop */ }
      if (o.chunks === last) { stable++; } else { stable = 0; last = o.chunks; }
      if (stable >= 6) break;
    }
    const final = await evalv('window.__data ? JSON.stringify(window.__data()) : null');
    console.log('[cdp] 静止基线收敛 =>', final);
  }

  console.log('[cdp] 页面异常:', pageLogs.length ? pageLogs : '(无)');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log('[cdp] 截图:', OUT, fs.statSync(OUT).size, '字节');
  }

  ws.close();
  killChrome();
  process.exit(0);
}

main().catch((e) => {
  console.error('[cdp] 异常', e);
  killChrome();
  process.exit(1);
});
