// CityState 落库编码判据宿主（TypeCode / R0..R7 / Built BLOB / 字典往返）
// 由 verify/check_city_encoding.mjs 调用；每行 "PASS <名>" / "FAIL <名> :: <详情>"
using System.Text;
using System.Text.Json;
using Zongmen.Subsystems.City;

var db = Path.Combine(Path.GetTempPath(), "citystore_probe_" + Environment.ProcessId + ".sqlite");
foreach (var f in new[] { db, db + "-wal", db + "-shm" })
    if (File.Exists(f)) File.Delete(f);

var pass = 0; var fail = 0;
void Ok(string name, bool cond, string detail = "")
{
    if (cond) { pass++; Console.WriteLine("PASS " + name); }
    else { fail++; Console.WriteLine("FAIL " + name + " :: " + detail); }
}

// 资源键比较：缺键按 0（引擎读法是 (+s.stock[r]||0)，省略与写 0 等价）
static bool SameStock(string a, string b)
{
    using var da = JsonDocument.Parse(a);
    using var dbb = JsonDocument.Parse(b);
    foreach (var k in new[] { "粮", "木", "矿", "渔", "炭", "灵", "丹", "器" })
    {
        long va = da.RootElement.TryGetProperty(k, out var x) && x.ValueKind == JsonValueKind.Number ? x.GetInt64() : 0;
        long vb = dbb.RootElement.TryGetProperty(k, out var y) && y.ValueKind == JsonValueKind.Number ? y.GetInt64() : 0;
        if (va != vb) return false;
    }
    return true;
}

string StockJson(int grain, int wood, int mine, int fish, int coal, int spirit, int dan, int qi)
    => $"{{\"粮\":{grain},\"木\":{wood},\"矿\":{mine},\"渔\":{fish},\"炭\":{coal},\"灵\":{spirit},\"丹\":{dan},\"器\":{qi}}}";

