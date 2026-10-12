@echo off
chcp 65001 >nul
title ClauseMind 本地开发启动器
echo ============================================
echo   ClauseMind 本地开发环境启动
echo   PostgreSQL / Redis 已随 Windows 自启
echo ============================================
echo.
echo [1/3] 启动后端  (http://localhost:3000) ...
start "ClauseMind - 后端 :3000" cmd /k "cd /d %~dp0server && npm run dev"
echo [2/3] 等待后端初始化 12 秒 ...
timeout /t 12 /nobreak >nul
echo [3/3] 启动前端  (http://localhost:5173) ...
start "ClauseMind - 前端 :5173" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 5 /nobreak >nul
start http://localhost:5173
echo.
echo 已全部启动：浏览器即将打开 http://localhost:5173
echo 关闭两个黑色窗口即可停止前后端；数据库服务不受影响。
timeout /t 5 /nobreak >nul
