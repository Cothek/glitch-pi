---
name: desktop-control
description: Full desktop computer-use via cua-driver MCP (59 tools). Use when you need to interact with the Windows desktop like a human — click, type, drag, manage windows, automate browsers, control clipboard. Pair with desktop-vision for capture; not for web-only tasks (use browser-use).
---

# Desktop Control (CUA)

## Tool Surface (59 tools, wired in `~/.pi/agent/mcp.json` as `cua-driver`)

### Observation
- `get_window_state` — per-window PNG + UIA tree (works everywhere)
- `get_desktop_state` — full desktop PNG + UIA tree (FAILS 0x80070006 over RDP IDD)
- `get_accessibility_tree` — UIA tree of focused window
- `list_apps`, `list_windows`, `get_screen_size`, `get_cursor_position`
- `get_browser_state` — browser tabs/URLs
- `check_permissions`, `health_report`

### Input: Mouse
- `click`, `double_click`, `right_click`, `drag`
- `move_cursor` — raw cursor positioning (BLOCKED over RDP IDD; prefer window-scoped click)
- `set_agent_cursor_enabled` — toggle agent cursor visibility
- `set_agent_cursor_motion`, `set_agent_cursor_theme`
- Troy sees the agent cursor move — it has a visible theme.

### Input: Keyboard
- `type_text` — types text into the active element
- `press_key` — presses a key combo
- `hotkey` — sends a key combination
- `set_value` — sets UIA value on checkboxes, toggles, text fields
- `scroll` — scrolls at cursor position or given coordinates

### Windows / Apps
- `list_apps`, `list_windows` — enumerate apps and open windows
- `launch_app <name>` — launch application
- `kill_app <pid>` — terminate process (confirm with Troy first)
- `bring_to_front`, `set_window_frame` — bring to front, move/resize
- `invoke_menu` — invoke menu command

### Browser (cua-driver builtin, replaces page-picker bridge)
- `browser_navigate`, `browser_click`, `browser_type`
- `browser_pointer`, `browser_dialog`, `browser_set_input_files`, `browser_download`
- For web-only tasks, prefer the browser-use skill instead.

### Clipboard
- `clipboard_read`, `clipboard_write`

### Session / Recording
- `start_session`, `end_session`, `escalate_session`, `list_sessions`
- `start_recording`, `stop_recording`, `replay_trajectory`

## Capture Paths — see `desktop-vision` skill

Full-desktop GDI (`get_desktop_state`) fails with 0x80070006 over RDP IDD. Use:
- `desktop_screenshot` — composited desktop PNG (registered by the desktop-control plugin, works over RDP)
- `get_window_state` — per-window PNG + UIA (works everywhere)
- `list_windows` + `get_accessibility_tree` — structural overview

## Interaction Safety
1. Prefer window-scoped input (`set_value`, `type_text`, `click` with window id) over raw cursor injection.
2. `move_cursor` / `SetCursorPos` is BLOCKED over RDP IDD — do not retry.
3. Screenshot before and after every action for verification.
4. Confirm destructive actions (`kill_app`, window resize, `set_window_frame`) with Troy.
5. The agent cursor is visible to Troy — it moves with each interaction.

## Workflow
1. Capture the target window or desktop (`get_window_state` / `desktop_screenshot`)
2. Analyze the visual (desktop-vision skill or read the PNG directly)
3. Identify the target element in the UIA tree
4. Interact (click, type_text, set_value, etc.)
5. Capture again to verify the outcome
6. Report what happened

## Daemon Toggle
Top-bar icon (pi-web-ui) or `POST /plugins-api/desktop-control/toggle` with body `{"enabled": true|false}`. The daemon (`cua-driver serve`) provides an always-on endpoint; the MCP server runs in-process when enabled. `desktop_screenshot` works whether the daemon is running or not.
