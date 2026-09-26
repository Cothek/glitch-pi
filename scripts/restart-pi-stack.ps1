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
    [int]$DelaySec = 0
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
$up = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$WebPort/" -UseBasicParsing -TimeoutSec 3
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
