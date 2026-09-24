<#
.SYNOPSIS
    Commit (and optionally push) the Glitch memory profile repo.

.DESCRIPTION
    The memory profile (user/*.md, preferences, diary, forge log) lives in its
    own git repo at <repo>/user, remote Cothek/glitch-user-troy. This script
    stages and commits changes there.

    Replaces the original one-off version, which hardcoded D:\Glitch\glitch-ai,
    used one fixed commit message, and pushed unconditionally.

    Push is OPT-IN (-Push). Committing is local and reversible; pushing is not.

.PARAMETER Message
    Commit message. Defaults to "memory: <timestamp> - <changed files>".

.PARAMETER Push
    Push to origin after committing.

.EXAMPLE
    .\scripts\commit-memory-changes.ps1
    .\scripts\commit-memory-changes.ps1 -Message "memory: tunnel + launch notes"
    .\scripts\commit-memory-changes.ps1 -Push
#>
param(
    [string]$Message,
    [switch]$Push
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this script's directory: works on any checkout/machine.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$MemoryRepo = Join-Path $RepoRoot "user"

if (-not (Test-Path (Join-Path $MemoryRepo ".git"))) {
    Write-Error "Memory repo not found at $MemoryRepo\.git (expected the user profile repo)."
    exit 1
}

Push-Location $MemoryRepo
try {
    $changes = git status --porcelain
    if ($LASTEXITCODE -ne 0) {
        Write-Error "git status failed in $MemoryRepo"
        exit 1
    }

    $changedLines = @($changes -split "`n" | Where-Object { $_.Trim() })
    if ($changedLines.Count -eq 0) {
        Write-Host "Memory repo is clean - nothing to commit." -ForegroundColor Green
        return
    }

    Write-Host "Staging $($changedLines.Count) changed path(s) in $MemoryRepo" -ForegroundColor Cyan
    $changedLines | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }

    git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed" }

    if (-not $Message) {
        $files = ($changedLines | ForEach-Object { $_.Substring(3).Trim() }) -join ", "
        if ($files.Length -gt 70) { $files = $files.Substring(0, 67) + "..." }
        $Message = "memory: $(Get-Date -Format 'yyyy-MM-dd HH:mm') - $files"
    }

    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    Write-Host "Committed: $Message" -ForegroundColor Green

    if ($Push) {
        git push
        if ($LASTEXITCODE -ne 0) {
            Write-Error "git push failed - the commit exists locally but is NOT on the remote."
            exit 1
        }
        Write-Host "Pushed to origin." -ForegroundColor Green
    }
    else {
        Write-Host "Not pushed (pass -Push to publish to origin)." -ForegroundColor DarkGray
    }
}
finally {
    Pop-Location
}
