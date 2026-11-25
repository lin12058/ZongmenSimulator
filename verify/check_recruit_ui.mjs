/* ============================================================
 * check_recruit_ui.mjs — 招募面板「离线能查的那一半」源码守卫
 * ------------------------------------------------------------
 * 分工 (别重复):
 *   check_recruit_pool.mjs     池子/生成器 (纯 JS, 不起服务)
 *   check_recruit_api.mjs 四端点 (HTTP)
 *   check_recruit_e2e.mjs  真浏览器点按钮 (headless Chrome)
 *   **本文件**             「接线」与「口径」——浏览器探针够不到的部分:
 *                          script 顺序 / 入口按钮 / 不硬编码常量 / id 冲突
 *
 * 断言分组:
 *   A. index.html 引入顺序 (recruit-bridge 在 crew-bridge 之后, 面板在 main.js 之前)
 *   B. window.RecruitPanel 的对外面 (main.js 只认 open/close/isOpen)
 *   C. 山川志入口: 只在非 poi 上出现, 点击 → open + 收起山川志
 *   D. 不硬编码 30/50/300/10 (影响力上线后写死的界面会立刻说谎)
 *   E. 新建小队链路闭合 (__new ↔ newSquad)
 *   F. 招完人不擦提示 (load(true)) + 刷新队伍面板
 *   G. CSS: 层级高于众生录(74)/山川志(45); 遮罩满屏; 入口按钮有样式
 *
 * 用法: node verify/check_recruit_ui.mjs      rc=0 通过
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { pass++; console.log('PASS ' + name + (info ? ' · ' + info : '')); }
  else { fail++; console.log('FAIL ' + name + (info ? ' · ' + info : '')); }
}

const html = read('web/index.html');
const panel = read('web/js/recruit/recruit-panel.js');
const bridge = read('web/js/recruit/recruit-bridge.js');
const css = read('web/js/recruit/recruit-panel.css');
const main = read('web/js/main.js');

const at = (src, needle) => src.indexOf(needle);

/* ---------------- A. 引入顺序 ---------------- */
const iCss = at(html, 'js/recruit/recruit-panel.css');
const iBri = at(html, 'js/recruit/recruit-bridge.js');
const iPan = at(html, 'js/recruit/recruit-panel.js');
const iMain = at(html, 'js/main.js');
const iCrew = at(html, 'js/crew/crew-bridge.js');
ok('A1 三件套都被 index.html 引入', iCss > 0 && iBri > 0 && iPan > 0);
ok('A2 面板与网络层都在 main.js 之前', iPan > 0 && iPan < iMain && iBri < iMain,
  'bridge@' + iBri + ' panel@' + iPan + ' main@' + iMain);
ok('A3 recruit-bridge 排在 crew-bridge 之后 (招完人要调 CrewBridge.autoMount)',
  iCrew > 0 && iCrew < iBri, 'crew@' + iCrew + ' recruit@' + iBri);
ok('A4 CSS 只引一次', html.split('recruit-panel.css').length === 2);
ok('A5 没有重复引 script', html.split('src="js/recruit/recruit-bridge.js"').length === 2 &&
  html.split('src="js/recruit/recruit-panel.js"').length === 2);

/* ---------------- B. 对外面 ---------------- */
ok('B1 暴露 window.RecruitPanel', /(window|g)\.RecruitPanel\s*=/.test(panel));
for (const fn of ['open', 'close', 'isOpen', 'reload', 'probe']) {
  ok('B2 导出 ' + fn + '()', new RegExp('\\b' + fn + '\\s*:').test(panel.slice(-1800)), fn);
}
ok('B3 main.js 只调 RecruitPanel.open (不自己渲染卡片)',
  /RecruitPanel\.open\(/.test(main) && !/rc-card/.test(main));
/* ⚠ DOM 句柄别叫 st —— 保留名 (见 DETAILS「前端 UI 边界」) */
ok('B4 DOM 句柄没占用保留名 st', !/\bst\s*=\s*document\.getElementById/.test(panel));

/* ---------------- C. 山川志入口 ---------------- */
/* 入口必须是「非 poi 且是本格实体」才有 —— 秘境不招人 */
ok('C1 infoRowsHTML 里输出招募按钮',
  /if \(hit && hit\.ent && hit\.ent\.type !== 'poi'\) \{[\s\S]{0,400}info-recruit/.test(main));
ok('C2 按钮带聚落 id (data-recruit) 与名字 (data-rcname)',
  /data-recruit=/.test(main) && /data-rcname=/.test(main));
/* 委托: 从文件里**最后**一处 data-recruit 往后看 —— 那是事件监听, 前面的是按钮模板 */
const deleg = main.slice(main.lastIndexOf('data-recruit'));
ok('C3 点击委托调 RecruitPanel.open 并收起山川志',
  /RecruitPanel\.open\(/.test(deleg) && /hideInfo\(\)/.test(deleg),
  deleg.split('\n').slice(0, 3).join(' / ').slice(0, 80));
ok('C4 面板未加载时不崩 (有判空 + 提示)', /window\.RecruitPanel && window\.RecruitPanel\.open/.test(deleg));

/* ---------------- D. 不硬编码业务常量 ---------------- */
/* 允许的例外: z-index / px / ms / 数值区间夹断 / parseInt 的进制 10 */
const bad = [];
for (const [name, src] of [['recruit-panel.js', panel], ['recruit-bridge.js', bridge]]) {
  src.split('\n').forEach((line, i) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('*') || raw.startsWith('/*') || raw.startsWith('//')) return;
    const s = raw.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
      .replace(/,\s*10\s*\)/g, ')')                    // parseInt(.., 10)
      .replace(/\b\d+\s*px\b/g, '')
      .replace(/z-index:\s*\d+/g, '');
    if (/\b(300|50|30|10)\b/.test(s)) bad.push(name + ':' + (i + 1) + ' ' + s.slice(0, 70));
  });
}
ok('D1 面板/网络层不出现硬编码的 30/50/300/10', bad.length === 0, bad.slice(0, 4).join(' | '));
ok('D2 点数字段一律从响应读 (rollCost / hireCost / value / cap)',
  /rollCost/.test(panel) && /hireCost/.test(panel) && /\.cap\b/.test(panel));

