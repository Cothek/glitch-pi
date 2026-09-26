<#
.SYNOPSIS
    Restarts the Pi web stack: pi-web-ui + auth proxy, tunnel re-ensured.
.DESCRIPTION
    Modeled on glitch-ai's scripts/restart-glitch.ps1 (sleep, kill, relaunch,
    "designed for schtasks independence") but with PID discipline: stack
    processes are found by the PORT THEY LISTEN ON and killed by PID only  - 
    never by process name (R22: a name match can hit unrelated processes).

    The interesting part is -ContinueId: an agent session dies with pi-web-ui
    (the pi engine runs inside it), but its conversation persists on disk.
    After the stack is back up, this script injects a continuation prompt
    into the target conversation over the local WebSocket
    (scripts/resume-session.mjs), so the agent picks the task back up.

    Safe to launch detached (scripts/start-detached.ps1) or via schtasks:
    no interaction, all output is plain Write-Host, everything timeboxed.
    When an AGENT self-serves a restart, launch detached with -DelaySec so
    the agent can finish its current message before the kill.

.PARAMETER WebPort     Port pi-web-ui listens on. Default 8787.
.PARAMETER AuthPort    Port the auth proxy listens on. Default 4103.
.PARAMETER ContinueId     Live conversation id to resume after restart (rarely stable).
.PARAMETER ContinuePath   Session jsonl path to resume after restart (the stable handle).
.PARAMETER ContinueText   Inline continuation prompt text (optional).
.PARAMETER ContinueFile   File containing the continuation prompt (optional).
.PARAMETER DelaySec       Seconds to wait before killing the stack. Default 0.
.PARAMETER ApplyUpdates  Restart with ALL dependency updates accepted. Runs the
                         new check-updates.mjs BEFORE killing the stack so a
                         non-zero exit never leaves the stack down. Default
                         behaviour (neither switch) is to skip all updates,
                         matching scripts/launch-unified.mjs --reuse-saved.
.PARAMETER SkipUpdates   Explicit no-op default. Logged so the next reader
                         sees the policy. If both -ApplyUpdates and
                         -SkipUpdates are passed, -SkipUpdates wins.
.PARAMETER UpdateFilter  Comma-separated subset of dependency names to limit
                         -ApplyUpdates to (e.g. "pi-coding-agent,cloudflared").
                         Empty = apply everything. Ignored unless
                         -ApplyUpdates is also passed.

.EXAMPLE
    .\scripts\restart-pi-stack.ps1
    .\scripts\restart-pi-stack.ps1 -ContinuePath <session.jsonl> -ContinueFile data\continuation.md -DelaySec 25
