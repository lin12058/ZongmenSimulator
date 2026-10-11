#!/usr/bin/env node
/* ============================================================
 * 宗门模拟器 · 角色生成器 (Node 侧薄封装 / CLI)
 * ------------------------------------------------------------
 * ★ 生成逻辑的**唯一真源**是 `js/chargen-core.js` (服务端 V8 也加载它)。
 *   本文件只在 Node 里把它求值出来 + 加一层 CLI/文件读写 —— 不再重复任何生成算法。
 *   为什么这么做: 若 Node 与 V8 各持一份生成代码, 二者一旦漂移就是**静默错值**
 *   (离线对拍通过、线上却对不同的人物), 与工程「单真源」铁律相悖。
 *
 * 用法:
 *   node chargen.mjs                       # 生成 10 个, seed=zongmen -> out/characters.json
 *   node chargen.mjs --count 50 --seed myworld
 *   node chargen.mjs --count 1 --pretty    # 打印到 stdout
 *
 * 作为模块:
 *   import { loadBase, generateCharacter, generateBatch, buildPayload } from './chargen.mjs';
 *
 * ⚠ 服务端在线路径**不走本文件** —— 前端窗口的数据来自 GET /api/characters
 *   (C# CharactersSubsystem → V8 characters scope → 同一份 chargen-core.js)。
 *   本文件只服务离线 CLI / 判据脚本。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_PATH = path.join(__dirname, 'js', 'chargen-core.js');
const DEFAULT_BASE = path.join(__dirname, 'data', 'cultivation-base.json');
const DEFAULT_OUT = path.join(__dirname, 'out', 'characters.json');

/* 在当前全局上下文里求值 classic script ⇒ 挂上 globalThis.CultivatorGen。 */
vm.runInThisContext(fs.readFileSync(CORE_PATH, 'utf8'), { filename: 'chargen-core.js' });
const CG = globalThis.CultivatorGen;
if (!CG) throw new Error('chargen-core.js 未导出 CultivatorGen');

/* ---- 再导出 (保持既有模块 API 不变: verify.mjs 等仍按名字 import) ---- */
export const makeRng = CG.makeRng;
export const fnv1a = CG.fnv1a;
export const hash01 = CG.hash01;
export const generateCharacter = CG.generateCharacter;
export const generateBatch = CG.generateBatch;
export const buildDict = CG.buildDict;
export const buildPayload = CG.buildPayload;

/** 装载基础数据: 读文件 → 建索引, 返回可直接喂给 generateCharacter 的对象。 */
export function loadBase(basePath = DEFAULT_BASE) {
  const data = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  return CG.indexBase(data);
}

/* ------------------------- CLI ------------------------- */

function parseArgs(argv) {
  const a = { count: 10, seed: 'zongmen', out: DEFAULT_OUT, base: DEFAULT_BASE, pretty: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--count' || k === '-n') a.count = parseInt(next(), 10);
    else if (k === '--seed' || k === '-s') a.seed = next();
    else if (k === '--out' || k === '-o') a.out = path.resolve(process.cwd(), next());
    else if (k === '--base') a.base = path.resolve(process.cwd(), next());
    else if (k === '--pretty') a.pretty = true;
    else if (k === '--quiet' || k === '-q') a.quiet = true;
  }
  return a;
}

function summarize(chars) {
  const byRealm = {};
  for (const c of chars) byRealm[c.realm.stage] = (byRealm[c.realm.stage] || 0) + 1;
  const ages = chars.map((c) => c.age);
  const avg = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '-');
  const core = chars[0] ? Object.keys(chars[0].attributes) : [];
  console.log(`[chargen] 境界分布: ${Object.entries(byRealm).sort().map(([k, v]) => `${k}×${v}`).join(', ')}`);
  console.log(`[chargen] 年龄 min=${Math.min(...ages)} max=${Math.max(...ages)} avg=${avg(ages)}`);
  if (core.length) {
    const attrAvg = core.map((k) => `${k}=${avg(chars.map((c) => c.attributes[k]))}`).join(' ');
    console.log(`[chargen] 六维均值: ${attrAvg}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = loadBase(args.base);
  const payload = buildPayload(base, { count: args.count, seed: args.seed });
  const chars = payload.characters;

  if (args.pretty) {
    process.stdout.write(JSON.stringify(chars.length === 1 ? chars[0] : chars, null, 2) + '\n');
    if (!args.quiet) summarize(chars);
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2), 'utf8');
  if (!args.quiet) {
    console.log(`[chargen] seed=${args.seed} count=${chars.length}`);
    console.log(`[chargen] 写出 -> ${args.out}`);
    summarize(chars);
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) main();