try
{
    var builtJson = "[{\"q\":1,\"r\":2,\"kind\":\"药圃\",\"terrain\":\"林地\",\"tier\":1,\"lv\":3,\"evo\":1}," +
                    "{\"q\":-48,\"r\":-51,\"kind\":\"民房\",\"terrain\":\"村落\",\"tier\":2,\"lv\":1,\"evo\":1}]";
    var stockJson = StockJson(100, 50, 10, 0, 5, 1, 2, 3);

    // ── 1. 写入并往返 ────────────────────────────────────────────
    var src = new CityStateRow
    {
        Round = 1, Id = "3_3_0", Type = "town", Q = 3, R = 3,
        Pop = 1234, PopF = 1234.5, Tier = 2, State = 0,
        Stock = stockJson, Built = builtJson,
        BornTick = 7, Age = 100, FoodDebt = 12.5, PopBase = 1000,
        BasePopF = 1000.25, BaseAge = 99, BuiltFrac = 0, Kf = 1200, Ver = 5, LastEvoTick = 81000,
    };
    using (var s1 = new CityStateStore(db)) s1.Put(src);

    using var s2 = new CityStateStore(db);
    var got = s2.Get(1, "3_3_0");
    Ok("1 读到同一行", got is not null);
    if (got is not null)
    {
        Ok("2 Type 往返", got.Type == "town", $"'{got.Type}'");
        Ok("3 Q/R", got.Q == 3 && got.R == 3, $"{got.Q},{got.R}");
        Ok("4 Pop/PopF", got.Pop == 1234 && Math.Abs(got.PopF - 1234.5) < 1e-9, $"{got.Pop}/{got.PopF}");
        Ok("5 Stock 往返（值为 0 的资源省略，语义等价）", SameStock(got.Stock, stockJson), $"\n     want {stockJson}\n     got  {got.Stock}");
        Ok("6 Built 往返", got.Built == builtJson, $"\n     want {builtJson}\n     got  {got.Built}");
        Ok("7 累加器 (Age/FoodDebt/BasePopF/Kf)",
            got.Age == 100 && Math.Abs(got.FoodDebt - 12.5) < 1e-9 && got.BasePopF == 1000.25 && Math.Abs(got.Kf - 1200) < 1e-9,
            $"{got.Age}/{got.FoodDebt}/{got.BasePopF}/{got.Kf}");
        Ok("8 Ver/LastEvoTick", got.Ver == 5 && got.LastEvoTick == 81000, $"{got.Ver}/{got.LastEvoTick}");
    }

    // ── 2. 磁盘体积（同一份数据 JSON vs 新编码） ─────────────────
    long rawBytes = 0, newBytes = 0;
    using (var c = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={db}"))
    {
        c.Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT length(Built), R0+R1+R2+R3+R4+R5+R6+R7, TypeCode FROM CityState WHERE Id='3_3_0';";
        using var r = cmd.ExecuteReader();
        if (r.Read()) newBytes = r.GetInt64(0);
    }
    rawBytes = Encoding.UTF8.GetByteCount(builtJson);
    Ok("9 Built 编码后比 JSON 小", newBytes > 0 && newBytes < rawBytes, $"json={rawBytes}B blob={newBytes}B");

    // ── 3. 空值形态 ──────────────────────────────────────────────
    var empty = new CityStateRow { Round = 1, Id = "4_4_0", Type = "village", Stock = "{}", Built = "[]", Pop = 30, PopF = 30, Tier = 1, PopBase = 30 };
    s2.Put(empty);
    var e2 = s2.Get(1, "4_4_0");
    Ok("10 空 Stock 读回仍是 {}", e2?.Stock == "{}", e2?.Stock ?? "null");
    Ok("11 空 Built 读回仍是 []", e2?.Built == "[]", e2?.Built ?? "null");
    Ok("12 不同 Type 共存在同一字典", e2?.Type == "village", e2?.Type ?? "null");

    // ── 4. 未知资源键必须抛（防静默丢数据） ──────────────────────
    var thrown = false;
    try
    {
        s2.Put(new CityStateRow { Round = 1, Id = "5_5_0", Type = "town", Stock = "{\"粮\":1,\"未知\":9}", Built = "[]", Pop = 1, PopF = 1, Tier = 1 });
    }
    catch (InvalidDataException) { thrown = true; }
    Ok("13 未知资源键抛异常（不静默丢）", thrown);

    // ── 5. Built 结构不符 ⇒ 原样退回 JSON ────────────────────────
    var weird = "[{\"q\":1,\"r\":2,\"kind\":\"药圃\",\"terrain\":\"林地\",\"tier\":1,\"lv\":3,\"evo\":1,\"extra\":9}]";
    s2.Put(new CityStateRow { Round = 1, Id = "6_6_0", Type = "town", Stock = "{}", Built = weird, Pop = 5, PopF = 5, Tier = 1 });
    var w = s2.Get(1, "6_6_0");
    Ok("14 Built 多余字段 ⇒ 原样往返", w?.Built == weird, w?.Built ?? "null");

    // ── 6. 字典没有膨胀 ──────────────────────────────────────────
    using var c2 = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={db}");
    c2.Open();
    using var cmd2 = c2.CreateCommand();
    cmd2.CommandText = "SELECT COUNT(*) FROM CityDict;";
    var dictRows = Convert.ToInt32(cmd2.ExecuteScalar());
    Ok("15 字典只在首次新增（2 type + 2 build + 2 terrain ≤ 8）", dictRows is > 0 and <= 8, $"rows={dictRows}");

    // ── 7. 行数 ─────────────────────────────────────────────────
    Ok("16 三行都在", s2.CountRound(1) == 4, $"count={s2.CountRound(1)}");
}
catch (Exception ex)
{
    fail++;
    Console.WriteLine("FAIL 未捕获异常 :: " + ex);
}

Console.WriteLine($"\n合计 PASS={pass} FAIL={fail}");
foreach (var f in new[] { db, db + "-wal", db + "-shm" })
    try { if (File.Exists(f)) File.Delete(f); } catch { }
return fail == 0 ? 0 : 1;
