@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title SAKURA TREE ENGINE
cd /d "%~dp0"

set "PORTS=5173 4173 5188"

reg query HKCU\Console /v VirtualTerminalLevel >nul 2>&1
if errorlevel 1 reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1
for /f %%A in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%A"

set "R=%ESC%[0m"
set "B=%ESC%[1m"
set "D=%ESC%[2m"
set "PK=%ESC%[38;2;255;183;197m"
set "PM=%ESC%[38;2;255;105;140m"
set "BR=%ESC%[38;2;90;60;55m"
set "GN=%ESC%[38;2;120;160;100m"
set "SK=%ESC%[38;2;200;185;195m"
set "WH=%ESC%[38;2;245;235;238m"
set "YL=%ESC%[38;2;255;220;160m"
set "RD=%ESC%[38;2;220;80;90m"
set "OK=%ESC%[38;2;130;200;140m"

call :kill_zombies quiet

:banner
cls
echo.
echo %PK%          .  .  *  .  .  *  .  .%R%
echo %PM%     +------------------------------------------+%R%
echo %PM%     :  %WH%%B%S A K U R A   T R E E   E N G I N E%R%%PM%  :%R%
echo %PM%     :  %D%%SK%procedural - SI metres - Three.js%R%%PM%     :%R%
echo %PM%     +------------------------------------------+%R%
echo.
echo %BR%                    \^|/%R%
echo %BR%                   --+--%R%
echo %BR%                  //^| ^|\\%R%
echo %PK%              .,'%BR% //%R%%PK%*%BR%  \\%R%%PK% ',.%R%
echo %PK%            ,'  %BR%///%R% %PK%* *%R% %BR%\\\ %R%%PK% ',%R%
echo %PK%           .   %BR%////%R%%PK%*  * *%R%%BR%\\\\%R%%PK%   .%R%
echo %PK%            ',. %BR%III%R% %PK%*  *%R% %BR%III%R%%PK% .,'%R%
echo %BR%                 IIIII%R%
echo %BR%                 IIIII%R%
echo %GN%            ~~~~%BR%IIIII%GN%~~~~%R%
echo %GN%         ~~~~~~~%BR%III%GN%~~~~~~~~%R%
echo %D%%SK%        ------------------------------------%R%
echo %D%%SK%         1u = 1m  -  H=9.0m  -  crown D=8m%R%
echo.

set "NODE_OK=0"
set "DEPS_OK=0"
where node >nul 2>&1 && set "NODE_OK=1"
if exist "node_modules\three\package.json" set "DEPS_OK=1"

if "!NODE_OK!"=="1" (
  for /f "tokens=*" %%V in ('node -v 2^>nul') do set "NODE_VER=%%V"
  echo %OK%  * node !NODE_VER!%R%   %D%ready%R%
) else (
  echo %RD%  * node missing%R%   %D%install Node.js 20+%R%
)
if "!DEPS_OK!"=="1" (
  echo %OK%  * dependencies%R%  %D%node_modules present%R%
) else (
  echo %YL%  * dependencies%R%  %D%run [I] install%R%
)
call :port_status
echo.

:menu
echo %PM%  +-- COMMANDS ---------------------------------+%R%
echo %PM%  :  %WH%[1]%R%  Launch dev server     %D%npm run dev%R%     %PM%:%R%
echo %PM%  :  %WH%[2]%R%  Production build      %D%npm run build%R%   %PM%:%R%
echo %PM%  :  %WH%[3]%R%  Preview build         %D%npm run preview%R% %PM%:%R%
echo %PM%  :  %WH%[4]%R%  Playwright QC         %D%npm run test:qc%R% %PM%:%R%
echo %PM%  :  %WH%[5]%R%  QC headed             %D%test:qc:headed%R%  %PM%:%R%
echo %PM%  :  %WH%[I]%R%  Install dependencies  %D%npm install%R%     %PM%:%R%
echo %PM%  :  %WH%[B]%R%  Budget estimate       %D%triangle audit%R%  %PM%:%R%
echo %PM%  :  %WH%[O]%R%  Open in browser       %D%localhost:5173%R%  %PM%:%R%
echo %PM%  :  %WH%[Z]%R%  Kill zombie ports     %D%:5173 :4173 :5188%R% %PM%:%R%
echo %PM%  :  %WH%[R]%R%  Refresh TUI%R%                            %PM%:%R%
echo %PM%  :  %WH%[Q]%R%  Quit%R%                                   %PM%:%R%
echo %PM%  +----------------------------------------------+%R%
echo.
set /p "CHOICE=  select: "

