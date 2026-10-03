@echo off
setlocal DisableDelayedExpansion
set "NODE_EXE=%~dp0.runtime\node\node.exe"
if exist "%NODE_EXE%" goto local_node
set "NODE_EXE="
for /f "delims=" %%N in ('"%SystemRoot%\System32\where.exe" node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE goto missing_node
goto validate_node
:local_node
set "PATH=%~dp0.runtime\node;%PATH%"
:validate_node
"%NODE_EXE%" -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 goto missing_node
"%NODE_EXE%" "%~dp0server\index.mjs" %*
exit /b %errorlevel%
:missing_node
echo Node.js 22 or newer is required. Run setup.cmd to prepare or repair the project-local Node runtime.
exit /b 1
