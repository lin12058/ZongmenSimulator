# review_v5 — 近两日改动性能 / 隐性 bug 审查

> 审查窗口：**2026-09-12 ~ 09-13**（含工作区未提交改动）
> 覆盖提交：`a0c7d49`（边界衰减）→ `7d7cd9e` → `40cfb9a`/`27e5cba`（记忆/清理）→ `c2b80d3`（道路网拓扑 + 城市选址/足迹/贸易）→ `d76acd9`（cartDist + 路复用）→ `641e8f4`（Network-First P0）→ `6122e26`
> 未提交：`Server/Zongmen/Engine/js/mapgen.js`(+20/-13)、`灵脉预览.html`(+45/-13)、`verify/_cdp_shot.mjs`、`verify/_scratch_diag.mjs`（未跟踪临时脚本）
> 审查方式：逐文件 diff + 现有代码通读；能静态验证的已实测（见 §五）。

---

## 一、结论速览

| # | 级别 | 位置 | 问题 | 影响 |
|---|------|------|------|------|
| 1 | 🔴 P0 | `灵脉预览.html` 内联 vs `mapgen.js` | 内联引擎**未同步**（66122B vs 66668B），已实测 | 预览页跑旧引擎，参照世界失真 |
| 2 | 🔴 P0 | `灵脉预览.html:2306` / `mapgen-server.js:104` | 预览页传「修路中心」cq/cr，服务端不传 → 建路顺序不同 | 路复用使路径依赖 → **预览路网 ≠ 服务端路网** |
| 3 | 🟠 P1 | `mapgen.js:122` `roadTileIdx` | 只增不清，而 `roadCache` 有 `ROAD_CAP=4096` 淘汰 | 幽灵路廊：被淘汰的路仍按 2 费吸引并线；重建路径可能与首次不同 |
| 4 | 🟠 P1 | `mapgen-server.js:104` | `settlementJson` 未过滤 `poi`（`settleJson` 有过滤） | 秘境被生成一套「祠堂/村口」足迹并进 poi 实体层；前端一旦画足迹就穿帮 |
| 5 | 🟠 P1 | `mapgen.js:1285-1293` + `1336-1341` | DI 拒绝的非骨架边**无负缓存**：每轮重跑最多 3 次 A*，并重复入重试队列 | 铺路预算被同一批废边反复吃掉，新区域出路变慢 |
| 6 | 🟠 P1 | `mapgen.js:1040` `skeletonEdgesFor` | 未缓存，每次命中 DI 闸都重算 O(P²·P)≈6 万次 cartDist + 1225 边排序 + Kruskal | 单格最慢 195.8ms 的主要贡献者之一 |
| 7 | 🟠 P1 | `mapgen-server.js:84-100` + `pb.js:173-207` + `main.js:303` | region 包冗余携带城镇足迹，**前端解析后直接丢弃** | 每次区域层下发：多余 protobuf 体积 + 每建筑一次对象分配，零收益 |
| 8 | 🟡 P2 | `MapWorldService.cs:469-476` | needSettle 时按 region 解 `SettlePack`，但同一份数据已随 region 包到达 | 多余 gzip 解压 + protobuf 解析 + Dictionary 组装（两项留一即可） |
| 9 | 🟡 P2 | `mapgen.js:135` `roadFailTrials` | 唯一没有容量上限的缓存 Map | 长期漫游按失败边数无界增长 |
| 10 | 🟡 P2 | `mapgen.js:1017-1035` `rngDominated` | 每次判定重建 5×5 池并调 **50 次** `settlementsFor`（注释写 3×3，实际 -2..2） | 单区域数百次字符串 key 查找 + 分配 |
| 11 | 🟡 P2 | `MapWorldService.cs:397-422` | `BlockRevs` 恒 1、`BumpBlockRev` **无调用者**，但 settle 已按「会演化」落库 | 真去改 settle 数据时客户端不会重拉（`Need(2)=false`） |
| 12 | 🟡 P2 | `MapWorldService.cs:344-346` / `363-364` | `b.GetProperty("q")`、`r.GetProperty("resource")` 未用 TryGetProperty（同文件其它字段都用了） | 缺字段 → JsonException → 整块 TileRequest 中断，症状像「没数据」 |
| 13 | 🟡 P2 | `mapgen-server.js:104` | `roadsNear(i,j,9999)` 一次算全 | 新 region 首请求阻塞 ~196ms（V8 门闩内），视野 9 格铺开可累计 ~1s |
| 14 | ⚪ P3 | `web/js/main.js:1077` | `updateSectPanel` 先做全量 `collectSects()`+sort，后比指纹 | 每 1.5s + 每次实体响应各一次无谓遍历/排序 |
| 15 | ⚪ P3 | 工作区 | 调 `PROSPECT_*`/`TOWN_*`/`FARM_SPIRIT`/`ROAD_*` 后未清库 | `w:{seed}:settle:*` 优先 SQLite 回读 → 足迹永不更新 |
| 16 | ⚪ P3 | `verify/` | `_cdp_shot.mjs`、`_scratch_diag.mjs` 未跟踪残留 | 违反本仓「不留一次性脚本」约定 |

