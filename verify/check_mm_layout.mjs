#!/usr/bin/env node
/* ============================================================
 * verify/check_mm_layout.mjs — 小地图面板「响应式几何」契约
 * ------------------------------------------------------------
 * 出身: 手机上报「小地图不占满窗体」。量化后根因是**窄屏专属**的 CSS 几何缺陷:
 *   窄屏档把画布缩到 150×98, 但面板头行「山河小图 归心 全屏 隐藏」与提示行的
 *   固有宽度都是 188px; #minimapBox 是绝对定位的收缩包裹盒 (shrink-to-fit) ⇒
 *   取最宽者 188px, 面板 204px, 而画布只有 150px ⇒ 右侧留 38px 空白纸。
 *   桌面档 216=216 恰好相等, 所以只在窄屏暴露。
 * 修法: ① 面板几何参数化 (--mm-h/--mm-chrome/--mm-bottom/--mm-gap), #info 山川志的
 *         bottom 由变量推出 (原先写死 230px/168px, 改画布高度就会压住小地图);
 *       ② 窄屏 left/right 同时贴边 ⇒ 宽度确定, 画布 width:100% 才铺得满。
 *
 * 本脚本不靠「看图」: 把 index.html 装进各档宽度的 iframe, 量真实布局盒, 逐条断言。
 *
 * 用法:
 *   node verify/check_mm_layout.mjs                        # 默认 12 个宽度 @ 127.0.0.1:8140
 *   node verify/check_mm_layout.mjs http://127.0.0.1:8141
 *   node verify/check_mm_layout.mjs --widths=320,390,760,761
 *   node verify/check_mm_layout.mjs --keep                 # 保留生成的探针页 (手工在浏览器里看)
 *   node verify/check_mm_layout.mjs --verbose              # 打印每个宽度的完整数据
 *
 * 退出码: 0 = 全绿 | 1 = 有 FAIL | 2 = 跳过(无 Chrome / 服务端探不通)
 * 约定: 探针页写在 web/ 下 (与 index.html 同源, 否则读不到 iframe 布局), 名为
 *       web/_mmlayout_probe.html —— 已被 .gitignore 的 `web/_*` 覆盖, 跑完即删。
 * ⚠ 用旧版 --headless (--headless=new 忽略 --window-size); 只杀自己起的 Chrome
 *   进程树 (按 PID), 不动用户自己开的浏览器。
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
function opt(k, d) {
  const p = '--' + k + '=';
  const hit = argv.find((s) => s.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
}
const BASE = (argv.find((s) => /^https?:\/\//.test(s)) || 'http://127.0.0.1:8140').replace(/\/$/, '');
const KEEP = has('keep');
const VERBOSE = has('verbose');
const WIDTHS = opt('widths', '280,320,360,390,414,480,600,760,761,820,1024,1280')
  .split(',').map(Number).filter((n) => n > 0);
const NARROW_MAX = 760;                     /* 与 index.html 的 @media (max-width: 760px) 对齐 */
const MM_H_NARROW = 132;                    /* 窄屏画布高 min(132px, 22vh) */
const EXPECT = {                            /* 桌面档锁死值 */
  panelW: 232, panelH: 198, canvasW: 216, canvasH: 141, inset: 16,
};
const INSET_NARROW = 10;

function chromePath() {
  const given = opt('chrome', '');
  if (given) return given;
  const cands = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return cands.find((p) => fs.existsSync(p)) || '';
}

