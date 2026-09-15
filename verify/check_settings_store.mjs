/* ============================================================
 * check_settings_store.mjs — 全局存储组件 ZMStore 契约 (离线 Node, 不需起服务/浏览器)
 * ------------------------------------------------------------
 * 背景 (2026-09-16 用户):
 *   ① 「seed 由服务器统一产生, 不能通过前端产生了, 存在 sqlite 里面的」
 *   ② 「右上角改成一个齿轮…点开后有弹窗, 显示是否显示名字之类的, 存在 localStorage
 *       里面方便下次读取, 这里要做个全局组件用来存东西的」
 *
 * 本脚本钉两件事 (都不需要浏览器):
 *   A. **store.js 的真行为** —— 把 web/js/store.js 原样 eval 进一个可控的假 window
 *      (自带可控 localStorage 桩), 逐条跑: 默认值 / 读写 / 白名单 / 幂等 / 订阅 /
 *      坏 JSON / 非布尔历史值 / 无 localStorage 降级 / 通用分区 / 节流落盘。
 *      ⚠ 必须真跑源码而不是"照着注释断言" —— 这类小模块最容易改坏 (它是全站唯一
 *        持久化出口, 一处 return 写错就是"设置永远存不上/永远存不住")。
 *   B. **接线守卫** —— index.html / main.js / 服务端三处的关键契约:
 *      · index.html 先引 store.js, 且只留一枚齿轮 (旧 7 个控件已清除)
 *      · 弹窗复选框 data-zm 集合 == ZMStore.defaults 键集合 (加开关漏一处立刻红灯)
 *      · main.js **不再**有前端造种子的指纹 (Date.now()%1e8), 改走 /api/world/*
 *      · showVeins/showLabels 的写点仍在 (frontend_smoke 的置脏契约靠它们)
 *
 * 用法: node verify/check_settings_store.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const JSDIR = path.join(WEB, 'js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

const SRC_STORE = fs.readFileSync(path.join(JSDIR, 'store.js'), 'utf8');
const SRC_MAIN = fs.readFileSync(path.join(JSDIR, 'main.js'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');

/* 词法级去注释 (字符串 + **正则字面量**感知)。
   ⚠ 仓库里 check_fish_skin/check_faction/frontend_smoke 用的那份"去注释器"只认引号,
     main.js 里的 `/[&<>"]/g` (esc() 的转义表) 会把它带进"字符串状态" ⇒ 之后整段
     状态错位、**块注释不再被剥掉**。症状是"文档注释里写过的旧实现指纹"被当成真代码
     (本轮 B6a 就踩了: 注释里引用了旧 `Date.now()%1e8` 便被判红)。
   本版按"上一个有效字符能否结束表达式"判定正则起始 (`/[&<>"]/g` 的前一字符是 `(` ⇒ 正则;
   `a / b` 的前一字符是变量名 ⇒ 除号), 于是注释一律能剥干净。 */
function stripComments(src) {
  let out = '', i = 0, st = null, prev = '';
  const n = src.length;
  const canStartRegex = () => !/[\w$)\]}]/.test(prev);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st) {
      out += c;
      if (c === '\\') { out += (d || ''); i += 2; continue; }
      if (c === st) st = null;
      i++; continue;
    }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && canStartRegex()) {          // 正则字面量: 原样保留 (内部引号不算字符串)
      out += c; i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += ch + (src[i + 1] || ''); i += 2; continue; }
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '\n') break;
        else if (ch === '/' && !inClass) { out += ch; i++; break; }
        out += ch; i++;
      }
      prev = '/'; continue;
    }
    if (c === "'" || c === '"' || c === '`') { st = c; out += c; i++; prev = c; continue; }
    if (!/\s/.test(c)) prev = c;
    out += c; i++;
  }
  return out;
}
const MAIN_NC = stripComments(SRC_MAIN);

/* ============================================================
 * A. store.js 真行为 (可控假 window + localStorage 桩)
 * ============================================================ */
