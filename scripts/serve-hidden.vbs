' Starts the NexPulse supervisor with no console window at all.
'
' scripts\startup.ps1 points the scheduled task here rather than straight at powershell.exe. powershell.exe is a
' console program, so Windows hands its console to the default terminal application; on Windows 11 that is Windows
' Terminal, which then saves the hidden server into its persisted window layout and relaunches it on its own at the
' next start -- a second supervisor rotating away the live log and fighting the first one for port 6600.
' wscript.exe is a GUI program, so there is no console to hand over: the child gets a plain hidden conhost and
' Terminal never learns it exists.
'
'   wscript.exe serve-hidden.vbs <path to serve.ps1> <path to bun.exe> [-NoUpdate]

Option Explicit
Dim shell, quote, command

If WScript.Arguments.Count < 2 Then WScript.Quit 2

Set shell = CreateObject("WScript.Shell")
quote = Chr(34)

command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass" & _
          " -File " & quote & WScript.Arguments(0) & quote & _
          " -Bun " & quote & WScript.Arguments(1) & quote
If WScript.Arguments.Count > 2 Then command = command & " " & WScript.Arguments(2)

' 0 hides the window; True waits, so the scheduled task keeps reporting Running for as long as the server lives.
WScript.Quit shell.Run(command, 0, True)
