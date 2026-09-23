/* ============================================================
 * w5_place_rev.mjs — 玩家宗门放置「端到端 + rev/脏块」契约 (在线, 需起服务端)
 * ------------------------------------------------------------
 * 需求背景 (用户 2026-09-21/23):
 *   「玩家可以随便放 …… 8 格附近有城市中心就不允许建造」
 *   「放下去的时候附近的直接重修算然后直接发给前端」
 *
 * 本脚本走**真实 WS 协议** (帧 5 PlaceCheck / 帧 6 PlaceCommit) 验六件事:
 *   A. 判据链: 城市中心 8 格内必拒 (too_close, blocker.need===8);
 *      hexDist === 8 的边界允许; 深海 (deep_water) 必拒。
 *   B. 提交成功: id 形态 `{i}_{j}_u{n}` (⚠ 前两段非数会让引擎的需求边池静默扫空),
 *      regionI/J 与引擎 regionSeedOf 一致, blocks 非空, ms > 0。
 *   C. **rev/脏块契约** (最容易静默失效的一条):
 *      ① 提交前先拉一次目标块, 记下 revs;
 *      ② 提交 (服务端同步重算道路 + BumpBlockRev);
 *      ③ 带 ① 的旧 revs 再拉同一块 → 该块 **必须** 重发 Settle 图层且含新宗门 id。
 *      反例: 只 ObserveRoadVer 而不 BumpBlockRev ⇒ rev 未变 ⇒ 服务端缺省下发 ⇒
 *      客户端永远看不到新宗门 (不报错)。
 *   D. 单格详情: /api/map/tile 的 place = 新宗门 (证明 ext 层真的进了 settlementsFor)。
 *   E. 幂等: 同 IdemKey 重发 → 同 id 回放, 且配额不被重复扣。
 *   F. 配额: 同账号再提交 (新 IdemKey) → quota_exceeded; 另一账号 PlaceCheck → quota=0。
 *
 * 用法: node verify/w5_place_rev.mjs [baseUrl]      (默认 http://127.0.0.1:8140)
 *   ⚠ 需要 Zongmen__PlayerSectMaxPerAccount=1 (默认) 才能验 F。
 *   ⚠⚠ **必须对着「本世还没有玩家宗门」的实例跑** (脚本自己会查 /api/map/stats 前置闸,
 *      不满足时 rc=2 跳过): A/B 段的期望值由**裸引擎参照实现**给出, 本世一旦落过宗门,
 *      两侧口径分叉 ⇒ 一串看似莫名其妙的 FAIL (实为世界被跑脏, 不是回归)。
 *      与 check_world_ledger.mjs 不要连跑 —— 它开的新一世里可能有历史宗门数据。
 *      ⚠ 本脚本会**写**: 真实落一座宗门 (PlayerSect 落库 + placeVer 前进) ⇒ 只对隔离实例跑。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';

global.window = globalThis;
for (const f of ['noise.js', 'mapgen-config.js', 'mapgen.js', 'mapgen-server.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, 'Server', 'Zongmen', 'Engine', 'js', f), 'utf8'));
}
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const MG = global.MapGen;
const GS = global.MapGenServer;
const PB = global.PB;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
async function getJson(url) {
  const r = await fetch(BASE + url);
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.json();
}
async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
}

/* ---------- 极简 WS 客户端 (帧 1/2/3/4/5/6) ---------- */
class Ws {
  constructor(base) {
    this.url = base.replace(/^http/, 'ws') + '/ws/map';
    this.seq = 0;
    this.pending = new Map();
    this.loginWaiter = null;
  }
  async connect(account) {
    this.sock = new WebSocket(this.url);
    this.sock.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      this.sock.onopen = res;
      this.sock.onerror = () => rej(new Error('ws 连接失败 ' + this.url));
    });
    this.sock.onmessage = (ev) => this.onFrame(new Uint8Array(ev.data));
    await new Promise((res) => { this.loginWaiter = res; this.frame(PB.FRAME.LOGIN, PB.encodeLogin({ account, token: 'demo' })); });
  }
  frame(type, body) {
    const f = new Uint8Array(1 + body.length);
    f[0] = type; f.set(body, 1);
    this.sock.send(f);
  }
  onFrame(u8) {
    const type = u8[0], payload = u8.subarray(1);
    if (type === PB.FRAME.LOGIN) { this.loginWaiter && this.loginWaiter(); this.loginWaiter = null; return; }
    if (type === PB.FRAME.TILE) {
      gunzip(payload).then((buf) => {
        const resp = PB.decodeTileResponse(buf);
        const p = this.pending.get(resp.seq);
        if (!p) return;
        this.pending.delete(resp.seq); clearTimeout(p.timer); p.resolve(resp);
      }, (e) => console.error('TileResponse 解压失败', e));
      return;
    }
    if (type === PB.FRAME.PLACE_CHECK || type === PB.FRAME.PLACE_COMMIT) {
      const key = type + ':' + (payload.length ? payload[0] : 0);
      const one = this._pendingPlace;
      if (!one) return;
      this._pendingPlace = null;
      clearTimeout(one.timer);
      try {
        one.resolve(type === PB.FRAME.PLACE_CHECK
          ? PB.decodePlaceCheckResponse(payload)
          : PB.decodePlaceCommitResponse(payload));
      } catch (e) { one.reject(e); }
    }
  }
  _waitPlace(type, body) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._pendingPlace = null; reject(new Error('放置帧超时 (type=' + type + ')')); }, 60000);
      this._pendingPlace = { resolve, reject, timer };
      this.frame(type, body);
    });
  }
  placeCheck(seed, q, r, excludeId) {
    return this._waitPlace(PB.FRAME.PLACE_CHECK, PB.encodePlaceCheck({ seed, q, r, seq: ++this.seq, excludeId }));
  }
  placeCommit(seed, q, r, name, tier, idemKey) {
    return this._waitPlace(PB.FRAME.PLACE_COMMIT, PB.encodePlaceCommit({ seed, q, r, name, tier, seq: ++this.seq, idemKey }));
  }
  tile(seed, i, j, mask = 0, lastRevs = []) {
    const sseq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(sseq); reject(new Error('ws tile 超时')); }, 60000);
      this.pending.set(sseq, { resolve, reject, timer });
      this.frame(PB.FRAME.TILE, PB.encodeTileRequest({ op: 1, seed, i, j, mask, seq: sseq, lastRevs }));
    });
  }
  close() { try { this.sock.close(); } catch { /* 忽略 */ } }
}

