#!/usr/bin/env node
/* ============================================================
 * verify/png_stats.mjs — PNG 像素统计 (纯 Node, 无第三方依赖)
 * ------------------------------------------------------------
 * 用途: 在不依赖人眼/multimodal 读图的前提下, 量化「画面上到底有没有墨」
 *       以及墨的分布范围 —— 用于实机截图 (verify/live_*.png) 的自动化断言。
 *
 * 用法:
 *   node verify/png_stats.mjs <a.png> [b.png]
 *     · 单文件: 输出尺寸 + 若干区域的墨量
 *     · 双文件: 再输出「差异像素」统计 (与相机无关的成因分析需自行解释)
 * 可选: --region=x0,y0,x1,y1   限定统计区域 (像素坐标, y 向下)
 *       --ink=110              墨阈值 (灰度 < 该值算墨, 默认 110)
 *
 * 只支持 8bit / 非隔行 的真彩 (colorType 2 或 6) —— Chrome 截图即此格式。
 * ============================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';

const fileA = process.argv[2];
const fileB = process.argv.find((a, i) => i > 2 && !/^--/.test(a));
if (!fileA) { console.error('用法: node verify/png_stats.mjs <a.png> [b.png] [--region=x0,y0,x1,y1] [--ink=110]'); process.exit(2); }
const regArg = (process.argv.find((a) => /^--region=/.test(a)) || '').split('=')[1];
const rectArg = (process.argv.find((a) => /^--rect=/.test(a)) || '').split('=')[1];
const INK = Number((process.argv.find((a) => /^--ink=/.test(a)) || '').split('=')[1]) || 110;

/* ---------------- 最小 PNG 解码 (8bit, colorType 2/6, 非隔行) ---------------- */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('非 PNG');
  let p = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bd = data[8]; ct = data[9]; il = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 2 && ct !== 6)) {
    throw new Error(`不支持的 PNG (bitDepth=${bd} colorType=${ct} interlace=${il})`);
  }
  const ch = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = src[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 255;
      }
      cur[x] = v;
    }
  }
  return { w, h, ch, px: out };
}

/* ---------------- 统计 ---------------- */
/* 墨判据: 灰度低 (近黑) —— 枯笔墨色 #2a2620 一类, 与草地/林地(绿)/水面(青)
   区分度很大; 道路核与文字描边也落在此区间 (故用「块计数」而非总像素区分聚落)。 */
function stats(img, x0, y0, x1, y1) {
  const { w, h, ch, px } = img;
  x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
  x1 = Math.min(w, x1 | 0); y1 = Math.min(h, y1 | 0);
  let dark = 0, n = 0, sum = 0;
  let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1;
  const BS = 16;
  const bw = Math.ceil((x1 - x0) / BS), bh = Math.ceil((y1 - y0) / BS);
  const blocks = new Uint16Array(bw * bh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * ch;
      const r = px[o], g = px[o + 1], b = px[o + 2];
      const lum = (r * 299 + g * 587 + b * 114) / 1000;
      n++; sum += lum;
      if (lum < INK) {
        dark++;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        blocks[((y - y0) / BS | 0) * bw + ((x - x0) / BS | 0)]++;
      }
    }
  }
  let inkBlocks = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i] >= 8) inkBlocks++;
  return { n, dark, mean: sum / n, inkBlocks, totalBlocks: bw * bh,
           bbox: mxx >= 0 ? [mnx, mny, mxx, mxy] : null };
}

const A = decodePng(fs.readFileSync(fileA));
const reg = regArg ? regArg.split(',').map(Number) : [0, 0, A.w, A.h];
const sA = stats(A, reg[0], reg[1], reg[2], reg[3]);

console.log(`# ${fileA}  ${A.w}x${A.h}  区域=[${reg.join(',')}] 墨阈值=${INK}`);
console.log(`  墨像素 ${sA.dark} / ${sA.n} (${(sA.dark / sA.n * 100).toFixed(3)}%)  均值亮度 ${sA.mean.toFixed(1)}`);
console.log(`  含墨块(16px, ≥8 墨点) ${sA.inkBlocks} / ${sA.totalBlocks} (${(sA.inkBlocks / sA.totalBlocks * 100).toFixed(2)}%)`);
console.log(`  墨范围 bbox ${sA.bbox ? sA.bbox.join(',') : 'null'}`);

