# 宗门模拟器 · Tick 与演化

> 自 `SKILL.md` 拆出（2026-10-11 压缩，原 133KB 单文件）。章节号沿用原编号 ⇒ 全文里「见 §32」这类交叉引用仍然有效，按下表定位即可。

---

## 43. Tick 框架（世界时钟 / 定时演化调度）的验证姿势 + 七条新坑（2026-09-26~27）

> 全文设计 → `docs/游戏时钟与Tick演化框架方案.md`（v2.1）；**进度真源** → `待办事项/Tick框架开发进度.md`。
> 本节只讲**怎么验**与**踩过的坑**。

### A. ★ 别起服务端验调度器 —— 用一个「引用生产工程」的控制台宿主

调度器/时钟/相位/落库这些**不依赖 V8、不依赖 Web**，起服务端验是最慢最脆的路。

**做法**：`verify/tickprobe/`（一个 `csproj` 控制台，`ProjectReference` 指向
`..\..\Server\Zongmen\Zongmen.csproj`），从 stdin 读**多行 JSON**（一行一个 op），逐行回 JSON。
判据脚本（`.mjs`）`spawn` 它一次，喂几百个 op 走完所有断言 —— **不必 fork 几百次**。

```js
// check_tick_lazy.mjs 里的宿主桥（一次进程跑完全部断言）
class Probe {
  constructor() {
    this.child = spawn('dotnet', ['run', '--no-build', '-v', 'q', '--project', PROJ],
      { cwd: ROOT, stdio: ['pipe','pipe','inherit'] });
    // stdout 按 \n 切行 → 顺序配给 waiters（判据是串行的，够用）
  }
  send(obj) { return new Promise(res => { this.waiters.push(res);
    this.child.stdin.write(JSON.stringify(obj) + '\n'); }); }
}
```

⚠ **必须 `--no-build`** —— 否则每次 `dotnet run` 都重新编译（十几秒），判据会慢到没法用。
先 `dotnet build verify/tickprobe/tickprobe.csproj` 再跑。

⚠ **参照系不能是被测规则自己**（§32 的老教训）：`simulate` op 里推进 job 必须调**生产代码**
`sched.CommitSuccess(j, t)`，**别在判据里自己重写一遍「下一跳怎么算」** —— 正是这条让
`check_tick_lazy` 抓到了哨兵溢出 bug（见 D1）。

### B. ⚠ 源码守卫**先剥注释**（比 §36 更狠的一次）

`check_tick_job_persist.mjs` F5 要断言「相位钥匙用线上名，绝不用 `kind.ToString()`」，
而 `TickJobRegistry.cs` 的**注释**里正好写着「绝不能用 `kind.ToString()`（枚举名）」——
扫描器直接把注释也算命中 ⇒ **假阳性**。修法：

```js
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
```

⚠ `verify/frontend_smoke.mjs` 的 `strip` 是 `.replace(/\/\*[\s\S]*?\*\//g, ' ')` —— 换成了
**空格**不是空串。写正则时要考虑到（`\n  }` 这类「行尾 + 缩进」的模式会被影响）。

### C. ⚠ 判据自己的**数值断言**会错：桶分布用**卡方**，不用 `max/min`

`check_tick_phase` 要验「相位在 `% PeriodTicks` 上均匀」。第一版写
`max(桶).min(桶) < 2.0` —— **N=2000 落 90 桶时实测 2.615，属正常采样方差**，直接假红。

**正解 = 卡方检验**：`χ² = Σ (O-E)²/E`，`E = N/桶数`，`df = 桶数-1`，
与临界值比（df=89 时 χ²≈86.4 完全正常）。**任何「分布均匀」的断言都别用极值比** ——
它随样本量剧烈波动，样本越大越容易假红。

### D. ★★ 两个判据抓出的**真实生产 bug**（都是「不报错」的那种）

