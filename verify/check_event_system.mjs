/* ============================================================
 * check_event_system.mjs — 跨 tick 事件系统判据
 * ------------------------------------------------------------
 * 被测（经 verify/eventprobe 以 <Compile Include> **链接同一份源文件**，不是复制品）：
 *   Server/Zongmen/Events/PbWire.cs           protobuf wire 原语
 *   Server/Zongmen/Events/CityDiff.cs         「前后对比」的 diff + 编解码
 *   Server/Zongmen/Events/EventTypes.cs       枚举 / 脚本注册表 / 最小堆
 *   Server/Zongmen/Events/EntityRegistry.cs   全局 int32 ↔ 引擎字符串 id
 *   Server/Zongmen/Events/EventStore.cs       EventQueue + History（原子提交）
 *   Server/Zongmen/Subsystems/City/js/city-events.js   脚本实现（Node 侧 eval + 正则）
 *
 * 断言分组：
 *   A. PbWire：zigzag（-1 只占 2 字节；标准 int32 会是 11）
 *   B. CityDiff：只写变化字段 / 往返逐字节一致 / apply 后与 after 无差
 *   C. CityDiff：无变化 ⇒ 0 字节
 *   D. CityDiff：字段变成 0 **必须写**（不能当「没变」）
 *   E. CityDiff：nullable 从有值变 null 用独立标志位
 *   F. CityDiff：库存单项变化只写 1 个 field
 *   G. EventHeap：堆序 / 最小 tick
 *   H. EventHeap：同 ref 二次 push 不重复
 *   I. EventHeap：收集即吊销 + 顺序与入堆无关
 *   J. EventHeap：rearm 后可再次到期；remove 生效
 *   K. EntityRegistry：幂等 / 重启保持 / highWater 只增
 *   L. EventStore：upsert↔load / commit 原子 / 一次性删行 / 周期改期
 *   M. 注册表 ↔ city-events.js HANDLERS 逐值一致
 *   N. 源码守卫（挂线顺序、出口 case、bundle 序、Put→CommitRun 顺序、确定性）
 *
 * ⚠ 不用「耗时 < N ms」这类绝对值阈值（工程教训：必假红）。
 * 用法: node verify/check_event_system.mjs      (rc=0 通过 / rc=1 失败)
 * ============================================================ */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(__dirname, 'eventprobe');
const BIN = path.join(PROJ, 'bin', 'Release', 'net8.0', 'eventprobe.exe');
const TMP = path.join(ROOT, 'Temp', 'eventprobe');
const SRC = (p) => path.join(ROOT, 'Server', 'Zongmen', p);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

/* ── 构建宿主（缺了才建；8140 在跑也不影响，本工程不引用主工程）── */
if (!fs.existsSync(BIN)) {
  console.log('  … 构建 eventprobe');
  execSync(`dotnet build "${PROJ}" -c Release -v q --nologo`, { cwd: ROOT, stdio: 'inherit' });
}

/* ── 一次性把全部 op 喂进去，按行收结果（顺序一一对应）── */
function runProbe(lines) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (err += d.toString('utf8')));
    p.on('error', reject);
    p.on('close', () => {
      const rows = out.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
      if (rows.length !== lines.length) {
        return reject(new Error(`probe 输出 ${rows.length} 行 / 输入 ${lines.length} 行\nSTDERR: ${err}`));
      }
      resolve(rows);
    });
    for (const l of lines) p.stdin.write(l + '\n');
    p.stdin.end();
  });
}

fs.mkdirSync(TMP, { recursive: true });
const unlinkIf = (f) => { for (const s of ['', '-wal', '-shm']) { const p = f + s; if (fs.existsSync(p)) fs.unlinkSync(p); } };

/* ══════════════════════════════════════════════════════════════════
 * 准备输入
 * ══════════════════════════════════════════════════════════════════ */
