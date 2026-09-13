/* ============================================================
 * sync_preview_inline.mjs — 把引擎源码同步内联进 灵脉预览.html
 * ------------------------------------------------------------
 * 预览页是 file:// 自包含单文件: 引擎 js 以 <script> 内联副本形式存在
 * （绕开 file:// 跨目录 <script src> 拦截）。改了引擎就必须同步,
 * 否则预览页跑的是旧算法 —— 这一步以前靠手工替换, 容易漏。
 *
 * 用法: node verify/sync_preview_inline.mjs [--check]
 *   --check  只比对不写入（CI/提交前用）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* 仓库根 = 本脚本所在目录的上一级 (verify/ → 根)。禁止硬编码绝对路径:
   目录更名 (宗门模拟器demo → ZongmenSimulator) 曾让本脚本 ENOENT 失效。 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, '灵脉预览.html');

/* 标记注释 → 源文件。标记行必须唯一。
   ⚠ 源文件是 CRLF, 匹配一律用 indexOf 的子串, 不要拼整块多行字面量。 */
const MAP = [
  { marker: '/*======== 引擎 mapgen-config.js 内联副本', src: 'Server/Zongmen/Engine/js/mapgen-config.js' },
  { marker: '/*======== 引擎 mapgen.js 内联副本',        src: 'Server/Zongmen/Engine/js/mapgen.js' }
];

const CHECK = process.argv.includes('--check');
let html = fs.readFileSync(PREVIEW, 'utf8');
let changed = 0;

for (const { marker, src } of MAP) {
  const m0 = html.indexOf(marker);
  if (m0 < 0) { console.log(`✘ 未找到标记: ${marker}`); process.exit(1); }
  const headerEnd = html.indexOf('*/', m0) + 2;          // 标记注释块结束
  const blockEnd = html.indexOf('</script>', headerEnd); // 该 script 块结束
  if (headerEnd < 2 || blockEnd < 0) { console.log(`✘ 块边界异常: ${marker}`); process.exit(1); }

  const engineSrc = fs.readFileSync(path.join(ROOT, src), 'utf8').replace(/\r\n/g, '\n');
  const cur = html.slice(headerEnd, blockEnd).replace(/\r\n/g, '\n');
  const want = '\n' + engineSrc + '\n';
  const ok = cur.trim() === want.trim();
  console.log(`${ok ? '✔ 已同步' : '✎ 需同步'}  ${path.basename(src).padEnd(18)} 内联 ${cur.length} → 源 ${want.length} 字节`);
  if (!ok) { changed++; html = html.slice(0, headerEnd) + want + html.slice(blockEnd); }
}

if (CHECK) {
  console.log(changed ? `\n=== 结果: ✘ ${changed} 处不同步（跑不带 --check 的命令写入）===` : '\n=== 结果: ✔ 全部同步 ===');
  process.exit(changed ? 1 : 0);
}
if (changed) {
  fs.writeFileSync(PREVIEW, html, 'utf8');
  console.log(`\n✔ 已写回 ${path.basename(PREVIEW)}（${changed} 段更新）`);
} else {
  console.log('\n✔ 无需写入');
}