**D1. 吊销哨兵溢出 ⇒ 相位错乱**
`ConcurrentTickQueue.AdvanceTo` 收集后把 `job.NextTick` 置为**吊销哨兵**
`long.MaxValue`（防并行重排时同一 job 被收集两次）。而 `CommitSuccess` 原本调
`_registry.NextDue(job, nowTick)` 算下一跳 ⇒ `long.MaxValue + Period` **整数溢出成负数**
⇒ 命中「兜底：`next <= nowTick`」分支 ⇒ 下一次到期是个随机负数 ⇒ job 立刻被再收集。
**症状**：`check_tick_lazy.mjs` B5 断言「相邻命中间隔严格 == period」失败，
实测间隔出现 **8 / 12 / 46 / 342** 这种不规则值。**不报错**，只是演化节奏乱掉。
**正解**：`job.NextTick = nowTick + job.PeriodTicks`（复位哨兵 + 严格 `+=Period`，
**不读旧值** —— 命中点恒为 `firstDue + k*Period`，此刻 `nowTick` 本身就是命中点）。
另在 `NextDue` 加防御：`if (NextTick >= RevokedTick - PeriodTicks) return nowTick + PeriodTicks;`。

**D2. 相位钥匙用**枚举名**而不是**线上名** ⇒ 改个枚举成员名就让全世界相位漂移**
`PhaseHash.PhaseOf(seed, entityId, kind, period)` 的 `kind` 参数，原本传
`kind.ToString()`（`DemoHeartbeat`），而 `TickJobStore` 落库存的是 **`KindNames.Of(kind)`**
（`demoHeartbeat`）。两者派生的相位**不同** ⇒ 重启后对账/重建按线上名复现出**另一个**相位。
**症状**：`check_tick_lazy` B4 期望值算错（258 vs 257），一路追到源码才发现。
**正解**：一律 `KindNames.Of(kind)` —— **持久化契约的键必须与派生键同源**。
守卫：`check_tick_job_persist` F5 + `check_tick_queue_threadsafe` F15。

⚠ **这两条的共同教训**：判据要断言「**恒等式**」（间隔严格 == period；两条路径派生的相位必须相等），
而不是「大概对」—— 极值/近似断言会放过这类**静默错乱**。

### E. ⚠ 并发不变量要在**真 OS 线程**上打

`check_tick_queue_threadsafe.mjs` 的 `queueThreads` op 用 `System.Threading.Thread`
（**不是** `Task.Run`）并行 `Push` + 并行 `AdvanceTo`，用 `ConcurrentDictionary`
记 `collected` 与 `duplicates`，断言：**无重复收集 / 无丢失 / 计数恒等 / 堆序自检**。
规模：8 线程 × 2000 job = 16000，duplicates=0。`Validate()`（索引表 ↔ 堆一一对应 + 堆序自检）
在每次操作后都可调 —— 这是「R11 线程安全」的**唯一**硬证据。

### F. ⚠ 「服务端进程随 shell 会话退出」——用 `run_in_background` 别用 `&`

用 `./Zongmen.exe > log 2>&1 &` 起，**tool call 一返回进程就没了**（表现为
「刚启动就 connection refused」，日志却写着 `Application started`）。
正解：Bash 工具 `run_in_background=true`。

### G. ⚠ `TickJobStore.Load` 只取 `Enabled=1` 是**正确行为**，别当缺陷

「停用的 job（连续失败 `MaxFails` 次）不该在重启后复活」⇒ SQL 里有
`WHERE Seed=$s AND Round=$r AND Enabled=1`。
写判据时若把一个 `Enabled=false` 的 job 也算进「应该被载入」，就会假红
（第一版 `check_tick_job_persist` A9 就是这么错的）。**单列一条断言**（`disabledFiltered`）
验它被正确过滤，而不是把它当漏行。

### H. ⚠ 前端「服务端权威量」的三条纪律

帧 7 世界时钟（`ClockQuery`/`ClockPush`，**明文不 gzip**，**不鉴权** —— 时钟是世界公开事实）：

1. **别每 tick 一问**：每 ~10 tick 校一次**绝对 tick**，之间用 `performance.now()` **本地插值**
   （`Date.now()` 只作 `performance` 不可用时的兜底）。每 tick 一问 = 把服务端懒调度白做了。
2. **校准失败只停更、不清零**：显示旧值远好于显示「0 年」/空白。
3. **换世必须先清基准**：`regenerate()` 里 `clockBase = null` —— 否则新世界头几秒
   继续显示**旧世界**的年份（「换了世界时间却没换」，典型静默错）。

