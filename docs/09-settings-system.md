# Settings System

All user preferences are persisted as JSON and restored on app launch.

## File Location

`~/Library/Application Support/com.wolfgames.native/settings.json`

## Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `shortcut` | string | `"PageDown"` | Global hotkey to trigger speak |
| `voice` | string | `"lessac-fast"` | TTS voice model identifier |
| `display` | string | `"bubbles"` | Visual display mode |
| `auto_speak` | boolean | `false` | Enable Claude auto-speak and file watcher |

## Tray Menu Integration

All settings are editable from the system tray menu with checkmark indicators:

- **Speak Selection** — manual trigger
- **Auto-Speak (Claude)** — toggle for hooks and file watcher
- **Settings** submenu containing:
  - **Voice** — Lessac (American), VCTK (British)
  - **Shortcut** — PageDown, Cmd+Shift+R, Cmd+Shift+Space, F5, F6
  - **Display** — Bubbles, Scroll, Paragraph

Changes take effect immediately and are persisted to disk.
