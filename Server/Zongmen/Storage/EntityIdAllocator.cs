using Microsoft.Data.Sqlite;

namespace Zongmen.Storage;

/* ============================================================
 * 实体 id 分配器 —— **全局 int32 号空间**（方案：全局 id 版）
 * ------------------------------------------------------------
 * 职责只有一个：**发号**。不认实体、不认分类、不碰世界内容。
 *
 * ★ 号空间语义
 *   · 合法区间 = [1, int.MaxValue]；0 保留为「无实体」。
 *   · 号**全局唯一**，跨世不重置（换世不给新世重新发 1 号 —— 上一世的事件/资产
 *     里还留着老号，重置即串味）。
 *   · 分类（<see cref="EntityKind"/>）**不进号**，独立存。理由：号段编码（高 8 位放分类）
 *     会把每类上限压到 1677 万，弟子/物品量级会撞顶；而分类在内存态可用
 *     <see cref="EntityRef"/> 打包成一个 long（8 字节，比 string 引用 + 对象头省）。
 *
 * ★ 分配策略（用户口径）
 *   ① 空闲池非空 ⇒ 取**最小**号（最小堆，天然保序）
 *   ② 池空且未到认领上界 ⇒ `_highWater + 1`
 *   ③ 池空且已到认领上界 ⇒ 向库**认领**一块（默认 1024）再发
 *
 * ★ 落库：只存**认领上界**（high-water mark），一行
 * ```sql
 * CREATE TABLE EntityIdSeq (Id INTEGER PRIMARY KEY CHECK(Id=1),
 *                           HighWater INTEGER NOT NULL, UpdatedAt INTEGER NOT NULL);
 * ```
 *   · 为什么必须落库：`_highWater` 是**运行时状态**，不是 seed 派生量，
 *     重启后推不出来（已发出的号没有别处记录）。
 *   · 为什么独立成表：`PruneExcept` 只清 `Data` 表的非活跃 seed 前缀，
 *     塞 `Data(Key,Value)` 里会被**静默删掉**（与 WorldLedger / TickJob 同理）。
 *   · 为什么存「认领上界」而不是「已发出上界」：一次 UPDATE 认 1024 个号，
 *     分配路径就完全不碰数据库（否则每个实体一次事务，WAL 直接打爆）。
 *
 * ⚠⚠ 四条会**静默出错**的红线（都不是异常，只是数据错）
 *   1. **重启必须先 ScanExisting**。构造时 `_highWater = 0`，不扫描就从头发号，
 *      与库里活着的实体撞号 —— 两个实体共用一个号，事件/资产全串。
 *      未扫描时 Alloc 会抛（`_scanned` 闸），这是刻意设计的：宁可启动失败，
 *      也不要带着错号跑起来。
 *   2. **空洞回收必须传全集**。「1..max 里不在 inUse 的就入池」这件事成立的前提是
 *      `inUse` = **所有引用该号空间的表的并集**。现在有 4 张表引用实体 id
 *      （CityState / TickJob / PlayerSect / RecruitPool），加事件表就是 5 张。
 *      漏一张 ⇒ 活着的 id 被当空闲发出去 ⇒ 两个实体共用一号。
 *   3. **`_highWater` 只增不减**。删实体**绝不**让 max 回退：回退后新实体拿到刚删的号，
 *      而它的历史事件（若还留在事件表里）会立刻挂到新实体身上。
 *   4. **崩溃只浪费、不重号**。已经认领但没发出的号（最多 `block-1` 个）重启后照常从
 *      认领上界之后继续发；宁可浪费 1023 个号，也绝不复用。
 *
 * ⚠ 与 `Data` 表、`Chunk/Region/Settle` 包**完全无关**：那些按坐标存，
 *   本类发的号只服务「需要以实体为单位累积状态的表」。
 * ============================================================ */
public sealed class EntityIdAllocator : IDisposable
{
    /// <summary>最小合法号。0 保留为「无实体」。</summary>
    public const int MinId = 1;

    /// <summary>最大合法号（int32 上界）。</summary>
    public const int MaxId = int.MaxValue;

    /// <summary>
    /// 空洞回收的护栏：`_highWater` 超过这个数就**放弃回收**，只从尾部继续发。
    /// 理由：回收要遍历 1..highWater 建集合，千万级已要几秒 + 十几 MB；
    /// 号空间有 21 亿，浪费一批空洞远比比启动挂住强。
    /// </summary>
    public const int MaxReclaimHighWater = 10_000_000;

    private const string CsTemplate = "Data Source={0};Pooling=True";

    /// <summary>默认认领块大小：每 1024 次分配才写一次库。</summary>
    public const int DefaultReserveBlock = 1024;

