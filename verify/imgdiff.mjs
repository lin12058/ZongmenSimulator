/* 临时：两 PNG 像素差分计数 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('binary');
    const body = buf.slice(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); ct = body[9]; }
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride), pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const line = Buffer.from(raw.slice(pos, pos + stride)); pos += stride;
    if (f === 1) for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 255;
    else if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    else if (f === 3) for (let i = 0; i < stride; i++) line[i] = (line[i] + (((i >= ch ? line[i - ch] : 0) + prev[i]) >> 1)) & 255;
    else if (f === 4) for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, px: out };
}

const [A, B] = process.argv.slice(2);
const a = decodePng(fs.readFileSync(A)), b = decodePng(fs.readFileSync(B));
if (a.w !== b.w || a.h !== b.h) { console.log(`尺寸不同 ${a.w}x${a.h} vs ${b.w}x${b.h}`); process.exit(0); }
let diff = 0, tot = a.w * a.h, maxd = 0;
for (let i = 0; i < tot; i++) {
  const ia = i * a.ch, ib = i * b.ch;
  const d = Math.abs(a.px[ia] - b.px[ib]) + Math.abs(a.px[ia + 1] - b.px[ib + 1]) + Math.abs(a.px[ia + 2] - b.px[ib + 2]);
  if (d > 30) diff++;
  if (d > maxd) maxd = d;
}
console.log(`${a.w}x${a.h}  差异像素 ${diff}/${tot} (${(diff / tot * 100).toFixed(2)}%)  最大通道差 ${maxd}`);
