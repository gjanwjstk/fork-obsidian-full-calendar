@echo off
cd /d "%~dp0"
echo Building...
call npm run build:deploy
echo.
pause
