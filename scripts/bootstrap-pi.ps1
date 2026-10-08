param(
    [switch]$Force
)

# ============================================================================
# bootstrap-pi.ps1 -- Pi-engine bootstrap for the glitch-pi fork (Gap G5,
# docs/startup-chain-plan.md). Replaces the OpenCode-era bootstrap.ps1 in the
# install chain (install-pi.ps1 step 4 + launch-glitch.bat auto-bootstrap).
#
# Difference vs bootstrap.ps1: this fork's ONLY engine is the Pi CLI
# (@earendil-works/pi-coding-agent) served from data/node, plus pi-web-ui for
# the Web stack. OpenCode and Handy are NOT installed (organs stripped in the
# fork; launch-unified.mjs guards on their presence).
#
# Steps:
#   [1/6] Node.js portable          -> data\node        (critical)
#   [2/6] MinGit                    -> data\mingit       (or system git)
#   [3/6] git submodules            -> glitch-memorycore
#   [4/6] Pi engine (npm -g)        -> pi CLI + pi-web-ui into data\node (critical)
#   [5/6] Engine skills             -> .pi\skills via scripts\sync-skills.mjs --pi
#   [6/6] cloudflared.exe           -> repo root        (tunnel, optional)
#
# Idempotent: every step is skipped when its artifact already exists
# (pass -Force to re-download). Exit 1 only on critical failures
# (Node.js / Pi engine), mirroring bootstrap.ps1's contract.
# ============================================================================

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$LogFile = "$RootDir\data\bootstrap-pi.log"
$BundledNodeDir = "$RootDir\data\node"
$NodeBin = "$BundledNodeDir\node.exe"
$BundledNpm = Join-Path $BundledNodeDir "npm.cmd"
$GitToolsDir = Join-Path $RootDir "data\mingit"
$CloudflaredBin = "$RootDir\cloudflared.exe"

# The Pi engine npm globals. One place to pin versions if a release turns out
# incompatible with this repo's .pi/extensions (validated against 0.99.2).
$PiEnginePackages = @("@earendil-works/pi-coding-agent", "pi-web-ui")

# Artifacts that prove the Pi engine actually landed (also checked by
# scripts/check-install.mjs -- keep the paths in sync).
$PiCliJs = Join-Path $BundledNodeDir "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
$PiWebUiEntry = Join-Path $BundledNodeDir "node_modules\pi-web-ui\bin\pi-web-ui.mjs"

# -- Spinner helper for long operations (same contract as bootstrap.ps1) --
function Invoke-WithSpinner {
    param([string]$Label, [scriptblock]$ScriptBlock, [string]$DoneMessage = "")

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $job = Start-Job -ScriptBlock $ScriptBlock 2>$null

    $chars = '-\|/'
    $i = 0
    while ($job.State -eq 'Running') {
        $elapsed = $sw.Elapsed.TotalSeconds.ToString("F0")
        Write-Host "`r  $Label $($chars[$($i % 4)]) ($($elapsed)s)" -NoNewline
        Start-Sleep -Milliseconds 200
        $i++
    }

    $sw.Stop()
    Write-Host ("`r" + " " * 60 + "`r") -NoNewline

    if ($job.State -eq 'Failed') {
        $reason = $job.ChildJobs[0].JobStateInfo.Reason
        $err = if ($reason -ne $null) { $reason.Message } else { $job.ChildJobs[0].Error[0].Exception.Message }
        $null = Receive-Job $job -Wait -AutoRemoveJob 2>$null
        Write-Host "  $Label FAILED" -ForegroundColor Red
        throw $err
    }

    $null = Receive-Job $job -Wait -AutoRemoveJob 2>$null

    if ($DoneMessage -ne "") {
        Write-Host "  $DoneMessage done! ($($sw.Elapsed.TotalSeconds.ToString('F1'))s)"
    }
}

# Don't stop on first error -- we handle per-step
$ErrorActionPreference = "Continue"

# Redirect all script output to a log file too
if (-not (Test-Path "$RootDir\data")) { New-Item -ItemType Directory -Path "$RootDir\data" -Force | Out-Null }
Start-Transcript -Path $LogFile -Append | Out-Null

