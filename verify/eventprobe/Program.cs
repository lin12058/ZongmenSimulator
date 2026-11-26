using System.Text.Json;
using Zongmen.Events;
using Zongmen.Storage;
using Zongmen.Subsystems.City;

namespace Zongmen.Verify;

/* ============================================================
 * eventprobe — 跨 tick 事件系统判据宿主（纯逻辑层）
 * ------------------------------------------------------------
 * 用法（Node 侧逐行喂 JSON，逐行回 JSON）：
 *   {"op":"pb","field":1,"v":-123}
 *   {"op":"diff","before":{...},"after":{...}}
 *   {"op":"heap","cmds":[{"c":"push",...},{"c":"advance","now":100}]}
 *   {"op":"entity","action":"open","db":"Temp/eventprobe/e.sqlite"}
 *   {"op":"store","action":"open","db":"Temp/eventprobe/s.sqlite"}
 *   {"op":"registry"}
 *
 * ⚠ 异常也回成 JSON（`ok:false`）—— 判据需要能断言「这一手应当失败」。
 * ⚠ 不链接 EventRunner.cs：它依赖 V8（JsVm）与 MapWorldServiceAccessor，
 *   那部分只能实机验。在这里 mock 出来等于测了个假的。
 * ============================================================ */
internal static class Program
{
    private static EntityRegistry? _reg;
    private static EventStore? _store;
    private static EventHeap? _heap;

    private static int Main()
    {
        /* ⚠ Windows 下重定向管道的默认编码是 ANSI(936)，而 Node 写的是 UTF-8。
           不设这两行，输入里的中文资源名（"粮" "木" …）会被解成乱码 ⇒
           JsonDocument.Parse 直接抛 JsonReaderException（表现为「判据 inexplicably 全红」）。 */
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;

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
        _reg?.Dispose();
        _store?.Dispose();
        return 0;
    }

    private static string Handle(string line)
    {
        using var doc = JsonDocument.Parse(line);
        var e = doc.RootElement;
        var op = e.GetProperty("op").GetString();

        switch (op)
        {
            case "pb": return OpPb(e);
            case "diff": return OpDiff(e);
            case "heap": return OpHeap(e);
            case "entity": return OpEntity(e);
            case "store": return OpStore(e);
            case "registry": return OpRegistry();
            default: return Json(new { ok = false, error = "unknown-op", op });
        }
    }

    // ══ PbWire ═════════════════════════════════════════════════════════

    private static string OpPb(JsonElement e)
    {
        var field = GetInt(e, "field", 1);
        var v = GetLong(e, "v", 0);
        var o = new List<byte>();
        PbWire.WriteSInt(o, field, v);
        var blob = o.ToArray();

        var p = 0;
        var gotTag = PbWire.TryReadTag(blob, ref p, out var f2, out var w2);
        var back = PbWire.ReadSInt(blob, ref p);

        return Json(new
        {
            ok = gotTag && back == v && f2 == field && w2 == PbWire.WireVarint && p == blob.Length,
            field = f2, wire = w2, back, bytes = blob.Length,
            /* 负数的具体字节数：zigzag 后 -1 应为 2 字节（tag + 1），
               标准 int32 会是 11 字节（tag + 10）。判据靠这条钉住「必须 zigzag」。 */
            hex = Convert.ToHexString(blob),
        });
    }

    // ══ CityDiff ═══════════════════════════════════════════════════════

    private static string OpDiff(JsonElement e)
    {
        var before = CityStateStore.FromEngineJson(1, e.GetProperty("before").GetRawText());
        var after = CityStateStore.FromEngineJson(1, e.GetProperty("after").GetRawText());

        var d = CityDiff.Between(before, after);
        var blob = d.Encode();

        /* 往返：decode → encode 必须逐字节相同（否则 field 号 / zigzag 有歧义） */
        var dec = CityDiff.Decode(blob);
        var blob2 = dec.Encode();
        var roundTrip = blob.AsSpan().SequenceEqual(blob2);

        /* 应用：把 diff 打到 before 上，结果必须与 after 无差 */
        var applied = CityStateStore.FromEngineJson(1, CityStateStore.ToEngineJson(before));
        dec.ApplyTo(applied);
        var rest = CityDiff.Between(applied, after);

        return Json(new
        {
            ok = true,
            count = d.Count,
            bytes = blob.Length,
            hex = Convert.ToHexString(blob),
            isEmpty = d.IsEmpty,
            roundTrip,
            appliedEqualsAfter = rest.IsEmpty,
            restCount = rest.Count,
        });
    }