const BASE = {
  id: '3_-2_1', type: 'town', q: 10, r: 20,
  pop: 1000, popF: 1000.0, tier: 2, state: 0,
  stock: { 粮: 100, 木: 50, 矿: 0, 渔: 0, 炭: 0, 灵: 0, 丹: 0, 器: 0 },
  built: [{ q: 1, r: 1, kind: '药圃', terrain: '林地', tier: 1, lv: 1, evo: 1 }],
  bornTick: 0, lastEvoTick: 100, ver: 5, age: 300,
  foodDebt: 0, popBase: 1000, basePopF: 1000.0, baseAge: 100, builtFrac: 0.5, Kf: 1000.0,
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const ENT_DB = path.join(TMP, 'entity.sqlite');
const STO_DB = path.join(TMP, 'store.sqlite');
for (const f of [ENT_DB, STO_DB]) unlinkIf(f);

const inputs = [];
const idx = {};   // 名字 → 行下标
const push = (name, obj) => { idx[name] = inputs.length; inputs.push(JSON.stringify(obj)); };

/* ── A. PbWire ── */
push('pb_m1', { op: 'pb', field: 1, v: -1 });
push('pb_0', { op: 'pb', field: 3, v: 0 });
push('pb_big', { op: 'pb', field: 5, v: -2147483648 });
push('pb_pos', { op: 'pb', field: 2, v: 1234567 });

/* ── B/C/D/E/F. CityDiff ── */
push('diff_same', { op: 'diff', before: BASE, after: clone(BASE) });
push('diff_pop', { op: 'diff', before: BASE, after: { ...clone(BASE), pop: 900 } });
push('diff_pop2', {
  op: 'diff', before: BASE,
  after: { ...clone(BASE), pop: 900, popF: 900.0, ver: 6 },
});
push('diff_zero', { op: 'diff', before: BASE, after: { ...clone(BASE), pop: 0 } });
push('diff_basenull', {
  op: 'diff', before: BASE,
  after: { ...clone(BASE), basePopF: null, baseAge: null },
});
push('diff_stock', {
  op: 'diff', before: BASE,
  after: { ...clone(BASE), stock: { 粮: 90, 木: 50, 矿: 0, 渔: 0, 炭: 0, 灵: 0, 丹: 0, 器: 0 } },
});
push('diff_built', {
  op: 'diff', before: BASE,
  after: { ...clone(BASE), built: [] },
});

/* ── G/H/I/J. EventHeap ── */
push('heap_main', {
  op: 'heap',
  cmds: [
    /* 故意乱序入堆 + 同 ref 重复 push */
    { c: 'push', round: 1, e: 7, k: 0, fn: 1, tick: 500 },
    { c: 'push', round: 1, e: 3, k: 0, fn: 1, tick: 100 },
    { c: 'push', round: 1, e: 5, k: 1, fn: 2, tick: 100 },
    { c: 'push', round: 1, e: 5, k: 0, fn: 1, tick: 300 },
    { c: 'validate' },
    { c: 'next' },
    { c: 'duppush', round: 1, e: 9, k: 0, fn: 6, tick: 900 },
    { c: 'validate' },
    { c: 'advance', now: 100 },
    { c: 'next' },
    { c: 'validate' },
    /* 把吊销的两条重新排期，再收集（验证 re-arm 有效） */
    { c: 'rearm', round: 1, e: 5, k: 1, tick: 150 },
    { c: 'rearm', round: 1, e: 3, k: 0, tick: 150 },
    { c: 'next' },
    { c: 'advance', now: 150 },
    { c: 'remove', round: 1, e: 7, k: 0 },
    { c: 'validate' },
  ],
});
push('heap_empty', { op: 'heap', cmds: [{ c: 'clear' }, { c: 'next' }, { c: 'advance', now: 999 }, { c: 'validate' }] });

/* ── K. EntityRegistry ── */
push('ent_open1', { op: 'entity', action: 'open', db: ENT_DB });
push('ent_a', { op: 'entity', action: 'get', kind: 1, name: '-3_-3_0' });
push('ent_a2', { op: 'entity', action: 'get', kind: 1, name: '-3_-3_0' });
push('ent_b', { op: 'entity', action: 'get', kind: 1, name: '5_7_u0' });
push('ent_ids1', { op: 'entity', action: 'ids' });
push('ent_name1', { op: 'entity', action: 'name', id: 1 });
push('ent_close1', { op: 'entity', action: 'close' });
/* 模拟重启：关掉再打开同一个库 */
push('ent_open2', { op: 'entity', action: 'open', db: ENT_DB });
push('ent_a3', { op: 'entity', action: 'get', kind: 1, name: '-3_-3_0' });
push('ent_c', { op: 'entity', action: 'get', kind: 1, name: '0_0_2' });
push('ent_ids2', { op: 'entity', action: 'ids' });
push('ent_close2', { op: 'entity', action: 'close' });

/* ── L. EventStore ── */
push('sto_open', { op: 'store', action: 'open', db: STO_DB });
push('sto_up1', { op: 'store', action: 'upsert', round: 1, e: 1, k: 0, script: 1, fn: 1, tick: 100, period: 0 });
push('sto_up2', { op: 'store', action: 'upsert', round: 1, e: 1, k: 1, script: 1, fn: 3, tick: 200, period: 30 });
push('sto_load1', { op: 'store', action: 'load', round: 1 });
/* 一次性事件：提交后行应消失、History +1 */
push('sto_commit1', { op: 'store', action: 'commit', round: 1, e: 1, k: 0, script: 1, fn: 1, tick: 100, diffHex: '0801', next: 0, oneShot: true });
/* 周期事件：提交后行还在、NextTick 推进 */
push('sto_commit2', { op: 'store', action: 'commit', round: 1, e: 1, k: 1, script: 1, fn: 3, tick: 230, diffHex: '', next: 260, oneShot: false });
push('sto_load2', { op: 'store', action: 'load', round: 1 });
push('sto_hist', { op: 'store', action: 'history', round: 1 });
push('sto_close', { op: 'store', action: 'close' });
/* 再开一次：History 的 Seq 必须接着上一段，不从头来 */
push('sto_open2', { op: 'store', action: 'open', db: STO_DB });
push('sto_commit3', { op: 'store', action: 'commit', round: 1, e: 2, k: 0, script: 1, fn: 6, tick: 300, diffHex: '', next: 0, oneShot: true });
push('sto_hist2', { op: 'store', action: 'history', round: 1, from: 2 });
push('sto_close2', { op: 'store', action: 'close' });

/* ── M. 注册表 ── */
push('registry', { op: 'registry' });

/* ══════════════════════════════════════════════════════════════════
 * 跑
 * ══════════════════════════════════════════════════════════════════ */
const out = await runProbe(inputs);
const R = (name) => out[idx[name]];

/* ── A ── */
console.log('\nA. PbWire（zigzag）');
{
  const m1 = R('pb_m1');
  check('A1 负数字段往返', m1.ok === true);
  check('A2 -1 只占 2 字节（zigzag 生效）', m1.bytes === 2, `实际 ${m1.bytes}B hex=${m1.hex}`);
  check('A3 0 占 2 字节', R('pb_0').bytes === 2);
  check('A4 int.MinValue 往返', R('pb_big').ok === true);
  check('A5 正数往返', R('pb_pos').ok === true && R('pb_pos').back === 1234567);
}

/* ── B/C/D/E/F ── */
console.log('\nB~F. CityDiff');
{
  const same = R('diff_same');
  check('B0/C1 无变化 ⇒ 0 字节 + IsEmpty', same.isEmpty === true && same.bytes === 0, `bytes=${same.bytes}`);
  check('C2 无变化 ⇒ count=0', same.count === 0);

  const pop = R('diff_pop');
  check('B1 只改 pop ⇒ diff 只有 1 个字段', pop.count === 1, `count=${pop.count}`);
  check('B2 只改 pop ⇒ 字节数 < 16', pop.bytes > 0 && pop.bytes < 16, `${pop.bytes}B`);
  check('B3 往返逐字节一致', pop.roundTrip === true);
  check('B4 apply 后与 after 无差', pop.appliedEqualsAfter === true, `rest=${pop.restCount}`);

  const pop2 = R('diff_pop2');
  check('B5 改 pop+popF+ver ⇒ 3 个字段', pop2.count === 3, `count=${pop2.count}`);

  const zero = R('diff_zero');
  check('D1 pop 变成 0 **要写**（不能当没变）', zero.count === 1 && zero.bytes > 0, `count=${zero.count} bytes=${zero.bytes}`);
  check('D2 pop=0 往返一致', zero.roundTrip === true && zero.appliedEqualsAfter === true);

  const bn = R('diff_basenull');
  check('E1 nullable 变 null 用标志位表达', bn.count === 2, `count=${bn.count}`);
  check('E2 nullable 变 null 往返一致', bn.roundTrip === true && bn.appliedEqualsAfter === true);

  const st = R('diff_stock');
  check('F1 库存单项变化 ⇒ 只有 1 个字段', st.count === 1, `count=${st.count}`);
  check('F2 库存 diff 往返一致', st.roundTrip === true && st.appliedEqualsAfter === true);

  const bl = R('diff_built');
  check('F3 built 清空被记录且往返一致', bl.count >= 1 && bl.appliedEqualsAfter === true, `count=${bl.count}`);
}

/* ── G~J ── */
console.log('\nG~J. EventHeap');
{
  const h = R('heap_main');
  const s = h.steps;
  check('G1 4 条入堆后 count=4', s[3].count === 4, `count=${s[3].count}`);
  check('G2 堆序自检通过（乱序入堆）', s[4].ok === true, s[4].err || '');
  check('G3 最小 tick = 100', s[5].next === 100, `next=${s[5].next}`);

  const dup = s.find((x) => x.c === 'duppush');
  check('H1 同 ref 二次 push 不重复（count 只 +1）', dup.count === 5, `count=${dup.count}`);
  check('H2 重复 push 后堆序仍成立', s[7].ok === true, s[7].err || '');

  const adv = s[8];
  check('I1 到期 2 条（同为 tick=100）', adv.n === 2, `n=${adv.n}`);
  check('I2 收集顺序按 (EntityId,EventKey) 与入堆序无关',
    JSON.stringify(adv.order) === JSON.stringify(['3#0', '5#1']), JSON.stringify(adv.order));
  check('I3 收集即吊销 ⇒ count 不变', adv.count === 5, `count=${adv.count}`);
  check('I4 吊销后堆序仍成立', s[10].ok === true, s[10].err || '');

  /* 索引对照 heap_main 的 cmds 序列：
     0 push e7 / 1 push e3 / 2 push e5#1 / 3 push e5#0 / 4 validate / 5 next /
     6 duppush / 7 validate / 8 advance(100) / 9 next / 10 validate /
     11 rearm(e5#1) / 12 rearm(e3#0) / 13 next / 14 advance(150) / 15 remove / 16 validate */
  const adv2 = s[14];
  check('J1 re-arm 后能再次到期', adv2.n === 2, `n=${adv2.n}`);
  check('J2 re-arm 顺序正确', JSON.stringify(adv2.order) === JSON.stringify(['3#0', '5#1']), JSON.stringify(adv2.order));
  check('J3 remove 生效', s[15].ok === true);
  check('J4 remove 后堆序仍成立', s[16].ok === true, s[16].err || '');

  const em = R('heap_empty');
  check('J5 clear 后 next = -1（无待触发）', em.steps[1].next === -1);
  check('J6 空堆 advance 零成本', em.steps[2].n === 0);
  check('J7 空堆自检通过', em.steps[3].ok === true);
}

/* ── K ── */
console.log('\nK. EntityRegistry');
{
  check('K1 首个实体号 = 1', R('ent_a').id === 1, `id=${R('ent_a').id}`);
  check('K2 同 (kind,name) 幂等返回同号', R('ent_a2').id === R('ent_a').id);
  check('K3 第二个实体号 = 2', R('ent_b').id === 2, `id=${R('ent_b').id}`);
  check('K4 号 → 名字反查正确', R('ent_name1').name === '-3_-3_0', R('ent_name1').name);
  check('K5 重启后同 name 仍拿同号', R('ent_a3').id === 1, `id=${R('ent_a3').id}`);
  check('K6 重启后新实体号只增（=3）', R('ent_c').id === 3, `id=${R('ent_c').id}`);
  const ids2 = R('ent_ids2');
  check('K7 号集合 = {1,2,3}', JSON.stringify(ids2.ids) === JSON.stringify([1, 2, 3]), JSON.stringify(ids2.ids));
}

/* ── L ── */
console.log('\nL. EventStore');
{
  check('L1 upsert 两行后库中 2 条', R('sto_up2').rows === 2, `rows=${R('sto_up2').rows}`);
  const ld1 = R('sto_load1');
  check('L2 load 读回 2 条', ld1.n === 2 && ld1.skipped === 0, `n=${ld1.n} skipped=${ld1.skipped}`);
  check('L3 load 的 NextTick 与写入一致',
    JSON.stringify(ld1.items.map((x) => x.tick)) === JSON.stringify([100, 200]),
    JSON.stringify(ld1.items));

  const c1 = R('sto_commit1');
  check('L4 一次性事件提交后行被删除', c1.rows === 1, `rows=${c1.rows}`);
  check('L5 提交同时写了一条 History', c1.history === 1, `history=${c1.history}`);
  check('L6 Seq 从 1 开始', c1.seq === 1, `seq=${c1.seq}`);

  const c2 = R('sto_commit2');
  check('L7 周期事件提交后行仍在', c2.rows === 1, `rows=${c2.rows}`);
  check('L8 第二次提交 Seq=2', c2.seq === 2, `seq=${c2.seq}`);

  const ld2 = R('sto_load2');
  check('L9 周期事件 NextTick 已推进到 260',
    ld2.items.length === 1 && ld2.items[0].tick === 260, JSON.stringify(ld2.items));

  const hist = R('sto_hist');
  check('L10 History 2 条', hist.n === 2, `n=${hist.n}`);
  check('L11 空 diff 也写 History（长度 0）',
    hist.items[1].bytes === 0 && hist.items[1].hex === '', JSON.stringify(hist.items[1]));
  check('L12 非空 diff 的字节被原样保存',
    hist.items[0].hex === '0801', hist.items[0].hex);

  const c3 = R('sto_commit3');
  check('L13 重启后 Seq 接着上一段（=3，不从头来）', c3.seq === 3, `seq=${c3.seq}`);
  const h2 = R('sto_hist2');
  check('L14 按 from 增量读只返回新的一条', h2.n === 1 && h2.items[0].seq === 3, JSON.stringify(h2.items));
}

/* ── M ── */
console.log('\nM. 注册表 ↔ city-events.js');
{
  const reg = R('registry');
  const cityFns = reg.all.filter((x) => x.script === 1).map((x) => x.fn).sort((a, b) => a - b);

  const jsPath = SRC('Subsystems/City/js/city-events.js');
  const js = fs.readFileSync(jsPath, 'utf8');
  const fnBlock = js.match(/var FN = \{([\s\S]*?)\};/);
  check('M1 city-events.js 有 FN 表', !!fnBlock);
  const fnMap = {};
  for (const m of (fnBlock ? fnBlock[1] : '').matchAll(/(\w+)\s*:\s*(\d+)/g)) fnMap[m[1]] = +m[2];
  const handled = [...js.matchAll(/HANDLERS\[FN\.(\w+)\]\s*=/g)].map((m) => fnMap[m[1]]).sort((a, b) => a - b);

  check('M2 JS 实现的函数集 = C# 注册表（逐值）',
    JSON.stringify(handled) === JSON.stringify(cityFns), `js=${JSON.stringify(handled)} cs=${JSON.stringify(cityFns)}`);
  check('M3 注册表 fn 码不重复', new Set(cityFns).size === cityFns.length);
  check('M4 注册表 script 全为 City(1)', reg.all.every((x) => x.script === 1));
  check('M5 注册表 vmScope 全为 "city"', reg.all.every((x) => x.scope === 'city'));
  check('M6 JS 侧无 Math.random（必须确定性）', !/Math\.random\s*\(/.test(js));
  check('M7 JS 侧无 Date.now（必须确定性）', !/Date\.now\s*\(/.test(js));
}

/* ── N. 源码守卫 ── */
console.log('\nN. 源码守卫');
{
  const pump = fs.readFileSync(SRC('Time/TickPump.cs'), 'utf8');
  const runner = fs.readFileSync(SRC('Events/EventRunner.cs'), 'utf8');
  const store = fs.readFileSync(SRC('Events/EventStore.cs'), 'utf8');
  const cityMod = fs.readFileSync(SRC('Subsystems/City/CityModule.cs'), 'utf8');
  const bundles = fs.readFileSync(SRC('Engine/JsvmModule.cs'), 'utf8');
  const prog = fs.readFileSync(SRC('Program.cs'), 'utf8');

  check('N1 TickPump 暴露 RunEventsHook', /public\s+Func<string,\s*int,\s*long,\s*int>\?\s+RunEventsHook/.test(pump));
  check('N2 TickPump 暴露 BindEventsHook', /public\s+Func<int,\s*int>\?\s+BindEventsHook/.test(pump));
  check('N3 RunOneTick 在写时钟前驱动事件', pump.indexOf('RunEvents(nowTick, b)') > 0
    && pump.indexOf('RunEvents(nowTick, b)') < pump.indexOf('Volatile.Write(ref _currentTick, nowTick + 1)'));
  check('N4 BindWorld 里绑定事件层', /_binding = new WorldBinding[\s\S]{0,200}BindEvents\(round\)/.test(pump));
  check('N5 UnbindWorld 里解绑事件层', /_binding = null;[\s\S]{0,120}BindEvents\(-1\)/.test(pump));

  /* ★ 顺序纪律：先 Put 状态、再 CommitRun。反了会让「History 说有变化、状态没变」。 */
  const iPut = runner.indexOf('_city.Put(after)');
  const iCommit = runner.indexOf('_store.CommitRun(');
  check('N6 EventRunner：Put 状态在 CommitRun 之前', iPut > 0 && iCommit > 0 && iPut < iCommit,
    `put@${iPut} commit@${iCommit}`);

  check('N7 EventRunner 有「收集即吊销 → 兜底 re-arm」', /Reprioritize\(ev\.Ref, nowTick \+ 1\)/.test(runner));
  check('N8 EventRunner 拒绝脚本改写实体 id（红线 R1）', /改写了实体 id/.test(runner));
  check('N9 EventRunner 派生事件 after 不小于 1', /if \(after < 1\) after = 1;/.test(runner));

  check('N10 CommitRun 在事务里写两张表', /BeginTransaction/.test(store)
    && /INSERT INTO History/.test(store) && /DELETE FROM EventQueue/.test(store));
  check('N11 EventStore 拒绝落库未登记脚本', /未登记的事件脚本/.test(store));

  check('N12 CityModule 接了 eventScriptJson 出口', /"eventScriptJson"\s*=>/.test(cityMod));

  const iEvo = bundles.indexOf('"city-evo.js"');
  const iEvents = bundles.indexOf('"city-events.js"');
  const iChar = bundles.indexOf('"chargen.js"');
  check('N13 bundle 里 city-events.js 排在 city-evo.js 之后', iEvo > 0 && iEvents > iEvo);
  check('N14 bundle 里 city-events.js 排在 chargen.js 之前', iEvents > 0 && iChar > iEvents);

  const iHook = prog.indexOf('_pump.BindEventsHook');
  const iAttach = prog.indexOf('AttachTickPump(_pump)');
  check('N15 Program：钩子挂在 AttachTickPump 之前', iHook > 0 && iAttach > 0 && iHook < iAttach,
    `hook@${iHook} attach@${iAttach}`);
  check('N16 Program 注册了三张事件表相关组件',
    /new EntityRegistry\(tickDbPath\)/.test(prog) && /new EventStore\(tickDbPath\)/.test(prog)
    && /new EventRunner\(/.test(prog));
}

/* ── 收尾 ── */
console.log('');
if (failures === 0) {
  console.log('OK  跨 tick 事件系统判据全部通过');
  process.exit(0);
}
console.log(`FAIL  跨 tick 事件系统判据失败 ${failures} 条`);
process.exit(1);
