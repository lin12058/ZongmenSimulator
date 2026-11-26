/* ============================================================
 * check_js_exports.mjs — 「每个 JS 出口都要在对应 Invoke switch 有 case」铁律守卫
 * ------------------------------------------------------------
 * 背景 (审查 C11):
 *   `domainRadius` / `archetypeOf` / `bumpRoadVer` 在 mapgen-server.js 里**早就定义**,
 *   但 WorldModule.Invoke 的 switch 一直没它们 ⇒ 任何人 `Call("domainRadius", ...)`
 *   都是**运行时** InvalidOperationException → HTTP 500, **编译期一个字都不报**。
 *   这类缺口只能静态扫出来, 靠运行期发现等于等线上。
 *
 * 三条断言 (双向, 任一向都不得空真):
 *   A. **case → JS 实体存在**: 每个 case 臂右值里真正调用的 `root.<m>(` /
 *      `script.<E>.<m>(` 必须在对应 JS 全局对象上**是函数**。
 *      （防 C# 拼错 / JS 改名删函数 —— 一样是运行期 500）
 *   B. **Call 点 → case 存在**: 全部 `*.cs` 里 `.(Vm|vm).Call("<name>", ...)`
 *      的 name 必须在「三张 switch 的 case 键集 ∪ OnVmReady/RoadVersion 的晚绑定集」里。
 *      （这就是 C11 那类 bug 的正向守卫）
 *   C. **JS 公开出口 → case 或显式内部**: 每个模块涉及的 JS 全局对象上, 所有
 *      **函数型导出**要么有 case, 要么在晚绑定集, 要么在 INTERNAL 白名单里。
 *      （防「新加了 JS 出口忘了接 case」；白名单 = 纯计算辅助, 加一条要回来登记）
 *      反向也查: 白名单里的名字**不许**同时有 case (否则白名单是过期的, 会盖住未来回归)。
 *
 * 口径说明:
 *   - 注释一律**先剥离**再扫 (C# 的 `//` 与 `/* *\/`, 且尊重字符串字面量 —— 否则
 *     WorldModule.cs 里那句说明注释 `Call("domainRadius"/"archetypeOf"/...)` 会假红)。
 *   - 「晚绑定集」不写死: 从各模块 `.cs` 里 `script.<E>.<m>(` 出现在 switch **之外**
 *     的部位自动扣出来 (= OnVmReady / RoadVersion 这类生命周期钩子)。
 *   - 解析失败/臂数异常一律 FAIL, 不许静默跳过 (反空真)。
 *
 * 用法: node verify/check_js_exports.mjs     (任意 cwd 可跑; rc=0 通过, rc=1 失败)
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const E = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const CITYJS = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'js');
const CHARJS = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'Characters', 'js');
const SRV = path.join(ROOT, 'Server', 'Zongmen');

let failures = 0;
let warns = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}
function warn(name, detail = '') { warns++; console.log('  WARN ' + name + (detail ? '  ← ' + detail : '')); }

/* ---------------- JS 侧: 载入 bundle, 取全局对象 ---------------- */
global.window = globalThis;
const JS_FILES = [
  path.join(E, 'noise.js'),
  path.join(E, 'mapgen-config.js'),
  path.join(E, 'mapgen.js'),
  path.join(E, 'mapgen-server.js'),
  path.join(CITYJS, 'city-evo.js'),
  /* 跨 tick 事件脚本（挂在 global.CityEvo 上，必须在 city-evo.js 之后求值）。
     ⚠ 不加载它 ⇒ `CityEvo.eventScriptJson` 是 undefined ⇒ 本节会假红。 */
  path.join(CITYJS, 'city-events.js'),
  path.join(CHARJS, 'chargen-core.js'),
];
for (const f of JS_FILES) {
  if (!fs.existsSync(f)) { console.log('  FAIL 缺 JS 文件 ' + f); failures++; }
  else (0, eval)(fs.readFileSync(f, 'utf8'));
}
/* 实体名 → 全局对象 (与 C# 里 `script.<Entity>` 的写法逐字对应) */
const ENTITIES = {
  MapGenServer: global.MapGenServer,
  CityEvo: global.CityEvo,
  CultivatorGen: global.CultivatorGen,
};
const ENTITY_SRC = {
  MapGenServer: fs.existsSync(path.join(E, 'mapgen-server.js'))
    ? fs.readFileSync(path.join(E, 'mapgen-server.js'), 'utf8') : '',
  CityEvo: (fs.existsSync(path.join(CITYJS, 'city-evo.js'))
    ? fs.readFileSync(path.join(CITYJS, 'city-evo.js'), 'utf8') : '')
    /* 事件脚本也挂在 CityEvo 上 ⇒ 它们同样是「本模块的公开出口」，必须一起纳入出口集，
       否则守卫 C 看不见 `eventScriptJson`（漏检方向是静默的，比假红更糟）。 */
    + (fs.existsSync(path.join(CITYJS, 'city-events.js'))
      ? fs.readFileSync(path.join(CITYJS, 'city-events.js'), 'utf8') : ''),
  CultivatorGen: fs.existsSync(path.join(CHARJS, 'chargen-core.js'))
    ? fs.readFileSync(path.join(CHARJS, 'chargen-core.js'), 'utf8') : '',
};

