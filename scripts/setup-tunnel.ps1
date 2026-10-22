param(
  [switch]$Auto,
  [string]$BaseDomain = "cothekdesigns.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$Cloudflared = "$RootDir\cloudflared.exe"
$ConfigDir = "$RootDir\config"
$DataDir = "$RootDir\data"

# Check cloudflared exists
if (-not (Test-Path $Cloudflared)) {
  Write-Host "cloudflared.exe not found. Run bootstrap.ps1 or download manually." -ForegroundColor Red
  exit 1
}

# ============================================================
# AUTO MODE
# ============================================================
if ($Auto) {
  trap { Write-Error $_; exit 1 }
  $ErrorActionPreference = "Stop"
  $PSNativeCommandUseErrorActionPreference = $false

  Write-Host ""
  Write-Host "Glitch AI - Auto Tunnel Setup" -ForegroundColor Magenta
  Write-Host ""

  # Determine machine-specific tunnel name
  $machineName = [System.Environment]::MachineName.ToLower() -replace '[^a-z0-9-]', ''
  $tunnelName = "glitch-ai-$machineName"
  $dnsHostname = "glitch-$machineName.$BaseDomain"

  Write-Host "  Machine: $([System.Environment]::MachineName)" -ForegroundColor Gray
  Write-Host "  Tunnel: $tunnelName" -ForegroundColor Cyan
  Write-Host "  DNS: $dnsHostname" -ForegroundColor Cyan
  Write-Host ""

  # Check if tunnel already exists (re-run safe)
  $ErrorActionPreference = "SilentlyContinue"
  $existingTunnels = & $Cloudflared tunnel list --output json 2>$null | ConvertFrom-Json
  $existingUuid = $null
  if ($existingTunnels -is [array]) {
    $match = $existingTunnels | Where-Object { $_.Name -eq $tunnelName }
    if ($match) { $existingUuid = $match[0].Id }
  } elseif ($existingTunnels -is [pscustomobject]) {
    if ($existingTunnels.Name -eq $tunnelName) { $existingUuid = $existingTunnels.Id }
  }

  if ($existingUuid) {
    Write-Host "  Tunnel '$tunnelName' already exists (re-using)" -ForegroundColor Yellow
    $uuid = $existingUuid
  } else {
    Write-Host "  Creating tunnel '$tunnelName'..." -ForegroundColor Cyan
    $createOutput = & $Cloudflared tunnel create $tunnelName 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  Tunnel creation failed: $createOutput" -ForegroundColor Red
      exit 1
    }
    Write-Host "  Tunnel created" -ForegroundColor Green

    # Parse UUID from output: "Created tunnel <name> with id <uuid>"
    if ($createOutput -match 'id\s+([a-f0-9-]+)') {
      $uuid = $Matches[1]
    } else {
      # Fallback: re-list to find UUID
      $updatedTunnels = & $Cloudflared tunnel list --output json 2>$null | ConvertFrom-Json
      if ($updatedTunnels -is [array]) {
        $newTunnel = $updatedTunnels | Where-Object { $_.Name -eq $tunnelName }
        $uuid = $newTunnel[0].Id
      } else {
        $uuid = $updatedTunnels.Id
      }
    }
  }

  if (-not $uuid) {
    Write-Host "  Failed to determine tunnel UUID" -ForegroundColor Red
    exit 1
  }

  Write-Host "  Tunnel UUID: $uuid" -ForegroundColor Gray

  # Route DNS (idempotent - safe to re-run)
  Write-Host "  Routing DNS $dnsHostname..." -ForegroundColor Cyan
  & $Cloudflared tunnel route dns $tunnelName $dnsHostname 2>&1 | Out-Null
  Write-Host "  DNS route set" -ForegroundColor Green

  # Ensure data directory exists
  $ErrorActionPreference = "Stop"
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

  # Write domain file (so server-mode.mjs can read it)
  Set-Content -Path "$DataDir\cloudflare-domain.txt" -Value $dnsHostname -NoNewline

  # Write config file atomically
  $configContent = @"
# Cloudflare Tunnel Configuration
# Tunnel: $tunnelName (created by Glitch AI auto-setup)
# Machine: $([System.Environment]::MachineName)

tunnel: $uuid
ingress:
  # ORIGIN 4103, NOT 4100: 4100 is the dead OpenCode-era auth-proxy port.
  # The live stack is pi-web-ui :8787 behind auth-proxy :4103. Port 4100 here
  # is what served 502 Bad Gateway on glitch.cothekdesigns.com (PM-063/PM-065).
  - hostname: $dnsHostname
    service: http://localhost:4103
  - service: http_status:404
"@

  $tmpFile = "$ConfigDir\cloudflared-config.yml.tmp"
  $configFile = "$ConfigDir\cloudflared-config.yml"
  try {
    # Write to temp file
    Set-Content -Path $tmpFile -Value $configContent -NoNewline
    # Validate: must contain tunnel UUID and hostname
    $testContent = Get-Content $tmpFile -Raw
    if (-not ($testContent -match 'tunnel:\s+[a-f0-9-]{8,}')) {
      throw "Config validation failed: missing or invalid tunnel UUID"
    }
    if (-not ($testContent -match 'hostname:\s+\S+')) {
      throw "Config validation failed: missing hostname"
    }
    # Atomic rename
    Move-Item -Force $tmpFile $configFile
  } catch {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
    Write-Host "  Config write failed: $_" -ForegroundColor Red
    exit 1
  }

  Write-Host "  Config written: $configFile" -ForegroundColor Green
  Write-Host ""
  Write-Host "Auto-setup complete!" -ForegroundColor Green
  Write-Host "  Tunnel: $tunnelName (UUID: $uuid)" -ForegroundColor Gray
  Write-Host "  URL: https://$dnsHostname" -ForegroundColor Gray
  Write-Host ""
  exit 0
}