/* localStorage 桩: 可计数写入次数 (验节流)、可注入"写就抛" (验无痕模式降级) */
function makeLS(opts = {}) {
  const map = new Map();
  if (opts.seed) for (const [k, v] of Object.entries(opts.seed)) map.set(k, v);
  return {
    writes: 0,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (opts.throwOnWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      this.writes++; map.set(k, String(v));
    },
    removeItem(k) { map.delete(k); },
    _dump() { return Object.fromEntries(map); }
  };
}
/* 每个用例都拿一个**全新的模块实例** (store.js 里有模块级状态 settings/subs/节流句柄) */
function loadStore(opts = {}) {
  const listeners = {};
  const timers = [];
  const g = {
    localStorage: opts.noLocalStorage ? undefined : makeLS(opts),
    document: { hidden: false },
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }
  };
  /* 无 localStorage 的仿真: 取属性即抛 SecurityError (Safari 无痕/file:// 的真实行为) */
  if (opts.noLocalStorage) {
    Object.defineProperty(g, 'localStorage', { get() { throw new Error('SecurityError'); } });
  }
  vm.createContext(g);
  vm.runInContext(SRC_STORE, g, { filename: 'store.js' });
  return { ZM: g.ZMStore, g, timers, listeners,
           /* 手动排空"节流定时器" (不等真实时间) */
           flushTimers() { for (const t of timers) if (!t.cleared) t.fn(); } };
}

