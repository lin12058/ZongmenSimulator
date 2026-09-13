#!/usr/bin/env node
/* ============================================================
 * tools/shot_buildings.mjs — 把 docs/建筑贴图/*.svg 渲染为同名 PNG
 * ------------------------------------------------------------
 * ⚠ 不能用 chrome --screenshot 直接截独立 .svg 文档: headless 对独立 SVG
 *   文档的缩放基准与窗口不一致 (实测被放大 ~3 倍且右侧截断)。改为把 SVG
 *   内联进一个固定 256×256 的 HTML 包装页再截图, 尺寸才严格 1:1。
 * 用法: node tools/shot_buildings.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'docs', '建筑贴图');
const TMP = path.join(os.tmpdir(), 'zm-bwrap-' + process.pid);
const CHROME = process.env.ZM_CHROME ||
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');

/* SVG 文本 → 固定尺寸 HTML 包装页 */
function wrap(svgText, size) {
  const inner = svgText.replace(/<\?xml[^>]*\?>\s*/, '').replace(/(<svg\b[^>]*?)\s+width="\d+"\s+height="\d+"/, '$1');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
 html,body{margin:0;padding:0;background:#f2ead8;overflow:hidden}
 svg{display:block;width:${size}px;height:${size}px}
</style></head><body>${inner}</body></html>`;
}

function shot(htmlPath, outPng, w, h) {
  const prof = path.join(TMP, 'prof-' + path.basename(outPng, '.png'));
  fs.rmSync(outPng, { force: true });
  /* ⚠ 必须用旧版 `--headless`, 不能用 `--headless=new`:
     本机 Chrome 在 `--headless=new` 下**完全忽略 --window-size**, 截图按页面内容
     自行取尺寸 (实测 256×256 请求 → 516×162, 且 SVG 被放大后右侧截断)。
     旧版 headless 下 --window-size 严格生效 (实测 200×120 → 输出 200×120)。 */
  const r = spawnSync(CHROME, [
    '--headless', '--user-data-dir=' + prof, '--no-first-run', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--window-size=' + w + ',' + h, '--screenshot=' + outPng,
    pathToFileURL(htmlPath).href
  ], { stdio: 'ignore', timeout: 120000 });
  const ok = fs.existsSync(outPng) && fs.statSync(outPng).size > 800;
  return { ok, code: r.status, size: ok ? fs.statSync(outPng).size : 0 };
}

fs.mkdirSync(TMP, { recursive: true });
const svgs = fs.readdirSync(DIR).filter((f) => f.endsWith('.svg')).sort();
let ok = 0; const bad = [];
for (const f of svgs) {
  const w = path.join(TMP, f.replace(/\.svg$/, '.html'));
  fs.writeFileSync(w, wrap(fs.readFileSync(path.join(DIR, f), 'utf8'), 256), 'utf8');
  const r = shot(w, path.join(DIR, f.replace(/\.svg$/, '.png')), 256, 256);
  if (r.ok) ok++; else bad.push(f + ' (exit=' + r.code + ')');
}
console.log(`SVG→PNG: ${ok}/${svgs.length} 成功`);
if (bad.length) console.log('失败: ' + bad.join(', '));

const g = path.join(DIR, '建筑贴图总览.html');
if (fs.existsSync(g)) {
  const r = shot(g, path.join(DIR, '建筑贴图总览.png'), 1560, 1560);
  console.log('总览: ' + (r.ok ? 'OK ' + r.size + 'B' : '失败 exit=' + r.code));
}
fs.rmSync(TMP, { recursive: true, force: true });
if (bad.length) process.exit(1);