---

## 二、逐条说明（可操作细节）

### 1. 🔴 预览页内联引擎未同步（已实测）

```
$ node verify/sync_preview_inline.mjs --check
✔ 已同步  mapgen-config.js   内联 4164 → 源 4164 字节
✎ 需同步  mapgen.js          内联 66122 → 源 66668 字节
=== 结果: ✘ 1 处不同步 ===
```

`mapgen.js` 的**未提交改动**（`demandEdgesFor(i,j,cq,cr)` + `roadsNear(...,cq,cr)`）只在源文件里，预览页内联的仍是上一版。后果：
- 预览页 `<script>` 里的 `roadsNear` 仍是 3 参版本，`灵脉预览.html:2306` 新传的第 4/5 个实参**被静默忽略** —— 页面上的「点击地图设修路中心」目前是**失效功能**（UI 有、行为无）。
- 一切以预览页为参照的目视/回归结论，都建立在旧引擎上。

**动作**：`node verify/sync_preview_inline.mjs` 写回，然后重跑 `check_preview_*` 与 `--check`。

### 2. 🔴 「修路中心」让预览世界与服务端世界分叉

```js
// 灵脉预览.html:2306（新）
MapGen.roadsNear(cell[0], cell[1], budget - built,
                 roadCenter ? roadCenter.q : undefined,
                 roadCenter ? roadCenter.r : undefined);
// mapgen-server.js:104（服务端权威）
var roads = MG.roadsNear(i, j, 9999);     // 无中心 → 规范序
```

`demandEdgesFor` 的排序被 cq/cr 改写后的前两级键**完全不同**（由内向外 vs hub 优先）。而 `mapgen.js` 自己的注释与 09-13 日志都写明：

> 路复用与闸门使可行性「路径依赖」(先建路的形状影响后建路)，会话内严格确定。

即**建路顺序决定成路**（`ROAD_W_ROAD=2` 折扣 + DI 闸 + 骨架强制）。所以：
- 预览页设了中心 → 路网与「同 seed 同格的服务端路网」不一致；
- `verify/w3_bfs_road.mjs`、`check_preview_settle_road.mjs` 分别直调引擎 / 读预览页，两边断言可能同时「全绿」却描述两个不同的世界。

**建议二选一**（不要都留）：
- (a) 把「由内向外」上移为**纯 UI 层展示顺序**（页面只按距离排 `roadQueue`，不把中心透传进引擎）——服务端语义不受影响；
- (b) 若确实要引擎级渐进，则**服务端也要传中心**（取玩家/请求块中心），并把中心纳入道路缓存 key，否则跨端一致性无法维持。

推荐 (a)：`buildRoadQueue()` 已经按到圆心的六边距排序了，`roadsNear` 的 cq/cr 参数属重复机制。

### 3. 🟠 `roadTileIdx` 与 `roadCache` 生命周期不一致

```js
var roadTileIdx = new Set();   // 注释：只增不清（缓存淘汰不回收）
cacheSet(roadCache, rkey, road, ROAD_CAP);   // 道路本体却会被淘汰
```

淘汰后：该路已不可见、也不在 `roadCache` 里，但它的格子**仍留在 `roadTileIdx`**，A* 每格照收 2 费 → 新路主动并线到「不存在的路」上。

两层后果：
1. **视觉**：出现没有路可画的走廊，新路莫名贴着空地走直线；
2. **一致性**：同一对路若因淘汰被重建，`roadTileIdx` 已含首次的路格 → 第二次可能走出**不同路径**，破坏「跨会话一致」与 client/server 对齐。

触发条件：全会话累计 >4096 条路（全域估算 ~1800 条，暂未触发，属**边界条件**）。修法：删 roadCache 条目时同步 `roadTileIdx.delete(t)`（或让道路与路格索引同源，用 `roadCache` 派生）。

