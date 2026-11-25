/* ============================================================
 * check_recruit_api.mjs — 招募系统四端点端到端判据 (需已起服务)
 * ------------------------------------------------------------
 * 覆盖 docs/游戏设计/招募系统-实施方案.md §七 接口 / §7.4 判定顺序:
 *   1. state: 首档 50 / 上限 = 产量×30 (=300) / 产量 = 影响力 (10) / 30 / 50
 *   2. pool : 首次自动生成 rollNo=0 并落库; 再取**同批人**(防刷)
 *   3. roll : 扣 30、换批、rollNo+1; 点数不足 ⇒ insufficient-points
 *   4. hire : 扣 50 / 建队且驻地绑定本聚落 / 入 Crew / 幂等(同 slot 不重复扣)
 *   5. 判定顺序: bad-settle → no-pool → bad-slot → 幂等 → 不足 → wrong-settle
 *   6. 驻地不被整表替换洗掉 (POST /api/crew/patch 不带 settle ⇒ 保留)
 *   7. 驻地闸与 Decide **同口径**: 有队员但驻地为空 ⇒ 别镇也能招 (不会"按钮亮着却拒")
 *
 * ⚠ 账号分工 (每个账号只够一次 hire: 初始 50 = 一次招募):
 *   A = 刷新/换批线 (50 → 20, 之后不足)
 *   C = 招募线 (50 → 0)
 *   B = 驻地闸线 (保持 50, 用来验 wrong-settle)
 *   D = 从未打探 ⇒ 验 no-pool
 *   E = 「驻地为空的老队」线 (50 → 0)
 *   crew 契约是**全局单份**(不按账号), 所以 C 建的队对 B 也可见 —— 正好验驻地闸。
 *
 * 用法: node verify/check_recruit_api.mjs [base]     (默认 http://127.0.0.1:8141)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://127.0.0.1:8141').replace(/\/+$/, '');

/* ⚠⚠ 本脚本会 DELETE /api/crew (crew 契约是**全局单份**) —— 绝不能指向生产端口 8140,
   那会抹掉玩家自己的队伍。只能在「测试库副本 + 8141 以上端口」的实例上跑。 */
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
const ACCT_A = 'probeA-' + T, ACCT_B = 'probeB-' + T;
const ACCT_C = 'probeC-' + T, ACCT_D = 'probeD-' + T;

async function api(method, p, body, account) {
  const headers = { 'X-Account': account || ACCT_A };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(BASE + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    /* 服务端没起 ⇒ 上层走 SKIP(rc=2), 别当成判据失败 */
    return { status: 0, json: null, error: String((e && e.message) || e) };
  }
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch (e) { json = { _raw: txt }; }
  return { status: r.status, json };
}

/* ---------------- 0. 前置: 当前世 + 两个聚落 ---------------- */
const cur = await api('GET', '/api/world/current');
if (!cur.json || !cur.json.seed) {
  console.log('SKIP 无当前世 (先绑定世界): ' + JSON.stringify(cur.json));
  process.exit(2);
}
const SEED = cur.json.seed;
console.log('# seed=' + SEED + ' round=' + cur.json.round + ' base=' + BASE);

/* 从引擎就地算聚落 (与 check_recruit_pool.mjs 同法; 手搓 id 测不到接线) */
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const CITY = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');
global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(CITY, 'city-evo.js'), 'utf8'));
global.MapGen.init(SEED);

function findSettles(n) {
  const out = [];
  for (let i = -2; i <= 2 && out.length < n; i++) {
    for (let j = -2; j <= 2 && out.length < n; j++) {
      let arr = [];
      try { arr = (JSON.parse(global.CityEvo.settlementsJson(i, j)).settlements) || []; }
      catch (e) { continue; }
      for (const s of arr) {
        if (s.type === 'poi') continue;
        if (!out.some(x => x.id === s.id)) out.push(s);
        if (out.length >= n) break;
      }
    }
  }
  return out;
}
const SET = findSettles(2);
if (SET.length < 2) { console.log('SKIP 引擎给出的聚落不足 2 个'); process.exit(2); }
const A = SET[0].id, B = SET[1].id;
console.log('# 聚落 A=' + A + '(' + SET[0].type + ') B=' + B + '(' + SET[1].type + ')');

