@echo off
REM Seed Helper capture listener — writes live journals + auto-diags to captures\
cd /d "%~dp0"
start "seed-capture" /min node capture_server.js
echo Capture listener started on 127.0.0.1:8766 (minimized window).
echo Leave it running while the queue runs. Captures land in %~dp0captures\
timeout /t 4 >nul