if /i "!CHOICE!"=="1" goto run_dev
if /i "!CHOICE!"=="2" goto run_build
if /i "!CHOICE!"=="3" goto run_preview
if /i "!CHOICE!"=="4" goto run_qc
if /i "!CHOICE!"=="5" goto run_qc_headed
if /i "!CHOICE!"=="I" goto run_install
if /i "!CHOICE!"=="B" goto run_budget
if /i "!CHOICE!"=="O" goto run_open
if /i "!CHOICE!"=="Z" goto run_zombies
if /i "!CHOICE!"=="R" goto banner
if /i "!CHOICE!"=="Q" goto bye
if /i "!CHOICE!"=="" goto menu

echo %RD%  unknown option:!CHOICE!%R%
timeout /t 1 >nul
goto banner

:kill_zombies
if /i "%~1"=="quiet" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_kill_zombies.ps1" -Quiet
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_kill_zombies.ps1"
)
exit /b 0

:port_status
set "BUSY="
for /f "delims=" %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_kill_zombies.ps1" -StatusOnly') do (
  if defined BUSY (set "BUSY=!BUSY! :%%P") else (set "BUSY=:%%P")
)
if defined BUSY (
  echo %YL%  * ports busy%R%      %D%!BUSY!  - press [Z] to kill%R%
) else (
  echo %OK%  * ports clear%R%     %D%:5173 :4173 :5188%R%
)
exit /b 0

:ensure_deps
if "!DEPS_OK!"=="1" exit /b 0
echo %YL%  deps missing - installing...%R%
call npm install
if errorlevel 1 (
  echo %RD%  npm install failed%R%
  pause
  exit /b 1
)
set "DEPS_OK=1"
exit /b 0

:run_zombies
echo.
echo %PK%  sweeping zombie listeners...%R%
call :kill_zombies
echo.
pause
goto banner

:run_dev
call :ensure_deps || goto banner
call :kill_zombies quiet
echo.
echo %PK%  Vite on %OK%http://localhost:5173%R%  %D%(Ctrl+C to stop)%R%
echo.
call npm run dev -- --host 127.0.0.1 --port 5173
echo.
pause
goto banner

:run_build
call :ensure_deps || goto banner
echo %PK%  building...%R%
call npm run build
if errorlevel 1 (echo %RD%  build failed%R%) else (echo %OK%  build ok - dist\%R%)
pause
goto banner

:run_preview
call :ensure_deps || goto banner
call :kill_zombies quiet
call npm run preview -- --host 127.0.0.1 --port 4173
pause
goto banner

:run_qc
call :ensure_deps || goto banner
call :kill_zombies quiet
call npm run test:qc
pause
goto banner

:run_qc_headed
call :ensure_deps || goto banner
call :kill_zombies quiet
call npm run test:qc:headed
pause
goto banner

:run_install
call npm install
if errorlevel 1 (echo %RD%  failed%R%) else (echo %OK%  dependencies ready%R% & set "DEPS_OK=1")
pause
goto banner

:run_budget
call :ensure_deps || goto banner
call npx --yes node --input-type=module -e "import { estimateSceneTris, formatBudget, PLAYABLE } from './src/budget.js'; const e=estimateSceneTris(PLAYABLE); console.log('  '+formatBudget(e)); console.log('  softOk='+e.softOk+'  hardOk='+e.hardOk);"
pause
goto banner

:run_open
start "" "http://127.0.0.1:5173/"
timeout /t 1 >nul
goto banner

:bye
echo.
echo %PK%  * until next blossom *%R%
endlocal
exit /b 0