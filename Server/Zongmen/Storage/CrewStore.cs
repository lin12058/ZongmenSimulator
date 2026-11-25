using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using Zongmen.Domain;

namespace Zongmen.Storage;

/* ============================================================
 * 小队数据存储 (Crew 表)
 * ------------------------------------------------------------
 * 为什么整份契约存一列 JSON, 而不是把成员/物品拆成关系表:
 *   · 一次读取就要**整份一致**的小队 (人 + 身上装备 + 背包), 拆表反而要写事务拼接;
 *   · 字段还会长 (特质/神通/优先级), 拆表每加一个字段都要迁移;
 *   · 量级极小 (几个弟子 + 几十件物品), 没有按字段查询的需求。
 *
 * ⚠ 必须是**独立表**: Data(Key,Value) 会被 MapWorldService 的
 *   PruneExcept(活跃 seed 前缀) 定期 DELETE, 塞进去会被静默清空。
 *   与 WorldLedger 同一个坑, 处理方式一致。
 *
 * ⚠ 同步短连接风格 (与 SqliteVirtualContext / WorldLedger 一致): 调用频率低
 *   (进面板读一次 / 玩家改动推一次), 不值得引入写队列。
 * ⚠ dbPath = null ⇒ 仅内存 (PersistEnabled=false 的降级), 行为一致, 重启归零。
 * ============================================================ */
/// <summary>锁内原子变换的结果。Committed=false 且 Error=null ⇒ mutate 主动放弃 (业务校验不过)。
/// Contract 在放弃时给的是**未改动**的现行契约 (仅供读, 不要在上面做写操作)。</summary>
public sealed record MutateResult(bool Committed, CrewContract? Contract, string? Error);

public sealed class CrewStore : IDisposable
{
    private const string CsTemplate = "Data Source={0};Pooling=True";
    /// <summary>一个存档位。将来要多小队时, 这把键换成 squad id 即可。</summary>
    public const string DefaultId = "squad-1";

    private sealed class Row
    {
        public int Revision;
        public long UpdatedAt;
        public CrewContract Contract = new();
    }

    private readonly string? _cs;
    private readonly Dictionary<string, Row> _mem = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private bool _loaded;

    public bool Persisted => _cs != null;

