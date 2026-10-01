<#
.SYNOPSIS
Switch Git branches with config validation, or merge branches safely.

.DESCRIPTION
Manages Git branches for Glitch AI development. You always launch Glitch
from the main branch (stable). This script handles switching to feature
branches, creating new branches, and merging completed work.

.PARAMETER Branch
Switch to this branch (auto-stashes changes, validates config)

.PARAMETER List
List all branches, mark current one

.PARAMETER Create
Create and switch to a new branch

.PARAMETER From
Source branch for -Create (default: develop)

.PARAMETER Merge
Merge specified branch into current branch

.PARAMETER Message
Commit message for merge

.PARAMETER Force
Skip config validation on switch

.PARAMETER NoStash
Don't auto-stash changes before switching
#>

param(
    [string]$Branch,
    [switch]$List,
    [string]$Create,
    [string]$From,
    [string]$Merge,
    [string]$Message,
    [switch]$Force,
    [switch]$NoStash
)

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Split-Path -Parent $ScriptDir
$ErrorActionPreference = "Continue"

function Get-CurrentBranch {
    try {
        $branch = git branch --show-current 2>$null
        if ($LASTEXITCODE -ne 0) { return "N/A" }
        return $branch
    } catch {
        return "N/A"
    }
}

function Get-BranchList {
    $lines = git branch -a 2>$null
    if ($LASTEXITCODE -ne 0) { return @() }
    return $lines
}

function Test-BranchConfigs($branchName) {
    $errors = @()
    $filesToCheck = @(
        "opencode.json",
        "config/opencode-normal.json",
        "config/opencode-free.json",
        "config/opencode-safe.json",
        "config/opencode-local.json",
        "glitch-memorycore/prompt-rules.md",
    )

    foreach ($file in $filesToCheck) {
        try {
            $content = git show "$branchName`:$file" 2>&1
            if ($LASTEXITCODE -ne 0) {
                $errors += "MISSING: $file"
                continue
            }
            if ($file -like "*.json") {
                $null = [System.Management.Automation.PSParser]::Tokenize($content, [ref]$null)
                try {
                    $null = $content | ConvertFrom-Json
                } catch {
                    $errors += "INVALID: $file - $($_.Exception.Message)"
                }
            }
        } catch {
            $errors += "ERROR: $file - $($_.Exception.Message)"
        }
    }

    if ($errors.Count -gt 0) {
        return @{ Valid = $false; Errors = $errors }
    }
    return @{ Valid = $true; Errors = @() }
}

function Invoke-AutoStash {
    $status = git status --porcelain 2>$null
    if ([string]::IsNullOrWhiteSpace($status)) {
        return $false
    }

    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    git stash push -m "glitch-auto-stash $timestamp" 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }
    return $false
}

function Invoke-StashPop {
    $stashList = git stash list 2>$null
    if ([string]::IsNullOrWhiteSpace($stashList)) {
        return
    }

    $hasGlitchStash = $stashList -match "glitch-auto-stash"
    if (-not $hasGlitchStash) {
        return
    }

    $answer = "y"
    if (-not $global:NonInteractive) {
        $prompt = Read-Host "Pop stash? (Y/n)"
        if ($prompt -eq "n" -or $prompt -eq "N") { $answer = "n" }
    }

    if ($answer -eq "y") {
        git stash pop 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  v Stash popped" -ForegroundColor Green
        } else {
            Write-Host "  ! Stash pop failed (conflict?)" -ForegroundColor Yellow
        }
    }
}

