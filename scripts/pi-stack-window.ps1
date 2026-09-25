<#
.SYNOPSIS
    Runs the Pi web UI stack INSIDE this PowerShell window (foreground).
.DESCRIPTION
    This is the body that runs in a visible window opened by
    start-pi-stack.ps1 -Windowed (or start-pi-stack-window.ps1).

    Three layers, all attached to THIS console:
      1. auth-proxy   - child process sharing this console (localhost:<AuthPort> -> <WebPort>)
      2. cloudflared  - child process sharing this console, only when no tunnel
                        is already running (skipped otherwise, and never killed
                        unless this window started it)
      3. pi-web-ui    - the FOREGROUND process (0.0.0.0:<WebPort>)

    Because all of them run on this window's console, CLOSING THE WINDOW stops
    the whole stack (Windows terminates every process attached to the console).
    Ctrl+C stops it the same way, and the finally block reaps the children.

    That is the point of windowed mode: the tunnel does not outlive the stack,
    so glitch.cothekdesigns.com never keeps pointing at a dead origin. The detached
    stack (start-pi-stack.ps1) is the opposite - there the tunnel is spawned
    detached too, so it survives closing every shell.

    This is the opposite of start-detached.ps1, which starts the stack with
    CREATE_NO_WINDOW so it survives closing every terminal. Use windowed mode
    when you want to see the server and kill it by closing the window; use the
    detached default when the server must outlive your shell.

.PARAMETER WebPort
    Port for pi-web-ui. Default 8787.
.PARAMETER AuthPort
    Port for the auth proxy. Default 4103.
.PARAMETER NoBrowser
    Pass --no-browser to pi-web-ui (otherwise it opens the browser itself).
.PARAMETER NoTunnel
    Do not start the Cloudflare tunnel in this window (local-only stack).

.EXAMPLE
    .\scripts\pi-stack-window.ps1
    .\scripts\pi-stack-window.ps1 -WebPort 8799 -AuthPort 4199 -NoBrowser
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
$WebEntry = Join-Path $RootDir "data\node\node_modules\pi-web-ui\bin\pi-web-ui.mjs"
$AuthProxy = Join-Path $RootDir "plugins\auth-proxy.mjs"
$LauncherCmd = Join-Path $env:USERPROFILE "pi-web-ui-launcher.cmd"

# ---- Cloudflare tunnel (windowed) -----------------------------------------
# Same assets the detached path resolves in scripts\lib\tunnel.mjs; the env
# overrides are honored identically so both paths agree. This window starts
# cloudflared ATTACHED to its console (that is what makes closing the window
# stop the tunnel) and records the PID in data\cloudflared-auto.pid - the same
# ownership record tunnel.mjs reads, so 'stop-pi-stack.ps1' and 'status' stay
# accurate for a window-owned tunnel.
$TunnelScript = Join-Path $RootDir "scripts\lib\tunnel.mjs"
$CloudflaredBin = if ($env:GLITCH_TUNNEL_BIN) { $env:GLITCH_TUNNEL_BIN } else { Join-Path $RootDir "cloudflared.exe" }
$TunnelConfig = if ($env:GLITCH_TUNNEL_CONFIG) { $env:GLITCH_TUNNEL_CONFIG } else { Join-Path $RootDir "config\cloudflared-config.yml" }
$TunnelLog = Join-Path $RootDir "data\logs\cloudflared-tunnel.window.log"

