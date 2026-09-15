#!/usr/bin/env node
/* ============================================================
 * verify/live_cap.mjs — 实机地图截图 (真实时间, 走前端「自截回传」通道)
 * ------------------------------------------------------------
 * 前端带 capture=1 时会等「块数据真实到达 + 至少渲染过一帧」再把
 * glcanvas + overlay 合成为 PNG, POST 到 /api/debug/snap (服务端落
 * verify/capture.png)。故本脚本无需 CDP: 起 headless Chrome 打开 URL,
 * 轮询 capture.png 变更, 抓到即收工。
 *
 * 用法: node verify/live_cap.mjs <url> <outPng> [timeoutSec] [WxH]
 * 例:   node verify/live_cap.mjs \
 *         "http://127.0.0.1:8140/index.html?seed=42&qt=-1&rt=-2&zm=3.2&nofade=1&capture=1" \
 *         verify/live_town.png
 *
 * ⚠ 必须用旧版 --headless: --headless=new 忽略 --window-size,
 *   页面 clientWidth 会退化成默认值 → 截图尺寸不可控。
 * ⚠ 只按 PID 杀自己起的 Chrome 进程树 (/IM 会连带杀掉用户自己在开的 Chrome)。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'verify', 'capture.png');      // 服务端落盘位置
const URL_IN = process.argv[2];
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'verify', 'live_cap.png'));
const TIMEOUT = (Number(process.argv[4]) || 90) * 1000;
const WH = (process.argv[5] || '1400x900').split('x');

if (!URL_IN) { console.error('用法: node verify/live_cap.mjs <url> <outPng> [timeoutSec] [WxH]'); process.exit(2); }

const CHROME = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome: ' + CHROME); process.exit(2); }

/* 起点: 记录快照文件的 mtimeMs —— 抓到更大者即本次产物 (不删旧文件, 留作对照) */
let prevMtime = 0;
if (fs.existsSync(SNAP)) prevMtime = fs.statSync(SNAP).mtimeMs;

const profile = path.join(os.tmpdir(), 'wb-livecap-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
/* ⚠ 必须挂 --remote-debugging-port: 旧版 --headless 单独给 URL 会在 load
   完成即退出, 页面的 setTimeout 等待 (等块数据) 根本来不及跑。
   挂了调试端口, headless Chrome 会常驻直到被 kill。 */
const PORT = 9400 + Math.floor(Math.random() * 400);
const args = [
  '--headless', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=${WH[0]},${WH[1]}`, `--remote-debugging-port=${PORT}`,
  URL_IN,
];
const proc = spawn(CHROME, args, { stdio: 'ignore' });
const t0 = Date.now();

/* 同步小睡 (不引入依赖): setTimeout 在被 process.exit 打断时不会触发, 故用 Atomics.wait */
const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* noop */ } };

function finish(ok, note) {
  /* 只杀自己起的进程树 */
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' }); } catch { /* noop */ }
  try { proc.kill(); } catch { /* noop */ }
  /* ⚠ 必须**同步**删 profile —— 旧版把 rmSync 放进 setTimeout(…,1500), 而紧接着就
     `process.exit()` ⇒ 定时器永远不触发 ⇒ **每次截图都漏一个 ~10MB 的 profile 目录**
     (2026-09-15 实测本机已积 127 个 `%TEMP%/wb-livecap-*`)。
     taskkill 返回后 Chrome 释放文件锁还有几百 ms 延迟, 故带重试。 */
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
    if (!fs.existsSync(profile)) break;
    nap(200);
  }
  if (ok) {
    fs.copyFileSync(SNAP, OUT);
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    console.log(`[live_cap] ✔ ${note} → ${OUT} (${kb}KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.error(`[live_cap] ✘ ${note} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  process.exit(ok ? 0 : 1);
}

const timer = setInterval(() => {
  if (fs.existsSync(SNAP)) {
    const st = fs.statSync(SNAP);
    if (st.size > 1000 && st.mtimeMs > prevMtime) {
      clearInterval(timer);
      /* 等 PNG 写完整: 连续两次尺寸一致 */
      let last = -1, stable = 0;
      const t2 = setInterval(() => {
        const s2 = fs.statSync(SNAP).size;
        stable = (s2 === last && s2 > 1000) ? stable + 1 : 0;
        last = s2;
        if (stable >= 1) { clearInterval(t2); finish(true, '截图已抓到'); }
      }, 400);
      return;
    }
  }
  if (Date.now() - t0 > TIMEOUT) {
    clearInterval(timer);
    finish(false, `超时 ${TIMEOUT / 1000}s 未见 ${path.basename(SNAP)} 更新`);
  }
}, 500);

/* 兜底: 进程异常/定时器被饿死时也要收工, 免得长挂 */
setTimeout(() => { clearInterval(timer); finish(false, `总超时 ${(TIMEOUT + 5000) / 1000}s`); }, TIMEOUT + 6000);
