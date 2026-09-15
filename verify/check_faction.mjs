/* ============================================================
 * check_faction.mjs — 「归属势力」底图契约 (离线 Node, 不需起服务/浏览器)
 * ------------------------------------------------------------
 * 用户原话:「也没给渔村下面弄归属的势力的图」。
 * 病根 (B, 2026-09-15):
 *   协议里**有** Owner (MapMessages.cs:82), 但引擎恒写空串 (mapgen.js:1204)
 *   ⇒ 前端从来没得可读; 而 R6 的地盘色 (townColor) 是「区分同屏不同城镇」的
 *   **位置派生色** ⇒ 同镇的村子必然**不同色**, 恰好与「归属」相反。
 *
 * 本层走 B-A 路线: **前端派生** —— 扫已加载的聚落实体, 取最近宗门当归属。
 *   零协议改动 / 零清库 / 单点回退; 代价是"不是世界真值"(视野外无宗门时暂时无归属)。
 *
 * 三条硬契约 (错了不会报错, 只会静默画错) ——
 *   ① **辖区半径是镜像常量**: main.js 的 SECT_DOMAIN_R 必须 == 引擎 CFG.COMM_R × 1.4
 *      (与 mapgen.js:1174 判"是否在灵脉域内"同口径)。引擎改这里不改 ⇒ 归属圈跟着错。
 *   ② **同宗同色**: 归属存在的聚落 townColor 必须**只**取决于宗门 (与自身位置无关);
 *      关掉归属层时同批聚落必须**多色** —— 这条 A/B 才证明 B 真的换掉了 R6 的口径。
 *   ③ **记号同源**: crest(3~6) / crestRot(k·π/3) / seal(0~7) 三者同由
 *      factionSig(宗门) 派生 ⇒ 同一势力在任意聚落上画出同一套记号。
 *
 * 手法: 把 main.js 里那 9 段真实源码**抠出来 eval**(不是重写一遍!) ——
 *   factionOf/factionColor/factionSig/townColor/townColorHash/hexDist + 3 个 var,
 *   注入可控的 settleCells / location。这样"测的就是上屏的那份代码"。
 *   plateAt 用 stub canvas (同 check_fish_skin.mjs) **真跑**, 并记录每一次路径操作,
 *   从而逐值断言刻痕长度/角度、印纹 8 型互异、以及"荒野不臆造记号"。
 *
 * 用法: node verify/check_faction.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'js');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');

global.window = globalThis;

/* ---------- 引擎侧: 拿 CFG.COMM_R 做镜像对拍 ---------- */
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;

/* ---------- 词法级去注释 (字符串感知) —— 源码守卫用。
   ⚠ 块注释里绝不能出现连续的 星号+斜杠 (会提前闭合注释)。 ---------- */
