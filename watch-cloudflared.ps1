$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LocalUrl = 'http://127.0.0.1:3001/healthz'
$PublicUrl = 'http://aojimiya123.top/'
$RestartScript = Join-Path $Root 'restart-cloudflared.ps1'
$LogDir = Join-Path $Root 'logs'
$WatchLog = Join-Path $LogDir 'cloudflared-watch.log'
$StampFile = Join-Path $LogDir 'cloudflared-last-restart.txt'
$MinRestartGapSeconds = 120

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-WatchLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $WatchLog -Value $line -Encoding UTF8
}

function Test-HttpOk {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 12
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    Write-WatchLog ("HTTP check failed for {0}: {1}" -f $Url, $_.Exception.Message)
    return $false
  }
}

function Restart-Recently {
  if (!(Test-Path $StampFile)) { return $false }
  try {
    $last = [datetime](Get-Content $StampFile -Raw)
    return ((Get-Date) - $last).TotalSeconds -lt $MinRestartGapSeconds
  } catch {
    return $false
  }
}

$localOk = Test-HttpOk $LocalUrl
$publicOk = Test-HttpOk $PublicUrl
$cloudflared = Get-Process | Where-Object { $_.ProcessName -like '*cloudflared*' } | Select-Object -First 1

if ($localOk -and $publicOk -and $cloudflared) {
  Write-WatchLog ("OK local/public/cloudflared PID {0}." -f $cloudflared.Id)
  exit 0
}

if (!$localOk) {
  Write-WatchLog 'Local ERP is not healthy. Skipping tunnel restart because origin is down.'
  exit 2
}

if (Restart-Recently) {
  Write-WatchLog 'Public tunnel is unhealthy, but restart was recent. Skipping to avoid restart loop.'
  exit 3
}

Write-WatchLog 'Public tunnel is unhealthy while local ERP is healthy. Restarting cloudflared.'
(Get-Date).ToString('o') | Set-Content -Path $StampFile -Encoding UTF8

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RestartScript
exit $LASTEXITCODE
