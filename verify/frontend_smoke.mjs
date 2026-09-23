/* ============================================================
 * frontend_smoke.mjs — 在 Node 中「完整模拟前端」数据流
 *   直接复用 web/js/pb.js + web/js/mapclient.js (与浏览器同份) 拉取
 *   /api/map/* 后解码, 验证元信息常量 + 几何往返 + HTTP 侧数据还原, 不依赖浏览器/GL。
 *
 *   注: chunk/region/comm 在 WebSocket 单块重构后已下线 HTTP 接口,
 *       其数据正确性由 verify_map.mjs (WS 链路) / w1_client_revs.mjs 覆盖;
 *       本脚本只负责「HTTP 辅助接口 (meta/tile) + 几何公式 + 小地图新架构契约」这一层。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';

/* 全局注入 window = globalThis 以原样执行浏览器脚本 */
global.window = globalThis;
/* mapclient.js 模块级会读 location.protocol/host 拼 WS_URL — Node 里必须提供 */
global.location = { protocol: 'http:', host: BASE.replace(/^https?:\/\//, '') };
/* Node 中 fetch 必须是绝对 URL, 给 mapclient.js 的相对路径补上 base */
const _realFetch = global.fetch;
global.fetch = (url, opts) =>
  _realFetch(String(url).startsWith('http') ? url : BASE + url, opts);

for (const f of ['pb.js', 'mapclient.js']) {
  const code = fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8');
  (0, eval)(code);
}
const PB = global.PB, MC = global.MapClient;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- 源码级守卫公用设施 (checkCalcLocal / checkPlaqueAlign 共用) ----------
   词法级去注释 (含**多行块注释**与字符串字面量感知)。
   ⚠ 不能用「行首是 * 或 双斜杠 就丢」的土办法 —— minimap-vein.js 里那段引擎说明
     块注释的续行**不以 * 开头**, 注释正文会被当成真实调用 (实测把其中
     `MapGen.init()` 的解释文字误判成第二个 init 点)。
   ⚠ 也不该直接砍行尾双斜杠注释: 'http://x' 这类字符串会受伤
     (这里靠「双斜杠前必须是空白」+ 字符串状态机双重规避)。
   ⚠ 块注释里**绝不能出现连续的 星号+斜杠** (那会提前闭合注释)。本次真实事故:
     vein-skin.js 的注释里写出「mtn 星号 / snow 星号」这种简写, 导致 node --check 报
     "Invalid regular expression flags" —— 报错行号在注释**之后**, 极难定位。 */
function stripComments(src) {
  let out = '', i = 0, st = null;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st) {
      out += c;
      if (c === '\\') { out += (d || ''); i += 2; continue; }
      if (c === st) st = null;
      i++; continue;
    }
    if (c === "'" || c === '"' || c === '`') { st = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}
/* web/js/*.js 去注释源码 (模块级只读一次) */
const JSDIR = path.join(ROOT, 'web', 'js');
const JSFILES = fs.readdirSync(JSDIR).filter((f) => f.endsWith('.js'));
const JSSRC = {};
for (const f of JSFILES) JSSRC[f] = stripComments(fs.readFileSync(path.join(JSDIR, f), 'utf8'));

async function fetchMeta() {
  const m = await MC.fetchMeta();
  check('meta 几何常量', m.hexR === 8 && m.chunkS === 21 && near(m.hexW, Math.sqrt(3) * 8, 1e-9));
  check('meta 图例 13', m.biomeMeta.length === 13, String(m.biomeMeta.length));
  return m;
}

async function fetchTile(seed, q, r) {
  const t = await MC.tile(seed, q, r);
  check(`tile(${q},${r}) e in [0,1]`, t.e >= 0 && t.e <= 1, String(t.e));
  check(`tile(${q},${r}) biome 0..7`, t.biome >= 0 && t.biome <= 7, String(t.biome));
  check(`tile(${q},${r}) 区域名非空`, typeof t.regionName === 'string' && t.regionName.length > 0,
    String(t.regionName));
  return t;
}

function checkGeometry() {
  const G = MC.geo();
  let bad = 0, samples = 0;
  for (let i = 0; i < 200; i++) {
    const q = (Math.random() * 2000 | 0) - 1000;
    const r = (Math.random() * 2000 | 0) - 1000;
    const w = MC.tileToWorld(q, r);
    const back = MC.pxToTile(w.x, w.y);
    samples++;
    if (back.q !== q || back.r !== r) {
      bad++;
      if (bad <= 3) console.log(`  FAIL 几何往返 (${q},${r}) -> (${back.q},${back.r})`);
    }
  }
  check(`几何往返 ${samples} 次 (大坐标 ±1000)`, bad === 0, `不一致 ${bad} 次`);
  check('geo() 结果被缓存复用', MC.geo() === G);
}

/* DOM id 契约: main/renderer/textures 里 $('x') / getElementById('x') 引用的 id
   必须在 index.html 中真实存在 —— 这类不匹配只在浏览器运行时炸, 静态核对是唯一便宜手段。 */
function checkDomIds() {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
  check('index.html 定义了 id', ids.size > 10, String(ids.size));
  const bad = [];
  let used = 0;
  for (const f of ['main.js', 'renderer.js', 'textures.js', 'mapclient.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8');
    for (const m of src.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
      const id = m[1] || m[2];
      used++;
      if (!ids.has(id)) bad.push(`${f}:${id}`);
    }
  }
  check(`JS 引用的 ${used} 处 DOM id 全部已定义`, bad.length === 0, bad.join(' '));
}

/* 静态层置脏契约: renderStaticInto() 由 staticDirty 门控, 其内部消费的数据
   (showVeins/showLabels/regionCells/commCells/settleCells/poiCells/chunkData)
   在别处被改写时必须同时置静态脏 —— 否则相机静止时 staticNeedsRedraw() 返回
   false, 改动不会生效 (要等下一次平移/缩放)。
   这是实测过的真实 bug: 灵脉/标注两个开关只翻变量不置脏 → 点了没反应。
   静态核对是唯一便宜手段 (该路径依赖 GL 与相机状态, Node 里跑不起来)。 */
function checkStaticDirtyContract() {
  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'main.js'), 'utf8');
  const bad = [];
  /* 1) 运行时改写 showVeins/showLabels (排除 `var showX = <初值>` 声明) 必须**同函数内**置脏。
     ⚠ 这里原来用固定字符窗 (±200 / +500) 做邻近判定 —— 每**加一个设置项**就会把
       `forceStaticDirty()` 挤出窗口 ⇒ 假红。2026-09-23 加第 6 个开关 (`domain`, 领地圈)
       时正是这样红的 (`showVeins@L77`), 而代码本身完全正确。
       改为「取赋值点所在的整个函数体」: 语义更强 (必须真的在同一函数里置脏),
       且对新增开关免疫。找不到包围函数时**回落**到旧字符窗 (绝不静默放宽)。 */
  function enclosingFn(src, idx) {
    /* ⚠ 不做花括号配对 —— main.js 的字符串/正则里花括号成堆, 朴素配对必错。
       改用**缩进**: 函数头行 indent=n ⇒ 「缩进 <= n 的下一行 `}`」就是函数尾。 */
    const lines = src.split('\n');
    let head = -1, indent = -1;
    const upTo = src.slice(0, idx).split('\n').length - 1;
    for (let i = upTo; i >= 0; i--) {
      const m = /^(\s*)(?:function\s+[\w$]+\s*\(|var\s+[\w$]+\s*=\s*function\s*\()/.exec(lines[i]);
      if (m) { head = i; indent = m[1].length; break; }
    }
    if (head < 0) return '';
    for (let i = head + 1; i < lines.length; i++) {
      const m = /^(\s*)\}/.exec(lines[i]);
      if (m && m[1].length <= indent) return lines.slice(head, i + 1).join('\n');
    }
    return '';
  }
  for (const m of src.matchAll(/\b(showVeins|showLabels)\s*=/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/\bvar\b/.test(src.slice(lineStart, m.index))) continue;      // 声明, 跳过
    const body = enclosingFn(src, m.index);
    const near = body || src.slice(Math.max(0, m.index - 200), m.index + 500);
    if (!/StaticDirty\s*\(/.test(near))
      bad.push(`${m[1]}@L${src.slice(0, m.index).split('\n').length}` +
               (body ? '' : '(无包围函数, 回落字符窗)'));
  }
  check('showVeins/showLabels 的运行时改写都伴随静态置脏', bad.length === 0, bad.join(' '));

  /* 2) 所有 'off' 按钮开关 (classList.toggle('off', …)) 都必须触发静态层重绘 */
  const bad2 = [];
  for (const m of src.matchAll(/classList\.toggle\('off'/g)) {
    const seg = src.slice(m.index, m.index + 400);
    if (!/StaticDirty\s*\(/.test(seg))
      bad2.push(`off@L${src.slice(0, m.index).split('\n').length}`);
  }
  check('标注开关键均触发静态层重绘', bad2.length === 0, bad2.join(' '));
}

/* 小地图 (R11) 契约 —— 旧实现 (每 1.5s 轮询 HTTP /api/map/fields 采 132×88 字段网格)
   已整体退役 (那正是「一直请求 → 撞请求速率」的根因)。新架构三层:
     L1 地形: 前端按 seed 自算 (引擎脚本经 WS 下发 ScriptPack → 间接 eval → MapGen.fields)
     L2 世界: 全部来自 WS (灵脉 comm.veins / 聚落 / 道路)
     L3 视野: 默认档跟随主相机, 全屏档独立拖动缩放, 可整体隐藏 (停摆)
   本检查 = 源码守卫 (零轮询 / 旧符号清除 / 模块接线) + 地形可画性复算。 */
async function checkMinimap() {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* 注释剥离: 文档性注释里出现旧符号名不算违规 (否则改不动注释) */
  const strip = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');

  const mc = read('web/js/mapclient.js'), mcs = strip(mc);
  check('mapclient 不再导出 fieldGrid (HTTP 字段网格退役)',
    !/fieldGrid/.test(mcs), '仍存在 fieldGrid');
  check('mapclient 不再出现 /api/map/fields 轮询',
    !mcs.includes('/api/map/fields'), '仍引用 /api/map/fields');
  check('mapclient 提供 requestScript (WS 下发引擎脚本)',
    mcs.includes('requestScript') && mc.includes('requestScript: requestScript'));

  const mm = read('web/js/minimap-vein.js');
  const mainJs = strip(read('web/js/main.js'));
  check('main.js 旧小地图实现已清除 (mmData/mmCam/requestMinimap/…)',
    !/mmData|mmCam|requestMinimap|refreshMinimap|drawMinimap|syncMinimapSize|minimapWindowStale/.test(mainJs),
    '仍残留旧符号');
  /* 热拔插单点: 壳层只把 window.MiniMapVein 取出来注入四个口子 (panel/full/snapshot/jump),
     不含任何小地图绘制逻辑 —— 换一个 minimap-*.js 即可整体替换。 */
  const initAt = mainJs.indexOf('M.init({');
  const initSeg = initAt < 0 ? '' : mainJs.slice(initAt, initAt + 420);
  const injMiss = ['panel', 'full', 'snapshot', 'jump'].filter((k) => !initSeg.includes(k + ':'));
  check('main.js 通过 MiniMapVein 单点注入 (panel/full/snapshot/jump)',
    /var M = window\.MiniMapVein;/.test(mainJs) && initAt >= 0 && injMiss.length === 0,
    initAt < 0 ? '未见 M.init({' : '缺 ' + injMiss.join(','));
  check('main.js 暴露只读快照 (comms/settles/roads 取自 WS 层)',
    /comms:\s*commCells/.test(mainJs) && /settles:\s*settleCells/.test(mainJs) &&
    /roads:\s*regionCells/.test(mainJs));

  /* 模块自足性: 三层 + 三态入口 + 探针都必须存在 (换模块时这些是接口契约)。
     ⚠ S1 (地形块前端自算): 引擎加载已从本模块收敛到全站单实例 EngineLocal
       ⇒ 这里断言的是「复用 EngineLocal」而非旧的「自己 requestScript」。 */
  const need = ['MiniMapVein', 'setMaximized', 'setHidden', 'probe', 'EngineLocal']
    .filter((k) => mm.indexOf(k) < 0);
  check('minimap-vein.js 接口齐备 (init/setMaximized/setHidden/probe)',
    need.length === 0, '缺少 ' + need.join(','));
  check('minimap-vein.js 不再自行 eval/init 引擎 (双实例会互清 14 张缓存)',
    !/(0,\s*eval)/.test(mm) && !/engine\.init\(/.test(mm), '仍残留自建引擎的痕迹');

  const html = read('web/index.html');
  check('index.html 挂载点齐备 + 全屏浮层与面板同级 (不被 .panel clip-path 裁)',
    html.includes('id="minimapBox"') && html.includes('id="mmCanvasFull"') &&
    html.includes('id="mmRestore"') && html.includes('js/minimap-vein.js"'));

  const pbSrc = strip(read('web/js/pb.js'));
  check('pb.js 有 SCRIPT 帧 + ScriptPack 编解码',
    /FRAME\s*=\s*\{[^}]*SCRIPT:\s*4/.test(pbSrc) &&
    pbSrc.includes('encodeScriptRequest') && pbSrc.includes('decodeScriptPack'));
  const cs = read('Server/Zongmen/Domain/MapMessages.cs');
  const ws = read('Server/Zongmen/Web/MapWsHandler.cs');
  check('服务端帧类型 Script=4 与处理器齐备',
    /Script = 4;/.test(cs) && ws.includes('HandleScriptAsync') &&
    ws.includes('EngineScriptOrder'));

  /* 地形复算: 用 Engine/js 原算法 (与前端同一份), 按模块真实的抽样规则复算。
     ⚠ R12 起抽样格是「世界对齐」的 { q%m==0 && r%m==0 } (m 由 SAMPLE_CELLS_MAX 反推),
       不是旧版「画布像素格投影进世界」—— 后者视图一动缓存全废 (实测平移 5 单位复用
       仅 55%, 面板档→全屏档 11.5%), 且默认全屏档漏格 63%。本段把该契约钉死:
         ① 抽样格落在 m 的整数倍上 (世界对齐);
         ② 视图内每一格都被某个抽样格代表 (全覆盖 ⇒ 不再出现成片「未探测」);
         ③ 视图微动后抽样格集合高度重合 (复用率; 旧实现在此只有 55% / 32%);
         ④ 复算出的群系索引与色板正确。
     ⚠ 本段是「按模块常量复刻规则」的代理检查 —— 改抽样规则必须同步本段。 */
  const wpp = Number((mm.match(/FOLLOW_WPP\s*=\s*([\d.]+)/) || [])[1]) || 6;
  const cellsMax = Number((mm.match(/SAMPLE_CELLS_MAX\s*=\s*(\d+)/) || [])[1]) || 24000;
  const lvMax = Number((mm.match(/LEVEL_MAX\s*=\s*(\d+)/) || [])[1]) || 5;
  const pad = Number((mm.match(/PADDING\s*=\s*([\d.]+)/) || [])[1]) || 0;
  /* U4: 一个显示块由 AGG_DIV² 个原始子格样本表决 ⇒ 原始样本层 = 块层 / AGG_DIV */
  const aggDiv = Number((mm.match(/AGG_DIV\s*=\s*(\d+)/) || [])[1]) || 2;
  for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
    (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
  }
  const MG = globalThis.MapGen;
  MG.init('42');
  const G = MC.geo();
  const HRW = 1.5 * G.hexR;
  /* 显示块层级 mD: 与模块 levelFor 同式 —— 一个显示块 ≈ step 像素 × wpp 的世界长度 */
  const levelFor = (vw, vh, w) => {
    const step = Math.max(2, Math.ceil(Math.sqrt((vw * vh) / cellsMax)));
    const k = Math.ceil(Math.log2(Math.max(1e-6, (step * w) / G.hexW)));
    return 1 << Math.min(lvMax, k > 0 ? k : 0);
  };
  /* 原始样本层级: 直接**取模块自己的函数源码**求值 (而不是在测试里另抄一份公式),
     这样模块改口径而测试没跟着改时, 下面的断言会直接失败。 */
  let rawLevelOfMod = null;
  {
    const at = mm.indexOf('function rawLevelOf');
    if (at >= 0) {
      const o = mm.indexOf('{', at);
      let d = 0, end = -1;
      for (let i = o; i < mm.length; i++) {
        if (mm[i] === '{') d++;
        else if (mm[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
      }
      if (end > 0) {
        /* 模块里的 AGG_DIV 是闭包常量 ⇒ 用工厂把它喂进去, 保证「取源码求值」真的可行 */
        try {
          rawLevelOfMod = (0, eval)('(function (AGG_DIV) { return ' + mm.slice(at, end) + '; })')(aggDiv);
        } catch (e) { rawLevelOfMod = null; }
      }
    }
  }
  const rawMOf = (mD) => (rawLevelOfMod ? rawLevelOfMod(mD) : Math.max(1, Math.floor(mD / aggDiv)));
  /* 复刻 rebuildPending 的枚举 (只要原始样本层的格集合) */
  const cellsOf = (vw, vh, cx, cy, w) => {
    const mD = levelFor(vw, vh, w);
    const m = rawMOf(mD);
    const px = (vw * pad / 2) * w, py = (vh * pad / 2) * w;
    const x0 = cx - (vw / 2) * w - px, x1 = cx + (vw / 2) * w + px;
    const y0 = cy - (vh / 2) * w - py, y1 = cy + (vh / 2) * w + py;
    const r0 = Math.floor(y0 / HRW) - 1, r1 = Math.ceil(y1 / HRW) + 1;
    const q0 = Math.floor(x0 / G.hexW - r1 / 2) - 1, q1 = Math.ceil(x1 / G.hexW - r0 / 2) + 1;
    const aq = Math.ceil(q0 / m) * m, ar = Math.ceil(r0 / m) * m;
    const S = new Set();
    for (let r = ar; r <= r1; r += m) for (let q = aq; q <= q1; q += m) S.add(q + ',' + r);
    return { S, m, mD };
  };
  const MW = 216, MH = 141;                            // 与 #minimap 的 CSS 尺寸同尺寸
  const cam = { x: G.hexW * (-51 + 133 / 2), y: 1.5 * G.hexR * 133 };
  const cell = cellsOf(MW, MH, cam.x, cam.y, wpp);
  let misaligned = 0, bad = 0;
  const hist = new Map();
  for (const k of cell.S) {
    const p = k.split(','), q = Number(p[0]), r = Number(p[1]);
    if (q % cell.m !== 0 || r % cell.m !== 0) { misaligned++; continue; }
    const fl = MG.fields(q, r);
    const b = fl && typeof fl.biome === 'number' ? fl.biome : -1;
    if (b < 0 || b > 7) { bad++; continue; }
    const col = (G.biomeMeta[b] || {}).color || '?';
    hist.set(col, (hist.get(col) || 0) + 1);
  }
  check(`原始样本格全部落在 rawM=${cell.m} 的整数倍上 (世界对齐 · 块层 mD=${cell.mD} · 错位 ${misaligned})`,
    misaligned === 0, String(misaligned));
  check(`自算地形样本全部落在群系 0..7 (越界 ${bad})`, bad === 0, String(bad));
  check(`前端自算地形画出多种地形色 (实测 ${hist.size} 种)`, hist.size >= 3,
    `仅 ${hist.size} 种 → 抽样/上色公式可疑`);
  /* 全覆盖: 视图内任取一格, 其**显示块**的子格样本必须全被枚举 ⇒ 不会成片「未探测」。
     U4 起块色由 AGG_DIV² 个子格样本表决 ⇒ 缺子格就只能退回角点单点样本 (椒盐的来源)。 */
  const subKeys = (q, r) => {
    const aq = Math.floor(q / cell.mD) * cell.mD, ar = Math.floor(r / cell.mD) * cell.mD, out = [];
    if (cell.mD < aggDiv) { out.push(aq + ',' + ar); return out; }
    const ck = Math.floor(cell.mD / aggDiv);
    for (let j = 0; j < aggDiv; j++) for (let i = 0; i < aggDiv; i++) out.push((aq + i * ck) + ',' + (ar + j * ck));
    return out;
  };
  let hole = 0, probe = 0;
  for (let y = 0; y < MH; y += 3) {
    for (let x = 0; x < MW; x += 3) {
      const t = MC.pxToTile(cam.x + (x - MW / 2) * wpp, cam.y + (y - MH / 2) * wpp);
      probe++;
      for (const k of subKeys(t.q, t.r)) if (!cell.S.has(k)) { hole++; break; }
    }
  }
  check(`视图内每格所属显示块都有全部 ${aggDiv * aggDiv} 个子格样本 (探针 ${probe} 点, 空洞 ${hole})`,
    hole === 0, `${hole} 空洞`);
  /* 复用率: 视图微动后抽样格集合必须高度重合 —— 这是「平移/缩放不再打回未探测」的核心契约 */
  const reuse = (c2) => { let n = 0; for (const k of cell.S) if (c2.S.has(k)) n++; return n / cell.S.size; };
  const panR = reuse(cellsOf(MW, MH, cam.x + 6, cam.y, wpp));
  const zoomR = reuse(cellsOf(MW, MH, cam.x, cam.y, wpp * 1.05));
  check(`视图平移 6 世界单位后抽样格复用率 ${(panR * 100).toFixed(1)}% (要求 >=90%)`,
    panR >= 0.90, `${(panR * 100).toFixed(1)}%`);
  check(`视图缩放 5% 后抽样格复用率 ${(zoomR * 100).toFixed(1)}% (要求 >=90%)`,
    zoomR >= 0.90, `${(zoomR * 100).toFixed(1)}%`);

  /* ---------- U4: 金字塔多数表决 (块色 = 块内多数地貌) ----------
     病征: 块色取「块角点单点样本」⇒ m>=4 时一个 m×m 区块只有 1 个格点参与决策,
     混合地貌区的相邻块各取各的角点 ⇒ 椒盐噪点 (用户/wpp=12 远缩档肉眼可见)。
     口径: cell(mD) = AGG_DIV² 个 cell(mD/AGG_DIV) 子格的众数 ⇒ 块色 = 块内多数地貌。
     本段钉死: ① 模块确实带多数表决 (AGG_DIV/rawLevelOf/aggOf/失效钩子);
              ② 原始样本层公式 (直接取模块源码求值, 不信测试里另抄的副本);
              ③ 数值: 与「块内 mD×mD 原生格真值多数」的一致率必须显著高于角点单点。 */
  check('U4 模块含多数表决三件套 (AGG_DIV/rawLevelOf/aggOf/aggInvalidate + 装配到位)',
    aggDiv === 2 && !!rawLevelOfMod && mm.includes('function aggOf') &&
    mm.includes('function aggInvalidate') && /aggInvalidate\(q, r\)/.test(mm) &&
    /rawM = rawLevelOf\(m\)/.test(mm), '缺多数表决');
  if (rawLevelOfMod) {
    const exp = { 1: 1, 2: 1, 4: 2, 8: 4, 16: 8, 32: 16 };
    const badLv = Object.keys(exp).filter((k) => rawLevelOfMod(Number(k)) !== exp[k]);
    check(`U4 原始样本层 = 块层/${aggDiv} (1→1 2→1 4→2 8→4 16→8 32→16; 错 ${badLv.length})`,
      badLv.length === 0, badLv.map((k) => k + '→' + rawLevelOfMod(Number(k))).join(' '));
  }
  {
    const modeOf = (a) => {
      const c = new Map();
      for (const b of a) c.set(b, (c.get(b) || 0) + 1);
      let best = a[0], bn = -1;
      c.forEach((n, b) => { if (n > bn) { bn = n; best = b; } });
      return best;
    };
    const fb = (q, r) => { const f = MG.fields(q, r); return f && typeof f.biome === 'number' ? f.biome : -1; };
    let agreeA = 0, agreeB = 0, tot = 0;
    for (const mD of [4, 8]) {
      const half = mD >> 1, N = 20;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const aq = (-60 + i) * mD, ar = (-60 + j) * mD, all = [];
          for (let y = 0; y < mD; y++) for (let x = 0; x < mD; x++) all.push(fb(aq + x, ar + y));
          const truth = modeOf(all);
          tot++;
          if (fb(aq, ar) === truth) agreeA++;
          if (modeOf([fb(aq, ar), fb(aq + half, ar), fb(aq, ar + half), fb(aq + half, ar + half)]) === truth) agreeB++;
        }
      }
    }
    const ppA = agreeA / tot * 100, ppB = agreeB / tot * 100;
    check(`U4 多数表决的块色更接近真值 (${tot} 块: 角点单点 ${ppA.toFixed(1)}% → 多数表决 ${ppB.toFixed(1)}%`
      + `, 提升 ${(ppB - ppA).toFixed(1)}pp, 要求 >=3pp)`, ppB - ppA >= 3, `提升仅 ${(ppB - ppA).toFixed(1)}pp`);
  }

  /* ---------- R13: 面板档倍率 (与大地图恒定比例 / 持久化 / 可拖可缩) ----------
     用户口径: 「左下角地图应该可以设置倍率, 放大后可以拉动, 保存和地图一直的大小比例」。
     口径 = 面板上屏 wpp 由「基准 baseWpp」与主相机 zoom 反比推出 ⇒ 小图/大图的世界长度比
     是常数, 主图缩放时小图同比例跟动。下面把该契约钉死 (改公式必须同步本段)。 */
  const mmS = strip(mm);
  /* 只看 curView 的函数体 (模块里 viewPanel 的初值可以合法地用 FOLLOW_WPP) */
  const cvAt = mmS.indexOf('function curView');
  const clAt = mmS.indexOf('function canvasLogical', cvAt);
  const cvSeg = cvAt < 0 ? '' : mmS.slice(cvAt, clAt < 0 ? cvAt + 400 : clAt);
  check('面板档 wpp 不再写死 (curView 走 panelWppNow, 由 zoom 反比推出)',
    cvAt >= 0 && cvSeg.includes('panelWppNow()') && !/wpp:\s*FOLLOW_WPP/.test(cvSeg) &&
    mmS.includes('baseWpp * DEFAULT_ZOOM / z'),
    cvAt < 0 ? '未见 curView' : 'curView 仍写死 FOLLOW_WPP');
  check('面板倍率持久化 (localStorage zongmen.mmView + load/save)',
    /LS_KEY\s*=\s*'zongmen\.mmView'/.test(mmS) &&
    mmS.includes('localStorage.setItem') && mmS.includes('localStorage.getItem'),
    '缺持久化');
  check('面板档可滚轮缩放 + 可拖动平移 (拖过阈值 ⇒ 自动转自由视角)',
    /canvas\.addEventListener\('wheel'/.test(mmS) &&
    /dragPanel\s*=\s*\{/.test(mmS) && /followCam = false/.test(mmS),
    '缺面板档滚轮/拖动');
  check('面板档 跟随↔自由 有归心出口 (拖出去必须能回来)',
    /followCam = true/.test(mmS) && html.includes('data-mm="recenter"'), '缺归心');
  check('全屏档倍率同样持久化 (fullWpp 入档)',
    /fullWpp:/.test(mmS) && /viewFull\.wpp = clamp\(viewFull\.wpp \* f/.test(mmS));
  /* 数值契约: 小图px/世界px ÷ 大图px/世界px = 1/(baseWpp × DEFAULT_ZOOM) —— 与 zoom 无关。
     这是「保存和地图一直的大小比例」唯一可执行的口径 (两个不同 zoom 比值必须相等)。 */
  const dZoom = Number((mm.replace(/\/\*[\s\S]*?\*\//g, ' ').match(/DEFAULT_ZOOM\s*=\s*([\d.]+)/) || [])[1]) || 2.2;
  const pw = (z) => wpp * dZoom / z;          // wpp(此处=FOLLOW_WPP) 即默认 baseWpp
  const ratio = (z) => (1 / pw(z)) / z;
  const r1 = ratio(0.9), r2 = ratio(5.1);
  check(`面板倍率与主相机缩放恒为常数比 (zoom 0.9→5.1 不变, 大图:小图 = ${(1 / r1).toFixed(2)}:1)`,
    Math.abs(r1 - r2) / r1 < 1e-9, `比值漂移 ${r1} vs ${r2}`);
  check('面板 wpp 覆盖主相机全档位 (0.7~6) 且不越界 [0.30, 48]',
    [0.7, 2.2, 6].every((z) => pw(z) >= 0.30 && pw(z) <= 48),
    [0.7, 2.2, 6].map((z) => z + '→' + pw(z).toFixed(2)).join(' '));
}

/* 色板契约: 五行/异灵根配色由 meta 单点下发 (elementRGB/variantRGB), 客户端优先读取
   (main.js 的 geoElementColor/geoVariantColor; 那里的字面量仅作 meta 缺失兜底)。
   —— 此前前后端各存一份副本、靠人工同步, 改色板必漂移。
   本检查: ① 断言 meta 的色板与 Engine/js/mapgen.js 导出的 ELEMENT_RGB/VARIANT_RGB
   逐值相同 (即「服务端 → meta」这一跳没丢值/没改名);
   ② 源码守卫: main.js 必须优先取 geo.elementRGB / geo.variantRGB (防被改回硬编码副本)。 */
async function checkPalettes() {
  const m = await MC.fetchMeta();
  global.window = globalThis;
  if (!global.MapGen) {                       // 与 verify_map 同款: 在 Node 里加载同份引擎作参照
    for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
      (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
    }
  }
  const MG = global.MapGen;
  const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

  const eRef = MG.ELEMENT_RGB;
  check('meta.elementRGB 为 5 项 (金木水火土)', Array.isArray(m.elementRGB) && m.elementRGB.length === 5,
    JSON.stringify(m.elementRGB));
  check('meta.elementRGB 与 mapgen.ELEMENT_RGB 逐值相同',
    Array.isArray(m.elementRGB) && m.elementRGB.length === eRef.length && m.elementRGB.every((c, i) => eq(c, eRef[i])),
    JSON.stringify(m.elementRGB));

  const vRef = MG.VARIANT_RGB, vKeys = Object.keys(vRef);
  check(`meta.variantRGB 与 mapgen.VARIANT_RGB 逐键逐值相同 (${vKeys.join('/')})`,
    !!m.variantRGB && Object.keys(m.variantRGB).length === vKeys.length &&
    vKeys.every((k) => eq(m.variantRGB[k], vRef[k])), JSON.stringify(m.variantRGB));

  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'main.js'), 'utf8');
  check('main.js geoElementColor 优先取 geo.elementRGB (源码守卫)',
    /function geoElementColor[\s\S]{0,220}?geo\.elementRGB/.test(src), '疑似改回硬编码副本');
  check('main.js geoVariantColor 优先取 geo.variantRGB (源码守卫)',
    /function geoVariantColor[\s\S]{0,220}?geo\.variantRGB/.test(src), '疑似改回硬编码副本');
}

/* 解码字段契约: 前端对解码结构的属性读取必须落在解码器产出的字段集内。
   —— 这正是 N11 当时的 bug 类别 (小地图读 `mmData.q1/r1`, 而 `/api/map/fields` 从未下发
   q1/r1 → 恒 undefined → 越界判断恒假 → 小地图自上线起一直是空框)。
   只扫「变量名无歧义」的 4 类 (resp/cm/st/lr), 歧义名 (m/g/rg/v 会被当作 meta/字段网格/
   内层对象等复用) 跳过以免误报; cm.elementRGB 与 st._anc 是客户端本地 memo 字段, 白名单放行。 */
function checkDecodedFieldAccess() {
  const pb = fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8');
  /* 抽出一个 decode/parse 函数的产出字段集: 既含对象字面量初值, 也含 m.xxx = 赋值 */
  const fieldsOf = (fn) => {
    const m = pb.match(new RegExp('function ' + fn + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}'));
    if (!m) return null;
    const body = m[1], s = new Set();
    for (const o of body.matchAll(/\{\s*([a-zA-Z_$][\w$]*\s*:[^{}]*?)\}/g))
      for (const kv of o[1].split(',')) {
        const k = kv.split(':')[0].trim();
        if (/^[a-zA-Z_$][\w$]*$/.test(k)) s.add(k);
      }
    for (const a of body.matchAll(/\bm\.([a-zA-Z_$][\w$]*)\s*(?:=|\.push)/g)) s.add(a[1]);
    return s;
  };
  const shapes = {
    resp: fieldsOf('decodeTileResponse'),
    cm: fieldsOf('decodeCommMsg'),
    st: fieldsOf('parsePlaceEntity'),
    lr: fieldsOf('decodeLoginResponse'),
  };
  check('解码字段集解析成功 (resp/cm/st/lr)',
    Object.values(shapes).every((s) => s && s.size >= 3),
    Object.entries(shapes).map(([k, v]) => `${k}=${v ? v.size : 'null'}`).join(' '));

  /* st._anc = 聚落匾额水平锚点的**客户端 memo** (main.js 在首次绘制时按地块算好并缓存,
     见 `if (!st._anc) { ... st._anc = {x,y} }`), 与 cm.elementRGB 同类: 非服务端下发字段。
     st._fac / st._facV = R6b (B)「归属势力」的缓存与版本号 (main.js factionOf), 同类。 */
  const whitelist = { cm: new Set(['elementRGB']), resp: new Set(), st: new Set(['_anc']), lr: new Set() };
  /* ⚠ `_` 前缀 = 本项目的「客户端本地 memo」约定: 线路字段 (protobuf) 一律不带下划线前缀,
     故 `_xxx` 只可能是前端自己挂上去的缓存 ⇒ 按前缀整体放行, 不必每加一个缓存就改白名单
     (这类误报已发生两次: _anc, 然后 _fac/_facV)。带下划线的**拼写错**不会被漏掉 ——
     线路字段没有下划线, 所以 `st._type` 这种错法本来就不在审计范围内。 */
  const isLocalMemo = (prop) => prop.charCodeAt(0) === 95;      // 95 = '_'
  const bad = [];
  let used = 0;
  for (const f of ['main.js', 'mapclient.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8');
    for (const mm of src.matchAll(/\b(resp|cm|st|lr)\.([a-zA-Z_$][\w$]*)/g)) {
      const [, obj, prop] = mm;
      used++;
      if (!shapes[obj] || shapes[obj].has(prop) || whitelist[obj].has(prop) || isLocalMemo(prop)) continue;
      bad.push(`${f}:${obj}.${prop}`);
    }
  }
  check(`前端对解码结构的 ${used} 处属性读取全部有对应字段`,
    bad.length === 0, [...new Set(bad)].sort().join(' '));
}

/* ============================================================
 * S1~S3 源码守卫: 「地形块前端自算」的结构不变量
 * ------------------------------------------------------------
 * 这些是**结构**约束 (谁被允许 eval / 谁被允许 init / 掩码运算有几处),
 * 靠跑用例是测不出来的 —— 只能扫源码。全部基于「去注释后的代码行」,
 * 否则文档注释里的示例代码会被误当成真实调用 (engine-local.js 的注释里
 * 就写着 `MapGen.init()` 作解释)。
 * 行为级证据在 verify/check_calc_local.mjs (真浏览器 3 档); 两者互补。
 * ============================================================ */
function checkCalcLocal() {
  const files = JSFILES;
  const code = JSSRC;
  const countIn = (re) => {
    let n = 0; const hit = [];
    for (const f of files) {
      const m = code[f].match(new RegExp(re.source, 'g'));
      if (m) { n += m.length; hit.push(f + '×' + m.length); }
    }
    return { n, where: hit.join(' ') };
  };

  /* ① 掩码运算全站唯一 (防有人另起炉灶写第二个「去 CHUNK 位」的地方) */
  {
    const r = countIn(/PB\.MASK\.ALL\s*&\s*~PB\.MASK\.CHUNK/);
    check('「去掉 CHUNK 位」的掩码运算全站仅 1 处 (' + (r.where || '无') + ')',
      r.n === 1 && /main\.js/.test(r.where), r.where);
  }
  /* ② 唯一 eval 点: 引擎脚本体只允许在 engine-local.js 里 eval。
        ⚠ 别把 mapclient.js 算进来 —— 它是**传输层提供方** (requestScript 定义在此),
          允许它取脚本; 不允许的是「谁 eval / 谁直接摸 window.MapGen」。 */
  {
    const r = countIn(/\(0,\s*eval\)/);
    check('间接 eval 全站仅 1 处且在 engine-local.js (' + (r.where || '无') + ')',
      r.n === 1 && /engine-local\.js/.test(r.where), r.where);
    const bad = files.filter((f) => f !== 'engine-local.js' &&
      (/\(0,\s*eval\)/.test(code[f]) ||
       /\b(?:window|g|globalThis)\s*\.\s*MapGen\b/.test(code[f])));
    check('其它前端文件不再自 eval / 不直接取 window.MapGen (只经 EngineLocal)',
      bad.length === 0, bad.join(' '));
  }
  /* ③ 唯一 init(seed) 点: MapGen.init 会清空引擎全部缓存, 双 init ⇒ 4× 冷算 */
  {
    const INIT_RE = /(^|[^\w.$])(MG|MapGen|engine)\s*\.\s*init\s*\(/;
    const r = countIn(INIT_RE);
    check('MapGen 的 init(seed) 全站仅 1 处且在 engine-local.js (' + (r.where || '无') + ')',
      r.n === 1 && /engine-local\.js/.test(r.where), r.where);
    const mm = code['minimap-vein.js'];
    check('minimap-vein.js 已不再自行 eval / 不再自行 init(seed)',
      !/\(0,\s*eval\)/.test(mm) && !INIT_RE.test(mm) && /EngineLocal/.test(mm));
  }
  /* ④ 加载顺序: engine-local.js 必须先于两个消费者 (否则取不到 window.EngineLocal,
        表现为小地图地形层永远「未探测」+ 主视图退回服务端下发) */
  {
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const at = (s) => html.indexOf(s);
    const iE = at('js/engine-local.js'), iM = at('js/minimap-vein.js'), iMain = at('js/main.js');
    check('index.html: engine-local.js 先于 minimap-vein.js 与 main.js 引入',
      iE > 0 && iE < iM && iE < iMain, `engine=${iE} mm=${iM} main=${iMain}`);
  }
  /* ⑤ 请求掩码形参: MC.block 必须能按块指定 mask (S3), 且缺省回落到全量 (老调用点不炸) */
  {
    const mc = code['mapclient.js'];
    check('mapclient: block() 支持 mask 形参并缺省回落全量',
      /function\s+block\s*\([^)]*mask/.test(mc) && /mask\s*==\s*null\s*\?\s*PB\.MASK\.ALL/.test(mc));
    check('main.js: 请求块时按档位传掩码 (第 4 实参)',
      /MC\.block\(\s*gen\s*,\s*job\.ca\s*,\s*job\.cb\s*,\s*mask\s*\)/.test(code['main.js']));
  }
  /* ⑥ 首请求闸门: 引擎定案前不发块请求 (否则首帧那 concChunk 个请求会带 mask=31 出去,
        服务端白算白发整块地形 —— 实测 chunkPkts=4) */
  {
    const m = code['main.js'];
    check('main.js: 首请求闸门存在 (CALC.settled 未定前 pumpChunks 直接返回)',
      /if\s*\(!CALC\.settled\)\s*return;/.test(m) && /settled\s*:\s*QSC\.get\('calc'\)\s*===\s*'server'/.test(m));
    check('main.js: 闸门有看门狗兜底 (setTimeout 放行, 不会永久挂起首屏)',
      /setTimeout\(\s*settle\s*,/.test(m));
  }
  /* ⑦ S4 握手接线: meta 指纹必须被读入并参与漂移判定 */
  {
    const m = code['main.js'];
    check('main.js: 读入 meta.engineHash 并做漂移判定 (S4)',
      /noteEngineHash\(MC\.engineHash\(\)\)/.test(m) && /verifyHash\(/.test(m));
    check('mapclient: 暴露 engineHash() 读取口', /engineHash:\s*engineHash/.test(code['mapclient.js']));
  }
}

/* ============================================================
 * 匾额/名牌落点对齐 · 源码守卫 (C-a / C-c / D, 2026-09-15)
 * ------------------------------------------------------------
 * 语义断言 (落点是否真落在建筑格 / 签位是否等于峰尖 / 文案格式) 在
 * verify/check_plaque_align.mjs —— 那里裸 eval vein-skin.js + bldg_ink.js 后逐值对拍。
 * 本函数只查**接线**: 三份前端文件是否还残留"第二份公式 / 旧拼接 / 旧档位数组"。
 * 分工理由: 语义改了接线没改 = 静默走老路径 (用户看到的就是"又对不上了"),
 *   而接线断了语义再多断言也跑不到。两边缺一不可。
 * ============================================================ */
function checkPlaqueAlign() {
  const code = JSSRC;
  const m = code['main.js'] || '', r = code['renderer.js'] || '', v = code['vein-skin.js'] || '';
  const mv = code['minimap-vein.js'] || '';

  /* ① 灵脉签位真源唯一: main.js veinTopU 必须转调 VS.tipU */
  {
    const body = (m.match(/function veinTopU\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
    check('main.js veinTopU 转调 VS.tipU (不自写第二份 H 公式)',
      /VS\.tipU/.test(body), body ? '未调 VS.tipU' : '函数体未匹配');
    check('main.js veinTopU 体内无内联 H 公式残留 (3.3+1.2 / hScale / sizeScale)',
      !!body && !/3\.3\s*\+\s*1\.2/.test(body) && !/hScale/.test(body) && !/sizeScale/.test(body));
  }

  /* ② 海报落点真源唯一: bldgAnchor 走 BI.anchorOf, 且无建筑不缓存 */
  {
    const body = (m.match(/function bldgAnchor\s*\([^)]*\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    check('main.js bldgAnchor 走 BI.anchorOf (不再自拼"中心格 x + p25 y"合成点)',
      /BI\.anchorOf/.test(body), body ? '未调 BI.anchorOf' : '函数体未匹配');
    const ls = body.split('\n');
    const gi = ls.findIndex((l) => /if\s*\(\s*!an\s*\)/.test(l));
    const si = ls.findIndex((l) => /_anc\s*=\s*an/.test(l));
    check('main.js bldgAnchor 无建筑时不落缓存 (守卫在赋值之前)',
      gi >= 0 && si > gi && !/_anc/.test(gi >= 0 ? ls[gi] : ''));
    const b = code['bldg_ink.js'] || '';
    check('bldg_ink.js 暴露 anchorOf 且带 real 字段 (真格 / 旧包围盒两路)',
      /anchorOf\s*:\s*anchorOf/.test(b) && /real\s*:\s*true/.test(b) && /real\s*:\s*false/.test(b),
      'bldg_ink 缺 anchorOf 导出或 real 两路');
  }

  /* ③ 引线终点 == 落点 (点不动、只抬签) */
  {
    const body = (m.match(/function drawNameBanner\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
    check('drawNameBanner: 引线 moveTo(x,bottomY)→lineTo(x,anchorY) 且圆点在 (x,anchorY)',
      /moveTo\(\s*x\s*,\s*bottomY\s*\)/.test(body) && /lineTo\(\s*x\s*,\s*anchorY\s*\)/.test(body) &&
      /arc\(\s*x\s*,\s*anchorY\s*,/.test(body));
    check('drawNameBanner: bottomY = anchorY - lead - gap (抬签不抬点)',
      /bottomY\s*=\s*anchorY\s*-\s*lead\s*-\s*\(\s*opt\.gap\s*\|\|\s*0\s*\)/.test(body));
  }

  /* ④ 文案真源唯一: 三处消费点都走 VS.label, 无 '灵脉·' 旧拼接, 无手写档位数组 */
  {
    const n = [m, r, v, mv].filter((s) => /['"]灵脉\u00B7['"]|['"]灵脉·['"]/.test(s)).length;
    check('四份前端文件均无 `\'灵脉·\'` 旧拼接 (文案真源在 VS.label)', n === 0,
      n + ' 处');
    const arr = [m, r, v, mv].filter((s) => /VEIN_LEVEL\s*=\s*\[/.test(s)).length;
    check('四份前端文件均无手写档位名数组 `VEIN_LEVEL = [`', arr === 0, arr + ' 处');
    check('vein-skin.js 暴露 label / tipU (文案 + 签位两个真源出口)',
      /label:\s*veinLabel/.test(v) && /tipU:\s*tipU/.test(v));
    check('main.js 灵脉名牌走 veinLabel() 而非内联拼接',
      /veinLabels\.push\([\s\S]{0,220}veinLabel\(/.test(m));
  }

  /* ⑤ 镜常量 coreElev == 引擎 LIFT_CORE 的**接线**检查在此不做 (引擎不在本脚本内);
        这里只钉"tipU 用它兜海拔"与"LEVELS 里逐档都有" */
  {
    check('vein-skin.js 每档都有 coreElev 且 tipU 在海拔未到货时使用它',
      (v.match(/coreElev\s*:/g) || []).length >= 4 && /lv\.coreElev/.test(v));
    check('vein-skin.js levelInfo 越界返 null (不再静默归一化成「大」)',
      /return \(n >= 0 && n < LEVELS\.length\) \? LEVELS\[n\] : null/.test(v));
  }

  /* ⑥ renderer.js 的 GLSL 不许硬编码判档阈值 */
  {
    check('renderer.js GLSL 无硬编码判档阈值 (走 E_MTN/S_MTN/E_SNOW/S_SNOW)',
      !/iElev\s*-\s*0\.70/.test(r) && !/iElev\s*-\s*0\.84/.test(r) &&
      !/ve\s*-\s*0\.70/.test(r) && !/ve\s*-\s*0\.84/.test(r) &&
      /E_SNOW/.test(r) && /S_MTN/.test(r));
    check('renderer.js 大世界山/雪峰/底座共用 VEIN_SHAPE 同一组常量',
      /MTN_LO\s*=\s*VEIN_SHAPE\.mtnLo/.test(r) && /SNOW_HI\s*=\s*VEIN_SHAPE\.snowHi/.test(r) &&
      /E_MTN\s*=\s*VEIN_SHAPE\.elevMtn/.test(r));
  }
}

console.log('== 元信息 ==');
await fetchMeta();

const seed = '42';
console.log(`\n== HTTP 辅助接口模拟前端 (seed=${seed}) ==`);
await fetchTile(seed, 0, 0);
await fetchTile(seed, 5, -3);
await fetchTile(seed, -8, 7);

/* HTTP tile 缓存头已改 no-cache (内容随 roadVer 变), 顺带断言不再给长缓存 */
{
  const r = await fetch(BASE + '/api/map/tile?seed=42&q=0&r=0');
  const cc = r.headers.get('cache-control') || '';
  check('tile 响应头不再含 max-age 长缓存', !/max-age=(?!0)/.test(cc), cc);
}

console.log('\n== 几何公式往返 ==');
checkGeometry();

console.log('\n== DOM id 契约 ==');
checkDomIds();

console.log('\n== 静态层置脏契约 ==');
checkStaticDirtyContract();

console.log('\n== 小地图契约 ==');
await checkMinimap();

console.log('\n== 色板契约 ==');
await checkPalettes();

console.log('\n== 地形前端自算源码守卫 (S1~S4) ==');
checkCalcLocal();

console.log('\n== 匾额/名牌落点对齐源码守卫 (C-a / C-c / D) ==');
checkPlaqueAlign();

console.log('\n== 解码字段契约 ==');
checkDecodedFieldAccess();

console.log(`\n========== 前端模拟: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);
