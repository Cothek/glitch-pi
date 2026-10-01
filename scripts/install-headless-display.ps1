<#
.SYNOPSIS
  Install the Parsec Virtual Display Driver (VDD) so headless screen capture works.

.DESCRIPTION
  Windows stops rendering the desktop when no display exists (headless, RDP closed,
  RDP minimized). Every GDI screenshot then fails with 0x80070006 "handle is invalid",
  which blocks cua-driver (and everything else) from seeing the screen.

  The Parsec VDD installs a virtual display adapter that Windows always treats as
  connected, so capture works with no monitor and no RDP window.

  Elevated: this script asks for Administrator once (one UAC prompt). The driver
  install is inherently kernel-level; there is no admin-free path.

  Idempotent + self-verifying. Exit code 0 = driver installed and visible.

.NOTES
  Source: official Parsec build (builds.parsec.app), silent mode /S.
  Uninstall: Settings -> Apps -> Parsec Virtual Display Adapter, then reboot.
#>

$ErrorActionPreference = "Stop"

$vddUrl  = "https://builds.parsec.app/vdd/parsec-vdd-0.45.0.0.exe"
$vddExe  = Join-Path $env:TEMP "parsec-vdd-0.45.0.0.exe"
# Log under the installer's repo (scripts/ -> ../data/logs) so it stays portable across machines.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' )).Path
$logDir  = Join-Path $repoRoot "data\logs"
$logFile = Join-Path $logDir "install-headless-display.log"

function Log($msg) {
  New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
  $line = "{0} {1}" -f (Get-Date -Format o), $msg
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

# --- already installed? skip everything -----------------------------------
$existing = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match "Parsec" -and $_.Status -eq "OK" }
if ($existing) {
  Log "already installed: $($existing.FriendlyName)"
  exit 0
}

# --- download (user-level, no admin needed) --------------------------------
if (-not (Test-Path $vddExe)) {
  Log "downloading $vddUrl"
  Invoke-WebRequest -Uri $vddUrl -OutFile $vddExe -UseBasicParsing -TimeoutSec 180
}
$size = (Get-Item $vddExe).Length
if ($size -lt 500000) { Log "ERROR: download suspiciously small ($size bytes)"; exit 1 }
Log "downloaded $size bytes"

# --- elevated install (ONE UAC prompt here) ----------------------------------
Log "requesting elevation for silent install..."
$p = Start-Process -FilePath $vddExe -ArgumentList "/S" -Verb RunAs -Wait -PassThru
Log "installer exit code: $($p.ExitCode)"

# --- verify ------------------------------------------------------------------
Start-Sleep -Seconds 3
$vdd = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue |
  Where-Object { $_.FriendlyName -match "Parsec" }
if ($vdd -and $vdd.Status -eq "OK") {
  Log "OK: $($vdd.FriendlyName) is online (status: $($vdd.Status))"
  Log "headless capture should now work — no monitor or RDP window required"
  exit 0
} elseif ($vdd) {
  Log "WARN: VDD device exists but status is $($vdd.Status) — a reboot may be needed"
  exit 2
} else {
  Log "ERROR: Parsec display device not found after install"
  exit 1
}