### 4. 🟠 秘境（poi）被算进城镇足迹

```js
// mapgen-server.js: settlementJson —— 无 type 过滤
for (var s = 0; s < sts.length; s++) stArr.push(settlementJson(sts[s]));
// mapgen-server.js: settleJson —— 有过滤
if (st.type === 'poi') continue;              // 秘境无城镇足迹
```

`growTownFootprint(id, 'poi', ...)` 里 `TOWN_BUILD_MAX['poi']` → `undefined || 8`、`CORE_KIND['poi']` → 回退 `village`，于是秘境被铺上「祠堂/村口 + 民房」，并且 `MapWorldService.cs:529 ToEntity` 会把这些字段带进 **poi 实体层**。当前前端不画足迹所以无症状，属**潜伏 bug**（一旦 §7 的足迹上地图落地就会立刻显形）。

**修法**：`settlementJson` 加 `if (st.type === 'poi')` 分支只发骨架字段（或 regionJson 干脆不再带足迹，见 §7）。

### 5. 🟠 DI 拒绝边的无负缓存 → 同一边每轮最多 3 次 A*

`roadsNear` 主循环里，非骨架且 DI 超限的边：

```js
var path = bfsRoad(pA.q, pA.r, pB.q, pB.r, roadTileIdx);   // ① 折扣 A*
if (steps * 10 > roadDI * d0hex) {
  var direct = bfsRoad(pA.q, pA.r, pB.q, pB.r);            // ② 无折扣 A*（结果超限即丢弃）
  if (direct && ...) path = direct;
  else {
    if (skel === null) skel = skeletonEdgesFor(i, j);      // ③ 见 §6
    if (!skel.has(rkey)) { deferred.push(edges[e]); continue; }   // 既不入 roadFail，也不记负缓存
  }
}
...
for (d4...) { var p2 = bfsRoad(qA.q, ..., roadTileIdx); }   // ④ deferred 再跑一次折扣 A*
...
for (d5...) { diRetryQueue.push(deferred[d5]); }            // ⑤ 同一 rkey 每轮重复入队（仅 4096 上限兜底）
```

下一次同格调用时，这条边仍是 `roadCache` miss、`roadFail` miss → **整套 A* 重来**。设计上「不记 roadFail」是对的（路径依赖，记了会永久毒化），但缺一个**会话级「本对已判定为 DI 超限」的负缓存 + 冷却**，导致：预算被反复消耗、重试队列里同一 `rkey` 大量重复（限量的 8 条/轮被浪费），新区域出路明显变慢。

**建议**：加 `diCooldown: Map<rkey, roadVer>`，仅在 `roadVer` 前进（真有新路落成）后才允许重试该边；`diRetryQueue` 入队前用 Set 去重。

### 6. 🟠 `skeletonEdgesFor` 未缓存

```js
var skel = null;                        // 局部变量 → 每次调用重建
if (skel === null) skel = skeletonEdgesFor(i, j);
```

池 = 5×5 区域格（P≈50 个聚落）→ 1225 对 × 50 次支配判定 ≈ **6 万次 `cartDist`**，加 1225 条边排序 + Kruskal（Map 版并查集）。它只依赖 (i,j)，和 `tradeCache`/`centerCache` 一样是纯函数 → 应按 `(i,j)` 缓存（可复用 `TOWN_CAP` 式的 cap）。这是单格最慢 195.8ms 的可见贡献项。

### 7. 🟠 region 包的「城镇足迹」是纯浪费（三重成本，零收益）

| 环节 | 成本 |
|------|------|
| `mapgen-server.js:84-100` `settlementJson` | 每个聚落一次 `growTownFootprint`（缓存后仍要拼 JSON）+ prototypes 序列化 |
| 传输 | RegionPack 每次下发多出 N×(建筑×5 字段 + 资源×2) |
| `pb.js:173-207` → `parsePlaceEntity` 分支解析 | 每个建筑一次 `bin()` 子视图 + 对象 + 字符串；`main.js:303` **只取 `{region, roads}`，`settlements` 直接丢弃** |

即：**服务端算 + 序列化 + 前端解析分配，最后全丢**。区域层是高频层（新块/rev 变化都会走）。

**修法（与 §8 联动）**：region 包只保留聚落**骨架**（1..12），足迹**只走 settle 包**（它已经是「会演化、独立 rev、独立落库」的权威）。这样 §4、§8 一并消失。

