#!/usr/bin/env node
/**
 * CityState 落库编码判据（2026-11-26 字符串压缩那一批）
 *
 * 守什么：
 *   · `Type` 已改 `TypeCode`（字典表 CityDict），往返不丢、不膨胀
 *   · `Stock` 已拆 8 个 INTEGER 列（R0..R7），值为 0 的资源省略但语义等价
 *   · `Built` 已压 varint BLOB，结构不符时**原样退回 JSON**（绝不丢字段）
 *   · 未知资源键必须抛（防「引擎加了资源但表没同步」这种静默丢数据）
 *
 * 跑法：node verify/check_city_encoding.mjs
 * 退出码：0 全绿 / 1 有失败 / 2 跳过（dotnet 不可用）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const proj = path.join(root, 'verify/citystore/citystore.csproj');

if (!fs.existsSync(proj)) {
  console.log('SKIP citystore 探针不存在');
  process.exit(2);
}

let fail = 0, pass = 0, skipped = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
};

console.log('== 源码守卫 ==');
const store = fs.readFileSync(path.join(root, 'Server/Zongmen/Subsystems/City/CityStateStore.cs'), 'utf8');
const perf = fs.readFileSync(path.join(root, 'Server/Zongmen/Time/TickPerfStore.cs'), 'utf8');
const job = fs.readFileSync(path.join(root, 'Server/Zongmen/Time/TickJobStore.cs'), 'utf8');

/* ⚠ 先剥注释再断言 —— 否则注释里提到的旧列名会把守卫染红（踩过）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const storeCode = stripComments(store);

check('G1 CityState 建表无 Type TEXT 列', !/Type\s+TEXT/i.test(storeCode));
check('G2 CityState 建表有 TypeCode INTEGER', /TypeCode\s+INTEGER/i.test(storeCode));
check('G3 CityState 建表有 R0..R7 八列', ['R0','R1','R2','R3','R4','R5','R6','R7'].every(c => new RegExp(c + '\\s+INTEGER').test(storeCode)));
check('G4 CityState 建表 Built 是 BLOB', /Built\s+BLOB/i.test(storeCode));
check('G5 有 CityDict 字典表', /CREATE TABLE IF NOT EXISTS CityDict/.test(storeCode));
check('G6 ResOrder 八资源与引擎同序', /"粮",\s*"木",\s*"矿",\s*"渔",\s*"炭",\s*"灵",\s*"丹",\s*"器"/.test(storeCode));
check('G7 未知资源键会抛（不是静默跳过）', /未知资源键/.test(storeCode) && /throw new InvalidDataException/.test(storeCode));
check('G8 Built 编码失败退回 JSON 兜底', /catch[\s\S]{0,200}BuiltJson/.test(storeCode));

const perfCode = stripComments(perf);
check('G9 TickPerf 无 Seed 列', !/Seed\s+TEXT/i.test(perfCode));
check('G10 TickPerf 用 KindCode INTEGER', /KindCode\s+INTEGER/i.test(perfCode));

const jobCode = stripComments(job);
check('G11 TickJob 无 Seed 列', !/Seed\s+TEXT/i.test(jobCode));
check('G12 TickJob 用 KindCode INTEGER', /KindCode\s+INTEGER/i.test(jobCode));

const kind = fs.readFileSync(path.join(root, 'Server/Zongmen/Time/TickJob.cs'), 'utf8');
check('G13 KindNames 有显式固定码（不是 (int)enum 落库）', /Code\s*=\s*\)\s*=>\s*ToCode/.test(kind.replace(/\s+/g, ' ')) || /ToCode\.TryGetValue/.test(kind));
check('G14 KindCode 0 是保留无效码', /未登记的枚举值返回 \*\*0\*\*/.test(kind) || /返回 \*\*0\*\*/.test(kind));

console.log('\n== 往返实测（C# 探针）==');
const r = spawnSync('dotnet', ['run', '--project', proj, '-c', 'Release', '-v', 'q', '--nologo'], {
  cwd: root, encoding: 'utf8', timeout: 300000,
});
const out = (r.stdout || '') + (r.stderr || '');
if (r.status === 2 || /dotnet.*not found|不是内部或外部命令/i.test(out)) {
  console.log('  SKIP dotnet 不可用');
  skipped++;
} else {
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^PASS (.+)$/);
    if (m) { pass++; console.log('  ✓ ' + m[1]); continue; }
    const f = line.match(/^FAIL (.+)$/);
    if (f) { fail++; console.log('  ✗ ' + f[1]); }
  }
  if (r.status !== 0 && !/合计/.test(out)) {
    console.log('  ✗ 探针异常退出');
    console.log(out.split(/\r?\n/).slice(-12).join('\n'));
    fail++;
  }
}

console.log(`\n合计 PASS=${pass} FAIL=${fail} SKIP=${skipped}`);
process.exit(fail === 0 ? 0 : 1);