    // ══ EventHeap ══════════════════════════════════════════════════════

    private static string OpHeap(JsonElement e)
    {
        _heap ??= new EventHeap();
        var steps = new List<object>();

        foreach (var c in e.GetProperty("cmds").EnumerateArray())
        {
            var cmd = c.GetProperty("c").GetString();
            switch (cmd)
            {
                case "push":
                    _heap.Push(MakeJob(c));
                    steps.Add(new { c = "push", count = _heap.Count, next = SafeNext() });
                    break;

                case "duppush":
                {
                    /* 同 (round,e,k) 二次 push：必须**替换**而不是堆里多一份。
                       ⚠ 多一份 = 同一事件被执行两次（人口扣两遍）。 */
                    _heap.Push(MakeJob(c));
                    _heap.Push(MakeJob(c));
                    steps.Add(new { c = "duppush", count = _heap.Count });
                    break;
                }

                case "advance":
                {
                    var due = _heap.AdvanceTo(GetLong(c, "now", 0));
                    steps.Add(new
                    {
                        c = "advance",
                        n = due.Count,
                        /* 收集顺序必须是 (EntityId, EventKey) —— 与入堆顺序无关 */
                        order = due.Select(x => $"{x.EntityId}#{x.EventKey}").ToArray(),
                        count = _heap.Count,
                    });
                    break;
                }

                case "rearm":
                {
                    var key = new EventRef(GetInt(c, "round", 1), GetInt(c, "e", 1), GetInt(c, "k", 0));
                    steps.Add(new { c = "rearm", ok = _heap.Reprioritize(key, GetLong(c, "tick", 0)), next = SafeNext() });
                    break;
                }

                case "remove":
                {
                    var key = new EventRef(GetInt(c, "round", 1), GetInt(c, "e", 1), GetInt(c, "k", 0));
                    var ok = _heap.TryRemove(key, out _);
                    steps.Add(new { c = "remove", ok, count = _heap.Count });
                    break;
                }

                case "snapshot":
                    steps.Add(new
                    {
                        c = "snapshot",
                        items = _heap.Snapshot().Select(x => new { e = x.EntityId, k = x.EventKey, tick = x.NextTick }).ToArray(),
                    });
                    break;

                case "validate":
                {
                    var (ok, err) = _heap.Validate();
                    steps.Add(new { c = "validate", ok, err });
                    break;
                }

                case "next":
                    steps.Add(new { c = "next", next = SafeNext() });
                    break;

                case "clear":
                    steps.Add(new { c = "clear", n = _heap.Clear() });
                    break;

                default:
                    steps.Add(new { c = cmd, ok = false, error = "unknown-cmd" });
                    break;
            }
        }

        return Json(new { ok = true, steps });
    }

    private static long SafeNext()
    {
        var n = _heap!.NextDueTick;
        return n == long.MaxValue ? -1 : n;
    }

    private static EventJob MakeJob(JsonElement c) => new()
    {
        Round = GetInt(c, "round", 1),
        EntityId = GetInt(c, "e", 1),
        EventKey = GetInt(c, "k", 0),
        Script = (EventScript)GetInt(c, "script", 1),
        Fn = (byte)GetInt(c, "fn", 6),
        NextTick = GetLong(c, "tick", 0),
        PeriodTicks = GetInt(c, "period", 0),
        CreatedTick = GetLong(c, "created", 0),
        Enabled = true,
    };

    // ══ EntityRegistry ═════════════════════════════════════════════════

