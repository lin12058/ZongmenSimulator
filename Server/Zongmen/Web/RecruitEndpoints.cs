using System.Text.Json;
using System.Text.Json.Nodes;
using Zongmen.Domain;
using Zongmen.Services;
using Zongmen.Storage;
using Zongmen.Time;

namespace Zongmen.Web;

/* ============================================================
 * 招募系统 API —— /api/recruit/*
 * ------------------------------------------------------------
 *   GET  /api/recruit/state                招募值 + 服务器常量
 *   GET  /api/recruit/pool?settle=<id>     打探候选池 (首次自动生成 rollNo=0 并落库)
 *   POST /api/recruit/roll                 刷新一批 (-30)
 *   POST /api/recruit/hire                 招一人进小队 (-50)
 *
 * 方案: docs/游戏设计/招募系统-实施方案.md (§七 接口 · §九 服务端要点)
 *
 * ★ 为什么是专用端点而不是事件流: 招募是「强校验 + 跨表原子写」(点数 / taken / Crew
 *   三处), 乐观事件流会把它拆成三段可竞态的操作。事件流留给低保真频操 (拖动/派活)。
 *
 * ★ 服务端权威: 客户端只传 settleId + slot + squadId。
 *   聚落类型/人口/五行、产量(影响力)、余额、能不能招, 全部服务端自己算 ——
 *   否则「改 pop / 改 type 骗好苗子」「本地改数字」都能绕过去。
 *
 * ★ 判定顺序 (方案 §7.4, 顺序即实现顺序):
 *   bad-settle → no-pool → bad-slot (已 taken ⇒ 幂等返回, 不扣点也不查驻地)
 *   → insufficient-points → wrong-settle → squad-full / squad-limit → 扣点写入
 * ============================================================ */
public static class RecruitEndpoints
{
    private const int MaxSquads = 6;
    private const int SquadCap = 9;

    public static void Map(
        WebApplication app, RecruitStore store, CrewStore crew,
        MapWorldService world, TickPump pump, WorldClockStore clock, TickOptions tick)
    {
        var api = new Api(store, crew, world, pump, clock, tick);

        app.MapGet("/api/recruit/state", (HttpContext ctx) => api.State(Account(ctx)));

        app.MapGet("/api/recruit/pool", (HttpContext ctx, string? settle) =>
            api.Pool(Account(ctx), settle ?? ""));

        /* 写操作一律 POST (防浏览器/代理预取缓存重放), 与 /api/crew 同口径 */
        app.MapPost("/api/recruit/roll", async (HttpContext ctx) =>
        {
            var (body, bad) = await ReadBody(ctx);
            return bad ?? api.Roll(Account(ctx), body!);
        });

        app.MapPost("/api/recruit/hire", async (HttpContext ctx) =>
        {
            var (body, bad) = await ReadBody(ctx);
            return bad ?? api.Hire(Account(ctx), body!);
        });
    }

    /* ============================================================
     * 实现
     * ============================================================ */
    private sealed class Api
    {
        private readonly RecruitStore _store;
        private readonly CrewStore _crew;
        private readonly MapWorldService _world;
        private readonly TickPump _pump;
        private readonly WorldClockStore _clock;
        private readonly TickOptions _tick;

        public Api(RecruitStore store, CrewStore crew, MapWorldService world,
                   TickPump pump, WorldClockStore clock, TickOptions tick)
        {
            _store = store; _crew = crew; _world = world;
            _pump = pump; _clock = clock; _tick = tick;
        }

        /* ---------------- 世界上下文 ---------------- */

        private (string Seed, int Round) World()
        {
            try { return (_world.CurrentSeed() ?? "", _world.CurrentRound()); }
            catch { return ("", 0); }
        }

        /// <summary>世界权威 tick。⚠ 时钟是服务端资产: 不许前端给, 也不许自造。</summary>
        private long NowTick(string seed, int round)
        {
            var t = _pump.CurrentTick;
            if (t >= 0) return t;
            if (seed.Length == 0) return 0;
            try { return _clock.GetOrCreate(seed, round, _tick.InitialTick).Tick; }
            catch { return 0; }
        }

        /* ---------------- 聚落上下文 (防伪造, 方案 §9.3) ---------------- */

