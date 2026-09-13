/* 临时：抽出 灵脉预览.html 内联的 mapgen.js，与 Server/Zongmen/Engine/js/mapgen.js 逐行 diff */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/codes/宗门模拟器demo';
const html = fs.readFileSync(path.join(ROOT, '灵脉预览.html'), 'utf8');
const marker = '/*======== 引擎 mapgen.js 内联副本';
const m0 = html.indexOf(marker);
const headerEnd = html.indexOf('*/', m0) + 2;
const blockEnd = html.indexOf('</script>', headerEnd);
const inline = html.slice(headerEnd, blockEnd).replace(/\r\n/g, '\n').trim();
const src = fs.readFileSync(path.join(ROOT, 'Server/Zongmen/Engine/js/mapgen.js'), 'utf8').replace(/\r\n/g, '\n').trim();

const A = inline.split('\n'), B = src.split('\n');
console.log(`内联 ${A.length} 行 / 源 ${B.length} 行`);

/* 简易 LCS diff (行级) */
const N = A.length, M = B.length;
const dp = new Uint32Array((N + 1) * (M + 1));
const W = M + 1;
for (let i = N - 1; i >= 0; i--)
  for (let j = M - 1; j >= 0; j--)
    dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);

let i = 0, j = 0, out = [];
while (i < N && j < M) {
  if (A[i] === B[j]) { i++; j++; continue; }
  if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { out.push(['-', i + 1, A[i]]); i++; }
  else { out.push(['+', j + 1, B[j]]); j++; }
}
while (i < N) { out.push(['-', i + 1, A[i]]); i++; }
while (j < M) { out.push(['+', j + 1, B[j]]); j++; }

console.log(`差异 ${out.length} 行  ("-" = 内联/预览页现有, "+" = 引擎源)`);
for (const [t, ln, s] of out) console.log(`${t}${String(ln).padStart(5)}| ${s}`);
