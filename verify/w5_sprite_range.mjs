/* ============================================================
 * w5_sprite_range.mjs — 立体精灵索引契约回归 (离线 Node, 不需起服务)
 *
 * 断言「真实实现」propSpriteFor 的输出契约 (不复刻逻辑, 避免测试与实现漂移)。
 *
 * 契约来源 (三处必须一致):
 *   textures.js buildAtlas():  第5行 40..47 = 山40/41·雪42/43·林44..47
 *                              第6行 48..54 = 沙48·草丛49·灵脉峰50..54   ← 55 未绘制(空)
 *                              第7行 56..63 = 山B 56/57·雪B 58/59·丘60/61·孤树62/63
 *   renderer.js PROP_FS:       col = sprite%8, row = floor(sprite/8) → 索引即 (col,row) 定位
 *   renderer.js PROP_VS:       高度分支按 40/41·42/43·44..49·50..54·56/57·58/59·60..63 分段
 *
 * 历史 bug (本脚本的由来): 森林分支 `44 + (h2*5.34|0)` 在 h2∈[0.749064,0.75) 溢出到 48,
 *   使 0.105% 的森林格画出沙漠精灵 (实测 8/7620)。若索引落到未绘制格(如 55), 该精灵会静默不可见。
 *
 * 用法: node verify/w5_sprite_range.mjs [seed] [半径块数]
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED = process.argv[2] || '42';
const RAD = parseInt(process.argv[3] || '8', 10);

global.window = globalThis;
for (const f of ['noise.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
}
const MG = global.MapGen;
MG.init(SEED);

/* 图集中真正绘制过的精灵索引 (第 6 行只画 7 个: 48..54, 55 为空) */
const DRAWN = new Set();
for (let k = 40; k <= 54; k++) DRAWN.add(k);
DRAWN.delete(55);
for (let k = 56; k <= 63; k++) DRAWN.add(k);

/* 各群系允许的精灵区间 (与 propSpriteFor 语义分支一一对应) */
const BY_BIOME = {
  3: [49, 60, 61, 62, 63],      // 草地: 草丛 / 小山包 / 孤树
  4: [44, 45, 46, 47],          // 森林: 4 变体
  5: [48],                      // 沙漠
  6: [40, 41, 56, 57],          // 山峰 (两族变体各 2 张)
  7: [42, 43, 58, 59],          // 雪峰
};

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const S = MG.CHUNK_S, R = MG.CHUNK_SCAN;
const hist = new Map(), byBiome = new Map();
const badRange = [], badBiome = [];
let total = 0;

for (let ca = -RAD; ca <= RAD; ca++) {
  for (let cb = -RAD; cb <= RAD; cb++) {
    const cc = { q: ca * S, r: cb * S };
    for (let dq = -R; dq <= R; dq++) {
      for (let dr = -R; dr <= R; dr++) {
        if (MG.hexDist(dq, dr, 0, 0) > R) continue;
        const q = cc.q + dq, r = cc.r + dr;
        const own = MG.chunkOfTile(q, r);
        if (own.q !== cc.q || own.r !== cc.r) continue;
        const f = MG.fields(q, r);
        const idx = MG.propSpriteFor(f);            // ← 断言真实实现
        if (idx < 0) continue;
        total++;
        hist.set(idx, (hist.get(idx) || 0) + 1);
        const b = f.disp != null ? f.disp : f.biome;
        if (!byBiome.has(b)) byBiome.set(b, new Set());
        byBiome.get(b).add(idx);
        if (!DRAWN.has(idx) && badRange.length < 8) badRange.push(`b=${b}→${idx} @(${q},${r})`);
        const allow = b >= 8 ? null : BY_BIOME[b];
        if (allow && !allow.includes(idx) && badBiome.length < 8) badBiome.push(`b=${b}→${idx} (允许 ${allow.join('/')})`);
      }
    }
  }
}

console.log(`== 立体精灵索引契约 (seed=${SEED}, ${(RAD * 2 + 1) ** 2} 块, 精灵 ${total} 个) ==`);
check('所有索引都在图集已绘制范围内 (无 55 / 无越界)', badRange.length === 0, badRange.join('; '));
check('各群系索引区间与图集/着色器契约一致', badBiome.length === 0, badBiome.join('; '));

const f4 = byBiome.get(4) ? [...byBiome.get(4)].sort((a, b) => a - b) : [];
check('森林只出 44..47 (不含 48 沙漠)', f4.length > 0 && f4.every((s) => s >= 44 && s <= 47), f4.join(','));
check('沙漠只用 48', (byBiome.get(5) ? [...byBiome.get(5)] : []).every((s) => s === 48), '');
check('灵脉峰只用 50..54', [...byBiome.keys()].filter((b) => b >= 8)
  .every((b) => [...byBiome.get(b)].every((s) => s >= 50 && s <= 54)), '');

/* 集成侧复核: buildChunk 实际输出的 propSprites 也必须在绘制集内 */
let emitted = new Set();
for (let ca = -2; ca <= 2; ca++) for (let cb = -2; cb <= 2; cb++) {
  for (const sp of MG.buildChunk(ca, cb).data.propSprites) emitted.add(sp);
}
const outOfAtlas = [...emitted].filter((k) => !DRAWN.has(k));
check('buildChunk 实际输出的精灵索引均在绘制集内', outOfAtlas.length === 0, outOfAtlas.join(','));

const keys = [...hist.keys()].sort((a, b) => a - b);
console.log(`  出现索引: ${keys.join(',')}`);
console.log(`  森林 8/7620 类溢出是否复现: ${f4.includes(48) ? '是(未修复)' : '否(已修复)'}`);
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
