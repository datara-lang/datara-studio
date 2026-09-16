@echo off
setlocal
cd /d "%~dp0.."
set "PORT=%RYAN_HARNESS_UI_PORT%"
if "%PORT%"=="" set "PORT=8088"
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -m http.server "%PORT%" --bind 127.0.0.1 --directory ui
  exit /b %errorlevel%
)
where python >nul 2>&1
if not errorlevel 1 (
  python -m http.server "%PORT%" --bind 127.0.0.1 --directory ui
  exit /b %errorlevel%
)
echo Python 3 is required to serve the kernel UI.
exit /b 1