if (fileB) {
  const B = decodePng(fs.readFileSync(fileB));
  if (B.w !== A.w || B.h !== A.h) { console.error('尺寸不一致, 无法逐像素比对'); process.exit(1); }
  const sB = stats(B, reg[0], reg[1], reg[2], reg[3]);
  console.log(`# ${fileB}  ${B.w}x${B.h}`);
  console.log(`  墨像素 ${sB.dark} / ${sB.n} (${(sB.dark / sB.n * 100).toFixed(3)}%)  均值亮度 ${sB.mean.toFixed(1)}`);
  console.log(`  含墨块(16px, ≥8 墨点) ${sB.inkBlocks} / ${sB.totalBlocks} (${(sB.inkBlocks / sB.totalBlocks * 100).toFixed(2)}%)`);
  console.log(`  墨范围 bbox ${sB.bbox ? sB.bbox.join(',') : 'null'}`);
  /* 逐像素差异 (同机位 A/B: 差异即「该图层唯一贡献」, 并给出差异范围) */
  let diff = 0, big = 0;
  let dx0 = 1e9, dy0 = 1e9, dx1 = -1, dy1 = -1;
  for (let y = 0; y < A.h; y++) {
    for (let x = 0; x < A.w; x++) {
      const o = (y * A.w + x) * A.ch;
      const d = Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]);
      if (d > 24) {
        diff++;
        if (x < dx0) dx0 = x; if (x > dx1) dx1 = x;
        if (y < dy0) dy0 = y; if (y > dy1) dy1 = y;
      }
      if (d > 120) big++;
    }
  }
  const tot = A.h * A.w;
  console.log(`# 差异: >24 ${diff} (${(diff / tot * 100).toFixed(2)}%) · >120 ${big} (${(big / tot * 100).toFixed(2)}%)`);
  console.log(`# 差异范围 bbox ${dx1 >= 0 ? [dx0, dy0, dx1, dy1].join(',') : 'null'}` +
              `  (尺寸 ${dx1 >= 0 ? (dx1 - dx0 + 1) : 0}x${dy1 >= 0 ? (dy1 - dy0 + 1) : 0})`);
  console.log(`# 墨块比 a/b = ${(sA.inkBlocks / Math.max(1, sB.inkBlocks)).toFixed(2)}  ·  墨像素比 = ${(sA.dark / Math.max(1, sB.dark)).toFixed(2)}`);
  if (process.argv.includes('--ascii')) asciiDiff(A, B);
  if (rectArg) rectDiff(A, B, rectArg);
} else if (process.argv.includes('--ascii')) {
  asciiInk(A);
}

/* 1:1 像素差分图 (小矩形): '#'=巨变(>120)  '+'=中变(>24)  '.'=微变(>8)  ' '=同。
   左侧标 y 像素, 便于把小块差异定位到画面元素上。 */
function rectDiff(A, B, spec) {
  const [x0, y0, x1, y1] = spec.split(',').map(Number);
  const ramp = (v) => (v > 120 ? '#' : v > 24 ? '+' : v > 8 ? '.' : ' ');
  console.log(`\n# 差异 1:1 图 rect=[${x0},${y0},${x1},${y1}]`);
  console.log('      ' + Array.from({ length: Math.ceil((x1 - x0) / 10) }, (_, i) =>
    String(x0 + i * 10).padEnd(10)).join(''));
  for (let y = y0; y < y1; y++) {
    let line = String(y).padStart(4) + '  ';
    for (let x = x0; x < x1; x++) {
      const o = (y * A.w + x) * A.ch;
      const v = Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]);
      line += ramp(v);
    }
    console.log(line);
  }
  /* 采样若干点的两侧颜色, 判断「变了什么材质」 */
  console.log('# 采样点颜色 A|B:');
  for (const [px, py] of [[Math.round((x0 + x1) / 2), y0 + 5], [x0 + 20, y0 + 17], [x1 - 20, y0 + 17]]) {
    const o = (py * A.w + px) * A.ch;
    console.log(`   (${px},${py})  ${A.px[o]},${A.px[o + 1]},${A.px[o + 2]}  |  ${B.px[o]},${B.px[o + 1]},${B.px[o + 2]}`);
  }
}

/* 终端可见的降采样热力图: 让「墨/差异在哪」不用看图也能读出来。
   每格取该区块内墨(或差异)像素占比 → 分级字符。 */
function asciiDiff(A, B) {
  const COLS = 78;
  const cw = Math.max(1, Math.floor(A.w / COLS)), chh = cw * 2;
  const rows = Math.floor(A.h / chh);
  const ramp = ' .:-=+*#%@';
  console.log(`\n# A/B 差异热力图 (每格 ${cw}x${chh}px, 字符 = 差异像素占比)`);
  let out = '';
  for (let ry = 0; ry < rows; ry++) {
    let line = '  ';
    for (let rx = 0; rx < COLS; rx++) {
      let d = 0, n = 0;
      for (let y = ry * chh; y < (ry + 1) * chh; y++) {
        for (let x = rx * cw; x < (rx + 1) * cw; x++) {
          const o = (y * A.w + x) * A.ch;
          const v = Math.abs(A.px[o] - B.px[o]) + Math.abs(A.px[o + 1] - B.px[o + 1]) + Math.abs(A.px[o + 2] - B.px[o + 2]);
          n++; if (v > 24) d++;
        }
      }
      const r = d / n;
      line += ramp[Math.min(9, Math.round(r * 9 / 0.30))];
    }
    out += line + '\n';
  }
  console.log(out);
}
function asciiInk(A) {
  const COLS = 78;
  const cw = Math.max(1, Math.floor(A.w / COLS)), chh = cw * 2;
  const rows = Math.floor(A.h / chh);
  const ramp = ' .:-=+*#%@';
  console.log(`\n# 墨分布热力图 (每格 ${cw}x${chh}px, 字符 = 墨像素占比)`);
  let out = '';
  for (let ry = 0; ry < rows; ry++) {
    let line = '  ';
    for (let rx = 0; rx < COLS; rx++) {
      let d = 0, n = 0;
      for (let y = ry * chh; y < (ry + 1) * chh; y++) {
        for (let x = rx * cw; x < (rx + 1) * cw; x++) {
          const o = (y * A.w + x) * A.ch;
          const lum = (A.px[o] * 299 + A.px[o + 1] * 587 + A.px[o + 2] * 114) / 1000;
          n++; if (lum < INK) d++;
        }
      }
      line += ramp[Math.min(9, Math.round((d / n) * 9 / 0.30))];
    }
    out += line + '\n';
  }
  console.log(out);
}
