@echo off
rem Disables the RDP WDDM graphics driver so GDI/WGC screen capture works
rem inside an active RDP session. Reversible: delete the value to undo.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" /v fEnableWddm /t REG_DWORD /d 0 /f
reg query "HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" /v fEnableWddm
echo.
echo Policy written. Now disconnect and reconnect RDP, then tell Glitch to retest.
pause
