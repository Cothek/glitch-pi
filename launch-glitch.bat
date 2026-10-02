@echo off
title Glitch AI - Unified Launcher

REM ---- Tooling PATH prep ----
REM Prefer bundled Node.js; fall back to system node
set "NODE_CMD=node"
if exist "%~dp0data\node\node.exe" (
  set "NODE_CMD=%~dp0data\node\node.exe"
  set "PATH=%~dp0data\node;%PATH%"
)

REM Add bundled MinGit to PATH if present (cmd/ for git.exe, usr/bin/ for bash.exe etc.)
if exist "%~dp0data\mingit\cmd\git.exe" (
  set "PATH=%~dp0data\mingit\cmd;%~dp0data\mingit\usr\bin;%PATH%"
)

REM Auto-bootstrap if Node.js not available - neither bundled nor system
if not exist "%~dp0data\node\node.exe" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo Bootstrapping Glitch ^(first-time setup - downloading Node.js + Pi engine^)...
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-pi.ps1"
        echo.
        if not exist "%~dp0data\node\node.exe" (
            echo Bootstrap failed - Node.js still missing. Please install Node.js manually.
            pause
            exit /b 1
        )
    )
)

REM Re-evaluate NODE_CMD and PATH after bootstrap
if exist "%~dp0data\node\node.exe" (
    set "NODE_CMD=%~dp0data\node\node.exe"
    set "PATH=%~dp0data\node;%PATH%"
)

if exist "%~dp0assets\glitch-head.txt" powershell -NoProfile -Command "Get-Content '%~dp0assets\glitch-head.txt' -Encoding UTF8"
echo.
set "LOG_FILE=%~dp0data\launch.log"
if not exist "%~dp0data" mkdir "%~dp0data"
echo [%date% %time%] Glitch starting... > "%LOG_FILE%"
echo [%date% %time%] Args: %* >> "%LOG_FILE%"
REM Run node script with live output
"%NODE_CMD%" "%~dp0scripts\launch-unified.mjs" %*
set "NODE_EXIT=%errorlevel%"
if %NODE_EXIT% neq 0 (
    echo [%date% %time%] Glitch exited with code %NODE_EXIT% >> "%LOG_FILE%"
    echo.
    echo Glitch exited with code %NODE_EXIT%.
    echo.
    echo Press any key to exit...
    pause > nul
)
exit /b %NODE_EXIT%
