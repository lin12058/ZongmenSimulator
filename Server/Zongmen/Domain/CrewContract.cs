using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zongmen.Domain;

/* ============================================================
 * 小队数据契约 (2026-11-24 用户定案: 顶层就两棵树)
 * ------------------------------------------------------------
 *   Squad  小队 —— 有哪些人, 每个人在干什么 (Activity)
 *   Bag    背包 —— 有哪些东西 (全队共用一套, 物品只在 Bag.Items 里出现一次)
 *
 * 三条硬约定 (与前端 crew-bridge.js 完全一致, 双侧改动必须同步):
 *   1. **只传源数据, 不传派生值**。气血/攻击/防御/命中/闪避/负重全部由前端
 *      attrs() 现算; Realm / Role / Age / Gender 是纯展示文本, 不参与任何公式。
 *   2. **装备存 itemId 引用**。Cell = 整数 ⇒ 在背包第 N 格; Cell = null ⇒
 *      穿戴在某成员身上 (或在该成员的法宝队列里)。
 *   3. **Id 全局唯一, 由服务端生成**。推荐前缀 srv-, 避免与前端调试用的
 *      自增 i1/i2 撞车 (撞了会表现为"两件不同东西被当成同一件")。
 *
 * 序列化: JsonSerializerDefaults.Web (camelCase + 大小写不敏感),
 *   前端直接 JSON.parse 就能用, 不需要中间层改名。
 * ============================================================ */
public sealed class CrewContract
{
    /// <summary>契约版本。结构不兼容时 +1, 前端按版本拒绝装载。</summary>
    public int Version { get; set; } = 1;

    /// <summary>递增修订号。每次 PUT/PATCH 由服务端 +1, 前端可用来判断"是否落后于服务端"。</summary>
    public int Revision { get; set; }

    /// <summary>最后写入时间 (Unix ms)。</summary>
    public long UpdatedAt { get; set; }

    public SquadDto Squad { get; set; } = new();

    /// <summary>多小队分组 (2026-11-25 §12 升级 · 修 S5)。
    /// ⚠ 与 <see cref="Squad"/>.Members 的分工: 后者是**全员平面名单** (前端 hydrate 据此建人,
    ///   少一个就少一个弟子), 本字段只回答「谁在哪队 / 队内第几位 / 队叫什么 / 队序」。
    ///   成员归属的唯一真源是 `Members` 的**数组顺序**, 不另存 position 字段。
    ///   缺失或为空 ⇒ 前端退化为「一队装全员」(与 normalizeSquads 的补队口径一致)。</summary>
    public List<SquadGroupDto> Squads { get; set; } = new();

    /// <summary>当前队 id。属前端本地偏好, 存下来只为「dump→hydrate 一次往返不丢」。</summary>
    public string CurSquad { get; set; } = "";

    public BagDto Bag { get; set; } = new();
    public List<JobDto> Jobs { get; set; } = new();
}

/// <summary>一支小队的**分组信息** (不含成员详情 —— 那些在 <see cref="SquadDto.Members"/> 里)。</summary>
public sealed class SquadGroupDto
{
    public string Id { get; set; } = "";
    /// <summary>队名 (≤4 字, 由前端清洗; 服务端只存不校验)。</summary>
    public string Name { get; set; } = "";
    /// <summary>成员 id, **顺序即站位** (0 = 队首)。</summary>
    public List<string> Members { get; set; } = new();
}

/// <summary>小队: 编制 + 成员。没换人的情况下, 只有 Members 里的内容会变。</summary>
public sealed class SquadDto
{
    public string Id { get; set; } = "squad-1";
    public string Name { get; set; } = "小队";
    /// <summary>编制上限 (人数)。与背包格子数无关。</summary>
    public int Capacity { get; set; } = 9;
    public List<MemberDto> Members { get; set; } = new();
}

