/* ============================================================
 * frontend_smoke.mjs — 在 Node 中「完整模拟前端」数据流
 *   直接复用 web/js/pb.js + web/js/mapclient.js (与浏览器同份) 拉取
 *   /api/map/* 后解码, 验证元信息常量 + 几何往返 + HTTP 侧数据还原, 不依赖浏览器/GL。
 *
 *   注: chunk/region/comm 在 WebSocket 单块重构后已下线 HTTP 接口,
 *       其数据正确性由 verify_map.mjs (WS 链路) / w1_client_revs.mjs 覆盖;
 *       本脚本只负责「HTTP 辅助接口 (meta/tile/fields) + 几何公式」这一层。
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

async function fetchFields(seed, q0, q1, r0, r1) {
  const g = await MC.fieldGrid(seed, q0, q1, r0, r1);
  check(`fields 网格大小`, g.nq === q1 - q0 + 1 && g.nr === r1 - r0 + 1, `${g.nq}x${g.nr}`);
  check(`fields data 字节数`, g.data.length === g.nq * g.nr, String(g.data.length));
  return g;
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
  /* 1) 运行时改写 showVeins/showLabels (排除 `var showX = <初值>` 声明) 必须邻近置脏 */
  for (const m of src.matchAll(/\b(showVeins|showLabels)\s*=/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    if (/\bvar\b/.test(src.slice(lineStart, m.index))) continue;      // 声明, 跳过
    const near = src.slice(Math.max(0, m.index - 200), m.index + 500);
    if (!/StaticDirty\s*\(/.test(near))
      bad.push(`${m[1]}@L${src.slice(0, m.index).split('\n').length}`);
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

/* 小地图契约: /api/map/fields 的响应键必须是 { q0, r0, nq, nr, d } ——
   客户端由 q0+nq-1 / r0+nr-1 推上界。**历史上这里出过真实 bug**: 客户端曾直接读
   mmData.q1/mmData.r1 (服务端从未下发这两个键 → 恒 undefined) → 越界判断恒假
   → 小地图自上线起一直是均匀兜底色 (#b9ad92) 的空框, 从未显示过地形。
   本检查做两件事: ① 数据契约 —— 用真实 fields 响应复算一遍像素上色, 必须真的
   画出多种地形色 (证明「服务端数据足以绘制 + 索引公式正确」);
   ② 源码守卫 —— main.js 不得再引用不存在的 mmData.q1/r1。 */
async function checkMinimap() {
  const G = MC.geo();
  const cam = { x: G.hexW * (-51 + 133 / 2), y: 1.5 * G.hexR * 133 };   // 与 shot.mjs 默认视野同参数
  const W = 132, H = 88, SCALE = 6;
  const x0 = cam.x - W / 2 * SCALE, y0 = cam.y - H / 2 * SCALE;
  const x1 = cam.x + W / 2 * SCALE, y1 = cam.y + H / 2 * SCALE;
  const a = MC.pxToTile(x0, y0), b = MC.pxToTile(x1, y1);
  const c = MC.pxToTile(x0, y1), d = MC.pxToTile(x1, y0);
  const q0 = Math.min(a.q, b.q, c.q, d.q), q1 = Math.max(a.q, b.q, c.q, d.q);
  const r0 = Math.min(a.r, b.r, c.r, d.r), r1 = Math.max(a.r, b.r, c.r, d.r);
  const g = await MC.fieldGrid('42', q0, q1, r0, r1);
  check('fields 响应含 q0/r0/nq/nr/d (客户端上色所需)',
    g.q0 === q0 && g.r0 === r0 && g.nq === q1 - q0 + 1 && g.nr === r1 - r0 + 1,
    JSON.stringify({ q0: g.q0, r0: g.r0, nq: g.nq, nr: g.nr }));
  check('fields 不含 q1/r1 (客户端须自行推上界)',
    g.q1 === undefined && g.r1 === undefined, `q1=${g.q1} r1=${g.r1}`);

  const hiQ = g.q0 + g.nq - 1, hiR = g.r0 + g.nr - 1;
  const hist = new Map();
  let outside = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const t = MC.pxToTile(cam.x + (px - W / 2) * SCALE, cam.y + (py - H / 2) * SCALE);
      let disp = -1;
      if (t.q >= g.q0 && t.q <= hiQ && t.r >= g.r0 && t.r <= hiR) {
        disp = g.data[(t.r - g.r0) * g.nq + (t.q - g.q0)];
      }
      if (disp < 0) outside++;
      const col = disp < 0 ? '#b9ad92' : (G.biomeMeta[disp] || { color: '#b9ad92' }).color;
      hist.set(col, (hist.get(col) || 0) + 1);
    }
  }
  check(`小地图采样 0 落空 (实测 ${outside}/${W * H})`, outside === 0, `${outside} 像素落在窗口外`);
  check(`小地图画出多种地形色 (实测 ${hist.size} 种)`, hist.size >= 3, `仅 ${hist.size} 种 → 疑似又退回空框`);

  const src = fs.readFileSync(path.join(ROOT, 'web', 'js', 'main.js'), 'utf8');
  /* 先剥注释再判断 — 否则「解释这个 bug」的注释本身会被误判为仍在引用 (不是 `"//"` 在 URL 里的场景: 前一字符为冒号则跳过) */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1');
  check('main.js 不再引用不存在的 mmData.q1/r1 (源码守卫)',
    !/mmData\.q1|mmData\.r1/.test(code), '仍在使用 mmData.q1/mmData.r1');
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
   内层对象等复用) 跳过以免误报; cm.elementRGB 是客户端本地 memo 字段, 白名单放行。 */
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

  const whitelist = { cm: new Set(['elementRGB']), resp: new Set(), st: new Set(), lr: new Set() };
  const bad = [];
  let used = 0;
  for (const f of ['main.js', 'mapclient.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'js', f), 'utf8');
    for (const mm of src.matchAll(/\b(resp|cm|st|lr)\.([a-zA-Z_$][\w$]*)/g)) {
      const [, obj, prop] = mm;
      used++;
      if (!shapes[obj] || shapes[obj].has(prop) || whitelist[obj].has(prop)) continue;
      bad.push(`${f}:${obj}.${prop}`);
    }
  }
  check(`前端对解码结构的 ${used} 处属性读取全部有对应字段`,
    bad.length === 0, [...new Set(bad)].sort().join(' '));
}

console.log('== 元信息 ==');
await fetchMeta();

const seed = '42';
console.log(`\n== HTTP 辅助接口模拟前端 (seed=${seed}) ==`);
await fetchTile(seed, 0, 0);
await fetchTile(seed, 5, -3);
await fetchTile(seed, -8, 7);
await fetchFields(seed, -10, 10, -10, 10);

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

console.log('\n== 解码字段契约 ==');
checkDecodedFieldAccess();

console.log(`\n========== 前端模拟: ${failures === 0 ? '全部通过 ✔' : failures + ' 项失败 ✘'} ==========`);
process.exit(failures === 0 ? 0 : 1);
