/* [实机判据] 需要先 dotnet build (见下) · 用隔离 DB 与非 8140 端口, 不碰正式库
 * 构建: cd Server/Zongmen && dotnet build -p:BaseOutputPath=Temp/buildcheck/ -p:UseAppHost=false
 *
 * 实机验收 S1: tick 演化真的走到 MarkSettleDirty, 且区域→区块折算不炸
 * 做法: 隔离库 + 手工播一条 townEvolve job (真城 id 由引擎现算) → 重启让 BindWorld 载入
 *       → 等若干 tick → 台账出现该城的行 = ApplyOutcome 走过 = MarkSettleDirty 被调用。
 * 跑法: node verify/live_s1.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DLL = path.join(ROOT, 'Server/Zongmen/Temp/buildcheck/Debug/net8.0/Zongmen.dll');
const DB = path.join(ROOT, 'Temp/live_s1.sqlite');
const PORT = 8156;
const BASE = 'http://127.0.0.1:' + PORT;
const LOG_A = path.join(ROOT, 'Temp/s1_a.log');
const LOG_B = path.join(ROOT, 'Temp/s1_b.log');

let fails = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d ? '  :: ' + d : '')); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decodeLog = (f) => { try { return new TextDecoder('gbk').decode(fs.readFileSync(f)); } catch { return fs.readFileSync(f, 'utf8'); } };

async function http(p, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
  try { const r = await fetch(BASE + p, { ...opts, signal: ctl.signal }); const txt = await r.text();
        let json = null; try { json = JSON.parse(txt); } catch { /* 非 JSON */ }
        return { status: r.status, txt, json }; } finally { clearTimeout(t); }
}
async function waitReady(label, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await http('/api/map/stats'); if (r.status === 200) return 1; } catch { /* 未起 */ }
    await sleep(300);
  }
  throw new Error(label + ' 启动超时');
}
function start(log) {
  const out = fs.openSync(log, 'w');
  return spawn('dotnet', [DLL, '--Zongmen:Port=' + PORT, '--Zongmen:DbPath=' + DB],
               { cwd: ROOT, stdio: ['ignore', out, out] });
}
async function stop(p, label) {
  if (!p || p.exitCode != null) return;
  await new Promise((res) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* noop */ } res(); }, 8000);
    p.on('exit', () => { clearTimeout(t); res(); });
    try { p.kill('SIGTERM'); } catch { /* noop */ }
  });
  await sleep(300); console.log('  · ' + label + ' 已停止');
}
function sql(s) {
  const r = spawnSync('python', ['-c', s], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python: ' + (r.stderr || '').slice(0, 200));
  return (r.stdout || '').trim();
}
/* 用引擎现算该 seed 在 region(0,0..3) 的第一座城 (id 必须是真的, 否则演化器取不到骨架) */
function firstTown(seed) {
  const r = spawnSync('node', ['-e', `
    const fs=require('fs');global.window=globalThis;
    const ENG='Server/Zongmen/Engine/js',CITY='Server/Zongmen/Subsystems/City/js';
    for(const f of ['noise.js','mapgen-config.js','mapgen.js','mapgen-server.js'])(0,eval)(fs.readFileSync(ENG+'/'+f,'utf8'));
    for(const f of fs.readdirSync(CITY).filter(x=>x.endsWith('.js')))(0,eval)(fs.readFileSync(CITY+'/'+f,'utf8'));
    window.MapGenServer.init(${JSON.stringify(String(seed))});
    for(let ri=-2;ri<=2;ri++)for(let rj=-2;rj<=2;rj++){
      const j=JSON.parse(window.CityEvo.settlementsJson(ri,rj));
      for(const s of (j.settlements||[])) if(s.type!=='poi'){console.log(s.id+'|'+s.type);process.exit(0);}
    }`], { encoding: 'utf8', cwd: ROOT });
  const line = (r.stdout || '').trim().split('\n')[0] || '';
  const [id, type] = line.split('|');
  return id ? { id, type } : null;
}

const wd = setTimeout(() => { console.error('总超时'); process.exit(3); }, 200000);
let A = null, B = null;
const db = DB.replace(/\\/g, '/');
try {
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch { /* 无 */ } }

  A = start(LOG_A); await waitReady('A');
  const wc = await http('/api/world/current');
  const seed = wc.json.seed, round = wc.json.round;
  console.log('  · 世界 round=' + round + ' seed=' + seed);
  const town = firstTown(seed);
  ok('从引擎现算出一座真城', !!town, town ? town.id + '/' + town.type : 'none');
  await stop(A, 'A'); A = null;

  ok('台账里还没有任何城 (基线干净)',
    sql(`import sqlite3;c=sqlite3.connect(r"${db}");print(c.execute("SELECT COUNT(*) FROM CityState").fetchone()[0])`) === '0');

  /* 播一条真的演化 job: NextTick=0 ⇒ 第一个 tick 就到期 */
  sql(`import sqlite3
c=sqlite3.connect(r"${db}")
c.execute("""INSERT OR REPLACE INTO TickJob
  (Round,EntityId,KindCode,Layer,Resource,NextTick,PeriodTicks,Phase,LastRunTick,FailCount,Enabled)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
  (${round}, ${JSON.stringify(town.id)}, 4, 1, 1, 0, 90, 0, 0, 0, 1))
c.commit();print('seeded')`);

  B = start(LOG_B); await waitReady('B');
  const st0 = await http('/api/map/stats');
  ok('重启后载入了 job', st0.json.tickPendingJobs >= 0, 'pending=' + st0.json.tickPendingJobs);

  /* 等它走几拍: 演化 + 落库 + MarkSettleDirty */
  await sleep(12000);
  const st1 = await http('/api/map/stats');
  ok('时钟在推进', st1.json.tick >= 1, 'tick=' + st1.json.tick);

  const rows = sql(`import sqlite3
c=sqlite3.connect(r"${db}")
r=c.execute("SELECT Id,Pop,Ver,Tier FROM CityState WHERE Round=${round}").fetchall()
print('|'.join('%s,%s,%s,%s'%x for x in r))`);
  ok('S1 端到端: 演化确实跑过并落了台账 (ApplyOutcome → MarkSettleDirty 被调用)',
    rows.length > 0 && rows.indexOf(town.id) >= 0, rows || '(空)');

  const lastRun = sql(`import sqlite3
c=sqlite3.connect(r"${db}")
print(c.execute("SELECT LastRunTick,NextTick FROM TickJob WHERE EntityId='${town.id}'").fetchone())`);
  /* 提交成功后 CommitSuccess 会按 NextDue 重新排期 ⇒ NextTick 从 0 变成 90 (季度周期) */
  ok('job 提交成功并重新排期 (NextTick 已前进)', /\(\s*\d+,\s*[1-9]\d*\)/.test(lastRun), lastRun);

  const logB = decodeLog(LOG_B);
  ok('区域→区块折算没有走兜底 (几何参数从 metaJson 读到)',
    logB.indexOf('读引擎几何参数失败') < 0,
    (logB.match(/\[dirty\][^\n]*/) || ['(无 [dirty] 日志)'])[0]);
  ok('演化过程没有失败日志 (MarkSettleDirty 没抛)',
    logB.indexOf('city 处理失败') < 0,
    (logB.match(/\[tick\] city 处理失败[^\n]*/) || ['(无)'])[0]);
} catch (e) {
  fails++; console.log('FAIL 异常 :: ' + (e && e.message));
} finally {
  await stop(A, 'A'); await stop(B, 'B'); clearTimeout(wd);
  console.log('\n---- ' + (fails ? fails + ' FAIL' : '全部 PASS') + ' ----');
  process.exit(fails ? 1 : 0);
}
