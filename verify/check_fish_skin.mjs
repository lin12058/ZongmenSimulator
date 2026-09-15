/* ============================================================
 * check_fish_skin.mjs — 渔村皮肤契约 (离线 Node, 不需起服务/浏览器)
 * ------------------------------------------------------------
 * 用户原话:「之前叫你重新画**渔村**的贴图, 你没重画」。
 * 病根: 渔村 (type='fishing') 的建筑池/地皮在 R5b 已调好, 但**画法**一直复用内陆
 *   的 KINDS['民房'] / ['仓库'] ⇒ 落到水上就是"内陆村子浮在海面", 只多一块木台。
 *
 * 本次做法 (A): 不动引擎/协议/库, 只加 KINDS_FISH 画法表, paint() 在
 *   spec.fishVillage 时优先查它。本脚本把这条通道的**全部接口**钉死:
 *
 *   A. 表结构         —— KINDS_FISH 恰含 民房/仓库, 且都是 KINDS 里的真 kind
 *   B. 水陆必须分叉   —— 民房/仓库 × detail{1,2,3} × R{8,16,24}, 逐字节必须不同
 *   C. 不许越权覆盖   —— 表外 kind (码头/渔船坞/渔亭/村口/祠堂…含 KIND_LIST 全表)
 *                        加不加 fishVillage 必须**逐字节相同**(它们本就为水上设计)
 *   D. 分叉是真差异   —— 茅顶/瓦顶互斥、几何下探更深(桩脚入水)、构件数更多、
 *                        detail=1 不画渔具 (远景靠"桩脚+茅顶"识别)
 *   E. 确定性         —— 同格同参恒同图 (精灵缓存前提); 相邻格画法错开
 *   F. 缓存不串图     —— **真跑 spriteOf** (stub canvas): 水陆两版必须是**两个**
 *                        不同缓存条目, 且各自二次调用命中同一张
 *   G. 源码守卫       —— 缓存 key 带皮肤位 / 透传 / paint 优先查表 / main.js 传参 /
 *                        渔村远视图标独立于村落
 *
 * 用法: node verify/check_fish_skin.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'js');

global.window = globalThis;

/* 词法级去注释 (字符串感知) —— 源码守卫用。
   ⚠ 块注释里绝不能出现连续的 星号+斜杠 (会提前闭合注释)。 */
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

/* ---------- stub canvas: 让 spriteOf 能在 Node 里真跑 ----------
   spriteOf 只在浏览器可用 (document.createElement('canvas') + getContext('2d') 直接画)。
   用一个"吞掉一切"的 2D 上下文代理即可跑完全链路 —— 我们要断言的是**缓存条目身份**,
   不是像素, 所以 no-op 足够。 */
function makeFakeCtx() {
  const store = {};
  const gradient = { addColorStop() {} };
  return new Proxy(store, {
    get(o, k) {
      if (k in o) return o[k];
      return function () { return gradient; };
    },
    set(o, k, v) { o[k] = v; return true; }
  });
}
function installFakeDom() {
  global.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      const el = { width: 1, height: 1, getContext() { return makeFakeCtx(); } };
      return el;
    }
  };
}

/* ---------- 载入被测量模块 ---------- */
installFakeDom();
(0, eval)(fs.readFileSync(path.join(WEB, 'bldg_ink.js'), 'utf8'));
const BI = global.BldgInk;
const SRC_INK = stripComments(fs.readFileSync(path.join(WEB, 'bldg_ink.js'), 'utf8'));
const SRC_MAIN = stripComments(fs.readFileSync(path.join(WEB, 'main.js'), 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const TILE_C = '#b3a88f';      // 内陆瓦顶 (TILE)
const THATCH_C = '#cdc4ae';    // 渔家茅顶 (THATCH)
const NET_C = '#efe6d0';       // 挂网网面色
const R_MAIN = 16;

function body(kind, fishVillage, detail = 3, R = R_MAIN, q = 3, r = -2, plate = true) {
  return BI.svgBody({ kind, cx: 0, cy: 0, q, r, variant: 0, tier: 1, R, detail, plate, fishVillage });
}
function geom(s) {
  let maxY = -1e9, minY = 1e9, n = 0;
  const re = /points="([^"]+)"/g; let m;
  while ((m = re.exec(s))) {
    n++;
    for (const pr of m[1].split(' ')) {
      const y = parseFloat(pr.split(',')[1]);
      if (!isFinite(y)) continue;
      if (y > maxY) maxY = y;
      if (y < minY) minY = y;
    }
  }
  return { minY, maxY, n };
}
/* 按图元类别计数 —— 只数折线/多边形, 分开看能区分"多加了描边"与"多加了一个面" */
const countOf = (s, tag) => (s.match(new RegExp('<' + tag, 'g')) || []).length;
const LAMP_C = '#c2a03c';      // 藤黄 (渔灯)
const DECK_C = '#c2a377';      // 木台/挑台色 (渔家画法独有)

