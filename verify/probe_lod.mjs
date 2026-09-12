/* ============================================================
 * probe_lod.mjs — 复现「放大后仍复用旧粗级」的场景并读取页面内部 LOD 状态
 * ------------------------------------------------------------
 * 为什么不能只截一张"开局就放大"的图：
 *   老 bug 只在**已有粗级缓存的前提下放大**才出现（terrainEnsure 只看覆盖，
 *   粗级覆盖着视口 → 判为可用 → 永不重建 → 一直糊）。开局即 scale=1 时
 *   需求级一开始就是 1 级，反而不会触发。
 *   所以本脚本：先等默认视野那一级建完（等量为"用户已经看了一会儿"），
 *   再把 scale 跳到目标值（等同滚轮放大）、走真实 draw()/terrainEnsure() 流程，
 *   最后从页面内部读出：want / 实际显示级 / 块宽 / 缓存级列表。
 *
 * 做法：把探针脚本追加进渲染 <script> 块（同作用域，能直接读写 scale/camX/
 *   terrainLv），结果写进 document.title，再用 --dump-dom 取回。
 * 用法: node verify/probe_lod.mjs [url out...]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '灵脉预览.html');
const CHROME = process.env.ZM_CHROME ||
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe');

const PROBE = (target) => `
;(function(){
  var TARGET = ${target};
  var log = [];
  /* 诊断计数：谁在阻止地形重建？ */
  var cDraw = 0, cStart = 0, cEnsure = 0, cRoadDraw = 0;
  var _draw = draw; draw = function(){ cDraw++; return _draw.apply(this, arguments); };
  var _start = terrainStart; terrainStart = function(){ cStart++; return _start.apply(this, arguments); };
  var _ens = terrainEnsure; terrainEnsure = function(){ cEnsure++; return _ens.apply(this, arguments); };
  function snap(){
    var sig = terrainSig();
    var lv = pickTerrainLv(viewRect(), sig);
    return { want: terrainWant, mode: terrainMode, busy: !!terrainJob, timer: !!terrainTimer,
             lv: lv ? lv.stepT : -1, blk: lv ? +lvBlockPx(lv).toFixed(2) : -1,
             levels: terrainLevels(sig) };
  }
  function wait(cond, cb, t0){
    t0 = t0 || Date.now();
    if (cond()) { cb(); return; }
    if (Date.now() - t0 > 20000) { cb(); return; }
    setTimeout(function(){ wait(cond, cb, t0); }, 30);
  }
  /* 阶段1：等默认视野那一级建完（模拟"用户已看过初始画面"） */
  wait(function(){ return !terrainJob && Object.keys(terrainLv).length > 0; }, function(){
    var before = snap(); log.push('before=' + JSON.stringify(before));
    var d0 = cDraw, s0 = cStart, e0 = cEnsure;
    /* 阶段2：直接改 scale —— 与滚轮 handler 同一路径（改 scale → draw → ensure） */
    scale = TARGET; camX = 0; camY = 0;
    draw();
    [0, 50, 120, 200, 400, 900, 1800].forEach(function(dt){
      setTimeout(function(){
        log.push('t' + dt + ':timer=' + (terrainTimer ? 1 : 0) + ',start=' + cStart +
                 ',draw=' + (cDraw - d0) + ',ens=' + (cEnsure - e0));
      }, dt);
    });
    /* 阶段3：等稳定（连续 6 次快照不再变化） */
    var last = '', n = 0;
    var iv = setInterval(function(){
      var s = snap();
      var key = s.want + '|' + s.mode + '|' + s.lv + '|' + s.levels.join(',') + '|' + s.busy + '|' + s.timer;
      if (key === last) n++; else { n = 0; last = key; }
      if ((!s.busy && n >= 6) || Date.now() - window.__probe0 > 25000){
        clearInterval(iv);
        var after = snap();
        document.title = 'LODPROBE target=' + TARGET +
          ' after.want=' + after.want +
          ' after.mode=' + after.mode +
          ' after.lv=' + after.lv +
          ' after.blk=' + after.blk +
          ' after.levels=[' + after.levels.join(',') + ']' +
          ' draws=' + (cDraw - d0) + ' tstart=' + (cStart - s0) + ' ensure=' + (cEnsure - e0) +
          ' timer=' + (after.timer ? 1 : 0) +
          ' | ' + log.join(' ; ');
      }
    }, 25);
  });
  window.__probe0 = Date.now();
})();
`;

const targets = process.argv.slice(2);
const list = targets.length ? targets.map(Number) : [0.25, 0.5, 1.0, 2.0, 4.0];

const html = fs.readFileSync(SRC, 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lodprobe-'));
let ok = true;

for (const t of list) {
  /* 注入到 IIFE 收尾 `})();` 之前 → 与渲染脚本同一作用域
     （注意：注到 </script> 之前会落在 IIFE 外面，scale/terrainLv 全都取不到） */
  const k = html.lastIndexOf('})();');
  const page = html.slice(0, k) + PROBE(t) + html.slice(k);
  const file = path.join(tmpDir, 'lod_' + String(t).replace('.', '_') + '.html');
  fs.writeFileSync(file, page, 'utf8');
  const url = 'file:///' + file.replace(/\\/g, '/');

  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cprof-'));
  const r = spawnSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--user-data-dir=' + prof, '--virtual-time-budget=40000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });

  const dom = r.stdout || '';
  const m = dom.match(/<title>([\s\S]*?)<\/title>/);
  const title = m ? m[1] : '(无 title)';
  console.log('target=%-5s %s', t, title);
  /* 断言：放大后显示级必须跟着变细，且不再是被拉伸的粗光栅 */
  const g = (k2) => { const mm = title.match(new RegExp(k2 + '=([-\\d.]+)')); return mm ? +mm[1] : NaN; };
  const lv = g('after\\.lv'), blk = g('after\\.blk'), want = g('after\\.want');
  const mode = (title.match(/after\.mode=(\w+)/) || [])[1];
  if (!(lv > 0)) { console.log('   ✘ 没读到显示级'); ok = false; }
  else if (mode === 'hex') {
    /* 逐格六边形模式：屏幕上一格就是 blk px 宽，放大多少都清晰，不是粗光栅 */
    if (lv !== 1) { console.log('   ✘ 逐格模式却不是 1 级 (lv=%d)', lv); ok = false; }
    else console.log('   ✔ 逐格六边形（1 级光栅取色）单格 %s px', blk);
  }
  else if (lv > want) { console.log('   ✘ 显示级 %d 比需求级 %d 还粗（复用了旧粗级）', lv, want); ok = false; }
  else if (blk > 20) { console.log('   ✘ 光栅块宽 %s px 仍旧过大（被拉伸的粗级）', blk); ok = false; }
  else console.log('   ✔ 显示级 %d（需求 %d）块宽 %s px', lv, want, blk);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(ok ? '\n=== ✔ LOD 收敛正确 ===' : '\n=== ✘ 存在未收敛/复用旧级 ===');
process.exit(ok ? 0 : 1);
