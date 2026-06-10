@echo off
rem ============================================================
rem  Install Cloudflare Tunnel as a Windows SERVICE (run on SERVER PC)
rem  - runs in background, NO window, auto-starts on reboot
rem  - JUST DOUBLE-CLICK. it will auto-request admin (click YES on the popup).
rem  - after this, you can close the tunnel-start.bat window for good
rem  - to remove later:  cloudflared.exe service uninstall
rem ============================================================

rem --- self-elevate: if not admin, relaunch elevated (UAC popup) ---
net session >nul 2>&1
if errorlevel 1 (
  echo [admin] requesting administrator - click YES on the popup ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d %~dp0

if exist tunnel-env.bat call tunnel-env.bat
if "%TUNNEL_TOKEN%"=="" (
  echo [error] tunnel-env.bat missing or TUNNEL_TOKEN empty. Put tunnel-env.bat next to this file.
  pause
  exit /b 1
)

if not exist cloudflared.exe (
  echo [setup] downloading cloudflared.exe ...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  if errorlevel 1 (
    echo [setup] download failed. check internet and retry.
    pause
    exit /b 1
  )
)

echo [install] removing any existing cloudflared service ...
cloudflared.exe service uninstall >nul 2>&1

echo [install] installing cloudflared as a Windows service ...
cloudflared.exe service install %TUNNEL_TOKEN%
if errorlevel 1 (
  echo [install] failed. see message above.
  pause
  exit /b 1
)

echo.
echo [done] Tunnel now runs in the background and auto-starts on reboot.
echo        You can close the tunnel-start.bat window now.
echo        erp.daelimsm.com stays up without any window open.
echo.
echo To stop/remove later:  cloudflared.exe service uninstall
pause
