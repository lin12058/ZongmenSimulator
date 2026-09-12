/* preview_fixedpage.mjs — 生成「固定种子 + 固定缩放 + 相机居中某大灵脉」的临时预览页
 * ------------------------------------------------------------
 * 用途：给预览页做可复现的视觉断言（截图 / 裁 1:1 看形状朝向）。
 *   ① 页面本身每次加载都随机种子 → 不固定的话两次截图是两张不同的世界，没法对照；
 *   ② 想特写某个大灵脉，得把相机摆到它身上 —— 相机语义（预览页 toScreen）：
 *        屏幕 = wrap中心 + 世界×scale + cam
 *      ⇒ 把世界点 (wx,wy) 摆到屏幕中心: cam = (-wx*scale, -wy*scale)
 *
 * 用法:
 *   node verify/preview_fixedpage.mjs <scale> <out.html> [extraJs]
 *     scale   目标缩放（如 0.077 默认视野 / 1 / 4 特写）
 *     out     输出临时页
 *     extraJs 可选，紧跟 draw() 之后执行（如 "document.getElementById('cb_vein').checked=false; draw();"）
 * 之后配合 shot.mjs 截图、crop_png.mjs 裁局部。
 *
 * ⚠️ shot.mjs 每次截出的 PNG 像素尺寸不固定（实测同一页面出现过 2229×1286 与 1484×856，
 *    整体等比缩放）→ 裁图坐标必须按「PNG 宽高 × 比例」推，不能写死像素。
 */
import fs from 'fs';

const scale   = Number(process.argv[2] || 1);
const out     = process.argv[3] || 'verify/tmp_fixedpage.html';
const extraJs = process.argv[4] || '';

let html = fs.readFileSync('灵脉预览.html', 'utf8');

/* 固定种子：同一世界才可复现/可对照 */
{
  const a = 'seedEl.value = seedEl.value || randomSeed();';
  if (html.indexOf(a) < 0) { console.log('✘ 未找到初始种子锚点'); process.exit(1); }
  html = html.replace(a, "seedEl.value = seedEl.value || 'STARFIX';");
}

const PROBE = `
;(function(){
  var S = ${scale};
  /* 找离中枢最近的大灵脉（level 0） */
  var best = null, bd = 1e9;
  for (var ci = -4; ci <= 4; ci++) for (var cj = -4; cj <= 4; cj++){
    var cm = MapGen.communityOf(ci, cj);
    if (!cm || !cm.veins) continue;
    for (var k = 0; k < cm.veins.length; k++){
      var v = cm.veins[k];
      if (v.level !== 0) continue;
      var d = MapGen.hexDist(v.q, v.r, 0, 0);
      if (d < bd){ bd = d; best = v; }
    }
  }
  if (!best){ document.title = 'FIXEDPAGE no-vein'; return; }
  var w = MapGen.tileToWorld(best.q, best.r);
  scale = S; camX = -w.x * S; camY = -w.y * S;
  draw();
  ${extraJs}
  document.title = 'FIXEDPAGE q=' + best.q + ' r=' + best.r + ' name=' + best.name +
    ' scale=' + S + ' dist=' + bd + '格';
})();
`;

const anchor = html.lastIndexOf('})();');
if (anchor < 0) { console.log('✘ 未找到 IIFE 结束锚点'); process.exit(1); }
html = html.slice(0, anchor) + PROBE + html.slice(anchor);

fs.writeFileSync(out, html, 'utf8');
console.log('✔ ' + out + '  scale=' + scale + (extraJs ? '  +extraJs' : ''));