function Invoke-SwitchBranch($targetBranch, $force) {
    $current = Get-CurrentBranch
    if ($current -eq $targetBranch) {
        Write-Host "  Already on $targetBranch" -ForegroundColor Yellow
        return
    }

    Write-Host "`n  Switching from $current to $targetBranch..." -ForegroundColor Cyan

    if (-not $force) {
        $configResult = Test-BranchConfigs $targetBranch
        if (-not $configResult.Valid) {
            Write-Host "  ! Config validation found issues:" -ForegroundColor Yellow
            foreach ($err in $configResult.Errors) {
                Write-Host "    $err" -ForegroundColor Yellow
            }

            $answer = Read-Host "  Switch anyway? You can still fix files after switching. (y/N)"
            if ($answer -ne "y" -and $answer -ne "Y") {
                Write-Host "  Aborted" -ForegroundColor Red
                exit 0
            }
        } else {
            Write-Host "  v Config validated on $targetBranch (6 files OK)" -ForegroundColor Green
        }
    }

    $stashHappened = $false
    if (-not $NoStash) {
        $dirty = git status --porcelain 2>$null
        if (-not [string]::IsNullOrWhiteSpace($dirty)) {
            $stashHappened = Invoke-AutoStash
            if ($stashHappened) {
                Write-Host "  v Stashed uncommitted changes" -ForegroundColor Green
            }
        }
    }

    $output = git checkout $targetBranch --recurse-submodules 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Checkout failed:" -ForegroundColor Red
        Write-Host "    $output" -ForegroundColor Red
        exit 1
    }

    Write-Host "  v Switched to $targetBranch" -ForegroundColor Green
    Write-Host "  v Submodules updated" -ForegroundColor Green

    if ($stashHappened) {
        Invoke-StashPop
    }
}

function Invoke-CreateBranch($newBranch, $fromBranch) {
    if ([string]::IsNullOrWhiteSpace($fromBranch)) {
        $fromBranch = "develop"
    }

    if ($fromBranch -eq "main") {
        Write-Host "  ! Warning: Creating branches from main is discouraged." -ForegroundColor Yellow
        Write-Host "    The main branch should only receive merges." -ForegroundColor Yellow
        $answer = Read-Host "  Continue? (y/N)"
        if ($answer -ne "y" -and $answer -ne "Y") {
            Write-Host "  Aborted" -ForegroundColor Red
            exit 0
        }
    }

    $output = git checkout -b $newBranch $fromBranch --recurse-submodules 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Branch creation failed:" -ForegroundColor Red
        Write-Host "    $output" -ForegroundColor Red
        exit 1
    }
    Write-Host "  v Created and switched to $newBranch (from $fromBranch)" -ForegroundColor Green

    git push -u origin $newBranch 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  v Pushed upstream (origin/$newBranch)" -ForegroundColor Green
    } else {
        Write-Host "  ! Push failed - you may need to push manually" -ForegroundColor Yellow
    }
}

function Invoke-MergeBranch($sourceBranch, $message) {
    $current = Get-CurrentBranch

    if ($current -eq $sourceBranch) {
        Write-Host "  ! Can't merge a branch into itself" -ForegroundColor Red
        exit 1
    }

    if ($current -eq "main" -and $sourceBranch -eq "develop") {
        Write-Host "  ! WARNING: Merging develop into main." -ForegroundColor Yellow
        Write-Host "    This makes develop's changes permanent." -ForegroundColor Yellow
        Write-Host "    Only proceed if develop has been tested and is stable." -ForegroundColor Yellow
        $answer = Read-Host "  Continue? (y/N)"
        if ($answer -ne "y" -and $answer -ne "Y") {
            Write-Host "  Aborted" -ForegroundColor Red
            exit 0
        }
    }

    Write-Host "`n  Merging $sourceBranch into $current..." -ForegroundColor Cyan

    $fetchOut = git fetch origin $sourceBranch 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! Fetch failed:" -ForegroundColor Red
        Write-Host "    $fetchOut" -ForegroundColor Red
        exit 1
    }
    Write-Host "  v Fetched origin/$sourceBranch" -ForegroundColor Green

    $mergeMsg = $message
    if ([string]::IsNullOrWhiteSpace($mergeMsg)) {
        $mergeMsg = "Merge branch '$sourceBranch' into $current"
    }

    $mergeOut = git merge $sourceBranch --no-ff -m "$mergeMsg" 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($mergeOut -match "CONFLICT") {
            Write-Host "  ! CONFLICT: Resolve conflicts manually, then commit" -ForegroundColor Red
        } else {
            Write-Host "  ! Merge failed:" -ForegroundColor Red
            Write-Host "    $mergeOut" -ForegroundColor Red
        }
        exit 1
    }
    Write-Host "  v Merged" -ForegroundColor Green

    $pushOut = git push 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  v Pushed to origin/$current" -ForegroundColor Green
    } else {
        Write-Host "  ! Push failed:" -ForegroundColor Yellow
        Write-Host "    $pushOut" -ForegroundColor Yellow
    }
}

