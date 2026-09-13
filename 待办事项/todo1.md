# TODO1 · 道路生成修复收尾（未完成任务）

> 生成时间：2026-09-13。对应 memory：`.workbuddy/memory/2026-09-13.md` 末节。
> 背景：DI 拒绝边无限循环修复已完成并用 w3_bfs_road 全绿验证（冷建 -39%，峰值 239ms）。
> 以下为**遗留待办**，留待后续会话与用户确认后动手。

## 1. 热跑回退 +23%（主候选）
- 现象：路网全建好后重扫 141 格区域，耗时 7298→6207ms，比改动前 5052ms 慢 23%。
- 根因：冷建阶段 617 次主循环 A* 中 **226 次(37%)注定失败** —— 需求池 5×5 允许端点相距约 70 格，
  远超复用模式可达上限 COST_MAX÷ROAD_W_ROAD = 60 步；每条边每遍都被重新 A*（roadFailTrials 只看次数、不看路网变更）。
- 候选方案：
  ① 主循环遇 roadFailTrials>=1 且 roadVer 未变时跳过；
  ② 需求边入图时按 hexDist 预筛（超预算的直接不入图）。

## 2. cq/cr 排序无剪枝
- 「由内向外」两层排序（预览页 buildRoadQueue / 引擎 demandEdgesFor）都存在，
  但 cq/cr 只参与排序，不带剪枝或预算约束，「当前视野」没变成工作量约束。
- 目标：让「视野内优先」成为真正的调度语义（预算饥饿时先服务视野内）。

## 3. 既有 P0/P1/P2（引用"唯一清单"）
- 详见 `.workbuddy/memory/MEMORY.md` 底部「已核验 bug 唯一清单」共 58 条（P0 3 / P1 14 / P2 25 / P3 16）。
- 真 P0：tradeEdgesFor 窗口 ±1 而 reach=40 可跨 2 格 / JsEngineHost LRU 淘汰不查在途引用。
- 改引擎前务必先读该清单，勿重复挖已判「已修复/误报」项。

## 4. 峰值 seed 相关性（非本次引入）
- 峰值 258~342ms 随 seed 波动；PRE 本就有此现象，本次不视为回归，无需处理。

## 验证与工具
- 基准：verify/bench_road_drain.mjs [seed] [半径] —— 泵送复刻 + drain A* 计数；
- 峰值：verify/bench_road_peak.mjs [seed] [半径] —— 逐格耗时+A* 次数归因；
- 改动后需同步：Server/Zongmen/Engine/js/mapgen.js 与 灵脉预览.html 内联副本（sync_preview_inline.mjs）。

---
*本文件为跨会话 TODO；完成后勾选并留实施记录。*
