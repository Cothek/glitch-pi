<#
.SYNOPSIS
    Shared helper for finding and closing parked glitch stack windows.
.DESCRIPTION
    A windowed stack window (powershell.exe -NoExit -File scripts\pi-stack-window.ps1)
    PARKS at its prompt forever after scripts\stop-pi-stack.ps1 (or anything else)
    kills its child servers, because -NoExit keeps the console alive. Over
    stop/restart cycles these parked windows accumulate - the user then sees
    several "servers" running that own nothing.

    A window is STALE when:
      1. it is NOT the parent of any live listener on :WebPort / :AuthPort
         (the live windowed stack window IS that parent), AND
      2. the window process is older than MinAgeSeconds (default 90) - a young
         window may still be booting its children, which take up to 60s to
         bind their ports on a cold start.

    Dot-sourced by scripts\start-pi-stack.ps1 (before starting layers) and
    scripts\stop-pi-stack.ps1 (after killing them). Safe to call any time: it
    never touches the window that owns the live stack.

.NOTES
    No parameters at dot-source time; the functions take their own.
#>

function Get-PortListenerPids {
    param([int]$Port)
    # netstat -ano lines:  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    27488
    $pids = @()
    $lines = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $tokens = ($line.ToString().Trim()) -split '\s+'
        $last = $tokens[-1]
        if ($last -match '^\d+$') { $pids += [int]$last }
    }
    return ($pids | Sort-Object -Unique)
}

function Get-StackWindowProcesses {
    # PowerShell consoles running the stack window body. CommandLine match is
    # the discriminator (the window is always launched with -File ...\pi-stack-window.ps1).
    return @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*pi-stack-window.ps1*' })
}

function Stop-StaleStackWindows {
    param(
        [int]$WebPort = 8787,
        [int]$AuthPort = 4103,
        [int]$MinAgeSeconds = 90
    )

    $windows = Get-StackWindowProcesses
    if ($windows.Count -eq 0) { return }

    # The parent PIDs of the live stack listeners own the stack; never touch those.
    # Scan THIS run's ports PLUS the stack defaults (8787/4103). With custom
    # -WebPort/-AuthPort the defaults are absent from the list, so the live
    # window of a concurrently running stack (another install, or the default
    # instance this run is side-stepping) looked "parked" and got force-closed
    # (verified live: a -WebPort 8799 run closed a 29-hour-old production stack
    # window). Protecting a few extra PIDs is free; closing a live stack's
    # window is not.
    $ownerPorts = @($WebPort, $AuthPort, 8787, 4103) | Sort-Object -Unique
    $owners = @()
    foreach ($port in $ownerPorts) {
        foreach ($lpid in (Get-PortListenerPids -Port $port)) {
            try {
                $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $lpid").ParentProcessId
                if ($parent) { $owners += [int]$parent }
            } catch { }
        }
    }
    $owners = $owners | Sort-Object -Unique

    $closed = 0
    foreach ($win in $windows) {
        if ($owners -contains [int]$win.ProcessId) { continue }
        $ageSeconds = ((Get-Date) - $win.CreationDate).TotalSeconds
        if ($ageSeconds -lt $MinAgeSeconds) { continue }
        Write-Host "closing parked stack window (PID $($win.ProcessId), age $([int]$ageSeconds)s)"
        try {
            Stop-Process -Id $win.ProcessId -Force -ErrorAction Stop
            $closed++
        } catch {
            Write-Host "  could not close PID $($win.ProcessId): $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    if ($closed -gt 0) {
        Write-Host "closed $closed parked stack window(s)"
    }
}
