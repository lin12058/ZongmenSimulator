/* ============================================================
 * check_clock.mjs — 时间模型恒等契约 (离线 Node + C# 判据宿主)
 * ------------------------------------------------------------
 * 需求 (设计 §1.1, 用户原话「1Tick对应游戏里面的一天，360天，一个月30天分为春夏秋冬」):
 *   1 tick = 1 日; 30 日 = 1 月; 12 月 = 1 年 = 360 日; 90 日 = 1 季 (春夏秋冬)
 *
 * ⚠ 本判据的**关键设计**: 断言对象是**真实服务端代码**(GameClock.cs),
 *   经由 verify/tickprobe 宿主调用 —— 不在 JS 侧重写一遍公式。
 *   理由 = 工程既有教训「参照系不能是被测规则自己」。
 *
 * 断言:
 *   A. 常量钉死
 *     1. TicksPerDay=1 / DaysPerMonth=30 / MonthsPerYear=12 / TicksPerYear=360 / TicksPerSeason=90
 *     2. 四季名 = 春/夏/秋/冬; 月名 12 个
 *   B. 边界恒等 (设计 §十二 明文)
 *     3. tick=0   → 第 1 年 春 一月 一日
 *     4. tick=359 → 第 1 年 冬 十二月 三十日   ← ★ 年末最后一天
 *     5. tick=360 → 第 2 年 春 一月 一日        ← ★ 进位
 *   C. 全 360 值穷举自洽 (一周年的每一天)
 *     6. ToDate(t) 的 (year,month,day) 与 FromDate 互逆
 *     7. doy == (month-1)*30 + (day-1); season == floor(doy/90)
 *     8. 月内 day 恒 1..30; month 恒 1..12; season 恒 0..3
 *     9. 同一年内 doy 严格 0..359 且无重复
 *   D. 跨年穷举 (前 5 年)
 *    10. 每个 tick 的 year == floor(tick/360)+1
 *    11. 季节推进: 每年都恰好出现 4 个季节、四季各 90 天
 *   E. 对齐函数
 *    12. AlignToSeasonStart / AlignToMonthStart / AlignToYearStart 幂等且在 [t-89, t] 内
 *   F. 负 tick 防御 (不应崩、且归一化)
 *    13. tick=-1 不抛异常
 *
 * 用法: node verify/check_clock.mjs
 * ============================================================ */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(__dirname, 'tickprobe');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✘ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

/* ── 驱动 C# 判据宿主: 一次进程跑完所有 op ─────────────────────────── */
class Probe {
  constructor() {
    this.child = spawn('dotnet', ['run', '--no-build', '-v', 'q', '--project', PROJ], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.buf = '';
    this.waiters = [];
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
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      setTimeout(() => { if (this.waiters.length > 500) reject(new Error('probe timeout')); }, 60000);
    });
  }

  async batch(objs) {
    const out = [];
    for (const o of objs) out.push(await this.send(o));
    return out;
  }

  close() { this.child.stdin.end(); }
}

const SEASON_NAMES = ['春', '夏', '秋', '冬'];
const MONTH_NAMES = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];

const probe = new Probe();

