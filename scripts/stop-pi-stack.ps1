<#
.SYNOPSIS
    Stops the Pi web UI stack (pi-web-ui + auth proxy), however it was started.
.DESCRIPTION
    Finds whatever is LISTENING on the stack ports and kills each process tree
    (taskkill /T) so the node children die with their cmd.exe/powershell parent.

    Works for both start modes:
      - headless  (start-detached.ps1, CREATE_NO_WINDOW)
      - windowed  (a visible window running pi-stack-window.ps1)

    Then stops the Cloudflare tunnel through scripts\lib\tunnel.mjs, the same
    module that starts it. A tunnel left behind after the stack is down just
    serves 502s for glitch.cothekdesigns.com, so the two scripts must not drift.
    Only a tunnel this repo started (recorded in data\cloudflared-auto.pid) is
    stopped; one started by hand is reported and left running.

    Killing a windowed stack from here also leaves that window sitting at its
    prompt - close it afterwards.

.PARAMETER WebPort
    pi-web-ui port. Default 8787.
.PARAMETER AuthPort
    Auth proxy port. Default 4103.
.PARAMETER NoTunnel
    Stop the stack but leave the Cloudflare tunnel running (useful when the
    tunnel is serving something else, or when you are restarting only the web
    layers and do not want the public URL to blink).

.EXAMPLE
    .\scripts\stop-pi-stack.ps1
    .\scripts\stop-pi-stack.ps1 -WebPort 8799 -AuthPort 4199
    .\scripts\stop-pi-stack.ps1 -NoTunnel
#>
param(
    [int]$WebPort = 8787,
    [int]$AuthPort = 4103,
    [switch]$NoTunnel
)

# NOTE: deliberately NOT [int[]]$Ports. Invoked with -File, PowerShell passes
# "8799,4199" as one literal string and casts it to a single int (87994199),
# so an array parameter silently targets a nonexistent port. Named scalars
# match start-pi-stack.ps1 and cannot be mis-parsed.
$Ports = @($WebPort, $AuthPort)

$ErrorActionPreference = "Continue"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $RootDir "data\node\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
$TunnelScript = Join-Path $RootDir "scripts\lib\tunnel.mjs"

function Get-ListenerPids([int]$Port) {
    netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING" |
        ForEach-Object { ($_ -replace '.*\s(\d+)$', '$1') } | Sort-Object -Unique
}

foreach ($port in $Ports) {
    $pids = Get-ListenerPids $port
    if (-not $pids) {
        Write-Host "Nothing listening on :$port"
        continue
    }
    foreach ($procId in $pids) {
        try {
            $p = Get-Process -Id $procId -ErrorAction Stop
            Write-Host "Stopping $($p.ProcessName) (PID $procId) on :$port"
            # Kill the process tree so child node processes die too. Output is
            # swallowed: a sibling may already be gone because the window script
            # reaps its own proxy child in its finally block.
            & taskkill /PID $procId /T /F 2>&1 | Out-Null
        } catch {
            Write-Host "Could not stop PID $procId on :$port - $($_.Exception.Message)"
        }
    }
}

# ---- Cloudflare tunnel ----------------------------------------------------
# Through the owning module, so the ownership rule (pidfile = ours) is applied
# in exactly one place. A tunnel this repo did not start is reported, not killed.
if ($NoTunnel) {
    Write-Host ""
    Write-Host "Tunnel: left running (-NoTunnel)"
} elseif (-not (Test-Path $TunnelScript)) {
    Write-Host ""
    Write-Host "Tunnel: cannot stop - $TunnelScript missing" -ForegroundColor Yellow
} else {
    Write-Host ""
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $NodeExe $TunnelScript stop | ForEach-Object { Write-Host $_ }
    } finally {
        $ErrorActionPreference = $prev
    }
}

Start-Sleep -Seconds 1
Write-Host ""
$remaining = @()
foreach ($port in $Ports) {
    $up = [bool](Get-ListenerPids $port)
    if ($up) { $remaining += $port }
    Write-Host "  :$port $(if ($up) {'STILL UP'} else {'down'})"
}
if ($remaining.Count -gt 0) {
    Write-Host ""
    Write-Host "  Some ports are still held - check with: netstat -ano | findstr :$($remaining[0])" -ForegroundColor Yellow
}
