/* ============================================================
 * check_tick_job_persist.mjs — TickJob 落库 ↔ 载入 恒等契约
 * ------------------------------------------------------------
 * 需求 (用户第二轮原话):
 *   「lazy nextTick 要在数据库里面维护一张表，计算实体 id 事件 和 nexttick
 *     防止重启后全部重新算一遍」
 *
 * ⇒ 契约 = **重启后拿到的东西必须和重启前一模一样**:
 *   ① 字段逐字节一致 (NextTick/PeriodTicks/Phase/LastRunTick/FailCount/Enabled/Layer/Resource/Kind)
 *   ② 幂等 (同一状态存两次 == 存一次; 不产生重复行)
 *   ③ 一次性事件插入即落库 (PeriodTicks=0, 不允许攒批 —— 攒批期间崩了它就没救了)
 *   ④ 丢行 = 最高危 (job 丢了 = 事件永久消失且**不报错**)
 *
 * ⚠ 判据宿主**直接引用生产工程** (verify/tickprobe → Server/Zongmen),
 *   不在 JS 侧重写一遍序列化逻辑 —— 参照系不能是被测规则自己。
 * ⚠ 「重启」必须用**全新 store 实例**载入: 同实例的 Load 只是缓存, 不算数。
 *
 * 用法: node verify/check_tick_job_persist.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

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

/* ══ 源码守卫 ══════════════════════════════════════════════════════
 * 有些契约是「文件里不许出现什么」，跑一次源码扫描最直接
 * (tickprobe 只暴露运行期行为，扫不到实现细节)。
 * ⚠ 扫描前必须**剥掉注释** —— 否则「注释里提了一句 kind.ToString() 是错的」
 *   会把守卫搞成假阳性（这正是本脚本第一版踩的坑）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* ... */
    .replace(/\/\/[^\n]*/g, '');           // // ...
}

function srcGuard(name, file, predicate, detail) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) { check(name, false, `缺少文件 ${file}`); return; }
  const src = stripComments(fs.readFileSync(p, 'utf8'));
  check(name, predicate(src), detail);
}

const probe = new Probe();
console.log('\n=== check_tick_job_persist：TickJob 落库 ↔ 载入 ===\n');

/* ── A. 逐字段往返一致 ─────────────────────────────────────────── */
console.log('A. 逐字段往返一致（落库 → 全新实例载入）');
const r1 = await probe.send({ op: 'jobStore', seed: 'rtseed', round: 3 });

check('A1 无字段不匹配', r1.ok, JSON.stringify(r1.mismatches));
check('A2 载入行数 == 写入行数', r1.loadedRows === r1.n, `${r1.loadedRows} vs ${r1.n}`);
check('A3 零脏行跳过', r1.skipped === 0, `skipped=${r1.skipped}`);
check('A4 表内行数 == job 数 + 1（多一个停用的）', r1.countAfterWrite === r1.n + 1,
  `${r1.countAfterWrite} vs ${r1.n}+1`);
check('A5 roundTrip 明细 4 条', r1.roundTrip.length === r1.n, `${r1.roundTrip.length}`);

/* 逐条核对「人为改过的那几个字段」确实穿过了数据库 */
const byId = Object.fromEntries(r1.roundTrip.map((x) => [x.id, x]));
check('A6 city_a.LastRunTick == 45（人为改过）', byId['city_a']?.lastRun === 45,
  `实际 ${byId['city_a']?.lastRun}`);
check('A7 city_a.Phase == 77（人为改过）', byId['city_a']?.phase === 77,
  `实际 ${byId['city_a']?.phase}`);
check('A8 city_b.FailCount == 3（人为改过）', byId['city_b']?.fails === 3,
  `实际 ${byId['city_b']?.fails}`);
check('A9 载入的 job 全部 Enabled=true', r1.roundTrip.every((x) => x.enabled === true));
check('A10 demo_0_0.Kind 是线上名 demoHeartbeat',
  byId['demo_0_0']?.kind === 'demoHeartbeat', `实际 ${byId['demo_0_0']?.kind}`);
check('A11 city_a.Kind 是线上名 townEvolve',
  byId['city_a']?.kind === 'townEvolve', `实际 ${byId['city_a']?.kind}`);
check('A12 每行 PeriodTicks > 0（非一次性）',
  r1.roundTrip.every((x) => x.period > 0));
check('A13 Enabled=0 的 job 不进载入结果（SQL 过滤，正确行为）',
  r1.disabledFiltered === true);

