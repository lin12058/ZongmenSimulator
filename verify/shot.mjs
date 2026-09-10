/* ============================================================
 * shot.mjs — 可靠的 headless 截图 (带空白检测 + 自动重试)
 *
 * 背景: 本机 Chrome 122 headless 的 WebGL command buffer 会间歇性失败
 *   (stderr 可见 "command_buffer_proxy_impl.cc GPU state invalid"), 表现为
 *   截图整幅只剩纸色底 (mean RGB ≈ 237,227,205) 而页面本身没报错 ——
 *   直接用 `--screenshot` 会得到"看起来失败其实只是环境抖动"的假阴性/假阳性。
 *   本工具解码 PNG 判定是否真的渲染出内容, 不行就换全新 profile 重试。
 *
 * 用法:
 *   node verify/shot.mjs [url] [outPng] [attempts]
 *   默认 url = http://127.0.0.1:8140/index.html?seed=42&nofade=1&qt=-51&rt=133&zm=1.1
 * 退出码: 0 = 拿到真实渲染图; 1 = 重试耗尽仍为空白(环境问题)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.ZM_CHROME ||
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
const URL_ = process.argv[2] ||
  'http://127.0.0.1:8140/index.html?seed=42&nofade=1&qt=-51&rt=133&zm=1.1';
/* 必须解析为绝对路径: Chrome 对 --screenshot 的相对路径解析基准与本进程不一致 */
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'verify', 'shot.png'));
const ATTEMPTS = parseInt(process.argv[4] || '3', 10);
/* 虚拟时间预算是关键: 虚拟时钟会跑到真实 WS 数据之前 → 预算太小必然截到空白。
   实测 60000 空白 / 120000 成功。故逐次递增预算重试。 */
const BUDGETS = [60000, 100000, 140000, 180000];

/* ---------- 极简 PNG 解码 (8bit, colorType 2/6) ---------- */
function decodePng(buf) {
  if (buf.slice(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') throw new Error('非 PNG');
  let p = 8, w = 0, h = 0, ct = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('binary');
    const body = buf.slice(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!ch) throw new Error('不支持 colorType=' + ct);
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride)); pos += stride;
    if (f === 1) for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 255;
    else if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    else if (f === 3) for (let i = 0; i < stride; i++) line[i] = (line[i] + (((i >= ch ? line[i - ch] : 0) + prev[i]) >> 1)) & 255;
    else if (f === 4) for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, px: out };
}

/* ---------- 判据: 是否真的渲染出内容 ----------
 * 空白(只有纸色底/UI) : mean ≈ (237,227,205), 颜色种类少
 * 真实地形           : mean ≈ (128,148,139), 颜色种类上千
 */
function analyze(file) {
  const { w, h, ch, px } = decodePng(fs.readFileSync(file));
  const step = ch * 7;                       // 抽样步长, 够用且快
  let sr = 0, sg = 0, sb = 0, n = 0;
  const seen = new Set();
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = y * w * ch + x * ch;
      sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
      if (seen.size < 4000) seen.add((px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3));
    }
  }
  const mean = (sr + sg + sb) / n / 3;
  return { w, h, mean: +mean.toFixed(1), colors: seen.size, blank: mean > 210 || seen.size < 300 };
}

console.log(`== headless 截图 (最多 ${ATTEMPTS} 次, 空白自动重试+递增预算) ==`);
console.log(`  url = ${URL_}`);
for (let k = 1; k <= ATTEMPTS; k++) {
  const prof = path.join(os.tmpdir(), 'zm-shot-' + process.pid + '-' + k);
  const budget = BUDGETS[Math.min(k - 1, BUDGETS.length - 1)];
  fs.rmSync(OUT, { force: true });
  const r = spawnSync(CHROME, [
    '--headless=new', '--user-data-dir=' + prof, '--no-first-run',
    '--window-size=1500,950', '--virtual-time-budget=' + budget,
    '--screenshot=' + OUT, URL_
  ], { stdio: 'ignore', timeout: 300000 });
  let info = null;
  try { info = analyze(OUT); } catch (e) { /* 未生成 */ }
  if (!info) { console.log(`  尝试 ${k} (budget=${budget}): 未生成截图 (exit=${r.status}) — 重试`); continue; }
  console.log(`  尝试 ${k} (budget=${budget}): ${info.w}x${info.h} mean=${info.mean} colors=${info.colors} → ${info.blank ? '空白(虚拟时钟/GPU 抖动)' : '渲染正常'}`);
  if (!info.blank) {
    console.log(`\n========== OK: 真实渲染图已保存 ${OUT} ==========`);
    process.exit(0);
  }
}
console.log(`\n========== 失败: ${ATTEMPTS} 次均为空白 — 判定为环境问题(headless 虚拟时钟/GPU), 非页面 bug ==========`);
process.exit(1);
