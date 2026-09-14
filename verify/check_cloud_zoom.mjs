#!/usr/bin/env node
/* 云「跟着画面缩放（世界锁定）」机读判据 —— 输入每个 zoom 一对实机图 (开云 / ?nocloud=1):
     掩码 = 两帧逐像素差 (d>24) ⇒ 云毯唯一贡献 (非云区恒 0, 与 §N4 同配方)。
   输出: 覆盖率% / 平均水平连续段长 (∝ 云朵宽) / 最长段 / 段数。
   判据: ① 覆盖率跨 zoom 近似恒定 (十版: 云尺寸 = 世界尺寸×zoom ⇒ 自相似);
         ② 平均段长随 zoom 近线性增长 (九版屏幕 px 弱耦合 ⇒ 基本不变)。
   用法: node verify/check_cloud_zoom.mjs 1:<on.png>:<off.png> 3:<on.png>:<off.png> ...
   取证: 用 verify/live_cap.mjs 截**同一 URL**(仅差 nocloud=1 与 zm) 的两图。
   ⚠ 实测参考 (2026-09-15 十版, CLOUD_W0=59): zm1→zm3 覆盖率 10.74%→6.52% (比值 0.61)、
     平均段长 16.9→30.5px (比值 1.80) —— 段长随 zoom 增长成立; 覆盖率非严格恒定
     (视差使近屏云相对少 + zm=1 时 base=59px 已近纹理原生宽, 放大受纹理像素上限约束)。 */
import fs from 'node:fs';
import zlib from 'node:zlib';

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0, il = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 2 && ct !== 6)) throw new Error('不支持的 PNG');
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

function mask(on, off) {
  const { w, h, ch } = on;
  const m = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0, o = 0; i < w * h; i++, o += ch) {
    const d = Math.abs(on.px[o] - off.px[o]) + Math.abs(on.px[o + 1] - off.px[o + 1]) + Math.abs(on.px[o + 2] - off.px[o + 2]);
    if (d > 24) { m[i] = 1; n++; }
  }
  return { w, h, m, n };
}

const specs = process.argv.slice(2);
if (!specs.length) {
  console.log('用法: node verify/check_cloud_zoom.mjs <zoom>:<on.png>:<off.png> [...]');
  process.exit(2);
}
console.log('zoom |  覆盖率%  | 平均段长px | 最长段px | 段数 | 判定');
const rows = [];
for (const s of specs) {
  const [z, onF, offF] = s.split(':');
  const A = decodePng(fs.readFileSync(onF)), B = decodePng(fs.readFileSync(offF));
  if (A.w !== B.w || A.h !== B.h) { console.error('尺寸不一致: ' + s); process.exit(1); }
  const { w, h, m, n } = mask(A, B);
  let runs = 0, runPx = 0, maxRun = 0, cur = 0;
  for (let y = 0; y < h; y++) {
    cur = 0;
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) { cur++; }
      else if (cur) { runs++; runPx += cur; if (cur > maxRun) maxRun = cur; cur = 0; }
    }
    /* 行尾段也要计入 */
    if (cur) { runs++; runPx += cur; if (cur > maxRun) maxRun = cur; }
  }
  const cov = n / (w * h) * 100;
  rows.push({ z: Number(z), cov, mean: runPx / Math.max(1, runs), maxRun, runs });
  console.log(`${String(z).padStart(4)} | ${cov.toFixed(3).padStart(8)} | ${(runPx / Math.max(1, runs)).toFixed(2).padStart(10)} | ${String(maxRun).padStart(8)} | ${String(runs).padStart(4)} |`);
}
if (rows.length >= 2) {
  const a = rows[0], b = rows[rows.length - 1];
  console.log(`\n判据① 覆盖率 (${a.z} → ${b.z}): ${a.cov.toFixed(3)}% → ${b.cov.toFixed(3)}%  比值 ${(b.cov / a.cov).toFixed(2)} (自相似 ⇒ 应 ≈1.0)`);
  console.log(`判据② 平均段长 (${a.z} → ${b.z}): ${a.mean.toFixed(2)} → ${b.mean.toFixed(2)} px  比值 ${(b.mean / a.mean).toFixed(2)} (世界锁定 ⇒ 应 ≈ zoom 比 ${(b.z / a.z).toFixed(2)})`);
}
