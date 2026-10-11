# 角色系统（CultivatorGen）· 独立子系统

> 为「在这个世界里建模一个个修士」提供 **基础数据 + 确定性生成器 + 前端查看窗口（实时）**。
> **服务端实时生成、游戏内实时显示** —— 角色是 `(seed, index)` 的**纯函数派生**，
> 由 C# 子系统里的独立 V8 现算，**不落库、不预生成静态表**（对齐 chunk/settle 的 seed 派生哲学）。
> 设计依据：`待办事项/人物系统-资料调研.md`（五层生成管线 / 正态 Stat Matrix / 确定性 > 花哨）。

## 目录

```
Subsystems/Characters/
├─ js/chargen-core.js           # ★ 生成逻辑唯一真源（classic script → global.CultivatorGen）
├─ chargen.mjs                  # Node 侧薄封装（vm 求值 core + CLI）—— 逻辑不在这里
├─ CharactersModule.cs          # V8 模块（scope="characters"）：Files/OnVmReady/Invoke 白名单
├─ CharactersSubsystem.cs       # ISubsystem + 数据端点 GET /api/characters
├─ data/cultivation-base.json   # 修仙基础数据（全量、可扩展、生成器唯一数据源）
├─ verify.mjs                   # 判据：数据完整性 / 确定性 / 分布 / 结构
├─ verify_roster.mjs            # 判据：载荷结构 + roster.js 纯函数 + 源码守卫
├─ out/characters.json          # CLI 离线示例（非前端数据源）
└─ README.md
```

配套的前端窗口（**属于 web/，不放在本目录**）：

```
web/js/roster.js                # 「众生录」窗口模块（window.SectRoster，独立、可注入、只读）
```

## 数据链路（★ 服务端权威）

```
data/cultivation-base.json
        │  C# CharactersModule 构造时读入
        ▼
  OnVmReady → CultivatorGen.setBase(json)         ← V8 沙箱没有 fs，只能宿主喂
        ▼
  GET /api/characters?seed=&count=&offset=        ← 前端只认这个端点（gzip）
        ▼
  web/js/roster.js  fetch → { dict, characters[] }
```

- **无台账**：`CharactersSubsystem.Tables` 为空 —— 不碰 `Data` 表，天然免疫后台 `PruneExcept`
  的「非活跃 seed 静默删行」（对照 `WorldLedger`/`PlayerSectStore`/`CityState` 三条独立表）。
- **seed 是服务端资产**：`?seed=` 缺省取**当前世**（`/api/world/current`），前端不给 seed。
- **换世即换人**：新 seed ⇒ 全新一批角色，零迁移成本。

## 跑法

```bash
# ① 判据（离线，无需起服务）
node Server/Zongmen/Subsystems/Characters/verify.mjs          # rc=0 全绿
node Server/Zongmen/Subsystems/Characters/verify_roster.mjs   # rc=0 全绿

# ② 离线 CLI（生成 24 个到 out/characters.json；seed 固定则逐字段可复现）
node Server/Zongmen/Subsystems/Characters/chargen.mjs --count 24 --seed zongmen
node Server/Zongmen/Subsystems/Characters/chargen.mjs --count 1 --seed demo --pretty

# ③ 在线端点（需先起后端；⚠ 常驻进程用 run_in_background，别用 &）
#    → 【服务端实时生成】300 人，seed 自动补当前世，gzip ≈116KB（未压缩 ≈750KB）
curl -s -H "Accept-Encoding: gzip" "http://127.0.0.1:8140/api/characters?count=300" -o out.gz
```

CLI 参数：`--count/-n`、`--seed/-s`、`--out/-o`、`--base`、`--pretty`、`--quiet/-q`。

## C# 装配（四处，全在 `Program.cs` = 组合根）

```csharp
var characters = new CharactersSubsystem(ZongmenPaths.ResolveCharactersDir(options, contentRoot));
var subsystems = new SubsystemRegistry(new ISubsystem[] { city, characters });   // ①
builder.Services.AddSingleton(characters);                                       // ②
characters.MapEndpoints(app, worldService);                                      // ③
// ④ VM 池自动多出一个 Scope：启动日志 `VM: … = city + characters`
```

