using System.Text;
using Microsoft.ClearScript.V8;

namespace Zongmen.Engine;

/* ============================================================
 * 虚引擎层 — ClearScript V8 沙箱
 *   每个 seed 世界一个独立 V8 实例 (确定性世界状态/缓存互不干扰),
 *   LRU 淘汰; 实例内加载「原封不动」的 noise.js + mapgen.js 与
 *   适配层 mapgen-server.js (window = globalThis 注入)。
 * ============================================================ */

public sealed class JsWorldVm : IDisposable
{
    private readonly V8ScriptEngine _engine;
    private readonly SemaphoreSlim _gate = new(1, 1);
    public string Seed { get; }
    public long LastUsed { get; private set; }

    public JsWorldVm(string seed, string bundle)
    {
        Seed = seed;
        _engine = new V8ScriptEngine();
        _engine.Evaluate(bundle);
        Call("init", seed);       // MapGen.init(seed)
        Touch();
    }

    public void Touch() => LastUsed = DateTime.UtcNow.Ticks;

    /// <summary>线程安全: 串行执行 JS 函数并返回其 JSON 字符串结果。</summary>
    public string Call(string fn, params object[] args)
    {
        Touch();
        _gate.Wait();
        try
        {
            dynamic s = _engine.Script.MapGenServer;
            return fn switch
            {
                "init" => (string)s.init(args[0]),
                "chunkJson" => (string)s.chunkJson(args[0], args[1]),
                "regionJson" => (string)s.regionJson(args[0], args[1]),
                "commJson" => (string)s.commJson(args[0], args[1]),
                "tileJson" => (string)s.tileJson(args[0], args[1]),
                "fieldGridJson" => (string)s.fieldGridJson(args[0], args[1], args[2], args[3]),
                "metaJson" => (string)s.metaJson(),
                "_countVeins" => (string)s._countVeins(),
                _ => throw new InvalidOperationException($"未知 JS 函数: {fn}")
            };
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _engine.Dispose();
}

public sealed class JsEngineHost : IDisposable
{
    private readonly object _lock = new();
    private readonly Dictionary<string, JsWorldVm> _vms = new();
    private readonly int _maxSeeds;
    private readonly string _bundle;

    public JsEngineHost(string jsDir, int maxSeeds)
    {
        _maxSeeds = maxSeeds;
        var sb = new StringBuilder();
        sb.AppendLine("'use strict';");
        sb.AppendLine("var window = globalThis; var global = window; var self = window;");
        foreach (var f in new[] { "noise.js", "mapgen.js", "mapgen-server.js" })
        {
            var p = Path.Combine(jsDir, f);
            if (!File.Exists(p)) throw new FileNotFoundException($"缺少世界脚本: {p}");
            sb.AppendLine($"/* ==== {f} ==== */");
            sb.AppendLine(File.ReadAllText(p, Encoding.UTF8));
        }
        _bundle = sb.ToString();
    }

    public JsWorldVm GetOrCreate(string seed)
    {
        seed = seed.Length > 80 ? seed[..80] : seed;
        lock (_lock)
        {
            if (_vms.TryGetValue(seed, out var vm)) { vm.Touch(); return vm; }
            var created = new JsWorldVm(seed, _bundle);
            _vms[seed] = created;
            EvictLocked();
            return created;
        }
    }

    private void EvictLocked()
    {
        while (_vms.Count > _maxSeeds)
        {
            var oldest = _vms.OrderBy(kv => kv.Value.LastUsed).First();
            oldest.Value.Dispose();
            _vms.Remove(oldest.Key);
        }
    }

    public int LiveSeeds => _vms.Count;

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var vm in _vms.Values) vm.Dispose();
            _vms.Clear();
        }
    }
}
