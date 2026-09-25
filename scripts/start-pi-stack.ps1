<#
.SYNOPSIS
    Starts the Pi web stack: pi-web-ui (:8787) + auth proxy (:4103) + Cloudflare tunnel.
.DESCRIPTION
    Two start modes:

    DETACHED (default) - both layers are launched with CREATE_NO_WINDOW via
    start-detached.ps1 and survive closing every shell. Nothing appears on
    screen; use this when the stack must outlive your terminal (remote access
    from your phone while you walk away).

    WINDOWED (-Windowed) - one visible PowerShell window that runs the whole
    stack in its foreground: pi-web-ui blocking, auth proxy as a child on the
    same console. CLOSE THAT WINDOW and both layers stop. Use this when you want
    to see the server and kill it by closing a window.

    Either way the login banner (username, password, local + remote URL,
    one-click auth_token link) is printed by the shared helper so this script
    and launch-pi.mjs can never drift apart.

    TUNNEL - after both ports are confirmed bound, the Cloudflare tunnel is
    ensured through scripts\lib\tunnel.mjs (the single lifecycle owner, also
    used by stop-pi-stack.ps1 and the tunnel-keeper extension). Detached mode
    spawns cloudflared detached so it survives closing every shell; windowed
    mode runs it as a child of the visible window so closing that window stops
    the tunnel too. The tunnel is only started when the auth proxy is up; a
    tunnel pointing at a dead origin is worse than no tunnel. -NoTunnel skips
    it for local-only runs.

    Re-running is safe: any layer already listening is skipped. Port checks poll
    until the socket is really bound, so a slow pi-web-ui boot is never reported
    as a failure.
.EXAMPLE
    .\scripts\start-pi-stack.ps1                  # detached
    .\scripts\start-pi-stack.ps1 -Windowed        # visible window you can close
    .\scripts\start-pi-stack.ps1 -Status          # check only, do not start
    .\scripts\start-pi-stack.ps1 -NoTunnel        # local only, no Cloudflare
    .\scripts\start-pi-stack.ps1 -WebPort 8799 -AuthPort 4199   # alternate ports
#>
param(
    [switch]$Status,
    [switch]$Windowed,
    [int]$WebPort = 8787,
    [int]$AuthPort = 4103,
    [switch]$NoBrowser,
    [switch]$NoTunnel
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $RootDir "data\node\node.exe"
$AuthProxy = Join-Path $RootDir "plugins\auth-proxy.mjs"
$LauncherCmd = Join-Path $env:USERPROFILE "pi-web-ui-launcher.cmd"
$LogDir = Join-Path $RootDir "data\logs"
$TunnelScript = Join-Path $RootDir "scripts\lib\tunnel.mjs"

function Test-Port([int]$Port) {
    $conn = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
    return [bool]$conn
}

# Poll until the socket is actually bound. A fixed Start-Sleep was the old bug:
# pi-web-ui needs ~10s to boot (SDK + plugins), so a 5s sleep reported a healthy
# server as "failed to start".
function Wait-Port([int]$Port, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-Status {
    [pscustomobject]@{
        PiWebUi   = Test-Port $WebPort
        AuthProxy = Test-Port $AuthPort
    }
}

# ---- Cloudflare tunnel ----------------------------------------------------
# All tunnel logic lives in scripts\lib\tunnel.mjs: it owns the ownership
# record (data\cloudflared-auto.pid) and refuses to kill a cloudflared this
# repo did not start, so these helpers only ever call it and report the result.

# One-line tunnel state for status output, e.g. "UP (PID 12504, started by
# this stack)" or "DOWN". Never throws: a tunnel readout must not break a start.
function Get-TunnelLine {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if (-not (Test-Path $TunnelScript)) { return "unknown (tunnel.mjs missing)" }
        $out = & $NodeExe $TunnelScript status | Select-Object -First 1
        if (-not $out) { return "unknown" }
        return ($out -replace '^\s*cloudflared:\s*', '')
    } catch {
        return "unknown"
    } finally {
        $ErrorActionPreference = $prev
    }
}

# Ensure the tunnel is up. Returns "up" | "down" | "skipped" | "n/a".
function Ensure-Tunnel {
    if ($NoTunnel) {
        Write-Host "  tunnel: skipped (-NoTunnel)" -ForegroundColor DarkGray
        return "skipped"
    }
    if (-not (Test-Path $TunnelScript)) {
        Write-Host "  tunnel: cannot start - $TunnelScript missing" -ForegroundColor Yellow
        return "n/a"
    }
    Write-Host "Ensuring Cloudflare tunnel..."
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $NodeExe $TunnelScript start | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -eq 0) {
        Write-Host "  tunnel: UP ($(Get-TunnelLine))" -ForegroundColor Green
        return "up"
    }
    Write-Host "  tunnel: DOWN - see $LogDir\cloudflared-tunnel.err.log" -ForegroundColor Yellow
    return "down"
}