/* ⚠ crew 契约是全局单份, 库里可能已有玩家自己的队伍 (驻地别处 ⇒ 一进来就 wrong-settle)。
   探针只跑在**测试库副本**上, 所以先清空拿一个干净起点 —— 顺便验 DELETE 端点可用。 */
const clr = await api('DELETE', '/api/crew');
ok('0.1 DELETE /api/crew 清空 (测试库副本)', clr.status === 200, 'status=' + clr.status);

/* ---------------- 1. state: 常量与首档 ---------------- */
const st0 = await api('GET', '/api/recruit/state');
const P0 = st0.json && st0.json.points;
ok('1.1 state ok', !!(st0.json && st0.json.ok === true), 'status=' + st0.status);
ok('1.2 首档 = 50 (InitialPoints)', P0 && P0.value === 50, P0 && String(P0.value));
ok('1.3 产量 = 影响力 = 10', P0 && P0.perYear === 10 && P0.influence === 10,
  P0 && ('perYear=' + P0.perYear + ' influence=' + P0.influence));
ok('1.4 上限 = 产量×30 = 300', P0 && P0.cap === 300, P0 && String(P0.cap));
ok('1.5 刷新 30 / 招募 50', P0 && P0.rollCost === 30 && P0.hireCost === 50,
  P0 && (P0.rollCost + ' / ' + P0.hireCost));
ok('1.6 clock 带 tick/year/round', !!(st0.json.clock && st0.json.clock.tick >= 0 &&
  st0.json.clock.year >= 1), JSON.stringify(st0.json.clock));

/* ---------------- 2. pool: 首次生成 + 防刷 ---------------- */
const pl1 = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A));
ok('2.1 pool ok', !!(pl1.json && pl1.json.ok === true), 'status=' + pl1.status);
ok('2.2 首次 rollNo = 0 (未扣点)', pl1.json && pl1.json.rollNo === 0, String(pl1.json && pl1.json.rollNo));
ok('2.3 开池子点数不变 (打探免费)', pl1.json && pl1.json.points.value === 50, String(pl1.json.points.value));
ok('2.4 聚落身份服务端查回 (type/id 与引擎一致)',
  !!(pl1.json.settle && pl1.json.settle.type === SET[0].type && pl1.json.settle.id === A),
  JSON.stringify(pl1.json.settle && { t: pl1.json.settle.type, n: pl1.json.settle.name }));
const C1 = (pl1.json.candidates) || [];
ok('2.5 候选非空且 slot 连续', C1.length > 0 && C1.every((c, i) => c.slot === i), 'n=' + C1.length);
ok('2.6 taken 初始为空', Array.isArray(pl1.json.taken) && pl1.json.taken.length === 0);
ok('2.7 hireGate.allowed=true (无队伍时哪都能招)', !!(pl1.json.hireGate && pl1.json.hireGate.allowed === true),
  JSON.stringify(pl1.json.hireGate && pl1.json.hireGate.reason));

const pl1b = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A));
ok('2.8 再取一次逐字节同一批人 (防刷: 池子落库)', JSON.stringify(pl1b.json.candidates) === JSON.stringify(C1));

/* B 号首次打探 B 镇 (打探不受驻地限制) */
const plB = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(B), undefined, ACCT_B);
ok('2.9 别镇可打探 (刷新不受驻地限制)', !!(plB.json && plB.json.ok === true),
  'n=' + ((plB.json.candidates || []).length));