> 若坚持冗余（注释里写「使单块路径不必再取 settle 包」），那至少要给 region 包一个 `POI` 过滤 + 让客户端真的用起来（足迹上地图），否则就是纯负担。

### 8. 🟡 `GetTileBlock` 里按 region 解 settle 包

```csharp
if (needSettle) {
    foreach (var (ri, rj) in layers!.Value.regions) {
        var sp = DesFromGz<SettlePack>(GetSettleBytes(seed, ri, rj));   // gzip + protobuf + Dict
        foreach (var t in sp.Towns) plans[t.Id] = t;
    }
}
```

同一份足迹**已经从 region 包拿到了**（`ToEntity(s)` 里就有），这里再解一遍。两项留一即可。

### 9. 🟡 `roadFailTrials` 无上限

`mapgen.js:135` 是唯一没有对应 `*_CAP` 的缓存 Map（`roadFail`/`diRetryQueue`/`roadCache` 等都有）。虽然窗口在 resetWorld 里会被清，但一次长会话内按「曾经尝试过的边」线性增长。按 `setAdd(...)` 同款思路加 cap 即可（淘汰只影响重试次数，不动结果）。

### 10. 🟡 `rngDominated` 的池开销

```js
for (var di = -2; di <= 2; di++)          // 注释写「3x3」，实际 5x5
  for (var dj = -2; dj <= 2; dj++)
    for (var c2 = 0; c2 < 2; c2++)        // a 侧 + b 侧 → 50 次 settlementsFor
```

`demandEdgesFor` 对每个候选对都调一次 → 单区域数百次 `settlementsFor(ci,cj)`（每次一个字符串拼接 + Map 查找）。建议：
- 在 `demandEdgesFor` 里按 (i,j) 预取一次 5×5 池（25 格）并复用；
- 顺手把注释里的「3x3」改成 5×5，避免下一个人按注释推理。

### 11. 🟡 `BlockRevs` 恒 1 / `BumpBlockRev` 无调用者

```csharp
/* Revs: ... 当前世界确定性无事件, rev 恒 1 */
/* 未来建筑事件只需 BumpBlockRev 后让客户端重拉该块即可。 */
```

但本轮已经把 settle 包定位成「建筑足迹**后续会演化**、独立持久化」。真去改足迹时，若忘了先 `BumpBlockRev(..., TileMask.Settle)`，客户端 `Need(2)=false` → **改了不生效、且不报错**（症状类似「读服务端未下发字段 = 恒定空值」那条铁律）。建议至少在 `GetSettleBytes`/未来写足迹的入口加 TODO 断言，或在文档里把「改足迹 ⇒ 必 bump Settle rev」写成显式契约。

### 12. 🟡 Json 取值风格不一致 → 异常型硬故障

```csharp
Q = b.GetProperty("q").GetInt32(),              // ← 缺字段即抛
Kind = b.GetProperty("kind").GetString() ?? "",
Resource = r.GetProperty("resource").GetString() ?? "",   // 同上
```

同文件其它地方一律 `TryGetProperty + ValueKind` 校验。JSON 与 DTO 一旦漂移（例如 JS 侧改名），这里会抛 `JsonException`，位置在 `BuildSettle` 内 → **整个 TileRequest 中断**，前端症状是「这一块所有图层都没有」——正是 MEMORY 里记过的伪装型故障。改成 TryGetProperty 与兄弟字段一致即可。

### 13. 🟡 `roadsNear(i, j, 9999)` 一次算全

新 region 首次请求在该 V8 门闩内把整格路网算完。实测最慢单 region：**195.8ms**（本轮之前 127.4ms，A* 时代 540ms）。视野 9 格新区域连续铺开时会串行阻塞到 ~1s 量级。本轮 5×5 RNG + 骨架 + DI 重试是成本翻倍的主因。
**建议**：`regionJson` 侧改有限预算 + 渐进补算（服务端也吃 `maxNew`），或对块响应做「先给缓存内的路，缺的下一帧补」——与预览页 `pumpRoads` 同思路。

### 14. ⚪ `updateSectPanel` 先算后比

```js
var pick = pickSect();      // 遍历 settleCells + sort（每次都做）
var fp = layerFingerprint();
if (id !== sect.curId || fp !== sect.curFp || force) { ...重建 DOM... }
```

判据是对的（含图层规模指纹），但代价在判据**之前**。改成先算 `layerFingerprint()`/`cur` 指纹、不变则直接 return，可省掉每 1.5s 与每次实体响应的全量遍历 + 排序。

