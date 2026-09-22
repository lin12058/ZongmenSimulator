/* ============================================================
 * cdp_screenshot.mjs — 通过 Chrome DevTools Protocol 驱动 headless,
 * 等待 fetch + setTimeout 在真实时间中完成, 然后抓 screenshot。
 * 依赖: Node >= 22 全局内置 WebSocket (undici), 无需 node:ws / ws 包。
 *
 * 用法: node verify/cdp_screenshot.mjs [url]
 * 产出: verify/shot_live.png
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL = process.argv[2] ||
  'http://127.0.0.1:8140/index.html?seed=42&qt=0&rt=0&zm=2.5&nofade=1&capture=1';
const OUT = path.join(ROOT, 'verify', 'shot_live.png');
/* 动态调试端口, 避免上一次 Chrome 残留占用固定端口导致起不来 */
const PORT = 9333 + Math.floor(Math.random() * 300);

const profile = path.join(process.env.TEMP || 'C:/Windows/Temp', `wb-cdp-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const chrome = path.join(process.env.USERPROFILE || process.env.HOME,
  'AppData/Local/Google/Chrome/Application/chrome.exe');
const args = [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1500,950', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  'about:blank',
];
console.log('[cdp] 启动 Chrome:', chrome, 'port', PORT);
const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });

/* 看门狗: 15s 内收不到 DevTools listening 则判失败 */
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
  process.stderr.write('[chrome] ' + s);
  if (!launched && s.includes('DevTools listening')) { launched = true; resolveReady(); }
}
proc.stdout.on('data', (d) => onChromeLine(d.toString()));
proc.stderr.on('data', (d) => onChromeLine(d.toString()));

async function fetchJSON(u) {
  const r = await fetch(u);
  return r.json();
}

/* 结束前把 Chrome 进程树一并杀掉, 避免残留占用调试端口 */
function killChrome() {
  try {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { try { proc.kill(); } catch { /* noop */ } }
}

await readyPromise;
clearTimeout(watchdog);
await new Promise((r) => setTimeout(r, 500));
let tabs = null;
for (let i = 0; i < 15 && !tabs; i++) {
  try { tabs = await fetchJSON(`http://127.0.0.1:${PORT}/json`); }
  catch { await new Promise((r) => setTimeout(r, 400)); }
}
if (!tabs) { console.error('无法获取 /json 页面列表'); killChrome(); process.exit(2); }
const tab = tabs.find((t) => t.type === 'page');
if (!tab) { console.error('无 page tab'); killChrome(); process.exit(2); }
const wsUrl = tab.webSocketDebuggerUrl;
console.log('[cdp] 连接', wsUrl);

/* ---------- 极简 CDP 客户端 (EventTarget 风格, Node>=22 全局 WebSocket) ---------- */
const ws = new WebSocket(wsUrl);
let nextId = 0;
const pendings = new Map();
const evHandlers = [];
ws.onmessage = (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pendings.has(msg.id)) {
    const p = pendings.get(msg.id);
    pendings.delete(msg.id);
    p(msg);
  }
  for (const h of evHandlers) h(msg);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('WebSocket 连接失败: ' + wsUrl));
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    pendings.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  await send('Page.enable');
  await send('Runtime.enable');
  /* 订阅页面 console 与未捕获异常 */
  evHandlers.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const a = m.params.args.map((x) => x.value ?? x.description ?? '').join(' ');
      console.log('[page:log]', a);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const ed = m.params.exceptionDetails || {};
      console.log('[page:exc ]', ed.text, '|', (ed.exception && ed.exception.description) || '');
    }
  });
  const loadPromise = new Promise((r) => {
    const onMsg = (m) => {
      if (m.method === 'Page.loadEventFired') { r(); }
    };
    evHandlers.push(onMsg);
  });
  await send('Page.navigate', { url: URL });
  await loadPromise;
  console.log('[cdp] Page load 事件触发');

  /* 给前端 setTimeout(4000) + 区块 fetch 留足真实时间 */
  await new Promise((r) => setTimeout(r, 9000));
  const state = await send('Runtime.evaluate', {
    expression: `(async () => {
      let metaStatus = 'n/a';
      try { const r = await fetch('/api/map/meta'); metaStatus = r.status; }
      catch (e) { metaStatus = 'ERR:' + e.message; }
      return JSON.stringify({
        metaStatus: metaStatus,
        data: window.__data ? window.__data() : null,
        /* 本宗面板 (2026-09-23 十二版: 原「宗门录 + 择宗」整条闭环已下线)。
           未立宗 ⇒ 三项为 ''/0/0, 面板显示引导文案「尚未择地立宗」;
           立宗后口径与旧宗门录相同 (sec-name / kv / tag)。 */
        sectName: (document.querySelector('#sectBody .sec-name') || {}).textContent || '',
        sectRows: (document.querySelectorAll('#sectBody .kv') || []).length,
        sectTags: (document.querySelectorAll('#sectBody .tag') || []).length,
        /* HUD 几何: 面板错位/被压这类问题在缩放图上肉眼看不准, 直接报边框 */
        hud: (function () {
          var out = [];
          var ids = ['titleBox', 'sectBox', 'controls', 'minimapBox', 'info'];
          for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (!el) { out.push(ids[i] + ':absent'); continue; }
            var r = el.getBoundingClientRect();
            out.push(ids[i] + ':' + Math.round(r.left) + ',' + Math.round(r.top) +
                     ',' + Math.round(r.width) + ',' + Math.round(r.height));
          }
          return out.join(' ');
        })(),
        hasGl: !!document.querySelector('canvas'),
        fatalShown: /后端世界服务不可用/.test(document.body.innerText || ''),
        bodySnippet: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)
      });
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('[cdp] 页面状态 =>', state.result && state.result.result && state.result.result.value);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result || !shot.result.data) {
    console.error('[cdp] 截图失败', shot);
    killChrome();
    process.exit(3);
  }
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('[cdp] 截图落地:', OUT, fs.statSync(OUT).size, '字节');

  ws.close();
  killChrome();
  process.exit(0);
}

main().catch((e) => {
  console.error('[cdp] 异常', e);
  killChrome();
  process.exit(1);
});