### I. ⚠ 帧 7 的 `Tick` 字段是 **ZigZag**（与同消息其余 int 不同）

`ClockQueryResponse`：`Seq/Year/Month/Day/Season/RatePerSecond/MonoMs/Pending` 是普通 varint，
**只有 `Tick` 是 `sint64`（ZigZag）**（因为 tick 理论可为负 —— 见 `GameClock` 的负 tick 防御）。
前端 `pb.js` 里 `case 2: m.tick = (t.wire === 0) ? r.zz() : 0;`
⚠ 混用会读出「看着像数字但全错」的值（同 §B 那段注释的警告）。
`frontend_smoke.mjs` 已加源码守卫钉死这一处。

### J. 判据注册与跑法

五条离线 `check_clock` / `check_tick_phase` / `check_tick_lazy` /
`check_tick_queue_threadsafe` / `check_tick_job_persist`（每条 ~2s，全绿）；
一条在线 `ws_clock_probe`（只读不登录，等 2.5s 采第二点验「时钟在走」）。
⚠ `run_regression.mjs` 的 `--only=` / `--skip=` 是**子串匹配**，**逗号分隔无效** ⇒ 一次一个。
1681 块 ≈ 65s）。
  ⚠️ **它的 BASE 默认写死 8140**；对着非 8140 的实例跑必须显式传 baseUrl，否则每块都 timeout
  并打印 `BAD ... timeout(可能解码失败)` —— 那是「连错端口」的假 BAD，不是毒块（本次踩过）。
- `w1` 依赖 Node 原生 `WebSocket`/`DecompressionStream`/`CompressionStream`/`Blob`（Node ≥ 22 自带），无需浏览器。
- **在 Node 里 eval `mapclient.js` 必须提供 `global.location`**（模块级读 `location.protocol/host` 拼 WS_URL），否则 `ReferenceError: location is not defined` —— 这是 `frontend_smoke.mjs` 曾长期失效的原因。

---

## 46. 「判据全绿但实机报错」的新形态 + 隔离实例取证法（2026-10-11 · demo 心跳保底）

> 场景：用户贴来一段日志 —— `[tick] job 连续失败 5 次已停用：94621817/2/demo_0_0/demoHeartbeat
> err=not-claimed-by-any-executor`。判据侧 4 个 tick 系列**全绿**。这条日志是「组合根级」的，
> 判据架构上就够不着它。修完后原地取证的方法也在这一节。

### A. ★★ 判据环境 ≠ 生产组合根 ⇒ 「谁注册了谁」这类事实判据测不到
- 根因：`TickPump.ExpectedJobs` **无条件**保底补一个 `demo_0_0/demoHeartbeat`（P1 脚手架残留），
  而 `Program.cs` 的 `TickExecutorHub` 只注册了 `CityTickExecutor`（认领 `TownEvolve`/`TradeEdge`）
  ⇒ 没有任何执行器认领 `DemoHeartbeat` ⇒ 到期必失败。
- **4 条 tick 判据全绿**，因为 `verify/tickprobe/` 与 `check_tick_*.mjs` 全都**自带 job 源与
  DemoTickExecutor**，从不走 `Program.cs` 的组装。
- ⇒ 纪律：**「谁注册了谁 / 谁认领了什么 / hosted service 装配」这类组合根事实，判据必须至少
  有一次走真实组合根**（起实例，读启动日志的 `执行器=…` / `子系统: …` / `VM: …` 三行）。
  判据擅长算法/协议/不变式；**装配与注册表是它的盲区**。

### B. ★ 隔离实例 + **用户 DB 的只读副本** = 最贴近现场的取证
```
① Node 复制（本机 shim 无 cp）：fs.copyFileSync('db/zongmen.sqlite','Temp/dbNNN.sqlite')
② 环境变量起隔离实例（绝不碰用户 8140）：
   Zongmen__Port=8141
   Zongmen__DbPath=<Temp/dbNNN.sqlite>
   Zongmen__WebDir=<repo>/web  Zongmen__EngineJsDir=<repo>/Engine/js
   Zongmen__Tick__ReconcileEveryTicks=15      # ★ 把 1 游戏年(360 tick)压到十几秒
   <repo>/Temp/srvA/Zongmen.exe > Temp/runNNN.log 2>&1
③ 跑完 TaskStop 收掉
```
- ⚠ **必须显式给 `WebDir`/`EngineJsDir`**：`dotnet build -o Temp/srvA` 出来的是裸输出目录，
  `contentRoot` 里既没有 `web/` 也没有 `Engine/js`。