/* ── B. 幂等 ───────────────────────────────────────────────────── */
console.log('\nB. 幂等（同一状态存两次 == 存一次）');
check('B1 无脏行时 Flush 返回 0', r1.idempotentRows === 0, `实际 ${r1.idempotentRows}`);
check('B2 再载入行数不变', r1.reloadedCount === r1.n, `${r1.reloadedCount} vs ${r1.n}`);

/* ── C. 一次性事件 ─────────────────────────────────────────────── */
console.log('\nC. 一次性事件（PeriodTicks=0）插入即落库');
check('C1 插入后表内行数增加', r1.oneShotPersisted === true);

/* ── D. 换 seed 互不干扰（键含 Seed/Round）─────────────────────── */
console.log('\nD. 键含 (Seed,Round)：换世不串行');
const r2 = await probe.send({ op: 'jobStore', seed: 'otherseed', round: 1 });
check('D1 另一世独立往返成功', r2.ok, JSON.stringify(r2.mismatches));
check('D2 另一世行数 == 4', r2.loadedRows === 4, `${r2.loadedRows}`);
check('D3 另一世表内计数独立 == 5（4 + 1 停用）', r2.countAfterWrite === 5, `${r2.countAfterWrite}`);

/* ── E. 重复跑同一参数（不同临时库）结果稳定 ───────────────────── */
console.log('\nE. 重复执行稳定（无隐藏时序依赖）');
const r3 = await probe.send({ op: 'jobStore', seed: 'rtseed', round: 3 });
check('E1 两次结果一致（ok/行数/明细）',
  r3.ok === r1.ok && r3.loadedRows === r1.loadedRows &&
  JSON.stringify(r3.roundTrip) === JSON.stringify(r1.roundTrip));

/* ══ F. 源码守卫 ═══════════════════════════════════════════════════ */
console.log('\nF. 源码守卫（实现纪律）');

srcGuard('F1 TickJobStore 用独立表 TickJob（不进 Data(Key,Value)）',
  'Server/Zongmen/Time/TickJobStore.cs',
  (s) => /CREATE TABLE IF NOT EXISTS TickJob/.test(s),
  '必须建独立表 —— PruneExcept 会静默删 Data 表的非活跃 seed 前缀');

srcGuard('F2 Flush 走单事务批量 UPSERT',
  'Server/Zongmen/Time/TickJobStore.cs',
  (s) => /BeginTransaction\s*\(\)/.test(s) && /ON CONFLICT\s*\(/.test(s),
  '一次事务 + UPSERT：避免逐行 fsync 放大');

srcGuard('F3 UPSERT 刻意不更新 Phase（否则相位抖动被推平）',
  'Server/Zongmen/Time/TickJobStore.cs',
  (s) => {
    const m = s.match(/ON CONFLICT[\s\S]{0,900}?;/);
    return m ? !/Phase\s*=\s*excluded\.Phase/.test(m[0]) : false;
  },
  'DO UPDATE SET 里不能有 Phase=excluded.Phase');

srcGuard('F4 落库前把吊销哨兵换成 RevokedTick-1（不把 long.MaxValue 写进库）',
  'Server/Zongmen/Time/TickJobStore.cs',
  (s) => /RevokedTick\s*\?\s*j\.NextTick\s*-\s*1\s*:\s*j\.NextTick/.test(s),
  '哨兵是「在途」的运行时标记，持久化时必须是可读的确定值');

srcGuard('F5 相位钥匙用线上名（KindNames.Of），绝不用 kind.ToString()',
  'Server/Zongmen/Time/TickJobRegistry.cs',
  (s) => /KindNames\.Of\s*\(\s*kind\s*\)/.test(s) && !/kind\.ToString\s*\(\s*\)/.test(s),
  '落库存线上名 ⇒ 对账/重建必须用同一把钥匙，否则相位静默漂移');

srcGuard('F6 CommitSuccess 复位哨兵并严格 += Period',
  'Server/Zongmen/Time/TickScheduler.cs',
  (s) => /job\.NextTick\s*=\s*nowTick\s*\+\s*job\.PeriodTicks/.test(s),
  '漏了这句 ⇒ long.MaxValue + Period 溢出成负数 ⇒ 相位错乱且不报错');

srcGuard('F7 Load 只取 Enabled=1（停用的 job 不该被重新调度）',
  'Server/Zongmen/Time/TickJobStore.cs',
  (s) => /WHERE\s+Seed=\$s\s+AND\s+Round=\$r\s+AND\s+Enabled=1/.test(s),
  '缺了这个过滤 ⇒ 已停用的失败 job 重启后复活，无限重试');

probe.close();

console.log(`\n${failures === 0 ? '全部通过 ✔' : `失败 ${failures} 项 ✘`}\n`);
process.exit(failures === 0 ? 0 : 1);
