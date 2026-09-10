using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text.Json;
using Zongmen.Domain;
using Zongmen.Engine;
using Zongmen.Protocol;
using Zongmen.Storage;

namespace Zongmen.Services;

/* ============================================================
 * 地图世界服务 — 「服务端权威」编排层
 *   JS 权威计算(引擎门锁) → JSON → protobuf → gzip
 *   → 内存/ SQLite 两级缓存 → 下发
 *   Chunk / Region / Community 持久化; Tile / 字段网格 即时计算。
 *
 * R9: chunk/region/comm 的 per-key in-flight 去重 — 并发同 key miss 只
 *     build 一次, 其余等待者 double-check 命中后直接返回。
 * T2: 区域包不再落 SQLite (历史上只写不读, 纯写放大); 会话内由
 *     _regionHot (专用大容量 LRU) + _mem 兜底, 冷回访免 A* 全量重算。
 * T4: tile 缓存新鲜度改用 VM roadVersion (roadCache 每新增道路 +1) —
 *     取代旧的「seed 全局 epoch」: 只有真有新路落成才失效旧 tile 缓存,
 *     连点小地图/流式加载不再反复整片重算。
 * T3: SQLite 整理 (Flush + PruneExcept) 移入后台定时任务, 不再依赖
 *     /stats 第 N 次请求偶发触发。
 * T11: tile/grid/region 热缓存统一 LruCache (命中即提序, 单条淘汰)。
 * W1 (rev/mask 一致性): GetTileBlock 的 mask 由调用方解析(0→All)+鉴权裁剪后传入;
 *     resp.Mask 即「客户端可视为持有」的图层位 — 客户端只更新 mask 命中位的 rev,
 *     杜绝「非全量 mask 请求后把未收到图层的 rev 记为已持有」的永久缺层。
 * W2: blockLayersJson 结果与 chunk/comm 解压产物按 key 加 LRU; tile 命中比对
 *     service 层 roadVer 免抢 V8 门闩; PruneExcept 仅在确有世界被淘汰时执行。
 * ============================================================ */

public sealed class MapWorldService : IDisposable
{
    private readonly ZongmenOptions _opt;
    private readonly JsEngineHost _host;
    private readonly MemoryVirtualContext _mem;
    private readonly SqliteVirtualContext? _sql;
    private string? _metaCache;
    private readonly object _metaLock = new();

    /* tile/fieldGrid/region 热缓存 (不落 SQLite, 仅进程内) */
    private const int TileCacheCap = 1024;
    private const int GridCacheCap = 64;
    private const int RegionHotCap = 512;
    private const int RawCacheCap = 2048;      // chunk/comm 解压后 protobuf (免每块重复 GzUnwrap)
    private const int BlockLayersCap = 1024;   // blockLayersJson 结果 (块归属映射, 内容确定)
    private readonly LruCache<TileEntry> _tileCache = new(TileCacheCap);
    private readonly LruCache<string> _gridCache = new(GridCacheCap);
    private readonly LruCache<byte[]> _regionHot = new(RegionHotCap);
    private readonly LruCache<byte[]> _rawCache = new(RawCacheCap);
    private readonly LruCache<(int, int)[][]> _blockLayersCache = new(BlockLayersCap);

    /// <summary>tile 缓存条目: 值 + 生成时的 VM 道路版本号 (T4)。</summary>
    private sealed record TileEntry(byte[] Gz, long RoadVer);

    /// <summary>service 层最近观测到的 roadVer (按 seed 前缀)。
    /// roadVer 只在区域包生成(内含 A*)时前进, 故 tile 缓存命中时比对这里即可免抢 V8 门闩。</summary>
    private readonly ConcurrentDictionary<string, long> _roadVerCache = new();

    /// <summary>本会话出现过的 seed 前缀 (World() 时登记) — 维护任务据此判定
    /// 「是否有已淘汰世界留下无主行」。必须在「取用/建立」时登记, 否则某个世界
    /// 若在同一维护周期内建立又被淘汰, 其前缀将不被记住 → 残留行永不清理。</summary>
    private readonly ConcurrentDictionary<string, byte> _seenSeedPrefixes = new();