# -- Detect architecture --
$isArm = (Get-CimInstance Win32_Processor).Architecture -eq 5
$archSuffix = if ($isArm) { "arm64" } else { "x64" }

Write-Host "=== Glitch Pi Bootstrap ===" -ForegroundColor Magenta
Write-Host "Log: $LogFile" -ForegroundColor DarkGray
Write-Host ""

$failures = @()
$criticalFailures = @()

# -- Step 1: Node.js (portable bundled -- always installed) --
Write-Host "[1/6] Installing bundled Node.js..." -ForegroundColor Cyan

$needsDownload = (-not (Test-Path $NodeBin)) -or $Force
$currentBundledVer = ""

if (-not $needsDownload) {
  try {
    $currentBundledVer = (& $NodeBin "--version" 2>$null).Trim()
    Write-Host "  Bundled Node.js found: $currentBundledVer" -ForegroundColor DarkGreen
  } catch {
    $needsDownload = $true
  }
}

if ($needsDownload) {
  Write-Host "  Checking latest LTS version..." -ForegroundColor Yellow
  try {
    $response = Invoke-WebRequest -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
    $releases = $response.Content | ConvertFrom-Json
    $latestLTS = ($releases | Where-Object { $_.lts -ne $false } | Select-Object -First 1)
    $latestVer = if ($latestLTS -and $latestLTS.version) { $latestLTS.version } else { "v22.14.0" }
  } catch {
    $latestVer = "v22.14.0"
  }

  # Skip if current bundled version matches latest
  if ($currentBundledVer -eq $latestVer -and -not $Force) {
    Write-Host "  Bundled Node.js is up-to-date ($currentBundledVer)" -ForegroundColor DarkGreen
  } else {
    Write-Host "  Downloading Node.js $latestVer (portable)..." -ForegroundColor Yellow
    try {
      $nodeArch = if ($isArm) { "arm64" } else { "x64" }
      $zipUrl = "https://nodejs.org/dist/$latestVer/node-$latestVer-win-$nodeArch.zip"
      $zipDir = Join-Path $RootDir "data\downloads"
      if (-not (Test-Path $zipDir)) { New-Item -ItemType Directory -Path $zipDir -Force | Out-Null }
      $zipPath = Join-Path $zipDir "node-portable.zip"

      Invoke-WithSpinner -Label "Downloading Node.js $latestVer" -ScriptBlock {
        Invoke-WebRequest -Uri $using:zipUrl -OutFile $using:zipPath -UseBasicParsing -TimeoutSec 120
      }

      $extractDir = "$env:TEMP\node-extracted"
      Invoke-WithSpinner -Label "Extracting Node.js" -ScriptBlock {
        if (Test-Path "$using:extractDir") { Remove-Item "$using:extractDir" -Recurse -Force -ErrorAction SilentlyContinue }
        Expand-Archive -Path $using:zipPath -DestinationPath $using:extractDir -Force
      }

      $extractedExe = Get-ChildItem $extractDir -Recurse -Filter "node.exe" | Select-Object -First 1
      if ($extractedExe) {
        $oldDir = "$BundledNodeDir.old"
        # The bundled node dir IS the npm global prefix -- the rename+copy below
        # wipes every npm global (pi, pi-web-ui, gitnexus). Capture which globals
        # existed so they can be restored afterwards.
        $piExistedBefore = @($PiEnginePackages | Where-Object {
          if ($_ -eq "@earendil-works/pi-coding-agent") {
            (Test-Path (Join-Path $BundledNodeDir "pi.cmd")) -or
            (Test-Path (Join-Path $BundledNodeDir "node_modules\@earendil-works\pi-coding-agent"))
          } else {
            (Test-Path (Join-Path $BundledNodeDir "pi-web-ui.cmd")) -or
            (Test-Path (Join-Path $BundledNodeDir "node_modules\$_"))
          }
        })
        $gnExistedBefore = (
          (Test-Path (Join-Path $BundledNodeDir "gitnexus.cmd")) -or
          (Test-Path (Join-Path $BundledNodeDir "gitnexus.exe")) -or
          (Test-Path (Join-Path $BundledNodeDir "node_modules\gitnexus"))
        )
        # Rename old dir to .old first (rename works even with running executables on Windows)
        if (Test-Path $BundledNodeDir) {
          if (Test-Path $oldDir) { Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue }
          Rename-Item $BundledNodeDir $oldDir -ErrorAction SilentlyContinue
        }
        New-Item -ItemType Directory -Path $BundledNodeDir -Force | Out-Null
        Copy-Item "$($extractedExe.Directory.FullName)\*" $BundledNodeDir -Recurse -Force
        # Cleanup .old - may fail if node.exe still running; cleaned on next update
        Remove-Item $oldDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "  Node.js extracted to data/node/" -ForegroundColor Green

        # Restore the npm globals wiped by the directory replacement above.
        $restore = @()
        if ($gnExistedBefore) { $restore += "gitnexus@latest" }
        $restore += $piExistedBefore
        if ($restore.Count -gt 0 -and (Test-Path $BundledNpm)) {
          Write-Host "  Restoring npm globals wiped by Node update: $($restore -join ', ')" -ForegroundColor Yellow
          $prevPath = $env:PATH
          $env:PATH = "$BundledNodeDir;$env:PATH"
          try {
            $null = & $BundledNpm "install" "-g" @restore 2>&1
          } finally {
            $env:PATH = $prevPath
          }
        }
      } else {
        throw "Could not find node.exe in extracted archive"
      }

      Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
      Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
      Write-Host "  ERROR downloading Node.js: $_" -ForegroundColor Red
      $criticalFailures += "Step 1: Node.js -- $_"
    }
  }
}

