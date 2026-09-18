#!/usr/bin/env bash
# Bash entry point for scripts/setup.ps1, for Git Bash (or MSYS2 / Cygwin) on Windows.
#
# The setup itself is Windows-only (winget, Task Scheduler), so this file does not
# reimplement it: it finds PowerShell and runs setup.ps1 with the same arguments.
#
#   bash scripts/setup.sh              # same as: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup.ps1
#   bash scripts/setup.sh -NoStartup   # switches pass straight through to setup.ps1 (-NoStartup, -NoBuild)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/setup.ps1"

# Windows PowerShell 5.1 ships with Windows and is what startup.ps1 is written for; pwsh (7+) also works.
if command -v powershell.exe >/dev/null 2>&1; then ps=powershell.exe
elif command -v powershell >/dev/null 2>&1; then ps=powershell
elif command -v pwsh >/dev/null 2>&1; then ps=pwsh
else
  echo "setup.sh: PowerShell was not found on PATH." >&2
  echo "NexPulse setup targets Windows (winget, Task Scheduler). Run this from Git Bash on Windows," >&2
  echo "or run scripts/setup.ps1 from a PowerShell window." >&2
  exit 1
fi

# Git Bash normally converts /d/work/... to D:\work\... for native programs; make it explicit when cygpath exists.
if command -v cygpath >/dev/null 2>&1; then script="$(cygpath -w "$script")"; fi

# Under mintty (the default Git Bash window) native console programs need winpty for interactive prompts
# such as `gh auth login`. Windows Terminal and the VS Code terminal do not.
if [[ "${TERM_PROGRAM:-}" == "mintty" ]] && command -v winpty >/dev/null 2>&1; then
  exec winpty "$ps" -NoProfile -ExecutionPolicy Bypass -File "$script" "$@"
fi
exec "$ps" -NoProfile -ExecutionPolicy Bypass -File "$script" "$@"
