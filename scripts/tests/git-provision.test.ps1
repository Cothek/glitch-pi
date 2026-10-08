#Requires -Version 5.1
<#
.SYNOPSIS
    Non-interactive test for Git provisioning in install-pi.ps1.

.DESCRIPTION
    Validates the tier list, pinned URLs, and download plumbing without
    requiring network access by default. With -Live, also downloads and
    extracts the first bash-capable tier to verify end-to-end.

.PARAMETER Live
    Perform actual download + extract test (requires network).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\git-provision.test.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tests\git-provision.test.ps1 -Live
#>
param(
    [switch]$Live
)

$ErrorActionPreference = 'Stop'

# -- Resolve paths --
$testsDir   = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$scriptsDir = Split-Path $testsDir -Parent
$scriptPath = Join-Path $scriptsDir 'install-pi.ps1'

if (-not (Test-Path $scriptPath)) {
    Write-Host "ERROR: install-pi.ps1 not found at $scriptPath" -ForegroundColor Red
    exit 1
}

# -- Test harness --
$script:passed = 0
$script:failed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if ($Condition) {
        $script:passed++
        Write-Host "  PASS: $Message" -ForegroundColor Green
    } else {
        $script:failed++
        Write-Host "  FAIL: $Message" -ForegroundColor Red
    }
}

# ============================================================
# TEST GROUP 1: Static analysis of install-pi.ps1 source
# ============================================================
Write-Host ""
Write-Host "[Static Analysis]" -ForegroundColor Cyan

$scriptContent = [IO.File]::ReadAllText($scriptPath)

# 1a. Pinned version is 4-part
$pinnedVer4Match = [regex]::Match($scriptContent, "\`$PinnedGitVer4\s*=\s*'([^']+)'")
Assert-True $pinnedVer4Match.Success "PinnedGitVer4 constant found"
$pinnedVer4 = $pinnedVer4Match.Groups[1].Value
Assert-True ($pinnedVer4 -match '^\d+\.\d+\.\d+\.\d+$') "PinnedGitVer4 is 4-part format: $pinnedVer4"

# 1b. Pinned tag uses 4-part windows tag
$pinnedTagMatch = [regex]::Match($scriptContent, "\`$PinnedGitTag\s*=\s*'([^']+)'")
Assert-True $pinnedTagMatch.Success "PinnedGitTag constant found"
$pinnedTag = $pinnedTagMatch.Groups[1].Value
Assert-True ($pinnedTag -match '^v\d+\.\d+\.\d+\.windows\.\d+$') "PinnedGitTag is valid: $pinnedTag"

# 1c. Pinned base URL derives from tag
$baseUrlMatch = [regex]::Match($scriptContent, '\$PinnedGitBaseUrl\s*=\s*"([^"]+)"')
Assert-True $baseUrlMatch.Success "PinnedGitBaseUrl found"
$baseUrl = $baseUrlMatch.Groups[1].Value
Assert-True ($baseUrl -like "*releases/download*") "PinnedGitBaseUrl points to releases/download"

# 1d. Pinned fallback patterns for sfx, nsis, mingit (NOT bashzip, which has
# no pinned URL because git-for-windows publishes no PortableGit *.zip at the
# pinned tag).
$expectedPatterns = @(
    'PortableGit-$PinnedGitVer4-64-bit.7z.exe'
    'Git-$PinnedGitVer4-64-bit.exe'
    'MinGit-$PinnedGitVer4-64-bit.zip'
)
foreach ($pat in $expectedPatterns) {
    Assert-True ($scriptContent.Contains($pat)) "Pinned fallback pattern present: $pat"
}

# 1e. bashzip has NO pinned URL (no PortableGit zip at this tag)
Assert-True (-not $scriptContent.Contains('PortableGit-$PinnedGitVer4-64-bit.zip')) "No bashzip pinned URL (known 404 at pinned tag)"

# 1f. No old broken 3-part fallback patterns
Assert-True (-not $scriptContent.Contains('fallbackVer3-64-bit.7z.exe')) "No old 3-part PortableGit fallback"
Assert-True (-not $scriptContent.Contains('fallbackVer3-64-bit.exe"')) "No old 3-part Git NSIS fallback"

