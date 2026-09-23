/* ============================================================
 * mapgen-server.js — 服务端适配层 (ClearScript V8 / Node 通用)
 * 依赖: noise.js + mapgen.js 已按序执行, 全局暴露 NoiseLib / MapGen
 * 职责: 把 MapGen 的权威计算结果转成紧凑 JSON 字符串交给宿主
 *       (C# 侧解析后组装 protobuf + gzip 落库/下发; Node 侧用于对照验证)
 * 说明: 本文件不改动任何原始生成逻辑, 只做数据搬运与位打包;
 *       数值打包 = 原始 Float32 语义, 客户端用同一份解码规则还原。
 * ============================================================ */
(function (global) {
  'use strict';
  var MG = global.MapGen;
  if (!MG) throw new Error('mapgen-server: MapGen 未加载');

  var S = MG.CHUNK_S;                 // 区块中心间距 21
  var HEX_W = MG.HEX_W;               // 13.8564
  var HEX_R = MG.HEX_R;               // 8

  /* ---------- base64 / 定宽字节打包 ---------- */
  var _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64FromBytes(u8) {
    var out = '', i = 0, n = u8.length;
    for (; i + 2 < n; i += 3) {
      var a = u8[i], b = u8[i + 1], c = u8[i + 2];
      out += _b64chars[a >> 2] + _b64chars[((a & 3) << 4) | (b >> 4)] +
             _b64chars[((b & 15) << 2) | (c >> 6)] + _b64chars[c & 63];
    }
    if (i + 1 === n) {
      var d = u8[i];
      out += _b64chars[d >> 2] + _b64chars[(d & 3) << 4] + '==';
    } else if (i + 2 === n) {
      var e = u8[i], f = u8[i + 1];
      out += _b64chars[e >> 2] + _b64chars[((e & 3) << 4) | (f >> 4)] + _b64chars[(f & 15) << 2] + '=';
    }
    return out;
  }
  /* P5: 逐段 b64 已并入 chunkJson 单段缓冲; b64FromBytes 仍用于
     单段缓冲 / 字段网格的整体编码 (T14: 原注释「不再需要」与事实不符, 已修正) */

  /* ---------- 区块: 相对区块中心 + u16 量化 ---------- */
  function chunkJson(ca, cb) {
    var built = MG.buildChunk(ca, cb);
    var d = built.data;
    var n = d.tiles.length;
    var cc = { q: ca * S, r: cb * S };            // 区块中心格 (与 mapgen chunkCenter 一致)
    var cqx = MG.tileToWorld(cc.q, cc.r);         // 区块中心世界像素 (绝对)

    /* P5: 全部定宽字段按段连续拼进单段缓冲 → 仅 1 次 base64 + 少量 JSON key,
       替代原先 13 段独立 base64 + JSON 序列化/双转码的开销。
       布局 (全部小端, 与 C# MapWorldService.BuildChunk 逐段切片严格对应):
         地块段: cq[n] | cr[n] | tiles[n] | elev[2n] | hash[2n] | neigh[4n]   (小计 11n)
         精灵段: pdx[4pn] | pdy[4pn] | psp[pn] | ph[2pn] | pe[2pn]            (小计 13pn) */
    var pn = d.propCenters.length / 2;
    var buf = new Uint8Array(n * 11 + pn * 13);
    var dv = new DataView(buf.buffer);
    var oCq = 0, oCr = n, oTiles = 2 * n;
    var oElev = 3 * n, oHash = 5 * n, oNeigh = 7 * n;
    var oPdx = 11 * n, oPdy = oPdx + 4 * pn, oPsp = oPdy + 4 * pn,
        oPh = oPsp + pn, oPe = oPh + 2 * pn;
    var i, k;
    /* R3: cq/cr 直接用 buildChunk 记录的实际轴向偏移 d.qrel/d.rrel (整数),
       不做「世界像素 → 反解轴坐标」的浮点往返 — 大坐标下避免错位一格。
       客户端仍按 ca*S+(cq-16) 正向还原绝对格坐标, 语义完全一致。 */
    for (i = 0; i < n; i++) {
      dv.setUint8(oCq + i, d.qrel[i] + 16);        // 相对区块中心, +16 偏移 (u8)
      dv.setUint8(oCr + i, d.rrel[i] + 16);
      dv.setUint8(oTiles + i, Math.round(d.tiles[i])); // biome*4+variant (整数语义)
      dv.setUint16(oElev + i * 2, Math.max(0, Math.min(65535, Math.round(d.elevs[i] * 65535))), true);
      dv.setUint16(oHash + i * 2, Math.max(0, Math.min(65535, Math.round(d.hashes[i] * 65535))), true);
      dv.setUint32(oNeigh + i * 4, Math.round(d.neigh[i]), true);
    }
    for (k = 0; k < pn; k++) {
      dv.setFloat32(oPdx + k * 4, d.propCenters[k * 2] - cqx.x, true);   // 相对区块中心世界像素 (px)
      dv.setFloat32(oPdy + k * 4, d.propCenters[k * 2 + 1] - cqx.y, true);
      dv.setUint8(oPsp + k, d.propSprites[k]);
      dv.setUint16(oPh + k * 2, Math.max(0, Math.min(65535, Math.round(d.propHashes[k] * 65535))), true);
      dv.setUint16(oPe + k * 2, Math.max(0, Math.min(65535, Math.round(d.propElevs[k] * 65535))), true);
    }
    return JSON.stringify({ ca: ca, cb: cb, count: n, pn: pn, d: b64FromBytes(buf) });
  }

  /* ---------- 区域包: 区域信息 + 聚落(骨架) + 道路(权威) ----------
     B5/D15: 区域包【不再】携带城镇足迹 (style/styleName/buildings/resources)。
       足迹以 settle 包为唯一权威 (settleJson, 落 SQLite、可演化), 由 C# GetTileBlock
       的 needSettle 分支合并; 前端 main.js 也只取 {region, roads}。
       原实现对区域包内每个聚落都跑 growTownFootprint 并序列化下发 (且**无 type 过滤**,
       秘境 poi 也被生成一整套祠堂/村口足迹 = B5), 结果被 C# 立刻用 settle 包覆盖、
       被前端直接丢弃 —— 服务端算 + 序列化 + 传输后全部归零 (D15)。
     这里只保留聚落骨架字段 (供 needSettle/needPoi 取实体列表; poi 本就无足迹)。 */
  function settlementJson(st) {
    return { id: st.id, type: st.type, q: st.q, r: st.r,
             x: st.x, y: st.y, name: st.name, pop: st.pop,
             owner: st.owner || '', tier: st.tier || 0,
             state: st.state || 0, expireTs: st.expireTs || 0 };
  }

  /* 区域包道路预算: 服务端权威快照要求「一次算全」本区域全部道路, 与前端渐进修路
     (小 maxNew 预算) 语义不同 —— 这里等于「无上限」。
     ⚠ A5 (P1, 未在本次安全范围内闭环): 该调用在 V8 门闩内同步跑完整区域 A*, 实测首请求
     ~195.8ms, 阻塞同 VM 的其它请求。要真正降低阻塞必须配合「region rev 随道路增量前进 +
     渐进补算」设计 (review.md §5 第 7 条): 单纯调小本预算会让区域包永久少路 —— 因为
     BlockRevs.Region 只在显式 BumpBlockRev 时变化, 不随 roadVer 前进, 客户端不会自动重拉。
     属跨 C#/前端契约改动, 需实测收敛性后再落。 */
  var REGION_ROAD_BUDGET = 9999;        // 语义 = 无上限 (勿单方面改小, 见上)

  function regionJson(i, j) {
    var ri = MG.regionInfo(i, j);
    var sts = MG.settlementsFor(i, j);
    var roads = MG.roadsNear(i, j, REGION_ROAD_BUDGET);   // 服务端权威: 预算充足, 一次算全
    var stArr = [], rdArr = [];
    for (var s = 0; s < sts.length; s++) stArr.push(settlementJson(sts[s]));
    for (var m = 0; m < roads.length; m++) {
      var rd = roads[m], pts = [];
      for (var p = 0; p < rd.pts.length; p++) pts.push(rd.pts[p].x, rd.pts[p].y);
      rdArr.push({ key: rd.key, x0: rd.x0, y0: rd.y0, x1: rd.x1, y1: rd.y1, pts: pts });
    }
    return JSON.stringify({
      i: i, j: j,
      region: { q: ri.q, r: ri.r, x: ri.x, y: ri.y, biome: ri.biome, name: ri.name },
      settlements: stArr, roads: rdArr
    });
  }

  /* ---------- 城镇足迹包: 按区域格持久化 (w:{seed}:settle:{i}:{j}) ----------
     建筑足迹「后续会演化, 必须持久化」(§Phase3)。与 regionJson 的聚落实体分开成包,
     由 C# 侧独立落 SQLite + 独立 rev; 结构演化不影响聚落实体层。 */
  function settleJson(i, j) {
    var sts = MG.settlementsFor(i, j);
    var towns = [];
    for (var s = 0; s < sts.length; s++) {
      var st = sts[s];
      if (st.type === 'poi') continue;              // 秘境无城镇足迹
      var plan = MG.growTownFootprint(st.id, st.type, st.q, st.r);
      var bs = [];
      for (var b = 0; b < plan.buildings.length; b++) {
        var bd = plan.buildings[b];
        bs.push({ q: bd.q, r: bd.r, kind: bd.kind, terrain: bd.terrain, tier: bd.tier });
      }
      var rs = [];
      for (var r = 0; r < plan.resources.length; r++)
        rs.push({ resource: plan.resources[r].resource, amount: plan.resources[r].amount });
      towns.push({ id: st.id, style: plan.style, styleName: plan.styleName,
                   buildings: bs, resources: rs });
    }
    return JSON.stringify({ i: i, j: j, towns: towns });
  }

  /* ---------- 群落包: 群落 + 灵脉 ---------- */
  function commJson(ci, cj) {
    var cm = MG.communityOf(ci, cj);
    if (!cm) return JSON.stringify({ exists: false, ci: ci, cj: cj });
    var vArr = [];
    for (var v = 0; v < cm.veins.length; v++) {
      var vn = cm.veins[v];
      var w = MG.tileToWorld(vn.q, vn.r);
      vArr.push({ name: vn.name, element: vn.element, variant: vn.variant || null,
                  level: vn.level, q: vn.q, r: vn.r, x: w.x, y: w.y });
    }
    return JSON.stringify({ exists: true, ci: ci, cj: cj,
      q: cm.q, r: cm.r, x: cm.x, y: cm.y, element: cm.element, spirit: cm.spirit,
      veins: vArr });
  }

  /* ---------- 单块归属映射 (WebSocket 单块接口, 设计 §6 方案 A) ----------
   * 主块 = 区块格 (ca, cb)。一个块天然覆盖若干区域格与群落格:
   *   region: 区域种子距块中心 ≤ CHUNK_SCAN + REGION_M
   *           (块胞腔最远 11 格 + 区域 Voronoi 胞腔最大延伸 ~REGION_M)
   *   comm:   群落主格距块中心 ≤ COMM_CL (群落晶格 150, 块胞腔 11 远小于它)
   * 服务端 GetTileBlock 据此把 chunk/region/settle/poi/comm 各图层
   * 拼进一个 TileResponse; 坐标映射只在此处权威定义。 */
  function blockLayersJson(ca, cb) {
    var ccq = ca * S, ccr = cb * S;
    var M = MG.REGION_M, CL = MG.CFG.COMM_CL;
    var reach = MG.CHUNK_SCAN + M;
    var i0 = Math.floor((ccq - reach) / M) - 1, i1 = Math.floor((ccq + reach) / M) + 1;
    var j0 = Math.floor((ccr - reach) / M) - 1, j1 = Math.floor((ccr + reach) / M) + 1;
    var regions = [];
    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var ri = MG.regionInfo(i, j);
        if (MG.hexDist(ri.q, ri.r, ccq, ccr) <= reach) regions.push([i, j]);
      }
    }
    /* ⚠ 玩家宗门 (ext) 的归属格可能落在本几何判据**之外** (它的区域中心离块中心 > reach,
       而实体本身就在块里) —— 不补这一笔, 玩家宗门**永远画不出来** (无异常、无日志)。
       ext 数量 = 每账号每世一座, 代价可忽略。 */
    var exr = MG.externalRegionsWithin(ccq, ccr, reach + MG.REGION_M);
    for (var xr = 0; xr < exr.length; xr++) {
      var dup = false;
      for (var rq = 0; rq < regions.length; rq++) {
        if (regions[rq][0] === exr[xr][0] && regions[rq][1] === exr[xr][1]) { dup = true; break; }
      }
      if (!dup) regions.push(exr[xr]);
    }
    var k0 = Math.floor((ccq - CL) / CL) - 1, k1 = Math.floor((ccq + CL) / CL) + 1;
    var l0 = Math.floor((ccr - CL) / CL) - 1, l1 = Math.floor((ccr + CL) / CL) + 1;
    var comms = [];
    for (var ci = k0; ci <= k1; ci++) {
      for (var cj = l0; cj <= l1; cj++) {
        var cm = MG.communityOf(ci, cj);
        if (cm && MG.hexDist(cm.q, cm.r, ccq, ccr) <= CL) comms.push([ci, cj]);
      }
    }
    return JSON.stringify({ ca: ca, cb: cb, regions: regions, comms: comms });
  }

  /* ---------- 单格详情 (信息面板权威数据) ---------- */
  function tileJson(q, r) {
    var f = MG.fields(q, r);
    var rs = MG.regionSeedOf(q, r);
    var ri = MG.regionInfo(rs.i, rs.j);
    var sts = MG.settlementsFor(rs.i, rs.j);
    var st = null;
    for (var s = 0; s < sts.length; s++) {
      if (sts[s].q === q && sts[s].r === r) { st = sts[s]; break; }
    }
    /* 去水距离: 与 main.js waterDist 一致的 4 环扫描 */
    var wd = 0;
    if (f.biome > 1) {
      var found = -1;
      for (var dist = 1; dist <= 4; dist++) {
        var hit = false;
        for (var dq = -dist; dq <= dist && !hit; dq++) {
          for (var dr = -dist; dr <= dist; dr++) {
            if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) !== dist) continue;
            if (MG.elevAt(q + dq, r + dr) < MG.SEA_LEVEL - 0.02) { hit = true; break; }
          }
        }
        if (hit) { found = dist; break; }
      }
      wd = found;
    }
    /* 是否在路上: 3x3 区域格只读已缓存道路 (预算 0 = 纯读 roadCache, 点击绝不触发 A*)。
       道路生成由「区域包流式加载」按区域一次性完成并写入 roadCache 供全局复用;
       未流式到的区域其路也未画到地图上, 此处保守返回 false 与画面一致。 */
    var onRoad = false;
    var ci = Math.floor(q / MG.REGION_M), cj = Math.floor(r / MG.REGION_M);
    outer:
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var roads = MG.roadsNear(ci + di, cj + dj, 0);
        for (var t = 0; t < roads.length; t++) {
          if (roads[t].tiles && roads[t].tiles.has(q + ',' + r)) { onRoad = true; break outer; }
        }
      }
    }
    return JSON.stringify({
      q: q, r: r,
      f: { q: f.q, r: f.r, x: f.x, y: f.y, e: f.e, m: f.m, t: f.t,
           biome: f.biome, disp: f.disp, variant: f.variant, hash: f.hash },
      vein: f.vein ? { element: f.vein.element, variant: f.vein.variant, level: f.vein.level,
                       d: f.vein.d, name: f.vein.name } : null,
      region: { i: rs.i, j: rs.j, q: ri.q, r: ri.r, x: ri.x, y: ri.y, biome: ri.biome, name: ri.name },
      place: st ? { type: st.type, name: st.name, pop: st.pop } : null,
      waterD: wd, onRoad: onRoad
    });
  }

  /* ---------- 字段网格 (小地图/批量采样) ---------- */
  function fieldGridJson(q0, q1, r0, r1) {
    var nq = q1 - q0 + 1, nr = r1 - r0 + 1;
    var u = new Uint8Array(nq * nr), dv = new DataView(u.buffer);
    var idx = 0;
    for (var r = r0; r <= r1; r++) {
      for (var q = q0; q <= q1; q++) {
        var f = MG.fields(q, r);
        var disp = f.disp != null ? f.disp : f.biome;
        dv.setUint8(idx++, disp);
      }
    }
    return JSON.stringify({ q0: q0, r0: r0, nq: nq, nr: nr, d: b64FromBytes(u) });
  }

  /* 世界元信息: 客户端几何/图例常量 (不含任何地形判定) */
  function metaJson() {
    var meta = {
      hexR: MG.HEX_R, hexW: MG.HEX_W, chunkS: MG.CHUNK_S, chunkScan: MG.CHUNK_SCAN,
      regionM: MG.REGION_M, commCl: MG.CFG.COMM_CL, commR: MG.CFG.COMM_R,
      seaLevel: MG.SEA_LEVEL, biomeMeta: MG.BIOME_META,
      /* 五行/异灵根配色: 与 biomeMeta 同理交给客户端 (前端曾各自复制一份字面量,
         必须人工同步 —— 改色板时极易漂移。现由 meta 单点下发) */
      elementRGB: MG.ELEMENT_RGB, variantRGB: MG.VARIANT_RGB,
      /* 领地半径表 (DOMAIN_R) + 最小间距 + 足迹半径: 前端画「领地圈」和做落点预览
         都必须用**服务端这一份**, 不许自己复制字面量 (同 elementRGB 的教训)。
         ⚠ 这张表在 C# 侧**没有**镜像 —— 判定只在引擎里做 (domainCheck), 表也只从这里
           下发。check_domain_radius.mjs 断言「全仓库只有一处 DOMAIN_R 字面量」。 */
      domainR: MG.CFG.DOMAIN_R, settleMinDist: MG.CFG.SETTLE_MIN_DIST, townR: MG.CFG.TOWN_R
    };
    return JSON.stringify(meta);
  }

  /* ============================================================
   * 玩家宗门放置 (2026-09-23 方案 §3.3) —— 服务端编排出口
   * ------------------------------------------------------------
   * 与地图数据出口的区别: 这里是**写操作**, 会改 VM 内的 ext 层与 roadCache。
   * 因此三条硬约束:
   *   ① 一次提交必须在**同一个 V8 门闩调用**里做完 (清缓存 → 重算路 → 版本号 +1),
   *      否则「路已重算但版本号未前进」的中间态会被并发请求看见;
   *   ② roadVer **只能 +1, 绝不归零** (宿主 ObserveRoadVer 单调取大 ⇒ 归零 = 路永远送不出去);
   *   ③ 返回的 blocks = 客户端必须重拉的块 —— 前端对**已加载**的块不会自动重拉
   *      (updateStreaming 的队列条件含 `!chunkData.has(key)`), 所以这份名单是必需的。
   * ============================================================ */

  /* 脏区块集合 (矩形包围盒 + 余量)。
     为什么是「包围盒 + 大余量」而不是精确反查: 一个块请求会带上「与块中心距离
     ≤ CHUNK_SCAN + REGION_M (=33) 的区域格」, 而区域格中心本身可离它的代表格 ~10 格
     ⇒ 区块中心的容差 ≈ 43 格 ≈ 2 个区块间距 (21); 再留 2 环余量 ⇒ PAD = 4。
     ⚠ 宁可多标 (多标只是让客户端多拉一次内容相同的块), 绝不漏标 (漏标 = 画面永久陈旧)。 */
  var DIRTY_BLOCK_PAD = 4;
  function dirtyBlocksFor(tiles) {
    var minCa = 1e18, maxCa = -1e18, minCb = 1e18, maxCb = -1e18;
    for (var n = 0; n < tiles.length; n++) {
      var cc = MG.chunkOfTile(tiles[n][0], tiles[n][1]);
      if (cc.ca < minCa) minCa = cc.ca;
      if (cc.ca > maxCa) maxCa = cc.ca;
      if (cc.cb < minCb) minCb = cc.cb;
      if (cc.cb > maxCb) maxCb = cc.cb;
    }
    if (minCa > maxCa) return [];
    var out = [];
    for (var ca = minCa - DIRTY_BLOCK_PAD; ca <= maxCa + DIRTY_BLOCK_PAD; ca++)
      for (var cb = minCb - DIRTY_BLOCK_PAD; cb <= maxCb + DIRTY_BLOCK_PAD; cb++)
        out.push([ca, cb]);
    return out;
  }

  var REGION_ROAD_BUDGET0 = REGION_ROAD_BUDGET;

  /* 落点校验 (悬停即问): 一次调用把 §2.3 判据链 5~7 全部算完, 免得前端每 150ms
     灌一串 V8 往返。⚠ 判据 1/2/3/9 (seed 新鲜度 / 登录 / 配额 / 名字) 是**服务端
     自身状态**, 不在这里 —— 服务端拿到本结果后再叠上去 (见 MapWorldService.PlaceCheck)。 */
  function placeCheckJson(q, r, excludeId) {
    q = q | 0; r = r | 0;
    var f = MG.fields(q, r);
    var vn = MG.veinNear(q, r);
    var veinD = vn ? vn.d : 99;
    var rs = MG.regionSeedOf(q, r);
    var dom = MG.domainCheck(q, r, excludeId || '');
    var deep = f.biome === MG.BIOME.DEEP;
    var onVein = !!f.vein;
    var veinNearEnough = veinD >= (MG.CFG.SETTLE_VEIN_FOOT_PAD | 0);
    var spirit = MG.spiritAt(q, r);
    var spOk = spirit >= MG.CFG.SEA_SETTLE_MIN_SPIRIT;
    var reason = '';
    if (deep) reason = 'deep_water';
    else if (onVein) reason = 'on_vein';
    else if (!veinNearEnough) reason = 'on_vein';
    else if (!dom.ok) reason = 'too_close';
    else if (!spOk) reason = 'spirit_too_low';
    return JSON.stringify({
      ok: 1, q: q, r: r,
      can: reason === '',
      reason: reason,
      deep: deep, onVein: onVein, veinD: veinD,
      spirit: spirit, spiritMin: MG.CFG.SEA_SETTLE_MIN_SPIRIT,
      biome: f.biome, elev: f.e,
      regionI: rs.i, regionJ: rs.j,
      blocker: dom.blocker,
      /* 前端画「领地圈」用: 附近聚落的中心 + 领地半径 (含它们自己也是候选障碍) */
      near: nearbyDomains(q, r),
      /* 自己已有的宗门 (用于「原地重建」时豁免) */
      excludeId: excludeId || ''
    });
  }

  /* 附近聚落的 {q,r,tier,type,need,dist} —— 供前端画圈与落点预览。
     范围 = 12 格 (最大 DOMAIN_R = 8, 留 4 格余量给"圈画得出来")。 */
  function nearbyDomains(q, r) {
    var M = MG.REGION_M;
    var ci = Math.floor(q / M), cj = Math.floor(r / M);
    var out = [], seen = {};
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var arr = MG.settlementsFor(ci + di, cj + dj);
        for (var n = 0; n < arr.length; n++) {
          var st = arr[n];
          if (seen[st.id]) continue;
          seen[st.id] = 1;
          var d = MG.hexDist(q, r, st.q, st.r);
          if (d > 12) continue;
          var need = MG.domainRadiusOf(st);
          if (need <= 0) continue;
          out.push({ id: st.id, type: st.type, tier: st.tier | 0, q: st.q, r: st.r,
                     dist: d, need: need, name: st.name || '' });
        }
      }
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  /* 提交落点 —— 方案 §3.3 的七步同步序列 (在 V8 门闩内一次做完)。 */
  function commitPlace(q, r, optsJson) {
    var t0 = Date.now();
    var opts = {};
    if (optsJson) {
      try { opts = typeof optsJson === 'string' ? JSON.parse(optsJson) : optsJson; }
      catch (e) { opts = {}; }
    }
    /* 步 1: 引擎侧放置 (id 由引擎按 {区域i}_{区域j}_u{n} 生成) */
    var st = MG.placeSettlement(q, r, opts);
    var rs = MG.regionSeedOf(st.q, st.r);
    /* 步 2: 清派生状态 (需求边 / 骨架 / 道路 / roadFail / 足迹) —— 五个坑的正面处理 */
    var clr = MG.clearRoadSideFor(rs.i, rs.j, 0, [st.id]);
    /* 步 3: 同步重算受影响区域的**全部**道路 (预算 = 无上限, 与区域包同口径)。
       实测 25 个区域格 ≈ 400~450ms (热地形) —— 这就是用户要的「放下去时附近直接重算」。 */
    var tiles = [[st.q, st.r]];
    for (var n = 0; n < clr.regions.length; n++) {
      var ri = MG.regionInfo(clr.regions[n][0], clr.regions[n][1]);
      tiles.push([ri.q, ri.r]);
    }
    for (var n2 = 0; n2 < clr.regions.length; n2++)
      MG.roadsNear(clr.regions[n2][0], clr.regions[n2][1], REGION_ROAD_BUDGET0);
    /* 步 4: 统计本次真正挂在玩家宗门上的道路 (新路) */
    function onSt(k) { var ids = k.split('|'); return ids[0] === st.id || ids[1] === st.id; }
    var nRoad = 0;
    MG.roadCache.forEach(function (_v, k) { if (onSt(k)) nRoad++; });
    /* 步 5: 道路版本号 +1 (必须在道路重算**之后** —— 先建后报) */
    var ver = MG.bumpRoadVer();
    /* 步 6: 脏区块 (客户端必须重拉的那些块) */
    var blocks = dirtyBlocksFor(tiles);
    return JSON.stringify({
      ok: 1, ms: Date.now() - t0,
      st: settlementJson(st),
      regionI: rs.i, regionJ: rs.j,
      roadVer: ver,
      regions: clr.regions,
      cross: clr.cross,
      blocks: blocks,
      nRoad: nRoad,
      cleared: clr.n
    });
  }

  global.MapGenServer = {
    init: function (seed) { MG.init(String(seed)); return JSON.stringify({ ok: 1 }); },
    chunkJson: chunkJson,
    regionJson: regionJson,
    settleJson: settleJson,
    commJson: commJson,
    blockLayersJson: blockLayersJson,
    tileJson: tileJson,
    fieldGridJson: fieldGridJson,
    metaJson: metaJson,
    /* 道路版本号: tile 缓存新鲜度校验用 (roadCache 新增道路即 +1) */
    roadVersion: function () { return MG.roadVersion(); },
    /* ---- 玩家宗门放置 (2026-09-23 方案 §2.4/§3.3) ----
       ⚠ 每一个新出口都必须在 JsEngineHost.Call 的 switch 白名单里加 case ——
       漏了就是 `InvalidOperationException: 未知 JS 函数` (运行时才炸, 编译期不报)。 */
    placeCheckJson: placeCheckJson,
    commitPlace: commitPlace,
    setExternalSettlements: function (json) {
      var list = [];
      if (json) { try { list = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { list = []; } }
      var r = MG.setExternalSettlements(list);
      return JSON.stringify(r);
    },
    externalSettlementsJson: function () {
      return JSON.stringify({ list: MG.externalSettlements() });
    },
    removeExternalSettlement: function (id) {
      return JSON.stringify({ ok: MG.removeExternalSettlement(String(id)) ? 1 : 0 });
    },
    domainCheckJson: function (q, r, excludeId) {
      return JSON.stringify(MG.domainCheck(q | 0, r | 0, excludeId || ''));
    },
    domainRadius: function (type, tier) {
      return MG.domainRadiusOf({ type: String(type), tier: tier | 0 });
    },
    archetypeOf: function (type, tier) {
      return MG.archetypeOf({ type: String(type), tier: tier | 0 });
    },
    /* 道路版本号强制前进 (拆除/外部改动后手工推进时用) */
    bumpRoadVer: function () { return MG.bumpRoadVer(); },
    /* 统计/自检钩子 */
    _countVeins: function () { return JSON.stringify({ n: MG.countVeins() }); }
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