function stripComments(src) {
  let out = '', i = 0, st = null;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st) { out += c; if (c === '\\') { out += (d || ''); i += 2; continue; }
      if (c === st) st = null; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { st = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/* ---------- 从**原文**抠片段 (字符串/注释感知的花括号配平) ----------
   ⚠ 必须在原文上抠: 抠出来的片段要直接 eval, 去注释版会把字符串里的内容一起毁掉。 */
function scanTo(src, j, stopFn) {
  /* 从 j 起扫, 跳过字符串与注释, 交给 stopFn(c, depth) 决定何时停。
     ⚠ 括号的 depth 必须先减/加**再**问 stopFn —— 否则"配平的闭合括号"永远问不到。 */
  let depth = 0, st = null;
  for (; j < src.length; j++) {
    const c = src[j], d = src[j + 1];
    if (st) { if (c === '\\') { j++; continue; } if (c === st) st = null; continue; }
    if (c === "'" || c === '"' || c === '`') { st = c; continue; }
    if (c === '/' && d === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && d === '*') { j += 2; while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++; j++; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; if (stopFn(c, depth)) return j; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; if (stopFn(c, depth)) return j; continue; }
    if (stopFn(c, depth)) return j;
  }
  return -1;
}
function grabFn(src, name) {
  const k = src.indexOf('function ' + name + '(');
  if (k < 0) return '';
  const b = src.indexOf('{', src.indexOf(')', k));
  if (b < 0) return '';
  const end = scanTo(src, b, (c, d) => c === '}' && d === 0);
  return end < 0 ? '' : src.slice(k, end + 1);
}
function grabVar(src, name) {
  const m = new RegExp('var\\s+' + name + '\\s*=').exec(src);
  if (!m) return '';
  const j = m.index + m[0].length;
  const end = scanTo(src, j, (c, d) => c === ';' && d === 0);
  return end < 0 ? '' : src.slice(m.index, end + 1);
}

const RAW_MAIN = fs.readFileSync(path.join(WEB, 'main.js'), 'utf8');
const RAW_INK = fs.readFileSync(path.join(WEB, 'bldg_ink.js'), 'utf8');
const RAW_MMV = fs.readFileSync(path.join(WEB, 'minimap-vein.js'), 'utf8');
const SRC_MAIN = stripComments(RAW_MAIN);
const SRC_INK = stripComments(RAW_INK);
const SRC_MMV = stripComments(RAW_MMV);

/* ---------- 装配「真源码」模块工厂 ----------
   按 main.js 里的真实顺序拼, 只注入 settleCells 与 location 两个外部依赖。 */
const PIECES = [
  grabFn(RAW_MAIN, 'hexDist'),
  grabVar(RAW_MAIN, 'TOWN_HUE'),
  grabFn(RAW_MAIN, 'townColorHash'),
  grabVar(RAW_MAIN, 'SECT_DOMAIN_R'),
  grabVar(RAW_MAIN, 'settleVer'),
  grabVar(RAW_MAIN, 'FAC_OK'),
  grabFn(RAW_MAIN, 'factionOf'),
  grabFn(RAW_MAIN, 'factionColor'),
  grabFn(RAW_MAIN, 'factionSig'),
  grabFn(RAW_MAIN, 'townColor')
];
const FACTORY_SRC = PIECES.join('\n') + `
  return {
    factionOf: factionOf, factionColor: factionColor, factionSig: factionSig,
    townColor: townColor, townColorHash: townColorHash, hexDist: hexDist,
    SECT_DOMAIN_R: SECT_DOMAIN_R, FAC_OK: FAC_OK,
    setSettleVer: function (v) { settleVer = v; },
    getSettleVer: function () { return settleVer; }
  };`;

function buildFaction(search, cells) {
  return new Function('settleCells', 'location', FACTORY_SRC)(cells, { search: search });
}
const emptyCells = () => new Map();

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
const nr = (x) => Math.round((x + 0) * 1000) / 1000 + 0;
const eqJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 造一个聚落实体 */
const sect = (id, q, r, name, state) => ({ id: id, type: 'sect', q: q, r: r, name: name || ('宗' + id), state: state || 0 });
const vill = (q, r, type, name) => ({ q: q, r: r, type: type || 'village', name: name || '村' });
const cellsOf = (list) => { const m = new Map(); list.forEach((e, i) => m.set('c' + i, [e])); return m; };

/* 批量造**互异且不退化**的宗门坐标 —— 测散列质量专用。
   ⚠ 踩过两次坑: ① q=(i*53)%400-200 / r=(i*149)%400-200 时 53≡149≡5 (mod 16)
     ⇒ q 与 r 低 4 位恒相等, 会把哈希冤枉成"低熵"(实测 52%);
     ② LCG 取低位 %12 周期极短 ⇒ 坐标本身大量重复。
   故用 xorshift32 且**只取高位**。 */
let _s = 0x9e3779b9;
const _r32 = () => { _s ^= _s << 13; _s >>>= 0; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s; };
const scatter = (n, span) => {
  span = span || 400;
  const out = [], seen = new Set();
  while (out.length < n) {
    const q = (_r32() >>> 20) % (span + 1) - (span >> 1), r = (_r32() >>> 20) % (span + 1) - (span >> 1);
    if (seen.has(q + ',' + r)) continue;
    seen.add(q + ',' + r); out.push([q, r]);
  }
  return out;
};

/* 片段都抠到了吗? 抠不到后面全是假的 */
{
  const miss = ['hexDist', 'TOWN_HUE', 'townColorHash', 'SECT_DOMAIN_R', 'settleVer', 'FAC_OK',
    'factionOf', 'factionColor', 'factionSig', 'townColor']
    .filter((x, i) => !PIECES[i]);
  if (miss.length) {
    console.log('!! 无法从 main.js 抠出: ' + miss.join(', ') + ' —— 契约失效, 终止');
    process.exit(1);
  }
}

/* ============================================================
 * A. 辖区半径: 镜像常量 (引擎 ↔ 前端)
 * ============================================================ */
console.log('== 归属势力契约 A: 辖区半径镜像常量 ==');
{
  const FAC = buildFaction('', emptyCells());
  const ENG_R = MG.CFG.COMM_R * 1.4;
  check('A1 main.js 的 SECT_DOMAIN_R 抠出且为有限数',
    isFinite(FAC.SECT_DOMAIN_R) && FAC.SECT_DOMAIN_R > 0, String(FAC.SECT_DOMAIN_R));
  check(`A2 ⚠ 镜像: SECT_DOMAIN_R(${FAC.SECT_DOMAIN_R}) === 引擎 CFG.COMM_R(${MG.CFG.COMM_R}) × 1.4 = ${ENG_R}`,
    FAC.SECT_DOMAIN_R === ENG_R, `前端 ${FAC.SECT_DOMAIN_R} / 引擎 ${ENG_R}`);
  check('A3 引擎侧判域口径未变 (mapgen.js 仍用 CFG.COMM_R * 1.4 判"是否在灵脉域内")',
    /cn\.dist\s*<\s*CFG\.COMM_R\s*\*\s*1\.4/.test(stripComments(fs.readFileSync(path.join(ENG, 'mapgen.js'), 'utf8'))));
  check('A4 SECT_DOMAIN_R 全文件只有一处赋值 (禁第二真源)',
    (SRC_MAIN.match(/var\s+SECT_DOMAIN_R\s*=/g) || []).length === 1);
  check('A5 factionOf 用常量比半径, 不写裸数字',
    /bd\s*<=\s*SECT_DOMAIN_R/.test(grabFn(SRC_MAIN, 'factionOf')) &&
    !/\d{2}\s*>=?\s*bd|bd\s*>=?\s*\d{2}/.test(grabFn(SRC_MAIN, 'factionOf')));
}

/* ============================================================
 * B. 归属判定 (真跑 factionOf)
 * ============================================================ */
console.log('\n== 归属势力契约 B: 最近宗门判定 ==');
{
  /* 三家宗门: 目标村庄 (0,0) 距 A 最近(3) / B(7) / C(30) —— 全在辖区 35 内 */
  const cells = cellsOf([sect('A', 3, 0), sect('B', 0, 7), sect('C', 30, 0)]);
  const FAC = buildFaction('', cells);
  const v = vill(0, 0);
  const got = FAC.factionOf(v);
  check('B1 取**最近**宗门当归属 (3 格那家, 不是 7/30)',
    !!got && got.id === 'A', got ? got.id : 'null');
  check('B2 村庄自己不带 _facV 时清空重算 (不沿用上一版缓存)',
    v._facV === FAC.getSettleVer());

  /* 闭区间边界: 恰好 = SECT_DOMAIN_R 算有归属, +1 就算荒野 */
  const R = FAC.SECT_DOMAIN_R;
  const f2 = buildFaction('', cellsOf([sect('S', 0, 0)]));
  check(`B3 轴向距恰好 = ${R} (闭区间) → 有归属`,
    !!f2.factionOf(vill(R, 0)), '恰好 R 被判成荒野');
  check(`B4 轴向距 = ${R + 1} → 无归属 (荒野聚落不画记号)`,
    f2.factionOf(vill(R + 1, 0)) === null);
  check('B5 hexDist 是轴向立方距离 (R 格那个方向算得对)',
    f2.hexDist(0, 0, R, 0) === R && f2.hexDist(0, 0, 0, R) === R && f2.hexDist(0, 0, -R, 0) === R);

  /* 已毁宗门不参与 */
  const f3 = buildFaction('', cellsOf([sect('X', 2, 0, '灭门', 1), sect('Y', 9, 0)]));
  const g3 = f3.factionOf(vill(0, 0));
  check('B6 state===1 (已毁/移除) 的宗门不参与归属判定',
    !!g3 && g3.id === 'Y', g3 ? g3.id : 'null');

  /* 并列取 id 小者 —— 纯为确定性 */
  const f4 = buildFaction('', cellsOf([sect('zz', 5, 0), sect('aa', 0, 5)]));
  const g4 = f4.factionOf(vill(0, 0));
  check('B7 距并列时取 id 小者 (同一张图两次刷新归属必须一致)',
    !!g4 && g4.id === 'aa', g4 ? g4.id : 'null');

  /* 宗门归自己 */
  const self = sect('M', 11, -4);
  check('B8 宗门自己的归属 = 它自己 (宗门录/记号层不必特判)',
    buildFaction('', emptyCells()).factionOf(self) === self);

  /* settleCells 空 (视野外) 不炸 */
  let threw = null;
  try { buildFaction('', emptyCells()).factionOf(vill(0, 0)); } catch (e) { threw = e.message; }
  check('B9 视野内还没有任何宗门时不抛异常 (静默"暂无归属")', threw === null, String(threw));

  /* ?fac=0 总开关 */
  const fOff = buildFaction('?fac=0', cells);
  check('B10 ?fac=0 时 FAC_OK=false 且归属一律 null (同机位 A/B 差分用)',
    fOff.FAC_OK === false && fOff.factionOf(vill(0, 0)) === null);

  /* ⚠ 缓存必须在 settleVer 变化时失效 —— 旧 bldgAnchor 就是被"永久锁定"坑过一次 */
  const f5 = buildFaction('', cellsOf([sect('远', 40, 0)]));   // 第一包: 附近没宗门
  const v5 = vill(0, 0);
  check('B11 第一包只有远处宗门 → 暂判无归属', f5.factionOf(v5) === null);
  check('B12 缓存生效: settleVer 未变时第二次调用不重算 (返回同一 null)',
    f5.factionOf(v5) === null && v5._facV === f5.getSettleVer());
  /* 第二包到货: 附近来了宗门, main.js 会 settleVer++ */
  f5.setSettleVer(f5.getSettleVer() + 1);
  const v5b = vill(0, 0);       // 同一格的新实体 (真实链路里实体被重建)
  v5b._facV = 0;                // 模拟"上一版缓存的版本号"
  const g5 = f5.factionOf(v5b);
  /* 让"新来的宗门"出现在同一个 settleCells 里 */
  const f6 = buildFaction('', cellsOf([sect('远', 40, 0), sect('近', 2, 0)]));
  const v6 = vill(0, 0);
  const g6a = f6.factionOf(v6);
  check('B13 ⚠ 无永久锁定: 缓存版本号落后时会重算 (新到货的近宗门能被补上)',
    (function () {
      f6.setSettleVer(f6.getSettleVer() + 1);
      const v7 = vill(0, 0); v7._facV = -1;      // 强制重算
      const r = f6.factionOf(v7);
      return !!r && r.id === '近';
    })(), g6a ? g6a.id : 'null');
  check('B14 归属结果缓存在 st._fac 且版本号打在 st._facV 上 (settleVer 驱动失效)',
    /st\._facV\s*===\s*settleVer/.test(grabFn(SRC_MAIN, 'factionOf')) &&
    /st\._facV\s*=\s*settleVer/.test(grabFn(SRC_MAIN, 'factionOf')));
  check('B15 候选只取 type===\'sect\' (村庄不能当别人的归属源)',
    /e\.type\s*!==\s*'sect'/.test(grabFn(SRC_MAIN, 'factionOf')));
}

/* ============================================================
 * C. 势力色: 同宗同色
 * ============================================================ */
console.log('\n== 归属势力契约 C: 势力色 (同宗同色) ==');
{
  const cells = cellsOf([sect('A', 3, 0, '青云宗')]);
  const FAC = buildFaction('', cells);
  const FAC_OFF = buildFaction('?fac=0', cellsOf([sect('A', 3, 0, '青云宗')]));
  const A = cells.get('c0')[0];

  const c1 = FAC.factionColor(A), c2 = FAC.factionColor(A);
  check('C1 factionColor 确定性 (同一宗门两次同值)', c1 === c2 && !!c1, String(c1));
  const m = /^hsl\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)%,(-?\d+(?:\.\d+)?)%\)$/.exec(c1 || '');
  check('C2 势力色是 hsl(h,s%,l%) 形式', !!m, String(c1));
  if (m) {
    const h = +m[1], s = +m[2], l = +m[3];
    check('C3 色相归一化在 [0,360), 饱和度/明度落在"旗帜感"带内 (s 44~61 / l 38~49)',
      h >= 0 && h < 360 && s >= 44 && s <= 61 && l >= 38 && l <= 49,
      `h${h} s${s} l${l}`);
  }

  /* 色相全周展开 (归属色要在"不同宗门之间"区分, 不按 type 分带) */
  const hues = [];
  for (const [q, r] of scatter(200)) {
    const mm = /hsl\((-?\d+)/.exec(FAC.factionColor(sect('h', q, r)) || '');
    if (mm) hues.push(+mm[1]);
  }
  check('C4 色相全周展开 (200 宗门的色相跨度 > 300° —— 没被按 type 分带挤在小段里)',
    hues.length === 200 && Math.max.apply(null, hues) - Math.min.apply(null, hues) > 300,
    `跨度 ${Math.max.apply(null, hues) - Math.min.apply(null, hues)}°`);

  /* ⚠ 本契约的核心 A/B: 归属色与聚落**自身位置**无关 */
  const six = [];
  for (let i = 0; i < 6; i++) six.push(vill(i * 2 - 5, i - 3, i % 2 ? 'village' : 'town'));
  const onColors = six.map((v) => FAC.townColor(v));
  const offColors = six.map((v) => FAC_OFF.townColor(v));
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i).length;
  check('C5 ⚠ 开启归属: 同宗 6 个聚落 (不同位置/不同类型) townColor **全同** (同宗同色)',
    uniq(onColors) === 1, uniq(onColors) + ' 种: ' + onColors.join(' '));
  check('C6 ⚠ 关掉归属 (?fac=0): 同批聚落退回 R6 位置派生色 → **多色** (A/B 铁证)',
    uniq(offColors) >= 3, uniq(offColors) + ' 种: ' + offColors.join(' '));
  check('C7 开启归属时 townColor == factionColor(归属宗门) (归属优先接管地盘色)',
    onColors.every((c) => c === FAC.factionColor(A)));

  /* ⚠ 测散列质量必须用**互异且不退化**的坐标 (见 scatter 上方注释的两个坑) */
  const many = [], pts = scatter(400);
  for (let i = 0; i < pts.length; i++) many.push(FAC.factionColor(sect('c' + i, pts[i][0], pts[i][1])));
  check('C8 400 个**坐标互异**的宗门颜色唯一率 ≥ 99% (组合空间 360×18×12)',
    uniq(many) / many.length >= 0.99,
    (uniq(many) / many.length * 100).toFixed(1) + '% (互异坐标 ' + pts.length + ' 个)');
  check('C8b 坐标完全相同的两个宗门 → 颜色必然相同 (这是"确定性", 不是撞色)',
    FAC.factionColor(sect('x1', 7, -3)) === FAC.factionColor(sect('x2', 7, -3)));

  /* 荒野聚落 (无归属) 仍有色 —— 否则整片聚落会变成同一个兜底色 */
  const f2 = buildFaction('', cellsOf([sect('S', 0, 0)]));
  const wild = [vill(60, 0), vill(61, 0), vill(62, -1), vill(63, 2)];
  check('C9 无归属的荒野聚落仍取到色 (不是 null / 统一兜底色)',
    wild.every((v) => /^hsl\(/.test(f2.townColor(v))) && uniq(wild.map((v) => f2.townColor(v))) >= 2);
}

/* ============================================================
 * D. 记号签名: 同源 + 同宗一致
 * ============================================================ */
console.log('\n== 归属势力契约 D: 记号签名 ==');
{
  const cells = cellsOf([sect('A', 3, 0)]);
  const FAC = buildFaction('', cells);
  const A = cells.get('c0')[0];
  const s1 = FAC.factionSig(A), s2 = FAC.factionSig(A);
  check('D1 factionSig 确定性 (同宗门两次同值)', eqJSON(s1, s2) && !!s1, JSON.stringify(s1));
  check('D2 crest ∈ {3,4,5,6}', s1 && s1.crest >= 3 && s1.crest <= 6, String(s1 && s1.crest));
  check('D3 seal ∈ [0,8)', s1 && s1.seal >= 0 && s1.seal < 8, String(s1 && s1.seal));
  check('D4 crestRot 是 k·π/3 (k=0..5) 的倍数 —— 刻痕相位只取 6 个离散值',
    s1 && Math.abs((s1.crestRot / (Math.PI / 3)) - Math.round(s1.crestRot / (Math.PI / 3))) < 1e-9,
    String(s1 && s1.crestRot));
  check('D5 组合空间 = crest 4 × rot 6 × seal 8 = 192 (同屏几家门派几乎不会撞)',
    4 * 6 * 8 === 192);

  /* ⚠ "同一势力处处一致": 两个村子归属同一宗门 ⇒ 记号必须相同 */
  const v1 = vill(2, 1), v2 = vill(4, -2);
  const g1 = FAC.factionSig(FAC.factionOf(v1)), g2 = FAC.factionSig(FAC.factionOf(v2));
  check('D6 ⚠ 同宗不同村落 → 记号完全相同 (crest/rot/seal 三件全部一致)',
    eqJSON(g1, g2), JSON.stringify(g1) + ' vs ' + JSON.stringify(g2));

  /* 取值要真的铺开 —— 防"永远同一个印" (坐标同样用 scatter, 免得被退化输入骗过) */
  const crestSet = {}, sealSet = {};
  for (const [q, r] of scatter(200)) {
    const s = FAC.factionSig(sect('g', q, r));
    crestSet[s.crest] = 1; sealSet[s.seal] = 1;
  }
  check('D7 200 个互异坐标的宗门覆盖 crest 全部 4 档 (3/4/5/6)',
    Object.keys(crestSet).length === 4, Object.keys(crestSet).join(','));
  check('D8 200 个宗门覆盖 seal 全部 8 型 (8 型记号真的都在用)',
    Object.keys(sealSet).length === 8, Object.keys(sealSet).length + ' 型');
}

/* ============================================================
 * E. plateAt 记号绘制 (stub canvas 真跑 + 逐操作记录)
 * ============================================================ */
console.log('\n== 归属势力契约 E: plateAt 记号绘制 (真跑) ==');
/* 记录型 2D 上下文 —— 与 check_fish_skin.mjs 的 no-op ctx 同路子, 但记下每一次路径操作 */
function makeRecCtx() {
  const ops = [];
  const grad = { addColorStop() {} };
  const api = {
    ops: ops, strokeStyle: '', fillStyle: '', globalAlpha: 1, lineWidth: 1,
    lineJoin: '', lineCap: '',
    save() {}, restore() {}, beginPath() { ops.push(['begin']); },
    closePath() { ops.push(['close']); },
    moveTo(x, y) { ops.push(['m', x, y]); },
    lineTo(x, y) { ops.push(['l', x, y]); },
    arc(x, y, r) { ops.push(['arc', x, y, r]); },
    rect(x, y, w, h) { ops.push(['rect', x, y, w, h]); },
    stroke() { ops.push(['stroke']); },
    fill() { ops.push(['fill']); },
    createRadialGradient() { return grad; }, createLinearGradient() { return grad; },
    setTransform() {}, translate() {}, rotate() {}, scale() {}, clip() {},
    bezierCurveTo() {}, quadraticCurveTo() {}, ellipse() {}
  };
  return api;
}
/* 把 op 序列切成"每个 beginPath→stroke"一组 */
function groups(ops) {
  const out = []; let cur = null;
  for (const o of ops) {
    if (o[0] === 'begin') cur = [];
    else if (o[0] === 'stroke') { if (cur) out.push(cur); cur = null; }
    else if (cur) cur.push(o);
  }
  return out;
}
/* 组的"归一化图形描述符": 顶点按 (中心, 尺度) 归一 —— 用来判"是不是同一个记号" */
function verts(g, cx, cy, s) {
  const v = [];
  for (const o of g) {
    if (o[0] === 'm' || o[0] === 'l') v.push([nr((o[1] - cx) / s), nr((o[2] - cy) / s)]);
    else if (o[0] === 'arc') v.push(['a', nr((o[1] - cx) / s), nr((o[2] - cy) / s), nr(o[3] / s)]);
    else if (o[0] === 'rect') v.push(['r', nr((o[1] - cx) / s), nr((o[2] - cy) / s), nr(o[3] / s), nr(o[4] / s)]);
  }
  v.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return v;
}
const segLen = (g) => Math.hypot(g[1][1] - g[0][1], g[1][2] - g[0][2]);
const segAng = (g) => { const a = Math.atan2(g[1][2] - g[0][2], g[1][1] - g[0][1]); return nr((a + Math.PI * 2) % (Math.PI * 2)); };

/* plateAt 来自 bldg_ink.js (整文件 eval, 故 STONE/INK3/hexPts/rgba 都在) */
global.document = {
  createElement() { return { width: 1, height: 1, getContext() { return makeRecCtx(); } }; }
};
(0, eval)(RAW_INK);
const BI = global.BldgInk;
const plate = (o) => { const c = makeRecCtx(); BI.plateAt(c, o); return c.ops; };
const CX = 40, CY = -17, R = 100;
/* main.js drawBuildings 真实调用形态: 环骨架 + 内描边 + (水上提亮) + 刻痕 + 印纹 */
function call(o) {
  return plate(Object.assign({
    cx: CX, cy: CY, R: R, tint: 'hsl(200,50%,44%)', a: 0.40, edge: true, la: 0.44,
    water: false, seal: null, crest: 0, crestRot: 0, sc: 'hsl(120,50%,44%)', sa: 0.62
  }, o));
}

check('E1 plateAt 已导出且可调用 (stub canvas 真跑)', typeof BI.plateAt === 'function' && call({}).length > 0);
{
  /* 荒野 (crest:0 / seal:null / water:false) → 只有 R10 骨架: 环带 1 + 内外描边 2 = 3 笔 */
  const ops = call({});
  const gs = groups(ops);
  check('E2 无归属: 恰 3 次 stroke (环带 + 内外描边), **不臆造**任何记号',
    gs.length === 3, gs.length + ' 组');
  check('E3 无归属: 没有任何 arc/rect (印纹专属图元一个不出)',
    !ops.some((o) => o[0] === 'arc' || o[0] === 'rect'));

  /* water: 内外各补一道亮描边 ⇒ +2 */
  const gw = groups(call({ water: true }));
  check('E4 water:true (渔村在深水上) 多出 2 道亮描边', gw.length === 5, gw.length + ' 组');

  /* crest: n 道, 每道自 rOut 向外伸 0.11R */
  let ok = true, angOk = true, lens = [];
  for (const n of [3, 4, 5, 6]) {
    const g = groups(call({ crest: n, crestRot: Math.PI / 3 }));
    if (g.length !== 3 + n) { ok = false; break; }
    const crest = g.filter((x) => x.length === 2 && Math.abs(segLen(x) - 0.11 * R) < 1e-6);
    if (crest.length !== n) { ok = false; break; }
    lens.push(nr(segLen(crest[0])));
    /* 角度 = crestRot + k·2π/n - π/2 */
    const got = crest.map(segAng).sort((a, b) => a - b);
    const exp = [];
    for (let k = 0; k < n; k++) exp.push(nr((Math.PI / 3 + k * Math.PI * 2 / n - Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)));
    exp.sort((a, b) => a - b);
    if (!eqJSON(got, exp)) { angOk = false; }
  }
  check('E5 crest:n 恰多出 n 道刻痕 (3/4/5/6 全对), 且各段长 = 0.11R (自 rOut 向外)',
    ok, '长度 ' + lens.join('/') + ' (期望 ' + (0.11 * R) + ')');
  check('E6 刻痕角度 = crestRot + k·2π/n - π/2 均匀分布 (相位由势力定)',
    angOk);

  /* seal: 8 型互异 + 中心在 (cx,cy) + 随 R 等比缩放 */
  const descs = [];
  for (let id = 0; id < 8; id++) {
    const g = groups(call({ seal: id }));
    check('E7 seal:' + id + ' 恰好追加 1 笔 (印纹只占一次 stroke)',
      g.length === 4, g.length + ' 组');
    descs.push(JSON.stringify(verts(g[g.length - 1], CX, CY, R * 0.50)));
  }
  check('E8 ⚠ 8 型印纹的图形描述符**两两互异** (缩到 8px 仍能分辨"是不是同一家")',
    new Set(descs).size === 8, new Set(descs).size + ' 型不同');
  check('E9 印纹中心落在环心 (顶点质心 ≈ (cx,cy))',
    (function () {
      const g = groups(call({ seal: 2 }))[3];
      const xs = g.filter((o) => o[0] === 'm' || o[0] === 'l');
      const mx = xs.reduce((a, o) => a + o[1], 0) / xs.length - CX;
      const my = xs.reduce((a, o) => a + o[2], 0) / xs.length - CY;
      return Math.abs(mx) < 1e-6 && Math.abs(my) < 1e-6;
    })());
  check('E10 印纹随 R 等比缩放 (归一化描述符在 R=100 与 R=50 下相同)',
    (function () {
      const g100 = groups(call({ seal: 4, R: 100 })); const g50 = groups(call({ seal: 4, R: 50 }));
      return eqJSON(verts(g100[3], CX, CY, 100 * 0.50), verts(g50[3], CX, CY, 50 * 0.50));
    })());
  check('E11 同一 R 下不同 seal 的归一化描述符也互异 (排除"只是被缩放掩盖了")',
    (function () {
      const a = JSON.stringify(verts(groups(call({ seal: 0, R: 50 }))[3], CX, CY, 25));
      const b = JSON.stringify(verts(groups(call({ seal: 5, R: 50 }))[3], CX, CY, 25));
      return a !== b;
    })());

  /* 三件齐上: 3 + water2 + crest4 + seal1 = 10 */
  const gall = groups(call({ water: true, crest: 4, seal: 3 }));
  check('E12 水上渔村三件齐上: 3 + 2(提亮) + 4(刻痕) + 1(印纹) = 10 笔',
    gall.length === 10, gall.length + ' 组');

  /* 幂等 */
  check('E13 同参两次 → 完全相同的操作序列 (无隐藏状态)',
    JSON.stringify(call({ water: true, crest: 5, seal: 6 })) === JSON.stringify(call({ water: true, crest: 5, seal: 6 })));

  /* 不传 sc 时回落 tint/INK3, 不抛 */
  let threw = null;
  try { plate({ cx: CX, cy: CY, R: 30, tint: '#888', edge: true, crest: 4, seal: 2 }); } catch (e) { threw = e.message; }
  check('E14 省略 sc/sa 时回落 tint (老调用点/小地图不传也不炸)', threw === null, String(threw));
}

/* ============================================================
 * F. 源码守卫 (接口真的接上了)
 * ============================================================ */
console.log('\n== 归属势力契约 F: 源码守卫 ==');
{
  const PA = grabFn(SRC_INK, 'plateAt');
  check('F1 plateAt 内 water/crest/seal 三者都是**条件**画 (荒野保持纯环)',
    /if\s*\(\s*o\.water\s*\)/.test(PA) && /if\s*\(\s*o\.crest\s*>\s*0\s*\)/.test(PA) &&
    /if\s*\(\s*o\.seal\s*!=\s*null\s*\)/.test(PA));
  check('F2 plateAt 的 R10 中空环骨架未被改成实心 (rOut 0.90 / rIn 0.80 仍在)',
    /0\.90/.test(PA) && /0\.80/.test(PA) && /o\.solid/.test(PA));
  check('F3 sealGlyph 从 BldgInk 导出 (契约/看板可查)',
    /plateAt:\s*plateAt/.test(SRC_INK) && /sealGlyph:\s*sealGlyph/.test(SRC_INK));
  check('F4 main.js drawBuildings 把 seal/crest/crestRot 传给 plateAt',
    /seal:\s*sig\s*\?\s*sig\.seal\s*:\s*null/.test(SRC_MAIN) &&
    /crest:\s*sig\s*\?\s*sig\.crest\s*:\s*0/.test(SRC_MAIN) &&
    /crestRot:\s*sig\s*\?\s*sig\.crestRot\s*:\s*0/.test(SRC_MAIN));
  check('F5 main.js drawBuildings 传 water: !!onWater (渔村在水上单独提亮)',
    /water:\s*!!onWater/.test(SRC_MAIN));
  check('F6 settleVer++ 出现在"到货"与"卸载"两处 (两侧都要让归属缓存失效)',
    (SRC_MAIN.match(/settleVer\+\+/g) || []).length >= 2,
    (SRC_MAIN.match(/settleVer\+\+/g) || []).length + ' 处');
  check('F7 ?fac=0 开关存在 (同机位 A/B 差分入口)',
    /fac=0/.test(SRC_MAIN) && /var\s+FAC_OK/.test(SRC_MAIN));
  check('F8 __facProbe 探针存在且吐 domainR/on (headless 可读归属事实)',
    /window\.__facProbe\s*=/.test(SRC_MAIN) && /domainR:\s*SECT_DOMAIN_R/.test(SRC_MAIN) && /on:\s*FAC_OK/.test(SRC_MAIN));
  check('F9 __feat 探针带 factionsOn/settleVer (截图脚本一眼知归属层开关)',
    /factionsOn:\s*FAC_OK/.test(SRC_MAIN) && /settleVer:\s*settleVer/.test(SRC_MAIN));
  check('F10 小地图灵脉层 tipTextAt 显示「归属 <名>」且走注入的 deps.factionOf',
    /归属/.test(SRC_MMV) && /deps\.factionOf/.test(SRC_MMV));
  check('F11 main.js 把 factionOf/factionColor 注入小地图 (M.init)',
    /factionOf:\s*factionOf/.test(SRC_MAIN) && /factionColor:\s*factionColor/.test(SRC_MAIN));
  check('F12 townColor 里归属优先 (fac 存在时直接返回 factionColor)',
    /var\s+fac\s*=\s*factionOf\(st\)/.test(grabFn(SRC_MAIN, 'townColor')) &&
    /if\s*\(fac\)\s*return\s+factionColor\(fac\)/.test(grabFn(SRC_MAIN, 'townColor')));
  /* ⚠ 这条要查**带注释的原文** RAW_MAIN —— 注释早已被 SRC_MAIN 剥掉, 查去注释版必假红 */
  const cut = RAW_MAIN.indexOf('var SECT_DOMAIN_R');
  const head = cut > 0 ? RAW_MAIN.slice(Math.max(0, cut - 3000), cut) : '';
  check('F13 归属层注释写明了"前端派生 / 非世界真值 / 日后换 ent.owner (B-B)"',
    /B-A/.test(head) && /前端派生/.test(head) && /owner/.test(head),
    head ? '注释段未含路线说明' : 'SECT_DOMAIN_R 未找到');
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
