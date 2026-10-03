@echo off
setlocal DisableDelayedExpansion
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
set "SETUP_EXIT=%errorlevel%"
if /i "%~1"=="--no-pause" exit /b %SETUP_EXIT%
echo.
pause
exit /b %SETUP_EXIT%
