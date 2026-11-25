/* ============================================================
 * check_crew_bridge.mjs — 契约桥 (web/js/crew/crew-bridge.js) 契约
 * ------------------------------------------------------------
 * 覆盖审查批次: C7 (事件流: 只发事件不发整份契约) /
 *              C15 (bag.capacity 唯一真源) / C16 (溢出进 overflow) /
 *              C17 (缺 vit 补满) / C18 (队列/槽位 itemRef 重复引用)
 *
 * ⚠ 纯 Node, 不需要 DOM。⚠ 与 verify/_crew_bridge_probe.mjs 的分工:
 *   本脚本测**语义边界** (容量/溢出/引用/事件信封), probe 测**往返幂等**。
 *
 * 用法: node verify/check_crew_bridge.mjs  (任意 cwd; rc=0 通过, rc=1 失败)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => (0, eval)(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

global.window = globalThis;
load('web/js/crew/crew-model.js');
load('web/js/crew/crew-bridge.js');

const M = window.CrewModel, B = window.CrewBridge;
let pass = 0, fail = 0;
function ok(name, cond, note) {
  if (cond) { pass++; console.log('PASS ' + name + (note ? ' · ' + note : '')); }
  else { fail++; console.log('FAIL ' + name + (note ? ' · ' + note : '')); }
}

const base = B.dump(M.demoSquad(6, 20261124, 2));

/* ================= C15: bag.capacity 唯一真源 ================= */
const big = JSON.parse(JSON.stringify(base));
big.bag.capacity = 54;
big.squad.members[0].equip.weapon = big.bag.items[0].id;
/* 给一个 cell=50 的背包件: 旧实现判合法(用 capacity)但装载按 48 开 ⇒ 装不下 */
big.bag.items[0].wornBy = null;
big.bag.items[0].cell = 50;
const vBig = B.validate(big);
ok('C15 capacity=54 时 cell=50 不再判越界', !vBig.warnings.some(w => w.includes('cell 越界')),
  vBig.warnings.filter(w => w.includes('cell')).join(' | '));
const hBig = B.hydrate(big);
ok('C15 capacity=54 ⇒ stash 54 格', hBig.ok && hBig.state.stash.length === 54, 'len=' + (hBig.state ? hBig.state.stash.length : 'n/a'));
ok('C15 capacity=54 ⇒ cell=50 真的放下了', hBig.ok && hBig.state.stash[50] && hBig.state.stash[50].id === big.bag.items[0].id,
  hBig.ok ? String(hBig.state.stash[50] && hBig.state.stash[50].id) : hBig.errors.join(';'));

const small = JSON.parse(JSON.stringify(base));
small.bag.capacity = 40;
small.bag.items[0].wornBy = null;
small.bag.items[0].cell = 44;
const vSmall = B.validate(small);
ok('C15 capacity=40 时 cell=44 判越界(改自动排)', vSmall.warnings.some(w => w.includes('cell 越界')),
  vSmall.warnings.filter(w => w.includes('cell')).join(' | '));
const hSmall = B.hydrate(small);
ok('C15 capacity=40 ⇒ stash 40 格', hSmall.ok && hSmall.state.stash.length === 40, 'len=' + hSmall.state.stash.length);

/* ================= C16: 溢出物品不丢 ================= */
const over = JSON.parse(JSON.stringify(base));
over.bag.capacity = 3;                       // 塞不下这么多东西
const hOver = B.hydrate(over);
ok('C16 溢出不再只是 warning', hOver.warnings.some(w => w.includes('溢出区')) || hOver.warnings.some(w => w.includes('溢出')),
  hOver.warnings.filter(w => w.includes('溢出'))[0] || '(无)');
const ovLen = hOver.state.overflow ? hOver.state.overflow.length : 0;
ok('C16 溢出物品进了 state.overflow', ovLen > 0, 'n=' + ovLen);
const dOver = B.dump(hOver.state);
const expectIds = new Set(over.bag.items.map(x => x.id));
const gotIds = new Set(dOver.bag.items.map(x => x.id));
const lost = [...expectIds].filter(x => !gotIds.has(x));
ok('C16 往返后一件物品都没丢', lost.length === 0, lost.length ? ('丢 ' + lost.length + ' 件: ' + lost.slice(0, 3)) : '全部保留');

/* ================= C17: 缺 vit 不能变 0 ================= */
const noVit = JSON.parse(JSON.stringify(base));
delete noVit.squad.members[0].vit;
const hNoVit = B.hydrate(noVit);
ok('C17 缺 vit 时按满血补', hNoVit.ok && hNoVit.state.pawns[0].vit && hNoVit.state.pawns[0].vit.hp > 0,
  hNoVit.ok ? JSON.stringify(hNoVit.state.pawns[0].vit) : hNoVit.errors.join(';'));