#>
param(
    [int]$WebPort = 8787,
    [int]$AuthPort = 4103,
    [string]$ContinueId = "",
    [string]$ContinuePath = "",
    [string]$ContinueText = "",
    [string]$ContinueFile = "",
    [int]$DelaySec = 0,
    [switch]$ApplyUpdates,
    [switch]$SkipUpdates,
    [string]$UpdateFilter = ""
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NodeExe = Join-Path $RootDir "data\node\node.exe"
if (-not (Test-Path $NodeExe)) { $NodeExe = "node" }

function Stamp([string]$m) { Write-Host "$(Get-Date -Format 'HH:mm:ss') $m" }

function Get-PortPid([int]$Port) {
    # netstat LISTENING lines for this port -> owning PIDs (deduped).
    $found = @()
    foreach ($line in (netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING")) {
        $parts = ($line.ToString().Trim() -split '\s+')
        # NOTE: $pid is READ-ONLY ($PID automatic variable). Never assign to it.
        $procPid = $parts[-1]
        if ($procPid -match '^\d+$') { $found += [int]$procPid }
    }
    return @($found | Select-Object -Unique)
}

if ($DelaySec -gt 0) { Stamp "waiting ${DelaySec}s before restart (caller asked for a head start)"; Start-Sleep -Seconds $DelaySec }

# ---- 0. Dependency updates (before the kill, if requested) -----------------
# Default (neither -ApplyUpdates nor -SkipUpdates) is to skip updates: a
# restart must never apply updates on its own. -SkipUpdates makes the no-op
# default explicit. If both switches are passed, -SkipUpdates wins.
if ($ApplyUpdates -and $SkipUpdates) {
    Stamp "-ApplyUpdates and -SkipUpdates both passed; -SkipUpdates wins (no updates)"
} elseif ($ApplyUpdates) {
    $checkerPath = Join-Path $RootDir "scripts\check-updates.mjs"
    if (-not (Test-Path $checkerPath)) {
        Stamp "update checker not present at $checkerPath; skipping -ApplyUpdates"
    } else {
        $checkerArgs = @($checkerPath, "--apply", "--yes")
        if ($UpdateFilter -ne "") { $checkerArgs += @("--filter", $UpdateFilter) }
        Stamp "applying dependency updates before restart (filter='$UpdateFilter')"
        & $NodeExe @checkerArgs
        if ($LASTEXITCODE -ne 0) {
            # Do NOT leave the stack down on a checker failure - the user
            # asked for a restart, not an update. Log and continue.
            Stamp "update checker exited $LASTEXITCODE; continuing restart anyway"
        } else {
            Stamp "dependency updates applied"
        }
        # Do NOT set $env:GLITCH_APPLY_UPDATES here: the launcher below stays
        # --reuse-saved because updates were already applied in this same run.
        # If we set the env var the launcher would re-apply the same updates
        # (idempotent but wasteful) and would also try to prompt on TTY.
    }
} else {
    Stamp "dependency updates skipped (default restart policy; pass -ApplyUpdates to apply)"
}

# ---- 1. Stop the stack by port-owning PID ----------------------------------
$targets = @{}
foreach ($p in (Get-PortPid $WebPort))  { $targets[[int]$p] = "pi-web-ui  :$WebPort" }
foreach ($p in (Get-PortPid $AuthPort)) { $targets[[int]$p] = "auth-proxy :$AuthPort" }
if ($targets.Count -eq 0) {
    Stamp "nothing listening on :$WebPort / :$AuthPort  -  nothing to stop"
} else {
    foreach ($p in $targets.Keys) {
        Stamp "stopping PID $p ($($targets[$p]))"
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
}

# Wait until both ports are actually free (max 15s).
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $busy = @(Get-PortPid $WebPort) + @(Get-PortPid $AuthPort)
    if ($busy.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}
Stamp "ports :$WebPort and :$AuthPort free"

# ---- 2. Start via the FULL startup chain ------------------------------------
# Troy's directive: a restart goes through the real startup script, with the
# saved selections auto-applied and no interactive prompts. GLITCH_REUSE_SAVED
# gates every interactive stop in launch-unified.mjs / launch-pi.mjs (branch
# check, repo-update prompt, the TUI/Web menu): saved choices win, nothing is
# persisted over a later real pick. The full chain also brings back the
# pieces a bare pi-web-ui launch skips (agent config, sync, login banner) -
# a bare launcher.cmd restart left the agent switcher missing.
Stamp "starting full startup chain via launch-unified.mjs (saved selections)"
$env:GLITCH_REUSE_SAVED = "1"
# The unified launcher shells out to bare 'node'; make the bundled portable
# node resolvable the same way launch-glitch.bat does.
$env:PATH = (Join-Path $RootDir "data\node") + ";" + $env:PATH
& $NodeExe (Join-Path $RootDir "scripts\launch-unified.mjs") --reuse-saved
if ($LASTEXITCODE -ne 0) { Stamp "FAILED: full startup chain exited $LASTEXITCODE"; exit 1 }
Stamp "full startup chain finished"

# ---- 3. Health check: HTTP 200 from the web server ---------------------------
# pi-web-ui requires PI_WEB_TOKEN on every HTTP request when the gate is on,
# so the health check must carry it too (the 60s window and HTTP-200 success
# rule are unchanged). Token stays out of any log line.
$tokenPath = Join-Path $RootDir ".server-token"
$tokenValue = $null
if (Test-Path $tokenPath) {
    $tokenValue = (Get-Content -Path $tokenPath -Raw -ErrorAction SilentlyContinue)
    if ($tokenValue) { $tokenValue = $tokenValue.Trim() }
    if (-not $tokenValue) { $tokenValue = $null }
}
$up = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    try {
        $reqArgs = @{
            Uri = "http://localhost:$WebPort/"
            UseBasicParsing = $true
            TimeoutSec = 3
        }
        if ($tokenValue) {
            $reqArgs.Headers = @{ 'X-PI-Token' = $tokenValue }
        }
        $resp = Invoke-WebRequest @reqArgs
        if ($resp.StatusCode -eq 200) { $up = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $up) {
    Stamp "FAILED: pi-web-ui did not answer HTTP on :$WebPort within 60s"
    exit 1
}
Stamp "pi-web-ui healthy on :$WebPort"

# ---- 4. Continuation injection (optional) ------------------------------------
if ($ContinueId -or $ContinuePath) {
    $resumeArgs = @((Join-Path $RootDir "scripts\resume-session.mjs"))
    if ($ContinuePath) { $resumeArgs += @("--path", $ContinuePath) }
    else { $resumeArgs += @("--id", $ContinueId) }
    if ($ContinueFile) {
        $f = if ([System.IO.Path]::IsPathRooted($ContinueFile)) { $ContinueFile } else { Join-Path (Get-Location) $ContinueFile }
        if (-not (Test-Path $f)) { Stamp "FAILED: continuation file not found: $f"; exit 1 }
        $resumeArgs += @("--file", $f)
    } elseif ($ContinueText) {
        $resumeArgs += @("--text", $ContinueText)
    } else {
        Stamp "FAILED: -ContinuePath/-ContinueId given but neither -ContinueFile nor -ContinueText"; exit 1
    }
    Stamp "injecting continuation"
    & $NodeExe @resumeArgs
    if ($LASTEXITCODE -ne 0) { Stamp "FAILED: resume-session.mjs exited $LASTEXITCODE"; exit 1 }
    Stamp "continuation injected"
}

Stamp "restart complete: pi-web-ui :$WebPort, auth-proxy :$AuthPort, tunnel ensured"
exit 0
