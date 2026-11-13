@echo off
rem Double-clickable launcher for Quietbook (Windows): starts the local server
rem and opens the dashboard. Needs Python 3.10+ from python.org (standard library only).
setlocal
cd /d "%~dp0.."

set "PY=python"
where py >nul 2>nul && set "PY=py -3"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

%PY% scripts\serve_dashboard.py %*
if errorlevel 1 (
  echo.
  echo Quietbook could not start. Is Python 3 installed? Get it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during the install.
  pause
)