if (Test-Path $NodeBin) {
  $ver = & $NodeBin "--version" 2>$null
  Write-Host "  Node.js ready: $(if ($ver) { $ver.Trim() } else { 'unknown version' })" -ForegroundColor Green
} else {
  Write-Host "  (using system Node.js)" -ForegroundColor DarkGreen
}

# -- Step 2: MinGit (portable Git) --
# Required by the launcher's branch pre-check and by git-sync.mjs. On a fresh clone
# there may be no system git and no bundled mingit, so we download MinGit into
# data\mingit\ (the same folder launch-glitch.bat adds to PATH). If git is already
# available (system install or previously bootstrapped), we skip the download.
$gitBin = Join-Path $GitToolsDir "cmd\git.exe"
$existingGit = (Get-Command git -ErrorAction SilentlyContinue).Source

if ($existingGit) {
  Write-Host "[2/6] MinGit -- git found: $existingGit" -ForegroundColor DarkGreen
  $sysGitCmdDir = Split-Path $existingGit -Parent
  $sysGitRootDir = Split-Path $sysGitCmdDir -Parent
  $sysGitUsrBin = Join-Path $sysGitRootDir "usr\bin"
  if (Test-Path (Join-Path $sysGitUsrBin "bash.exe")) {
    $env:PATH = "$sysGitUsrBin;$env:PATH"
    Write-Host "  Added system git's bash to PATH: $sysGitUsrBin" -ForegroundColor Cyan
  }
} elseif (Test-Path $gitBin) {
  Write-Host "[2/6] MinGit -- bundled git found at $gitBin" -ForegroundColor DarkGreen
  $env:PATH = "$GitToolsDir\cmd;$GitToolsDir\usr\bin;$env:PATH"
} else {
  Write-Host "[2/6] Installing MinGit (portable Git)..." -ForegroundColor Cyan
  try {
    # Try GitHub API for the latest MinGit release, with retries on transient failures.
    # A GitHub outage should not kill the whole bootstrap -- Node/Pi/cloudflared still install.
    $downloadUrl = $null
    $maxAttempts = 3
    $attempt = 0
    $lastErr = ""
    while ($attempt -lt $maxAttempts -and -not $downloadUrl) {
      $attempt++
      try {
        $apiUrl = "https://api.github.com/repos/git-for-windows/git/releases/latest"
        $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing -TimeoutSec 10
        $minGitAsset = $release.assets | Where-Object { $_.name -like "MinGit-*-64-bit.zip" } | Select-Object -First 1
        if ($minGitAsset) {
          $downloadUrl = $minGitAsset.browser_download_url
          Write-Host "  Found: $($minGitAsset.name)" -ForegroundColor Yellow
        } else {
          throw "No MinGit asset found in latest release"
        }
      } catch {
        $lastErr = $_.Exception.Message
        if ($attempt -lt $maxAttempts) {
          Write-Host "  MinGit API lookup failed (attempt $attempt/$maxAttempts): $lastErr -- retrying in 3s" -ForegroundColor Yellow
          Start-Sleep -Seconds 3
        }
      }
    }
    if (-not $downloadUrl) {
      # Fallback to a known-good version
      $downloadUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.2/MinGit-2.47.0.2-64-bit.zip"
      Write-Host "  Using fixed MinGit 2.47.0.2 (API failed after $maxAttempts attempts: $lastErr)" -ForegroundColor Yellow
    }

    $zipDir = Join-Path $RootDir "data\downloads"
    if (-not (Test-Path $zipDir)) { New-Item -ItemType Directory -Path $zipDir -Force | Out-Null }
    $zipPath = Join-Path $zipDir "mingit.zip"

    # Retry the actual download too -- GitHub release CDN can be flaky
    $downloaded = $false
    $dlAttempt = 0
    $dlLastErr = ""
    while ($dlAttempt -lt $maxAttempts -and -not $downloaded) {
      $dlAttempt++
      try {
        Invoke-WithSpinner -Label "Downloading MinGit (~40MB, attempt $dlAttempt/$maxAttempts)" -ScriptBlock {
          Invoke-WebRequest -Uri $using:downloadUrl -OutFile $using:zipPath -UseBasicParsing -TimeoutSec 120
        }
        $downloaded = $true
      } catch {
        $dlLastErr = $_.Exception.Message
        if ($dlAttempt -lt $maxAttempts) {
          Write-Host "  MinGit download failed (attempt $dlAttempt/$maxAttempts): $dlLastErr -- retrying in 3s" -ForegroundColor Yellow
          Start-Sleep -Seconds 3
        }
      }
    }
    if (-not $downloaded) {
      throw "MinGit download failed after $maxAttempts attempts: $dlLastErr"
    }

    if (Test-Path $GitToolsDir) { Remove-Item $GitToolsDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $GitToolsDir -Force | Out-Null
    Invoke-WithSpinner -Label "Extracting MinGit" -ScriptBlock {
      Expand-Archive -Path $using:zipPath -DestinationPath $using:GitToolsDir -Force
    }
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $gitBin)) {
      throw "MinGit binary not found after extraction at $gitBin"
    }
    # Add to PATH so the next steps (submodules, skill sync) can use git in-process
    $env:PATH = "$GitToolsDir\cmd;$GitToolsDir\usr\bin;$env:PATH"
    Write-Host "  MinGit installed to $GitToolsDir" -ForegroundColor Green
  } catch {
    Write-Host "  ERROR installing MinGit: $_" -ForegroundColor Red
    Write-Host "  Git is required for the launcher's branch check and submodule init." -ForegroundColor Yellow
    Write-Host "  Install Git manually from https://git-scm.com/download/win" -ForegroundColor Yellow
    # Non-critical: bootstrap continues. The submodule step below guards on
    # git availability and skips gracefully when git is missing.
    $failures += "MinGit download failed (GitHub unreachable). Git will not be available. You can install git manually and re-run bootstrap."
  }
}

