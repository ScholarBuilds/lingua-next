@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Install uv: winget install --id astral-sh.uv -e
  echo Then reopen your terminal and run this script again.
  pause
  exit /b 1
)
rem uv provisions Python 3.12 without changing the system Python installation.
uv run --no-project --python 3.12 "%~dp0tools\launch_nexus.py" %*
set "NEXUS_EXIT=%errorlevel%"
if not "%NEXUS_EXIT%"=="0" (
  echo [FAIL] NEXUS exited with code %NEXUS_EXIT%. Logs: data\logs
  pause
)
exit /b %NEXUS_EXIT%
