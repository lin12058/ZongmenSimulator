/* ============================================================
 * main.js — 山河图主程序 (WebSocket 单块流式版)
 *  - 单块流式加载: 视野切块 → ws TileRequest → TileResponse 多图层
 *    子消息 (chunk/region/settle/poi/comm) 分发 (设计 §三)
 *  - 覆盖层: 道路/聚落/景点/区域/灵脉/浪线 全部基于后端下发数据绘制
 *  - 小地图: 独立模块 web/js/minimap-vein.js (R11) ——
 *    地形按 seed 前端自算 (引擎脚本经 WS 下发), 世界层全走 WS, 零 HTTP 轮询
 *  - 单格详情: HTTP 后端即时计算
 * ============================================================ */
(function () {
  'use strict';
  var MC = MapClient, IT = InkTextures, PB = window.PB;

  var els = {};
  var renderer = null;
  var worldSeed = '';
  var metaReady = false;
  var geo = null;

  var cam = { x: 0, y: 0, zoom: 2.2, tx: 0, ty: 0, tzoom: 2.2 };
  var minZoom = 0.7, maxZoom = 6;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  /* R10: 调试句柄门控 —— 仅 URL 带 debug=1 (或 capture=1 的 headless 验证) 时暴露,
     平时不向全局泄漏内部状态。 */
  var DEBUG = new URLSearchParams(location.search).get('debug') === '1' ||
              new URLSearchParams(location.search).get('capture') === '1';
  var hoverTile = null, selectedTile = null;
  /* 「点选」标记 (2026-09-14 九版): 玩家点击哪一格, 哪一格就落一枚朱砂圈 (取代原先
     「黑色加粗六边框」+ 「本宗自动择宗」两套东西)。null = 未点选 (开局图上没有任何标记)。 */
  var selMark = null;

  /* ============================================================
   * 显示开关 —— 唯一真源 = ZMStore (web/js/store.js, localStorage 持久化)
   * ------------------------------------------------------------
   * 2026-09-16 用户定案: 「右上角改成一个齿轮, 点开后有弹窗, 显示是否显示名字之类的,
   *   存在 localStorage 里面方便下次读取」。
   * 旧口径: `var showVeins = true` + 按钮靠 toggle('off') 类名表达状态 —— 状态住在**按钮外观**里,
   *   刷新即丢, 且"加一个开关要改三处"(HTML 按钮/变量/绑定)。现在: schema 在 store.js 一处,
   *   本文件只做「store → 渲染变量」的单向映射 (applySettings), 弹窗里的复选框由 data-zm 绑定。
   * ⚠ 变量名沿用旧的 (showVeins/showLabels/showBanners) —— frontend_smoke 的「静态层置脏契约」
   *   逐名扫描它们, 改名会静默丢掉那条守卫。语义:
   *     showVeins   ← veins       灵脉层 (峰体/地盘色环/晕圈/七星花)
   *     showLabels  ← nameRegion  区域名 (山川注记淡字; 旧「注记」按钮)
   *     showBanners ← nameSettle  聚落名 (纸签)
   *     showVeinName← nameVein    灵脉名 (纸签, 签面敷五行色) —— 新增: 灵脉签与村名常打架, 分开关
   *     showClouds  ← clouds      云气层
   * ============================================================ */
  var S = window.ZMStore;
  if (!S) throw new Error('缺少 web/js/store.js (全局存储组件) — index.html 里必须在本文件之前加载');
  var showVeins = true, showLabels = true;
  var showBanners = true, showVeinName = true, showClouds = true;
  /* headless 调试参数 (与 nofade/nobldg 同族, 只做 A/B 差分用):
       nobanner=1 → **所有**地名纸签关掉 (聚落名 + 灵脉名; 旧语义, 验收脚本在用)
       nocloud=1  → 云气关掉 (check_cloud_zoom 的同机位 A/B 靠它)
     ⚠ 它们的优先级**高于** localStorage: 调试参数必须是可复现的确定态, 不能被上一次
       会话里手点出来的偏好污染。 */
  var NO_BANNER_URL = new URLSearchParams(location.search).get('nobanner') === '1';
  var NO_CLOUD_URL = new URLSearchParams(location.search).get('nocloud') === '1';
  /* 建筑层开关 (headless 视觉验证用, 与 nofade/capture 同族):
     nobldg=1 → 不画建筑层, 同机位可与开启态做逐像素 A/B, 判定
     「建筑确实画上去了 / 画在哪里」。日常游玩不传此参数。 */
  var NO_BLDG = new URLSearchParams(location.search).get('nobldg') === '1';
  var BANNER_MAX = 90;          // 单帧匾额上限 (战略视图下防刷屏)

  /* ============================================================
   * 设置: ZMStore (真源) → 渲染变量 (单向) + 齿轮弹窗
   * ============================================================ */
  var settingsOpen = false;
  function applySettings() {
    /* ⚠ 局部名故意用 sv 而非 st: frontend_smoke 的「解码字段契约」把 `st.` 硬编码为
       parsePlaceEntity 产出的聚落结构, 复用 st 会被判成"读了不存在的线路字段"(真实红)。 */
    var sv = S.settings.all();
    showVeins = sv.veins;
    showLabels = sv.nameRegion;
    showBanners = sv.nameSettle;
    showVeinName = sv.nameVein;
    showClouds = sv.clouds;
    /* 调试参数压过持久化偏好 —— 见上面 NO_BANNER_URL 的注释 (调试态必须可复现) */
    if (NO_BANNER_URL) { showBanners = false; showVeinName = false; }
    if (NO_CLOUD_URL) showClouds = false;
    syncSettingInputs();
    /* 开关只改渲染变量、不碰相机 ⇒ 必须显式置脏: 否则相机静止时 staticNeedsRedraw()
       返回 false, 点了弹窗里的复选框要等下次平移才生效 (旧的按钮开关就踩过这个坑)。 */
    forceStaticDirty();
  }
  /* 把 store 的当前值刷到弹窗复选框上 (单向镜面)。
     ⚠ 绝不反向"从 HTML 读初值": 那会让 index.html 里的 checked 默认值变成第二真源,
       且两处互写必抖。UI 只是 store 的显示层。 */
  function syncSettingInputs() {
    var box = $('settingsBox');
    if (!box) return;
    var sv = S.settings.all();
    var ins = box.querySelectorAll('input[data-zm]');
    for (var i = 0; i < ins.length; i++) {
      var k = ins[i].getAttribute('data-zm');
      if (Object.prototype.hasOwnProperty.call(sv, k)) ins[i].checked = !!sv[k];
    }
  }
  function openSettings(open) {
    var wrap = $('settingsWrap');
    if (!wrap) return;
    settingsOpen = !!open;
    if (settingsOpen) syncSettingInputs();
    wrap.classList.toggle('hidden', !settingsOpen);
    $('btnGear').classList.toggle('on', settingsOpen);
  }
  /* 另启一世的按钮文案/禁用态 (领种子期间不给连点 —— 每次点击都是一次真实开界 + 落库) */
  function regenBusy(busy) {
    var b = $('btnRegen');
    if (!b) return;
    b.disabled = !!busy;
    b.textContent = busy ? '正在开辟…' : '另 启 一 世';
  }
  function setMsg(t) {
    var m = $('setMsg');
    if (m) m.textContent = t ? String(t) : '';
  }

  /* ============================================================
   * 世界 (W · 2026-09-16): 种子由**服务端**统一产生并存 SQLite
   * ------------------------------------------------------------
   * 旧口径: 前端 `String(Date.now() % 100000000)` 自造种子 —— 刷新即换界, 多端各看各的世界,
   *   服务端只能被动接受任意字符串当 seed (种子从来不是"资产", 只是一次请求的参数)。
   * 新口径: 客户端只「领当前世」(GET /api/world/current) 或「求下一世」(POST /api/world/next);
   *   服务端把每一世写进 db/zongmen.sqlite 的 World 表 ⇒ 刷新不掉世、重启不换界、多端同世界。
   * ⚠ `?seed=` 保留为**调试覆盖** (verify/*.mjs 的定点验收全靠它, 不能删): 命中时按
   *   "外部世界"处理 —— 不入账、不显示轮次, 弹窗里标成「URL 覆盖 (未入账)」。
   * ============================================================ */
  var worldRound = 0;          // 0 = 未入账 (URL 覆盖)
  var worldSrc = '';
  function worldFetch(url, method) {
    return fetch(url, { method: method || 'GET', cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
  }
  /* 把世界事实落到 UI 三处: 弹窗的轮次/种子/来历 + 题名下那行小字 + 齿轮 tooltip */
  function setWorldInfo(w) {
    worldRound = (w && w.round) ? w.round : 0;
    worldSrc = (w && w.src) ? w.src : ((w && w.kind) || '');
    var seed = (w && w.seed) || '-';
    var rEl = $('setRound'), sEl = $('setSeed'), srcEl = $('setSeedSrc'), eEl = $('eraRound');
    if (rEl) rEl.textContent = worldRound ? ('第 ' + worldRound + ' 世') : '未入账';
    if (sEl) sEl.textContent = seed;
    if (srcEl) {
      srcEl.textContent = worldSrc === 'url' ? 'URL 覆盖 (未入账)'
        : ((w && w.persisted === false) ? '服务端 · 仅内存' : '服务端台账');
    }
    if (eEl) eEl.textContent = worldRound ? (' · 第 ' + worldRound + ' 世') : '';
    var g = $('btnGear');
    if (g) g.title = '设置 · 显示项 / 世界' + (worldRound ? ('（第 ' + worldRound + ' 世 · 种子 ' + seed + '）') : '');
  }

  /* 地表让位开关 (headless A/B 用): noyield=1 → 不做「覆盖格抹平」, 同机位可
     逐像素对照「路/建筑处的树·山确实被抹掉了」。日常游玩不传。 */
  var NO_YIELD = new URLSearchParams(location.search).get('noyield') === '1';
  /* 云气不漂移 (headless A/B 用): 云毯默认随时间东移 ⇒ 两张图相隔数秒即天然有别,
     云气开关的差分会被"云自己移动"污染。加此参数把漂移钉死, 使 A/B 只反映云的有无。 */
  var NO_CLOUD_DRIFT = new URLSearchParams(location.search).get('noclouddrift') === '1';
  /* 云影关断 (headless A/B 用): noshadow=1 → 只画云不画影。云影是"软压暗",
     与云体自身的墨线压暗混在一起无法分辨 ⇒ A/B 时用它把"影"单独差出来。 */
  var NO_CLOUD_SHADOW = new URLSearchParams(location.search).get('noshadow') === '1';
  var cloudSprites = null;      // 云团变体 (boot 时由 InkTextures.buildClouds 产出)
  var cloudShadows = null;      // 云影 (同源轮廓的墨色软影, buildCloudShadows 产出)
  /* 灵脉皮肤配置 (web/js/vein-skin.js, index.html 里必须在本文件之前加载)。
     本文件只用它两处: ① 灵脉签的垂直锚点 (峰体高度 = 山地底座 + 灵脉峰);
     ② 山地底座倍率 shape.terrainBase (详见 PROP_VS 灵脉分支)。 */
  var VS = (typeof window !== 'undefined' && window.VeinSkin) || null;
  /* 档名兜底表: 档序与 vein-skin.js LEVELS[].key 一一对应 (0大/1中/2小/3从属)。
     ⚠ 只给下面 VS 缺失时的兜底分支用; 正常路径走 VS.label ⇒ 只有一份真源。
     从属格不进 comm.veins[], 列全只为防将来改口径时静默 undefined。 */
  var VEIN_LV_NAME = ['大', '中', '小', '从属'];
  /* 灵脉「呈示名」=「<地貌名>·<档>」。真源在 vein-skin.js 的 VS.label (三处消费点共用:
     匾额名牌 / 侧栏「灵脉」字段 / 小地图悬停提示), 这里只做缺失兜底 —— 免得各处
     再各写一份档名数组 (历史上 main.js 有两份、minimap-vein.js 有一份, 且长度不一)。
     ⚠ 旧写法 `v.name + '灵脉·' + 档` 会叠字 (金属矿脉 + 灵脉·大), 见 VS.label 注释。 */
  function veinLabel(v) {
    if (VS && VS.label) return VS.label(v, v.level);
    return ((v && v.name) ? v.name : '灵脉') + '·' + (VEIN_LV_NAME[v.level] || '小');
  }
  /* 匾额锚点调试层 (headless 定位「牌匾 vs 地物」用): plaqdbg=1
     绿=聚落中心 st.x/y · 黄=聚落格 tileToWorld(q,r) · 青=锚点(默认中位建筑) ·
     橙点=每个建筑格 · 品红=灵脉格心 · 青点=灵脉峰尖(签子实际落点)。日常游玩不传。 */
  var PLAQ_DBG = new URLSearchParams(location.search).get('plaqdbg') === '1';
  /* 聚落牌匾锚点规则的 A/B (headless 对拍用) —— **全部是历史档位**, 只留给对拍:
       ?ancgeo=1|box → 建筑包围盒中心 (初版)      ?ancgeo=col → 离聚落中心列最近 (一修)
       ?ancgeo=med   → 中位格 (二修)              ?ancgeo=sum → medoid (二修备选)
       ?ancgeo=densest (或 `?ancgeo=` 空值) → 最密格 (三/四修, 2026-09-16 之前的默认)
       **默认 (C-a 五修 2026-09-16) = 城市中心点** —— 直接读实体坐标 (st.x, st.y), 无求解器。
     ⚠ 用户口径 (2026-09-16): 「要和当前的城市的中心点位置一样, 而不是什么所谓的平均值
       或者什么参照物」。前四修全都在"用统计量去猜中心", 每一修都在给上一修的副作用打补丁
       (合成点 → 列最近 → 中位格 → 最密格+平手参照物); 中心本来就是**给定的**, 不是估的。
     ⚠ 为什么中心点就够: 引擎把**核心建筑** (祠堂/村口/宗祠/集市/官衙/祖师殿…) 恒定放在
       聚落中心格 (mapgen.js growTownFootprint 的 `cell.d === 0` 那一支) ⇒ 中心格上永远
       有一座真建筑 —— 它就是这聚落的中心, 也解释了"点悬在空地上"的原始病灶。
       于是锚点对建筑清单 (含远处农田/码头等离群地物) **恒等免疫**: 它根本不读清单。 */
  var ANC_GEO = (function () {
    var q = new URLSearchParams(location.search);
    if (!q.has('ancgeo')) return 'center';               // 缺省 = 城市中心点
    var v = q.get('ancgeo');
    if (v === '1' || v === 'box') return 'box';
    if (v === 'col') return 'col';
    if (v === 'med') return 'med';
    if (v === 'sum') return 'sum';
    if (v === '' || v === 'densest') return 'densest';
    return 'center';
  })();
  /* 灵脉签落点口径 (同一次口径订正):
       'center' (默认) = **灵山中心点** = 灵脉格心 (v.x, v.y) —— 地盘色环与灵脉花就画在这里;
       'apex'          = C-c 二修旧行为 (跟精灵抖动 + 抬到看得见的峰尖), 只留给对拍。
     ⚠ 两种档位下**签子本身的位置不变**: 签底一律抬到峰尖之上 (gap = topU*hexR*z),
       区别只在**圆点/引线终点** —— 中心点档的引线因此要从签底一路连到峰体中心。 */
  var VEIN_PT = (function () {
    return new URLSearchParams(location.search).get('veinpt') === 'apex' ? 'apex' : 'center';
  })();

  /* ---------- 宗门录 (左上角水墨面板) ----------
     数据源: 地图实体层 settleCells 中 type==='sect' 的实体 (id/name/pop/tier/
     styleName/buildings/resources), 不新增任何后端契约。
     「掌门」一栏: 后端 mapgen 尚无归属系统 (owner 恒为空串, 见 mapgen.js 注释),
     故由 seed+sect.id 确定性派生一个道号作演示 —— 事件系统接入后改为直接读 owner。
     ⚠ 九版: **删除「随行·就近择宗」自动选择** —— 开局不再自动认领最近的一座宗门
     (以前朱砂标记会随相机漂到最近的宗门上)。选中宗门只由玩家**主动**决定:
     点击图上某一格 (若该格属某座宗门) 或从「择宗」菜单里点选。pinId 空 = 未择。 */
  var sect = { pinId: '', pinEnt: null, curId: '', cur: null, items: [] };

  var chunkData = new Map();        // 'ca,cb' -> {arrays, bbox}
  var regionCells = new Map();      // 'i,j'  -> {region, roads}   (图层1: 区域名+道路)
  var commCells = new Map();        // 'ci,cj'-> CommunityPack     (图层4: 灵脉群落)
  /* 图层2/3 动态实体 (设计 §二): 按 key '区域i,j' 分组缓存, 与服务端
     EntityGroup 键一致 → 邻块重复携带同一区域时以键覆盖去重 */
  var settleCells = new Map();      // 'i,j' -> [PlaceEntity]  聚落实体
  var poiCells = new Map();         // 'i,j' -> [PlaceEntity]  景点实体
  var chunkQueue = [], chunkBusy = new Map();
  /* 道路/建筑覆盖格 → 该格上的树·山精灵让位 (变平地)。
     · propBlock   : "q,r" 集合 (建筑占地格 + 道路沿线格);
     · blockedVer  : 集合版本号, 数据到达即 +1;
     · propBuilt   : chunkKey -> 已按哪个版本过滤过精灵 (版本相同不重算, 平移缩放零开销)。 */
  var propBlock = new Set();
  var blockedVer = 0, syncedVer = -1;
  var propBuilt = new Map();
  var chunkRetry = new Map();   // key -> { attempt, at }: 可重试失败(网络/超时)的退避计划, at 为下次可入队时间
  /* R12: 并发/重试等网络常数收敛到单一配置对象, 不再散落魔法数字 */
  var NET_CFG = {
    concChunk: 4,          // 单块 WebSocket 并发请求数
    retryBaseMs: 800,      // 失败重试指数退避基数
    retryMaxMs: 30000      // 单次退避上限
  };
  /* ---------- S3: 地形块「前端自算」档位 ----------
     拍板 (2026-09-15): 主视图地形块改由前端按 seed 本地算 (MapGen.buildChunk),
     WS 请求的 mask 去掉 CHUNK 位 (31 → 30) —— 服务端 needChunk 分支本就支持, **零改动**。
     其余四层 (region/settle/poi/comm) 照旧走 WS: 世界是动态的, 只有静态地形可自算。
     · armed  = 用户档位 (?calc=server 关掉 ⇒ 老链路一行不改地长期保留作降级通道)
     · local  = **实际生效**, 由 armed + 引擎就绪 + 指纹未漂移三者共同决定 (calcRefresh)
     · 降级是静默且无损: local 转 false 后 mask 回到 31, 请求/落表全部走原路径。 */
  var QSC = new URLSearchParams(location.search);
  var CALC = {
    armed: QSC.get('calc') !== 'server',
    local: false,                     // 初始 false: 引擎脚本到货前先按老链路跑 (避免首屏空白)
    budgetMs: (QSC.get('chunkbudget') == null ? 6 : (+QSC.get('chunkbudget') || 0)),
    frameUsed: 0,                     // 本帧已花在本地算块上的毫秒 (每帧开头归零)
    localFail: 0, localFailMax: 8,    // 本地连续失败计数 / 阈值 (超阈本会话回退服务端)
    ab: QSC.get('chunkab') === '1',   // 开发自检: 每块额外带 CHUNK 位取一次做逐位比对
    probe: QSC.get('chunkprobe') === '1',
    /* S3 闸门: false = 先不发块请求 (等引擎定案)。calc=server 档无需等待 ⇒ 直接放行。 */
    settled: QSC.get('calc') === 'server'
  };
  /* 本地档的请求掩码 —— ⚠ 全项目**只此一处**出现「去掉 CHUNK 位」的运算
     (契约守卫: verify/frontend_smoke.mjs 断言该表达式仅出现 1 次, 防有人另起炉灶) */
  var CALC_MASK = PB.MASK.ALL & ~PB.MASK.CHUNK;      // 31 & ~1 = 30
  function EL() { return window.EngineLocal || null; }
  /* 档位生效判定: armed && 引擎就绪 && 指纹未漂移 */
  function calcRefresh() {
    var E = EL();
    var want = CALC.armed && !!(E && E.ready()) && !(E && E.hashStale());
    if (want !== CALC.local) {
      CALC.local = want;
      CALC.localFail = 0;
      console.log('[自算] 地形块来源: ' + (want ? '前端本地 (mask=30)' : '服务端下发 (mask=31)'));
    }
  }
  /* 分帧预算: 一次算太多块会顶出长任务 (25 块冷算 61ms, 低端机 ×5~10)。
     超预算的块挂进轻队列, **下一帧再算** —— ⚠ 不能走 scheduleChunkRetry
     (那是 0.8s 起步的惩罚性退避), 否则首屏会被人为拖慢。
     队列元素带 resp: 响应已在手, 不重发 WS 请求。 */
  var chunkDefer = [];
  var deferKeys = new Set();          // 只在队键集: updateStreaming 不再为它们重复发请求
  function deferChunk(job, resp, gen) {
    if (chunkDefer.length >= 4096) return;
    chunkDefer.push({ job: job, resp: resp, gen: gen });
    deferKeys.add(job.key);
  }
  function pumpDeferred() {
    while (chunkDefer.length) {
      if (CALC.budgetMs > 0 && CALC.frameUsed > CALC.budgetMs) return;
      var it = chunkDefer.shift();
      deferKeys.delete(it.job.key);
      if (it.gen !== worldSeed) continue;                 // 旧世界的块: 直接丢
      if (!keepChunk.has(it.job.key)) { MC.blockForget(it.job.key); continue; }
      finishChunk(it.job, it.resp, it.gen);
    }
  }
  /* 开发自检 (?chunkab=1 / ?chunkprobe=1): 真页面里比「本地算的数组」与
     「服务端下发的数组」是否逐位相同 —— Node 侧脚本只能证明文件里的引擎一致,
     证明不了浏览器里 eval 出来的那份也一致 (见待办单 §7)。 */
  var CALC_SEGS = ['centers', 'tiles', 'elevs', 'hashes', 'neigh',
                   'propCenters', 'propSprites', 'propHashes', 'propElevs'];
  var calcStat = { blocks: 0, diff: 0, badBlocks: 0, seg: {}, chunkPkts: 0 };
  function calcAB(local, resp) {
    if (!local || !resp || !resp.chunk) return;
    var srv;
    try { srv = PB.chunkToArrays(resp.chunk, geo); }
    catch (e) { console.warn('[chunkab] 服务端块解码失败', e); return; }
    calcStat.blocks++;
    var bad = 0;
    for (var s = 0; s < CALC_SEGS.length; s++) {
      var nm = CALC_SEGS[s], A = local[nm], B = srv[nm];
      if (!calcStat.seg[nm]) calcStat.seg[nm] = { n: 0, d: 0 };
      var rec = calcStat.seg[nm];
      if (A == null && B == null) continue;               // 纯海区块: 两侧同为 null
      if (A == null || B == null || A.length !== B.length) {
        rec.d += Math.abs((A ? A.length : 0) - (B ? B.length : 0)) || 1; bad++;
        continue;
      }
      for (var i = 0; i < A.length; i++) {
        rec.n++;
        if (A[i] !== B[i]) { rec.d++; calcStat.diff++; bad++; }
      }
    }
    if (bad) { calcStat.badBlocks++; console.warn('[chunkab] 块不一致', resp.i + ',' + resp.j); }
  }
  /* S5: 长任务观测 —— 首屏 25 块冷算 61ms 在桌面端无感, 低端机 ×5~10 就可能顶出
     长任务 (>50ms)。这里只**观测**不干预 (干预手段是 budgetMs 分帧 / 将来上 Worker)。
     ⚠ 只在调试/契约档挂 observer: 产品路径不留任何额外开销 (longtask 采样本身有成本)。 */
  var longStat = { n: 0, maxMs: 0, list: [] };
  if (DEBUG || CALC.probe || CALC.ab) {
    try {
      var LOT = window.PerformanceObserver;
      if (typeof LOT === 'function' && LOT.supportedEntryTypes &&
          LOT.supportedEntryTypes.indexOf('longtask') >= 0) {
        new LOT(function (l) {
          var es = l.getEntries();
          for (var i = 0; i < es.length; i++) {
            longStat.n++;
            if (es[i].duration > longStat.maxMs) longStat.maxMs = es[i].duration;
            if (longStat.list.length < 8) longStat.list.push(Math.round(es[i].duration));
          }
        }).observe({ entryTypes: ['longtask'] });
      }
    } catch (e) { /* 老浏览器无 longtask: 保持 n=0/hexOk 语义, 契约按「无从判定」处理 */ }
  }

  /* 门控与既有调试句柄同族: 平时不向全局泄漏内部状态 */
  if (DEBUG || CALC.probe || CALC.ab) {
    window.__calcProbe = function () {
      var E = EL();
      return {
        armed: CALC.armed, local: CALC.local, mask: CALC.local ? CALC_MASK : PB.MASK.ALL,
        /* S3 契约用: **实际**发出去的掩码 (与上面「意图值」不同 —— ?chunkab=1 时
           为了拿服务端块做对拍, 实际仍带 CHUNK 位)。只看 `mask` 会把自检档误判为
           「已在用 mask=30」, 所以契约断言实际值。 */
        maskEff: lastMask,
        settled: CALC.settled,
        budgetMs: CALC.budgetMs, localFail: CALC.localFail, deferred: chunkDefer.length,
        chunksLocal: chunkData.size,
        calc: E ? E.probe() : null,
        longTask: { n: longStat.n, maxMs: Math.round(longStat.maxMs * 10) / 10, list: longStat.list },
        ab: { blocks: calcStat.blocks, diff: calcStat.diff, badBlocks: calcStat.badBlocks,
              seg: calcStat.seg, chunkPkts: calcStat.chunkPkts }
      };
    };
  }
  /* R4: 当前视野窗口内的 chunk/region/comm key 集合 (updateStreaming 全量重建时
     刷新; 异步回调落库前据此校验, 防止把已卸载格子数据回填/重复上传 GPU) */
  var keepChunk = new Set(), keepR = new Set(), keepC = new Set();
  var lastMask = -1;                 // 最近一次实际发出的 mask (S3 契约断言用)

  var timeSec = 0, lastT = 0;
  var frameCount = 0;              // 渲染帧计数 (capture=1 截图须等「数据到达后至少渲染过一帧」)
  /* R11: 小地图已拆成独立模块 (web/js/minimap-vein.js, 可热拔插)。
     壳层只提供一个「数据版本号」: 任何图层变化都 +1, 模块据此决定世界层重绘 ——
     旧实现 (mmData/mmInFlight/requestMinimap + 1.5s /api/map/fields 轮询) 已删。 */
  var dataRev = 0;
  function mmBump() { dataRev++; }

  /* ---------- 静态覆盖层缓存 ---------- */
  var staticLayer = null;
  var staticCam = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };
  var staticDirty = true;
  /* R1: 静态层 dirty 200ms 节流合并 —— 连续加载 N 个 chunk/区域/群落时,
     各上传回调不再逐一置 staticDirty(每帧全量重绘 N 次), 而是合并到
     最后一次标记后 200ms 统一重绘一次。 */
  var staticSchedTimer = null;
  var lastStaticDraw = 0;          // performance.now() 上次静态层重绘时刻
  /* T7: 道路几何缓存 — 路网顶点只依赖 regionCells 数据 (世界坐标, 与相机无关),
     平移/缩放触发的静态层重绘不再重复重建顶点 + 重传 GPU;
     仅在新区域数据到达 / 世界重铸时置脏重建一次。 */
  var roadsDirty = true;

  /* 数据到达类脏标记(浪线/地名/道路补齐): 距上次重绘 <200ms 时延迟合并,
     已 ≥200ms 或 staticDirty 已挂起则立即置位由下一帧消费 */
  function markStaticDirty() {
    mmBump();                          // R11: 图层数据变化 → 小地图世界层重绘
    if (staticDirty) return;
    var now = performance.now();
    if (now - lastStaticDraw >= 200 || lastStaticDraw === 0) { staticDirty = true; return; }
    if (staticSchedTimer) return;
    staticSchedTimer = setTimeout(function () {
      staticSchedTimer = null;
      staticDirty = true;          // 下一帧 staticNeedsRedraw 消费
    }, 200);
  }
  /* 卸载/重铸等必须尽快消除残影的置位: 不节流 */
  function forceStaticDirty() {
    mmBump();                          // R11: 卸载/重铸 → 小地图同样要重绘
    if (staticSchedTimer) { clearTimeout(staticSchedTimer); staticSchedTimer = null; }
    staticDirty = true;
  }
  var lastPan = { x: 0, y: 0, zoom: 0 };
  /* P1: 流式需求集增量阈值 —— 记录上次全量重算时的相机状态,
     NaN 初始值强制首帧重算; regenerate() 时重置回 NaN。 */
  var lastStream = { x: NaN, y: NaN, zoom: NaN, w: 0, h: 0 };

  function $(id) { return document.getElementById(id); }
  function chunkKey(ca, cb) { return ca + ',' + cb; }
  function cellKey(a, b) { return a + ',' + b; }

  function showFatal(msg) {
    var d = $('fatal');
    d.style.display = 'flex';
    $('fatalMsg').textContent = String(msg);
  }
  /* T10: 全局 error 只落 console, 不再弹致命面板 — 第三方脚本/上下文丢失等
     次要异常不应中断渲染主循环; 渲染循环自身已有 try/catch 兜底 (loop 内)。 */
  window.addEventListener('error', function (e) {
    console.error('[zongmen] 全局异常:', e.message,
      e.filename ? '@' + e.filename.split('/').pop() + ':' + e.lineno : '');
  });

  function s2w(sx, sy) {
    return {
      x: (sx - els.app.clientWidth / 2) / cam.zoom + cam.x,
      y: (sy - els.app.clientHeight / 2) / cam.zoom + cam.y
    };
  }
  function w2s(wx, wy) {
    return {
      x: (wx - cam.x) * cam.zoom + els.app.clientWidth / 2,
      y: (wy - cam.y) * cam.zoom + els.app.clientHeight / 2
    };
  }
  function viewBounds() {
    var a = s2w(0, 0), b = s2w(els.app.clientWidth, els.app.clientHeight);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  function hexPath(ctx, cx, cy, R) {
    ctx.beginPath();
    for (var k = 0; k < 6; k++) {
      var a = Math.PI / 180 * (60 * k - 30);
      var px = cx + R * Math.cos(a), py = cy + R * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /* ---------- 区块流式加载 (后端权威) ---------- */
  function tileBoundsOf(b, padTiles) {
    var c0 = MC.pxToTile(b.x0, b.y0), c1 = MC.pxToTile(b.x1, b.y1),
        c2 = MC.pxToTile(b.x0, b.y1), c3 = MC.pxToTile(b.x1, b.y0);
    var qmin = Math.min(c0.q, c1.q, c2.q, c3.q) - padTiles;
    var qmax = Math.max(c0.q, c1.q, c2.q, c3.q) + padTiles;
    var rmin = Math.min(c0.r, c1.r, c2.r, c3.r) - padTiles;
    var rmax = Math.max(c0.r, c1.r, c2.r, c3.r) + padTiles;
    return { qmin: qmin, qmax: qmax, rmin: rmin, rmax: rmax };
  }

  function updateStreaming() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    /* P1: 相机位移/缩放/视口尺寸超过阈值才全量重建需求集 (阈值公式与
       staticNeedsRedraw 的 scale 同思路, 随 zoom 缩小);
       相机静止且无到期重试时, 只推进存量队列, 不做象限扫描/卸载/排序。 */
    var stScale = 16 / (cam.zoom * 0.75 + 0.25);
    var moved = lastStream.x !== lastStream.x ||          // 首帧 / regenerate 后为 NaN → 必须重算
                vw !== lastStream.w || vh !== lastStream.h ||
                Math.abs(cam.x - lastStream.x) > stScale ||
                Math.abs(cam.y - lastStream.y) > stScale ||
                Math.abs(cam.zoom - lastStream.zoom) > 0.02;
    if (!moved) {
      var tNow0 = performance.now();
      var retryDue = false;
      chunkRetry.forEach(function (rr) { if (rr.at <= tNow0) retryDue = true; });
      if (!retryDue) {
        pumpChunks();                                     // 在途完成回调也会自 pump
        return;
      }
    }
    lastStream.x = cam.x; lastStream.y = cam.y;
    lastStream.zoom = cam.zoom; lastStream.w = vw; lastStream.h = vh;

    var b = viewBounds();
    var t = tileBoundsOf(b, 2);
    /* 视野区域/群落格窗口: 供 regionCells/commCells/settleCells/poiCells
       窗口失活与回填校验 (块响应的子消息可能落在窗口外, 交给邻块负责) */
    var M = geo.regionM, CL = geo.commCl;
    var i0 = Math.floor(t.qmin / M) - 1, i1 = Math.floor(t.qmax / M) + 1;
    var j0 = Math.floor(t.rmin / M) - 1, j1 = Math.floor(t.rmax / M) + 1;
    var ci0 = Math.floor(t.qmin / CL) - 1, ci1 = Math.floor(t.qmax / CL) + 1;
    var cj0 = Math.floor(t.rmin / CL) - 1, cj1 = Math.floor(t.rmax / CL) + 1;

    /* 卸载视野外 (区域/群落数据 + 实体层) */
    keepR = new Set(); keepC = new Set();   // 模块级: 供异步回调校验回填 (R4)
    for (var ri = i0; ri <= i1; ri++) for (var rj = j0; rj <= j1; rj++) keepR.add(cellKey(ri, rj));
    for (var ui = ci0; ui <= ci1; ui++) for (var uj = cj0; uj <= cj1; uj++) keepC.add(cellKey(ui, uj));
    regionCells.forEach(function (_p, k) { if (!keepR.has(k)) regionCells.delete(k); });
    commCells.forEach(function (_p, k) { if (!keepC.has(k)) commCells.delete(k); });
    settleCells.forEach(function (_l, k) { if (!keepR.has(k)) settleCells.delete(k); });
    poiCells.forEach(function (_l, k) { if (!keepR.has(k)) poiCells.delete(k); });
    settleVer++;             // R6b (B): 卸载也会改变"最近宗门"的候选集 ⇒ 归属缓存同样失效

    /* 单块 need 集合 (主块 = 区块格, 设计 §六 方案 A) */
    var pad = geo.hexW * 2;
    var tb = tileBoundsOf(
      { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, 0);
    var m2 = geo.chunkScan + geo.chunkS;
    var a0 = Math.floor((tb.qmin - m2) / geo.chunkS), a1 = Math.floor((tb.qmax + m2) / geo.chunkS);
    var b0 = Math.floor((tb.rmin - m2) / geo.chunkS), b1 = Math.floor((tb.rmax + m2) / geo.chunkS);
    var need = {};
    keepChunk = new Set();   // 模块级: 本帧仍需的块 key, 供 loadChunk 回调校验 (R4)
    for (var ca = a0; ca <= a1; ca++) {
      for (var cb = b0; cb <= b1; cb++) {
        var kk = chunkKey(ca, cb);
        need[kk] = { ca: ca, cb: cb };
        keepChunk.add(kk);
      }
    }
    chunkData.forEach(function (_info, key) {
      if (!need[key]) {
        renderer.dropChunk(key);
        chunkData.delete(key);
        propBuilt.delete(key);               // 精灵过滤记录随块卸载 (重进视野重算)
        MC.blockForget(key);                 // rev 缓存同步失效: 重进视野须全量重取
        forceStaticDirty();                  // 内容移除: 尽快重绘清除残影 (R1)
      }
    });

    /* 队列重建: 未加载 && 未在途 && 不在退避期内, 距相机排序 */
    chunkQueue.length = 0;
    var tNow = performance.now();
    for (var key in need) {
      var rr = chunkRetry.get(key);
      if (!chunkData.has(key) && !chunkBusy.has(key) && !deferKeys.has(key) &&
          (!rr || rr.at <= tNow)) {
        var cc = need[key];
        var w = MC.tileToWorld(cc.ca * geo.chunkS, cc.cb * geo.chunkS);
        var d = (w.x - cam.x) * (w.x - cam.x) + (w.y - cam.y) * (w.y - cam.y);
        chunkQueue.push({ ca: cc.ca, cb: cc.cb, key: key, d: d });
      }
    }
    /* 已离开视野的退避记录及时清理, 防止无界增长; 重回视野时重试窗口从零计 */
    chunkRetry.forEach(function (_v, key) { if (!need[key]) chunkRetry.delete(key); });
    chunkQueue.sort(function (p, q) { return p.d - q.d; });
    pumpChunks();
  }

  /* 单个块请求的生命周期独立成函数: job 必须被本次请求闭包独占。
     (此前 var job 在 while 循环里被所有并发回调共享, 回调里读到的永远是
      最后一个 job → chunkBusy 只删掉最后一个 key, 前几个 key 永久卡死。) */
  function loadChunk(job) {
    var gen = worldSeed;
    /* S3: 本地算档不带 CHUNK 位 (服务端就不算不发整块地形);
       ?chunkab=1 是显式开发自检 ⇒ 仍带 CHUNK 位, 好拿服务端的块做逐位对拍。 */
    var mask = (CALC.local && !CALC.ab) ? CALC_MASK : PB.MASK.ALL;
    lastMask = mask;
    MC.block(gen, job.ca, job.cb, mask).then(function (resp) {
      /* 修复「个别色块无贴图」(待办/色块无贴图bug排查): MapClient.onFrame 收到
         响应即无条件写 revs 缓存; 若本块此刻已被丢弃 (出视野/世界重铸), 数据不会
         经 applyBlock 落 chunkData —— revs 残留会让下次请求携带旧 lastRevs,
         服务端按 rev 未变缺省下发 → 块永久空白。故两个丢弃分支都主动 blockForget,
         维持不变量「revs 有记录 ⇒ chunkData 有数据」。 */
      if (gen !== worldSeed) { MC.blockForget(job.key); return; }   // 世界已重铸, 丢弃旧响应
      if (!keepChunk.has(job.key)) { MC.blockForget(job.key); return; }  // R4: 已出视野被卸载
      finishChunk(job, resp, gen);
    }).catch(function (err) {
      console.error('块加载失败', job.key, err);
      if (gen !== worldSeed) return;                 // 旧世界失败不记账
      scheduleChunkRetry(job);                       // 网络/超时/断线: 指数退避后自动重试
    }).then(function () {
      if (gen !== worldSeed) return;                 // 旧世界请求不动新世界的 busy 集
      chunkBusy.delete(job.key);
      pumpChunks();
    });
  }

  /* 本地算 + 落表。分帧预算不足时把 (job, resp) 挂进轻队列, **下一帧**接着算
     (响应已在手, 不重发请求; 也不走惩罚性退避 —— 见 CALC 注释)。
     ⚠ 必须在两道丢弃守卫**之后**才算: 别为已出视野/已重铸的块白算一遍。 */
  function finishChunk(job, resp, gen) {
    var local = null;
    if (CALC.local) {
      if (CALC.budgetMs > 0 && CALC.frameUsed > CALC.budgetMs) { deferChunk(job, resp, gen); return; }
      var E = EL();
      if (E && E.ready()) {
        try {
          var t0 = performance.now();
          local = E.chunkArrays(job.ca, job.cb);
          var ms = performance.now() - t0;
          CALC.frameUsed += ms;                      // 记本帧预算 (低端机靠它摊帧)
          E.noteBuild(ms);
          if (CALC.ab) calcAB(local, resp);
        } catch (e) {
          console.error('本地块计算失败', job.key, e);
          local = null;
        }
      }
    }
    applyBlock(job, resp, local);
  }

  /* TileResponse 子消息分发 (设计 §3.2): chunk→GPU, region→道路/地名,
     settle/poi→实体层, comm→灵脉。rev 未变的图层服务端缺省, 保留旧数据。 */
  function applyBlock(job, resp, localArrays) {
    if (resp.err) console.warn('块 ' + job.key + ' 部分图层不可用:', resp.err);
    /* S3 契约: 统计「服务端仍在下发整块地形」的次数 —— 本地档 (mask=30) 下必须恒 0,
       是「服务端真的不再算/不再发 chunk」的**唯一**可观测证据 (除了看服务端日志)。 */
    if (resp.chunk) calcStat.chunkPkts++;

    /* 图层0 静态地形 (子消息缺省 = rev 未变, 保留已上传 GPU 的数据)。
       S3: 两条来源 —— 前端本地自算优先 (显式传入), 否则服务端下发。 */
    var arrays = localArrays || (resp.chunk ? PB.chunkToArrays(resp.chunk, geo) : null);
    /* 兜底防御: chunk 缺省 (=服务端按 rev 未变不重发) 但本地从未持有该块 —
       说明 revs 缓存与 chunkData 不一致 (旧版竞态已造成的坏状态, 或不可达
       的遗漏路径)。清 rev 后重新入队, 下一次请求不带 lastRevs → 服务端全量
       下发, 消除永久空白。
       ★ 但服务端**明确报错**时 (resp.err) 不能直接重排: 错误响应几乎立即返回,
         pumpChunks 会马上再发 → 无退避自旋, 单连接被打满。改走指数退避。
       ★ S3 新增 (⚠ 本地算档下这段必须走另一条路): 本地档 mask 不含 CHUNK 位,
         服务端**永远**不会下发地形 ⇒ 无脑沿用「清 rev → 重排队」会把同一块
         无限重排 (每轮服务端照样不给 chunk), 表现为「视野反复空白 + 请求风暴」。
         故拆成两条互不干扰的路径: 本地失败走退避重试, 连续超阈静默回退服务端。 */
    if (!arrays && !chunkData.has(job.key)) {
      if (CALC.local && !CALC.ab) {
        if (++CALC.localFail > CALC.localFailMax) {
          CALC.local = false;            // 本会话回退 (老链路完整保留), 只 warn 一次不弹窗
          console.warn('[自算] 本地算块连续失败 ' + CALC.localFail + ' 次, 已回退服务端下发');
          MC.blockForget(job.key);
          chunkQueue.push(job);
          return;
        }
        scheduleChunkRetry(job);         // 本地算失败: 清 rev 重拉没有意义 ⇒ 退避后重试本块
      } else {
        MC.blockForget(job.key);
        if (resp.err) {
          scheduleChunkRetry(job);       // 0.8s→30s 退避, 由 updateStreaming 到期检查重新入队
        } else {
          chunkQueue.push(job);          // 纯 rev 不一致: 一次往返即自愈, 无需退避
        }
      }
      return;
    }
    CALC.localFail = 0;                  // 走到这里说明本块有数据 ⇒ 「连续失败」计数清零
    if (arrays && !chunkData.has(job.key)) {
      var bb = { x0: 1e18, y0: 1e18, x1: -1e18, y1: -1e18 };
      var ct = arrays.centers;
      for (var i = 0; i < arrays.count; i++) {
        var x = ct[i * 2], y = ct[i * 2 + 1];
        if (x < bb.x0) bb.x0 = x; if (x > bb.x1) bb.x1 = x;
        if (y < bb.y0) bb.y0 = y; if (y > bb.y1) bb.y1 = y;
      }
      renderer.uploadChunk(job.key, arrays, bb);   // R7: bbox 供渲染粗剔除
      chunkData.set(job.key, { arrays: arrays, bbox: bb });
      refreshChunkProps(job.key);        // 新块: 立即按最新覆盖格过滤树·山 (让位)
      markStaticDirty();                   // R1: 连续 N 个块合并 200ms 重绘一次
    }

    /* 图层1 区域 (区域名 + 道路; 实体已拆分到图层2/3) */
    var regionsApplied = false;
    for (var rg2 = 0; rg2 < resp.regions.length; rg2++) {
      var rg = resp.regions[rg2];
      var rk = rg.i + ',' + rg.j;
      if (!keepR.has(rk)) continue;                // 窗口外: 交给覆盖该区域的邻块
      regionCells.set(rk, { region: rg.region, roads: rg.roads });
      roadsDirty = true;                           // T7: 路网数据变化 → 重绘重建道路几何
      regionsApplied = true;
    }
    /* ★ 必须与 chunk/settle/poi/comm 分支一样置静态脏: roadsDirty 与区域名绘制
       (renderStaticInto 内 584/648 行) 都在 staticDirty 门控的重绘函数里消费。
       若只置 roadsDirty 而不置 staticDirty, 当「相机静止 + 本块 chunk 未变化」
       (如重试时该块 chunkData 已存在 → 上面的 chunk 分支整个跳过) 时,
       renderStaticInto 不会被调用 → 道路几何与区域名一直不刷新。 */
    if (regionsApplied) { rebuildPropBlock(); markStaticDirty(); }   // 路网变 → 覆盖格重算

    /* 图层2/3 实体 (按区域格键覆盖, 天然去重邻块重复携带) */
    if (resp.settle) {
      for (var sg = 0; sg < resp.settle.groups.length; sg++) {
        var g = resp.settle.groups[sg];
        var gk = g.i + ',' + g.j;
        if (keepR.has(gk)) settleCells.set(gk, g.items);
      }
      settleVer++;              // R6b (B): 新聚落到货 → 归属缓存 (st._fac) 全部失效重算
      markStaticDirty();
      rebuildPropBlock();       // 建筑占地格变 → 覆盖格重算 (聚落内的树/山让位)
      updateSectPanel(false);   // 实体层更新即刷新宗门录 (id 未变时内部直接返回)
    }
    if (resp.poi) {
      for (var pg = 0; pg < resp.poi.groups.length; pg++) {
        var gp = resp.poi.groups[pg];
        var gk2 = gp.i + ',' + gp.j;
        if (keepR.has(gk2)) poiCells.set(gk2, gp.items);
      }
      markStaticDirty();
    }

    /* 图层4 灵脉群落 */
    for (var cm2 = 0; cm2 < resp.comms.length; cm2++) {
      var cm = resp.comms[cm2];
      var ck = cm.ci + ',' + cm.cj;
      if (!keepC.has(ck)) continue;
      commCells.set(ck, cm);
      markStaticDirty();
    }
  }

  /* 指数退避: 0.8s→1.6→3.2→6.4→12.8→…→30s 封顶, 之后保持 30s 周期重试,
     直至块离开视野(记录被清理)或 regenerate() 重铸世界。不永久放弃, 服务抖动恢复后地图可自愈。 */
  function scheduleChunkRetry(job) {
    var r = chunkRetry.get(job.key);
    var attempt = r ? r.attempt : 0;
    attempt++;
    var delay = Math.min(NET_CFG.retryBaseMs * Math.pow(2, attempt - 1), NET_CFG.retryMaxMs);
    chunkRetry.set(job.key, { attempt: attempt, at: performance.now() + delay });
  }

  function pumpChunks() {
    /* S3 首请求闸门: 引擎「能不能本地算」未定案之前**一个块都不发**。
       否则首帧那 concChunk(=4) 个并发请求会带着 mask=31 出去, 服务端白算白发
       4 个整块地形 (实测 chunkPkts=4) —— 「不向后端请求地形」就没做干净。
       等 EngineLocal.load() 定案 (成功 ⇒ 用 30; 失败 ⇒ 用 31) 再放行, 代价是
       首屏多等一次 WS 往返 (~10~30ms), 换取服务端彻底不再生成 chunk。
       看门狗在 armCalc() 里兜底, 不会永久挂起。 */
    if (!CALC.settled) return;
    while (chunkBusy.size < NET_CFG.concChunk && chunkQueue.length) {
      var job = chunkQueue.shift();
      if (chunkData.has(job.key) || chunkBusy.has(job.key)) continue;
      chunkBusy.set(job.key, true);
      loadChunk(job);
    }
  }

  /* ---------- 聚落图标 (Canvas2D 白描, 原样保留) ---------- */
  function iconBase(ctx) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(45,38,30,0.95)';
    ctx.fillStyle = 'rgba(242,236,220,0.92)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }
  function drawSect(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-6.5, 6.5, 13, 3); ctx.strokeRect(-6.5, 6.5, 13, 3);
    ctx.fillRect(-4.5, 1.5, 9, 5); ctx.strokeRect(-4.5, 1.5, 9, 5);
    ctx.beginPath();
    ctx.moveTo(-8.5, 1.5); ctx.quadraticCurveTo(-6.5, 0.2, -5, -2.5);
    ctx.lineTo(5, -2.5); ctx.quadraticCurveTo(6.5, 0.2, 8.5, 1.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillRect(-3, -7.5, 6, 5); ctx.strokeRect(-3, -7.5, 6, 5);
    ctx.beginPath();
    ctx.moveTo(-6.5, -7.5); ctx.quadraticCurveTo(-5, -8.8, -3.8, -11);
    ctx.lineTo(3.8, -11); ctx.quadraticCurveTo(5, -8.8, 6.5, -7.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, -14.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, -15.5, 1.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawCity(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-8, -2, 16, 9); ctx.strokeRect(-8, -2, 16, 9);
    for (var i = -8; i < 8; i += 4) { ctx.fillRect(i, -4.5, 2.6, 2.5); ctx.strokeRect(i, -4.5, 2.6, 2.5); }
    ctx.beginPath();
    ctx.moveTo(-2.5, 7); ctx.lineTo(-2.5, 2); ctx.arc(0, 2, 2.5, Math.PI, 0); ctx.lineTo(2.5, 7);
    ctx.closePath(); ctx.fillStyle = 'rgba(60,50,40,0.55)'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(8, 1); ctx.lineTo(13, -1); ctx.lineTo(13, 5); ctx.lineTo(8, 3);
    ctx.closePath(); ctx.fillStyle = 'rgba(166,58,44,0.8)'; ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  function drawTown(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-6, -1, 12, 8); ctx.strokeRect(-6, -1, 12, 8);
    ctx.beginPath();
    ctx.moveTo(-8.5, -1); ctx.lineTo(0, -8); ctx.lineTo(8.5, -1); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,50,40,0.55)';
    ctx.fillRect(-1.8, 2.5, 3.6, 4.5); ctx.strokeRect(-1.8, 2.5, 3.6, 4.5);
    ctx.restore();
  }
  function drawVillage(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    ctx.fillRect(-4.5, 0, 9, 6); ctx.strokeRect(-4.5, 0, 9, 6);
    ctx.beginPath();
    ctx.moveTo(-6.5, 0); ctx.quadraticCurveTo(0, -9, 6.5, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,50,40,0.5)';
    ctx.fillRect(-1.4, 2, 2.8, 4);
    ctx.restore();
  }
  /* A (2026-09-15): 渔村远视图标 —— 原与村落共用 drawVillage (单屋), 远景分不出来。
     现在 = 屋 (左上, 尖顶) + 船 (右下, 梭形) + 网纹三撇 ⇒ 缩到 10px 也读得出"是渔村"。
     构图刻意与 drawVillage 错开: 村落的屋在正中且只有一栋, 渔村的屋偏左且配船。 */
  function drawFishing(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    iconBase(ctx);
    /* 屋 (左) */
    ctx.fillRect(-6, -1, 7, 5); ctx.strokeRect(-6, -1, 7, 5);
    ctx.beginPath();
    ctx.moveTo(-7.5, -1); ctx.quadraticCurveTo(-2.5, -8, 2.5, -1); ctx.closePath();
    ctx.fill(); ctx.stroke();
    /* 船 (右下): 梭形壳 + 一撇缆 */
    ctx.beginPath();
    ctx.moveTo(-1.5, 4.5); ctx.quadraticCurveTo(3.5, 8.5, 8, 4.5);
    ctx.quadraticCurveTo(3.5, 6.2, -1.5, 4.5);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(60,50,40,0.5)';
    ctx.fillRect(-3.4, 1, 2.2, 3);                    // 门洞
    /* 网纹: 三道短斜撇 (挂网) */
    ctx.strokeStyle = 'rgba(60,50,40,0.62)'; ctx.lineWidth = 1.1;
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-1.2 + i * 1.5, -2.4);
      ctx.lineTo(0.4 + i * 1.5, -0.2);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawPoi(ctx, x, y, s) {
    ctx.save(); ctx.translate(x, y); ctx.scale(s / 16, s / 16);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(150,52,38,0.95)';
    ctx.fillStyle = 'rgba(214,120,92,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(6, 0); ctx.lineTo(0, 8); ctx.lineTo(-6, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(150,52,38,0.95)'; ctx.fill();
    ctx.restore();
  }
  var ICON_FN = { sect: drawSect, city: drawCity, town: drawTown, village: drawVillage,
                  fishing: drawFishing, poi: drawPoi };
  var TYPE_NAME = { sect: '宗门', city: '仙城', town: '坊市', village: '村落',
                    fishing: '渔村', poi: '秘境' };
  var VEIN_EL = ['金', '木', '水', '火', '土'];

  /* ---------- 地名纸签 (山海经式竖排匾额) ----------
     古图经卷的地名签: 米黄纸底 + 细墨框 + 焦墨竖排楷体, 一签一名, 一律**立在对应
     地物上方**, 签底引一线连到地物落点。签面倾角由名字 hash 决定 —— 同名恒定,
     平移/缩放重绘不会闪。名字一律竖排: 逐字居中排成单列。 */
  function bannerTilt(name) {
    return ((hash32(String(name)) % 1000) / 1000 - 0.5) * 0.055;    // ±1.6°
  }
  /* 签位占用表 (每帧清空) —— 地名密处两签会叠在一起 (灵脉签 7 字很长, 最容易
     和旁边的村签撞)。绘制顺序 = 优先级: 聚落/景点在前, 灵脉在后; 后到的先往上
     让一档, 让不开就不画 (宁缺勿叠)。 */
  var bannerBoxes = [];
  function bannerHit(bb) {
    for (var i = 0; i < bannerBoxes.length; i++) {
      var o = bannerBoxes[i];
      if (bb.x0 < o.x1 && bb.x1 > o.x0 && bb.y0 < o.y1 && bb.y1 > o.y0) return o;
    }
    return null;
  }
  /* 灵脉签的五行淡染 (2026-09-16 用户: 「灵脉的牌匾要有对应的颜色, 稍微淡一点附在原来的
     牌匾上面」)。
     ★ 读法: 纸签本体**不动** (纸色 + 手撕边 + 双线内框 + 墨字全部保留), 五行色以「薄染」
       叠在纸面之上 —— 「附在原来的牌匾上面」的字面实现。
     ★ 「稍微淡一点」不是靠调低那一个 alpha 值, 而是**两道着色**:
         · 先把本色向纸色提亮 (paperMix) —— 直接拿饱和的元素色低透叠上去会发脏 (纸变"污")，
           提亮后是"染过的纸"而非"盖了块颜色";
         · 再分上下两段渐变 (顶淡底浓), 让签子仍像一块有光照的纸。
       签脚色条与描边则用**本色** (不提亮): 那才是"对应的颜色"的落款处, 远看第一眼认的就是它。 */
  var VEIN_PAPER = [247, 239, 219];     // 签面纸色 (与 drawNameBanner 的 fillStyle 同源)
  var VEIN_WASH_MIX = 0.40;             // 向纸色提亮的比例 (0=本色, 1=纯纸色)
  var VEIN_WASH_A0 = 0.30, VEIN_WASH_A1 = 0.46;   // 签顶/签底的不透明度
  function mixRGB(a, b, k) {            // k=0 → a, k=1 → b
    return [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0];
  }

  function drawNameBanner(ctx, x, anchorY, text, opt) {
    opt = opt || {};
    var chars = String(text == null ? '' : text).split('');
    if (!chars.length) return;
    var fs = opt.fs || 11.5;
    var padX = fs * 0.34, padT = fs * 0.48, padB = fs * 0.38;
    var lineH = fs * 1.04;
    var bw = fs * 1.02 + padX * 2;                   // 签宽
    var bh = chars.length * lineH + padT + padB;     // 签高
    var lead = Math.max(5, fs * 0.62);               // 引绳长 (签子贴近地物)
    /* opt.gap: 签底再往上让开的额外间距 (像素) —— 给"点扎在建筑格心"用:
       点必须压在房子上 (C-a), 但签子不能糊住屋顶, 于是把**签**抬起来、点不动。 */
    var bottomY = anchorY - lead - (opt.gap || 0);   // 签底 y
    var topY = bottomY - bh;
    if (bottomY < -24 || topY > opt.vh + 24) return; // 整签出视野 → 不画
    var bb = { x0: x - bw * 0.5 - 2, x1: x + bw * 0.5 + 2, y0: topY - 2, y1: bottomY + 2 };
    var hitB = bannerHit(bb);
    if (hitB) {
      if (!opt.avoid) return;                        // 后到者让位; 让不开就不画
      bottomY = hitB.y0 - 4;                         // 只让到被压那张签之上 (最小位移)
      topY = bottomY - bh;
      bb = { x0: bb.x0, x1: bb.x1, y0: topY - 2, y1: bottomY + 2 };
      if (topY < -24 || bottomY > opt.vh + 24) return;   // 让出视野 → 不画
      if (bannerHit(bb)) return;
    }
    bannerBoxes.push(bb);
    statBanner++;                                    // 验数: 本帧真正画出的匾额数
    var tilt = bannerTilt(text);
    ctx.save();
    /* 引绳 + 落点 (在签之下先画) */
    ctx.strokeStyle = 'rgba(58,48,36,0.42)';
    ctx.lineWidth = Math.max(0.8, fs * 0.07);
    ctx.beginPath(); ctx.moveTo(x, bottomY); ctx.lineTo(x, anchorY); ctx.stroke();
    ctx.fillStyle = 'rgba(58,48,36,0.5)';
    ctx.beginPath(); ctx.arc(x, anchorY, Math.max(1, fs * 0.10), 0, Math.PI * 2); ctx.fill();
    /* 签面 (手撕纸边: 四角轻微不齐) */
    ctx.translate(x, bottomY);
    ctx.rotate(tilt);
    ctx.beginPath();
    ctx.moveTo(-bw * 0.5 + bw * 0.02, -bh * 0.995);
    ctx.lineTo(bw * 0.5 - bw * 0.015, -bh);
    ctx.lineTo(bw * 0.5, -bh * 0.03);
    ctx.lineTo(bw * 0.5 - bw * 0.025, 0);
    ctx.lineTo(-bw * 0.5, -bh * 0.015);
    ctx.closePath();
    ctx.shadowColor = 'rgba(52,40,24,0.36)';
    ctx.shadowBlur = Math.max(2, fs * 0.45);
    ctx.shadowOffsetY = Math.max(1, fs * 0.16);
    ctx.fillStyle = 'rgba(247,239,219,0.95)';
    ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    /* 灵脉签: 纸面薄敷一层灵根本色 —— 分两道, 见文件上方 VEIN_PAPER / VEIN_WASH_* 注释。
       ① 提亮后的五行色整签渐变薄染 (附在纸签之上, 不换掉纸签本身);
       ② 本色描边 (外框墨线染上本色) + 签脚本色色条 (落款处), 远看仍是一块纸牌。
       ⚠ 两次 fill()/stroke() 复用同一个当前路径 (translate/rotate 之后建的), 中间不得
         再 beginPath —— 否则染的就不是签面了。 */
    if (opt.tint) {
      var wRgb = mixRGB(opt.tint, VEIN_PAPER, VEIN_WASH_MIX);
      var ws = 'rgba(' + wRgb[0] + ',' + wRgb[1] + ',' + wRgb[2] + ',';
      var wash = ctx.createLinearGradient(0, -bh, 0, 0);
      wash.addColorStop(0, ws + VEIN_WASH_A0 + ')');
      wash.addColorStop(1, ws + VEIN_WASH_A1 + ')');
      ctx.fillStyle = wash;
      ctx.fill();
    }
    var edge = opt.tint ? mixRGB(opt.tint, [72, 58, 40], 0.52) : null;
    ctx.strokeStyle = edge ? 'rgba(' + edge[0] + ',' + edge[1] + ',' + edge[2] + ',0.66)'
                           : 'rgba(72,58,40,0.60)';
    ctx.lineWidth = Math.max(1, fs * 0.085);
    ctx.stroke();
    /* 内框细线 (与面板同族的"双线画框") */
    ctx.strokeStyle = 'rgba(120,98,66,0.28)';
    ctx.lineWidth = Math.max(0.6, fs * 0.05);
    ctx.strokeRect(-bw * 0.5 + fs * 0.20, -bh + fs * 0.20, bw - fs * 0.40, bh - fs * 0.40);
    /* 灵脉签脚: 一枚灵根色小印 (落款处用**本色**, 这是"对应的颜色"最实的一笔) */
    if (opt.tint) {
      ctx.fillStyle = 'rgba(' + opt.tint[0] + ',' + opt.tint[1] + ',' + opt.tint[2] + ',0.86)';
      ctx.fillRect(-bw * 0.5 + fs * 0.30, -fs * 0.56, bw - fs * 0.60, fs * 0.18);
    }
    /* 竖排字 */
    ctx.fillStyle = opt.poi ? 'rgba(140,48,34,0.95)' : 'rgba(36,29,21,0.96)';
    ctx.font = fs + 'px "KaiTi","STKaiti","KaiTi_GB2312",serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], 0, -bh + padT + lineH * (i + 0.5));
    }
    ctx.restore();
  }

  /* ============================================================
   * R11: 小地图壳层接口 —— 只给「只读快照 + 主相机跳转」,
   *   渲染/交互全在 web/js/minimap-vein.js (独立模块, 可热拔插:
   *   换小地图只改这一个 init 调用, 不动 main.js 其它部分)。
   *   旧实现 (HTTP /api/map/fields 轮询采样 132×88 网格) 已整体删除 ——
   *   那正是「一直请求 → 撞请求速率」的根因 (D8/R11)。
   * ============================================================ */
  function mmSnapshot() {
    return {
      rev: dataRev,
      seed: worldSeed,
      cam: { x: cam.x, y: cam.y, zoom: cam.zoom },
      vw: els.app ? (els.app.clientWidth || 0) : 0,
      vh: els.app ? (els.app.clientHeight || 0) : 0,
      hexW: geo ? geo.hexW : 0, hexR: geo ? geo.hexR : 0,
      biomeMeta: geo ? geo.biomeMeta : null,
      elementRGB: geo ? geo.elementRGB : null,
      variantRGB: geo ? geo.variantRGB : null,
      /* 世界层: 全部来自 WS 已到货的群落/聚落/道路。模块只读, 不得修改;
         世界是动态的 ⇒ 前端绝不自算这些内容 (自算必然与服务端不一致)。 */
      comms: commCells, settles: settleCells, roads: regionCells
    };
  }
  /* 小地图单击 → 主相机跳转 (全屏档用) */
  function mmJump(x, y) {
    cam.tx = x; cam.ty = y; cam.x = x; cam.y = y;
    forceStaticDirty();
  }
  function initMinimap() {
    var M = window.MiniMapVein;
    if (!M || !M.init) {
      console.warn('小地图模块未加载 (web/js/minimap-vein.js) — 已跳过');
      return;
    }
    M.init({
      panel: document.getElementById('minimapBox'),
      full: document.getElementById('mmFull'),
      snapshot: mmSnapshot,
      jump: mmJump,
      /* R6b (B): 归属势力解析器 —— 小地图只读地物数据, 不认识"宗门/辖区";
         把解析器注入它, 悬停提示才能显示「归属 XX宗」而不用把逻辑复制一份过去。
         ⚠ 模块必须容忍这两个键缺失 (main.js 可单独回退) ⇒ 那边写 `if (g.factionOf)`。 */
      factionOf: factionOf,
      factionColor: factionColor
    });
  }
  /* ---------- 标注层: 全部基于后端数据绘制 ---------- */
  function staticNeedsRedraw(vw, vh) {
    if (staticDirty) return true;
    var scale = 18 / (cam.zoom * 0.75 + 0.25);
    if (Math.abs(cam.x - staticCam.x) > scale) return true;
    if (Math.abs(cam.y - staticCam.y) > scale) return true;
    if (Math.abs(cam.zoom - staticCam.zoom) > 0.02) return true;
    if (vw !== staticCam.w || vh !== staticCam.h) return true;
    return false;
  }

  /* 逐块浪线 (数据来自已加载区块的 tiles/hashes/centers/neigh) */
  function drawChunkWaves(ctx, b) {
    var pad = 24;
    var w0 = MC.pxToTile(b.x0 - pad, b.y0 - pad), w1 = MC.pxToTile(b.x1 + pad, b.y1 + pad),
        w2 = MC.pxToTile(b.x0 - pad, b.y1 + pad), w3 = MC.pxToTile(b.x1 + pad, b.y0 - pad);
    var qmin = Math.min(w0.q, w1.q, w2.q, w3.q), qmax = Math.max(w0.q, w1.q, w2.q, w3.q);
    var rmin = Math.min(w0.r, w1.r, w2.r, w3.r), rmax = Math.max(w0.r, w1.r, w2.r, w3.r);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    chunkData.forEach(function (info) {
      var bb = info.bbox;
      if (bb.x1 < b.x0 - pad || bb.x0 > b.x1 + pad || bb.y1 < b.y0 - pad || bb.y0 > b.y1 + pad) return;
      var d = info.arrays, centers = d.centers, tiles = d.tiles, hashes = d.hashes, neigh = d.neigh;
      for (var i = 0; i < d.count; i++) {
        var biome = (tiles[i] / 4) | 0;
        if (biome > 1) continue;
        var wfq = Math.round((centers[i * 2] / geo.hexW) - (centers[i * 2 + 1] / (1.5 * geo.hexR)) / 2);
        var wfr = Math.round(centers[i * 2 + 1] / (1.5 * geo.hexR));
        if (wfq < qmin || wfq > qmax || wfr < rmin || wfr > rmax) continue;
        var hh = hashes[i];
        /* T7: 先做近岸判定与出线概率筛 — 深海 ~70% 的格在此被跳过,
           免去 3 个浮点哈希与后续全部绘制计算 (输出与原顺序完全一致) */
        var nearLand = false;
        if (biome === 1) {
          var nv = neigh[i];
          for (var wn = 0; wn < 6; wn++) {
            var nb = (nv >> (wn * 3)) & 7;      // P2: 3bit/邻居 移位掩码解码, 免逐邻居 Math.pow(8,wn)
            if (nb > 1) { nearLand = true; break; }
          }
        }
        if (!nearLand && hh >= (biome === 0 ? 0.30 : 0.46)) continue;
        var fr1 = (hh * 913.7) % 1, fr2 = (hh * 517.3) % 1, fr3 = (hh * 271.1) % 1;
        var hx = centers[i * 2], hy = centers[i * 2 + 1];
        if (nearLand) {
          var mcx = hx + (fr1 - 0.5) * geo.hexW * 0.8;
          var mcy = hy + (fr2 - 0.5) * geo.hexR * 0.8;
          var mr = geo.hexW * (0.20 + fr3 * 0.15);
          ctx.strokeStyle = 'rgba(126,152,150,' + (0.22 + fr2 * 0.10).toFixed(2) + ')';
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.arc(mcx, mcy, mr, Math.PI * 1.02 + fr1 * 0.8, Math.PI * 1.72 + fr1 * 0.8);
          ctx.stroke();
          ctx.fillStyle = 'rgba(226,236,232,' + (0.20 + fr3 * 0.14).toFixed(2) + ')';
          ctx.beginPath(); ctx.arc(mcx + mr * 1.25, mcy + 1.8, 0.8, 0, Math.PI * 2); ctx.fill();
          continue;
        }
        var wx0 = hx + (fr1 - 0.5) * geo.hexW * 1.2;
        var wy0 = hy + (fr2 - 0.5) * geo.hexR * 1.2;
        var wl = geo.hexW * (1.1 + fr3 * 1.5);
        var wtilt = (fr1 - 0.5) * 0.25;
        ctx.strokeStyle = 'rgba(64,94,104,' + (0.16 + fr2 * 0.10).toFixed(2) + ')';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(wx0 - wl * 0.5, wy0 + wtilt * wl * 0.5);
        ctx.quadraticCurveTo(wx0 - wl * 0.1, wy0 - wl * 0.13, wx0 + wl * 0.12, wy0 - wl * 0.02);
        ctx.quadraticCurveTo(wx0 + wl * 0.32, wy0 + wl * 0.06, wx0 + wl * 0.5, wy0 + wtilt * wl * 0.3);
        ctx.stroke();
        if (fr3 > 0.55) {
          ctx.strokeStyle = 'rgba(70,100,110,' + (0.10 + fr2 * 0.06).toFixed(2) + ')';
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(wx0 - wl * 0.16, wy0 + 2.4);
          ctx.quadraticCurveTo(wx0 + wl * 0.06, wy0 + 1.2, wx0 + wl * 0.26, wy0 + 2.6);
          ctx.stroke();
        }
      }
    });
  }

  /* ---------- 建筑层: 在六边格上实时绘制 (真源 web/js/bldg_ink.js) ----------
     与「图标代替建筑」的区别:
       · 贴格  —— 每座建筑落在后端下发的 (q,r) 格心, 半径/朝向与地图网格同源;
       · 朝向  —— 按地类推导: 码头朝水面 / 炉窑朝山 / 料场朝林 / 民房朝中枢 /
                  殿宇坐北朝南, 探针失败才回退默认朝向;
       · 变体  —— 逐格取自 hash3(q,r,kind) → 同格恒定 (平移不闪), 异格各异;
       · 缓存  —— 绘制结果按 (种类+朝向+变体+等级+尺寸档) 存小位图, 平移只做贴图。
     ⚠ 必须整块绘制在 drawEntityList 之前 (建筑在地面, 名牌/标记在其上)。 */
  var BI = window.BldgInk;
  var CS_OFF = 16;                 // 后端 chunk 覆盖 ca*chunkS ± 16 (=33 格边长)
  var CS_SPAN = 33;
  /* 精灵渲染半径档 (设备像素): 随 zoom 拾级而上, 换档即清缓存 → 单档位内条数有界 */
  var R_BUCKETS = [8, 11, 15, 20, 27, 36, 48, 64];
  var lastRBucket = -1;
  var bldgShown = false;           // 本帧建筑层是否已绘制 (供实体图标让位)
  var bldgPlan = [];               // 复用的绘制计划数组
  /* DEBUG: 本帧每座聚落**实际画出去**的匾额落点 (屏幕 px) —— __plaqProbe 读它,
     用来把「签/线/点落在哪」变成可读数 (而不是从截图目测)。空对象 = 非 DEBUG。 */
  var plaqDrawn = {};
  /* 表现升级的验数指标 (2026-09-14): headless 无法"看"图, 改由 window.__feat()
     取这些运行期事实 —— 桥数/签数/虚线段数/让位裁掉多少精灵/灵脉峰与大世界峰各几座。
     只在 DEBUG 下读取, 计数开销可忽略 (整数自增)。 */
  var statBridge = 0;              // 本帧压水建筑 → 画了几座栈桥
  var statBanner = 0;              // 本帧竖排匾额画了几块
  var statVeinBanner = 0;          // 本帧灵脉签画了几块 (灵脉名可单独关后, 与聚落签分开验数)
  var statWaterQuads = 0;          // 上次重建道路时水上虚线段的四边形数
  /* 格 → 地类 (biome)。数据来自已加载区块; 未加载返回 -1 (探针自动放弃)。
     ⚠ 区块归属**不能**用 round(q/chunkS): 引擎 chunkOfTile 是「区块格心四候选
       取六边距最近 + 固定平局序」, 与四舍五入不等价 (chunkS=21 时 (32,32) 归
       (2,1) 而 round 给 (2,2))。这里改为枚举 4 个候选区块、直接问「索引里有没有
       这一格」—— 索引本身由服务端 qrel 生成, 归属天然权威, 无需复制平局规则。
       (2026-09-13 w6 对拍: round 版本 3 区块中 2 个整体错位) */
  function buildTileIdx(info, ca, cb) {
    var d = info.arrays, S = geo.chunkS;
    var idx = new Int16Array(CS_SPAN * CS_SPAN);
    idx.fill(-1);
    var hw = geo.hexW, h15 = 1.5 * geo.hexR;
    for (var i = 0; i < d.count; i++) {
      /* centers 由 (qa,ra) 用同一公式正算 → 反解取整即精确还原 */
      var ra = Math.round(d.centers[i * 2 + 1] / h15);
      var qa = Math.round(d.centers[i * 2] / hw - ra / 2);
      var cq = qa - ca * S + CS_OFF, cr = ra - cb * S + CS_OFF;
      if (cq >= 0 && cq < CS_SPAN && cr >= 0 && cr < CS_SPAN) idx[cr * CS_SPAN + cq] = i;
    }
    info.tileIdx = idx;
  }
  function biomeAt(q, r) {
    if (!geo) return -1;
    var S = geo.chunkS;
    var qb = Math.floor(q / S) * S, rb = Math.floor(r / S) * S;
    for (var a = 0; a < 4; a++) {
      var ca = (qb + (a % 2) * S) / S, cb = (rb + (a >> 1) * S) / S;
      var info = chunkData.get(chunkKey(ca, cb));
      if (!info) continue;
      if (!info.tileIdx) buildTileIdx(info, ca, cb);
      var cq = q - ca * S + CS_OFF, cr = r - cb * S + CS_OFF;
      if (cq < 0 || cq >= CS_SPAN || cr < 0 || cr >= CS_SPAN) continue;
      var i = info.tileIdx[cr * CS_SPAN + cq];
      if (i >= 0) return (info.arrays.tiles[i] / 4) | 0;
    }
    return -1;
  }
  /* 格 → 海拔 (九版新增, 灵脉「山地底座」用)。查法与 biomeAt 同一套
     (四候选区块 + 服务端权威索引); 未加载 → -1 (调用方按"平原"处理, 只是不垫底座)。 */
  function elevAtTile(q, r) {
    if (!geo) return -1;
    var S = geo.chunkS;
    var qb = Math.floor(q / S) * S, rb = Math.floor(r / S) * S;
    for (var a = 0; a < 4; a++) {
      var ca = (qb + (a % 2) * S) / S, cb = (rb + (a >> 1) * S) / S;
      var info = chunkData.get(chunkKey(ca, cb));
      if (!info) continue;
      if (!info.tileIdx) buildTileIdx(info, ca, cb);
      var cq = q - ca * S + CS_OFF, cr = r - cb * S + CS_OFF;
      if (cq < 0 || cq >= CS_SPAN || cr < 0 || cr >= CS_SPAN) continue;
      var i = info.tileIdx[cr * CS_SPAN + cq];
      if (i >= 0) return info.arrays.elevs[i];
    }
    return -1;
  }
  /* 单个区块的「格键 → 海拔」小表 (建一次挂在 info 上; arrays 不可变 ⇒ 无需失效)。
     比逐格 elevAtTile 少一次四候选搜索 —— 供 refreshChunkProps 逐精灵取海拔。 */
  function tileElevMap(info) {
    if (info.tileElev) return info.tileElev;
    var a = info.arrays, m = new Map();
    for (var i = 0; i < a.count; i++) {
      var t = worldToTileI(a.centers[i * 2], a.centers[i * 2 + 1]);
      m.set(t.q + ',' + t.r, a.elevs[i]);
    }
    info.tileElev = m;
    return m;
  }

  /* 灵脉签的**横向**落点偏移 (世界单位): 峰尖不在格心正上方, 偏一个精灵随机抖动。
     真源在 vein-skin.apexJx (与 renderer PROP_VS 的 jx 同式); hash 未到货时返 0
     ⇒ 回落格心 (区块到货重绘自愈)。 */
  function veinJxU(v) {
    if (!VS || !VS.apexJx) return 0;
    return VS.apexJx(propHashAt(v.q, v.r));
  }

  /* 灵脉峰「格心 → 峰尖」的上屏高度 (uR 倍数) —— 灵脉签的**垂直落点** ——
     ★ C-c (2026-09-15): 与 renderer.js 的 PROP_VS **逐项对齐**, 不再留经验余量。
     ★★ C-c 二修 (2026-09-16): 落点由**方框顶**改**真实峰尖** (vein-skin.tipU 内含
        apexV 折算), 并把该精灵的 hash 传下去 (峰尖高度 hrand 与横向抖动 jx 都随 hash)。

     精灵方框在 shader 里的垂直摆位 (renderer.js:272-273):
       bottom = iCenter.y + uR*0.95;   // 方框底压向下一格 → 立体堆叠
       world.y = bottom - (1-vv)*H;    // vv=0 是精灵顶部 ⇒ 方框顶 = center.y + uR*(0.95 - H)
     ⚠ 但**方框顶 ≠ 峰尖**: 128 逻辑格里峰尖上方还有一段空白 (格 y 0..~21 是空的),
       峰尖在方框里的相对位置 = apexV() (vein-skin.js 复算, 现值 0.1489)。于是
         **峰尖相对格心的上探量 = (1 - apexV())*H - 0.95** (uR), 其中 (renderer.js:220/238)
         H = (3.3+1.2*hrand)*hs*sizeScale + (3.3+1.2*hrand)*bhs

     ⚠ 旧实现返回 `H_est + 0.35` ⇒ 原先的悬空 = (0.95 + 0.35) + apexV*H
       = 1.30 + (1.19~1.49) ≈ 2.5~2.8 uR (≈64~72px @hexR=25.6) —— 用户看到的
       「点子悬在峰上半空、竖线没搭到峰上」是这个常数差 + 方框顶口径一起造成的,
       分两次修完 (第一次 1.30, 第二次 apexV*H)。
     ⚠ hrand 取**本档包络的中点**, 不再写死 0.86 —— 0.86 只是「大」档的中点
       (中 0.93 / 小 0.91 / 从属 0.78), 写死会让中/小档的底座偏矮。
       精灵逐 hash 的真实 hrand 在包络内随机 ⇒ 拿不到 hash 时残留误差最坏
       ≈0.33 uR (≈8px, 大档高海拔处; 区块到货即自愈)。
     ⚠ ★ 公式**只此一份**, 在 vein-skin.js 的 VS.tipU —— 本函数只负责取海拔与 hash
       再转调, 不再内联 (内联会在 shader 调参后静默漂移, 这正是 C-c 之前的病根)。
     ⚠ elevAtTile 未加载时返 -1 ⇒ 走该档 coreElev 估计 (偏矮但不悬空)。区块到货会
       markStaticDirty → 本函数重算, 自愈 (标签在静态层重绘时重建)。 */
  function veinTopU(v) {
    var e = elevAtTile(v.q, v.r);
    if (VS && VS.tipU) return VS.tipU(v.level, e, propHashAt(v.q, v.r));
    return 2.5;   // 兜底: 与「大」档量级相当, 不在热路径上 (VS 未加载时才会走)
  }

  /* 格 → 服务端精灵实例的随机 hash。
     只为灵脉签的落点服务 (C-c 二修 2026-09-16): 灵脉峰的**峰尖**高度与横向抖动
     都由该精灵的 iHash 决定 (shader: hrand = fract(hash*5.17), jx = fract(hash*3.77)),
     拿到 hash 才能把签子算到"看得见的那个尖"上, 而不是包络中点 + 格心。
     ⚠ 用 arrays 里的原始精灵表 (不是被让位过滤后重传的 GPU 副本) —— 灵脉格永不被
       让位, 两者对灵脉格同值, 但 arrays 不可变 ⇒ 索引可安全缓存在 info 上。
     ⚠ 区块未到货返回 null ⇒ 调用方回落到包络中点/格心 (区块到货会重绘自愈)。 */
  function propHashAt(q, r) {
    if (!geo) return null;
    var S = geo.chunkS;
    var qb = Math.floor(q / S) * S, rb = Math.floor(r / S) * S;
    for (var a = 0; a < 4; a++) {
      var ca = (qb + (a % 2) * S) / S, cb = (rb + (a >> 1) * S) / S;
      var info = chunkData.get(chunkKey(ca, cb));
      if (!info) continue;
      if (!info.propIdx) {
        var arr = info.arrays, m = new Map();
        /* ⚠ 纯海区块 pn=0 ⇒ chunkToArrays 给的是 **null 而非空数组** (见 MEMORY):
           读 .length 会抛异常, 必须判空。 */
        var pc = arr.propCenters, psp = arr.propSprites;
        for (var i = 0; psp && pc && i < psp.length; i++) {
          var t = worldToTileI(pc[i * 2], pc[i * 2 + 1]);
          m.set(t.q + ',' + t.r, i);
        }
        info.propIdx = m;
      }
      var j = info.propIdx.get(q + ',' + r);
      if (j != null) {
        var hs = info.arrays.propHashes;      // 同上: 可能为 null
        return (hs && j < hs.length) ? hs[j] : null;
      }
    }
    return null;
  }

  /* ---------- 地表让位: 道路/建筑覆盖格上的树·山一律抹平 ----------
     规则 (2026-09-14): 凡被墨路或建筑占地之处, 地面不再起树、不再起山 —— 呈平地;
     压水的情形另由「栈桥 / 虚线航道」承担 (见 drawBuildings 与道路段分流)。
     建筑格来自 settleCells, 路格来自 regionCells 折线沿采样 —— 前端全都有,
     但区块数据里的 propSprites 是服务端一次算好的 ⇒ 必须在传 GPU 前过滤掉。 */
  function worldToTileI(x, y) {
    var ra = Math.round(y / (1.5 * geo.hexR));
    return { q: Math.round(x / geo.hexW - ra / 2), r: ra };
  }
  function rebuildPropBlock() {
    propBlock.clear();
    settleCells.forEach(function (ents) {
      for (var i = 0; i < ents.length; i++) {
        var st = ents[i];
        if (st.state === 1 || !st.buildings) continue;
        for (var j = 0; j < st.buildings.length; j++)
          propBlock.add(st.buildings[j].q + ',' + st.buildings[j].r);
      }
    });
    regionCells.forEach(function (pack) {
      var roads = pack.roads || [];
      for (var r = 0; r < roads.length; r++) {
        var pts = roads[r].pts;
        /* 折线按 ~1/3 格步长采点: 采到的是「路真正压过的格」, 不是只压端点 */
        for (var p = 0; p + 3 < pts.length; p += 2) {
          var ax = pts[p], ay = pts[p + 1], bx = pts[p + 2], by = pts[p + 3];
          var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 1;
          var n = Math.max(1, Math.ceil(len / (geo.hexW * 0.34)));
          for (var s = 0; s <= n; s++) {
            var t = s / n;
            var wt = worldToTileI(ax + dx * t, ay + dy * t);
            propBlock.add(wt.q + ',' + wt.r);
          }
        }
      }
    });
    blockedVer++;
  }
  /* 逐块过滤精灵。只在 blockedVer 变化 (或该块新到) 时算一次 —— 平移/缩放零开销。
     ⚠ 区块**可以一个精灵都没有** (纯海区块 pn=0): 此时 pb.chunkToArrays 给的是
       null 而不是空数组 (实测 chunk (1,-3) 即如此) —— 直接读 .length 会在渲染
       循环里抛异常 → showFatal 整页不可用。取值前必须判空。 */
  function refreshChunkProps(key) {
    var info = chunkData.get(key);
    if (!info) return;
    if (propBuilt.get(key) === blockedVer) return;
    propBuilt.set(key, blockedVer);
    var a = info.arrays;
    var n = a.propSprites && a.propCenters ? a.propSprites.length : 0;
    info.propOrig = n;                          // 验数: 服务端给的精灵总数
    info.propKept = n; info.keptVein = 0; info.keptMtn = 0; info.keptOther = 0;
    if (!n) return;
    /* A/B 调试: noyield=1 → 不抹平 (精灵全留), 用于证明让位确实生效 */
    if (NO_YIELD) return;
    var c = new Float32Array(n * 2), sp = new Float32Array(n),
        hs = new Float32Array(n), el = new Float32Array(n);
    var m = 0, hv = 0, hm = 0;
    /* 本块的「格键 → 海拔」表 (惰性建): 只给灵脉峰查"该格海拔"用 (见下方 el[m]) */
    var elevOf = null;
    for (var i = 0; i < n; i++) {
      var x = a.propCenters[i * 2], y = a.propCenters[i * 2 + 1];
      var t = worldToTileI(x, y);
      if (propBlock.has(t.q + ',' + t.r)) continue;      // 被路/建筑压住 → 抹平
      var sid = a.propSprites[i];
      /* 验数: 灵脉峰 = 五行峰 50..54 (第 6 行 2~6 列) + 异灵根峰 32..35 (第 4 行 0..3 列);
         大世界岩峰/雪峰 = 40/41/56/57/42/43/58/59 */
      var isVein = (sid >= 50 && sid <= 54) || (sid >= 32 && sid <= 35);
      if (isVein) hv++;
      else if (sid === 40 || sid === 41 || sid === 56 || sid === 57 ||
               sid === 42 || sid === 43 || sid === 58 || sid === 59) hm++;
      c[m * 2] = x; c[m * 2 + 1] = y;
      sp[m] = sid; hs[m] = a.propHashes[i];
      /* ⚠ 灵脉峰的第 4 通道要**复合等级与海拔**: 服务端给的 propElevs[i] 是灵脉等级
         (0大/1中/2小/3从属), 而"在原来的山之上再加峰高"还需**该格真实海拔** —— 它只在地块段
         (arrays.elevs) 里。合成 (等级 + 海拔)/4 后上传, 由 renderer.js PROP_VS 还原
         (精灵段的海拔通道是 u16 量化、值域 [0,1], 装不下两个量, 故先归一化压进去)。
         ⚠ 十一版 D1: 除数由 3 改 **4** (新增第 4 档「从属」) —— 上界 (3+1)/4 = 1.0 恰好不溢出,
           换档位数时**必须重算这个上界**, 否则 iElev > 1 被 clamp 后等级错档。 */
      if (isVein) {
        if (!elevOf) elevOf = tileElevMap(info);
        el[m] = (a.propElevs[i] + (elevOf.get(t.q + ',' + t.r) || 0)) / 4;
      } else {
        el[m] = a.propElevs[i];
      }
      m++;
    }
    info.propKept = m; info.keptVein = hv; info.keptMtn = hm; info.keptOther = m - hv - hm;
    /* 一个都没裁且 GPU 上本来就是全量 → 不重传 (首次上传已含全部精灵)。
       若上一轮裁过而本轮全保留 (覆盖格移出视野), 必须重传回全量。 */
    if (m === n && !info.propCut) return;
    info.propCut = m !== n;
    renderer.updateProps(key, {
      propCenters: c.subarray(0, m * 2), propSprites: sp.subarray(0, m),
      propHashes: hs.subarray(0, m), propElevs: el.subarray(0, m)
    });
  }
  function syncPropBlock() {
    if (syncedVer === blockedVer) return;
    syncedVer = blockedVer;
    chunkData.forEach(function (_info, key) { refreshChunkProps(key); });
  }

  /* 朝向求解器来自绘制核心 (web/js/bldg_ink.js 的 faceSolver):
     朝向规则表/回退逻辑/环枚举与离线预览页、对拍脚本共用同一份实现,
     本文件只负责把「浏览器侧的 biomeAt」注入进去。geo 就绪后建一次即可。 */
  var bldgSolver = null;
  function solverFor() {
    if (!bldgSolver && geo && BI && BI.faceSolver) {
      bldgSolver = BI.faceSolver({ biome: biomeAt, hexW: geo.hexW, hexR: geo.hexR, ringMax: 3 });
    }
    return bldgSolver;
  }
  /* 逐格变体: 同 kind 同格恒定 → 平移/重绘不闪; 异格不同 → 去掉重复感。
     精灵缓存键不含格位, 故变体个数即「同种建筑可见造型数」→ 取 8 档。 */
  function variantOf(b) {
    return BI.hash3(b.q | 0, b.r | 0, BI.kindIdOf(b.kind)) % 8;
  }
  function bucketOf(rDev) {
    for (var i = 0; i < R_BUCKETS.length; i++) if (rDev <= R_BUCKETS[i]) return i;
    return R_BUCKETS.length - 1;
  }
  /* 稀有「地标」建筑 (全图出现 <150): 缩远时若与常规建筑一起砍掉, 这几座等于白画
     —— 战略视图下正是要找它们。名单与 `tools/stats_buildings.mjs` 的稀有档一致。 */
  var RARE_KINDS = { '炼炉': 1, '官衙': 1, '焦炭窑': 1, '宗祠': 1, '祭坛': 1, '聚灵阵': 1, '灵枢殿': 1 };
  /* A2 (2026-09-16 用户定案): 水面格**本就有对应画法**的 kind —— 见 drawBuildings。
     这些 kind 压在水上时**不**改写成「栈桥」, 而是按本体画 + 走渔家皮肤。
     名单 = 引擎「渔家」池 (民房/仓库/码头/渔船坞/渔亭) —— 即水面格现在真正会抽到的全集。
     白名单外 (核心建筑/田地/矿场等) 压水时仍走「栈桥」兜底, 不改既有语义。 */
  var WATER_KIND = { '民房': 1, '仓库': 1, '码头': 1, '渔船坞': 1, '渔亭': 1 };
  /* A2 A/B 档位 (2026-09-16): `?water=old` 还原改前的旧口径 ——
     「水面格一律改画『栈桥』, 且该格不画地盘环」。只为**同机位差分**取证用
     (见 verify/check_fish_skin.mjs G11); 线上默认走新口径 (按本体 kind 画 + 渔家皮肤 + 恒画地盘环)。 */
  var WATER_OLD = (function () {
    try { return /[?&]water=old(&|$)/.test(location.search); } catch (e) { return false; }
  })();
  /* ============================================================
   * R6b 「归属势力」(B · 2026-09-15)
   * ------------------------------------------------------------
   * 用户原话:「也没给渔村下面弄**归属势力**的图」。病根: 协议里早有 owner 字段
   *   (MapMessages.cs:82), 但引擎恒写空串 (mapgen.js:1204) ⇒ 前端从来没得可读;
   *   而现有的地盘色 (R6 townColor) 是"区分同屏不同城镇"的**位置派生色**, 与归属无关
   *   (同镇的村子在这个口径下必然**不同色**, 恰好与"归属"相反)。
   *
   * 本层取 **B-A 路线: 前端派生** —— 扫已加载的聚落实体, 取**最近的宗门**当归属。
   *   优点: 零协议改动、零清库、可单点回退; 缺点: **不是世界真值** (只覆盖已加载的
   *   聚落包 ⇒ 视野外无宗门时该聚落暂时"无归属")。等事件系统给引擎补 owner 后,
   *   只需把 `factionOf` 的返回改成读 `ent.owner` (B-B), 绘制层与记号层一行不用改。
   *
   * 判域口径**镜像引擎**: mapgen.js:1174 判"是否在灵脉域内"用的是
   *   `cn.dist < CFG.COMM_R * 1.4` (= 25 × 1.4 = 35 格)。这里用同一个半径当
   *   "宗门辖区"上限 —— 超出即视为荒野聚落 (不画归属记号)。
   *   ⚠ 这是**镜像常量**: 引擎改了这里不改, 归属圈会跟着错。故 verify/check_faction.mjs
   *     逐值断言 `SECT_DOMAIN_R === MGCfg.COMM_R * 1.4`。
   * ============================================================ */
  var SECT_DOMAIN_R = 35;             // = 引擎 CFG.COMM_R(25) × 1.4
  var settleVer = 0;                  // 每有新的 settle 图层到货 ++ ⇒ factionOf 缓存失效
  var FAC_OK = (function () {         // ?fac=0 关掉归属层 (同机位 A/B 差分用)
    try { return !/[?&]fac=0(&|$)/.test(location.search); } catch (e) { return true; }
  })();
  /* 最近宗门 (轴向六边距)。结果缓存到 st._fac, 靠 settleVer 失效 ——
     ⚠ 不能只缓存一次: 首个 settle 包到达时附近可能还没有宗门, 那样会被"
     永久锁定为无归属"(旧 bldgAnchor 踩过同类坑, 见那里的注释)。 */
  function factionOf(st) {
    if (!FAC_OK || !st) return null;
    if (st.type === 'sect') return st;                 // 宗门自己归自己
    if (st._facV === settleVer) return st._fac || null;
    st._facV = settleVer;
    st._fac = null;
    var bd = 1e9, best = null;
    settleCells.forEach(function (ents) {
      for (var i = 0; i < ents.length; i++) {
        var e = ents[i];
        if (e.type !== 'sect' || e.state === 1) continue;
        var d = hexDist(st.q | 0, st.r | 0, e.q | 0, e.r | 0);
        /* 并列取 id 小者 —— 纯为了"确定性": 同一局地图任何两次刷新给出同一个归属 */
        if (d < bd - 1e-9 || (d <= bd + 1e-9 && best && (e.id || '') < (best.id || ''))) {
          bd = d; best = e;
        }
      }
    });
    if (best && bd <= SECT_DOMAIN_R) st._fac = best;
    return st._fac;
  }
  /* 势力色: **同宗同色** (这正是"归属"的意义 —— 与 R6 的"异镇异色"相反)。
     由宗门的 (q,r) 派生 ⇒ 跨会话稳定。色相全周展开 (不用 R6 的按 type 分带,
     因为归属色要在**不同宗门之间**互相区分, 不是在同一类型内部区分)。 */
  function factionColor(sect) {
    if (!sect) return null;
    var hh = townColorHash(sect.q | 0, sect.r | 0, 0x5ec7);
    var hue = hh % 360;
    var sat = 44 + (hh >>> 9) % 18;                    // 44~61% (比城镇色更"旗帜"一点)
    var lig = 38 + (hh >>> 17) % 12;                   // 38~49%
    return 'hsl(' + hue + ',' + sat + '%,' + lig + '%)';
  }
  /* 势力「记号签名」: 造形三要素一次性派生 —— 刻痕数 (3~6) / 起始相位 / 印纹 (0~7)。
     三者同源 ⇒ 同一势力处处一致; 且两两组合空间 4×6×8=192 ⇒ 同屏几家门派几乎不会撞。 */
  function factionSig(sect) {
    if (!sect) return null;
    var hh = townColorHash(sect.q | 0, sect.r | 0, 0x7a11);
    return { crest: 3 + (hh % 4), crestRot: ((hh >>> 7) % 6) * (Math.PI / 3), seal: (hh >>> 13) % 8 };
  }
  /* R6 (2026-09-15 十一版): 城镇地盘色 —— 由聚落**位置 + 类型**派生确定性 HSL。
     同一城镇恒同色、异镇异色、跨会话稳定; 色相按 type 分带 (城/镇/村/宗门/渔村各占一段),
     避免满屏同色; 不落协议 (纯前端派生)。⚠ 不用 st.id: 客户端实体未必带该字段 (以 q,r 为准)。
     ★ R6b (B): **有归属时改由势力色接管** (同宗同色) —— 无归属才退回本口径。 */
  var TOWN_HUE = { city: 22, town: 46, village: 142, sect: 268, fishing: 196 };
  function townColorHash(a, b, c) {
    var h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    return h >>> 0;
  }
  function townColor(st) {
    var fac = factionOf(st);
    if (fac) return factionColor(fac);                 // 归属优先: 同宗同色
    var base = TOWN_HUE[st && st.type];
    if (base == null) base = 200;
    var tKey = st && st.type ? st.type.length : 0;
    var hh = townColorHash(st && st.q | 0, st && st.r | 0, tKey);
    var hue = (base + (hh % 29) - 14 + 360) % 360;      // 同带内 ±14° 抖动 (区分同类型不同城镇)
    var sat = 40 + (hh >>> 8) % 20;                     // 40~59%
    var lig = 39 + (hh >>> 16) % 11;                    // 39~49%
    return 'hsl(' + hue + ',' + sat + '%,' + lig + '%)';
  }
  /* 屏幕空间 (dpr 变换下) 逐格贴图。
     六边格半径 <5px (tiny) 时: 常规建筑交给聚落图标, 只保留稀有地标 (抬最小尺寸),
     否则「全图没几座」的建筑在战略视图里等于白画。
     ⚠ tiny 模式**不置 bldgShown** —— 它是「本帧建筑层已覆盖」的信号, 实体图标据此让位;
       若置真, 所有聚落图标都会让位, 而实际只画了极少数地标 (整体反而更空)。 */
  function drawBuildings(ctx, vw, vh, z) {
    bldgShown = false;
    statBridge = 0;
    if (NO_BLDG) return;                       // headless A/B 验证开关 (见顶部 NO_BLDG)
    var solver = solverFor();
    if (!BI || !BI.spriteOf || !geo || !solver) return;
    var tiny = geo.hexR * z < 5;
    var tgt = geo.hexR * z * dpr;                 // 目标半径 (设备像素)
    var bkt = bucketOf(tgt);
    if (tiny) bkt = 0;                            // tiny: 强制最小档 (R=8)
    if (bkt !== lastRBucket) { BI.spriteClear(); lastRBucket = bkt; }
    var R = R_BUCKETS[bkt], scale = tiny ? 1 : tgt / R;
    var detail = z >= 1.35 ? 3 : (z >= 0.9 ? 2 : 1);
    var list = bldgPlan;
    list.length = 0;
    settleCells.forEach(function (ents) {
      for (var i = 0; i < ents.length; i++) {
        var st = ents[i];
        if (st.state === 1 || !st.buildings || !st.buildings.length) continue;
        for (var j = 0; j < st.buildings.length; j++) {
          var b = st.buildings[j];
          if (tiny && !RARE_KINDS[b.kind]) continue;   // tiny: 只留稀有地标
          var w = MC.tileToWorld(b.q, b.r);
          var ps = w2s(w.x, w.y);
          /* 留足余量: 栈桥/树冠/幡可越出本格 (SPR_BOX 上界 2.4R) */
          if (ps.x < -70 || ps.y < -100 || ps.x > vw + 70 || ps.y > vh + 100) continue;
          list.push({ b: b, st: st, x: ps.x * dpr, y: ps.y * dpr, d: w.y, bio: biomeAt(b.q, b.r) });
        }
      }
    });
    if (!list.length) return;
    /* 深度序: 世界 y 小者远, 先画; 同深按 q 定序, 保证遮挡关系稳定不闪 */
    list.sort(function (p, q2) { return (p.d - q2.d) || (p.b.q - q2.b.q); });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);           // 精灵为设备像素位图 → 原样贴
    for (var k = 0; k < list.length; k++) {
      var it = list[k], b = it.b;
      var fi = solver.faceInfo(b, it.st);
      /* 建筑压水 (本格是水)。
         A2 (2026-09-16 用户定案): 旧口径不论 kind 一律改画「栈桥」 ⇒ 沿海聚落水上一排
           光板桥 (用户: "还是跟桥梁一样")。现改为 —— 水面格**按本体 kind 画**,
           因为引擎已把**任何聚落**的水面格判为『渔家』, 抽到的本就是该在水上的
           民房/仓库/码头/渔船坞/渔亭; 再由 fishVillage 走渔家皮肤 (吊脚楼/渔获仓)。
         「栈桥」降级为**白名单外** kind 的兜底 (核心建筑/田矿等本不该在水上);
           渔村自身的既有语义 (isFish) 仍豁免, 不回归。 */
      var onWater = it.bio === 0 || it.bio === 1;
      var isFish = it.st.type === 'fishing';
      var bridge = onWater && !isFish && (WATER_OLD || !WATER_KIND[b.kind]);
      var rec = BI.spriteOf({
        kind: bridge ? '栈桥' : b.kind, q: b.q, r: b.r, variant: variantOf(b), tier: b.tier,
        face: fi.face, water: fi.water, R: R, detail: detail,
        plate: false,                            // R6: 地盘改由城镇色**现画** (见下), 精灵内不再烘地皮色
        onWater: onWater,                        // R5b: 水上格 → 垫干栏木台 (水上人家)
        fishVillage: WATER_OLD ? isFish : (isFish || onWater)   // A2: 水面格也走渔家皮肤
      });
      if (!rec) continue;
      if (bridge) statBridge++;                  // 验数: 本帧画了几座栈桥 (水→桥)
      /* R6 (2026-09-15 十一版): 城镇地盘 —— 逐格现画 (设备像素, 不进精灵缓存),
         颜色 = 所属城镇 (同镇同色、异镇异色、跨会话稳定)。灵脉格禁建 (R4) ⇒ 建筑格非灵脉格。
         R10 (2026-09-15 十一版): 地盘改**中空正六边形环** (半径带 0.80R~0.90R), 实心块作废;
         海上渔村同走本函数 ⇒ 海上的地盘也一并变成空环。
         A2 (2026-09-16 用户定案): **水陆都要画** —— 旧口径 `if (!bridge)` 把水面格整段
           跳过 ⇒ 水上建筑下面没有六边环 (用户: "下面没有正六边形的框框")。现无差别绘制。
         `?water=old` 档位下恢复旧的 `if (!bridge)` 语义 (同机位 A/B 差分)。 */
      if (!bridge || !WATER_OLD) {
        /* R6b (B): 归属记号 —— seal (环心印纹) / crest (环外刻痕) 都由**归属势力**派生,
           同宗处处一致。无归属的荒野聚落传 null/0 ⇒ 保持纯环 (不臆造记号)。
           水上聚落额外 water:true ⇒ 内外各补一道亮描边 (深水底上单环对比不足)。 */
        var fac = factionOf(it.st), sig = factionSig(fac);
        BI.plateAt(ctx, { cx: it.x, cy: it.y, R: R * scale, tint: townColor(it.st),
                          a: 0.40, edge: true, la: 0.44,
                          water: !!onWater,
                          seal: sig ? sig.seal : null,
                          crest: sig ? sig.crest : 0,
                          crestRot: sig ? sig.crestRot : 0,
                          sc: fac ? factionColor(fac) : null, sa: 0.62 });
      }
      ctx.drawImage(rec.cv, it.x + rec.ox * scale, it.y + rec.oy * scale,
                    rec.w * scale, rec.h * scale);
    }
    ctx.restore();
    bldgShown = !tiny;                         // tiny 只画了少数地标 ⇒ 不遮挡聚落图标
  }

  function renderStaticInto() {
    var cw = els.overlay.width, ch = els.overlay.height;
    statBanner = 0;                            // 验数: 本帧匾额计数归零
    statVeinBanner = 0;                        // 验数: 灵脉签计数归零
    bannerBoxes.length = 0;                     // 签位占用表同步清空 (避让用)
    if (DEBUG) plaqDrawn = {};                  // 匾额落点记录同步归零 (只有 DEBUG 会读)
    if (!staticLayer) staticLayer = document.createElement('canvas');
    if (staticLayer.width !== cw || staticLayer.height !== ch) {
      staticLayer.width = cw; staticLayer.height = ch;
    }
    var ctx = staticLayer.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    var b = viewBounds();

    ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
      dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
      dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
    var z = cam.zoom;

    /* 匾额锚点调试层 (plaqdbg=1): 把「牌匾锚点 vs 真实地物」一次标全 ——
       绿=聚落中心 st.x/y · 黄=聚落格 tileToWorld(q,r) · 青=建筑包围盒锚点 ·
       橙点=每个建筑格 · 品红=灵脉 v.x/y。只为 headless 定位偏差, 不进产品路径。 */
    function drawPlaqueDbg(dctx) {
      function mk(sx, sy, col, label, dy) {
        dctx.strokeStyle = col; dctx.lineWidth = 1.4;
        dctx.beginPath();
        dctx.moveTo(sx - 8, sy); dctx.lineTo(sx + 8, sy);
        dctx.moveTo(sx, sy - 8); dctx.lineTo(sx, sy + 8);
        dctx.stroke();
        if (!label) return;
        dctx.font = 'bold 11px monospace';
        dctx.textAlign = 'left'; dctx.textBaseline = 'middle';
        var tw = dctx.measureText(label).width, ty = sy + (dy || 0);
        dctx.fillStyle = 'rgba(8,8,8,0.78)';
        dctx.fillRect(sx + 9, ty - 7, tw + 5, 14);
        dctx.fillStyle = col;
        dctx.fillText(label, sx + 11, ty);
      }
      settleCells.forEach(function (ents) {
        ents.forEach(function (st) {
          if (st.state === 1) return;
          if (!st.buildings || !st.buildings.length) return;
          for (var i = 0; i < st.buildings.length; i++) {
            var w = MC.tileToWorld(st.buildings[i].q, st.buildings[i].r);
            var s = w2s(w.x, w.y);
            dctx.fillStyle = 'rgba(255,132,0,0.95)';
            dctx.fillRect(s.x - 2.5, s.y - 2.5, 5, 5);
          }
          var pc = w2s(st.x, st.y);
          mk(pc.x, pc.y, 'rgba(30,230,90,1)', st.name + '·中心', -30);
          var tw2 = MC.tileToWorld(st.q, st.r);
          var tc = w2s(tw2.x, tw2.y);
          mk(tc.x, tc.y, 'rgba(255,226,0,1)', st.name + '·格', -14);
          var an = bldgAnchor(st), as = w2s(an.x, an.y);
          mk(as.x, as.y, 'rgba(0,226,255,1)', st.name + '·型箱', 2);
        });
      });
      for (var q = 0; q < veinLabels.length; q++) {
        var sp = w2s(veinLabels[q].x, veinLabels[q].y);
        mk(sp.x, sp.y, 'rgba(255,40,210,1)', '脉·' + veinLabels[q].name, 16);
        /* C-c 二修验收入口: 青点 = 签子**算出来**的峰尖落点 (格心 + 抖动, 上抬 topU)。
           它必须压在山尖的墨色最上沿 —— 偏上/偏下/偏侧都说明 apexV/jx 与 shader 脱钩。 */
        var ap2 = w2s(veinLabels[q].x + (veinLabels[q].jxU || 0) * geo.hexR, veinLabels[q].y);
        mk(ap2.x, ap2.y - geo.hexR * z * veinLabels[q].topU,
           'rgba(0,226,255,1)', '峰尖·' + veinLabels[q].name, -16);
      }
    }

    /* 浪线 (基于区块数据, 无动画) */
    drawChunkWaves(ctx, b);

    /* 道路 (后端 A* 路径点) — T7: 仅路网数据变化时重建几何并重传 GPU
       ★ 陆上/水上分流 (2026-09-14): 过水段不铺路面, 改画**虚线航道** ——
         陆路是实体米色路面, 水上是断开的石青墨虚线, 一眼可辨"此段行船不走人"。 */
    if (roadsDirty) {
      roadsDirty = false;
      var haloV = [], coreV = [], waterV = [];
      function pushSeg(arr, ax, ay, bx, by, w) {
        var dx = bx - ax, dy = by - ay;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var nx = -dy / len * w * 0.5, ny = dx / len * w * 0.5;
        arr.push(ax - nx, ay - ny, bx + nx, by + ny, ax + nx, ay + ny,
                 ax - nx, ay - ny, bx - nx, by - ny, bx + nx, by + ny);
      }
      /* 虚线: 沿线段按 dash/gap 切段, 每段仍用 pushSeg 展宽 */
      function pushDash(arr, ax, ay, bx, by, w, dash, gap) {
        var dx = bx - ax, dy = by - ay;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dx / len, uy = dy / len, s = 0;
        while (s < len) {
          var e = Math.min(len, s + dash);
          pushSeg(arr, ax + ux * s, ay + uy * s, ax + ux * e, ay + uy * e, w);
          s = e + gap;
        }
      }
      function isWaterWorld(wx, wy) {
        var wt = worldToTileI(wx, wy);
        var bb = biomeAt(wt.q, wt.r);
        return bb === 0 || bb === 1;
      }
      var drawn = {};
      regionCells.forEach(function (pack) {
        /* D2: 区域包降级/半截时 roads/region 可能缺省 —— 直接取属性会抛异常,
           异常从 renderStaticInto 冒到主循环 → showFatal 整页不可用。 */
        var roads = pack.roads || [];
        for (var rr = 0; rr < roads.length; rr++) {
          var road = roads[rr];
          if (drawn[road.key]) continue;
          drawn[road.key] = true;
          /* 不做逐路视野裁剪: regionCells 本身随视野窗口卸载, 集合有界;
             若按重建时刻的视野裁剪, 平移离开后 roadsDirty=false 会导致远路缺失 */
          var pts = road.pts;
          var rh = 0;
          for (var kc = 0; kc < road.key.length; kc++) rh = (rh * 31 + road.key.charCodeAt(kc)) % 997;
          var wBase = 1.4 + (rh / 997) * 1.5;
          for (var p2 = 0; p2 < pts.length / 2 - 1; p2++) {
            var segH = Math.sin(p2 * 12.9898 + rh * 0.7853) * 43758.5453;
            var wob = segH - Math.floor(segH);
            var wm = wBase * (0.60 + 0.8 * wob);
            var ax = pts[p2 * 2], ay = pts[p2 * 2 + 1], bx = pts[p2 * 2 + 2], by = pts[p2 * 2 + 3];
            /* 端点任一在水里即判过水: 一格宽的河汊才能被两段虚线完整覆盖 */
            if (isWaterWorld(ax, ay) || isWaterWorld(bx, by)) {
              pushDash(waterV, ax, ay, bx, by, Math.max(1.3, wm * 1.15),
                       geo.hexW * 0.42, geo.hexW * 0.36);
            } else {
              pushSeg(haloV, ax, ay, bx, by, wm * 2.4);
              pushSeg(coreV, ax, ay, bx, by, Math.max(1.0, wm));
            }
          }
        }
      });
      statWaterQuads = waterV.length / 12;      // 验数: 水上一段虚线 = 一个四边形
      renderer.setRoads(new Float32Array(haloV), new Float32Array(coreV),
                        new Float32Array(waterV));
    }

    /* 灵脉: 七星花 + 群落灵气晕圈 (后端群落数据) */
    var veinLabels = [];
    if (showVeins) {
      commCells.forEach(function (cm) {
        if (!cm.exists) return;
        var cRGB = cm.elementRGB || (cm.elementRGB = geoElementColor(cm.element));
        var auraR = geo.commR * geo.hexW * 1.15;
        var cS = cRGB[0] + ',' + cRGB[1] + ',' + cRGB[2];
        var ag = ctx.createRadialGradient(cm.x, cm.y, auraR * 0.06, cm.x, cm.y, auraR);
        ag.addColorStop(0, 'rgba(' + cS + ',0.085)');
        ag.addColorStop(0.6, 'rgba(' + cS + ',0.035)');
        ag.addColorStop(1, 'rgba(' + cS + ',0)');
        ctx.fillStyle = ag;
        ctx.beginPath(); ctx.arc(cm.x, cm.y, auraR, 0, Math.PI * 2); ctx.fill();
        for (var vv = 0; vv < cm.veins.length; vv++) {
          var v = cm.veins[vv];
          var rgb = v.variant ? geoVariantColor(v.variant) : cRGB;
          /* R8 (2026-09-15 十一版): 灵脉「地盘」色环 —— 峰下铺一圈元素色六边地台,
             与 R6 的城镇地盘同一「六边地台」语汇, 让灵脉本体一眼分得清金木水火土。 */
          ctx.save();
          ctx.beginPath();
          hexPath(ctx, v.x, v.y, geo.hexR * 0.94);
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
          ctx.fill();
          ctx.globalAlpha = 0.55;
          ctx.strokeStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
          ctx.lineWidth = Math.max(0.8, geo.hexR * 0.09);
          ctx.stroke();
          ctx.restore();
          IT.drawVeinFlower(ctx, v.x, v.y, null, rgb, { level: v.level });
          /* 名牌文案: 「<地貌名>·<档>」—— 由 veinLabel() 统一 (2026-09-15 用户: 去括号,
             并用全角间隔号; 同时收掉「灵脉」叠字, 见 veinLabel 注释)。
             C-c 二修 (2026-09-16): 签子挂在**看得见的峰尖**上 —— 高度用 apexOf().topU
             (方框顶要按 apexV 折算, 见 veinTopU 注释), 横向要跟着精灵的随机抖动 jx
             走 (shader `jx = (fract(hash*3.77)-0.5)*1.8uR`)。原来的"格心 x + 方框顶"
             会让竖线落在峰的一侧、圆点悬在峰尖上方 (用户第二次报「对不上」)。 */
          veinLabels.push({ x: v.x, y: v.y, jxU: veinJxU(v), name: veinLabel(v),
                            rgb: rgb, level: v.level, topU: veinTopU(v) });
        }
      });
    }

    /* ---- 屏幕坐标系 ---- */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var vw = els.app.clientWidth, vh = els.app.clientHeight;

    if (showLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      regionCells.forEach(function (pack) {
        var rg = pack.region;
        if (!rg) return;                        // D2: 缺 region 的降级包直接跳过
        var ps = w2s(rg.x, rg.y);
        if (ps.x < -200 || ps.y < -100 || ps.x > vw + 200 || ps.y > vh + 100) return;
        var fs = Math.max(Math.sqrt(geo.regionM * geo.regionM) * 0.75, 12) * z;
        ctx.font = fs + 'px "KaiTi","STKaiti",serif';
        ctx.fillStyle = rg.biome <= 1 ? 'rgba(52,66,72,0.28)' : 'rgba(58,48,38,0.26)';
        ctx.fillText(rg.name, ps.x, ps.y);
      });
    }

    /* 建筑层 (地面实体 → 压在淡淡的区域名之上, 名牌/灵脉标之下) */
    drawBuildings(ctx, vw, vh, z);

    /* 聚落名牌的「挂牌锚点」(缓存) —— C-a 五修 (2026-09-16):
       ★ 默认落点 = **城市中心点** = 聚落中心格 (st.x, st.y)。**不经任何求解器**。
         用户原话: 「要和当前的城市的中心点位置一样, 而不是什么所谓的平均值或者参照物」。
       ★★ 为什么这就够 (离线跑引擎实测, seed42/777 共 90 座): 引擎把**核心建筑**
         (祠堂/村口/宗祠/集市/官衙/祖师殿…) 恒定放在中心格 (`growTownFootprint` 的
         `cell.d === 0` 那一支) ⇒ **中心格上永远有一座真建筑**。所以:
           · 点恒落在真建筑上 (原始病灶"点悬在村里空地上"根除);
           · 对建筑清单**恒等免疫** —— 远处农田/码头根本读都不读, 不需要平手决序/参照物。
         ⚠ 前四修 (合成点 → 离中心列最近 → 中位格 → 最密格+平手参照物) 都是在"用统计量
           去猜中心", 全部保留给 A/B 对拍: `?ancgeo=densest|box|col|med|sum`。
       ⚠ `real` = 中心格上**确有一栋建筑** (正常恒真; 中心格落在灵脉/深海格时引擎会跳过
         核心建筑, 此时点仍扎在中心点上, 只是签子少抬一点)。
       ⚠ 清单未到货时**不落缓存** —— 否则 `real` 会永久停在 false, 签子少抬一档。 */
    function bldgAnchor(st) {
      if (!st._anc) {
        if (ANC_GEO !== 'center') {
          /* 历史档位 (只给 A/B 对拍): 交给 bldg_ink.js 的求解器 */
          var an = BI.anchorOf(st.buildings, geo.hexW, geo.hexR, st.x, ANC_GEO);
          if (!an) return { x: st.x, y: st.y, real: false, y0: st.y };
          st._anc = an;
          return st._anc;
        }
        /* 城市中心点: 位置直接取实体坐标 (中心格); `real` 只问"这一格上有没有建筑" */
        var bl = st.buildings, on = false;
        for (var bi = 0; bl && bi < bl.length; bi++) {
          if (bl[bi].q === st.q && bl[bi].r === st.r) { on = true; break; }
        }
        var rec = { x: st.x, y: st.y, real: on, y0: st.y };
        if (bl && bl.length) st._anc = rec;      // 清单未到 → 每帧重算 (real 可能还不对)
        return rec;
      }
      return st._anc;
    }

    /* 聚落/景点实体图标 + 名牌 (图层2/3: 动态实体独立于静态地形层, 设计 §二) */
    var zoomClamp = Math.max(z, 0.55);
    function drawEntityList(entities) {
      for (var s2 = 0; s2 < entities.length; s2++) {
        var st = entities[s2];
        if (st.state === 1) continue;              // 被毁实体: 不再绘制 (事件系统接入后可改残迹)
        var ps2 = w2s(st.x, st.y);
        if (ps2.x < -60 || ps2.y < -70 || ps2.x > vw + 60 || ps2.y > vh + 70) continue;
        var fn = ICON_FN[st.type];
        if (!fn) continue;
        var baseSize = { sect: 17, city: 15, town: 12, village: 10, poi: 11 }[st.type] || 10;
        /* 建筑层已把聚落实体化 → 叠在上面的示意图标让位, 只留名牌;
           景点无建筑, 图标照旧。远景 (格半径不足, 建筑层未画) 两种都保留。 */
        var solid = bldgShown && st.type !== 'poi';
        if (!solid) fn(ctx, ps2.x, ps2.y, baseSize * zoomClamp);
        var showName = st.type === 'sect' || st.type === 'city' || st.type === 'poi' || z > 0.62;
        /* 名牌 = 竖排纸签, 一律挂在对应地物**上方** (2026-09-14 改; 旧版为横排落在下方)。
           签底锚在图标顶/建筑群上沿之上, 引绳由 drawNameBanner 自己连回锚点。 */
        if (showBanners && showName && statBanner < BANNER_MAX) {
          var aX = ps2.x, anchorY, gap = 0;
          if (solid) {
            /* C-a: 圆点**落在真实建筑格的格心**上 (不再是合成点, 也不再往上飘 1.15R) ——
               「竖线和点对不上」的直接病因是旧代码把点抬到锚点上方 1.15R+2 (贴建筑群上沿),
               而那个锚点本身又不在任何建筑上 ⇒ 点悬在村子上空的空地里。
               现在: 点 = 格心; 签子腾开屋顶的间距改由 drawNameBanner 的 opt.gap 承担
               (签仍在屋顶之上, 但点老老实实压在房子上, 引线是同列的竖线)。 */
            var anc = bldgAnchor(st);
            var ap = w2s(anc.x, anc.y);
            aX = ap.x;
            anchorY = ap.y;
            gap = anc.real ? (1.15 * geo.hexR * z + 2) : (0.6 * geo.hexR * z + 2);
            if (DEBUG) {
              plaqDrawn[String(st.id || (st.q + ',' + st.r))] = {
                aX: aX, anchorY: anchorY, gap: gap, solid: true,
                on: (aX > -40 && aX < vw + 40 && anchorY > -40 && anchorY < vh + 40)
              };
            }
          } else {
            anchorY = ps2.y - (baseSize * zoomClamp * 0.72 + 4);
            if (DEBUG) {
              plaqDrawn[String(st.id || (st.q + ',' + st.r))] = {
                aX: aX, anchorY: anchorY, gap: 0, solid: false,
                on: (aX > -40 && aX < vw + 40 && anchorY > -40 && anchorY < vh + 40)
              };
            }
          }
          drawNameBanner(ctx, aX, anchorY, st.name, {
            fs: 11.5 * Math.max(z, 0.75), vh: vh, poi: st.type === 'poi', gap: gap
          });
        }
      }
    }
    settleCells.forEach(drawEntityList);
    poiCells.forEach(drawEntityList);

    /* 灵脉名牌 —— 与聚落同款**竖排纸签** (2026-09-14 二改: 原为横排描边字)。
       2026-09-16: 灵脉名独立成开关 (showVeinName) —— 签长 7 字且灵脉常就长在村边,
       和聚落名挤在一起时用户需要能单独关一头 (旧口径两者同受「匾额」一个开关管)。
       签面薄敷灵根本色 + 签脚一枚色印, 一眼分得清金木水火土 (见 drawNameBanner 的 wash)。
       ⚠ 画在聚落名牌**之后**: 签位占用表里先到者优先, 灵脉签长 (7 字), 撞上
         村名时让它往上让一档 —— 灵脉常就在聚落旁边, 不避让必叠。 */
    if (showVeinName && z >= 0.85) {
      for (var vl = 0; vl < veinLabels.length; vl++) {
        var vb = veinLabels[vl];
        /* 落点口径 (2026-09-16 订正 —— 与聚落同一次口径):
           ★ center (默认) = **灵山中心点** = 灵脉格心 (v.x, v.y)。地盘色环
             (`hexPath(v.x,v.y)`) 与灵脉花 (`drawVeinFlower(v.x,v.y)`) 都画在这一格 ⇒
             圆点与"看得见的灵脉本体中心"同点, 不再跟精灵的随机抖动/峰尖走。
           · apex (旧 C-c 二修, `?veinpt=apex`) = 跟精灵横向抖动 jxU + 抬到看得见的峰尖。
           ⚠ 两种档位下**签子位置逐像素相同** (签底一律抬到峰尖之上, 由 gap 承担);
             区别只在**圆点/引线终点** —— 中心点档的引线因此从签底一路连到峰体中心。 */
        var apex = (VEIN_PT === 'apex');
        var ps3 = apex ? w2s(vb.x + (vb.jxU || 0) * geo.hexR, vb.y) : w2s(vb.x, vb.y);
        if (ps3.x < -90 || ps3.y < -40 || ps3.x > vw + 90 || ps3.y > vh + 140) continue;
        if (statBanner >= BANNER_MAX) break;
        var lift = geo.hexR * z * (vb.topU || 0);      // 格心 → 峰尖 的上屏高度
        var b0 = statBanner;                           // drawNameBanner 内部自增 statBanner:
        drawNameBanner(ctx, ps3.x, apex ? ps3.y - lift : ps3.y, vb.name, {
          fs: (vb.level === 0 ? 11.5 : 10.5) * Math.max(z, 0.75), vh: vh, tint: vb.rgb,
          avoid: true, gap: apex ? 0 : lift            // 中心点档: 点不动, 靠 gap 把签抬上峰
        });
        /* 真画出来了才算 (撞位让不开时 drawNameBanner 直接 return, 不计入) */
        if (statBanner > b0) statVeinBanner++;
      }
    }

    /* 朱砂「点选」标记不在这里画 (2026-09-14 九版改动):
       它已从「本宗·自动择宗标记」改为「玩家点选标记」, 画在**覆盖层** (drawOverlay)
       里 —— 好处是点一下立刻可见, 不必等静态层置脏重绘; 且不再随相机自动漂移。 */

    if (PLAQ_DBG) drawPlaqueDbg(ctx);
    staticCam.x = cam.x; staticCam.y = cam.y;
    staticCam.zoom = cam.zoom; staticCam.w = els.app.clientWidth; staticCam.h = els.app.clientHeight;
    staticDirty = false;
    lastStaticDraw = performance.now();      // R1: 供 markStaticDirty 判断合并窗口
    if (staticSchedTimer) { clearTimeout(staticSchedTimer); staticSchedTimer = null; }  // 本轮已含最新数据, 取消挂起节流
  }

  /* 五行/异灵根配色 —— 优先用 meta 下发的色板 (与 biomeMeta 同理, 单点真源);
     下面的字面量只作 meta 缺失时的兜底, 必须与
     Server/Zongmen/Engine/js/mapgen.js 的 ELEMENT_RGB / VARIANT_RGB 一致
     (frontend_smoke 的「色板契约」段会断言两者逐值相同)。 */
  var ELEMENT_RGB_FB = [[196, 176, 120], [104, 140, 86], [86, 116, 142], [176, 72, 50], [152, 120, 82]];
  var VARIANT_RGB_FB = { 雷: [142, 96, 190], 风: [118, 150, 148], 冰: [136, 168, 192], 暗: [96, 84, 110] };
  function geoElementColor(el) {
    return (geo && geo.elementRGB && geo.elementRGB[el]) || ELEMENT_RGB_FB[el] || [150, 130, 100];
  }
  function geoVariantColor(name) {
    return (geo && geo.variantRGB && geo.variantRGB[name]) || VARIANT_RGB_FB[name] || [150, 130, 100];
  }

  /* ---------- 云气层 (水墨祥云: 勾线云团 + 卷云钩) ----------
     云毯锚在**世界坐标**上: 平移时云跟着走, 但比地面慢 (视差 0.88) ⇒ 有高度感;
     云团大小**与地形同倍率随 zoom 缩放** (十版; 旧版只做屏幕 px 弱耦合 ⇒ 放大后云显得越来越小)。
     播种密度由格号 hash 决定 —— 同格恒定, 不会有随机闪烁。
     位图 (6 种形态) 见 textures.js buildClouds() —— 云球勾线 + 上白下阴 + 卷云钩 + 云尾。
     ⚠ 变体数**不写死**: 取模走 cloudSprites.length, 加变体只改 textures.js CLOUD_N。
     七版三条 (用户反馈"云太大 / 太不透明 / 地上没阴影"):
       · 基准宽 base 由 176 降到 92 (≈五成), 大小方差收窄 ⇒ 云不再是"大块白斑";
       · 不透明度由 0.72~0.98 降到 0.32~0.54 ⇒ 云下的地形/道路/建筑透得出来;
       · 新增**地面云影**: 同源轮廓的墨色软影, 向右下偏一点, 铺在所有云体之前
         (影位图见 textures.js buildCloudShadows)。 */
  var CLOUD_CELL = 190;        // 播云格边长 (世界像素) —— 基准朵宽 ~94 ⇒ 格距 ≈ 2 倍朵宽
  /* 族群块 = 3×3 播云格 (570 世界像素)。
     ★ 九版**结构性的改法**: 云按「块」播、不再按「格」播。
       八版 (以及九版初稿) 逐格独立播种 ⇒ **每格都长云** ⇒ 云均匀铺满整屏, 看着只有
       "稀/密" 之别, 没有 "一团一团" 的**集群感** (用户: "成批的云要聚集很多, 像乌云
       一样密集; 散装的云也要有集群感")。
       现在: ① 先给块定**聚集度** (偏斜分布: 多数块偏稀、少数块极密);
             ② 块内挑 1~3 个**云团中心**, 把朵**按圆盘分布堆在中心周围**;
             ③ 团内朵数远多于八版 ⇒ 中心叠成实心云体, 团与团之间/块与块之间留出晴空。
       于是同一屏里同时有 "厚云幕 / 小批 / 孤单小朵 / 晴空" 四种层次, 且每种都成团。 */
  var CLOUD_CLUSTER = 3;
  var CLUSTER_W = CLOUD_CELL * CLOUD_CLUSTER;   // 族群块边长 (世界像素)
  var CLOUD_PARALLAX = 0.88;   // 视差: 云比地面慢 12%
  var CLOUD_DRIFT = 7;         // 向东漂移速度 (世界像素/秒)
  /* 基准朵宽 —— **世界像素** (2026-09-15 十版): 上屏宽 = CLOUD_W0 * cam.zoom。
     ⚠ 旧律 `base = 92 * (0.70 + 0.32*min(z,3.2))` 是**屏幕 px**: 与 zoom 弱耦合, 且 z>3.2 直接冻结
     ⇒ 放大时云相对地形越来越小、缩小时越来越挤 (用户: "云的大小没有跟着屏幕大小变化")。
     现在云与地形/树/建筑**同一倍率** (59 世界像素 × 当前 zoom): z=2.2 (默认档) 时 ≈130px = 旧值
     ⇒ **默认视野观感不变**, 只让"放大 / 缩小"真正带动云。
     ⚠ 云的位置本来就锚在世界坐标 (CLOUD_PARALLAX), 现在尺寸也锚上 ⇒ 两者自洽:
     云毯的**屏幕覆盖率从此与 zoom 无关** (拉近不会变稀、拉远不会糊成一片)。 */
  var CLOUD_W0 = 59;           // 基准朵宽 (世界像素) —— 想整体放大/缩小云只改这一个数
  /* 一块要播的云 (可能为空)。三层掷骰, 全用块号 hash ⇒ 同块恒定不闪:
       ① 聚集度 → 晴空 / 孤单 / 小批 / 成批 四档;
       ② 档位定「几团云 (nm) / 每团几朵 (per) / 团内散开半径 (spr) / 朵的大小与不透明度」;
       ③ 逐朵在团心周围按**圆盘均匀分布**撒点 (中心密、外缘疏) ⇒ 团内叠成实心云体。
     期望 (z=1 视野 ~5×4 块): 成批块 ~1 个 ⇒ 2~3 团大云幕; 另有小批/孤单各若干团。 */
  function cloudOf(ka, kb) {
    function h01(a, b, k) {
      var v = Math.sin(a * k + b * (k * 3.1)) * 43758.5453;
      return v - Math.floor(v);
    }
    var h = h01(ka, kb, 17.7719);
    if (h < 0.18) return null;                                        // 晴空 (~18% 块)
    var nm, per, spr, scLo, scHi, aLo, aHi;
    if (h < 0.46) {        // 孤单: 1 团小朵 (散装云也要成团 ⇒ 4 朵抱在一起)
      nm = 1; per = 4;  spr = 0.105; scLo = 0.50; scHi = 0.78; aLo = 0.24; aHi = 0.40;
    } else if (h < 0.72) { // 小批: 2 团中等
      nm = 2; per = 13; spr = 0.150; scLo = 0.68; scHi = 1.08; aLo = 0.28; aHi = 0.48;
    } else {               // 成批: 3 团厚云幕 (乌云般密集)
      nm = 3; per = 24; spr = 0.180; scLo = 0.88; scHi = 1.36; aLo = 0.32; aHi = 0.58;
    }
    var nsp = (cloudSprites && cloudSprites.length) || 1;     // 变体数取实际产出
    var out = [];
    for (var m = 0; m < nm; m++) {
      /* 团心: 块内偏置 ±0.30 块 —— 同块几团错开, 又都留在本块范围内 */
      var ox = (h01(ka * 31 + m, kb * 31 + m, 7.3319) - 0.5) * CLUSTER_W * 0.60;
      var oy = (h01(ka * 31 + m, kb * 31 + m, 19.7717) - 0.5) * CLUSTER_W * 0.60;
      var mx = (ka + 0.5) * CLUSTER_W + ox, my = (kb + 0.5) * CLUSTER_W + oy;
      /* 每团朵数再抖 ±40% (成批 12~28 / 小批 6~14 / 孤单 2~4) */
      var cnt = Math.max(2, per + Math.round((h01(ka * 37 + m, kb * 37 + m, 29.1133) - 0.5) * per * 0.8));
      var rad = spr * CLUSTER_W;
      for (var t = 0; t < cnt; t++) {
        var kk = ka * 53 + kb * 7 + m * 101 + t;
        var u = h01(kk, kk * 3 + 1, 5.7781);
        var v = h01(kk + 17, kk * 5 + 2, 23.3717);
        var w = h01(kk + 41, kk * 9 + 3, 11.1131);
        var ang = u * 6.2831853, rr = rad * Math.sqrt(v);      // 圆盘均匀 ⇒ 团内密、外缘疏
        out.push({
          wx: mx + Math.cos(ang) * rr,
          wy: my + Math.sin(ang) * rr,
          sp: ((w * 1000) | 0) % nsp,
          sc: scLo + w * (scHi - scLo),               // 档位决定大小 (成批更大)
          /* ⚠ 不透明度仍是压着的 (七版用户嫌"太不透明"): 单朵薄, **密集感靠团内多朵叠** ——
             成批团 12~28 朵互叠 ⇒ 中心自然压成云幕; 孤单团 2~4 朵 ⇒ 仍是薄云。 */
          a: aLo + ((u + v) % 1) * (aHi - aLo)
        });
      }
    }
    return out;
  }
  function drawClouds(ctx, vw, vh) {
    if (!showClouds || !cloudSprites || !cloudSprites.length) return;
    var z = cam.zoom;
    var drift = NO_CLOUD_DRIFT ? 0 : timeSec * CLOUD_DRIFT;
    var pad = CLUSTER_W * 0.85;
    var b = viewBounds();
    /* 遍历单位是**族群块** (不是播云格) —— 云按块生成, 块间距 CLUSTER_W */
    var ka0 = Math.floor((b.x0 - pad) / CLUSTER_W), ka1 = Math.floor((b.x1 + pad) / CLUSTER_W);
    var kb0 = Math.floor((b.y0 - pad) / CLUSTER_W), kb1 = Math.floor((b.y1 + pad) / CLUSTER_W);
    var base = CLOUD_W0 * z;    // 上屏基准宽 (CSS px) = 世界尺寸 × zoom ⇒ 与地形同步缩放
    /* 云影偏移/不透明度 (屏幕 px): 影向右下偏 —— 光从左上来; 影比云淡得多 */
    var SH_DX = 0.10, SH_DY = 0.30, SH_A = 0.55;
    /* ① 先收本帧可见的云 —— 两趟绘制必须用同一批, 否则影子与云体会错开 */
    var vis = [], ka, kb, cc;
    for (ka = ka0; ka <= ka1; ka++) {
      for (kb = kb0; kb <= kb1; kb++) {
        cc = cloudOf(ka, kb);
        if (!cc) continue;
        for (var t = 0; t < cc.length; t++) {          // 本块 0~3 团, 每团 per 朵
          var c1 = cc[t];
          var ps = w2s(cam.x + (c1.wx + drift - cam.x) * CLOUD_PARALLAX,
                       cam.y + (c1.wy - cam.y) * CLOUD_PARALLAX);
          var cw = base * c1.sc, chh = cw * (84 / 128);
          if (ps.x + cw * 0.5 < -12 || ps.y + chh < -12 ||
              ps.x - cw * 0.5 > vw + 12 || ps.y - chh > vh + 12) continue;
          vis.push({ c: c1, x: ps.x, y: ps.y, w: cw, h: chh });
        }
      }
    }
    if (!vis.length) return;
    /* 覆盖层画布是设备像素 (与静态层同), 故下面按 dpr 放大绘制 */
    /* ② 云影一趟: 全部先落到地上 (云体之前) —— 若夹在云体之间画, 后一朵云的影子
          会盖在前一朵云身上。云影位图与云体同源轮廓 (textures.js buildCloudShadows) */
    var i;
    if (cloudShadows && cloudShadows.length && !NO_CLOUD_SHADOW) {
      ctx.globalAlpha = SH_A;
      for (i = 0; i < vis.length; i++) {
        var v = vis[i];
        var sh = cloudShadows[v.c.sp % cloudShadows.length];
        if (!sh) continue;
        ctx.drawImage(sh, (v.x - v.w * 0.5 + v.w * SH_DX) * dpr,
                      (v.y - v.h * 0.62 + v.h * SH_DY) * dpr,
                      v.w * 1.04 * dpr, v.h * 1.04 * dpr);
      }
      ctx.globalAlpha = 1;
    }
    /* ③ 云体一趟 */
    for (i = 0; i < vis.length; i++) {
      var v2 = vis[i];
      ctx.globalAlpha = v2.c.a;
      ctx.drawImage(cloudSprites[v2.c.sp], (v2.x - v2.w * 0.5) * dpr,
                    (v2.y - v2.h * 0.62) * dpr, v2.w * dpr, v2.h * dpr);
      ctx.globalAlpha = 1;
    }
  }

  function drawOverlay() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    if (staticNeedsRedraw(vw, vh)) renderStaticInto();
    var ctx = els.overlayCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    if (staticLayer && Math.abs(cam.zoom - staticCam.zoom) < 0.02) {
      var sdx = dpr * cam.zoom * (staticCam.x - cam.x);
      var sdy = dpr * cam.zoom * (staticCam.y - cam.y);
      ctx.drawImage(staticLayer, sdx, sdy);
    } else if (staticLayer) {
      ctx.drawImage(staticLayer, 0, 0);
    }
    /* 云气: 压在静态层之上 (云是"天", 在路/建筑/名牌之上), 交互高亮之下 */
    drawClouds(ctx, vw, vh);
    /* 悬停: 淡墨细六边框 —— 只回答"鼠标底下是哪一格", 不是选中态 */
    function hexHi(t, alpha) {
      if (!t) return;
      var w = MC.tileToWorld(t.q, t.r);
      ctx.save();
      ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom,
        dpr * (els.app.clientWidth / 2 - cam.x * cam.zoom),
        dpr * (els.app.clientHeight / 2 - cam.y * cam.zoom));
      ctx.strokeStyle = 'rgba(48,36,24,' + alpha + ')';
      ctx.lineWidth = 3.4;
      hexPath(ctx, w.x, w.y, geo.hexR * 0.94);
      ctx.stroke();
      ctx.restore();
    }
    hexHi(hoverTile, 0.7);
    /* 点选标记 (朱砂双圈 + 四角斜标) —— 2026-09-14 九版:
       · 位置 = 玩家**点的那一格**(selMark), 不再跟相机自动漂 (自动择宗已删);
       · 取代原来那圈「黑色加粗」六边框 (用户: 又黑又粗, 丑);
       · 画在覆盖层 ⇒ 点一下立刻可见, 不必等静态层置脏。 */
    if (selMark) {
      var sp = w2s(selMark.x, selMark.y);
      if (sp.x > -80 && sp.y > -80 && sp.x < vw + 80 && sp.y < vh + 80) {
        /* 2026-09-15 十二版: 标记整体缩为原先的 1/3 (用户: 点选红圈太大);
           再 ×1.2 (用户: 圈圈太小了) ⇒ SEL_K = 1/3·1.2 = 0.4。
           所有几何量 (半径 / 圈距 / 斜标偏移与长度) 统一乘 SEL_K。

           线宽 (2026-09-15 用户: 线太细了, 大概 0.1 格宽; 缩太小要跟着变粗):
           基准 = **0.1 × 该缩放下一格的屏显宽度** (格宽 = geo.hexW × zoom, 即六边形对边距),
           不写死像素 ⇒ 放大时圈与线同比例变粗, 比例恒定;
           缩得太小时线会在屏幕上细到看不见 ⇒ 保底 SEL_LW_MIN, 让线**相对圈**变粗。 */
        var SEL_K = 1 / 3 * 1.2;
        var SEL_LW_MIN = 1.5;                              // 保底线宽 (CSS px)
        var selCellW = (geo.hexW || geo.hexR * 1.7320508) * cam.zoom;
        var selLw = Math.max(selCellW * 0.1, SEL_LW_MIN);  // ≈ 0.1 格宽
        var sr = Math.max(geo.hexR * cam.zoom * 1.9 * SEL_K, 11 * SEL_K);
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);          // 以下为 CSS px 作图
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(166,58,44,0.88)'; ctx.lineWidth = selLw;
        ctx.beginPath(); ctx.arc(sp.x, sp.y, sr, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(166,58,44,0.30)'; ctx.lineWidth = Math.max(selLw * 0.6, 1);
        ctx.beginPath(); ctx.arc(sp.x, sp.y, sr + 3.4 * SEL_K, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(166,58,44,0.85)'; ctx.lineWidth = selLw * 1.2;
        for (var s4 = 0; s4 < 4; s4++) {
          var sa = Math.PI / 4 + s4 * Math.PI / 2;
          var so = sr + 6.5 * SEL_K;
          var sx2 = sp.x + Math.cos(sa) * so, sy2 = sp.y + Math.sin(sa) * so;
          ctx.beginPath();
          ctx.moveTo(sx2 - Math.cos(sa) * 4 * SEL_K, sy2 - Math.sin(sa) * 4 * SEL_K);
          ctx.lineTo(sx2 + Math.cos(sa) * 4 * SEL_K, sy2 + Math.sin(sa) * 4 * SEL_K);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  /* ---------- 相机 ---------- */
  function clampCam() {
    cam.tzoom = MC.clamp(cam.tzoom, minZoom, maxZoom);
  }

  /* ---------- 信息面板 (后端单格详情) ---------- */
  /* D6: 原实现用单一 panelBusy 布尔早退 —— 连点时新请求被静默丢弃 (面板停在旧格);
     且 MC.tile 无超时, 请求挂住则「参详中…」可能永久滞留。
     现改为「请求序号 + 最新者胜」: 每次请求带自增 rid, 回调里 rid != 最新则丢弃;
     超时由 mapclient 侧的 AbortController 兜底 (8s)。 */
  var infoSeq = 0;
  /* R5: tile 详情请求 150ms 防抖 —— 连点多个格子时只发最后一次的请求 */
  var infoTimer = null, infoPending = null;
  function showInfo(tile) {
    if (!tile) return;
    infoPending = tile;                        // 保留最近一次点击目标
    if (infoTimer) clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      infoTimer = null;
      var t = infoPending; infoPending = null;
      requestTileInfo(t);
    }, 150);
  }
  function requestTileInfo(tile) {
    if (!tile) return;
    var rid = ++infoSeq;
    els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">参详中…</span></div>';
    els.info.classList.remove('hidden');
    var gen = worldSeed, q = tile.q, r = tile.r;
    MC.tile(gen, q, r).then(function (m) {
      if (rid !== infoSeq) return;                 // 已被更晚的点击取代 → 静默丢弃
      if (gen !== worldSeed) return;
      var rows = [];
      /* D13: 服务端字符串一律过 esc() (与宗门录面板一致) —— 原实现直接拼进
         innerHTML, 名称里含 < & 等字符就会破坏结构/注入。 */
      if (m.placeType) {
        rows.push('<div class="row"><span class="k">所在</span><span class="v">' +
          esc(TYPE_NAME[m.placeType] || m.placeType) + '</span></div>');
        rows.push('<div class="row"><span class="k">名号</span><span class="v big">' + esc(m.placeName) + '</span></div>');
        if (m.placeType !== 'poi') rows.push('<div class="row"><span class="k">生民</span><span class="v">约 ' + m.placePop.toLocaleString() + ' 口</span></div>');
        else rows.push('<div class="row"><span class="k">气数</span><span class="v">机缘未至, 探之莫测</span></div>');
        rows.push('<div class="sep"></div>');
      }
      rows.push('<div class="row"><span class="k">地界</span><span class="v">' + esc(m.regionName) + '</span></div>');
      rows.push('<div class="row"><span class="k">地貌</span><span class="v">' + esc((geo.biomeMeta[m.disp] || {}).name || '未名') + '</span></div>');
      rows.push('<div class="row"><span class="k">位次</span><span class="v">' +
        (q < 0 ? '西 ' + (-q) : '东 ' + q) + ' · ' + (r < 0 ? '北 ' + (-r) : '南 ' + r) + '</span></div>');
      if (m.hasVein) {
        rows.push('<div class="sep"></div>');
        rows.push('<div class="row"><span class="k">灵脉</span><span class="v big">' + esc(m.veinName) + '</span></div>');
        rows.push('<div class="row"><span class="k">灵根</span><span class="v">' +
          (m.veinVariant ? esc(m.veinVariant) + '灵根 · 派自' + (VEIN_EL[m.veinElement] || '?')
                         : (VEIN_EL[m.veinElement] || '?') + '灵根') + '</span></div>');
        rows.push('<div class="row"><span class="k">位份</span><span class="v">' +
          (m.veinLevel === 0 ? '大灵脉·七星' : m.veinLevel === 1 ? '中灵脉·七星' : '独立小灵脉') + '</span></div>');
      }
      rows.push('<div class="row"><span class="k">海拔</span><span class="v">' + (m.e * 300 | 0) + ' 丈</span></div>');
      rows.push('<div class="row"><span class="k">润泽</span><span class="v">' + (m.m * 100 | 0) + '%</span></div>');
      var wd = m.waterD;
      rows.push('<div class="row"><span class="k">去水</span><span class="v">' +
        (m.biome <= 1 ? '滨水' : wd >= 1 && wd <= 4 ? wd + ' 里' : '较远') + '</span></div>');
      if (m.onRoad) rows.push('<div class="row"><span class="k">道路</span><span class="v">有墨路经此</span></div>');
      els.infoBody.innerHTML = rows.join('');
    }).catch(function (err) {
      if (rid !== infoSeq) return;                 // 过期请求的失败不再覆盖面板
      console.error('格详情失败', err);
      els.infoBody.innerHTML = '<div class="row"><span class="k">山川志</span><span class="v">未察明</span></div>';
    });
  }
  function hideInfo() {
    if (infoTimer) { clearTimeout(infoTimer); infoTimer = null; infoPending = null; }  // R5: 关闭面板取消挂起的防抖请求
    els.info.classList.add('hidden');
  }

  /* ---------- 世界重建 ---------- */
  function seedEra(seedStr) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    var gan = '甲乙丙丁戊己庚辛壬癸'.charAt(h % 10);
    var zhi = '子丑寅卯辰巳午未申酉戌亥'.charAt((h >>> 3) % 12);
    var season = '春夏秋冬'.charAt((h >>> 7) % 4);
    els.era.textContent = '岁次' + gan + zhi + ' · ' + season;
  }

  function regenerate(seedString) {
    worldSeed = String(seedString);
    chunkData.forEach(function (_info, key) { renderer.dropChunk(key); });
    chunkData.clear();
    regionCells.clear();
    commCells.clear();
    settleCells.clear();
    poiCells.clear();
    MC.blockForgetAll();                             // rev 缓存随世界重铸失效
    keepChunk = new Set();                            // R4: 世界重铸后旧窗口失效, 待 updateStreaming 重建
    keepR = new Set(); keepC = new Set();
    propBlock.clear(); propBuilt.clear();             // 覆盖格/过滤记录随重铸失效
    syncedVer = -1; blockedVer++;
    if (BI && BI.spriteClear) BI.spriteClear();       // 建筑精灵缓存随世界重铸失效
    lastRBucket = -1;
    chunkQueue.length = 0;
    chunkRetry.clear();
    chunkBusy.clear();                // 旧世界在途回调带 gen 守卫, 不会误删新世界标记
    chunkDefer.length = 0;            // S3: 分帧队列里的块属于旧世界, 一并作废
    deferKeys.clear();
    CALC.localFail = 0;
    /* S3: 引擎是全站单实例 ⇒ seed 只在这里推进一次 (小地图/主视图都只**读**)。
       引擎未到货时 setSeed 只是记账, load 完成后会自动补 init (见 engine-local.js)。 */
    var E0 = EL();
    if (E0) E0.setSeed(worldSeed);
    calcRefresh();
    roadsDirty = true;                // T7: 世界重铸 → 路网几何强制重建
    lastStream.x = NaN;               // P1: 重置流式增量状态 → 首帧强制全量重建
    hoverTile = null;
    selectedTile = null;
    cam.tx = cam.x = 0;
    cam.ty = cam.y = 0;
    cam.tzoom = cam.zoom = 2.2;
    /* ⚠ 这里不再回填任何"种子输入框" —— 手输种子的 UI 已删 (2026-09-16 用户:
       「seed 由服务器统一产生, 不能通过前端产生」)。世界事实由 setWorldInfo 落 UI。 */
    seedEra(worldSeed);
    /* 世界重铸: 旧世界的宗门 id 全部失效 → 清掉选中宗门与点选标记 (九版无"随行"可回退,
       重铸后回到"未择"状态, 由玩家重新点选) */
    sect.pinId = ''; sect.pinEnt = null; sect.curId = ''; sect.curFp = ''; sect.cur = null;
    selMark = null;
    openSectMenu(false);
    updateSectPanel(true);
    hideInfo();
    forceStaticDirty();               // R1: 重铸需立即全量重绘 (清节流定时器) + 小地图 rev bump
  }

  function updateStats() {
    var st = 0, rd = 0, veins = 0;
    settleCells.forEach(function (list) { st += list.length; });
    poiCells.forEach(function (list) { st += list.length; });
    regionCells.forEach(function (pack) { rd += (pack.roads ? pack.roads.length : 0); });
    commCells.forEach(function (cm) { if (cm.exists) veins += cm.veins.length; });
    els.stats.textContent = '已探明 宗门村镇 ' + st + ' · 墨路 ' + rd + ' · 灵脉 ' + veins;
  }

  /* ---------- 宗门录: 数据整理 + 面板渲染 ---------- */
  var MASTER_CH = '玄清太云素无孤寒沧离明虚重白赤青洞霄寂衍真澄空'.split('');
  var MASTER_TAIL = ['真人', '上人', '道人', '散人', '老祖', '尊主'];
  var TIER_NAME = ['', '下品宗门', '中品宗门', '上品宗门'];

  function hash32(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* 距离一律用「格子」: 轴向 (q,r) 的六角立方距离 */
  function hexDist(q0, r0, q1, r1) {
    var dq = q1 - q0, dr = r1 - r0;
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
  }
  function tileDistFrom(wx, wy, q, r) {
    var t = MC.pxToTile(wx, wy);
    return Math.round(hexDist(q, r, t.q, t.r));
  }
  function masterOf(ent) {
    if (ent.owner) return ent.owner;
    var h = hash32(worldSeed + '#' + ent.id);
    return MASTER_CH[h % MASTER_CH.length] +
           MASTER_CH[(h >>> 6) % MASTER_CH.length] +
           MASTER_TAIL[(h >>> 11) % MASTER_TAIL.length];
  }
  function regionNameAt(q, r) {
    if (!geo) return '';
    var pack = regionCells.get(cellKey(Math.floor(q / geo.regionM), Math.floor(r / geo.regionM)));
    return pack && pack.region ? pack.region.name : '';
  }
  /* 最近灵脉: 遍历已加载的群落包 (随视野窗口有界, 无额外请求)。
     VEIN_NEAR 格以外视为「未附」—— 免得写出一条几百格外的灵脉充数。 */
  var VEIN_NEAR = 60;
  function nearestVein(q, r) {
    var best = null;
    commCells.forEach(function (cm) {
      if (!cm.exists || !cm.veins) return;
      for (var i = 0; i < cm.veins.length; i++) {
        var v = cm.veins[i];
        var d = tileDistFrom(v.x, v.y, q, r);
        if (!best || d < best.d) best = { v: v, d: d };
      }
    });
    return best && best.d <= VEIN_NEAR ? best : null;
  }
  /* 视野内宗门, 按距相机中心的格距升序 */
  function collectSects() {
    var out = [], seen = {}, ct = MC.pxToTile(cam.x, cam.y);
    settleCells.forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (ent.type !== 'sect' || ent.state === 1) continue;   // 非宗门 / 已毁
        if (seen[ent.id]) continue;                            // 邻块重复携带 → 去重
        seen[ent.id] = true;
        out.push({ ent: ent, d: Math.round(hexDist(ct.q, ct.r, ent.q, ent.r)) });
      }
    });
    out.sort(function (a, b) { return a.d - b.d; });
    return out;
  }
  /* D14: 单遍 O(n) 扫描 (不排序、不建数组) —— 层指纹未变时用它回答
     「选中的宗门还在不在、距离变没变」。
     九版: 选中宗门**只由 pinId 决定** (点地图 / 择宗菜单), 「随行·就近择宗」已删 ⇒
     这里不再有"最近宗门换了人"这回事, 只需找回 pinId 对应的实体。 */
  function scanSects() {
    var ct = MC.pxToTile(cam.x, cam.y);
    var pin = null;
    if (sect.pinId) {
      settleCells.forEach(function (list) {
        if (pin) return;
        for (var i = 0; i < list.length; i++) {
          var ent = list[i];
          if (ent.type === 'sect' && ent.state !== 1 && ent.id === sect.pinId) {
            pin = { id: ent.id, d: Math.round(hexDist(ct.q, ct.r, ent.q, ent.r)), ent: ent };
            return;
          }
        }
      });
    }
    return { pin: pin };
  }
  /* 该格是否属于某座宗门的营建 (宗址格或它的山门建筑格) */
  function tileInBuildings(ent, q, r) {
    var bl = ent.buildings || [];
    for (var i = 0; i < bl.length; i++) if (bl[i].q === q && bl[i].r === r) return true;
    return false;
  }
  function sectAtTile(q, r) {
    var hit = null;
    settleCells.forEach(function (list) {
      if (hit) return;
      for (var i = 0; i < list.length; i++) {
        var ent = list[i];
        if (ent.type !== 'sect' || ent.state === 1) continue;
        if ((ent.q === q && ent.r === r) || tileInBuildings(ent, q, r)) { hit = ent; return; }
      }
    });
    return hit;
  }
  /* 点选一格 (2026-09-14 九版): 落朱砂标记; 若这一格属于某座宗门, 顺带把它设成
     「宗门录」的选中宗门 —— 这是九版**唯一**的选宗途径之一 (另一条是择宗菜单)。 */
  function selectTile(t) {
    if (!t) return;
    var w = MC.tileToWorld(t.q, t.r);
    selMark = { q: t.q, r: t.r, x: w.x, y: w.y };
    var ent = sectAtTile(t.q, t.r);
    if (ent) {
      sect.pinId = ent.id; sect.pinEnt = ent;
      updateSectPanel(true);
    }
  }
  function pickSectById(id) {
    for (var i = 0; i < sect.items.length; i++)
      if (sect.items[i].ent.id === id) return sect.items[i];
    return null;
  }
  function updateSectPanel(force) {
    if (!metaReady || !geo) return;
    var fp = layerFingerprint();
    var sc = scanSects();
    /* 选中宗门已出视野/被卸载/被毁 → 退回最后一次实体 (sect.pinEnt): 面板不闪空,
       距离继续按它算; 玩家再点到它时引用自会刷新。 */
    var ent = sc.pin ? sc.pin.ent : sect.pinEnt;
    if (sc.pin) sect.pinEnt = sc.pin.ent;
    var id = ent ? ent.id : '';
    var d = 0;
    if (ent) {
      if (sc.pin) d = sc.pin.d;
      else { var ct = MC.pxToTile(cam.x, cam.y); d = Math.round(hexDist(ct.q, ct.r, ent.q, ent.r)); }
    }
    if (id !== sect.curId || fp !== sect.curFp || force) {
      sect.curFp = fp;
      sect.curId = id; sect.cur = ent;
      els.sectBody.innerHTML = ent
        ? sectBodyHTML({ ent: ent, d: d })
        : '<div class="sec-empty">未择宗门 · 点击图上宗门</div>';
      if (els.sectMenu.classList.contains('open')) openSectMenu(true);
    } else if (ent) {
      var dEl = els.sectBody.querySelector('.sec-dist');
      if (dEl) dEl.textContent = d;      // 「距此」随相机移动, 由 1.5s 节拍刷新
    }
  }
  function tagList(list) {
    var h = '<div class="chips">';
    for (var i = 0; i < list.length && i < 8; i++)
      h += '<span class="tag">' + esc(list[i].name) + '<b>' + list[i].n + '</b></span>';
    return h + '</div>';
  }
  function kindsOf(buildings) {
    var c = {}, order = [];
    for (var i = 0; i < buildings.length; i++) {
      var k = buildings[i].kind || '屋舍';
      if (c[k] == null) { c[k] = 0; order.push(k); }
      c[k]++;
    }
    return order.map(function (k) { return { name: k, n: c[k] }; })
                .sort(function (a, b) { return b.n - a.n; });
  }
  function sectBodyHTML(pick) {
    var ent = pick.ent, row = [];
    function kv(k, v) {
      return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';
    }
    row.push('<div class="sec-top"><div class="sec-name">' + esc(ent.name) + '</div>' +
             '<div class="sec-seal">' + esc(String(ent.name).slice(0, 2)) + '</div></div>');
    row.push('<div class="sec-sub">' + (TIER_NAME[ent.tier] || '宗门') +
             (ent.styleName ? ' · ' + esc(ent.styleName) : '') + '</div>');
    row.push('<div class="ink-rule"></div>');
    row.push(kv('掌门', esc(masterOf(ent))));
    row.push(kv('门人', (ent.pop || 0).toLocaleString() + ' 口'));
    row.push(kv('地界', esc(regionNameAt(ent.q, ent.r) || '未探明')));
    row.push(kv('位次', (ent.q < 0 ? '西 ' + (-ent.q) : '东 ' + ent.q) + ' · ' +
                         (ent.r < 0 ? '北 ' + (-ent.r) : '南 ' + ent.r)));
    row.push(kv('距此', '<span class="sec-dist">' + pick.d + '</span> 格'));
    var nv = nearestVein(ent.q, ent.r);
    row.push(kv('灵脉', nv
      ? esc(veinLabel(nv.v)) + ' · ' + nv.d + ' 格'
      : '未附灵脉'));
    var bl = ent.buildings || [], rs = ent.resources || [];
    if (bl.length) {
      row.push('<div class="sec-cap">山门营建</div>');
      row.push(tagList(kindsOf(bl)));
    }
    if (rs.length) {
      row.push('<div class="sec-cap">岁入</div>');
      row.push(tagList(rs.map(function (x) { return { name: x.resource, n: x.amount }; })));
    }
    return row.join('');
  }
  /* 择宗菜单 (九版): 删掉「随行 · 就近择宗」那一项 —— 自动择宗已按用户要求移除,
     这里只剩"点名择宗"。空列表才显示空态。 */
  function sectMenuHTML() {
    var h = '';
    for (var i = 0; i < sect.items.length && i < 30; i++) {
      var it = sect.items[i];
      h += '<div class="mm-item' + (it.ent.id === sect.pinId ? ' cur' : '') +
           '" data-id="' + esc(it.ent.id) + '"><span class="mm-nm">' + esc(it.ent.name) +
           '</span><span class="mm-d">' + it.d + ' 格</span></div>';
    }
    if (!sect.items.length) h += '<div class="mm-empty">此方地界，未闻宗门</div>';
    return h;
  }
  function openSectMenu(open) {
    /* 每次展开都重新收一遍视野内宗门 (按距相机中心升序) —— 原由 pickSect() 顺带刷新,
       九版 pickSect 已删, 改在这里取。 */
    if (open) { sect.items = collectSects(); els.sectMenu.innerHTML = sectMenuHTML(); }
    els.sectMenu.classList.toggle('open', open);
    els.sectMenuBtn.classList.toggle('on', open);
  }
  /* 每 1.5s (与统计/小地图同节拍) 刷新一次。
     ★ 重建判据除「当前宗门 id 变化」外还必须含「图层规模变化」: 区块响应的
       settle/region/comm 是分先后到达的, 宗门实体往往先到 → 首帧渲染时
       regionCells/commCells 还是空的, 「地界/灵脉」会算成未探明/未附并**永久滞留**
       (id 不再变化 → 不再重建)。加了规模指纹后数据补到即自动纠正。 */
  function layerFingerprint() {
    return settleCells.size + '|' + regionCells.size + '|' + commCells.size;
  }

  /* ---------- 输入 ---------- */
  var drag = null;
  function bindInput() {
    var app = els.app;
    app.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      drag = { sx: e.clientX, sy: e.clientY, cx: cam.tx, cy: cam.ty, moved: false };
    });
    window.addEventListener('mousemove', function (e) {
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (drag) {
        var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          cam.tx = drag.cx - dx / cam.zoom;
          cam.ty = drag.cy - dy / cam.zoom;
          cam.x = cam.tx; cam.y = cam.ty;
        }
      } else if (mx >= 0 && my >= 0 && mx < rect.width && my < rect.height) {
        var w = s2w(mx, my);
        hoverTile = MC.pxToTile(w.x, w.y);
        app.style.cursor = 'pointer';
      } else {
        /* D9: 鼠标移出画布时清掉悬停格与指针样式 —— 原实现只在「画布内」分支赋值,
           走出画布后 hover 高亮与 cursor:pointer 一直残留。 */
        hoverTile = null;
        app.style.cursor = '';
      }
    });
    app.addEventListener('mouseleave', function () {
      hoverTile = null;
      app.style.cursor = '';
    });
    window.addEventListener('mouseup', function (e) {
      if (!drag) return;
      var wasClick = !drag.moved;
      drag = null;
      if (!wasClick) return;
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
      var wpt = s2w(mx, my);
      selectedTile = MC.pxToTile(wpt.x, wpt.y);
      selectTile(selectedTile);         // 九版: 点哪选哪 (朱砂圈 + 若是宗门则立选)
      showInfo(selectedTile);
    });
    app.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = app.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = s2w(mx, my);
      /* D12: 归一化 deltaMode —— Firefox 滚轮 deltaMode=1 (行), 直接乘 deltaY 会让
         缩放几乎不动 (deltaY 只有 ±3)。行 16px / 页 100px 折成像素当量。 */
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
      cam.tzoom = MC.clamp(cam.tzoom * Math.exp(-e.deltaY * unit * 0.0012), minZoom, maxZoom);
      cam.zoom = cam.tzoom;
      var after = s2w(mx, my);
      cam.tx += before.x - after.x;
      cam.ty += before.y - after.y;
      cam.x = cam.tx; cam.y = cam.ty;
    }, { passive: false });
    app.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        drag = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, cx: cam.tx, cy: cam.ty, moved: false };
      } else if (e.touches.length === 2) {
        drag = null;
        this._pinch = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
      }
    }, { passive: true });
    app.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (e.touches.length === 1 && drag) {
        var dx = e.touches[0].clientX - drag.sx, dy = e.touches[0].clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          cam.tx = drag.cx - dx / cam.zoom;
          cam.ty = drag.cy - dy / cam.zoom;
          cam.x = cam.tx; cam.y = cam.ty;
        }
      } else if (e.touches.length === 2) {
        /* D11: 双指捏合加锚点补偿 —— 以两指中点为不动点缩放 (与滚轮同口径),
           原实现只改 zoom 不补平移, 捏合时地图中心会「跑」。 */
        var rect = app.getBoundingClientRect();
        var px = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        var py = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        var before = s2w(px, py);
        var d = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY);
        cam.tzoom = MC.clamp(cam.tzoom * d / (this._pinch || d), minZoom, maxZoom);
        this._pinch = d;
        cam.zoom = cam.tzoom;
        var after = s2w(px, py);
        cam.tx += before.x - after.x;
        cam.ty += before.y - after.y;
        cam.x = cam.tx; cam.y = cam.ty;
      }
    }, { passive: false });
    app.addEventListener('touchend', function (e) {
      /* D11: 抬起一指后剩下那指要能继续拖动 —— 原实现无条件 drag=null,
         必须松手重按才能再拖 (多点触控下的常见挫败点)。 */
      if (e.touches && e.touches.length === 1) {
        this._pinch = 0;
        drag = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                 cx: cam.tx, cy: cam.ty, moved: false };
        return;
      }
      drag = null;
      this._pinch = 0;
    });

    var keys = {};
    window.addEventListener('keydown', function (e) { keys[e.key] = true; });
    window.addEventListener('keyup', function (e) { keys[e.key] = false; });
    /* D10: 失焦时清空按键状态 —— 原实现只靠 keyup, Alt+Tab 切走再回来时
       「按下的方向键」永远收不到 keyup → 相机持续漂移。 */
    window.addEventListener('blur', function () { keys = {}; });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) keys = {};
    });
    setInterval(function () {
      var sp = 480 / cam.zoom;
      if (keys.ArrowLeft || keys.a || keys.A) cam.tx -= sp;
      if (keys.ArrowRight || keys.d || keys.D) cam.tx += sp;
      if (keys.ArrowUp || keys.w || keys.W) cam.ty -= sp;
      if (keys.ArrowDown || keys.s || keys.S) cam.ty += sp;
    }, 33);

    /* R11: 小地图自己的输入 (跟随/全屏拖动缩放/单击跳转) 全部在
       web/js/minimap-vein.js 内绑定 —— 这里不再代理它的鼠标事件。 */

    /* ---- 设置弹窗 (齿轮) ----
       ⚠ 复选框的 change 只往 store 里写: 渲染变量的更新、置脏、复选框回填全在
         ZMStore.on → applySettings 这一条路上发生 (**单一数据流**)。别在这里
         顺手再改 showX 变量 —— 那样两处写同一状态, 早晚有一处漏置脏。 */
    $('btnGear').addEventListener('click', function (e) {
      e.stopPropagation();
      openSettings(!settingsOpen);
    });
    $('btnSetClose').addEventListener('click', function () { openSettings(false); });
    $('settingsMask').addEventListener('click', function () { openSettings(false); });
    var setIns = $('settingsBox').querySelectorAll('input[data-zm]');
    for (var si = 0; si < setIns.length; si++) {
      setIns[si].addEventListener('change', function () {
        S.settings.set(this.getAttribute('data-zm'), this.checked);
      });
    }
    /* Esc 关弹窗。⚠ 与"方向键平移"共用一个 keydown 监听不可行 (那个注册在 window 上且
       只记 keys[e.key]), 这里单独挂一条, 不干扰相机键。 */
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && settingsOpen) openSettings(false);
    });
    window.addEventListener('mousedown', function (e) {
      if (!settingsOpen) return;
      if ($('settingsBox').contains(e.target) || $('btnGear').contains(e.target)) return;
      openSettings(false);
    });
    /* 另启一世: 种子由服务端产生 (POST /api/world/next), 前端只负责"求"与"用"。
       旧口径 `regenerate(String(Date.now() % 100000000))` 是前端自造种子 —— 已删。 */
    $('btnRegen').addEventListener('click', function () {
      if (this.disabled) return;
      regenBusy(true);
      setMsg('');
      worldFetch('/api/world/next', 'POST').then(function (w) {
        setWorldInfo(w);
        regenerate(w.seed);
        /* 世界重铸后弹窗**保持打开**: 用户要看见"现在是第几世、种子多少"这个反馈 */
        setMsg('已开第 ' + w.round + ' 世 · 种子 ' + w.seed);
        regenBusy(false);
      }, function (err) {
        /* 失败绝**不**回落前端造种子 —— 那正是本轮要根除的行为 (造出来的世界不在台账里,
           刷新即丢, 服务端无从知晓)。只报错, 让用户重试或去查服务端是否在跑。 */
        setMsg('开辟失败: ' + (err && err.message || err) + ' — 服务端未响应?');
        regenBusy(false);
      });
    });
    /* 择宗菜单: 按钮开合 / 选项落定 / 点空白处收起 (九版: 不再有「随行」项) */
    els.sectMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSectMenu(!els.sectMenu.classList.contains('open'));
    });
    els.sectMenu.addEventListener('click', function (e) {
      var it = e.target && e.target.closest ? e.target.closest('.mm-item') : null;
      if (!it) return;
      var id = it.getAttribute('data-id') || '';
      var pick = id ? pickSectById(id) : null;
      sect.pinId = pick ? id : '';
      sect.pinEnt = pick ? pick.ent : null;
      /* 选中即把朱砂圈也移过去 (与"点地图选宗"同一套标记) */
      if (pick) {
        var w = MC.tileToWorld(pick.ent.q, pick.ent.r);
        selMark = { q: pick.ent.q, r: pick.ent.r, x: w.x, y: w.y };
      } else {
        selMark = null;
      }
      openSectMenu(false);
      updateSectPanel(true);              // 立即重排面板
    });
    window.addEventListener('mousedown', function (e) {
      if (!els.sectMenu.classList.contains('open')) return;
      if (els.sectBox.contains(e.target) || els.sectMenu.contains(e.target)) return;
      openSectMenu(false);
    });

    $('infoClose').addEventListener('click', hideInfo);
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    var vw = els.app.clientWidth, vh = els.app.clientHeight;
    renderer.resize(Math.round(vw * dpr), Math.round(vh * dpr));
    els.overlay.width = Math.round(vw * dpr);
    els.overlay.height = Math.round(vh * dpr);
    els.overlay.style.width = vw + 'px';
    els.overlay.style.height = vh + 'px';
  }

  /* ---------- 主循环 ---------- */
  var frame = 0;
  /* D5b: 「隔帧降载」必须用**每次 loop 都自增**的计数, 不能用 frameCount ——
     frameCount 只在真正渲染的帧里 ++, 一旦相机静止且它恰好为奇数, 跳帧分支会
     永远成立 (它自己不会前进) ⇒ 整个渲染循环冻死: 滚轮改的 zoom 数值在涨、
     画面纹丝不动, 只有拖动 (drag 让跳帧条件不成立) 才"活一帧"再冻。
     这正是"滚轮有时没响应、只有拖屏幕才有反应"的根因。 */
  var tickCount = 0;
  var statsTimer = 0;            // R11: 原 minimapTimer 同节拍改名 (小地图已独立) 
  function loop(t) {
    try {
      tickCount++;
      timeSec = t / 1000;
      var dt = Math.min((t - lastT) / 1000, 0.1);
      lastT = t;
      cam.x += (cam.tx - cam.x) * Math.min(1, dt * 10);
      cam.y += (cam.ty - cam.y) * Math.min(1, dt * 10);
      cam.zoom += (cam.tzoom - cam.zoom) * Math.min(1, dt * 10);
      if (Math.abs(cam.tx - cam.x) < 0.1) cam.x = cam.tx;
      if (Math.abs(cam.ty - cam.y) < 0.1) cam.y = cam.ty;
      clampCam();

      /* D5: 静止降帧 —— 相机已收敛 + 无脏图层 + 无在途加载 + 无拖拽时, 每两帧才渲染一帧
         (动画继续, 约 30fps), 把「静止时仍每帧全跑 3-pass WebGL + 全屏后处理 + 覆盖层」
         的功耗砍半。任何交互 (拖拽/滚轮/点击)、数据到达、脏标记都会立刻恢复满帧。
         ⚠ S5: 必须把「分帧队列非空」也列进不降帧的条件 —— 否则挂起的块会在
           chunkBusy.size===0 的静止状态下一帧都不被消费。 */
      var settled = Math.abs(cam.tx - cam.x) < 0.5 && Math.abs(cam.ty - cam.y) < 0.5 &&
                    Math.abs(cam.tzoom - cam.zoom) < 0.004;
      if (settled && !staticDirty && !drag && chunkBusy.size === 0 &&
          chunkDefer.length === 0 && (tickCount & 1)) {
        requestAnimationFrame(loop);
        return;
      }

      CALC.frameUsed = 0;               // S5: 分帧预算每帧归零 (在降帧判断之后, 不留残值)
      if (metaReady) { updateStreaming(); syncPropBlock(); }
      pumpDeferred();                   // S5: 上一帧超预算而挂起的块, 本帧优先补齐
      renderer.render(cam, timeSec);
      drawOverlay();
      frameCount++;
      /* R11: 小地图已完全交给独立模块 (自带 rAF + 节流), 主循环不再为它做任何事 ——
         这里只剩「统计/宗门录」的 1.5s 节拍。 */
      statsTimer += dt;
      if (statsTimer > 1.5) {
        statsTimer = 0;
        updateStats();
        updateSectPanel(false);     // 「距此」随相机移动, 与统计同节拍刷新
      }
    } catch (err) {
      showFatal('渲染循环异常: ' + err.message);
      throw err;
    }
    requestAnimationFrame(loop);
  }

  /* ---------- 启动 ---------- */
  function boot() {
    els = {
      app: $('app'),
      overlay: $('overlay'),
      overlayCtx: $('overlay').getContext('2d'),
      glcanvas: $('glcanvas'),
      minimap: $('minimap'),
      era: $('era'),
      eraRound: $('eraRound'),
      stats: $('stats'),
      info: $('info'),
      infoBody: $('infoBody'),
      sectBox: $('sectBox'),
      sectBody: $('sectBody'),
      sectMenu: $('sectMenu'),
      sectMenuBtn: $('sectMenuBtn')
    };

    try {
      renderer = new InkRenderer(els.glcanvas);
    } catch (err) {
      showFatal(err.message);
      return;
    }
    var atlas = IT.buildAtlas();
    renderer.setTextures(atlas, IT.buildPaper(), IT.buildNoise());
    cloudSprites = IT.buildClouds();          // 云气层位图 (Canvas2D, 不进 WebGL 图集)
    cloudShadows = IT.buildCloudShadows ? IT.buildCloudShadows() : null;   // 云影 (同源轮廓)
    renderer.setAvgColors(IT.computeAvgColors(atlas));
    renderer.dpr = dpr;
    renderer.noFade = new URLSearchParams(location.search).get('nofade') === '1';
    onResize();

    MC.fetchMeta().then(async function (m) {
      metaReady = true;
      geo = MC.geo();
      renderer.hexR = geo.hexR;
      renderer.seaLevel = geo.seaLevel;
      console.log('[zongmen] meta 就绪 hexW=' + geo.hexW.toFixed(3) + ' chunkS=' + geo.chunkS);

      /* ---- 世界种子: 服务端是唯一来源 (W · 2026-09-16) ----
         ★ 旧口径是 `regenerate(urlSeed || String(Date.now() % 100000000))` —— 前端凭空
           造一个种子当世界。现在改成"向服务端领当前世": 同一台服务器上所有人看到同一个
           世界, 刷新页面不掉世, 服务端重启也不换界 (种子落在 db/zongmen.sqlite 的 World 表)。
         ★ `?seed=` 仍是**调试覆盖**且优先级最高: verify/*.mjs 的定点验收 (seed=42 / 20260909…)
           全靠它, 删了整条验证管线就废了。它按"外部世界"处理 —— 不入账、不显示轮次。 */
      var urlParams = new URLSearchParams(location.search);
      var urlSeed = urlParams.get('seed');
      var w;
      if (urlSeed) {
        w = { seed: urlSeed, round: 0, src: 'url' };
      } else {
        try {
          w = await worldFetch('/api/world/current');
          w.src = 'server';
        } catch (err) {
          /* 拿不到种子就**没有世界** —— 绝不回落到前端自造 (那会把"服务端不可用"这个
             真问题伪装成"正常开局", 且造出的世界不在台账里)。 */
          showFatal('未能从服务器取得世界种子: ' + ((err && err.message) || err) +
            ' — 种子由服务端统一产生并存于 db/zongmen.sqlite, 请确认 Server/Zongmen 已启动');
          return;
        }
      }
      setWorldInfo(w);
      regenerate(w.seed);
      /* S3: 引擎脚本到货后启用「地形块本地算」; 拿不到就静默走服务端下发 (老链路)。
         S4: 同时记下引擎指纹, WS 重连时重取 meta 校验 —— 页面长开期间服务端升级引擎,
             前端旧引擎算地形 + 后端新引擎发聚落/道路 = 坐标口径漂移 (建筑落海)。 */
      function armCalc() {
        var E1 = EL();
        if (!E1) { CALC.settled = true; calcRefresh(); return; }
        E1.noteEngineHash(MC.engineHash());   // 老服务端无此字段 = null ⇒ 不判定(见 verifyHash)
        if (!CALC.armed) { CALC.settled = true; calcRefresh(); return; }
        /* 闸门放行: 只放一次 (幂等), 由 load() 的成败两条路 + 看门狗共同触发。
           放行后强制下一帧全量重建需求集 —— 前面被闸住的块从未进入 chunkBusy,
           但也不在 chunkQueue 里 (updateStreaming 只在需要时追加), NaN 哨兵最省心。 */
        var settle = function () {
          if (CALC.settled) return;
          CALC.settled = true;
          calcRefresh();
          lastStream.x = NaN;
          pumpChunks();
        };
        E1.load().then(settle, settle);
        setTimeout(settle, 3000);             // 看门狗: 引擎脚本/WS 卡死时别拖住首屏
      }
      armCalc();
      MC.onReconnect(function () {
        MC.fetchMeta(true).then(function (mm) {
          var E2 = EL();
          if (!E2) return;
          E2.verifyHash(mm && mm.engineHash);      // 漂移 ⇒ 内部置 hashStale 并 warn 一次
          E2.load().then(function () { calcRefresh(); });   // WS 刚恢复: 脚本可能这次才拿到
        });
      });
      if (urlParams.get('qt') != null) {
        var wp0 = MC.tileToWorld(+urlParams.get('qt'), +(urlParams.get('rt') || 0));
        cam.tx = cam.x = wp0.x;
        cam.ty = cam.y = wp0.y;
      }
      if (urlParams.get('zm') != null) {
        cam.tzoom = cam.zoom = MC.clamp(parseFloat(urlParams.get('zm')), minZoom, maxZoom);
      }
      /* 十二版调试: ?sel=q,r 直接落一枚点选标记 (仅 DEBUG 生效, 与 plaqdbg/ancgeo 同类)。
         headless 截图无从模拟鼠标点击 ⇒ 靠它验收「朱砂标记」的实际大小与落点。
         ⚠ 必须在 regenerate 之后: 世界重铸会把 selMark 清空。 */
      if (DEBUG && urlParams.get('sel') != null) {
        var selQ = +urlParams.get('sel').split(',')[0];
        var selR = +(urlParams.get('sel').split(',')[1] || 0);
        var wSel = MC.tileToWorld(selQ, selR);
        selMark = { q: selQ, r: selR, x: wSel.x, y: wSel.y };
      }
      /* 显示开关: 从 localStorage (ZMStore) 恢复上次会话的偏好, 并订阅其变化。
         ⚠ 这是**唯一**驱动渲染变量的入口 (弹窗里的复选框只是往 store 写值) —— 故
           一次 applySettings 就同时完成: 变量更新 + 复选框回填 + 静态层置脏。 */
      applySettings();
      S.settings.on(applySettings);
      bindInput();
      initMinimap();          // R11: 挂载独立小地图模块 (可热拔插, 见 minimap-vein.js)
      /* 调试: ?set=1 开局即展开设置弹窗 (headless 无法点齿轮 —— 与 plaqdbg/sel 同类)。
         仅 DEBUG 生效, 不进产品路径。 */
      if (DEBUG && urlParams.get('set') === '1') openSettings(true);

      /* R10: 调试句柄仅 DEBUG 模式 (debug=1 / capture=1) 暴露 */
      if (DEBUG) {
        window.__cam = cam;
        window.__renderer = renderer;
        window.__mm = window.MiniMapVein;      // R11: 小地图探针 (截图/断言读事实)
        window.__data = function () { return { chunks: chunkData.size, regions: regionCells.size, comms: commCells.size }; };
        /* R12 诊断: ?mmprobe=1 —— CDP Runtime.evaluate 对本页会永久挂起 (见 memory),
           故沿用小地图自回传通道: 按时间点采 小地图探针 + 数据计数, 末尾一次性
           POST 到 /api/debug/snap (服务端只落字节, 不校验 MIME) ⇒ 读 verify/capture.png
           即得整条时间序列。仅显式传参生效, 不参与业务。 */
        if (/[?&]mmprobe=1/.test(location.search) && window.__mm) {
          var mmSamples = [];
          var mmTake = function (tag) {
            var p = { tag: tag, t: Math.round(performance.now()) };
            try { p.mm = window.__mm.probe(); } catch (e) { p.err = String(e); }
            try { p.data = window.__data(); } catch (e2) { /* noop */ }
            mmSamples.push(p);
          };
          /* ?mmdrive=1: 脚本化交互 (headless 没法手拖) —— 在全屏画布上派发真实
             wheel/mouse 事件, 走模块自己的处理器。用于验收「平移/缩放之后
             是否还露出成片未探测」。仅显式传参生效。 */
          var mmDrive = /[?&]mmdrive=1/.test(location.search);
          /* R13 面板档 / 倍率持久化 的验收通道 (CDP 挂起、live_cap 每次新 profile ⇒
             只能靠页面自己派事件 + 自己重载) */
          var mmPanel = /[?&]mmdrive=panel/.test(location.search);
          var mmReload = /[?&]mmreload=1/.test(location.search);
          var mmPostAt = 14000;
          var pcv = function () { return document.getElementById('minimap'); };
          var mmWheelPanel = function (n) {
            var cv = pcv(); if (!cv) return;
            var rc = cv.getBoundingClientRect();
            var d = n < 0 ? -100 : 100, k = Math.abs(n);   // ⚠ 负 n 不能直接进 for 条件 (空循环)
            for (var i = 0; i < k; i++) cv.dispatchEvent(new WheelEvent('wheel', {
              deltaY: d, clientX: rc.left + rc.width / 2, clientY: rc.top + rc.height / 2,
              bubbles: true, cancelable: true
            }));
          };
          var mmDragPanel = function (dx, dy) {
            var cv = pcv(); if (!cv) return;
            var rc = cv.getBoundingClientRect();
            var x0 = rc.left + rc.width / 2, y0 = rc.top + rc.height / 2;
            cv.dispatchEvent(new MouseEvent('mousedown', {
              button: 0, clientX: x0, clientY: y0, bubbles: true, cancelable: true
            }));
            for (var s = 1; s <= 8; s++) {
              window.dispatchEvent(new MouseEvent('mousemove', {
                clientX: x0 + dx * s / 8, clientY: y0 + dy * s / 8, bubbles: true
              }));
            }
            window.dispatchEvent(new MouseEvent('mouseup', {
              button: 0, clientX: x0 + dx, clientY: y0, bubbles: true
            }));
          };
          var mmRecenter = function () {
            var b = document.querySelector('#minimapBox [data-mm="recenter"]');
            if (b) b.click();
          };
          /* ?mmreload=1: 跨刷新「倍率是否真被记住」的端到端验收 —— 同一 profile 内:
             阶段 A 滚轮改倍率 (触发 saveView) → 打标 → location.reload();
             阶段 B (重载后) 采一支 probe 即 POST —— 此时 localStorage 已被 loadView 读回,
             若 probe().baseWpp / savedRaw 与 A 阶段一致, 即「保存」成立。 */
          if (mmReload) {
            var mmPhase = 0;
            try { mmPhase = Number(sessionStorage.getItem('mmrPhase') || 0); } catch (e) { mmPhase = 0; }
            if (mmPhase === 0) {
              setTimeout(function () { mmTake('reload-A-before'); }, 2500);
              setTimeout(function () { mmWheelPanel(4); }, 3200);
              setTimeout(function () { mmTake('reload-A-after'); }, 4600);
              setTimeout(function () {
                try { sessionStorage.setItem('mmrPhase', '1'); } catch (e2) { /* noop */ }
                location.reload();
              }, 5200);
              mmPostAt = -1;                    // A 阶段不 POST (留待 B 阶段一次性回传)
            } else {
              setTimeout(function () { mmTake('reload-B-restored'); }, 6000);
              /* 重载后通用采样 (1500/3000/5000/8000) 也会进 payload —— 单支 probe 太小,
                 live_cap 的「>1KB」门槛会判成超时, 故留到 10.5s 一起回传。 */
              mmPostAt = 10500;
            }
          }
          /* ?mmdrive=panel: 在左下角小图上派真事件 —— 验「滚轮调倍率 / 拖动转自由视角 / 归心」 */
          if (mmPanel && !mmReload) {
            setTimeout(function () { mmTake('panel-before'); }, 9000);
            setTimeout(function () { mmWheelPanel(4); }, 9400);
            setTimeout(function () { mmTake('panel-zoomIn'); }, 10600);
            setTimeout(function () { mmDragPanel(70, 50); }, 11000);
            setTimeout(function () { mmTake('panel-pan+1.2s'); }, 12200);
            setTimeout(function () { mmTake('panel-pan+4s'); }, 15000);
            setTimeout(function () { mmRecenter(); }, 15400);
            setTimeout(function () { mmTake('panel-recentered'); }, 16400);
            setTimeout(function () { mmWheelPanel(-6); }, 17400);
            setTimeout(function () { mmTake('panel-zoomOut+2s'); }, 19400);
            mmPostAt = 21000;
          }
          if (mmDrive) {
            var fcv = function () { return document.getElementById('mmCanvasFull'); };
            var wheel = function (n) {
              var cv = fcv(); if (!cv) return;
              var rc = cv.getBoundingClientRect();
              for (var i = 0; i < n; i++) {
                cv.dispatchEvent(new WheelEvent('wheel', {
                  deltaY: 100, clientX: rc.left + rc.width / 2, clientY: rc.top + rc.height / 2,
                  bubbles: true, cancelable: true
                }));
              }
            };
            var dragTo = function (dx, dy) {
              var cv = fcv(); if (!cv) return;
              var rc = cv.getBoundingClientRect();
              var x0 = rc.left + rc.width / 2, y0 = rc.top + rc.height / 2;
              cv.dispatchEvent(new MouseEvent('mousedown', {
                button: 0, clientX: x0, clientY: y0, bubbles: true, cancelable: true
              }));
              for (var s = 1; s <= 8; s++) {
                window.dispatchEvent(new MouseEvent('mousemove', {
                  clientX: x0 + dx * s / 8, clientY: y0 + dy * s / 8, bubbles: true
                }));
              }
              window.dispatchEvent(new MouseEvent('mouseup', {
                button: 0, clientX: x0 + dx, clientY: y0 + dy, bubbles: true
              }));
            };
            setTimeout(function () { mmTake('pan-before'); }, 14000);
            setTimeout(function () { dragTo(220, 120); }, 14300);
            setTimeout(function () { mmTake('pan+0.3s'); }, 14600);
            setTimeout(function () { mmTake('pan+1s'); }, 15300);
            setTimeout(function () { mmTake('pan+3s'); }, 17300);
            setTimeout(function () { mmTake('zoom-before'); }, 17700);
            setTimeout(function () { wheel(6); }, 17900);
            setTimeout(function () { mmTake('zoom+1s'); }, 18900);
            setTimeout(function () { mmTake('zoom+5s'); }, 22900);
            setTimeout(function () { wheel(-9); }, 23300);
            setTimeout(function () { mmTake('zoomin+3s'); }, 26300);
          }
          [1500, 3000, 5000, 8000, 12000].forEach(function (ms) {
            setTimeout(function () { mmTake(ms); }, ms);
          });
          if (mmDrive) mmPostAt = 27600;          // 全屏驱动序列比默认采样长
          if (mmPostAt > 0) {
            setTimeout(function () {
              fetch('/api/debug/snap', { method: 'POST', body: JSON.stringify(mmSamples) }).catch(function () {});
            }, mmPostAt);
          }
        }
        /* 表现升级验数: 一次性汇总, 供 headless 断言 (看图之外的"事实"证据) */
        window.__feat = function () {
          var cutChunks = 0, removed = 0, keptVein = 0, keptMtn = 0, keptOther = 0, props = 0;
          chunkData.forEach(function (info) {
            if (info.propOrig == null) return;
            props += info.propOrig;
            keptVein += info.keptVein || 0;
            keptMtn += info.keptMtn || 0;
            keptOther += info.keptOther || 0;
            if (info.propCut) { cutChunks++; removed += info.propOrig - (info.propKept || 0); }
          });
          return {
            bannersOn: showBanners, cloudsOn: showClouds,
            nameSettleOn: showBanners, nameVeinOn: showVeinName, nameRegionOn: showLabels,
            showVeins: showVeins, bldgShown: bldgShown,
            /* W (2026-09-16): 世界事实 + 设置载体 —— headless 判据要能分别读
               「这局种子来自服务端还是 URL 覆盖」「第几世」「弹窗开着没」「store 里存了什么」。 */
            worldRound: worldRound, worldSeed: worldSeed, worldSrc: worldSrc,
            settingsOn: settingsOpen, settingsStore: S.settings.all(),
            localStorageOk: S.persistent(),
            cloudVariants: cloudSprites ? cloudSprites.length : 0,
            propBlock: propBlock.size, blockedVer: blockedVer, syncedVer: syncedVer,
            propBuilt: propBuilt.size, cutChunks: cutChunks, propsRemoved: removed,
            propsTotal: props, keptVein: keptVein, keptMtn: keptMtn, keptOther: keptOther,
            banners: statBanner, veinBanners: statVeinBanner,
            bridges: statBridge, waterQuads: statWaterQuads,
            factionsOn: FAC_OK, settleVer: settleVer,
            /* 九版点选态: headless 用 Input.dispatchMouseEvent 点一下, 再读这两项
               即知「朱砂标记落在哪一格 / 宗门录选中的是哪一座」。无点击时为 null/''。 */
            sel: selMark ? [selMark.q, selMark.r] : null,
            sectPin: sect.pinId ? String(sect.pinId) : '',
            zoom: +cam.zoom.toFixed(3), camTile: [Math.round(cam.x), Math.round(cam.y)]
          };
        };
        /* R6b (B) 归属势力探针 —— headless 无法"看"图, 归属层的三条硬事实必须能读数:
             ① 每个聚落算出的是哪个宗门 (fac) ② 轴向距多少 (d, 用来验辖区半径)
             ③ 势力色与记号 (color/seal/crest, 用来验"同宗同色 + 记号一致")
           另外按势力聚合计数 (byFaction), 直接读"这家管了几个村"。 */
        window.__facProbe = function () {
          var nSect = 0, rows = [], by = {};
          settleCells.forEach(function (ents) {
            for (var i = 0; i < ents.length; i++) if (ents[i].type === 'sect') nSect++;
          });
          settleCells.forEach(function (ents) {
            for (var i = 0; i < ents.length; i++) {
              var e = ents[i];
              if (e.type === 'sect' || e.state === 1) continue;
              var f = factionOf(e), sig = factionSig(f);
              rows.push({
                name: e.name, type: e.type, q: e.q | 0, r: e.r | 0,
                d: f ? hexDist(e.q | 0, e.r | 0, f.q | 0, f.r | 0) : -1,
                fac: f ? (f.name || '') : '',
                color: townColor(e),
                seal: sig ? sig.seal : -1, crest: sig ? sig.crest : 0
              });
              if (f) by[f.name] = (by[f.name] || 0) + 1;
            }
          });
          return { sects: nSect, settles: rows.length, rows: rows.slice(0, 300), byFaction: by,
                   domainR: SECT_DOMAIN_R, on: FAC_OK };
        };
        /* 匾额落点探针 (C-c 二修 2026-09-16) —— headless 无法"看"图, 于是把
           「签子/竖线/圆点到底落在哪个地物上」变成可读数。每行 = 一个聚落 (按 id 去重):
             anchor   落点格 (bldgAnchor: 真实建筑格; 兜底才是聚落中心格)
             dCentR   落点离「建筑簇质心」的距离 (R 倍) —— 越大越像扎在边缘孤例上
             near2R   落点 2R 内有几座建筑 (1~2 = 孤岛, 直观的"点扎在村外")
             inPlan   本帧该落点格是否真的画了建筑 (false ⇒ 点压在空地上)
             ranK     落点按"离质心近"排序的名次 (0 = 最中心的那座)
             dotX/dotY 本帧匾额**实际**画出的引线底点 (屏幕 px, 与 vue 里那份同值)
           外加 veins: 每座灵脉的 topU / jxU / hash (与 shader 对账用)。 */
        window.__plaqProbe = function () {
          var rows = [], seen = {};
          settleCells.forEach(function (ents) {
            for (var i = 0; i < ents.length; i++) {
              var st = ents[i];
              if (st.state === 1) continue;
              var idk = String(st.id || (st.q + ',' + st.r));
              if (seen[idk]) continue;
              seen[idk] = 1;
              var bl = st.buildings || [];
              var pts = [], mx = 0, my = 0, j;
              for (j = 0; j < bl.length; j++) {
                var w = MC.tileToWorld(bl[j].q, bl[j].r);
                pts.push(w); mx += w.x; my += w.y;
              }
              if (bl.length) { mx /= bl.length; my /= bl.length; }
              /* 稳健参照系 = **截尾质心** (先取均值, 丢最远 25%, 再取均值) ——
                 远处农田/码头在这一步被剔掉。
                 ⚠ 别拿裸均值当参照: 它会被同一批离群地物拉走, 于是"离参照最近"的
                   恰恰是被拉偏的那条规则 (一修 col 就吃过这个假好评: 东陵村在裸均值
                   口径下看着只有 1.15R, 其实落点在建筑群东缘, 稳健口径下 2.6R)。 */
              var rcx = mx, rcy = my;
              if (bl.length > 3) {
                var ds2 = [];
                for (j = 0; j < bl.length; j++) {
                  var qx = pts[j].x - mx, qy = pts[j].y - my;
                  ds2.push({ i: j, d: qx * qx + qy * qy });
                }
                ds2.sort(function (a, c) { return a.d - c.d; });
                var kp = Math.max(3, Math.round(bl.length * 0.75)), sx2 = 0, sy2 = 0;
                for (j = 0; j < kp; j++) { sx2 += pts[ds2[j].i].x; sy2 += pts[ds2[j].i].y; }
                rcx = sx2 / kp; rcy = sy2 / kp;
              }
              var dRef = function (a) {
                if (!a) return null;
                var ux = a.x - rcx, uy = a.y - rcy;
                return +(Math.sqrt(ux * ux + uy * uy) / geo.hexR).toFixed(3);
              };
              var an = BI.anchorOf(bl, geo.hexW, geo.hexR, st.x, '');
              var anCol = BI.anchorOf(bl, geo.hexW, geo.hexR, st.x, 'col');
              var anMed = BI.anchorOf(bl, geo.hexW, geo.hexR, st.x, 'med');
              var anSum = BI.anchorOf(bl, geo.hexW, geo.hexR, st.x, 'sum');
              var nn = 0, rank = -1;
              if (an && bl.length) {
                var ad = [], k2;
                for (k2 = 0; k2 < bl.length; k2++) {
                  var ex = pts[k2].x - an.x, ey = pts[k2].y - an.y;
                  ad.push(Math.sqrt(ex * ex + ey * ey));
                  if (ad[k2] <= 2 * geo.hexR) nn++;
                }
                var aRr = Math.sqrt((an.x - rcx) * (an.x - rcx) + (an.y - rcy) * (an.y - rcy));
                rank = ad.filter(function (v2) { return v2 < aRr - 1e-9; }).length;
              }
              var planned = false;
              for (j = 0; j < bldgPlan.length; j++) {
                if (bldgPlan[j].b.q === (an ? an.q : st.q) && bldgPlan[j].b.r === (an ? an.r : st.r)) { planned = true; break; }
              }
              var rec = plaqDrawn[idk];
              /* 原始建筑格一并吐出来 —— 离线可拿它评估**任意**锚点规则
                 (中位/medoid/截尾/包围盒…), 不必为每个候选改一次前端。 */
              var blc = [];
              for (j = 0; j < bl.length && j < 80; j++) blc.push([bl[j].q, bl[j].r]);
              /* 中心点口径的直接证据: 中心格 (st.q, st.r) 上到底有没有建筑 ——
                 引擎把核心建筑放在那里, 所以正常应恒为 true (离线可用 bldgs 复算)。 */
              var coreOn = false;
              for (j = 0; j < bl.length; j++) {
                if (bl[j].q === (st.q | 0) && bl[j].r === (st.r | 0)) { coreOn = true; break; }
              }
              rows.push({
                id: idk, name: st.name, type: st.type, q: st.q | 0, r: st.r | 0,
                nb: bl.length, sx: +st.x.toFixed(2), bldgs: blc, coreOn: coreOn,
                ax: an ? +an.q : null, ar: an ? +an.r : null, real: an ? !!an.real : false,
                /* 四条候选规则到**同一个稳健参照系** (截尾质心) 的距离, R 倍数 ——
                   同一行读数就能比规则; 数值越小 = 越坐在村子正中间。 */
                dTrimR: dRef(an), near2R: nn, rank: rank,
                dColR: dRef(anCol), dMedR: dRef(anMed), dSumR: dRef(anSum),
                colQ: anCol ? anCol.q : null, colRr: anCol ? anCol.r : null,
                medQ: anMed ? anMed.q : null, medRr: anMed ? anMed.r : null,
                sumQ: anSum ? anSum.q : null, sumRr: anSum ? anSum.r : null,
                inPlan: planned,
                solid: rec ? rec.solid : null, gap: rec ? +rec.gap.toFixed(1) : null,
                dotX: rec ? +rec.aX.toFixed(1) : null, dotY: rec ? +rec.anchorY.toFixed(1) : null,
                onScreen: rec ? rec.on : null,
                /* 五修口径的实机读数: 中心点 (st.x, st.y) 的投影坐标 —— 默认档下
                   dotX/dotY 应与 ctrX/ctrY **逐像素相等** (点就扎在中心点上)。 */
                ctrX: +w2s(st.x, st.y).x.toFixed(1), ctrY: +w2s(st.x, st.y).y.toFixed(1)
              });
            }
          });
          var vrows = [];
          if (showVeins) {
            commCells.forEach(function (cm) {
              if (!cm.exists) return;
              for (var v2 = 0; v2 < cm.veins.length; v2++) {
                var v = cm.veins[v2];
                vrows.push({
                  name: veinLabel(v), q: v.q | 0, r: v.r | 0, level: v.level,
                  elev: +elevAtTile(v.q, v.r).toFixed(4),
                  hash: propHashAt(v.q, v.r),
                  topU: +veinTopU(v).toFixed(4), jxU: +veinJxU(v).toFixed(4),
                  apexV: VS && VS.apexV ? +VS.apexV().toFixed(5) : null,
                  boxU: VS && VS.tipU ? null : null
                });
              }
            });
          }
          return { hexR: geo.hexR, hexW: geo.hexW, zoom: +cam.zoom.toFixed(3),
                   dpr: dpr, apexV: VS && VS.apexV ? +VS.apexV().toFixed(5) : null,
                   anc: ANC_GEO, veinpt: VEIN_PT,
                   settles: rows, veins: vrows.slice(0, 200) };
        };
        /* ?plaqprobe=1: 走「页面自回传」通道把 __plaqProbe 的 JSON 落到
           verify/capture.png (CDP Runtime.evaluate 对本页永久挂起, 见 memory) ——
           随后直接按**文本**读该文件即可。仅显式传参生效, 不参与业务。 */
        if (/[?&]plaqprobe=1/.test(location.search)) {
          setTimeout(function () {
            var t1 = '';
            try { t1 = JSON.stringify(window.__plaqProbe()); } catch (e) { t1 = JSON.stringify({ err: String(e) }); }
            fetch('/api/debug/snap', { method: 'POST', body: t1 }).catch(function () { /* noop */ });
          }, 11000);
        }
        /* 定点相机助手: 把「路压水」「建筑压水」的世界格坐标吐出来 —— 否则
           headless 无从知道该把镜头停在哪才能同时看到虚线航道与栈桥。 */
        window.__spots = function () {
          var water = [], bridge = [];
          /* ⚠ biomeAt 对未加载格返回 -1; 水是 0/1。必须 bb>=0 才算, 否则
             "未加载" 会被误判成水 (<=1)。 */
          function isW(q, r) { var bb = biomeAt(q, r); return bb >= 0 && bb <= 1; }
          regionCells.forEach(function (pack) {
            var roads = pack.roads || [];
            for (var i = 0; i < roads.length && water.length < 12; i++) {
              var pts = roads[i].pts;
              for (var p = 0; p + 3 < pts.length; p += 2) {
                var ta = worldToTileI(pts[p], pts[p + 1]);
                var tb = worldToTileI(pts[p + 2], pts[p + 3]);
                if (isW(ta.q, ta.r) || isW(tb.q, tb.r)) {
                  water.push([ta.q, ta.r, tb.q, tb.r]); break;
                }
              }
            }
          });
          settleCells.forEach(function (ents) {
            for (var i = 0; i < ents.length; i++) {
              var st = ents[i];
              if (st.state === 1 || !st.buildings) continue;
              for (var j = 0; j < st.buildings.length && bridge.length < 12; j++) {
                var b = st.buildings[j];
                if (isW(b.q, b.r)) bridge.push([b.q, b.r, st.name]);
              }
            }
          });
          var towns = [];
          settleCells.forEach(function (ents) {
            for (var i = 0; i < ents.length; i++) {
              var s = ents[i];
              if (s.state === 1 || !s.buildings || !s.buildings.length) continue;
              if (towns.length < 24) towns.push([s.q, s.r, s.name, s.type, s.buildings.length]);
            }
          });
          return { water: water, bridge: bridge, towns: towns, cam: [cam.x, cam.y, cam.zoom] };
        };
      }

      /* 调试钩子: capture=1 时等待块数据真实到达 (≥3 块或 25s 兜底) 再把
         canvas 合成图回传后端, 用于 headless 截图验证。
         不用固定 4s 定时: WS 单块首次构建含 V8 冷启动+A* 道路, 耗时波动大。
         ★ 还必须等「就绪之后至少渲染过一帧」(frameCount 前进): headless 虚拟
           时钟下 timer 会跑到 WS 数据之前, 若立刻合成, drawImage 读到的是从未
           渲染过的 framebuffer (alpha:false → 不透明白黑), 截出全黑图
           (这正是此前 capture.png 全黑的根因)。
           注: 合成**不放进 rAF 回调** —— 虚拟时钟可能饿死 rAF, 那样会永不截图;
           改为「帧计数门槛 + 超时兜底」, 两种时钟下都必然会产出文件。 */
      if (new URLSearchParams(location.search).get('capture') === '1') {
        var snapStart = Date.now();
        var readyFrame = -1;
        /* ⚠ capmin=N (秒): 在「就绪门槛」之外**再等 N 秒**才合成。
           门槛 (chunkData≥3) 在低 zoom 下远远不够 —— zm≤2.2 的视口要上百个区块,
           只等到 3 块就截 ⇒ 画面大面积缺块 (paper 空白), 且缺多少随服务端冷热
           波动 ⇒ **同机位两次截图能差 20%** (2026-09-14 实测: 墨像素 6.4% vs 13.9%)。
           故凡做实机 A/B, URL 一律带 capmin (推荐 8~10) 并先"预热"一次同 URL。 */
        var capMinMs = (Number(new URLSearchParams(location.search).get('capmin')) || 0) * 1000;
        var trySnap = function () {
          var ready = chunkData.size >= 3 && regionCells.size >= 1;
          if (ready && readyFrame < 0) readyFrame = frameCount;
          var timedOut = Date.now() - snapStart >= 25000;
          var waited = Date.now() - snapStart >= capMinMs;
          if (!timedOut && (!ready || frameCount <= readyFrame || !waited)) { setTimeout(trySnap, 200); return; }
          try {
            var canvas = document.createElement('canvas');
            canvas.width = els.app.clientWidth;
            canvas.height = els.app.clientHeight;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(els.glcanvas, 0, 0, canvas.width, canvas.height);
            ctx.drawImage(els.overlay, 0, 0, canvas.width, canvas.height);
            /* R11: 小地图是 DOM 画布 (独立模块), 不在 gl/overlay 合成里 ——
               截图验证必须显式把它按屏幕位置贴回来, 否则「图上有小地图」这件事
               在 capture.png 上根本看不见 (探针会误判为没画)。 */
            var mmCvs = document.querySelectorAll('#minimap, #mmCanvasFull');
            for (var mi = 0; mi < mmCvs.length; mi++) {
              var mEl = mmCvs[mi], mr = mEl.getBoundingClientRect();
              if (mr.width < 2 || mr.height < 2) continue;
              try { ctx.drawImage(mEl, mr.left, mr.top, mr.width, mr.height); } catch (e3) { /* 空画布 */ }
            }
            canvas.toBlob(function (b) {
              if (!b) return;
              fetch('/api/debug/snap', { method: 'POST', body: b }).catch(console.error);
            }, 'image/png');
          } catch (e) { console.error(e); }
        };
        setTimeout(trySnap, 1000);
      }

      requestAnimationFrame(loop);
    }).catch(function (err) {
      console.error('[zongmen] meta 获取失败', err);
      showFatal('后端世界服务不可用: ' + err.message +
        ' — 请先启动 Server/Zongmen (端口见 appsettings.json)');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
