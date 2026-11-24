#!/usr/bin/env node
/* ============================================================
 * verify_roster.mjs — 「众生录」角色窗口 · 前端模块判据
 * ------------------------------------------------------------
 * 对齐工程 verify/check_*.mjs 纪律: 能在 Node 里断言的, 就不留给"肉眼看浏览器"。
 * ★ 2026-10-11 改造: 数据源已从静态快照改为**服务端实时生成** (GET /api/characters)
 *   ⇒ 本脚本不再读任何静态 JSON, 而是**用同一份 chargen-core.js** 造出载荷
 *   (与 C# V8 侧、Node CLI 侧同源), 再喂给 roster.js 的纯函数断言。
 *
 * 本脚本做四件事:
 *   [0] 用 core 造载荷, 校验结构与「标签单真源」(dict);
 *   [1] 在 Node 中**裸跑** web/js/roster.js 的纯函数 (normalize/presentRealms/applyFilter/
 *       rowHTML/detailHTML), 断言渲染产物里真有该有的字 (姓名/六维标签/储物袋…);
 *   [2] 渲染产物不得泄漏 undefined/NaN;
 *   [3] 源码守卫: roster.js 无 eval / 不直取引擎; main.js 的 roster dataUrl 必须指向
 *       服务端端点 (防止有人回退成静态 JSON —— 那正是本次要消灭的方案)。
 *
 * 用法: node verify_roster.mjs        # 全绿 rc=0; 有 FAIL rc=1
 * 依赖: ../chargen.mjs (Node 薄封装) + web/js/roster.js + web/js/main.js
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBase, buildPayload } from './chargen.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const ROSTER_JS = path.join(REPO_ROOT, 'web', 'js', 'roster.js');
const MAIN_JS = path.join(REPO_ROOT, 'web', 'js', 'main.js');

const fails = [];
const log = [];
const L = (s = '') => log.push(s);
const check = (name, ok, detail = '') => {
  if (!ok) fails.push(name + (detail ? ` :: ${detail}` : ''));
  L(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

/* ---------- 0. 造载荷 (与 C# V8 侧 / Node CLI 同源) ---------- */
L('[0] 载荷 (core 直造, 不再读静态快照)');
const base = loadBase();
const payload = buildPayload(base, { count: 300, seed: 'zongmen' });
check('载荷可解析且 schema = cultivators/v1', payload.schema === 'cultivators/v1', String(payload.schema));
check('载荷 characters 非空', Array.isArray(payload.characters) && payload.characters.length === 300,
  String((payload.characters || []).length));
check('载荷带 dict (展示字典, 标签单真源)', !!payload.dict && Array.isArray(payload.dict.attributes) &&
  payload.dict.attributes.length === 6, payload.dict ? `attributes=${payload.dict.attributes.length}` : '无 dict');
check('载荷带 offset (服务端分页契约)', payload.offset === 0, String(payload.offset));

/* ---------- 1. 裸跑 roster.js 的纯函数 ---------- */
L('[1] roster.js 纯函数 (Node 裸跑)');
global.window = globalThis;
const src = fs.readFileSync(ROSTER_JS, 'utf8');
(0, eval)(src);
const R = globalThis.SectRoster;
check('roster.js 暴露 window.SectRoster', !!R && typeof R.init === 'function');
check('接口齐备 (init/open/probe + 纯函数出口)',
  ['init', 'open', 'close', 'toggle', 'load', 'probe', 'normalize', 'presentRealms',
   'applyFilter', 'rowHTML', 'detailHTML'].every((k) => typeof R[k] === 'function'));

const n = R.normalize(payload);
check('normalize: 角色数与载荷一致', n.chars.length === payload.count, `${n.chars.length}/${payload.count}`);
check('normalize: 容忍空载荷 (不抛)', (() => {
  try { const e = R.normalize(null); return e.chars.length === 0 && e.count === 0; } catch (x) { return false; }
})());

const realms = R.presentRealms(n.chars, n.dict);
const distinct = new Set(n.chars.map((c) => c.realm.id)).size;
check('presentRealms: 覆盖所有出现过的境界', realms.length === distinct, `${realms.length}/${distinct}`);
check('presentRealms: 按 seq 升序 (凡人最前)', realms.length > 0 && realms[0].id === 'fanren',
  realms.map((r) => r.id).join('>'));

const all = R.applyFilter(n.chars, 'all', '');
check('applyFilter(all): 全部返回', all.length === n.chars.length, `${all.length}/${n.chars.length}`);
const mortal = R.applyFilter(n.chars, 'mortal', '');
check('applyFilter(凡人): 全部 seq=0', mortal.every((c) => c.realm.seq === 0) && mortal.length > 0,
  String(mortal.length));
const qi = R.applyFilter(n.chars, 'lianqi', '');
check('applyFilter(炼气): 全部 realm.id=lianqi', qi.every((c) => c.realm.id === 'lianqi'),
  String(qi.length));
/* 搜索: 用第一个人物的姓名回搜, 必须命中它本身 */
const probe0 = n.chars[0];
const hit = R.applyFilter(n.chars, 'all', probe0.name.full);
check(`applyFilter(搜索「${probe0.name.full}」): 命中自身`, hit.some((c) => c.id === probe0.id),
  `命中 ${hit.length} 条`);
