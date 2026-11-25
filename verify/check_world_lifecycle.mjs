/* [实机判据] 需要先 dotnet build (见下) · 用隔离 DB 与非 8140 端口, 不碰正式库
 * 构建: cd Server/Zongmen && dotnet build -p:BaseOutputPath=Temp/buildcheck/ -p:UseAppHost=false
 *
 * 实机验收: S2 (重启不清当前世) / S3 (换世重绑 Tick)
 * 用隔离 DB + 8155 端口, 不碰用户的 8140 与正式库。
 * 跑法: node verify/live_s2s3.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DLL = path.join(ROOT, 'Server/Zongmen/Temp/buildcheck/Debug/net8.0/Zongmen.dll');
const DB = path.join(ROOT, 'Temp/live_s2s3.sqlite');
const PORT = 8155;
const BASE = 'http://127.0.0.1:' + PORT;
const LOG_A = path.join(ROOT, 'Temp/live_a.log');
const LOG_B = path.join(ROOT, 'Temp/live_b.log');

let fails = 0;
function ok(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  :: ' + detail : ''));
  if (!cond) fails++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 控制台是 GBK: 按 UTF-8 读会把日志读成乱码, 断言就变成假绿 */
function decodeLog(f) { try { return new TextDecoder('gbk').decode(fs.readFileSync(f)); } catch { return fs.readFileSync(f, 'utf8'); } }

async function http(pathname, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(BASE + pathname, { ...opts, signal: ctl.signal });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* 非 JSON 也算拿到响应 */ }
    return { status: r.status, txt, json };
  } finally { clearTimeout(t); }
}

async function waitReady(label, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await http('/api/map/stats');
      if (r.status === 200) return Date.now() - t0;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(label + ' 启动超时 (' + ms + 'ms)');
}

function start(logFile) {
  const out = fs.openSync(logFile, 'w');
  const p = spawn('dotnet', [DLL, '--Zongmen:Port=' + PORT, '--Zongmen:DbPath=' + DB], {
    cwd: ROOT, stdio: ['ignore', out, out]
  });
  return p;
}

async function stop(p, label) {
  if (!p || p.exitCode != null) return;
  await new Promise((res) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* noop */ } res(); }, 8000);
    p.on('exit', () => { clearTimeout(t); res(); });
    try { p.kill('SIGTERM'); } catch { /* noop */ }
  });
  await sleep(300);
  console.log('  · ' + label + ' 已停止');
}