/* ---------- 用引擎参考实现找「城市」与「合法空位」 ---------- */
function findCityAndSpot(seed) {
  MG.init(seed);
  const REG = MG.REGION_M;
  let city = null;
  for (let i = -6; i <= 6 && !city; i++) {
    for (let j = -6; j <= 6; j++) {
      const arr = MG.settlementsFor(i, j);
      for (const s of arr) if (s.type === 'city') { city = s; break; }
      if (city) break;
    }
  }
  if (!city) throw new Error('参考世界 ' + seed + ' 里找不到 city, 无法验判据 A');
  /* 从城里往外扫, 找第一个「距所有聚落都 ≥ 其领地半径」的格 (用引擎自己的判定) */
  let spot = null;
  for (let d = 1; d <= 30 && !spot; d++) {
    for (let dq = -d; dq <= d && !spot; dq++) {
      for (let dr = -d; dr <= d; dr++) {
        if (Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)) !== d) continue;
        const q = city.q + dq, r = city.r + dr;
        if (MG.fields(q, r).biome === MG.BIOME.DEEP) continue;
        if (!MG.domainCheck(q, r, '').ok) continue;
        spot = { q, r };
        break;
      }
    }
  }
  return { city, spot };
}

/* ============================ 主流程 ============================ */
console.log('== 0. 领当前世 ==');
const cur = await getJson('/api/world/current');
const seed = cur.seed, round = cur.round;
console.log(`  seed=${seed} round=${round}`);
check('seed 非空', !!seed);

