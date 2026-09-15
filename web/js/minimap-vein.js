/* ============================================================
 * minimap-vein.js — 小地图模块 (灵脉版) · 可热拔插
 * ------------------------------------------------------------
 * 目标 (用户 2026-09-15): 替换旧小地图 —— 旧实现每 1.5s 轮询
 *   HTTP /api/map/fields 采 132×88 字段网格, 撞请求速率上限。
 *
 * 数据分层 (唯一口径):
 *   L1 地形层 —— 前端按 seed 自算: 引擎脚本经 WS 下发 (ScriptPack),
 *               间接 eval 出 window.MapGen, 再按 **世界格对齐** 的抽样层
 *               (q%m==0 && r%m==0, m=2^k, 见 levelFor) 逐格 MapGen.fields(q,r).biome
 *               算进「世界格→群系」表, 再抽样成位图; 未算到的画「未探测」纹理。
 *                 ⚠ 抽样格必须世界对齐 —— 视图锁定的采样点会让平移/缩放把缓存
 *                   全部作废 (实测复用率 36%~11%)。
 *                 ⚠ 只读 biome/e, 绝不读 onRoad —— 道路语义依赖引擎
 *                   roadCache 冷热 (mapgen.js:222), 走 L2。
 *                 ⚠ 块色走**金字塔多数表决** (U4): 显示块的群系不取该块角点的单个样本
 *                   (混合地貌区会出椒盐噪点), 而是 4 个 (m/2) 子格取众数 ⇒ 块色 = 块内
 *                   多数地貌。实测与「块内 mD×mD 原生格真值多数」一致率 70~93% → 81~96%
 *                   (混合地貌区提升最大, +11pp); 代价 = 原始样本 ×3.5。
 *   L2 世界层 —— 全部来自 WS: 灵脉 (comm.veins) / 聚落 (settle) /
 *               道路 (region) / 区域名。世界是动态的, 前端不自行生成。
 *   L3 视野层 —— 默认档跟随主相机; 全屏档独立相机 (可拖动/缩放)。
 *
 * 交互:
 *   默认档 (屏幕左下角小图): 滚轮缩放 / 拖动平移 (拖过阈值 ⇒ 自动转「自由视角」) /
 *     单击 (未拖动) → 打开全屏 / 「归心」→ 恢复跟随主相机。
 *   全屏档: 拖动平移 / 滚轮缩放 / 单击跳转主相机 / ESC 或 ✕ 关闭 / 「归位」复位。
 *   隐藏: 整个模块停摆 (停 rAF / 停抽样 / 停绘制), 角落留一枚恢复钮。
 *
 * ⚠ 面板档倍率 (R13): 面板的 wpp 不是独立数字, 而是由「与大地图恒定的比例」推出 ——
 *   上屏 wpp = baseWpp × (DEFAULT_ZOOM / 主相机 zoom)。于是
 *     小图 1px 的世界长度 : 大图 1px 的世界长度 = 1 : (baseWpp × DEFAULT_ZOOM) = 常数
 *   ⇒ 主地图放大/缩小, 小图同比例跟着放大/缩小, 两者大小比例永远一致 (用户口径:
 *   「保存和地图一直的大小比例」)。baseWpp 持久化到 localStorage, 跨刷新记住。
 *   ⚠ 别把面板 wpp 写死成常量 (旧版 FOLLOW_WPP=6) —— 那样主图缩放时小图纹丝不动。
 *
 * 壳层依赖 (全部注入, 模块不摸 main.js 内部变量):
 *   MiniMapVein.init({
 *     panel, full,                       // DOM 挂载点 (全屏浮层须是 .panel 的兄弟)
 *     snapshot: function () {...},       // 只读快照 (见 main.js mmSnapshot)
 *     jump: function (x, y) {...},       // 主相机跳转
 *   });
 * ============================================================ */
