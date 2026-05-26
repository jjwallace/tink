# Global Input Handling

Native intercepts system-wide input events using macOS CGEvent taps, allowing it to respond to user actions in any application.

## CGEvent Tap

A listen-only event tap is created on a background thread during app setup. It monitors:

| Event Type | Keycode/Button | Action |
|---|---|---|
| `kCGEventOtherMouseDown` | Middle mouse button | Speak selection (gated by `speak_selection_enabled` + `speak_selection_middle_click`) |
| `kCGEventLeftMouseDragged` | Any drag | Set "was dragging" flag |
| `kCGEventLeftMouseUp` | After drag | Show selection hint bubble |
| `kCGEventKeyDown` | Escape (keycode 53) | Stop TTS, close all UI |
| `kCGEventKeyDown` | `speak_selection_shortcut` keycode (default PageUp = 116) | Speak selection (gated by `speak_selection_enabled`) |
| `kCGEventKeyDown` | `shortcut` keycode (default PageDown = 121) | Start STT (push-to-talk) |
| `kCGEventKeyUp` | `shortcut` keycode | Stop STT, paste transcript |

## Requirements

- **Accessibility permissions** are required for the event tap to work
- Grant via: System Settings > Privacy & Security > Accessibility > enable Native
- Without permissions, the event tap fails silently (logged to stderr)

## Debouncing

Middle-click has a 1-second debounce to prevent rapid-fire triggers. The drag detection flag (`WAS_DRAGGING`) resets on every mouse-up, so normal clicks don't trigger the selection hint.

## Hotkey Bindings

Both hotkeys are read directly from the CGEvent tap via atomic keycodes (`STT_HOTKEY_KEYCODE`, `SPEAK_SEL_HOTKEY_KEYCODE`) rather than `tauri-plugin-global-shortcut` — the plugin consumes events before the tap sees them, which broke the indicator UI. The keycode atomics are seeded from settings at launch and refreshed on every `update_setting` call.

Supported bindings (see `shortcut_to_keycode` in `src-tauri/src/lib.rs` and `SUPPORTED_HOTKEYS` in `src/SettingsPanel.tsx` — keep in sync):

- `PageUp`, `PageDown`, `Home`, `End`, `Insert`, `Delete`
- `F13`–`F20`

Letter/number keys are deliberately excluded: the bindings fire globally, so letters would trigger during normal typing.

## Speak-Selection Modes

`speak_selection_mode` controls what the selection feeds into:

- `summarize` (default) — raw selection → SmolLM2 → TTS. Returns a 1–2 sentence digest. Falls back to verbatim on `SKIP` or summarizer error.
- `verbose` — raw selection → `strip_markdown` → TTS. Reads exactly what's highlighted.
