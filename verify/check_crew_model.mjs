/* ============================================================
 * check_crew_model.mjs — 小队纯逻辑层 (web/js/crew/crew-model.js) 契约
 * ------------------------------------------------------------
 * 覆盖审查批次: C1 (慧根文案↔效果) / C2 (队 id 去重收敛, 原实现死循环) /
 *              C10 (特质接进派生值 + PENDING_TRAITS 灰标) +
 *              D13 (probe 必须校验 squads/curSquad) / D15 (负面特质保底 -1) /
 *              D16 (未知 jobId 必须清成待派活再重派)
 *
 * ⚠ 纯 Node, 不需要 DOM (DOM 那一层在 crew-panel.js, 归 _crew_harness.html)。
 *
 * 用法: node verify/check_crew_model.mjs   (任意 cwd; rc=0 通过, rc=1 失败)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
global.window = globalThis;
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'crew', 'crew-model.js'), 'utf8'));
const M = window.CrewModel;

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

/* C1 */
ok('C1 慧根 修炼速度 +6%', M.TRAITS['慧根'].v === '修炼速度 +6%', M.TRAITS['慧根'].v);

/* C2 去重必须收敛 (原实现会死循环 —— 用子进程超时兜底, 这里直接调) */
const st0 = M.demoSquad(6, 7, 3);
st0.squads = [
  { id: 'sq1_3', name: '甲', members: [st0.pawns[0].id] },
  { id: 'sq1', name: '乙', members: [st0.pawns[1].id] },
  { id: 'sq1', name: '丙', members: [st0.pawns[2].id] }
];
let c2ok = false, c2ids = null;
try {
  const out = M.normalizeSquads(st0);
  c2ids = out.map(s => s.id);
  c2ok = new Set(c2ids).size === c2ids.length;
} catch (e) { c2ids = 'threw: ' + e.message; }
ok('C2 队 id 去重收敛且唯一', c2ok, JSON.stringify(c2ids));

/* C2 幂等: 再跑一次不变 */
const ids2 = M.normalizeSquads(st0).map(s => s.id);
ok('C2 去重幂等', JSON.stringify(ids2) === JSON.stringify(c2ids), JSON.stringify(ids2));

/* D14 找不到队 ⇒ 空 (不回落) */
const s2 = M.demoSquad(5, 9, 2);
ok('D14 不存在的队返回空数组', M.squadPawns(s2, 'nope').length === 0);
ok('D14 缺 id 时取 curSquad', M.squadPawns(s2).length === M.squadPawns(s2, s2.curSquad).length);
/* 空队也返回空 */
s2.squads.push({ id: 'sq9', name: '空队', members: [] });
ok('D14 空队返回空数组 (不是全员)', M.squadPawns(s2, 'sq9').length === 0);

/* D13 probe: 缺 squads 必须报错 */
const s3 = M.demoSquad(5, 11, 1);
const p3 = M.probe(s3);
ok('D13 正常 state 的 probe 仍 ok', p3.ok, p3.violations.slice(0, 3).join(' | '));
const s4 = M.demoSquad(5, 11, 1);
s4.squads = undefined;
const p4 = M.probe(s4);
ok('D13 缺 squads 的 probe 变红', !p4.ok && p4.violations.some(v => v.includes('squads')), p4.violations.slice(0, 2).join(' | '));
const s5 = M.demoSquad(5, 11, 1);
s5.curSquad = 'ghost';
const p5 = M.probe(s5);
ok('D13 curSquad 不存在被抓出', !p5.ok && p5.violations.some(v => v.includes('curSquad')), p5.violations.slice(0, 2).join(' | '));

/* D15 负向特质保底: atk 小也要扣到 1 点 */
const sp = JSON.parse(JSON.stringify(M.demoSquad(3, 3, 1).pawns[0]));
sp.traits = [{ n: '畏战', v: '近战伤害 -4%', tier: 'neg', bonus: 0, pair: 'nerve' }];
sp.gear = { weapon: null, offhand: null, body: null, head: null, talisman: null };
sp.queue = [];
const atkNeg = M.attrs(sp).atk;
sp.traits = [];
const atkBase = M.attrs(sp).atk;
ok('D15 畏战至少扣 1 点 (无保底会 0 点)', atkBase - atkNeg >= 1, 'base=' + atkBase + ' neg=' + atkNeg);

