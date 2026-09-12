/* 临时：裁图 + 最近邻放大（用于 1:1 检查六角形朝向/形状） */
import fs from 'fs';
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

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'binary'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function encodePng(w, h, rgb) {                       // rgb: Buffer w*h*3
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 3)] = 0; rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3); }
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const [src, X, Y, CW, CH, S, dst] = process.argv.slice(2);
const x0 = +X, y0 = +Y, cw = +CW, chh = +CH, s = +S || 1;
const img = decodePng(fs.readFileSync(src));
const ox = Math.max(0, Math.min(img.w - 1, x0)), oy = Math.max(0, Math.min(img.h - 1, y0));
const w = Math.min(cw, img.w - ox), h = Math.min(chh, img.h - oy);
const rgb = Buffer.alloc(w * s * h * s * 3);
for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
  const si = ((oy + (y / s | 0)) * img.w + (ox + (x / s | 0))) * img.ch;
  const di = (y * w * s + x) * 3;
  rgb[di] = img.px[si]; rgb[di + 1] = img.px[si + 1]; rgb[di + 2] = img.px[si + 2];
}
fs.writeFileSync(dst, encodePng(w * s, h * s, rgb));
console.log('✔ ' + dst + '  ' + src + ' [' + ox + ',' + oy + ' +' + w + 'x' + h + '] ×' + s);
