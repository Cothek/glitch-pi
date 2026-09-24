<#
.SYNOPSIS
    Stops the Pi web UI stack (pi-web-ui + auth proxy), however it was started.
.DESCRIPTION
    Finds whatever is LISTENING on the stack ports and kills each process tree
    (taskkill /T) so the node children die with their cmd.exe/powershell parent.

    Works for both start modes:
      - headless  (start-detached.ps1, CREATE_NO_WINDOW)
      - windowed  (a visible window running pi-stack-window.ps1)

    Killing a windowed stack from here also leaves that window sitting at its
    prompt - close it afterwards.

.PARAMETER WebPort
    pi-web-ui port. Default 8787.
.PARAMETER AuthPort
    Auth proxy port. Default 4103.

.EXAMPLE
    .\scripts\stop-pi-stack.ps1
    .\scripts\stop-pi-stack.ps1 -WebPort 8799 -AuthPort 4199
#>
param(
    [int]$WebPort = 8787,
    [int]$AuthPort = 4103
)

# NOTE: deliberately NOT [int[]]$Ports. Invoked with -File, PowerShell passes
# "8799,4199" as one literal string and casts it to a single int (87994199),
# so an array parameter silently targets a nonexistent port. Named scalars
# match start-pi-stack.ps1 and cannot be mis-parsed.
$Ports = @($WebPort, $AuthPort)

$ErrorActionPreference = "Continue"

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
