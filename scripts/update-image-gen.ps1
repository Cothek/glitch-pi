param(
  [switch]$CheckOnly = $false,
  [switch]$UpdatePython = $false,
  [switch]$UpdateComfyUI = $false,
  [switch]$UpdateDeps = $false
)

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$ComfyDir = Join-Path $RootDir "data\comfyui"
$ComfyUIDir = Join-Path $ComfyDir "ComfyUI"
$VenvPython = Join-Path $ComfyDir "venv\Scripts\python.exe"
$PythonDir = Join-Path $RootDir "data\python"
$StatusFile = Join-Path $RootDir "data\image-gen-status.json"

function Write-ColorHost {
  param([string]$Text, [string]$Color = "White")
  Write-Host $Text -ForegroundColor $Color
}

# --- Early exit if not installed ---
$installed = $true
if (-not (Test-Path $ComfyDir)) {
  Write-ColorHost "ComfyUI not installed at $ComfyDir" "Yellow"
  $statusJson = @{
    checked_at = (Get-Date -Format "o")
    installed = $false
    python = @{ current = $null; latest = $null; update_available = $false }
    comfyui = @{ current_commit = $null; behind = $null; update_available = $false }
    deps = @()
    model = @{ name = "sd_xl_base_1.0.safetensors"; download_url = "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors" }
  } | ConvertTo-Json -Depth 4
  $statusJson | Set-Content -Path $StatusFile -Encoding UTF8
  Write-ColorHost "Status written to $StatusFile" "Gray"
  exit 0
}

# --- Collect results ---
$pythonResult = @{ current = $null; latest = $null; update_available = $false }
$comfyuiResult = @{ current_commit = $null; behind = $null; update_available = $false }
$depsResult = @()

# ========== 1. Check Python version ==========
$versionFile = Join-Path $PythonDir "version.txt"
$pythonCurrent = $null

if (Test-Path $versionFile) {
  $pythonCurrent = (Get-Content $versionFile -ErrorAction SilentlyContinue).Trim()
}

$pythonLatest = $null
try {
  $releaseJson = Invoke-WebRequest -Uri "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest" -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop | ConvertFrom-Json
  if ($releaseJson.tag_name) {
    $pythonLatest = $releaseJson.tag_name.TrimStart('v')
  }
} catch {
  Write-ColorHost "  WARNING: Could not check latest Python version (offline?)" "Yellow"
}

$pythonUpdate = $false
if ($pythonCurrent -and $pythonLatest -and $pythonCurrent -ne $pythonLatest) {
  $pythonUpdate = $true
}

$pythonResult = @{
  current = $pythonCurrent
  latest = $pythonLatest
  update_available = $pythonUpdate
}

# Apply Python update
if ($UpdatePython -and $pythonUpdate -and $pythonLatest) {
  Write-ColorHost "  Updating Python from $pythonCurrent to $pythonLatest..." "Cyan"
  try {
    $arch = "x86_64"
    $downloadUrl = "https://github.com/astral-sh/python-build-standalone/releases/download/$pythonLatest/cpython-$pythonLatest-$arch-pc-windows-msvc-shared-install_only.tar.gz"
    $tempGz = Join-Path $env:TEMP "python-build-standalone.tar.gz"
    $tempExtract = Join-Path $env:TEMP "python-extracted"

    Invoke-WebRequest -Uri $downloadUrl -OutFile $tempGz -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop
    Write-ColorHost "  Downloaded python-build-standalone $pythonLatest" "Green"

    if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null

    # Extract tar.gz using tar (Windows 10+ built-in)
    $systemTarExe = Join-Path $env:SystemRoot "System32\tar.exe"
    $tarExe = if (Test-Path $systemTarExe) { $systemTarExe } else { 'tar' }
    & $tarExe -xzf $tempGz -C $tempExtract 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      # Fallback: try 7z or expand
      $7z = Get-Command "7z" -ErrorAction SilentlyContinue
      if ($7z) {
        & $7z.Source x $tempGz -o"$tempExtract" -y 2>&1 | Out-Null
      } else {
        throw "No tar or 7z available for extraction"
      }
    }

    # Find the python/ directory inside extraction
    $pythonInstallDir = Get-ChildItem -Path $tempExtract -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "python*" } | Select-Object -First 1
    if (-not $pythonInstallDir) {
      $pythonInstallDir = Get-ChildItem -Path $tempExtract -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    if ($pythonInstallDir) {
      if (Test-Path $PythonDir) { Remove-Item $PythonDir -Recurse -Force -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Path $PythonDir -Force | Out-Null
      Copy-Item "$($pythonInstallDir.FullName)\*" $PythonDir -Recurse -Force

      # Write version file
      Set-Content -Path $versionFile -Value $pythonLatest -Encoding UTF8
      Write-ColorHost "  Python updated to $pythonLatest" "Green"
      $pythonResult.current = $pythonLatest
      $pythonResult.update_available = $false
    } else {
      Write-ColorHost "  ERROR: Could not find Python directory in extracted archive" "Red"
    }

    Remove-Item $tempGz -Force -ErrorAction SilentlyContinue
    Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Write-ColorHost "  Python update failed: $_" "Red"
  }
}

