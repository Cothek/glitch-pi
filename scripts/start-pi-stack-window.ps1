<#
.SYNOPSIS
    Starts the Pi web UI stack in a VISIBLE PowerShell window you can close to stop it.
.DESCRIPTION
    Opens one PowerShell window that runs scripts\pi-stack-window.ps1. That
    window is the server: pi-web-ui runs in its foreground and the auth proxy is
    a child on the same console, so closing the window stops both layers.

    This is the visible counterpart of start-pi-stack.ps1, which starts the
    same stack detached (CREATE_NO_WINDOW) so it survives closing every shell.

    Refuses to start when a layer is already listening - stop the running stack
    first with .\scripts\stop-pi-stack.ps1.
.EXAMPLE
    .\scripts\start-pi-stack-window.ps1
    .\scripts\start-pi-stack-window.ps1 -WebPort 8799 -AuthPort 4199 -NoBrowser
#>
param(
    [int]$WebPort = 8787,
    [int]$AuthPort = 4103,
    [switch]$NoBrowser,
    [switch]$NoTunnel
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $RootDir "data\node\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
$Body = Join-Path $RootDir "scripts\pi-stack-window.ps1"
$TunnelScript = Join-Path $RootDir "scripts\lib\tunnel.mjs"

function Test-Port([int]$Port) {
    [bool](netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING")
}

if (-not (Test-Path $Body)) { Write-Error "Missing: $Body"; exit 1 }

$busy = @()
if (Test-Port $WebPort) { $busy += "pi-web-ui :$WebPort" }
if (Test-Port $AuthPort) { $busy += "auth proxy :$AuthPort" }
if ($busy.Count -gt 0) {
    Write-Host "Already listening: $($busy -join ', ')" -ForegroundColor Yellow
    Write-Host "Stop the running stack first:  .\scripts\stop-pi-stack.ps1" -ForegroundColor DarkGray
    Write-Host "Check status:                  .\scripts\start-pi-stack.ps1 -Status" -ForegroundColor DarkGray
    exit 1
}

# Launch the window. -NoExit keeps it open if the server crashes, so the error
# stays readable instead of vanishing with the window.
$psArgs = "-NoExit -ExecutionPolicy Bypass -File `"$Body`" -WebPort $WebPort -AuthPort $AuthPort"
if ($NoBrowser) { $psArgs += " -NoBrowser" }
if ($NoTunnel) { $psArgs += " -NoTunnel" }
$win = Start-Process powershell -ArgumentList $psArgs -WorkingDirectory $RootDir -PassThru

Write-Host "Opening Pi web UI window (PID $($win.Id))..." -ForegroundColor Cyan

# Wait for both layers so this script reports the truth instead of guessing.
function Wait-Port([int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

$webUp = Wait-Port $WebPort 60
$authUp = Wait-Port $AuthPort 20

# The tunnel is started by the window body (it owns the child), so read its
# state from the shared ownership record instead of guessing.
$tunnelLine = "unknown"
if (Test-Path $TunnelScript) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $line = & $NodeExe $TunnelScript status | Select-Object -First 1
        if ($line) { $tunnelLine = ($line -replace '^\s*cloudflared:\s*', '') }
    } catch { $tunnelLine = "unknown" } finally { $ErrorActionPreference = $prev }
}

Write-Host ""
Write-Host "Result:"
Write-Host "  pi-web-ui  ($WebPort): $(if ($webUp) {'UP'} else {'DOWN'})"
Write-Host "  auth-proxy ($AuthPort): $(if ($authUp) {'UP'} else {'DOWN'})"
Write-Host "  tunnel (cloudflared): $(if ($NoTunnel) {'skipped (-NoTunnel)'} else {$tunnelLine})"

if ($webUp -and $authUp) {
    Write-Host ""
    Write-Host "  Close the Pi web UI window (PID $($win.Id)) to stop the stack (web UI," -ForegroundColor DarkGray
    Write-Host "  auth proxy, and any tunnel that window started)." -ForegroundColor DarkGray
    exit 0
} else {
    Write-Host ""
    Write-Host "  A layer did not come up in time - check that window for the error." -ForegroundColor Yellow
    exit 1
}