/* ---------- 探针页 (与 index.html 同源; 各档宽度 iframe + 量盒) ---------- */
const PROBE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>MMLAYOUT</title>
<style>
  html, body { margin: 0; background: #fff; font: 11px/1.4 monospace; }
  #host { position: absolute; left: -20000px; top: 0; }
  #host iframe { display: block; border: 0; }
  pre { margin: 0; padding: 6px; white-space: pre-wrap; }
</style></head><body>
<pre id="out">PENDING</pre><div id="host"></div>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var widths = (q.get('w') || '390').split(',').map(Number).filter(function (n) { return n > 0; });
  var out = document.getElementById('out'), host = document.getElementById('host'), res = [];
  function r1(v) { return Math.round(v * 10) / 10; }
  function measure(win, tag) {
    var d = win.document;
    var box = d.getElementById('minimapBox'), cv = d.getElementById('minimap');
    if (!box || !cv) return { tag: tag, err: 'no #minimapBox/#minimap' };
    var bs = win.getComputedStyle(box), cs = win.getComputedStyle(cv);
    var bb = box.getBoundingClientRect(), cb = cv.getBoundingClientRect();
    var head = box.querySelector('.mm-head'), hint = box.querySelector('.hint');
    var hb = head ? head.getBoundingClientRect() : null;
    var nb = hint ? hint.getBoundingClientRect() : null;
    var padL = parseFloat(bs.paddingLeft), padR = parseFloat(bs.paddingRight);
    var bdL = parseFloat(bs.borderLeftWidth), bdR = parseFloat(bs.borderRightWidth);
    var contentW = bb.width - padL - padR - bdL - bdR;
    var info = d.getElementById('info');
    return {
      tag: tag, vw: win.innerWidth, vh: win.innerHeight, dpr: win.devicePixelRatio,
      narrow: win.matchMedia('(max-width: 760px)').matches,
      panel: { x: r1(bb.x), y: r1(bb.y), w: r1(bb.width), h: r1(bb.height) },
      contentW: r1(contentW),
      canvas: {
        cssW: cs.width, cssH: cs.height, w: r1(cb.width), h: r1(cb.height),
        clientW: cv.clientWidth, clientH: cv.clientHeight,
        backingW: cv.width, backingH: cv.height,
        right: r1(cb.right - bb.left)
      },
      head: hb ? { w: r1(hb.width), h: r1(hb.height), scrollW: head.scrollWidth,
                   clientW: head.clientWidth, right: r1(hb.right - bb.left),
                   overflowPx: r1(hb.right - cb.right) } : null,
      hint: nb ? { w: r1(nb.width), h: r1(nb.height), scrollW: hint.scrollWidth,
                   clientW: hint.clientWidth } : null,
      infoGap: info ? r1(bb.top - info.getBoundingClientRect().bottom) : null,
      gapRight: r1(contentW - cb.width),
      fillPct: r1(100 * cb.width / contentW),
      vpRightGap: r1(win.innerWidth - bb.right),
      vpBottomGap: r1(win.innerHeight - bb.bottom)
    };
  }
  function step(i) {
    if (i >= widths.length) {
      out.textContent = 'MMLAYOUT_BEGIN\\n' + JSON.stringify(res) + '\\nMMLAYOUT_END';
      document.title = 'MMLAYOUT DONE ' + res.length;
      return;
    }
    var w = widths[i], h = Math.max(480, Math.round(w * 1.6));
    var f = document.createElement('iframe');
    f.width = String(w); f.height = String(h);
    f.style.width = w + 'px'; f.style.height = h + 'px';
    f.src = 'index.html?seed=20260915';
    f.onload = function () {
      setTimeout(function () {
        var m;
        try { m = measure(f.contentWindow, w + 'x' + h); } catch (e) { m = { tag: w + 'x' + h, err: String(e) }; }
        res.push(m);
        out.textContent = 'MMLAYOUT_BEGIN\\n' + JSON.stringify(res) + '\\nMMLAYOUT_END';
        f.parentNode.removeChild(f);
        step(i + 1);
      }, 700);
    };
    host.appendChild(f);
  }
  step(0);
})();
<\/script></body></html>
`;

/* ---------- 前置检查 ---------- */
const CHROME = chromePath();
const probePath = path.join(WEB, '_mmlayout_probe.html');
const cleanup = () => { if (!KEEP) { try { fs.unlinkSync(probePath); } catch { /* noop */ } } };

if (!CHROME) { console.error('[skip] 未找到 Chrome (可用 --chrome=<路径> 指定)'); process.exit(2); }
if (!fs.existsSync(path.join(WEB, 'index.html'))) { console.error('[skip] 缺 web/index.html'); process.exit(2); }

/* 探活: 服务端不通就没法同源读 iframe */
const probe = spawnSync(process.execPath, ['-e', `
  const u = ${JSON.stringify(BASE + '/index.html')};
  fetch(u, { signal: AbortSignal.timeout(6000) })
    .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
