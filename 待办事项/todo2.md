# todo2 — 未完成任务清单（2026-09-13 20:36 汇总）

> 来源：本轮会话（灵脉预览附属建筑偏左下角修复）+ 道路网遗留问题。
> 已完成部分详见 `.workbuddy/memory/2026-09-13.md`。

## A. 附属建筑偏左下角修复 —— 收尾（本轮主线）

状态：引擎改动已落地、预览已同步、语法已校验；剩收尾。

- [ ] **A1. 前后对照图确认视觉效果**
  - `node verify/_dbg_town_page.mjs 0.92 verify/_out_after.html city` → `shot.mjs` 截图 → `crop_png.mjs` 放大城镇区域
  - 旧版图已删（验收依据改为对拍量化结论 + 新图目检）
- [ ] **A2. 全量回归**
  - `verify_map` + `w3_bfs_road`(12 项) + `frontend_smoke` + `check_preview_settle_road` 全绿
  - 注意：改引擎 js 后服务端不热加载，需重启；chunk 载荷变则清 `db/zongmen.sqlite*`
- [ ] **A3. 决策：spreadPick 是否推广到生产前端**
  - 目前只改了引擎生成侧；`web/js/main.js` 的 `drawBuildings()` 画的是生成结果，理论自动受益，但需实机确认
- [ ] **A4. 清理诊断脚本**
  - 验收通过后删 `verify/_dbg_{inline_diff,town_ab,town_geom,town_page}.mjs`
  - ⚠ 按 MEMORY.md 规矩：Node fs.unlinkSync 绝对路径 + 数量断言，禁 shell 通配/git rm

## B. 道路网已知病灶（上轮遗留，需拍板）

- [ ] **B1. 热跑回退 +23%**：主循环 37% A\* 注定失败（需求池 5x5 端点距 ~70 格 > 复用可达 60 步），roadFailTrials 不看路网是否变过。候选：①trials≥1 且 roadVer 未变跳过；②需求边入图按 hexDist 预筛
- [ ] **B2. cq/cr 只参与排序不带预算约束**——「当前视野」未变成工作量约束（预览页 buildRoadQueue / 引擎 demandEdgesFor 两层）
- [ ] **B3. MEMORY.md「唯一清单」P0 3 条 / P1 14 条**（改引擎前先读 review.md，别重复挖已判「已修复/误报」项）

## C. 预览页遗留（历史）

- [ ] **C1. `灵脉预览.html` 仍是 LANDUSE_COL 六边+方块芯，未接实时建筑绘制（bldg_ink）**
- [ ] **C2. 稀有 7 种建筑缩远被 `hexR*z<5px` 一刀切隐藏**
- [ ] **C3. 生产前端 `web/js/main.js` 尚未在地图画 footprint**
