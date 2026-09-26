<# 
.SYNOPSIS
    Glitch AI Installer for Windows (PowerShell 5.1+)
    Standalone installer - download and run directly from GitHub.

.DESCRIPTION
    This script installs Glitch AI by cloning the repository, running the bootstrap
    script to download dependencies (Node.js, OpenCode, Handy, etc.), optionally
    setting up a user profile from GitHub, and launching Glitch.

.PARAMETER InstallDir
    Custom installation directory (default: $HOME\glitch-ai)

.PARAMETER NoLaunch
    Skip the launch prompt after installation.

.PARAMETER Help
    Show this help message.

.PARAMETER UserRepo
    GitHub user repo URL for profile sync (e.g. https://github.com/user/repo.git).
    When provided, skips the interactive sync prompt and uses this repo directly.

.EXAMPLE
    irm https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.ps1 | iex

.EXAMPLE
    irm https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.ps1 | iex -InstallDir "D:\glitch-ai"

.EXAMPLE
    irm https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.ps1 | iex -NoLaunch

.EXAMPLE
    irm https://raw.githubusercontent.com/Cothek/glitch-ai/develop/scripts/install.ps1 -OutFile "$env:TEMP\glitch-install.ps1"; powershell -ExecutionPolicy Bypass -File "$env:TEMP\glitch-install.ps1" -Branch develop

.EXAMPLE
    irm https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.ps1 | iex -UserRepo "https://github.com/Cothek/glitch-user-cothek.git"
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$InstallDir = "$HOME\glitch-ai",

    [Parameter(Mandatory=$false)]
    [switch]$NoLaunch,

    [Parameter(Mandatory=$false)]
    [switch]$Help,

    [Parameter(Mandatory=$false)]
    [string]$Branch = "main",

    [Parameter(Mandatory=$false)]
    [string]$UserRepo,

    [Parameter(Mandatory=$false)]
    [switch]$NoShortcut
)

# Bump this whenever installer behavior changes -- printed at startup for issue identification
$InstallerVersion = "1.0.1"

# Set up logging - captures all output to a file for diagnosis
# Log starts in TEMP (always exists) and is relocated into the install directory
# AFTER the clone succeeds. Nothing is written inside $InstallDir before clone.
$script:LogFile = $null
try {
    $script:LogFile = Join-Path $env:TEMP "glitch-install.log"
    Start-Transcript -Path $script:LogFile -Append | Out-Null
    Write-Host "  Logging to: $script:LogFile" -ForegroundColor DarkGray
} catch {
    try {
        Write-Host "  (Could not start logging)" -ForegroundColor DarkGray
    } catch {}
}

Write-Host ""
Write-Host "  Glitch AI Installer v$InstallerVersion (Windows)" -ForegroundColor Cyan
Write-Host "  Install dir : $InstallDir" -ForegroundColor DarkGray
Write-Host "  Branch      : $Branch" -ForegroundColor DarkGray
Write-Host "  PowerShell  : $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray
Write-Host ""

# Catch all unhandled errors and log them
$ErrorActionPreference = "Stop"
trap {
    Write-Host "`n  FATAL ERROR: $_" -ForegroundColor Red
    Write-Host "  Log file: $script:LogFile" -ForegroundColor Yellow
    Write-Host "  Please share this log file when reporting the issue." -ForegroundColor Yellow
    try { Stop-Transcript | Out-Null } catch {}
    return
}