        private sealed record SettleCtx(
            string Id, string Type, int Q, int R, int Pop, string Name, int? Element, string Json);

        /// <summary>
        /// settleId (`i_j_k`) → 服务端自己查回的聚落身份。
        /// ⚠ 客户端只能给 id; type/pop/element 一律从引擎查 (否则改 pop 就能骗池量)。
        /// ⚠ 查回的结果会在首次生成池子时存进 RecruitPool.SettleJson, 之后不再重查
        ///   (聚落演化变了也不动池子 —— 这是特性: 已打探的池子永久固定)。
        /// </summary>
        private SettleCtx? Resolve(string seed, string settleId)
        {
            var parts = settleId.Split('_');
            if (parts.Length < 3) return null;
            if (!int.TryParse(parts[0], out var i) || !int.TryParse(parts[1], out var j)) return null;

            using var lease = _world.LeaseWorld(seed);
            string raw;
            try { raw = lease.Vm.Call("citySettlementsJson", i, j); }
            catch { return null; }

            using var doc = JsonDocument.Parse(raw);
            if (!doc.RootElement.TryGetProperty("settlements", out var arr)) return null;
            foreach (var s in arr.EnumerateArray())
            {
                if (!s.TryGetProperty("id", out var idEl) || idEl.GetString() != settleId) continue;
                var type = s.TryGetProperty("type", out var te) ? te.GetString() ?? "" : "";
                if (type == "poi" || type.Length == 0) return null;      // 秘境不招
                var q = s.TryGetProperty("q", out var qe) ? qe.GetInt32() : 0;
                var r = s.TryGetProperty("r", out var re) ? re.GetInt32() : 0;
                var pop = s.TryGetProperty("pop", out var pe) ? pe.GetInt32() : 0;

                /* 名称与本地灵脉五行: 身份表里没有, 由 tileJson 一次补全。
                   ⚠ 拿不到不算错 (名字只影响展示, element 只影响主灵根倾向) —— 招募照常。 */
                var name = "";
                int? elem = null;
                try
                {
                    using var td = JsonDocument.Parse(lease.Vm.Call("tileJson", q, r));
                    if (td.RootElement.TryGetProperty("place", out var pl) && pl.ValueKind == JsonValueKind.Object)
                    {
                        if (pl.TryGetProperty("name", out var nm) && nm.ValueKind == JsonValueKind.String)
                            name = nm.GetString() ?? "";
                        if (pl.TryGetProperty("pop", out var pp) && pp.ValueKind == JsonValueKind.Number)
                            pop = pp.GetInt32();
                    }
                    if (td.RootElement.TryGetProperty("vein", out var vn) && vn.ValueKind == JsonValueKind.Object &&
                        vn.TryGetProperty("element", out var el) && el.ValueKind == JsonValueKind.Number)
                        elem = el.GetInt32();
                }
                catch { /* 锦上添花字段, 失败不影响招募 */ }

                var json = JsonSerializer.Serialize(new
                {
                    id = settleId, type, pop, element = elem, q, r, name
                }, CrewJson.Options);
                return new SettleCtx(settleId, type, q, r, pop, name, elem, json);
            }
            return null;
        }

        /* ---------------- 池子生成 (走世界层 VM 的 chargenPool 出口) ---------------- */

        private string GenPool(string seed, int rollNo, SettleCtx ctx)
        {
            var opts = JsonSerializer.Serialize(new
            {
                worldSeed = seed,
                round = rollNo,
                settle = new { id = ctx.Id, type = ctx.Type, pop = ctx.Pop, element = ctx.Element, q = ctx.Q, r = ctx.R }
            }, CrewJson.Options);
            using var lease = _world.LeaseWorld(seed);
            return lease.Vm.Call("chargenPool", opts);
        }

        /* ---------------- 响应零件 ---------------- */

        private object PointsDto(string account, int round, RecruitPointRow pt)
        {
            var perYear = _store.PerYear(account, round);
            return new
            {
                value = pt.Points,
                cap = perYear * RecruitStore.CapYears,
                perYear,
                influence = perYear,
                rollCost = RecruitStore.RollCost,
                hireCost = RecruitStore.HireCost,
                initial = RecruitStore.InitialPoints,
                enterCost = RecruitStore.EnterCost
            };
        }

