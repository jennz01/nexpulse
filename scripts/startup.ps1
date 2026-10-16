<#
Manage the Windows scheduled task that starts the dashboard server hidden at logon.

  bun run startup:install     register the task for the current user and start it now (-NoUpdate: never git pull at logon)
  bun run startup:status      task state, last result, whether the server is listening
  bun run startup:restart     pull the latest code and rebuild if anything changed, then stop and start again (-NoUpdate skips the pull)
  bun run startup:stop        stop the server (frees port 6600 for `bun run dev`)
  bun run startup:uninstall   stop and remove the task
  bun run startup:doctor      check everything that can stop the server from starting, and say what to do

Direct form: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 <verb>
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'status', 'restart', 'stop', 'doctor')]
  [string] $Verb = 'status',
  # install: register the task without the git pull at logon. restart: restart without pulling first.
  [switch] $NoUpdate
)
$ErrorActionPreference = 'Stop'

$TaskName = 'NexPulse'
$root = Split-Path -Parent $PSScriptRoot
$serveScript = Join-Path $PSScriptRoot 'serve.ps1'
$launcherScript = Join-Path $PSScriptRoot 'serve-hidden.vbs'
$updateScript = Join-Path $PSScriptRoot 'update.ps1'
$logFile = Join-Path $root 'data\server.log'

function Get-Port {
  $configPath = Join-Path $root 'config\dashboard.config.json'
  try { $port = (Get-Content -Raw $configPath | ConvertFrom-Json).server.port } catch { $port = $null }
  if ($port) { return [int] $port } else { return 6600 }
}
$port = Get-Port

