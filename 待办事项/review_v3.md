# 宗门模拟器 demo3 · 前后端整体代码审核 v3

> 审核对象：`web/js/*`(main/mapclient/noiselib/pb/textures/renderer)、`Server/Zongmen/Engine/js/*`(noise/mapgen/mapgen-server)、
> `Server/Zongmen/*.cs`(Program/Options/MapWorldService/JsEngineHost/MapEndpoints/StaticWebMiddleware/ApiRateLimit 及 Storage/Domain/Protocol/Web)。
> 性质：性能 & 正确性 & 潜在 bug 定向扫描（v3 为在 v1/v2 基础上补充的新一轮深审，含跨文件一致性与遗漏面）。
> 评级：🔴 高（正确性/需处理）· 🟠 中（可优化/风险）· 🟢 低（维护性/注释）。

---

## 〇、v3 新增发现速览

| # | 模块 | 级别 | 一句话 |
|---|------|------|--------|
| 1 | `MapWorldService.GetRegionBytes` | 🟠 | 区域包只写 SQLite、从不回读，落库纯属浪费（v2 提到但v3落实为「按 new seed 持续膨胀」后果） |
| 2 | `SqliteVirtualContext` 单库无限膨胀 | 🟠 | `PruneExcept` 仅在 `/stats` 第 20 次请求触发，非活跃 seed 的各种历史世界数据长期占用磁盘(33MB+) |
| 3 | `_regionEpoch` 每生成一次区域就全 seed 失效一次 | 🟠 | 使 tile 缓存（最多1024条）频繁整片清空，连点小地图反复重算 |
| 4 | `MemoryVirtualContext` 淘汰触发 O(n) 扫描 | 🟢 | 每次超限用 `Take(cap/4)` 全量遍历，热点轮询时反复整表扫描 |
| 5 | `ApiRateLimitMiddleware` 清理概率采样 | 🟢 | `(now & 0x3FF)==0` 按当前时间低位，非频率担保；仅防膨胀可用 |
| 6 | `main.js` 静态层 drawOnDemand 链路 | 🟢 | `staticNeedsRedraw` 用相机位移阈值 + `setTimeout`，高 DPR 下可能产生绘制抖动（低） |

---

## 一、性能（前端）

### 🟠 1.1 静态覆盖层每帧全量重建（路网 + 标注）
`main.js drawOverlay()`（L706-L734）每帧：
- 由 `staticNeedsRedraw()` 判断是否重绘；但 `regionCells.forEach` 生成 `haloV/coreV` 顶点数组，
  每帧即使相机静止只要 `staticDirty` 或位移超阈值就全量重算并 `setRoads()` → `bufferData(DYNAMIC)` 重传整个路网。
- 与 v2 #8 一致，但补充一个点：**当新 chunk/region 陆续到达时，`markStaticDirty` 的 200ms 节流能在“数据洪峰”合并，但一次全量重绘的成本仍与整张地图区域数成正比**。

**建议**：把路网顶点、区域名/灵脉名标注拆成「分块缓存」；仅失效块重绘。或把路网烘焙到离屏 Canvas 作为图层，平移时只做 `drawImage` 位移。当前规模可接受，但地图越大越明显。

### 🟠 1.2 精灵层 `propPad` 余量过大
`renderer.js` 中 `propPad = hexR*12`，Pass1.5 对每个 chunk 做 `boxHits(bbox, viewBox, propPad)` 粗剔除。
`hexR=8 → pad=96px`，远大于实际精灵高度（约 3.3~4.5 倍半径 ≈ 26~36px）。
- 影响：视口外的 chunk 常因 pad 过大仍进 Pass1.5，绘制成本略高；但只多画不入 buffer，无正确性问题。

### 🟢 1.3 `pxToTile`/`tileToWorld` 无条件重算（同 v2 #9）
Canvas2D 小地图每像素调 `pxToTile`，无 tile 级缓存；dPR=2 与全屏缩放时逐像素成本累积。低优先级，热点出现再优化。

---

## 二、性能（后端）

### 🟠 2.1 区域包只写而不读 → SQL 落库与磁盘双重浪费
`MapWorldService.GetRegionBytes`（L126-154）：
```csharp
var hit = _mem.GetDataBytes(key);          // 只查内存
if (hit != null) return hit;
...
Store(key, gz);                            // _sql?.SetDataDeferred(...) 照写
```
- 每次区域**冷回访**都走 JS VM 全量 `regionJson`（含 A*），与 SQLite 中既有行无关。
- 结论：`db/zongmen.sqlite` 中 `w:…:region:…` 记录自写入起永不回读，仅做无意义持久化 + 占磁盘。
- **建议**：要么不再写 region 行（省 IO/磁盘），要么为 `tileJson.onRoad` 引入与道路生成同源的版本号，使 region 可安全走 SQLite 冷读（v1/v2 已提，v3 建议直接落地其一）。

### 🟠 2.2 SQLite / 缓存无界增长（新增后果分析）
- `MaxSeeds=3` 只限制 V8 实例；每次 `regenerate` 或新 seed 都会把一整套 chunk/region/comm 写入 SQLite。
- `PruneExcept(prefixes)` 只在 `/stats` 偶发触发（每 20 次统计），且只按“当前存活 seed”过滤；历史 seed 若已被 LRU 淘汰，其数据永不清除。
- 现 `db/zongmen.sqlite` 已 33MB；长期多 seed 使用会持续膨胀。
- **建议**：a) 为 persistent 加 TTL/大小预算，按最近访问或 seed 时间淘汰；b) 将 prune 移到运行期定时（后台任务），而非依赖 `/stats` 调用；c) `region` 不落库后体积可大幅回落。

