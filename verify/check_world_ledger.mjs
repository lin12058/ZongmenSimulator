/* ============================================================
 * check_world_ledger.mjs — 世界种子台账契约 (**需活服务端**, 只读 + 一次写)
 * ------------------------------------------------------------
 * 用户口径 (2026-09-16): 「seed 是由服务器统一产生的, 不能通过前端产生了, 存在 sqlite 里面的」
 *
 * 本脚本钉死「种子是服务端资产」这条链路的全部外部行为:
 *   1. GET  /api/world/current  → 幂等 (连取两次完全一致) / 形态合法 / 首次自动开第一世
 *   2. GET  /api/world/list     → 历史轮次降序 / 无重复种子 / total 自洽
 *   3. POST /api/world/next     → 轮次 +1 / 新种子 ≠ 旧种子 / 落库后 current 前进
 *   4. /api/map/stats           → worldRounds/ledgerPersisted 与台账一致 (对账口)
 *   5. 新种子**可用**: 拿它问 /api/map/meta 必须真能开出一界 (不是凭空字符串)
 *   6. 前端接线: index.html 只留齿轮 + 引了 store.js + 已无手输种子控件
 *
 * ⚠ 会**真实开一世** (轮次 +1 并落库) —— 这是被测行为本身, 不要对着用户的 8140 跑;
 *   起隔离实例: set Zongmen__Port=8150 & set Zongmen__MaxSeeds=64 & dotnet verify/_vmsrv/Zongmen.dll
 *
 * 用法: node verify/check_world_ledger.mjs [http://127.0.0.1:8150]
 * ============================================================ */
const BASE = (process.argv[2] || 'http://127.0.0.1:8140').replace(/\/$/, '');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

async function getJson(url, method = 'GET') {
  const r = await fetch(BASE + url, { method, cache: 'no-store' });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { /* 非 JSON: 留给断言报原文 */ }
  return { status: r.status, json: j, text: txt };
}

const SEED_RE = /^\d{6,12}$/;          // 服务端产出形态: 十进制 8 位 (无前导零), 宽放一点便于判"是不是数字串"

