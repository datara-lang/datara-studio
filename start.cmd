@echo off
REM Datara Studio launcher.
REM
REM Starts the studio and then watches it:
REM   * TWO Datara servers, on 127.0.0.1:7878 and 127.0.0.1:7879
REM   * the forgen_ai companion (suggestions, lint) on 127.0.0.1:7890, optional
REM   * the browser, opened at the interface
REM
REM Why two servers. The Datara runtime gives a socket no timeout and no
REM non-blocking mode, so one connection that connects and then sends nothing
REM blocks that server's single-threaded accept loop permanently - and browsers
REM open exactly such connections (preconnect, cancelled requests). The
REM interface tries 7878 first and falls back to 7879, so the IDE recovers on
REM its own instead of looking broken. See PORTING.md SEAM-6.
REM
REM The watchdog is not decoration either: it pings both ports and restarts the
REM pair only when NEITHER answers, because restarting on one slow response
REM would fight a server that is merely busy.

setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT_A=7878"
set "PORT_B=7879"
set "PORT_C=7880"
set "PORT_D=7881"
set "AIPORT=7890"

echo.
echo   Datara Studio
echo   -------------
echo.

where forgen >nul 2>&1
if errorlevel 1 (
  echo   forgen is not on PATH. Install the Datara toolchain, or add
  echo   C:\Users\%USERNAME%\AppData\Local\Programs\Datara\bin to PATH.
  echo.
  pause
  exit /b 1
)

if not exist "ui\studio.html" (
  echo   ui\studio.html is missing - building it ...
  node scripts\build-ui.mjs
  if errorlevel 1 (
    echo.
    echo   Could not build the interface. Run:  node scripts\build-ui.mjs
    pause
    exit /b 1
  )
)

REM the AI companion lives in the sibling project and is entirely optional
if exist "..\..\python\forgen_ai\ide_daemon.py" (
  echo   starting AI companion on 127.0.0.1:%AIPORT% ...
  call :hide "cmd /c cd /d ..\.. && python python\forgen_ai\ide_daemon.py --port %AIPORT%"
) else (
  echo   AI companion not found - the IDE runs without suggestions.
)

call :spawn

REM give the servers a moment to bind before the browser asks for the page
timeout /t 3 /nobreak >nul
start "" http://127.0.0.1:%PORT_A%

echo   watching - this window must stay open. Ctrl+C to stop.
echo.

:watch
timeout /t 4 /nobreak >nul
call :anyup
if errorlevel 1 (
  echo   [%TIME:~0,8%] no port answered - restarting the servers
  call :killports
  timeout /t 1 /nobreak >nul
  call :spawn
  echo   [%TIME:~0,8%] restarted
)
goto watch

REM A subroutine rather than a `for` with a `goto` inside it: jumping out of a
REM parenthesised block is a batch trap, and this is the same answer with none of
REM the ambiguity.
:anyup
for %%P in (%PORT_A% %PORT_B% %PORT_C% %PORT_D%) do (
  curl -s -m 3 -o nul "http://127.0.0.1:%%P/api/health" >nul 2>&1
  if not errorlevel 1 exit /b 0
)
exit /b 1

REM Kill whoever holds one of our ports. Not `taskkill /im forgen.exe`, which
REM would also kill a `forgen build` the user is running in another terminal -
REM the port owner is the only process we have any business ending.
:killports
for %%P in (%PORT_A% %PORT_B% %PORT_C% %PORT_D%) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr /r ":%%P .*LISTENING"') do (
    taskkill /f /pid %%I >nul 2>&1
  )
)
exit /b 0

:spawn
REM Both servers run with NO window at all. They used to be `start "title" cmd /c`
REM which opens two console windows on every launch - visible, flashing, and
REM sitting in the taskbar for as long as the IDE is open. See scripts\hidden.vbs.
call :hide "cmd /c set DATARA_STUDIO_PORT=%PORT_A% && forgen run src\main.dtr"
call :hide "cmd /c set DATARA_STUDIO_PORT=%PORT_B% && forgen run src\main.dtr"

REM If neither of the first two answers shortly, add a second pair. This covers
REM the one case the normal pair cannot: a server that was force-killed can leave
REM its listening socket registered, and Windows then keeps handing connections
REM to the dead socket. The port is bound but silent, so nothing answers there
REM and a new server on it would not fail - it would split the traffic with the
REM dead one. Starting on fresh ports instead is the only clean way out.
timeout /t 4 /nobreak >nul
curl -s -m 3 -o nul "http://127.0.0.1:%PORT_A%/api/health" >nul 2>&1
if not errorlevel 1 exit /b 0
curl -s -m 3 -o nul "http://127.0.0.1:%PORT_B%/api/health" >nul 2>&1
if not errorlevel 1 exit /b 0

echo   neither %PORT_A% nor %PORT_B% answered - trying %PORT_C% and %PORT_D%
call :hide "cmd /c set DATARA_STUDIO_PORT=%PORT_C% && forgen run src\main.dtr"
call :hide "cmd /c set DATARA_STUDIO_PORT=%PORT_D% && forgen run src\main.dtr"
exit /b 0

REM Launch a command with no window. Falls back to a minimised window if
REM wscript is unavailable, which is rare but is not worth failing over.
:hide
where wscript >nul 2>&1
if errorlevel 1 (
  start /min "datara-studio" %~1
) else (
  wscript //nologo //B "scripts\hidden.vbs" "%~1"
)
exit /b 0