/* ---------------- E. 新建小队链路 ---------------- */
ok('E1 浮层有「新建小队」项且用哨兵值 __new', /data-rc-squad="__new"/.test(panel));
ok('E2 哨兵被识别成 newSquad:true', /'__new'/.test(panel) && /newSquad:\s*true/.test(panel));
ok('E3 跳过哨兵后再传给 bridge', /forceNew \? '' :/.test(panel));
ok('E4 传空 id 时不带 squadId (服务端自选)', /if \(squadId\) body\.squadId/.test(bridge));
ok('E5 已有队时置灰「不在本镇/满员」的队', /!s\.here \|\| full/.test(panel));

/* ---------------- F. 招完人不擦提示 ---------------- */
ok('F1 load(keepMsg) 支持保留提示', /function load\(keepMsg\)/.test(panel) &&
  /if \(!keepMsg\) st\.msg = ''/.test(panel));
ok('F2 doHire 成功后 load(true)', /load\(true\)/.test(panel));
ok('F3 招完人刷新队伍面板 (CrewBridge.autoMount)', /CrewBridge/.test(panel) && /autoMount/.test(panel));

/* ---------------- G. CSS 层级与入口样式 ---------------- */
const z = (css.match(/#recruitWrap\s*\{[^}]*z-index:\s*(\d+)/) || [])[1];
ok('G1 面板 z-index 高于众生录 74 / 山川志 45', z && +z > 74, 'z=' + z);
ok('G2 外层 fixed 满屏 + 遮罩 inset:0 (点外面也能关)',
  /#recruitWrap\s*\{[^}]*position:\s*fixed/.test(css) && /#recruitWrap\s*\{[^}]*inset:\s*0/.test(css) &&
  /\.rc-mask\s*\{[^}]*inset:\s*0/.test(css));
ok('G3 山川志入口按钮有样式', /#infoBody\s+\.info-recruit/.test(css));
ok('G4 候选列表自己滚 (面板不超高)', /\.rc-list\s*\{[^}]*overflow/.test(css));
ok('G5 已入宗门/置灰有可辨识样式', /\.rc-card\.taken/.test(css) && /\.rc-hire\.off|\.rc-btn\.off/.test(css));

/* ---------------- H. id 唯一 (别和别的面板撞) ---------------- */
const ids = [...panel.matchAll(/id="([a-zA-Z][\w-]*)"/g)].map(m => m[1]);
const dupInPanel = ids.filter((v, i) => ids.indexOf(v) !== i);
ok('H1 面板内 id 不重复', dupInPanel.length === 0, [...new Set(dupInPanel)].join(','));
const otherIds = new Set();
for (const f of ['web/js/main.js', 'web/js/crew/crew-panel.js', 'web/js/roster.js',
                 'web/js/infocard.js', 'web/index.html']) {
  let src = '';
  try { src = read(f); } catch { continue; }
  for (const m of src.matchAll(/id="([a-zA-Z][\w-]*)"/g)) otherIds.add(m[1]);
}
const clash = [...new Set(ids.filter(v => otherIds.has(v)))];
ok('H2 与既有 DOM id 不撞车', clash.length === 0, clash.join(','));

console.log('\n== ' + pass + ' PASS / ' + fail + ' FAIL ==');
process.exit(fail ? 1 : 0);