# Color output helpers
function Write-Header { param([string]$msg) Write-Host "`n$msg" -ForegroundColor Magenta }
function Write-Step   { param([string]$msg) Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Success{ param([string]$msg) Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn   { param([string]$msg) Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Error  { param([string]$msg) Write-Host "  $msg" -ForegroundColor Red }
function Write-Prompt { param([string]$msg) Write-Host "  $msg" -NoNewline -ForegroundColor Cyan }

# Find git.exe via the PERSISTED (global) PATH -- the source of truth for
# whether git will be available in FUTURE terminals. The session $env:PATH is
# NOT authoritative because launch scripts (launch-glitch.bat)
# prepend bundled MinGit at every launch without persisting it -- so a
# session-only git would still leave fresh terminals broken.
function Get-PersistedGitPath {
    foreach ($scope in @('User', 'Machine')) {
        $pathValue = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ([string]::IsNullOrEmpty($pathValue)) { continue }
        foreach ($entry in $pathValue.Split(';')) {
            $trimmed = $entry.Trim().Trim('"').TrimEnd('\')
            if ([string]::IsNullOrEmpty($trimmed)) { continue }
            $candidate = Join-Path $trimmed 'git.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

function Test-GitInPersistedPath {
    return $null -ne (Get-PersistedGitPath)
}

# Find node.exe via the PERSISTED (global) PATH -- same philosophy as the git
# check above. The session $env:PATH is NOT authoritative because launch
# scripts prepend bundled Node.js at every launch without persisting it.
function Get-PersistedNodePath {
    foreach ($scope in @('User', 'Machine')) {
        $pathValue = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ([string]::IsNullOrEmpty($pathValue)) { continue }
        foreach ($entry in $pathValue.Split(';')) {
            $trimmed = $entry.Trim().Trim('"').TrimEnd('\')
            if ([string]::IsNullOrEmpty($trimmed)) { continue }
            $candidate = Join-Path $trimmed 'node.exe'
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

function Test-NodeInPersistedPath {
    return $null -ne (Get-PersistedNodePath)
}

function Test-PathInPersistedPath {
    param([string]$TargetDir)
    $target = $TargetDir.Trim().Replace('/', '\').TrimEnd('\').ToLowerInvariant()
    foreach ($scope in @('User', 'Machine')) {
        $pathValue = [Environment]::GetEnvironmentVariable('Path', $scope)
        if ([string]::IsNullOrEmpty($pathValue)) { continue }
        foreach ($entry in $pathValue.Split(';')) {
            $trimmed = $entry.Trim().Trim('"').Replace('/', '\').TrimEnd('\')
            if ([string]::IsNullOrEmpty($trimmed)) { continue }
            if ($trimmed.ToLowerInvariant() -eq $target) { return $true }
        }
    }
    return $false
}

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

# Ask whether to persist git's directory on the user PATH so it works in any
# terminal. Takes the FINAL git directory (system git dir, or
# $InstallDir\data\mingit\cmd once the staged MinGit is moved).
function Ask-PersistGitOnPath {
    param([string]$GitDir)
    Write-Host "  Git is installed but not on your system PATH." -ForegroundColor Yellow
    Write-Host "  git will only work inside Glitch's launcher unless we add it." -ForegroundColor Yellow
    Write-Prompt "  Add Git to your Windows user PATH so it works in any terminal? (Y/n): "
    $persistAnswer = Read-Host
    if ($persistAnswer -eq '' -or $persistAnswer -like 'y*') {
        try {
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $GitDir } else { "$GitDir;$userPath" }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            Write-Success "  Git added to your user PATH. New terminals will recognize git."
            Write-Host "  Note: existing/open terminals need to be restarted to pick up the new PATH." -ForegroundColor DarkGray
        } catch {
            Write-Warn "  Could not update PATH automatically: $_"
            Write-Host "  You can add it manually later with:" -ForegroundColor Yellow
            Write-Host "    [Environment]::SetEnvironmentVariable('Path', '$GitDir;' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')" -ForegroundColor Gray
        }
    } else {
        Write-Step "  Skipped. You can add Git to your PATH later if needed."
    }
}

# Ask whether to persist the bundled Node.js directory on the user PATH so
# node/npm work in any terminal. Takes the bundled node bin directory
# ($InstallDir\data\node).
function Ask-PersistNodeOnPath {
    param([string]$NodeDir)
    Write-Host "  Node.js is installed but not on your system PATH." -ForegroundColor Yellow
    Write-Host "  node will only work inside Glitch's launcher unless we add it." -ForegroundColor Yellow
    Write-Prompt "  Add Node.js to your Windows user PATH so it works in any terminal? (Y/n): "
    $persistAnswer = Read-Host
    if ($persistAnswer -eq '' -or $persistAnswer -like 'y*') {
        try {
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $newUserPath = if ([string]::IsNullOrEmpty($userPath)) { $NodeDir } else { "$NodeDir;$userPath" }
            [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
            Write-Success "  Node.js added to your user PATH. New terminals will recognize node."
            Write-Host "  Note: existing/open terminals need to be restarted to pick up the new PATH." -ForegroundColor DarkGray
        } catch {
            Write-Warn "  Could not update PATH automatically: $_"
            Write-Host "  You can add it manually later with:" -ForegroundColor Yellow
            Write-Host "    [Environment]::SetEnvironmentVariable('Path', '$NodeDir;' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')" -ForegroundColor Gray
        }
    } else {
        Write-Step "  Skipped. You can add Node.js to your PATH later if needed."
    }
}

# Offer to create a desktop shortcut to launch-glitch.bat. Uses WScript.Shell COM
# to write a .lnk on the user's Desktop (handles OneDrive-redirected desktops via
# [Environment]::GetFolderPath('Desktop')). Wrapped in try/catch so a shortcut
# failure NEVER fails the install — prints a warning and continues.
function Ask-DesktopShortcut {
    param([string]$InstallDir)
    $launcherPath = Join-Path $InstallDir 'launch-glitch.bat'
    if (-not (Test-Path $launcherPath)) {
        Write-Warn "  Skipping desktop shortcut: launcher not found at $launcherPath"
        return
    }
    try {
        $desktopDir = [Environment]::GetFolderPath('Desktop')
        if ([string]::IsNullOrEmpty($desktopDir) -or -not (Test-Path $desktopDir)) {
            Write-Warn "  Skipping desktop shortcut: could not resolve Desktop folder."
            return
        }
        $shortcutPath = Join-Path $desktopDir 'Glitch.lnk'
        Write-Prompt "  Create a desktop shortcut to launch Glitch? (Y/n): "
        $answer = Read-Host
        if ($answer -eq '' -or $answer -like 'y*') {
            $ws = New-Object -ComObject WScript.Shell
            $sc = $ws.CreateShortcut($shortcutPath)
            $sc.TargetPath = $launcherPath
            $sc.WorkingDirectory = $InstallDir
            $sc.WindowStyle = 1   # normal window
            $sc.Description = "Launch Glitch AI"
            $iconPath = Join-Path $InstallDir 'assets\glitch-icon.ico'
            if (Test-Path $iconPath) { $sc.IconLocation = "$iconPath,0" }
            $sc.Save()
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ws) | Out-Null
            Write-Success "  Desktop shortcut created: $shortcutPath"
        } else {
            Write-Step "  Skipped desktop shortcut."
        }
    } catch {
        Write-Warn "  Could not create desktop shortcut: $_"
        Write-Host "  You can create one manually later (right-click Desktop > New > Shortcut > $launcherPath)." -ForegroundColor DarkGray
    }
}

# Show help
if ($Help) {
    Write-Host @"
Glitch AI Installer for Windows

Usage:
  irm https://raw.githubusercontent.com/Cothek/glitch-ai/main/scripts/install.ps1 | iex [-InstallDir <path>] [-NoLaunch] [-NoShortcut] [-Help] [-UserRepo <url>]

Parameters:
  -InstallDir <path>   Custom install directory (default: $HOME\glitch-ai)
  -NoLaunch            Skip launch prompt after installation
  -NoShortcut          Skip desktop shortcut offer
  -Help                Show this help
  -UserRepo <url>      GitHub user repo URL for profile sync (e.g. https://github.com/user/repo.git)

Prerequisites:
  - Git (auto-downloaded if missing -- portable MinGit ~40 MB)
  - Internet connection
  - PowerShell 5.1+ (built into Windows 10/11)

Node.js is NOT required - the bootstrap script downloads a portable Node.js bundle.
"@
    exit 0
}

# Resolve the last commit that touched this installer on the selected branch (best-effort, for issue identification)
$InstallerCommit = ""
try {
    $commitApi = Invoke-RestMethod -Uri "https://api.github.com/repos/Cothek/glitch-ai/commits?path=scripts/install.ps1&sha=$Branch" -Headers @{ "User-Agent" = "glitch-installer" } -TimeoutSec 10 -ErrorAction Stop
    if ($commitApi -and $commitApi.Count -gt 0 -and $commitApi[0].sha) {
        $InstallerCommit = $commitApi[0].sha
        if ($InstallerCommit.Length -gt 7) { $InstallerCommit = $InstallerCommit.Substring(0, 7) }
    }
} catch {
    $InstallerCommit = ""
}

# Banner
$BannerVersionContent = if ($InstallerCommit) { "v$InstallerVersion - commit $InstallerCommit ($Branch)" } else { "v$InstallerVersion" }
$BannerPad = [Math]::Max(0, [Math]::Floor((77 - $BannerVersionContent.Length) / 2))
$BannerVersionLine = "|" + (" " * $BannerPad) + $BannerVersionContent + (" " * [Math]::Max(0, 77 - $BannerPad - $BannerVersionContent.Length)) + "|"
Write-Host @"
+=============================================================================+
|                         GLITCH AI INSTALLER (Windows)                        |
|                    Personal AI Companion - Persistent Memory                 |
$BannerVersionLine
+=============================================================================+
"@ -ForegroundColor Magenta

# 1. Check PowerShell version
Write-Header "Checking prerequisites..."
$psVersion = $PSVersionTable.PSVersion.Major
if ($psVersion -lt 5) {
    Write-Error "PowerShell 5.1+ required. Current: $($PSVersionTable.PSVersion)"
    Write-Error "Upgrade: https://github.com/PowerShell/PowerShell/releases"
    throw "Installation failed"
}
Write-Success "PowerShell $($PSVersionTable.PSVersion) OK"

# 2. Choose install location
Write-Header "Installation location"
if (-not $PSBoundParameters.ContainsKey('InstallDir')) {
    Write-Host "  Where should Glitch AI be installed?" -ForegroundColor White
    Write-Host ""
    Write-Host "  [1] Current directory: $(Join-Path (Get-Location).Path "glitch-ai")" -ForegroundColor White
    Write-Host "  [2] User home directory: $HOME\glitch-ai (default)" -ForegroundColor White
    Write-Host "  [3] Custom path" -ForegroundColor White
    Write-Host ""
    Write-Prompt "  Choose (Enter=2): "
    $locChoice = Read-Host
    switch ($locChoice) {
        '1' { $InstallDir = Join-Path (Get-Location).Path "glitch-ai" }
        '3' {
            $custom = Read-Host "  Enter installation path"
            if (-not [string]::IsNullOrWhiteSpace($custom)) {
                $InstallDir = $custom.Trim()
            }
        }
    }
}
Write-Success "Installation directory: $InstallDir"

# 3. Check git -- auto-download portable MinGit if missing
$gitProvisioned = $false
$gitStagedDir = $null
$gitNeedsPersistence = $false
$gitPath = (Get-Command git -ErrorAction SilentlyContinue).Source

if (Test-GitInPersistedPath) {
    # Git already on the global (persisted) PATH -- nothing to do, don't ask.
    if (-not $gitPath) {
        # Session doesn't see it yet (PATH changed after this terminal opened).
        # Resolve the actual git.exe from the persisted PATH.
        $gitPath = Get-PersistedGitPath
    }
    Write-Success "Git found in system PATH: $gitPath"
} else {
    # Git NOT on the global PATH. Provision if needed, then ask to persist.
    if (-not $gitPath) {
        # Check if MinGit was already downloaded to the install dir (partial re-run)
        $existingBundledGit = Join-Path $InstallDir "data\mingit\cmd\git.exe"
        if (Test-Path $existingBundledGit) {
            $gitPath = $existingBundledGit
            $env:PATH = "$(Split-Path $gitPath -Parent);$env:PATH"
            Write-Step "Using existing bundled Git at $gitPath"
            $gitNeedsPersistence = $true
        } else {
            Write-Warn "Git not found in PATH."
            Write-Step "Downloading MinGit (portable Git for Windows, ~40 MB)..."

            $gitStagedDir = Join-Path $env:TEMP "glitch-mingit"
            $gitBin = Join-Path $gitStagedDir "cmd\git.exe"

            # Try to get latest release URL from GitHub API
            try {
                $apiUrl = "https://api.github.com/repos/git-for-windows/git/releases/latest"
                $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing -TimeoutSec 10
                $minGitAsset = $release.assets | Where-Object { $_.name -like "MinGit-*-64-bit.zip" } | Select-Object -First 1
                if ($minGitAsset) {
                    $downloadUrl = $minGitAsset.browser_download_url
                    Write-Step "  Found: $($minGitAsset.name)"
                } else {
                    throw "No MinGit asset found in latest release"
                }
            } catch {
                # Fallback to known good version
                $downloadUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.0.windows.2/MinGit-2.47.0.2-64-bit.zip"
                Write-Step "  Using fixed MinGit 2.47.0.2 (API failed: $($_.Exception.Message))"
            }

            $tempZip = Join-Path $env:TEMP "glitch-mingit.zip"
            try {
                Invoke-WithSpinner -Label "Downloading MinGit (40MB)" -DoneMessage "MinGit" -ScriptBlock {
                  Invoke-WebRequest -Uri $using:downloadUrl -OutFile $using:tempZip -UseBasicParsing -TimeoutSec 120
                }

                New-Item -ItemType Directory -Path $gitStagedDir -Force | Out-Null
                Invoke-WithSpinner -Label "Extracting MinGit" -DoneMessage "MinGit" -ScriptBlock {
                  Expand-Archive -Path $using:tempZip -DestinationPath $using:gitStagedDir -Force
                }
                Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

                if (-not (Test-Path $gitBin)) {
                    throw "MinGit binary not found after extraction at $gitBin"
                }
                $env:PATH = "$gitStagedDir\cmd;$gitStagedDir\usr\bin;$env:PATH"
                $gitPath = $gitBin
                $gitProvisioned = $true
                $gitNeedsPersistence = $true
                Write-Success "MinGit staged to $gitStagedDir (will be moved after clone)"
            } catch {
                Remove-Item $gitStagedDir -Recurse -Force -ErrorAction SilentlyContinue
                Write-Error "Failed to download MinGit: $_"
                Write-Error "Install Git manually from https://git-scm.com/download/win"
                Write-Error "After installing, restart your terminal and re-run the installer."
                throw "Installation failed"
            }
        }
    } else {
        # gitPath was found via session PATH
        $gitNeedsPersistence = $true
    }
    # Prompt now when the git location is already final (system git on session
    # PATH, or bundled MinGit already at its final location). The just-downloaded
    # staged case is deferred until after the clone when the final location is known.
    if ($gitNeedsPersistence -and -not $gitProvisioned) {
        Ask-PersistGitOnPath -GitDir (Split-Path $gitPath -Parent)
        $gitNeedsPersistence = $false
    }
}

# 4. Check install directory
Write-Header "Installation directory: $InstallDir"

if (Test-Path "$InstallDir\.git") {
    # Existing git repo -- offer update
    Write-Warn "Glitch AI already installed at $InstallDir"
    Write-Prompt "Update to latest version? (Y/n): "
    $update = Read-Host
    if ($update -eq '' -or $update -like 'y*') {
        Write-Step "Pulling latest changes..."
        Push-Location $InstallDir
        try {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $result = git pull --ff-only 2>&1
            $exitCode = $LASTEXITCODE
            $ErrorActionPreference = $prevEAP
            Pop-Location
            if ($exitCode -eq 0) {
                Write-Success "Updated to latest version"
            } else {
                Write-Error "Update failed: $($result -join "`n")"
                Write-Warn "You may have local changes. Try: cd $InstallDir && git status"
                throw "Installation failed"
            }
        } catch {
            $ErrorActionPreference = $prevEAP
            Pop-Location -ErrorAction SilentlyContinue
            Write-Error "Update failed: $_"
            Write-Warn "You may have local changes. Try: cd $InstallDir && git status"
            throw "Installation failed"
        }
    } else {
        Write-Warn "Skipping update. Using existing installation."
    }
} elseif (Test-Path $InstallDir) {
    # Directory exists and has actual content -- ask what to do
    Write-Warn "Directory '$InstallDir' already exists (not a git repo)."
    Write-Host ""
    Write-Host "  [1] Overwrite (delete and re-clone)" -ForegroundColor White
    Write-Host "  [2] Choose a different directory" -ForegroundColor White
    Write-Host "  [3] Cancel" -ForegroundColor White
    Write-Host ""
    Write-Prompt "  Choose (Enter=3): "
    $overChoice = Read-Host
    switch ($overChoice) {
        '1' {
            Write-Step "Removing existing directory..."
            Remove-Item $InstallDir -Recurse -Force
            Write-Success "Directory cleared."
        }
        '2' {
            $newDir = Read-Host "  Enter new installation path"
            if (-not [string]::IsNullOrWhiteSpace($newDir)) {
                $InstallDir = $newDir.Trim()
                Write-Success "Will install to: $InstallDir"
            } else {
                Write-Warn "Installation cancelled."
                exit 0
            }
        }
        default {
            Write-Warn "Installation cancelled."
            exit 0
        }
    }
}

# Fresh install (or after overwrite)
if (-not (Test-Path "$InstallDir\.git")) {
    $parentDir = Split-Path $InstallDir -Parent
    if (-not (Test-Path $parentDir)) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }

    # Track submodule status for end-of-install summary
    $script:SubmoduleSuccess = @()
    $script:SubmoduleFailures = @()
    $script:CloneSucceeded = $false

    try {
      Invoke-WithSpinner -Label "Cloning Glitch AI repository" -DoneMessage "Repository" -ScriptBlock {
        $r = & $using:gitPath clone https://github.com/Cothek/glitch-ai.git "$using:InstallDir" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "Clone failed (exit $LASTEXITCODE)`n$r" }
        $script:CloneSucceeded = $true
      }
      Write-Success "Repository cloned to $InstallDir"
    } catch {
      Write-Error "Clone failed: $_"
      throw "Installation failed"
    }
    if ($Branch -ne "main") {
        Write-Step "Checking out branch: $Branch..."
        Push-Location $InstallDir
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $gitPath checkout $Branch 2>&1 | Out-Null
        $ErrorActionPreference = $prevEAP
        Pop-Location
    }

    # Finalize bundled git: move the staged MinGit into the install dir so the
    # launcher (launch-glitch.bat) finds it at data\mingit on future
    # launches. Copy + remove, NOT Move-Item: %TEMP% may be on a different volume.
    if ($gitProvisioned -and $gitStagedDir) {
        $finalGitDir = Join-Path $InstallDir "data\mingit"
        if (-not (Test-Path $finalGitDir)) { New-Item -ItemType Directory -Path $finalGitDir -Force | Out-Null }
        Copy-Item "$gitStagedDir\*" $finalGitDir -Recurse -Force
        if (-not (Test-Path (Join-Path $finalGitDir "cmd\git.exe"))) {
            throw "MinGit copy failed: $finalGitDir\cmd\git.exe missing after copy"
        }
        Remove-Item $gitStagedDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $env:TEMP "glitch-mingit.zip") -Force -ErrorAction SilentlyContinue
        $env:PATH = "$finalGitDir\cmd;$finalGitDir\usr\bin;$env:PATH"
        $gitPath = Join-Path $finalGitDir "cmd\git.exe"
        Write-Success "MinGit installed to $finalGitDir"
    }

    # Persist the FINAL git location for the staged (just-downloaded) case.
    if ($gitNeedsPersistence) {
        Ask-PersistGitOnPath -GitDir (Split-Path $gitPath -Parent)
    }

    # Initialize submodules individually so one failure doesn't block the others
    if ($script:CloneSucceeded) {
        Push-Location $InstallDir
        try {
            $initOutput = & $gitPath submodule init 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Warn "git submodule init returned non-zero (continuing): $initOutput"
            }
        } catch {
            Write-Warn "git submodule init failed (continuing): $_"
        }

        # Read submodule list from .gitmodules
        $rawLines = git config --file .gitmodules --get-regexp path 2>&1
        $submodules = @()
        foreach ($line in $rawLines) {
            if ($line -match 'submodule\..+\.path\s+(.+)') {
                $submodules += $matches[1].Trim()
            }
        }

        # Initialize each submodule individually so one failure doesn't block the others
        if ($submodules.Count -eq 0) {
            Write-Warn "No submodules found in .gitmodules"
        } else {
            $issueFile = Join-Path $InstallDir "data\install-issues.md"
            $issueDir = Split-Path -Parent $issueFile
            if (-not (Test-Path $issueDir)) {
                New-Item -ItemType Directory -Path $issueDir -Force | Out-Null
            }

            foreach ($submodule in $submodules) {
                Write-Step "Updating submodule: $submodule"
                $subOutput = & $gitPath submodule update --init $submodule 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "  ${submodule}: OK"
                    $script:SubmoduleSuccess += $submodule
                } else {
                    Write-Warn "  ${submodule}: FAILED"
                    $subOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
                    $script:SubmoduleFailures += $submodule

                    # Log to install-issues.md (same format as install.sh, parseable by check-install-issues.mjs)
                    # NOTE: Use AppendAllText with UTF8Encoding($false) to write UTF-8 WITHOUT BOM.
                    # Out-File -Encoding utf8 on PowerShell 5.1 writes a BOM (EF BB BF), which breaks
                    # check-install-issues.mjs (it reads with readFileSync('utf8') and anchors ^## with /m).
                    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
                    $issueContent = @"

## Install Issue - $timestamp
- **Subsystem**: Submodule clone
- **Component**: $submodule
- **Error**:
````
$subOutput
````
- **Impact**: Some memory/skill files may be missing until resolved
- **Fix**: Tell Glitch "check install issues" or run: cd $InstallDir && git submodule update --init --recursive

"@
                    [System.IO.File]::AppendAllText($issueFile, $issueContent, [System.Text.UTF8Encoding]::new($false))
                }
            }

            Write-Host ""
            if ($script:SubmoduleFailures.Count -eq 0) {
                Write-Success "All submodules initialized successfully"
            } else {
                Write-Warn "Some submodules failed to clone (see above)"
                Write-Warn "Issues logged to: $issueFile"
                Write-Warn "Glitch will attempt to fix these on first launch."
            }
        }
    }
}

# Relocate the install log into the install dir. The log always starts in TEMP
# and this runs on BOTH the fresh and update paths: after the clone or pull the
# install dir exists to receive it.
$targetLog = Join-Path $InstallDir "install.log"
if ($script:LogFile -and $script:LogFile -ne $targetLog) {
    try {
        Stop-Transcript | Out-Null
        Copy-Item $script:LogFile $targetLog -Force
        $script:LogFile = $targetLog
        Start-Transcript -Path $script:LogFile -Append | Out-Null
        Write-Host "  Log file: $script:LogFile" -ForegroundColor DarkGray
    } catch {
        # Keep logging to TEMP on failure
        try { Start-Transcript -Path (Join-Path $env:TEMP "glitch-install.log") -Append | Out-Null } catch {}
    }
}

# 4. Run bootstrap
Write-Header "Running bootstrap (downloads Node.js, OpenCode, Handy, etc.)..."
$bootstrapPath = "$InstallDir\scripts\bootstrap.ps1"
if (-not (Test-Path $bootstrapPath)) {
    Write-Error "bootstrap.ps1 not found at $bootstrapPath"
    throw "Installation failed"
}

Push-Location $InstallDir
Write-Step "Executing bootstrap.ps1..."
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\bootstrap.ps1"
$bootstrapExit = $LASTEXITCODE
Pop-Location

if ($bootstrapExit -ne 0) {
    Write-Error "Bootstrap failed with exit code $bootstrapExit"
    throw "Installation failed"
}
Write-Success "Bootstrap completed successfully"

# Offer to persist bundled Node.js on the user PATH (only if node actually
# exists and is not already on the persisted User/Machine PATH).
$bundledNodeExe = Join-Path $InstallDir "data\node\node.exe"
$bundledNodeDir = Join-Path $InstallDir "data\node"
if ((Test-Path $bundledNodeExe) -and -not (Test-PathInPersistedPath -TargetDir $bundledNodeDir)) {
    Ask-PersistNodeOnPath -NodeDir $bundledNodeDir
} elseif (Test-Path $bundledNodeExe) {
    Write-Step "Bundled Node.js is already on your persisted PATH (no need to add it)."
}

# 4.5. Install GitNexus (MCP code graph)
Write-Header "Installing GitNexus (MCP code graph)..."
$gitnexusOk = $false
$bundledNodeBin = Join-Path $InstallDir "data\node"
$bundledNpm = Join-Path $bundledNodeBin "npm.cmd"

# Skip if gitnexus is already present (bundled tree or PATH)
$alreadyInstalled = $false
if ((Test-Path (Join-Path $bundledNodeBin "node_modules\gitnexus")) -or
    (Test-Path (Join-Path $bundledNodeBin "gitnexus.cmd")) -or
    (Test-Path (Join-Path $bundledNodeBin "gitnexus.exe")) -or
    (Get-Command gitnexus -ErrorAction SilentlyContinue)) {
    $alreadyInstalled = $true
}

if ($alreadyInstalled) {
    $gitnexusOk = $true
    Write-Success "GitNexus already installed (MCP code graph)"
} else {
    # Prefer bundled npm (always writable, correct Node version); fall back to system npm
    $npmCmd = $null
    if (Test-Path $bundledNpm) {
        $npmCmd = $bundledNpm
    } else {
        $sysNpm = Get-Command npm -ErrorAction SilentlyContinue
        if ($sysNpm -and (Test-Path $sysNpm.Source)) {
            $npmCmd = $sysNpm.Source
        }
    }

    if ($npmCmd) {
        # Prepend bundled node bin to PATH so postinstall scripts and bare node/npx
        # resolve the bundled node (gitnexus requires node >=22)
        $env:PATH = "$bundledNodeBin;$env:PATH"

        Write-Step "Installing gitnexus via npm (MCP code graph)..."
        $script:GitNexusInstallException = $null
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            [string[]]$npmOutput = & $npmCmd install -g gitnexus 2>&1
            if ($LASTEXITCODE -eq 0) {
                $gitnexusOk = $true
            } else {
                $gitnexusOk = $false
                Write-Warn "gitnexus npm install failed (exit code $LASTEXITCODE). Output:"
                $npmOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkYellow }
            }
        } catch {
            $script:GitNexusInstallException = $_
            $gitnexusOk = $false
        } finally {
            $ErrorActionPreference = $prevEAP
        }

        # Verify after install
        if (-not $gitnexusOk) {
            if ((Test-Path (Join-Path $bundledNodeBin "gitnexus.cmd")) -or
                (Test-Path (Join-Path $bundledNodeBin "gitnexus.exe")) -or
                (Test-Path (Join-Path $bundledNodeBin "node_modules\gitnexus"))) {
                $gitnexusOk = $true
            } else {
                try {
                    $listOut = & $npmCmd list -g --depth=0 gitnexus 2>&1
                    if ($LASTEXITCODE -eq 0 -and $listOut -match 'gitnexus@') {
                        $gitnexusOk = $true
                    }
                } catch {}
            }
        }
    } else {
        Write-Warn "No npm found (bundled or system). Cannot install GitNexus."
    }
}

if ($gitnexusOk) {
    Write-Success "GitNexus installed (MCP code graph)"
} elseif ($script:GitNexusInstallException) {
    Write-Warn "GitNexus install had an issue (non-fatal): $($script:GitNexusInstallException.Exception.Message)"
    Write-Host "  Manual install: cd $InstallDir; .\data\node\npm.cmd install -g gitnexus" -ForegroundColor DarkGray
} else {
    Write-Warn "GitNexus install failed (non-fatal). Manual install: cd $InstallDir; .\data\node\npm.cmd install -g gitnexus"
}

# 4.6. GitNexus FTS/OpenSSL fix (semantic search)
# The gitnexus FTS extension needs OpenSSL 3 DLLs (libssl-3-x64.dll / libcrypto-3-x64.dll)
# which ship with Git for Windows at <GitRoot>\mingw64\bin. Without them on PATH,
# the FTS extension fails to load (Windows error 126) and `gitnexus query` returns empty.
Write-Header "Configuring GitNexus FTS (semantic search)..."
$gitnexusCmd = $null
if (Test-Path (Join-Path $bundledNodeBin "gitnexus.cmd")) {
    $gitnexusCmd = Join-Path $bundledNodeBin "gitnexus.cmd"
} elseif (Test-Path (Join-Path $bundledNodeBin "gitnexus.exe")) {
    $gitnexusCmd = Join-Path $bundledNodeBin "gitnexus.exe"
} elseif (Get-Command gitnexus -ErrorAction SilentlyContinue) {
    $gitnexusCmd = (Get-Command gitnexus).Source
}

if ($gitnexusCmd) {
    # Find Git's mingw64\bin (ships OpenSSL 3 DLLs the FTS extension needs)
    $gitMingw64Bin = $null
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe) {
        $gitPath = $gitExe.Source
        $idx = $gitPath.ToLower().IndexOf('\cmd\git')
        if ($idx -ge 0) {
            $candidate = Join-Path (Join-Path $gitPath.Substring(0, $idx) 'mingw64') 'bin'
            if (Test-Path (Join-Path $candidate 'libssl-3-x64.dll')) {
                $gitMingw64Bin = $candidate
            }
        }
    }
    if (-not $gitMingw64Bin) {
        # Fallback: scan common Git install roots
        $roots = @('C:\Program Files\Git', 'D:\Program Files\Git', 'E:\Program Files\Git', 'C:\Program Files (x86)\Git')
        foreach ($root in $roots) {
            $candidate = Join-Path (Join-Path $root 'mingw64') 'bin'
            if (Test-Path (Join-Path $candidate 'libssl-3-x64.dll')) {
                $gitMingw64Bin = $candidate
                break
            }
        }
    }

    if ($gitMingw64Bin) {
        Write-Step "Found Git mingw64 bin at $gitMingw64Bin - prepending to PATH for FTS/OpenSSL"
        $env:PATH = $gitMingw64Bin + ';' + $env:PATH
    } else {
        Write-Warn "Git mingw64 bin not found - FTS extension may fail to load (OpenSSL 3 DLLs missing). Semantic search will degrade."
    }

    # Repair FTS indexes (one-time; subsequent analyzes maintain them incrementally)
    Write-Step "Repairing GitNexus FTS indexes..."
    $env:GITNEXUS_LBUG_BUFFER_POOL_SIZE = '4294967296'  # 4 GiB - required when FTS is enabled
    try {
        & $gitnexusCmd analyze --repair-fts 2>&1 | ForEach-Object { Write-Host "  $_" }
        Write-Success "GitNexus FTS indexes repaired successfully"
    } catch {
        Write-Warn "FTS repair failed (non-fatal): $_"
        Write-Host "  You can run manually later: gitnexus analyze --repair-fts"
    }
} else {
    Write-Warn "gitnexus command not found after install - skipping FTS repair"
}

# 5. User profile setup
Write-Header "User Profile Setup"

$userDir = "$InstallDir\user"
$userProfileExists = Test-Path "$userDir\main-memory.md"

# First: check if they have an existing GitHub profile to clone
$ghUser = $null
$repoName = $null
$cloneAttempted = $false

if ($UserRepo) {
    $parsed = $UserRepo -replace 'https?://github\.com/', '' -replace '\.git$', ''
    $parts = $parsed -split '/'
    if ($parts.Count -eq 2) {
        $ghUser = $parts[0]
        $repoName = $parts[1]
        $cloneAttempted = $true
        Write-Host "  Using specified user repo: $ghUser/$repoName" -ForegroundColor Cyan
    } else {
        Write-Warn "Could not parse UserRepo URL: $UserRepo"
    }
} else {
    # Always ask about GitHub profile connection
    Write-Host ""
    Write-Host "Do you have an existing Glitch user profile on GitHub?" -ForegroundColor White
    Write-Host "  (If not, you can set this up later inside Glitch.)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Prompt "Connect existing profile from GitHub? (y/N): "
    $syncProfile = Read-Host
    if ($syncProfile -like 'y*') {
        Write-Prompt "GitHub username: "
        $ghUser = Read-Host
        if ($ghUser) {
            Write-Prompt "Repository name (default: glitch-user-$ghUser): "
            $repoName = Read-Host
            if (-not $repoName) { $repoName = "glitch-user-$ghUser" }
            $cloneAttempted = $true
        }
    }
}

# Auto-detect the primary branch and let the user pick if multiple branches exist
function Select-UserRepoBranch {
    param([string]$RepoUrl)
    $primary = $null
    $branches = @()
    try {
        $symrefOut = & git ls-remote --symref $RepoUrl HEAD 2>&1
        foreach ($line in $symrefOut) {
            if ($line -match '^ref:\s+refs/heads/(.+?)\s+HEAD') {
                $primary = $matches[1].Trim()
                break
            }
        }
        $headsOut = & git ls-remote --heads $RepoUrl 2>&1
        foreach ($line in $headsOut) {
            if ($line -match 'refs/heads/(.+)$') {
                $branches += $matches[1].Trim()
            }
        }
        $branches = $branches | Sort-Object -Unique
    } catch { }
    if (-not $primary) { return "main" }
    if ($branches.Count -le 1) { return $primary }

    Write-Host ""
    Write-Warn "Remote repo has multiple branches:"
    for ($i = 0; $i -lt $branches.Count; $i++) {
        $marker = if ($branches[$i] -eq $primary) { " (primary)" } else { "" }
        Write-Host "    [$($i+1)] $($branches[$i])$marker" -ForegroundColor White
    }
    Write-Prompt "  Which branch to use? (Enter=$primary): "
    $choice = Read-Host
    if ($choice -match '^\d+$') {
        $idx = [int]$choice - 1
        if ($idx -ge 0 -and $idx -lt $branches.Count) {
            return $branches[$idx]
        }
        Write-Warn "Invalid choice, using primary: $primary"
    }
    return $primary
}

# Try to clone existing profile if requested
if ($cloneAttempted -and $ghUser -and $repoName) {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        Write-Step "Connecting to $ghUser/$repoName..."

        $repoUrl = "https://github.com/$ghUser/$repoName.git"
        $useBranch = Select-UserRepoBranch -RepoUrl $repoUrl

        # Clear user dir for clean clone
        if (Test-Path $userDir) {
            Remove-Item "$userDir\*" -Recurse -Force -ErrorAction SilentlyContinue
        }
        if (-not (Test-Path $userDir)) {
            New-Item -ItemType Directory -Path $userDir -Force | Out-Null
        }

        # Clone straight into user dir
        # GCM should handle auth with a browser popup
        $cloneOutput = git clone -b $useBranch $repoUrl "$userDir" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "Profile downloaded from GitHub (branch: $useBranch)"
        } else {
            # Clone failed - offer PAT as fallback
            Write-Warn "  Could not access $ghUser/$repoName."
            Write-Host ""
            Write-Host "  The repository may be private or require authentication." -ForegroundColor Yellow
            Write-Host "  Git Credential Manager was installed earlier in this setup." -ForegroundColor Yellow
            Write-Host "  A browser window should open for you to log into GitHub." -ForegroundColor Yellow
            Write-Host "  If that didn't work, you can use a Personal Access Token." -ForegroundColor Yellow
            Write-Host ""
            Write-Prompt "  Enter GitHub Personal Access Token (or press Enter to skip): "
            $ghToken = Read-Host
            if ($ghToken) {
                # Clean failed clone first
                Remove-Item "$userDir\*" -Recurse -Force -ErrorAction SilentlyContinue
                git clone -b $useBranch "https://$ghUser`:$ghToken@github.com/$ghUser/$repoName.git" "$userDir" 2>&1
                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Profile downloaded from GitHub (branch: $useBranch)"
                } else {
                    Write-Warn "  Still could not connect."
                    $cloneAttempted = $false
                }
            } else {
                $cloneAttempted = $false
            }
        }
    } catch {
        Write-Warn "  Profile connection failed: $_"
        $cloneAttempted = $false
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

# If no clone was attempted or it failed, create local starter files
if (-not $cloneAttempted -or -not (Test-Path "$userDir\main-memory.md")) {
    if (-not (Test-Path $userDir)) {
        New-Item -ItemType Directory -Path $userDir -Force | Out-Null
    }

    $needsStarter = -not (Test-Path "$userDir\main-memory.md")
    if ($needsStarter) {
        Write-Step "Creating local user profile..."

        $starterMemory = @"
---
type: UserProfile
title: Main Memory
description: Your personal profile and preferences
tags: [user, profile]
timestamp: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
---
# Main Memory
## User Profile
*To be filled in through interaction with Glitch*
"@
        Set-Content -LiteralPath "$userDir\main-memory.md" -Value $starterMemory -Encoding UTF8

        $starterSession = @"
---
type: SessionMemory
title: Current Session Memory
tags: [session, ram]
timestamp: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
---
# Current Session Memory
## Session Recap
*First session with Glitch*
"@
        Set-Content -LiteralPath "$userDir\current-session.md" -Value $starterSession -Encoding UTF8

        $starterReminders = @"
---
type: ReminderLog
title: Reminders
description: Cross-session reminders
tags: [reminders]
timestamp: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
---
# Reminders
"@
        Set-Content -LiteralPath "$userDir\reminders.md" -Value $starterReminders -Encoding UTF8

        $starterDashboard = @"
---
type: Dashboard
title: Session Dashboard
description: Active workstream tracker
tags: [dashboard]
timestamp: $(Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
---
# Session Dashboard
"@
        Set-Content -LiteralPath "$userDir\session-dashboard.md" -Value $starterDashboard -Encoding UTF8

        # Initialize git on main branch (never master) so the profile is ready for sync
        Push-Location $userDir
        try {
            $gitVersion = (& git --version 2>&1)
            $canInitB = $false
            if ($gitVersion -match 'version (\d+)\.(\d+)') {
                $verMajor = [int]$matches[1]
                $verMinor = [int]$matches[2]
                $canInitB = ($verMajor -gt 2) -or ($verMajor -eq 2 -and $verMinor -ge 28)
            }
            $initErr = $null
            if ($canInitB) {
                $initErr = (& git init -b main 2>&1)
                if ($LASTEXITCODE -ne 0) { throw "git init -b main failed: $initErr" }
            } else {
                $initErr = (& git init 2>&1)
                if ($LASTEXITCODE -ne 0) { throw "git init failed: $initErr" }
                $currentRef = (& git symbolic-ref HEAD 2>&1)
                if ($currentRef -match 'refs/heads/main') {
                    # already on main — nothing to do
                } else {
                    $renameErr = (& git branch -m main 2>&1)
                    if ($LASTEXITCODE -ne 0) {
                        Write-Warn "Could not rename branch to main: $renameErr (continuing)"
                    }
                }
            }
            Write-Success "Git repo initialized on main branch"
        } catch {
            Write-Warn "Could not initialize git in user dir: $_"
        } finally {
            Pop-Location
        }

        Write-Success "User profile created at $userDir"
    } else {
        Write-Success "User profile already exists at $userDir"
    }
}

# Show next steps for GitHub sync
if ($cloneAttempted -and -not (Test-Path "$userDir\.git")) {
    Write-Host ""
    Write-Host "  To connect your profile to GitHub later, start Glitch and say:" -ForegroundColor Cyan
    Write-Host '    "Connect my user profile to GitHub"' -ForegroundColor Yellow
    Write-Host ""
} elseif ($cloneAttempted) {
    # Clone succeeded -- profile synced from GitHub
    Write-Host ""
    Write-Host "  Profile downloaded from GitHub." -ForegroundColor Green
    Write-Host "  To sync changes later, start Glitch and say:" -ForegroundColor Cyan
    Write-Host '    "Connect my user profile to GitHub"' -ForegroundColor Yellow
    Write-Host ""
} elseif (-not $cloneAttempted) {
    Write-Host ""
    Write-Host "  Profile is local-only (git repo initialized on main branch)." -ForegroundColor Cyan
    Write-Host "  To sync with GitHub later, start Glitch and say:" -ForegroundColor Cyan
    Write-Host '    "Connect my user profile to GitHub"' -ForegroundColor Yellow
    Write-Host ""
}

# 6. Verify installation
Write-Header "Verifying installation..."
Push-Location $InstallDir
$checkNode = if (Test-Path "$InstallDir\data\node\node.exe") { "$InstallDir\data\node\node.exe" } else { "node" }
Write-Step "Running install verification..."
& $checkNode scripts/check-install.mjs 2>&1 | Write-Host
$checkExit = $LASTEXITCODE
Pop-Location

if ($checkExit -ne 0) {
    Write-Warn "Some checks did not pass. Review the report above for details."
    Write-Warn "Items marked with [X] under 'Core' indicate critical issues."
}

# 6.5. Seed default plugins into user/plugins.json (additive merge)
Write-Header "Seeding default plugins..."
Push-Location $InstallDir
try {
    $seedOutput = & $checkNode scripts/plugin.mjs seed 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Seeded default plugins. Edit user\plugins.json to customize."
        if ($seedOutput) { Write-Host "  $seedOutput" -ForegroundColor DarkGray }
    } else {
        Write-Warn "Plugin seed returned non-zero (continuing): $seedOutput"
    }
} catch {
    Write-Warn "Plugin seed failed (non-critical): $_"
}
Pop-Location

# 6.7. Desktop shortcut offer (skipped when -NoShortcut is set)
if (-not $NoShortcut) {
    Ask-DesktopShortcut -InstallDir $InstallDir
}

# 7. Launch
if (-not $NoLaunch) {
    Write-Header "Launch Glitch AI"
    Write-Prompt "Launch Glitch now? (Y/n): "
    $launch = Read-Host
    if ($launch -eq '' -or $launch -like 'y*') {
        Write-Step "Starting Glitch AI..."
        Push-Location $InstallDir
        # Use Start-Process to launch in a new window (detached)
        $proc = Start-Process -FilePath "launch-glitch.bat" -WindowStyle Normal -PassThru
        Write-Success "Glitch AI launched (PID: $($proc.Id))"
        Write-Host ""
        Write-Host "  To launch again later, run:" -ForegroundColor Cyan
        Write-Host "    cd $InstallDir" -ForegroundColor Gray
        Write-Host "    .\launch-glitch.bat" -ForegroundColor Gray
        Pop-Location
    }
}

# Summary of any install issues (shown only if something failed)
if ($script:SubmoduleFailures.Count -gt 0) {
    Write-Host ""
    Write-Host "  WARNING: Some components couldn't be downloaded during install." -ForegroundColor Yellow
    Write-Host "    Issues logged to: $InstallDir\data\install-issues.md" -ForegroundColor Yellow
    Write-Host "    Glitch will review and attempt to fix these on first launch." -ForegroundColor Yellow
    Write-Host "    Manual fix: cd $InstallDir && git submodule update --init --recursive" -ForegroundColor Yellow
    Write-Host ""
}

Write-Header "Installation Complete!"
Write-Host @"
Glitch AI is installed at: $InstallDir

Next steps:
  * Launch:        cd $InstallDir && .\launch-glitch.bat
  * Free mode:     cd $InstallDir && .\launch-glitch.bat (select Free at prompt)
  * Local mode:    cd $InstallDir && .\launch-glitch.bat (select Local at prompt)
  * Safe mode:     cd $InstallDir && .\launch-glitch.bat (select Safe at prompt)
  * Update:        Re-run this installer (it will pull latest)
  * User sync:     .\scripts\sync-user.ps1 -Push  (after making changes)

Documentation: https://github.com/Cothek/glitch-ai
"@ -ForegroundColor Green

# Stop logging
try { Stop-Transcript | Out-Null } catch {}