/* ---------- 前置闸: 本世必须「干净」 ----------
   ⚠ 本判据的 A2/A3/A4/B1 都是拿**裸引擎参照实现**算期望值 (findCityAndSpot 里不注入 ext),
   而服务端算的是「裸世界 + 本世已落的玩家宗门」。一旦本世已经落过宗门, 两侧口径必然分叉:
     · 参照实现说「这里合法」⇐ 它不知道那儿多了个宗门
     · 服务端回 too_close / 空的 reason
   表现为 A2「8 格放行」等一串**莫名其妙的 FAIL** (2026-09-23 我连跑几遍把自己的隔离实例跑脏,
   就踩了这个: 4 条 FAIL 全是世界状态的产物, 不是代码回归)。
   故本世已有玩家宗门 ⇒ rc=2 **跳过** (runner 把 rc=2 记作 skip, 不算红), 并给出重起姿势。 */
console.log('== 0b. 前置闸: 本世是否干净 ==');
const stats0 = await getJson('/api/map/stats');
if ((stats0.playerSects | 0) > 0) {
  console.log('  [skip] 本世 (round=' + round + ') 已有 ' + stats0.playerSects +
              ' 座玩家宗门 ⇒ 参照实现会失真, 本次跳过。');
  console.log('         重起姿势 (隔离实例 + 全新 DB, 且**别**先跑会动世界的判据):');
  console.log('           Zongmen__Port=8150 Zongmen__DbPath=<fresh>.sqlite dotnet Zongmen.dll');
  console.log('         ⚠ check_world_ledger.mjs 会真实开一世; 本脚本要求「领到的这一世」干净。');
  process.exit(2);
}
console.log('  playerSects=' + stats0.playerSects + ' placeVer=' + stats0.placeVer + ' OK');

console.log('== 参考实现: 找一个 city 与一个合法空位 ==');
const { city, spot } = findCityAndSpot(seed);
console.log(`  city=${city.id} (${city.q},${city.r}) tier=${city.tier} → DOMAIN_R=${MG.domainRadiusOf(city)}`);
console.log(`  spot=(${spot.q},${spot.r})`);
check('city 领地半径 = 8 (用户原话「8 格附近有城市中心」)', MG.domainRadiusOf(city) === 8, String(MG.domainRadiusOf(city)));
check('找到合法空位', !!spot);

const account = 'place_' + Date.now().toString(36);
const ws = new Ws(BASE);
await ws.connect(account);
console.log(`  已登录 account=${account}`);

console.log('== A. 判据链 ==');
const st0 = await getJson('/api/map/stats');
const ver0 = st0.placeVer;

/* A1: 城市中心本身必拒 */
const cCenter = await ws.placeCheck(seed, city.q, city.r);
check('A1 城市中心被拒', cCenter.ok === false, JSON.stringify({ ok: cCenter.ok, reason: cCenter.reason }));
check('A1 reason=too_close', cCenter.reason === 'too_close', cCenter.reason);
check('A1 blocker.need=8', cCenter.blocker && cCenter.blocker.need === 8, JSON.stringify(cCenter.blocker));
check('A1 blocker.dist < need', cCenter.blocker && cCenter.blocker.dist < cCenter.blocker.need, '');
check('A1 near 列表非空 (前端要画领地圈)', cCenter.near.length > 0, String(cCenter.near.length));