### 15. ⚪ 改了生成参数就必须清库（本轮 config 动了 16 行）

`GetSettleBytes`/`GetChunkBytes`/`GetCommBytes` 的读取顺序是 `_mem → ReadSqlBackfill(SQLite) → 生成`。本轮改了 `ROAD_W`/`ROAD_W_ROAD`/`ROAD_DI_MAX10`/`PROSPECT_*`/`TOWN_*`/`FARM_SPIRIT`/`TRADE_REACH` —— **SQLite 里的旧 chunk/comm/settle 会被优先回读，参数不生效**（典型症状：改了配置却不生效、只有清库后才对）。
**动作**：确认 `db/zongmen.sqlite*` 已清（或在改参数提交里显式写「需清库」）。

### 16. ⚪ `verify/` 残留

`verify/_cdp_shot.mjs`、`verify/_scratch_diag.mjs` 为未跟踪临时脚本。按本仓约定用 **Node `fs.unlinkSync`（绝对路径 + basename 断言）** 清理，**禁用 shell 通配符与 `git rm`**（MEMORY 里有两条血案）。

---

## 三、已核实「看着可疑但不是问题」

- **`pb.js` 的 repeated 字段写法正确**：`case 15: m.buildings.push(parseBuilding(r.bin(rdLen(r, t))))` —— 逐次 push 一个元素，符合「repeated 必须逐元素」铁律（写成容器套 field1 会把 UTF-8 当子消息解 → `不支持的 wire=7`）。
- **`Reader.bin()` 返回 `subarray`（视图）安全**：`new Reader(u8)` 里 `this.end = u8.length`（相对视图长度）；`toStr` 走 `TextDecoder.decode(view)`、`toF32` 走 `new DataView(buf, byteOffset, byteLength)`，都带偏移，无越界/错位。
- **`#sectMenu` 不会被 `.panel` 的 `clip-path` 裁掉**：它是 `#sectBox` 的**兄弟**（都在 `#sectWrap` 内，`#sectWrap{position:relative}`），`z-index:6` 高于 `#controls`（auto）——符合 MEMORY 里那条「下拉必须放到同级定位容器」的戒条。
- **`BuildOnce` 内调 `Store` 不会自锁**：`Store` 只写 `_mem`/`_sql`，不取 `_buildGates`；`finally` 里 `TryRemove` + 入口 double-check 语义正确。
- **`legendItems` / `seedShow` 已彻底移除**：`web/` 与 `verify/` 内均无引用，无悬空 `els.*`。

---

## 四、建议处理顺序

1. **P0**：`sync_preview_inline.mjs` 写回 → 重跑 `check_preview_*` + `--check`（§1）。
2. **P0**：定「修路中心」归属：推荐「只作 UI 层展示顺序，不透传引擎」（§2）。
3. **P1 一致性**：`roadTileIdx` 与 `roadCache` 同步淘汰（§3）；`settlementJson` 加 poi 过滤（§4）。
4. **P1 性能**：DI 拒绝边负缓存 + 重试队列去重（§5）；`skeletonEdgesFor` 按 (i,j) 缓存（§6）。
5. **P1 净收益最大的一刀**：region 包去掉足迹（§7），连带解决 §4 / §8。
6. 其余 P2/P3 随手带上；清理 `verify/_*.mjs`（§16）与确认清库（§15）。

---

## 五、本次已执行 / 可复跑的命令

```bash
export PATH="/c/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd:/usr/bin:$PATH"
cd D:/codes/宗门模拟器demo

# 改动清单
git log --since="3 days ago" --pretty=format:'%h|%ad|%s' --date=format:'%Y-%m-%d %H:%M'
git diff --stat c2b80d3~1 HEAD -- . ':(exclude).workbuddy' ':(exclude)verify' ':(exclude)*.html'

# §1 实测：预览页内联是否同步
node verify/sync_preview_inline.mjs --check      # → ✘ 1 处不同步 mapgen.js

# §3 实测：roadTileIdx 无淘汰点（只有 add / has / clear）
grep -n "roadTileIdx" Server/Zongmen/Engine/js/mapgen.js

# §7 实测：前端拿到 region.settlements 却只存 {region, roads}
grep -n "settlements" web/js/main.js web/js/pb.js
```

> 需要动的回归：`verify_map` / `w3_bfs_road` / `check_preview_settle_road` / `check_preview_draw` / `frontend_smoke`，外加静态回归 `sync_preview_inline --check`。
