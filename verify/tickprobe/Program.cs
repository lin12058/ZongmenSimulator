using System.Text.Json;
using Zongmen.Time;

namespace Zongmen.Verify;

/* ============================================================
 * tickprobe — Tick 框架判据宿主
 * ------------------------------------------------------------
 * 用法 (Node 侧驱动):
 *   echo '{"op":"clock","tick":359}' | dotnet run --project verify/tickprobe
 *   node verify/check_clock.mjs      ← 内部批量喂 op, 一次进程跑完全部断言
 *
 * 设计: 单次进程内读多行 JSON (每行一个 op), 逐行输出 JSON 结果。
 *   ⇒ 判据脚本一次启动即可跑几百个断言, 不必 fork 几百次。
 *
 * ⚠ 关键: 本宿主**引用真实服务端工程**, 断言的是生产代码而不是它的复制品。
 * ============================================================ */
internal static class Program
{
    private static readonly JsonSerializerOptions J = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    /// <summary>
    /// 解析 kind：**两种写法都接受** ——
    /// 线上名（`townEvolve`，KindNames 里的那个，也是落库值）与
    /// 枚举名（`TownEvolve`，便于直接抄代码）。
    /// ⚠ 判据脚本一律用线上名 —— 它才是持久化契约。
    /// </summary>
    private static TickJobKind ParseKind(string? s, TickJobKind fallback)
    {
        if (string.IsNullOrWhiteSpace(s)) return fallback;
        if (KindNames.TryParse(s, out var wire)) return wire;
        if (Enum.TryParse<TickJobKind>(s, ignoreCase: true, out var named)) return named;
        throw new ArgumentException($"未知 kind: {s}");
    }

    private static int Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            object result;
            try
            {
                using var doc = JsonDocument.Parse(line);
                result = Dispatch(doc.RootElement);
            }
            catch (Exception ex)
            {
                result = new { err = ex.GetType().Name + ": " + ex.Message };
            }