# 1g. No bare $using:object.property pattern in download calls
$usingPropMatches = [regex]::Matches($scriptContent, '\$using:\w+\.browser_download_url')
$nonCommentHits = 0
foreach ($m in $usingPropMatches) {
    $lineStart = $scriptContent.LastIndexOf("`n", $m.Index) + 1
    $lineEnd   = $scriptContent.IndexOf("`n", $m.Index)
    if ($lineEnd -lt 0) { $lineEnd = $scriptContent.Length }
    $line = $scriptContent.Substring($lineStart, $lineEnd - $lineStart).TrimStart()
    if (-not $line.StartsWith('#')) { $nonCommentHits++ }
}
Assert-True ($nonCommentHits -eq 0) "No non-comment `$using:obj.property pattern (found $nonCommentHits)"

# 1h. $using:tUrl is used in the download job
Assert-True ($scriptContent.Contains('$using:tUrl')) "Download job uses `$using:tUrl (plain scalar)"

# 1i. New switches are in the param block
Assert-True ($scriptContent.Contains('$ProvisionGitDryRun')) "Param -ProvisionGitDryRun present"
Assert-True ($scriptContent.Contains('$ProvisionGitLive')) "Param -ProvisionGitLive present"

# 1j. Single shared function for the tier loop (no duplicated download code)
Assert-True ($scriptContent.Contains('function Invoke-GitTierProvision')) "Shared function Invoke-GitTierProvision defined"
Assert-True ($scriptContent.Contains('function Build-GitTierList')) "Shared function Build-GitTierList defined"

# 1k. Exactly ONE tier loop foreach (no duplication)
$loopCount = ([regex]::Matches($scriptContent, 'foreach \(\$tier in \$TierList\)')).Count
Assert-True ($loopCount -eq 1) "Exactly 1 tier loop (found $loopCount)"

# 1l. Both installer and live test call Invoke-GitTierProvision
$invokeCount = ([regex]::Matches($scriptContent, 'Invoke-GitTierProvision\s+-TierList')).Count
Assert-True ($invokeCount -ge 2) "Invoke-GitTierProvision called from >=2 sites (found $invokeCount)"

# 1m. No "pie" token in either installer (case-insensitive guard)
$shPath = Join-Path $scriptsDir 'install-pi.sh'
$ps1PieHits = [regex]::Matches($scriptContent, '(?i)\bpie\b')
$shContent = [IO.File]::ReadAllText($shPath)
$shPieHits  = [regex]::Matches($shContent, '(?i)\bpie\b')
Assert-True ($ps1PieHits.Count -eq 0) "install-pi.ps1 contains no 'pie' token (found $($ps1PieHits.Count))"
Assert-True ($shPieHits.Count -eq 0)  "install-pi.sh contains no 'pie' token (found $($shPieHits.Count))"

# 1n. Windows banner reads "GLITCH PI INSTALLER (Windows)"
Assert-True ($scriptContent.Contains('GLITCH PI INSTALLER (Windows)')) "Windows banner reads 'GLITCH PI INSTALLER (Windows)'"

# ============================================================
# TEST GROUP 2: Dry-run output validation (network-free)
# ============================================================
Write-Host ""
Write-Host "[Dry-Run Test]" -ForegroundColor Cyan

$dryRunOutput = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -ProvisionGitDryRun 2>&1
$dryRunExit = $LASTEXITCODE
$dryRunLines = @($dryRunOutput | ForEach-Object { $_.ToString() } | Where-Object { $_ -match '\|' })

Assert-True ($dryRunExit -eq 0) "Dry-run exits 0 (got $dryRunExit)"
# 3-4 tiers: bashzip is omitted when API is unavailable (no pinned URL).
Assert-True ($dryRunLines.Count -ge 3 -and $dryRunLines.Count -le 4) "Dry-run emits 3-4 tier lines (got $($dryRunLines.Count))"

# Parse tier lines
$tiers = @()
foreach ($line in $dryRunLines) {
    $parts = $line.Split('|')
    if ($parts.Count -ge 3) {
        $kind = $parts[0].Trim()
        $name = $parts[1].Trim()
        $url  = ($parts[2..($parts.Count-1)] -join '|').Trim()
        $tiers += [pscustomobject]@{ Kind=$kind; Name=$name; Url=$url }
    }
}

