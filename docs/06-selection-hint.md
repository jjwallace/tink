# Selection Hint

When you drag-select text anywhere on your desktop, a small floating bubble appears near your cursor showing the hotkey to trigger dictation.

## How It Works

The CGEvent tap in Rust monitors three mouse events:
- `kCGEventLeftMouseDragged` — sets a "was dragging" flag
- `kCGEventLeftMouseUp` — if dragging flag was set, emits `tts-hint-show` with mouse position and current shortcut key
- The hint bubble shows "press Page Down to read aloud" (or whatever shortcut is configured)

## Frontend Component

The `SelectionHint` class creates a small dark pill that:
- Fades in near the cursor with a slight upward slide
- Shows the shortcut key in bold
- Auto-hides after 4 seconds
- Disappears immediately when TTS starts (via `tts-hint-hide` event)

## Customization

The hint automatically reflects whatever shortcut is configured in Settings. If you change the hotkey to F5, the hint updates to show "press F5 to read aloud".
