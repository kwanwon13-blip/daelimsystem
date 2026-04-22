@echo off
chcp 949 >nul
echo ============================================
echo   Price Server (PROXY MODE)
echo   Use on Server PC (192.168.0.133)
echo ============================================
echo.

cd /d "%~dp0"

REM ── Salary proxy config (MUST match admin PC daemon) ──
set SALARY_MODE=proxy
set SALARY_DAEMON_SECRET=f955c734a410cda688a5f694b3c83137da6c9bd501a587093c15da2e9a725ae0
set SALARY_DAEMON_URL=http://192.168.0.30:3002
set SALARY_SOURCE_IP=192.168.0.30
set SALARY_DAEMON_TIMEOUT=15000

echo Salary mode:    %SALARY_MODE%
echo Daemon target:  %SALARY_DAEMON_URL%
echo Allowed PC IP:  %SALARY_SOURCE_IP%
echo.
echo Starting main server on port 3000 ...
echo.
node server.js

echo.
echo Server stopped.
pause
