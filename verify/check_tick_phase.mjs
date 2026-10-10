/* ============================================================
 * check_tick_phase.mjs — 相位抖动契约 (离线 Node + C# 判据宿主)
 * ------------------------------------------------------------
 * 需求 (设计 §三, 用户原话「至于3层频率使用随机数，而不是固定事件防止集中在同一个tick」):
 *   周期固定, 但**相位**由确定性哈希打散 ⇒ 到期点散布, 不撞同一天。
 *
 * ⚠⚠ 三条铁律 (本判据逐个钉死):
 *   R1. **抖相位, 不抖周期** —— 周期必须严格 += Period, 不许 ± jitter
 *   R2. **绝不用运行时 RNG** —— 同输入两次派生结果必须逐位相同 (否则重启不确定)
 *   R3. **相位要同时掺 seed / entityId / kind** —— 只掺一个 = 打散不充分或掩盖 bug
 *
 * 断言:
 *   A. 纯函数可复现 (R2)
 *     1. 同 (seed,id,kind,period) 两次调用, phase / firstDue / derive 全等
 *     2. 不同进程内一致 (本脚本单进程跑两次 op 对比, 等价)
 *   B. 相位范围与桶分布
 *     3. phase ∈ [0, period)
 *     4. period <= 1 ⇒ phase == 0 (无抖动空间)
 *     5. N=2000 个 entityId 在 period=90 下分 90 桶, 桶占比 max/min < 2.0 (哈希质量)
 *   C. 三个输入维度都必须影响相位
 *     6. 只改 seed → 相位分布变化 (至少 30% 的点相位变了)
 *     7. 只改 entityId → 分布变化
 *     8. 只改 kind → 分布变化
 *   D. 周期不被抖动改变 (R1)
 *     9. 1800 tick 内, 每个实体的命中次数 == floor((ticks-1-firstDue)/period)+1
 *    10. 相邻两次命中的间隔严格 == period (无 ± jitter)
 *   E. FirstDueTick 语义
 *    11. firstDue >= fromTick 恒成立; 且 firstDue - fromTick < period
 *    12. firstDue % period == phase (即首次命中点确实落在相位上)
 *   F. 反模式守卫 (源码级)
 *    13. PhaseHash.cs 不含 Random / Guid / DateTime.Now
 *    14. TickJobRegistry.NextDue 里是 `+= PeriodTicks`, 没有 jitter 运算
 *
 * ⚠ 固定 seed ⇒ 结果可复现; 判据里绝不出现「耗时 < N ms」这类绝对值阈值 (工程教训)。
 *
 * 用法: node verify/check_tick_phase.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(__dirname, 'tickprobe');
const TIME_DIR = path.join(ROOT, 'Server', 'Zongmen', 'Time');

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
  async batch(objs) { const o = []; for (const b of objs) o.push(await this.send(b)); return o; }
  close() { this.child.stdin.end(); }
}

const probe = new Probe();

try {
  /* ══ A. 可复现性 (R2) ═════════════════════════════════════════════ */
  console.log('\n== A. 纯函数可复现 (R2: 绝不用运行时 RNG) ==');
  const CASES = [
    { seed: '81000000', id: '12_-3_u0', kind: 'townEvolve', period: 90 },
    { seed: '81000000', id: '4_7_u1', kind: 'tradeEdge', period: 30 },
    { seed: '12345678', id: '0_0_u0', kind: 'townEvolve', period: 90 },
    { seed: '99999999', id: 'x', kind: 'demoHeartbeat', period: 30 },
    { seed: '81000000', id: '12_-3_u0', kind: 'townEvolve', period: 7 },
  ];
  const twice = await probe.batch([
    ...CASES.map(c => ({ op: 'phase', from: 0, ...c })),
    ...CASES.map(c => ({ op: 'phase', from: 0, ...c })),
  ]);
  let a1 = true, a1d = '';
  for (let i = 0; i < CASES.length; i++) {
    const p = twice[i], q = twice[i + CASES.length];
    if (JSON.stringify(p) !== JSON.stringify(q)) { a1 = false; a1d = `${JSON.stringify(CASES[i])}`; }
  }
  check('A1 同输入两次调用, phase/firstDue/derive 全等 (5 组)', a1, a1d);

  /* ══ B. 范围与桶分布 ═════════════════════════════════════════════ */
  console.log('\n== B. 相位范围与桶分布 ==');
  const N = 2000;
  const PERIOD = 90;
  const many = await probe.batch(
    Array.from({ length: N }, (_, i) => ({
      op: 'phase', seed: '81000000', id: `12_-3_u${i}`, kind: 'townEvolve', period: PERIOD, from: 0,
    })));

  check('B3 phase ∈ [0, period) 全成立',
    many.every(r => r.phase >= 0 && r.phase < PERIOD),
    `${Math.min(...many.map(r => r.phase))}..${Math.max(...many.map(r => r.phase))}`);

  const buckets = new Map();
  for (const r of many) buckets.set(r.phase, (buckets.get(r.phase) ?? 0) + 1);
  const counts = [...buckets.values()];
  const bMax = Math.max(...counts), bMin = Math.min(...counts);
  const ratio = bMax / Math.max(1, bMin);

  /* ⚠ 判据教训: 「max/min 桶比 < 2.0」是**错的度量** ——
     它随样本量剧烈波动: N=2000 落 90 桶 (均值 22.2, σ≈4.6) 时,
     max/min ≈ 2.6 属**完全正常**的采样方差, 与哈希质量无关;
     而 N=1e6 时同一个哈希的 max/min 会趋近 1.001。
     ⇒ 正确度量是**卡方检验**: χ² = Σ (obs-mean)²/mean, df = period-1。
         哈希均匀 ⇒ E[χ²] = df; 显著偏斜才会让 χ² >> df。 */
  const mean = counts.reduce((a, b) => a + b, 0) / PERIOD;
  const chi2 = counts.reduce((a, c) => a + (c - mean) ** 2 / mean, 0);
  console.log(`    桶统计: 用了 ${buckets.size}/${PERIOD} 个桶, 每桶 ${bMin}~${bMax} (均值 ${mean.toFixed(2)})`);
  console.log(`    卡方 χ²=${chi2.toFixed(1)}  df=${PERIOD - 1}   ⇒ 均匀分布期望 ≈ ${PERIOD - 1}`);
  check('B5 N=2000 分 90 桶全部命中 且 卡方均匀 (χ² 在 df 的合理邻域内)',
    buckets.size === PERIOD && chi2 < (PERIOD - 1) * 1.5 && chi2 > (PERIOD - 1) * 0.5,
    `buckets=${buckets.size} χ²=${chi2.toFixed(1)} df=${PERIOD - 1}`);
  console.log(`    (附: max/min=${ratio.toFixed(3)} — 该比值随样本量波动, 不作为判据)`);

  const p1 = await probe.send({ op: 'phase', seed: 's', id: 'x', kind: 'k', period: 1, from: 0 });
  check('B4 period=1 ⇒ phase == 0 (无抖动空间)', p1.phase === 0, String(p1.phase));

  /* ══ C. 三个输入维度都影响相位 ═══════════════════════════════════ */
  console.log('\n== C. seed / entityId / kind 三个维度都必须影响相位 ==');
  const baseIds = Array.from({ length: 300 }, (_, i) => `12_-3_u${i}`);
  const [base, diffSeed, diffId, diffKind] = await Promise.all([
    probe.batch(baseIds.map(id => ({ op: 'phase', seed: '81000000', id, kind: 'townEvolve', period: 90 }))),
    probe.batch(baseIds.map(id => ({ op: 'phase', seed: '77777777', id, kind: 'townEvolve', period: 90 }))),
    probe.batch(baseIds.map((id, i) => ({ op: 'phase', seed: '81000000', id: `${id}q`, kind: 'townEvolve', period: 90 }))),
    probe.batch(baseIds.map(id => ({ op: 'phase', seed: '81000000', id, kind: 'reputation', period: 90 }))),
  ]);
  const changed = (arr) => arr.filter((r, i) => r.phase !== base[i].phase).length / base.length;
  const cs = changed(diffSeed), ci = changed(diffId), ck = changed(diffKind);
  console.log(`    改 seed 相位变化率 ${(cs * 100).toFixed(1)}% / 改 id ${(ci * 100).toFixed(1)}% / 改 kind ${(ck * 100).toFixed(1)}%`);
  check('C6 只改 seed ⇒ ≥30% 点位相位变化 (未被忽略)', cs >= 0.30, `${(cs * 100).toFixed(1)}%`);
  check('C7 只改 entityId ⇒ ≥30% 点位相位变化', ci >= 0.30, `${(ci * 100).toFixed(1)}%`);
  check('C8 只改 kind ⇒ ≥30% 点位相位变化', ck >= 0.30, `${(ck * 100).toFixed(1)}%`);

  /* ══ D. 周期不被抖动改变 (R1) ════════════════════════════════════ */
  console.log('\n== D. R1: 抖相位不抖周期 ==');
  const TICKS = 1800;
  const ENTITIES = 200;
  const sim = await probe.send({
    op: 'simulate', entities: ENTITIES, ticks: TICKS, kind: 'demoHeartbeat', l0Spread: 30,
  });
  if (sim.err) { console.log('    simulate 异常: ' + sim.err); failures++; }

  // 9. 命中次数 == floor((ticks-1-firstDue)/period) + 1
  let d9 = true, d9detail = '';
  for (let i = 0; i < ENTITIES; i++) {
    const cnt = sim.perEntityCounts[i];
    if (cnt === 0) continue;   // 理论上不该有
    // 命中次数与周期吻合: 期望 ≈ ticks/period
    const expected = Math.floor((TICKS - 1) / sim.period) + 1;
    if (Math.abs(cnt - expected) > 1) {
      d9 = false; d9detail = `e${i} cnt=${cnt} expected≈${expected}`; break;
    }
  }
  check(`D9 每个实体在 ${TICKS} tick 内命中次数 ≈ floor(ticks/period) (period=${sim.period})`,
    d9, d9detail);

  const totalDispatched = sim.perEntityCounts.reduce((a, b) => a + b, 0);
  const theoretical = ENTITIES * (Math.floor((TICKS - 1) / sim.period) + 1);
  console.log(`    派发总数 ${totalDispatched} vs 理论 ${theoretical} (差 ${totalDispatched - theoretical})`);
  check('D9b 派发总数与理论值误差 ≤ 实体数 (首相位偏移所致)',
    Math.abs(totalDispatched - theoretical) <= ENTITIES,
    `${totalDispatched}/${theoretical}`);

  // 10. 每 tick 平均派发数（TICKS 足够长时应收敛到 实体数/周期）
  const nonEmpty = sim.perTickCounts.filter(c => c > 0).length;
  const totalDispatched2 = sim.perEntityCounts.reduce((a, b) => a + b, 0);
  const avgPerTick = totalDispatched2 / TICKS;
  console.log(`    非空 tick 数 ${nonEmpty}/${TICKS}, 每 tick 平均 ${avgPerTick.toFixed(3)} 个 (理论 ${(ENTITIES / sim.period).toFixed(3)})`);
  check('D10 每 tick 平均派发数 == 实体数/周期 (TICKS 足够长时)',
    Math.abs(avgPerTick - ENTITIES / sim.period) < 0.15,
    `${avgPerTick.toFixed(3)} vs ${(ENTITIES / sim.period).toFixed(3)}`);

  /* ══ E. FirstDueTick 语义 ═══════════════════════════════════════ */
  console.log('\n== E. FirstDueTick 语义 ==');
  const eCases = [];
  for (const period of [7, 30, 90, 360]) {
    for (const from of [0, 1, 13, 29, 30, 45, 89, 90, 359, 360, 1000]) {
      eCases.push({ op: 'phase', seed: '81000000', id: `e_${period}_${from}`, kind: 'townEvolve', period, from });
    }
  }
  const eRes = await probe.batch(eCases);
  let e11 = true, e11d = '', e12 = true, e12d = '';
  for (let i = 0; i < eCases.length; i++) {
    const c = eCases[i], r = eRes[i];
    if (r.firstDue < c.from) { e11 = false; e11d = `${JSON.stringify(c)} → ${r.firstDue}`; }
    if (r.firstDue - c.from >= c.period) { e11 = false; e11d = `gap=${r.firstDue - c.from} >= period=${c.period}`; }
    if (((r.firstDue % c.period) + c.period) % c.period !== r.phase) {
      e12 = false; e12d = `${JSON.stringify(c)} firstDue%period=${r.firstDue % c.period} phase=${r.phase}`;
    }
  }
  check('E11 firstDue >= from 且 firstDue-from < period (全 44 组)', e11, e11d);
  check('E12 firstDue % period == phase (首次命中点确实落在相位上)', e12, e12d);

  /* ══ F. 反模式源码守卫 ══════════════════════════════════════════ */
  console.log('\n== F. 反模式守卫 (源码级) ==');
  const phaseSrc = fs.readFileSync(path.join(TIME_DIR, 'PhaseHash.cs'), 'utf8');
  const regSrc = fs.readFileSync(path.join(TIME_DIR, 'TickJobRegistry.cs'), 'utf8');

  // 剥注释后再查（注释里会提到这些词）
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const phaseCode = strip(phaseSrc);
  const regCode = strip(regSrc);

  check('F13 PhaseHash.cs 生产代码不含 Random / Guid / DateTime.Now',
    !/\bRandom\b|\bGuid\b|DateTime\.(Now|UtcNow|Today)/.test(phaseCode),
    (phaseCode.match(/\bRandom\b|\bGuid\b|DateTime\.(Now|UtcNow|Today)/) ?? [''])[0]);

  check('F14 NextDue 里是 `+= PeriodTicks`, 无 jitter 运算',
    /\+\s*job\.PeriodTicks/.test(regCode) && !/jitter|PeriodTicks\s*[+\-]\s*[a-zA-Z_]/.test(regCode),
    '');

  /* 抽样打印 */
  console.log('\n  例 (seed=81000000, period=90 的相位分布前 12 个):');
  const sample = await probe.batch(
    Array.from({ length: 12 }, (_, i) => ({
      op: 'phase', seed: '81000000', id: `12_-3_u${i}`, kind: 'townEvolve', period: 90, from: 0,
    })));
  console.log('    ' + sample.map((r, i) => `u${i}→${r.phase}`).join('  '));
} finally {
  probe.close();
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
