# 宗门模拟器 · 山河图后端 (Zongmen / ClearScript V8 + protobuf + SQLite)

> C# ASP.NET Core 8 后端, 内嵌 ClearScript V8 沙箱原样执行 `noise.js + mapgen.js`,
> 把无限流式世界的**权威内容**通过 `gzip(protobuf)` 直接落 SQLite 并按区块下发;
> 前端只剩渲染与交互, 不再运行任何地形/噪声/A\* 寻路/灵脉生成。

## 目录结构

```
宗门模拟器demo/
├─ web/                          前端 (与旧 demo 视觉一致, 仅去掉了 MapGen/noise)
│  ├─ index.html                 ← 原样保留 UI, 替换脚本标签
│  ├─ js/
│  │  ├─ pb.js                   微型 protobuf 解码器 (与服务端 MapMessages 一一对应)
│  │  ├─ mapclient.js            数据客户端: 几何工具 + /api/map/* 拉取 + 解码
│  │  ├─ renderer.js             水墨渲染器 (原样, 接收 Float32Array 同形数据)
│  │  ├─ textures.js             美术素材 (原样)
│  │  └─ main.js                 主程序 (去 MapGen, 改服务端数据驱动)
└─ Server/Zongmen/
   ├─ Zongmen.csproj
   ├─ Program.cs                 启动装配 (Kestrel 端口 8140, 静态代理 + /api/map/*)
   ├─ appsettings.json           "Zongmen": { Port, WebDir, DbPath, MaxSeeds, … }
   ├─ Domain/MapMessages.cs      protobuf-net 契约 (带符号字段标 ZigZag)
   ├─ Protocol/Codecs.cs         ProtoCodec + GZipCodec
   ├─ Storage/
   │  ├─ VirtualContext.cs       KV 抽象
   │  ├─ SqliteVirtualContext.cs Data(Key TEXT PK, Value BLOB) + 全局锁
   │  └─ MemoryVirtualContext.cs ConcurrentDictionary
   ├─ Engine/JsEngineHost.cs     每 seed 一个 V8, LRU 淘汰, 串行化门锁
   ├─ Engine/js/                 "原封不动" 的脚本 (噪声/地图/适配层)
   │  ├─ noise.js                ← 与 web 完全一致 (V8 直接执行)
   │  ├─ mapgen.js               ← 与 web 完全一致 (V8 直接执行)
   │  └─ mapgen-server.js        服务端适配层: 把 MapGen 输出打成 JSON 字符串
   ├─ Services/MapWorldService.cs 编排: JS → JSON → protobuf → gzip → KV → 下发
   └─ Web/
      ├─ StaticWebMiddleware.cs  默认代理 web/ (无需另起前端服务)
      ├─ MapEndpoints.cs         /api/map/meta|chunk|region|comm|tile|fields|stats
      └─ MapDebug.cs             /api/debug/snap (调试用截图接收)
```

## 运行

```bash
dotnet run --project Server/Zongmen          # http://127.0.0.1:8140
```

* `appsettings.json` 中 `Zongmen.Port` 默认 8140 (0.0.0.0 监听)。
* `WebDir` 留空 → 自动向上查找含 `web/index.html` 的目录。
* `DbPath` 留空 → 默认 `<工程根>/db/zongmen.sqlite`。
* `MaxSeeds`: 进程内常驻的世界数 (LRU), 默认 3。

打开 `http://127.0.0.1:8140/` 即可看到山河图, 区块流式从 `/api/map/chunk` 加载;
不用再启动任何前端/Node 静态服务。

## API 协议

| 路径 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `GET /api/map/meta` | `seed=`(可选) | `application/json` | 几何常量 + 图例 |
| `GET /api/map/chunk` | `seed,ca,cb` | `application/x-protobuf` (Content-Encoding: gzip) | 区块实例 + 精灵 (相对起点, u16 量化) |
| `GET /api/map/region`| `seed,i,j` | 同上 (protobuf) | 区域名 + 聚落 + 道路 (A\*) |
| `GET /api/map/comm`  | `seed,ci,cj`| 同上 | 群落灵气晕 + 灵脉列表 |
| `GET /api/map/tile`  | `seed,q,r` | 同上 | 单格全部事实 (海拔/湿度/灵脉/聚落/去水/在路) |
| `GET /api/map/fields`| `seed,q0,q1,r0,r1` | JSON `{q0,r0,nq,nr,d:b64}` | 小地图字段采样 |
| `GET /api/map/stats` | – | JSON | liveSeeds / dbRows / memRows |

> 区块/区域/群落经 `GetOrCreate → JS 计算 → protobuf 序列化 → gzip 压缩 → 直接写 SQLite`,
> 二次请求从 SQLite + 内存两级缓存返回。Tile / Fields 实时计算 (单格与采样窗口较小)。

## 数据准确性验证

`verify/verify_map.mjs` 在 Node 端加载同一份 `Engine/js/noise.js + mapgen.js + mapgen-server.js`,
直接调 `MapGenServer.*` 生成参考基准 → 通过 HTTP 走 protobuf+gzip 链路 → 用浏览器同款
`web/js/pb.js` 还原 → 逐字段对齐:

* 区块: count/tiles/neigh **精确**, centers ≤1e-3 px, elev/hash u16 容差,
  精灵 sprite/中心/elev/hash 容差, 相对起点坐标还原 ≤1e-3 px。
* 区域: 聚落(全部字段精确)、道路 (key 集合一致、点列 ≤1e-3 px)。
* 群落: 存在性/主格/五行/灵脉各字段精确。
* 单格: biome/disp/e/m/t 容差、灵脉/区域/聚落/去水/在路 精确。
* 确定性: 同 seed+坐标 二次请求 proto 解压字节完全一致。
* 持久化: `/api/map/stats` 显示 `dbRows > 0` 且重启进程后数据仍命中。

```bash
"C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-2/node.exe" verify/verify_map.mjs
# 期望: ========== 结果: 全部通过 ✔ ==========
```

## headless 截图 (可选)

```bash
chrome.exe --headless=new \
  --user-data-dir="C:\Users\Administrator\AppData\Local\Temp\wb-chrome-prof" \
  --no-first-run --window-size=1500,950 --virtual-time-budget=60000 \
  --screenshot=verify/shot.png \
  "http://127.0.0.1:8140/index.html?seed=42&qt=0&rt=0&zm=2.5&nofade=1"
```

也可用 URL 带 `&capture=1` 触发前端自截图回传 `/api/debug/snap`, 落地到
`verify/capture.png` (headless 异步截屏受虚拟时钟限制, 通常用 `--timeout=120000`
或人工在浏览器内交互)。