try {
  /* ══ A. 常量 ══════════════════════════════════════════════════════ */
  console.log('\n== A. 常量钉死 ==');
  const K = await probe.send({ op: 'constants' });
  check('A1 TicksPerDay=1 / DaysPerMonth=30 / MonthsPerYear=12',
    K.ticksPerDay === 1 && K.daysPerMonth === 30 && K.monthsPerYear === 12,
    `${K.ticksPerDay}/${K.daysPerMonth}/${K.monthsPerYear}`);
  check('A2 TicksPerYear=360 / TicksPerSeason=90 / MsPerTick=1000',
    K.ticksPerYear === 360 && K.ticksPerSeason === 90 && K.msPerTick === 1000,
    `${K.ticksPerYear}/${K.ticksPerSeason}/${K.msPerTick}`);
  check('A3 四季名 = 春/夏/秋/冬', JSON.stringify(K.seasonNames) === JSON.stringify(SEASON_NAMES),
    JSON.stringify(K.seasonNames));
  check('A4 月名 12 个且与前端口径一致',
    K.monthNames.length === 12 && JSON.stringify(K.monthNames) === JSON.stringify(MONTH_NAMES),
    JSON.stringify(K.monthNames));
  check('A5 TicksPerYear == DaysPerMonth*MonthsPerYear == TicksPerSeason*4',
    K.ticksPerYear === K.daysPerMonth * K.monthsPerYear &&
    K.ticksPerYear === K.ticksPerSeason * 4, '');

  /* ══ B. 边界恒等 ══════════════════════════════════════════════════ */
  console.log('\n== B. 边界恒等 (设计 §十二 明文) ==');
  const [c0, c359, c360] = await probe.batch([
    { op: 'clock', tick: 0 },
    { op: 'clock', tick: 359 },
    { op: 'clock', tick: 360 },
  ]);

  check('B1 tick=0 → 第 1 年 春 一月 一日',
    c0.year === 1 && c0.month === 1 && c0.day === 1 && c0.season === 0,
    JSON.stringify(c0));

  check('B2 ★ tick=359 → 第 1 年 冬 十二月 三十日',
    c359.year === 1 && c359.month === 12 && c359.day === 30 && c359.season === 3 &&
    c359.seasonName === '冬' && c359.monthName === '十二月',
    JSON.stringify(c359));

  check('B3 ★ tick=360 → 第 2 年 春 一月 一日（进位）',
    c360.year === 2 && c360.month === 1 && c360.day === 1 && c360.season === 0,
    JSON.stringify(c360));

  check('B4 中文描述形如「第1年 冬 十二月 三十日」',
    c359.desc === '第1年 冬 十二月 三十日', c359.desc);

  /* ══ C. 全 360 值穷举自洽 ═══════════════════════════════════════ */
  console.log('\n== C. 第 1 年全 360 值穷举 ==');
  const clocks = await probe.batch(
    Array.from({ length: 360 }, (_, t) => ({ op: 'clock', tick: t })));

  let c6 = true, c7 = true, c8 = true, c9 = true, d6 = '', d7 = '', d8 = '', d9 = '';
  const doySeen = new Set();
  const fromDates = await probe.batch(
    clocks.map(c => ({ op: 'fromDate', year: c.year, month: c.month, day: c.day })));

  for (let t = 0; t < 360; t++) {
    const c = clocks[t];

    // 6. ToDate 与 FromDate 互逆
    if (fromDates[t].tick !== t) { c6 = false; d6 = `t=${t} → ${fromDates[t].tick}`; }

    // 7. doy / season 推导
    const doy = (c.month - 1) * 30 + (c.day - 1);
    if (c.dayOfYear !== doy || c.season !== Math.floor(doy / 90)) {
      c7 = false; d7 = `t=${t} doy=${c.dayOfYear}/${doy} season=${c.season}`;
    }

    // 8. 取值范围
    if (c.day < 1 || c.day > 30 || c.month < 1 || c.month > 12 || c.season < 0 || c.season > 3) {
      c8 = false; d8 = `t=${t} ${JSON.stringify(c)}`;
    }

    // 9. doy 无重复
    if (doySeen.has(c.dayOfYear)) { c9 = false; d9 = `t=${t} doy=${c.dayOfYear}`; }
    doySeen.add(c.dayOfYear);
  }

  check('C6 ToDate ↔ FromDate 全 360 值互逆', c6, d6);
  check('C7 doy == (month-1)*30+(day-1) 且 season == floor(doy/90)', c7, d7);
  check('C8 day∈1..30 / month∈1..12 / season∈0..3', c8, d8);
  check('C9 doy 无重复且覆盖 0..359', c9 && doySeen.size === 360, d9 + ` size=${doySeen.size}`);

  /* ══ D. 跨年穷举 (前 5 年 = 1800 tick) ═════════════════════════ */
  console.log('\n== D. 前 5 年 (1800 tick) 跨年穷举 ==');
  const multi = await probe.batch(
    Array.from({ length: 1800 }, (_, t) => ({ op: 'clock', tick: t })));

  let d10 = true, e10 = '';
  for (let t = 0; t < 1800; t++) {
    const expectedYear = Math.floor(t / 360) + 1;
    if (multi[t].year !== expectedYear) { d10 = false; e10 = `t=${t} year=${multi[t].year}/${expectedYear}`; break; }
  }
  check('D10 year == floor(tick/360)+1 (全 1800 值)', d10, e10);

  let d11 = true, e11 = '';
  for (let y = 0; y < 5; y++) {
    const slice = multi.slice(y * 360, (y + 1) * 360);
    for (let s = 0; s < 4; s++) {
      const seg = slice.slice(s * 90, (s + 1) * 90);
      if (!seg.every(c => c.season === s && c.year === y + 1)) {
        d11 = false; e11 = `year=${y + 1} season=${s}`;
      }
    }
  }
  check('D11 每年恰好 4 季 × 90 天 (5 年全验)', d11, e11);

  /* ══ E. 对齐函数 ════════════════════════════════════════════════ */
  console.log('\n== E. 对齐函数 ==');
  const sampleTicks = [0, 1, 29, 30, 89, 90, 179, 359, 360, 719, 1080, 1234];
  const aligns = await probe.batch(sampleTicks.map(t => ({ op: 'align', tick: t })));
  let e12 = true, e12d = '';
  for (let i = 0; i < sampleTicks.length; i++) {
    const t = sampleTicks[i], a = aligns[i];
    if (a.season > t || t - a.season >= 90) { e12 = false; e12d = `t=${t} season=${a.season}`; }
    if (a.month > t || t - a.month >= 30) { e12 = false; e12d = `t=${t} month=${a.month}`; }
    if (a.year > t || t - a.year >= 360) { e12 = false; e12d = `t=${t} year=${a.year}`; }
    if (a.season % 90 !== 0 || a.month % 30 !== 0 || a.year % 360 !== 0) {
      e12 = false; e12d = `t=${t} 对齐结果不是边界: ${JSON.stringify(a)}`;
    }
    if (a.year > a.season || a.season > a.month) {
      e12 = false; e12d = `t=${t} 对齐序应 year<=season<=month (年含季含月): ${JSON.stringify(a)}`;
    }
  }
  check('E12 对齐结果落在 [t-周期+1, t] 且为周期边界', e12, e12d);

  /* ══ F. 负 tick 防御 ════════════════════════════════════════════ */
  console.log('\n== F. 防御 ==');
  const neg = await probe.send({ op: 'clock', tick: -1 });
  check('F13 tick=-1 不抛异常且 day 落在 1..30',
    !neg.err && neg.day >= 1 && neg.day <= 30, JSON.stringify(neg));

  /* ══ 抽样打印 ═══════════════════════════════════════════════════ */
  console.log('\n  例:');
  for (const t of [0, 45, 89, 90, 200, 359, 360, 723, 1079]) {
    const c = multi[t];
    console.log(`    tick=${String(t).padStart(4)} → ${c.desc}  (season=${c.season})`);
  }
} finally {
  probe.close();
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