            Console.WriteLine(JsonSerializer.Serialize(result, J));
            Console.Out.Flush();
        }
        return 0;
    }

    private static object Dispatch(JsonElement e)
    {
        var op = e.GetProperty("op").GetString();

        return op switch
        {
            // ── 时间模型 ────────────────────────────────────────────────
            "clock" => Clock(e),
            "fromDate" => new
            {
                tick = GameClock.FromDate(
                    e.GetProperty("year").GetInt32(),
                    e.GetProperty("month").GetInt32(),
                    e.GetProperty("day").GetInt32()),
            },
            "align" => new
            {
                season = GameClock.AlignToSeasonStart(e.GetProperty("tick").GetInt64()),
                month = GameClock.AlignToMonthStart(e.GetProperty("tick").GetInt64()),
                year = GameClock.AlignToYearStart(e.GetProperty("tick").GetInt64()),
            },
            "constants" => new
            {
                ticksPerDay = GameClock.TicksPerDay,
                daysPerMonth = GameClock.DaysPerMonth,
                monthsPerYear = GameClock.MonthsPerYear,
                ticksPerYear = GameClock.TicksPerYear,
                ticksPerSeason = GameClock.TicksPerSeason,
                msPerTick = GameClock.MsPerTick,
                seasonNames = GameClock.SeasonNames,
                monthNames = GameClock.MonthNames,
            },
            "describe" => new { desc = GameClock.Describe(e.GetProperty("tick").GetInt64()) },

            // ── 相位派生 ────────────────────────────────────────────────
            "phase" => Phase(e),
            "fnv" => new { h = PhaseHash.Fnv1a32(e.GetProperty("s").GetString() ?? "") },
            "mix" => new { h = PhaseHash.Mix32((uint)e.GetProperty("h").GetInt64()) },

            // ── 调度器 (线程安全) ───────────────────────────────────────
            "queue" => QueueOps(e),
            "queueThreads" => QueueThreads(e),

            // ── 分批 ────────────────────────────────────────────────────
            "partition" => Partition(e),

            // ── 注册表 ──────────────────────────────────────────────────
            "registry" => Registry(),

            // ── 持久化 (TickJob 表 落库 ↔ 载入) ─────────────────────────
            "jobStore" => JobStore(e),

            // ── 端到端 tick 模拟 (纯调度, 不执行) ───────────────────────
            "simulate" => Simulate(e),

            // ── P2 城市演化: 真引擎 + 真台账 端到端 (离线对拍用) ────────
            "evo" => Evo(e),

            _ => new { err = "unknown op: " + op },
        };
    }

    // ══ clock ══════════════════════════════════════════════════════════
    private static object Clock(JsonElement e)
    {
        var tick = e.GetProperty("tick").GetInt64();
        var d = GameClock.ToDate(tick);
        return new
        {
            tick,
            year = d.Year,
            month = d.Month,
            day = d.Day,
            season = d.Season,
            dayOfYear = d.DayOfYear,
            seasonName = GameClock.SeasonNames[d.Season],
            monthName = GameClock.MonthNames[d.Month - 1],
            desc = GameClock.Describe(tick),
        };
    }

    // ══ phase ══════════════════════════════════════════════════════════
    private static object Phase(JsonElement e)
    {
        var seed = e.GetProperty("seed").GetString() ?? "";
        var entityId = e.GetProperty("id").GetString() ?? "";
        var kind = e.GetProperty("kind").GetString() ?? "";
        var period = e.GetProperty("period").GetInt32();
        var from = e.TryGetProperty("from", out var f) ? f.GetInt64() : 0L;

        return new
        {
            phase = PhaseHash.PhaseOf(seed, entityId, kind, period),
            firstDue = PhaseHash.FirstDueTick(seed, entityId, kind, period, from),
            derive = PhaseHash.Derive(seed, entityId, kind),
        };
    }

    // ══ queue：脚本化操作序列 ══════════════════════════════════════════
    private static object QueueOps(JsonElement e)
    {
        var opt = new TickOptions();
        var registry = new TickJobRegistry(opt);
        var queue = new ConcurrentTickQueue();

        var log = new List<object>();
        var ids = new Dictionary<string, TickJob>(StringComparer.Ordinal);

        foreach (var step in e.GetProperty("steps").EnumerateArray())
        {
            var cmd = step.GetProperty("c").GetString();
            switch (cmd)
            {
                case "enqueue":
                {
                    var job = registry.NewJob(
                        seed: step.GetProperty("seed").GetString() ?? "s",
                        round: 1,
                        entityId: step.GetProperty("id").GetString() ?? "x",
                        kind: ParseKind(step.GetProperty("kind").GetString(), TickJobKind.DemoHeartbeat),
                        fromTick: step.TryGetProperty("from", out var fr) ? fr.GetInt64() : 0L);
                    if (step.TryGetProperty("next", out var nx))
                        job.NextTick = nx.GetInt64();
                    queue.Push(job);
                    ids[job.Key.ToString()] = job;
                    log.Add(new { c = "enqueue", key = job.Key.ToString(), next = job.NextTick });
                    break;
                }
                case "pushRaw":
                {
                    var job = new TickJob
                    {
                        Seed = step.GetProperty("seed").GetString() ?? "s",
                        Round = step.GetProperty("round").GetInt32(),
                        EntityId = step.GetProperty("id").GetString() ?? "x",
                        Kind = ParseKind(step.GetProperty("kind").GetString(), TickJobKind.DemoHeartbeat),
                        Layer = (TickLayer)step.GetProperty("layer").GetInt32(),
                        Resource = (TickResource)step.GetProperty("resource").GetInt32(),
                        NextTick = step.GetProperty("next").GetInt64(),
                        PeriodTicks = step.GetProperty("period").GetInt32(),
                    };
                    queue.Push(job);
                    log.Add(new { c = "pushRaw", key = job.Key.ToString(), next = job.NextTick });
                    break;
                }
                case "advance":
                {
                    var now = step.GetProperty("now").GetInt64();
                    var due = queue.AdvanceTo(now);
                    // ⚠ 推进让「已收集」的 job 可以再次被收集（模拟合流后 CommitSuccess）
                    if (step.TryGetProperty("commit", out var cm) && cm.GetBoolean())
                    {
                        foreach (var j in due)
                        {
                            j.LastRunTick = now;
                            if (j.PeriodTicks > 0) { j.NextTick = now + j.PeriodTicks; queue.Reprioritize(j.Key, j.NextTick); }
                            else queue.TryRemove(j.Key, out _);
                        }
                    }
                    log.Add(new
                    {
                        c = "advance",
                        now,
                        n = due.Count,
                        due = due.Select(j => new
                        {
                            key = j.Key.ToString(),
                            dt = j.DtTicks,
                            lastRun = j.LastRunTick,
                        }).ToArray(),
                    });
                    break;
                }
                case "peek":
                    log.Add(new { c = "peek", ok = queue.TryPeek(out var pk), next = queue.TryPeek(out pk) ? pk.NextTick : -1 });
                    break;
                case "remove":
                {
                    var keyStr = step.GetProperty("key").GetString();
                    // ⚠ 规范键用**线上名**（KindNames.Of）= `seed/round/entityId/wireName`，
                    //   不是枚举名 —— 传 "s/1/a/DemoHeartbeat" 会查不到。
                    var target = queue.Snapshot().FirstOrDefault(j => j.Key.ToString() == keyStr);
                    var ok = target is not null && queue.TryRemove(target.Key, out _);
                    log.Add(new { c = "remove", key = keyStr, ok });
                    break;
                }
                case "validate":
                {
                    var (ok, err) = queue.Validate();
                    log.Add(new { c = "validate", ok, err });
                    break;
                }
            }
        }

        var (vok, verr) = queue.Validate();

        return new
        {
            count = queue.Count,
            pushes = queue.PushCount,
            pops = queue.PopCount,
            peeks = queue.PeekCount,
            revoked = queue.RevokeCount,
            dupSuppressed = queue.DuplicateSuppressed,
            validate = new { ok = vok, err = verr },
            log,
        };
    }

    // ══ queueThreads：真并发压测 ═══════════════════════════════════════
    private static object QueueThreads(JsonElement e)
    {
        var threads = e.GetProperty("threads").GetInt32();
        var perThread = e.GetProperty("perThread").GetInt32();
        var rounds = e.TryGetProperty("rounds", out var r) ? r.GetInt32() : 50;

        var queue = new ConcurrentTickQueue();
        var opt = new TickOptions();
        var registry = new TickJobRegistry(opt);

        var collected = new System.Collections.Concurrent.ConcurrentDictionary<string, int>();
        var duplicates = 0;

        // 生产者：threads 个线程并行投递
        var producers = new List<Thread>();
        for (var t = 0; t < threads; t++)
        {
            var tid = t;
            producers.Add(new Thread(() =>
            {
                for (var i = 0; i < perThread; i++)
                {
                    var job = registry.NewJob("s", 1, $"e_{tid}_{i}", TickJobKind.DemoHeartbeat, 0);
                    job.NextTick = (i % 3);     // 都压在最早几个 tick 上 ⇒ 最大化竞争
                    queue.Push(job);
                }
            }));
        }
        foreach (var p in producers) p.Start();
        foreach (var p in producers) p.Join();

        var countAfterPush = queue.Count;

        // 消费者：并行 AdvanceTo（不 commit）—— 只该被收集一次
        var consumers = new List<Thread>();
        for (var t = 0; t < threads; t++)
        {
            consumers.Add(new Thread(() =>
            {
                for (var k = 0; k < rounds; k++)
                {
                    var due = queue.AdvanceTo(2);
                    foreach (var j in due)
                    {
                        var key = j.Key.ToString();
                        if (collected.AddOrUpdate(key, 1, (_, v) => v + 1) > 1)
                            Interlocked.Increment(ref duplicates);
                    }
                }
            }));
        }
        foreach (var c in consumers) c.Start();
        foreach (var c in consumers) c.Join();

        var (vok, verr) = queue.Validate();

        return new
        {
            expectedTotal = threads * perThread,
            countAfterPush,
            collectedDistinct = collected.Count,
            collectedTotal = collected.Values.Sum(),
            duplicates,
            validate = new { ok = vok, err = verr },
        };
    }

    // ══ partition ══════════════════════════════════════════════════════
    private static object Partition(JsonElement e)
    {
        var opt = new TickOptions { ConcurrentExecution = true };
        var registry = new TickJobRegistry(opt);
        var part = new TickPartitioner(registry, opt);

        var jobs = new List<TickJob>();
        foreach (var item in e.GetProperty("jobs").EnumerateArray())
        {
            var j = registry.NewJob(
                "s", 1,
                item.GetProperty("id").GetString() ?? "x",
                ParseKind(item.GetProperty("kind").GetString(), TickJobKind.DemoHeartbeat),
                0);
            j.NextTick = 0;
            jobs.Add(j);
        }
        jobs.Sort(TickScheduler.CompareByCanonicalOrder);

        var batches = part.Partition(jobs, 0);

        return new
        {
            n = batches.Count,
            batches = batches.Select(b => new
            {
                resource = b.Resource.ToString(),
                layer = b.Layer.ToString(),
                serial = b.Serial,
                ids = b.Jobs.Select(j => j.EntityId + "/" + j.Kind).ToArray(),
            }).ToArray(),
        };
    }

    // ══ registry ═══════════════════════════════════════════════════════
    private static object Registry()
    {
        var opt = new TickOptions();
        var reg = new TickJobRegistry(opt);
        return new
        {
            specs = reg.All.Select(s => new
            {
                kind = s.Kind.ToString(),
                name = KindNames.Of(s.Kind),
                layer = (int)s.Layer,
                resource = (int)s.Resource,
                period = s.PeriodTicks,
                parallel = s.Parallelizable,
                reads = s.Reads,
                writes = s.Writes,
                caches = s.EngineCaches,
            }).ToArray(),
        };
    }

    // ══ jobStore：落库 → 载入 逐字段一致 ════════════════════════════════
    /*
     * 一次 op 内跑完整往返（用临时文件，跑完删）：
     *   ① 造 N 个 job（含一次性事件），标记脏 → Flush
     *   ② 新建 store 实例重新 Load（模拟重启）→ 逐字段对比
     *   ③ 再 Flush 一次（空）→ 再 Load → 幂等性
     * ⚠ 用**全新实例**载入才算「重启」；同一个实例的 LoadedRows 只是缓存。
     */
    private static object JobStore(JsonElement e)
    {
        var seed = e.TryGetProperty("seed", out var s) ? s.GetString() ?? "testseed" : "testseed";
        var round = e.TryGetProperty("round", out var r) ? r.GetInt32() : 1;
        var db = Path.Combine(Path.GetTempPath(), $"zm_tickjob_{Guid.NewGuid():N}.sqlite");
        var opt = new TickOptions { L0SpreadTicks = 30 };
        var reg = new TickJobRegistry(opt);

        try
        {
            // ── ① 写入 ───────────────────────────────────────────────
            var specs = new (string Id, TickJobKind Kind)[]
            {
                ("demo_0_0", TickJobKind.DemoHeartbeat),
                ("city_a", TickJobKind.TownEvolve),
                ("city_b", TickJobKind.TradeEdge),
                ("sect_x", TickJobKind.SectCultivation),
            };

            List<TickJob> original;
            long loadedRows, skipped, countAfterWrite;
            using (var store = new TickJobStore(db))
            {
                original = new List<TickJob>();
                foreach (var (id, kind) in specs)
                    original.Add(reg.NewJob(seed, round, id, kind, 0));

                // 人为改几个字段，验证它们确实被持久化了
                // ⚠ 只改**会被载入的** job 的字段。Enabled=false 的 job 载入时会被
                //   SQL 的 WHERE Enabled=1 过滤掉 —— 那是**正确行为**（停用的 job
                //   不该被重新调度），单列一条断言（见下方 disabledFiltered）。
                original[1].LastRunTick = 45;
                original[1].Phase = 77;
                original[2].FailCount = 3;

                foreach (var j in original) store.MarkDirty(j);
                // 另外单独塞一个「停用」的 job，用来验证 Enabled=0 不进载入结果
                store.MarkDirty(Disabled(reg, seed, round, "disabled_1", TickJobKind.SectCultivation));
                store.Flush();
                countAfterWrite = store.Count();
            }

            // ── ② 全新实例载入（= 重启）──────────────────────────────
            List<TickJob> loaded;
            using (var store = new TickJobStore(db))
            {
                loaded = store.Load(seed, round);
                loadedRows = store.LoadedRows;
                skipped = store.SkippedRows;
            }

            // ── ③ 幂等：再存一次（应为 0 脏行）→ 再 Load ─────────────
            long idempotentRows;
            List<TickJob> reloaded;
            using (var store = new TickJobStore(db))
            {
                store.Load(seed, round);
                idempotentRows = store.Flush();     // 无脏行 ⇒ 0
                reloaded = store.Load(seed, round);
            }

            // ── 逐字段对比 ───────────────────────────────────────────
            var fields = new List<object>();
            var mismatches = new List<string>();
            foreach (var o in original)
            {
                var l = loaded.FirstOrDefault(x => x.Key.Equals(o.Key));
                if (l is null) { mismatches.Add($"missing {o.Key}"); continue; }

                void Chk(string name, object a, object b)
                {
                    if (!Equals(a, b)) mismatches.Add($"{o.Key}.{name}: {a} != {b}");
                }
                Chk("NextTick", o.NextTick, l.NextTick);
                Chk("PeriodTicks", o.PeriodTicks, l.PeriodTicks);
                Chk("Phase", o.Phase, l.Phase);
                Chk("LastRunTick", o.LastRunTick, l.LastRunTick);
                Chk("FailCount", o.FailCount, l.FailCount);
                Chk("Enabled", o.Enabled, l.Enabled);
                Chk("Layer", o.Layer, l.Layer);
                Chk("Resource", o.Resource, l.Resource);
                Chk("KindName", KindNames.Of(o.Kind), KindNames.Of(l.Kind));
                if (o.Payload is null != l.Payload is null) mismatches.Add($"{o.Key}.Payload null-ness");

                fields.Add(new
                {
                    id = o.EntityId,
                    kind = KindNames.Of(o.Kind),
                    nextTick = l.NextTick,
                    period = l.PeriodTicks,
                    phase = l.Phase,
                    lastRun = l.LastRunTick,
                    fails = l.FailCount,
                    enabled = l.Enabled,
                });
            }

            // ── 停用的 job 不进载入结果（正确行为，不是缺陷）──────────
            var disabledFiltered = loaded.All(j => j.EntityId != "disabled_1");

            // ── 一次性事件：插入即落库（不经周期 flush）──────────────
            var oneShotPersisted = false;
            using (var store = new TickJobStore(db))
            {
                var oneShot = reg.NewJob(seed, round, "oneshot_1", TickJobKind.RoadRework, 0);
                store.MarkDirty(oneShot);
                store.Flush();
                oneShotPersisted = store.Count() > countAfterWrite;
            }

            return new
            {
                ok = mismatches.Count == 0,
                mismatches,
                n = original.Count,
                loadedRows,
                skipped,
                countAfterWrite,
                disabledFiltered,
                roundTrip = fields.ToArray(),
                idempotentRows,
                reloadedCount = reloaded.Count,
                oneShotPersisted,
            };
        }
        finally
        {
            TryDelete(db);
        }
    }

    /// <summary>造一个已停用的 job（用于验证 Enabled=0 不进载入结果）。</summary>
    private static TickJob Disabled(TickJobRegistry reg, string seed, int round, string id, TickJobKind kind)
    {
        var j = reg.NewJob(seed, round, id, kind, 0);
        j.Enabled = false;
        return j;
    }

    private static void TryDelete(string db)
    {
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            try { if (File.Exists(db + suffix)) File.Delete(db + suffix); } catch { /* ignore */ }
        }
    }

    // ══ simulate：端到端「时钟 → 相位 → 收集 → 重排」，不执行 ══════════
    private static object Simulate(JsonElement e)
    {
        var opt = new TickOptions
        {
            L0SpreadTicks = e.TryGetProperty("l0Spread", out var l0) ? l0.GetInt32() : 30,
        };
        var reg = new TickJobRegistry(opt);
        var queue = new ConcurrentTickQueue();
        var sched = new TickScheduler(reg, opt, queue);

        var entityCount = e.GetProperty("entities").GetInt32();
        var ticks = e.GetProperty("ticks").GetInt32();
        var kind = ParseKind(e.TryGetProperty("kind", out var k) ? k.GetString() : null, TickJobKind.DemoHeartbeat);

        for (var i = 0; i < entityCount; i++)
            sched.Enqueue("s", 1, $"e{i}", kind, 0);

        var perTickCounts = new int[ticks];
        var perEntityCounts = new int[entityCount];
        var peeksNoJob = 0;
        var phaseBuckets = new Dictionary<long, int>();

        var jobsByEntity = queue.Snapshot().ToDictionary(j => j.EntityId);
        foreach (var j in jobsByEntity.Values)
        {
            phaseBuckets.TryGetValue(j.Phase, out var c);
            phaseBuckets[j.Phase] = c + 1;
        }

        for (var t = 0; t < ticks; t++)
        {
            var due = sched.AdvanceTo(t);
            perTickCounts[t] = due.Count;
            if (due.Count == 0) peeksNoJob++;

            foreach (var j in due)
            {
                var idx = int.Parse(j.EntityId.AsSpan(1));
                perEntityCounts[idx]++;

                /* ★ 用**真实生产代码** TickScheduler.CommitSuccess 推进 ——
                   不在判据里自己重写一遍（工程既有教训：参照系不能是被测规则自己）。
                   这一条也是本判据抓到 bug 的地方：曾用 `NextDue(j, t)` 直接算，
                   而此刻 j.NextTick 仍是吊销哨兵 long.MaxValue ⇒ 整数溢出 ⇒ 相位错乱。 */
                sched.CommitSuccess(j, t);
            }
        }

        return new
        {
            entities = entityCount,
            ticks,
            perTickCounts,
            perEntityCounts,
            emptyTicks = peeksNoJob,
            phaseBucketCount = phaseBuckets.Count,
            phaseMin = phaseBuckets.Values.DefaultIfEmpty(0).Min(),
            phaseMax = phaseBuckets.Values.DefaultIfEmpty(0).Max(),
            period = reg.Spec(kind).PeriodTicks,
            advanceCalls = sched.AdvanceCalls,
            emptyAdvances = sched.EmptyAdvances,
            dispatched = sched.Dispatched,
            queuePeeks = queue.PeekCount,
        };
    }

    // ══ P2 城市演化: 真引擎 (JsEngineHost + city-evo.js) + 真台账 (CityStateStore) ══
    //
    //   ★ 这一支是「融入正确性」的判据本体:
    //     用**生产代码路径** (JsEngineHost.Call 的白名单 → city-evo.js) 跑演化,
    //     把终态与 verify/evo/city_evo_sim.mjs 的终态比对。
    //     两者实现同源 (E 常量逐值一致) ⇒ 任何逐城差异都指向「融入走样了」。
    //
    //   入参: { op:"evo", seed, years, span, k, engineJsDir? }
    //   出参: { seed, years, ticks, cities:[{id,pop,popF,tier,state,built,stock,Kf}...], ... }
    //
    //   ⚠ 为什么这里**不复用** TickVmPoolExecutor/MapWorldService:
    //     那两个需要完整 DI 图 (Kestrel/WS/台账/限流…), 在判据宿主里搭起来
    //     会把「被测对象」埋进一堆无关设施里, 失败时无法定位。
    //     本支只走**同一条编译器路径** (同样的 vm.Call 白名单 + 同样的 CityStateStore),
    //     这才是判据要验的东西。端到端 (含 tick 泵) 另有 check_city_evo_ws.mjs。
    private static object Evo(JsonElement e)
    {
        var seed = e.TryGetProperty("seed", out var sv) ? sv.GetString() ?? "evo-probe" : "evo-probe";
        var years = e.TryGetProperty("years", out var yv) ? yv.GetDouble() : 1.0;
        var span = e.TryGetProperty("span", out var spv) ? spv.GetInt32() : 3;
        var kPolicy = e.TryGetProperty("k", out var kv) ? kv.GetString() ?? "freeze" : "freeze";
        var ticks = (int)Math.Round(years * 360);

        /* 引擎目录: 默认相对宿主 exe 推 (verify/tickprobe/bin/... → 仓库根) */
        var jsDir = e.TryGetProperty("engineJsDir", out var jdv) && jdv.ValueKind == JsonValueKind.String
            ? jdv.GetString()!
            : Path.Combine(FindRepoRoot(), "Server", "Zongmen", "Engine", "js");

        var dbPath = Path.Combine(Path.GetTempPath(), $"zm_evo_{Guid.NewGuid():N}.sqlite");
        try
        {
            using var host = new Zongmen.Engine.JsEngineHost(jsDir, maxSeeds: 2);
            var store = new Zongmen.Storage.CityStateStore(dbPath);
            try
            {
                using var lease = host.Lease(seed);
                var vm = lease.Vm;

                /* ① 初始化: 遍历窗口建台账行 (与 TickVmPoolExecutor.EnsureInitialized 同口径) */
                var ids = new List<string>();
                var metaOf = new Dictionary<string, string>(StringComparer.Ordinal);
                for (var i = -span; i <= span; i++)
                {
                    for (var j = -span; j <= span; j++)
                    {
                        /* ⚠ 用 citySettlementsJson (带 type/q/r) 而不是 settleJson (不带) */
                        using var d = JsonDocument.Parse(vm.Call("citySettlementsJson", i, j));
                        if (!d.RootElement.TryGetProperty("settlements", out var towns) ||
                            towns.ValueKind != JsonValueKind.Array) continue;
                        foreach (var t in towns.EnumerateArray())
                        {
                            var id = t.TryGetProperty("id", out var idv) ? idv.GetString() ?? "" : "";
                            if (id.Length == 0 || metaOf.ContainsKey(id)) continue;
                            var type = t.TryGetProperty("type", out var tyv) && tyv.ValueKind == JsonValueKind.String
                                ? tyv.GetString() ?? "" : "";
                            if (type == "poi") continue;
                            var q = t.TryGetProperty("q", out var qv) ? qv.GetInt32() : 0;
                            var r = t.TryGetProperty("r", out var rv) ? rv.GetInt32() : 0;
                            var pop = t.TryGetProperty("pop", out var pv) ? pv.GetInt32() : 0;
                            var tier = t.TryGetProperty("tier", out var tv) ? tv.GetInt32() : 1;
                            var stJson = vm.Call("cityNewStateJson", id, type, q, r, pop, tier, 0);
                            store.Put(Zongmen.Storage.CityStateStore.FromEngineJson(0, stJson));
                            metaOf[id] = vm.Call("cityMetaJson", id, type, q, r);
                            ids.Add(id);
                        }
                    }
                }
                ids.Sort(StringComparer.Ordinal);

                /* ② 推演: 与 city_evo_sim.mjs 同节拍 —— 每 90 tick 演化一步 (dt=90) */
                for (var tick = 90; tick <= ticks; tick += 90)
                {
                    foreach (var id in ids)
                    {
                        var cur = store.Get(0, id);
                        if (cur == null) continue;
                        var stateJson = Zongmen.Storage.CityStateStore.ToEngineJson(cur);
                        var outJson = vm.Call("cityEvolveJson", stateJson, metaOf[id], 90, kPolicy);
                        store.Put(Zongmen.Storage.CityStateStore.FromEngineJson(0, outJson));
                    }
                }

                /* ③ 报终态 (逐城, 规范序) */
                var rows = store.ByRound(0);
                var cities = new List<object>(rows.Count);
                foreach (var row in rows)
                {
                    cities.Add(new
                    {
                        id = row.Id,
                        pop = row.Pop,
                        popF = row.PopF,
                        tier = row.Tier,
                        state = row.State,
                        built = CountArr(row.Built),
                        age = row.Age,
                        ver = row.Ver,
                        Kf = row.Kf,
                        stock = row.Stock,
                    });
                }
                var totalPop = 0;
                var tiers = new Dictionary<int, int>();
                foreach (var row in rows)
                {
                    totalPop += row.Pop;
                    tiers[row.Tier] = tiers.TryGetValue(row.Tier, out var n) ? n + 1 : 1;
                }
                return new
                {
                    seed, years, ticks, span, kPolicy,
                    cityCount = rows.Count,
                    totalPop,
                    tiers,
                    cities,
                };
            }
            finally { store.Dispose(); }
        }
        finally
        {
            TryDelete(dbPath);
            TryDelete(dbPath + "-wal");
            TryDelete(dbPath + "-shm");
        }
    }

    private static int CountArr(string json)
    {
        if (string.IsNullOrEmpty(json) || json == "[]") return 0;
        try
        {
            using var d = JsonDocument.Parse(json);
            return d.RootElement.ValueKind == JsonValueKind.Array ? d.RootElement.GetArrayLength() : 0;
        }
        catch { return 0; }
    }

    private static string FindRepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        for (var i = 0; i < 8 && dir != null; i++)
        {
            if (Directory.Exists(Path.Combine(dir, "Server", "Zongmen", "Engine", "js"))) return dir;
            dir = Path.GetDirectoryName(dir);
        }
        return Directory.GetCurrentDirectory();
    }
}