# -- Step 3: Git Submodules --
Write-Host "[3/6] Initializing git submodules..." -ForegroundColor Cyan

# Distinguish "not a git repo" (expected, skip silently) from real failures (warn loudly).
# A fresh download of the repo as a zip (no .git/) lands here -- that's normal, not an error.
$isGitRepo = Test-Path (Join-Path $RootDir ".git")
if (-not $isGitRepo) {
  Write-Host "  Skipping submodules (not a git repo -- this is normal for zip downloads)" -ForegroundColor DarkGray
} else {
  $gitAvailable = Get-Command git -ErrorAction SilentlyContinue
  if (-not $gitAvailable) {
    Write-Host "  WARNING: git not available -- cannot init submodules" -ForegroundColor Yellow
    Write-Host "  Recovery: cd `"$RootDir`" && git submodule update --init --recursive" -ForegroundColor Yellow
    $failures += "Step 3: Git Submodules -- git not available (see MinGit step above)"
  } else {
    $subOutput = git -C "$RootDir" submodule update --init --recursive 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  Submodules initialized" -ForegroundColor Green
    } else {
      Write-Host "  WARNING: Submodule update failed (continuing anyway)" -ForegroundColor Yellow
      $subOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
      Write-Host "  Recovery: cd `"$RootDir`" && git submodule update --init --recursive" -ForegroundColor Yellow
      $failures += "Step 3: Git Submodules -- submodule update failed (see output above)"
    }
  }
}

