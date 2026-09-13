/* 临时诊断：聚落中心 vs 建筑足迹的几何关系
   目的：查清「附属建筑全都挤在聚落标记的一侧」到底是
         (a) 足迹整体相对中心偏移，还是 (b) 标记半径远大于足迹半径（把中间全盖住）
   用法: node verify/_dbg_town_geom.mjs [seed] [scale]
*/
import fs from 'fs';

const SEED = process.argv[2] || 'geom-a';
const SCALE = Number(process.argv[3] || 0.92);

const html = fs.readFileSync('灵脉预览.html', 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
global.window = global;
(0, eval)(blocks[0] + '\n' + blocks[1] + '\n' + blocks[2]);
const M = global.MapGen;
M.init(SEED);

const HEX_R = M.HEX_R, HEX_W = M.HEX_W, RM = M.REGION_M;
const t2w = (q, r) => ({ x: HEX_W * (q + r / 2), y: 1.5 * HEX_R * r });
const markBase = Math.max(2, Math.min(16, RM * HEX_W * SCALE * 0.16));
const tilePx = HEX_R * SCALE;
console.log(`seed=${SEED} HEX_R=${HEX_R} HEX_W=${HEX_W.toFixed(4)} REGION_M=${RM} scale=${SCALE}`);
console.log(`tilePx=${tilePx.toFixed(2)}px  markBase=${markBase.toFixed(2)}px  ` +
  `城市标记半径=${(markBase * 1.5).toFixed(1)} 城镇=${markBase.toFixed(1)} 村庄=${(markBase * 0.65).toFixed(1)}`);

/* 扫一片区域，按类型收几个聚落 */
const found = { city: [], town: [], village: [] };
for (let i = -3; i <= 3 && found.city.length < 2; i++) {
  for (let j = -3; j <= 3 && found.city.length < 2; j++) {
    let arr = [];
    try { arr = M.settlementsFor(i, j) || []; } catch (e) { }
    for (const s of arr) if (found[s.type] && found[s.type].length < 3) found[s.type].push(s);
  }
}
if (!found.city.length) {
  for (let i = -6; i <= 6 && found.city.length < 1; i++)
    for (let j = -6; j <= 6 && found.city.length < 1; j++) {
      let arr = []; try { arr = M.settlementsFor(i, j) || []; } catch (e) { }
      for (const s of arr) if (s.type === 'city') found.city.push(s);
    }
}

for (const type of ['city', 'town', 'village']) {
  const st = found[type][0];
  if (!st) { console.log(`\n--- ${type}: 附近未找到 ---`); continue; }
  const plan = M.growTownFootprint(st.id, st.type, st.q, st.r);
  const c = t2w(st.q, st.r);
  const tier = type === 'city' ? 1.5 : type === 'town' ? 1.0 : 0.65;
  const mr = markBase * tier;
  console.log(`\n--- ${type} 「${st.name}」 id=${st.id} 中心格=(${st.q},${st.r}) 建房 ${plan ? plan.buildings.length : 0} 座 ---`);
  if (!plan) continue;
  let ds = [], dx = [], dy = [];
  for (const b of plan.buildings) {
    const w = t2w(b.q, b.r);
    ds.push(M.hexDist(b.q, b.r, st.q, st.r));
    dx.push(w.x - c.x); dy.push(w.y - c.y);
  }
  const mn = a => Math.min(...a), mx = a => Math.max(...a);
  console.log(`  足迹半径(格): hexDist min=${mn(ds)} max=${mx(ds)}`);
  console.log(`  世界偏移 dx=[${mn(dx).toFixed(1)}, ${mx(dx).toFixed(1)}]  dy=[${mn(dy).toFixed(1)}, ${mx(dy).toFixed(1)}]`);
  /* 屏幕跨度：六边形按 r0 = max(2, tilePx*0.86) 画 (含半个六边形本体) */
  const r0 = Math.max(2.0, tilePx * 0.86);
  const halfW = Math.sqrt(3) / 2 * r0;                 // 尖顶六边形半宽
  const sx = [mn(dx) * SCALE - halfW, mx(dx) * SCALE + halfW];
  const sy = [mn(dy) * SCALE - r0, mx(dy) * SCALE + r0];
  console.log(`  建筑层屏幕跨度 x=[${sx[0].toFixed(1)}, ${sx[1].toFixed(1)}] (宽 ${(sx[1]-sx[0]).toFixed(1)}px)` +
    `  y=[${sy[0].toFixed(1)}, ${sy[1].toFixed(1)}] (高 ${(sy[1]-sy[0]).toFixed(1)}px)`);
  console.log(`  聚落标记覆盖 x=[${(-mr).toFixed(1)}, ${mr.toFixed(1)}] y=[${(-mr).toFixed(1)}, ${mr.toFixed(1)}]`);
  const coverX = mr - (sx[1] - sx[0]) / 2, coverY = mr - (sy[1] - sy[0]) / 2;
  console.log(`  ⇒ 标记比建筑层宽 ${coverX.toFixed(1)}px / 高 ${coverY.toFixed(1)}px ` +
    (coverX > 0 && coverY > 0 ? '【标记把整个足迹包住 → 只剩边角露头】' : ''));
  /* 建筑层在屏幕上的中心（应 ≈ 0,0） */
  console.log(`  建筑层屏幕质心 x=${((sx[0]+sx[1])/2).toFixed(2)} y=${((sy[0]+sy[1])/2).toFixed(2)} (应≈0,0)`);
}
