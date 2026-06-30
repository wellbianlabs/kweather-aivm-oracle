@echo off
chcp 65001 >nul
setlocal
REM ===== KWeather x AIVM - one-click deploy =====
REM   1) push local commits to GitHub   2) pull + restart on the server   3) open the live site
set "REPO=C:\project\KWeather_AIVM_Oracle"
set "SERVER=hduser@220.95.232.202"
set "APPDIR=/opt/kweather-aivm-oracle"

echo(
echo ===========================================================
echo   KWeather x AIVM  -  Deploy to agent.kweather.co.kr
echo ===========================================================
echo(
echo [1/3] GitHub push (local repo)
git -C "%REPO%" push origin main
echo(
echo [2/3] Server deploy over SSH  (enter the server / sudo password when asked)
ssh -t %SERVER% "cd %APPDIR% && sudo git pull && sudo systemctl restart kweather-agent && echo ==== DEPLOY DONE ==== && systemctl is-active kweather-agent"
echo(
echo [3/3] Opening the live site...
start "" "https://agent.kweather.co.kr/agents"
echo(
echo Deploy finished. Review the messages above.
echo(
pause
endlocal
