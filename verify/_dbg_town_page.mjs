/* 临时：生成「固定种子 + 相机居中某城市 + 叠加足迹候选盘」的预览页
   用法: node verify/_dbg_town_page.mjs <scale> <out.html> [type] [seed]
   叠加内容(红色)：
     · 37 格候选盘(hexDist≤3)的六边轮廓 —— 足迹「应该」覆盖的范围
     · 中心格十字
   ⇒ 建筑只在盘的一侧 ⇒ 选中集偏斜；均匀铺在盘内 ⇒ 正常 */
import fs from 'fs';

const scale = Number(process.argv[2] || 0.92);
const out = process.argv[3] || 'verify/_dbg_town.html';
const wantType = process.argv[4] || 'city';
const seed = process.argv[5] || 'STARFIX';

let html = fs.readFileSync('灵脉预览.html', 'utf8');
const a = 'seedEl.value = seedEl.value || randomSeed();';
if (html.indexOf(a) < 0) { console.log('✘ 未找到种子锚点'); process.exit(1); }
html = html.replace(a, "seedEl.value = seedEl.value || " + JSON.stringify(seed) + ";");

const PROBE = `
;(function(){
  var S = ${scale}, TYPE = ${JSON.stringify(wantType)};
  var best = null, bd = 1e9;
  for (var ci = -8; ci <= 8; ci++) for (var cj = -8; cj <= 8; cj++){
    var arr = []; try { arr = MapGen.settlementsFor(ci, cj) || []; } catch(e){}
    for (var k = 0; k < arr.length; k++){
      var s2 = arr[k];
      if (s2.type !== TYPE) continue;
      var d = MapGen.hexDist(s2.q, s2.r, 0, 0);
      if (d < bd){ bd = d; best = s2; }
    }
  }
  if (!best){ document.title = 'DBG no-settle'; return; }
  ['cb_road','cb_trade','cb_grid','cb_comm','cb_vein'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.checked = false;
  });
  var w = MapGen.tileToWorld(best.q, best.r);
  scale = S; camX = -w.x * S; camY = -w.y * S;

  /* 叠加层：37 格候选盘 */
  function overlay(){
    var HEX_W = MapGen.HEX_W, HEX_R = MapGen.HEX_R;
    var R = (MapGen.REGION_M ? 3 : 3);
    ctx.save();
    ctx.lineWidth = 1;
    for (var dq = -R; dq <= R; dq++) for (var dr = -R; dr <= R; dr++){
      if (MapGen.hexDist(0,0,dq,dr) > R) continue;
      var ww = MapGen.tileToWorld(best.q + dq, best.r + dr);
      var sp = toScreen(ww.x, ww.y);
      hexPath(sp.x, sp.y, HEX_R * scale * 0.9);
      ctx.strokeStyle = MapGen.hexDist(0,0,dq,dr) === 0 ? 'rgba(255,0,120,0.95)' : 'rgba(255,40,40,0.75)';
      ctx.stroke();
    }
    var c0 = toScreen(w.x, w.y);
    ctx.strokeStyle = 'rgba(255,0,120,0.95)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(c0.x-14,c0.y); ctx.lineTo(c0.x+14,c0.y);
    ctx.moveTo(c0.x,c0.y-14); ctx.lineTo(c0.x,c0.y+14); ctx.stroke();
    ctx.restore();
  }
  var _d = draw;
  draw = function(){ _d(); overlay(); };
  draw();
  document.title = 'DBG ' + best.type + ' ' + best.name + ' q=' + best.q + ' r=' + best.r + ' scale=' + S;
})();
`;

const anchor = html.lastIndexOf('})();');
html = html.slice(0, anchor) + PROBE + html.slice(anchor);
fs.writeFileSync(out, html, 'utf8');
console.log('✔ ' + out + '  type=' + wantType + ' scale=' + scale + ' seed=' + seed);
