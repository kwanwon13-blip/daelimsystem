@echo off
setlocal DisableDelayedExpansion
chcp 949 >nul
title Price Server Proxy Watchdog

REM Use pushd to handle paths with special chars (!!!, &, etc.)
pushd "%~dp0"
if errorlevel 1 (
    echo [FAIL] Could not change directory to %~dp0
    pause
    exit /b 1
)

REM ── Salary proxy config (MUST match admin PC daemon) ──
set "SALARY_MODE=proxy"
set "SALARY_DAEMON_SECRET=f955c734a410cda688a5f694b3c83137da6c9bd501a587093c15da2e9a725ae0"
set "SALARY_DAEMON_URL=http://192.168.0.30:3002"
set "SALARY_SOURCE_IP=192.168.0.30"
set "SALARY_DAEMON_TIMEOUT=15000"

echo.
echo ============================================
echo   Price Server - Proxy Mode Watchdog
echo   Dir: %CD%
echo   Salary: %SALARY_MODE% (%SALARY_DAEMON_URL%)
echo ============================================
echo.

:loop
if exist server-stop.flag (
    del server-stop.flag
    echo.
    echo Stop flag detected. Exiting watchdog.
    timeout /t 2 >nul
    popd
    exit /b 0
)

echo [%date% %time%] Starting server.js (proxy mode) ...
echo.

node server.js

echo.
echo --------------------------------------------
echo Server exited (code: %errorlevel%). Restart in 3 sec...
echo --------------------------------------------
timeout /t 3 >nul
goto loop
