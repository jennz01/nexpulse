<#
Manage the Windows scheduled task that starts the dashboard server hidden at logon.

  bun run startup:install     register the task for the current user and start it now
  bun run startup:status      task state, last result, whether the server is listening
  bun run startup:restart     stop and start again (after `bun run build` or a config edit)
  bun run startup:stop        stop the server (frees port 6600 for `bun run dev`)
  bun run startup:uninstall   stop and remove the task

Direct form: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup.ps1 <verb>
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'status', 'restart', 'stop')]
  [string] $Verb = 'status'
)
$ErrorActionPreference = 'Stop'

$TaskName = 'NexPulse'
$root = Split-Path -Parent $PSScriptRoot
$serveScript = Join-Path $PSScriptRoot 'serve.ps1'
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
  if (-not $task -or $task.State -ne 'Running') { return }
  # Task Scheduler ends the supervisor but not its bun child, so collect the tree first and kill both.
  $children = @()
  foreach ($supervisor in @(Get-SupervisorProcesses)) {
    $children += @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($supervisor.ProcessId) AND Name = 'bun.exe'")
  }
  Stop-ScheduledTask -TaskName $TaskName
  foreach ($child in $children) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not (Wait-Stopped)) { Write-Warning "port $port is still in use after stopping the task" }
  Write-Host "Stopped '$TaskName'."
}

function Start-Task {
  $task = Get-Task
  if (-not $task) { throw "Task '$TaskName' is not installed. Run: bun run startup:install" }
  Start-ScheduledTask -TaskName $TaskName
  if (Wait-Listening) { Write-Host "Server is listening on http://127.0.0.1:$port" }
  else { Write-Warning "task started but nothing is listening on port $port yet; see $logFile" }
}

function Install-Task {
  $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
  if (-not $bun) { throw 'bun.exe was not found on PATH. Install Bun (https://bun.sh) and open a new terminal.' }
  if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) {
    Write-Warning 'web\dist is not built; the server will serve a placeholder page until you run `bun run build` and `bun run startup:restart`.'
  }

  Stop-Task
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$serveScript`" -Bun `"$bun`""
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root

  $user = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = 'PT15S'  # let the network come up before the first polls

  # ExecutionTimeLimit zero disables the default 3-day cap that would otherwise kill a long-running task.
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  # Interactive = "run only when user is logged on": the server inherits your profile, so gh and lark-cli find their logins.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "NexPulse dashboard server (bun) on http://127.0.0.1:$port, started hidden at logon. Managed by $root\scripts\startup.ps1" `
    -Force | Out-Null
  Write-Host "Registered task '$TaskName' to start at logon of $user."
  Start-Task
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
    Write-Host ("Trigger:    at logon of {0}, after {1}" -f $task.Principal.UserId, $task.Triggers[0].Delay)
    Write-Host ("Last run:   {0} (result 0x{1:X})" -f $lastRun, $info.LastTaskResult)
    Write-Host ("Command:    {0} {1}" -f $task.Actions[0].Execute, $task.Actions[0].Arguments)
    Write-Host ("Log:        {0}" -f $logFile)
  }
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { Write-Host "Server:     listening on http://127.0.0.1:$port (pid $($listener.OwningProcess))" }
  else { Write-Host "Server:     not listening on port $port" }
}

switch ($Verb) {
  'install'   { Install-Task }
  'uninstall' { Uninstall-Task }
  'status'    { Show-Status }
  'restart'   { Stop-Task; Start-Task }
  'stop'      { if (Get-Task) { Stop-Task } else { Write-Host "Task '$TaskName' is not installed." } }
}
