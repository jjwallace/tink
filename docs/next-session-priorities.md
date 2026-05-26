# Next Session Priorities

## 1. Multi-screen overlay (BROKEN)
The overlay window positions once at startup and never moves. If you're on a different monitor, the overlay renders there with wrong dimensions, text is clipped.

**Fix:** Add a `reposition_overlay` function that:
- Gets current mouse position via `current_mouse_pos()`
- Finds which NSScreen contains that point
- Repositions + resizes the window to that screen's frame
- Call it: on `open-settings` event, on `tts-open` event, on a periodic check (every 5s)

**Files:** `src-tauri/src/lib.rs` lines ~905-930 (the setup block that positions the window)

## 2. Audio queue (speech/sounds overlap)
Currently each `/speak` call cancels the previous. Sounds and speech step on each other.

**Fix:** Add a queue to the speak server or TTS engine — sounds and speech play in order, each waiting for the previous to finish.

**Files:** `src-tauri/src/speak_server.rs`, `src-tauri/src/lib.rs` (do_speak_text)

## 3. Test iterate mode
The `PostToolUse` hook was added mid-session and never loaded. A fresh session will have it. Test that iterate mode narrates every tool call.

## 4. Settings panel accordions
Already implemented but untested with the new Rust backend. Verify after restart.

## Current port: 9877 (changed from 9876 due to zombie process)