function Test-TunnelRunning {
    # True when ANY cloudflared is up (ours or not). Exit 0 = up.
    if (-not (Test-Path $TunnelScript)) { return $false }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $NodeExe $TunnelScript status | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Test-Port([int]$Port) {
    [bool](netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING")
}

try { $Host.UI.RawUI.WindowTitle = "Glitch Pi Web UI :$WebPort (user: opencode) - CLOSE THIS WINDOW TO STOP" } catch {}

Write-Host ""
Write-Host " ============================================================"
Write-Host "  Glitch Pi Web UI - this window IS the web UI server"
Write-Host " ============================================================"
Write-Host "   web UI     : http://localhost:$WebPort"
Write-Host "   auth proxy : localhost:$AuthPort -> localhost:$WebPort"
Write-Host "   tunnel     : $(if ($NoTunnel) {'disabled (-NoTunnel)'} else {'auto (Cloudflare, tied to this window)'})"
Write-Host "   login      : username + password printed above (change: scripts\set-credentials.mjs)"
Write-Host ""
Write-Host "   Close this window (or press Ctrl+C) to STOP the stack."
Write-Host ""

# --- Refuse to double-bind -------------------------------------------------
$busy = @()
if (Test-Port $WebPort) { $busy += "pi-web-ui :$WebPort" }
if (Test-Port $AuthPort) { $busy += "auth proxy :$AuthPort" }
if ($busy.Count -gt 0) {
    Write-Host "  Already listening: $($busy -join ', ')" -ForegroundColor Yellow
    Write-Host "  Nothing to do. To stop the running stack first:"
    Write-Host "    .\scripts\stop-pi-stack.ps1"
    Write-Host ""
    Write-Host "  (This window was started with -NoExit, so it stays open.)" -ForegroundColor DarkGray
    return
}

# --- Resolve the pi-web-ui entry ------------------------------------------
$useLauncher = $false
if (-not (Test-Path $WebEntry)) {
    if (Test-Path $LauncherCmd) {
        $useLauncher = $true
        Write-Host "  NOTE: direct pi-web-ui entry not found, falling back to launcher:" -ForegroundColor Yellow
        Write-Host "        $LauncherCmd" -ForegroundColor DarkGray
    } else {
        Write-Host "  ERROR: pi-web-ui not found." -ForegroundColor Red
        Write-Host "    entry   : $WebEntry" -ForegroundColor DarkGray
        Write-Host "    launcher: $LauncherCmd" -ForegroundColor DarkGray
        return
    }
}
if (-not (Test-Path $AuthProxy)) {
    Write-Host "  ERROR: auth proxy not found: $AuthProxy" -ForegroundColor Red
    return
}
if (-not (Test-Path (Join-Path $RootDir ".server-password"))) {
    Write-Host "  ERROR: .server-password missing - the auth proxy will refuse to start." -ForegroundColor Red
    Write-Host "         Create one with: node scripts\set-credentials.mjs" -ForegroundColor DarkGray
    return
}

# --- Login banner (shared helper) -----------------------------------------
# Port overrides so the banner prints the ports this window actually uses.
$env:GLITCH_PI_WEBUI_PORT = "$WebPort"
$env:GLITCH_PI_AUTH_PORT = "$AuthPort"
$ShowCreds = Join-Path $RootDir "scripts\show-credentials.mjs"
if (Test-Path $ShowCreds) {
    $credArgs = @()
    if (-not $Host.UI.SupportsVirtualTerminal) { $credArgs += "--plain" }
    & $NodeExe $ShowCreds @credArgs
}

$proxy = $null
$tunnel = $null
$tunnelOwned = $false
try {
    # --- 1. auth proxy: child on THIS console -----------------------------
    Write-Host "  starting auth proxy on :$AuthPort ..." -ForegroundColor Cyan
    $proxy = Start-Process -FilePath $NodeExe `
        -ArgumentList @("`"$AuthProxy`"", "$AuthPort", "http://localhost:$WebPort") `
        -NoNewWindow -PassThru
    Start-Sleep -Milliseconds 800
    if ($proxy.HasExited) {
        Write-Host "  WARNING: auth proxy exited immediately (code $($proxy.ExitCode))." -ForegroundColor Yellow
        Write-Host "  Remote access through the tunnel will NOT work." -ForegroundColor Yellow
        Write-Host "  Check: node `"$AuthProxy`" $AuthPort http://localhost:$WebPort" -ForegroundColor DarkGray
        Write-Host ""
    } else {
        Write-Host "  auth proxy up (PID $($proxy.Id))" -ForegroundColor DarkGreen
    }

    # --- 2. cloudflared: child on THIS console ----------------------------
    # Only when no tunnel is already running: Cloudflare accepts several
    # connectors on one tunnel without erroring, so a blind second start would
    # leave a duplicate that outlives this window.
    if ($NoTunnel) {
        Write-Host "  tunnel: skipped (-NoTunnel)" -ForegroundColor DarkGray
    } elseif (Test-TunnelRunning) {
        Write-Host "  tunnel: already running - left alone (this window does not own it)" -ForegroundColor DarkGray
    } elseif (-not (Test-Path $CloudflaredBin)) {
        Write-Host "  tunnel: cloudflared not found at $CloudflaredBin - remote access will NOT work" -ForegroundColor Yellow
    } elseif (-not (Test-Path $TunnelConfig)) {
        Write-Host "  tunnel: config not found at $TunnelConfig - remote access will NOT work" -ForegroundColor Yellow
    } else {
        Write-Host "  starting cloudflared (tunnel tied to this window) ..." -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TunnelLog) | Out-Null
        $tunnel = Start-Process -FilePath $CloudflaredBin `
            -ArgumentList @("tunnel", "--config", "`"$TunnelConfig`"", "run", "--logfile", "`"$TunnelLog`"") `
            -NoNewWindow -PassThru
        Start-Sleep -Milliseconds 1500
        if ($tunnel.HasExited) {
            Write-Host "  WARNING: cloudflared exited immediately (code $($tunnel.ExitCode))." -ForegroundColor Yellow
            Write-Host "  Remote access will NOT work. Last lines of $TunnelLog :" -ForegroundColor DarkGray
            if (Test-Path $TunnelLog) { Get-Content $TunnelLog -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
            $tunnel = $null
        } else {
            $tunnelOwned = $true
            try {
                Set-Content -Path (Join-Path $RootDir "data\cloudflared-auto.pid") -Value $tunnel.Id -NoNewline
            } catch {}
            Write-Host "  cloudflared up (PID $($tunnel.Id))" -ForegroundColor DarkGreen
        }
    }

    # --- 3. pi-web-ui in the FOREGROUND (window lives as long as it does) ---
    Write-Host "  starting pi-web-ui on 0.0.0.0:$WebPort ..." -ForegroundColor Cyan
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""

    if ($useLauncher) {
        & $LauncherCmd
    } else {
        $webArgs = @("`"$WebEntry`"", "--port", "$WebPort", "--host", "0.0.0.0", "--cwd", "`"$RootDir`"")
        if ($NoBrowser) { $webArgs += "--no-browser" }
        & $NodeExe @webArgs
    }
} finally {
    if ($tunnelOwned -and $tunnel -and -not $tunnel.HasExited) {
        Write-Host ""
        Write-Host "  stopping cloudflared (PID $($tunnel.Id))..." -ForegroundColor Cyan
        # By captured PID only - never by image name, which would also kill a
        # tunnel some other tool started.
        try { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue } catch {}
        try { Remove-Item (Join-Path $RootDir "data\cloudflared-auto.pid") -ErrorAction SilentlyContinue } catch {}
    }
    if ($proxy -and -not $proxy.HasExited) {
        Write-Host ""
        Write-Host "  stopping auth proxy (PID $($proxy.Id))..." -ForegroundColor Cyan
        try { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
}

Write-Host ""
Write-Host "  pi-web-ui has stopped - the stack is down." -ForegroundColor Yellow
Write-Host "  This window stays open (-NoExit). Close it, or restart with:" -ForegroundColor DarkGray
Write-Host "    .\scripts\start-pi-stack-window.ps1" -ForegroundColor DarkGray
Write-Host ""
