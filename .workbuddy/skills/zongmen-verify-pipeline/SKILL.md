---
name: zongmen-verify-pipeline
description: 宗门模拟器 demo3 的构建→启动后端→三层回归验证→headless 截图→清理停服完整管线。任何涉及 Server/Zongmen (C#) 或 web/ (前端 JS) 的代码改动后，按本流程验证。
---

# 宗门模拟器 · 验证管线

## 1. 编译
```bash
dotnet build Server/Zongmen/Zongmen.csproj -v q
```
- 必须指到 `.csproj`（给目录会报 MSB1009）。

## 2. 启动后端（仓库根执行）
```bash
./Server/Zongmen/bin/Debug/net8.0/Zongmen.exe > verify/server_run.log 2>&1   # run_in_background
```
- 端口 8140（appsettings.json "Zongmen.Port"）。
- 探活：`curl -s --noproxy "*" http://127.0.0.1:8140/api/map/stats`
- **本机 curl 必须 `--noproxy "*"`**，否则环境代理报 upstream connect failed 误判服务死。
- 改过 `Server/Zongmen/Engine/js/*.js` 后必须重启后端才生效（bundle 在 VM 构造时读取）。

## 3. 三层验证
```bash
node verify/verify_map.mjs        # 310 项契约: Node 加载同份 Engine/js 作参考 + HTTP 走真实 protobuf+gzip 链路
node verify/frontend_smoke.mjs    # 前端数据流模拟 + 几何往返
node --check web/js/*.js          # 前端语法
```
- 全绿标准：`结果: 全部通过 ✔`，退出码 0。

## 4. 专项 sanity（改缓存/并发相关时）
- 字节一致性：同 URL 请求两次比 md5（`_regionHot`/tile 缓存命中路径）。
- 并发：`seq 1 12 | xargs -P 12 -I{} sh -c 'curl ... 同 key chunk+region+tile'` 全 200 无死锁（验 `_buildGates` 门闩）。
- 落库行为：全新 seed 请求后查库
  `"C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe" -c "import sqlite3; c=sqlite3.connect('file:db/zongmen.sqlite?mode=ro', uri=True); ..."`
  （只读模式 `?mode=ro`）。当前语义：region 不落库（T2），chunk/comm 落库。

## 5. headless 渲染回归
```bash
"~/AppData/Local/Google/Chrome/Application/chrome.exe" --headless=new \
  --user-data-dir="$TEMP/zmen_capture_profile" --virtual-time-budget=25000 \
  --window-size=1280,800 "http://127.0.0.1:8140/?capture=1&nofade=1&seed=20260909"
```
- `?capture=1` 页面 4s 后自合成 glcanvas+overlay → POST /api/debug/snap → `verify/capture.png`，Read 查看。
- Chrome 在用户 AppData 下（不在 Program Files）；agent-browser screenshot 在本机 SIGTERM 失效，勿用。

## 6. 停服与确认
```bash
# 停: 按进程名 (比按端口稳)
Get-Process -Name Zongmen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
# 确认: netstat + tasklist 双确认, 勿用 Get-NetTCPConnection (本机输出不稳定, 监听存在时也可能返回空)
netstat -ano | grep ":8140" | grep LISTEN || echo "无监听"
tasklist | grep -i zongmen || echo "无进程"
```
- 用户惯例：服务由用户手动启动，验证完必须停干净。
- run_in_background 起的进程被外部终止时日志特征=戛然而止无异常。

## 7. 提交惯例
- 本仓库每轮审核修复单独提交，中文标题 + 逐条 bullet（编号 + 一句话说明 + 验证结论），review 文档状态回填随代码同 commit（参考 B1~B3/P1~P8、R1~R13、T0~T15 三轮）。
