# 执行日志：背包与装备系统调研

> 类型 `research` ｜ 日期 `20261124`
> 会话记录，追加写，不改历史行。

## 会话 20261124

### Phase 1：澄清与确认　**Status: complete**
- **Started:** 20261124 20:06
- 动作：
  - 读 `Server/Zongmen/` 目录结构，确认 `Domain/` 只有 `MapMessages.cs`，无物品/背包模型
  - 读 `web/js/` 目录，确认前端是 Canvas 渲染 + `pb.js` 手写 protobuf 解码
  - 读 `docs/design/20261119/findings.md`（原名 `docs/修仙版X4经济_结构映射与最小闭环.md`，20261124 已按规范迁移）前 60 行，确认项目既有经济设定（修士=舰船、灵石=货币+燃料）
  - 确认可复用：SQLite/WAL 存储、protobuf 协议、`/api/map/meta` 配置下发模式

### Phase 2：外部调研　**Status: complete**
- **Started:** 20261124 20:07
- 动作（4 轮检索）：
  - 检索「修仙 宗门模拟器 背包 储物戒 格子」→ 命中《我要当老祖》6×7 棋盘、《我是掌门》背包即战场、VGTip 储物戒 500/1000 格扩容
  - 检索「grid inventory 100 slots stackable upgrade」→ 命中 xslab 双表模型文章、叁省网 100 格 10×10 设计文档、Unity ScriptableObject 背包、UE5 Hyper Slot Inventory
  - 检索「RPG 装备栏 部位 数量 上限」→ 命中独游魔盒经验区间表、《剑与魔法王国》105 格装备栏、KC:D 16 层叠、RPGHQ 槽位数讨论
  - 检索「修仙 法宝 装备上限 念力」→ 命中《鬼谷八荒》念力→法宝 5 个 + 装备栏 3/战斗道具 5、《了不起的修仙模拟器》12~18 件两段式
  - 检索「open source inventory C# .NET」→ 命中 TheChest、Micky5991、xFedeT/RPGInventory、Rucksack
  - 检索「party shared vs per-character inventory」→ 命中 PoE stash 讨论、Darkest Dungeon 16 格反面案例

### Phase 3：选型与结论　**Status: complete**
- **Started:** 20261124 20:08
- 动作：
  - 定背包模型 = 定长 slot 数组（否掉列表/重量/棋盘制，理由见 findings 2.1）
  - 定装备限额 = 固定 5 部位 + 神识驱动 N + 符箓 3 三层叠加（findings 2.2）
  - 定数据模型 = `ItemDef` / `ItemInst` 双表 + `Container` 复用（findings 2.3）
  - 定三个实现级坑的规则：扩容只追加、换装原子预占、堆叠升序扣减（findings 三）
  - 拆 P0~P3（findings 四）

### Phase 4：验证与交付　**Status: in_progress**
- **Started:** 20261124 20:09
- 动作：
  - **发现落盘位置错误**：初版写在 `docs/背包与装备系统-调研.md`，违反 `plan-with-file` 的 `docs/<类型>/YYYYMMDD/` 规范
  - 用技能脚本初始化 `docs/research/20261124/` 三件套（脚本输出的三个绝对路径已核对）
  - 原文档内容迁入 `findings.md`，计划拆进 `task_plan.md`，本文件为日志
  - 删除旧文件 `docs/背包与装备系统-调研.md`（untracked，用 Node `fs.unlinkSync` 绝对路径）
- 创建/修改的文件：
  - `docs/research/20261124/task_plan.md`（新建，含 6 个待拍板问题）
  - `docs/research/20261124/findings.md`（新建，调研全文 + 20 条来源链接）
  - `docs/research/20261124/progress.md`（本文件）
  - `docs/背包与装备系统-调研.md`（已删除，内容无损失迁移）

## 测试结果

| 测试 | 输入 | 预期 | 实际 | 结论 |
|------|------|------|------|------|
| 三件套存在性 | `ls docs/research/20261124/` | 3 个 .md | 3 个 .md | 通过 |
| 旧文件已清 | `ls docs/*.md` 查「背包与装备系统-调研」 | 不存在 | 不存在 | 通过 |
| 内容完整性 | `findings.md` 行数 vs 原文档 | 不减少章节 | 7 大节全在，另加 20 条 URL 表 | 通过 |

## 错误日志

| 时间 | 错误 | 第几次 | 处理 |
|------|------|--------|------|
| 20261124 20:06 | 调研文档落盘位置错误（`docs/` 根目录） | 1 | 迁移到 `docs/research/20261124/findings.md`，原文件删除，内容按三件套重新分工 |
| 20261124 20:09 | `Write` 覆盖 findings.md 被拒（"File has not been read yet"） | 1 | 先 `Read` 读出模板再 `Write`，未原样重试 |

## 换会话恢复自检

| 问题 | 答案 |
|------|------|
| 现在在哪个阶段 | Phase 4（验证与交付），等用户答复 6 个待拍板问题 |
| 还剩哪几步 | ① 用户拍板 6 项 → ② 另建 `docs/plan/YYYYMMDD/` 写 P0~P3 实施单 → ③ 开始写 `Container` 代码 |
| 目标是什么 | 摸清「小队共享储物戒 + 每人装备队列」的成熟解法，产出可据此拆实施单的选型结论 |
| 学到了什么 | 见 `findings.md`（产品 9 例、开源 5 个、模型 4×4 对比、3 个实现坑、P0~P3 拆分） |
| 做了什么 | 见本文件上方 Phase 1~4 |