    private static string OpEntity(JsonElement e)
    {
        var action = e.GetProperty("action").GetString();
        switch (action)
        {
            case "open":
                _reg?.Dispose();
                _reg = new EntityRegistry(e.GetProperty("db").GetString());
                return Json(new { ok = true, persisted = _reg.Persisted });

            case "get":
            {
                var id = _reg!.GetOrCreate((EntityKind)GetInt(e, "kind", 1),
                    e.GetProperty("name").GetString()!,
                    GetInt(e, "q", 0), GetInt(e, "r", 0), GetLong(e, "tick", 0));
                return Json(new { ok = true, id });
            }

            case "name":
            {
                var n = _reg!.NameOf(GetInt(e, "id", 1));
                return Json(new { ok = n != null, name = n });
            }

            case "ids":
                return Json(new
                {
                    ok = true,
                    ids = _reg!.AllIds().OrderBy(x => x).ToArray(),
                    high = _reg.HighWater,
                    count = _reg.Count,
                });

            case "dead":
                return Json(new { ok = _reg!.MarkDead(GetInt(e, "id", 1)) });

            case "close":
                _reg?.Dispose();
                _reg = null;
                return Json(new { ok = true });

            default:
                return Json(new { ok = false, error = "unknown-action", action });
        }
    }

    // ══ EventStore ═════════════════════════════════════════════════════

    private static string OpStore(JsonElement e)
    {
        var action = e.GetProperty("action").GetString();
        switch (action)
        {
            case "open":
                _store?.Dispose();
                _store = new EventStore(e.GetProperty("db").GetString());
                return Json(new { ok = true, persisted = _store.Persisted });

            case "upsert":
                _store!.Upsert(MakeJob(e));
                return Json(new { ok = true, rows = _store.CountRound(GetInt(e, "round", 1)) });

            case "load":
            {
                var list = _store!.LoadAll(GetInt(e, "round", 1));
                return Json(new
                {
                    ok = true,
                    n = list.Count,
                    skipped = _store.Skipped,
                    items = list.Select(x => new { e = x.EntityId, k = x.EventKey, fn = x.Fn, tick = x.NextTick }).ToArray(),
                });
            }

            case "commit":
            {
                var job = MakeJob(e);
                var hex = e.TryGetProperty("diffHex", out var h) ? h.GetString() ?? "" : "";
                var diff = hex.Length == 0 ? Array.Empty<byte>() : Convert.FromHexString(hex);
                var seq = _store!.CommitRun(job, GetLong(e, "tick", 0), diff, GetLong(e, "next", 0),
                    e.TryGetProperty("oneShot", out var os) && os.GetBoolean());
                return Json(new { ok = true, seq, rows = _store.CountRound(job.Round), history = _store.HistoryRows });
            }

            case "history":
            {
                var list = _store!.ReadHistory(GetInt(e, "round", 1),
                    GetInt(e, "e", -1), GetLong(e, "from", 0), GetInt(e, "limit", 1000));
                return Json(new
                {
                    ok = true,
                    n = list.Count,
                    items = list.Select(x => new
                    {
                        seq = x.Seq, tick = x.Tick, e = x.EntityId, fn = x.Fn, k = x.EventKey,
                        bytes = x.Diff.Length, hex = Convert.ToHexString(x.Diff),
                    }).ToArray(),
                });
            }

            case "count":
                return Json(new { ok = true, rows = _store!.CountRound(GetInt(e, "round", 1)) });

            case "delete":
                return Json(new { ok = _store!.Delete(new EventRef(GetInt(e, "round", 1), GetInt(e, "e", 1), GetInt(e, "k", 0))) });

            case "deleteround":
            {
                var n = _store!.DeleteRound(GetInt(e, "round", 1));
                return Json(new { ok = true, n });
            }

            case "close":
                _store?.Dispose();
                _store = null;
                return Json(new { ok = true });

            default:
                return Json(new { ok = false, error = "unknown-action", action });
        }
    }

    // ══ 注册表 ═════════════════════════════════════════════════════════

    private static string OpRegistry() => Json(new
    {
        ok = true,
        all = EventScriptRegistry.All.Select(x => new
        {
            script = (int)x.Script,
            fn = (byte)x.Fn,
            js = x.JsName,
            scope = x.VmScope,
            desc = x.Desc,
        }).ToArray(),
    });

    // ══ 小工具 ═════════════════════════════════════════════════════════

    private static string Json(object o) => JsonSerializer.Serialize(o);

    private static int GetInt(JsonElement e, string k, int def)
        => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;

    private static long GetLong(JsonElement e, string k, long def)
        => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : def;
}