> ⚠ **新子系统必查**：`JsvmModule.AcceptsExternalSettlements` 默认 `false`。
> `JsVmPool.onCreated` 会对**每个**新建 VM 调 `setExternalSettlements`；本模块不载
> `mapgen-server.js`、没有该出口 ⇒ 若返回 true 会在**首次建 VM** 时抛「未知 JS 函数」。
> 判据：启动日志的 ext 重放行只应有 `[core]`/`[city]`，**没有** `[characters]`。

## 前端查看窗口（众生录）

- **入口**：左上工具列「名录」按钮（`#btnRoster`）。窗口是与 `#topbar` 同级的浮层
  （`.panel` 的 `clip-path` 会裁掉子树，塞进顶栏面板会被切）。
- **内容**：左列名册（境界筛选芯片 + 姓名/道号搜索），右侧详情（六维条形 / 灵根 · 纯度 / 寿元 /
  天分 / 资源 / 特质 / 功法（主修 + 辅修熟练度）/ 储物袋（容量 · 灵石 · 逐件）/ 出身 · 阵营 · 编号）。
- **载荷带 `dict`（展示字典）**：六维/派生/资源/特质/功法分类的中文名只有基础数据知道。
  前端**不硬编码标签**（否则改 JSON 不改前端 = 静默错名），一律读 `dict`，仅缺失时回落 `roster.js` 兜底表。
- **模块边界**：`roster.js` 不引用 main.js 任何内部变量；`main.js` 只在 boot 里调一次
  `initRoster()` 注入 `{ root, btn, esc, dataUrl: 'api/characters?count=300' }`，**不渲染**。
- **调试开关**（仅 `?debug=1` 生效）：`?roster=1` 开局即展开窗口；`window.__feat().roster`
  可读回 `{ ready, open, count, shown, filter, query, selected }`。

## 基础数据（cultivation-base.json）

全部数据驱动，生成器**不硬编码任何词条**。当前含：

| 段 | 内容 | 规模 |
|---|---|---|
| `elements` | 五行 + 变异灵根（雷/冰/风/暗/光/空间） | 5 + 6 |
| `spiritRoots` | 灵根品级 8 档（废→天）+ 纯度正态 + 纯度分级 | 8 |
| `realms` | 凡人→渡劫 10 境（含层数/寿元/灵气/突破/天劫） | 10 |
| `attributes` | 六维（根骨/悟性/神识/气运/心境/魅力）+ 派生 + 资源条 | 6+3 |
| `techniques` | 15 类 × 6 品阶，功法库（含硬门槛 minRealm/minRoot） | 45 |
| `items` | 11 类 × 6 品阶，物品库（丹药/法宝/符箓/灵石/材料…） | 57 |
| `storageBag` | 储物袋容量公式 + 各境界初始灵石 | — |
| `names` | 姓 100+ / 男名 60 / 女名 60 / 中性名 20 / 道号词根 | 240+ |
| `traits` | 4 类（天赋/体质/怪癖/天命）× 6 品质 + 冲突表 | 39 |
| `backgrounds` | 出身背景（属性修正 + 起始物品 + 灵石乘子） | 18 |
| `factions` | 阵营（正道/魔道/中立/散修）+ 示例宗门 | 4 + 7 |
| `appearance` | 体态/容貌/气质 | 3×8 |
| `generate` | 全部分布参数（正态均值/方差、权重、区间） | — |

**新增内容只改 JSON**：往对应 `list` 追一行即可；数据对象与角色对象都带 `ext` 槽。

## 生成器设计纪律

1. **确定性**：每个角色由 `(seed, index)` 经 FNV-1a → `mulberry32` PRNG 生成；同一输入**逐字段可复现**，
   绝不 `Math.random()` / `Date.now()`。输出**不含时间戳**，可 diff。（⇒ 无需落库表。）