check('applyFilter(无匹配词): 空数组', R.applyFilter(n.chars, 'all', '\u0000zzz不存在').length === 0);

/* ---------- 2. 渲染产物 ---------- */
L('[2] 渲染产物 (rowHTML / detailHTML)');
const row = R.rowHTML(probe0, probe0.id);
check('rowHTML: 含姓名 + 选中态 + data-ro-id', row.includes(probe0.name.full) &&
  row.includes('ro-item on') && row.includes('data-ro-id="' + probe0.id + '"'));
check('rowHTML: 凡人无道号 (不出现空 dh)', (() => {
  const m = n.chars.find((c) => c.realm.seq === 0);
  return !m || !R.rowHTML(m, null).includes('<span class="dh">');
})());

/* 详情: 凡人 + 修士各取一个, 都不得渲染出 "undefined" / "NaN" */
const sampleMortal = n.chars.find((c) => c.realm.seq === 0) || n.chars[0];
const sampleCultivator = n.chars.find((c) => c.realm.seq >= 3) || n.chars[n.chars.length - 1];
for (const [tag, c] of [['凡人', sampleMortal], ['修士', sampleCultivator]]) {
  const h = R.detailHTML(c, n.dict);
  const segOk = h.includes(c.name.full) && h.includes('六 维') && h.includes('储 物 袋') && h.includes('来 历');
  check(`detailHTML(${tag} ${c.name.full}): 含姓名/六维/储物袋/来历`, segOk, segOk ? '' : '缺关键段落');
  const leak = /\bundefined\b/.test(h) || /\bNaN\b/.test(h);
  check(`detailHTML(${tag}): 无 undefined/NaN 泄漏`, !leak, leak ? '有泄漏' : '');
  /* 主修心法段必须与数据一致 —— 凡人**可能**持凡阶引气诀 (minRealm=fanren 的入门心法),
     故不能断言"凡人必无心法"; 只断言「有则显示、无则出提示」这条真契约。 */
  const hasMain = !!(c.techniques && c.techniques.main);
  check(`detailHTML(${tag}): 主修心法段与数据一致 (hasMain=${hasMain})`,
    hasMain === h.includes('主修心法'));
}

/* 标签单真源: 每个基础数据里的六维键都要有中文标签可查 */
const coreKeys = Object.keys(sampleCultivator.attributes || {});
const labelKeys = new Set(n.dict.attributes.map((a) => a.key));
check('dict 覆盖全部六维键 (标签不靠前端硬编码)',
  coreKeys.every((k) => labelKeys.has(k)), coreKeys.filter((k) => !labelKeys.has(k)).join(',') || 'ok');
check('detailHTML 真的用上了 dict 的中文标签 (含「根骨」)',
  R.detailHTML(sampleCultivator, n.dict).includes('根骨'));

/* 兜底表: 不传 dict 时也不能炸 (离线/旧载荷) */
check('detailHTML 无 dict 时回落兜底表 (不抛且仍出标签)', (() => {
  try { const h = R.detailHTML(sampleCultivator); return h.includes('根骨') && h.includes(sampleCultivator.name.full); }
  catch (e) { return false; }
})());

/* ---------- 3. 源码守卫 ---------- */
L('[3] 源码守卫');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
check('roster.js 无间接 eval', !/\(0,\s*eval\)/.test(stripped));
check('roster.js 不直取 window.MapGen / EngineLocal', !/\bwindow\s*\.\s*MapGen\b/.test(stripped) &&
  !/\bwindow\s*\.\s*EngineLocal\b/.test(stripped));
check('roster.js 自身不发业务请求 (只 fetch dataUrl)',
  (stripped.match(/fetch\(/g) || []).length === 1);
check('roster.js 未把 DOM 句柄命名为 st (避 frontend_smoke 解码字段契约的保留名)',
  !/\bst\s*[:=]/.test(stripped));

/* ★ 数据源守卫: 前端必须指向**服务端端点**, 不得回退成静态 JSON。
   (本次改造的核心契约 —— 回退即"又有一个 1MB 库表"。) */
const mainSrc = fs.readFileSync(MAIN_JS, 'utf8');
const dm = mainSrc.match(/dataUrl\s*:\s*['"]([^'"]+)['"]/);
check('main.js 的 roster dataUrl 指向 /api/characters', !!dm && /^api\/characters/.test(dm[1]),
  dm ? dm[1] : '未找到 dataUrl');
check('main.js 不再引用任何 characters.json 静态文件',
  !/characters\.json/.test(mainSrc.replace(/\/\*[\s\S]*?\*\//g, ' ')));
check('roster.js 兜底 dataUrl 也是端点', /api\/characters/.test(src) && !/data\/characters\.json/.test(src));

L('');
L(fails.length ? `结果: FAIL (${fails.length})` : '结果: PASS (全部通过)');
fails.forEach((f) => L(`  ✗ ${f}`));
process.stdout.write(log.join('\n') + '\n');
process.exit(fails.length ? 1 : 0);
