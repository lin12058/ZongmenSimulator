using System.Collections.Concurrent;
using System.Text.Json;
using Zongmen.Storage;

namespace Zongmen.Verify;

/* ============================================================
 * idprobe — 实体 id 分配器判据宿主
 * ------------------------------------------------------------
 * 用法 (Node 侧驱动, 每行一个 op):
 *   {"op":"new","db":"Temp/idprobe/a.sqlite","block":8}
 *   {"op":"alloc","n":3}
 *   {"op":"free","ids":[7,3]}
 *   {"op":"scan","inUse":[1,2,4],"reclaim":true}
 *   {"op":"stats"}
 *   {"op":"pack","kind":1,"id":12345}
 *   {"op":"concurrent","threads":4,"per":500}
 *   {"op":"dispose"}
 *
 * ⚠ 只吐 JSON 单行; 异常也回成 JSON (`ok:false`), 让 Node 侧能断言"这一手应当失败"。
 * ============================================================ */
internal static class Program
{
    private static readonly JsonSerializerOptions J = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private static EntityIdAllocator? _a;

    private static int Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (line.Length == 0) continue;
            string outp;
            try { outp = Handle(line); }
            catch (Exception ex) { outp = Json(new { ok = false, error = ex.GetType().Name, message = ex.Message }); }
            Console.WriteLine(outp);
            Console.Out.Flush();
        }
        _a?.Dispose();
        return 0;
    }

    private static string Handle(string line)
    {
        using var d = JsonDocument.Parse(line);
        var r = d.RootElement;
        var op = r.TryGetProperty("op", out var o) ? o.GetString() ?? "" : "";

        switch (op)
        {
            case "new":
                {
                    _a?.Dispose();
                    _a = null;
                    var db = r.TryGetProperty("db", out var dv) && dv.ValueKind == JsonValueKind.String
                        ? dv.GetString() : null;
                    if (string.IsNullOrEmpty(db)) db = null;      // 纯内存模式
                    var block = Int(r, "block", EntityIdAllocator.DefaultReserveBlock);
                    _a = new EntityIdAllocator(db, block);
                    return Json(new
                    {
                        ok = true,
                        highWater = _a.HighWater,
                        reserved = _a.Reserved,
                        persisted = _a.Persisted,
                    });
                }

            case "alloc":
                {
                    var a = Require();
                    var n = Int(r, "n", 1);
                    var ids = n == 1 ? new[] { a.Alloc() } : a.AllocRange(n);
                    return Json(new { ok = true, ids });
                }

            case "allocOne":
                {
                    /* ⚠ 单独一个 op 而不是 alloc+ids[0]: 判据要断言"这一手应当抛"时,
                       不能把异常和正常返回混在同一个形状里。 */
                    var a = Require();
                    return Json(new { ok = true, id = a.Alloc() });
                }

            case "free":
                {
                    var a = Require();
                    var ids = Ints(r, "ids");
                    var freed = ids.Length == 1 ? (a.Free(ids[0]) ? 1 : 0) : a.FreeRange(ids);
                    return Json(new { ok = true, freed });
                }

            case "scan":
                {
                    var a = Require();
                    var inUse = Ints(r, "inUse");
                    var reclaim = r.TryGetProperty("reclaim", out var rv) && rv.ValueKind == JsonValueKind.True;
                    var rep = a.ScanExisting(inUse, reclaim);
                    return Json(new { ok = true, rep.HighWater, rep.MaxInUse, rep.InUseCount,
                                      rep.HolesReclaimed, rep.Before, rep.Note });
                }

            case "holes":
                {
                    var a = Require();
                    return Json(new { ok = true, holes = a.CountHoles(Ints(r, "inUse")) });
                }

            case "stats":
                return Json(new { ok = true, stats = Require().Stats() });

            case "pack":
                {
                    var kind = (EntityKind)Int(r, "kind", 1);
                    var id = Int(r, "id", 0);
                    var eref = new EntityRef(kind, id);
                    var back = EntityRef.Unpack(eref.Packed);
                    return Json(new
                    {
                        ok = true,
                        packed = eref.Packed,
                        kind = (int)back.Kind,
                        id = back.Id,
                        same = back == eref,
                    });
                }

            case "concurrent":
                {
                    var a = Require();
                    var threads = Math.Clamp(Int(r, "threads", 4), 1, 32);
                    var per = Math.Clamp(Int(r, "per", 500), 1, 200_000);
                    var bag = new ConcurrentBag<int>();
                    var tasks = new Task[threads];
                    for (var t = 0; t < threads; t++)
                        tasks[t] = Task.Run(() => { for (var i = 0; i < per; i++) bag.Add(a.Alloc()); });

                    /* ⚠ 硬超时: 绝不用无界 WaitAll —— 门闩写错时判据会永久挂住 (工程教训)。 */
                    var done = Task.WaitAll(tasks, TimeSpan.FromSeconds(60));
                    if (!done) return Json(new { ok = false, error = "Timeout", message = "并发分配 60s 未完成" });

                    var arr = bag.ToArray();
                    return Json(new
                    {
                        ok = true,
                        total = arr.Length,
                        distinct = arr.Distinct().Count(),
                        min = arr.Min(),
                        max = arr.Max(),
                    });
                }

            case "dispose":
                _a?.Dispose();
                _a = null;
                return Json(new { ok = true, closed = true });

            default:
                return Json(new { ok = false, error = "BadOp", message = $"未知 op: {op}" });
        }
    }

    private static EntityIdAllocator Require() =>
        _a ?? throw new InvalidOperationException("还没有 allocator：先发 {\"op\":\"new\",...}");

    private static int Int(JsonElement r, string name, int fallback) =>
        r.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

    private static int[] Ints(JsonElement r, string name)
    {
        if (!r.TryGetProperty(name, out var v) || v.ValueKind != JsonValueKind.Array) return Array.Empty<int>();
        var list = new List<int>(v.GetArrayLength());
        foreach (var e in v.EnumerateArray())
            if (e.ValueKind == JsonValueKind.Number) list.Add(e.GetInt32());
        return list.ToArray();
    }

    private static string Json(object o) => JsonSerializer.Serialize(o, J);
}
