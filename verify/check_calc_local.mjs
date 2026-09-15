#!/usr/bin/env node
/* ============================================================
 * verify/check_calc_local.mjs — 「地形块前端自算」(S2/S3) 真页面契约
 * ------------------------------------------------------------
 * 出身: 2026-09-15 拍板 —— 主视图地形块改由前端按 seed 本地算, WS 请求的 mask
 *   去掉 CHUNK 位 (31 → 30)。服务端零改动 (needChunk 分支本就支持)。
 *
 * 为什么必须「真页面」:
 *   verify/chunk_selfcalc_ab.mjs 是 Node 侧脚本 —— 它证明的是「磁盘上的引擎一致」,
 *   证明不了「浏览器里间接 eval 出来的那份 MapGen 也一致」(打包顺序 / strict 模式 /
 *   NoiseLib 覆盖都可能让浏览器侧跑出另一份)。所以这里把同一个断言搬进真浏览器:
 *   同源 iframe 装 index.html, 页面自己用 `?chunkab=1` 对每一块做
 *   「本地数组 vs 服务端数组」的逐位比对, 结果挂在 window.__calcProbe()。
 *
 * 手段: 与 check_mm_layout.mjs 同款 —— 同源 iframe 探针页 + 旧版 headless --dump-dom,
 *   纯数字, 不碰 CDP (本页 CDP 会永久挂起), 不读图。
 *
 * 用法:
 *   node verify/check_calc_local.mjs                       # 默认 @ 127.0.0.1:8140
 *   node verify/check_calc_local.mjs http://127.0.0.1:8141
 *   node verify/check_calc_local.mjs --keep                # 保留探针页
 *   node verify/check_calc_local.mjs --verbose
 *   node verify/check_calc_local.mjs --wait=9000           # 每档等待 (默认 7000ms)
 *
 * 退出码: 0 = 全绿 | 1 = 有 FAIL | 2 = 跳过 (无 Chrome / 服务端探不通)
 * 约定: 探针页写在 web/ 下 (同源), 名 web/_calclocal_probe.html —— 被 .gitignore 的
 *       `web/_*` 覆盖, 跑完即删。
 * ⚠ 用旧版 --headless (--headless=new 忽略 --window-size)。
 * ⚠ 必须用「独立实例」的服务端 (8141) 或用户的 8140 —— 两者都只做只读请求。
 * ============================================================ */
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
function opt(k, d) {
  const p = '--' + k + '=';
  const hit = argv.find((s) => s.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
}
const BASE = (argv.find((s) => /^https?:\/\//.test(s)) || 'http://127.0.0.1:8140').replace(/\/$/, '');
const SEED = opt('seed', '20260915');
const WAIT = Number(opt('wait', 7000));
const KEEP = has('keep');
const VERBOSE = has('verbose');

/* 三档:
   hybrid  本地算生产档 —— 实际 mask 必须 30, 且服务端**不再下发任何整块地形**
   server  老链路回退档 —— 实际 mask 31, 服务端照旧下发 (一行未改)
   ab      开发对拍档 (?chunkab=1) —— 实际 mask 仍 31 (要拿服务端块做逐位对拍),
           断言「本地数组 ≡ PB.chunkToArrays(服务端块)」逐位一致
   ⚠ 早期只跑前两档且断言 probe.mask, 那个字段是**意图值**(CALC.local?30:31),
     ?chunkab=1 下与真实请求不符 —— 会给出「已在用 mask=30」的假证据。
     故一律断言 maskEff (main.js 里真实传给 MC.block 的值)。 */
const MODES = [
  { tag: 'hybrid', q: 'calc=hybrid' },
  { tag: 'ab', q: 'calc=hybrid&chunkab=1' },
  { tag: 'server', q: 'calc=server' },
];
/* `--modes=server:calc=server` ⇒ 只跑指定档 (隔离调试用; 缺省跑全部) */
const MODES_ARG = argv.find((s) => s.startsWith('--modes='));
const ACTIVE = MODES_ARG
  ? MODES_ARG.slice('--modes='.length).split(',').map((s) => {
      const i = s.indexOf(':');
      return { tag: s.slice(0, i), q: s.slice(i + 1) };
    })
  : MODES;

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

/* ---------- 探针页: 同源 iframe 里跑真页面, 把 __calcProbe() 原样交出来 ---------- */
const PROBE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>CALCLOCAL</title>
<style>
  html, body { margin: 0; background: #fff; font: 11px/1.4 monospace; }
  /* ⚠ 与 check_mm_layout 的关键差异: iframe **必须在视口内可见**。
     离屏 iframe (left:-20000px) 会被 Chrome 判定为「不可见帧」而节流 rAF ——
     check_mm_layout 只量 CSS 盒 (同步可测) 所以看不出来, 但本脚本要等地形块
     经「rAF 渲染循环 → updateStreaming → pumpChunks → WS → applyBlock」落表,
     rAF 一被节流就永远 0 块。故: iframe 铺满视口 (0,0), <pre> 挪到下方视口外
     (dump-dom 只序列化主文档 DOM, 不看可见性)。 */
  #host { position: absolute; left: 0; top: 0; }
  #host iframe { display: block; border: 0; }
  pre { position: absolute; left: 0; top: 940px; margin: 0; padding: 6px; white-space: pre-wrap; }
</style></head><body>
<div id="host"></div><pre id="out">PENDING</pre>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var seed = q.get('seed') || '20260915';
  var wait = Number(q.get('wait') || 7000);
  var modes = (q.get('modes') || 'hybrid:calc=hybrid&chunkab=1,server:calc=server').split(',');
  var out = document.getElementById('out'), host = document.getElementById('host'), res = [];
  function push() { out.textContent = 'CALCLOCAL_BEGIN\\n' + JSON.stringify(res) + '\\nCALCLOCAL_END'; }
  function step(i) {
    if (i >= modes.length) { document.title = 'CALCLOCAL DONE ' + res.length; return; }
    var m = modes[i].split(':');
    var tag = m[0], qs = m.slice(1).join(':');
    var f = document.createElement('iframe');
    f.width = '1400'; f.height = '900';
    f.style.width = '1400px'; f.style.height = '900px';
    /* capture=1 ⇒ main.js 的 DEBUG 为真 ⇒ 才暴露 __calcProbe(); nofade 去掉淡入抖动 */
    f.src = 'index.html?seed=' + encodeURIComponent(seed) + '&' + qs + '&capture=1&nofade=1';
    f.onload = function () {
      setTimeout(function () {
        var rec = { tag: tag, qs: qs };
        try {
          var w = f.contentWindow;
          var p = (typeof w.__calcProbe === 'function') ? w.__calcProbe() : null;
          rec.probe = p;
          rec.hasFn = !!p;
          /* 附加: 真页面里 meta 是否带来引擎指纹 (S4) */
          try { rec.engineHash = w.MapClient && w.MapClient.engineHash ? w.MapClient.engineHash() : null; }
          catch (e2) { rec.engineHash = 'ERR ' + e2.message; }
          rec.err = null;
          /* 诊断用: 页面若弹了致命错误横幅 (showFatal), 把可见文本带回 Node 侧 */
          try { rec.bodyText = (w.document.body && w.document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300); }
          catch (e3) { rec.bodyText = 'ERR ' + e3.message; }
        } catch (e) { rec.err = String(e); }
        res.push(rec); push();
        f.parentNode.removeChild(f);
        step(i + 1);
      }, wait);
    };
    host.appendChild(f);
  }
  step(0);
})();
<\/script></body></html>
`;

const CHROME = chromePath();
const probePath = path.join(WEB, '_calclocal_probe.html');
const cleanup = () => { if (!KEEP) { try { fs.unlinkSync(probePath); } catch { /* noop */ } } };

if (!CHROME) { console.error('[skip] 未找到 Chrome (可用 --chrome=<路径> 指定)'); process.exit(2); }
if (!fs.existsSync(path.join(WEB, 'index.html'))) { console.error('[skip] 缺 web/index.html'); process.exit(2); }

const alive = spawnSync(process.execPath, ['-e', `
  fetch(${JSON.stringify(BASE + '/index.html')}, { signal: AbortSignal.timeout(6000) })
    .then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
`], { stdio: 'ignore', timeout: 12000 });
if (alive.status !== 0) {
  console.error('[skip] 探不通 ' + BASE + '/index.html —— 先起服务端 (或传 --base 位置参数)');
  process.exit(2);
}

fs.writeFileSync(probePath, PROBE);

/* ⚠ 每档起**独立的 Chrome 进程** —— 早期版本把多档塞进一次 --dump-dom 里串行跑,
   结果第二档恒定 0 块: --virtual-time-budget 是**整个页面**的总额, 第一档的 rAF
   循环/等待会把额度吃掉, 第二档还没连上 WS 就因为虚拟时间耗尽被 dump。
   独立进程各自一份额度, 互不串扰 (代价是多几次 Chrome 冷启动, 换来确定性)。 */
const budget = 20000 + WAIT + 8000;
console.log('== check_calc_local: ' + ACTIVE.length + ' 档 @ ' + BASE + '  seed=' + SEED +
            ' (每档独立 Chrome, 预算 ' + budget + 'ms 虚拟时间) ==');
const rows = [];
for (const mode of ACTIVE) {
  const profile = path.join(os.tmpdir(), 'wb-calclocal-' + mode.tag + '-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });
  const url = BASE + '/_calclocal_probe.html?seed=' + encodeURIComponent(SEED) +
              '&wait=' + WAIT + '&modes=' + encodeURIComponent(mode.tag + ':' + mode.q);
  const args = [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + profile, '--force-device-scale-factor=1',
    '--window-size=1400,900', '--virtual-time-budget=' + budget, '--dump-dom', url,
  ];
  const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: budget + 180000, maxBuffer: 64 * 1024 * 1024 });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  const dump = r.stdout || '';
  const html = dump.replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const mm = html.match(/CALCLOCAL_BEGIN\s*([\s\S]*?)\s*CALCLOCAL_END/);
  if (!mm) {
    console.error('  FAIL [' + mode.tag + '] 探针未产出数据 (Chrome rc=' + r.status +
                  ', dump ' + dump.length + ' 字节)');
    console.error('       多半是 --virtual-time-budget 不够 (当前 ' + budget + 'ms) 或页面卡住');
    process.exit(1);
  }
  let one;
  try { one = JSON.parse(mm[1]); } catch (e) {
    console.error('  FAIL [' + mode.tag + '] 探针数据不是合法 JSON: ' + e.message);
    process.exit(1);
  }
  rows.push(...one);
  if (VERBOSE) { console.log('--- ' + mode.tag + ' ---'); console.log(JSON.stringify(one[0], null, 1)); }
}
cleanup();

let nPass = 0, nFail = 0;
function judge(name, fn) {
  const errs = [];
  for (const x of rows) {
    const e = fn(x);
    if (e) errs.push(x.tag + ': ' + e);
  }
  if (errs.length) { nFail++; console.log('  FAIL ' + name); for (const e of errs) console.log('         ' + e); }
  else { nPass++; console.log('  PASS ' + name); }
}
const pick = (tag) => rows.find((x) => x.tag === tag) || {};
const hy = pick('hybrid'), sv = pick('server'), abm = pick('ab');

/* ① 三档都必须把块落到 chunkData (否则后面全是空断言) */
judge('三档都真的加载了地形块 (chunksLocal >= 6)', (x) => {
  if (x.err) return x.err;
  if (!x.probe) return '__calcProbe 缺失 (capture=1 未生效?)';
  return x.probe.chunksLocal >= 6 ? '' : ('只落了 ' + x.probe.chunksLocal + ' 块');
});

/* ② hybrid: 引擎就绪 + 本地算生效 + **实际**请求掩码 = 30 */
judge('hybrid 档: 引擎就绪, 本地算生效, 实际请求掩码 = 30 (去掉 CHUNK 位)', (x) => {
  if (x.tag !== 'hybrid') return '';
  if (x.err) return x.err;
  const p = x.probe;
  if (!p) return '__calcProbe 缺失';
  if (!p.local) return 'CALC.local = false (引擎未就绪或指纹漂移)';
  if (p.maskEff !== 30) return 'maskEff = ' + p.maskEff + ' (期望 30)';
  if (!p.calc || !p.calc.ready) return '引擎未 ready';
  if (!p.calc.seed) return '引擎 seed 未应用';
  return '';
});
judge('server 档: 未启用本地算, 实际请求掩码 = 31 (老链路一行不改)', (x) => {
  if (x.tag !== 'server') return '';
  if (x.err) return x.err;
  const p = x.probe;
  if (!p) return '__calcProbe 缺失';
  if (p.local) return 'CALC.local = true (server 档不该启用)';
  if (p.maskEff !== 31) return 'maskEff = ' + p.maskEff + ' (期望 31)';
  return '';
});

/* ③ 本次改造的**目的断言**: 生产档下服务端不再下发任何整块地形。
     这是除了看服务端日志以外唯一的可观测证据 —— mask=30 若没真正生效
     (比如被某处覆盖回 ALL), 这里立刻红。 */
judge('服务端已停止下发整块地形 (hybrid 档 chunkPkts = 0)', (x) => {
  if (x.tag !== 'hybrid') return '';
  if (x.err) return x.err;
  const ab = x.probe && x.probe.ab;
  if (!ab) return 'ab 段缺失';
  return ab.chunkPkts === 0 ? '' : ('收到 ' + ab.chunkPkts + ' 个 chunk 包 (掩码没生效?)');
});
judge('server 档对照: 服务端照旧下发 (chunkPkts > 0, 证明计数有效而非恒 0)', (x) => {
  if (x.tag !== 'server') return '';
  if (x.err) return x.err;
  const ab = x.probe && x.probe.ab;
  if (!ab) return 'ab 段缺失';
  return ab.chunkPkts > 0 ? '' : 'chunkPkts = 0 —— 计数可能失灵 (假阴性风险)';
});

/* ④ 核心: 真页面里「本地数组」与「服务端数组」逐位一致 (chunkab=1) */
judge('真页面逐位比对: 至少 3 块, 0 处差异 (本地数组 ≡ PB.chunkToArrays 结果)', (x) => {
  if (x.tag !== 'ab') return '';
  if (x.err) return x.err;
  if (x.probe && x.probe.maskEff !== 31) {
    return 'maskEff = ' + x.probe.maskEff + ' —— 对拍档须带 CHUNK 位才拿得到服务端块';
  }
  const ab = x.probe && x.probe.ab;
  if (!ab) return 'ab 段缺失';
  if (ab.chunkPkts < 3) return ('只收到 ' + ab.chunkPkts + ' 个 chunk 包');
  if (ab.blocks < 3) return ('只比了 ' + ab.blocks + ' 块 (chunkab 未生效?)');
  if (ab.diff !== 0) return (ab.diff + ' 处差异 (坏块 ' + ab.badBlocks + ')');
  if (ab.badBlocks !== 0) return ('坏块 ' + ab.badBlocks);
  return '';
});
judge('逐段都有样本被比过 (9 段: centers/tiles/elevs/hashes/neigh/prop*)', (x) => {
  if (x.tag !== 'ab') return '';
  if (x.err) return x.err;
  const seg = (x.probe && x.probe.ab && x.probe.ab.seg) || {};
  const need = ['centers', 'tiles', 'elevs', 'hashes', 'neigh'];
  const miss = need.filter((k) => !seg[k] || seg[k].n < 100);
  if (miss.length) return ('样本不足: ' + miss.join(','));
  const bad = Object.keys(seg).filter((k) => seg[k].d > 0);
  return bad.length ? ('仍有差异的段: ' + bad.join(',')) : '';
});

/* ④ 几何同源: geo.hexW/hexR 必须与引擎常量一致 (centers 公式的前提) */
judge('geo.hexW/hexR 与引擎 HEX_W/HEX_R 同源', (x) => {
  if (x.err) return x.err;
  const c = x.probe && x.probe.calc;
  if (!c) return 'calc 段缺失';
  if (c.hexOk === null) return 'geo 未就绪';
  return c.hexOk === true ? '' : 'geo 与引擎常量不一致';
});

/* ⑤ 无请求风暴: 本地算失败计数必须为 0 (拆错兜底分支的典型症状) */
judge('无请求风暴 (localFail = 0, 分帧队列收敛)', (x) => {
  if (x.err) return x.err;
  const p = x.probe;
  if (!p) return '__calcProbe 缺失';
  if (p.localFail > 0) return ('localFail = ' + p.localFail);
  if (p.deferred > 24) return ('分帧队列积压 ' + p.deferred + ' 块');
  return '';
});

/* ⑥ S5: 首屏长任务。⚠ 必须**归因**, 不能只看 hybrid 的绝对值 ——
   observer 在 main.js 模块初始化时就挂上了 (`main.js:195`), 它同时把 WebGL 上下文创建、
   着色器编译、图集构建、引擎 eval/init 全算进来。所以"hybrid 最长 276ms"根本不说明
   本地算顶出了长任务。
   上一版判据就是只看绝对值 ⇒ 在 headless 软件 GL 下**恒红 276ms**, 与本地算无关 (假红)。
   本版改成 **A/B 归因**: 本地算若真顶出长任务, hybrid 必然显著高于 server 档 (server 档
   一行本地算都不跑); 两者相近 ⇒ 那是启动开销, 不是本次改造引入的。
   ⚠ 余量取 40ms: 本地算的边际成本 ~115ms/48块 是**分摊到多帧**的, 单帧不该再多出一个长任务。 */
judge('首屏长任务不因本地算而恶化 (S5: hybrid ≤ server + 40ms 余量)', (x) => {
  if (x.tag !== 'hybrid') return '';
  if (x.err) return x.err;
  const h = x.probe && x.probe.longTask;
  if (!h) return 'longTask 段缺失';
  if (h.n === 0) return '';                       // 未触发 = 通过 (无采样支持同义)
  const sv = (rows.find((r) => r.tag === 'server') || {}).probe;
  const sl = sv && sv.longTask;
  if (!sl || sl.n === 0) {
    return ('无法归因: server 档无长任务采样 (hybrid 最长 ' + h.maxMs +
            'ms) —— server 档也拿不到数字时只能人工看');
  }
  const tol = 40;
  if (h.maxMs <= sl.maxMs + tol) return '';
  return ('hybrid 最长 ' + h.maxMs + 'ms vs server ' + sl.maxMs + 'ms —— 超 ' + tol +
          'ms 余量, 本地算确实顶出了长任务 (该上 Worker 或调小 chunkbudget)');
});

/* ⑦ S4: meta 必须带引擎指纹 (服务端已升级时才断言; 老服务端 = null ⇒ 提示重启) */
judge('meta 下发 engineHash (S4 握手字段)', (x) => {
  if (x.err) return x.err;
  const h = x.engineHash;
  if (h === null || h === undefined) return 'meta 无 engineHash —— 服务端未重启到含 S4 的构建';
  if (typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)) return '';
  return 'engineHash 形态异常: ' + JSON.stringify(h);
});

console.log('');
function line(tag, x, extra) {
  if (!x || !x.probe) { console.log('  ' + tag + ': (无数据)'); return; }
  const p = x.probe, ab = p.ab || {};
  const lt = p.longTask || {};
  console.log('  ' + tag + ': local=' + p.local + ' maskEff=' + p.maskEff +
    ' 块=' + p.chunksLocal + ' 服务端chunk包=' + (ab.chunkPkts || 0) +
    ' 首屏最长任务=' + (lt.n ? lt.maxMs + 'ms(' + lt.n + '次)' : '无') + extra);
}
line('hybrid ', hy, '  | 引擎 seed=' + (hy.probe && hy.probe.calc && hy.probe.calc.seed));
line('ab     ', abm, '  逐位比对 ' + ((abm.probe && abm.probe.ab && abm.probe.ab.blocks) || 0) +
                    ' 块 / 差异 ' + ((abm.probe && abm.probe.ab && abm.probe.ab.diff) || 0));
line('server ', sv, '');
console.log(nFail ? ('结果: FAIL ' + nFail + ' 条, PASS ' + nPass + ' 条 ✘')
                  : ('结果: 全部通过 ✔  (' + nPass + ' 条)'));
process.exit(nFail ? 1 : 0);
