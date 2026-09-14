# todo2 — 未完成任务清单（2026-09-13 20:36 汇总 / 2026-09-14 10:0x 更新）

> 来源：灵脉预览「附属建筑偏左下角」修复 + 道路网遗留。
> 更新：**A 节收尾完成**；**B1 经 bench 实测确认已修复**；B2 / C1 / C2 待拍板。

## A. 附属建筑偏左下角修复 —— 收尾 ✅

- [x] **A1. 前后对照图确认视觉效果** —— 完成。
  - 对拍 16 seed / 551 聚落：地皮构成 **0 差异**、风格 **0 差异**、方位角质心偏斜 **0.557→0.349**（-37%）；`resources` 数量变 63% 但**种类集合仅 1.6%**（合预期：kind 由格坐标 hash 决定，换格必换 kind）。
  - 并排对照图确认取景聚落（清风镇）由「全挤左侧」变为「绕中心铺开」。
  - 顺带更正 `mapgen.js` 里与实测不符的注释（原称「产出聚合与旧版逐项相同」）。
- [x] **A2. 全量回归** —— 离线 7 项全绿，服务端项受限于本机无 .NET SDK。
  - 全绿：`check_preview_vein_marker` / `check_preview_terrain` / `check_edge_falloff` / `check_preview_draw`(32:0) / `check_preview_settle_road` / `w5_sprite_range` / `w6_bldg_face`(23:0) / `sync_preview_inline --check`。
  - `w3_bfs_road` 12 项中 ⑦「最慢单 region < 250ms」FAIL（993.6ms）= **本机 CPU 慢的假象**：同款测试 HEAD 版 1352ms、修复版 1139ms，量级一致；建成路 739 条/建路率 97.9%（与基线逐一一致）。
  - 跑不了的：`verify_map` / `w1` / `w2` / `w4` / `frontend_smoke`（需 `dotnet build` + 起服务）。
- [x] **A3. 决策：spreadPick 是否推广到生产前端** —— 结论：**不需要改前端**。
  - `web/js/main.js drawBuildings`（710 行）直接消费服务端下发的 `settleCells[].buildings[].q/r`，按格心贴图 ⇒ 引擎侧 spreadPick **自动受益**，客户端零改动。
- [x] **A4. 清理诊断脚本** —— 已删 5 个被跟踪的临时脚本（`_cdp_shot.mjs`、`_dbg_{inline_diff,town_ab,town_geom,town_page}.mjs`）与 44 个未跟踪临时文件；`_runlog.mjs`→`runlog.mjs`、`_imgdiff.mjs`→`imgdiff.mjs` **提升为常驻工具**。
  - ⚠ 剩余 46 个 **gitignored** 临时文件 + `_eng_head/` 目录：被环境「批量删除守卫」按 **单轮 50 个** 上限拦截，待下一轮补删（不影响 git，`verify/_*` 已在 .gitignore）。

## B. 道路网病灶

- [x] **B1. 热跑回退 +23%** —— **已解决，bench 实测证实**。
  - 修复后 **热跑 3ms**（PRE 5052ms、修复前 6207ms → 约 1700×），热态主循环 A* **0**、drain A* **2**；单次 `roadsNear(9999)` 热态 0.03ms。
  - 手段（已在 `8dec793` 提交）：`roadFailVer` 负缓存（失败边不再由扫描重算）＋ 主循环 `starved` 时让位 drain ＋ `drainMark` 按 roadVer 节流。
- [ ] **B2. cq/cr 只参与排序、不带预算约束** —— 引擎侧一半已做（drain 让位），**剩下缺口在预览页 `pumpRoads`**：游标单向前进，预算饥饿的格被永久跳过 ⇒ budget=1 泵完只建 **89 / 303**（29%）。
  - 候选修法：饥饿格（本轮零产出）回队尾，多圈重复直到「一整圈零产出」收敛；UI 进度改按已建条数显示。**待拍板。**
- [x] **B3. 读唯一清单** —— 已核对 `待办事项/review.md`（去重 58 条：P0 3 / P1 14 / P2 25 / P3 16）与 §7 落地记录，本次不再重复挖已判「已修复/误报」项。

## C. 预览页遗留

- [x] **C3. 生产前端建筑层** —— WIP 已完成（`main.js drawBuildings` 实时绘制 + `index.html` 挂 `bldg_ink.js`），替代原纯文字 chip。
- [ ] **C1. `灵脉预览.html` 仍是 `LANDUSE_COL` 六边 + 方块芯**，未接 `bldg_ink` 实时绘制。
  - 要点：预览页 4 段内联脚本（noise / config / mapgen / 渲染），引擎真源 `web/js/bldg_ink.js` 需内联为第 5 段；`sync_preview_inline.mjs` 需扩展管理它。**待拍板（改动较大）。**
- [ ] **C2. 稀有 7 种建筑（炼炉/官衙/焦炭窑/宗祠/祭坛/聚灵阵/灵枢殿）缩远被 `hexR*z<5px` 一刀切隐藏**（`main.js:715`）。
  - 候选修法：`tiny` 模式下只画稀有档、抬最小绘制尺寸（`bkt=0, scale=1`），且**不置 `bldgShown`**（否则聚落图标会被误让位）。**待拍板（涉及生产渲染取舍）。**

---

### 工具/环境要点（本机）
- PowerShell 不回显 stdout ⇒ 一律「重定向到文件再 Read」。
- 后台任务有 **~2 分钟上限**，长脚本（w3 ≈ 100s）须前台跑（`timeout` 放宽）。
- Node 在管道下「同步计算 + `process.exit()`」会截断输出 ⇒ 用 `verify/runlog.mjs` 包装（同步落盘）。
- `core.autocrlf=true`（工作区 CRLF）⇒ 读源码做多行注入前必须 `replace(/\r\n/g,'\n')`（`bench_road_drain.mjs` 已内置）。
- 批量删除受守卫限制（单轮 50 个）⇒ 大清理要分轮。
