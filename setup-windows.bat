@echo off
rem Double-click this file ONCE to set up and start Travel Desk.
cd /d "%~dp0"
title Travel Desk setup

echo Installing the required package...
call npm install
if errorlevel 1 goto fail

call node scripts\setup.js
if errorlevel 1 goto fail

rem Stop an older copy that is still running on port 3000.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo Starting Travel Desk. Keep this window open while you use it.
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"
call npm start
pause
goto :eof

:fail
echo.
echo Something went wrong. Copy the messages above and send them to Claude for help.
pause
