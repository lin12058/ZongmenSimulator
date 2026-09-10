using System.Net.WebSockets;
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

    public static void Map(WebApplication app, MapWorldService svc)
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

            var resp = svc.GetTileBlock(req.Seed, req.I, req.J, allowedMask,
                                        req.LastRevs.Count > 0 ? req.LastRevs : null);
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
    }
}