function Show-LoginBanner {
    $ShowCreds = Join-Path $RootDir "scripts\show-credentials.mjs"
    if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
    if (Test-Path $ShowCreds) {
        $env:GLITCH_PI_WEBUI_PORT = "$WebPort"
        $env:GLITCH_PI_AUTH_PORT = "$AuthPort"
        $credArgs = @()
        if (-not $Host.UI.SupportsVirtualTerminal) { $credArgs += "--plain" }
        & $NodeExe $ShowCreds @credArgs
    } else {
        Write-Host "  Remote: https://glitch.cothekdesigns.com  (auth via .server-password)"
    }
}

$stackStatus = Get-Status
if ($Status) {
    Write-Host "Pi stack status:"
    Write-Host "  pi-web-ui  ($WebPort): $(if ($stackStatus.PiWebUi) {'UP'} else {'DOWN'})"
    Write-Host "  auth-proxy ($AuthPort): $(if ($stackStatus.AuthProxy) {'UP'} else {'DOWN'})"
    Write-Host "  tunnel (cloudflared): $(Get-TunnelLine)"
    exit 0
}

# ---------------------------------------------------------------- WINDOWED --
if ($Windowed) {
    $manager = Join-Path $RootDir "scripts\start-pi-stack-window.ps1"
    if (-not (Test-Path $manager)) { Write-Error "Missing: $manager"; exit 1 }

    $winArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$manager`" -WebPort $WebPort -AuthPort $AuthPort"
    if ($NoBrowser) { $winArgs += " -NoBrowser" }
    if ($NoTunnel) { $winArgs += " -NoTunnel" }

    # The manager refuses when a layer is already listening, so check first and
    # report that plainly instead of opening a window that immediately exits.
    if ($stackStatus.PiWebUi -and $stackStatus.AuthProxy) {
        Write-Host "Both layers already UP (:$WebPort, :$AuthPort) - not opening a duplicate window."
        Write-Host "Stop them first: .\scripts\stop-pi-stack.ps1"
        # No window means nothing would own the tunnel, so repair it here
        # instead of exiting with a stack that is local-only.
        Ensure-Tunnel | Out-Null
        Write-Host ""
        Write-Host "  tunnel (cloudflared): $(Get-TunnelLine)"
        exit 0
    }
    if ($stackStatus.PiWebUi -or $stackStatus.AuthProxy) {
        Write-Warning "One layer is already listening on its port - stop the running stack first:"
        Write-Host "  .\scripts\stop-pi-stack.ps1   (or close the Pi web UI window)"
        exit 1
    }

    # No banner here on purpose: the window prints it (and launch-pi.mjs prints
    # its own), so echoing it again would scatter the password across consoles.
    & powershell -NoProfile -ExecutionPolicy Bypass -File $manager -WebPort $WebPort -AuthPort $AuthPort @($(if ($NoBrowser) { '-NoBrowser' } else { @() }))

    $stackStatus = Get-Status
    if ($stackStatus.PiWebUi -and $stackStatus.AuthProxy) {
        Write-Host ""
        Write-Host "The Pi web UI window is running the stack." -ForegroundColor Green
        Write-Host "  tunnel (cloudflared): $(Get-TunnelLine)" -ForegroundColor DarkGray
        Write-Host "  CLOSE THAT WINDOW to stop all three layers (web UI, auth proxy, tunnel)." -ForegroundColor DarkGray
        Write-Host "  Login details are printed in it." -ForegroundColor DarkGray
        exit 0
    } else {
        Write-Error "A layer did not come up - see the Pi web UI window for the error"
        exit 1
    }
}

# ---------------------------------------------------------------- DETACHED --
if (-not (Test-Path $LauncherCmd)) {
    Write-Error "Missing launcher: $LauncherCmd"
    exit 1
}
if (-not (Test-Path (Join-Path $RootDir ".server-password"))) {
    Write-Error ".server-password not found - auth proxy cannot start"
    exit 1
}

# 1. pi-web-ui
if ($stackStatus.PiWebUi) {
    Write-Host "pi-web-ui already UP on :$WebPort (skipping)"
} else {
    Write-Host "Starting pi-web-ui on 0.0.0.0:$WebPort..."
    & (Join-Path $RootDir "scripts\start-detached.ps1") -Command $LauncherCmd -Name "pi-web-ui"
    if (-not (Wait-Port $WebPort 60)) {
        Write-Host "  pi-web-ui did not bind :$WebPort within 60s - check $LogDir\pi-web-ui.err.log" -ForegroundColor Yellow
    }
}

# 2. auth proxy (4103 -> 8787)
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }
if ($stackStatus.AuthProxy) {
    Write-Host "auth-proxy already UP on :$AuthPort (skipping)"
} else {
    Write-Host "Starting auth-proxy on :$AuthPort -> :$WebPort..."
    $cmd = "`"$NodeExe`" `"$AuthProxy`" $AuthPort http://localhost:$WebPort"
    & (Join-Path $RootDir "scripts\start-detached.ps1") -Command $cmd -Name "auth-proxy-pi"
    if (-not (Wait-Port $AuthPort 20)) {
        Write-Host "  auth-proxy did not bind :$AuthPort within 20s - check $LogDir\auth-proxy-pi.err.log" -ForegroundColor Yellow
    }
}

