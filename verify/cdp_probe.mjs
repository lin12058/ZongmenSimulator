/* ============================================================
 * cdp_probe.mjs — 不抓图, 只采样页面渲染像素与 atlas 源像素,
 * 用于定位 "陆面 base 渲染为黑" 的根因 (atlas 0 / shader 0 / FBO 0)。
 * 用法: node verify/cdp_probe.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const URL2 = 'http://127.0.0.1:8140/index.html?seed=42&qt=10&rt=5&zm=2.5&nofade=1';
const PORT = 9400 + Math.floor(Math.random() * 300);
const profile = path.join(process.env.TEMP || 'C:/Windows/Temp', `wb-probe-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });

const chrome = path.join(process.env.USERPROFILE || process.env.HOME,
  'AppData/Local/Google/Chrome/Application/chrome.exe');
const args = [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run',
  '--window-size=1500,950', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, 'about:blank',
];
const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const watchdog = setTimeout(() => { proc.kill(); process.exit(2); }, 15000);
watchdog.unref();

let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });
let launched = false;
proc.stdout.on('data', (d) => {
  const s = d.toString();
  process.stderr.write('[chrome] ' + s);
  if (!launched && s.includes('DevTools listening')) { launched = true; resolveReady(); }
});
proc.stderr.on('data', (d) => {
  const s = d.toString();
  process.stderr.write('[chrome] ' + s);
  if (!launched && s.includes('DevTools listening')) { launched = true; resolveReady(); }
});
function killChrome() { try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { proc.kill(); } catch {} } }

await ready;
clearTimeout(watchdog);
await new Promise((r) => setTimeout(r, 400));
let tabs = null;
for (let i = 0; i < 15 && !tabs; i++) {
  try { tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); }
  catch { await new Promise((r) => setTimeout(r, 400)); }
}
if (!tabs) { console.error('no /json'); killChrome(); process.exit(2); }
const tab = tabs.find((t) => t.type === 'page');
if (!tab) { console.error('no page tab'); killChrome(); process.exit(2); }

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 0;
const pendings = new Map();
const evHandlers = [];
ws.onmessage = (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pendings.has(m.id)) { const p = pendings.get(m.id); pendings.delete(m.id); p(m); }
  for (const h of evHandlers) h(m);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('ws open fail'));
});
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId; pendings.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
const loaded = new Promise((r) => evHandlers.push((m) => { if (m.method === 'Page.loadEventFired') r(); }));
await send('Page.navigate', { url: URL });
await loaded;
await new Promise((r) => setTimeout(r, 10000));  // 给流式区块充分时间

/* 核心探针: 重建 atlas + 采 glcanvas 像素 */
const probe = await send('Runtime.evaluate', {
  expression: `(async () => {
    const W = window.__renderer ? window.__renderer.canvas.width  : 0;
    const H = window.__renderer ? window.__renderer.canvas.height : 0;
    const gl = window.__renderer && window.__renderer.gl;

    /* 1) 重建 atlas, 采几个 cell 的实际像素 */
    const IT = window.InkTextures;
    const atlas = IT.buildAtlas();
    const actx = atlas.getContext('2d');
    const cell = (b, v) => {
      const PX = IT.PX;
      const d = actx.getImageData(b * PX, v * PX, PX, PX).data;
      let r=0,g=0,bl=0,a=0,n=0;
      for (let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; bl+=d[i+2]; a+=d[i+3]; n++; }
      return [Math.round(r/n), Math.round(g/n), Math.round(bl/n), Math.round(a/n)];
    };
    const atlasCells = {};
    for (let b=0;b<8;b++) atlasCells['b'+b] = [cell(b,0), cell(b,1), cell(b,2), cell(b,3)];

    /* 2) 采 5 个 glcanvas 屏幕像素 (CSS px) */
    const cssW = document.getElementById('glcanvas').clientWidth;
    const cssH = document.getElementById('glcanvas').clientHeight;
    const dpr  = window.devicePixelRatio || 1;
    const tmp = document.createElement('canvas');
    tmp.width = cssW; tmp.height = cssH;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(document.getElementById('glcanvas'), 0, 0, cssW, cssH);
    const px = (x,y) => Array.from(tctx.getImageData(x,y,1,1).data);
    const screen = {
      grid5x5: [],
      chunks: window.__data ? window.__data() : null,
      cam: window.__cam ? { x: window.__cam.x, y: window.__cam.y, z: window.__cam.zoom } : null
    };
    for (let gy = 0; gy < 5; gy++) {
      const row = [];
      for (let gx = 0; gx < 5; gx++) {
        const x = ((cssW * (gx + 0.5)) / 5) | 0;
        const y = ((cssH * (gy + 0.5)) / 5) | 0;
        row.push({ at: [x, y], rgb: px(x, y).slice(0, 3) });
      }
      screen.grid5x5.push(row);
    }

    /* 3) 读 atlas 在 GPU 端的 texAtlas 内容 (用 readPixels 从默认 framebuffer 不行;
       但 renderer.texAtlas 是 GL texture, 我们用 gl.readPixels 从一个临时 FBO) */
    let gpuAtlasCells = null;
    try {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, window.__renderer.texAtlas, 0);
      const PW = 64;
      const out = {};
      for (const b of [0,1,2,3,6,7]) {
        const buf = new Uint8Array(PW*PW*4);
        gl.readPixels(b*256, 0, PW, PW, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let r=0,g=0,bl=0,a=0,n=0;
        for (let i=0;i<buf.length;i+=4){ r+=buf[i]; g+=buf[i+1]; bl+=buf[i+2]; a+=buf[i+3]; n++; }
        out['b'+b] = [Math.round(r/n), Math.round(g/n), Math.round(bl/n), Math.round(a/n)];
      }
      gpuAtlasCells = out;
      gl.deleteFramebuffer(fbo);
    } catch(e) { gpuAtlasCells = 'ERR: ' + e.message; }

    return JSON.stringify({
      dpr, canvasBacking: [W, H], cssSize: [cssW, cssH],
      atlasCells, screen, gpuAtlasCells,
      debug: (() => {
        /* 检查 chunk(0,0) 是否上传 + 其首 3 个 center (pixel) */
        const r = window.__renderer;
        if (!r) return { err: 'no __renderer' };
        const keys = Array.from(r.chunks.keys());
        const has00 = keys.includes('42_0_0');
        /* 通过第二个 WebGL 上下文读 VAO 的 centers 缓冲不实际, 改用 main.js 的 chunkData */
        const cd = window.__data && window.__data();
        return {
          chunkCount: keys.length,
          hasChunk00: has00,
          sampleKeys: keys.slice(0, 10).concat(keys.slice(-3)),
          __data: cd,
        };
      })()
    });
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(probe.result && probe.result.result && probe.result.result.value);
killChrome();
process.exit(0);