# ============================================================
# INTERACTIVE MODE (original behavior)
# ============================================================

Write-Host ""
Write-Host "Glitch AI - Cloudflare Tunnel Setup" -ForegroundColor Magenta
Write-Host ""

Write-Host "Step 1: Authenticate with Cloudflare" -ForegroundColor Cyan
Write-Host "  This opens a browser window. Log in with your Cloudflare account." -ForegroundColor Gray
Write-Host "  (Select cothekdesigns.com if prompted)" -ForegroundColor Gray
Write-Host ""
& $Cloudflared tunnel login
if ($LASTEXITCODE -ne 0) {
  Write-Host "Authentication failed. Re-run this script." -ForegroundColor Red
  exit 1
}
Write-Host "  Authenticated successfully" -ForegroundColor Green
Write-Host ""

$TunnelName = "glitch-ai"
$Hostname = "glitch.cothekdesigns.com"

Write-Host "Step 2: Create tunnel '$TunnelName'" -ForegroundColor Cyan
& $Cloudflared tunnel create $TunnelName
if ($LASTEXITCODE -ne 0) {
  Write-Host "Tunnel creation failed. Tunnel may already exist." -ForegroundColor Yellow
  Write-Host "  To delete and recreate: cloudflared tunnel delete $TunnelName" -ForegroundColor Gray
}
Write-Host ""

Write-Host "Step 3: Route DNS" -ForegroundColor Cyan
Write-Host "  Creating DNS record: $Hostname -> tunnel" -ForegroundColor Gray
& $Cloudflared tunnel route dns $TunnelName $Hostname
if ($LASTEXITCODE -ne 0) {
  Write-Host "DNS route may already exist (this is fine)" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run launch-glitch.bat and select server mode (option 4) to start the server + tunnel" -ForegroundColor Gray
Write-Host "  2. Visit https://$Hostname" -ForegroundColor Gray
Write-Host ""