    /* R9: per-key in-flight 去重门闩 (key → lock 对象); 构建完成即移除,
        移除后新 miss 会再查缓存命中, 不会重复 build */
    private readonly ConcurrentDictionary<string, object> _buildGates = new();

    /* T3: 后台维护任务 (周期 Flush + 按 seed 前缀整理 SQLite) */
    private readonly CancellationTokenSource _maintCts = new();
    private readonly Task _maintTask;

    public MapWorldService(ZongmenOptions opt, string contentRoot)
    {
        _opt = opt;
        var jsDir = ZongmenPaths.ResolveEngineJsDir(opt, contentRoot);
        _host = new JsEngineHost(jsDir, opt.MaxSeeds);
        _mem = new MemoryVirtualContext();
        if (opt.PersistEnabled)
            _sql = new SqliteVirtualContext(ZongmenPaths.ResolveDbPath(opt, contentRoot));
        _maintTask = Task.Run(MaintenanceLoopAsync);
    }

    private JsWorldVm World(string seed)
    {
        _seenSeedPrefixes.TryAdd(WorldKeys.SeedPrefix(seed), 0);   // P3: 登记已用过的世界
        return _host.GetOrCreate(seed);
    }

    /* ---------------- 区块 ---------------- */
    public byte[] GetChunkBytes(string seed, int ca, int cb)
    {
        var key = WorldKeys.Chunk(seed, ca, cb);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);      // T8: 库命中回填 _mem
        if (hit != null) return hit;