        private static readonly string[] ELEMENT_KEYS = { "metal", "wood", "water", "fire", "earth" };
        private static readonly string[] ELEMENT_NAMES = { "金", "木", "水", "火", "土" };

        private static string? ElementKey(int? idx)
            => idx is >= 0 and <= 4 ? ELEMENT_KEYS[idx.Value] : null;

        private static string? ElementName(int? idx)
            => idx is >= 0 and <= 4 ? ELEMENT_NAMES[idx.Value] : null;

        /// <summary>把池子快照拆成逐格候选 (slot 即下标; 招走的人置 taken, **不重排**)。</summary>
        private static List<object> Candidates(string poolJson, List<int> taken)
        {
            var list = new List<object>();
            JsonNode? root;
            try { root = JsonNode.Parse(poolJson); }
            catch { return list; }
            if (root?["candidates"] is not JsonArray arr) return list;
            var set = new HashSet<int>(taken);
            for (var i = 0; i < arr.Count; i++)
            {
                var c = arr[i];
                list.Add(new
                {
                    slot = i,
                    seedKey = c?["seedKey"]?.GetValue<string>() ?? "",
                    taken = set.Contains(i),
                    pawn = c?["pawn"],
                    items = c?["items"] ?? new JsonArray(),
                    meta = c?["meta"]
                });
            }
            return list;
        }

        private static JsonArray RawCandidates(string poolJson)
        {
            try
            {
                var node = JsonNode.Parse(poolJson);
                return node?["candidates"] as JsonArray ?? new JsonArray();
            }
            catch { return new JsonArray(); }
        }

        /* ---------------- 队伍投影与驻地闸 (方案 §4.1.1 / §9.6) ---------------- */

        /// <summary>契约里的有效队伍表。⚠ 老契约「只有 Squad.Members」⇒ 视作一支隐含队
        /// (与前端 normalizeSquads 的补队口径一致), 否则「明明有人却判成没队伍」。</summary>
        private static List<SquadGroupDto> EffectiveSquads(CrewContract? c)
        {
            var list = new List<SquadGroupDto>();
            if (c == null) return list;
            if (c.Squads is { Count: > 0 })
            {
                foreach (var s in c.Squads)
                {
                    if (s == null) continue;
                    /* ⚠ 只读投影: 契约可能是共享引用 (CrewStore.Get 返回现行对象), 这里**不写**它。
                       字段为 null (手改存档/老 JSON) 时造一份等价副本再交出去。 */
                    if (s.Members != null && s.Settle != null) list.Add(s);
                    else list.Add(new SquadGroupDto
                    {
                        Id = s.Id,
                        Name = s.Name,
                        Settle = s.Settle ?? "",
                        Members = (s.Members ?? new List<string>()).ToList()
                    });
                }
                return list;
            }
            if (c.Squad?.Members is { Count: > 0 })
            {
                list.Add(new SquadGroupDto
                {
                    Id = string.IsNullOrEmpty(c.Squad.Id) ? "sq1" : c.Squad.Id,
                    Name = string.IsNullOrEmpty(c.Squad.Name) ? "小队" : c.Squad.Name,
                    Settle = "",
                    Members = c.Squad.Members.Select(m => m.Id).ToList()
                });
            }
            return list;
        }

        /// <summary>写前把「隐含单队」实体化进 c.Squads —— 之后所有判定都只认 c.Squads。</summary>
        private static void MaterializeSquads(CrewContract c)
        {
            c.Squads ??= new List<SquadGroupDto>();
            if (c.Squads.Count > 0) return;
            if (c.Squad?.Members is not { Count: > 0 }) return;
            c.Squads.Add(new SquadGroupDto
            {
                Id = string.IsNullOrEmpty(c.Squad.Id) ? "sq1" : c.Squad.Id,
                Name = string.IsNullOrEmpty(c.Squad.Name) ? "小队" : c.Squad.Name,
                Settle = "",
                Members = c.Squad.Members.Select(m => m.Id).ToList()
            });
        }

        private sealed class Decision
        {
            public string? Code;                  // null = 通过
            public SquadGroupDto? Target;         // 已有目标队
            public bool NeedNew;                  // 需要新建一支
            public string SquadId = "";
        }

