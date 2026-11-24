using System.Text.Json;
using System.Text.Json.Nodes;
using Zongmen.Domain;
using Zongmen.Storage;

namespace Zongmen.Web;

/* ============================================================
 * 小队数据 API —— /api/crew
 * ------------------------------------------------------------
 *   GET    /api/crew           取当前小队契约 (没有则 404)
 *   PUT    /api/crew           全量覆盖 (部署/导入存档/演示初始化)
 *   POST   /api/crew/patch     增量合并 (日常: 改任务进度 / 换装 / 增减物品)
 *   DELETE /api/crew           清空 (调试)
 *   GET    /api/crew/schema    契约字段说明 (给前端/联调用, 不返回业务数据)
 *
 * 与地图接口的分工: /api/map/* 是**只读**世界数据; /api/crew 是**可写**的存档数据,
 * 所以写操作一律 POST/PUT (带副作用, 不能被预取或缓存重放)。
 * ============================================================ */
public static class CrewEndpoints
{
    public static void Map(WebApplication app, CrewStore store)
    {
        app.MapGet("/api/crew", () =>
        {
            var c = store.Get();
            if (c == null)
            {
                return Results.Json(new
                {
                    error = "no squad",
                    hint = "先用 PUT /api/crew 灌一份契约; 字段说明见 GET /api/crew/schema"
                }, CrewJson.Options, statusCode: 404);
            }
            /* no-store: 存档必须每次取最新, 不能被浏览器/代理缓存 */
            return Results.Json(c, CrewJson.Options);
        });

        app.MapPut("/api/crew", async (HttpRequest req) =>
        {
            CrewContract? c;
            try
            {
                c = await JsonSerializer.DeserializeAsync<CrewContract>(req.Body, CrewJson.Options);
            }
            catch (JsonException e)
            {
                return Results.Json(new { ok = false, error = "JSON 解析失败: " + e.Message },
                    CrewJson.Options, statusCode: 400);
            }
            if (c == null)
                return Results.Json(new { ok = false, error = "空请求体" }, CrewJson.Options, statusCode: 400);
            if (c.Version != 1)
            {
                return Results.Json(new { ok = false, error = $"契约版本 {c.Version} 不被支持 (当前 1)" },
                    CrewJson.Options, statusCode: 409);
            }
            if (c.Squad.Members.Count == 0)
                return Results.Json(new { ok = false, error = "squad.members 不能为空" }, CrewJson.Options, statusCode: 400);
            if (c.Squad.Members.Select(m => m.Id).Distinct().Count() != c.Squad.Members.Count)
                return Results.Json(new { ok = false, error = "成员 id 重复" }, CrewJson.Options, statusCode: 400);
            if (c.Bag.Items.Select(i => i.Id).Distinct().Count() != c.Bag.Items.Count)
                return Results.Json(new { ok = false, error = "物品 id 重复" }, CrewJson.Options, statusCode: 400);

            /* 全量 PUT 是权威存档 ⇒ 格位必须严格自洽 (与 patch 的宽松语义不同):
               patch 允许两个请求之间的瞬时冲突, PUT 不接受。 */
            var cells = new Dictionary<int, string>();
            foreach (var it in c.Bag.Items)
            {
                it.WornBy = null;               // 只读输出字段, 不信任客户端
                if (it.Cell is not int cell) continue;
                if (cell < 0 || cell >= c.Bag.Capacity)
                    return Results.Json(new { ok = false, error = $"物品 {it.Id} 的 cell 越界({cell}), 容量 {c.Bag.Capacity}" },
                        CrewJson.Options, statusCode: 400);
                if (cells.TryGetValue(cell, out var other))
                    return Results.Json(new { ok = false, error = $"格 {cell} 被两件物品占用: {other} / {it.Id}" },
                        CrewJson.Options, statusCode: 400);
                cells[cell] = it.Id;
            }

            var saved = store.Save(c);
            return Results.Json(new
            {
                ok = true,
                revision = saved.Revision,
                members = saved.Squad.Members.Count,
                items = saved.Bag.Items.Count
            }, CrewJson.Options);
        });

        app.MapPost("/api/crew/patch", async (HttpRequest req) =>
        {
            JsonNode? node;
            try
            {
                node = await JsonNode.ParseAsync(req.Body);
            }
            catch (JsonException e)
            {
                return Results.Json(new { ok = false, error = "JSON 解析失败: " + e.Message },
                    CrewJson.Options, statusCode: 400);
            }
            if (node is not JsonObject obj)
                return Results.Json(new { ok = false, error = "patch 必须是 JSON 对象" },
                    CrewJson.Options, statusCode: 400);

            var merged = store.Patch(obj, out var err);
            if (merged == null)
            {
                var code = err != null && err.Contains("尚未写入") ? 404 : 400;
                return Results.Json(new { ok = false, error = err ?? "合并失败" }, CrewJson.Options, statusCode: code);
            }
            return Results.Json(new
            {
                ok = true,
                revision = merged.Revision,
                members = merged.Squad.Members.Count,
                items = merged.Bag.Items.Count
            }, CrewJson.Options);
        });

        app.MapDelete("/api/crew", () =>
        {
            var had = store.Clear();
            return Results.Json(new { ok = true, cleared = had }, CrewJson.Options);
        });

        app.MapGet("/api/crew/schema", () => Results.Json(Schema(), CrewJson.Options));
    }

