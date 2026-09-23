#!/usr/bin/env node
/*
 * 宗门模拟器 · 全量回归 runner  (交接单 U6 固化项, 2026-09-15)
 *
 * 用途: 把散在 verify/ 下的判据脚本按固定顺序跑一遍, 汇总「红 N / 共 M」, 避免每次手拼命令行。
 *
 * 用法:
 *   node verify/run_regression.mjs                     # 24 条离线 + 5 条需活服务端(对 127.0.0.1:8140)
 *   node verify/run_regression.mjs --base=192.168.63.62:8140
 *   node verify/run_regression.mjs --offline-only      # 只跑不需要活服务端的 24 条
 *   node verify/run_regression.mjs --live-only         # 只跑需要活服务端的 (离线组要 8 分钟, 别白等)
 *   node verify/run_regression.mjs --with-server       # 追加 verify_map/w1/w2/w4(建议对着隔离 8141 跑)
 *   node verify/run_regression.mjs --with-place        # 追加 w5_place_rev(⚠ 它会**写入**: 真落一座宗门)
 *   node verify/run_regression.mjs --only=vein         # 只跑文件名含 "vein" 的
 *   node verify/run_regression.mjs --skip=w3,w5        # 跳过含这些片段的
 *   node verify/run_regression.mjs --list              # 只列出会跑哪些
 *
 * 约定 (与 .workbuddy/memory/MEMORY.md 一致, 别踩):
 *   1. **别 kill 用户 8140 实例**。服务端判据一律只读; 要跑 `--with-server` 请先另起隔离实例:
 *        set Zongmen__Port=8141 & set Zongmen__DbPath=db/zongmen.verify.sqlite & dotnet run
 *      然后 `node verify/run_regression.mjs --base=127.0.0.1:8141 --with-server`。
 *      ⚠ **例外: check_world_ledger 会真实开一世** (POST /api/world/next 落库) —— 它只该对着
 *        隔离实例跑; 对着用户的 8140 跑一次就会把人家正在看的世界换掉。
 *   2. **HTTP 判据必须绕代理**: 本机 `HTTP_PROXY=http://127.0.0.1:9105` 会让内网请求 502。
 *      本 runner 统一清掉 *_PROXY 并置 NO_PROXY=* , 各脚本不必自己处理。
 *   3. `w3_bfs_road` 的 ⑦ 两条**墙钟**阈值是**机器绝对速度门槛**(默认 400/500ms), 慢机/拥塞时必红。
 *      本 runner 会把这**两条**失败单独降级为「墙钟(非回归)」warn, 不计入红; 若失败的是别的断言,
 *      仍算真红。想要更松/更严: `--w3-ms=600`。
 *   4. `check_cloud_zoom.mjs` 需要实机截图参数, 裸跑 rc=2 属正常 ⇒ 不在默认清单内(要跑请单独调)。
 *      同理 `check_mm_layout.mjs` 与 `check_mm_ui.mjs` 无 Chrome / 服务端不通时 rc=2 (跳过, 不算红)。
 *      **rc=2 一律记作 skip**(单列在汇总里, 不让跳过静默发生); 其余非 0 才算红。
 *   5. 退出码: 有真红 ⇒ 1, 否则 0 (warn/skip 不影响退出码)。
 *   6. ⚠ **`check_world_ledger.mjs` 与 `w5_place_rev.mjs` 都会改服务端状态**:
 *      前者真实开一世 (POST /api/world/next), 后者真实落一座宗门 (写 PlayerSect + placeVer)。
 *      两者都只该对着**隔离实例 + 全新 DB** 跑 —— 别对着用户正在看的 8140。
 *      且 w5 的前置是「本世还没有玩家宗门」(它自己会查, 不满足即 rc=2 跳过)。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..') + path.sep;
const NODE = process.execPath;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
function opt(k, dflt) {
  const p = '--' + k + '=';
  const hit = argv.find((s) => s.startsWith(p));
  return hit === undefined ? dflt : hit.slice(p.length);
}

const BASE = opt('base', '127.0.0.1:8140');
const BASE_URL = /^https?:/.test(BASE) ? BASE : 'http://' + BASE;
const ONLY = opt('only', '');
const SKIP = opt('skip', '');
const W3_MS = opt('w3-ms', '');
const OFFLINE_ONLY = has('offline-only') || has('no-server');
const WITH_SERVER = has('with-server') && !OFFLINE_ONLY;
const WITH_PLACE = has('with-place') && !OFFLINE_ONLY;
const LIVE_ONLY = has('live-only');
const LIST_ONLY = has('list');

/* [文件, 额外参数, 组别, 备注]
 *   组别: 'off' = 纯离线(无网络) | 'live' = 需要一个活服务端(只读探活)
 *   ⚠ frontend_smoke 既跑源码守卫也问服务端要 meta/tile ⇒ 归 live。 */
