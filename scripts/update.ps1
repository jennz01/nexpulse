<#
Bring this checkout up to date, then rebuild what git does not track. serve.ps1 runs it before the first server
start at logon and `bun run startup:restart` runs it before restarting; by hand, from the repo root:

  bun run update        (or: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update.ps1)

  1. git pull --ff-only   skipped when there is no upstream branch or the checkout has local changes
  2. bun install          when bun.lock differs from the one last installed (node_modules\.nexpulse-lock)
  3. bun run build        when web\dist was built from another commit (web\dist\version.json), or not at all

Steps 2 and 3 look at what is on disk, not at whether this pull brought commits: a `git pull` run by hand would
otherwise leave new code without its packages or UI, and the next run would call it up to date. They run on a clean
checkout only, so work in progress is never built behind your back.

It never throws and never prompts. When git, the network or the build is unhappy it says why and exits 1, and the
caller carries on with the code already there. If step 2 or 3 fails right after this pull, the checkout steps back to
the commit it had, so the server never runs new code without its packages or UI; the next sign-in tries again.
Exit 0 means up to date, updated, or deliberately skipped.
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
  Say "$what failed (exit $($result.code)) after the pull:"
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
  $pulled = $false
  if ($pull.code -ne 0) {
    # Offline is common 15 s after logon; still repair packages and UI for the code already here.
    Say "git pull from $($upstream.text) failed; keeping the current code ($(FirstLine $pull.text))"
    $script:exitCode = 1
  } else {
    $after = (Invoke-Git @('rev-parse', 'HEAD')).text
    if ($after -eq $before) { Say "already up to date with $($upstream.text) ($(Short $after))" }
    else { Say "pulled $(Short $before)..$(Short $after) from $($upstream.text)"; $pulled = $true }
  }
  Sync-Built $(if ($pulled) { $before } else { $null })
}

# Packages and the built UI live outside git, so they are compared with the checked-out code on every run.
$lockFile = Join-Path $root 'bun.lock'
$lockStamp = Join-Path $root 'node_modules\.nexpulse-lock'
$versionFile = Join-Path $root 'web\dist\version.json'

function Lock-Hash { if (Test-Path $lockFile) { (Get-FileHash $lockFile -Algorithm SHA256).Hash } else { '' } }

function Install-Packages {
  $r = Invoke-Bun @('install')
  if ($r.code -eq 0) { Set-Content -Path $lockStamp -Value (Lock-Hash) -Encoding ascii }
  return $r
}

function Sync-Built([string] $rollbackTo) {
  $installed = if (Test-Path $lockStamp) { (Get-Content $lockStamp -Raw).Trim() } else { '' }
  if ($installed -ne (Lock-Hash)) {
    $r = Install-Packages
    if ($r.code -ne 0) { Fail 'bun install' $r; if ($rollbackTo) { Undo-Pull $rollbackTo }; return }
    Say 'bun install ok'
  }
  $head = (Invoke-Git @('rev-parse', 'HEAD')).text
  # Builds made before v0.35 have no version.json; treat them as built from another commit.
  $built = $null
  if (Test-Path $versionFile) { try { $built = (Get-Content $versionFile -Raw -ErrorAction Stop | ConvertFrom-Json).sha } catch { $built = $null } }
  if (-not $built -or -not $head.StartsWith($built)) {
    $r = Invoke-Bun @('run', 'build')
    if ($r.code -ne 0) { Fail 'bun run build' $r; if ($rollbackTo) { Undo-Pull $rollbackTo }; return }
    Say "bun run build ok (the UI was built from $(if ($built) { $built } else { 'an older version' }))"
  }
  if ($rollbackTo) { Say 'update complete' }
}

function Undo-Pull([string] $before) {
  # New code without its packages or UI crash-loops the server (a missing import never recovers), so step back to the
  # commit that was running. Safe: the pull only happens on a checkout with no local changes to tracked files. The next
  # sign-in or `bun run startup:restart` pulls and tries again.
  $reset = Invoke-Git @('reset', '--hard', $before)
  if ($reset.code -ne 0) { Say "could not step back to $(Short $before): $(FirstLine $reset.text)"; return }
  Say "stepped back to $(Short $before); the update is retried at the next sign-in"
  # The failed step may have half-written node_modules or emptied web/dist; restore both for the old commit (best effort).
  $r = Install-Packages
  if ($r.code -ne 0) { Say "  bun install for $(Short $before) also failed (exit $($r.code)); the server may not start" }
  $r = Invoke-Bun @('run', 'build')
  if ($r.code -ne 0) { Say "  bun run build for $(Short $before) also failed (exit $($r.code))" }
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
