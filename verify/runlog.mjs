/* 运行包装器: 同步落盘 stdout/stderr, 绕开 Node 在管道下
   「同步计算 + process.exit() → 缓冲输出被截断」的问题。
   用法: node verify/_runlog.mjs <out.txt> <script.mjs> [args...]
*/
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outFile = process.argv[2];
const script = process.argv[3];
const log = fs.openSync(outFile, 'w');
const w = (c) => { try { fs.writeSync(log, typeof c === 'string' ? Buffer.from(c, 'utf8') : c); } catch { } return true; };
process.stdout.write = w;
process.stderr.write = w;
const note = (tag, e) => w(`\n[${tag}] ${e && (e.stack || e.message || e)}\n`);
process.on('uncaughtException', (e) => note('UNCAUGHT', e));
process.on('unhandledRejection', (e) => note('UNHANDLED', e));
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(s, () => { note('SIGNAL', s); process.exit(1); }); } catch { }
}
process.on('exit', (c) => { w(`\n[EXIT] code=${c} rss=${Math.round(process.memoryUsage().rss / 1048576)}MB\n`); try { fs.closeSync(log); } catch { } });
process.argv = [process.argv[0], script, ...process.argv.slice(4)];
await import(pathToFileURL(path.resolve(script)).href);
