param(
  [switch]$SkipPlaywright = $false,
  [switch]$Force = $false
)

$ErrorActionPreference = "Stop"

# ── Helpers ──
function Write-Step {
  param([string]$Text)
  Write-Host "  $Text" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Text)
  Write-Host "    OK $Text" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Text)
  Write-Host "    WARNING: $Text" -ForegroundColor Yellow
}

function Write-Fail {
  param([string]$Text)
  Write-Host "    FAILED: $Text" -ForegroundColor Red
}

# ── 1. Resolve Paths ──
$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$PluginDir = Join-Path $RootDir "plugins/browser-use"
$DataDir = Join-Path $RootDir "data/browser-use"
$ProfilesDir = Join-Path $DataDir "profiles"
$ScreenshotsDir = Join-Path $DataDir "screenshots"
$ConfigPath = Join-Path $DataDir "config.json"
$RegistryPath = Join-Path $RootDir "user/plugins.json"

Write-Host ""
Write-Host "Browser Use Plugin Installer" -ForegroundColor Magenta
Write-Host "  Root: $RootDir" -ForegroundColor DarkGray
Write-Host ""

# ── 2. Check Prerequisites ──
Write-Step "[1/7] Checking prerequisites..."

# Check Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Fail "Node.js is not installed or not in PATH. Install Node.js >= 18 from https://nodejs.org/ and try again."
  exit 1
}

$nodeVersion = & node --version 2>&1
$nodeVersionStr = $nodeVersion.Trim()
$nodeVersionNum = $nodeVersionStr -replace '^v', ''
$nodeMajor = [int]($nodeVersionNum.Split('.')[0])

if ($nodeMajor -lt 18) {
  Write-Fail "Node.js >= 18 is required. Found: $nodeVersionStr"
  exit 1
}
Write-Ok "Node.js $nodeVersionStr found at $($nodeCmd.Source)"

# Check plugin directory
if (-not (Test-Path $PluginDir)) {
  Write-Fail "Plugin directory not found: $PluginDir"
  exit 1
}
Write-Ok "Plugin directory exists"

# ── 3. Install npm Dependencies ──
Write-Step "[2/7] Installing npm dependencies..."

Push-Location $PluginDir
try {
  if (Test-Path "node_modules") {
    if ($Force) {
      Write-Warn "node_modules exists, reinstalling due to -Force"
      Remove-Item "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
      & npm install 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    } else {
      Write-Ok "node_modules already exists (use -Force to reinstall)"
    }
  } else {
    Write-Host "    Running npm install..." -ForegroundColor Yellow
    & npm install 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    Write-Ok "npm dependencies installed"
  }
} finally {
  Pop-Location
}

# ── 4. Install Playwright Chromium ──
Write-Step "[3/7] Installing Playwright Chromium browser..."

if (-not $SkipPlaywright) {
  Push-Location $PluginDir
  try {
    Write-Host "    Downloading Chromium via Playwright..." -ForegroundColor Yellow
    Write-Host "    This may take a few minutes on first install..." -ForegroundColor DarkGray
    & npx playwright install chromium 2>&1 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { throw "playwright install failed with exit code $LASTEXITCODE" }
    Write-Ok "Chromium installed"
  } finally {
    Pop-Location
  }
} else {
  Write-Ok "Playwright install skipped (-SkipPlaywright)"
}

# ── 5. Create Directory Structure ──
Write-Step "[4/7] Creating directory structure..."

$null = New-Item -ItemType Directory -Path $DataDir -Force
$null = New-Item -ItemType Directory -Path $ProfilesDir -Force
$null = New-Item -ItemType Directory -Path $ScreenshotsDir -Force
Write-Ok "Created: $DataDir"
Write-Ok "Created: $ProfilesDir"
Write-Ok "Created: $ScreenshotsDir"

# ── 6. Create Default Config ──
Write-Step "[5/7] Creating default config..."