    /* ---------------- 契约说明 (联调用, 不返回业务数据) ---------------- */
    private static object Schema() => new
    {
        version = 1,
        top = new
        {
            squad = "小队: 有哪些人 + 每个人在干什么",
            bag = "背包: 有哪些东西 (全队共用, 物品只出现一次)",
            jobs = "工种表 (可选, 缺省用前端内置)",
            revision = "服务端维护的递增修订号",
            updatedAt = "最后写入时间 (Unix ms)"
        },
        squad = new
        {
            id = "string", name = "string", capacity = "int 编制上限",
            members = new[]
            {
                new
                {
                    id = "string 全局唯一 (建议前缀 srv-)",
                    name = "string", role = "string 纯展示", gender = "string", age = "int",
                    realm = "string 纯展示 (不参与属性计算)",
                    exp = "int 当前修为; 上限 = 600 + 天赋总量×6",
                    mood = "int 0~100",
                    root = new { order = "string[5] 五行键", v = "int[5] 合计必须 100", main = "int 主灵根下标" },
                    talents = new { v = "map<dao, int[6]> daos=body,qi,mind,gear,pill,array", total = "int 冗余, 前端以实际合计为准" },
                    traits = "array<{n:string}> 1~3 条; 只有 8 个名字真正生效: 勤勉/懒散/坚毅/怯懦/胆识/畏战/血旺/亏血",
                    equip = "map<slot, itemId|null> slots=weapon,offhand,body,head,talisman; talisman 必须 = queue[0]",
                    queue = "string[] 法宝队列 1~4 件 itemId",
                    arts = new { slots = "array<{n,rank,cost}>", cap = "int", from = "string 纯展示" },
                    vit = new { hp = "int 当前气血", mp = "int 当前灵力" },
                    activity = new
                    {
                        kind = "work|idle|rest|combat|away",
                        jobId = "string 对应 jobs[].id; kind!=work 时为 null",
                        taskName = "string 给玩家看的动作名",
                        progress = "int 0~100", done = "int 累计完成件数",
                        since = "long 开始时间 Unix ms", note = "string 卡住原因"
                    },
                    prio = "map<jobId, 1..4|0>  1 最急 / 4 最缓 / 0 不做"
                }
            }
        },
        bag = new
        {
            capacity = "int 总格数 (默认 48)", cols = "int 6", rows = "int 8",
            items = new[]
            {
                new
                {
                    id = "string 全局唯一", cell = "int|null; 整数=第 N 格, null=穿戴中",
                    wornBy = "string|null 只读输出, 被哪个成员穿着",
                    name = "string", kind = "weapon|offhand|body|head|talisman|pill|material|book",
                    ch = "string 单字图标", q = "int 品阶 1~6", w = "double 重量",
                    atk = "int", def = "int", acc = "int", hp = "int", mp = "int", heal = "int 服用回血",
                    qty = "int", qtyMax = "int"
                }
            }
        },
        patchShape = new
        {
            squad = new { name = "string?", capacity = "int?" },
            members = "array<部分 Member> 按 id 字段级合并, 不存在则新增",
            removeMembers = "string[]",
            items = "array<部分 Item> 按 id 字段级合并",
            removeItems = "string[] 删除物品时会自动清掉成员身上对它的引用",
            jobs = "array<Job> 整表替换"
        },
        rules = new[]
        {
            "只传源数据: 气血/攻击/防御/命中/闪避/负重由前端 attrs() 现算, 传了也会被覆盖",
            "realm / role / age / gender 是纯展示文本, 不参与任何公式",
            "装备用 itemId 引用; 物品本体只在 bag.items 出现一次",
            "成员删除后其穿戴物品变回 cell=null, 前端会自动补进空格 (不销毁)"
        }
    };
}
