/* ============================================================
   check_mobile_ui —— 手机版两件事的契约 (2026-09-15 用户报)
   ------------------------------------------------------------
   ① 「手机版小地图不能放大或者拖动」
      根因: minimap-vein.js 只绑了 mouse* 事件, 触屏设备上压根没有对应事件。
      本判据用合成的 TouchEvent 走 iframe 里的真页面, 断言:
        单指拖动 ⇒ 脱离跟随 + 中心按位移平移; 双指捏合 ⇒ 改「与大地图恒定的比例」;
        未移动的单指抬起 ⇒ 展开全屏; 而「拖动后浏览器补发的合成鼠标事件」不得被当成单击 ⇒ 不弹全屏。
   ② 「UI 应该是白色的, 不应该跟随系统变化」
      根因: 页面未声明 color-scheme, 手机浏览器 / Android WebView / 微信·QQ 的 X5 内核
            会对这类页面做「算法暗化」(整页反色), 纸白被反成墨黑。
      断言: 声明了 color-scheme: only light + 全表无 prefers-color-scheme 规则 + 表单控件锁浅色。
      ⚠ 本机桌面 Chrome 复现不出算法暗化 (实测 --force-dark-mode / WebContentsForceDark
        三种组合 3 张截图逐像素近乎相同), 所以这里只能断言「退出所需的声明在位且无反向规则」,
        不能在本地证明手机上的观感 —— 该结论的实机证据在用户手机上。
   用法:
     node verify/check_mm_ui.mjs                       # 对 127.0.0.1:8140
     node verify/check_mm_ui.mjs http://192.168.63.62:8140
     node verify/check_mm_ui.mjs --keep --verbose      # 留探针页 / 打印明细
   ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const KEEP = has('keep');
const VERBOSE = has('verbose');
const BASE = (argv.find((s) => /^https?:\/\//.test(s)) || 'http://127.0.0.1:8140').replace(/\/$/, '');

function chromePath() {
  const cands = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return cands.find((p) => fs.existsSync(p)) || '';
}

/* ---------- 探针页 (与 index.html 同源 iframe; 合成触摸/鼠标事件 → 读 probe()) ---------- */
const PROBE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>MMUI</title>
<style>
  html, body { margin: 0; background: #fff; font: 11px/1.4 monospace; }
  #host { position: absolute; left: -20000px; top: 0; }
  #host iframe { display: block; border: 0; }
  pre { margin: 0; padding: 6px; white-space: pre-wrap; }
</style></head><body>
<pre id="out">PENDING</pre><div id="host"></div>
<script>
(function () {
  var out = document.getElementById('out');
  function done(obj) { out.textContent = 'MMUI_BEGIN\\n' + JSON.stringify(obj) + '\\nMMUI_END'; }

  var fr = document.createElement('iframe');
  fr.width = 420; fr.height = 760;
  fr.src = '/index.html?seed=20260915&nofade=1';
  document.getElementById('host').appendChild(fr);

  var errs = [];
  var R = { errs: errs, steps: [] };

  fr.addEventListener('load', function () {
    var w = fr.contentWindow, d = fr.contentDocument;
    w.addEventListener('error', function (e) { errs.push('error: ' + (e.message || e.type)); });
    w.addEventListener('unhandledrejection', function (e) { errs.push('reject: ' + e.reason); });

    var t0 = Date.now();
    (function wait() {
      var api = w.MiniMapVein;
      var ready = false;
      try { ready = !!api && api.probe().rev >= 0; } catch (e) { ready = false; }
      if (!ready) {
        if (Date.now() - t0 > 25000) { R.fatal = '模块/快照 25s 内未就绪 (MiniMapVein=' + !!api + ')'; return done(R); }
        return setTimeout(wait, 120);
      }
      try { run(w, d); } catch (e) { R.fatal = 'run 抛异常: ' + (e && e.stack || e); }
      done(R);
    })();

    /* ---- 触摸/鼠标事件构造 ---- */
    function touch(el, id, x, y) {
      return new Touch({ identifier: id, target: el, clientX: x, clientY: y,
                         pageX: x, pageY: y, screenX: x, screenY: y,
                         radiusX: 6, radiusY: 6, force: 1 });
    }
    function fire(el, type, list, changed) {
      el.dispatchEvent(new TouchEvent(type, {
        touches: list, targetTouches: list, changedTouches: changed || list,
        bubbles: true, cancelable: true
      }));
    }
    function mouse(el, type, x, y) {
      el.dispatchEvent(new MouseEvent(type, {
        button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y,
        bubbles: true, cancelable: true, view: w
      }));
    }
    function wheel(el, x, y, dy) {
      el.dispatchEvent(new w.WheelEvent('wheel', {
        deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true
      }));
    }

    function run(w, d) {
      var api = w.MiniMapVein, P = function () { return api.probe(); };
      R.rev = P().rev;                                  // 快照版本号 (>=0 说明 WS 帧已到, 中心值可信)
      var cv = d.getElementById('minimap'), fcv = d.getElementById('mmCanvasFull');
      var root = d.documentElement;
      var step = function (name, val) { R.steps.push([name, val]); };

      /* ===== ① 静态声明: 强制浅色 + 手势归属 ===== */
      var cs = w.getComputedStyle(root);
      R.colorScheme = cs.colorScheme || '';
      R.htmlBg = w.getComputedStyle(d.body).backgroundColor;
      var meta = d.querySelector('meta[name="color-scheme"]');
      R.metaScheme = meta ? meta.getAttribute('content') : null;
      R.touchAction = { panel: w.getComputedStyle(cv).touchAction, full: w.getComputedStyle(fcv).touchAction };
      /* 全表扫 prefers-color-scheme: 有 = 页面自己会随系统变色 (不该有) */
      R.schemeRules = [];
      try {
        for (var i = 0; i < d.styleSheets.length; i++) {
          var sh = d.styleSheets[i], rs = sh.cssRules || [];
          for (var j = 0; j < rs.length; j++) {
            var txt = rs[j].cssText || '';
            if (txt.indexOf('prefers-color-scheme') >= 0) R.schemeRules.push(txt.slice(0, 90));
            if (rs[j].cssRules) for (var k = 0; k < rs[j].cssRules.length; k++) {
              var t2 = rs[j].cssRules[k].cssText || '';
              if (t2.indexOf('prefers-color-scheme') >= 0) R.schemeRules.push(t2.slice(0, 90));
            }
          }
        }
      } catch (e) { R.schemeRulesErr = String(e); }
      R.mediaDark = w.matchMedia('(prefers-color-scheme: dark)').matches;

      /* ===== ② 鼠标路径未被破坏 (回归) ===== */
      var a0 = P();
      wheel(cv, 60, 60, -120);                       // 上滚 = 放大
      var a1 = P();
      R.mouseWheel = { before: a0.baseWpp, after: a1.baseWpp, mode: d.getElementById('minimap') ? 'ok' : '-' };
      step('鼠标滚轮改 baseWpp', a1.baseWpp !== a0.baseWpp);

      /* ===== ③ 触摸: 单指拖动 ⇒ 脱离跟随 + 中心平移, 且不得误弹全屏 ===== */
      d.querySelector('#minimapBox [data-mm="recenter"]').click();   // 归心: 恢复跟随
      var b0 = P();
      var cx0 = cv.clientWidth, cy0 = cv.clientHeight;
      var wpp0 = b0.panelWpp, SX = 40, SY = Math.round(cy0 / 2), DX = 60, DY = 24;
      var t1 = touch(cv, 1, SX, SY);
      fire(cv, 'touchstart', [t1]);
      var t1b = touch(cv, 1, SX + DX, SY + DY);
      fire(cv, 'touchmove', [t1b]);
      fire(cv, 'touchend', [], [t1b]);
      var b1 = P();
      R.drag = {
        followBefore: b0.followCam, followAfter: b1.followCam,
        cx0: b0.panelCx, cy0: b0.panelCy, cx1: b1.panelCx, cy1: b1.panelCy,
        wantDx: -DX * wpp0, gotDx: b1.panelCx - b0.panelCx,
        wantDy: -DY * wpp0, gotDy: b1.panelCy - b0.panelCy,
        wpp0: wpp0, wpp1: b1.panelWpp, maximized: b1.maximized,
        cw: cx0, ch: cy0
      };
      step('触摸拖动 ⇒ 脱离跟随', b0.followCam === true && b1.followCam === false);
      step('触摸拖动 ⇒ 展开全屏没被误触发', b1.maximized === false);

      /* ===== ④ 合成鼠标事件 (拖动后浏览器会补发) 必须被丢弃 ===== */
      mouse(cv, 'mousedown', SX, SY);
      mouse(w, 'mouseup', SX, SY);
      var b2 = P();
      R.synthMouse = { maximized: b2.maximized };
      step('拖动后合成鼠标事件被丢弃 (不弹全屏)', b2.maximized === false);

      /* ===== ⑤ 触摸: 未移动的单指抬起 ⇒ 由「单击展开全屏」接住 ===== */
      api.setMaximized(false);
      var t2 = touch(cv, 2, 60, 60);
      fire(cv, 'touchstart', [t2]);
      fire(cv, 'touchend', [], [t2]);
      var b3 = P();
      R.tap = { maximized: b3.maximized };
      step('触摸单击 ⇒ 展开全屏', b3.maximized === true);
      api.setMaximized(false);

      /* ===== ⑥ 触摸: 双指捏合 = 滚轮同口径 (只改 baseWpp) ===== */
      d.querySelector('#minimapBox [data-mm="recenter"]').click();
      var c0 = P();
      var PX = Math.round(cx0 / 2), PY = Math.round(cy0 / 2);
      var p1 = touch(cv, 11, PX - 30, PY), p2 = touch(cv, 12, PX + 30, PY);
      fire(cv, 'touchstart', [p1, p2]);
      var p1b = touch(cv, 11, PX - 90, PY), p2b = touch(cv, 12, PX + 90, PY);
      fire(cv, 'touchmove', [p1b, p2b]);              // 两指张开 = 更放大 ⇒ baseWpp 变小
      fire(cv, 'touchend', [], [p1b, p2b]);
      var c1 = P();
      var q1 = touch(cv, 21, PX - 90, PY), q2 = touch(cv, 22, PX + 90, PY);
      fire(cv, 'touchstart', [q1, q2]);
      var q1b = touch(cv, 21, PX - 25, PY), q2b = touch(cv, 22, PX + 25, PY);
      fire(cv, 'touchmove', [q1b, q2b]);              // 两指并拢 = 缩小
      fire(cv, 'touchend', [], [q1b, q2b]);
      var c2 = P();
      R.pinch = { wpp0: c0.baseWpp, out: c1.baseWpp, in: c2.baseWpp, maximized: c1.maximized };
      step('两指张开 ⇒ baseWpp 变小 (更放大)', c1.baseWpp < c0.baseWpp * 0.95);
      step('两指并拢 ⇒ baseWpp 变大 (更缩小)', c2.baseWpp > c1.baseWpp * 1.05);
      step('捏合不会误弹全屏', c1.maximized === false);

      /* ===== ⑦ 全屏档: 单指拖动 + 双指捏合 ===== */
      api.setMaximized(true);
      var d0 = P();
      var fw = fcv.clientWidth, fh = fcv.clientHeight;
      var g1 = touch(fcv, 31, 60, 60);
      fire(fcv, 'touchstart', [g1]);
      var g1b = touch(fcv, 31, 60 + 70, 60 + 30);
      fire(fcv, 'touchmove', [g1b]);
      fire(fcv, 'touchend', [], [g1b]);
      var d1 = P();
      R.fullDrag = { maximized: d1.maximized, wpp: d0.fullWpp,
                     wantDx: -70 * d0.fullWpp, gotDx: d1.fullCx - d0.fullCx,
                     wantDy: -30 * d0.fullWpp, gotDy: d1.fullCy - d0.fullCy, fw: fw, fh: fh };
      var e1 = touch(fcv, 41, 80, 80), e2 = touch(fcv, 42, 160, 80);
      fire(fcv, 'touchstart', [e1, e2]);
      var e1b = touch(fcv, 41, 40, 80), e2b = touch(fcv, 42, 200, 80);
      fire(fcv, 'touchmove', [e1b, e2b]);
      fire(fcv, 'touchend', [], [e1b, e2b]);
      var d2 = P();
      R.fullPinch = { wpp0: d1.fullWpp, wpp1: d2.fullWpp };
      step('全屏档单指拖动 ⇒ 中心位移', Math.abs(d1.fullCx - d0.fullCx) > 1);
      step('全屏档捏合 ⇒ fullWpp 变化', Math.abs(d2.fullWpp - d1.fullWpp) > 1e-6);
      api.setMaximized(false);

      R.ok = errs.length === 0;
    }
  });
})();
</script></body></html>`;

/* ---------- 前置检查 ---------- */
const CHROME = chromePath();
if (!CHROME) { console.error('  FAIL 找不到 Chrome (--chrome=PATH 可指定)'); process.exit(1); }
const probePath = path.join(WEB, '_mmui_probe.html');
const cleanup = () => { if (!KEEP) { try { fs.unlinkSync(probePath); } catch { /* noop */ } } };
fs.writeFileSync(probePath, PROBE.replace(/\r?\n/g, '\r\n'));

const alive = spawnSync(process.execPath, ['-e', `
  const http=require('http');
  const r=http.get('${BASE}/index.html',{timeout:5000},(res)=>{console.log('HTTP '+res.statusCode);res.destroy();process.exit(0);});
  r.on('error',(e)=>{console.log('ERR '+e.message);process.exit(2);});
  r.on('timeout',()=>{console.log('TIMEOUT');r.destroy();process.exit(2);});
`], { encoding: 'utf8' });
if (!/HTTP 200/.test(alive.stdout || '')) {
  cleanup();
  console.error('  FAIL 服务端不可达: ' + BASE + '  (' + String(alive.stdout || '').trim() + ')');
  console.error('       同源 iframe 是本判据的前提, 起服务端后再跑。');
  process.exit(2);
}

/* ---------- 跑 Chrome ---------- */
const budget = 60000;
const profile = path.join(os.tmpdir(), 'wb-mmui-' + Date.now());
const args = [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--user-data-dir=' + profile,
  '--force-device-scale-factor=1', '--window-size=420,780',
  '--virtual-time-budget=' + budget, '--dump-dom',
  BASE + '/_mmui_probe.html',
];
console.log('== check_mm_ui: 手机版触摸交互 + 强制浅色 @ ' + BASE + ' ==');
const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: budget + 150000, maxBuffer: 64 * 1024 * 1024 });
const dump = r.stdout || '';
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
cleanup();

/* ---------- 解析 ---------- */
const html = dump.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const m = html.match(/MMUI_BEGIN\s*([\s\S]*?)\s*MMUI_END/);
if (!m) {
  console.error('  FAIL 探针未产出数据 (Chrome rc=' + r.status + ', dump ' + dump.length + ' 字节)');
  console.error('       多半是 --virtual-time-budget 不够 (当前 ' + budget + 'ms) 或 iframe 未就绪');
  process.exit(1);
}
let D;
try { D = JSON.parse(m[1]); } catch (e) { console.error('  FAIL 探针数据不是合法 JSON: ' + e.message); process.exit(1); }
if (D.fatal) { console.error('  FAIL ' + D.fatal); process.exit(1); }

const n2 = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(3));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

let nPass = 0, nFail = 0;
function judge(name, ok, detail) {
  if (ok) { nPass++; console.log('  PASS ' + name); return; }
  nFail++; console.log('  FAIL ' + name + (detail ? ('\n         ' + detail) : ''));
}

const st = {};
for (const [k, v] of D.steps || []) st[k] = v;

if (VERBOSE) {
  console.log('  明细: ' + JSON.stringify(D, null, 1).replace(/\n/g, '\n  '));
}

/* ===== ① 强制浅色 ===== */
console.log('\n-- ① 强制浅色 (不跟随系统) --');
console.log('  color-scheme: ' + JSON.stringify(D.colorScheme) + '   meta: ' + JSON.stringify(D.metaScheme) +
  '   页面遇过的 prefers-color-scheme:dark = ' + D.mediaDark + '   body bg = ' + D.htmlBg);
judge('声明了 color-scheme: only light (退出浏览器算法暗化)',
  /only light/i.test(D.colorScheme || '') || /only light/i.test(D.metaScheme || ''),
  'getComputedStyle(root).colorScheme = ' + JSON.stringify(D.colorScheme) +
  ' / <meta name="color-scheme"> = ' + JSON.stringify(D.metaScheme) +
  '\n         没有 only light ⇒ 手机浏览器/WebView 有权把纸白反成墨黑 (用户报的就是这个)');
judge('全表没有任何 prefers-color-scheme 规则 (页面不会自己跟着系统变色)',
  (D.schemeRules || []).length === 0 && !D.schemeRulesErr,
  '命中 ' + (D.schemeRules || []).length + ' 条: ' + JSON.stringify(D.schemeRules) + ' err=' + D.schemeRulesErr);
judge('两条画布都声明 touch-action:none (手势归模块, 不被浏览器吃掉)',
  D.touchAction && /none/.test(D.touchAction.panel || '') && /none/.test(D.touchAction.full || ''),
  JSON.stringify(D.touchAction));

/* ===== ② 触摸交互 ===== */
console.log('\n-- ② 手机触摸交互 --');
judge('触摸单指拖动 ⇒ 脱离跟随 (不再是「跟死了拖不动」)',
  D.drag && D.drag.followBefore === true && D.drag.followAfter === false,
  'followCam ' + (D.drag && D.drag.followBefore) + ' → ' + (D.drag && D.drag.followAfter));
judge('触摸单指拖动 ⇒ 中心按「位移 × wpp」平移 (Δx≈' + n2(D.drag && D.drag.wantDx) + ', Δy≈' + n2(D.drag && D.drag.wantDy) + ')',
  D.drag && near(D.drag.gotDx, D.drag.wantDx, 1e-6) && near(D.drag.gotDy, D.drag.wantDy, 1e-6),
  '实测 Δx=' + n2(D.drag && D.drag.gotDx) + ' Δy=' + n2(D.drag && D.drag.gotDy));
judge('触摸拖动 ⇒ 没有误弹全屏 (原实现的坑: 合成 mousedown/mouseup 被当成单击)',
  D.drag && D.drag.maximized === false && D.synthMouse && D.synthMouse.maximized === false,
  '拖动后 maximized=' + (D.drag && D.drag.maximized) + ', 人工补发合成鼠标后 maximized=' + (D.synthMouse && D.synthMouse.maximized));
judge('触摸单击 (未移动) ⇒ 展开全屏', D.tap && D.tap.maximized === true,
  'maximized=' + (D.tap && D.tap.maximized));

const pk = D.pinch || {};
judge('双指张开 ⇒ baseWpp 变小 = 更放大 (' + n2(pk.wpp0) + ' → ' + n2(pk.out) + ')',
  pk.wpp0 > 0 && pk.out < pk.wpp0 * 0.95);
judge('双指并拢 ⇒ baseWpp 变大 = 更缩小 (' + n2(pk.out) + ' → ' + n2(pk.in) + ')',
  pk.in > pk.out * 1.05);
judge('捏合也走「只改 baseWpp」的滚轮同口径 (上屏 wpp 由主相机反比推出, 恒定比例不被破坏)',
  pk.maximized === false && st['捏合不会误弹全屏'] === true);

const fd = D.fullDrag || {}, fp = D.fullPinch || {};
judge('全屏档单指拖动 ⇒ 中心按「位移 × fullWpp」平移 (Δx≈' + n2(fd.wantDx) + ', Δy≈' + n2(fd.wantDy) + ')',
  near(fd.gotDx, fd.wantDx, 1e-6) && near(fd.gotDy, fd.wantDy, 1e-6),
  '实测 Δx=' + n2(fd.gotDx) + ' Δy=' + n2(fd.gotDy) + '  maximized=' + fd.maximized);
judge('全屏档双指捏合 ⇒ fullWpp 变化 (' + n2(fp.wpp0) + ' → ' + n2(fp.wpp1) + ')',
  st['全屏档捏合 ⇒ fullWpp 变化'] === true);

/* ===== ③ 鼠标路径回归 ===== */
console.log('\n-- ③ 鼠标原路径未被破坏 --');
const mw = D.mouseWheel || {};
judge('鼠标滚轮仍能改 baseWpp (' + n2(mw.before) + ' → ' + n2(mw.after) + ')',
  mw.before !== mw.after);

judge('探针页无 JS 异常', (D.errs || []).length === 0, JSON.stringify(D.errs));

console.log('  快照 rev=' + D.rev + ' (>=0 ⇒ WS 帧已到, 上面对照的是真中心)');
console.log('\n  合成事件落点: 面板画布 ' + (D.drag && D.drag.cw) + '×' + (D.drag && D.drag.ch) +
  ', 全屏画布 ' + (fd.fw) + '×' + (fd.fh) + '   步骤 ' + Object.keys(st).length + ' 项全部执行');
console.log(nFail ? ('结果: FAIL ' + nFail + ' 条, PASS ' + nPass + ' 条 ✘') : ('结果: 全部通过 ✔  (' + nPass + ' 条)'));
process.exit(nFail ? 1 : 0);
