@echo off
setlocal DisableDelayedExpansion
set "SETUP_NO_PAUSE=0"
set "SETUP_MODE="
:parse_args
if "%~1"=="" goto run_setup
if /i "%~1"=="--no-pause" goto no_pause
if /i "%~1"=="--editor-only" goto editor_only
echo Usage: setup.cmd [--no-pause] [--editor-only]
exit /b 2
:no_pause
set "SETUP_NO_PAUSE=1"
shift
goto parse_args
:editor_only
set "SETUP_MODE=-EditorOnly"
shift
goto parse_args
:run_setup
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1" %SETUP_MODE%
set "SETUP_EXIT=%errorlevel%"
if "%SETUP_NO_PAUSE%"=="1" exit /b %SETUP_EXIT%
echo.
pause
exit /b %SETUP_EXIT%