        /// <summary>
        /// 定目标队 + 驻地闸 + 容量闸。⚠ 顺序: 驻地不等 **先于** 队满判断 ——
        /// 否则「满队」会盖住「不在本镇」这个真实原因, 玩家照着提示回驻地也没用。
        /// </summary>
        private static Decision Decide(IReadOnlyList<SquadGroupDto> squads, string settleId, string wantId,
                                       int cap, bool forceNew)
        {
            var d = new Decision();

            /* 「新建小队」是玩家的显式选择 (面板入队浮层那一项): 不复用空队, 直接新建。
               仍然受 6 支上限约束。 */
            if (forceNew)
            {
                if (squads.Count >= MaxSquads) { d.Code = "squad-limit"; return d; }
                d.NeedNew = true;
                d.SquadId = NextSquadId(squads);
                return d;
            }

            SquadGroupDto? t;
            if (!string.IsNullOrEmpty(wantId))
            {
                t = squads.FirstOrDefault(s => s.Id == wantId);
                if (t == null) { d.Code = "no-squad"; return d; }
            }
            else
            {
                /* 没指定: 优先「本镇且有队员」→ 再退「第一支有队员」→ 再退「第一支空队」
                   ⚠ 不写成 `if (squads.Count == 0)`: 前端可能留着空队对象, 那样判会误拒 */
                t = squads.FirstOrDefault(s => s.Members.Count > 0 && s.Settle == settleId)
                 ?? squads.FirstOrDefault(s => s.Members.Count > 0)
                 ?? squads.FirstOrDefault();
            }

            if (t == null)
            {
                if (squads.Count >= MaxSquads) { d.Code = "squad-limit"; return d; }
                d.NeedNew = true;
                d.SquadId = NextSquadId(squads);
                return d;
            }

            if (t.Members.Count > 0 && (t.Settle ?? "").Length > 0 && t.Settle != settleId)
            {
                d.Code = "wrong-settle";
                return d;
            }
            if (t.Members.Count >= cap) { d.Code = "squad-full"; return d; }
            d.Target = t;
            d.SquadId = t.Id;
            return d;
        }

        private static string NextSquadId(IReadOnlyList<SquadGroupDto> squads)
        {
            var used = new HashSet<string>(squads.Select(s => s.Id), StringComparer.Ordinal);
            for (var i = 1; i <= MaxSquads; i++)
            {
                var id = "sq" + i;
                if (!used.Contains(id)) return id;
            }
            return "sq" + (squads.Count + 1);
        }

        private static readonly string[] SQUAD_NAMES = { "小队", "二队", "三队", "四队", "五队", "六队" };

        private static string NextSquadName(IReadOnlyList<SquadGroupDto> squads)
        {
            var used = new HashSet<string>(squads.Select(s => s.Name), StringComparer.Ordinal);
            foreach (var n in SQUAD_NAMES) if (!used.Contains(n)) return n;
            return SQUAD_NAMES[^1];
        }

        /// <summary>hireGate: 当前聚落能不能招 + 服务端视角的队伍表。前端**只读不推**。</summary>
        private object Gate(CrewContract? c, string settleId, string seed, string currentName)
        {
            var squads = EffectiveSquads(c);
            var hasMembers = squads.Any(s => s.Members.Count > 0);
            var here = squads.Any(s => s.Members.Count > 0 &&
                                       (string.IsNullOrEmpty(s.Settle) || s.Settle == settleId));
            var allowed = !hasMembers || here;

            var cache = new Dictionary<string, string>(StringComparer.Ordinal) { [settleId] = currentName };
            string NameOf(string id)
            {
                if (id.Length == 0) return "";
                if (cache.TryGetValue(id, out var hit)) return hit;
                SettleCtx? ctx = null;
                try { ctx = Resolve(seed, id); } catch { /* 引擎查不到 ⇒ 走兜底文案 */ }
                var v = ctx == null ? "驻地已不存" : (ctx.Name.Length > 0 ? ctx.Name : id);
                cache[id] = v;
                return v;
            }

