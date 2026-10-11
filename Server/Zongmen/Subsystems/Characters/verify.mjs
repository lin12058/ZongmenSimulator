#!/usr/bin/env node
/* ============================================================
 * 角色系统判据 (jugement / verify) —— 对齐工程 verify/check_*.mjs 纪律
 * 用法: node verify.mjs         # 全部通过 rc=0, 有 FAIL rc=1
 * 校验: 数据完整性(悬空引用) / 确定性 / 分布(正态区间) / 结构完整性
 * ============================================================ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBase, generateCharacter } from './chargen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = loadBase(path.join(__dirname, 'data', 'cultivation-base.json'));

const fails = [];
const log = [];
const L = (s = '') => log.push(s);
const check = (name, ok, detail = '') => { if (!ok) fails.push(name + (detail ? ` :: ${detail}` : '')); L(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

/* ---------- 0. 数据完整性（悬空引用） ---------- */
L('[0] 数据完整性');
{
  const itemIds = new Set(base.items.list.map((i) => i.id));
  const techIds = new Set(base.techniques.list.map((t) => t.id));
  const traitIds = new Set(base.traits.list.map((t) => t.id));
  let bad = 0;
  for (const bg of base.backgrounds.list)
    for (const id of bg.startItems ?? []) if (!itemIds.has(id)) { bad++; L(`    ✗ 背景 ${bg.id} -> 未定义物品 ${id}`); }
  for (const [realm, ids] of Object.entries(base.generate.starterKits)) {
    if (realm.startsWith('_') || !Array.isArray(ids)) continue;
    for (const id of ids) if (!itemIds.has(id)) { bad++; L(`    ✗ starterKits.${realm} -> 未定义物品 ${id}`); }
  }
  for (const [a, b] of base.traits.conflicts)
    for (const id of [a, b]) if (!traitIds.has(id)) { bad++; L(`    ✗ traits.conflicts -> 未定义特质 ${id}`); }
  for (const t of base.techniques.list) {
    if (!techIds.has(t.id)) continue;
    if (!base.$index.realmById[t.minRealm]) { bad++; L(`    ✗ 功法 ${t.id} -> 未定义境界 ${t.minRealm}`); }
    if (base.$index.rootRankById[t.minRoot] === undefined) { bad++; L(`    ✗ 功法 ${t.id} -> 未定义灵根 ${t.minRoot}`); }
  }
  check('无悬空引用', bad === 0, bad ? `${bad} 处` : '');
}

/* ---------- 1. 确定性 ---------- */
L('[1] 确定性');
{
  let det = true;
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(generateCharacter(base, { index: i, seed: 'DET' })) !==
        JSON.stringify(generateCharacter(base, { index: i, seed: 'DET' }))) { det = false; break; }
  }
  check('同 (seed,index) 逐字段一致', det);
  const a = JSON.stringify(generateCharacter(base, { index: 0, seed: 'A' }));
  const b = JSON.stringify(generateCharacter(base, { index: 0, seed: 'B' }));
  check('换 seed 结果不同', a !== b);
  check('无时间戳污染输出', !JSON.stringify(generateCharacter(base, { index: 0, seed: 'A' })).match(/\d{4}-\d{2}-\d{2}T/));
}

/* ---------- 2. 分布（正态 / 区间 / 覆盖） ---------- */
L('[2] 分布 (N=3000)');
const chars = [];
for (let i = 0; i < 3000; i++) chars.push(generateCharacter(base, { index: i, seed: 'WORLD' }));
{
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
  const ages = chars.map((c) => c.age);
  check('年龄下界=0 (含 age==0)', Math.min(...ages) === 0, `min=${Math.min(...ages)} age0=${ages.filter((a) => a === 0).length}`);
  check('年龄上界 <= 寿元', chars.every((c) => c.age < c.lifespan));
  check('境界 10/10 全覆盖', new Set(chars.map((c) => c.realm.seq)).size === base.realms.list.length);
  // 六维采样本身是 normal(mean,sd)；灵根/背景/特质为「正偏置修正」会小幅抬高实测均值，
  // 故阈值放宽到 ±6（仍能抓住分布写错/退化）。
  for (const a of base.attributes.core) {
    const xs = chars.map((c) => c.attributes[a.key]);
    check(`六维 ${a.name} 均值≈${a.mean}`, Math.abs(mean(xs) - a.mean) < 6, `实测 ${mean(xs).toFixed(1)} sd ${sd(xs).toFixed(1)}`);
  }
  const pur = chars.map((c) => c.spiritRoot.purity);
  check('灵根纯度 均值≈55 sd≈16', Math.abs(mean(pur) - 55) < 3 && Math.abs(sd(pur) - 16) < 3, `实测 ${mean(pur).toFixed(1)}/${sd(pur).toFixed(1)}`);
  const tc = chars.map((c) => c.traits.length);
  check('特质条数 ∈ [1,3]', Math.min(...tc) >= 1 && Math.max(...tc) <= 3, `实测 ${Math.min(...tc)}~${Math.max(...tc)}`);
}

/* ---------- 3. 结构完整性 ---------- */
L('[3] 结构完整性');
{
  const req = ['v', 'id', 'name', 'gender', 'age', 'lifespan', 'realm', 'spiritRoot', 'attributes', 'derived', 'resources', 'traits', 'background', 'faction', 'techniques', 'storageBag', 'appearance', 'relations', 'history', 'ext'];
  let bad = '';
  for (const c of chars) {
    for (const k of req) if (!(k in c)) { bad = `${c.id} 缺 ${k}`; break; }
    if (bad) break;
    if (c.realm.seq >= 1 && !c.techniques.main) { bad = `${c.id} 修士无主修心法`; break; }
    if (c.realm.seq === 0 && c.name.daohao) { bad = `${c.id} 凡人却有道号`; break; }
    if (c.realm.seq === 0 && c.techniques.main && c.techniques.main.grade !== 'fan') { bad = `${c.id} 凡人持非凡阶心法`; break; }
    for (const t of [c.techniques.main, ...c.techniques.aux].filter(Boolean)) {
      const mt = base.$index.techniqueById[t.id];
      if (base.$fn.realmSeq(mt.minRealm) > c.realm.seq) bad = `${c.id} 功法 ${t.name} 超境界`;
      if (base.$fn.rootRank(mt.minRoot) > c.spiritRoot.rank) bad = `${c.id} 功法 ${t.name} 超灵根`;
      if (bad) break;
    }
    if (bad) break;
    for (const it of c.storageBag.items) {
      const mi = base.$index.itemById[it.id];
      if (mi && base.$fn.realmSeq(mi.minRealm) > c.realm.seq) { bad = `${c.id} 物品 ${it.name} 超境界`; break; }
    }
    if (bad) break;
    if (c.storageBag.items.length > c.storageBag.slots) { bad = `${c.id} 储物袋溢出`; break; }
  }
  check('字段齐全 + 境界/灵根硬门槛 + 储物袋不溢出', !bad, bad);
}

L('');
L(fails.length ? `结果: FAIL (${fails.length})` : '结果: PASS (全部通过)');
fails.forEach((f) => L(`  ✗ ${f}`));

// 输出：写 UTF-8 文件（控制台 CJK 可能乱码），并以 rc 表达判定
process.stdout.write(log.join('\n') + '\n');
process.exit(fails.length ? 1 : 0);