public sealed class MemberDto
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>职司, 纯展示 (剑修/丹修…)。不参与数值计算。</summary>
    public string Role { get; set; } = "";
    public string Gender { get; set; } = "男";
    public int Age { get; set; } = 20;
    /// <summary>境界, 纯展示。不参与数值计算。</summary>
    public string Realm { get; set; } = "炼气期 · 1 层";
    /// <summary>当前修为。上限 = 600 + 天赋总量 × 6 (前端现算)。</summary>
    public int Exp { get; set; }
    public int Mood { get; set; } = 70;

    public RootDto Root { get; set; } = new();
    public TalentDto Talents { get; set; } = new();
    public List<TraitRefDto> Traits { get; set; } = new();

    /// <summary>穿戴槽: 值是 itemId (或 null)。法宝槽必须 === Queue[0]。</summary>
    public EquipDto Equip { get; set; } = new();
    /// <summary>法宝队列 1~4 件 (itemId), 首位 = 当前佩戴。</summary>
    public List<string> Queue { get; set; } = new();
    public string QueueFrom { get; set; } = "本命一件";

    public ArtsDto Arts { get; set; } = new();

    /// <summary>当前气血/灵力。上限由前端 attrs() 现算, 这里只给当前值。</summary>
    public VitalDto Vit { get; set; } = new();

    /// <summary>在干什么 —— 小队面板的核心字段, 空闲也必须给 kind=idle。</summary>
    public ActivityDto Activity { get; set; } = new();

    /// <summary>工种优先级: jobId → 1 最急 / 2 / 3 / 4 最缓 / 0 不做。</summary>
    public Dictionary<string, int> Prio { get; set; } = new();
}

public sealed class RootDto
{
    /// <summary>灵根顺序, 固定 5 项 (jin/mu/shui/huo/tu)。可省略, 服务端按默认顺序解释。</summary>
    public List<string> Order { get; set; } = new();
    /// <summary>五行吸收比例, **合计恒 100** (前端会对不齐的按比例归一)。</summary>
    public List<int> V { get; set; } = new();
    /// <summary>主灵根下标 0~4。</summary>
    public int Main { get; set; }
}

public sealed class TalentDto
{
    /// <summary>六道 × 每道 6 项: body/qi/mind/gear/pill/array。单项 ≤60, 总量 90~180。</summary>
    public Dictionary<string, int[]> V { get; set; } = new();
    /// <summary>冗余字段 (前端也会重算)。给错了只告警, 以各道实际合计为准。</summary>
    public int Total { get; set; }
}

/// <summary>特质只按**名字**生效 (前端 attrs()/rateOf 硬编码了 8 个名字)。</summary>
public sealed class TraitRefDto
{
    public string N { get; set; } = "";
    /// <summary>可选, 仅用于自定义特质在面板上的说明文字。</summary>
    public string? V { get; set; }
}

public sealed class EquipDto
{
    public string? Weapon { get; set; }
    public string? Offhand { get; set; }
    public string? Body { get; set; }
    public string? Head { get; set; }
    public string? Talisman { get; set; }
}

public sealed class ArtsDto
{
    public List<ArtDto> Slots { get; set; } = new();
    public int Cap { get; set; }
    public string From { get; set; } = "本命三格";
}

public sealed class ArtDto
{
    public string N { get; set; } = "";
    /// <summary>阶 1~7。</summary>
    public int Rank { get; set; } = 1;
    /// <summary>耗灵 1~6。</summary>
    public int Cost { get; set; } = 1;
}

public sealed class VitalDto
{
    public int Hp { get; set; }
    public int Mp { get; set; }
}