const JOBS = [
  ['check_vein_skin.mjs', [], 'off'],
  /* 全局存储组件 ZMStore (web/js/store.js) —— 真跑源码 (假 window + localStorage 桩):
     默认值/白名单/幂等/订阅/坏 JSON/无 localStorage 降级/节流/通用分区 + 弹窗与 schema 键集合对齐. */
  ['check_settings_store.mjs', [], 'off'],
  /* 匾额/名牌落点对齐 (C-a 聚落落点扎真建筑格 / C-c 灵脉签位=峰尖 / D 文案) ——
     纯离线: 裸 eval vein-skin.js + bldg_ink.js, 再对三份前端文件做"禁第二真源"源码守卫。 */
  ['check_plaque_align.mjs', [], 'off'],
  /* 渔村皮肤 (A): 裸 eval bldg_ink.js (+ stub canvas 真跑 spriteOf) —— 钉死水陆分叉、
     表外 kind 不越权、缓存不串图 (不加缓存皮肤位就会串图, 本契约的主断言)。 */
  ['check_fish_skin.mjs', [], 'off'],
  /* 归属势力底图 (B): 抠 main.js 里 factionOf/factionColor/factionSig/townColor 等
     9 段**真源码** eval (注入可控 settleCells) + stub canvas 真跑 plateAt 记路径操作 ——
     钉死 ①辖区半径镜像引擎 CFG.COMM_R×1.4 ②同宗同色 (?fac=0 的 A/B 铁证)
     ③记号同源 (8 型印纹互异/刻痕长度角度)。 */
  ['check_faction.mjs', [], 'off'],
  ['check_vein_cluster.mjs', [], 'off'],
  ['check_no_build_on_vein.mjs', [], 'off'],
  ['check_settle_spacing.mjs', [], 'off'],
  /* 玩家落点校验的「邻域覆盖范围」契约 (2026-09-21, 玩家放置宗门方案 §2.7):
     REGION_M=18 + 锚点抖动 6.3 + 选址再选 PROSPECT_R=4 ⇒ 单侧最大偏移 10.3 格
     ⇒ 第 1 环最近可能只有 7.7 格 (< DOMAIN_R_MAX=8) ⇒ **必须扫 2 环 (25 格)**。
     本判据把该推导钉死, 并做真实世界抽样 + 空真防护 (hitsInDomain=0 判 FAIL)。 */
  ['check_place_neighborhood.mjs', [], 'off'],
  /* 领地半径 DOMAIN_R 真源 + 语义契约 (2026-09-23, 玩家放置宗门方案 §2.6/§3.1, A~G 七段):
     · A 真源表逐键对拍 (city:8/town:6/sect3:8/sect2:7/sect1:6/village:4/fishing:4/poi:0);
     · B 逐档取值 = archetypeOf → domainRadiusOf; · C **边界语义 `dist < need` 才拒** (dist===need 放行);
     · D **2 环窗口含对角** (扫 2 环必须在 (2,2)/(2,0)/(1,2) 都命中 —— 1 环会漏);
     · E **单向语义** (拿新落点量既有聚落, 反向不成立) + 独立复算对拍 (不复用被测函数);
     · F excludeId 只豁免自己那一座 (同 id 两座会一起被豁免, 那是对的);
     · G 前端镜像表 domainRof 与引擎逐值一致。
     ⚠ 全部用**受控 ext** 构造 (cleanSpot 先找干净落点), 不依赖自动世界的偶然分布。 */
  ['check_domain_radius.mjs', [], 'off'],
  /* 玩家落定提交出口的离线端到端契约 (2026-09-23, A~D 四段) —— **直调 MapGenServer.commitPlace**
     (mapgen-server.js 是纯搬运层, 无宿主依赖 ⇒ 离线可跑, 不需要服务端/WS):
     · A 落库形态: id 为 `{区域i}_{区域j}_u{n}` (**前缀不能是 p_, 否则 id.split('_') 得 NaN ⇒ 静默扫空池**),
       返回 regions=25 / cross=24 / roadVer 严格前进且**非陈旧快照** (须 == MG.roadVersion());
     · B 脏块覆盖: blocks(实测 156) 必须**覆盖实际发生变化的地图格** —— 少一块前端就不会重拉;
     · C resetRoads/configure 走 bumpRoadVer **只 +1 增量** (红线 4: 归零撞 ObserveRoadVer 单调取大);
     · D 增删对称: 放一个再删掉 ⇒ 自动层指纹回到原样。
     实测读数: ms=188 nRoad=3 blocks=156 regions=25 cross=24。 */
  ['check_place_rules.mjs', [], 'off'],
  /* ext 叠加层「不污染自动层」契约 (2026-09-23, A~D 四段):
     · A 零拷贝: settlementsFor 返回的数组**不得**是 settleCache 里那份 (append 会原地改缓存);
     · B 指纹: 加 ext 前后 rawSettlementsFor/settleCache **逐格逐字节不变** (自动世界一个像素都不许动);
     · C 增删对称: setExternalSettlements([]) 后与从未加过完全等价;
     · D 两套间距规则并存: 自动层用 settleMinDist, 玩家层用 DOMAIN_R, **互不覆盖**。 */
  ['check_place_no_pollute.mjs', [], 'off'],
  /* 玩家落定的「同步重算代价 + 机制正确性」契约 (2026-09-23, 玩家放置宗门方案 §3.5/§3.6):
     · 机制 (推翻 v2 的错误结论): 新宗门会**挤掉既有需求边** (rngDominated 三方判定) +
       翻转骨架集 (Kruskal) ⇒ 「旧边一条都不用重算」是错的, 用户要求是对的;
     · 代价分账: 道路 405~443ms (贵) vs 城市 31ms (纯城市 ~23ms) ⇒ **两笔账别记成一笔**;
     · 红线: roadVer 只能 +1 增量, 归零会撞 ObserveRoadVer 单调取大 ⇒ 路永远送不出去;
     · 反空真: 「不清 demandCache/skeletonCache 就注入」必须**得到与基线相同的几何**
       (即证明"注入真的会静默失效"), 命中数 0 说明样本无鉴别力。
     ⚠ 段 2/3 会跑 A* (~20s), 故样本数参数化 (默认 1 落点 / 3 轮), 深查可放大。 */
  ['check_place_road_recompute.mjs', ['seed-check', '5', '1', '3'], 'off'],
  ['check_sea_village.mjs', [], 'off'],
  ['check_vein_settle_gap.mjs', [], 'off'],
  ['check_preview_vein_marker.mjs', [], 'off'],
  ['check_preview_draw.mjs', [], 'off'],
  ['check_preview_settle_road.mjs', [], 'off'],
  ['check_preview_terrain.mjs', [], 'off'],
  ['check_edge_falloff.mjs', [], 'off'],
  ['sync_preview_inline.mjs', ['--check'], 'off'],
  ['w3_bfs_road.mjs', W3_MS ? [String(W3_MS)] : [], 'off', '墙钟 ⑦ 慢机红 ⇒ 降级 warn'],
  ['w5_sprite_range.mjs', [], 'off'],
  ['w6_bldg_face.mjs', [], 'off'],
  /* 世界种子台账 (W · 2026-09-16): 服务端产种子 + 落 SQLite。
     ⚠ 它**会真实开一世** (POST /api/world/next) —— 只对隔离实例跑, 别对着用户的 8140。
     放在 live 组最前: 后面那几个开浏览器/多 seed 的判据都要靠"领到种子"才能起页面。 */
  ['check_world_ledger.mjs', [BASE_URL], 'live'],
  ['frontend_smoke.mjs', [BASE_URL], 'live'],
  /* 小地图面板响应式几何 (窄屏铺满窗体宽度): 起 headless Chrome 量 iframe 布局盒。
     无 Chrome 或服务端不通时自己 rc=2 跳过 —— 见脚本头部注释。 */
  ['check_mm_layout.mjs', [BASE_URL], 'live'],
  /* 手机版: 触摸交互 (拖动/捏合/单击 + 合成鼠标事件闸) 与强制浅色 (color-scheme: only light)。
     同样要 Chrome + 同源 iframe, 缺一 rc=2 跳过。 */
  ['check_mm_ui.mjs', [BASE_URL], 'live'],
  /* 地形块前端自算 (S1~S5): 真浏览器 3 档 —— hybrid(实际 mask=30 **且服务端不再下发整块地形**)
     / ab(本地数组 ≡ 服务端块的逐位对拍) / server(老链路回退)。每档起一次独立 Chrome
     (⚠ 同一 Chrome 里串行跑多档会被 --virtual-time-budget 串扰: 第二档恒定 0 块)。
     无 Chrome 或服务端不通 rc=2 跳过。
     ⚠ 需对**含 S4 的服务端**跑 (meta 必须带 engineHash): 对着未重启的旧实例会红 1 条
       「服务端未重启到含 S4 的构建」—— 那是提示, 不是回归。
     ⚠⚠ **本机 headless 虚拟时间下 hybrid/ab 档会假红** (`local=false / 块=0 / engine seed=null`,
       因为它要等 WS 的 Script 帧 (type=4) 而虚拟时钟不等真实网络):
       2026-09-23 已用 **HEAD 原始前端** A/B 证实 —— 未含任何改动同样红 (server 档恒绿)。
       服务端那条链另经 Node 直连验过: 帧 4 在 10~40ms 内到货 (60913B gzip → 140932B), 3/3 稳定。
       ⇒ 看到 hybrid/ab 红而 server 绿时, 先怀疑本机 Chrome, 别急着改代码。 */
  ['check_calc_local.mjs', [BASE_URL], 'live'],
];
const SERVER_JOBS = [
  ['verify_map.mjs', [BASE_URL], 'live'],
  ['w1_client_revs.mjs', [BASE_URL], 'live'],
  ['w2_concurrency.mjs', [BASE_URL], 'live'],
  ['w4_revs_at_scale.mjs', [BASE_URL], 'live'],
];
/* ⚠ **会写入**服务端的判据, 只在显式 `--with-place` 时才跑 (默认不碰用户的世界)。
   放在最后: 它把本世「弄脏」(落一座宗门) ⇒ 别的依赖干净世界的判据必须排在它前面。 */