# 3. Cloudflare tunnel - only once the auth proxy really answers, because
#    glitch.cothekdesigns.com routes to :$AuthPort. A tunnel with no origin just
#    serves 502s, so it is skipped rather than started blind.
if (-not (Wait-Port $AuthPort 5)) {
    Write-Host "Cloudflare tunnel skipped - auth-proxy :$AuthPort is down (tunnel would point at nothing)" -ForegroundColor Yellow
} else {
    Ensure-Tunnel | Out-Null
}

# Verify
$stackStatus = Get-Status
Write-Host ""
Write-Host "Result:"
Write-Host "  pi-web-ui  ($WebPort): $(if ($stackStatus.PiWebUi) {'UP'} else {'DOWN'})"
Write-Host "  auth-proxy ($AuthPort): $(if ($stackStatus.AuthProxy) {'UP'} else {'DOWN'})"
Write-Host "  tunnel (cloudflared): $(Get-TunnelLine)"
if ($stackStatus.PiWebUi -and $stackStatus.AuthProxy) {
    Show-LoginBanner
    Write-Host "  Started detached - nothing to close. To stop:" -ForegroundColor DarkGray
    Write-Host "    .\scripts\stop-pi-stack.ps1" -ForegroundColor DarkGray
    exit 0
} else {
    Write-Error "One or more layers failed to start - check $LogDir\*.err.log"
    exit 1
}
