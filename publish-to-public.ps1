param(
  [switch]$Confirmed,
  [string]$Remote = 'ecs-user@120.26.178.11',
  [string]$Identity = 'C:\Users\Administrator\.ssh-codex\AJMY-0630-admin.pem'
)

$ErrorActionPreference = 'Stop'
if (-not $Confirmed) {
  throw 'Public publishing is guarded. Run: .\publish-to-public.ps1 -Confirmed'
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$gitStatus = (& git -C $root status --porcelain)
if ($gitStatus) { throw 'Development worktree is not clean. Commit changes before public publishing.' }
& git -C $root fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not refresh origin/main.' }
$revision = (& git -C $root rev-parse HEAD).Trim()
$remoteRevision = (& git -C $root rev-parse origin/main).Trim()
if ($revision -ne $remoteRevision) { throw 'HEAD is not origin/main. Push the verified commit before public publishing.' }
if (-not (Test-Path -LiteralPath $Identity)) { throw "SSH identity not found: $Identity" }

$shortRevision = $revision.Substring(0, 12)
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "agimia-public-$shortRevision"
$archive = Join-Path $tempRoot "agimia-release-$shortRevision.tar.gz"
$remoteArchive = "/tmp/agimia-release-$shortRevision.tar.gz"
$remoteScript = "/tmp/agimia-deploy-$shortRevision.sh"
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$scp = 'C:\Windows\System32\OpenSSH\scp.exe'
$sshArgs = @('-o','BatchMode=yes','-o','ConnectTimeout=15','-o','StrictHostKeyChecking=yes','-i',$Identity)

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  & git -C $root archive --format=tar.gz --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not create public release archive.' }

  & $scp @sshArgs $archive "${Remote}:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload public release archive.' }
  & $scp @sshArgs (Join-Path $root 'ops\deploy-release.sh') "${Remote}:$remoteScript"
  if ($LASTEXITCODE -ne 0) { throw 'Could not upload public deploy script.' }

  & $ssh @sshArgs $Remote "bash '$remoteScript' '$remoteArchive' '$shortRevision'"
  if ($LASTEXITCODE -ne 0) { throw 'Public deployment failed. The server attempted code rollback.' }

  $health = Invoke-WebRequest -Uri 'http://120.26.178.11:3001/healthz' -UseBasicParsing -TimeoutSec 15
  if ($health.StatusCode -ne 200) { throw 'Public health check failed from this computer.' }
  Write-Host "Published public revision $shortRevision"
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
