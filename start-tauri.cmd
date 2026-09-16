@echo off
REM Datara Studio, desktop edition.
REM
REM Runs the Tauri shell, which is only the window: it starts the Datara servers
REM itself, waits for one to answer, and opens the window at it. Nothing needs
REM to be started first.
REM
REM Why this file exists at all: the shell needs the release binary to have been
REM built, and "the exe is missing" is the one failure a double-click cannot
REM explain. So it checks, and builds if it has to.

setlocal
cd /d "%~dp0"

set "EXE=src-tauri\target\release\datara-studio.exe"

if not exist "%EXE%" (
  echo.
  echo   The desktop shell has not been built yet.
  echo   Building it now - this takes a few minutes the first time.
  echo.
  call "%~dp0scripts\build-desktop.cmd"
  if errorlevel 1 (
    echo.
    echo   Build failed. Run scripts\build-desktop.cmd by hand to see why.
    pause
    exit /b 1
  )
)

if not exist "ui\studio.html" (
  echo   ui\studio.html is missing - building it ...
  node scripts\build-ui.mjs
  if errorlevel 1 (
    echo   Could not build the interface. Run: node scripts\build-ui.mjs
    pause
    exit /b 1
  )
)

start "" "%EXE%"
exit /b 0