/* ---------------- 3. roll: 扣 30 / 换批 (账号 A) ---------------- */
const names0 = C1.map(c => c.pawn.name).join(',');
const rl = await api('POST', '/api/recruit/roll', { settle: A });
ok('3.1 roll ok', !!(rl.json && rl.json.ok === true), JSON.stringify(rl.json && rl.json.code));
ok('3.2 rollNo 0 → 1', rl.json && rl.json.rollNo === 1, String(rl.json && rl.json.rollNo));
ok('3.3 扣 30 (50→20)', rl.json && rl.json.points.value === 20, String(rl.json.points.value));
ok('3.4 换了一批人', (rl.json.candidates || []).map(c => c.pawn.name).join(',') !== names0);
ok('3.5 换批后 taken 清空', Array.isArray(rl.json.taken) && rl.json.taken.length === 0);

const rl2 = await api('POST', '/api/recruit/roll', { settle: A });
ok('3.6 余额 20 < 30 ⇒ insufficient-points', !!(rl2.json && rl2.json.code === 'insufficient-points'),
  JSON.stringify(rl2.json && rl2.json.code));
ok('3.7 失败不动点数 (仍 20)', rl2.json.points && rl2.json.points.value === 20);
const plAfter = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A));
ok('3.8 失败后池子仍是 rollNo 1 那批', plAfter.json.rollNo === 1 &&
  JSON.stringify(plAfter.json.candidates) === JSON.stringify(rl.json.candidates));

/* ---------------- 4. hire: 扣 50 / 建队 / 驻地 (账号 C) ---------------- */
/* ⚠ 池子是**按账号**落库的 (防刷: 每个玩家自己的快照), 所以 C 必须先自己打探一次;
   但快照内容与账号无关 (种子只吃 worldSeed/settle/round) ⇒ 内容应与 A 逐字节相同。 */
const plC = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A), undefined, ACCT_C);
ok('4.0 池子按账号独立、内容与账号无关 (C 与 A 同批人)',
  !!(plC.json && plC.json.ok === true && plC.json.rollNo === 0) &&
  JSON.stringify(plC.json.candidates) === JSON.stringify(C1),
  'C.rollNo=' + (plC.json && plC.json.rollNo));

const hi = await api('POST', '/api/recruit/hire', { settle: A, slot: 0 }, ACCT_C);
const MID = (hi.json.member || {}).id || '';        // 后续断言都用它, 防 member 缺失时抛 TypeError
ok('4.1 hire ok', !!(hi.json && hi.json.ok === true), JSON.stringify(hi.json && hi.json.code));
ok('4.2 扣 50 (50→0)', hi.json.points && hi.json.points.value === 0,
  String(hi.json.points && hi.json.points.value));
ok('4.3 返回 member 与 squadId', !!(hi.json.member && hi.json.member.id && hi.json.squadId),
  (hi.json.member && hi.json.member.name) + ' → ' + hi.json.squadId);
ok('4.4 返回的起步装备 items 是数组', Array.isArray(hi.json.items));

const crew1 = await api('GET', '/api/crew');
const sq1 = ((crew1.json && crew1.json.squads) || []).find(s => s.id === hi.json.squadId);
ok('4.5 新队驻地绑定本次聚落', !!(sq1 && sq1.settle === A), sq1 && JSON.stringify(sq1.settle));
ok('4.6 新队 members 含此人 (= id 数组)', !!(sq1 && sq1.members && sq1.members.includes(MID)),
  sq1 && JSON.stringify(sq1.members));
ok('4.7 老字段 Squad.Members 同步 (兼容老前端)',
  !!((crew1.json.squad || {}).members || []).some(m => m.id === MID), 'mid=' + MID);

/* ⚠ taken 也是按账号存的 (谁招走了谁自己知道) ⇒ 必须用 C 自己的池子验 */
const plTaken = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A), undefined, ACCT_C);
ok('4.8 池子 taken 记下 slot 0', (plTaken.json.taken || []).indexOf(0) >= 0, JSON.stringify(plTaken.json.taken));
ok('4.9 池子不重排 (同 slot 仍是同一人)',
  plTaken.json.candidates[0].pawn.name === plC.json.candidates[0].pawn.name);
/* 反证: 别的账号看同一聚落, taken 仍为空 (招募是个人进度, 不是全服公共池) */
const plOther = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(A), undefined, ACCT_D);
ok('4.9b 他人 taken 不受影响 (个人进度)', (plOther.json.taken || []).length === 0,
  JSON.stringify(plOther.json.taken));

