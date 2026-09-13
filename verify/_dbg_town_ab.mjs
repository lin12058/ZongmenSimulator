/* 临时：旧/新 mapgen 双引擎对拍
   目的：证明修好后
     ① 建筑「组成」逐项不变 —— 每镇 (terrain,kind) 多重集 + resources 清单完全相同
        (即地皮配额/产出聚合口径没被改动，落库数据语义不变)
     ② 只有「格位分布」变了 —— 建筑相对中心的方位角覆盖从「半边」变成「绕一圈」
   用法: node verify/_dbg_town_ab.mjs [seedCount]
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = 'D:/codes/宗门模拟器demo';
const EJ = path.join(ROOT, 'Server/Zongmen/Engine/js');

/* 旧版 = 灵脉预览.html 里的内联副本（本次修改前同步进去的那份） */
const html = fs.readFileSync(path.join(ROOT, '灵脉预览.html'), 'utf8');
const mk = '/*======== 引擎 mapgen.js 内联副本';
const m0 = html.indexOf(mk);
const hEnd = html.indexOf('*/', m0) + 2;
const bEnd = html.indexOf('</script>', hEnd);
const OLD_MAPGEN = html.slice(hEnd, bEnd).replace(/\r\n/g, '\n');
const NEW_MAPGEN = fs.readFileSync(path.join(EJ, 'mapgen.js'), 'utf8');
const CFG = fs.readFileSync(path.join(EJ, 'mapgen-config.js'), 'utf8');
const NOISE = fs.readFileSync(path.join(EJ, 'noise.js'), 'utf8');

if (OLD_MAPGEN.trim() === NEW_MAPGEN.trim()) { console.log('✘ 新旧同源，无法对拍'); process.exit(1); }

function loadEngine(mapgenSrc) {
  const sandbox = {};
  sandbox.global = sandbox; sandbox.window = sandbox;
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(NOISE + '\n' + CFG + '\n' + mapgenSrc, sandbox, { filename: 'engine.js' });
  return sandbox.MapGen;
}

const OLD = loadEngine(OLD_MAPGEN);
const NEW = loadEngine(NEW_MAPGEN);
const HEX_W = NEW.HEX_W, HEX_R = NEW.HEX_R;

const N = Number(process.argv[2] || 6);
let nSettle = 0, compBad = 0, resBad = 0, kindDiff = 0, movedTowns = 0;
const covOld = [], covNew = [], biasOLD = [], biasNEW = [];
const byType = { village: { idx: [] }, town: { idx: [] }, city: { idx: [] }, sect: { idx: [] } };

