---
name: desktop-vision
description: Capture or inspect the Windows desktop from any pi session, including over live RDP where get_desktop_state fails with 0x80070006. Use whenever you need a desktop screenshot, screen OCR-grounding, or window-scoped input on this machine.
---

# Desktop Vision (Glitch + cua-driver)

## Which capture to use

1. Try `mcp cua-driver get_desktop_state` (or `cua-driver call get_desktop_state '{"max_image_dimension":1280}'`).
2. If it fails with `0x80070006` ("The handle is invalid"), the session is rendering on the RDP indirect display — desktop-wide WGC/GDI capture is impossible on Windows 11 while RDP is attached. Do NOT retry in a loop.
3. Fallback: run the compositor:
   ```powershell
   powershell -NoProfile -File "E:\Glitch AI\glitch-pi\scripts\capture-desktop.ps1"
   ```
   It captures every on-screen window separately (works over RDP), composites them at their desktop coordinates into `glitch-pi/data/desktop-compose.png`, and prints a JSON summary. Then `read` the PNG.
4. Window-scoped inspection always works: `get_window_state` (screenshot + UIA tree), `list_windows`, `get_screen_size`.
5. Input: prefer window-scoped routes (`set_value`, `type_text`, `press_key`, `click` with pid/window_id). Raw cursor injection (`SetCursorPos`/`SendInput`, e.g. `move_cursor`) is blocked in RDP sessions.

## Notes
- Desktop control is a toggleable service: the pi-web-ui header button (or
  `node scripts/desktop-control.mjs on|off`) flips `data/config/desktop-control.json`.
  When it is OFF, `capture-desktop.ps1` refuses with
  "desktop control is disabled" instead of resurrecting the daemon. Ask Troy to
  enable the header button rather than starting the daemon by hand.
- Details and evidence: `glitch-pi/user/post-mortems.md` → "Desktop capture 0x80070006 root cause".
- Full-desktop capture without RDP attached: `scripts/attach-session-to-console.ps1` once per login, then watch via Parsec (not RDP).