            return new
            {
                allowed,
                reason = allowed ? null : "wrong-settle",
                squads = squads.Select(s => new
                {
                    id = s.Id,
                    name = s.Name,
                    settle = s.Settle,
                    settleName = NameOf(s.Settle ?? ""),
                    here = !string.IsNullOrEmpty(s.Settle) && s.Settle == settleId,
                    members = s.Members.Count
                }).ToList()
            };
        }

        private static int SquadsCap(CrewContract? c)
            => c?.Squad?.Capacity is > 0 and <= 32 ? c.Squad.Capacity : SquadCap;

        /* ---------------- 端点 ---------------- */

        public IResult State(string account)
        {
            var (seed, round) = World();
            var now = NowTick(seed, round);
            var pt = _store.Settle(account, round, now);
            return Ok(new
            {
                ok = true,
                points = PointsDto(account, round, pt),
                clock = new { tick = now, year = GameClock.YearOf(now), round }
            });
        }

        public IResult Pool(string account, string settleId)
        {
            var (seed, round) = World();
            var now = NowTick(seed, round);
            if (seed.Length == 0) return Fail("no-world", "尚无当前世 (先 GET /api/world/current)", 503);

            var sid = (settleId ?? "").Trim();
            var ctx = Resolve(seed, sid);
            if (ctx == null) return Fail("bad-settle", "该格没有可招募的聚落", 400);

            var pt = _store.Settle(account, round, now);
            var row = _store.EnsurePool(account, round, ctx.Id, ctx.Json, n => GenPool(seed, n, ctx));
            var taken = RecruitStore.ParseTaken(row.TakenJson);

            return Ok(new
            {
                ok = true,
                settle = new
                {
                    id = ctx.Id,
                    type = ctx.Type,
                    pop = ctx.Pop,
                    element = ElementKey(ctx.Element),
                    elementIndex = ctx.Element,
                    elementName = ElementName(ctx.Element),
                    q = ctx.Q,
                    r = ctx.R,
                    name = ctx.Name
                },
                rollNo = row.RollNo,
                taken,
                points = PointsDto(account, round, pt),
                hireGate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name),
                candidates = Candidates(row.PoolJson, taken)
            });
        }