### 🟢 2.3 `_regionEpoch` 失效粒度过粗（同 v2 #3 的落实方案）
- `GetRegionBytes` 每次生成后 `++_regionEpoch[seed]`，使该 seed 全部 tile 缓存条目失效。建议按 `(seed,i,j)` 粒度维护，只失效「当前区域内的 tile」。

### 🟢 2.4 `MemoryVirtualContext` 淘汰 O(n)
`EvictIfOver()` 用 `Take(cap/4)` 遍历 Keys 再删除。容量大或热点轮询时反复整表扫描。建议用有序结构（`LinkedHashMap`/`OrderedDictionary`）或固定分片。

---

## 三、正确性 / 潜在 Bug

### 🔴 3.1（确认无碍）chunk 坐标还原 — 校验通过
`mapclient.chunkToArrays`：`qa = ca*S + (cq[i]-16)`，服务端 `dq+16` → 还原 `dq=q-ca*S`，`qa=q`。配 `Path.resolve` 与 `NEIGH_SLOTS` 一致，未发现坐标错位。✔

### 🟠 3.2 `ApiRateLimitMiddleware` 清理采样的伪随机性
`if (_hits.Count > 1024 && (now & 0x3FF) == 0) Prune(now)`：
- 用当前时钟低位作“每隔约1024次请求”触发器，但触发时机不可控（可能与窗口边界无关）。
- 结果：不至于无限增长（rate 上限 <120/5s），但到达上限附近时可能长时间不清理窗口 → 内存短暂上升。低风险，可接受。

### 🟠 3.3 `loadExtra`/`pump` 的 `regionBusy/commBusy` 与 `keepR/keepC` 竞态（已核对无 bug）
`loadExtra` 完成后先判 `keepR/keepC` 再写 map；`busy.delete` 恒在末尾。卸载与回归竞态下**不会把已卸载格重新填回**。✔ 但 `regionQueue`/`commQueue` 重建逻辑里，`pumpExtra` 可能在 `queue.length=0` 后仍被在途回调调用——已确认安全（判断 `busy.has`）。✔

### 🟢 3.4 注释/命名不一致（低）
- `textures.js` 头注释写“共7行”，实际 `ATLAS_ROWS=8` 且第5/6/7行放精灵；注释滞后于实现（v2 已提，v3 确认仍在）。
- `mapgen.js` 的 `COUNT_VEINS` 刷星 `configuration` 语义与 `R11` 注释有待同步。

---

## 四、跨文件一致性审计（v3 新增）

| 契约 | 服务端 | 前端 | 结论 |
|------|--------|------|------|
| 区块字段顺序/字节宽 | `BuildChunk` 单段 11n+13pn | `pb.decodeChunkMsg/chunkToArrays` 同序同宽 | ✔ |
| 区域/群路点数 | `regionJson.roads[].pts` 交错 f32 | `toF32(rdLen)` | ✔ |
| 灵脉灯色 | `ELEMENT_RGB`(5) | `geoElementColor` 数组一致 | ✔ |
| `meta` 几何 | `CHUNK_S/SCAN/REGION_M/COMM_CL/R` | `geo()` 同名映射 | ✔ |
| 精灵行号 | `propSpriteFor` 40..63 | `PROP_FS` 行号整除 8 | ✔(受 ATLAS_ROWS 耦合，见v2#1) |
| 限流窗口 | tile/fields | 仅命中这两个端点 | ✔ |

---

## 五、测试覆盖缺口

- `verify_map.mjs` 主要覆盖区块坐标/地貌/海拔/哈希/邻域/精灵、区域、群落、单格，310 项。未覆盖：
  1. **SQLite 冷读路径**（当前 region 根本不读库，所以无路径可测 —— 印证 2.1）。
  2. **`_regionEpoch` 失效后的 tile 重算正确性**（连点小地图）。
  3. **多 seed 切换后 SQLite 膨胀/清理**。
  4. **限流触发后 429 行为**与前端重试。
  5. **`renderer` 分块/精灵边界**（无 WebGL 单测，仅页面级验证）。
  6. `capture.png`/`shot_*.png` 回归基线仅机器可见，建议加入 diff 阈值告警。

---

## 六、建议处理顺序

1. **2.1 + 2.2**：`region` 不落库或为 `onRoad` 引入版本号；SQLite 加定时整理/按 seed 预算。（影响磁盘与冷启动）
2. **2.3**：epoch 按区域粒度失效，减少 tile 缓存无谓清空。
3. **1.1**：路网/标注分块缓存，降低平移 & 数据洪峰期重绘成本。
4. **2.4 / 3.2**：淘汰与清理改用有序结构，去掉依赖 `/stats` 的偶发清理。
5. **4.0 注记**：`ATLAS_ROWS` 抽公共常量 + 构建期断言（承接 v2#1）。

---

## 七、总体结论

- 架构（C# 权威 + V8 沙箱 + protobuf/gzip + 两级缓存 + 前端纯渲染）**设计正确、无明显结构性缺陷**；
- 正确性上未发现会导致画面错版或数据损坏的确定性 bug；坐标/字节序/元数据/色彩跨文件一致。
- 主要风险集中在**持久化生命周期**（region 只写不读、SQLite 无限膨胀、epoch 粗粒度失效）与**渲染静态层全量重绘**；
- 建议把 v3 的 2.1/2.2/2.3 与 v2 的 #1/#2/#3 合并为一个「存储与缓存生命周期」迭代，前端分块预烘焙为后续优化。