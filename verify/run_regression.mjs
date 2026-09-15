#!/usr/bin/env node
/*
 * 宗门模拟器 · 全量回归 runner  (交接单 U6 固化项, 2026-09-15)
 *
 * 用途: 把散在 verify/ 下的判据脚本按固定顺序跑一遍, 汇总「红 N / 共 M」, 避免每次手拼命令行。
 *
 * 用法:
 *   node verify/run_regression.mjs                     # 16 条离线判据 + frontend_smoke(对 127.0.0.1:8140)
 *   node verify/run_regression.mjs --base=192.168.63.62:8140
 *   node verify/run_regression.mjs --offline-only      # 只跑不需要活服务端的 15 条
 *   node verify/run_regression.mjs --with-server       # 追加 verify_map/w1/w2/w4(建议对着隔离 8141 跑)
 *   node verify/run_regression.mjs --only=vein         # 只跑文件名含 "vein" 的
 *   node verify/run_regression.mjs --skip=w3,w5        # 跳过含这些片段的
 *   node verify/run_regression.mjs --list              # 只列出会跑哪些
 *
 * 约定 (与 .workbuddy/memory/MEMORY.md 一致, 别踩):
 *   1. **别 kill 用户 8140 实例**。服务端判据一律只读; 要跑 `--with-server` 请先另起隔离实例:
 *        set Zongmen__Port=8141 & set Zongmen__DbPath=db/zongmen.verify.sqlite & dotnet run
 *      然后 `node verify/run_regression.mjs --base=127.0.0.1:8141 --with-server`。
 *   2. **HTTP 判据必须绕代理**: 本机 `HTTP_PROXY=http://127.0.0.1:9105` 会让内网请求 502。
 *      本 runner 统一清掉 *_PROXY 并置 NO_PROXY=* , 各脚本不必自己处理。
 *   3. `w3_bfs_road` 的 ⑦ 两条**墙钟**阈值是**机器绝对速度门槛**(默认 400/500ms), 慢机/拥塞时必红。
 *      本 runner 会把这**两条**失败单独降级为「墙钟(非回归)」warn, 不计入红; 若失败的是别的断言,
 *      仍算真红。想要更松/更严: `--w3-ms=600`。
 *   4. `check_cloud_zoom.mjs` 需要实机截图参数, 裸跑 rc=2 属正常 ⇒ 不在默认清单内(要跑请单独调)。
 *   5. 退出码: 有真红 ⇒ 1, 否则 0 (warn 不影响退出码)。
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
const LIST_ONLY = has('list');

/* [文件, 额外参数, 组别, 备注]
 *   组别: 'off' = 纯离线(无网络) | 'live' = 需要一个活服务端(只读探活)
 *   ⚠ frontend_smoke 既跑源码守卫也问服务端要 meta/tile ⇒ 归 live。 */
const JOBS = [
  ['check_vein_skin.mjs', [], 'off'],
  ['check_vein_cluster.mjs', [], 'off'],
  ['check_no_build_on_vein.mjs', [], 'off'],
  ['check_settle_spacing.mjs', [], 'off'],
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
  ['frontend_smoke.mjs', [BASE_URL], 'live'],
];
const SERVER_JOBS = [
  ['verify_map.mjs', [BASE_URL], 'live'],
  ['w1_client_revs.mjs', [BASE_URL], 'live'],
  ['w2_concurrency.mjs', [BASE_URL], 'live'],
  ['w4_revs_at_scale.mjs', [BASE_URL], 'live'],
];

const want = (f) => (!ONLY || f.includes(ONLY)) && !(SKIP && SKIP.split(',').some((s) => s && f.includes(s)));

const plan = JOBS
  .concat(WITH_SERVER ? SERVER_JOBS : [])
  .map(([f, args, grp, note]) => ({ f, args, grp, note }))
  .filter((j) => want(j.f) && !(OFFLINE_ONLY && j.grp === 'live'));

if (LIST_ONLY) {
  console.log('基址 = ' + BASE_URL + (OFFLINE_ONLY ? '  (offline-only)' : '') + (WITH_SERVER ? '  (with-server)' : ''));
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

let red = 0, warn = 0, pass = 0, miss = 0;
const reds = [], warns = [];
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
  let kind = 'ok';
  if (r.status !== 0) {
    const allWall = failLines.length > 0 && failLines.every((l) => WALL_RE.test(l) && /\d(\.\d+)?\s*ms/.test(l));
    kind = allWall ? 'warn' : 'red';
  }
  if (kind === 'red') { red++; reds.push(j.f); }
  else if (kind === 'warn') { warn++; warns.push(j.f); }
  else pass++;

  const tag = kind === 'red' ? '红  ' : kind === 'warn' ? 'WARN' : 'rc=0';
  const counts = (nP || nF) ? '  [' + nP + ' PASS' + (nF ? ' / ' + nF + ' FAIL' : '') + ']' : '';
  console.log('[' + tag + '] ' + j.f + counts + '  ' + dt + 's' + (j.note ? '   (' + j.note + ')' : ''));
  if (kind === 'red') {
    for (const l of failLines.slice(0, 6)) console.log('        ' + l.trim().slice(0, 170));
  } else if (kind === 'warn') {
    for (const l of failLines.slice(0, 3)) console.log('        ' + l.trim().slice(0, 170));
  }
  /* 输出里没有 PASS/FAIL 的脚本(rc!=0 且无线索) ⇒ 回显尾部几行, 否则看不到原因 */
  if (kind === 'red' && !failLines.length) {
    for (const l of lines.slice(-4)) console.log('        ' + l.trim().slice(0, 170));
  }
}

const dtAll = ((Date.now() - t0all) / 1000).toFixed(1);
console.log('\n========== 红 ' + red + ' / 共 ' + plan.length +
  '   (绿 ' + pass + ', warn ' + warn + ', miss ' + miss + ', 耗时 ' + dtAll + 's) ==========');
if (warns.length) console.log('  ⚠ warn(墙钟非回归): ' + warns.join(', ') + '  —— 机器绝对速度门槛, 不是回归');
if (reds.length) console.log('  ✘ 真红: ' + reds.join(', '));
process.exit(red ? 1 : 0);