        /* R9: 同 key 并发 miss 合并 — 只 build 一次 */
        return BuildOnce(key, () =>
        {
            var vm = World(seed);
            var gz = BuildChunk(vm, ca, cb);
            Store(key, gz);
            return gz;
        });
    }

    private byte[] BuildChunk(JsWorldVm vm, int ca, int cb)
    {
        var json = vm.Call("chunkJson", ca, cb);
        using var d = JsonDocument.Parse(json);
        var root = d.RootElement;
        var count = root.GetProperty("count").GetInt32();
        var pn = root.GetProperty("pn").GetInt32();
        var p = new ChunkPayload
        {
            Ca = root.GetProperty("ca").GetInt32(),
            Cb = root.GetProperty("cb").GetInt32(),
            Count = count,
            Pn = pn,
        };
        /* P5: 单段定宽缓冲解包。JS 布局 (全小端):
             地块段 n×11B = [cq u8][cr u8][tiles u8][elev u16][hash u16][neigh u32]
             精灵段 pn×13B = [pdx f32][pdy f32][psp u8][ph u16][pe u16] */
        const int tileBytes = 11;   // 地块段每格字节数 (精灵段长度由 pn 与 raw 总长校验)
        var raw = B64(root, "d");
        int o = 0;
        p.Cq = Slice(raw, o, count); o += count;
        p.Cr = Slice(raw, o, count); o += count;
        p.Tiles = Slice(raw, o, count); o += count;
        p.Elev = Slice(raw, o, count * 2); o += count * 2;
        p.Hash = Slice(raw, o, count * 2); o += count * 2;
        p.Neigh = Slice(raw, o, count * 4); o += count * 4;
        if (o != count * tileBytes) throw new InvalidDataException("chunk 地块段长度不符");
        p.Pdx = Slice(raw, o, pn * 4); o += pn * 4;
        p.Pdy = Slice(raw, o, pn * 4); o += pn * 4;
        p.Psp = Slice(raw, o, pn); o += pn;
        p.Ph = Slice(raw, o, pn * 2); o += pn * 2;
        p.Pe = Slice(raw, o, pn * 2); o += pn * 2;
        if (o != raw.Length) throw new InvalidDataException("chunk 缓冲长度不符");
        var proto = ProtoCodec.SerToByte(p);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 区域包 ---------------- */
    public byte[] GetRegionBytes(string seed, int i, int j)
    {
        var key = WorldKeys.Region(seed, i, j);
        /* 区域包含 A* 道路且 tileJson 的 onRoad 依赖 VM roadCache 热状态:
           若直接命中 SQLite 旧行, VM 不执行生成 → 道路缓存与画面/详情不一致。
           故区域包总是经 JS 生成(确定性, 与历史字节一致)。
           T2: 会话内由 _regionHot (大容量专用 LRU) + _mem 兜底; 不再落 SQLite —
           区域行历史上只写不读, 落库纯写放大 (冷回访本来就须重跑 A* 保证语义)。 */
        var hit = _regionHot.Get(key) ?? _mem.GetDataBytes(key);
        if (hit != null) return hit;

        var gz = BuildOnce(key, () =>
        {
            var vm = World(seed);
            var g = BuildRegion(vm, i, j);
            _regionHot.Set(key, g);
            _mem.SetData(key, g);
            return g;
        });
        /* 区域包含 A*(roadsNear) → 可能使 roadCache 前进; 刷新 service 层 roadVer,
           使后续 tile 缓存命中无需再进 V8 门闩 (T4 语义不变: 版本变则旧 tile 失效)。 */
        _roadVerCache[WorldKeys.SeedPrefix(seed)] = World(seed).RoadVersion();
        return gz;
    }

    private byte[] BuildRegion(JsWorldVm vm, int i, int j)
    {
        var json = vm.Call("regionJson", i, j);
        using var d = JsonDocument.Parse(json);
        var r = d.RootElement;
        var pack = new RegionPack
        {
            I = i, J = j,
            Region = new RegionInfoDto
            {
                Q = r.GetProperty("region").GetProperty("q").GetInt32(),
                R = r.GetProperty("region").GetProperty("r").GetInt32(),
                X = F(r.GetProperty("region"), "x"),
                Y = F(r.GetProperty("region"), "y"),
                Biome = r.GetProperty("region").GetProperty("biome").GetInt32(),
                Name = r.GetProperty("region").GetProperty("name").GetString() ?? "",
            },
        };
        foreach (var s in r.GetProperty("settlements").EnumerateArray())
        {
            pack.Settlements.Add(new SettlementDto
            {
                Id = s.GetProperty("id").GetString() ?? "",
                Type = s.GetProperty("type").GetString() ?? "",
                Q = s.GetProperty("q").GetInt32(),
                R = s.GetProperty("r").GetInt32(),
                X = F(s, "x"),
                Y = F(s, "y"),
                Name = s.GetProperty("name").GetString() ?? "",
                Pop = s.GetProperty("pop").GetInt32(),
                /* WebSocket 单块接口 (设计 §3.4): 实体骨架字段 */
                Owner = s.TryGetProperty("owner", out var ow) && ow.ValueKind == JsonValueKind.String
                    ? ow.GetString() ?? "" : "",
                Tier = s.TryGetProperty("tier", out var tr) ? tr.GetInt32() : 0,
                State = s.TryGetProperty("state", out var stt) ? stt.GetInt32() : 0,
                ExpireTs = s.TryGetProperty("expireTs", out var ex) ? ex.GetInt64() : 0,
            });
        }
        foreach (var rd in r.GetProperty("roads").EnumerateArray())
        {
            var ptsJson = rd.GetProperty("pts");
            var ptsBytes = new byte[ptsJson.GetArrayLength() * 4];
            var k = 0;
            foreach (var pt in ptsJson.EnumerateArray())
            {
                var b = BitConverter.GetBytes(pt.GetSingle());
                ptsBytes[k++] = b[0]; ptsBytes[k++] = b[1];
                ptsBytes[k++] = b[2]; ptsBytes[k++] = b[3];
            }
            pack.Roads.Add(new RoadDto
            {
                Key = rd.GetProperty("key").GetString() ?? "",
                X0 = F(rd, "x0"), Y0 = F(rd, "y0"),
                X1 = F(rd, "x1"), Y1 = F(rd, "y1"),
                Pts = ptsBytes,
            });
        }
        var proto = ProtoCodec.SerToByte(pack);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 群落包 ---------------- */
    public byte[] GetCommBytes(string seed, int ci, int cj)
    {
        var key = WorldKeys.Comm(seed, ci, cj);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);      // T8: 库命中回填 _mem
        if (hit != null) return hit;

        return BuildOnce(key, () =>
        {
            var vm = World(seed);
            var gz = BuildComm(vm, ci, cj);
            Store(key, gz);
            return gz;
        });
    }

    private byte[] BuildComm(JsWorldVm vm, int ci, int cj)
    {
        var json = vm.Call("commJson", ci, cj);
        using var d = JsonDocument.Parse(json);
        var r = d.RootElement;
        var pack = new CommunityPack
        {
            Ci = ci, Cj = cj,
            Exists = r.GetProperty("exists").GetBoolean(),
        };
        if (pack.Exists)
        {
            pack.Q = r.GetProperty("q").GetInt32();
            pack.R = r.GetProperty("r").GetInt32();
            pack.X = F(r, "x");
            pack.Y = F(r, "y");
            pack.Element = r.GetProperty("element").GetInt32();
            pack.Spirit = F(r, "spirit");
            foreach (var v in r.GetProperty("veins").EnumerateArray())
            {
                pack.Veins.Add(new VeinDto
                {
                    Name = v.GetProperty("name").GetString() ?? "",
                    Element = v.GetProperty("element").GetInt32(),
                    Variant = v.TryGetProperty("variant", out var va) && va.ValueKind == JsonValueKind.String
                        ? va.GetString() ?? "" : "",
                    Level = v.GetProperty("level").GetInt32(),
                    Q = v.GetProperty("q").GetInt32(),
                    R = v.GetProperty("r").GetInt32(),
                    X = F(v, "x"),
                    Y = F(v, "y"),
                });
            }
        }
        var proto = ProtoCodec.SerToByte(pack);
        return GZipCodec.Compress(proto);
    }

    /* R9: per-key 构建门闩 (chunk/region/comm 共用) */
    private byte[] BuildOnce(string key, Func<byte[]> build)
    {
        var gate = _buildGates.GetOrAdd(key, _ => new object());
        lock (gate)
        {
            try
            {
                /* double-check: 等待期间可能已被并发请求 build 完成 */
                if (_mem.GetDataBytes(key) is byte[] memHit) return memHit;
                return build();
            }
            finally
            {
                _buildGates.TryRemove(key, out _);
            }
        }
    }

    /* ---------------- WebSocket 单块统一接口 (设计 §3/§4) ----------------
     * GetTileBlock(i, j, mask, lastRevs): 一个块 = 一个 TileResponse,
     * 内含 chunk/region/settle/poi/comm 五个独立子消息, mask 按位选层。
     * 主块坐标系 = 区块格 (方案 A): i,j 即 chunk (ca,cb);
     * 块覆盖的 region/comm 格由 JS blockLayersJson 权威给出。
     * Revs: 按块的图层版本 (对齐 roadVer 思路)。当前世界确定性无事件,
     * rev 恒 1; 客户端带 lastRevs 且未变化时该层子消息缺省 (响应最小化)。
     * 未来建筑事件只需 BumpBlockRev 后让客户端重拉该块即可。 */
    private sealed class BlockRevs
    {
        public int Chunk = 1, Region = 1, Settle = 1, Poi = 1, Comm = 1;
        public int ByBit(int bit) => bit switch
        {
            0 => Chunk, 1 => Region, 2 => Settle, 3 => Poi, _ => Comm
        };
        public void Bump(uint mask)
        {
            if ((mask & (uint)TileMask.Chunk) != 0) Chunk++;
            if ((mask & (uint)TileMask.Region) != 0) Region++;
            if ((mask & (uint)TileMask.Settle) != 0) Settle++;
            if ((mask & (uint)TileMask.Poi) != 0) Poi++;
            if ((mask & (uint)TileMask.Comm) != 0) Comm++;
        }
    }

    private readonly ConcurrentDictionary<string, BlockRevs> _blockRev = new();

    /// <summary>事件钩子 (预留): 置某块某图层脏, 客户端下次带旧 rev 重拉时才会收到该层数据。</summary>
    public void BumpBlockRev(string seed, int i, int j, TileMask layers)
    {
        var revs = _blockRev.GetOrAdd("blk:" + WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j,
                                      _ => new BlockRevs());
        revs.Bump((uint)layers);
    }

    /// <summary>
    /// 构造单块响应。mask 为「已解析、已鉴权」的图层位 (由调用方完成 0→All 归一与
    /// 未登录裁剪); 本方法按字面语义处理, 不再自行把 0 当 All。
    /// 语义约定: resp.Mask = 本次「客户端可视为持有」的图层位
    ///   = mask 中「已下发数据」或「rev 命中(客户端本就持有)」的位。
    ///   恒等于入参 mask —— 因为 Need(bit)=true 时会下发, Need=false 时客户端已持有。
    /// 客户端据此只更新 mask 命中位的 rev (未命中位保持 0 = 未持有), 从根上避免
    /// 「非全量 mask 请求后把未收到图层的 rev 记为已持有」导致的永久缺层。
    /// </summary>
    public TileResponse GetTileBlock(string seed, int i, int j, uint mask, List<int>? lastRevs)
    {
        mask &= (uint)TileMask.All;
        var revs = _blockRev.GetOrAdd("blk:" + WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j,
                                      _ => new BlockRevs());
        int[] revArr = [revs.Chunk, revs.Region, revs.Settle, revs.Poi, revs.Comm];
        var resp = new TileResponse { I = i, J = j, Mask = mask, Revs = [.. revArr] };

        /* 图层是否需要下发: mask 命中 且 (客户端未持有 或 rev 已变化) */
        bool Need(int bit)
        {
            if ((mask & (1u << bit)) == 0) return false;
            var lr = lastRevs != null && bit < lastRevs.Count ? lastRevs[bit] : 0;
            return lr <= 0 || lr != revArr[bit];
        }
        bool needChunk = Need(0), needRegion = Need(1), needSettle = Need(2),
             needPoi = Need(3), needComm = Need(4);
        if (!needChunk && !needRegion && !needSettle && !needPoi && !needComm)
            return resp;   // 全层 rev 未变: 最小响应 (验收 §8.6)

        var vm = World(seed);
        if (needChunk)
            resp.Chunk = UnwrapCached(WorldKeys.Chunk(seed, i, j), GetChunkBytes(seed, i, j));

        /* 块归属映射: 仅在需要 region/settle/poi/comm 层时向 JS 取一次 (结果走 LRU) */
        ((int, int)[] regions, (int, int)[] comms)? layers =
            (needRegion || needSettle || needPoi || needComm) ? GetBlockLayers(vm, seed, i, j) : null;

        /* 图层1/2/3 共用区域包: 聚落实体从 RegionPack.settlements 拆出 */
        if (needRegion || needSettle || needPoi)
        {
            var settleGroups = new List<EntityGroup>();
            var poiGroups = new List<EntityGroup>();
            foreach (var (ri, rj) in layers!.Value.regions)
            {
                var pack = DesFromGz<RegionPack>(GetRegionBytes(seed, ri, rj));
                if (needRegion)
                {
                    resp.Regions.Add(new RegionData
                    {
                        I = ri, J = rj, Info = pack.Region, Roads = pack.Roads,
                    });
                }
                if (needSettle)
                {
                    var items = new List<PlaceEntity>();
                    foreach (var s in pack.Settlements)
                    {
                        if (s.Type == "poi") continue;
                        items.Add(ToEntity(s));
                    }
                    if (items.Count > 0) settleGroups.Add(new EntityGroup { I = ri, J = rj, Items = items });
                }
                if (needPoi)
                {
                    var items = new List<PlaceEntity>();
                    foreach (var s in pack.Settlements)
                    {
                        if (s.Type != "poi") continue;
                        items.Add(ToEntity(s));
                    }
                    if (items.Count > 0) poiGroups.Add(new EntityGroup { I = ri, J = rj, Items = items });
                }
            }
            if (needSettle && settleGroups.Count > 0) resp.Settle = new SettleData { Groups = settleGroups };
            if (needPoi && poiGroups.Count > 0) resp.Poi = new PoiData { Groups = poiGroups };
        }

        /* 图层4: 群落包原样嵌入 (CommunityPack protobuf) */
        if (needComm)
        {
            foreach (var (ci, cj) in layers!.Value.comms)
                resp.Comms.Add(UnwrapCached(WorldKeys.Comm(seed, ci, cj), GetCommBytes(seed, ci, cj)));
        }
        return resp;
    }

    private static PlaceEntity ToEntity(SettlementDto s) => new()
    {
        Id = s.Id, Type = s.Type, Q = s.Q, R = s.R, X = s.X, Y = s.Y,
        Name = s.Name, Pop = s.Pop, Owner = s.Owner,
        Tier = s.Tier, State = s.State, ExpireTs = s.ExpireTs,
    };

    /* 块归属映射: (regions[], comms[]) — JS 权威 (blockLayersJson)
       结果仅依赖 (seed,i,j) 且内容确定 (region/comm 归属映射与事件无关),
       故按 seedprefix:i:j 加 LRU, 免每次块请求重跑 V8 + JSON 解析。 */
    private ((int, int)[] regions, (int, int)[] comms) GetBlockLayers(JsWorldVm vm, string seed, int i, int j)
    {
        var key = WorldKeys.SeedPrefix(seed) + ":" + i + ":" + j;
        var cached = _blockLayersCache.Get(key);
        if (cached != null) return (cached[0], cached[1]);

        using var d = JsonDocument.Parse(vm.Call("blockLayersJson", i, j));
        var r = d.RootElement;
        var regions = ReadPairs(r.GetProperty("regions"));
        var comms = ReadPairs(r.GetProperty("comms"));
        _blockLayersCache.Set(key, [regions, comms]);
        return (regions, comms);
    }

    private static (int, int)[] ReadPairs(JsonElement arr)
    {
        var outp = new (int, int)[arr.GetArrayLength()];
        var n = 0;
        foreach (var p in arr.EnumerateArray())
        {
            var it = p.EnumerateArray().GetEnumerator();
            it.MoveNext(); var a = it.Current.GetInt32();
            it.MoveNext(); var b = it.Current.GetInt32();
            outp[n++] = (a, b);
        }
        return outp;
    }

    private static byte[] GzUnwrap(byte[] gz) => GZipCodec.Decompress(gz);

    /* chunk/comm 子消息嵌入 TileResponse 前必须解压成原始 protobuf, 而同一 key
       在多块/多次请求中重复出现 (邻块共享、视野反复) → 解压结果按 key 缓存,
       免每块重复 GzUnwrap。内容按 (seed,坐标) 确定, 缓存只损失命中率不影响正确性。 */
    private byte[] UnwrapCached(string key, byte[] gz)
    {
        var raw = _rawCache.Get(key);
        if (raw != null) return raw;
        raw = GzUnwrap(gz);
        _rawCache.Set(key, raw);
        return raw;
    }

    private static T DesFromGz<T>(byte[] gz) => ProtoCodec.DesFromByte<T>(GzUnwrap(gz));

    /* T8: SQLite 命中后回填 _mem, 同一 key 后续读取不再走库 */
    private byte[]? ReadSqlBackfill(string key)
    {
        if (_sql == null) return null;
        var v = _sql.GetDataBytes(key);
        if (v != null) _mem.SetData(key, v);
        return v;
    }

    /* ---------------- 单格详情 (不落库) ---------------- */
    /* T4: 进程内热缓存 — key = "t:<seedprefix>:<q>:<r>", 值带 VM roadVersion。
       tileJson 的 onRoad 语义与 VM roadCache 相关 (点击零 A*, 只读已生成道路)。
       仅当 roadCache 真有新路落成 (roadVersion 前进) 时旧条目失效重算;
       区域包缓存命中/流式补齐不再整片作废 tile 缓存。
       P1: 命中路径比对 service 层 _roadVerCache (区域包生成时刷新) → 免抢 V8 门闩。 */
    public byte[] GetTileBytes(string seed, int q, int r)
    {
        var cacheKey = "t:" + WorldKeys.SeedPrefix(seed) + ":" + q + ":" + r;
        var cached = _tileCache.Get(cacheKey);
        if (cached != null)
        {
            /* P1: 命中路径优先比对 service 层 roadVer (区域包生成时刷新), 免每次
               抢 V8 门闩取 RoadVersion — tile 是高频路径(小地图轮询+点击连发)。
               首次无记录时才进 V8 取一次; roadVer 只在区域包生成时前进, 故此后
               命中即无锁直返。 */
            var prefix = WorldKeys.SeedPrefix(seed);
            if (_roadVerCache.TryGetValue(prefix, out var known))
            {
                if (cached.RoadVer == known) return cached.Gz;
            }
            else
            {
                var v0 = World(seed).RoadVersion();
                _roadVerCache[prefix] = v0;
                if (cached.RoadVer == v0) return cached.Gz;
            }
        }

        var vm = World(seed);
        var json = vm.Call("tileJson", q, r);
        var ver = vm.RoadVersion();     // 取生成后版本: 若生成途中恰好新路落成, 下次请求会按新版本重算
        _roadVerCache[WorldKeys.SeedPrefix(seed)] = ver;
        using var d = JsonDocument.Parse(json);
        var rt = d.RootElement;
        var f = rt.GetProperty("f");
        var tq = new TileQuery
        {
            Q = q, R = r,
            E = F(f, "e"), M = F(f, "m"), T = F(f, "t"),
            Biome = f.GetProperty("biome").GetInt32(),
            Disp = f.GetProperty("disp").GetInt32(),
            Variant = f.GetProperty("variant").GetInt32(),
            RegionI = rt.GetProperty("region").GetProperty("i").GetInt32(),
            RegionJ = rt.GetProperty("region").GetProperty("j").GetInt32(),
            RegionName = rt.GetProperty("region").GetProperty("name").GetString() ?? "",
            RegionBiome = rt.GetProperty("region").GetProperty("biome").GetInt32(),
            OnRoad = rt.GetProperty("onRoad").GetBoolean(),
        };
        if (rt.TryGetProperty("vein", out var v) && v.ValueKind == JsonValueKind.Object)
        {
            tq.HasVein = true;
            tq.VeinElement = v.GetProperty("element").GetInt32();
            tq.VeinVariant = v.TryGetProperty("variant", out var vv) && vv.ValueKind == JsonValueKind.String
                ? vv.GetString() ?? "" : "";
            tq.VeinLevel = v.GetProperty("level").GetInt32();
            tq.VeinD = v.GetProperty("d").GetInt32();
            tq.VeinName = v.GetProperty("name").GetString() ?? "";
        }
        if (rt.TryGetProperty("place", out var pl) && pl.ValueKind == JsonValueKind.Object)
        {
            tq.PlaceType = pl.GetProperty("type").GetString() ?? "";
            tq.PlaceName = pl.GetProperty("name").GetString() ?? "";
            tq.PlacePop = pl.GetProperty("pop").GetInt32();
        }
        /* 去水距离: 原算法陆上 4 环无水的 -1 → 255 (无符号便于 wire) */
        var wd = rt.GetProperty("waterD").GetInt32();
        tq.WaterD = wd < 0 ? 255 : wd;
        var proto = ProtoCodec.SerToByte(tq);
        var gz = GZipCodec.Compress(proto);

        _tileCache.Set(cacheKey, new TileEntry(gz, ver));
        return gz;
    }

    /* ---------------- 字段网格 / 元信息 (JSON) ---------------- */
    /* R8: 小地图同窗口重复轮询(0.4~1.5s)直接命中, 免每次占 V8 门闩 */
    public string GetFieldGridJson(string seed, int q0, int q1, int r0, int r1)
    {
        var cacheKey = "g:" + WorldKeys.SeedPrefix(seed) + ":" + q0 + ":" + q1 + ":" + r0 + ":" + r1;
        var hit = _gridCache.Get(cacheKey);
        if (hit != null) return hit;

        var vm = World(seed);
        var json = vm.Call("fieldGridJson", q0, q1, r0, r1);
        _gridCache.Set(cacheKey, json);
        return json;
    }

    public string GetMetaJson(string seed)
    {
        lock (_metaLock)
        {
            if (_metaCache != null) return _metaCache;
        }
        var vm = World(seed);
        var json = vm.Call("metaJson");
        lock (_metaLock)
        {
            _metaCache ??= json;
        }
        return json;
    }

    public string StatsJson()
    {
        /* P6: 先排空批量落库队列, 计数才反映真实落库进度。
           T3: 历史行清理已移入后台维护任务, 不再依赖 /stats 偶发触发。 */
        _sql?.Flush();
        return System.Text.Json.JsonSerializer.Serialize(new
        {
            liveSeeds = _host.LiveSeeds,
            maxSeeds = _opt.MaxSeeds,      // 便于验证 appsettings.json 是否真的生效
            dbRows = _sql?.Count() ?? 0,
            memRows = _mem.Count(),
        });
    }

    /* T3: 后台维护 — 周期排空写队列 + 清理「非活跃 seed」的历史缓存行
       (世界可按 seed 确定性重建, 属安全缓存清理)。不依赖 /stats 请求节奏。 */
    private async Task MaintenanceLoopAsync()
    {
        try
        {
            while (!_maintCts.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMinutes(2), _maintCts.Token).ConfigureAwait(false);
                try
                {
                    _sql?.Flush();
                    if (_sql != null && _host.LiveSeeds > 0)
                    {
                        var prefixes = new List<string>();
                        foreach (var seed in _host.Seeds)
                            prefixes.Add("w:" + WorldKeys.SeedPrefix(seed) + ":");
                        /* P3: 仅当「确有某个曾出现过的世界已被淘汰」时才清理 —
                           否则 DELETE ... NOT(...LIKE OR...) 每 2 分钟白扫全表。
                           _seenSeedPrefixes 在 World() 处登记; 一旦某前缀不再活跃
                           (= 该世界被 LRU 淘汰), 才有无主行需要删除。 */
                        bool stale = false;
                        foreach (var p in _seenSeedPrefixes.Keys)
                            if (!prefixes.Contains(p)) { stale = true; break; }
                        if (stale)
                        {
                            _sql.PruneExcept(prefixes);
                            _seenSeedPrefixes.Clear();      // 已淘汰者的行已删, 记忆重置为当前活跃集
                        }
                        foreach (var p in prefixes) _seenSeedPrefixes.TryAdd(p, 0);
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("[MapWorldService] 维护任务异常(下轮重试): " + ex.Message);
                }
            }
        }
        catch (OperationCanceledException) { }
    }

    private void Store(string key, byte[] gz)
    {
        _mem.SetData(key, gz);
        _sql?.SetDataDeferred(key, gz);     // P6: 冷生成异步批量落库, 不阻塞请求路径
    }

    private static byte[] B64(JsonElement e, string name)
        => Convert.FromBase64String(e.GetProperty(name).GetString() ?? "");

    private static byte[] Slice(byte[] src, int offset, int len)
    {
        if (len <= 0) return [];
        var dst = new byte[len];
        Buffer.BlockCopy(src, offset, dst, 0, len);
        return dst;
    }

    private static float F(JsonElement e, string name)
        => e.GetProperty(name).GetSingle();

    public void Dispose()
    {
        _maintCts.Cancel();
        try { _maintTask.Wait(1000); } catch { /* 忽略 */ }
        _host.Dispose();
        _sql?.Flush();              // P6: 退出前排空批量写入, 尽量落库
        _sql?.Dispose();
        _mem.Dispose();
        _maintCts.Dispose();
    }
}
