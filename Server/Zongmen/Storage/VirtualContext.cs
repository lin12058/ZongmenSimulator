namespace Zongmen.Storage;

/* ============================================================
 * 存储层 — VirtualContext 抽象 (参考文档: 可插拔 KV)
 *   Sqlite / Memory 两种实现; 业务只面向抽象读写。
 * ============================================================ */

public abstract class VirtualContext : IDisposable
{
    public abstract byte[]? GetDataBytes(string key);
    public abstract void SetData(string key, byte[]? value);
    public abstract void DeleteByKey(string key);
    public abstract long Count();
    public abstract void Dispose();
}