function Get-Task { Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

function Test-Listening { [bool] (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

function Wait-Listening([int] $seconds = 15) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (Test-Listening) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-Stopped([int] $seconds = 10) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (-not (Test-Listening)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-SupervisorProcesses {
  # The task's PowerShell instances, recognised by the serve.ps1 path on their command line.
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$serveScript*" }
}

function Stop-Task {
  $task = Get-Task
  $supervisors = @(Get-SupervisorProcesses)
  if (-not $supervisors -and (-not $task -or $task.State -ne 'Running')) { return }
  # Task Scheduler ends only its own process, the launcher, so collect the tree first and take it down by hand.
  # Supervisors go before their bun children, or the restart loop would bring the server straight back.
  $children = @()
  foreach ($supervisor in $supervisors) {
    $children += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor.ProcessId) AND Name = 'bun.exe'")
  }
  if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  foreach ($supervisor in $supervisors) { Stop-Process -Id $supervisor.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not (Wait-Stopped)) { Write-Warning "port $port is still in use after stopping the task" }
  Write-Host "Stopped '$TaskName'."
}

function Start-Task {
  $task = Get-Task
  if (-not $task) { throw "Task '$TaskName' is not installed. Run: bun run startup:install" }
  Start-ScheduledTask -TaskName $TaskName
  if (Wait-Listening) { Write-Host "Server is listening on http://127.0.0.1:$port"; return $true }
  Write-Host "The task started but nothing is listening on port $port. Run: bun run startup:doctor (log: $logFile)" -ForegroundColor Red
  return $false
}

function Update-Checkout {
  # The same pull / install / build the supervisor does at logon, run in the foreground so a restart by hand shows what changed.
  $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
  if (-not $bun) { $bun = 'bun' }
  & $updateScript -Bun $bun 2>&1 | ForEach-Object { Write-Host "$_" }
}

function Install-Task {
  $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
  if (-not $bun) { throw 'bun.exe was not found on PATH. Install Bun (https://bun.sh) and open a new terminal.' }
  if (-not (Test-Path $launcherScript)) { throw "scripts\serve-hidden.vbs is missing; the task needs it to start the server without a console window." }
  if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
    Write-Warning 'web\dist is not built; the server will serve a placeholder page until you run `bun run build` and `bun run startup:restart`.'
  }

  Stop-Task
  # wscript.exe, not powershell.exe: a console program's console is handed to the default terminal application,
  # and Windows Terminal then saves the hidden server into its window layout and relaunches it. See serve-hidden.vbs.
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $arguments = "`"$launcherScript`" `"$serveScript`" `"$bun`""
  if ($NoUpdate) { $arguments += ' -NoUpdate' }
  $action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $root

  $user = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = 'PT15S'  # let the network come up before the first polls
  # Laptops sleep and lock rather than sign out, so a server that stopped would otherwise wait days for the next logon.
  # Unlocking starts the task again; while it is still running, IgnoreNew below makes this a no-op.
  $stateClass = Get-CimClass -Namespace Root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
  $unlock = New-CimInstance -CimClass $stateClass -ClientOnly -Property @{ StateChange = 8; UserId = $user; Delay = 'PT5S'; Enabled = $true }  # 8 = session unlock

  # ExecutionTimeLimit zero disables the default 3-day cap that would otherwise kill a long-running task.
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  # Interactive = "run only when user is logged on": the server inherits your profile, so gh and lark-cli find their logins.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $unlock) -Settings $settings -Principal $principal `
    -Description "NexPulse dashboard server (bun) on http://127.0.0.1:$port, started hidden at logon and again at unlock if it stopped. Managed by $root\scripts\startup.ps1" `
    -Force | Out-Null
  Write-Host "Registered task '$TaskName' to start at logon of $user, and again at unlock if it has stopped."
  # Exit non-zero when nothing listens, so the setup script stops in red instead of saying "Done".
  if (-not (Start-Task)) { exit 1 }
}

function Uninstall-Task {
  if (-not (Get-Task)) { Write-Host "Task '$TaskName' is not installed."; return }
  Stop-Task
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'. The server no longer starts at logon."
}

function Show-Status {
  $task = Get-Task
  if (-not $task) {
    Write-Host "Task '$TaskName' is not installed. Run: bun run startup:install"
  } else {
    $info = $task | Get-ScheduledTaskInfo
    $lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { 'never' }
    Write-Host ("Task:       {0} ({1})" -f $task.TaskName, $task.State)
    foreach ($t in $task.Triggers) { Write-Host ("Trigger:    {0}" -f (Format-Trigger $t)) }
    Write-Host ("Last run:   {0} (result 0x{1:X})" -f $lastRun, $info.LastTaskResult)
    Write-Host ("Command:    {0} {1}" -f $task.Actions[0].Execute, $task.Actions[0].Arguments)
    Write-Host ("Log:        {0}" -f $logFile)
  }
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { Write-Host "Server:     listening on http://127.0.0.1:$port (pid $($listener.OwningProcess))" }
  else { Write-Host "Server:     not listening on port $port" }
}

function Format-Trigger($t) {
  $kind = $t.CimClass.CimClassName
  if ($kind -eq 'MSFT_TaskLogonTrigger') { return "at logon of $($t.UserId), after $($t.Delay)" }
  if ($kind -eq 'MSFT_TaskSessionStateChangeTrigger' -and $t.StateChange -eq 8) { return "at unlock by $($t.UserId), after $($t.Delay)" }
  return $kind
}

# Last-run codes Task Scheduler reports, in the words a teammate needs.
# Keyed by hex text: Windows PowerShell reads 0x800710E0 as a negative Int32, which would never match the positive code.
$ResultText = @{
  '0' = 'last start succeeded'; '41301' = 'running now'; '41303' = 'has not run yet'; '41306' = 'stopped by a user or by startup:stop'
  '800710E0' = 'Windows refused to start it (a condition or policy)'; '80070002' = 'a file the task starts was not found'
  '8007010B' = 'its working folder does not exist'; '1' = 'the launcher exited with an error'
}

function Show-Doctor {
  # A diagnosis must always run to the end: native stderr (git with no upstream, dsregcmd) must not stop it under 'Stop'.
  $ErrorActionPreference = 'Continue'
  $findings = New-Object System.Collections.Generic.List[string]
  $me = "$env:USERDOMAIN\$env:USERNAME"
  Write-Host "NexPulse startup doctor  ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))"
  Write-Host "Folder:     $root"
  Write-Host "Windows:    $((Get-CimInstance Win32_OperatingSystem).Caption) as $me"
  $joined = (dsregcmd /status 2>$null | Select-String 'AzureAdJoined|DomainJoined' | ForEach-Object { $_.Line.Trim() -replace '\s+', ' ' }) -join ', '
  if ($joined) { Write-Host "Joined:     $joined" }

  $task = Get-Task
  if (-not $task) {
    $findings.Add('The startup task is not installed, so nothing starts the server after a restart. Run: bun run startup:install')
  } else {
    $info = $task | Get-ScheduledTaskInfo
    $lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { 'never' }
    $code = [int64] $info.LastTaskResult -band 0xFFFFFFFF
    $text = $ResultText['{0:X}' -f $code]; if (-not $text) { $text = 'unknown code' }
    Write-Host ("Task:       {0}, last run {1}, result 0x{2:X} ({3})" -f $task.State, $lastRun, $code, $text)
    foreach ($t in $task.Triggers) { Write-Host ("Trigger:    {0}" -f (Format-Trigger $t)) }
    Write-Host ("Starts:     {0} {1}" -f $task.Actions[0].Execute, $task.Actions[0].Arguments)
    if ($task.Actions[0].Execute -notmatch 'wscript') {
      $findings.Add('The task was registered by an older version: it starts PowerShell directly, which shows a Terminal window at sign-in; closing it stops the server. Run: bun run startup:install')
    }
    if (-not ($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskSessionStateChangeTrigger' })) {
      $findings.Add('The task has no restart-at-unlock trigger yet, so a stopped server waits for the next sign-in. Run: bun run startup:install')
    }
    $logon = $task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } | Select-Object -First 1
    if ($logon -and $logon.UserId -and $logon.UserId -ne $me) {
      $findings.Add("The task starts at logon of '$($logon.UserId)', but you are '$me', so it never fires for you. Run: bun run startup:install")
    }
    $bunPath = ([regex]::Matches($task.Actions[0].Arguments, '"([^"]+)"') | Select-Object -Index 2).Groups[1].Value
    if ($bunPath -and -not (Test-Path $bunPath)) { $findings.Add("The task runs Bun from '$bunPath', which no longer exists (Bun moved or was reinstalled). Run: bun run startup:install") }
    if ($code -notin 0x0, 0x41301, 0x41303, 0x41306) { $findings.Add(("The last start failed: 0x{0:X} ({1}). The log below usually says why." -f $code, $text)) }
  }

  $listening = Test-Listening
  Write-Host ("Server:     {0}" -f $(if ($listening) { "listening on http://127.0.0.1:$port" } else { "not listening on port $port" }))
  if (-not $listening -and $task) {
    $findings.Add('The server is not running. Start it now: bun run startup:restart. The log below shows why it stopped.')
  }

  $wsh = @('HKCU:', 'HKLM:') | ForEach-Object { (Get-ItemProperty "$_\Software\Microsoft\Windows Script Host\Settings" -ErrorAction SilentlyContinue).Enabled } | Where-Object { $_ -ne $null }
  if ($wsh -contains 0) { $findings.Add('Windows Script Host is turned off by policy, so the hidden launcher (wscript.exe) cannot run. Ask IT, or start the server by hand: bun run start') }
  if (Get-Service CSFalconService -ErrorAction SilentlyContinue) {
    Write-Host 'Security:   CrowdStrike Falcon is installed (if a Falcon notice appeared at sign-in, it may have blocked wscript/PowerShell)'
  }
  $gitStatus = & git -C $root status --porcelain --untracked-files=no 2>$null
  $upstream = & git -C $root rev-parse --abbrev-ref '@{u}' 2>$null
  Write-Host ("Code:       {0} at {1}{2}" -f $(if ($upstream) { "tracking $upstream" } else { 'no upstream' }), (& git -C $root rev-parse --short HEAD 2>$null), $(if ($gitStatus) { ', local changes (auto-update paused)' } else { '' }))

  foreach ($pair in @(@('server.log', 30), @('server.prev.log', 15))) {
    $path = Join-Path $root "data\$($pair[0])"
    Write-Host ''
    Write-Host "--- last lines of data\$($pair[0]):"
    if (Test-Path $path) { Get-Content $path -Tail $pair[1] | ForEach-Object { Write-Host "  $_" } } else { Write-Host '  (none)' }
  }

  Write-Host ''
  if ($findings.Count -eq 0) { Write-Host 'No problems found.' -ForegroundColor Green }
  else {
    Write-Host 'Problems found:' -ForegroundColor Yellow
    $i = 0; foreach ($f in $findings) { $i++; Write-Host "  $i. $f" -ForegroundColor Yellow }
  }
}

switch ($Verb) {
  'install'   { Install-Task }
  'uninstall' { Uninstall-Task }
  'status'    { Show-Status }
  'restart'   { if (-not $NoUpdate) { Update-Checkout }; Stop-Task; if (-not (Start-Task)) { exit 1 } }
  'stop'      { if (Get-Task) { Stop-Task } else { Write-Host "Task '$TaskName' is not installed." } }
  'doctor'    { Show-Doctor }
}