console.log('== 渔村皮肤契约 A: 画法表结构 ==');
check('bldg_ink.js 已加载且暴露 KINDS / KINDS_FISH / svgBody / spriteOf',
  !!BI && !!BI.KINDS && !!BI.KINDS_FISH && typeof BI.svgBody === 'function' &&
  typeof BI.spriteOf === 'function');
if (!BI || !BI.KINDS_FISH) { console.log('\n========== 结果: 缺 KINDS_FISH, 终止 =========='); process.exit(1); }

{
  const keys = Object.keys(BI.KINDS_FISH).sort();
  check('A1 KINDS_FISH 键恰为 民房/仓库 (表外 kind 一律回落通用画法)',
    keys.join(',') === '仓库,民房', keys.join(','));
  check('A2 表内每个 kind 都是通用 KINDS 里的真 kind (否则回落逻辑失去意义)',
    keys.every((k) => typeof BI.KINDS[k] === 'function'));
  check('A3 表内每个 kind 都是函数 (画法入口与 KINDS 同签名)',
    keys.every((k) => typeof BI.KINDS_FISH[k] === 'function'));
}

console.log('\n== 渔村皮肤契约 B: 水陆必须分叉 ==');
for (const kind of ['民房', '仓库']) {
  let bad = [];
  for (const detail of [1, 2, 3]) {
    for (const R of [8, 16, 24]) {
      if (body(kind, true, detail, R) === body(kind, false, detail, R)) bad.push(`d${detail}/R${R}`);
    }
  }
  check(`B ${kind}: 9 组 (detail×R) 水陆两版逐字节均不同`,
    bad.length === 0, '相同组: ' + (bad.join(' ') || '无'));
  const l = body(kind, false).length, s = body(kind, true).length;
  console.log(`  ${kind} SVG 长度: 内陆 ${l} / 渔家 ${s} (渔家多 ${s - l} 字符)`);
}

console.log('\n== 渔村皮肤契约 C: 不许越权覆盖表外 kind ==');
{
  const WATER_NATIVE = ['码头', '渔船坞', '渔亭', '渡口'];
  const CORE = ['村口', '祠堂'];
  const list = (BI.KIND_LIST || []).slice();
  const outside = [...new Set([...WATER_NATIVE, ...CORE, ...list])]
    .filter((k) => k && !BI.KINDS_FISH[k] && typeof BI.KINDS[k] === 'function');
  const same = outside.filter((k) => body(k, true) === body(k, false));
  console.log(`  表外 kind 共 ${outside.length} 种: ${outside.join(' ')}`);
  check(`C1 水上原生三件 (码头/渔船坞/渔亭) 加不加 flag 都逐字节相同`,
    WATER_NATIVE.every((k) => typeof BI.KINDS[k] !== 'function' || body(k, true) === body(k, false)));
  check(`C2 核心两件 (村口/祠堂) 加不加 flag 都逐字节相同`,
    CORE.every((k) => typeof BI.KINDS[k] !== 'function' || body(k, true) === body(k, false)));
  check(`C3 KIND_LIST 全表 (${outside.length} 种) 表外 kind 一律不受 flag 影响`,
    outside.length > 0 && same.length === outside.length,
    '被误改: ' + (same.length === outside.length ? '无' : outside.filter((k) => !same.includes(k)).join(' ')));
}