for (let s = 0; s < N; s++) {
  const seed = 'ab-' + s;
  OLD.init(seed); NEW.init(seed);
  for (let gi = -3; gi <= 3; gi++) for (let gj = -3; gj <= 3; gj++) {
    const A = (() => { try { return OLD.settlementsFor(gi, gj) || []; } catch (e) { return []; } })();
    const B = (() => { try { return NEW.settlementsFor(gi, gj) || []; } catch (e) { return []; } })();
    if (A.length !== B.length) { console.log('✘ 聚落数不一致', seed, gi, gj, A.length, B.length); process.exit(1); }
    for (let k = 0; k < A.length; k++) {
      const a = A[k], b = B[k];
      if (a.id !== b.id || a.q !== b.q || a.r !== b.r) { console.log('✘ 聚落本身不一致', a.id, b.id); process.exit(1); }
      if (a.type === 'poi') continue;
      const pa = OLD.growTownFootprint(a.id, a.type, a.q, a.r);
      const pb = NEW.growTownFootprint(b.id, b.type, b.q, b.r);
      nSettle++;
      /* ① 地皮构成必须逐项相同（决定城镇风格与产出「种类」） */
      const keyT = x => x.buildings.map(v => v.terrain).sort().join(',');
      if (keyT(pa) !== keyT(pb)) {
        compBad++;
        if (compBad <= 3) console.log(`✘ 地皮构成变了 [${seed} ${a.id} ${a.type}]\n   旧 ${keyT(pa)}\n   新 ${keyT(pb)}`);
      }
      /* 地皮相同 ⇒ 池子相同；具体建筑(农田/磨坊/谷仓)由「格」的 hash 决定，
         换格必然重抽 → 只统计，不作判据 */
      const keyK = x => x.buildings.map(v => v.terrain + '/' + v.kind).sort().join(',');
      if (keyK(pa) !== keyK(pb)) kindDiff++;
      const ra = JSON.stringify(pa.resources), rb = JSON.stringify(pb.resources);
      if (ra !== rb) { resBad++; }
      if (pa.buildings.map(x => x.q + ',' + x.r).sort().join(' ') !== pb.buildings.map(x => x.q + ',' + x.r).sort().join(' ')) movedTowns++;
      /* ② 格位分布：把建筑相对中心投到 12 个 30° 扇区，看覆盖了几个扇区 */
      const fan = plan => {
        const set = new Set();
        for (const v of plan.buildings) {
          const dq = v.q - a.q, dr = v.r - a.r;
          const ang = Math.atan2(1.5 * dr, dq + dr / 2);
          set.add(Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 12) % 12);
        }
        return set.size;
      };
      covOld.push(fan(pa)); covNew.push(fan(pb));
      /* 方位角质心模长（排除中心格）：≈1 表示建筑全挤在同一方向，≈0 表示绕中心均匀 */
      const bias = plan => {
        let sx = 0, sy = 0, m = 0;
        for (const v of plan.buildings) {
          const dq = v.q - a.q, dr = v.r - a.r;
          if (dq === 0 && dr === 0) continue;
          const ang = Math.atan2(1.5 * dr, dq + dr / 2);
          sx += Math.cos(ang); sy += Math.sin(ang); m++;
        }
        return m ? Math.hypot(sx, sy) / m : 0;
      };
      biasOLD.push(bias(pa)); biasNEW.push(bias(pb));
      if (byType[a.type]) byType[a.type].idx.push(covOld.length - 1);
    }
  }
}
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
const minOf = a => Math.min(...a);
console.log(`\n对拍聚落 ${nSettle} 个 / ${N} 个种子`);
console.log(`  ① 地皮构成不同: ${compBad}   ← 必须为 0 (决定城镇风格/产出口径)`);
console.log(`     同类地皮内具体建筑重抽(农田↔磨坊↔谷仓): ${kindDiff} (${(kindDiff / nSettle * 100).toFixed(1)}%)  ← 换格的必然副作用`);
console.log(`     resources 数值变化: ${resBad} (${(resBad / nSettle * 100).toFixed(1)}%)`);
console.log(`  ② 格位发生变化的城镇: ${movedTowns} (${(movedTowns / nSettle * 100).toFixed(1)}%)`);
console.log(`     方位角扇区覆盖(12 扇): 旧 均值 ${avg(covOld)} 最小 ${minOf(covOld)} | 新 均值 ${avg(covNew)} 最小 ${minOf(covNew)}`);

/* ③ 直接量「偏斜」：只用非中心建筑算方位角质心，越接近 0 = 越均匀 (旧版应显著偏向 -x) */
console.log(`     方位角质心 |Σe^{iθ}|/n (1=全在同一方向, 0=绕圈均匀): 旧 ${avg(biasOLD)} | 新 ${avg(biasNEW)}`);
console.log(`\n  按类型拆分:`);
for (const t of ['village', 'town', 'city', 'sect']) {
  const idx = byType[t].idx;
  if (!idx.length) continue;
  const pick = a => avg(idx.map(i => a[i])), mn = a => minOf(idx.map(i => a[i]));
  console.log(`    ${t.padEnd(8)} n=${String(idx.length).padStart(3)}  扇区 旧 ${pick(covOld)}/${mn(covOld)} → 新 ${pick(covNew)}/${mn(covNew)}` +
    `   偏斜 旧 ${pick(biasOLD)} → 新 ${pick(biasNEW)}`);
}
if (!globalThis.__dumped) {
  globalThis.__dumped = 1;
}
