$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cloudflared = 'C:\Users\Administrator\Desktop\tools\cloudflared.exe'
$Config = 'C:\Users\Administrator\.cloudflared\config.yml'
$TunnelId = '00f64fe5-9303-4c01-8ac9-585e2eb59554'
$LogDir = Join-Path $Root 'logs'
$WatchLog = Join-Path $LogDir 'cloudflared-watch.log'
$OutLog = Join-Path $Root 'cloudflared.out.log'
$ErrLog = Join-Path $Root 'cloudflared.err.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-WatchLog {
  param([string]$Message)
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -Path $WatchLog -Value $line -Encoding UTF8
}

Write-WatchLog 'Restarting cloudflared tunnel.'

Get-Process |
  Where-Object { $_.ProcessName -like '*cloudflared*' } |
  ForEach-Object {
    try {
      Write-WatchLog ("Stopping cloudflared PID {0}." -f $_.Id)
      Stop-Process -Id $_.Id -Force
    } catch {
      Write-WatchLog ("Failed to stop cloudflared PID {0}: {1}" -f $_.Id, $_.Exception.Message)
    }
  }

Start-Sleep -Seconds 1

try {
  Write-WatchLog 'Cleaning stale tunnel connections.'
  & $Cloudflared tunnel cleanup $TunnelId 2>&1 | ForEach-Object { Write-WatchLog $_ }
} catch {
  Write-WatchLog ("Tunnel cleanup failed: {0}" -f $_.Exception.Message)
}

Start-Sleep -Seconds 1

try {
  Start-Process `
    -FilePath $Cloudflared `
    -ArgumentList @('tunnel', '--config', $Config, '--no-prechecks', 'run') `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden

  Start-Sleep -Seconds 5
  $process = Get-Process | Where-Object { $_.ProcessName -like '*cloudflared*' } | Select-Object -First 1
  if ($process) {
    Write-WatchLog ("cloudflared started. PID {0}." -f $process.Id)
    exit 0
  }

  Write-WatchLog 'cloudflared did not stay running after restart.'
  exit 1
} catch {
  Write-WatchLog ("cloudflared restart failed: {0}" -f $_.Exception.Message)
  exit 1
}