# -- Step 4: Pi engine (pi CLI + pi-web-ui as npm globals in data/node) --
# THE core step of this fork: launch-pi.mjs spawns
# data\node\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js,
# and the Web stack runs data\node\node_modules\pi-web-ui\bin\pi-web-ui.mjs.
# Without this step a fresh install cannot start in any mode.
Write-Host "[4/6] Installing Pi engine (pi CLI + pi-web-ui)..." -ForegroundColor Cyan

if (-not (Test-Path $BundledNpm)) {
  Write-Host "  ERROR: bundled npm not found at $BundledNpm -- Node.js step must have failed" -ForegroundColor Red
  $criticalFailures += "Step 4: Pi engine -- bundled npm missing (Node.js install failed)"
} elseif ((Test-Path $PiCliJs) -and (Test-Path $PiWebUiEntry) -and -not $Force) {
  $piVer = ""
  try {
    $pkgJson = Get-Content (Join-Path $BundledNodeDir "node_modules\@earendil-works\pi-coding-agent\package.json") -Raw | ConvertFrom-Json
    $piVer = $pkgJson.version
  } catch {}
  Write-Host "[4/6] Pi engine found (pi $($piVer))" -ForegroundColor DarkGreen
} else {
  $prevPath = $env:PATH
  $env:PATH = "$BundledNodeDir;$env:PATH"
  try {
    # pi-coding-agent + pi-web-ui are large trees; give the spinner patience.
    Write-Host "  npm install -g $($PiEnginePackages -join ' ') (large download, minutes)..." -ForegroundColor Yellow
    $npmOutput = & $BundledNpm "install" "-g" @PiEnginePackages 2>&1
    if ($LASTEXITCODE -ne 0) {
      $npmOutput | Select-Object -Last 15 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
      throw "npm install exited with code $LASTEXITCODE"
    }
    if (-not (Test-Path $PiCliJs)) {
      throw "pi CLI entry missing after install: $PiCliJs"
    }
    if (-not (Test-Path $PiWebUiEntry)) {
      throw "pi-web-ui entry missing after install: $PiWebUiEntry"
    }
    $piVer = ""
    try {
      $pkgJson = Get-Content (Join-Path $BundledNodeDir "node_modules\@earendil-works\pi-coding-agent\package.json") -Raw | ConvertFrom-Json
      $piVer = $pkgJson.version
    } catch {}
    Write-Host "  Pi engine ready (pi $($piVer), pi-web-ui installed)" -ForegroundColor Green
  } catch {
    Write-Host "  ERROR installing Pi engine: $_" -ForegroundColor Red
    Write-Host "  Retry: .\data\node\npm.cmd install -g $($PiEnginePackages -join ' ')" -ForegroundColor Yellow
    $criticalFailures += "Step 4: Pi engine -- $_"
  } finally {
    $env:PATH = $prevPath
  }
}

# -- Step 5: Engine skills -> .pi\skills --
# .pi\skills is gitignored on purpose; the source of truth is the
# glitch-memorycore submodule (initialized in step 3). Without this the TUI
# starts with zero engine skills.
Write-Host "[5/6] Syncing engine skills to .pi\skills..." -ForegroundColor Cyan

