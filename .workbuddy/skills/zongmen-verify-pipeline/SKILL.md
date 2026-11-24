---
name: zongmen-verify-pipeline
description: 宗门模拟器（C# .NET 8 + ClearScript V8 服务端 + WebGL 前端）的验证与踩坑管线：起隔离实例跑回归、写/改判据（check_*.mjs）、源码守卫与仓库卫生、协议层/图层/子系统接入、前端表现层与 headless 截图验收、Tick 框架与城市演化。触发场景：跑回归、写判据、验收、算验收姿势、verify、check_*.mjs、隔离实例、源码守卫、headless 截图、run_regression、frontend_smoke、Tick 验证。
agent_created: true
---

# 宗门模拟器 · 验证与踩坑管线

> **入口文件**。2026-10-11 由 133KB 单文件压缩而来 —— 这里只留「每次都会用到的速查」，
> 细节按主题进 `references/`。章节号**沿用原编号** ⇒ 各文件里「见 §32」这类交叉引用照旧有效。

## 0. 路由：按你要动的东西查

| 你要做的事 | 去读 |
|---|---|
| 起/停隔离实例、跑 `run_regression`、离线回归清单、本机环境与 shim 坑 | `references/00-跑法与验收骨架.md`（§4-8 · §13 · §20-22） |
| 写或改判据 `check_*.mjs`、假红归因、A/B 档位、判决实验、采样与断言方法学 | `references/10-判据方法学.md`（§23-25 · §31-35 · §37 · §41-42 · §44） |
| 源码守卫写法、git 与仓库卫生、误删恢复、新增全局状态的连带影响 | `references/20-源码守卫与仓库卫生.md`（§10 · §26 · §36 · §39） |
| 新增图层/协议字段、世界种子台账、把 Node 生成器接成 C# 子系统 + 端点 | `references/30-协议图层与子系统接入.md`（§11 · §12 · §38 · §45） |
| 前端表现层、小地图、手机档、响应式几何、配色/皮肤契约 | `references/40-前端与表现层.md`（§9 · §14-19 · §27-30 · §40） |
| Tick 框架、世界时钟、城市演化、时间调度与组合根装配 | `references/50-Tick与演化.md`（§43 · §46） |

**§43 与 §46 是最贵的两节**（Tick 验证姿势、判据环境 ≠ 生产组合根），碰 Tick 前先读。

## 1. 三条红线（每轮都适用）

1. **清文件**：先 `git ls-files` 过滤掉被跟踪名单，再用 Node `fs.unlinkSync` **绝对路径**删，
   带 basename/数量断言。**禁 shell 通配符与 `git rm`** —— `verify/` 已误删 **3 次**，
   且 `verify/_*` 被 `.gitignore` 忽略 ⇒ **删后不可恢复**。（§26.1）
2. **`git push` 必加** `-c http.proxy= -c https.proxy=`：本机 `127.0.0.1:7897` 无进程 ⇒ Connection refused。
   push 挂起无输出 = GitHub 弹窗没人点（让用户点一下）；快速 schannel 报错 = 真 TLS 问题（换 `http.version=HTTP/1.1`）。（§10）
3. **后台实例活不过一个回合** ⇒ 「起实例 + 跑实机判据」必须放**同一个回合**；跨回合先 `net.connect` 探活。
   ⚠ **绝不 kill 用户的 8140**。（§35.3）

## 2. 判据四防 + 一条「必须有牙」

1. **绝对值阈值必假红** ⇒ 改成 A/B 归因（先问「这个量在旧路径上是多少」）。（§31.1）
2. **参照系不能是被测规则自己的目标函数** ⇒ 换一个「没有任何候选能优化」的量（几何中位数 / 包围盒中心）。（§32）
3. **复算须与实现同容差语义**（如 `k < bk - 1e-9` 的滚动比较）—— 2e-13 的尾数就能翻案。（§32.1）
4. **源码守卫判「赋值点所在的整个函数体」**（按缩进定界，别做花括号配对），且**先剥注释**；
   ⚠ 去注释器必须认识**正则字面量**（`/[&<>"]/g` 会把状态搞错位）。（§41.E · §43.B · §36）
5. **反向对照（有牙的证明）**：改完把**改前**的版本临时换回去再跑一次，**必须红**；
   跑完按 `sha256` 核对还原。只证明「改后是绿的」等于什么都没证明。**读-改-跑-还原一律 `try/finally`**。（§28 · §41.E）

## 3. 本机环境（会静默误事的）

- **一律用 `$HOME`，别写死用户名**；仓库 = `D:/codes/ZongmenSimulator`。
- 三件套绝对路径：
  - node `$HOME/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`
  - python `$HOME/.workbuddy/binaries/python/versions/3.13.12/python.exe`（内建 `sqlite3`；本机**无** sqlite3 CLI）
  - dotnet `$HOME/.dotnet/dotnet`（SDK 8.0.425，**不在** `C:/Program Files/dotnet/`）；git `C:/Program Files/Git/cmd/git.exe`
