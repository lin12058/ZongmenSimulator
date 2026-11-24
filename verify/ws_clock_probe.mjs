/* ============================================================
 * ws_clock_probe.mjs — 帧 7 (ClockQuery/ClockPush) 端到端契约 (在线, 需起服务端)
 * ------------------------------------------------------------
 * 需求 (用户 2026-09-26 第一轮原话):
 *   「现在你要有一个 C# 里面的 gametick 用于实时计算游戏的时长的」
 *
 * 验四件事:
 *   A. 帧契约: 发帧 7 回帧 7; 载荷**明文非 gzip** (首字节是可解析的 protobuf tag)。
 *   B. 字段契约: tick>0 / 年月日季节自洽 / tick 与 ToDate 一致 / 描述非空 /
 *      RatePerSecond==1 / 四季名合法。
 *   C. **无需登录**: 时钟是世界公开事实, 未登录也必须能读 (且不泄露实体数据)。
 *   D. **时钟真在走**: 间隔 ~2.5s 两次查询, Δtick ≈ 2 (1 tick/秒)。
 *      ⚠ 用「Δtick 落在 [2,4]」而非「Δtick == 2」: 不能假设两次请求恰好卡在整秒两侧。
 *
 * 跑法: node verify/ws_clock_probe.mjs [baseUrl]     (默认 http://127.0.0.1:8140)
 *   ⚠ 只读, 不写任何状态 (不登录、不落子) ⇒ 可对任何实例跑。
 *   ⚠ 用 Node 内建 WebSocket (Node ≥ 22), 不依赖 ws 包。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8140';
const WSURL = BASE.replace(/^http/, 'ws') + '/ws/map';

/* 复用前端协议层 (单真源: 编解码不在判据里重写一遍) */
(0, eval)(fs.readFileSync(path.join(ROOT, 'web', 'js', 'pb.js'), 'utf8'));
const PB = global.PB;

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { failures++; console.log(`  ✘ ${name}${detail ? '  → ' + detail : ''}`); }
};

/* 四季/月名真源: 与 GameClock 同口径 (仅用于断言合法性, 不用于推导时间) */
const SEASONS = ['春', '夏', '秋', '冬'];

const sock = new WebSocket(WSURL);
sock.binaryType = 'arraybuffer';

const got = [];
let t0 = 0;

function sendQuery() {
  const body = PB.encodeClockQuery({ seq: got.length + 1 });
  const f = new Uint8Array(1 + body.length);
  f[0] = PB.FRAME.CLOCK_QUERY; f.set(body, 1);
  sock.send(f);
}

sock.onopen = () => {
  console.log('\n=== ws_clock_probe：帧 7 世界时钟 ===\n');
  console.log(`  → ${WSURL}  (未登录直查)\n`);
  t0 = Date.now();
  sendQuery();
};

sock.onmessage = (ev) => {
  const u8 = new Uint8Array(ev.data);
  const type = u8[0];
  const payload = u8.subarray(1);
  const d = PB.decodeClockQueryResponse(payload);
  got.push({ ...d, at: Date.now() });

  console.log(`  帧${type} tick=${d.tick} 年月日=${d.year}/${d.month}/${d.day} ` +
              `季=${d.seasonName} 描述="${d.desc}" 速率=${d.ratePerSecond} pending=${d.pending}` +
              (d.err ? `  err=${d.err}` : ''));

  if (got.length === 1) {
    /* ── A. 帧契约 ────────────────────────────────────────────── */
    check('A1 回帧类型 == 7 (CLOCK_PUSH)', type === 7, `实际 ${type}`);
    check('A2 载荷明文非 gzip (首字节是 protobuf tag)',
      payload[0] === 0x08 || payload[0] === 0x10, `首字节 0x${payload[0]?.toString(16)}`);
    check('A3 无错误字段', !d.err, d.err);

    /* ── B. 字段契约 ──────────────────────────────────────────── */
    check('B1 tick > 0', d.tick > 0, `${d.tick}`);
    check('B2 year >= 1', d.year >= 1, `${d.year}`);
    check('B3 month ∈ [1,12]', d.month >= 1 && d.month <= 12, `${d.month}`);
    check('B4 day ∈ [1,30]', d.day >= 1 && d.day <= 30, `${d.day}`);
    check('B5 season ∈ [0,3]', d.season >= 0 && d.season <= 3, `${d.season}`);
    check('B6 seasonName 合法', SEASONS.includes(d.seasonName), d.seasonName);
    check('B7 RatePerSecond == 1', d.ratePerSecond === 1, `${d.ratePerSecond}`);
    check('B8 Desc 形如「第N年 …」', typeof d.desc === 'string' && d.desc.startsWith('第'), d.desc);
    check('B9 MonoMs > 0 (服务端单调时钟已提供)', d.monoMs > 0, `${d.monoMs}`);

    /* B10: tick 与「年月日」自洽 —— 复算 360 日/年, 30 日/月, 90 日/季 */
    const ty = Math.floor(d.tick / 360) + 1;
    const doy = d.tick % 360;
    const mo = Math.floor(doy / 30) + 1;
    const da = doy % 30 + 1;
    const se = Math.floor(doy / 90);
    check('B10 (year,month,day,season) 与 tick 自洽 (360日/年 30日/月 90日/季)',
      ty === d.year && mo === d.month && da === d.day && se === d.season,
      `推得 ${ty}/${mo}/${da}/季${se}，收到 ${d.year}/${d.month}/${d.day}/季${d.season}`);

    setTimeout(sendQuery, 2500);
  } else if (got.length === 2) {
    /* ── D. 时钟真在走 ───────────────────────────────────────── */
    const dt = got[1].tick - got[0].tick;
    const dms = got[1].at - got[0].at;
    check('D1 tick 单调不减', dt >= 0, `Δ=${dt}`);
    check('D2 Δtick ≈ Δ秒 (1 tick/秒)', dt >= 2 && dt <= 4, `Δtick=${dt}, Δt=${dms}ms`);
    check('D3 第二次描述也非空', got[1].desc.startsWith('第'), got[1].desc);

    sock.close();
    console.log(`\n${failures === 0 ? '全部通过 ✔' : `失败 ${failures} 项 ✘`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  }
};

sock.onerror = (e) => { console.error('WS 错误:', e.message || e); process.exit(1); };
setTimeout(() => { console.error('超时: 未收到帧 7 响应'); process.exit(1); }, 15000);
