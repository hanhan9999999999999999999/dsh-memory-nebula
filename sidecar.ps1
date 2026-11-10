# 记忆星图 · 独立引擎（sidecar）开关
#   用法： .\sidecar.ps1 start   /   .\sidecar.ps1 stop   /   .\sidecar.ps1 status
#   可选： -Port 7890   -Root <要额外扫描的工作区父目录，默认当前目录>   -Node C:\path\to\node.exe
# 说明：宿主进程里的插件代码是 DSH 启动那一刻加载的；改了 lib/host/*.js 之后，
#      用这个脚本跑一份独立引擎（默认端口 7890），页面会自动探测并切过去。
#      重启过一次 DSH 之后宿主自己就是新代码，这个进程就不再需要了。

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status')]
  [string]$Action = 'status',
  [int]$Port = 7890,
  [string]$Root = (Get-Location).Path,
  [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
$plugin = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $plugin 'lib\standalone.mjs'
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$logDir = Join-Path $homeDir 'memory-nebula'

function Resolve-Node {
  if ($Node) {
    if (-not (Test-Path $Node)) { throw "指定的 node 不存在：$Node" }
    return $Node
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $runtimes = Join-Path $homeDir 'dsh-runtimes'
  if (Test-Path $runtimes) {
    $hit = Get-ChildItem -Path $runtimes -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  throw '找不到 node：请把 Node 22.13+ 放进 PATH，或用 -Node 指定路径。'
}

# 只认「这个端口」的那一个实例，别把别人的 7891 一起杀掉。
function Get-Sidecars {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*standalone.mjs*' -and $_.CommandLine -like "*--port $Port*" }
}

function Wait-Ping {
  for ($i = 0; $i -lt 30; $i++) {
    try {
      return Invoke-RestMethod "http://127.0.0.1:$Port/api/memory-nebula/ping" -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $null
}

switch ($Action) {
  'start' {
    $running = Get-Sidecars
    if ($running) {
      Write-Host "端口 $Port 上已经在跑：pid $($running.ProcessId -join ', ')"
      break
    }
    $node = Resolve-Node
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $outLog = Join-Path $logDir 'standalone.log'
    # 不用 Start-Process 的 -RedirectStandardOutput：Windows PowerShell 5.1 会一直等到子进程退出，
    # 让 `sidecar.ps1 start` 卡在调用方。改由引擎自己写 --log。
    Start-Process -FilePath $node `
      -ArgumentList @("`"$script`"", '--port', "$Port", '--root', "`"$Root`"", '--log', "`"$outLog`"") `
      -WindowStyle Hidden | Out-Null
    $ping = Wait-Ping
    if ($ping) {
      Write-Host "已启动 · 端口 $Port · 记忆 $($ping.stats.nodes) 条 / 连接 $($ping.stats.edges) 条 · v$($ping.version)"
    } else {
      Write-Host "已启动但探活失败，看日志：$outLog"
      Write-Host "（端口被占用时日志里会直接写「端口 $Port 已被占用」）"
    }
  }
  'stop' {
    $running = Get-Sidecars
    if (-not $running) { Write-Host "端口 $Port 上没有独立引擎"; break }
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Host "已停止 pid $($running.ProcessId -join ', ')"
  }
  'status' {
    $running = Get-Sidecars
    if (-not $running) { Write-Host "未运行（端口 $Port；页面会退回宿主自带的接口）"; break }
    Write-Host "运行中：pid $($running.ProcessId -join ', ')"
    $ping = Wait-Ping
    if ($ping) {
      Write-Host "记忆 $($ping.stats.nodes) 条 / 连接 $($ping.stats.edges) 条 / 构建 $($ping.build) · v$($ping.version)"
    } else {
      Write-Host "进程在，但端口 $Port 没响应"
    }
  }
}
