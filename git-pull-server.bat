@echo off
echo ========================================
echo  Server Git Pull Setup
echo ========================================
echo.

echo [1/4] Setting Git config...
git config --global --add safe.directory * >nul 2>&1
git config --global user.name "kwanwon13" >nul 2>&1
git config --global user.email "kwanwon13@gmail.com" >nul 2>&1
echo        OK

echo [2/4] Finding project folder...
pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Cannot access project folder.
    pause
    exit /b 1
)
echo        Folder: %CD%

echo [3/4] Setting up Git remote...
if not exist ".git" git init >nul 2>&1
git remote remove origin >nul 2>&1
git remote add origin https://github.com/kwanwon13-blip/daelimsystem.git
git fetch origin >nul 2>&1
echo        OK

echo [4/4] Pulling latest code from GitHub...
git reset --hard origin/main
if errorlevel 1 (
    echo [ERROR] Git pull failed.
    popd
    pause
    exit /b 1
)

popd

echo.
echo [5/5] Restarting server...
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 >nul
wscript.exe "D:\price-list-app\start-server.vbs"
timeout /t 3 >nul
echo        Server restarted!

echo.
echo ========================================
echo  DONE! Server updated and restarted.
echo  URL: http://192.168.0.133:3000
echo ========================================
echo.
pause
