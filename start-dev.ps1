# =====================================================================
# ClauseMind 本地开发一键启动脚本（Windows / PowerShell 5.1+ 兼容）
# 用法：在项目根目录执行  .\start-dev.ps1
# 作用：按顺序拉起 PostgreSQL -> Redis -> 后端(3000) -> 前端(5173)
# 特性：幂等——已在运行的组件自动跳过；前后端各开一个独立日志窗口
# =====================================================================

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 机器相关路径：换电脑只改这三行 ----
$PgCtl       = 'C:\Users\18229\.local\lib\pgsql\bin\pg_ctl.exe'
$PgData      = 'C:\Users\18229\.local\share\pgdata'
$RedisServer = 'D:\Redis\redis-server.exe'
# ---------------------------------------

$ServerDir   = Join-Path $Root 'server'
$FrontendDir = Join-Path $Root 'frontend'

function Test-Port($Port) {
  return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port($Port, $Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Port $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-Http($Url, $Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3 | Out-Null
      return $true
    } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

Write-Host ''
Write-Host '========== ClauseMind 开发环境启动 ==========' -ForegroundColor Cyan

# 1) PostgreSQL（便携版，不是 Windows 服务，需手工拉起）
if (Test-Port 5432) {
  Write-Host '[1/4] PostgreSQL 已在运行，跳过' -ForegroundColor Green
} else {
  Write-Host '[1/4] 启动 PostgreSQL ...' -ForegroundColor Yellow
  if (-not (Test-Path $PgCtl)) { throw "找不到 pg_ctl：$PgCtl，请修改脚本顶部路径" }
  & $PgCtl -D $PgData -w start
  if (-not (Wait-Port 5432 15)) { throw 'PostgreSQL 启动超时（15s）' }
  Write-Host '      PostgreSQL 就绪 :5432' -ForegroundColor Green
}

# 2) Redis
if (Test-Port 6379) {
  Write-Host '[2/4] Redis 已在运行，跳过' -ForegroundColor Green
} else {
  Write-Host '[2/4] 启动 Redis ...' -ForegroundColor Yellow
  if (-not (Test-Path $RedisServer)) { throw "找不到 redis-server：$RedisServer，请修改脚本顶部路径" }
  Start-Process -FilePath $RedisServer -WorkingDirectory (Split-Path $RedisServer) -WindowStyle Minimized
  if (-not (Wait-Port 6379 10)) { throw 'Redis 启动超时（10s）' }
  Write-Host '      Redis 就绪 :6379' -ForegroundColor Green
}

# 3) 后端 NestJS（新窗口运行，方便看日志 / Ctrl+C 停止）
if (Test-Port 3000) {
  Write-Host '[3/4] 后端已在运行，跳过' -ForegroundColor Green
} else {
  if (-not (Test-Path (Join-Path $ServerDir 'node_modules'))) {
    throw 'server\node_modules 不存在，请先执行：cd server; npm install --legacy-peer-deps'
  }
  Write-Host '[3/4] 新窗口启动后端 (http://localhost:3000) ...' -ForegroundColor Yellow
  Start-Process -FilePath cmd.exe -ArgumentList @(
    '/k', "title ClauseMind-Server && cd /d `"$ServerDir`" && npm run dev"
  )
}

# 4) 前端 Vite（新窗口运行）
if (Test-Port 5173) {
  Write-Host '[4/4] 前端已在运行，跳过' -ForegroundColor Green
} else {
  if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
    throw 'frontend\node_modules 不存在，请先执行：cd frontend; npm install'
  }
  Write-Host '[4/4] 新窗口启动前端 (http://localhost:5173) ...' -ForegroundColor Yellow
  Start-Process -FilePath cmd.exe -ArgumentList @(
    '/k', "title ClauseMind-Frontend && cd /d `"$FrontendDir`" && npm run dev"
  )
}

# 等待两个 HTTP 服务就绪（首次 ts-node-dev 编译可能需要 30~60s）
Write-Host ''
Write-Host '等待服务就绪 ...' -ForegroundColor Cyan
$apiOk  = Wait-Http 'http://localhost:3000/health' 90
$webOk  = Wait-Http 'http://localhost:5173' 60

Write-Host ''
if ($apiOk) { Write-Host '  后端健康检查  PASS  http://localhost:3000/health' -ForegroundColor Green }
else        { Write-Host '  后端未就绪，请查看「ClauseMind-Server」窗口日志（等待编译或报错）' -ForegroundColor Red }
if ($webOk) { Write-Host '  前端页面      PASS  http://localhost:5173' -ForegroundColor Green }
else        { Write-Host '  前端未就绪，请查看「ClauseMind-Frontend」窗口日志' -ForegroundColor Red }

Write-Host ''
Write-Host '  打开应用： http://localhost:5173' -ForegroundColor White
Write-Host '  演示账号： testboss / Test1234' -ForegroundColor White
Write-Host '  停止服务： 关闭弹出的两个 cmd 窗口；PG/Redis 保持后台运行即可' -ForegroundColor DarkGray
Write-Host '==========================================' -ForegroundColor Cyan
Write-Host ''