function runBehavior() {
  /* A1 默认值: 五个开关全开 */
  {
    const { ZM } = loadStore();
    const d = ZM.settings.all();
    check('A1 默认值: 五个开关齐全且全开',
      Object.keys(ZM.defaults).length === 5 &&
      ['veins', 'nameSettle', 'nameVein', 'nameRegion', 'clouds'].every((k) => d[k] === true),
      JSON.stringify(d));
  }

  /* A2 读写 + 幂等: 同值再写不广播、不落盘 */
  {
    const t = loadStore();
    let n = 0, last = null;
    t.ZM.settings.on((k, v) => { n++; last = [k, v]; });
    const first = t.ZM.settings.set('nameSettle', false);
    const again = t.ZM.settings.set('nameSettle', false);
    check('A2a set 生效 (true→false 返回 true, 再写同值返回 false)',
      first === true && again === false && t.ZM.settings.get('nameSettle') === false);
    check('A2b 订阅只被真变化唤醒一次 (幂等写不空转)', n === 1 && last[0] === 'nameSettle' && last[1] === false,
      'n=' + n + ' last=' + JSON.stringify(last));
    check('A2c 订阅第三个参数是整份设置的快照 (含刚改的值)',
      t.ZM.settings.all().nameSettle === false && t.ZM.settings.all().veins === true);
    const off = t.ZM.settings.on(() => {});
    off();
    t.ZM.settings.set('clouds', false);
    check('A2d on() 返回的退订函数真的退订', n === 2, 'n=' + n);
  }

  /* A3 白名单: schema 外的键必须静默拒绝且不落盘 */
  {
    const t = loadStore();
    const r = t.ZM.settings.set('typoKey', true);
    t.ZM.settings.flush();
    const dumped = JSON.parse(t.g.localStorage.getItem(t.ZM.SETTINGS_KEY) || '{}');
    check('A3 白名单外键被拒绝 (set 返回 false 且不写进存储)',
      r === false && !('typoKey' in dumped), JSON.stringify(dumped));
  }

  /* A4 历史脏值: 非布尔 → 回落默认; 未知键 → 丢弃 */
  {
    const t = loadStore({ seed: {} });
    const key = 'zongmen.settings.v1';
    t.g.localStorage.setItem(key, JSON.stringify({ veins: 'no', clouds: 0, zombie: 1, nameVein: false }));
    const d = t.ZM.settings.all();
    check('A4a 非布尔的历史值回落默认 (只认 boolean)',
      d.veins === true && d.clouds === true && d.nameVein === false,
      JSON.stringify(d));
    check('A4b 历史数据里的未知键不进内存 (白名单单点收口)',
      !('zombie' in d), JSON.stringify(d));
  }

  /* A5 坏 JSON 不炸 */
  {
    const t = loadStore();
    t.g.localStorage.setItem('zongmen.settings.v1', 'not json{{');
    let threw = null;
    try { t.ZM.settings.all(); } catch (e) { threw = e.message; }
    check('A5a 存储里是坏 JSON 时回落默认且不抛', threw === null && t.ZM.settings.get('veins') === true,
      String(threw));
    check('A5b set 后能把坏值覆盖成合法 JSON', (() => {
      t.ZM.settings.set('veins', false); t.ZM.settings.flush();
      try { return JSON.parse(t.g.localStorage.getItem('zongmen.settings.v1')).veins === false; }
      catch (e) { return false; }
    })());
  }

  /* A6 节流: 连续写只落盘一次; flush 强写 */
  {
    const t = loadStore();
    t.ZM.settings.set('veins', false);
    t.ZM.settings.set('clouds', false);
    const before = t.g.localStorage.writes;
    t.flushTimers();
    const after = t.g.localStorage.writes;
    check('A6a 连续两次 set 合并为一次落盘 (节流)',
      before === 0 && after === 1, 'before=' + before + ' after=' + after);
    t.ZM.settings.set('clouds', true);
    const w0 = t.g.localStorage.writes;
    t.ZM.settings.flush();
    check('A6b flush 绕过节流立刻落盘 (离开页面不丢最后一次改动)',
      t.g.localStorage.writes === w0 + 1 && t.g.localStorage.writes === 2,
      'writes=' + t.g.localStorage.writes);
    check('A6c 落盘内容 == 内存值',
      JSON.parse(t.g.localStorage.getItem(t.ZM.SETTINGS_KEY)).clouds === true);
  }

  /* A7 无 localStorage 环境 (无痕 / file://): 不抛, 会话内仍生效 */
  {
    const t = loadStore({ noLocalStorage: true });
    let threw = null;
    try {
      t.ZM.settings.set('veins', false);
      t.ZM.settings.flush();
      t.ZM.read('cam', null);
      t.ZM.write('cam', { x: 1 });
      t.ZM.clear('cam');
    } catch (e) { threw = e.message; }
    check('A7 无 localStorage 时全部 API 不抛 (当次会话内设置仍生效)',
      threw === null && t.ZM.persistent() === false && t.ZM.settings.get('veins') === false,
      String(threw));
  }

  /* A8 写抛异常 (配额满/无痕 Safari): 内存态照样更新, 只是不落盘 */
  {
    const t = loadStore({ throwOnWrite: true });
    let threw = null;
    try { t.ZM.settings.set('nameRegion', false); t.ZM.settings.flush(); } catch (e) { threw = e.message; }
    check('A8 落盘抛异常被吞 (内存值仍然更新, 界面不会因此卡死)',
      threw === null && t.ZM.settings.get('nameRegion') === false, String(threw));
  }

  /* A9 通用分区 (给"记住相机/上次轮次"之类用) */
  {
    const t = loadStore();
    const w = t.ZM.write('cam', { x: 12, y: -3 });
    const r = t.ZM.read('cam', null);
    const raw = t.g.localStorage.getItem('zongmen.cam');   // ⚠ clear 之前取: clear 就是删这个键
    const miss = t.ZM.read('nope', 'DEF');
    t.ZM.clear('cam');
    check('A9a 通用分区 write/read 往返一致 (键名带 zongmen. 前缀)',
      w === true && r && r.x === 12 && r.y === -3 && raw === '{"x":12,"y":-3}',
      'raw=' + raw);
    check('A9b 未写过的分区返回默认值; clear 后读回默认',
      miss === 'DEF' && t.ZM.read('cam', 'DEF') === 'DEF');
  }

  /* A10 键名带版本 (换语义时靠升版本让旧键自然失效, 不写迁移代码) */
  {
    const { ZM } = loadStore();
    check('A10 设置键名带版本号 (zongmen.settings.v1)',
      ZM.SETTINGS_KEY === 'zongmen.settings.v1' && ZM.PREFIX === 'zongmen.');
  }

  /* A11 toggle */
  {
    const { ZM } = loadStore();
    ZM.settings.toggle('veins');
    const a = ZM.settings.get('veins');
    ZM.settings.toggle('veins');
    check('A11 toggle 取反并可复原', a === false && ZM.settings.get('veins') === true);
  }
}

