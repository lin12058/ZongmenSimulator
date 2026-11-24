@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  宗门模拟器 · 山河图  一键启动
rem    start.bat            编译并启动服务端，自动打开浏览器
rem    start.bat -n         启动但不打开浏览器
rem    start.bat stop       停止占用 8140 端口的服务端进程
rem  端口/持久化等配置见 Server\Zongmen\appsettings.json
rem ============================================================

set "PROJ=Server\Zongmen\Zongmen.csproj"
set "PORT=8140"
set "URL=http://127.0.0.1:%PORT%/"

rem ---------- 停止模式 ----------
if /i "%~1"=="stop" (
  netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
  if errorlevel 1 (
    echo [提示] 端口 %PORT% 未在监听，服务端没有在运行。
  ) else (
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
      echo [停止] 结束进程 PID %%p
      taskkill /PID %%p /T /F >nul 2>nul
    )
  )
  exit /b 0
)

rem ---------- 依赖检查 ----------
where dotnet >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 dotnet 命令。
  echo        请安装 .NET 8 SDK: https://dotnet.microsoft.com/download
  pause
  exit /b 1
)

rem ---------- 已运行则直接开浏览器 ----------
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 已在监听，服务端应该已经在运行。
  echo        如需重启请先执行: start.bat stop
  start "" "%URL%"
  exit /b 0
)

rem ---------- 后台延时打开浏览器（编译需要时间） ----------
if /i not "%~1"=="-n" start /b cmd /c "timeout /t 12 >nul & start %URL%"

echo ======================================================
echo   宗门模拟器 · 山河图
echo   正在编译并启动服务端（首次约 10-30 秒）...
echo   地址: %URL%
echo   停止: 本窗口按 Ctrl+C ，或另开窗口执行 start.bat stop
echo ======================================================
echo.

dotnet run --project "%PROJ%"

echo.
echo [服务端已退出] 退出码 %errorlevel%
pause