function Show-Menu {
    $current = Get-CurrentBranch
    Write-Host "`n  Glitch AI - Branch Manager`n" -ForegroundColor Cyan
    Write-Host "  Current branch: $current`n" -ForegroundColor White

    Write-Host "  [1] List branches" -ForegroundColor White
    Write-Host "  [2] Switch branch" -ForegroundColor White
    Write-Host "  [3] Create new branch" -ForegroundColor White
    Write-Host "  [4] Merge branch" -ForegroundColor White
    Write-Host "  [5] Exit`n" -ForegroundColor White

    $choice = Read-Host "  Choice"
    Write-Host ""

    switch ($choice) {
        "1" {
            $branches = Get-BranchList
            Write-Host "  Branches:" -ForegroundColor Cyan
            foreach ($b in $branches) {
                $color = if ($b -match "^\*") { "Green" } else { "White" }
                Write-Host "    $b" -ForegroundColor $color
            }
        }
        "2" {
            $target = Read-Host "  Branch name to switch to"
            if (-not [string]::IsNullOrWhiteSpace($target)) {
                $global:NonInteractive = $true
                Invoke-SwitchBranch $target $Force
                $global:NonInteractive = $false
            }
        }
        "3" {
            $name = Read-Host "  New branch name"
            $source = Read-Host "  Source branch (default: develop)"
            if (-not [string]::IsNullOrWhiteSpace($name)) {
                Invoke-CreateBranch $name $source
            }
        }
        "4" {
            $source = Read-Host "  Branch to merge"
            if (-not [string]::IsNullOrWhiteSpace($source)) {
                $mergeMsg = Read-Host "  Commit message (optional)"
                Invoke-MergeBranch $source $mergeMsg
            }
        }
        "5" {
            Write-Host "  Goodbye" -ForegroundColor Cyan
            exit 0
        }
        default {
            Write-Host "  Invalid choice" -ForegroundColor Red
        }
    }
}

# --- Main ---

$argsList = @($MyInvocation.Line -split ' ')
$hasHelp = $argsList -match "--help" -or $argsList -match "-h" -or $argsList -match "/h" -or $argsList -match "/help" -or $argsList -match "-\?"

if ($hasHelp) {
    $helpText = @"
  USAGE
    .\scripts\switch-branch.ps1 [[-Branch] <string>] [-List] [[-Create] <string>]
      [[-From] <string>] [[-Merge] <string>] [[-Message] <string>] [-Force] [-NoStash]

  PARAMETERS
    -Branch <string>    Switch to this branch (auto-stashes, validates config)
    -List               List all branches
    -Create <string>    Create and switch to a new branch
    -From <string>      Source branch for -Create (default: develop)
    -Merge <string>     Merge specified branch into current
    -Message <string>   Commit message for merge
    -Force              Skip config validation on switch
    -NoStash            Don't auto-stash before switching
"@
    Write-Host $helpText -ForegroundColor Cyan
    exit 0
}

$hasAction = $List -or -not [string]::IsNullOrWhiteSpace($Branch) -or -not [string]::IsNullOrWhiteSpace($Create) -or -not [string]::IsNullOrWhiteSpace($Merge)

if ($List) {
    $branches = Get-BranchList
    Write-Host "`n  Branches:" -ForegroundColor Cyan
    foreach ($b in $branches) {
        $color = if ($b -match "^\*") { "Green" } else { "White" }
        Write-Host "    $b" -ForegroundColor $color
    }
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($Branch)) {
    Invoke-SwitchBranch $Branch $Force
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($Create)) {
    Invoke-CreateBranch $Create $From
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($Merge)) {
    if ([string]::IsNullOrWhiteSpace($Message)) {
        Write-Host "  ! -Message is required for -Merge" -ForegroundColor Red
        exit 1
    }
    Invoke-MergeBranch $Merge $Message
    exit 0
}

if (-not $hasAction) {
    Show-Menu
}
