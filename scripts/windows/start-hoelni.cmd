@echo off
REM Hoelni Client Suite – start (supervised). Run from the repository root or double-click.
cd /d "%~dp0\..\.."
if not exist node_modules (
  echo Installing dependencies...
  call npm ci || goto :error
)
if not exist dist\index.js (
  echo Building...
  call npm run build || goto :error
)
echo Starting Hoelni Client Suite on http://127.0.0.1:7420 ...
start "" http://127.0.0.1:7420
call npm start
goto :eof
:error
echo Failed – see output above.
pause