(function (g) {
  'use strict';

  /* 壳层依赖全部经 deps 注入 (snapshot/jump), 引擎经 window.EngineLocal ——
     R11 起本模块不再直接摸 MapClient (原 MC.requestScript 已迁入 EngineLocal)。 */

  /* ---------- 常量 ---------- */
  var FOLLOW_WPP = 6;            // 面板档基准缩放: 世界单位/像素 (主相机处于 DEFAULT_ZOOM 时的观感 = 旧版观感)
  var DEFAULT_ZOOM = 2.2;        // 主相机基准缩放 (与 main.js cam.zoom 初值同口径) —— 面板倍率联动的锚点
  var BASE_WPP_MIN = 1.2, BASE_WPP_MAX = 24;  // 面板基准 wpp 可调范围 (下限别太小: 一张图吞下整个世界就没意义了)
  var LS_KEY = 'zongmen.mmView';  // 倍率持久化键 (跨刷新保存「与大地图的大小比例」)
  var FULL_WPP_INIT = 3.5;       // 全屏档初始缩放
  var WPP_MIN = 0.30, WPP_MAX = 48;
  /* 触摸档 (手机) */
  var TOUCH_SLOP = 8;            // 单指位移阈值 (px, 曼哈顿): 超过算拖动, 否则算点按 —— 比鼠标的 3px 宽 (手指抖动大)
  var TOUCH_GUARD_MS = 600;      // 触摸后这段时间内的「合成鼠标事件」一律丢弃 (见 fromTouch)
  var SAMPLE_BUDGET_MS = 10;     // 兜底: 首次抽样前的额度 (之后按帧间隔自适应, 见 tick)
  var REDRAW_MS = 110;           // 非拖动时的重绘节流
  var SAMPLE_CELLS_MAX = 24000;  // 单视图抽样格上限 (决定抽样层级 m; 越小越省, 见 levelFor)
  var LEVEL_MAX = 5;             // 抽样层级 m = 2^0..2^LEVEL_MAX (1..32 世界格/样本)
  var AGG_DIV = 2;               // U4: 一个显示块聚合 AGG_DIV×AGG_DIV 个原始子格样本 (4 票多数表决)
  var PADDING = 0.20;            // 采样范围外扩比例 (平移前先备好边缘, 拖动才不露底)
  var PENDING_CAP = 400000;      // 待采样列表上限 (世界对齐 ⇒ 跨视图复用, 正常远达不到)
  var TERRAIN_CAP = 400000;      // 地形缓存上限 (超出按插入序淘汰最旧 1/4, 不清空整表)

  /* 未探测纹理 (与任何地形色都不撞: 深褐底 + 斜纹) */
  var UNK_BASE = [40, 36, 32], UNK_HATCH = [58, 52, 44];

  /* 世界层色板 (L2): 聚落按类型 */
  var SETTLE_COLOR = {
    sect: [124, 86, 178], city: [196, 122, 58], town: [172, 132, 72],
    village: [150, 132, 92], fishing: [72, 142, 152]
  };
  var SETTLE_FALLBACK = [160, 150, 120];
  var SEAL = 'rgba(166,58,44,0.95)';

  /* ---------- 状态 ---------- */
  var deps = null;
  var panel = null, full = null;
  var canvas = null, ctx = null, fcanvas = null, fctx = null;
  var tip = null, restoreBtn = null;
  var running = false, rafId = 0;
  var hidden = false, maximized = false, destroyed = false;

  var engine = null, engineReady = false, engineSeed = null;
  /* L1 地形缓存 —— 键是「世界格 q,r」, 与视图无关。
     ⚠ 这是 R12 修「大地图大面积未探测」的关键: 旧实现按「画布像素格」投影成采样点,
       视图一平移/缩放, 采样点几乎全部落到新格上 ⇒ 缓存复用率 36%~11% (实测),
       每次交互都重新露底。改成世界格后, 平移/缩放基本 100% 复用。
     m (抽样层级) 只决定「选哪些世界格去算」与「显示时读哪一格的近似」, 不进键。 */
  var terrainCache = new Map();     // "q,r" -> biome (0..7) | -1(算不出)
  var pending = [];                 // 待采样世界格 [q,r,d²] (按离视图中心由近及远)
  var pendingIdx = 0;               // 已消费游标 (替代 shift(): 免 O(n) 搬移 + 免静默丢弃)
  var pendingSet = new Set();       // 待采样去重
  var pendingEpoch = null;          // 生成 pending 时的视图签名 (判是否需要重建)
  var sampleM = 1;                  // 显示块层级 mD = 2^k 世界格/块 (决定抽样层级与块大小)
  var rawM = 1;                     // 原始样本层级 = mD/AGG_DIV (每块 AGG_DIV² 个样本; mD<AGG_DIV 时 = 1)
  var aggCache = new Map();         // 聚合块缓存 "mD:q,r" -> {b,n} | null (子块缺样本时也缓存, 由 aggInvalidate 失效)
  var snap = null;                  // 最近一次快照
  var lastRev = -1, lastSeed = null;
  var viewFull = { cx: 0, cy: 0, wpp: FULL_WPP_INIT };
  var viewFullInit = false;
  /* 面板档视图 (R13): baseWpp = 「与大地图恒定的比例」的载体;
     上屏 wpp 由 panelWppNow() 按主相机 zoom 反比推出, viewPanel.wpp 只在自由视角下作为落点。
     中心默认跟随主相机 (followCam), 拖动后转自由 (viewPanel.cx/cy 生效), 「归心」恢复。 */
  var viewPanel = { cx: 0, cy: 0, wpp: FOLLOW_WPP };
  var baseWpp = FOLLOW_WPP;
  var followCam = true;
  var dragPanel = null, persistTimer = 0;
  var hintEl = null, fullTitleEl = null;
  var lastDraw = 0, dragState = null, cardDirty = true;
  var pinchPanelD = 0, pinchFullD = 0;   // 上一帧双指间距 (0 = 当前没有捏合)
  var lastTouchTs = -1e9;                // 最近一次触摸的 timeStamp (拦合成鼠标事件用)
  var hover = null;                 // {x,y,info}
  var terrainBmp = null, terrainBc = null;   // 离屏地形位图
  var bmpBiome = null;                       // 上一次位图的逐块群系 (椒盐诊断计数用, 不参与绘制)
  var biomeRGB = [], veinRGB = null;
  /* 诊断计数 (只读; 由 probe() 暴露, 供实机取数定位收敛问题) */
  var mmStat = { bmpW: 0, bmpH: 0, step: 0, blocks: 0, miss: 0, draws: 0, enqDrop: 0, m: 1, rawM: 1,
                 pending: 0, pendingLeft: 0, agg: 0, iso: 0, isoBase: 0 };

  /* ---------- 小工具 ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function hexW() { return (snap && snap.hexW) || 13.856; }
  function hexR() { return (snap && snap.hexR) || 8; }

  /* 与 mapclient/引擎同口径的轴坐标↔世界像素 (尖顶六边形, y 向下) */
  function tileToWorld(q, r) {
    return { x: hexW() * (q + r / 2), y: 1.5 * hexR() * r };
  }
  function pxToTile(x, y) {
    var rf = y / (1.5 * hexR());
    var qf = x / hexW() - rf / 2;
    var xf = qf, yf = -qf - rf, zf = rf;
    var xx = Math.round(xf), yy = Math.round(yf), zz = Math.round(zf);
    var dx = Math.abs(xx - xf), dy = Math.abs(yy - yf), dz = Math.abs(zz - zf);
    if (dx > dy && dx > dz) xx = -yy - zz;
    else if (dy > dz) yy = -xx - zz;
    else zz = -xx - yy;
    return { q: xx, r: zz };
  }

  function parseColor(c, dst) {
    if (!c) return dst;
    var s = String(c);
    if (s.charAt(0) === '#' && s.length >= 7) {
      return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    }
    return dst;
  }
  function css(rgb, a) {
    return a == null ? 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')'
                     : 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
  }
  function rgbOf(arr, i) { return (arr && arr[i]) || null; }

  /* ---------- 引擎: 收敛到全站单实例 EngineLocal (web/js/engine-local.js) ----------
     本模块**不得**再自行 eval 引擎、也**不得**自行 init(seed):
       · MapGen.init() 会 clear() 引擎内全部 14 张缓存 (mapgen.js) ⇒ 主视图每次重铸世界
         都会把小地图已算好的格全部作废 (实测热算 0.62ms/块 → 冷算 2.46ms/块, 4×);
       · window.NoiseLib 同名覆盖的保存/还原也必须留在唯一 eval 点里 (本模块无从插手中途)。
     加载与换 seed 统一由 EngineLocal 负责, 这里只保留只读访问器。 */
  function EL() { return g.EngineLocal || null; }

  function ensureEngine() {
    var E = EL();
    if (!E) {
      console.warn('[小地图] EngineLocal 未加载 (web/js/engine-local.js) — 地形层降级为「未探测」');
      return Promise.resolve(false);
    }
    return E.load().then(function (ok) {
      engine = ok ? E.mapgen() : null;
      engineReady = !!ok;
      if (ok) cardDirty = true;                 // 脚本到货 → 尽快把「未探测」换成真地形
      return ok;
    });
  }

  /* 地形层全量重置 (换 seed / 世界重铸) */
  function resetTerrain() {
    terrainCache.clear();
    aggCache.clear();
    pending.length = 0; pendingIdx = 0;
    pendingSet.clear(); pendingEpoch = null;
    sampleM = 1; rawM = 1;
  }

  /* ---------- L1 地形: 世界对齐抽样 ----------
     旧实现的两个致命点 (R12 实测, 见 .tmp_lattice.js):
       ① 采样点 = 画布像素格投影进世界 ⇒ 抽样格「视图锁定」: 视图平移 5 世界单位
          (不足半格) 已算格只复用 55%, 平移一格 36%, 面板档→全屏档 11.5%
          ⇒ 每次拖动/缩放都把地图打回「未探测」, 这就是截图里大面积暗底斜纹的来源。
       ② 视图内真实格数远超样本数: 默认全屏档 58363 格 vs 21850 样本 = 漏格 63%;
          wpp=12 时漏格 96.8% ⇒ 即使收敛也是残图。
     新实现: 抽样集合 = 世界格 { q % m == 0 && r % m == 0 } —— 与视图无关。
     平移/缩放只是「多要几个新格」, 已算过的格永久有效, 且跨层级共用同一张表
     (m 变大时它的样本本来就是 m 小的时候的子集)。m 取 2 的幂 ⇒ 缩放跨阈值才换层。 */

  /* 抽样层级: m = 2^k, 让「一个抽样格 ≈ 一个显示块」。
     目标 m = 显示块像素 step × (世界单位/像素 wpp) / 格宽 hexW —— 即抽样分辨率
     与显示分辨率对齐: 比显示更细是白算, 更粗则看得见的块状损失。
     只取 2 的幂 ⇒ 缩放跨阈值才换层 (层内平移/缩放 100% 复用缓存)。 */
  function levelFor(v, W, H) {
    var step = Math.max(2, Math.ceil(Math.sqrt((W * H) / SAMPLE_CELLS_MAX)));
    var m = (step * v.wpp) / hexW();
    var k = Math.ceil(Math.log2(m > 0 ? m : 1));
    if (!(k > 0)) k = 0;                       // 覆盖 k<=0 / NaN
    return 1 << Math.min(LEVEL_MAX, k);
  }

  /* 枚举某一层在视野(外扩 PADDING)内的对齐格, 跳过已算过的, 按离视野中心排序 */
  function enumLevel(v, W, H, m) {
    var hw = hexW(), hr = 1.5 * hexR();
    var padX = W * PADDING / 2 * v.wpp, padY = H * PADDING / 2 * v.wpp;
    var y0 = v.cy - (H / 2) * v.wpp - padY, y1 = v.cy + (H / 2) * v.wpp + padY;
    var x0 = v.cx - (W / 2) * v.wpp - padX, x1 = v.cx + (W / 2) * v.wpp + padX;
    var r0 = Math.floor(y0 / hr) - 1, r1 = Math.ceil(y1 / hr) + 1;
    var q0 = Math.floor(x0 / hw - r1 / 2) - 1, q1 = Math.ceil(x1 / hw - r0 / 2) + 1;
    var aq = Math.ceil(q0 / m) * m, ar = Math.ceil(r0 / m) * m;    // 对齐到 m 的倍数
    var out = [];
    for (var r = ar; r <= r1; r += m) {
      for (var q = aq; q <= q1; q += m) {
        var k = q + ',' + r;
        if (terrainCache.has(k) || pendingSet.has(k)) continue;    // 跨视图/跨层级直接复用
        var dx = hw * (q + r / 2) - v.cx, dy = hr * r - v.cy;
        out.push([q, r, dx * dx + dy * dy, m]);      // 第 4 位 = 该样本所属层级 (供聚合失效用)
      }
    }
    out.sort(function (a, b) { return a[2] - b[2]; });   // 近处先算 ⇒ 视野中心先清晰
    for (var i = 0; i < out.length; i++) pendingSet.add(out[i][0] + ',' + out[i][1]);
    return out;
  }

  /* 显示块的原始样本层级: 每块 AGG_DIV² 个子格各要一个样本 (mD<AGG_DIV ⇒ 与块同层, 无表决) */
  function rawLevelOf(mD) { return mD >= AGG_DIV ? Math.max(1, Math.floor(mD / AGG_DIV)) : 1; }

  /* ---------- U4: 金字塔多数表决 (块色 = 块内多数地貌) ----------
     病征: 旧口径的块色 = 该块**角点**的单点样本 ⇒ m>=4 时一个 m×m 区块只有 1 个格点
     参与决策, 混合地貌区的相邻块各取各的角点 ⇒ 椒盐噪点。
     口径: cell(mD) = 4 个 cell(mD/2) 子块的**众数** (票 = 子块代表的样本数 = 面积)。
       子块就是原始样本 (rawM = mD/AGG_DIV), 即每块 4 个原始样本 ⇒ 采样量 ×3.5 (实测)。
     实测 (seed 42, 与「块内 mD×mD 原生格真值多数」的一致率):
       角点单点 70.1%~93.4% → 多数表决 81.1%~95.8% (混合地貌的中心区 +11pp)。
     ⚠ 只做**一层**聚合 (子块即原始样本): 递归到 mD/4 会把采样量抬到 ×16。
     ⚠ 缺样本的子块**不投票** (绝不当作群系 0), 全缺 ⇒ 返回 null 由 biomeAt 回退到角点/粗层。
     ⚠ 平票 (2:2) 取先出现的子块 (序 [左上, 右上, 左下, 右下]) ⇒ 结果确定, 无随机。 */
  var _vb = new Int32Array(8), _vn = new Int32Array(8), _vi = new Int32Array(8);

  function aggOf(aq, ar, k) {
    if (AGG_DIV < 2 || k < AGG_DIV) return null;
    var key = k + ':' + aq + ',' + ar;
    var hit = aggCache.get(key);
    if (hit !== undefined) return hit;
    var ck = Math.floor(k / AGG_DIV), out = null;
    if (ck === rawM) {                     // 子块层级 == 当前原始层 ⇒ 才有样本可表决
      var cnt = 0, i, j, b, s, ord;
      for (j = 0; j < AGG_DIV; j++) {
        for (i = 0; i < AGG_DIV; i++) {
          b = terrainCache.get((aq + i * ck) + ',' + (ar + j * ck));
          if (b == null || b < 0) continue;
          ord = j * AGG_DIV + i;
          for (s = 0; s < cnt && _vb[s] !== b; s++) { /* 线性找票 */ }
          if (s === cnt) {
            if (cnt >= _vb.length) continue;   // 票位上限 (AGG_DIV<=2 时恒不触发)
            _vb[cnt] = b; _vn[cnt] = 1; _vi[cnt] = ord; cnt++;
          } else _vn[s]++;
        }
      }
      var bi = -1;
      for (s = 0; s < cnt; s++) {
        if (bi < 0 || _vn[s] > _vn[bi] || (_vn[s] === _vn[bi] && _vi[s] < _vi[bi])) bi = s;
      }
      if (bi >= 0) out = { b: _vb[bi], n: _vn[bi] };
    }
    aggCache.set(key, out);                // null 也缓存; 新样本一到就由 aggInvalidate 删掉
    return out;
  }

  /* 原始样本落盘 ⇒ 含它的显示块聚合失效 (只需重算那一个块) */
  function aggInvalidate(q, r) {
    if (sampleM < AGG_DIV) return;
    var aq = Math.floor(q / sampleM) * sampleM, ar = Math.floor(r / sampleM) * sampleM;
    aggCache.delete(sampleM + ':' + aq + ',' + ar);
  }

  /* 重建待采样列表: 先铺「粗层」把整个视野盖住 (几十格, 一帧算完) ⇒ 首帧就有粗略
     地脉; 再逐层细化到「原始样本层」rawM。biomeAt 的层级回退链正好用得上粗层
     ⇒ 永远不成片露底。U4 起细层是 rawM = mD/AGG_DIV (每块 4 个子格样本)。 */
  function rebuildPending(v, W, H) {
    var m = levelFor(v, W, H);               // 显示块层级 mD (决定块大小与聚合层级)
    sampleM = m;
    rawM = rawLevelOf(m);
    aggCache.clear();                        // 换层 ⇒ 旧聚合键/口径全失效
    pendingSet.clear();
    var lv = [], x = Math.min(1 << LEVEL_MAX, m * 8);
    for (; x > rawM; x >>= 1) lv.push(x);
    lv.push(rawM);
    var out = [];
    for (var i = 0; i < lv.length; i++) out = out.concat(enumLevel(v, W, H, lv[i]));
    pending = out; pendingIdx = 0;
    mmStat.m = m; mmStat.rawM = rawM; mmStat.pending = out.length;
  }

  /* 显示侧补料: 画到没有数据的块 ⇒ 把「原始层的对齐格」追加进待采样 (拖动新露出的边缘) */
  function pendingAdd(q, r) {
    var m = rawM;
    var aq = m > 1 ? Math.floor(q / m) * m : q;
    var ar = m > 1 ? Math.floor(r / m) * m : r;
    var k = aq + ',' + ar;
    if (terrainCache.has(k) || pendingSet.has(k)) return;
    if (pending.length >= PENDING_CAP) { mmStat.enqDrop++; return; }
    pendingSet.add(k);
    pending.push([aq, ar, 0, m]);
    mmStat.pending = pending.length;
  }

  /* 取某格的群系: ① 块级多数表决 (U4) → ② 块角点原始样本 → ③ 沿层级回退链找已算过的
     对齐格 (粗层引导先铺满 ⇒ 首帧即有)。
     ⚠ 块 = 网格的一个 mD×mD 区域, 同一块内的所有像素必须同色 ⇒ mD>=AGG_DIV 时不再走
       「精确格」快路径 (那会在块内混入角点色, 破坏块一致性)。 */
  function biomeAt(q, r) {
    var b;
    if (sampleM < AGG_DIV) {
      b = terrainCache.get(q + ',' + r);
      if (b != null) return b;
    } else {
      var aq = Math.floor(q / sampleM) * sampleM, ar = Math.floor(r / sampleM) * sampleM;
      var a = aggOf(aq, ar, sampleM);
      if (a != null) return a.b;
      b = terrainCache.get(aq + ',' + ar);
      if (b != null) return b;
    }
    var top = Math.min(512, sampleM * 8);
    for (var m = sampleM; m <= top; m *= 2) {
      if (m < 2) continue;
      b = terrainCache.get((Math.floor(q / m) * m) + ',' + (Math.floor(r / m) * m));
      if (b != null) return b;
    }
    return null;
  }

  /* 消化待采样格: 按「时间额度」而不是「个数」—— 机器快/帧率高时自动多算,
     帧率低 (软件渲染/后台标签页) 时按帧间隔成比例补上, 首屏填充不会被帧率卡死。
     ⚠ 用游标而不是 Array.shift(): shift() 对大数组是 O(n) 搬移, 且旧的「队列满即丢弃」
       会把「待算」永久变成「未探测」。 */
  function sampleTick(budgetMs) {
    if (!engineReady) return false;
    if (pendingIdx >= pending.length) return false;
    var t0 = performance.now(), n = 0, item, q, r, k, t, budget = budgetMs || SAMPLE_BUDGET_MS;
    while (pendingIdx < pending.length) {
      item = pending[pendingIdx++];
      q = item[0]; r = item[1];
      k = q + ',' + r;
      if (terrainCache.has(k)) continue;
      t = null;
      try { t = engine.fields(q, r); } catch (e) { t = null; }
      terrainCache.set(k, t && typeof t.biome === 'number' ? t.biome : -1);
      aggInvalidate(q, r);              // U4: 新样本 ⇒ 所属显示块的聚合失效 (只删一个键)
      n++;
      if ((n & 63) === 0 && performance.now() - t0 >= budget) break;
    }
    /* 缓存上限: 按插入序淘汰最旧 1/4 (整表清空会重新露底, 不可取) */
    if (terrainCache.size > TERRAIN_CAP) {
      var it = terrainCache.keys(), drop = TERRAIN_CAP >> 2;
      for (var i = 0; i < drop; i++) { var e = it.next(); if (e.done) break; terrainCache.delete(e.value); }
    }
    mmStat.pendingLeft = Math.max(0, pending.length - pendingIdx);
    return n > 0;
  }

  /* ---------- 视图 ---------- */
  /* 面板档上屏 wpp = 基准 × (基准缩放 / 主相机缩放)。
     于是「小图 1px 的世界长度」与「大图 1px 的世界长度」之比 = 1/(baseWpp × DEFAULT_ZOOM)
     —— 与 zoom 无关的常数 ⇒ 主图缩放时小图同比例跟着变, 大小比例永远一致。 */
  function panelWppNow() {
    var z = (snap && snap.cam && snap.cam.zoom > 0) ? snap.cam.zoom : DEFAULT_ZOOM;
    return clamp(baseWpp * DEFAULT_ZOOM / z, WPP_MIN, WPP_MAX);
  }
  /* 相对默认倍率的显示倍数 (>1 = 比默认更放大) */
  function panelZoomX() { return FOLLOW_WPP / baseWpp; }
  function fmtX(x) { return '×' + (Math.round(x * 100) / 100); }

  function curView() {
    if (maximized) return viewFull;
    return {
      cx: followCam ? (snap ? snap.cam.x : 0) : viewPanel.cx,
      cy: followCam ? (snap ? snap.cam.y : 0) : viewPanel.cy,
      wpp: panelWppNow()
    };
  }
  function canvasLogical(cv) {
    var w = Math.max(1, cv.clientWidth || 216), h = Math.max(1, cv.clientHeight || 141);
    return { w: w, h: h };
  }
  function worldToScreen(wx, wy, v, W, H) {
    return { x: (wx - v.cx) / v.wpp + W / 2, y: (wy - v.cy) / v.wpp + H / 2 };
  }
  function screenToWorld(sx, sy, v, W, H) {
    return { x: v.cx + (sx - W / 2) * v.wpp, y: v.cy + (sy - H / 2) * v.wpp };
  }

  /* 地形位图: 每 step 画布像素抽 1 个格 (总样本数封顶 ~4 万, 保证大窗口也不卡) */
  function buildTerrain(W, H, v) {
    var step = Math.max(2, Math.ceil(Math.sqrt((W * H) / SAMPLE_CELLS_MAX)));
    var bw = Math.max(1, Math.ceil(W / step)), bh = Math.max(1, Math.ceil(H / step));
    if (!terrainBmp) { terrainBmp = document.createElement('canvas'); terrainBc = terrainBmp.getContext('2d'); }
    if (terrainBmp.width !== bw || terrainBmp.height !== bh) {
      terrainBmp.width = bw; terrainBmp.height = bh;
    }
    var img = terrainBc.createImageData(bw, bh), d = img.data;
    var i, px, py, wx, wy, t, b, rgb, o, miss = 0, bb;
    if (!bmpBiome || bmpBiome.length < bw * bh) bmpBiome = new Int16Array(bw * bh);
    for (py = 0; py < bh; py++) {
      wy = v.cy + ((py * step + step / 2) - H / 2) * v.wpp;
      for (px = 0; px < bw; px++) {
        wx = v.cx + ((px * step + step / 2) - W / 2) * v.wpp;
        t = pxToTile(wx, wy);
        b = biomeAt(t.q, t.r);           // 块级多数表决 (U4) → 块角点原始样本 → 更粗层级的对齐格
        o = (py * bw + px) * 4;
        bmpBiome[py * bw + px] = bb = (b == null) ? -9 : b;   // -9 = 尚无数据 (不计入椒盐诊断)
        if (b == null) {                 // 尚无数据 (刚暴露的边缘) → 补料 + 未探测斜纹
          miss++;
          pendingAdd(t.q, t.r);
          rgb = (((px + py) & 3) === 0) ? UNK_HATCH : UNK_BASE;
          d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
        } else if (b < 0) {              // 引擎算不出该格: 用更暗的未探测色
          rgb = UNK_BASE;
          d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
        } else {
          rgb = biomeRGB[b] || UNK_HATCH;
          d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
        }
      }
    }
    terrainBc.putImageData(img, 0, 0);
    /* 椒盐诊断 (U4 验收口径, 只读计数): 四邻群系已知、且自身与四邻全不同的块 = 孤立噪点块。
       画面就是这张位图放大 step 倍 ⇒ 位图上的孤立块 = 屏幕上的孤立色块。 */
    var iso = 0, base = 0, ax, ay, k0;
    for (ay = 1; ay < bh - 1; ay++) {
      for (ax = 1; ax < bw - 1; ax++) {
        k0 = ay * bw + ax; b = bmpBiome[k0];
        if (b < 0) continue;
        if (bmpBiome[k0 - 1] < 0 || bmpBiome[k0 + 1] < 0 ||
            bmpBiome[k0 - bw] < 0 || bmpBiome[k0 + bw] < 0) continue;
        base++;
        if (bmpBiome[k0 - 1] !== b && bmpBiome[k0 + 1] !== b &&
            bmpBiome[k0 - bw] !== b && bmpBiome[k0 + bw] !== b) iso++;
      }
    }
    mmStat.bmpW = bw; mmStat.bmpH = bh; mmStat.step = step;
    mmStat.blocks = bw * bh; mmStat.miss = miss;
    mmStat.iso = iso; mmStat.isoBase = base; mmStat.agg = aggCache.size;
    return { bmp: terrainBmp, step: step };
  }

  /* ---------- L2 世界层 (全部来自 WS 快照) ---------- */
  function drawRoads(c, W, H, v, k) {
    if (!snap || !snap.roads || !snap.roads.size) return;
    c.strokeStyle = 'rgba(198,152,82,0.72)';
    c.lineWidth = Math.max(1, 1 * k);
    c.beginPath();
    snap.roads.forEach(function (cell) {
      var roads = cell && cell.roads;
      if (!roads) return;
      for (var i = 0; i < roads.length; i++) {
        var pts = roads[i].pts;
        if (!pts || pts.length < 4) continue;
        for (var j = 0; j + 1 < pts.length; j += 2) {
          var p = worldToScreen(pts[j], pts[j + 1], v, W, H);
          if (j === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
        }
      }
    });
    c.stroke();
  }

  function drawSettles(c, W, H, v, k) {
    if (!snap || !snap.settles || !snap.settles.size) return;
    var drawn = 0;
    snap.settles.forEach(function (list) {
      if (!list) return;
      for (var i = 0; i < list.length && drawn < 900; i++) {
        var s = list[i];
        if (!s) continue;
        var wp = (s.x || s.y) ? { x: s.x, y: s.y } : tileToWorld(s.q, s.r);
        var p = worldToScreen(wp.x, wp.y, v, W, H);
        if (p.x < -8 || p.y < -8 || p.x > W + 8 || p.y > H + 8) continue;
        var col = SETTLE_COLOR[s.type] || SETTLE_FALLBACK;
        var r = (s.type === 'city' ? 3.4 : s.type === 'sect' ? 3.2 : s.type === 'town' ? 2.8 : 2.2) * k;
        c.fillStyle = css(col);
        c.strokeStyle = 'rgba(28,24,20,0.85)';
        c.lineWidth = Math.max(0.6, k);
        c.beginPath();
        c.rect(p.x - r, p.y - r, r * 2, r * 2);
        c.fill(); c.stroke();
        drawn++;
      }
    });
  }

  /* 灵脉 (五行/异灵根/等级) —— WS comm.veins */
  function drawVeins(c, W, H, v, k) {
    if (!snap || !snap.comms || !snap.comms.size) return;
    var list = [];
    snap.comms.forEach(function (cm) {
      if (!cm || !cm.veins) return;
      for (var i = 0; i < cm.veins.length; i++) {
        var nv = cm.veins[i];
        if (nv) list.push(nv);
      }
    });
    if (!list.length) return;
    for (var i2 = 0; i2 < list.length; i2++) {
      var vn = list[i2];
      var wp2 = (vn.x || vn.y) ? { x: vn.x, y: vn.y } : tileToWorld(vn.q, vn.r);
      var p2 = worldToScreen(wp2.x, wp2.y, v, W, H);
      if (p2.x < -10 || p2.y < -10 || p2.x > W + 10 || p2.y > H + 10) continue;
      var rgb = (vn.variant && veinRGB && veinRGB[vn.variant])
        ? veinRGB[vn.variant]
        : (rgbOf(snap.elementRGB, vn.element) || [200, 200, 200]);
      var lvl = (typeof vn.level === 'number') ? vn.level : 2;
      var rr = (lvl === 0 ? 5.0 : lvl === 1 ? 4.0 : lvl === 2 ? 3.0 : 2.2) * k;
      /* 外圈柔光 + 菱形本体 (灵脉很密时省掉渐变, 否则每帧几百个 radialGradient 太贵) */
      if (list.length <= 140) {
        var grd = c.createRadialGradient(p2.x, p2.y, 0, p2.x, p2.y, rr * 2.4);
        grd.addColorStop(0, css(rgb, 0.55));
        grd.addColorStop(1, css(rgb, 0));
        c.fillStyle = grd;
        c.beginPath(); c.arc(p2.x, p2.y, rr * 2.4, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = css(rgb);
      c.strokeStyle = 'rgba(30,26,22,0.9)';
      c.lineWidth = Math.max(0.6, 0.9 * k);
      c.beginPath();
      c.moveTo(p2.x, p2.y - rr); c.lineTo(p2.x + rr, p2.y);
      c.lineTo(p2.x, p2.y + rr); c.lineTo(p2.x - rr, p2.y);
      c.closePath(); c.fill(); c.stroke();
    }
  }

  /* ---------- 绘制主入口 ---------- */
  function draw() {
    var fctxUse = maximized ? fctx : ctx;
    var cvUse = maximized ? fcanvas : canvas;
    if (!fctxUse || !snap) return;
    var L = canvasLogical(cvUse), W = L.w, H = L.h;
    var dpr = Math.max(1, Math.min(3, g.devicePixelRatio || 1));
    var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (cvUse.width !== pw || cvUse.height !== ph) {
      cvUse.width = pw; cvUse.height = ph;
      cardDirty = true;
    }
    var c = fctxUse;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var v = curView(), k = maximized ? 1.6 : 1;

    /* L1 地形 */
    var tb = buildTerrain(W, H, v);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, W, H);
    c.drawImage(tb.bmp, 0, 0, W, H);

    /* 灵气边界圈 (引擎口径; 引擎未就绪则不画) */
    if (engineReady && engine && engine.spiritEdgeWorld) {
      var eW = 0;
      try { eW = engine.spiritEdgeWorld(); } catch (e2) { eW = 0; }
      if (eW > 0) {
        var O = worldToScreen(0, 0, v, W, H), rad = eW / v.wpp;
        if (rad > 4 && rad < 20000) {
          c.strokeStyle = 'rgba(120,96,150,0.42)';
          c.lineWidth = 1;
          c.beginPath(); c.arc(O.x, O.y, rad, 0, Math.PI * 2); c.stroke();
        }
      }
    }

    /* L2 世界层 */
    drawRoads(c, W, H, v, k);
    drawSettles(c, W, H, v, k);
    drawVeins(c, W, H, v, k);

    /* L3 视野框 (主相机视口; 全屏档用于对照) */
    if (snap.cam && snap.vw && snap.vh) {
      var halfW = (snap.vw / 2) / snap.cam.zoom, halfH = (snap.vh / 2) / snap.cam.zoom;
      var a1 = worldToScreen(snap.cam.x - halfW, snap.cam.y - halfH, v, W, H);
      var a2 = worldToScreen(snap.cam.x + halfW, snap.cam.y + halfH, v, W, H);
      c.strokeStyle = SEAL;
      c.lineWidth = Math.max(1, 1.4 * k);
      var rx = Math.max(6, a2.x - a1.x), ry = Math.max(6, a2.y - a1.y);
      c.strokeRect(a1.x, a1.y, rx, ry);
    } else if (!maximized) {
      /* 默认档没有主视口数据时至少标出中心 (不再有「中心小方块」的误导) */
      c.strokeStyle = SEAL;
      c.lineWidth = 1.2;
      c.strokeRect(W / 2 - 3, H / 2 - 3, 6, 6);
    }

    /* 未就绪提示 */
    if (!engineReady) {
      c.fillStyle = 'rgba(232,220,196,0.86)';
      c.font = '12px "KaiTi","STKaiti",serif';
      c.textAlign = 'center';
      c.fillText('地脉未通 · 地形待算', W / 2, H / 2 - 8);
    }
    c.textAlign = 'left';
    lastDraw = performance.now();
    mmStat.draws++;
  }

  function markDirty() { cardDirty = true; }

  /* ---------- 循环 ---------- */
  function tick() {
    if (destroyed || hidden) return;
    rafId = g.requestAnimationFrame(tick);
    if (!deps) return;
    var nowMs = performance.now();
    var dtMs = Math.min(400, nowMs - lastTickMs);      // 首帧 lastTickMs=0 → 取 400 上限
    lastTickMs = nowMs;
    var s = deps.snapshot();
    if (!s) return;
    snap = s;
    if (!biomeRGB.length && s.biomeMeta) {
      for (var i = 0; i < s.biomeMeta.length; i++) {
        biomeRGB[i] = parseColor(s.biomeMeta[i] && s.biomeMeta[i].color, [185, 173, 146]);
      }
    }
    veinRGB = s.variantRGB || veinRGB;

    if (engineSeed !== s.seed) {       // 世界重铸 → 地形层全量重置 (+ 引擎换 seed)
      resetTerrain();
      engineSeed = s.seed;             // 本地记账: 引擎侧 init 统一由 EngineLocal 管
      var E2 = EL();
      if (engineReady && E2) E2.setSeed(s.seed);
      cardDirty = true;
    }
    if (s.rev !== lastRev) { lastRev = s.rev; cardDirty = true; }

    /* 抽样层级/视野变了 → 重建待采样列表 (世界对齐 ⇒ 已算过的格不会白费)。
       拖动中用「列表已排空」才重建: 保证抽样器永远有活干, 又不在每帧重排 2 万个格;
       松手 (dragState 为空) 立即按「由近及远」重排 ⇒ 视野一次填满。 */
    if (engineReady) {
      var cvNow = maximized ? fcanvas : canvas;
      if (cvNow) {
        var LNow = canvasLogical(cvNow), vNow = curView();
        var qx = Math.max(1e-6, vNow.wpp * 12);
        var ep = levelFor(vNow, LNow.w, LNow.h) + '|' + Math.round(vNow.cx / qx) + '|' + Math.round(vNow.cy / qx);
        if (ep !== pendingEpoch && (!dragState || pendingIdx >= pending.length)) {
          rebuildPending(vNow, LNow.w, LNow.h);
          pendingEpoch = ep;
          cardDirty = true;
        }
      }
    }

    var progressed = sampleTick(clamp(dtMs * 0.35, SAMPLE_BUDGET_MS, 110));
    if (progressed) cardDirty = true;

    if (!maximized) {
      /* 默认档: 相机动了 → 重画 (位图以相机为中心, 内容会变) */
      if (!viewCacheInit || Math.abs(s.cam.x - viewCache.x) > 0.9 ||
          Math.abs(s.cam.y - viewCache.y) > 0.9 || Math.abs(s.cam.zoom - viewCache.z) > 0.02) {
        viewCacheInit = true; viewCache.x = s.cam.x; viewCache.y = s.cam.y; viewCache.z = s.cam.zoom;
        cardDirty = true;
      }
    }
    var now = performance.now();
    if (cardDirty && (dragState || now - lastDraw >= REDRAW_MS)) {
      cardDirty = false;
      draw();
    }
  }
  var viewCache = { x: NaN, y: NaN, z: NaN }, viewCacheInit = false;
  var lastTickMs = 0;

  function start() {
    if (running || destroyed) return;
    running = true;
    rafId = g.requestAnimationFrame(tick);
  }
  function stop() {
    if (rafId) g.cancelAnimationFrame(rafId);
    rafId = 0; running = false;
  }

  /* ---------- 提示层 ---------- */
  /* 灵脉呈示名: 真源在 vein-skin.js 的 VeinSkin.label (大地图匾额 / 侧栏 / 这里三处共用)。
     懒取 g.VeinSkin 而非模块初始化时缓存 —— 将来若调整 index.html 的加载顺序, 这里会
     立刻退回「只有名字」而不是静默拿到 null。⚠ 兜底刻意不写档名数组: 档名真源只有
     vein-skin.js LEVELS[].key 一处 (历史上这里另有一份长度还不同的副本, 已删)。 */
  function veinLabel(v) {
    var V = g.VeinSkin;
    if (V && V.label) return V.label(v, v && v.level);
    return (v && v.name) ? v.name : '灵脉';
  }
  function tipTextAt(wx, wy, v) {
    var t = pxToTile(wx, wy);
    var out = [];
    var b = biomeAt(t.q, t.r);         // 与显示同口径 (精确格 → 对齐格), 免得「画着有色、读说未探测」
    var bn = (b != null && b >= 0 && snap.biomeMeta && snap.biomeMeta[b])
      ? snap.biomeMeta[b].name : (b == null ? '未探测' : '不可测');
    out.push(bn + ' · ' + t.q + ',' + t.r);
    /* 灵脉 (取最近, 3 格内) */
    var best = null, bestD = 4;
    if (snap.comms) {
      snap.comms.forEach(function (cm) {
        if (!cm || !cm.veins) return;
        for (var i = 0; i < cm.veins.length; i++) {
          var nv = cm.veins[i]; if (!nv) continue;
          var d = Math.max(Math.abs(nv.q - t.q), Math.abs(nv.r - t.r));
          if (d < bestD) { bestD = d; best = nv; }
        }
      });
    }
    if (best) {
      /* 2026-09-15: 去括号 + 去「灵脉」叠字, 等级用全角间隔号 (与大地图匾额同款)。
         ⚠ 文案真源在 vein-skin.js 的 VeinSkin.label —— 别在这里再写一份档名数组。 */
      out.push(veinLabel(best) + ' · ' + bestD + '格');
    }
    var st = null;
    if (snap.settles) {
      snap.settles.forEach(function (list) {
        if (st || !list) return;
        for (var i = 0; i < list.length; i++) {
          var s2 = list[i];
          if (s2 && Math.max(Math.abs(s2.q - t.q), Math.abs(s2.r - t.r)) <= 1) { st = s2; return; }
        }
      });
    }
    if (st) {
      out.push(st.name + ' · ' + ({ sect: '宗门', city: '城', town: '镇', village: '村', fishing: '渔村' }[st.type] || st.type));
      /* R6b (B, 2026-09-15): 归属势力 —— 解析器由 main.js 注入 (本模块只读地物, 不认"辖区")。
         ⚠ 必须容忍注入缺失 (main.js 可单独回退到旧版) ⇒ 先查函数存在再调。 */
      if (typeof deps.factionOf === 'function' && st.type !== 'sect') {
        var fac = deps.factionOf(st);
        if (fac && fac.name) out.push('归属 ' + fac.name);
      }
    }
    return out.join('\n');
  }
  function showTip(sx, sy, text) {
    if (!tip) return;
    tip.textContent = text;
    tip.style.display = 'block';
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var vw = g.innerWidth || 1200, vh = g.innerHeight || 800;
    tip.style.left = clamp(sx + 14, 4, Math.max(4, vw - w - 6)) + 'px';
    tip.style.top = clamp(sy + 14, 4, Math.max(4, vh - h - 6)) + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  /* ---------- 倍率持久化 (跨刷新保存「与大地图的大小比例」) ---------- */
  function loadView() {
    try {
      var raw = g.localStorage ? g.localStorage.getItem(LS_KEY) : null;
      if (!raw) return;
      var o = JSON.parse(raw);
      if (!o || o.v !== 1) return;
      if (isFinite(o.base)) baseWpp = clamp(+o.base, BASE_WPP_MIN, BASE_WPP_MAX);
      if (isFinite(o.wpp)) viewPanel.wpp = clamp(+o.wpp, WPP_MIN, WPP_MAX);
      if (isFinite(o.fullWpp)) viewFull.wpp = clamp(+o.fullWpp, WPP_MIN, WPP_MAX);
    } catch (e) { /* 无 localStorage / 坏 JSON ⇒ 用默认值, 绝不抛 */ }
  }
  function saveView() {
    try {
      if (!g.localStorage) return;
      g.localStorage.setItem(LS_KEY, JSON.stringify({
        v: 1, base: Math.round(baseWpp * 1e4) / 1e4,
        wpp: Math.round(viewPanel.wpp * 1e4) / 1e4,
        fullWpp: Math.round(viewFull.wpp * 1e4) / 1e4
      }));
    } catch (e) { /* 隐私模式/配额禁用 ⇒ 静默降级 (不阻断交互) */ }
  }
  function saveViewSoon() {          // 滚轮连滚时别每格都写盘
    if (persistTimer) return;
    persistTimer = g.setTimeout(function () { persistTimer = 0; saveView(); }, 400);
  }
  /* 面板底部提示 —— 用户唯一能「看见倍率已被记住」的地方 */
  function updateHint() {
    var zn = fmtX(panelZoomX());
    if (hintEl) {
      hintEl.textContent = (followCam ? '跟随视野' : '自由视角') + ' · 倍率 ' + zn;
      hintEl.title = '滚轮/捏合缩放 · 拖动平移 (拖过会自动转自由视角) · 单击展开全屏 · 归心恢复跟随';
    }
    if (fullTitleEl) {
      fullTitleEl.textContent = '山河小图 · 全屏（倍率 ' + fmtX(FULL_WPP_INIT / viewFull.wpp) +
        ' · 拖动平移 · 滚轮/捏合缩放 · 单击跳转）';
    }
  }

  /* ---------- 交互 ---------- */
  /* 触摸档 (手机) —— 原实现只绑了 mouse*, 手机上压根没有对应事件 ⇒ 「既不能放大也不能拖动」。
     ⚠ 合成鼠标事件: 一次触摸结束后浏览器会在 ~300ms 内补发 mousedown/mouseup,
       不拦就会被 mouseup 的「未拖动 ⇒ 展开全屏」接住 —— 于是「一拖动就自己弹全屏」。 */
  function touchMark(e) { lastTouchTs = e.timeStamp; }
  function fromTouch(e) { return (e.timeStamp - lastTouchTs) < TOUCH_GUARD_MS; }
  function touchDist(e) {
    var a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
  }
  function touchMid(e) {
    var a = e.touches[0], b = e.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  /* 面板档捏合 = 滚轮同口径: 只改「与大地图恒定大小比例」的载体 baseWpp,
     上屏 wpp 仍由 panelWppNow() 按主相机 zoom 反比推出 —— 直接改上屏 wpp 会把恒定比例毁掉。
     自由视角下再补一次中心偏移, 让两指中点下的世界点不动 (跟随态中心被主相机锁死, 补了也会被下一帧覆盖)。 */
  function onPanelPinch(e) {
    var d = touchDist(e);
    if (!pinchPanelD) { pinchPanelD = d; return; }
    var f = pinchPanelD / d;                 // 两指张开 ⇒ f<1 ⇒ baseWpp 变小 ⇒ 更放大
    pinchPanelD = d;
    var L = canvasLogical(canvas), rect = canvas.getBoundingClientRect(), m = touchMid(e);
    var before = screenToWorld(m.x - rect.left, m.y - rect.top, curView(), L.w, L.h);
    baseWpp = clamp(baseWpp * f, BASE_WPP_MIN, BASE_WPP_MAX);
    var after = screenToWorld(m.x - rect.left, m.y - rect.top, curView(), L.w, L.h);
    if (!followCam) { viewPanel.cx += before.x - after.x; viewPanel.cy += before.y - after.y; }
    cardDirty = true;
    updateHint();
    saveViewSoon();
  }
  /* 全屏档捏合 = 滚轮同口径 (滚轮锚在光标, 这里锚在两指中点) */
  function onFullPinch(e) {
    var d = touchDist(e);
    if (!pinchFullD) { pinchFullD = d; return; }
    var f = pinchFullD / d;
    pinchFullD = d;
    var rect = fcanvas.getBoundingClientRect(), L = canvasLogical(fcanvas), m = touchMid(e);
    var mx = m.x - rect.left, my = m.y - rect.top;
    var before = screenToWorld(mx, my, viewFull, L.w, L.h);
    viewFull.wpp = clamp(viewFull.wpp * f, WPP_MIN, WPP_MAX);
    var after = screenToWorld(mx, my, viewFull, L.w, L.h);
    viewFull.cx += before.x - after.x;
    viewFull.cy += before.y - after.y;
    cardDirty = true;
    updateHint();
    saveViewSoon();
  }
  function onPanelMove(e) {
    if (!snap) return;
    if (dragPanel && dragPanel.moved) { hideTip(); return; }
    var rect = canvas.getBoundingClientRect();
    var L = canvasLogical(canvas), v = curView();
    var w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, v, L.w, L.h);
    showTip(e.clientX, e.clientY, tipTextAt(w.x, w.y, v));
  }

  function bindPanel() {
    if (!canvas) return;
    /* 单击展开全屏 / 拖动平移 —— 用位移阈值区分 (3px, 与全屏档同口径)。
       ⚠ 拖动的起始中心必须锁成「按下瞬间的实际中心」: followCam 为真时 viewPanel.cx 是旧值,
         直接拿它算会在第一帧跳一大跳。 */
    canvas.addEventListener('mousedown', function (e) {
      if (fromTouch(e) || e.button !== 0) return;
      e.preventDefault();
      var v = curView();
      dragPanel = { sx: e.clientX, sy: e.clientY, cx: v.cx, cy: v.cy, wpp: v.wpp, moved: false };
    });
    g.addEventListener('mousemove', function (e) {
      if (!dragPanel || maximized) return;
      var dx = e.clientX - dragPanel.sx, dy = e.clientY - dragPanel.sy;
      if (!dragPanel.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        dragPanel.moved = true;
        followCam = false;                       // 一拖动就脱离跟随 (倍率仍锁定不变)
        if (canvas) canvas.style.cursor = 'grabbing';
      }
      if (dragPanel.moved) {
        viewPanel.cx = dragPanel.cx - dx * dragPanel.wpp;
        viewPanel.cy = dragPanel.cy - dy * dragPanel.wpp;
        cardDirty = true;
      }
    });
    g.addEventListener('mouseup', function (e) {
      if (!dragPanel) return;
      if (fromTouch(e)) { dragPanel = null; return; }   // 合成事件: 丢弃, 但清状态免卡死
      var moved = dragPanel.moved;
      dragPanel = null;
      if (canvas) canvas.style.cursor = '';
      if (moved) { updateHint(); saveViewSoon(); return; }
      setMaximized(true);                        // 未拖动 ⇒ 视为单击: 展开全屏
    });
    /* 滚轮 = 调「与大地图的大小比例」(只改基准 baseWpp; 上屏 wpp 由 zoom 反比推出,
       不能也不该直接改上屏 wpp —— 那会把恒定比例改掉) */
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      baseWpp = clamp(baseWpp * f, BASE_WPP_MIN, BASE_WPP_MAX);
      cardDirty = true;
      updateHint();
      saveViewSoon();
    }, { passive: false });
    /* —— 触摸档 —— */
    canvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      touchMark(e);
      if (e.touches.length >= 2) {
        dragPanel = null;                       // 两指 = 捏合: 不作平移, 更不能把抬手当成「点按展开」
        pinchPanelD = touchDist(e);
        hideTip();
        return;
      }
      var v = curView();                        // 同鼠标: 锁「按下瞬间的实际中心」(followCam 时 viewPanel.cx 是旧值)
      dragPanel = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                    cx: v.cx, cy: v.cy, wpp: v.wpp, moved: false };
    }, { passive: false });
    canvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      touchMark(e);
      if (e.touches.length >= 2) { onPanelPinch(e); return; }
      if (!dragPanel || maximized) return;
      var dx = e.touches[0].clientX - dragPanel.sx, dy = e.touches[0].clientY - dragPanel.sy;
      if (!dragPanel.moved && Math.abs(dx) + Math.abs(dy) > TOUCH_SLOP) {
        dragPanel.moved = true;
        followCam = false;                      // 一拖动就脱离跟随 (与鼠标同口径)
        hideTip();
      }
      if (dragPanel.moved) {
        viewPanel.cx = dragPanel.cx - dx * dragPanel.wpp;
        viewPanel.cy = dragPanel.cy - dy * dragPanel.wpp;
        cardDirty = true;
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      touchMark(e);
      var left = e.touches ? e.touches.length : 0;
      if (left >= 1) {
        /* 捏合抬起一指 ⇒ 剩下那指接着拖 (不该要求松手重按); moved:true 保证不会被当成点按 */
        var v2 = curView();
        dragPanel = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                      cx: v2.cx, cy: v2.cy, wpp: v2.wpp, moved: true };
        pinchPanelD = 0;
        return;
      }
      pinchPanelD = 0;
      if (!dragPanel) return;
      var moved = dragPanel.moved;
      dragPanel = null;
      if (moved) { updateHint(); saveViewSoon(); return; }
      setMaximized(true);                       // 未移动 ⇒ 单击: 展开全屏
    }, { passive: false });
    canvas.addEventListener('touchcancel', function () { dragPanel = null; pinchPanelD = 0; });
    canvas.addEventListener('mousemove', onPanelMove);
    canvas.addEventListener('mouseleave', function () {
      hideTip();
      if (!dragPanel && canvas) canvas.style.cursor = '';
    });
  }

  function bindFull() {
    if (!fcanvas) return;
    fcanvas.addEventListener('mousedown', function (e) {
      if (fromTouch(e) || e.button !== 0) return;
      e.preventDefault();
      dragState = { sx: e.clientX, sy: e.clientY, cx: viewFull.cx, cy: viewFull.cy, moved: false };
    });
    g.addEventListener('mousemove', function (e) {
      if (!dragState || !maximized) return;
      var dx = e.clientX - dragState.sx, dy = e.clientY - dragState.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragState.moved = true;
      if (dragState.moved) {
        viewFull.cx = dragState.cx - dx * viewFull.wpp;
        viewFull.cy = dragState.cy - dy * viewFull.wpp;
        cardDirty = true;
      }
    });
    g.addEventListener('mouseup', function (e) {
      if (fromTouch(e)) { dragState = null; return; }
      if (!dragState || !maximized) { dragState = null; return; }
      var moved = dragState.moved;
      dragState = null;
      if (moved) { saveViewSoon(); return; }
      /* 单击 (未拖动) → 主相机跳转 */
      var rect = fcanvas.getBoundingClientRect();
      var L = canvasLogical(fcanvas);
      var w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, viewFull, L.w, L.h);
      if (deps && deps.jump) deps.jump(w.x, w.y);
      cardDirty = true;
    });
    fcanvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = fcanvas.getBoundingClientRect();
      var L = canvasLogical(fcanvas);
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var before = screenToWorld(mx, my, viewFull, L.w, L.h);
      var f = e.deltaY > 0 ? 1.14 : 1 / 1.14;
      viewFull.wpp = clamp(viewFull.wpp * f, WPP_MIN, WPP_MAX);
      var after = screenToWorld(mx, my, viewFull, L.w, L.h);
      viewFull.cx += before.x - after.x;      // 以光标为不动点
      viewFull.cy += before.y - after.y;
      cardDirty = true;
      updateHint();                            // 全屏头部显示当前倍率
      saveViewSoon();                          // 全屏倍率同样持久化
    }, { passive: false });
    /* —— 触摸档 —— */
    fcanvas.addEventListener('touchstart', function (e) {
      e.preventDefault();
      touchMark(e);
      if (e.touches.length >= 2) { dragState = null; pinchFullD = touchDist(e); hideTip(); return; }
      dragState = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                    cx: viewFull.cx, cy: viewFull.cy, moved: false };
    }, { passive: false });
    fcanvas.addEventListener('touchmove', function (e) {
      e.preventDefault();
      touchMark(e);
      if (e.touches.length >= 2) { onFullPinch(e); return; }
      if (!dragState || !maximized) return;
      var dx = e.touches[0].clientX - dragState.sx, dy = e.touches[0].clientY - dragState.sy;
      if (Math.abs(dx) + Math.abs(dy) > TOUCH_SLOP) dragState.moved = true;
      if (dragState.moved) {
        viewFull.cx = dragState.cx - dx * viewFull.wpp;
        viewFull.cy = dragState.cy - dy * viewFull.wpp;
        cardDirty = true;
      }
    }, { passive: false });
    fcanvas.addEventListener('touchend', function (e) {
      e.preventDefault();
      touchMark(e);
      var left = e.touches ? e.touches.length : 0;
      if (left >= 1) {
        dragState = { sx: e.touches[0].clientX, sy: e.touches[0].clientY,
                      cx: viewFull.cx, cy: viewFull.cy, moved: true };
        pinchFullD = 0;
        return;
      }
      pinchFullD = 0;
      if (!dragState || !maximized) { dragState = null; return; }
      var moved = dragState.moved;
      dragState = null;
      if (moved) { saveViewSoon(); return; }
      /* 单击 (未移动) → 主相机跳转 */
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var rect = fcanvas.getBoundingClientRect();
      var L = canvasLogical(fcanvas);
      var w = screenToWorld(t.clientX - rect.left, t.clientY - rect.top, viewFull, L.w, L.h);
      if (deps && deps.jump) deps.jump(w.x, w.y);
      cardDirty = true;
    }, { passive: false });
    fcanvas.addEventListener('touchcancel', function () { dragState = null; pinchFullD = 0; });
    fcanvas.addEventListener('mousemove', function (e) {
      if (dragState) { hideTip(); return; }
      var rect = fcanvas.getBoundingClientRect();
      var L = canvasLogical(fcanvas);
      var w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top, viewFull, L.w, L.h);
      showTip(e.clientX, e.clientY, tipTextAt(w.x, w.y, viewFull));
    });
    fcanvas.addEventListener('mouseleave', function () { hideTip(); });
  }

  function onKey(e) {
    if (e.key === 'Escape' && maximized) setMaximized(false);
  }

  /* ---------- 公开接口 ---------- */
  function setMaximized(b) {
    if (destroyed) return;
    maximized = !!b;
    if (!full) maximized = false;
    if (maximized) {
      if (!viewFullInit) {
        viewFull.cx = snap ? snap.cam.x : 0;
        viewFull.cy = snap ? snap.cam.y : 0;
        viewFull.wpp = FULL_WPP_INIT;
        viewFullInit = true;
      } else if (snap) {
        /* 每次打开都以主相机为中心开始 (不全屏期间还记得上次位置也行; 这里选跟随) */
        viewFull.cx = snap.cam.x; viewFull.cy = snap.cam.y;
      }
      full.classList.add('open');
      cardDirty = true;
    } else {
      full.classList.remove('open');
      dragState = null;
      hideTip();
      cardDirty = true;
    }
    updateHint();
  }

  function setHidden(b) {
    if (destroyed) return;
    hidden = !!b;
    if (hidden) {
      if (maximized) setMaximized(false);
      if (panel) panel.classList.add('mm-hidden');
      if (restoreBtn) restoreBtn.classList.add('show');
      stop();                    // 真停摆: 不再 rAF / 不抽样 / 不绘制
    } else {
      if (panel) panel.classList.remove('mm-hidden');
      if (restoreBtn) restoreBtn.classList.remove('show');
      cardDirty = true;
      start();
    }
  }

  function destroy() {
    stop();
    destroyed = true;
    /* 引擎实例归 EngineLocal 所有 (全站共享), 这里只松掉本地引用, 不 dispose/不重 init */
    engine = null; engineReady = false;
    resetTerrain();
    if (panel) panel.innerHTML = '';
    if (full) full.classList.remove('open');
  }

  function init(d) {
    deps = d || {};
    panel = deps.panel || null;
    full = deps.full || null;
    if (panel) {
      canvas = panel.querySelector('canvas');
      ctx = canvas ? canvas.getContext('2d') : null;
    }
    if (full) {
      fcanvas = full.querySelector('canvas');
      fctx = fcanvas ? fcanvas.getContext('2d') : null;
    }
    tip = document.getElementById('mmTip');
    restoreBtn = document.getElementById('mmRestore');
    hintEl = panel ? panel.querySelector('.hint') : null;
    fullTitleEl = full ? full.querySelector('.mm-title') : null;
    loadView();                      // 先恢复持久化倍率, 再绑交互/刷新提示
    bindPanel(); bindFull();
    g.addEventListener('keydown', onKey);
    var fl = panel && panel.querySelector('[data-mm="full"]');
    var hd = panel && panel.querySelector('[data-mm="hide"]');
    var rc = panel && panel.querySelector('[data-mm="recenter"]');
    if (fl) fl.addEventListener('click', function () { setMaximized(true); });
    if (hd) hd.addEventListener('click', function () { setHidden(true); });
    /* 「归心」: 自由视角 → 回跟随主相机 (倍率不变) */
    if (rc) rc.addEventListener('click', function () {
      followCam = true;
      hideTip();
      cardDirty = true;
      saveView();
      updateHint();
    });
    if (full) {
      var cl = full.querySelector('[data-mm="close"]');
      var hd2 = full.querySelector('[data-mm="hide"]');
      var rs = full.querySelector('[data-mm="reset"]');
      if (cl) cl.addEventListener('click', function () { setMaximized(false); });
      if (hd2) hd2.addEventListener('click', function () { setHidden(true); });
      if (rs) rs.addEventListener('click', function () {
        viewFull.wpp = FULL_WPP_INIT;
        if (snap) { viewFull.cx = snap.cam.x; viewFull.cy = snap.cam.y; }
        cardDirty = true;
        saveViewSoon();
        updateHint();
      });
    }
    if (restoreBtn) restoreBtn.addEventListener('click', function () { setHidden(false); });
    /* 调试态: ?mm=full|hide —— headless 截图无法模拟点击 (与 ?sel / ?plaqdbg 同族),
       靠它验收「全屏档 / 隐藏态」两态。?mmwpp=N 指定全屏档初始缩放 (截图验收要能
       复现「缩得很远」的现场)。?mmbase=N 指定面板档基准倍率、?mmfollow=0 直启自由视角
       —— 面板档倍率联动/拖动没有别的实机取数通道 (CDP 对本页会永久挂起)。
       仅显式传参才生效; base 的传参覆盖持久化值 (但**不写回** localStorage)。 */
    try {
      var qs = new URLSearchParams(location.search);
      var mmMode = qs.get('mm');
      var mw = Number(qs.get('mmwpp'));
      var mb = Number(qs.get('mmbase'));
      if (mb > 0) baseWpp = clamp(mb, BASE_WPP_MIN, BASE_WPP_MAX);
      if (qs.get('mmfollow') === '0') followCam = false;
      if (mmMode === 'full') {
        if (mw > 0) { viewFull.wpp = clamp(mw, WPP_MIN, WPP_MAX); viewFullInit = true; }
        setMaximized(true);
      } else if (mmMode === 'hide' || mmMode === 'hidden') setHidden(true);
    } catch (e4) { /* 无 location (不该发生) */ }
    updateHint();
    ensureEngine();          // 异步: 到了就自动重画 (cardDirty 由 rev/相机变化驱动)
    start();
    return api;
  }

  var api = {
    init: init,
    setMaximized: setMaximized,
    setHidden: setHidden,
    toggleHidden: function () { setHidden(!hidden); },
    isHidden: function () { return hidden; },
    isMaximized: function () { return maximized; },
    markDirty: markDirty,
    destroy: destroy,
    /* 诊断用 (实机探针/回归读事实, 不参与业务) */
    probe: function () {
      var z = (snap && snap.cam && snap.cam.zoom > 0) ? snap.cam.zoom : DEFAULT_ZOOM;
      /* 持久化事实: 直接读回 localStorage (写只在 saveView 里发生, 这里只读) */
      var saved = null;
      try { saved = g.localStorage ? g.localStorage.getItem(LS_KEY) : null; } catch (e) { saved = 'ERR'; }
      return {
        hidden: hidden, maximized: maximized, running: running,
        engineReady: engineReady, engineSeed: engineSeed,
        terrainCached: terrainCache.size, queueLen: pending.length - pendingIdx,
        pendingLen: pending.length, sampleM: sampleM, rawM: rawM, agg: aggCache.size,
        rev: lastRev, wpp: maximized ? viewFull.wpp : panelWppNow(),
        /* 面板档倍率 (R13): baseWpp 是持久化的「与大地图的大小比例」载体;
           scaleRatio = 小图/大图 的世界长度比 = 1/(baseWpp × DEFAULT_ZOOM), 恒不随 zoom 变。 */
        baseWpp: baseWpp, camZoom: z, followCam: followCam,
        panelWpp: panelWppNow(), panelZoomX: panelZoomX(),
        panelCx: followCam ? (snap ? snap.cam.x : 0) : viewPanel.cx,
        panelCy: followCam ? (snap ? snap.cam.y : 0) : viewPanel.cy,
        fullWpp: viewFull.wpp, fullCx: viewFull.cx, fullCy: viewFull.cy,
        dragging: !!dragPanel && dragPanel.moved,
        savedRaw: saved,
        bmpW: mmStat.bmpW, bmpH: mmStat.bmpH, step: mmStat.step,
        blocks: mmStat.blocks, miss: mmStat.miss, draws: mmStat.draws,
        /* U4: 椒盐量 —— 四邻已知且与四邻群系全不同的块数 / 分母 (位图块级, 画面 = 位图 ×step) */
        iso: mmStat.iso, isoBase: mmStat.isoBase,
        isoPct: mmStat.isoBase ? +(mmStat.iso / mmStat.isoBase * 100).toFixed(2) : 0,
        enqDrop: mmStat.enqDrop, cap: TERRAIN_CAP
      };
    }
  };
  g.MiniMapVein = api;
})(typeof window !== 'undefined' ? window : this);