# ========== 2. Check ComfyUI version ==========
$comfyuiCommit = $null
$comfyuiBehind = $null

if (Test-Path (Join-Path $ComfyUIDir ".git")) {
  Push-Location $ComfyUIDir
  try {
    $comfyuiCommit = (& "git" "rev-parse" "--short" "HEAD" 2>$null).Trim()
    $null = & "git" "fetch" "origin" "master" 2>&1
    if ($LASTEXITCODE -eq 0) {
      $behindRaw = (& "git" "rev-list" "--count" "HEAD..origin/master" 2>$null).Trim()
      if ($behindRaw -match '^\d+$') {
        $comfyuiBehind = [int]$behindRaw
      }
    }
  } catch {
    Write-ColorHost "  WARNING: Could not check ComfyUI git status" "Yellow"
  }
  Pop-Location
}

$comfyuiUpdate = ($comfyuiBehind -and $comfyuiBehind -gt 0)

$comfyuiResult = @{
  current_commit = $comfyuiCommit
  behind = $comfyuiBehind
  update_available = $comfyuiUpdate
}

# Apply ComfyUI update
if ($UpdateComfyUI -and $comfyuiUpdate) {
  Write-ColorHost "  Updating ComfyUI ($comfyuiCommit is $comfyuiBehind behind)..." "Cyan"
  Push-Location $ComfyUIDir
  try {
    $pullOut = & "git" "pull" "origin" "master" 2>&1
    if ($LASTEXITCODE -eq 0) {
      $comfyuiCommit = (& "git" "rev-parse" "--short" "HEAD" 2>$null).Trim()
      $comfyuiResult.current_commit = $comfyuiCommit
      $comfyuiResult.behind = 0
      $comfyuiResult.update_available = $false
      Write-ColorHost "  ComfyUI updated to $comfyuiCommit" "Green"
    } else {
      Write-ColorHost "  git pull failed: $pullOut" "Red"
    }
  } catch {
    Write-ColorHost "  ComfyUI update failed: $_" "Red"
  }
  Pop-Location
}

# ========== 3. Check pip deps ==========
$outdatedDeps = @()

if (Test-Path $VenvPython) {
  try {
    $pipRaw = & $VenvPython "-m" "pip" "list" "--outdated" "--format=json" 2>&1
    if ($LASTEXITCODE -eq 0 -and $pipRaw) {
      $pipParsed = $pipRaw | ConvertFrom-Json -ErrorAction SilentlyContinue
      if ($pipParsed) {
        foreach ($pkg in $pipParsed) {
          $outdatedDeps += @{
            name = $pkg.name
            current = $pkg.version
            latest = $pkg.latest_version
          }
        }
      }
    }
  } catch {
    Write-ColorHost "  WARNING: Could not check pip dependencies" "Yellow"
  }
}

# Apply pip updates
if ($UpdateDeps -and $outdatedDeps.Count -gt 0) {
  Write-ColorHost "  Updating $($outdatedDeps.Count) pip package(s)..." "Cyan"
  foreach ($pkg in $outdatedDeps) {
    try {
      Write-ColorHost "    Upgrading $($pkg.name) $($pkg.current) -> $($pkg.latest)" "DarkYellow"
      $null = & $VenvPython "-m" "pip" "install" "--upgrade" $pkg.name 2>&1
    } catch {
      Write-ColorHost "    Failed to upgrade $($pkg.name): $_" "Red"
    }
  }
  Write-ColorHost "  Pip dependencies updated" "Green"
  $outdatedDeps = @()  # Reset since we just updated
}

$depsResult = $outdatedDeps

# ========== Write Status JSON ==========
$statusJson = @{
  checked_at = (Get-Date -Format "o")
  installed = $installed
  python = $pythonResult
  comfyui = $comfyuiResult
  deps = $depsResult
  model = @{
    name = "sd_xl_base_1.0.safetensors"
    download_url = "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
  }
} | ConvertTo-Json -Depth 4

$statusJson | Set-Content -Path $StatusFile -Encoding UTF8

Write-Host ""
Write-ColorHost "Image Gen Status:" "White"
Write-ColorHost "  Python: $($pythonCurrent ?? 'n/a') -> $($pythonLatest ?? 'unknown') $(if ($pythonUpdate) {'[UPDATE]'} else {'[OK]'})" $(if ($pythonUpdate) {"Yellow"} else {"Green"})
Write-ColorHost "  ComfyUI: $($comfyuiCommit ?? 'n/a') ($($comfyuiBehind ?? '?') behind) $(if ($comfyuiUpdate) {'[UPDATE]'} else {'[OK]'})" $(if ($comfyuiUpdate) {"Yellow"} else {"Green"})
Write-ColorHost "  Pip deps: $($outdatedDeps.Count) outdated" $(if ($outdatedDeps.Count -gt 0) {"Yellow"} else {"Green"})
Write-ColorHost "Status written to $StatusFile" "Gray"