/* A2: 距 city 中心 8 格 (===) 应**允许** —— 边界语义 */
let boundaryOk = null;
for (let dq = -8; dq <= 8 && boundaryOk === null; dq++) {
  for (let dr = -8; dr <= 8; dr++) {
    if (MG.hexDist(city.q, city.r, city.q + dq, city.r + dr) !== 8) continue;
    const c = await ws.placeCheck(seed, city.q + dq, city.r + dr);
    /* 若该点没被「别的」聚落挡住, 就必须放行 */
    if (!c.blocker || c.blocker.id === city.id) { boundaryOk = { q: city.q + dq, r: city.r + dr, c }; break; }
  }
}
check('A2 距 city 中心 8 格可建 (=== 放行)',
  boundaryOk && boundaryOk.c.ok === true, boundaryOk ? JSON.stringify({ q: boundaryOk.q, r: boundaryOk.r, ok: boundaryOk.c.ok, reason: boundaryOk.c.reason }) : 'no sample');

/* A3: 深海必拒 (扫描找一个深海格) */
let deepHit = null;
for (let q = city.q - 120; q <= city.q + 120 && !deepHit; q += 3) {
  for (let r = city.r - 120; r <= city.r + 120; r += 3) {
    if (MG.fields(q, r).biome !== MG.BIOME.DEEP) continue;
    deepHit = { q, r };
    break;
  }
}
if (deepHit) {
  const c = await ws.placeCheck(seed, deepHit.q, deepHit.r);
  check('A3 深海被拒 reason=deep_water', c.ok === false && c.reason === 'deep_water', JSON.stringify({ ok: c.ok, reason: c.reason }));
} else {
  console.log('  SKIP A3 (本世界探针范围内没找到深海格)');
}

/* A4: 灵脉格必拒 */
let veinHit = null;
for (let q = city.q - 150; q <= city.q + 150 && !veinHit; q += 2) {
  for (let r = city.r - 150; r <= city.r + 150; r += 2) {
    if (!MG.fields(q, r).vein) continue;
    veinHit = { q, r };
    break;
  }
}
if (veinHit) {
  const c = await ws.placeCheck(seed, veinHit.q, veinHit.r);
  check('A4 灵脉格被拒 reason=on_vein', c.ok === false && c.reason === 'on_vein', JSON.stringify({ ok: c.ok, reason: c.reason }));
} else {
  console.log('  SKIP A4 (探针范围内没找到灵脉格)');
}

console.log('== B/C. 提交 + rev/脏块契约 ==');
const block = MG.chunkOfTile(spot.q, spot.r);
const before = await ws.tile(seed, block.ca, block.cb);
check('B0 提交前块请求成功', !!before && before.revs.length === 5, '');
const oldRevs = before.revs.slice();
const hadSect = !!(before.settle && before.settle.groups.some((g) => g.items.length));

