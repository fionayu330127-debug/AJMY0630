param(
  [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'
if (-not $Confirmed) {
  throw 'Publishing is guarded. Run: .\publish-to-production.ps1 -Confirmed'
}

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$production = 'C:\Users\Administrator\Desktop\agimia-erp-production'
$archiveRoot = 'E:\Agimia-ERP-Release-Backups'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$gitStatus = (& git -C $source status --porcelain)
if ($gitStatus) { throw 'Development worktree is not clean. Commit or stash changes before publishing.' }
$revision = (& git -C $source rev-parse --short=12 HEAD).Trim()
$backup = Join-Path $archiveRoot "$stamp-$revision-local-production"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "agimia-release-$stamp-$revision"
$releaseZip = Join-Path $tempRoot 'release.zip'
$releaseDir = Join-Path $tempRoot 'release'

if (-not (Test-Path -LiteralPath $production)) { throw "Production directory not found: $production" }

try {
  $codePublished = $false
  New-Item -ItemType Directory -Path $backup,$releaseDir -Force | Out-Null
  & git -C $source archive --format=zip --output=$releaseZip HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not create release archive from Git HEAD.' }
  Expand-Archive -LiteralPath $releaseZip -DestinationPath $releaseDir -Force

  $backupCode = Join-Path $backup 'code'
  New-Item -ItemType Directory -Path $backupCode -Force | Out-Null
  robocopy $production $backupCode /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 `
    /XD '.git' 'node_modules' 'logs' 'data' 'modules\tk-creator-system\data' 'modules\tk-trend-system\data' 'product-test-system\data' `
    /XF '.env' '*.log' '*.db' '*.db-wal' '*.db-shm' | Out-Host
  if ($LASTEXITCODE -gt 7) { throw "Code backup failed: $LASTEXITCODE" }

  $database = Join-Path $production 'modules\tk-creator-system\data\tk-creator.db'
  & node (Join-Path $source 'scripts\backup-sqlite.js') $database (Join-Path $backup 'tk-creator.db')
  if ($LASTEXITCODE -ne 0) { throw 'SQLite backup failed.' }
  Set-Content -LiteralPath (Join-Path $backup 'release.txt') -Value "revision=$revision`ncreated_at=$((Get-Date).ToString('s'))"

  robocopy $releaseDir $production /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 `
    /XD 'node_modules' 'logs' 'data' 'modules\tk-creator-system\data' 'modules\tk-trend-system\data' 'product-test-system\data' `
    /XF '.env' '*.log' '*.db' '*.db-wal' '*.db-shm' | Out-Host
  if ($LASTEXITCODE -gt 7) { throw "Code publish failed: $LASTEXITCODE" }
  $codePublished = $true

  & node --check (Join-Path $production 'server.js')
  & node --check (Join-Path $production 'modules\tk-creator-system\server.js')
  if ($LASTEXITCODE -ne 0) { throw 'Production syntax check failed.' }

  $listeners = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($listenerPid in $listeners) {
    if ($listenerPid -and $listenerPid -ne $PID) { Stop-Process -Id $listenerPid -Force }
  }

  Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory $production -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $production 'erp.out.log') -RedirectStandardError (Join-Path $production 'erp.err.log')
  Start-Sleep -Seconds 3
  $health = Invoke-WebRequest -Uri 'http://127.0.0.1:3001/healthz' -UseBasicParsing -TimeoutSec 15
  if ($health.StatusCode -ne 200) { throw 'Production health check failed after restart.' }

  Write-Host "Published revision $revision to $production"
  Write-Host "Backup: $backup"
} catch {
  $publishError = $_
  if ($codePublished -and (Test-Path -LiteralPath (Join-Path $backup 'code'))) {
    Write-Warning "Publish failed; restoring code from $backup"
    robocopy (Join-Path $backup 'code') $production /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 | Out-Host
    if ($LASTEXITCODE -gt 7) { Write-Warning "Automatic code rollback also failed: $LASTEXITCODE" }
  }
  throw $publishError
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
