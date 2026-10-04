param(
  [switch]$Force
)

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$LogFile = "$RootDir\data\bootstrap.log"
$OpenCodeDir = "$RootDir\opencode"
$OpenCodeBin = "$OpenCodeDir\opencode.exe"
$HandyDir = "$RootDir\handy-voice\Handy"
$HandyBin = "$HandyDir\handy.exe"
$CloudflaredBin = "$RootDir\cloudflared.exe"

# -- Spinner helper for long operations --
# Shows a rotating spinner + elapsed seconds while a background job runs.
# Use $using:varName inside the scriptblock to pass parent variables.
function Invoke-WithSpinner {
    param([string]$Label, [scriptblock]$ScriptBlock, [string]$DoneMessage = "")
    
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $job = Start-Job -ScriptBlock $ScriptBlock 2>$null
    
    $chars = '-\|/'
    $i = 0
    while ($job.State -eq 'Running') {
        $elapsed = $sw.Elapsed.TotalSeconds.ToString('F0')
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
Start-Transcript -Path $LogFile -Append | Out-Null

# -- Detect architecture --
$isArm = (Get-CimInstance Win32_Processor).Architecture -eq 5
$archSuffix = if ($isArm) { "arm64" } else { "x64" }

Write-Host "=== Glitch Bootstrap ===" -ForegroundColor Magenta
Write-Host "Log: $LogFile" -ForegroundColor DarkGray
Write-Host ""

$failures = @()
$criticalFailures = @()

# -- Step 1: Node.js (portable bundled -- always installed) --
$BundledNodeDir = "$RootDir\data\node"
$NodeBin = "$BundledNodeDir\node.exe"

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
        # The bundled node dir IS the npm global prefix - the rename+copy below
        # wipes every npm global (gitnexus, opencode). Capture gitnexus presence
        # first so we can restore it afterwards.
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

        # Restore gitnexus global wiped by the directory replacement above.
        if ($gnExistedBefore) {
          $bundledNpm = Join-Path $BundledNodeDir "npm.cmd"
          if (Test-Path $bundledNpm) {
            Write-Host "  Restoring gitnexus (npm global wiped by Node update)..." -ForegroundColor Yellow
            $prevPath = $env:PATH
            $env:PATH = "$BundledNodeDir;$env:PATH"
            try {
              $null = & $bundledNpm "install" "-g" "gitnexus@latest" 2>&1
              if ($LASTEXITCODE -eq 0 -and ((Test-Path (Join-Path $BundledNodeDir "gitnexus.cmd")) -or (Test-Path (Join-Path $BundledNodeDir "node_modules\gitnexus")))) {
                Write-Host "  gitnexus restored." -ForegroundColor Green
              } else {
                Write-Host "  gitnexus restore FAILED - reinstall manually: data\node\npm.cmd install -g gitnexus" -ForegroundColor Red
              }
            } finally {
              $env:PATH = $prevPath
            }
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
# there is no system git and no bundled mingit, so we download MinGit into data\mingit\
# (the same folder launch-glitch.bat adds to PATH). If git is already available
# (system install or previously bootstrapped), we skip the download.
$gitToolsDir = Join-Path $RootDir "data\mingit"
$gitBin = Join-Path $gitToolsDir "cmd\git.exe"
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
  $env:PATH = "$gitToolsDir\cmd;$gitToolsDir\usr\bin;$env:PATH"
} else {
  Write-Host "[2/6] Installing MinGit (portable Git)..." -ForegroundColor Cyan
  try {
    # Try GitHub API for the latest MinGit release, with retries on transient failures.
    # A GitHub outage should not kill the whole bootstrap -- Node/OpenCode/Handy still install.
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

    if (Test-Path $gitToolsDir) { Remove-Item $gitToolsDir -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $gitToolsDir -Force | Out-Null
    Invoke-WithSpinner -Label "Extracting MinGit" -ScriptBlock {
      Expand-Archive -Path $using:zipPath -DestinationPath $using:gitToolsDir -Force
    }
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

    if (-not (Test-Path $gitBin)) {
      throw "MinGit binary not found after extraction at $gitBin"
    }
    # Add to PATH so the next step (submodules) can use git in-process
    $env:PATH = "$gitToolsDir\cmd;$gitToolsDir\usr\bin;$env:PATH"
    Write-Host "  MinGit installed to $gitToolsDir" -ForegroundColor Green
  } catch {
    Write-Host "  ERROR installing MinGit: $_" -ForegroundColor Red
    Write-Host "  Git is required for the launcher's branch check and submodule init." -ForegroundColor Yellow
    Write-Host "  Install Git manually from https://git-scm.com/download/win" -ForegroundColor Yellow
    # Non-critical: bootstrap continues to Node/OpenCode/Handy. The submodule step
    # already guards on $gitAvailable and skips gracefully when git is missing.
    $failures += "MinGit download failed (GitHub unreachable). Git will not be available. You can install git manually and re-run bootstrap. Launcher branch check will be skipped."
  }
}

# -- Step 3: Git Submodules --
Write-Host "[3/6] Initializing git submodules..." -ForegroundColor Cyan

# Distinguish "not a git repo" (expected, skip silently) from real failures (warn loudly).
# A fresh clone of the repo as a zip (no .git/) lands here -- that's normal, not an error.
$isGitRepo = Test-Path (Join-Path $RootDir ".git")
if (-not $isGitRepo) {
  Write-Host "  Skipping submodules (not a git repo -- this is normal for zip downloads)" -ForegroundColor DarkGray
} else {
  # FIX: previously this ran `git ...` unconditionally. When git was missing the
  # command never executed and $LASTEXITCODE retained its prior value (0 from the
  # earlier node check), so the script printed "Submodules initialized" even on
  # total failure. Guard on git availability first.
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
      # Real failure: network error, auth failure, missing submodule, etc.
      # Log the actual error so users can diagnose, but DO NOT abort bootstrap.
      Write-Host "  WARNING: Submodule update failed (continuing anyway)" -ForegroundColor Yellow
      $subOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
      Write-Host "  Recovery: cd `"$RootDir`" && git submodule update --init --recursive" -ForegroundColor Yellow
      $failures += "Step 3: Git Submodules -- submodule update failed (see output above)"
    }
  }
}

# -- Step 4: OpenCode --
$opencodeExtractDir = "$env:TEMP\opencode-extracted"
# Prefer Windows' built-in bsdtar (handles C:\ paths natively). GNU tar from Git/MinGit
# on PATH misreads "C:\..." as a remote host ("Cannot connect to C: resolve failed").
# Do NOT pass --force-local: bsdtar rejects it (GNU-only option).
$systemTarExe = Join-Path $env:SystemRoot "System32\tar.exe"
$TarExe = if (Test-Path $systemTarExe) { $systemTarExe } else { 'tar' }
$stepOk = $true
if (-not (Test-Path $OpenCodeBin) -or $Force) {
  Write-Host "[4/6] Installing OpenCode..." -ForegroundColor Cyan
  try {
    $systemOpenCode = "C:\Program Files\nodejs\node_modules\opencode-ai\bin\opencode.exe"
    if (Test-Path $systemOpenCode) {
      Write-Host "  Found system install, copying..." -ForegroundColor Yellow
      Copy-Item $systemOpenCode $OpenCodeBin -Force
    } else {
      # Determine version: try npm CLI first, then registry REST API, then last-resort constant
      $opencodeVersion = "1.18.11"  # last-resort fallback if npm AND registry both unreachable
      $npmOk = $false
      try {
        $npmVer = npm view opencode-ai version 2>$null
        if ($npmVer) {
          $opencodeVersion = $npmVer.Trim()
          $npmOk = $true
        }
      } catch {
        # npm not available or failed, will try registry next
      }
      if (-not $npmOk) {
        # npm query failed or returned nothing; fall back to the npm registry REST API
        # (works without npm installed and without execution policy issues)
        try {
          $regInfo = Invoke-RestMethod -Uri "https://registry.npmjs.org/opencode-ai/latest" -UseBasicParsing -TimeoutSec 15
          if ($regInfo.version) { $opencodeVersion = [string]$regInfo.version }
        } catch {
          # registry unreachable too; keep last-resort constant
        }
      }

      # Download platform-specific binary from npm registry
      # (GitHub releases don't ship Windows binaries)
      $npmPkg = if ($isArm) { "opencode-windows-arm64" } else { "opencode-windows-x64" }
      $tgzUrl = "https://registry.npmjs.org/$npmPkg/-/$npmPkg-$opencodeVersion.tgz"
      $tgzPath = "$env:TEMP\opencode.tgz"
      Write-Host "  Downloading opencode $opencodeVersion..." -ForegroundColor Yellow
      Invoke-WithSpinner -Label "Downloading opencode $opencodeVersion" -ScriptBlock {
        Invoke-WebRequest -Uri $using:tgzUrl -OutFile $using:tgzPath -UseBasicParsing -TimeoutSec 120
      }

      Invoke-WithSpinner -Label "Extracting opencode" -ScriptBlock {
        if (Test-Path "$using:opencodeExtractDir") { Remove-Item "$using:opencodeExtractDir" -Recurse -Force }
        New-Item -ItemType Directory -Path "$using:opencodeExtractDir" -Force | Out-Null
        & $using:TarExe -xf $using:tgzPath -C $using:opencodeExtractDir
        if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }
      }

      $extractedExe = Get-ChildItem $opencodeExtractDir -Recurse -Filter "opencode.exe" | Select-Object -First 1
      if ($extractedExe) {
        if (-not (Test-Path $OpenCodeDir)) { New-Item -ItemType Directory -Path $OpenCodeDir -Force | Out-Null }
        Move-Item $extractedExe.FullName $OpenCodeBin -Force
      } else {
        throw "Could not find opencode.exe in extracted package"
      }
      Remove-Item $tgzPath -Force -ErrorAction SilentlyContinue
      Remove-Item $opencodeExtractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "  OpenCode ready!" -ForegroundColor Green
  } catch {
    Write-Host "  ERROR installing OpenCode: $_" -ForegroundColor Red
    $stepOk = $false
    $criticalFailures += "Step 4: OpenCode -- $_"
  }
} else {
  Write-Host "[4/6] OpenCode found" -ForegroundColor DarkGreen
}

# -- Step 5: Handy --
$handyVersion = "0.8.3"
$handyArch = if ($isArm) { "arm64" } else { "x64" }
$handySize = 105925408
$needsInstall = $Force
if (Test-Path $HandyBin) {
  $actualSize = (Get-Item $HandyBin).Length
  if ($actualSize -ne $handySize) { $needsInstall = $true }
} else { $needsInstall = $true }
if ($needsInstall) {
  Write-Host "[5/6] Installing Handy..." -ForegroundColor Cyan
  try {
    $systemHandy = "$env:LOCALAPPDATA\Handy\handy.exe"
    if (Test-Path $systemHandy) {
      Write-Host "  Found system install, copying..." -ForegroundColor Yellow
      if (-not (Test-Path $HandyDir)) { New-Item -ItemType Directory -Path $HandyDir -Force }
      Copy-Item "$env:LOCALAPPDATA\Handy\*" $HandyDir -Recurse -Force
    } else {
      Write-Host "  Downloading Handy v$handyVersion ($handyArch)..." -ForegroundColor Yellow
      $setupUrl = "https://github.com/cjpais/Handy/releases/download/v$handyVersion/Handy_${handyVersion}_${handyArch}-setup.exe"
      $setupPath = "$env:TEMP\Handy_setup.exe"
      $extractDir = "$env:TEMP\Handy_tmp"
      Invoke-WithSpinner -Label "Downloading Handy v$handyVersion" -ScriptBlock {
        Invoke-WebRequest -Uri $using:setupUrl -OutFile $using:setupPath -UseBasicParsing -TimeoutSec 120
      }
      $7z = Get-Command "7z" -ErrorAction SilentlyContinue
      if ($7z) {
        Write-Host "  Extracting with 7-Zip..." -ForegroundColor Yellow
        if (Test-Path $extractDir) { Remove-Item -Path $extractDir -Recurse -Force }
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        & $7z.Source x "$setupPath" -o"$extractDir" -y 2>&1 | Out-Null
      } else {
        Write-Host "  Installing silently..." -ForegroundColor Yellow
        $extractDir = "$env:TEMP\Handy_tmp"
        $proc = Start-Process -FilePath $setupPath -ArgumentList "/S", "/D=$extractDir" -Wait -PassThru
        if ($proc.ExitCode -ne 0) {
          Write-Host "  Silent install failed. Trying MSI extraction..." -ForegroundColor DarkYellow
          $msiUrl = "https://github.com/cjpais/Handy/releases/download/v$handyVersion/Handy_${handyVersion}_${handyArch}_en-US.msi"
          $msiPath = "$env:TEMP\Handy_${handyVersion}_${handyArch}_en-US.msi"
          Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
          $extractDir = "$env:TEMP\Handy_exe"
          New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
          Invoke-WithSpinner -Label "Downloading Handy MSI" -ScriptBlock {
            Invoke-WebRequest -Uri $using:msiUrl -OutFile $using:msiPath -UseBasicParsing -TimeoutSec 120
          }
          Write-Host "  Extracting via MSI..." -ForegroundColor Yellow
          Start-Process -FilePath "msiexec" -ArgumentList "/a `"$msiPath`" /qn TARGETDIR=`"$extractDir`"" -Wait
          Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
        }
      }
      $foundExe = Get-ChildItem -Path $extractDir -Recurse -Filter "handy.exe" | Select-Object -First 1
      if ($foundExe) {
        $src = $foundExe.Directory.FullName
        if (Test-Path $HandyDir) { Remove-Item $HandyDir -Recurse -Force }
        New-Item -ItemType Directory -Path $HandyDir -Force | Out-Null
        Copy-Item "$src\*" $HandyDir -Recurse -Force
      } else {
        Write-Host "  Failed to extract Handy." -ForegroundColor Red
        Write-Host "  Download manually: https://github.com/cjpais/Handy/releases" -ForegroundColor Yellow
      }
      Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
      Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path $HandyBin) -and ((Get-Item $HandyBin).Length -eq $handySize)) {
      Set-Content -Path "$HandyDir\portable" -Value "Handy Portable Mode" -NoNewline
      Write-Host "  Handy ready!" -ForegroundColor Green
    }
  } catch {
    Write-Host "  ERROR installing Handy: $_" -ForegroundColor Red
    $failures += "Step 5: Handy -- $_"
  }
} else {
  Write-Host "[5/6] Handy found" -ForegroundColor DarkGreen
}

