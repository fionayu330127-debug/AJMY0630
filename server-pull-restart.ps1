$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3001

Set-Location $root

git pull --ff-only origin main
npm install --omit=dev

$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

foreach ($pid in $listeners) {
  if ($pid -and $pid -ne $PID) {
    Stop-Process -Id $pid -Force
  }
}

Start-Process -FilePath 'node' `
  -ArgumentList 'server.js' `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root 'erp.out.log') `
  -RedirectStandardError (Join-Path $root 'erp.err.log')

Write-Host "Agimia ERP restarted:"
Write-Host "  public: http://120.26.178.11:3001/"
Write-Host "  local:  http://127.0.0.1:3001/"
