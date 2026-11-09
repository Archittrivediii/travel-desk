@echo off
rem Double-click this file any time to start Travel Desk. Keep the window open while you use it.
cd /d "%~dp0"
title Travel Desk

rem Stop an older copy that is still running on port 3000 (only that program, nothing else).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
  echo Stopping the older Travel Desk that was still running...
  taskkill /F /PID %%p >nul 2>&1
)
timeout /t 1 /nobreak >nul

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
call npm start
pause