if ((Test-Path $ConfigPath) -and -not $Force) {
  Write-Ok "Config already exists at $ConfigPath (use -Force to overwrite)"
} else {
  $defaultConfig = @{
    enabled = $true
    headless = $false
    llm = @{
      active_provider = "openrouter"
      active_model = "google/gemini-2.0-flash-001"
      providers = @(
        @{
          id = "openrouter"
          type = "openrouter"
          name = "OpenRouter"
          apiKey = ""
          baseUrl = "https://openrouter.ai/api/v1"
          models = @("google/gemini-2.0-flash-001")
          vision = $true
        }
      )
    }
    browser = @{
      user_data_dir = "data/browser-use/profiles"
      viewport = @{
        width = 1920
        height = 1080
      }
      allowed_domains = @()
      highlight_elements = $true
    }
    screenshots = @{
      save_dir = "data/browser-use/screenshots"
      auto_screenshot = $true
    }
    session = @{
      max_steps = 50
      max_failures = 3
      timeout_seconds = 300
    }
    retry = @{
      enabled = $true
      max_attempts = 3
      backoff_base_ms = 2000
    }
    # VERIFIED 2026-09-26: dispatchToVision() POSTs to http://localhost:<vision_port>/api/analyze, and NOTHING in this repo serves that route (grep across plugins/, scripts/, .pi/). Port 4100 was the opencode-era auth proxy; Pi's auth proxy is 4103 and does not implement /api/analyze either. So vision dispatch has no target in Pi — leave it off until something serves POST /api/analyze.
    vision = @{
      enabled = $true
      dispatch_to_vision = $false
      vision_port = 4100
    }
    history = @{
      enabled = $true
      max_entries = 100
    }
    scheduler = @{
      enabled = $true
      max_tasks = 10
      check_interval_seconds = 60
    }
    sessions = @{
      max_concurrent = 3
    }
    custom_actions = @{
      enabled = $true
      max_actions = 20
    }
  }

  $configJson = $defaultConfig | ConvertTo-Json -Depth 6
  Set-Content -Path $ConfigPath -Value $configJson -Encoding UTF8
  Write-Ok "Default config created at $ConfigPath"
}

# ── 7. Register Plugin ──
Write-Step "[6/7] Registering plugin..."

$registryDir = Split-Path -Parent $RegistryPath
if (-not (Test-Path $registryDir)) {
  $null = New-Item -ItemType Directory -Path $registryDir -Force
}

$registry = @{}
if (Test-Path $RegistryPath) {
  try {
    $existingContent = Get-Content $RegistryPath -Raw | ConvertFrom-Json
    if ($existingContent -is [PSCustomObject]) {
      $existingContent.PSObject.Properties | ForEach-Object {
        $registry[$_.Name] = $_.Value
      }
    }
  } catch {
    Write-Warn "Could not parse existing plugins.json, creating new registry"
  }
}

if ($registry.ContainsKey("browser-use")) {
  Write-Ok "Plugin already registered in user/plugins.json"
} else {
  $registry["browser-use"] = @{ enabled = $false }
  $registryJson = $registry | ConvertTo-Json -Depth 4
  Set-Content -Path $RegistryPath -Value $registryJson -Encoding UTF8
  Write-Ok "Plugin registered in user/plugins.json (disabled by default)"
}

# ── 8. Print Success ──
Write-Step "[7/7] Done!"

Write-Host ""
Write-Host "============================================" -ForegroundColor Magenta
Write-Host " Browser Use plugin installed!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Plugin: $PluginDir" -ForegroundColor White
Write-Host "  Config: $ConfigPath" -ForegroundColor White
Write-Host "  Profiles: $ProfilesDir" -ForegroundColor White
Write-Host "  Screenshots: $ScreenshotsDir" -ForegroundColor White
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Add an LLM provider via API or edit data/browser-use/config.json" -ForegroundColor White
Write-Host "     POST http://localhost:4105/api/providers  (see README for examples)" -ForegroundColor DarkGray
Write-Host "     Supports: OpenAI, OpenRouter, Anthropic, Google, DeepSeek, Ollama, NVIDIA, etc." -ForegroundColor DarkGray
Write-Host "  2. Enable the plugin:" -ForegroundColor White
Write-Host '     Enable browser-use plugin' -ForegroundColor Yellow
Write-Host "  3. Restart Glitch to load the plugin" -ForegroundColor White
Write-Host ""
Write-Host "Test with:" -ForegroundColor Cyan
Write-Host '  POST http://localhost:4105/api/status' -ForegroundColor Yellow
Write-Host '  POST http://localhost:4105/api/run { "task": "go to example.com" }' -ForegroundColor Yellow
Write-Host ""
