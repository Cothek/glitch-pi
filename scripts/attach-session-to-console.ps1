<#
.SYNOPSIS
  Redirect the current user's session to the console so rendering never stops
  when the RDP window is closed or minimized. Requires the Parsec Virtual
  Display Driver (installed by install-headless-display.ps1).

.DESCRIPTION
  Windows stops rendering RDP sessions when they are disconnected or minimized,
  which breaks every GDI-based screen capture (including cua-driver). Moving the
  session to the console keeps rendering alive because the VDD always presents a
  display surface. This is the standard headless automation setup.

  Idempotent: if the session is already on the console, exits 0.

  Elevation: one UAC prompt (tscon is admin-only).

.NOTES
  After running this, the RDP client window may briefly show a blank screen;
  that's normal, the session moved. Reconnect RDP if you want to watch.
#>

$ErrorActionPreference = "Stop"

# --- detect the user's own session -----------------------------------------
$me = $env:USERNAME
$lines = quser 2>$null | Where-Object { $_ -match [regex]::Escape($me) }
if (-not $lines) { Write-Host "ERROR: no session found for $me"; exit 1 }

$line = $lines[0]
$id = ($line -replace '^.*?\s+(\d+)\s+.*$', '$1')
$alreadyConsole = $line -match '\bconsole\b'

Write-Host "session line: $line"

if ($alreadyConsole) {
  Write-Host "OK: session is already on the console (nothing to do)"
  exit 0
}

# --- elevate once and run tscon --------------------------------------------
$inner = "tscon $id /dest:console"
Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -WindowStyle Hidden -Command $inner"
Write-Host "UAC prompt shown for tscon (session $id -> console)"

# --- verify -----------------------------------------------------------------
Start-Sleep -Seconds 4
$now = quser | Where-Object { $_ -match [regex]::Escape($me) } | Select-Object -First 1
Write-Host "post: $now"
if ($now -match '\bconsole\b') {
  Write-Host "OK: session is on the console... GDI capture now works headless"
} else {
  Write-Host "NOTE: session line is '$now'. RDP disconnect may take a few seconds."
}
