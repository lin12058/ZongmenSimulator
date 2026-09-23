/* ============================================================
 * store.js — 全站**唯一**的本地持久化组件 (window.ZMStore)
 * ------------------------------------------------------------
 * 用户口径 (2026-09-16):
 *   「点开后有弹窗, 显示是否显示名字之类的, 存在 localStorage 里面方便下次读取,
 *     这里要做个全局组件用来存东西的」
 * ⇒ 设置项不再散落在 main.js 的 `var showX = true` 里, 也不再靠 `classList.toggle('off')`
 *   反推状态 (旧口径的"按钮外观即状态": 刷新即丢、加一项就要改三处)。
 *   现在: **一处声明 schema, 一处读写 API, 一处订阅**。
 *
 * 设计要点 (都被实际踩过, 不是想当然):
 *   1. **schema 白名单 + 默认值**。`set('typo', 1)` 静默失败 (返回 false), 不写进存储 ——
 *      否则 localStorage 会随版本演进取到一堆没人读的僵尸键, 且读的时候无法判断真假。
 *   2. **读路径绝不碰 localStorage**。启动时 load 一次进内存, 之后 get 只读内存副本 ——
 *      渲染每帧都要读开关 (showVeins / showClouds…), 逐帧 `localStorage.getItem` 是同步 I/O。
 *   3. **写路径节流**。连续拨几个开关合并成一次写 (默认 200ms), 但 `flush()` 可强写
 *      (离开页面时 `pagehide` 用, 免得节流窗口里的最后一次改动丢掉)。
 *   4. **坏数据不炸**。localStorage 里可能被别的页面/旧版本塞进非 JSON、被浏览器配额截断、
 *      或隐私模式下 setItem 直接抛 (Safari 无痕) —— 全部 try/catch, 退回默认值。
 *   5. **分区 (namespace)**。设置只是第一个用户; 「上次的相机/轮次缓存」这类东西将来也会用到,
 *      故通用读写 `read(ns, def)` / `write(ns, obj)` 一并给出, 键前缀统一 `zongmen.`。
 *
 * 用法:
 *   ZMStore.settings.get('nameSettle')      // true/false
 *   ZMStore.settings.set('nameSettle', false)
 *   ZMStore.settings.all()                  // { veins:true, … } 副本
 *   ZMStore.settings.on(function (k, v, all) { … })   // 返回退订函数
 *   ZMStore.read('cam', null) / ZMStore.write('cam', {x:1,y:2}) / ZMStore.clear('cam')
 *
 * ⚠ 与 minimap-vein.js 的 `zongmen.mmView` 的关系: 那个键由小地图模块自己管 (它在
 *   "可被单独替换"的契约里, 不该依赖本组件)。本组件只管**新增**的、跨模块共享的设置。
 * ============================================================ */
