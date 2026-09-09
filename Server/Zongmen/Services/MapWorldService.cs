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
    private readonly LruCache<TileEntry> _tileCache = new(TileCacheCap);
    private readonly LruCache<string> _gridCache = new(GridCacheCap);
    private readonly LruCache<byte[]> _regionHot = new(RegionHotCap);

    /// <summary>tile 缓存条目: 值 + 生成时的 VM 道路版本号 (T4)。</summary>
    private sealed record TileEntry(byte[] Gz, long RoadVer);

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

    private JsWorldVm World(string seed) => _host.GetOrCreate(seed);

    /* ---------------- 区块 ---------------- */
    public byte[] GetChunkBytes(string seed, int ca, int cb)
    {
        var key = WorldKeys.Chunk(seed, ca, cb);
        var hit = _mem.GetDataBytes(key) ?? ReadSqlBackfill(key);      // T8: 库命中回填 _mem
        if (hit != null) return hit;

        /* R9: 同 key 并发 miss 合并 — 只 build 一次 */
        return BuildOnce(key, seed, () =>
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
        const int tileBytes = 11, propBytes = 13;
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

        return BuildOnce(key, seed, () =>
        {
            var vm = World(seed);
            var gz = BuildRegion(vm, i, j);
            _regionHot.Set(key, gz);
            _mem.SetData(key, gz);
            return gz;
        });
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

        return BuildOnce(key, seed, () =>
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
    private byte[] BuildOnce(string key, string seed, Func<byte[]> build)
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
       区域包缓存命中/流式补齐不再整片作废 tile 缓存。 */
    public byte[] GetTileBytes(string seed, int q, int r)
    {
        var cacheKey = "t:" + WorldKeys.SeedPrefix(seed) + ":" + q + ":" + r;
        var vm = World(seed);
        var cached = _tileCache.Get(cacheKey);
        if (cached != null && cached.RoadVer == vm.RoadVersion())
            return cached.Gz;

        var json = vm.Call("tileJson", q, r);
        var ver = vm.RoadVersion();     // 取生成后版本: 若生成途中恰好新路落成, 下次请求会按新版本重算
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
                        _sql.PruneExcept(prefixes);
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