    private readonly string? _cs;
    private readonly object _gate = new();

    /// <summary>空闲号最小堆 —— priority = 号本身，Dequeue 天然给最小。</summary>
    private readonly PriorityQueue<int, int> _free = new();

    /// <summary>池内判重。⚠ 缺了它重复 Free 会让同一个号在堆里出现两次 ⇒ 两个实体拿到同一号。</summary>
    private readonly HashSet<int> _freeSet = new();

    private readonly int _block;

    /// <summary>已**发出**的最大号。</summary>
    private int _highWater;

    /// <summary>已向库**认领**的上界（含）。`_reserved >= _highWater` 恒成立。</summary>
    private int _reserved;

    /// <summary>是否已扫描过存量 id。纯内存模式视为已扫描。</summary>
    private bool _scanned;

    private long _allocated;
    private long _reused;
    private long _freed;
    private long _reserveCalls;
    private long _reclaimSkipped;

    public EntityIdAllocator(string? dbPath, int reserveBlock = DefaultReserveBlock)
    {
        _block = Math.Clamp(reserveBlock, 1, 65_536);

        if (string.IsNullOrEmpty(dbPath))
        {
            /* 纯内存模式（判据 / 单测 / 未来的临时世界）：没有历史，从 1 起发即可。 */
            _scanned = true;
            return;
        }

        var dir = Path.GetDirectoryName(Path.GetFullPath(dbPath));
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        _cs = string.Format(CsTemplate, dbPath);

        using var c = Open();
        using (var cmd = c.CreateCommand())
        {
            cmd.CommandText = """
                CREATE TABLE IF NOT EXISTS EntityIdSeq (
                    Id        INTEGER PRIMARY KEY CHECK (Id = 1),
                    HighWater INTEGER NOT NULL DEFAULT 0,
                    UpdatedAt INTEGER NOT NULL DEFAULT 0
                );
                """;
            cmd.ExecuteNonQuery();
        }

        _reserved = ReadHighWater();
        /* ⚠ 全新库（_reserved == 0）⇒ 没有任何历史实体 ⇒ 可以直接发号，不必等扫描。
           非 0 ⇒ **必须**等 ScanExisting，否则 1.._reserved 里可能躺着活实体。 */
        if (_reserved == 0) _scanned = true;
    }

    public bool Persisted => _cs != null;

    /// <summary>已发出的最大号（不含尚未发出的认领区间）。</summary>
    public int HighWater { get { lock (_gate) return _highWater; } }

    /// <summary>已向库认领的上界。</summary>
    public int Reserved { get { lock (_gate) return _reserved; } }

    /// <summary>池内可用号数量（诊断；不要用它在循环里做判空 —— 有竞态）。</summary>
    public int FreeCount { get { lock (_gate) return _free.Count; } }

    // ══ 发号 ══════════════════════════════════════════════════════════

    /// <summary>
    /// 取一个号。池优先（最小号）→ 认领区间内递增 → 扩块。
    /// ⚠ 未扫描存量时抛 <see cref="InvalidOperationException"/>（见类头红线 1）。
    /// </summary>
    public int Alloc()
    {
        lock (_gate)
        {
            if (!_scanned)
                throw new InvalidOperationException(
                    "EntityIdAllocator 尚未扫描存量 id：直接发号会与库里活实体撞号。" +
                    "开机流程必须先调 ScanExisting(所有引用本号空间的表的 id 并集)。");

            if (_free.Count > 0)
            {
                var id = _free.Dequeue();
                _freeSet.Remove(id);
                Interlocked.Increment(ref _reused);
                return id;
            }

            if (_highWater < _reserved)
            {
                Interlocked.Increment(ref _allocated);
                return ++_highWater;
            }

            ReserveNextBlockUnchecked();
            Interlocked.Increment(ref _allocated);
            return ++_highWater;
        }
    }

    /// <summary>批量发号（一次持锁，够用且比循环快）。</summary>
    public int[] AllocRange(int n)
    {
        if (n <= 0) return Array.Empty<int>();
        var outArr = new int[n];
        lock (_gate)
        {
            if (!_scanned)
                throw new InvalidOperationException("EntityIdAllocator 尚未扫描存量 id。");
            for (var i = 0; i < n; i++)
            {
                if (_free.Count > 0)
                {
                    var id = _free.Dequeue();
                    _freeSet.Remove(id);
                    outArr[i] = id;
                    Interlocked.Increment(ref _reused);
                    continue;
                }
                if (_highWater >= _reserved) ReserveNextBlockUnchecked();
                outArr[i] = ++_highWater;
                Interlocked.Increment(ref _allocated);
            }
        }
        return outArr;
    }

