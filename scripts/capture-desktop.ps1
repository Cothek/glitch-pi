<#
.SYNOPSIS
  Desktop-wide screenshot for Glitch that works even in active RDP sessions.

.DESCRIPTION
  Windows 11 RDP sessions render on an indirect display (Microsoft Remote Display
  Adapter). WGC-from-monitor and GDI screen BitBlt both fail there (0x80070006),
  so `cua-driver get_desktop_state` cannot work while the user is attached via RDP.
  Verified 2026-09-22 in session 2 (fEnableWddm=0 policy has no effect on Win11).

  This script composes the desktop from per-window captures (WGC-from-HWND, which
  DOES work over RDP): it enumerates on-screen windows via cua-driver, captures each
  window's screenshot, draws them at their desktop bounds onto a virtual-screen
  bitmap, and writes one PNG. Background (wallpaper/windows without capture
  support) stays black.

  Output: glitch-pi/data/desktop-compose.png + a JSON summary on stdout.
  Exit 0 on success, 1 on failure.
#>

$ErrorActionPreference = "Stop"
$CUA = "$env:LOCALAPPDATA\Programs\Cua\cua-driver\bin\cua-driver.exe"
$OutFile = Join-Path $PSScriptRoot "..\data\desktop-compose.png"

function Invoke-Cua($tool, $json) {
  # PS 5.1 strips quotes when passing to native exes; escape them for the CLI.
  $escaped = $json -replace '"', '\"'
  $out = & $CUA call $tool $escaped 2>$null
  return ($out | Out-String | ConvertFrom-Json)
}

# The web-UI header toggle (data/config/desktop-control.json) is authoritative:
# when desktop control is disabled we must NOT resurrect the daemon here, or the
# button's OFF state would be a lie. A daemon that is already running is still
# used as-is.
$dcFlag = $false
try {
  $dcCfg = Join-Path $PSScriptRoot "..\data\config\desktop-control.json"
  if (Test-Path $dcCfg) { $dcFlag = [bool]((Get-Content $dcCfg -Raw | ConvertFrom-Json).enabled) }
  else { $dcFlag = $true }   # no flag file yet: behave like the pre-plugin installer
} catch { $dcFlag = $true }

# ensure daemon is up (call auto-fails fast if pipe missing)
try { $null = Invoke-Cua "get_screen_size" "{}" } catch {
  if (-not $dcFlag) {
    Write-Error "desktop control is disabled (enable it from the pi-web-ui header button)"
    exit 1
  }
  & "$PSScriptRoot\start-detached.ps1" -Command "`"$CUA`" serve --socket \\.\pipe\cua-driver" -Name cua-driver-serve | Out-Null
  Start-Sleep -Seconds 3
  $null = Invoke-Cua "get_screen_size" "{}"
}

Add-Type -AssemblyName System.Drawing

$wins = (Invoke-Cua "list_windows" "{}")._legacy_windows |
        Where-Object { $_.is_on_screen -and -not $_.minimized -and $_.width -gt 0 -and $_.height -gt 0 -and $_.title -ne "Cua.AgentCursorOverlay.default" }

if (-not $wins) { Write-Error "no capturable windows found"; exit 1 }

$canvasW = [int](($wins | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum - ($wins | Measure-Object x -Minimum).Minimum)
$canvasH = [int](($wins | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum - ($wins | Measure-Object y -Minimum).Minimum)
$minX = [int]($wins | Measure-Object x -Minimum).Minimum
$minY = [int]($wins | Measure-Object y -Minimum).Minimum

$bmp = New-Object System.Drawing.Bitmap $canvasW, $canvasH
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)

$captured = 0; $skipped = @()
# back to front = ascending z where larger z_index is on top per driver docs; sort defensively
foreach ($w in ($wins | Sort-Object z_index)) {
  try {
    $st = Invoke-Cua "get_window_state" ("{""pid"":$($w.pid),""window_id"":$($w.window_id),""include_accessibility_tree"":false,""include_screenshot"":true,""max_image_dimension"":1600}")
    if ($st.screenshot_png_b64) {
      $bytes = [Convert]::FromBase64String($st.screenshot_png_b64)
      $ms = New-Object System.IO.MemoryStream (,$bytes)
      $img = [System.Drawing.Image]::FromStream($ms)
      $g.DrawImage($img, $w.x - $minX, $w.y - $minY, $w.width, $w.height)
      $img.Dispose(); $ms.Dispose()
      $captured++
    } else { $skipped += $w.title }
  } catch { $skipped += $w.title }
}

$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

[pscustomobject]@{
  ok = $true
  file = (Resolve-Path $OutFile).Path
  canvas = "${canvasW}x${canvasH}"
  windows_captured = $captured
  windows_skipped = $skipped
} | ConvertTo-Json -Compress