function sql(script) {
  const r = spawnSync('python', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python 失败: ' + (r.stderr || '').slice(0, 300));
  return (r.stdout || '').trim();
}

const watchdog = setTimeout(() => { console.error('总超时 (180s)'); process.exit(3); }, 180000);

let A = null, B = null;
const dbSqlite = DB.replace(/\\/g, '/');
try {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch { /* 不存在 */ } }
  ok('隔离库已清空 (不碰 db/zongmen.sqlite)', !fs.existsSync(DB), DB);
  ok('已编译产物存在', fs.existsSync(DLL), path.basename(DLL));

  /* ---------- A: 首次启动 + 开第一世 ---------- */
  console.log('\n== A. 首次启动 ==');
  A = start(LOG_A);
  ok('A 就绪', (await waitReady('A')) >= 0, 'boot ok');
  const wc = await http('/api/world/current');
  ok('A: /api/world/current 正常', wc.status === 200 && !!wc.json && !!wc.json.seed, wc.txt.slice(0, 80));
  const roundA = wc.json ? wc.json.round : -1;
  ok('A: 当前世 round 已开', roundA >= 1, 'round=' + roundA);

  const stA = await http('/api/map/stats');
  ok('A: /stats 正常', stA.status === 200 && stA.json && stA.json.tick >= 0, 'tick=' + (stA.json && stA.json.tick));

  /* 塞一条「本世」的城市台账行 —— 旧代码在下次启动时会把这一行删掉 */
  sql(`import sqlite3
c=sqlite3.connect(r"${dbSqlite}")
c.execute("INSERT OR REPLACE INTO CityState(Round,Id,Pop,PopF,Tier,State,Type,Q,R) VALUES(?,?,?,?,?,?,?,?,?)",
          (${roundA}, '0_0_u1', 321, 321.0, 2, 1, 'town', 0, 0))
c.commit(); print(c.execute("SELECT COUNT(*) FROM CityState WHERE Round=?", (${roundA},)).fetchone()[0])`);
  const before = sql(`import sqlite3
c=sqlite3.connect(r"${dbSqlite}")
print(c.execute("SELECT COUNT(*) FROM CityState WHERE Round=${roundA}").fetchone()[0])`);
  ok('A: 台账里已有一行 (演化几十天的替代物)', before === '1', 'rows=' + before);

  await stop(A, 'A'); A = null;

  /* ---------- B: 重启同一份库 ---------- */
  console.log('\n== B. 重启 (S2: 不许清当前世) ==');
  B = start(LOG_B);
  ok('B 就绪', (await waitReady('B')) >= 0, 'boot ok');
  const after = sql(`import sqlite3
c=sqlite3.connect(r"${dbSqlite}")
print(c.execute("SELECT COUNT(*) FROM CityState WHERE Round=${roundA}").fetchone()[0])`);
  ok('S2: 重启后当前世台账**还在** (旧代码会清零)', after === '1', 'rows ' + before + ' → ' + after);

  const logB = decodeLog(LOG_B);
  ok('S2: 启动日志不再出现「换世清空子系统世态」', logB.indexOf('换世清空子系统世态') < 0,
    (logB.match(/换世清空子系统世态[^\n]*/) || ['(无)'])[0]);

  const stB = await http('/api/map/stats');
  ok('S2: 重启后时钟已绑定 (tick >= 0)', stB.json && stB.json.tick >= 0, 'tick=' + (stB.json && stB.json.tick));

  /* ---------- S3: 换世必须重绑 Tick ---------- */
  console.log('\n== C. 换世 (S3) ==');
  /* 先让它走几拍, 好区分「新世从 InitialTick 起」与「旧世继续跑」 */
  await sleep(6000);
  const st1 = await http('/api/map/stats');
  const tickBefore = st1.json.tick;
  ok('C: 换世前时钟在走', tickBefore >= 3, 'tick=' + tickBefore);

  const nx = await http('/api/world/next', { method: 'POST' });
  ok('C: POST /api/world/next 成功', nx.status === 200 && nx.json && !!nx.json.seed, nx.txt.slice(0, 100));
  const newSeed = nx.json ? nx.json.seed : '';
  const newRound = nx.json ? nx.json.round : -1;

  const wc2 = await http('/api/world/current');
  ok('C: 当前世已换到新 round', wc2.json && wc2.json.round === newRound && wc2.json.seed === newSeed,
    'round ' + newRound + ' seed=' + String(newSeed).slice(0, 12));

  const rowafter = sql(`import sqlite3
c=sqlite3.connect(r"${dbSqlite}")
print(c.execute("SELECT COUNT(*) FROM CityState WHERE Round=${roundA}").fetchone()[0])`);
  ok('C: 上一世的台账被清 (避免跨世串味)', rowafter === '0', 'rows=' + rowafter);

  await sleep(2500);
  const st2 = await http('/api/map/stats');
  const tickAfter = st2.json.tick;
  ok('C: 换世后时钟从新世重新起算 (旧代码会从 ' + tickBefore + ' 继续往上)',
    tickAfter >= 0 && tickAfter <= tickBefore, '换世前 ' + tickBefore + ' → 换世后 ' + tickAfter);
  ok('C: 换世后时钟仍在推进 (新世真的被绑上)', tickAfter >= 1, 'tick=' + tickAfter);

  const clk = await http('/api/clock');
  const clkTick = clk.json ? (clk.json.Tick != null ? clk.json.Tick : clk.json.tick) : null;
  ok('C: /api/clock 报的是新世第 1 年 (不是旧世)', clkTick != null && clkTick <= 5,
    clk.json ? (clk.json.Desc || clk.json.desc || ('tick=' + clkTick)) : clk.txt.slice(0, 60));

  const logB2 = decodeLog(LOG_B);
  ok('C: 换世日志有「换世清空…第 ' + roundA + ' 世」', logB2.indexOf('换世清空子系统世态: 第 ' + roundA + ' 世') >= 0,
    (logB2.match(/换世清空子系统世态[^\n]*/) || ['(无)'])[0]);
} catch (e) {
  fails++;
  console.log('FAIL 实机验收异常 :: ' + (e && e.message));
} finally {
  await stop(A, 'A'); await stop(B, 'B');
  clearTimeout(watchdog);
  console.log('\n---- ' + (fails ? fails + ' FAIL' : '全部 PASS') + ' ----');
  process.exit(fails ? 1 : 0);
}