/* C10 力大无穷 负重 +5% */
const sp2 = JSON.parse(JSON.stringify(M.demoSquad(3, 4, 1).pawns[0]));
sp2.traits = [];
const loadBase = M.loadMax(sp2);
sp2.traits = [{ n: '力大无穷', v: '', tier: 'rare', bonus: 6, pair: 'solo-mighty' }];
const loadMighty = M.loadMax(sp2);
ok('C10 力大无穷 负重 +5% 生效', loadMighty > loadBase, loadBase + ' -> ' + loadMighty);

/* C10 聚气 → mp 上限 */
const sp3 = JSON.parse(JSON.stringify(M.demoSquad(3, 5, 1).pawns[0]));
sp3.traits = [];
const mpBase = M.attrs(sp3).mp;
sp3.traits = [{ n: '五行亲和', v: '', tier: 'rare', bonus: 5, pair: 'solo-fivemix' }];
ok('C10 五行亲和 聚气 +4% 抬 mp 上限', M.attrs(sp3).mp > mpBase, mpBase + ' -> ' + M.attrs(sp3).mp);

/* C10 修炼速度 */
const sp4 = JSON.parse(JSON.stringify(M.demoSquad(3, 6, 1).pawns[0]));
sp4.traits = [];
ok('C10 慧根 修炼倍率 1.06', Math.abs(M.expRateOf(sp4) - 1) < 1e-9, String(M.expRateOf(sp4)));
sp4.traits = [{ n: '慧根', v: '', tier: 'uncommon', bonus: 4, pair: 'insight' }];
ok('C10 慧根 expRateOf=1.06', Math.abs(M.expRateOf(sp4) - 1.06) < 1e-9, String(M.expRateOf(sp4)));

/* C10 心境下限 */
const sp5 = JSON.parse(JSON.stringify(M.demoSquad(3, 7, 1).pawns[0]));
sp5.traits = [];
ok('C10 默认心境下限 20', M.moodFloor(sp5) === 20);
sp5.traits = [{ n: '心如止水', v: '', tier: 'uncommon', bonus: 3, pair: 'solo-calm' }];
ok('C10 心如止水 心境下限 35', M.moodFloor(sp5) === 35);

/* C10 未接系统的特质清单 */
const pend = Object.keys(M.PENDING_TRAITS);
ok('C10 未接系统特质 9 条', pend.length === 9, pend.join(','));
ok('C10 pending 的条目都在 TRAITS 表里', pend.every(n => !!M.TRAITS[n]), pend.filter(n => !M.TRAITS[n]).join(','));

/* D16 step 读 state.jobs */
const s6 = M.demoSquad(4, 12, 1);
/* 换一张只有两个工种的表 (服务端换表场景) */
s6.jobs = [{ id: 'gather', ch: '采', n: '采集', target: '灵草', dao: 'qi' },
           { id: 'study', ch: '经', n: '研经', target: '藏经阁', dao: 'mind' }];
for (const p of s6.pawns) { p.job = null; p.prio = { gather: 1, mine: 1, study: 2 }; }
M.step(s6, 100);
const badJobs = s6.pawns.filter(p => p.job && p.job.jobId && !s6.jobs.some(j => j.id === p.job.jobId));
ok('D16 派活只从 state.jobs 里挑', badJobs.length === 0, badJobs.map(p => p.job.jobId).join(','));

/* D16 未知 jobId 会被清掉重派而不是永久卡死 */
const s7 = M.demoSquad(3, 13, 1);
s7.jobs = [{ id: 'gather', ch: '采', n: '采集', target: '灵草', dao: 'qi' }];
s7.pawns[0].job = { jobId: 'gone', task: '旧活', progress: 0, done: 0 };
M.step(s7, 100);
ok('D16 未知 jobId 清成待派活', s7.pawns[0].job.jobId === null, JSON.stringify(s7.pawns[0].job));
M.step(s7, 100);
ok('D16 下一轮重新派活 (不再卡死)', s7.pawns[0].job.jobId === 'gather', JSON.stringify(s7.pawns[0].job));

/* 回归: 多跑几步不产生违规 */
const s8 = M.demoSquad(6, 20261124, 3);
for (let i = 0; i < 80; i++) M.step(s8, 3000);
const p8 = M.probe(s8);
ok('回归 demoSquad 跑 80 步后 probe 仍 ok', p8.ok, p8.violations.slice(0, 3).join(' | '));

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
