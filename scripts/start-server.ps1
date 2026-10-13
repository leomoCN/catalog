<#
.SYNOPSIS
  启动 product-image-search 服务器（部署准备版启动脚本）。

.DESCRIPTION
  - 自动解析 Bun 运行时：优先使用 -BunPath 参数，其次 PATH 中的 bun，
    最后回退到已安装的 C:\Users\Administrator\.cherrystudio\bin\bun.exe。
  - 配置项（参数优先，其次环境变量，最后默认值）：
    PORT              -Port             环境变量 PORT              默认 5173
    HOST              -ListenHost       环境变量 HOST              默认 127.0.0.1（仅回环）
    ADMIN_TOKEN       -AdminToken       环境变量 ADMIN_TOKEN       （为空则由服务器读取 data/.admin-token 或自动生成）
    INTERNAL_PASSWORD -InternalPassword 环境变量 INTERNAL_PASSWORD （为空则使用服务器默认密码）
  - 默认只绑定回环地址 127.0.0.1，不把端口暴露到公网；如需内网多设备访问，
    应配合 VPN/零信任网络，切勿直接把端口暴露到公网。
  - 绝不打印 ADMIN_TOKEN / INTERNAL_PASSWORD 的明文内容，只显示「是否已提供」。

.EXAMPLE
  & scripts/start-server.ps1
  & scripts/start-server.ps1 -Port 8080
  & scripts/start-server.ps1 -Port 8080 -ListenHost 0.0.0.0 -AdminToken "..." -InternalPassword "..."
  & scripts/start-server.ps1 -BunPath "C:\path\to\bun.exe"
#>
[CmdletBinding()]
param(
  [int]$Port,
  [string]$ListenHost,
  [string]$AdminToken,
  [string]$InternalPassword,
  [string]$BunPath
)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

# ---------- 解析 Bun 运行时（绝对路径回退） ----------
$bun = ''
if ($BunPath) {
  if (Test-Path -LiteralPath $BunPath) { $bun = $BunPath }
  else { throw "指定的 Bun 路径不存在：$BunPath" }
}
if (-not $bun) {
  $cmd = Get-Command -Name bun -CommandType Application -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $bun = $cmd.Source }
}
if (-not $bun) {
  $fallback = 'C:\Users\Administrator\.cherrystudio\bin\bun.exe'
  if (Test-Path -LiteralPath $fallback) { $bun = $fallback }
}
if (-not $bun) {
  throw '未找到 Bun 运行时。请通过 -BunPath 指定 bun.exe 路径，或先安装 Bun 后重试。'
}

# ---------- 解析配置（参数 > 环境变量 > 默认值） ----------
# 注意：PowerShell 变量名不区分大小写，本地变量不能用 $port（会与参数 $Port 冲突），
# 因此本地端口变量命名为 $serverPort。
$serverPort = 5173
if ($PSBoundParameters.ContainsKey('Port')) { $serverPort = $Port }
elseif ($env:PORT) {
  if ($env:PORT -notmatch '^\d+$') { throw "环境变量 PORT 非法：$($env:PORT)（应为 1-65535 的数字）" }
  $serverPort = [int]$env:PORT
}
if ($serverPort -lt 1 -or $serverPort -gt 65535) { throw "PORT 非法：$serverPort（应为 1-65535）" }

$hostAddr = '127.0.0.1'
if ($PSBoundParameters.ContainsKey('ListenHost') -and $ListenHost) { $hostAddr = $ListenHost }
elseif ($env:HOST) { $hostAddr = $env:HOST }

$adminTokenValue = ''
if ($PSBoundParameters.ContainsKey('AdminToken') -and $AdminToken) { $adminTokenValue = $AdminToken.Trim() }
elseif ($env:ADMIN_TOKEN) { $adminTokenValue = $env:ADMIN_TOKEN.Trim() }

$internalPasswordValue = ''
if ($PSBoundParameters.ContainsKey('InternalPassword') -and $InternalPassword) { $internalPasswordValue = $InternalPassword.Trim() }
elseif ($env:INTERNAL_PASSWORD) { $internalPasswordValue = $env:INTERNAL_PASSWORD.Trim() }

# ---------- 保存调用方环境变量（结束后恢复，不污染上级会话） ----------
$prevEnv = @{
  'PORT' = $env:PORT
  'HOST' = $env:HOST
  'ADMIN_TOKEN' = $env:ADMIN_TOKEN
  'INTERNAL_PASSWORD' = $env:INTERNAL_PASSWORD
}

try {
  # 配置子进程环境；密钥只进环境变量，不进命令行、不打印
  $env:PORT = "$serverPort"
  $env:HOST = $hostAddr
  if ($adminTokenValue) { $env:ADMIN_TOKEN = $adminTokenValue } else { Remove-Item Env:ADMIN_TOKEN -ErrorAction SilentlyContinue }
  if ($internalPasswordValue) { $env:INTERNAL_PASSWORD = $internalPasswordValue } else { Remove-Item Env:INTERNAL_PASSWORD -ErrorAction SilentlyContinue }

  # ---------- 打印启动信息（不含任何密钥内容） ----------
  Write-Host 'product-image-search 启动（start-server.ps1）'
  Write-Host "  项目目录 : $root"
  Write-Host "  Bun       : $bun"
  try { Write-Host "  Bun 版本 : $(& $bun --version)" } catch { Write-Host '  Bun 版本 : (读取失败)' }
  Write-Host "  监听地址 : http://$hostAddr`:$serverPort （默认仅回环）"
  if ($adminTokenValue) { Write-Host '  ADMIN_TOKEN       : 已提供（内容不显示）' }
  else { Write-Host '  ADMIN_TOKEN       : 未提供（读取 data/.admin-token，没有则首次启动自动生成）' }
  if ($internalPasswordValue) { Write-Host '  INTERNAL_PASSWORD : 已提供（内容不显示）' }
  else { Write-Host '  INTERNAL_PASSWORD : 未提供（使用服务器默认密码，仅测试用）' }
  if ($hostAddr -notin @('127.0.0.1', 'localhost', '::1')) {
    Write-Warning "监听地址不是回环地址（$hostAddr），端口将对网络可达。部署到内网/公网前请确认：不直接暴露公网、配合 VPN/零信任网络与防火墙策略。"
  }
  Write-Host ''

  Push-Location $root
  try {
    & $bun server.js
    if ($LASTEXITCODE -ne $null) { $code = $LASTEXITCODE } else { $code = 1 }
  } finally {
    Pop-Location
  }
  exit $code
} finally {
  # 恢复调用方环境变量（不改动上级会话）
  foreach ($key in $prevEnv.Keys) {
    if ($null -eq $prevEnv[$key]) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$key" -Value $prevEnv[$key] }
  }
}
