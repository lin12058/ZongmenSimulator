/* ============================================================
 * check_recruit_pool.mjs — 招募池「快照可落库」契约探针 (离线, 不起服务)
 * ------------------------------------------------------------
 * 被测链路 = 服务端真正走的那条:
 *   C# WorldModule case "chargenPool" → mapgen-server.chargenPoolJson(str)
 *     → Engine/js/chargen.js genPoolJson(str) → genPool(opts)
 * 所以这里**必须**按 JsvmBundles.WorldBacked 的顺序载入全部 6 个脚本,
 * 直接调 `MS.chargenPoolJson(...)`, 而不是绕过 mapgen-server 去碰 Chargen。
 *
 * 断言分组:
 *   A. 出口存在性 (C# 只有一条 case, 名字写错 = 运行期「未知 JS 函数」)
 *   B. 确定性 ⇒ 「刷新网页还是同一批人」的根基 (同 opts 逐字节相同)
 *   C. rollNo 换批 ⇒ 必须换人 (否则 -30 点白扣)
 *   D. 快照可序列化 ⇒ PoolJson 落库/读回不变形 (JSON 往返逐字节)
 *   E. 池量/槽位/装备引用完整性 ⇒ 招募时按 slot 取人不会取空
 *   F. 参数接线: settleType 传得进去 (出身偏置) / element 传得进去 (主系) / pop 放大
 *
 * 用法: node verify/check_recruit_pool.mjs [seed]
 *       rc=0 全绿, rc=1 有 FAIL, rc=2 跳过 (缺脚本)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const CITY = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');
const SEED = process.argv[2] || '58750609';

/* ⚠ 顺序 = JsvmBundles.WorldBacked (chargen 必须排在 city-evo 之后) */
const BUNDLE = [
  path.join(ENG, 'noise.js'),
  path.join(ENG, 'mapgen-config.js'),
  path.join(ENG, 'mapgen.js'),
  path.join(ENG, 'mapgen-server.js'),
  path.join(CITY, 'city-evo.js'),
  path.join(ENG, 'chargen.js'),
];
for (const f of BUNDLE) {
  if (!fs.existsSync(f)) { console.log('SKIP 缺脚本: ' + f); process.exit(2); }
}

global.window = globalThis;
for (const f of BUNDLE) (0, eval)(fs.readFileSync(f, 'utf8'));

const MG = global.MapGen, MS = global.MapGenServer, CG = global.Chargen;

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

/* ---------------- A. 出口存在性 ---------------- */
ok('A1 MapGenServer.chargenPoolJson 存在', typeof MS.chargenPoolJson === 'function');
ok('A2 Chargen.genPoolJson 存在 (转发目标)', !!CG && typeof CG.genPoolJson === 'function');

/* 世界必须初始化 —— 缺这一步 tileJson/citySettlements 全是空 */
MG.init(SEED);

/* 真的从引擎里捞一个聚落, 而不是手搓 id (手搓 = 测不到接线) */
function firstSettles(n) {
  const out = [];
  for (let i = -1; i <= 1 && out.length < n; i++) {
    for (let j = -1; j <= 1 && out.length < n; j++) {
      let arr = [];
      try { arr = (JSON.parse(global.CityEvo.settlementsJson(i, j)).settlements) || []; }
      catch (e) { continue; }
      for (const s of arr) {
        if (s.type === 'poi') continue;
        out.push(s);
        if (out.length >= n) break;
      }
    }
  }
  return out;
}
const settles = firstSettles(3);
ok('A3 引擎能给出可用聚落 (非 poi)', settles.length > 0,
  settles.map(s => s.id + '/' + s.type).join(' '));

const host = { worldSeed: SEED, round: 0, settle: {
  id: (settles[0] && settles[0].id) || 'v_test', type: (settles[0] && settles[0].type) || 'village',
  pop: (settles[0] && settles[0].pop) || 40, element: null } };
const HOST_JSON = JSON.stringify(host);

/* ---------------- B. 确定性 ---------------- */
const p1 = MS.chargenPoolJson(HOST_JSON);
const p2 = MS.chargenPoolJson(HOST_JSON);
ok('B1 同 opts 两次逐字节相同 (刷新网页同一批人)', p1 === p2, p1.length + 'B vs ' + p2.length + 'B');

/* 也接受对象入参 (ClearScript 走字符串, 但 Node 判据可能传对象) */
const pObj = MS.chargenPoolJson(host);
ok('B2 对象入参与字符串入参结果一致', pObj === p1);

/* 换 worldSeed 必须换人 (否则跨世串味) */
const other = JSON.stringify(Object.assign({}, host, { worldSeed: SEED + '_x' }));
ok('B3 换 worldSeed ⇒ 换一批', MS.chargenPoolJson(other) !== p1);

/* ---------------- C. rollNo 换批 ---------------- */
const r1 = JSON.parse(MS.chargenPoolJson(JSON.stringify(Object.assign({}, host, { round: 1 }))));
const r2 = JSON.parse(MS.chargenPoolJson(JSON.stringify(Object.assign({}, host, { round: 2 }))));
const names1 = r1.candidates.map(c => c.pawn.name).join(',');
const names2 = r2.candidates.map(c => c.pawn.name).join(',');
ok('C1 round 1 ≠ round 2 名单 (刷新真换人)', names1 !== names2, names1 + ' | ' + names2);
ok('C2 两次刷新都非空', r1.candidates.length > 0 && r2.candidates.length > 0,
  r1.candidates.length + ' / ' + r2.candidates.length);

