<#
Supervisor for the dashboard server. The NexPulse scheduled task (scripts\startup.ps1 install)
runs this hidden at logon; you can also run it by hand from the repo root:

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\serve.ps1

It first runs scripts\update.ps1 (git pull --ff-only, then bun install and bun run build when anything changed;
skipped over local changes, never fatal), then starts `bun server/index.ts`, appends everything the server prints
to data\server.log, and starts it again if it exits (5 s after a crash, doubling up to 60 s while it keeps failing fast).
#>
param(
  # Absolute path to bun.exe. startup.ps1 bakes it in because the task's PATH may differ from your shell's.
  [string] $Bun = 'bun',
  # Start without pulling the latest code first (`bun run startup:install -NoUpdate` bakes this into the task).
  [switch] $NoUpdate
)
# Native stderr lines arrive as error records under 2>&1 in PowerShell 5.1; Continue keeps them flowing into the log.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir 'server.log'
$prev = Join-Path $dataDir 'server.prev.log'
if (Test-Path $log) { Move-Item -Force -Path $log -Destination $prev }

function Write-Log([string] $line) {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Add-Content -Path $log -Encoding UTF8 -Value "[$stamp] supervisor: $line"
}

Write-Log "started (pid $PID) in $root"
if ($NoUpdate) {
  Write-Log 'auto-update is off (-NoUpdate)'
} else {
  # Pull the latest code before the first start, so a PC that only ever signs in stays current. update.ps1 never throws.
  & (Join-Path $PSScriptRoot 'update.ps1') -Bun $Bun 2>&1 | ForEach-Object { Write-Log "$_" }
}
if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
  Write-Log 'web\dist\index.html is missing: run `bun run build`, then `bun run startup:restart`'
}

$delay = 5
while ($true) {
  Write-Log "starting: $Bun server/index.ts"
  $startedAt = Get-Date
  & $Bun server/index.ts 2>&1 | ForEach-Object {
    # stderr lines come wrapped as error records; take the raw text so blank lines do not log as "RemoteException".
    $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
    Add-Content -Path $log -Encoding UTF8 -Value $line
  }
  $code = $LASTEXITCODE
  $ranSec = [int]((Get-Date) - $startedAt).TotalSeconds

  # A server that ran for a while earned a quick restart; one that keeps dying fast gets a growing pause.
  if ($ranSec -ge 60) { $delay = 5 }
  Write-Log "server exited with code $code after $ranSec s; restarting in $delay s"
  Start-Sleep -Seconds $delay
  if ($ranSec -lt 60) { $delay = [Math]::Min($delay * 2, 60) }
}
