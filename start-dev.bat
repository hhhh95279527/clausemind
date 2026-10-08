@echo off
rem ClauseMind 一键启动（双击本文件等价于在 PowerShell 执行 .\start-dev.ps1）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dev.ps1"
echo.
pause