- ⚠ 调小 `ReconcileEveryTicks` 是**关键**：默认 360 tick（≈6 分钟）根本等不到一次对账。

### C. ⚠⚠ 「日志安静」既 ≠「没问题」也 ≠「没动作」——等日志会得到假阴性
- 对账日志的条件是 `Added>0 || Removed>0` ⇒ **完全一致时它是静默的**。本次等了 45 秒看日志无新增，
  差点误判成「tick 没在跑」。
- 正确取证 = **查库**（python3 内建 `sqlite3`，本机无 sqlite3 CLI；脚本写 `Temp/`）：
  | 查什么 | 期望 |
  |---|---|
  | `WorldClock.Tick` | 在增长（本次 1657247 → 1657427） |
  | `TickJob` group by (Kind,Enabled) | 城 job 条数**一条不少**，demo 心跳 0 行 |
  | `CityState` 的 `Ver`/`LastEvoTick`/`Age` | 在长 ⇒ 演化真在写世界 |

### D. ⚠⚠ 「某 kind 无执行器认领」+「保底/对账会重建它」= **永不收敛**的复活环
- `Enabled=0` 停用 与 「`Load`/`Reconcile` 都只读 `Enabled=1`」组合出闭环：停用行在 `existing`
  里**看不见** ⇒ `Reconcile` 当它是新增 ⇒ UPSERT 回来（`Enabled=1`/`FailCount=0`）⇒ 再死一次。
  周期 = `ReconcileEveryTicks`（= 每游戏年刷一次错日志，永不消失）。
- ★ 推广原则：**对账的语义是「只增删」⇒ 它的输入必须可信**。让 `ExpectedJobs` 返回
  「空集 / 残缺集」（如 provider 抛异常后 `Clear()` + 回退保底）等于**授权对账删光整个世界** ——
  旧代码正是这样：`ExpectedJobsProvider` 一抛异常，本世所有演化 job 被判 `removed` 清空，
  日志只有一条 LogError（把「provider 挂了」伪装成「有 job 在跑」）。
  正解：**返回 null = 期望集未知 ⇒ 整轮跳过对账**（表保持原样 + Warning 留痕）。
- ⚠ 同一个雷还在：`Reputation` job **无执行器认领**（只是 provider 还没投递它）。扩 provider 前
  先确认有认领者。

### E. 本机 bash shim 缺失命令清单（累计，遇到就换工具）
`ls` / `head` / `tail` / `cat` / `cp` / `cd` / `dirname` / `wc` / `grep` / **`sleep`**
- 替代：读文件用 Read/Grep 工具；**等待**用 `node -e "setTimeout(()=>…,N)"`；
  复制用 `node -e "fs.copyFileSync"`；重定向 `> Temp/x.log` + Read 工具。
- ⚠ `… | tail -25` 会让**整条命令 stdout 全空**（管道断在第一段），不是「命令没跑」，别误判。

### F. 改「保底 / 默认行为」时的同步清单（本轮实际改到的三处）
1. **开关 + 教训注释**（`TickOptions.EnableDemoHeartbeat=false` —— 把踩坑史写进 XML 注释，
   否则下一轮又有人把它改回 true）；
2. **调用方的三态语义**（`ExpectedJobs` 返回 `List<TickJob>?`：正常 / 未知-null / 裸链路）；
3. **⚠ 存档里的历史残留**（`BindWorld` 里清：内存丢弃 + 新增 `TickJobStore.DeleteKindRows` 删
   `Enabled=0` 的僵尸行 —— 它既不在 expected 也不在 `Load(Enabled=1)` 里，`Reconcile` **永远
   判不到它**，不清就永久滞留）。
   ⇒ 改默认行为必须连带处理「旧版本已经落库的那份」，否则一开开关就撞上一个 `NextTick`/`Phase`
   都不同的旧行。

---
