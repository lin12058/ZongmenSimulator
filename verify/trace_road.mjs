/* ============================================================
 * trace_road.mjs — 寻路追踪: 对给定种子+两个聚落名, 逐格对比
 *   ① 引擎实际路径 (A*+复用) 的每格 biome/代价
 *   ② 直线走廊参照路径的每格 biome/代价
 *   ③ 复用优惠在哪些格生效
 * 用法: node verify/trace_road.mjs <seed> <聚落名A> <聚落名B> [扫描半径=20]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const [seed, nameA, nameB, spanArg] = process.argv.slice(2);
if (!seed || !nameA || !nameB) { console.log('用法: node verify/trace_road.mjs <seed> <聚落名A> <聚落名B> [半径]'); process.exit(1); }
const SPAN = parseInt(spanArg || '20', 10);
const ctx = { window: {}, console, Math, Map, Set, performance };
ctx.globalThis = ctx; vm.createContext(ctx);
for (const f of ['noise.js','mapgen-config.js','mapgen.js']) ctx.globalThis && vm.runInContext(fs.readFileSync(path.join(JSDIR, f), 'utf8'), ctx);
const MG = ctx.window.MapGen;
MG.init(seed);
const BN = ['深海','浅海','沙岸','草地','林地','沙漠','山地','雪峰'];
const roadTileIdx = new Set();
for (let i = -SPAN-1; i <= SPAN+1; i++) for (let j = -SPAN-1; j <= SPAN+1; j++) {
  for (const rd of MG.roadsNear(i, j, 9999)) for (const t of rd.tiles) roadTileIdx.add(t);
}
// 按名字找聚落
let A = null, B = null;
for (let i = -SPAN-1; i <= SPAN+1 && (!A || !B); i++) for (let j = -SPAN-1; j <= SPAN+1; j++) {
  for (const s of MG.settlementsFor(i, j)) {
    if (s.name === nameA) A = s;
    if (s.name === nameB) B = s;
  }
}
if (!A || !B) { console.log('✘ 找不到聚落:', !A ? nameA : '', !B ? nameB : '', '(本窗口内存在的名字样例见上)'); 
  const names = new Set();
  for (let i = -SPAN; i <= SPAN; i++) for (let j = -SPAN; j <= SPAN; j++) for (const s of MG.settlementsFor(i,j)) if (s.type!=='poi') names.add(s.name);
  console.log('窗口内聚落名:', [...names].slice(0, 40).join('、'));
  process.exit(2);
}
const roadW = MG.CFG.ROAD_W_ROAD|0, corrD = MG.CFG.ROAD_REUSE_CORRIDOR|0;
const Q = (dq,dr)=>dq*dq+dq*dr+dr*dr;
const sq=A.q, sr=A.r, gq=B.q, gr=B.r;
const vdq=gq-sq, vdr=gr-sr, Qv=Q(vdq,vdr);
function tileW(q, r) {
  let w = MG.roadWeight(MG.fields(q, r));
  let reused = false;
  if (roadTileIdx.has(q+','+r)) {
    const udq=q-sq, udr=r-sr, Qu=Q(udq,udr);
    const B=2*udq*vdq+udq*vdr+udr*vdq+2*udr*vdr;
    let ic;
    if (B<0) ic = Qu<=corrD*corrD;
    else if (B>2*Qv){const a=q-gq,b=r-gr; ic=Q(a,b)<=corrD*corrD;}
    else ic = 4*Qu*Qv-B*B <= 4*corrD*corrD*Qv;
    if (ic) { w = roadW; reused = true; }
  }
  return { w, reused };
}
const pa = MG.bfsRoad(sq, sr, gq, gr, roadTileIdx);
console.log(`== ${A.name}(${A.q},${A.r}) → ${B.name}(${B.q},${B.r})  六边距=${MG.hexDist(sq,sr,gq,gr)} ==`);
if (!pa) { console.log('引擎判定: 不可达'); process.exit(0); }
let c = 0, reuseTiles = 0, seq = '';
const rows = [];
for (let k = 1; k < pa.length; k++) {
  const q = pa[k][0], r = pa[k][1];
  const f = MG.fields(q, r);
  const { w, reused } = tileW(q, r);
  c += w; if (reused) reuseTiles++;
  seq += BN[f.biome][0];
  rows.push({ k, q, r, biome: BN[f.biome], w, reused });
}
console.log(`实际路径: ${pa.length-1} 步, 总代价=${c}, 其中复用格(2费)=${reuseTiles}`);
console.log('地形序列:', seq);
// 直线参照
function hexLine(q0,r0,q1,r1){
  const N = Math.max(Math.abs(q1-q0), Math.abs(r1-r0), Math.abs(q1-q0+r1-r0));
  const out=[];
  for(let k=0;k<=N;k++){const t=k/N;const qf=q0+(q1-q0)*t,rf=r0+(r1-r0)*t;
    const xf=qf,yf=-qf-rf,zf=rf;let x=Math.round(xf),y=Math.round(yf),z=Math.round(zf);
    const dx=Math.abs(x-xf),dy=Math.abs(y-yf),dz=Math.abs(z-zf);
    if(dx>dy&&dx>dz)x=-y-z;else if(dy>dz)y=-x-z;else z=-x-y;out.push([x,z]);}
  return out;
}
const line = hexLine(sq, sr, gq, gr);
let lc = 0, lseq = '', lbad = 0;
for (const [q, r] of line) {
  const f = MG.fields(q, r);
  if (!f) { lbad++; continue; }
  const { w, reused } = tileW(q, r);
  lc += reused ? roadW : w;   // 直线走廊内也可复用 (A* 同规则)
  lseq += BN[f.biome][0] + (reused ? '*' : '');
}
console.log(`直线参照: ${line.length-1} 步, 总代价=${lc}${lbad?` (跳过${lbad}个无效格)`:''}`);
console.log('直线地形序列 (*=该格是可复用的已铺路):', lseq);
console.log(`结论: 实际(${c}) vs 直线(${lc}) → ${c < lc ? '实际更便宜, 绕行是最优 ✓' : c === lc ? '等价' : '⚠ 实际更贵 — 存在 bug!'}`);