/* ---------------- D. 快照可序列化 ---------------- */
const parsed = JSON.parse(p1);
const roundTrip = JSON.stringify(parsed);
ok('D1 JSON 往返逐字节不变 (PoolJson 落库/读回不变形)', roundTrip === p1);
ok('D2 快照带 v/seedKey/settle/candidates 四件', parsed.v != null && !!parsed.seedKey &&
  !!parsed.settle && Array.isArray(parsed.candidates),
  'v=' + parsed.v + ' seedKey=' + parsed.seedKey);
ok('D3 seedKey 含 (worldSeed|settleId|round|pool) 四段', parsed.seedKey.split('|').length === 4, parsed.seedKey);
ok('D4 settle 字段齐全 (id/type/pop)', parsed.settle.id === host.settle.id &&
  parsed.settle.type === host.settle.type, JSON.stringify(parsed.settle));

/* ---------------- E. 池量 / 槽位 / 装备引用 ---------------- */
const cs = parsed.candidates;
ok('E1 池量在 1~POOL_MAX 之间', cs.length >= 1 && cs.length <= CG.CFG.POOL_MAX,
  cs.length + ' / max ' + CG.CFG.POOL_MAX);
/* ⚠ 池子本身**不带** slot: slot 是服务端响应层按数组下标补的
   (RecruitEndpoints.Pool: `slot = i`), 按 slot 取人 = 取 candidates[slot]。
   这里断言的是「下标顺序稳定且没有与之冲突的 slot 字段」—— 真冲突会让按 slot
   取人取到别人, 而顺序不稳会让「招第 3 个」招成第 5 个。 */
const slotOk = cs.every((c, i) => c.slot == null || c.slot === i);
ok('E2 下标顺序稳定且无冲突 slot 字段', slotOk, 'n=' + cs.length);

let missEquip = 0, dupId = 0, noPawn = 0;
for (const c of cs) {
  if (!c.pawn || !c.pawn.name) { noPawn++; continue; }
  const ids = (c.items || []).map(it => it.id);
  if (new Set(ids).size !== ids.length) dupId++;
  const eq = c.pawn.equip || {};
  for (const k of Object.keys(eq)) {
    const ref = eq[k];
    if (ref && !ids.includes(ref)) missEquip++;
  }
}
ok('E3 每个候选人都有 pawn.name', noPawn === 0, 'bad=' + noPawn);
ok('E4 items id 单卡内唯一', dupId === 0, 'dup=' + dupId);
ok('E5 equip 引用的 id 都在 items 里 (招募后直接入队不丢装)', missEquip === 0, 'miss=' + missEquip);

/* 人不能重名 —— 池内重名会让「按名字找弟子」的 UI 出错 */
ok('E6 池内不重名', new Set(cs.map(c => c.pawn.name)).size === cs.length);

/* ---------------- F. 参数接线 ---------------- */
/* F1 settleType 传得进去 (渔村渔家 vs 仙城渔家) */
function bgShare(type, key, n) {
  let hit = 0;
  const o = JSON.stringify({ worldSeed: SEED, round: 0,
    settle: { id: 'bg_' + type, type, pop: 60 } });
  const pool = JSON.parse(MS.chargenPoolJson(o)).candidates;
  for (const c of pool) if ((c.meta || {}).backgroundKey === key) hit++;
  return pool.length ? hit / pool.length : 0;
}
const fishFisher = bgShare('fishing', 'fisher', 0);
const cityFisher = bgShare('city', 'fisher', 0);
ok('F1 settleType 传到出身偏置 (渔村渔家 > 仙城渔家)',
  fishFisher > cityFisher, (fishFisher * 100).toFixed(0) + '% vs ' + (cityFisher * 100).toFixed(0) + '%');

/* F2 element 传得进去 (主系恒等于指定五行) */
let mainHit = 0, mainAll = 0;
for (let e = 0; e < 5; e++) {
  const o = JSON.stringify({ worldSeed: SEED, round: 0,
    settle: { id: 'el_' + e, type: 'town', pop: 60, element: e } });
  for (const c of JSON.parse(MS.chargenPoolJson(o)).candidates) {
    mainAll++;
    if (c.pawn.root && c.pawn.root.main === e) mainHit++;
  }
}
ok('F2 settle.element 决定主灵根 (恒等)', mainAll > 0 && mainHit === mainAll, mainHit + '/' + mainAll);

/* F3 pop 放大 (同一 id 只改 pop) */
function sizeOf(pop) {
  return JSON.parse(MS.chargenPoolJson(JSON.stringify({ worldSeed: SEED, round: 0,
    settle: { id: 'pop_x', type: 'village', pop } }))).candidates.length;
}
const small = sizeOf(10), big = sizeOf(400);
ok('F3 settle.pop 只放大不缩小 (400 > 10)', big > small, small + ' → ' + big);

/* F4 越界 settle (缺 type) 不抛异常, 回落 village */
let threw = null, fb = null;
try { fb = JSON.parse(MS.chargenPoolJson(JSON.stringify({ worldSeed: SEED, round: 0, settle: { id: 'no_type' } }))); }
catch (e) { threw = e.message; }
ok('F4 缺 type 不抛异常且回落 village', threw === null && fb && fb.settle.type === 'village', String(threw));

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
