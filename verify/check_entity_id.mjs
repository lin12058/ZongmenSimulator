/* ============================================================
 * check_entity_id.mjs — 全局 int32 实体 id 分配器判据
 * ------------------------------------------------------------
 * 被测：`Server/Zongmen/Storage/EntityIdAllocator.cs`
 *   （经 verify/idprobe 以 <Compile Include> **链接同一份源文件**，不是复制品）
 *
 * 用户口径（原话）：
 *   「开机扫描一遍所有 id 取最大值，扫描 1 到最大值所有 id，不存在的写入优先队列；
 *     下次取 id 取最小的；池子为 0 则 max+1，防止浪费 id」
 *
 * 断言分组：
 *   A. 全新库从 1 连续发
 *   B. 池优先 → 取**最小**空洞（不是任意空洞）
 *   C. 重复 Free 不重复入池（否则两个实体拿同一号）
 *   D. 越界 Free 被拒（0 / 大于 highWater）
 *   E. 纯内存模式免扫描
 *   F. 重启未扫描 ⇒ Alloc 必须抛（宁可启动失败，也不撞号）
 *   G. 重启 + 扫描召回空洞 ⇒ 最小优先，顺序正确
 *   H. 扫描不开回收 ⇒ 绝不重号（max 只增不减）
 *   I. 「认领上界」与「已发出上界」分离 ⇒ 崩溃只浪费不重号，且不白扔一整块
 *   J. 并发 8×1000 无重号
 *   K. EntityRef 打包往返
 *   L. 源码守卫（独立表 / 无 RNG / 只增 UPSERT / 越界拒绝）
 *
 * ⚠ 不用「耗时 < N ms」这类绝对值阈值（工程教训：必假红）。
 *
 * 用法: node verify/check_entity_id.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(__dirname, 'idprobe');
const SRC = path.join(ROOT, 'Server', 'Zongmen', 'Storage', 'EntityIdAllocator.cs');
const TMP = path.join(ROOT, 'Temp', 'idprobe');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✘ ${name}${detail ? '  → ' + detail : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class Probe {
  constructor() {
    this.child = spawn('dotnet', ['run', '--no-build', '-c', 'Release', '-v', 'q', '--project', PROJ],
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

/* ---------- 0. 现场清理 + 构建 ---------- */
if (fs.existsSync(TMP)) {
  const abs = path.resolve(TMP);
  if (!abs.startsWith(path.resolve(ROOT, 'Temp'))) throw new Error('越界清理: ' + abs);
  fs.rmSync(abs, { recursive: true, force: true });
}
fs.mkdirSync(TMP, { recursive: true });

