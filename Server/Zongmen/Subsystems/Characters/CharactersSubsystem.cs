using System.Text;
using Zongmen.Engine;
using Zongmen.Protocol;
using Zongmen.Services;
using Zongmen.Time;

namespace Zongmen.Subsystems.Characters;

/* ============================================================
 * 角色子系统 (Subsystems/Characters/)
 * ------------------------------------------------------------
 * 本类是本子系统对外的**唯一接缝**: 模块声明 + 认领的 job + 数据端点。
 *
 * ★ 无台账 (Tables 为空 / 无 StateStore) —— 这是与 City 的**关键差异**, 也是本子系统
 *   的架构主张: 角色是 (seed, index) 的**纯函数派生**, 每次请求确定性重算。
 *   于是:
 *     · 不需要 1MB 的落库表 (用户明确否掉的方案);
 *     · 天然免疫 PruneExcept 误删 (它根本不碰 Data 表);
 *     · 换世 = 换 seed 即换一批人, 零迁移成本。
 *   将来若要接 Tick 演化 (寿元/修炼/迁移), 只需把**可变派生层** (age/progress/alive…)
 *   另立一张独立表 (CultivatorStore), 身份/属性仍由 seed 派生 —— 结构与 CityState 同形。
 *
 * ⚠ 端点由本子系统**自己声明** (MapEndpoints), 而不是塞进 MapEndpoints.cs:
 *   后者属 Core(Web 层), 让它引用具体子系统类型就违了「Core 只认 ISubsystem」的约束。
 *   Program.cs 是**组合根**, 由它调本方法 —— 组合根认识具体类型是允许且必要的。
 * ============================================================ */
public sealed class CharactersSubsystem : ISubsystem
{
    public string Name => "characters";

    /// <summary>本子系统的 V8 模块 (独立 VM, scope = "characters")。</summary>
    public JsvmModule? Module { get; }

    /// <summary>尚未认领 tick job —— 时间维度 (寿元/修炼) 待接 Tick 时再声明, 并由本子系统
    /// 配一个 CharactersTickExecutor (认领集**不得**与 CityTickExecutor 重叠)。
    /// ⚠ 现在声明空集是刻意的: TickExecutorHub 要求每个**执行器**的非空 Claims,
    ///   而本子系统暂无执行器 ⇒ 空集既安全又不撒谎。</summary>
    public IReadOnlyList<TickJobKind> Claims { get; } = Array.Empty<TickJobKind>();

    /// <summary>无台账 (角色是 seed 纯函数派生, 不落库)。</summary>
    public string[] Tables => Array.Empty<string>();

    public CharactersSubsystem(string charactersDir)
    {
        Module = new CharactersModule(Path.Combine(charactersDir, "js"), Path.Combine(charactersDir, "data"));
    }

    /// <summary>换世: 无世态可清 (角色按当前 seed 现算) ⇒ 返回 0。</summary>
    public int OnWorldChanged(int round) => 0;