# 2a. All URLs are absolute https (dead URLs are filtered by the dry-run)
foreach ($t in $tiers) {
    Assert-True ($t.Url -match '^https://') "Tier $($t.Kind) URL is absolute https: $($t.Url.Substring(0, [Math]::Min(60, $t.Url.Length)))..."
}

# 2b. No tier URL is empty (dead URLs never reach the dry-run output)
foreach ($t in $tiers) {
    Assert-True (-not [string]::IsNullOrWhiteSpace($t.Url)) "Tier $($t.Kind) URL is non-empty"
}

# 2c. mingit is always present (it has a pinned URL)
$mingitTier = $tiers | Where-Object { $_.Kind -eq 'mingit' }
Assert-True ($null -ne $mingitTier) "mingit tier present in dry-run output"

# 2d. Bash-capable tiers (if present) precede mingit
$bashTierKinds = @('bashzip', 'sfx', 'nsis')
$lastBashIdx = -1
$mingitIdx   = -1
for ($i = 0; $i -lt $tiers.Count; $i++) {
    if ($tiers[$i].Kind -in $bashTierKinds) { $lastBashIdx = $i }
    if ($tiers[$i].Kind -eq 'mingit') { $mingitIdx = $i }
}
Assert-True ($mingitIdx -ge 0) "mingit tier index found"
if ($lastBashIdx -ge 0 -and $mingitIdx -ge 0) {
    Assert-True ($lastBashIdx -lt $mingitIdx) "Bash tiers precede mingit tier"
}

# 2e. Tier kinds are in the expected order (skipping bashzip when absent)
$validKinds = @('bashzip', 'sfx', 'nsis', 'mingit')
$prevKindIdx = -1
$orderOk = $true
foreach ($t in $tiers) {
    $idx = $validKinds.IndexOf($t.Kind)
    if ($idx -lt 0 -or $idx -le $prevKindIdx) { $orderOk = $false; break }
    $prevKindIdx = $idx
}
Assert-True $orderOk "Tier kinds in correct order: $($tiers.Kind -join ', ')"

# 2f. Tier names are non-empty
foreach ($t in $tiers) {
    Assert-True (-not [string]::IsNullOrWhiteSpace($t.Name)) "Tier $($t.Kind) name is non-empty: $($t.Name)"
}

# 2g. sfx, nsis, mingit always use 4-part version in pinned names
$pinnedTierKinds = @('sfx', 'nsis', 'mingit')
foreach ($t in $tiers) {
    if ($t.Kind -in $pinnedTierKinds) {
        # Name should contain the 4-part version (e.g. 2.47.0.2 or 2.56.0.2)
        $hasFourPart = ($t.Name -match '\d+\.\d+\.\d+\.\d+')
        Assert-True $hasFourPart "Tier $($t.Kind) name has 4-part version: $($t.Name)"
    }
}

# ============================================================
# TEST GROUP 3: Live download + extract (optional)
# ============================================================
if ($Live) {
    Write-Host ""
    Write-Host "[Live Test]" -ForegroundColor Cyan

    $liveOutput = powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -ProvisionGitLive 2>&1
    $liveExit   = $LASTEXITCODE

    $liveOutput | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

    Assert-True ($liveExit -eq 0) "Live test exits 0 (got $liveExit)"
    $hasPassLine = ($liveOutput | Out-String) -match 'PASS.*git\.exe.*bash\.exe'
    Assert-True $hasPassLine "Live test reports PASS for git+bash"
    $hasLivePass = ($liveOutput | Out-String) -match 'LIVE TEST PASSED'
    Assert-True $hasLivePass "Live test reports LIVE TEST PASSED"

    # The live test must exercise the SAME function as the installer.
    # Verify the output mentions "Trying tier" (from Invoke-GitTierProvision).
    $hasTierMsg = ($liveOutput | Out-String) -match 'Trying tier'
    Assert-True $hasTierMsg "Live test exercises Invoke-GitTierProvision (tier messages present)"
}

# ============================================================
# Summary
# ============================================================
Write-Host ""
Write-Host "Results: $script:passed passed, $script:failed failed" -ForegroundColor $(if ($script:failed -eq 0) { 'Green' } else { 'Red' })

if ($script:failed -gt 0) { exit 1 }
exit 0