    /// <summary>
    /// 回收一个号进池。**这是唯一的回收入口**。
    ///
    /// ⚠ 调用方必须先确认「这个号在所有引用它的表里都已彻底删除」（事件、资产、
    ///   幂等回放…）。本类只做号本身的合法性校验，看不到业务表。
    /// ⚠ 号 &gt; `_highWater`（从未发出）或重复回收 ⇒ 返回 false，不入池。
    /// </summary>
    public bool Free(int id)
    {
        lock (_gate)
        {
            if (id < MinId || id > _highWater) return false;
            if (!_freeSet.Add(id)) return false;          // 已在池
            _free.Enqueue(id, id);
            Interlocked.Increment(ref _freed);
            return true;
        }
    }

    /// <summary>批量回收，返回实际入池数量。</summary>
    public int FreeRange(IEnumerable<int> ids)
    {
        var n = 0;
        lock (_gate)
        {
            foreach (var id in ids)
            {
                if (id < MinId || id > _highWater) continue;
                if (!_freeSet.Add(id)) continue;
                _free.Enqueue(id, id);
                n++;
            }
        }
        if (n > 0) Interlocked.Add(ref _freed, n);
        return n;
    }

    // ══ 开机恢复 ══════════════════════════════════════════════════════

    /// <summary>
    /// 开机扫描：用**存量 id 全集**修正 `_highWater`，可选把空洞塞进空闲池。
    ///
    /// ⚠⚠ <paramref name="inUse"/> 必须是**所有引用本号空间的表的并集**
    ///   （CityState / TickJob / PlayerSect / RecruitPool / 事件表 …）。
    ///   漏一张 ⇒ 活 id 被当空闲发出 ⇒ 两个实体共用一个号（不报错，只是数据错乱）。
    ///
    /// ⚠ `reclaimHoles = false`（默认）时**不回收空洞**，只把 `_highWater` 往上修 ——
    ///   空心号留在黑洞里永不使用，但绝不会误伤活实体。确认 `inUse` 是全集后再传 true。
    ///
    /// ⚠ `_highWater` 只增不减：`max(内存现值, inUse 最大值)`，且把认领上界一起顶上去
    ///   （防「库被外部改小」之后发号重号）。
    /// </summary>
    public IdScanReport ScanExisting(IReadOnlyCollection<int> inUse, bool reclaimHoles = false)
    {
        lock (_gate)
        {
            var inSet = new HashSet<int>(Math.Max(16, inUse.Count));
            var maxInUse = 0;
            foreach (var id in inUse)
            {
                if (id < MinId) continue;
                inSet.Add(id);
                if (id > maxInUse) maxInUse = id;
            }

            var before = _highWater;
            if (maxInUse > _highWater) _highWater = maxInUse;

            /* 认领上界必须 >= 已用最大号：库被外部改小（或换了库文件）时不重号。 */
            if (_highWater > _reserved)
            {
                PersistHighWater(_highWater);
                _reserved = _highWater;
            }

            var reclaimed = 0;
            string? note = null;

            if (!reclaimHoles)
            {
                note = "未请求回收（reclaimHoles=false）";
            }
            else if (_highWater > MaxReclaimHighWater)
            {
                reclaimed = -1;
                Interlocked.Increment(ref _reclaimSkipped);
                note = $"highWater={_highWater} 超过 {MaxReclaimHighWater}，跳过空洞回收（只从尾部续发）";
            }
            else
            {
                for (var i = MinId; i <= _highWater; i++)
                {
                    if (inSet.Contains(i)) continue;
                    if (!_freeSet.Add(i)) continue;
                    _free.Enqueue(i, i);
                    reclaimed++;
                }
            }

            _scanned = true;
            return new IdScanReport(
                HighWater: _highWater,
                MaxInUse: maxInUse,
                InUseCount: inSet.Count,
                HolesReclaimed: reclaimed,
                Before: before,
                Note: note);
        }
    }

    /// <summary>
    /// 检测空洞（**只读，不入池**）—— 给运维/判据看「浪费了多少号」。
    /// ⚠ 千万级 highWater 下会遍历一次，别在热路径调。
    /// </summary>
    public int CountHoles(IReadOnlyCollection<int> inUse)
    {
        lock (_gate)
        {
            var inSet = new HashSet<int>(inUse);
            var holes = 0;
            for (var i = MinId; i <= _highWater; i++) if (!inSet.Contains(i)) holes++;
            return holes;
        }
    }

    // ══ 落库 ══════════════════════════════════════════════════════════

    private void ReserveNextBlockUnchecked()
    {
        var baseVal = Math.Max(_highWater, _reserved);
        var next = (long)baseVal + _block;
        if (next > MaxId)
            throw new InvalidOperationException(
                $"EntityIdAllocator 号空间耗尽（highWater={_highWater}, block={_block}, max={MaxId}）");

        PersistHighWater((int)next);
        _reserved = (int)next;
        Interlocked.Increment(ref _reserveCalls);
    }