- ⚠ **bash shim 缺命令**：`ls / head / tail / cat / cp / cd / dirname / wc / grep / sleep`。
  · 读文件用 Read/Grep 工具；**等待**用 `node -e "setTimeout(()=>…,N)"`；复制用 `node -e "fs.copyFileSync"`。
  · ⚠ `… | tail -25` 会让**整条命令 stdout 全空**（管道断在第一段）—— 那不是「命令没跑」。
  · `grep` 无匹配返回 1 ⇒ 放 `&&` 链中间会断链。
- ⚠ **别用 `node -e "…"` 内联含反引号/反斜杠/`$` 的脚本**（bash 会做命令替换，内容被静默吞掉，已踩 3 次）
  ⇒ 多行或有特殊字符一律**先 Write 临时脚本再 `node <file>`**（Write 不走 shell）。
- ⚠ 本机 `HTTP_PROXY=127.0.0.1:9105` 会劫持内网请求 ⇒ curl 加 **`--noproxy "*"`**；`run_regression` 内部已自动清代理。
- 长输出**写盘再 Read**（终端工具可能不回显 stdout）。

## 4. 常用命令

```bash
N="$HOME/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"

# 离线全量回归（默认 18 条离线 + 4 条 live；--offline-only / --base= / --only= / --skip= / --list）
"$N" verify/run_regression.mjs
# ⚠ --only/--skip 是子串匹配，逗号分隔无效 ⇒ 一次一个

# 单条判据
"$N" verify/check_tick_phase.mjs           # 离线：phase / lazy / queue_threadsafe / job_persist
"$N" verify/frontend_smoke.mjs             # 纯源码契约，不需要服务端

# 隔离实例（绝不碰用户 8140）—— 四步
dotnet build Server/Zongmen/Zongmen.csproj -o "D:\codes\ZongmenSimulator\Temp\srvA"   # ⚠ 必须 Windows 绝对路径
Zongmen__Port=8141 \
Zongmen__DbPath="D:/codes/ZongmenSimulator/Temp/dbNNN.sqlite" \
Zongmen__WebDir="D:/codes/ZongmenSimulator/web" \
Zongmen__EngineJsDir="D:/codes/ZongmenSimulator/Engine/js" \
Zongmen__Tick__ReconcileEveryTicks=15 \
"$HOME/…/Temp/srvA/Zongmen.exe" > Temp/runNNN.log 2>&1     # 必须 run_in_background，别用 &

# 停服：netstat + tasklist 两段式，按「端口归属的 PID + 镜像名」精确定位
#   C:/Windows/System32/netstat.exe -ano | grep -E ':8141\b' | grep -i listening
#   C:/Windows/System32/tasklist.exe /FI "PID eq <pid>" /FO CSV /NH  →  再 taskkill /F /PID <pid>
# ⚠ wmic 已被本机安全策略拉黑；⚠ 绝不用 taskkill /IM dotnet.exe
```

- ⚠ **必须显式放大 `Zongmen__MaxSeeds`**（默认 3）：live 判据每次用新 seed ⇒ 连跑三四轮就用满名额，
  症状是「`模块/快照 25s 内未就绪`」，看着像产品回归。查 `curl --noproxy "*" http://127.0.0.1:PORT/api/map/stats` 的 `liveSeeds`。（§22 第 0 条）
- ⚠ `dotnet build -o` 出来的是裸输出目录 ⇒ **必须显式给 `WebDir`/`EngineJsDir`**。（§46.B）
- ⚠ 改「保底/默认行为」前先想好「旧版本已落库的那份怎么办」。（§46.F）

## 5. 改完必跑（按改动面）

| 改了 | 必跑 |
|---|---|
| `Engine/js/*.js` | ① `node verify/sync_preview_inline.mjs --check` ② 重启服务端 ③ 载荷（chunk/comm/settle/road）变了 ⇒ 停服清 `db/zongmen.sqlite*` |
| 前端 `web/js/*` | `frontend_smoke.mjs`；改了 **CSS 几何** ⇒ 还要 `check_mm_layout.mjs`（CSS **不在**源码守卫内） |
| 手机档 / 触摸 / 配色 | `check_mm_ui.mjs` |
| 判据自身 | **反向对照**（改前必须红）+ 单跑复现（排除联跑抖动：Chrome 争用 / MaxSeeds 跑满） |
| Tick / 城市演化 | `check_tick_*.mjs` ×4 + `verify/evo/check_city_evo_integration.mjs` |
| 组合根 / 注册表 / hosted service | **必须起一次真实实例**读启动日志（判据架构上够不着这类事实）。（§46.A） |
| 协议层 / 新图层 / 新子系统 | 见 `references/30-…md` §11 / §45 的必挂清单 |

