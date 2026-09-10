@echo off
setlocal
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 "%~dp0tools\launch_nexus.py" %*
) else (
  python "%~dp0tools\launch_nexus.py" %*
)
exit /b %errorlevel%