const PLACE_JOBS = [
  ['w5_place_rev.mjs', [BASE_URL], 'live', '⚠ 会写入: 真落一座宗门 (只对隔离实例跑)'],
];

const want = (f) => (!ONLY || f.includes(ONLY)) && !(SKIP && SKIP.split(',').some((s) => s && f.includes(s)));

const plan = JOBS
  .concat(WITH_SERVER ? SERVER_JOBS : [])
  .concat(WITH_PLACE ? PLACE_JOBS : [])
  .map(([f, args, grp, note]) => ({ f, args, grp, note }))
  .filter((j) => want(j.f) && !(OFFLINE_ONLY && j.grp === 'live') && !(LIVE_ONLY && j.grp === 'off'));

if (LIST_ONLY) {
  console.log('基址 = ' + BASE_URL + (OFFLINE_ONLY ? '  (offline-only)' : '') + (LIVE_ONLY ? '  (live-only)' : '') + (WITH_SERVER ? '  (with-server)' : '') + (WITH_PLACE ? '  (with-place)' : ''));
  for (const j of plan) console.log('  [' + j.grp + '] ' + j.f + (j.args.length ? ' ' + j.args.join(' ') : ''));
  console.log('共 ' + plan.length + ' 条');
  process.exit(0);
}

/* 干净的子进程环境: 去掉代理, 否则内网请求会被 HTTP_PROXY 劫持 */
const ENV = { ...process.env };
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete ENV[k];
ENV.NO_PROXY = '*';
ENV.no_proxy = '*';