`], { stdio: 'ignore', timeout: 12000 });
if (probe.status !== 0) {
  console.error('[skip] 探不通 ' + BASE + '/index.html —— 先起服务端 (或传 --base 位置参数)');
  process.exit(2);
}

fs.writeFileSync(probePath, PROBE);

/* ---------- 跑 Chrome ---------- */
const budget = 20000 + WIDTHS.length * 5000;
const profile = path.join(os.tmpdir(), 'wb-mmlayout-' + Date.now());
fs.mkdirSync(profile, { recursive: true });
const url = BASE + '/_mmlayout_probe.html?w=' + WIDTHS.join(',');
const args = [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + profile, '--force-device-scale-factor=1',
  '--window-size=1400,900', '--virtual-time-budget=' + budget, '--dump-dom', url,
];
console.log('== check_mm_layout: ' + WIDTHS.length + ' 个宽度 @ ' + BASE + ' ==');
const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: budget + 120000, maxBuffer: 64 * 1024 * 1024 });
const dump = r.stdout || '';
/* ⚠ 旧版把「删 profile」放进 `setTimeout(…,800)`, 而紧接着就 `cleanup()` 里的
   `process.exit()` ⇒ 定时器永远不触发 ⇒ **每次跑都漏一个 Chrome profile 目录**
   (实测本机积了 7 个 `wb-mmlayout-*`)。而且 `KEEP` 的两个分支写反了 ——
   KEEP=true (要留档调试) 反而立刻删。本版: KEEP 为真就**留**并打印路径, 否则**同步**删。 */
if (KEEP) {
  console.log('  (KEEP: 保留 profile 供调试 → ' + profile + ')');
} else {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
    if (!fs.existsSync(profile)) break;
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } catch { /* noop */ }
  }
}
cleanup();

/* ---------- 解析 ---------- */
const html = dump.replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const mm = html.match(/MMLAYOUT_BEGIN\s*([\s\S]*?)\s*MMLAYOUT_END/);
if (!mm) {
  console.error('  FAIL 探针未产出数据 (Chrome rc=' + r.status + ', dump ' + dump.length + ' 字节)');
  console.error('       多半是 --virtual-time-budget 不够 (当前 ' + budget + 'ms) 或页面卡住');
  process.exit(1);
}
let rows;
try { rows = JSON.parse(mm[1]); } catch (e) {
  console.error('  FAIL 探针数据不是合法 JSON: ' + e.message);
  process.exit(1);
}

const narrow = rows.filter((x) => x.narrow), wide = rows.filter((x) => !x.narrow);
const bad = (x) => x.err;

const fmt = (v, n = 1) => (v === null || v === undefined ? '-' : Number(v).toFixed(n));
if (VERBOSE || rows.length !== WIDTHS.length) {
  console.log(' 视口 | 窄 | 面板 WxH      | 内容宽 | 画布 WxH      | 右空白 | 铺满% | 头行溢 | 提示溢 | 山川志净距');
  for (const x of rows) {
    if (bad(x)) { console.log('  ' + x.tag + '  ✘ ' + x.err); continue; }
    console.log([
      ' ' + String(x.vw).padStart(4),
      x.narrow ? '是' : '否',
      (x.panel.w + 'x' + x.panel.h).padEnd(13),
      String(x.contentW).padStart(6),
      (x.canvas.w + 'x' + x.canvas.h).padEnd(13),
      String(fmt(x.gapRight)).padStart(6),
      String(fmt(x.fillPct)).padStart(6),
      String(fmt(x.head && x.head.overflowPx)).padStart(6),
      String(fmt((x.hint && x.hint.scrollW - x.hint.clientW) || 0)).padStart(6),
      String(fmt(x.infoGap)).padStart(10),
    ].join(' | '));
  }
}

let nPass = 0, nFail = 0;
function judge(name, fn) {
  const errs = [];
  for (const x of rows) {
    if (bad(x)) { errs.push(x.tag + ': ' + x.err); continue; }
    const e = fn(x);
    if (e) errs.push(x.tag + ': ' + e);
  }
  if (errs.length) { nFail++; console.log('  FAIL ' + name + '  (' + errs.length + '/' + rows.length + ' 档不合格)'); for (const e of errs.slice(0, 6)) console.log('         ' + e); }
  else { nPass++; console.log('  PASS ' + name); }
}

judge('数据齐全 (' + rows.length + '/' + WIDTHS.length + ' 个宽度都量到)', (x) =>
  WIDTHS.includes(x.vw) ? '' : ('量到的视口宽 ' + x.vw + ' 不在请求清单里'));

judge('画布铺满面板内容框 (右侧空白 <= 1px) —— 本条 = 手机上报的那个 bug', (x) =>
  x.gapRight > 1 ? ('画布 ' + x.canvas.w + ' < 内容框 ' + x.contentW + '  ⇒ 右侧空白 ' + x.gapRight + 'px') : '');

judge('窄屏(<=760) 面板左右贴边 ' + INSET_NARROW + 'px —— 铺满窗体宽度', (x) => {
  if (!x.narrow) return '';
  if (Math.abs(x.panel.x - INSET_NARROW) > 1) return ('左边距 ' + x.panel.x + ' (期望 ' + INSET_NARROW + ')');
  if (Math.abs(x.vpRightGap - INSET_NARROW) > 1) return ('右边距 ' + x.vpRightGap + ' (期望 ' + INSET_NARROW + ')');
  return '';
});

judge('窄屏画布高 = min(' + MM_H_NARROW + 'px, 22vh)', (x) => {
  if (!x.narrow) return '';
  const want = Math.min(MM_H_NARROW, 0.22 * x.vh);
  return Math.abs(x.canvas.h - want) > 1 ? ('高 ' + x.canvas.h + ' (期望 ' + want.toFixed(1) + ')') : '';
});

judge('宽屏(>=761) 桌面档未被改动: 面板 ' + EXPECT.panelW + 'x' + EXPECT.panelH + ' / 画布 ' + EXPECT.canvasW + 'x' + EXPECT.canvasH, (x) => {
  if (x.narrow) return '';
  if (Math.abs(x.panel.w - EXPECT.panelW) > 1) return ('面板宽 ' + x.panel.w + ' (期望 ' + EXPECT.panelW + ')');
  if (Math.abs(x.panel.h - EXPECT.panelH) > 1) return ('面板高 ' + x.panel.h + ' (期望 ' + EXPECT.panelH + ')');
  if (Math.abs(x.canvas.w - EXPECT.canvasW) > 1) return ('画布宽 ' + x.canvas.w + ' (期望 ' + EXPECT.canvasW + ')');
  if (Math.abs(x.canvas.h - EXPECT.canvasH) > 1) return ('画布高 ' + x.canvas.h + ' (期望 ' + EXPECT.canvasH + ')');
  if (Math.abs(x.panel.x - EXPECT.inset) > 1) return ('左边距 ' + x.panel.x + ' (期望 ' + EXPECT.inset + ')');
  return '';
});

judge('头行/提示行都不溢出面板 (按钮不被截)', (x) => {
  const h = x.head, hi = x.hint;
  if (!h) return '#minimapBox .mm-head 缺失';
  if (h.overflowPx > 0.5) return ('头行右缘超出画布 ' + h.overflowPx + 'px (头行 ' + h.w + ' > 画布 ' + x.canvas.w + ')');
  if (h.scrollW - h.clientW > 1) return ('头行横向溢出 ' + (h.scrollW - h.clientW) + 'px');
  if (hi && hi.scrollW - hi.clientW > 1) return ('提示行横向溢出 ' + (hi.scrollW - hi.clientW) + 'px');
  return '';
});

judge('山川志 (#info) 停在小地图上方, 不重叠 (净距 >= 6px)', (x) => {
  if (x.infoGap === null) return '#info 缺失';
  return x.infoGap < 6 ? ('净距 ' + x.infoGap + 'px ⇒ 压住了小地图') : '';
});

judge('画布外框不出视口', (x) => {
  const right = x.panel.x + x.canvas.right;
  if (right > x.vw + 1) return ('画布右缘 ' + right + ' > 视口 ' + x.vw);
  if (x.vpBottomGap < 0) return ('面板沉出视口底 ' + x.vpBottomGap + 'px');
  return '';
});

const strip = narrow.length ? Math.max.apply(null, narrow.map((x) => x.gapRight)) : 0;
console.log('\n  窄屏 ' + narrow.length + ' 档 / 宽屏 ' + wide.length + ' 档;  ' +
  '窄屏画布铺满率 ' + (narrow.length ? narrow.map((x) => fmt(x.fillPct)).join(',') + '%' : '-') +
  ',  最大右侧空白 ' + fmt(strip) + 'px  (修前: 38px / 铺满 79.8%)');
console.log(nFail ? ('结果: FAIL ' + nFail + ' 条, PASS ' + nPass + ' 条 ✘') : ('结果: 全部通过 ✔  (' + nPass + ' 条)'));
process.exit(nFail ? 1 : 0);
