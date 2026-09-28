<#
.SYNOPSIS
    Stops the servers AROUND pi-web-ui: the auth proxy and the Cloudflare tunnel.
.DESCRIPTION
    Used by the stack-servers pi-web-ui plugin's "stack root" Stop button. That
    button has to take down the whole stack, but a script that kills the
    pi-web-ui listener with `taskkill /T` cannot be the one doing it: the script
    is itself a descendant of the pi-web-ui process, so the tree kill would end
    the script mid-run. The plugin therefore exits the host process ITSELF and
    spawns this script to stop everything else:

      1. auth proxy  - the process LISTENING on :AuthPort (tree-killed; the
                       proxy is never a descendant of pi-web-ui, so this is
                       safe from inside the host's tree)
      2. tunnel      - through scripts\lib\tunnel.mjs, the single owner of the
                       tunnel lifecycle and the pidfile ownership rule

    Deliberately NOT the same as scripts\stop-pi-stack.ps1: that one is the
    user-facing full stop (it kills pi-web-ui too, and closes parked windows).
    This script exists so the plugin's root stop can complete without killing
    the script that is running it.

.PARAMETER AuthPort
    Auth proxy port. Default 4103.
.PARAMETER NoTunnel
    Leave the Cloudflare tunnel running (local-only stop).
.EXAMPLE
    .\scripts\stop-stack-servers.ps1
#>
param(
    [int]$AuthPort = 4103,
    [switch]$NoTunnel
)

$ErrorActionPreference = "Continue"
$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $RootDir "data\node\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
$TunnelScript = Join-Path $RootDir "scripts\lib\tunnel.mjs"

function Get-ListenerPids([int]$Port) {
    netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING" |
        ForEach-Object { ($_ -replace '.*\s(\d+)$', '$1') } | Sort-Object -Unique
}

Write-Host "Stopping stack servers around pi-web-ui (auth proxy + tunnel)"

foreach ($procId in (Get-ListenerPids $AuthPort)) {
    try {
        Write-Host "  stopping auth proxy on :$AuthPort (PID $procId)"
        & taskkill /PID $procId /T /F 2>&1 | Out-Null
    } catch {
        Write-Host "  could not stop PID $procId - $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

if ($NoTunnel) {
    Write-Host "  tunnel: left running (-NoTunnel)"
} elseif (-not (Test-Path $TunnelScript)) {
    Write-Host "  tunnel: cannot stop - $TunnelScript missing" -ForegroundColor Yellow
} else {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $NodeExe $TunnelScript stop | ForEach-Object { Write-Host "  $_" }
    } finally {
        $ErrorActionPreference = $prev
    }
}

Start-Sleep -Milliseconds 800
$still = Get-ListenerPids $AuthPort
Write-Host "  auth proxy :$AuthPort $(if ($still) { 'STILL UP' } else { 'down' })"