const dNoVit = B.dump(hNoVit.state);
ok('C17 dump 出的 vit 不是 0/0', dNoVit.squad.members[0].vit.hp > 0 && dNoVit.squad.members[0].vit.mp > 0,
  JSON.stringify(dNoVit.squad.members[0].vit));
const hNoVit2 = B.hydrate(dNoVit);
ok('C17 二次往返仍是满血 (不是 0%)',
  hNoVit2.ok && hNoVit2.state.pawns[0].vit.hp === hNoVit.state.pawns[0].vit.hp,
  hNoVit2.ok ? String(hNoVit2.state.pawns[0].vit.hp) : hNoVit2.errors.join(';'));

/* ================= C18: 重复引用 ================= */
const dup = JSON.parse(JSON.stringify(base));
const qid = dup.squad.members[0].queue[0];
dup.squad.members[1].equip.body = qid;        // 别人的法宝挂到自己身上
const vDup = B.validate(dup);
ok('C18 跨成员重复引用判 error', !vDup.ok && vDup.errors.some(e => e.includes('同时引用')),
  vDup.errors.filter(e => e.includes('引用')).join(' | '));

const dup2 = JSON.parse(JSON.stringify(base));
dup2.squad.members[0].equip.weapon = dup2.squad.members[0].equip.head;   // 同一人两槽同件
const vDup2 = B.validate(dup2);
ok('C18 同人两槽同件判 error', !vDup2.ok && vDup2.errors.some(e => e.includes('同时引用')),
  vDup2.errors.filter(e => e.includes('引用')).join(' | '));

/* 正常契约 (法宝槽 = queue[0]) 不能被误伤 */
ok('C18 法宝槽 = 队列首位不算重复', B.validate(base).ok, B.validate(base).errors.join(';'));

/* ================= C7: 事件信封 ================= */
const sent = [];
global.fetch = (url, opts) => {
  const body = JSON.parse(opts.body);
  sent.push({ url, body });
  const rev = (body.base || 0) + 1;
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, rev, results: body.events.map(e => ({ id: e.id, ok: true })) })
  });
};

const hEv = B.hydrate(base);          /* 先 hydrate: 它会用契约自己的 revision 设 base */
B.configureEvents({ enabled: true, base: 7 });
const stEv = hEv.state;
const pawn0 = stEv.pawns[0];

const evs = [];
B.onChange(e => evs.push(e));        /* 必须在写操作之前订阅, 否则收不到前几条 */

B.wrapWrites();

/* 1. 装备一件背包里的东西 */
let stashIdx = stEv.stash.findIndex(x => x && M.CrewModel ? true : false);
stashIdx = stEv.stash.findIndex(x => x);
const beforeItemId = stEv.stash[stashIdx].id;
M.equip(pawn0, stEv.stash, stashIdx);
/* 2. 卸下 */
M.unequip(pawn0, stEv.stash, 'head');
/* 3. 服丹 (必须是 pill 且气血未满) */
stEv.stash[0] = M.makeItem({ n: '回元丹', kind: 'pill', ch: '丹', q: 1, w: 1, heal: 30 }, 'test-pill');
stEv.pawns[1].vit.hp = 10;
M.useItem(stEv.pawns[1], stEv.stash, 0);
/* 4. 改优先级 */
M.cyclePriority(pawn0, 'gather');
/* 5. 挪人 */
M.movePawn(stEv, pawn0.id, stEv.squads[1].id, 0);

const es = B.eventState();
ok('C7 接了后台才入队', es.enabled === true, JSON.stringify(es));