/// <summary>
/// 在干什么。Kind 决定面板顶部那一行的措辞:
///   work 干活 / idle 空闲 / rest 静养 / combat 交手 / away 外出
/// </summary>
public sealed class ActivityDto
{
    public string Kind { get; set; } = "idle";
    /// <summary>对应 JobDto.Id; Kind != work 时应为 null。</summary>
    public string? JobId { get; set; }
    /// <summary>给玩家看的具体动作 (采灵草 / 看炉 …)。</summary>
    public string TaskName { get; set; } = "";
    /// <summary>0~100。</summary>
    public int Progress { get; set; }
    /// <summary>累计完成件数。</summary>
    public int Done { get; set; }
    /// <summary>开始时间 (Unix ms), 0 = 未知。用于算时长/效率。</summary>
    public long Since { get; set; }
    /// <summary>卡住原因 (灵草不足 / 伤势未愈 …), 面板直接显示。</summary>
    public string Note { get; set; } = "";
}

/// <summary>背包: 全队共用一套。物品总数 = 格中 + 穿戴中。</summary>
public sealed class BagDto
{
    /// <summary>总格数, 默认 48 (6×8)。</summary>
    public int Capacity { get; set; } = 48;
    public int Cols { get; set; } = 6;
    public int Rows { get; set; } = 8;
    public List<ItemDto> Items { get; set; } = new();
}

public sealed class ItemDto
{
    /// <summary>全局唯一。</summary>
    public string Id { get; set; } = "";
    /// <summary>格位。整数 = 在背包第 N 格; null = 穿戴中 (见 WornBy)。</summary>
    public int? Cell { get; set; }
    /// <summary>只读输出字段: 被哪个成员穿着 (服务端可不填, 前端 dump 时回填)。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? WornBy { get; set; }

    public string Name { get; set; } = "";
    /// <summary>weapon / offhand / body / head / talisman / pill / material / book。
    /// 决定能穿哪个槽 (前端 slotOf)。</summary>
    public string Kind { get; set; } = "material";
    /// <summary>格子里的单字图标。</summary>
    public string Ch { get; set; } = "物";
    /// <summary>品阶 1~6。</summary>
    public int Q { get; set; } = 1;
    public double W { get; set; }

    public int Atk { get; set; }
    public int Def { get; set; }
    public int Acc { get; set; }
    public int Hp { get; set; }
    public int Mp { get; set; }
    /// <summary>服用回血量 (丹药)。</summary>
    public int Heal { get; set; }

    public int Qty { get; set; } = 1;
    public int QtyMax { get; set; } = 1;
}

/// <summary>工种表。一般由前端内置一份, 服务端只在需要扩展工种时下发覆盖。</summary>
public sealed class JobDto
{
    public string Id { get; set; } = "";
    public string Ch { get; set; } = "";
    public string N { get; set; } = "";
    public string Target { get; set; } = "";
    /// <summary>body/qi/mind/gear/pill/array</summary>
    public string Dao { get; set; } = "body";
}

/* ============================================================
 * 增量补丁 (POST /api/crew/patch 的请求体)
 * ------------------------------------------------------------
 * ⚠ 这里**刻意没有 C# DTO**: 服务端按原始 JSON 逐键合并, 因为只有"键是否存在"
 *   才能区分「没传这个字段」与「显式传 0 / null」。一旦先反序列化成 C# 类,
 *   缺失的 int 会变成 0、缺失的 string 会变成 null, 合并就会把原值抹掉。
 *
 * 请求体形状 (所有字段可选):
 *   {
 *     "squad":   { "name": "外门三队", "capacity": 9 },
 *     "members": [ { "id": "srv-p-1", "activity": { "kind": "work",
 *                    "jobId": "gather", "taskName": "采灵草", "progress": 43 } } ],
 *     "removeMembers": ["srv-p-9"],
 *     "items":   [ { "id": "srv-i-1", "cell": 12 } ],
 *     "removeItems":   ["srv-i-9"],
 *     "jobs":    [ … 整表替换 … ]
 *   }
 * 语义: members / items 按 id **字段级合并** (对象递归、数组整体替换);
 *       id 不存在则新增; remove* 按 id 删除。
 * ============================================================ */

/// <summary>契约的 JSON 约定 (Web 默认: camelCase + 大小写不敏感 + 数字字符串可读)。</summary>
public static class CrewJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        WriteIndented = false
    };
}
