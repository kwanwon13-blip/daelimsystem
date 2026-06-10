@echo off
rem ============================================================
rem  ERP Cloudflare Quick Tunnel (run on SERVER PC, ERP port 3000)
rem  - downloads cloudflared.exe on first run
rem  - registers the public URL into ERP workflow settings
rem  - watchdog loop: restarts tunnel if it dies
rem  admin password: create tunnel-env.bat next to this file with
rem     set ERP_ADMIN_ID=admin
rem     set ERP_ADMIN_PW=your-real-password
rem  (tunnel-env.bat is gitignored - never committed)
rem ============================================================
cd /d %~dp0

if exist tunnel-env.bat call tunnel-env.bat
if "%ERP_BASE%"=="" set ERP_BASE=http://127.0.0.1:3000

if not exist cloudflared.exe (
  echo [setup] downloading cloudflared.exe ...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  if errorlevel 1 (
    echo [setup] download failed. check internet and retry.
    pause
    exit /b 1
  )
)

:loop
node "%~dp0tunnel-quick.js"
echo [watchdog] tunnel stopped. restarting in 5 seconds... press Ctrl+C to quit.
timeout /t 5 /nobreak >nul
goto loop