/* ---------------- C# 侧: 剥注释 ---------------- */
/** 剥掉 C# 的 // 与 /* *\/ 注释; 尊重 "..." / '...' / @"..." / $"..." 字面量。 */
function stripCs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      /* 前置 @ / $ 已在上一轮原样写入, 这里只处理引号体内 */
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\' && q === '"' && src[i - 1] !== '@') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const MODULES = [
  { label: '世界层', file: 'Engine/WorldModule.cs', def: 'MapGenServer' },
  { label: '城市层', file: 'Subsystems/City/CityModule.cs', def: 'CityEvo' },
  { label: '角色层', file: 'Subsystems/Characters/CharactersModule.cs', def: 'CultivatorGen' },
];

const caseKeys = new Set();      /* 三张 switch 的 case 键全集 (`.Call` 用的就是它) */
const invokedPairs = new Set();  /* 实际被调用的 "<实体>.<方法>" (根治 mangle: cultivatorOneJson → oneJson) */
const latePairs = new Set();     /* 晚绑定 (OnVmReady / RoadVersion) 的 "<实体>.<方法>" */
const lateNames = new Set();     /* 晚绑定的方法名 (给 B 兜底) */
const lateDetail = [];
let totalArms = 0;

console.log('== A. case → JS 实体存在 (右值真实调用目标必须在 JS 上是函数) ==');
for (const m of MODULES) {
  const abs = path.join(SRV, m.file);
  if (!fs.existsSync(abs)) { check(`${m.label} 文件存在`, false, abs); continue; }
  const raw = fs.readFileSync(abs, 'utf8');
  const src = stripCs(raw);

  /* 定位 switch 块: `fn switch` 之后到 `_ => throw` 之前 */
  const start = src.indexOf('fn switch');
  const end = src.indexOf('_ => throw');
  if (start < 0 || end < 0 || end < start) {
    check(`${m.label} switch 块可定位`, false, '未找到 "fn switch" / "_ => throw"');
    continue;
  }
  const block = src.slice(start, end);
  const arms = [];
  for (const line of block.split('\n')) {
    const km = line.match(/^\s*"([A-Za-z_]\w*)"\s*=>/);
    if (!km) continue;
    const rhs = line.slice(line.indexOf('=>') + 2);
    /* 优先 script.<E>.<m>(, 否则 root.<m>( */
    const sm = rhs.match(/script\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/);
    const rm = rhs.match(/\broot\.([A-Za-z_]\w*)\s*\(/);
    if (sm) arms.push({ key: km[1], entity: sm[1], js: sm[2] });
    else if (rm) arms.push({ key: km[1], entity: m.def, js: rm[1] });
    else arms.push({ key: km[1], entity: null, js: null });
  }
  check(`${m.label} switch 解析出 case 臂`, arms.length >= 3, `arms=${arms.length}`);

  for (const a of arms) {
    caseKeys.add(a.key);
    if (!a.entity) { check(`${m.label} "${a.key}" 右值可解析出调用目标`, false, '既非 script.E.m( 也非 root.m('); continue; }
    const obj = ENTITIES[a.entity];
    if (!obj) { check(`${m.label} "${a.key}" 的实体 ${a.entity} 存在`, false, '无此全局对象'); continue; }
    invokedPairs.add(`${a.entity}.${a.js}`);
    check(`${m.label} "${a.key}" → ${a.entity}.${a.js} 是函数`,
      typeof obj[a.js] === 'function', typeof obj[a.js]);
  }
  totalArms += arms.length;

  /* 晚绑定: 全文件里 script.<E>.<m>( 但不在 switch 臂内的 = 生命周期钩子 */
  const armJs = new Set(arms.filter(x => x.entity).map(x => `${x.entity}.${x.js}`));
  const re = /script\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g;
  let mm;
  while ((mm = re.exec(src))) {
    const pair = `${mm[1]}.${mm[2]}`;
    if (armJs.has(pair)) continue;
    if (!latePairs.has(pair)) lateDetail.push(`${m.label}: ${pair}`);
    latePairs.add(pair);
    lateNames.add(mm[2]);
  }
}

console.log(`  -- 合计 case 臂 ${totalArms} 条, 晚绑定 ${[...lateNames].sort().join('/') || '(无)'}`);
check('case 臂总数 >= 35 (防解析器失效导致空真)', totalArms >= 35, `arms=${totalArms}`);
check('晚绑定集非空 (OnVmReady 的 init/setBase 应被扣出)', lateNames.size > 0, `size=${lateNames.size}`);

/* ---------------- B. Call 点 → case 存在 ---------------- */
console.log('== B. .Call("<name>") 的 name 必须在 case 键集 ∪ 晚绑定集 ==');
const csFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'obj' || e.name === 'bin') continue;
      walk(p);
    } else if (e.name.endsWith('.cs')) csFiles.push(p);
  }
})(SRV);