const idem = 'idem_' + Date.now().toString(36);
const t0 = Date.now();
const cm = await ws.placeCommit(seed, spot.q, spot.r, '卜居测试宗', 2, idem);
const wall = Date.now() - t0;
check('B1 提交成功', cm.ok === true, JSON.stringify({ ok: cm.ok, reason: cm.reason, err: cm.err }));
if (!cm.ok) {
  console.log('  中止: 提交失败, 后续断言无意义');
  ws.close();
  console.log('\n结果: ' + (failures ? 'FAIL ' + failures : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}
console.log(`  id=${cm.sect.id} ms(服务端自报)=${cm.ms} ms(墙钟)=${wall} roads=${cm.roads} blocks=${cm.blocks.length}`);
check('B2 id 形态 {i}_{j}_u{n} (前两段必须是整数: 引擎会 split 反解)',
  /^-?\d+_-?\d+_u\d+$/.test(cm.sect.id), cm.sect.id);
check('B2b id 前两段 == 引擎 regionSeedOf', (() => {
  const rs = MG.regionSeedOf(spot.q, spot.r);
  const p = cm.sect.id.split('_');
  return (+p[0] === rs.i) && (+p[1] === rs.j);
})(), cm.sect.id);
check('B3 regionI/J 与引擎一致', (() => {
  const rs = MG.regionSeedOf(spot.q, spot.r);
  return cm.regionI === rs.i && cm.regionJ === rs.j;
})(), cm.regionI + ',' + cm.regionJ);
check('B4 blocks 非空 (前端靠它强制重拉)', cm.blocks.length > 0, String(cm.blocks.length));
check('B5 ms > 0 (同步重算真的跑了)', cm.ms > 0, String(cm.ms));
check('B6 roadVer 单调前进', cm.roadVer > 0, String(cm.roadVer));

/* C: 带旧 revs 重拉同一块 → 必须重发 Settle 且含新 id */
const after = await ws.tile(seed, block.ca, block.cb, 0, oldRevs);
const gotSettle = !!after.settle;
const hasNew = gotSettle && after.settle.groups.some((g) => g.items.some((e) => e.id === cm.sect.id));
check('C1 BumpBlockRev 生效: 带旧 revs 重拉仍重发 Settle 图层', gotSettle,
  JSON.stringify({ settle: !!after.settle, revs: after.revs }));
check('C2 重发的 Settle 里含新宗门 (externalRegionsWithin 补格生效)', hasNew, '');
/* 反向: 若该块本来就有聚落, 说明「无条件重发」也可能过关 —— 所以再断言 rev 真的变了 */
check('C3 该块 Settle rev 相比提交前变大', after.revs[2] !== oldRevs[2],
  JSON.stringify({ before: oldRevs[2], after: after.revs[2] }));

console.log('== D. 单格详情 ==');
const detail = await fetch(BASE + '/api/map/tile?seed=' + encodeURIComponent(seed) + '&q=' + spot.q + '&r=' + spot.r)
  .then((r) => r.arrayBuffer()).then((b) => PB.decodeTileMsg(new Uint8Array(b)));
check('D1 /api/map/tile 的 place = 新宗门', detail.placeType === 'sect' && detail.placeName === '卜居测试宗',
  JSON.stringify({ type: detail.placeType, name: detail.placeName }));
check('D2 place 人口 > 0', (detail.placePop | 0) > 0, String(detail.placePop));

console.log('== E. 幂等 ==');
const again = await ws.placeCommit(seed, spot.q, spot.r, '卜居测试宗', 2, idem);
check('E1 同 IdemKey 回放同 id', again.ok === true && again.sect && again.sect.id === cm.sect.id,
  JSON.stringify({ ok: again.ok, id: again.sect && again.sect.id }));
check('E2 回放不重算 (ms=0 或与首次相同)',
  again.ms === cm.ms || again.ms === 0, `${again.ms} vs ${cm.ms}`);

console.log('== F. 配额 ==');
const second = await ws.placeCommit(seed, spot.q + 1, spot.r, '第二座', 1, 'idem2_' + Date.now().toString(36));
check('F1 同账号第二座被拒 quota_exceeded', second.ok === false && second.reason === 'quota_exceeded',
  JSON.stringify({ ok: second.ok, reason: second.reason }));
const ws2 = new Ws(BASE);
await ws2.connect('other_' + Date.now().toString(36));
const other = await ws2.placeCheck(seed, spot.q + 40, spot.r + 40);
check('F2 另一账号配额从 0 起 (按账号而非按世界)', other.quota === 0 && other.quotaMax === 1,
  JSON.stringify({ quota: other.quota, max: other.quotaMax }));
ws2.close();

console.log('== G. 服务端状态 ==');
const st1 = await getJson('/api/map/stats');
check('G1 stats.playerSects >= 1', st1.playerSects >= 1, String(st1.playerSects));
check('G2 stats.placeVer 前进', st1.placeVer > ver0, `${ver0} → ${st1.placeVer}`);

ws.close();
console.log('\n结果: ' + (failures ? 'FAIL ' + failures : 'ALL PASS'));
process.exit(failures ? 1 : 0);