        public IResult Roll(string account, JsonObject body)
        {
            var (seed, round) = World();
            var now = NowTick(seed, round);
            if (seed.Length == 0) return Fail("no-world", "尚无当前世", 503);

            var sid = Str(body, "settle").Trim();
            var ctx = Resolve(seed, sid);
            if (ctx == null) return Fail("bad-settle", "该格没有可招募的聚落", 400);

            if (!_store.TryRoll(account, round, now, ctx.Id, ctx.Json,
                    n => GenPool(seed, n, ctx), out var pt, out var pool))
            {
                return Ok(new
                {
                    ok = false,
                    code = "insufficient-points",
                    error = $"招募值不足（{pt.Points}/{RecruitStore.RollCost}）",
                    points = PointsDto(account, round, pt)
                });
            }

            var taken = RecruitStore.ParseTaken(pool!.TakenJson);
            return Ok(new
            {
                ok = true,
                rollNo = pool.RollNo,
                taken,
                points = PointsDto(account, round, pt),
                hireGate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name),
                candidates = Candidates(pool.PoolJson, taken)
            });
        }

        public IResult Hire(string account, JsonObject body)
        {
            var (seed, round) = World();
            var now = NowTick(seed, round);

            /* ① 先结算: 后面任何错误响应里的 points 都必须是最新值 */
            var pt = _store.Settle(account, round, now);
            if (seed.Length == 0) return Fail("no-world", "尚无当前世", 503);

            var sid = Str(body, "settle").Trim();
            var ctx = Resolve(seed, sid);
            if (ctx == null) return Fail("bad-settle", "该格没有可招募的聚落", 400);

            /* ② 池子必须已经打探过 (前端应先 GET pool) */
            var pool = _store.GetPool(account, round, ctx.Id);
            if (pool == null)
            {
                return Fail("no-pool", "该聚落的候选池还没生成 (先 GET /api/recruit/pool)", 404);
            }

            var raw = RawCandidates(pool.PoolJson);
            var slot = IntOf(body, "slot", -1);
            if (slot < 0 || slot >= raw.Count) return Fail("bad-slot", $"slot 越界 (0~{raw.Count - 1})", 400);

            var cand = raw[slot];
            var memberId = cand?["pawn"]?["id"]?.GetValue<string>() ?? "";

            /* ③ 已招走 ⇒ **幂等返回** (不扣点, 也不查驻地 —— 重试要无脑重发就行) */
            var taken = RecruitStore.ParseTaken(pool.TakenJson);
            if (taken.Contains(slot))
            {
                var exist = _crew.Get()?.Squad?.Members?.FirstOrDefault(m => m.Id == memberId);
                return Ok(new
                {
                    ok = true,
                    duplicated = true,
                    member = exist,
                    squadId = SquadOf(_crew.Get(), memberId),
                    rev = _crew.Revision(),
                    points = PointsDto(account, round, pt),
                    hireGate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name)
                });
            }

            /* ④ 余额 (权威校验在 TrySpend 的锁内, 这里只是提前给个干净的错误) */
            if (pt.Points < RecruitStore.HireCost)
            {
                return Ok(new
                {
                    ok = false,
                    code = "insufficient-points",
                    error = $"招募值不足（{pt.Points}/{RecruitStore.HireCost}）",
                    points = PointsDto(account, round, pt),
                    hireGate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name)
                });
            }

            /* ⑤⑥ 驻地闸 + 容量闸 (快照判定; 真正的权威判定在 Mutate 的锁内重跑一次) */
            var snapshot = _crew.Get();
            var forceNew = BoolOf(body, "newSquad");
            var pre = Decide(EffectiveSquads(snapshot), ctx.Id, Str(body, "squadId"), SquadsCap(snapshot), forceNew);
            if (pre.Code != null) return Reject(pre.Code, ctx, seed, account, round, pt);

            /* ⑦ 从**快照**取人装配 (不重跑生成器 ⇒ 显示的人和入队的人 100% 一致) */
            MemberDto? member;
            List<ItemDto> items;
            try
            {
                member = cand?["pawn"]?.Deserialize<MemberDto>(CrewJson.Options);
                items = cand?["items"]?.Deserialize<List<ItemDto>>(CrewJson.Options) ?? new List<ItemDto>();
            }
            catch (Exception ex)
            {
                return Fail("bad-pool", "池子快照损坏: " + ex.Message, 500);
            }
            if (member == null || member.Id.Length == 0) return Fail("bad-pool", "池子快照缺少 pawn", 500);

            /* ⑧ 扣点 (锁内原子) —— 失败就是余额不够 (并发场景) */
            if (!_store.TrySpend(account, round, now, RecruitStore.HireCost, out var afterSpend))
            {
                return Ok(new
                {
                    ok = false,
                    code = "insufficient-points",
                    error = $"招募值不足（{afterSpend.Points}/{RecruitStore.HireCost}）",
                    points = PointsDto(account, round, afterSpend),
                    hireGate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name)
                });
            }

            /* ⑨ 写 Crew (锁内原子: 加成员 + 入队 + 并入物品) */
            string? code = null;
            var newSquadId = "";
            var res = _crew.Mutate(c =>
            {
                MaterializeSquads(c);
                var d = Decide(c.Squads, ctx.Id, Str(body, "squadId"), SquadsCap(c), forceNew);
                if (d.Code != null) { code = d.Code; return false; }

                SquadGroupDto target;
                if (d.NeedNew)
                {
                    target = new SquadGroupDto
                    {
                        Id = d.SquadId,
                        Name = NextSquadName(c.Squads),
                        Settle = ctx.Id,           // 新建队 = 当次招募聚落 (驻地在此刻绑定)
                        Members = new List<string>()
                    };
                    c.Squads.Add(target);
                }
                else
                {
                    target = d.Target!;
                    /* 空队 / 老存档驻地为空 ⇒ 绑到当前聚落 (这就是「没有队员时哪都能招」的实现) */
                    if (target.Members.Count == 0 || string.IsNullOrEmpty(target.Settle)) target.Settle = ctx.Id;
                }

                target.Members.Add(member.Id);
                c.Squad.Members.Add(member);
                foreach (var it in items) c.Bag.Items.Add(it);
                newSquadId = target.Id;
                return true;
            }, createIfMissing: true);

            if (res.Error != null || !res.Committed || code != null)
            {
                /* 写失败 ⇒ **退点** (否则玩家白扣 50 还啥也没拿到) */
                var back = _store.AddPoints(account, round, now, RecruitStore.HireCost);
                code ??= "crew-write-failed";
                return Reject(code, ctx, seed, account, round, back, res.Error);
            }

            /* ⑩ 标记 taken (幂等; 失败不影响本次结果 —— 重试时同一 slot 会走幂等分支) */
            try { _store.MarkTaken(account, round, ctx.Id, slot); }
            catch (Exception ex) { Console.Error.WriteLine($"[recruit] MarkTaken 失败 settle={ctx.Id} slot={slot}: {ex.Message}"); }

            return Ok(new
            {
                ok = true,
                duplicated = false,
                member,
                items,
                squadId = newSquadId,
                rev = res.Contract!.Revision,
                points = PointsDto(account, round, afterSpend),
                hireGate = Gate(res.Contract, ctx.Id, seed, ctx.Name)
            });
        }

        /* ---------------- 响应工具 ---------------- */

        private static string SquadOf(CrewContract? c, string memberId)
        {
            if (c?.Squads == null) return "";
            foreach (var s in c.Squads)
                if (s.Members != null && s.Members.Contains(memberId)) return s.Id;
            return "";
        }

        private IResult Reject(string code, SettleCtx ctx, string seed, string account, int round,
                               RecruitPointRow pt, string? detail = null)
        {
            var gate = Gate(_crew.Get(), ctx.Id, seed, ctx.Name);
            var points = PointsDto(account, round, pt);
            var msg = code switch
            {
                "wrong-settle" => "队伍驻地不在本聚落，需回到驻地才能招募",
                "squad-full" => "目标小队已满",
                "no-squad" => "指定的队伍不存在",
                "squad-limit" => $"小队数已满 {MaxSquads} 支",
                _ => detail ?? "招募失败"
            };
            return Ok(new { ok = false, code, error = msg, points, hireGate = gate });
        }

        private static IResult Ok(object o) => Results.Json(o, CrewJson.Options,
            contentType: "application/json; charset=utf-8");

        private static IResult Fail(string code, string error, int status) => Results.Json(
            new { ok = false, code, error }, CrewJson.Options,
            contentType: "application/json; charset=utf-8", statusCode: status);
    }

    /* ---------------- 请求体 (放在 Api 外面: Map 里要用) ---------------- */
    private static async Task<(JsonObject? Body, IResult? Bad)> ReadBody(HttpContext ctx)
    {
        JsonNode? node;
        try { node = await JsonNode.ParseAsync(ctx.Request.Body); }
        catch (JsonException e)
        {
            return (null, Fail("bad-json", "JSON 解析失败: " + e.Message, 400));
        }
        if (node is not JsonObject obj)
            return (null, Fail("bad-json", "请求体必须是 JSON 对象", 400));
        return (obj, null);
    }

    private static IResult Fail(string code, string error, int status) => Results.Json(
        new { ok = false, code, error }, CrewJson.Options,
        contentType: "application/json; charset=utf-8", statusCode: status);

    /* ---------------- 请求头/查询里的账号 (demo 无鉴权: 缺省 guest) ---------------- */
    private static string Account(HttpContext ctx)
    {
        var h = ctx.Request.Headers["X-Account"].ToString().Trim();
        if (h.Length == 0) h = ctx.Request.Query["account"].ToString().Trim();
        if (h.Length == 0) h = "guest";           // 前端 WS 登录的缺省账号 (mapclient.js)
        return h.Length > 64 ? h[..64] : h;
    }

    private static string Str(JsonObject body, string key)
    {
        var n = body[key];
        if (n == null) return "";
        try { return n.GetValue<string>() ?? ""; }
        catch { return n.ToString(); }
    }

    private static int IntOf(JsonObject body, string key, int def)
    {
        var n = body[key];
        if (n == null) return def;
        try { return n.GetValue<int>(); }
        catch
        {
            return int.TryParse(n.ToString(), out var v) ? v : def;
        }
    }

    private static bool BoolOf(JsonObject body, string key)
    {
        var n = body[key];
        if (n == null) return false;
        try { return n.GetValue<bool>(); }
        catch
        {
            var s = n.ToString();
            return s == "1" || string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
        }
    }
}
