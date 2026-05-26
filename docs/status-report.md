# Status Report — 2026-04-07

## What's Broken Right Now

**TTS speak endpoint is unresponsive.** The HTTP server on port 9876 accepts connections but doesn't return responses. The app is running old compiled code — none of our changes are live. Multiple curl connections are stuck waiting, which may be causing a backlog.

**Fix:** Kill the app and restart with a fresh build:
```bash
# Kill everything
pkill -f "native" 
lsof -ti:1420 | xargs kill 2>/dev/null
lsof -ti:9876 | xargs kill 2>/dev/null

# Rebuild and run
cd repos/nest/native
bun run tauri dev
```

## What Was Built (Not Yet Running)

### 1. Speech-to-Text (Push-to-Talk)
- **Files:** `src-tauri/src/stt.rs`, `src/stt-display.ts`
- **How it works:** Hold Page Up → mic captures audio → ZipFormer decodes → words fly onto screen → release to paste
- **Status:** Code compiles, offline model downloaded (342MB), but untested because app needs restart
- **Known issue:** Was using streaming model with offline recognizer — fixed to use offline model

### 2. Settings Panel
- **Files:** `src/settings-panel.ts`, updated `src-tauri/src/settings.rs`
- **How it works:** Tray menu → "Settings..." → dark overlay with pill toggles
- **Settings:** Work Mode (Iterate/Autopilot), Voice, Display, Sounds, Voice Input, Auto-Speak
- **Status:** Code complete, untested

### 3. Sound Effects
- **Files:** `src-tauri/src/sfx.rs`
- **How it works:** `play_sfx("start")` or `play_sfx("complete")` plays WAV via rodio
- **Available sounds:** `start-quite.wav`, `complete-accomplish.wav`
- **Status:** Code complete, untested

### 4. First-Launch Model Downloader
- **How it works:** On startup, checks for missing models, emits `models-missing` event, settings panel auto-opens with download button
- **Status:** Code complete, untested

### 5. Setup Script Improvements
- **File:** `setup.sh` — one-command install (checks Rust, Bun, Xcode CLT, downloads all models)
- **Status:** Written and working

## Sentence Splitter Fix
- Fixed dot-splitting in `tts.rs` so filenames like `setup-models.sh` don't get split into separate sentences

## What Needs to Happen Next

1. **Restart the app** to pick up all compiled changes
2. **Test STT** — hold Page Up, speak, verify words appear and paste works
3. **Test Settings Panel** — tray → Settings, click pill toggles
4. **Test SFX** — verify start/complete sounds play
5. **Test Model Downloader** — delete a model dir, restart, verify auto-download prompt

## Product Direction

The user wants two work modes:
- **Iterate:** Constant narration, speech on every step, rich feedback while watching
- **Autopilot:** Confident send-off, silent work, sound effect + summary when done

The TTS integration with Claude Code is not reliably firing — the speak endpoint hangs. This is the core blocker for the product experience.