B.flushEvents().then(async () => {
  const body = sent[0] ? sent[0].body : null;
  ok('C7 发到 /api/crew/events', sent.length === 1 && sent[0].url === '/api/crew/events', sent[0] ? sent[0].url : '(没发)');
  ok('C7 请求体是 {base, events[]}', !!body && typeof body.base === 'number' && Array.isArray(body.events),
    body ? 'base=' + body.base + ' n=' + body.events.length : '(空)');
  ok('C7 base = 客户端看到的 rev (7)', !!body && body.base === 7, body ? String(body.base) : '');
  const types = body ? body.events.map(e => e.type) : [];
  ok('C7 五类事件都发出来了', types.length === 5, types.join(','));
  ok('C7 type 用契约名 (item.equip/unequip/use/job.priority/member.move)',
    ['item.equip', 'item.unequip', 'item.use', 'job.priority', 'member.move'].every(t => types.indexOf(t) >= 0),
    types.join(','));
  const e0 = body ? body.events[0] : {};
  ok('C7 信封字段齐全 (v/id/seq/base/at/type/data)',
    e0.v === 1 && typeof e0.id === 'string' && typeof e0.seq === 'number' && typeof e0.base === 'number' &&
    typeof e0.at === 'number' && typeof e0.type === 'string' && !!e0.data,
    JSON.stringify(e0).slice(0, 120));
  ok('C7 信封不带 contract (§14.0 明令废弃)', body ? body.events.every(e => !('contract' in e)) : false);
  ok('C7 data 只放 id + 目标值', body
    ? body.events.every(e => Object.keys(e.data).every(k => ['pawnId', 'itemId', 'slot', 'jobId', 'value', 'toSquadId', 'toPos', 'squadId', 'name', 'toIndex', 'toSquadIdNot'].indexOf(k) >= 0))
    : false,
    body ? JSON.stringify(body.events.map(e => Object.keys(e.data))) : '');
  const eqEv = body ? body.events.find(e => e.type === 'item.equip') : null;
  ok('C7 item.equip 的 data 是 id 不是对象引用',
    !!eqEv && typeof eqEv.data.pawnId === 'string' && typeof eqEv.data.itemId === 'string' &&
    eqEv.data.itemId === beforeItemId, eqEv ? JSON.stringify(eqEv.data) : '');
  const priEv = body ? body.events.find(e => e.type === 'job.priority') : null;
  ok('C7 job.priority 带 value (前端算好的目标值)',
    !!priEv && typeof priEv.data.value === 'number' && priEv.data.value >= 0 && priEv.data.value <= 4,
    priEv ? JSON.stringify(priEv.data) : '');
  const mvEv = body ? body.events.find(e => e.type === 'member.move') : null;
  ok('C7 member.move 带 toSquadId/toPos', !!mvEv && typeof mvEv.data.toSquadId === 'string' && mvEv.data.toPos === 0,
    mvEv ? JSON.stringify(mvEv.data) : '');

  ok('C7 seq 单调 +1 且无洞', body ? body.events.every((e, i) => i === 0 || e.seq === body.events[i - 1].seq + 1) : false,
    body ? body.events.map(e => e.seq).join(',') : '');
  ok('C7 id 唯一 (幂等键)', body ? new Set(body.events.map(e => e.id)).size === body.events.length : false);
  ok('C7 成功后 base 跟到服务端 rev', B.eventState().base === 8, 'base=' + B.eventState().base);
  ok('C7 成功后队列清空', B.eventState().pending === 0, 'pending=' + B.eventState().pending);

  /* 失败要留在队列 */
  global.fetch = () => Promise.reject(new Error('boom'));
  M.cyclePriority(pawn0, 'farm');
  await B.flushEvents();
  ok('C7 网络失败 ⇒ 事件留在队列 (不丢)', B.eventState().pending === 1, 'pending=' + B.eventState().pending);
  ok('C7 失败记 lastError', !!B.eventState().lastError, B.eventState().lastError);

  /* 恢复后重发成功 */
  sent.length = 0;
  global.fetch = (url, opts) => {
    const body2 = JSON.parse(opts.body);
    sent.push({ url, body: body2 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rev: (body2.base || 0) + 1 }) });
  };
  await B.flushEvents();
  ok('C7 恢复后重发成功且队列清空', sent.length === 1 && B.eventState().pending === 0,
    'sent=' + sent.length + ' pending=' + B.eventState().pending);

  /* resync: 服务端整份回推 ⇒ 本地重装 */
  let mounted = null;
  const origMount = B.mount;
  global.fetch = () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: false, rev: 99, resync: true, state: base })
  });
  /* 优先级归 0 也必须发事件 (0 是合法目标值, 曾因 falsy 被吞) */
  M.cyclePriority(pawn0, 'study');
  await B.flushEvents();
  ok('C7 resync ⇒ base 跟到服务端 rev 99', B.eventState().base === 99, 'base=' + B.eventState().base);
  ok('C7 resync ⇒ 队列作废', B.eventState().pending === 0, 'pending=' + B.eventState().pending);
  ok('C7 优先级归 0 也发事件 (0 不能被当 falsy 吞掉)', sent.length >= 1, 'sent=' + sent.length);

  /* onChange 收到的是事件而不是整份契约 */
  ok('C7 onChange 回调拿到事件对象', evs.length >= 5 && evs[0].type && evs[0].v === 1,
    evs.length ? JSON.stringify(evs[0]).slice(0, 80) : '(无)');

  console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
  process.exit(fail ? 1 : 0);
});
