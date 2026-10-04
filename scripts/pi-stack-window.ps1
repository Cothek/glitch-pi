<#
.SYNOPSIS
    Runs the Pi web UI stack INSIDE this PowerShell window (foreground).
.DESCRIPTION
    This is the body that runs in a visible window opened by
    start-pi-stack.ps1 -Windowed (or start-pi-stack-window.ps1).

    Three layers, all attached to THIS console:
      1. pi-web-ui    - console-attached child, started FIRST and waited on
                        (0.0.0.0:<WebPort>); the window parks on it, so the
                        window lives as long as it does
      2. auth-proxy   - child process sharing this console (localhost:<AuthPort> -> <WebPort>)
      3. cloudflared  - child process sharing this console, only when no tunnel
                        is already running (skipped otherwise, and never killed
                        unless this window started it)

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
# The %USERPROFILE%\pi-web-ui-launcher.cmd fallback shim was removed: it was
# machine-local state outside the repo and could silently change web UI startup.

# pi-web-ui 403s browser WS upgrades whose Origin != Host (originAllowed()).
# Behind the auth proxy / tunnel, Host reads localhost:<WebPort>, so the public
# hostnames must be allow-listed. Kept in sync with start-pi-stack.ps1 -
# change both together.
$env:PI_WEB_ALLOW_ORIGINS = "https://pi.cothekdesigns.com,https://glitch.cothekdesigns.com"

# ---- PI_WEB_TOKEN (shared token gate on :8787) ------------------------------
# Same load-or-generate block as start-pi-stack.ps1, placed before pi-web-ui
# is spawned so the child process inherits it. start-pi-stack.ps1 -Windowed
# usually runs first; if it did, the file already exists and we just re-load.
# Never log the value - it is the gate secret.
$TokenFile = Join-Path $RootDir ".server-token"
function Ensure-ServerToken {
    if (Test-Path $TokenFile) {
        $existing = (Get-Content -Path $TokenFile -Raw -ErrorAction SilentlyContinue)
        if ($existing) { $existing = $existing.Trim() }
        if ($existing) {
            $env:PI_WEB_TOKEN = $existing
            Write-Host "  web token loaded from .server-token"
            return
        }
    }
    $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(24)
    $hex = ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($TokenFile, $hex, $utf8NoBom)
    $env:PI_WEB_TOKEN = $hex
    Write-Host "  web token generated"
}
Ensure-ServerToken | Out-Null

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
# node is spawned directly from $WebEntry, exactly like every other start path.
if (-not (Test-Path $WebEntry)) {
    Write-Host "  ERROR: pi-web-ui not found." -ForegroundColor Red
    Write-Host "    entry   : $WebEntry" -ForegroundColor DarkGray
    return
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
$webui = $null
try {
    # --- 1. pi-web-ui FIRST (console-attached child) ----------------------
    # The auth proxy must not accept requests before the web UI is listening:
    # a browser/tunnel polling during the gap gets ECONNREFUSED at the proxy
    # which logs `Proxy error for GET ...` noise on every boot. Starting the
    # web UI first and waiting for its port closes that race. -NoNewWindow
    # keeps it attached to THIS console, so closing the window still stops it.
    Write-Host "  starting pi-web-ui on 0.0.0.0:$WebPort ..." -ForegroundColor Cyan
    $webArgs = @("`"$WebEntry`"", "--port", "$WebPort", "--host", "0.0.0.0", "--cwd", "`"$RootDir`"")
    if ($NoBrowser) { $webArgs += "--no-browser" }
    $webui = Start-Process -FilePath $NodeExe -ArgumentList $webArgs -NoNewWindow -PassThru
    # Wait for the port (up to ~20s). Timeout is a warning, not a refusal:
    # slow first-time cold starts should still get the proxy + tunnel up.
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($webui.HasExited) { break }
        if (Test-Port $WebPort) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if ($webui.HasExited) {
        Write-Host "  ERROR: pi-web-ui exited immediately (code $($webui.ExitCode))." -ForegroundColor Red
        Write-Host "         The stack is down; fix the web server first." -ForegroundColor DarkGray
        return
    }
    if ($ready) {
        Write-Host "  pi-web-ui up (PID $($webui.Id))" -ForegroundColor DarkGreen
    } else {
        Write-Host "  WARNING: :$WebPort not listening after 20s - continuing anyway." -ForegroundColor Yellow
    }

    # --- 2. auth proxy: child on THIS console -----------------------------
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

    # --- 3. cloudflared: child on THIS console ----------------------------
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

    # --- 4. Park on the web UI (window lives as long as it does) ----------
    Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
    # Ctrl+C interrupts Wait-Process and lands in the finally block below.
    Wait-Process -Id $webui.Id
} finally {
    if ($webui -and -not $webui.HasExited) {
        Write-Host ""
        Write-Host "  stopping pi-web-ui (PID $($webui.Id))..." -ForegroundColor Cyan
        try { Stop-Process -Id $webui.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
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
