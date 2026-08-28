$ErrorActionPreference = 'Stop'

$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$scp = 'C:\Windows\System32\OpenSSH\scp.exe'
$identity = 'C:\Users\Administrator\.ssh-codex\AJMY-0630-admin.pem'
$remote = 'ecs-user@120.26.178.11'
$remoteDirectory = '/home/ecs-user/agimia-backups'
$localDirectory = 'E:\Agimia-ERP-Backups'
$log = Join-Path $localDirectory 'backup-download.log'

New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null

$latest = & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i $identity $remote "find $remoteDirectory -maxdepth 1 -type f -name 'agimia-erp-*.tar.gz' -printf '%f\n' | sort | tail -n 1"
if ($LASTEXITCODE -ne 0 -or -not $latest) { throw 'Could not determine the latest ECS backup' }
$latest = $latest.Trim()

foreach ($name in @($latest, "$latest.sha256")) {
  & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes -i $identity "${remote}:${remoteDirectory}/$name" $localDirectory
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $name" }
}

$expected = (Get-Content (Join-Path $localDirectory "$latest.sha256") -Raw).Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0].ToUpperInvariant()
$actual = (Get-FileHash -Algorithm SHA256 (Join-Path $localDirectory $latest)).Hash
if ($actual -ne $expected) { throw "SHA-256 verification failed: $latest" }

Get-ChildItem $localDirectory -Filter 'agimia-erp-*.tar.gz*' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item -Force

"$(Get-Date -Format s) downloaded and verified $latest" | Add-Content -Path $log
Write-Host "Downloaded and verified: $latest"