console.log('\n== 渔村皮肤契约 D: 分叉是"真差异"而非抖动 ==');
for (const kind of ['民房', '仓库']) {
  const land = body(kind, false), sea = body(kind, true);
  check(`D1 ${kind}: 内陆版含瓦顶 ${TILE_C} 且不含茅顶 ${THATCH_C}`,
    land.includes(TILE_C) && !land.includes(THATCH_C));
  check(`D2 ${kind}: 渔家版含茅顶 ${THATCH_C} 且不含瓦顶 ${TILE_C} (一眼可辨的区分点)`,
    sea.includes(THATCH_C) && !sea.includes(TILE_C));
  /* 干栏桩脚: 桩脚从 h=-0.2x 起 ⇒ 渔家版几何下探更深 (plate 关掉才量得准,
     否则「石台 + 落影」把两者的 maxY 都顶到 ±1.35R, 掩盖差异) */
  const gl = geom(body(kind, false, 3, R_MAIN, 3, -2, false));
  const gs = geom(body(kind, true, 3, R_MAIN, 3, -2, false));
  check(`D3 ${kind}: 渔家版几何下探更深 (桩脚入水)`, gs.maxY - gl.maxY >= 1.0,
    `内陆 maxY ${gl.maxY.toFixed(2)} → 渔家 ${gs.maxY.toFixed(2)} (+${(gs.maxY - gl.maxY).toFixed(2)}px)`);
  /* 构件更多: 桩脚 8 段 + 台沿 + 板缝 + 网目 6 + 竹梯 + 鱼干架 4 … ⇒ 折线增量必然 >= 8。
     面 (polygon) 增量 >= 2 = 挑台 + 网面 (+ 篓/桶)。分开数是为了将来"只加面不加线"
     (或反之) 的退化也能被看出来, 不靠一个笼统的总数。 */
  const dl = countOf(land, 'polyline'), ds = countOf(sea, 'polyline');
  const pl = countOf(land, 'polygon'), ps = countOf(sea, 'polygon');
  check(`D4 ${kind}: 渔家版折线构件显著更多 (桩脚/网目/鱼干架)`, ds - dl >= 8,
    `polyline ${dl} → ${ds} (+${ds - dl})`);
  check(`D5 ${kind}: 渔家版面构件也更多 (挑台 + 网面/桶/篓)`, ps - pl >= 2,
    `polygon ${pl} → ${ps} (+${ps - pl})`);
  /* 木台/挑台色 '#c2a377' 是渔家画法独有的 (内陆版的地台走 STONE, 不出现这个色)
     ⇒ 两个 kind 都能用它判"是否真的换了画法"。 */
  check(`D6 ${kind}: 渔家版有木台/挑台 (${DECK_C}) 而内陆版没有`,
    sea.includes(DECK_C) && !land.includes(DECK_C));
  /* 渔灯 (藤黄圆点) 只在渔家画法里 —— 但**仅民房可判**: 内陆仓库的粮囤本来就用藤黄点,
     故 仓库 不做这条 (避免假阴性)。 */
  if (kind === '民房') {
    check(`D6b ${kind}: 渔家版有一盏渔灯 (${LAMP_C}) 而内陆版没有`,
      sea.includes(LAMP_C) && !land.includes(LAMP_C));
  }
  /* 不开地盘时几何都不许越出 SPR_BOX 的可用区 (地板 ±1.35R) */
  const box = BI.SPR_BOX;
  check(`D7 ${kind}: 渔家版仍在精灵缓存盒内 (不裁剪)`,
    gs.maxY <= box.y1 * R_MAIN + 1e-6 && gs.minY >= box.y0 * R_MAIN - 1e-6,
    `几何 y [${gs.minY.toFixed(2)}, ${gs.maxY.toFixed(2)}] / 盒 [${(box.y0 * R_MAIN).toFixed(2)}, ${(box.y1 * R_MAIN).toFixed(2)}]`);
  /* 远景档收口: detail=1 不画渔具 (靠"桩脚+茅顶"识别), detail>=2 才出场。
     用网面色 NET_C 判 —— 它对两个 kind 都是渔家独有 (木台色在 detail=1 仍有, 判不了)。 */
  const s1 = body(kind, true, 1), s2 = body(kind, true, 2);
  check(`D8 ${kind}: detail=1 不画挂网 (远景不留脏点)`, !s1.includes(NET_C), 'detail1 仍含网面色');
  check(`D9 ${kind}: detail>=2 才出渔具 (挂网)`, s2.includes(NET_C));
}