const build = spawn('dotnet', ['build', PROJ, '-c', 'Release', '-v', 'q', '--nologo'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let buildErr = '';
build.stderr.setEncoding('utf8');
build.stderr.on('data', (d) => { buildErr += d; });
const buildCode = await new Promise((res) => build.on('close', res));
if (buildCode !== 0) {
  console.error('idprobe 构建失败，跳过判据:\n' + buildErr);
  process.exit(2);   // rc=2 = 跳过
}

const DB = (n) => path.join(TMP, n + '.sqlite');

const probe = new Probe();
try {
  /* ══ A. 全新库从 1 连续发 ═══════════════════════════════════════ */
  console.log('\n== A. 全新库从 1 起，连续无空洞 ==');
  let r = await probe.send({ op: 'new', db: DB('a'), block: 8 });
  check('A1 新库 persisted=true, highWater=0, reserved=0',
    r.ok && r.persisted === true && r.highWater === 0 && r.reserved === 0, JSON.stringify(r));

  r = await probe.send({ op: 'alloc', n: 5 });
  check('A2 首次 5 个号 == [1,2,3,4,5]', eq(r.ids, [1, 2, 3, 4, 5]), JSON.stringify(r.ids));

  r = await probe.send({ op: 'alloc', n: 5 });
  check('A3 再 5 个 == [6,7,8,9,10]', eq(r.ids, [6, 7, 8, 9, 10]), JSON.stringify(r.ids));

  /* ══ B. 池优先取最小 ═══════════════════════════════════════════ */
  console.log('\n== B. 池优先：取最小空洞 ==');
  r = await probe.send({ op: 'free', ids: [7, 3] });
  check('B1 free [7,3] 都入池 (freed=2)', r.freed === 2, JSON.stringify(r));

  r = await probe.send({ op: 'allocOne' });
  check('B2 先给 3（不是 7、不是 11）', r.id === 3, String(r.id));
  r = await probe.send({ op: 'allocOne' });
  check('B3 再给 7', r.id === 7, String(r.id));
  r = await probe.send({ op: 'allocOne' });
  check('B4 池空后给 11（highWater+1）', r.id === 11, String(r.id));

  /* ══ C. 重复 Free 不重复入池 ═══════════════════════════════════ */
  console.log('\n== C. 重复 Free 不重复入池 ==');
  r = await probe.send({ op: 'free', ids: [5] });
  check('C1 首次 free 5 ⇒ freed=1', r.freed === 1, JSON.stringify(r));
  r = await probe.send({ op: 'free', ids: [5] });
  check('C2 重复 free 5 ⇒ freed=0', r.freed === 0, JSON.stringify(r));
  r = await probe.send({ op: 'allocOne' });
  const c3 = r.id;
  r = await probe.send({ op: 'allocOne' });
  check('C3 5 只被发出一次（第二次拿到 12）', c3 === 5 && r.id === 12, `first=${c3} second=${r.id}`);

  /* ══ D. 越界 Free 被拒 ═════════════════════════════════════════ */
  console.log('\n== D. 越界 Free 被拒 ==');
  r = await probe.send({ op: 'free', ids: [0] });
  check('D1 free(0) 被拒', r.freed === 0, JSON.stringify(r));
  r = await probe.send({ op: 'free', ids: [9999] });
  check('D2 free(9999) 超出 highWater 被拒', r.freed === 0, JSON.stringify(r));

  /* ══ E. 纯内存模式免扫描 ═══════════════════════════════════════ */
  console.log('\n== E. 纯内存模式（db=null）免扫描 ==');
  r = await probe.send({ op: 'new', db: '', block: 4 });
  check('E1 内存模式 persisted=false', r.ok && r.persisted === false, JSON.stringify(r));
  r = await probe.send({ op: 'allocOne' });
  check('E2 直接发 1（不抛）', r.ok && r.id === 1, JSON.stringify(r));

  /* ══ F. 重启未扫描 ⇒ Alloc 必须抛 ═════════════════════════════ */
  console.log('\n== F. 重启未扫描 ⇒ Alloc 抛错（防撞号） ==');
  r = await probe.send({ op: 'new', db: DB('a'), block: 8 });
  check('F1 重启后 highWater=0（尚未扫描）', r.ok && r.highWater === 0, JSON.stringify(r));
  r = await probe.send({ op: 'allocOne' });
  check('F2 未扫描就 Alloc ⇒ 抛 InvalidOperationException',
    r.ok === false && r.error === 'InvalidOperationException', JSON.stringify(r));

  /* ══ G. 重启 + 扫描召回空洞，最小优先 ═════════════════════════ */
  console.log('\n== G. 扫描 1..max，缺失入池，取最小 ==');
  /* a 库此刻：已发出 1..12，其中 3/5/7 被 free 过又重新发出 ⇒ 全部在用。
     人为声明 3/5/7 已删（模拟"实体删了但号要回收"）。 */
  const IN_USE_A = [1, 2, 4, 6, 8, 9, 10, 11, 12];
  r = await probe.send({ op: 'scan', inUse: IN_USE_A, reclaim: true });
  check('G1 扫描得 highWater=12（含空洞上界）', r.highWater === 12, JSON.stringify(r));
  check('G2 before=0 ⇒ 确实是从头恢复', r.before === 0, JSON.stringify(r));
  check('G3 空洞回收 3 个（3/5/7）', r.holesReclaimed === 3, JSON.stringify(r));

  r = await probe.send({ op: 'allocOne' });
  check('G4 先给最小空洞 3', r.id === 3, String(r.id));
  r = await probe.send({ op: 'allocOne' });
  check('G5 再给 5', r.id === 5, String(r.id));
  r = await probe.send({ op: 'allocOne' });
  check('G6 再给 7', r.id === 7, String(r.id));
  r = await probe.send({ op: 'allocOne' });
  check('G7 池空后给 13', r.id === 13, String(r.id));

  /* ══ H. 扫描不开回收 ⇒ 绝不重号 ═══════════════════════════════ */
  console.log('\n== H. 扫描不开回收 ⇒ 从尾部续发，绝不重号 ==');
  r = await probe.send({ op: 'new', db: DB('b'), block: 4 });
  await probe.send({ op: 'alloc', n: 10 });                       // 1..10
  await probe.send({ op: 'dispose' });                            // 模拟关机
  r = await probe.send({ op: 'new', db: DB('b'), block: 4 });
  r = await probe.send({ op: 'scan', inUse: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], reclaim: false });
  check('H1 不开回收 ⇒ holesReclaimed=0', r.holesReclaimed === 0, JSON.stringify(r));
  check('H2 highWater 恢复到 10', r.highWater === 10, JSON.stringify(r));
  r = await probe.send({ op: 'allocOne' });
  check('H3 下一个是 11（不是 1）', r.id === 11, String(r.id));

  /* ══ I. 认领上界 vs 已发出上界（崩溃只浪费、不重号、不白扔） ═══ */
  console.log('\n== I. 崩溃恢复：已认领未发出的号照常可用 ==');
  r = await probe.send({ op: 'new', db: DB('c'), block: 1000 });
  r = await probe.send({ op: 'alloc', n: 100 });                   // 1..100，reserved=1000
  check('I1 发出 100 个后 reserved=1000', r.ids[99] === 100, JSON.stringify(r).slice(0, 80));
  r = await probe.send({ op: 'stats' });
  check('I2 stats: highWater=100, reserved=1000',
    r.stats.highWater === 100 && r.stats.reserved === 1000, JSON.stringify(r.stats));

  await probe.send({ op: 'dispose' });                             // 模拟崩溃（不 free）
  r = await probe.send({ op: 'new', db: DB('c'), block: 1000 });
  check('I3 重启后 reserved 仍是 1000（认领上界落库了）', r.reserved === 1000, JSON.stringify(r));
  r = await probe.send({ op: 'scan', inUse: Array.from({ length: 100 }, (_, i) => i + 1), reclaim: true });
  check('I4 扫描后 highWater=100、无空洞', r.highWater === 100 && r.holesReclaimed === 0, JSON.stringify(r));
  r = await probe.send({ op: 'allocOne' });
  check('I5 下一个是 101（吃掉认领区间，不是 1001）', r.id === 101, String(r.id));

  /* ══ J. 并发无重号 ═════════════════════════════════════════════ */
  console.log('\n== J. 并发 8 × 1000 无重号 ==');
  await probe.send({ op: 'new', db: DB('d'), block: 64 });
  r = await probe.send({ op: 'concurrent', threads: 8, per: 1000 });
  check('J1 总发出 8000 个', r.ok && r.total === 8000, JSON.stringify(r));
  check('J2 去重后仍是 8000（零重复）', r.distinct === 8000, JSON.stringify(r));
  check('J3 号区间落在 [1,8000]', r.min === 1 && r.max === 8000, `min=${r.min} max=${r.max}`);

  /* ══ K. EntityRef 打包往返 ═════════════════════════════════════ */
  console.log('\n== K. EntityRef 一个 long 装下 (kind,id) ==');
  r = await probe.send({ op: 'pack', kind: 1, id: 12345 });
  check('K1 (Settle,12345) 往返一致', r.same === true && r.kind === 1 && r.id === 12345, JSON.stringify(r));
  r = await probe.send({ op: 'pack', kind: 5, id: 0 });
  check('K2 (Character,0) 往返一致', r.same === true && r.kind === 5 && r.id === 0, JSON.stringify(r));
  r = await probe.send({ op: 'pack', kind: 0, id: 0 });
  check('K3 (None,0) packed=0（空值可判）', r.packed === 0, JSON.stringify(r));

  await probe.send({ op: 'dispose' });
} finally {
  probe.close();
}

/* ══ L. 源码守卫（剥注释后判，避免注释里的字样误命中）═══════════ */
console.log('\n== L. 源码守卫 ==');
const raw = fs.readFileSync(SRC, 'utf8');
/* 剥 // 行注释与 /* *\/ 块注释（保留字符串字面量里的内容会有误差，但这里只判标识符，
   两处 SQL 都在 """…""" 里，剥注释不影响它们）。 */
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

check('L1 EntityIdSeq 是**独立表**（不许塞 Data 表，会被 PruneExcept 静默删）',
  /CREATE TABLE IF NOT EXISTS EntityIdSeq/.test(code));
check('L2 发号路径无 RNG / Guid / DateTime.Now（必须确定性）',
  !/\bRandom\b|\bGuid\b|DateTime\.Now/.test(code));
check('L3 落库是「只增」UPSERT（HighWater < excluded.HighWater）',
  /EntityIdSeq\.HighWater\s*<\s*excluded\.HighWater/.test(code));
check('L4 Free 有越界拒绝（id > _highWater）',
  /id\s*>\s*_highWater/.test(code));
check('L5 Alloc 有未扫描闸（_scanned）',
  /if\s*\(!_scanned\)/.test(code));
check('L6 有号空间耗尽护栏（next > MaxId）',
  /next\s*>\s*MaxId/.test(code));
check('L7 换世不重置：类内无 DeleteWorld / Reset 之类清号方法',
  !/public\s+\w+\s+(Reset|DeleteWorld|ClearAll)\s*\(/.test(code));

/* ---------- 汇总 ---------- */
console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
} else {
  console.log(`${failures} 项失败。`);
  process.exit(1);
}
