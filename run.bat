@echo off
REM ===========================================================================
REM  Set SkySwitch domain external call paths (call_limit_ext) - Windows launcher
REM  Just double-click this file. It runs the tool in a console window.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or it is not on your PATH.
  echo.
  echo   Please install the LTS version ^(v18 or newer^) from:
  echo       https://nodejs.org
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

node set-domain-call-limits-standalone.js

echo.
echo   Done. You can close this window.
pause
endlocal