/* 幂等: 同 slot 再发一次 (C 已 0 点, 幂等分支必须**先于**余额判断) */
const hi2 = await api('POST', '/api/recruit/hire', { settle: A, slot: 0 }, ACCT_C);
ok('4.10 同 slot 重发 ⇒ duplicated 且不扣点',
  !!(hi2.json && hi2.json.ok === true && hi2.json.duplicated === true),
  JSON.stringify(hi2.json && hi2.json.code));
ok('4.11 幂等分支点数仍 0', hi2.json.points && hi2.json.points.value === 0);

/* bad-slot (C 0 点也要先报 bad-slot ⇒ 证明顺序) */
const hiBadSlot = await api('POST', '/api/recruit/hire', { settle: A, slot: 999 }, ACCT_C);
ok('4.12 slot 越界 ⇒ bad-slot (先于余额判断)',
  !!(hiBadSlot.json && hiBadSlot.json.code === 'bad-slot'), 'status=' + hiBadSlot.status);

/* ---------------- 5. 判定顺序 ---------------- */
const badSettle = await api('POST', '/api/recruit/hire', { settle: '999_999_999', slot: 0 }, ACCT_C);
ok('5.1 无聚落 ⇒ bad-settle (先于其他一切)',
  !!(badSettle.json && badSettle.json.code === 'bad-settle'), 'status=' + badSettle.status);

/* D 号只打探过 A ⇒ 在 B 招必须报 no-pool (池子没生成就不许招) */
const noPool = await api('POST', '/api/recruit/hire', { settle: B, slot: 0 }, ACCT_D);
ok('5.2 D 号没打探过 A ⇒ no-pool',
  !!(noPool.json && noPool.json.code === 'no-pool'),
  JSON.stringify(noPool.json && (noPool.json.code || noPool.json.error)));

/* A 号: 先打探 B 镇 (否则先撞 no-pool), 20 点 < 50 ⇒ 必须报「不足」而不是「驻地不对」。
   ⚠ 实现顺序是 不足 → 驻地, 所以这里只能验不足; 驻地闸用有钱的 B 号验。 */
await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(B));
const poorA = await api('POST', '/api/recruit/hire', { settle: B, slot: 0 });
ok('5.3 A 号 20 点 ⇒ insufficient-points', !!(poorA.json && poorA.json.code === 'insufficient-points'),
  JSON.stringify(poorA.json && poorA.json.code));

/* B 号: 有 50 点 + 已打探 B 镇, 但队伍(C 建的)驻地在 A ⇒ wrong-settle */
const hiB = await api('POST', '/api/recruit/hire', { settle: B, slot: 0 }, ACCT_B);
ok('5.4 队伍驻地在 A ⇒ 在 B 招被拒 wrong-settle',
  !!(hiB.json && hiB.json.code === 'wrong-settle'),
  JSON.stringify(hiB.json && (hiB.json.code || hiB.json.error)));
ok('5.5 被拒后 B 号点数 50 不变', hiB.json.points && hiB.json.points.value === 50,
  String(hiB.json.points && hiB.json.points.value));
ok('5.6 拒绝响应带 hireGate (前端直接渲染红条)',
  !!(hiB.json.hireGate && hiB.json.hireGate.allowed === false),
  JSON.stringify(hiB.json.hireGate && hiB.json.hireGate.reason));

const gateB = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(B), undefined, ACCT_B);
ok('5.7 别镇 hireGate.allowed=false', !!(gateB.json.hireGate && gateB.json.hireGate.allowed === false));
ok('5.8 hireGate 每队员额与驻地名齐备',
  (gateB.json.hireGate.squads || []).every(s =>
    typeof s.members === 'number' && typeof s.name === 'string' && 'here' in s));

