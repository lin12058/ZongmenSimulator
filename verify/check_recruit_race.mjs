/* ============================================================
 * check_recruit_race.mjs — 同一候选被并发抢招 ⇒ 只能进一个人
 * ------------------------------------------------------------
 * 为什么需要这条: crew 契约是**全局单份**, 而候选池内容与账号无关 (种子只吃
 * worldSeed/settle/rollNo) ⇒ 5 个账号看到的是**同一个人**。若它们同时点「招募」,
 * 扣点被 TrySpend 串行化了, 但「人有没有进队」这一段若不防重, 就会写进 5 份
 * 同 id 的成员 + 5 份同 id 的装备 (面板上 5 个同名弟子, 背包里 5 把一样的剑)。
 *
 * 断言:
 *   A. 恰好 1 个 duplicated=false, 其余 duplicated=true (退点, 不报错)
 *   B. 契约里该成员 id **只出现一次** (squad.members 与 squads[] 都是)
 *   C. 背包物品 id 不重复
 *   D. 赢家扣 50, 输家退回到 50
 *
 * 用法: node verify/check_recruit_race.mjs [base=http://127.0.0.1:8141]
 * ⚠ 会 DELETE /api/crew (全局契约) ⇒ 拒绝在 8140 上跑; 只用于测试库副本。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:8141').replace(/\/+$/, '');

const PORT = (() => { try { return new URL(BASE).port; } catch { return ''; } })();
if (PORT === '8140') {
  console.log('SKIP 拒绝在生产端口 8140 上跑 (本脚本会清空 /api/crew)');
  process.exit(2);
}

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

const T = Date.now().toString(36);
async function api(method, p, body, account) {
  const headers = { 'X-Account': account };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(BASE + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, json: null, error: String((e && e.message) || e) };
  }
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = { _raw: txt }; }
  return { status: r.status, json };
}

/* ---------------- 0. 当前世 + 一个聚落 ---------------- */
let cur;
try { cur = await (await fetch(BASE + '/api/world/current')).json(); }
catch (e) { console.log('SKIP 服务端没起: ' + BASE); process.exit(2); }
if (!cur || !cur.seed) { console.log('SKIP 无当前世'); process.exit(2); }

const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const CITY = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');
global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(CITY, 'city-evo.js'), 'utf8'));
global.MapGen.init(cur.seed);

let A = '';
outer:
for (let i = -2; i <= 2; i++) {
  for (let j = -2; j <= 2; j++) {
    let arr = [];
    try { arr = (JSON.parse(global.CityEvo.settlementsJson(i, j)).settlements) || []; } catch { continue; }
    for (const s of arr) if (s.type !== 'poi') { A = s.id; break outer; }
  }
}
if (!A) { console.log('SKIP 引擎没给出聚落'); process.exit(2); }
console.log('# settle=' + A + ' base=' + BASE);

/* 干净起点 (全局契约) */
await api('DELETE', '/api/crew').catch(() => { });

/* ---------------- 1. 5 个账号各自打探 (内容应完全一致) ---------------- */
const ACCTS = [0, 1, 2, 3, 4].map(n => 'race' + n + '-' + T);
const pools = [];
for (const acct of ACCTS) {
  pools.push(await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A), undefined, acct));
}
const first = pools[0].json || {};
ok('1.1 五个账号都拿到池子', pools.every(p => p.json && p.json.ok === true),
  pools.map(p => (p.json && p.json.ok) ? 'ok' : 'x').join(''));
const names = pools.map(p => (((p.json || {}).candidates || [])[0] || {}).pawn?.name || '');
ok('1.2 池子内容与账号无关 (同一个人)', new Set(names).size === 1 && !!names[0], names.join(','));
const MID = ((first.candidates || [])[0] || {}).pawn?.id || '';
ok('1.3 拿到候选 id', !!MID, MID);

/* ---------------- 2. 并发抢招同一个 slot ---------------- */
const results = await Promise.all(ACCTS.map(acct =>
  api('POST', '/api/recruit/hire', { settle: A, slot: 0 }, acct)));

const won = results.filter(r => r.json && r.json.ok === true && r.json.duplicated === false);
const dup = results.filter(r => r.json && r.json.ok === true && r.json.duplicated === true);
ok('2.1 恰好 1 人招到', won.length === 1, 'won=' + won.length + ' dup=' + dup.length +
  ' resp=' + results.map(r => (r.json && (r.json.code || (r.json.duplicated ? 'dup' : 'ok'))) || '?').join(','));
ok('2.2 其余都是幂等成功 (不报错、已退点)', dup.length === results.length - 1,
  'dup=' + dup.length);

/* ---------------- 3. 契约里只有一份 ---------------- */
const crew = await api('GET', '/api/crew');
const c = crew.json || {};
const hitsLegacy = ((c.squad || {}).members || []).filter(m => m.id === MID).length;
ok('3.1 老字段 Squad.Members 里只有 1 条', hitsLegacy === 1, 'n=' + hitsLegacy);
const sq = (c.squads || []).find(s => (s.members || []).indexOf(MID) >= 0);
const hitsGroup = sq ? sq.members.filter(x => x === MID).length : 0;
ok('3.2 squads[] 里只有 1 条', hitsGroup === 1, 'n=' + hitsGroup);

const itemIds = ((c.bag || {}).items || []).map(it => it.id);
ok('3.3 背包没有重复物品 id', new Set(itemIds).size === itemIds.length,
  itemIds.length + ' 件 / ' + new Set(itemIds).size + ' 唯一');

/* ---------------- 4. 扣点: 赢家 0, 输家退满 50 ---------------- */
const sts = [];
for (const acct of ACCTS) {
  sts.push(await api('GET', '/api/recruit/state', undefined, acct));
}
const vals = sts.map(s => (s.json && s.json.points && s.json.points.value));
ok('4.1 一个 0 点 (真招到), 四个 50 点 (已退点)',
  vals.filter(v => v === 0).length === 1 && vals.filter(v => v === 50).length === results.length - 1,
  vals.join(','));

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