/* ============================================================
 * B. 接线守卫 (index.html / main.js)
 * ============================================================ */
function runWiring() {
  /* B1 store.js 必须在 main.js 之前加载 (main.js 顶层就要 new/取用它) */
  const iStore = SRC_INDEX.indexOf('js/store.js');
  const iMain = SRC_INDEX.indexOf('js/main.js');
  check('B1 index.html 引 store.js 且排在 main.js 之前',
    iStore > 0 && iMain > iStore, 'store@' + iStore + ' main@' + iMain);
  check('B2 main.js 顶层取用 window.ZMStore 并在缺失时明确报错 (不静默降级)',
    /var S = window\.ZMStore;/.test(MAIN_NC) && /缺少 web\/js\/store\.js/.test(MAIN_NC));

  /* B3 齿轮取代旧控件: 旧 id 一个不剩 */
  const gone = ['seedInput', 'btnSeed', 'btnVeins', 'btnLabels', 'btnBanners', 'btnClouds']
    .filter((id) => SRC_INDEX.includes('id="' + id + '"') || MAIN_NC.includes("'" + id + "'"));
  check('B3 旧控件 (手输种子/山河重铸/四个图层按钮) 已从 HTML 与 JS 中清除',
    gone.length === 0, gone.join(','));
  check('B4 右上角只剩齿轮按钮 (btnGear) + 设置弹窗挂载点',
    SRC_INDEX.includes('id="btnGear"') && SRC_INDEX.includes('id="settingsWrap"') &&
    SRC_INDEX.includes('id="settingsBox"') && /openSettings\(/.test(MAIN_NC));

  /* B5 弹窗复选框 == schema 键集合 (加开关只改两处; 漏一处红灯) */
  const dn = [...SRC_INDEX.matchAll(/data-zm="([^"]+)"/g)].map((m) => m[1]);
  const schema = [...SRC_STORE.matchAll(/^\s{4}(\w+):\s*(true|false)/gm)].map((m) => m[1]);
  const dnSet = new Set(dn), scSet = new Set(schema);
  const onlyHtml = dn.filter((k) => !scSet.has(k));
  const onlySchema = schema.filter((k) => !dnSet.has(k));
  check('B5 弹窗复选框与 ZMStore.defaults 键集合完全一致 (' + schema.length + ' 项)',
    dn.length === schema.length && onlyHtml.length === 0 && onlySchema.length === 0,
    'HTML 多: ' + onlyHtml.join(',') + ' / schema 多: ' + onlySchema.join(','));

  /* B6 服务端是种子唯一来源: main.js 不得再自造种子 */
  check('B6a main.js 不再有前端造种子的指纹 (Date.now()%1e8)',
    !/Date\.now\(\)\s*%\s*100000000/.test(MAIN_NC));
  check('B6b main.js 只向 /api/world/current 领世、POST /api/world/next 开世',
    /worldFetch\('\/api\/world\/current'\)/.test(MAIN_NC) &&
    /worldFetch\('\/api\/world\/next',\s*'POST'\)/.test(MAIN_NC));
  check('B6c 取不到种子时**不回落到前端自造** (报致命错, 不伪装成正常开局)',
    /未能从服务器取得世界种子/.test(MAIN_NC) && /showFatal\(/.test(MAIN_NC));
  check('B6d ?seed= 调试覆盖仍在册 (verify/*.mjs 的定点验收依赖它)',
    /urlParams\.get\('seed'\)/.test(MAIN_NC) && /src: 'url'/.test(MAIN_NC));

  /* B7 渲染变量仍由 store 单向驱动; frontend_smoke 的置脏契约靠这两个写点 */
  /* ⚠ 只钉「映射关系」，**不钉局部变量名**：main.js 里读 store 的局部名是 `sv` 而非 `st`
     —— `st.` 是 frontend_smoke「解码字段契约」硬编码的聚落结构禁区名，用 st 会另报真红。 */
  check('B7a applySettings 把 store 五项映射到渲染变量',
    /showVeins = \w+\.veins;/.test(MAIN_NC) && /showLabels = \w+\.nameRegion;/.test(MAIN_NC) &&
    /showBanners = \w+\.nameSettle;/.test(MAIN_NC) && /showVeinName = \w+\.nameVein;/.test(MAIN_NC) &&
    /showClouds = \w+\.clouds;/.test(MAIN_NC));
  check('B7b 复选框只往 store 写 (单一数据流: UI → store → applySettings → 渲染)',
    /S\.settings\.set\(this\.getAttribute\('data-zm'\), this\.checked\)/.test(MAIN_NC) &&
    /S\.settings\.on\(applySettings\)/.test(MAIN_NC));
  check('B7c 灵脉名独立成开关 (showVeinName 只判自己, 不再与聚落名同受 showBanners)',
    /if \(showVeinName && z >= 0\.85\)/.test(MAIN_NC) && !/if \(showBanners && z >= 0\.85\)/.test(MAIN_NC));
  check('B7d 调试参数 (nobanner/nocloud) 压过持久化偏好',
    /if \(NO_BANNER_URL\) \{ showBanners = false; showVeinName = false; \}/.test(MAIN_NC) &&
    /if \(NO_CLOUD_URL\) showClouds = false;/.test(MAIN_NC));

  /* B8 灵脉签五行淡染: 纸签本体不动, 颜色附在上面 (两道着色) */
  const banner = (SRC_MAIN.match(/function drawNameBanner\s*\([^)]*\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  check('B8a 灵脉签仍复用同一路径 fill (染在纸签之上, 中间不 beginPath)',
    /if \(opt\.tint\) \{[\s\S]*?createLinearGradient\(0, -bh, 0, 0\)[\s\S]*?ctx\.fill\(\);\s*\}/.test(banner));
  check('B8b 五行色先向纸色提亮再薄染 (VEIN_WASH_MIX + 纸色常量)',
    /mixRGB\(opt\.tint, VEIN_PAPER, VEIN_WASH_MIX\)/.test(banner) &&
    /var VEIN_PAPER = \[247, 239, 219\]/.test(SRC_MAIN));
  check('B8c 签脚色条用**本色** (对应的颜色的落款处)',
    /rgba\(' \+ opt\.tint\[0\] \+ ',' \+ opt\.tint\[1\] \+ ',' \+ opt\.tint\[2\] \+ ',0\.86\)/.test(banner));
  check('B8d 签顶淡/签底浓 (两段渐变, 仍像一块受光的纸)',
    /VEIN_WASH_A0/.test(banner) && /VEIN_WASH_A1/.test(banner) &&
    /VEIN_WASH_A0 = 0\.30, VEIN_WASH_A1 = 0\.46/.test(SRC_MAIN));

  /* B9 探针齐备 (headless 判据的读点) */
  check('B9 __feat 暴露世界事实与设置载体 (worldRound/worldSeed/worldSrc/settingsStore)',
    /worldRound: worldRound, worldSeed: worldSeed, worldSrc: worldSrc/.test(MAIN_NC) &&
    /settingsStore: S\.settings\.all\(\)/.test(MAIN_NC));
  check('B10 __feat 分别暴露聚落名/灵脉名/区域名三个开关位 + 灵脉签计数',
    /nameSettleOn: showBanners, nameVeinOn: showVeinName, nameRegionOn: showLabels/.test(MAIN_NC) &&
    /veinBanners: statVeinBanner/.test(MAIN_NC));
  check('B11 调试: ?set=1 开局展开设置弹窗 (headless 无法点齿轮)',
    /urlParams\.get\('set'\) === '1'\) openSettings\(true\)/.test(MAIN_NC));
}

console.log('== check_settings_store (ZMStore 行为 + 世界种子接线) ==\n');
runBehavior();
console.log('\n-- 接线守卫 --');
runWiring();
console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
process.exit(failures ? 1 : 0);
