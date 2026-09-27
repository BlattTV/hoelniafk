@echo off
REM Hoelni Client Suite – start without the desktop installer (from the repository).
REM The suite opens in its own app window (Microsoft Edge app mode, no browser UI).
REM The installed desktop program (desktop\ → "Hoelni Client Suite" in the start menu) is the preferred way.
cd /d "%~dp0\..\.."
if not exist node_modules (
  echo Installing dependencies...
  call npm ci || goto :error
)
if not exist dist\index.js (
  echo Building...
  call npm run build || goto :error
)
echo Starting Hoelni Client Suite ...
start "Hoelni backend" /min cmd /c "npm start"
powershell -NoProfile -Command "$u='http://127.0.0.1:7420/api/status'; for($i=0;$i -lt 180;$i++){ try { Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 2 | Out-Null; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
if errorlevel 1 goto :error
start "" msedge --app=http://127.0.0.1:7420/ --window-size=1440,920 || start "" http://127.0.0.1:7420/
goto :eof
:error
echo Failed – see output above.
pause
