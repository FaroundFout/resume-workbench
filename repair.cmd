@echo off
setlocal DisableDelayedExpansion
set "DOCTOR_NO_PAUSE=0"
:parse_args
if "%~1"=="" goto run_doctor
if /i "%~1"=="--no-pause" goto no_pause
echo Usage: repair.cmd [--no-pause]
exit /b 2
:no_pause
set "DOCTOR_NO_PAUSE=1"
shift
goto parse_args
:run_doctor
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-doctor-windows.ps1" -Mode prepare
set "DOCTOR_EXIT=%errorlevel%"
if "%DOCTOR_NO_PAUSE%"=="1" exit /b %DOCTOR_EXIT%
echo.
pause
exit /b %DOCTOR_EXIT%