(function (g) {
  'use strict';

  var PREFIX = 'zongmen.';
  /* 版本号进键名: 将来 schema 变更(改语义/删项)时升到 v2, 老键自然失效并被忽略 ——
     比写"迁移代码"省事得多, 且不会把旧语义误读成新语义。 */
  var SETTINGS_KEY = PREFIX + 'settings.v1';
  var WRITE_THROTTLE_MS = 200;

  /* ---------------- 设置分区 ---------------- */
  /* 每一项 = 一个"是否显示/是否启用"开关。默认全开 (与旧版按钮初值一致)。
     ⚠ 加新开关时**只需在这里加一行** + 在页面上加一个 `<input data-zm="key">`,
       弹窗与存储会自动带上它 (逻辑见 main.js 的 applySettings / 弹窗渲染)。 */
  var DEFAULTS = {
    veins: true,        // 灵脉层: 峰体 / 地盘色环 / 灵气晕圈 / 七星花
    nameSettle: true,   // 聚落名: 城镇·宗门·景点的竖排纸签
    nameVein: true,     // 灵脉名: 灵脉签 (签面淡染五行色)
    nameRegion: true,   // 区域名: 山川注记淡字 (旧「注记」开关)
    clouds: true,       // 云气层
    /* 领地圈 (2026-09-23 玩家宗门放置方案 §4.4): 常显各聚落的**领地范围**
       (六边形, 半径 = 规模映射, 真源 = 服务端 CFG.DOMAIN_R 经 meta 下发)。
       默认关 —— 它回答的是「这里能不能立宗」, 属偶发需求而非常态信息。 */
    domain: false
  };

  var settings = null;          // 内存副本 (读路径只认它)
  var writeTimer = 0;           // 节流写句柄
  var subs = [];

  function localStorageOf() {
    /* file:// 下访问 localStorage 在有沙箱的浏览器里会抛 SecurityError —— 整个模块必须
       能在"没有 localStorage"的世界里静默降级 (当次会话内设置仍然生效)。 */
    try { return g.localStorage || null; } catch (e) { return null; }
  }

  function sanitize(raw) {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    if (raw && typeof raw === 'object') {
      for (var k2 in DEFAULTS) {
        if (typeof raw[k2] === 'boolean') out[k2] = raw[k2];   // 只认布尔; 其它类型一律回落默认
      }
    }
    return out;
  }

  function loadSettings() {
    if (settings) return settings;
    var raw = null, ls = localStorageOf();
    if (ls) {
      try { raw = JSON.parse(ls.getItem(SETTINGS_KEY)); } catch (e) { raw = null; }
    }
    settings = sanitize(raw);
    return settings;
  }

  function writeNow() {
    writeTimer = 0;
    var ls = localStorageOf();
    if (!ls) return false;
    try { ls.setItem(SETTINGS_KEY, JSON.stringify(loadSettings())); return true; }
    catch (e) { return false; }        // 配额满 / 无痕模式: 当次会话内仍然生效
  }

  function saveSettings() {
    if (writeTimer) return;
    writeTimer = setTimeout(writeNow, WRITE_THROTTLE_MS);
  }

  function emit(k, v) {
    var snap = allSettings();
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](k, v, snap); } catch (e) { /* 单个订阅者炸不影响别人 */ }
    }
  }

  function allSettings() {
    var s = loadSettings(), o = {};
    for (var k in s) o[k] = s[k];
    return o;
  }

  function getSetting(k) {
    var s = loadSettings();
    return Object.prototype.hasOwnProperty.call(s, k) ? s[k] : undefined;
  }

  function setSetting(k, v) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) return false;   // 白名单外: 静默拒绝
    var s = loadSettings();
    v = !!v;
    if (s[k] === v) return false;      // 无变化 ⇒ 不写盘不广播 (幂等, 免得订阅者被空转唤醒)
    s[k] = v;
    saveSettings();
    emit(k, v);
    return true;
  }

  function toggleSetting(k) {
    var cur = getSetting(k);
    return setSetting(k, cur === undefined ? DEFAULTS[k] : !cur);
  }

  function resetSettings() {
    settings = sanitize(null);
    writeNow();
    emit('*', null);
    return allSettings();
  }

  function onSettingsChanged(cb) {
    if (typeof cb !== 'function') return function () {};
    subs.push(cb);
    return function () {
      var i = subs.indexOf(cb);
      if (i >= 0) subs.splice(i, 1);
    };
  }

  /* ---------------- 通用分区 (给将来的"记住相机/上次轮次"之类用) ---------------- */
  function nsKey(ns) { return PREFIX + String(ns); }

  function readNs(ns, def) {
    var ls = localStorageOf();
    if (!ls) return def;
    try {
      var raw = ls.getItem(nsKey(ns));
      if (raw == null) return def;
      var v = JSON.parse(raw);
      return v == null ? def : v;
    } catch (e) { return def; }
  }

  function writeNs(ns, obj) {
    var ls = localStorageOf();
    if (!ls) return false;
    try { ls.setItem(nsKey(ns), JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }

  function clearNs(ns) {
    var ls = localStorageOf();
    if (!ls) return false;
    try { ls.removeItem(nsKey(ns)); return true; } catch (e) { return false; }
  }

  /* ---------------- 暴露 ---------------- */
  g.ZMStore = {
    PREFIX: PREFIX,
    SETTINGS_KEY: SETTINGS_KEY,
    defaults: DEFAULTS,               // 只读参考 (别改: sanitize 会以它为准)
    settings: {
      get: getSetting,
      set: setSetting,
      toggle: toggleSetting,
      all: allSettings,
      reset: resetSettings,
      on: onSettingsChanged,
      /* 强写 (绕过节流): 离开页面前用, 免得节流窗口内的最后一次改动丢 */
      flush: writeNow
    },
    read: readNs,
    write: writeNs,
    clear: clearNs,
    /* 自检: 存储层是否可用 (无痕/配额满 ⇒ false; 设置仍在会话内生效) */
    persistent: function () { return !!localStorageOf(); }
  };

  /* 离开页面时兜底强写 —— 只挂一次, 且不引入任何业务依赖 */
  if (g.addEventListener) {
    g.addEventListener('pagehide', function () { writeNow(); });
    g.addEventListener('visibilitychange', function () {
      try { if (g.document && g.document.hidden) writeNow(); } catch (e) { /* noop */ }
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
