/* 临时诊断：把 灵脉预览.html 复制一份，在最后一个 <script> 块最前面注入
   全局错误捕获（红底浮层直接画在页面上），并把种子固定成 STARFIX。
   然后用 chrome --headless --screenshot 截图 —— 报错会直接印在图上。
   用法: node verify/_scratch_diag.mjs <scale> <out.html> [extraJs]
*/
import fs from 'node:fs';

const scale = Number(process.argv[2] || 0);
const out = process.argv[3] || 'verify/_diag.html';
const extraJs = process.argv[4] || '';

let html = fs.readFileSync('灵脉预览.html', 'utf8');

/* 固定种子 */
{
  const a = 'seedEl.value = seedEl.value || randomSeed();';
  if (html.indexOf(a) < 0) { console.log('✘ 未找到种子锚点'); process.exit(1); }
  html = html.replace(a, "seedEl.value = seedEl.value || 'STARFIX';");
}

/* 错误浮层：必须在最后一个 script 块的最前面（页面 IIFE 之前）安装 */
const GUARD = `
window.__ERRS__=[];
window.__T0__=performance.now();
function __st(){
  try{
    var j=terrainJob, lv=Object.keys(terrainLv);
    return 'job='+(j?(j.done+'/'+j.total+' step'+j.stepT):'null')+' lv=['+lv.join(',')+'] mode='+terrainMode;
  }catch(e){ return 'st? '+e.message; }
}
function __paint(){
  var d=document.getElementById('__errbox');
  if(!d){d=document.createElement('div');d.id='__errbox';
    d.style.cssText='position:fixed;left:0;top:0;z-index:99999;background:#c1121f;color:#fff;font:13px/1.45 monospace;padding:8px;max-width:100%;white-space:pre-wrap;pointer-events:none';
    (document.body||document.documentElement).appendChild(d);}
  d.textContent='JS错误 x'+window.__ERRS__.length+'\\n'+window.__ERRS__.slice(-4).join('\\n')+'\\nNOW '+__st();
}
window.addEventListener('error',function(e){
  window.__ERRS__.push('t='+((performance.now()-window.__T0__)|0)+'ms '+(e.message||'?')+' @'+(e.lineno||'?')+':'+(e.colno||'?')+' | '+__st());
  __paint();
});
window.addEventListener('unhandledrejection',function(e){
  var r=e.reason; window.__ERRS__.push('promise: '+((r&&r.message)||r)); __paint();
});
window.__probe=function(){ return __st(); };
`;

/* 注：config 块的注释里也写着「<script>」，故用 lastIndexOf 取真正的最后一块 */
const lastOpen = html.lastIndexOf('<script>') + '<script>'.length;
if (lastOpen < '<script>'.length) { console.log('✘ 未找到 script 块'); process.exit(1); }
html = html.slice(0, lastOpen) + GUARD + html.slice(lastOpen);

/* 相机/缩放探针：把视口摆到中枢附近（或指定 scale 下最近的城镇上） */
const PROBE = `
;(function(){
  if (${scale} > 0) {
    /* 找离中枢最近的一个非秘境聚落，把相机摆到它身上：屏幕 = wrap/2 + 世界*scale + cam */
    var t = null;
    for (var i = -3; i <= 3 && !t; i++) for (var j = -3; j <= 3 && !t; j++){
      var a = MapGen.settlementsFor(i, j) || [];
      for (var k = 0; k < a.length; k++){ if (a[k].type !== 'poi') { t = a[k]; break; } }
    }
    var w = t ? MapGen.tileToWorld(t.q, t.r) : { x: 0, y: 0 };
    scale = ${scale}; camX = -w.x * scale; camY = -w.y * scale;
    window.__town = t ? (t.type + ' ' + (t.name || '') + ' q=' + t.q + ' r=' + t.r) : 'none';
  }
  draw();
  document.title = 'DIAG ' + (window.__ERRS__.length ? 'ERR x' + window.__ERRS__.length : 'no-err') +
    ' | scale=' + scale + ' cellPx=' + (MapGen.HEX_R * (+commClEl.value) * scale).toFixed(1) +
    ' | ' + window.__probe() + (window.__town ? ' | town=' + window.__town : '');
  setTimeout(function(){ __paint(); document.title += ' | END ' + __st(); }, 5000);
  ${extraJs}
})();
`;
const anchor = html.lastIndexOf('})();');
if (anchor < 0) { console.log('✘ 未找到 IIFE 结束锚点'); process.exit(1); }
html = html.slice(0, anchor) + PROBE + html.slice(anchor);

fs.writeFileSync(out, html, 'utf8');
console.log('✔ ' + out + (scale > 0 ? '  scale=' + scale : '  (默认缩放)'));