# -- Step 6: Cloudflare Tunnel (standalone EXE, no admin needed) --
if (-not (Test-Path $CloudflaredBin) -or $Force) {
  Write-Host "[6/6] Installing Cloudflare Tunnel..." -ForegroundColor Cyan
  try {
    if ($isArm) {
      Write-Host "  ARM64: Download cloudflared manually:" -ForegroundColor Yellow
      Write-Host "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
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
Write-Host "=== Glitch Bootstrap Complete ===" -ForegroundColor Magenta

if ($criticalFailures.Count -gt 0) {
  Write-Host ""
  Write-Host "$($criticalFailures.Count) critical error(s):" -ForegroundColor Red
  $criticalFailures | ForEach-Object { Write-Host "  [!] $_" -ForegroundColor Red }
  Write-Host ""
  Write-Host "Essential components failed to install. Glitch cannot start." -ForegroundColor Red
  Write-Host "See bootstrap.log for full details." -ForegroundColor DarkGray
  Stop-Transcript | Out-Null
  exit 1
}

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "$($failures.Count) non-critical error(s):" -ForegroundColor Yellow
  $failures | ForEach-Object { Write-Host "  [!] $_" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "These are optional components -- Glitch will still run." -ForegroundColor Yellow
  Write-Host "See bootstrap.log for full details." -ForegroundColor DarkGray
} else {
  Write-Host "All steps completed successfully!" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  .\launch-glitch.bat       - TUI mode (with Handy voice)" -ForegroundColor Cyan
Write-Host "  .\launch-glitch.bat       - Web server mode (option 4 in unified launcher)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  For first-time Cloudflare Tunnel setup:" -ForegroundColor Yellow
Write-Host "  .\setup-tunnel.ps1        - Authenticate + create tunnel + DNS record" -ForegroundColor Yellow

Stop-Transcript | Out-Null