if (-not (Test-Path $NodeBin)) {
  Write-Host "  WARNING: bundled node missing -- skipping skill sync" -ForegroundColor Yellow
  $failures += "Step 5: Skills -- bundled node missing"
} elseif (-not (Test-Path (Join-Path $RootDir "glitch-memorycore\plugins\glitch-skills\skills"))) {
  Write-Host "  WARNING: engine skills source missing (submodule not initialized) -- skipping" -ForegroundColor Yellow
  Write-Host "  Recovery: cd `"$RootDir`" && git submodule update --init --recursive" -ForegroundColor Yellow
  $failures += "Step 5: Skills -- glitch-memorycore submodule missing"
} else {
  $syncScript = Join-Path $ScriptDir "sync-skills.mjs"
  if (-not (Test-Path $syncScript)) {
    Write-Host "  WARNING: scripts\sync-skills.mjs missing -- skipping" -ForegroundColor Yellow
    $failures += "Step 5: Skills -- sync-skills.mjs missing"
  } else {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $syncOutput = & $NodeBin $syncScript "--pi" 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  Engine skills synced" -ForegroundColor Green
      $syncOutput | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    } else {
      # Non-fatal: the TUI runs without engine skills, degraded only.
      Write-Host "  WARNING: skill sync returned non-zero (continuing)" -ForegroundColor Yellow
      $syncOutput | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
      $failures += "Step 5: Skills -- sync-skills.mjs exited $LASTEXITCODE (run: node scripts\sync-skills.mjs --pi)"
    }
    $ErrorActionPreference = $prevEAP
  }
}

# -- Step 6: Cloudflare Tunnel (standalone EXE, no admin needed) --
if (-not (Test-Path $CloudflaredBin) -or $Force) {
  Write-Host "[6/6] Installing Cloudflare Tunnel..." -ForegroundColor Cyan
  try {
    if ($isArm) {
      Write-Host "  ARM64: Download cloudflared manually:" -ForegroundColor Yellow
      Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" -ForegroundColor Yellow
    } else {
      Write-Host "  Downloading cloudflared.exe..." -ForegroundColor Yellow
      $exeUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
      Invoke-WithSpinner -Label "Downloading cloudflared" -ScriptBlock {
        Invoke-WebRequest -Uri $using:exeUrl -OutFile $using:CloudflaredBin -UseBasicParsing -TimeoutSec 120
      }
      Write-Host "  cloudflared ready!" -ForegroundColor Green
    }
  } catch {
    Write-Host "  ERROR installing cloudflared: $_" -ForegroundColor Red
    Write-Host "  This is optional -- tunnel mode won't be available but local mode works fine." -ForegroundColor Yellow
    $failures += "Step 6: Cloudflare Tunnel -- $_"
  }
} else {
  Write-Host "[6/6] cloudflared found" -ForegroundColor DarkGreen
}

# -- Summary --
Write-Host ""
Write-Host "=== Glitch Pi Bootstrap Complete ===" -ForegroundColor Magenta

if ($criticalFailures.Count -gt 0) {
  Write-Host ""
  Write-Host "$($criticalFailures.Count) critical error(s):" -ForegroundColor Red
  $criticalFailures | ForEach-Object { Write-Host "  [!] $_" -ForegroundColor Red }
  Write-Host ""
  Write-Host "Essential components failed to install. Glitch cannot start." -ForegroundColor Red
  Write-Host "See bootstrap-pi.log for full details." -ForegroundColor DarkGray
  Stop-Transcript | Out-Null
  exit 1
}

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "$($failures.Count) non-critical error(s):" -ForegroundColor Yellow
  $failures | ForEach-Object { Write-Host "  [!] $_" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "These are optional components -- Glitch will still run." -ForegroundColor Yellow
  Write-Host "See bootstrap-pi.log for full details." -ForegroundColor DarkGray
} else {
  Write-Host "All steps completed successfully!" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  .\launch-glitch.bat      - start Glitch (TUI mode)" -ForegroundColor Cyan
Write-Host "  node scripts\launch-pi.mjs --tui   - terminal Pi CLI directly" -ForegroundColor Cyan

Stop-Transcript | Out-Null