console.log('\n== 渔村皮肤契约 E: 确定性与错落 ==');
{
  check('E1 同格同参恒同图 (精灵缓存的前提)',
    body('民房', true) === body('民房', true));
  check('E2 相邻格 (q 与 q+1) 渔家画法错开 (同屏两座不重样)',
    body('民房', true, 3, R_MAIN, 3) !== body('民房', true, 3, R_MAIN, 4));
  /* 内部混用: 只用一条 alt 判据, 但两个 kind 各自独立取用 —— 断言两 kind 的交替相位一致 */
  const a0 = body('民房', true, 3, R_MAIN, 3);
  const a1 = body('民房', true, 3, R_MAIN, 4);
  const b0 = body('仓库', true, 3, R_MAIN, 3);
  const b1 = body('仓库', true, 3, R_MAIN, 4);
  check('E3 两个渔家 kind 的交替相位一致 (同一格坐标同一变体判定)',
    (a0 !== a1) === (b0 !== b1));
}

console.log('\n== 渔村皮肤契约 F: 缓存不串图 (真跑 spriteOf) ==');
{
  BI.spriteClear();
  const spec = { kind: '民房', q: 3, r: -2, variant: 0, tier: 1, R: R_MAIN, detail: 3, plate: false };
  const land = BI.spriteOf(Object.assign({}, spec, { fishVillage: false }));
  const sea = BI.spriteOf(Object.assign({}, spec, { fishVillage: true }));
  check('F1 水陆两版各拿到一张精灵 (无异常)', !!land && !!sea);
  check('F2 ⚠ 水陆两版是**两个不同缓存条目** —— 不加缓存皮肤位就会串图 (本契约的主断言)',
    land !== sea, land === sea ? '水陆命中同一张精灵!' : '');
  check('F3 两版画布尺寸一致 (皮肤不改缓存盒)', !!land && !!sea && land.w === sea.w && land.h === sea.h,
    land && sea ? `${land.w}x${land.h} vs ${sea.w}x${sea.h}` : '');
  const land2 = BI.spriteOf(Object.assign({}, spec, { fishVillage: false }));
  const sea2 = BI.spriteOf(Object.assign({}, spec, { fishVillage: true }));
  check('F4 二次调用各自命中同一张 (缓存生效, 不是每次重画)', land2 === land && sea2 === sea);
  const seaOtherDetail = BI.spriteOf(Object.assign({}, spec, { detail: 2, fishVillage: true }));
  check('F5 detail 不同 → 另开一张 (detail 位仍有效)', seaOtherDetail !== sea);
}

console.log('\n== 渔村皮肤契约 G: 源码守卫 ==');
{
  /* 缓存 key 必须含皮肤位 */
  const spr = (SRC_INK.match(/function spriteOf\s*\([\s\S]*?\n  \}/) || [''])[0];
  check('G1 spriteOf 的缓存 key 串含 fishVillage 三元位',
    /fishVillage\s*\?\s*'F'\s*:\s*'-'/.test(spr), spr ? '未找到皮肤位' : 'spriteOf 未匹配');
  check('G2 spriteOf 把 fishVillage 透传给 paint (否则画出来仍是内陆民房)',
    /fishVillage:\s*spec\.fishVillage/.test(spr));
  /* paint 分派必须"优先查表 + 回落" */
  const pt = (SRC_INK.match(/function paint\s*\([\s\S]*?\n  \}/) || [''])[0];
  check('G3 paint 分派: fishVillage 且有专属画法 → 用 KINDS_FISH, 否则回落 KINDS',
    /\(spec\.fishVillage\s*&&\s*KINDS_FISH\[spec\.kind\]\)\s*\|\|\s*KINDS\[spec\.kind\]/.test(pt));
  /* 导出 */
  check('G4 BldgInk 导出 KINDS_FISH (离线看板/契约可查)', /KINDS_FISH:\s*KINDS_FISH/.test(SRC_INK));
  /* main.js 调用点 */
  check('G5 main.js drawBuildings 传 fishVillage: isFish (接口真的接上了)',
    /fishVillage:\s*isFish/.test(SRC_MAIN));
  check('G6 main.js isFish 判据 == type===\'fishing\'', /var isFish\s*=\s*it\.st\.type\s*===\s*'fishing'/.test(SRC_MAIN));
  /* 远视图标独立 */
  check('G7 ICON_FN.fishing 指向独立的 drawFishing (不再复用 drawVillage)',
    /fishing:\s*drawFishing/.test(SRC_MAIN) && /function drawFishing\s*\(/.test(SRC_MAIN));
  check('G8 渔村远视图标与村落图标不是同一函数',
    !/fishing:\s*drawVillage/.test(SRC_MAIN));
}

console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