const callSites = new Map(); /* name → [relpath:line] */
for (const f of csFiles) {
  const src = stripCs(fs.readFileSync(f, 'utf8'));
  src.split('\n').forEach((line, idx) => {
    const re = /\.Call\(\s*"([A-Za-z_]\w*)"/g;
    let mm;
    while ((mm = re.exec(line))) {
      const arr = callSites.get(mm[1]) || [];
      arr.push(`${path.relative(ROOT, f)}:${idx + 1}`);
      callSites.set(mm[1], arr);
    }
  });
}
check('扫到 Call 调用点 (防正则失效)', callSites.size >= 15, `distinct=${callSites.size}`);
for (const [name, where] of [...callSites].sort()) {
  check(`Call("${name}") 有对应 case/晚绑定`, caseKeys.has(name) || lateNames.has(name),
    `无 case, 调用点 ${where.join(', ')}`);
}

/* ---------------- C. JS 公开出口 → case 或显式内部 ---------------- */
/* 白名单口径: 纯计算辅助, 只被同文件内部调用; 跨 VM 暴露没有意义
   (C# 只通过 JSON 出口拿数据, 不逐函数调)。
   ⚠ 新增一条必须回来登记, 并说明为什么不该有 case。 */
const INTERNAL = {
  CityEvo: [
    'attractivenessOf', 'computeK', 'craftOutput', 'crowdRateOf', 'evolveCity',
    'harvestAndBuild', 'landPrice', 'newCityState', 'planCityBuildings',
    'planOverflowOnly', 'resourcePrices', 'ringCells', 'selfCheck', 'spiritInfoOf',
  ],
  CultivatorGen: [
    'buildDict', 'buildPayload', 'clamp', 'fnv1a', 'gauss', 'generateBatch',
    'generateCharacter', 'getBase', 'hash01', 'indexBase', 'intNormal', 'isReady',
    'makeRng', 'personBrief', 'powerOf', 'splitSquads', 'truncNormal', 'weightedPick',
  ],
  MapGenServer: [],
};

/* 每个模块「涉及」的实体 = 默认实体 + 它臂里出现过的 script.<E> */
const touched = new Map(); /* entity → Set(label) */
for (const m of MODULES) {
  const abs = path.join(SRV, m.file);
  if (!fs.existsSync(abs)) continue;
  const src = stripCs(fs.readFileSync(abs, 'utf8'));
  const set = new Set([m.def]);
  const re = /script\.([A-Za-z_]\w*)\./g;
  let mm;
  while ((mm = re.exec(src))) if (ENTITIES[mm[1]]) set.add(mm[1]);
  for (const e of set) {
    const arr = touched.get(e) || [];
    arr.push(m.label);
    touched.set(e, arr);
  }
}

console.log('== C. JS 函数型导出 → case / 晚绑定 / 白名单 ==');
for (const [ent, labels] of [...touched].sort()) {
  const obj = ENTITIES[ent];
  check(`${ent} 全局对象存在 (被 ${labels.join('+')} 引用)`, !!obj);
  if (!obj) continue;
  const fnExports = Object.keys(obj).filter(k => typeof obj[k] === 'function').sort();
  check(`${ent} 函数型导出非空`, fnExports.length > 0, `n=${fnExports.length}`);
  const wl = new Set(INTERNAL[ent] || []);
  /* 白名单过期检查: 有了 case 还在白名单里 ⇒ 白名单会盖住未来回归 */
  for (const name of wl) {
    const pair = `${ent}.${name}`;
    check(`${ent}.${name} 白名单未过期 (不应同时有 case/晚绑定)`,
      !invokedPairs.has(pair) && !latePairs.has(pair),
      '已接进 switch 却还挂在 INTERNAL 白名单');
  }
  for (const name of fnExports) {
    const pair = `${ent}.${name}`;
    if (invokedPairs.has(pair) || latePairs.has(pair)) { check(`${ent}.${name} 有 case/晚绑定`, true); continue; }
    if (wl.has(name)) {
      /* 反死代码: 白名单条目必须在文件里被引用 >1 次 (声明 1 次 + 至少 1 次使用) */
      const src = ENTITY_SRC[ent] || '';
      const hits = (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length;
      if (hits < 2) warn(`${ent}.${name} 白名单但源码内仅 ${hits} 处引用 (对外只读访问器?)`, '');
      continue;
    }
    check(`${ent}.${name} 有 case / 晚绑定 / 白名单登记`, false,
      '新加了 JS 出口但没在 Invoke switch 接 case (C11 同类缺口)');
  }
  /* 白名单条目不许多余 (登记了不存在的名字) */
  for (const name of wl) check(`${ent}.${name} 白名单条目真实存在`, fnExports.includes(name));
}

/* ---------------- 汇总 ---------------- */
console.log('');
if (failures === 0) {
  console.log(`OK  js 出口守卫通过: case 臂 ${totalArms} 条 / 全局出口 ${[...touched.keys()].length} 个对象 / Call 点 ${callSites.size} 个名字 / 警告 ${warns} 条`);
  process.exit(0);
} else {
  console.log(`FAIL  js 出口守卫失败: ${failures} 条 (case 臂 ${totalArms} / Call 点 ${callSites.size} / 警告 ${warns})`);
  process.exit(1);
}