/* 词法级去注释 (字符串 + 正则字面量感知) —— 7d 这条**否定**断言必须看代码而不是注释:
   注释里引用旧实现 (`Date.now() % 100000000`) 是正常的文档行为, 不该判红。
   ⚠ 仓库里那份只认引号的去注释器会被 main.js 的 `/[&<>"]/g` 带进"字符串状态", 之后
     整段状态错位、块注释不再被剥掉 ⇒ 否定断言假红 (本轮实测踩过)。 */
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
    if (c === '/' && canStartRegex()) {
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

async function main() {
  console.log('== check_world_ledger @ ' + BASE + ' ==\n');

  /* 1. 当前世: 幂等 + 形态 */
  const c1 = await getJson('/api/world/current');
  check('1a GET /api/world/current 返回 JSON (200)',
    c1.status === 200 && c1.json !== null, 'status=' + c1.status + ' body=' + c1.text.slice(0, 120));
  const cur = c1.json || {};
  check('1b 当前世字段齐备 (round/seed/bornAt/persisted/kind)',
    Number.isInteger(cur.round) && cur.round >= 1 && SEED_RE.test(String(cur.seed)) &&
    Number.isFinite(cur.bornAt) && typeof cur.persisted === 'boolean' && cur.kind === 'current',
    JSON.stringify(cur));
  const c2 = await getJson('/api/world/current');
  check('1c 连续两次 current **完全一致** (幂等: 刷新不掉世, 多端同世界)',
    c2.json && c2.json.round === cur.round && c2.json.seed === cur.seed &&
    c2.json.bornAt === cur.bornAt,
    JSON.stringify(c2.json));

  /* 2. 历史列表 */
  const l1 = await getJson('/api/world/list?n=50');
  const rounds = (l1.json && l1.json.rounds) || [];
  check('2a GET /api/world/list 返回轮次表 (含当前世在首位)',
    l1.status === 200 && rounds.length >= 1 && rounds[0].round === cur.round &&
    rounds[0].seed === cur.seed, JSON.stringify(rounds[0] || null));
  let desc = true;
  for (let i = 1; i < rounds.length; i++) if (rounds[i].round >= rounds[i - 1].round) desc = false;
  check('2b 轮次降序排列', desc, rounds.map((r) => r.round).join(','));
  const seeds = rounds.map((r) => r.seed);
  check('2c 历史种子互不重复 (轮次是唯一的, 世界不会撞)', new Set(seeds).size === seeds.length);
  check('2d total == rounds.length (在 n 足够大时)',
    rounds.length === 50 ? true : l1.json.total === rounds.length,
    'total=' + (l1.json && l1.json.total) + ' len=' + rounds.length);

  /* 3. /stats 对账 */
  const st = await getJson('/api/map/stats');
  check('3a /api/map/stats 的 worldRounds 与台账 total 一致 (对账口)',
    st.json && st.json.worldRounds === l1.json.total && st.json.ledgerPersisted === l1.json.persisted,
    JSON.stringify({ r: st.json && st.json.worldRounds, t: l1.json.total, p: st.json && st.json.ledgerPersisted }));

  /* 4. 另启一世 */
  const n1 = await getJson('/api/world/next', 'POST');
  const nw = n1.json || {};
  check('4a POST /api/world/next 返回新一世 (kind=next)',
    n1.status === 200 && nw.kind === 'next' && Number.isInteger(nw.round), JSON.stringify(nw));
  check('4b 轮次严格 +1', nw.round === cur.round + 1, cur.round + ' → ' + nw.round);
  check('4c 新种子 ≠ 旧种子 且形态一致',
    nw.seed !== cur.seed && SEED_RE.test(String(nw.seed)), JSON.stringify([cur.seed, nw.seed]));
  check('4d bornAt 单调不倒退', nw.bornAt >= cur.bornAt, cur.bornAt + ' → ' + nw.bornAt);

  /* 5. 台账当前世已前进 */
  const c3 = await getJson('/api/world/current');
  check('5a next 之后 current 就是刚开的那一世 (落库生效)',
    c3.json && c3.json.round === nw.round && c3.json.seed === nw.seed,
    JSON.stringify(c3.json));
  const l2 = await getJson('/api/world/list?n=50');
  check('5b list 里能查到刚开的一世 (历史只增不减: 台账不被缓存清理任务删掉)',
    (l2.json.rounds || []).some((r) => r.round === nw.round && r.seed === nw.seed),
    'total ' + l1.json.total + ' → ' + l2.json.total);

  /* 6. 新种子**真能开界**: 用它问 meta, 服务端必须照常给几何/色板 */
  const meta = await getJson('/api/map/meta?seed=' + encodeURIComponent(nw.seed));
  const mj = meta.json || {};
  check('6a 新种子可用 (GET /api/map/meta?seed=<新种子> 返回几何)',
    meta.status === 200 && typeof mj.hexW === 'number' && mj.hexW > 0 && !!mj.engineHash,
    'status=' + meta.status + ' hexW=' + mj.hexW);

  /* 7. 前端接线 (静态): 种子只能"领", 不能"造" */
  const html = await (await fetch(BASE + '/index.html', { cache: 'no-store' })).text();
  check('7a index.html 引了全局存储组件 store.js 且在 main.js 之前',
    html.includes('js/store.js') && html.indexOf('js/store.js') < html.indexOf('js/main.js'));
  check('7b 右上角只剩齿轮 + 设置弹窗挂载点',
    html.includes('id="btnGear"') && html.includes('id="settingsWrap"'));
  check('7c 手输种子 / 山河重铸 的控件已从页面移除',
    !html.includes('id="seedInput"') && !html.includes('id="btnSeed"'));
  const mainRaw = await (await fetch(BASE + '/js/main.js', { cache: 'no-store' })).text();
  const mainJs = stripComments(mainRaw);
  check('7d main.js 只向 /api/world/* 领种子 (不再 Date.now() 造)',
    mainJs.includes('/api/world/current') && mainJs.includes('/api/world/next') &&
    !/Date\.now\(\)\s*%\s*100000000/.test(mainJs));

  console.log('\n========== 结果: ' + (failures ? failures + ' 项失败' : '全部通过 ✔') + ' ==========');
  console.log('（本脚本会真实开一世: 当前已到第 ' + (c3.json ? c3.json.round : '?') + ' 世 · 种子 ' +
    (c3.json ? c3.json.seed : '?') + '）');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('  FAIL 运行异常: ' + (e && e.message));
  console.log('\n========== 结果: 1 项失败 ==========');
  process.exit(1);
});