/* ---------------- 6. 驻地不被整表替换洗掉 ---------------- */
const patch = await api('POST', '/api/crew/patch', {
  squads: [{ id: hi.json.squadId, name: '一队', members: [MID] }],
});
ok('6.1 patch 不带 settle 不报错', patch.status === 200, 'status=' + patch.status);
const crew2 = await api('GET', '/api/crew');
const sq2 = (crew2.json.squads || []).find(s => s.id === hi.json.squadId);
ok('6.2 ⚠ settle 被兜底保留 (整表替换不洗驻地)', !!(sq2 && sq2.settle === A),
  sq2 && JSON.stringify(sq2.settle));
ok('6.3 patch 的改名生效 (name=一队)', !!(sq2 && sq2.name === '一队'), sq2 && sq2.name);

/* ---------------- 7. 驻地闸与 Decide 同口径 (驻地为空的队员队) ---------------- */
/* 场景: 一队驻在 A 且有队员, 另一队**有队员但驻地为空** (老存档形态)。人在 B 镇。
   正确口径 = Gate.allowed 为真, 且真的能招进那支"驻地为空"的队 (并补绑到 B)。
   ⚠ 旧实现 Gate 说 allowed、Decide 却挑中"第一支有队员的队"(A 那支) ⇒ 按钮亮着、
     点下去 wrong-settle —— 这条判据就是守这个死角的。
   PUT 是整份替换 (不做 settle 兜底保留), 所以能造出空驻地的老契约。 */
const ACCT_E = 'probeE-' + T;
const put = await api('PUT', '/api/crew', {
  version: 1,
  squads: [
    { id: 'sq1', name: '小队', members: ['m-a'], settle: A },
    { id: 'sq2', name: '二队', members: ['m-b'], settle: '' },
  ],
  curSquad: 'sq1',
  squad: {
    id: 'sq1', name: '小队', capacity: 8,       // ⚠ 故意写 8 (旧前端 dump 的污染值): 编制上限必须仍是 9
    members: [{ id: 'm-a', name: '旧甲' }, { id: 'm-b', name: '旧乙' }],
  },
  bag: { capacity: 48, cols: 6, rows: 8, items: [] },
});
ok('7.0 PUT 一份「一队在 A + 一队驻地为空」的老契约', put.status === 200, 'status=' + put.status);

const gateE = await api('GET', '/api/recruit/pool?settle=' + encodeURIComponent(B), undefined, ACCT_E);
const gE = (gateE.json && gateE.json.hireGate) || {};
ok('7.1 有队员但驻地为空 ⇒ 别镇也 allowed=true', gE.allowed === true, JSON.stringify(gE.reason));
const sqE2 = (gE.squads || []).find(s => s.id === 'sq2');
ok('7.2 该队 canEnter=true (不能因为 here=false 就置灰)',
  !!(sqE2 && sqE2.canEnter === true), JSON.stringify(sqE2));
ok('7.3 hireGate 下发编制/队数上限 (9/6), 不采用契约里被污染的 capacity=8',
  gE.squadCap === 9 && gE.maxSquads === 6, gE.squadCap + '/' + gE.maxSquads);

const hiE = await api('POST', '/api/recruit/hire', { settle: B, slot: 0 }, ACCT_E);
ok('7.4 ⚠ Gate/Decide 同口径: 招进「驻地为空」那支队 (不是 wrong-settle)',
  !!(hiE.json && hiE.json.ok === true && hiE.json.squadId === 'sq2'),
  JSON.stringify(hiE.json && (hiE.json.code || hiE.json.error)));
const crewE = await api('GET', '/api/crew');
const sqE3 = ((crewE.json && crewE.json.squads) || []).find(s => s.id === 'sq2');
ok('7.5 招完把该队驻地补绑到本次聚落', !!(sqE3 && sqE3.settle === B), sqE3 && sqE3.settle);
ok('7.6 队里 2 人 (旧 1 + 新 1), 另一队不受影响',
  !!(sqE3 && sqE3.members.length === 2), sqE3 && sqE3.members.join(','));
const sqE1 = ((crewE.json && crewE.json.squads) || []).find(s => s.id === 'sq1');
ok('7.7 在 A 的那支队驻地没被改', !!(sqE1 && sqE1.settle === A), sqE1 && sqE1.settle);

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