    private int ReadHighWater()
    {
        if (_cs == null) return 0;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT HighWater FROM EntityIdSeq WHERE Id=1;";
        var v = cmd.ExecuteScalar();
        if (v is null || v is DBNull) return 0;
        var n = Convert.ToInt64(v);
        return n <= 0 ? 0 : n > MaxId ? MaxId : (int)n;
    }

    private void PersistHighWater(int value)
    {
        if (_cs == null) return;
        using var c = Open();
        using var cmd = c.CreateCommand();
        /* ⚠ 单行 UPSERT，且 WHERE 里带 `HighWater < $v`：
              **只允许往上写**。多进程/多次认领并发时，落后的一次不会把上界写小。 */
        cmd.CommandText = """
            INSERT INTO EntityIdSeq (Id, HighWater, UpdatedAt)
            VALUES (1, $v, $t)
            ON CONFLICT(Id) DO UPDATE SET
                HighWater = excluded.HighWater,
                UpdatedAt = excluded.UpdatedAt
            WHERE EntityIdSeq.HighWater < excluded.HighWater;
            """;
        cmd.Parameters.AddWithValue("$v", value);
        cmd.Parameters.AddWithValue("$t", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
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

    // ══ 观测 ══════════════════════════════════════════════════════════

    public IdAllocStats Stats()
    {
        lock (_gate)
        {
            return new IdAllocStats(
                HighWater: _highWater,
                Reserved: _reserved,
                FreeCount: _free.Count,
                Allocated: Interlocked.Read(ref _allocated),
                Reused: Interlocked.Read(ref _reused),
                Freed: Interlocked.Read(ref _freed),
                ReserveCalls: Interlocked.Read(ref _reserveCalls),
                ReclaimSkipped: Interlocked.Read(ref _reclaimSkipped),
                Scanned: _scanned);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _free.Clear();
            _freeSet.Clear();
        }
        if (_cs != null) SqliteConnection.ClearAllPools();
    }
}

/// <summary>实体分类。⚠ **不进号空间**，独立存（见 <see cref="EntityRef"/>）。</summary>
public enum EntityKind : byte
{
    /// <summary>无实体。号 0 专用。</summary>
    None = 0,

    /// <summary>聚落：城 / 镇 / 村 / 渔村 / 秘境 / 玩家宗门（引擎 id 形如 `{i}_{j}_{k}`）。</summary>
    Settle = 1,

    /// <summary>可招募弟子（引擎 id 形如 `srv-c-{hash8}`）。</summary>
    Disciple = 2,

    /// <summary>小队（前端 id 形如 `sq-{base}-{from}`）。</summary>
    Squad = 3,

    /// <summary>物品 / 装备（引擎 id 形如 `srv-c-{hash8}-weapon`）。</summary>
    Item = 4,

    /// <summary>
    /// 地图人口 NPC（引擎 id 形如 `c{17位大数}`）。
    /// ⚠ 纯派生、不落库 ⇒ 本类的号对它们只是**进程内句柄**，重启后必须重建，不可持久化。
    /// </summary>
    Character = 5,
}

/// <summary>
/// 内存态实体引用：`(分类, 号)` 打包成**一个 long**（8 字节）。
/// 比 `(string Id)` 省一个对象头 + 字符数组 + 一次哈希遍历。
/// ⚠ 只是运行时表示，**不落库**：落库仍存引擎的字符串 id（唯一直源）。
/// </summary>
public readonly record struct EntityRef(EntityKind Kind, int Id)
{
    public long Packed => ((long)(byte)Kind << 32) | (uint)Id;

    public static EntityRef Unpack(long v) => new((EntityKind)(byte)(v >> 32), (int)(v & 0xFFFFFFFF));

    public override string ToString() => $"{Kind}#{Id}";
}

/// <summary>分配器统计快照（/stats 与判据用）。</summary>
public readonly record struct IdAllocStats(
    int HighWater,
    int Reserved,
    int FreeCount,
    long Allocated,
    long Reused,
    long Freed,
    long ReserveCalls,
    long ReclaimSkipped,
    bool Scanned);

/// <summary>开机扫描结果。</summary>
/// <param name="HolesReclaimed">实际入池的空洞数；-1 = 因护栏跳过回收。</param>
/// <param name="Before">扫描前的 `_highWater`（用来验证「只增不减」）。</param>
public readonly record struct IdScanReport(
    int HighWater,
    int MaxInUse,
    int InUseCount,
    int HolesReclaimed,
    int Before,
    string? Note);
