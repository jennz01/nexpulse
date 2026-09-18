<#
One-shot setup for the personal dashboard on Windows. Run it from anywhere:

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1              # from PowerShell
  bash scripts/setup.sh                                                               # from Git Bash (thin wrapper around this file)
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1 -NoStartup   # everything except the logon task

It is safe to run again at any time: every step checks before it changes anything.

  1. Tools      Git, Bun, GitHub CLI, Node.js and lark-cli; missing ones are installed with winget / npm
  2. Packages   bun install
  3. Config     config\dashboard.config.json from the example, config\secrets\.env template
  4. Build      bun run build (the static UI the server serves)
  5. Check      bun run check (one call per source; FAILED github/lark rows and DISABLED rows are expected until you sign in / add credentials)
  6. Startup    bun run startup:install (Windows scheduled task that starts the server at logon)

Signing in to GitHub and Lark is not part of setup: open the dashboard afterwards and use Settings, Connections, Authorize.
#>
[CmdletBinding()]
param(
  # Skip registering the logon task (you can run `bun run startup:install` later).
  [switch] $NoStartup,
  # Skip the UI build (for a dev machine that will use `bun run dev`).
  [switch] $NoBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string] $text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Ok([string] $text) { Write-Host "   $text" -ForegroundColor Green }
function Note([string] $text) { Write-Host "   $text" -ForegroundColor Yellow }
function Have([string] $cmd) { return [bool] (Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Run([string] $exe, [string[]] $arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') exited with code $LASTEXITCODE" }
}
function Ensure-Tool([string] $cmd, [string] $wingetId, [string] $label, [string] $manual) {
  if (Have $cmd) { Ok "$label found: $((Get-Command $cmd).Source)"; return }
  if (-not (Have 'winget')) { throw "$label is not installed and winget is unavailable. Install it from $manual and run this script again." }
  Note "$label is missing; installing with winget ($wingetId)..."
  & winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
  if (-not (Have $cmd)) { throw "$label was installed but is not on PATH yet. Close this terminal, open a new one and run the script again." }
  Ok "$label installed: $((Get-Command $cmd).Source)"
}

Step 'Tools'
Ensure-Tool 'git' 'Git.Git' 'Git' 'https://git-scm.com/download/win'
Ensure-Tool 'bun' 'Oven-sh.Bun' 'Bun' 'https://bun.sh'
Ensure-Tool 'gh' 'GitHub.cli' 'GitHub CLI' 'https://cli.github.com'
Ensure-Tool 'node' 'OpenJS.NodeJS.LTS' 'Node.js (needed only to install lark-cli)' 'https://nodejs.org'
if (Have 'lark-cli') {
  Ok "lark-cli found: $(& lark-cli --version)"
} else {
  Note 'lark-cli is missing; installing with npm (@larksuite/cli)...'
  Run 'npm' @('install', '-g', '@larksuite/cli')
  Refresh-Path
  if (-not (Have 'lark-cli')) { throw 'lark-cli was installed but is not on PATH yet. Close this terminal, open a new one and run the script again.' }
  Ok "lark-cli installed: $(& lark-cli --version)"
}
$bunVersion = (& bun --version).Trim()
if ([version] ($bunVersion -replace '[^0-9.].*$', '') -lt [version] '1.3.0') { throw "Bun $bunVersion is too old; the dashboard needs 1.3 or newer (bun upgrade)." }
Ok "Bun $bunVersion"

Step 'Packages'
Run 'bun' @('install')

Step 'Config'
$configPath = Join-Path $root 'config\dashboard.config.json'
$examplePath = Join-Path $root 'config\dashboard.config.example.json'
if (Test-Path $configPath) {
  Ok 'config\dashboard.config.json exists; leaving it alone'
} else {
  Copy-Item $examplePath $configPath
  Note 'Created config\dashboard.config.json from the example. Fill in the Lark Base ids and field names (see SETUP.md, "Configure").'
}
$secretsDir = Join-Path $root 'config\secrets'
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
$envPath = Join-Path $secretsDir '.env'
if (-not (Test-Path $envPath)) {
  Set-Content -Path $envPath -Encoding ascii -Value @(
    '# Codemagic -> Teams -> Personal Account -> Integrations -> Codemagic API -> copy the token, then remove the leading #',
    '# CODEMAGIC_API_TOKEN=paste-your-token-here'
  )
  Note 'Created config\secrets\.env with a commented Codemagic token line; the Builds panel stays off until you fill it in.'
} else {
  Ok 'config\secrets\.env exists'
}

if (-not $NoBuild) {
  Step 'Build'
  Run 'bun' @('run', 'build')
}

Step 'Check'
& bun run check
if ($LASTEXITCODE -ne 0) { Note 'FAILED rows for github and lark are expected until you sign in from the dashboard (Settings, Connections), DISABLED rows until you add those credentials. For anything else fix the config for that row and run `bun run check` again. The rest of the setup still applies.' }

if ($NoStartup) {
  Step 'Done (startup task skipped)'
  Write-Host '   Start it by hand with `bun run start`, or register the logon task later with `bun run startup:install`.'
  Write-Host '   Then open http://127.0.0.1:6600, Settings, Connections, and click Authorize for GitHub and for Lark.'
  Write-Host '   The first time on a PC, Lark also needs a one-time `lark-cli config init --brand lark` in a terminal; the Lark row there explains when.'
} elseif ($NoBuild) {
  Step 'Done (startup task skipped: nothing is built to serve)'
  Write-Host '   Run `bun run dev` for development, or `bun run build` then `bun run startup:install`.'
} else {
  Step 'Startup task'
  Run 'powershell' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'startup.ps1'), 'install')
  Step 'Done'
  Write-Host '   The dashboard is running at http://127.0.0.1:6600 and will start again at every sign-in.'
  Write-Host '   Next: open it, go to Settings, Connections and click Authorize for GitHub and for Lark (each is a short browser step).'
  Write-Host '   The first time on a PC, Lark also needs a one-time `lark-cli config init --brand lark` in a terminal; the Lark row there explains when.'
  Write-Host '   After editing config\dashboard.config.json: bun run startup:restart'
}