## 6. 全部章节索引

| 章 | 标题 | 文件 |
|---|---|---|
| §46 | 「判据全绿但实机报错」的新形态 + 隔离实例取证法 | 50-Tick与演化 |
| §45 | 把「Node 侧生成脚本」接成 C# 子系统 + HTTP 端点 | 30-协议图层与子系统接入 |
| §44 | Δ 拆分不变性 (f(state,dt)) 的判决实验姿势 | 10-判据方法学 |
| §43 | Tick 框架的验证姿势 + 七条新坑 | 50-Tick与演化 |
| §42 | 城市扩张 P2-α（附属城镇）验证姿势 + 六条新坑 | 10-判据方法学 |
| §41 | 玩家放置宗门 P0 的验证姿势 + 五条新坑 | 10-判据方法学 |
| §40 | 引擎加「几何特征」后表现层的第二处同源拷贝 | 40-前端与表现层 |
| §39 | 新增/改名「全局状态」与源码守卫的相互作用 | 20-源码守卫与仓库卫生 |
| §38 | 世界种子改由服务端产生 —— 改这类「注入点」必查清单 | 30-协议图层与子系统接入 |
| §37 | A/B 档位改造后，引用该表达式的判据要同步改 | 10-判据方法学 |
| §36 | 源码守卫的否定断言：去注释器必须认识正则字面量 | 20-源码守卫与仓库卫生 |
| §35 | 用户说「要中心点」时，别再把它解成统计量 | 10-判据方法学 |
| §34 | 数值探针优先：读不了 PNG 时的几何验收 | 10-判据方法学 |
| §33 | 「离群免疫」要的是恒等式，不是「更鲁棒」 | 10-判据方法学 |
| §32 | 判据的「参照系」不能是被测规则自己的目标函数 | 10-判据方法学 |
| §31 | 判据自己会「假红」：两类必须归因的断言 | 10-判据方法学 |
| §30 | 手机浏览器「算法暗化」→ 强制浅色 | 40-前端与表现层 |
| §29 | 手机触摸档：事件根本没绑 | 40-前端与表现层 |
| §28 | 响应式几何缺陷：「绝对定位收缩盒」+ 量盒才是唯一证据 | 40-前端与表现层 |
| §27 | 前端「配置真源」的契约验证（灵脉配色范式） | 40-前端与表现层 |
| §26 | 工作区事故与仓库卫生（`verify/` 误删、漏跟踪审计、安全暂存删除） | 20-源码守卫与仓库卫生 |
| §25 | 改核心源码的手法：断言式补丁脚本 | 10-判据方法学 |
| §24 | 引擎改动的正确性验证：顺序无关性 harness | 10-判据方法学 |
| §23 | 判定「失败是不是回归」—— 引擎/前端副本 A/B | 10-判据方法学 |
| §22 | 服务端回归 —— 起隔离实例（绝不动用户的 8140） | 00-跑法与验收骨架 |
| §21 | 离线回归清单 + 批量驱动 | 00-跑法与验收骨架 |
| §20 | 本机环境前提（两条会误事的） | 00-跑法与验收骨架 |
| §19 | 小地图粗层「椒盐感」：金字塔多数表决 | 40-前端与表现层 |
| §18 | 小地图「面板档倍率」与主相机联动 | 40-前端与表现层 |
| §17 | 小地图地形层：抽样格必须「世界对齐」 | 40-前端与表现层 |
| §16 | 小地图灵脉化：独立模块 + 全 WS 数据 | 40-前端与表现层 |
| §15 | 「聚落 ↔ 灵脉」间距 与「点选标记」缩放 | 40-前端与表现层 |
| §14 | 「场地」表现与聚落形态的改法 | 40-前端与表现层 |
| §13 | 十一版新增离线回归脚本（不必起服务） | 00-跑法与验收骨架 |
| §12 | 两个跨机 / 打包类经验（u16 复合打包、CRLF、反引号） | 30-协议图层与子系统接入 |
| §11 | 新增协议层/图层时的必查项 | 30-协议图层与子系统接入 |
| §10 | 本机 git 环境与「对象库被删」恢复 | 20-源码守卫与仓库卫生 |
| §9 | 排查教训（W1 / 调试钩子） | 40-前端与表现层 |
| §8 | 配置坑（ContentRoot） | 00-跑法与验收骨架 |
| §7 | 提交惯例 | 00-跑法与验收骨架 |
| §6 | 停服与确认 | 00-跑法与验收骨架 |
| §5 | headless 渲染回归（务必用 shot.mjs） | 00-跑法与验收骨架 |
| §4 | 专项 sanity（改缓存/并发相关时） | 00-跑法与验收骨架 |