const WALL_RE = /⑦/;               // w3 墙钟两条都带 ⑦
const FAIL_RE = /^\s*FAIL\s/;

let red = 0, warn = 0, pass = 0, miss = 0, skip = 0;
const reds = [], warns = [], skips = [];
const t0all = Date.now();

console.log('== run_regression: ' + plan.length + ' 条 @ ' + BASE_URL + ' ==\n');

for (const j of plan) {
  const fp = ROOT + 'verify/' + j.f;
  if (!fs.existsSync(fp)) { miss++; console.log('[MISS] ' + j.f + '  <== 文件不存在'); continue; }

  const t0 = Date.now();
  const r = spawnSync(NODE, [fp, ...j.args], { cwd: ROOT, encoding: 'utf8', env: ENV, timeout: 900000 });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split(/\r?\n/).filter((l) => l.trim());

  const nP = lines.filter((l) => /^\s*PASS\s/.test(l)).length;
  const nF = lines.filter((l) => FAIL_RE.test(l)).length;
  const failLines = lines.filter((l) => FAIL_RE.test(l));
  const rc = r.status === null ? 'null(超时/被杀)' : r.status;

  /* w3 的墙钟两条降级: 只有当**全部**失败行都是 ⑦ 且带 ms 才降级 */
  /* rc=2 = 「**跳过**」, 是本工程判据的既有约定 (见本文件头部第 4 条):
     check_mm_layout / check_mm_ui / check_calc_local (无 Chrome 或服务端不通)
     与 w5_place_rev (隔离实例的世界已被放置过 ⇒ 参照实现失真) 都靠它。
     ⚠ 早先的实现只认 rc!==0 ⇒「跳过」被算成**真红**, 与文档自相矛盾。
     现在单列 skip 一并列出 —— 不让任何跳过**静默**发生。 */
  let kind = 'ok';
  if (r.status === 2) kind = 'skip';
  else if (r.status !== 0) {
    const allWall = failLines.length > 0 && failLines.every((l) => WALL_RE.test(l) && /\d(\.\d+)?\s*ms/.test(l));
    kind = allWall ? 'warn' : 'red';
  }
  if (kind === 'red') { red++; reds.push(j.f); }
  else if (kind === 'warn') { warn++; warns.push(j.f); }
  else if (kind === 'skip') { skip++; skips.push(j.f); }
  else pass++;

  const tag = kind === 'red' ? '红  ' : kind === 'warn' ? 'WARN' : kind === 'skip' ? 'SKIP' : 'rc=0';
  const counts = (nP || nF) ? '  [' + nP + ' PASS' + (nF ? ' / ' + nF + ' FAIL' : '') + ']' : '';
  console.log('[' + tag + '] ' + j.f + counts + '  ' + dt + 's' + (j.note ? '   (' + j.note + ')' : ''));
  if (kind === 'red') {
    for (const l of failLines.slice(0, 6)) console.log('        ' + l.trim().slice(0, 170));
  } else if (kind === 'warn') {
    for (const l of failLines.slice(0, 3)) console.log('        ' + l.trim().slice(0, 170));
  } else if (kind === 'skip') {
    for (const l of lines.filter((l) => /skip/i.test(l)).slice(0, 2)) console.log('        ' + l.trim().slice(0, 170));
  }
  /* 输出里没有 PASS/FAIL 的脚本(rc!=0 且无线索) ⇒ 回显尾部几行, 否则看不到原因 */
  if (kind === 'red' && !failLines.length) {
    for (const l of lines.slice(-4)) console.log('        ' + l.trim().slice(0, 170));
  }
}

const dtAll = ((Date.now() - t0all) / 1000).toFixed(1);
console.log('\n========== 红 ' + red + ' / 共 ' + plan.length +
  '   (绿 ' + pass + ', warn ' + warn + ', skip ' + skip + ', miss ' + miss + ', 耗时 ' + dtAll + 's) ==========');
if (warns.length) console.log('  ⚠ warn(墙钟非回归): ' + warns.join(', ') + '  —— 机器绝对速度门槛, 不是回归');
if (skips.length) console.log('  ⊘ skip(rc=2, 前置条件不满足): ' + skips.join(', ') + '  —— 不是回归, 但请看清原因');
if (reds.length) console.log('  ✘ 真红: ' + reds.join(', '));
process.exit(red ? 1 : 0);
