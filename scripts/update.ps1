<#
Bring this checkout up to date, then rebuild what git does not track. serve.ps1 runs it before the first server
start at logon and `bun run startup:restart` runs it before restarting; by hand, from the repo root:

  bun run update        (or: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update.ps1)

  1. git pull --ff-only   skipped when there is no upstream branch or the checkout has local changes
  2. bun install          only when the pull brought new commits
  3. bun run build        only when the pull brought new commits (the served UI lives in web/dist, outside git)

It never throws and never prompts. When git, the network or the build is unhappy it says why and exits 1, and the
caller carries on with the code already there. Exit 0 means up to date, updated, or deliberately skipped.
#>
param(
  # Absolute path to bun.exe; startup.ps1 bakes it into the task because the task's PATH may differ from your shell's.
  [string] $Bun = 'bun'
)
$ErrorActionPreference = 'Continue'  # native stderr must not turn into a terminating error here
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$script:exitCode = 0

function Say([string] $text) { Write-Output "update: $text" }
function Short([string] $sha) { if ($sha.Length -ge 7) { return $sha.Substring(0, 7) } else { return $sha } }
function FirstLine([string] $text) { return ($text -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1) }

function Invoke-Git([string[]] $arguments, [int] $timeoutSec = 30) {
  # System.Diagnostics.Process rather than Start-Process: in Windows PowerShell 5.1 the -PassThru object reports no
  # ExitCode once output is redirected. This also keeps git's stderr out of PowerShell's error stream and bounds the wait.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:git
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Arguments = ($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $p = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return @{ code = 124; text = "git $($arguments -join ' ') gave up after $timeoutSec s" }
  }
  return @{ code = $p.ExitCode; text = ($so.Result + "`n" + $se.Result).Trim() }
}

function Invoke-Bun([string[]] $arguments) {
  $lines = @(& $Bun @arguments 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" } })
  return @{ code = $LASTEXITCODE; lines = $lines }
}

function Fail([string] $what, $result) {
  Say "$what failed (exit $($result.code)); the server may run new code with the old UI until this is fixed:"
  $result.lines | Select-Object -Last 8 | ForEach-Object { Say "  $_" }
  $script:exitCode = 1
}

function Update-Checkout {
  $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $gitCmd) { Say 'git is not on PATH; keeping the current code'; return }
  $script:git = $gitCmd.Source
  if (-not (Test-Path (Join-Path $root '.git'))) { Say 'not a git checkout; keeping the current code'; return }

  $upstream = Invoke-Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  if ($upstream.code -ne 0) { Say 'no upstream branch (detached HEAD or a local-only branch); keeping the current code'; return }
  $status = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
  if ($status.code -ne 0) { Say "git status failed: $(FirstLine $status.text)"; $script:exitCode = 1; return }
  if ($status.text) { Say 'local changes in the checkout; not pulling over them (commit or stash them to resume auto-update)'; return }

  $before = (Invoke-Git @('rev-parse', 'HEAD')).text
  $pull = Invoke-Git @('pull', '--ff-only', '--no-rebase') 60
  if ($pull.code -ne 0) { Say "git pull from $($upstream.text) failed; keeping the current code ($(FirstLine $pull.text))"; $script:exitCode = 1; return }
  $after = (Invoke-Git @('rev-parse', 'HEAD')).text
  if ($after -eq $before) { Say "already up to date with $($upstream.text) ($(Short $after))"; return }
  Say "pulled $(Short $before)..$(Short $after) from $($upstream.text)"

  # Dependencies and the built UI live outside git, so new commits need both refreshed before the server serves them.
  $r = Invoke-Bun @('install')
  if ($r.code -ne 0) { Fail 'bun install' $r; return }
  Say 'bun install ok'
  $r = Invoke-Bun @('run', 'build')
  if ($r.code -ne 0) { Fail 'bun run build' $r; return }
  Say 'bun run build ok'
  Say 'update complete'
}

# A hidden task must never hang on a credential prompt; the repo is public, so fetching needs none anyway.
$savedPrompt = $env:GIT_TERMINAL_PROMPT
$savedGcm = $env:GCM_INTERACTIVE
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
try { Update-Checkout } finally {
  $env:GIT_TERMINAL_PROMPT = $savedPrompt
  $env:GCM_INTERACTIVE = $savedGcm
}
exit $script:exitCode
