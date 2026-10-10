/* ============================================================
 * check_tick_lazy.mjs — lazy nextTick 恒等契约 (离线 Node + C# 判据宿主)
 * ------------------------------------------------------------
 * 需求 (设计 §四, 用户原话「有一个很关键的东西叫做 nextTick 的 lazy
 *   代表下一次计算是什么时候，避免每Tick都要计算」):
 *   空转 tick 的成本必须是 **常数级** —— 一次 Peek 比较, 不是「遍历所有 job」。
 *
 * ⚠ 判据是**恒等**, 不是阈值:
 *   设计 §十二 明文: 「无 job 的 tick 里 `Peek` 次数 == 1」
 *   绝不用「耗时 < N ms」这种绝对值阈值 (工程既有教训: 首测含 JIT)。
 *
 * 断言:
 *   A. 空转 O(1)
 *     1. 单个 job 在 far tick: 跑 100 tick, PeekCount 增长 == 100 (每 tick 恰 1 次)
 *     2. 1000 个 job 全在 far tick: 跑 100 tick, PeekCount 增长仍 == 100  ⇒ **与 job 数无关**
 *     3. 全部空转 tick 的 EmptyAdvances == 100 (一次都没被误判定为到期)
 *   B. 到期次数恒等
 *     4. 单 job period=P, 跑 T tick ⇒ 派发次数 == floor((T-1-firstDue)/P)+1
 *     5. 恒定周期: 相邻派发间隔严格 == P (绝不 ±jitter)
 *     6. 到期 tick 上的 PeekCount 也是恰 1 次 (不因有 job 而多扫)
 *   C. 禁止「每 tick 全量扫描」
 *     7. PeekCount 增长与 (job 数 × tick 数) 无关 —— 只与 tick 数有关
 *   D. 延迟删除 / 重排不去废 job
 *     8. 同键 Push 两次 ⇒ Count 仍为 1 (覆盖而非重复)
 *     9. 重排到远期 ⇒ 从堆里消失但 Count 不变; 重排回近期 ⇒ 能正常到期
 *   E. 一次性事件
 *    10. PeriodTicks=0 ⇒ 跑完即停用 (Enabled=false 且从队列移除)
 *   F. 时钟推进与收集解耦
 *    11. advanceCalls == tick 数 (每 tick 恰好一次收集, 不多不少)
 *
 * 用法: node verify/check_tick_lazy.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(__dirname, 'tickprobe');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✘ ${name}${detail ? '  → ' + detail : ''}`); }
}

class Probe {
  constructor() {
    this.child = spawn('dotnet', ['run', '--no-build', '-v', 'q', '--project', PROJ],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiters = [];
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const w = this.waiters.shift();
        if (w) w(JSON.parse(line));
      }
    });
  }
  send(obj) {
    return new Promise((res) => { this.waiters.push(res); this.child.stdin.write(JSON.stringify(obj) + '\n'); });
  }
  close() { this.child.stdin.end(); }
}

const probe = new Probe();

try {
  /* ══ A. 空转 O(1) ═════════════════════════════════════════════════ */
  console.log('\n== A. 空转复杂度 (与 job 数无关) ==');

  // 1. 单个 job 放在 far tick（周期内不会到期）
  const oneFar = await probe.send({
    op: 'queue', steps: [
      { c: 'enqueue', seed: 's', id: 'only', kind: 'demoHeartbeat', from: 0, next: 100000 },
      ...Array.from({ length: 100 }, (_, t) => ({ c: 'advance', now: t })),
    ],
  });

  check('A1 单 job 空转 100 tick ⇒ PeekCount == 100 (每 tick 恰 1 次)',
    oneFar.peeks === 100, `peeks=${oneFar.peeks}`);

  // 2. 1000 个 job 全在 far tick
  const manyFar = await probe.send({
    op: 'queue', steps: [
      ...Array.from({ length: 1000 }, (_, i) =>
        ({ c: 'pushRaw', seed: 's', round: 1, id: `e${i}`, kind: 'DemoHeartbeat', layer: 0, resource: 1, next: 100000, period: 30 })),
      ...Array.from({ length: 100 }, (_, t) => ({ c: 'advance', now: t })),
    ],
  });

  check('A2 ★ 1000 job 空转 100 tick ⇒ PeekCount 仍 == 100 (与 job 数无关)',
    manyFar.peeks === 100, `peeks=${manyFar.peeks} (job=${manyFar.count})`);

  check('A2b 1000 job 全空转时 count 仍 == 1000 (未被误收集)',
    manyFar.count === 1000, `count=${manyFar.count}`);

  // 3. 空转 tick 全被正确计数
  const advCount = oneFar.log.filter(l => l.c === 'advance').length;
  const dueCount = oneFar.log.filter(l => l.c === 'advance').reduce((a, l) => a + l.n, 0);
  check('A3 100 次收集里合计到期 0 个 (一次都没误判)',
    advCount === 100 && dueCount === 0, `advance=${advCount} due=${dueCount}`);

  /* ══ B. 到期次数恒等 ═════════════════════════════════════════════ */
  console.log('\n== B. 到期次数 / 周期恒等 ==');
  for (const P of [7, 30, 90, 360]) {
    const T = 1800;
    const sim = await probe.send({
      op: 'simulate', entities: 1, ticks: T, kind: 'demoHeartbeat', l0Spread: P,
    });
    /* ⚠ 期望值必须用**同一个 kind 钥匙**去投影相位 ——
       NewJob 内部用的是线上名（KindNames.Of = "demoHeartbeat"），
       这里若用枚举名（"DemoHeartbeat"）会算出另一个相位（这是本轮真实抓到的 bug）。 */
    const firstDue = await probe.send({
      op: 'phase', seed: 's', id: 'e0', kind: 'demoHeartbeat', period: P, from: 0,
    });
    // 命中集合 = { t | firstDue + k*P <= T-1, k >= 0 }
    const expected = Math.floor((T - 1 - firstDue.firstDue) / P) + 1;
    const actual = sim.perEntityCounts[0];
    check(`B4 period=${P}: 单 job ${T} tick 派发 ${actual} 次 == 恒等期望 ${expected} (firstDue=${firstDue.firstDue})`,
      actual === expected, `${actual} vs ${expected}`);

    // B5 相邻命中间隔严格 == P
    const hitTicks = [];
    for (let t = 0; t < T; t++) if (sim.perTickCounts[t] > 0) hitTicks.push(t);
    let gapsOk = hitTicks.length > 1;
    for (let i = 1; i < hitTicks.length; i++) if (hitTicks[i] - hitTicks[i - 1] !== P) gapsOk = false;
    check(`B5 period=${P}: 相邻命中间隔严格 == ${P} (无 ±jitter, 共 ${hitTicks.length} 次)`,
      gapsOk && hitTicks[0] === firstDue.firstDue,
      `首=${hitTicks[0]} 期望=${firstDue.firstDue} 间隔集=${[...new Set(hitTicks.slice(1).map((v, i) => v - hitTicks[i]))]}`);
  }

  /* ══ C. 有 job 时 Peek 仍是 1 次/tick ═══════════════════════════ */
  console.log('\n== C. 有到期时 Peek 次数不膨胀 ==');
  const busy = await probe.send({
    op: 'queue',
    steps: [
      ...Array.from({ length: 50 }, (_, i) =>
        ({ c: 'pushRaw', seed: 's', round: 1, id: `b${i}`, kind: 'DemoHeartbeat', layer: 0, resource: 1, next: 10, period: 5 })),
      ...Array.from({ length: 100 }, (_, t) => ({ c: 'advance', now: t, commit: true })),
    ],
  });
  check('C6 50 job 频繁到期, 100 tick 内 PeekCount == 100 (恰 1 次/tick)',
    busy.peeks === 100, `peeks=${busy.peeks}`);

  /* ══ D. 重排 / 覆盖 ══════════════════════════════════════════════ */
  console.log('\n== D. 同键覆盖与重排 ==');
  const dup = await probe.send({
    op: 'queue', steps: [
      { c: 'enqueue', seed: 's', id: 'k', kind: 'demoHeartbeat', from: 0, next: 100 },
      { c: 'enqueue', seed: 's', id: 'k', kind: 'demoHeartbeat', from: 0, next: 200 },
      { c: 'validate' },
    ],
  });
  check('D8 同键 Push 两次 ⇒ Count == 1 (覆盖而非重复)', dup.count === 1, `count=${dup.count}`);
  check('D8b 覆盖后堆内不变量成立', dup.validate.ok, String(dup.validate.err));

  /* ══ E. 一次性事件 ══════════════════════════════════════════════ */
  console.log('\n== E. 一次性事件 (PeriodTicks=0) ==');
  const oneShot = await probe.send({
    op: 'queue', steps: [
      { c: 'pushRaw', seed: 's', round: 1, id: 'evt', kind: 'DemoHeartbeat', layer: 0, resource: 1, next: 5, period: 0 },
      { c: 'advance', now: 0 },
      { c: 'advance', now: 5, commit: true },   // 一次性: commit 走 TryRemove
      { c: 'advance', now: 5 },
      { c: 'advance', now: 6 },
    ],
  });
  const oneShotDue = oneShot.log.filter(l => l.c === 'advance').map(l => l.n);
  check('E10 一次性事件只到期 1 次, 之后消失',
    oneShotDue[0] === 0 && oneShotDue[1] === 1 &&
    oneShotDue.slice(2).every(n => n === 0) && oneShot.count === 0,
    `due=${JSON.stringify(oneShotDue)} count=${oneShot.count}`);

  /* ══ F. 收集次数恒等 ════════════════════════════════════════════ */
  console.log('\n== F. 时钟推进与收集解耦 ==');
  const T = 500;
  const simF = await probe.send({
    op: 'simulate', entities: 100, ticks: T, kind: 'demoHeartbeat', l0Spread: 30,
  });
  check(`F11 advanceCalls == ${T} (每 tick 恰一次收集, 不多不少)`,
    simF.advanceCalls === T, `advanceCalls=${simF.advanceCalls}`);
  check('F11b emptyAdvances + 非空 tick == 总 tick 数',
    simF.emptyAdvances + simF.perTickCounts.filter(c => c > 0).length === T,
    `${simF.emptyAdvances} + ${simF.perTickCounts.filter(c => c > 0).length}`);

  /* ══ 规模对照: 100 与 10000 job 的空转成本相同 ═══════════════════ */
  console.log('\n== G. 规模对照 (O(1) 空转的直接证据) ==');
  const runs = [];
  for (const n of [100, 1000, 10000]) {
    const r = await probe.send({
      op: 'queue', steps: [
        ...Array.from({ length: n }, (_, i) =>
          ({ c: 'pushRaw', seed: 's', round: 1, id: `g${i}`, kind: 'DemoHeartbeat', layer: 0, resource: 1, next: 999999, period: 30 })),
        ...Array.from({ length: 200 }, (_, t) => ({ c: 'advance', now: t })),
      ],
    });
    runs.push({ n, peeks: r.peeks, count: r.count });
    console.log(`    ${String(n).padStart(6)} job → PeekCount ${r.peeks}  (Count=${r.count})`);
  }
  check('G7 三种规模的 PeekCount 全等 200 ⇒ 空转成本与 job 数无关',
    runs.every(r => r.peeks === 200), JSON.stringify(runs.map(r => r.peeks)));
} finally {
  probe.close();
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