    public CrewStore(string? dbPath)
    {
        if (string.IsNullOrEmpty(dbPath)) return;
        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);
        using var init = Open();
        using var cmd = init.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS Crew (
                Id        TEXT    PRIMARY KEY,
                Revision  INTEGER NOT NULL,
                Json      TEXT    NOT NULL,
                UpdatedAt INTEGER NOT NULL
            );
            """;
        cmd.ExecuteNonQuery();
    }

    private SqliteConnection Open()
    {
        var c = new SqliteConnection(_cs);
        c.Open();
        using (var p = c.CreateCommand())
        {
            p.CommandText = "PRAGMA busy_timeout=8000;";
            p.ExecuteNonQuery();
        }
        return c;
    }

    /* ---------------- 读 ---------------- */

    /// <summary>当前小队契约。没有数据时返回 null (调用方给 404)。</summary>
    public CrewContract? Get(string id = DefaultId)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _mem.TryGetValue(id, out var row) ? row.Contract : null;
        }
    }

    public int Revision(string id = DefaultId)
    {
        lock (_gate)
        {
            EnsureLoaded();
            return _mem.TryGetValue(id, out var row) ? row.Revision : 0;
        }
    }

    /* ---------------- 写 ---------------- */

    /// <summary>全量覆盖。Revision 由服务端 +1 (客户端传什么都不作数)。</summary>
    public CrewContract Save(CrewContract c, string id = DefaultId)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var rev = (_mem.TryGetValue(id, out var old) ? old.Revision : 0) + 1;
            c.Revision = rev;
            c.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (string.IsNullOrEmpty(c.Squad.Id)) c.Squad.Id = id;
            var row = new Row { Revision = rev, UpdatedAt = c.UpdatedAt, Contract = c };
            _mem[id] = row;
            if (_cs != null)
            {
                using var conn = Open();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO Crew(Id, Revision, Json, UpdatedAt) VALUES($i, $r, $j, $u)
                    ON CONFLICT(Id) DO UPDATE SET Revision=$r, Json=$j, UpdatedAt=$u;
                    """;
                cmd.Parameters.AddWithValue("$i", id);
                cmd.Parameters.AddWithValue("$r", rev);
                cmd.Parameters.AddWithValue("$j", JsonSerializer.Serialize(c, CrewJson.Options));
                cmd.Parameters.AddWithValue("$u", c.UpdatedAt);
                cmd.ExecuteNonQuery();
            }
            return c;
        }
    }

    /// <summary>
    /// 增量合并。⚠ 入参是**原始 JSON**, 不是 DTO —— 只有"键是否存在"才能区分
    /// 「没传」与「显式传 0 / null」。语义见 CrewContract.cs 尾部的注释。
    /// </summary>
    public CrewContract? Patch(JsonObject patch, out string? error, string id = DefaultId)
    {
        error = null;
        lock (_gate)
        {
            EnsureLoaded();
            if (!_mem.TryGetValue(id, out var row))
            {
                error = "尚未写入小队数据, 先用 PUT /api/crew 灌一份";
                return null;
            }
            if (JsonSerializer.SerializeToNode(row.Contract, CrewJson.Options) is not JsonObject root)
            {
                error = "现有数据无法解析";
                return null;
            }

            /* --- squad: 字段级合并 --- */
            if (patch["squad"] is JsonObject sq && root["squad"] is JsonObject curSq)
                MergeInto(curSq, sq);

            /* --- members: 按 id upsert --- */
            if (root["squad"] is JsonObject s2 && s2["members"] is JsonArray members)
            {
                var byId = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                foreach (var node in members)
                    if (node is JsonObject eo && eo["id"]?.ToString() is { Length: > 0 } eid) byId[eid] = eo;

                if (patch["members"] is JsonArray inc)
                {
                    foreach (var node in inc)
                    {
                        if (node is not JsonObject mo) continue;
                        var mid = mo["id"]?.ToString();
                        if (string.IsNullOrEmpty(mid)) { error = "members[] 里有一项缺 id"; return null; }
                        if (byId.TryGetValue(mid, out var hit)) MergeInto(hit, mo);
                        else { var added = (JsonObject)mo.DeepClone(); members.Add(added); byId[mid] = added; }
                    }
                }
                if (patch["removeMembers"] is JsonArray rm)
                {
                    var kill = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var n in rm) if (n?.ToString() is { Length: > 0 } k) kill.Add(k);
                    for (var i = members.Count - 1; i >= 0; i--)
                        if (members[i] is JsonObject eo && kill.Contains(eo["id"]?.ToString() ?? "")) members.RemoveAt(i);
                }
            }

            /* --- items: 按 id upsert --- */
            if (root["bag"] is JsonObject bag && bag["items"] is JsonArray items)
            {
                var byId = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
                foreach (var node in items)
                    if (node is JsonObject eo && eo["id"]?.ToString() is { Length: > 0 } eid) byId[eid] = eo;

                if (patch["items"] is JsonArray inc)
                {
                    foreach (var node in inc)
                    {
                        if (node is not JsonObject io) continue;
                        var iid = io["id"]?.ToString();
                        if (string.IsNullOrEmpty(iid)) { error = "items[] 里有一项缺 id"; return null; }
                        if (byId.TryGetValue(iid, out var hit)) MergeInto(hit, io);
                        else { var added = (JsonObject)io.DeepClone(); items.Add(added); byId[iid] = added; }
                    }
                }
                if (patch["removeItems"] is JsonArray rm)
                {
                    var kill = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var n in rm) if (n?.ToString() is { Length: > 0 } k) kill.Add(k);
                    for (var i = items.Count - 1; i >= 0; i--)
                        if (items[i] is JsonObject io && kill.Contains(io["id"]?.ToString() ?? "")) items.RemoveAt(i);
                    /* 被删物品若还挂在某人身上 ⇒ 一并把引用清掉, 否则前端会报"引用不存在的物品" */
                    if (root["squad"] is JsonObject s3 && s3["members"] is JsonArray ms3)
                    {
                        foreach (var node in ms3)
                        {
                            if (node is not JsonObject mo) continue;
                            if (mo["equip"] is JsonObject eq)
                                foreach (var slot in new[] { "weapon", "offhand", "body", "head", "talisman" })
                                {
                                    var v = eq[slot]?.ToString();
                                    if (v != null && kill.Contains(v)) eq[slot] = null;
                                }
                            if (mo["queue"] is JsonArray q)
                            {
                                for (var qi = q.Count - 1; qi >= 0; qi--)
                                    if (kill.Contains(q[qi]?.ToString() ?? "")) q.RemoveAt(qi);
                            }
                        }
                    }
                }
            }

            /* --- jobs: 整表替换 --- */
            if (patch["jobs"] is JsonArray jobs) root["jobs"] = jobs.DeepClone();

            /* --- squads / curSquad: 整表替换 ---
               ⚠ 队序与队内站位都是**数组顺序**, 逐元素合并没有意义 (拖动只是换位置);
                 增删队也是整份换。所以这里不做 MergeInto, 直接替换。
               ⚠⚠ 但 `settle`(驻地) 必须**兜底保留旧值**: 前端拖动/改名会重发整个 squads
                 数组, 只要它构造时漏了 settle, 按「空 = 未绑定」处理就会在下次 hire 时
                 补绑到当时的聚落 ⇒ 驻地被悄悄改到别处 (不报错、不崩, 只是数据慢慢变错)。
                 口径: 传空 + 旧值非空 ⇒ 保留旧值; 解绑只能显式(目前不提供)。 */
            if (patch["squads"] is JsonArray sgs)
            {
                var oldSettle = new Dictionary<string, string>(StringComparer.Ordinal);
                if (root["squads"] is JsonArray oldSq)
                    foreach (var n in oldSq)
                        if (n is JsonObject o && o["id"]?.ToString() is { Length: > 0 } oid)
                            oldSettle[oid] = o["settle"]?.ToString() ?? "";

                var sqNext = (JsonArray)sgs.DeepClone();
                foreach (var n in sqNext)
                {
                    if (n is not JsonObject o) continue;
                    var sid = o["id"]?.ToString() ?? "";
                    var cur = o["settle"]?.ToString() ?? "";
                    if (cur.Length == 0 && oldSettle.TryGetValue(sid, out var prev) && prev.Length > 0)
                        o["settle"] = prev;
                }
                root["squads"] = sqNext;
            }
            if (patch["curSquad"] is JsonNode csq) root["curSquad"] = csq.DeepClone();

            var next = root.Deserialize<CrewContract>(CrewJson.Options);
            if (next == null) { error = "合并结果无法解析"; return null; }
            return Save(next, id);
        }
    }

    /// <summary>
    /// 锁内原子「读 → 改 → Revision+1 → 落库」。**招募 hire 必须走这里**。
    ///
    /// 为什么不能「锁外 Get → 加人 → Save」: Save 是**全量覆盖**, 会吞掉前端 300ms 窗口里
    /// 刚发的 patch (拖动/派活)。更糟的是两个并发 hire 各自读到旧的 squads 数组再各自写回,
    /// 后写的那个把先写的人**整队覆盖掉** (丢人, 不报错)。
    ///
    /// mutate 返回 false = 主动放弃 (业务校验不过), 此时**不落库、Revision 不动**。
    /// ⚠ 改的是**深拷贝**: mutate 抛异常 / 返回 false 都不会污染内存里的现行契约。
    /// </summary>
    public MutateResult Mutate(Func<CrewContract, bool> mutate, string id = DefaultId, bool createIfMissing = false)
    {
        lock (_gate)
        {
            EnsureLoaded();
            CrewContract? baseC;
            if (_mem.TryGetValue(id, out var row)) baseC = row.Contract;
            else if (createIfMissing)
                baseC = new CrewContract { Squad = new SquadDto { Id = id, Name = "小队" } };
            else
                return new MutateResult(false, null, "尚未写入小队数据, 先用 PUT /api/crew 灌一份");

            /* 深拷贝: 序列化往返最省事 (契约很小), 且能顺带把 null 集合规范回默认值 */
            CrewContract? work;
            try
            {
                work = JsonSerializer.Deserialize<CrewContract>(
                    JsonSerializer.Serialize(baseC, CrewJson.Options), CrewJson.Options);
            }
            catch (Exception ex)
            {
                return new MutateResult(false, null, "契约无法复制: " + ex.Message);
            }
            if (work == null) return new MutateResult(false, null, "契约无法复制");

            /* ⚠ 客户端可能显式传 `"squads": null` ⇒ 反序列化把非空默认值覆盖成 null。
               这里统一垫回空集合, 避免 mutate 闭包里 NRE (那会变成 500, 而不是业务错误码)。 */
            work.Squad ??= new SquadDto { Id = id, Name = "小队" };
            work.Squad.Members ??= new List<MemberDto>();
            work.Bag ??= new BagDto();
            work.Bag.Items ??= new List<ItemDto>();
            work.Squads ??= new List<SquadGroupDto>();
            foreach (var s in work.Squads)
            {
                s.Members ??= new List<string>();
                s.Settle ??= "";
            }

            bool commit;
            try { commit = mutate(work); }
            catch (Exception ex) { return new MutateResult(false, null, "变换失败: " + ex.Message); }
            if (!commit) return new MutateResult(false, baseC, null);

            return new MutateResult(true, Save(work, id), null);
        }
    }

    public bool Clear(string id = DefaultId)
    {
        lock (_gate)
        {
            EnsureLoaded();
            var had = _mem.Remove(id);
            if (_cs != null)
            {
                using var conn = Open();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "DELETE FROM Crew WHERE Id=$i;";
                cmd.Parameters.AddWithValue("$i", id);
                cmd.ExecuteNonQuery();
            }
            return had;
        }
    }

    /* ---------------- 内部 ---------------- */

    /// <summary>对象递归合并; 数组与标量整体替换; null 也照写 (用来把 cell 清空)。</summary>
    private static void MergeInto(JsonObject target, JsonObject src)
    {
        foreach (var kv in src)
        {
            if (kv.Value is JsonObject po)
            {
                if (target[kv.Key] is JsonObject to) MergeInto(to, po);
                else target[kv.Key] = po.DeepClone();
            }
            else
            {
                target[kv.Key] = kv.Value?.DeepClone();
            }
        }
    }

    private void EnsureLoaded()
    {
        if (_loaded || _cs == null) { _loaded = true; return; }
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT Id, Revision, Json, UpdatedAt FROM Crew;";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            var id = r.GetString(0);
            var json = r.GetString(2);
            CrewContract? parsed = null;
            try { parsed = JsonSerializer.Deserialize<CrewContract>(json, CrewJson.Options); }
            catch { /* 坏档不让服务起不来: 跳过, 下次 PUT 覆盖 */ }
            if (parsed == null) continue;
            _mem[id] = new Row { Revision = r.GetInt32(1), UpdatedAt = r.GetInt64(3), Contract = parsed };
        }
        _loaded = true;
    }

    public void Dispose()
    {
        lock (_gate) _mem.Clear();   // 短连接池化, 无持有连接
    }
}