    /* ============================================================
     * 数据端点: GET /api/characters?seed=&count=&offset=
     * ------------------------------------------------------------
     * 与前端的契约: 前端「众生录」窗口 (web/js/roster.js) fetch 本端点,
     * 拿到 {schema,seed,count,offset,dict,characters[]} —— 与旧的静态快照**同构**,
     * 故前端模块零改动 (只是 dataUrl 换了个地址)。
     *
     * ⚠ seed 缺省 = **当前世** (服务端资产, 前端不必知道; 与「种子绝不回落前端造」同规矩)。
     * ⚠ 必须 gzip: 300 人 ≈ 1MB JSON ⇒ 手工压缩 + 标 Content-Encoding (与 tile 同口径,
     *   浏览器/undici 按 header 透明解压)。
     * ⚠ no-cache: 换世 / 将来演化都会让人物变化, 缓存住就是"改了没反应"。
     * ============================================================ */
    public void MapEndpoints(WebApplication app, MapWorldService world)
    {
        app.MapGet("/api/characters", (string? seed, int? count, int? offset, HttpContext ctx) =>
        {
            var s = (seed ?? "").Trim();
            if (s.Length == 0) s = world.CurrentSeed() ?? "";
            var n = count is > 0 and <= 2000 ? count.Value : 300;         // 默认 300 人
            var off = offset is >= 0 and <= 100000 ? offset.Value : 0;

            string json;
            if (s.Length == 0)
            {
                /* 尚无当前世 (极少: 正常流程 /api/world/current 已建世) ⇒ 回**结构合法**的空载荷,
                   让前端窗口照常渲染「暂无」而不是报错。dict 给 null, roster 走兜底标签表。 */
                json = "{\"schema\":\"cultivators/v1\",\"seed\":\"\",\"count\":0,\"offset\":0,"
                     + "\"dict\":null,\"characters\":[]}";
            }
            else
            {
                try
                {
                    using var lease = world.LeaseScope(Module!.Scope, s);
                    json = lease.Vm.Call("cultivatorBatchJson", s, n, off);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[characters] 生成失败 seed={s} n={n}: {ex.GetType().Name}: {ex.Message}");
                    return Results.Text(
                        "{\"schema\":\"cultivators/v1\",\"count\":0,\"characters\":[],\"err\":\"generate_failed\"}",
                        "application/json; charset=utf-8", statusCode: 500);
                }
            }

            var gz = GZipCodec.Compress(Encoding.UTF8.GetBytes(json));
            ctx.Response.Headers.ContentEncoding = "gzip";
            ctx.Response.Headers.CacheControl = "no-cache, no-store";
            return Results.Bytes(gz, "application/json; charset=utf-8");
        });

        /* ============================================================
         * 点击详情: GET /api/people?seed=&q=&r=
         * ------------------------------------------------------------
         * 「点哪一格, 就看哪一格的人」(用户 Q2: 详情按**网格**取, 不按区块取)。
         * 回 { schema, seed, q, r, kind, n, ps, squads:[{id,size,power,rep}] } —— 小队按战力降序。
         *
         * ⚠ 两段拼接 (两个独立 V8, 刻意不合并):
         *   ① **落人格**「谁在哪一格」→ 核心 VM (`WorldModule`: 有骨架 + 地形)
         *   ② **战力/小队**「是谁、多少战力」→ 本子系统的 characters VM (有六维)
         *   任一环节失败 ⇒ 500 + err, 绝不回一份「人数对不上」的半成品。
         * ============================================================ */
        app.MapGet("/api/people", (string? seed, int? q, int? r, HttpContext ctx) =>
        {
            var s = (seed ?? "").Trim();
            if (s.Length == 0) s = world.CurrentSeed() ?? "";
            if (s.Length == 0 || q is null || r is null)
                return Results.Text("{\"schema\":\"people/v1\",\"err\":\"bad_args\"}",
                                    "application/json; charset=utf-8", statusCode: 400);

            string json;
            try
            {
                string place;
                using (var core = world.LeaseScope(WorldModule.WorldScope, s))
                    place = core.Vm.Call("peopleAtJson", q.Value, r.Value);

                using var pd = System.Text.Json.JsonDocument.Parse(place);
                var root = pd.RootElement;
                var n = root.GetProperty("n").GetInt32();
                var baseIdx = root.GetProperty("base").GetInt64();
                var kind = root.TryGetProperty("kind", out var kEl) ? kEl.GetString() ?? "" : "";

                string detail;
                if (n <= 0)
                    detail = "{\"n\":0,\"ps\":0,\"squads\":[]}";
                else
                {
                    using var lease = world.LeaseScope(Module!.Scope, s);
                    detail = lease.Vm.Call("squadBatchJson", s, baseIdx, n);
                }
                json = "{\"schema\":\"people/v1\",\"seed\":" +
                       System.Text.Json.JsonSerializer.Serialize(s) +
                       ",\"q\":" + q.Value + ",\"r\":" + r.Value +
                       ",\"kind\":" + System.Text.Json.JsonSerializer.Serialize(kind) +
                       "," + detail.Substring(1);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[people] 生成失败 seed={s} q={q} r={r}: {ex.GetType().Name}: {ex.Message}");
                return Results.Text("{\"schema\":\"people/v1\",\"err\":\"generate_failed\"}",
                                    "application/json; charset=utf-8", statusCode: 500);
            }

            var gz = GZipCodec.Compress(Encoding.UTF8.GetBytes(json));
            ctx.Response.Headers.ContentEncoding = "gzip";
            ctx.Response.Headers.CacheControl = "no-cache, no-store";
            return Results.Bytes(gz, "application/json; charset=utf-8");
        });
    }
}
