using System.Net.WebSockets;
using System.Text;
using Zongmen.Domain;
using Zongmen.Protocol;
using Zongmen.Services;

namespace Zongmen.Web;

/* ============================================================
 * WebSocket 单块接口处理器 (设计 §3/§5)
 *   ws://…/ws/map — 二进制帧: [1 字节类型][protobuf 载荷]
 *     C→S: 1=LoginRequest  2=TileRequest  3=Ping
 *     S→C: 1=LoginResponse 2=TileResponse(gzip) 3=Pong
 *   纯请求/响应: 客户端切块才发, 服务器不主动推送 (设计 §1.4)。
 *   鉴权与数据解耦 (设计 §5): 未登录只能取 Chunk/Region,
 *   登录后才放行 Settle/Poi/Comm; demo 期任意非空账号密码即登录成功。
 * ============================================================ */

public static class MapWsHandler
{
    private const int MaxFrameBytes = 1 * 1024 * 1024;   // 请求上限 (TileRequest 很小, 防御性)

    /* R11: 可下发的引擎脚本白名单 + 拼接次序 —— 必须与服务端 bundle 一致
       (JsEngineHost: noise → mapgen-config → mapgen)。mapgen-server.js 是服务端
       适配层 (落库/JSON 出口), 浏览器侧不需要, 故不下发。 */
    private static readonly string[] EngineScriptOrder = ["noise.js", "mapgen-config.js", "mapgen.js"];