2. **正态分布**：年龄 / 六维 / 灵根纯度 / 修为进度 全部走 **截断正态**（Box-Muller + 拒绝采样）。
   ⚠ 六维采样本身是 `normal(mean,sd)`，灵根/背景/特质是**正偏置修正**，故实测均值略高于表内 `mean`（悟性最明显）。
3. **年龄从 0 开始**：实际年龄落在「该境界的年龄带」（`realmAgeBand`）内并兜底 `< lifespan`，故 newborn / 幼童皆可生成。
4. **生成顺序依赖**：性别 → 背景 → 灵根 → 特质 → 属性 → 境界 → 功法 → 寿元 → **年龄** → 名（名依赖性别）。
5. **硬门槛**：功法/物品/背景起始物均按 `minRealm` + 灵根 `minRoot` 门控（资质是「能不能学」而非 +%）—— 凡人不会持玄阶心法。

## 角色对象（cultivators/v1）关键字段

`id / genSeed / name{surname,given,full,daohao} / gender / age / lifespan / realm{seq,layer,stage,progress,talentScore} / spiritRoot{grade,purity,elements,mutation} / attributes(六维) / derived(资质/潜力/声望) / resources(灵力/气血/精神) / traits[] / background / faction{alignment,sect} / techniques{main,aux[]} / storageBag{slots,used,lingshi,items[]} / appearance / relations(占位) / history(占位) / ext`

载荷外壳：`{ schema, generatedAt:null, seed, count, offset, baseMeta, dict, characters[] }`

## 判据

`verify.mjs`（生成侧，Node 跑 core）：

- `[0]` 数据完整性：背景起始物 / starterKits / 特质冲突表的**悬空引用**。
- `[1]` 确定性：同 `(seed,index)` 一致、换 seed 不同、无时间戳。
- `[2]` 分布：年龄下界=0、上界≤寿元、境界 10/10 覆盖、六维均值≈50、纯度 55/16、特质 1~3。
- `[3]` 结构：字段齐全 + 境界/灵根硬门槛 + 储物袋不溢出。

`verify_roster.mjs`（前端窗口侧，**不再依赖静态文件** —— 用 core 造载荷）：

- `[0]` 载荷（core 直造）：schema 正确、300 人、带 `dict` 且六维标签齐、带 `offset`。
- `[1]` Node 里**裸跑** `web/js/roster.js` 的纯函数：`normalize` 容错、`presentRealms` 覆盖且按 seq 升序、
  `applyFilter`（全部 / 凡人 / 炼气 / 姓名搜索 / 无匹配）逐条断言。
- `[2]` 渲染产物：`rowHTML` 含姓名+选中态+`data-ro-id`；`detailHTML` 含六维/储物袋/来历、无 `undefined`/`NaN`、
  主修心法段与数据一致；**标签单真源**（每个六维键都能在 `dict` 找到中文名，且无 `dict` 时回落兜底表）。
- `[3]` 源码守卫：无间接 `eval`、不直取 `window.MapGen`/`EngineLocal`、只发一次 `fetch`、不把 DOM 句柄命名为 `st`；
  **★ 数据源守卫**：`main.js` 的 roster `dataUrl` 必须指向 `api/characters`，且 `main.js` 不再引用 `characters.json`。

## 下一步（未做）

- 接 **Tick**：`SectCultivation`/`Lifespan` 两类空壳 job 已在 `TickJobKind` 注册 —— 时间维度接缝已就绪；
  届时新增 `CharactersTickExecutor`（认领集**不得**与 `CityTickExecutor` 重叠）+
  `CultivatorStore` 独立表（只存**可变派生层** age/progress/alive…，身份仍由 seed 派生）。
- 窗口内加「按宗门/阵营筛选」「以某人为视角跳地图」「详情按需拉 `/api/characters?id=`」。
- 社会关系（师徒/道侣/仇敌）P0 不做，`relations` 字段已占位。
