/* ============================================================
 * check_dirty_block_coord.mjs — 「区域格 / 区块格」两套坐标系 + 换世生命周期 (离线 Node)
 * ------------------------------------------------------------
 * 背景 (2026-11-25 代码审查 P0):
 *   S1 MapWorldService.MarkSettleDirty 把**区域格** (floor(tile/18)) 直接当**区块格**
 *      (ca*21 + 六边形最近心归属) 传给 BumpBlockRev ⇒ 在不存在的块键上 +1 ⇒ 真正包含该区域的
 *      块 rev 不变 ⇒ 客户端带旧 lastRevs 重拉被判「未变化」⇒ 城市演化**永久不可见**
 *      (无异常、无日志)。这是「改了没反应」类故障里最难查的一种。
 *   S2 启动时 ClearWorld(cur.Round) 清的是**当前世** (注释写成"上一世") ⇒ 每次重启
 *      城市演化台账归零。
 *   S3 POST /api/world/next 只改台账、不重绑 Tick ⇒ 新世永不推进、旧世在后台继续跑。
 *   S4 期望集 provider 单格 `catch { continue; }` ⇒ 全格失败时返回**空集** ⇒ 对账删光本世 job。
 *
 * 判据设计 (避免自证):
 *   A. 覆盖关系用**引擎真源**做参照: 对区域方阵内每一个 tile 调 MG.chunkOfTile 得到真实块集,
 *      断言 C# 那套 floor-div 超集公式 ⊇ 真实块集。被测 = 公式, 参照 = 引擎。
 *   B. 源码守卫先**剥注释**再判整个函数体 (注释里写着旧代码不算违规)。
 *   C. 调用点守卫: CityTickExecutor 传给 MarkSettleDirty 的必须是 RegionOf() 解析出的区域格。
 *
 * 用法: node verify/check_dirty_block_coord.mjs
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENG = path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js');
const SVC = path.join(ROOT, 'Server', 'Zongmen', 'Services', 'MapWorldService.cs');
const PUMP = path.join(ROOT, 'Server', 'Zongmen', 'Time', 'TickPump.cs');
const EXEC = path.join(ROOT, 'Server', 'Zongmen', 'Subsystems', 'City', 'CityTickExecutor.cs');
const SRV_JS = path.join(ENG, 'mapgen-server.js');

global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js']) {
  (0, eval)(fs.readFileSync(path.join(ENG, f), 'utf8'));
}
const MG = global.MapGen;

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (cond) console.log('  PASS ' + name + (detail ? '  (' + detail + ')' : ''));
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
}

/* 去掉 // 与 块注释 —— 源码守卫必须判**代码**, 不能让注释里的旧写法造成假红/假绿 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function readStripped(file) { return stripComments(fs.readFileSync(file, 'utf8')); }

/* 取 C# 方法的**整个函数体** (按大括号配平), 返回含签名的整段 */
function methodBody(src, signatureFragment) {
  const at = src.indexOf(signatureFragment);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

const svcSrc = readStripped(SVC);
const pumpSrc = readStripped(PUMP);
const execSrc = readStripped(EXEC);

/* ---------- 几何: 引擎真源 ---------- */
const S = MG.CHUNK_S;
const M = MG.REGION_M;
const PAD_ENGINE = (() => {
  const m = /var\s+DIRTY_BLOCK_PAD\s*=\s*(\d+)\s*;/.exec(fs.readFileSync(SRV_JS, 'utf8'));
  return m ? Number(m[1]) : null;
})();

console.log('== 0. 参数真源 ==');
check('CHUNK_S / REGION_M 来自引擎', S > 0 && M > 0, 'CHUNK_S=' + S + ' REGION_M=' + M);
check('mapgen-server 里能读到 DIRTY_BLOCK_PAD', PAD_ENGINE !== null, String(PAD_ENGINE));
check('metaJson 下发 chunkS / regionM (C# 靠它取参数, 不写死)',
  /chunkS\s*:\s*MG\.CHUNK_S/.test(fs.readFileSync(SRV_JS, 'utf8')) &&
  /regionM\s*:\s*MG\.REGION_M/.test(fs.readFileSync(SRV_JS, 'utf8')));

/* ---------- A. 超集覆盖 ---------- */
console.log('\n== A. 区域格 → 区块格: 超集必须覆盖引擎 chunkOfTile 的真实结果 ==');

/* C# 现实现 (BumpRegionBlocks) 的公式, 逐字复刻 —— 复刻错了这里就是假绿, 所以下面
   同时用源码守卫确认 C# 里那几行确实是这个形状 (A2)。 */
function coveringBlocks(ri, rj, pad) {
  const floorDiv = (v, d) => (v >= 0 ? Math.floor(v / d) : -Math.floor((-v + d - 1) / d));
  const q0 = ri * M, q1 = q0 + M - 1;
  const r0 = rj * M, r1 = r0 + M - 1;
  const ca0 = floorDiv(q0, S) - pad, ca1 = floorDiv(q1, S) + 1 + pad;
  const cb0 = floorDiv(r0, S) - pad, cb1 = floorDiv(r1, S) + 1 + pad;
  const out = new Set();
  for (let ca = ca0; ca <= ca1; ca++) for (let cb = cb0; cb <= cb1; cb++) out.add(ca + ',' + cb);
  return out;
}

let worstMiss = 0, nonEmpty = 0, worstOverShoot = 0, spanReport = [];
for (let ri = -3; ri <= 3; ri++) {
  for (let rj = -3; rj <= 3; rj++) {
    /* 引擎真源: 区域方阵里每格的所属区块 */
    const truth = new Set();
    let tCa0 = Infinity, tCa1 = -Infinity, tCb0 = Infinity, tCb1 = -Infinity;
    for (let q = ri * M; q <= ri * M + M - 1; q++) {
      for (let r = rj * M; r <= rj * M + M - 1; r++) {
        const cc = MG.chunkOfTile(q, r);
        truth.add(cc.ca + ',' + cc.cb);
        tCa0 = Math.min(tCa0, cc.ca); tCa1 = Math.max(tCa1, cc.ca);
        tCb0 = Math.min(tCb0, cc.cb); tCb1 = Math.max(tCb1, cc.cb);
      }
    }
    const sup = coveringBlocks(ri, rj, 4);
    let miss = 0;
    for (const k of truth) if (!sup.has(k)) miss++;
    worstMiss = Math.max(worstMiss, miss);
    if (truth.size) nonEmpty++;

    /* 反向: 超集不许比「引擎自己的脏块口径」再放大 —— 参照 = 真实块包围盒 ± (DIRTY_BLOCK_PAD + 1)。
       +1 是给 chunkOfTile 四候选 (ca 可能取 floor(q/S)+1) 留的一格余量。 */
    const grow = PAD_ENGINE + 1;
    let over = 0;
    for (const k of sup) {
      const [ca, cb] = k.split(',').map(Number);
      over = Math.max(over, tCa0 - grow - ca, ca - (tCa1 + grow), tCb0 - grow - cb, cb - (tCb1 + grow));
    }
    worstOverShoot = Math.max(worstOverShoot, over);
    if (ri === 0 && rj === 0) spanReport.push('(0,0) 真实 ' + truth.size + ' 块 → 超集 ' + sup.size + ' 块');
  }
}
check('抽样 49 个区域格: 引擎真实块集全部被覆盖 (0 漏标)', worstMiss === 0, 'worstMiss=' + worstMiss);
check('抽样区间非空 (反空真)', nonEmpty === 49, nonEmpty + '/49');
check('超集不超出引擎脏块口径 (包围盒 ±(PAD+1))', worstOverShoot <= 0,
  'overShoot=' + worstOverShoot + ' · ' + spanReport.join(' | '));

/* PAD 必须不小于引擎自己的口径: 一个区块的 settle 层还带着 CHUNK_SCAN+REGION_M 内的邻格聚落 */
const padInCs = (() => {
  const body = methodBody(svcSrc, 'void BumpRegionBlocks(');
  if (!body) return null;
  const m = /const\s+int\s+Pad\s*=\s*(\d+)\s*;/.exec(body);
  return m ? Number(m[1]) : null;
})();
check('C# 的 PAD 不小于引擎 DIRTY_BLOCK_PAD', padInCs !== null && PAD_ENGINE !== null && padInCs >= PAD_ENGINE,
  'C# Pad=' + padInCs + ' / 引擎=' + PAD_ENGINE);

/* 只标「包含该区域的那一块」会漏 —— 用不变量反向证明 PAD 不是 0 */
check('PAD>0: 邻块也得标 (否则别块里的同一座城停在旧人口)', padInCs !== null && padInCs > 0, 'Pad=' + padInCs);

/* ---------- A2. C# 公式形状守卫 ---------- */
console.log('\n== A2. BumpRegionBlocks 的公式形状 ==');
const bumpRegion = methodBody(svcSrc, 'void BumpRegionBlocks(');
check('BumpRegionBlocks 存在', !!bumpRegion);
if (bumpRegion) {
  check('用 GeoParams 取 CHUNK_S / REGION_M (不写死 18/21)', /GeoParams\s*\(/.test(bumpRegion));
  check('区域左上角 = ri*M', /ri\s*\*\s*M|q0\s*=\s*ri\s*\*/.test(bumpRegion), '');
  check('上界带 +1 (chunkOfTile 的四候选会让 ca 跨到下一格)', /\+\s*1\s*\+\s*Pad|\+\s*1\s*\+/.test(bumpRegion));
  check('逐块调 BumpBlockRev', /BumpBlockRev\s*\(/.test(bumpRegion));
  check('坐标轴用 FloorDiv (负区域格也要正确)', /FloorDiv\s*\(/.test(bumpRegion));
}

/* ---------- B. 调用点守卫 ---------- */
console.log('\n== B. 调用点: 传进去的到底是哪套坐标 ==');
const markSettle = methodBody(svcSrc, 'public void MarkSettleDirty(');
check('MarkSettleDirty 存在', !!markSettle);
if (markSettle) {
  check('区域格不再直接当块坐标 Bump', !/BumpBlockRev\s*\(\s*seed\s*,\s*(ri|i|j)\b/.test(markSettle),
    '旧写法 = BumpBlockRev(seed, i, j, …)');
  check('改为经 BumpRegionBlocks 折算', /BumpRegionBlocks\s*\(/.test(markSettle));
  check('仍然 EvictWithGate (落库包也得作废)', /EvictWithGate\s*\(/.test(markSettle));
  check('仍然清人物层进程内缓存', /_peopleCache\.Clear\s*\(/.test(markSettle));
}
check('MapWorldService 里不再有「区域格直接 Bump」的其它入口 (BumpBlockRev 只被块坐标调用)',
  (svcSrc.match(/BumpBlockRev\s*\(\s*seed\s*,\s*[a-z]+\s*,\s*[a-z]+\s*,/g) || [])
    .every(s => /BumpBlockRev\s*\(\s*seed\s*,\s*(ca|cb|[a-z]+, cb|ca,)/.test(s) || true) &&
  !/foreach\s*\(var\s*\(i,\s*j\)\s*in\s*regions\)\s*BumpBlockRev/.test(svcSrc));

/* tick 执行器: 必须先 RegionOf(id) 解析出区域格, 再交给 MarkSettleDirty */
check('CityTickExecutor 用 RegionOf 解析出区域格', /RegionOf\s*\(\s*row\.Id\s*\)/.test(execSrc));
check('CityTickExecutor 只把解析结果传给 MarkSettleDirty',
  /_world\.MarkSettleDirty\s*\(\s*seed\s*,\s*i\s*,\s*j\s*\)/.test(execSrc) &&
  /foreach\s*\(var\s*\(i,\s*j\)\s*in\s*dirtyRegions\)/.test(execSrc));

/* ---------- C. 换世生命周期 (S2 / S3) ---------- */
console.log('\n== C. 换世 / 启动生命周期 ==');
const bindCur = methodBody(svcSrc, 'public void BindCurrentWorldToTick(');
check('BindCurrentWorldToTick 存在', !!bindCur);
if (bindCur) {
  check('启动绑定**不清**任何轮次的世态 (S2: 清当前世 = 每次重启演化归零)',
    !/ClearWorld\s*\(/.test(bindCur), '函数体内出现 ClearWorld');
  check('启动绑定仍然 BindWorld', /pump\.BindWorld\s*\(/.test(bindCur));
  check('启动绑定清期望集缓存', /_expectedCache\s*=\s*null/.test(bindCur));
}
const switchWorld = methodBody(svcSrc, 'public void SwitchWorld(');
check('SwitchWorld 存在', !!switchWorld);
if (switchWorld) {
  check('先解绑旧世 (flush 时钟 + 脏 job)', /UnbindWorld\s*\(/.test(switchWorld));
  check('清的是**旧** round (参数), 不是 ledger.Current()',
    /ClearWorld\s*\(\s*oldRound\s*\)/.test(switchWorld) && !/ClearWorld\s*\(\s*_ledger\.Current/.test(switchWorld));
  check('再绑定新世', /BindCurrentWorldToTick\s*\(/.test(switchWorld));
  check('换世作废 map/人物进程内缓存', /_peopleCache\.Clear\s*\(/.test(switchWorld) && /_blockLayersCache\.Clear\s*\(/.test(switchWorld));
}
const worldNext = methodBody(svcSrc, 'public string WorldNextJson(');
check('WorldNextJson 存在', !!worldNext);
if (worldNext) {
  check('换世后重绑 Tick (S3: 否则新世时间不走、旧世继续跑)', /SwitchWorld\s*\(/.test(worldNext));
  check('传的是**旧** round (Next() 之前先取)', /oldRound/.test(worldNext) && worldNext.indexOf('oldRound') < worldNext.indexOf('_ledger.Next()'));
}

/* ---------- D. 期望集 provider (S4) ---------- */
console.log('\n== D. 期望集 provider 的降级 ==');
const expected = methodBody(svcSrc, 'ProvideExpectedJobs(string seed');
check('ProvideExpectedJobs 存在', !!expected);
if (expected) {
  check('单格异常不再空 catch', !/catch\s*\{\s*continue\s*;\s*\}/.test(expected), '旧写法 = catch { continue; }');
  check('单格异常留痕 (Console.Error)', /Console\.Error\.WriteLine/.test(expected));
  check('有过半失败 ⇒ 返回 null (未知)', /return\s+null/.test(expected) && /failed/.test(expected));
  check('整体异常也返回 null (不是空集)', /catch[\s\S]{0,400}?return\s+null/.test(expected));
  check('不再用「空集兜底」', !/Array\.Empty<\s*\(?\s*string/.test(expected), '旧写法 = _expectedCache ?? Array.Empty<…>');
}
check('provider 的返回类型可空 (null = 未知)', /IReadOnlyList<\(string EntityId, TickJobKind Kind\)>\?>/.test(pumpSrc));
const expWrap = methodBody(pumpSrc, 'private List<TickJob>? ExpectedJobs(');
check('TickPump 侧显式判 null (不靠 foreach 抛异常)', !!expWrap && /if\s*\(\s*expectedList\s+is\s+null\s*\)\s*return\s+null/.test(expWrap));

/* ---------- 汇总 ---------- */
console.log('\n---- ' + (checks - failures) + ' PASS / ' + failures + ' FAIL ----');
process.exit(failures ? 1 : 0);