    public static void Map(WebApplication app, MapWorldService svc, string engineJsDir)
    {
        app.MapGet("/ws/map", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                await ctx.Response.WriteAsync("expected websocket upgrade");
                return;
            }

            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            var session = new WsSession();
            var recvBuf = new byte[MaxFrameBytes];

            try
            {
                while (ws.State == WebSocketState.Open && !ctx.RequestAborted.IsCancellationRequested)
                {
                    /* 读满一帧 (自动处理分片) */
                    var (count, isBinary, closed) = await ReceiveFullFrameAsync(ws, recvBuf, ctx.RequestAborted);
                    if (closed) break;
                    if (count <= 0 || !isBinary) continue;      // 空帧/文本帧忽略

                    byte type = recvBuf[0];
                    switch (type)
                    {
                        case WsFrame.Login:
                            await HandleLoginAsync(ws, session, recvBuf, count, ctx.RequestAborted);
                            break;

                        case WsFrame.Tile:
                            await HandleTileAsync(ws, svc, session, recvBuf, count, ctx.RequestAborted);
                            break;

                        case WsFrame.Ping:
                            await SendFrameAsync(ws, WsFrame.Pong, null, ctx.RequestAborted);
                            break;

                        case WsFrame.Script:
                            await HandleScriptAsync(ws, engineJsDir, recvBuf, count, ctx.RequestAborted);
                            break;

                        /* ---- 玩家宗门放置 (方案 §4.1) ---- */
                        case WsFrame.PlaceCheck:
                            await HandlePlaceCheckAsync(ws, svc, session, recvBuf, count, ctx.RequestAborted);
                            break;

                        case WsFrame.PlaceCommit:
                            await HandlePlaceCommitAsync(ws, svc, session, recvBuf, count, ctx.RequestAborted);
                            break;

                        default:
                            /* 未知类型: 忽略 (前向兼容) */
                            break;
                    }
                }
            }
            catch (OperationCanceledException) { /* 客户端断开: 正常退出读循环 */ }
            catch (WebSocketException) { /* 套接字异常: 视同断开 */ }
        });
    }

    private static async Task HandleLoginAsync(
        WebSocket ws, WsSession session, byte[] buf, int count, CancellationToken ct)
    {
        LoginRequest req;
        try
        {
            req = ProtoCodec.DesFromByte<LoginRequest>(buf.AsSpan(1, count - 1).ToArray());
        }
        catch
        {
            await SendFrameAsync(ws, WsFrame.Login,
                ProtoCodec.SerToByte(new LoginResponse { Ok = false, Err = "登录帧解析失败" }), ct);
            return;
        }

        /* demo 鉴权: 任意非空账号即通过; 接入账号体系时在此校验 token */
        if (string.IsNullOrWhiteSpace(req.Account))
        {
            await SendFrameAsync(ws, WsFrame.Login,
                ProtoCodec.SerToByte(new LoginResponse { Ok = false, Err = "账号不能为空" }), ct, gzip: false);
            return;
        }
        session.Account = req.Account.Trim();
        session.Authed = true;
        Console.WriteLine($"[ws/map] 登录 account={session.Account}");
        await SendFrameAsync(ws, WsFrame.Login,
            ProtoCodec.SerToByte(new LoginResponse { Ok = true, Account = session.Account }), ct, gzip: false);
    }

    private static async Task HandleTileAsync(
        WebSocket ws, MapWorldService svc, WsSession session, byte[] buf, int count, CancellationToken ct)
    {
        TileRequest req;
        try
        {
            req = ProtoCodec.DesFromByte<TileRequest>(buf.AsSpan(1, count - 1).ToArray());
        }
        catch (Exception ex)
        {
            await SendTileErrorAsync(ws, 0, 0, 0, reqSeq: 0, "TileRequest 解析失败: " + ex.Message, ct);
            return;
        }
        if (string.IsNullOrWhiteSpace(req.Seed))
        {
            await SendTileErrorAsync(ws, req.I, req.J, 0, req.Seq, "seed 不能为空", ct);
            return;
        }

        try
        {
            /* mask 归一 + 鉴权裁剪都提前到构建之前 (设计 §5):
               - 0 语义等同 All (协议约定);
               - 未登录: 从请求 mask 中剔除实体层, 使 GetTileBlock 根本不构建
                 settle/poi/comm (旧实现是「先全量构建再清空」, 白烧 V8 预算);
               - 被剔除的位记入 DeniedMask 回显, 且只针对本次真正请求的位
                 (避免「仅 rev 未变」被误报为 denied)。 */
            uint reqMask = req.Mask == 0 ? (uint)TileMask.All : req.Mask & (uint)TileMask.All;
            const uint entityMask = (uint)(TileMask.Settle | TileMask.Poi | TileMask.Comm);
            uint allowedMask = session.Authed ? reqMask : reqMask & ~entityMask;

            /* C6: 块构建是「全同步」管线 (V8 门闩 + A* + gzip), 直接内联 await 会占着
               ASP.NET 的请求线程池线程跑完 — 冷启/多 seed 并发时把池子吃干, 连
               非地图请求也被拖住。放到线程池单独执行, 并允许客户端断开时提前放弃等待
               (WaitAsync(ct): 不等同步体结束, 但也不去打断它 —— V8 调用本身无法取消)。 */
            var resp = await Task.Run(() => svc.GetTileBlock(req.Seed, req.I, req.J, allowedMask,
                                            req.LastRevs.Count > 0 ? req.LastRevs : null), ct)
                                   .WaitAsync(ct);
            resp.Seq = req.Seq;
            if (!session.Authed)
            {
                uint denied = reqMask & entityMask;
                if (denied != 0)
                {
                    resp.DeniedMask = denied;
                    resp.Err = "未登录: 聚落/景点/灵脉图层需要登录后获取";
                }
            }
            await SendFrameAsync(ws, WsFrame.Tile, ProtoCodec.SerToByte(resp), ct, gzip: true);
        }
        catch (OperationCanceledException)
        {
            /* 客户端已断开 (页面关闭/刷新): 发送被取消, 属正常断连, 不记日志 */
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[ws/map] TileRequest 处理异常: " + ex);
            try { await SendTileErrorAsync(ws, req.I, req.J, 0, req.Seq, "块构建失败: " + ex.Message, ct); }
            catch { /* 套接字已失效 */ }
        }
    }

    /// <summary>Tile 错误响应: 帧类型 2 恒 gzip, 与正常响应一致 (客户端按类型解压)。</summary>
    private static Task SendTileErrorAsync(
        WebSocket ws, int i, int j, uint mask, uint reqSeq, string err, CancellationToken ct)
    {
        var resp = new TileResponse { I = i, J = j, Mask = mask, Seq = reqSeq, Err = err };
        return SendFrameAsync(ws, WsFrame.Tile, ProtoCodec.SerToByte(resp), ct, gzip: true);
    }

    /* ---- R11: 引擎脚本下发 ----
       载荷 = ScriptPack{ Name, Source = gzip(js) }; 帧类型 4 自身不压缩 (源已是 gzip)。
       白名单外/不存在 → 回空 Source (客户端据此降级为「未探测」占位, 不抛异常)。
       Name 只做白名单匹配, 绝不用它拼路径 —— 杜绝目录穿越。 */
    private static async Task HandleScriptAsync(
        WebSocket ws, string jsDir, byte[] buf, int count, CancellationToken ct)
    {
        string want = "";
        try
        {
            if (count > 1)
                want = ProtoCodec.DesFromByte<ScriptRequest>(buf.AsSpan(1, count - 1).ToArray()).Name ?? "";
        }
        catch { /* 载荷损坏/为空: 按「要整包」处理 */ }

        string[] files = want.Length == 0
            ? EngineScriptOrder
            : Array.FindAll(EngineScriptOrder, f => string.Equals(f, want, StringComparison.OrdinalIgnoreCase));
        if (files.Length == 0)
        {
            await SendFrameAsync(ws, WsFrame.Script,
                ProtoCodec.SerToByte(new ScriptPack { Name = "denied" }), ct);
            return;
        }

        var sb = new StringBuilder();
        foreach (var f in files)
        {
            var p = Path.Combine(jsDir, f);
            if (!File.Exists(p))
            {
                Console.Error.WriteLine("[ws/map] ScriptRequest 缺少引擎脚本: " + p);
                await SendFrameAsync(ws, WsFrame.Script,
                    ProtoCodec.SerToByte(new ScriptPack { Name = "missing" }), ct);
                return;
            }
            sb.AppendLine("/* ==== " + f + " ==== */");
            sb.AppendLine(File.ReadAllText(p, Encoding.UTF8));
        }
        var src = Encoding.UTF8.GetBytes(sb.ToString());
        var pack = new ScriptPack { Name = "engine", Source = GZipCodec.Compress(src) };
        await SendFrameAsync(ws, WsFrame.Script, ProtoCodec.SerToByte(pack), ct);
    }

    /* ============================================================
     * 玩家宗门放置 (2026-09-23 方案 §4.1/§4.2)
     * ------------------------------------------------------------
     * 帧 5 = PlaceCheck (只读, 悬停即问); 帧 6 = PlaceCommit (写, 含同步重算 ~450ms)。
     * 载荷恒**明文** protobuf (与 Login/Pong 同口径, 不做按大小切换 —— 客户端按帧类型
     * 判别压缩, 混用会解错)。
     * ⚠ 限流必须在这里做: ApiRateLimitMiddleware 是 HTTP 中间件, 对 WS 帧**完全无效**。
     *   PlaceCheck 是悬停驱动的高频路径 (前端 ≥150ms 节流), 不设闸的话单条连接就能把
     *   V8 门闩钉死, 把整台服务拖住 (Chunk/Region 也走同一把门闩)。
     * ⚠ 两条载荷都必须先过「seed 非空 + 已登录」的粗筛, 再进 V8。
     * ============================================================ */

    /// <summary>悬停校验稳态速率 (次/秒) 与突发额度。</summary>
    private const double CheckRatePerSec = 8;
    private const double CheckBurst = 8;

    private static async Task HandlePlaceCheckAsync(
        WebSocket ws, MapWorldService svc, WsSession session, byte[] buf, int count, CancellationToken ct)
    {
        PlaceCheckRequest req;
        try
        {
            req = ProtoCodec.DesFromByte<PlaceCheckRequest>(buf.AsSpan(1, count - 1).ToArray());
        }
        catch (Exception ex)
        {
            await SendPlaceAsync(ws, WsFrame.PlaceCheck,
                new PlaceCheckResponse { Err = "PlaceCheck 解析失败: " + ex.Message }, ct);
            return;
        }
        if (!session.AllowCheck())
        {
            await SendPlaceAsync(ws, WsFrame.PlaceCheck,
                new PlaceCheckResponse { Q = req.Q, R = req.R, Seq = req.Seq, Err = "落点校验过于频繁" }, ct);
            return;
        }
        try
        {
            var resp = await Task.Run(() => svc.PlaceCheck(
                req.Seed, session.Account, session.Authed, req.Q, req.R, req.ExcludeId, req.Seq), ct)
                .WaitAsync(ct);
            await SendPlaceAsync(ws, WsFrame.PlaceCheck, resp, ct);
        }
        catch (OperationCanceledException) { /* 客户端断开 */ }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[ws/map] PlaceCheck 异常: " + ex);
            try
            {
                await SendPlaceAsync(ws, WsFrame.PlaceCheck,
                    new PlaceCheckResponse { Q = req.Q, R = req.R, Seq = req.Seq, Err = "落点校验失败: " + ex.Message }, ct);
            }
            catch { /* 套接字已失效 */ }
        }
    }

    private static async Task HandlePlaceCommitAsync(
        WebSocket ws, MapWorldService svc, WsSession session, byte[] buf, int count, CancellationToken ct)
    {
        PlaceCommitRequest req;
        try
        {
            req = ProtoCodec.DesFromByte<PlaceCommitRequest>(buf.AsSpan(1, count - 1).ToArray());
        }
        catch (Exception ex)
        {
            await SendPlaceAsync(ws, WsFrame.PlaceCommit,
                new PlaceCommitResponse { Err = "PlaceCommit 解析失败: " + ex.Message }, ct);
            return;
        }
        /* ⚠ 提交**不**在传输层限流 —— 传输层看到的是「同一请求重发」, 而幂等回放正是
           为这种重发设计的 (廉价、不碰 V8)。在这里设闸会把重放一起挡掉, 表现为
           「狂点确认键 → 第二下报频繁」。真正的闸在 MapWorldService.PlaceCommit 里,
           且只卡**贵的那条路** (回放与配额拒绝都不经它)。 */
        try
        {
            /* ⚠ 同步重算 ~450ms, 必须放线程池 + 允许断开时放弃等待 (同 Tile 的 C6 理由):
               直接内联 await 会占着请求线程池线程跑完整条 A* 流水线。 */
            var resp = await Task.Run(() => svc.PlaceCommit(
                req.Seed, session.Account, session.Authed, req.Q, req.R, req.Name, req.Tier, req.IdemKey, req.Seq), ct)
                .WaitAsync(ct);
            await SendPlaceAsync(ws, WsFrame.PlaceCommit, resp, ct);
            if (resp.Ok)
                Console.WriteLine($"[ws/map] 卜居 account={session.Account} at ({req.Q},{req.R}) " +
                                  $"id={resp.Sect?.Id} roads={resp.Roads} blocks={resp.Blocks.Count} ms={resp.Ms}");
        }
        catch (OperationCanceledException) { /* 客户端断开 */ }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[ws/map] PlaceCommit 异常: " + ex);
            try
            {
                await SendPlaceAsync(ws, WsFrame.PlaceCommit,
                    new PlaceCommitResponse { Seq = req.Seq, IdemKey = req.IdemKey, Err = "卜居失败: " + ex.Message }, ct);
            }
            catch { /* 套接字已失效 */ }
        }
    }

    /// <summary>放置帧的发送口 (恒明文; 与 Tile 的 gzip 约定区分开 = 客户端按帧类型判别)。</summary>
    private static Task SendPlaceAsync<T>(WebSocket ws, byte type, T msg, CancellationToken ct)
        => SendFrameAsync(ws, type, ProtoCodec.SerToByte(msg), ct, gzip: false);

    /* ---- 帧收发 ---- */
    private static async Task SendFrameAsync(
        WebSocket ws, byte type, byte[]? payload, CancellationToken ct, bool gzip = false)
    {
        /* 帧类型即压缩约定: TileResponse 恒 gzip (客户端按类型解压),
           Login/Pong 恒明文 — 不做按大小切换, 避免客户端无法判别。 */
        byte[] body = payload ?? [];
        if (gzip && body.Length > 0)
            body = GZipCodec.Compress(body);

        var frame = new byte[1 + body.Length];
        frame[0] = type;
        if (body.Length > 0) Buffer.BlockCopy(body, 0, frame, 1, body.Length);
        await ws.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Binary, true, ct);
    }

    /// <summary>读满一个完整帧 (处理分片)。返回 (字节数, 是否二进制, 是否已关闭)。</summary>
    private static async Task<(int Count, bool IsBinary, bool Closed)> ReceiveFullFrameAsync(
        WebSocket ws, byte[] buf, CancellationToken ct)
    {
        int total = 0;
        bool isBinary = true;
        while (true)
        {
            var seg = new ArraySegment<byte>(buf, total, buf.Length - total);
            var result = await ws.ReceiveAsync(seg, ct);
            if (result.MessageType == WebSocketMessageType.Close)
                return (total, false, true);
            if (result.MessageType == WebSocketMessageType.Text) isBinary = false;
            total += result.Count;
            if (total > buf.Length) return (total, isBinary, true);   // 超限防御
            if (result.EndOfMessage) return (total, isBinary, false);
            if (total >= buf.Length) return (total, isBinary, false); // 缓冲吃满仍未见分片尾: 按整帧处理
        }
    }

    private sealed class WsSession
    {
        public bool Authed { get; set; }
        public string Account { get; set; } = "";

        /* ---- 令牌桶 (WS 帧不走 HTTP 限流中间件, 见 HandlePlaceCheckAsync 头注释) ---- */
        private double _checkTokens = CheckBurst;
        private long _checkRefillAt;

        /// <summary>悬停校验令牌桶: 稳态 CheckRatePerSec 次/秒, 突发 CheckBurst 次。</summary>
        public bool AllowCheck()
        {
            var now = Environment.TickCount64;
            if (_checkRefillAt == 0) _checkRefillAt = now;
            var dt = (now - _checkRefillAt) / 1000.0;
            if (dt > 0)
            {
                _checkTokens = Math.Min(CheckBurst, _checkTokens + dt * CheckRatePerSec);
                _checkRefillAt = now;
            }
            if (_checkTokens < 1) return false;
            _checkTokens -= 1;
            return true;
        }
    }
}
