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
 * ============================================================ */

public sealed class MapWorldService : IDisposable
{
    private readonly ZongmenOptions _opt;
    private readonly JsEngineHost _host;
    private readonly MemoryVirtualContext _mem;
    private readonly SqliteVirtualContext? _sql;
    private string? _metaCache;
    private readonly object _metaLock = new();

    public MapWorldService(ZongmenOptions opt, string contentRoot)
    {
        _opt = opt;
        var jsDir = ZongmenPaths.ResolveEngineJsDir(opt, contentRoot);
        _host = new JsEngineHost(jsDir, opt.MaxSeeds);
        _mem = new MemoryVirtualContext();
        if (opt.PersistEnabled)
            _sql = new SqliteVirtualContext(ZongmenPaths.ResolveDbPath(opt, contentRoot));
    }

    private JsWorldVm World(string seed) => _host.GetOrCreate(seed);

    /* ---------------- 区块 ---------------- */
    public byte[] GetChunkBytes(string seed, int ca, int cb)
    {
        var key = WorldKeys.Chunk(seed, ca, cb);
        var hit = _mem.GetDataBytes(key) ?? _sql?.GetDataBytes(key);
        if (hit != null) return hit;

        var vm = World(seed);
        var gz = BuildChunk(vm, ca, cb);
        Store(key, gz);
        return gz;
    }

    private byte[] BuildChunk(JsWorldVm vm, int ca, int cb)
    {
        var json = vm.Call("chunkJson", ca, cb);
        using var d = JsonDocument.Parse(json);
        var root = d.RootElement;
        var p = new ChunkPayload
        {
            Ca = root.GetProperty("ca").GetInt32(),
            Cb = root.GetProperty("cb").GetInt32(),
            Count = root.GetProperty("count").GetInt32(),
            Cq = B64(root, "cq"),
            Cr = B64(root, "cr"),
            Tiles = B64(root, "tiles"),
            Elev = B64(root, "elev"),
            Hash = B64(root, "hash"),
            Neigh = B64(root, "neigh"),
            Pn = root.GetProperty("pn").GetInt32(),
            Pdx = B64(root, "pdx"),
            Pdy = B64(root, "pdy"),
            Psp = B64(root, "psp"),
            Ph = B64(root, "ph"),
            Pe = B64(root, "pe"),
        };
        var proto = ProtoCodec.SerToByte(p);
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 区域包 ---------------- */
    public byte[] GetRegionBytes(string seed, int i, int j)
    {
        var key = WorldKeys.Region(seed, i, j);
        var hit = _mem.GetDataBytes(key) ?? _sql?.GetDataBytes(key);
        if (hit != null) return hit;

        var vm = World(seed);
        var gz = BuildRegion(vm, i, j);
        Store(key, gz);
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
        var hit = _mem.GetDataBytes(key) ?? _sql?.GetDataBytes(key);
        if (hit != null) return hit;

        var vm = World(seed);
        var gz = BuildComm(vm, ci, cj);
        Store(key, gz);
        return gz;
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

    /* ---------------- 单格详情 (不落库) ---------------- */
    public byte[] GetTileBytes(string seed, int q, int r)
    {
        var vm = World(seed);
        var json = vm.Call("tileJson", q, r);
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
        return GZipCodec.Compress(proto);
    }

    /* ---------------- 字段网格 / 元信息 (JSON) ---------------- */
    public string GetFieldGridJson(string seed, int q0, int q1, int r0, int r1)
    {
        var vm = World(seed);
        return vm.Call("fieldGridJson", q0, q1, r0, r1);
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
        => System.Text.Json.JsonSerializer.Serialize(new
        {
            liveSeeds = _host.LiveSeeds,
            dbRows = _sql?.Count() ?? 0,
            memRows = _mem.Count(),
        });

    private void Store(string key, byte[] gz)
    {
        _mem.SetData(key, gz);
        _sql?.SetData(key, gz);
    }

    private static byte[] B64(JsonElement e, string name)
        => Convert.FromBase64String(e.GetProperty(name).GetString() ?? "");

    private static float F(JsonElement e, string name)
        => e.GetProperty(name).GetSingle();

    public void Dispose()
    {
        _host.Dispose();
        _sql?.Dispose();
        _mem.Dispose();
    }
}
