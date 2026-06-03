# Tink — Desktop Overlay App

Tauri 2 + SolidJS transparent fullscreen overlay. Ships as `Tink.dmg`.
Voice anchor, TTS/STT, creature choreography, VFX, settings panel.

## Build

```bash
# One-time: install create-dmg
brew install create-dmg

# Rebuild creature package after touching companion/creature/src/*
cd ../companion/creature && bun run build && cd ../../tink

# Full release build → Tink.app + Tink_0.2.0_aarch64.dmg
bun run tauri build
# Artifacts:
#   src-tauri/target/release/bundle/macos/Tink.app
#   src-tauri/target/release/bundle/dmg/Tink_0.2.0_aarch64.dmg

# Dev (hot-reload frontend, restart after any .rs change)
bun run tauri dev
```

**After any `.rs` change:** kill the running process and `bun run tauri dev` again — Rust code is NOT hot-reloaded.

## Routing Table

| Domain | File |
|---|---|
| App config (name, bundle targets, icon) | [`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json) |
| App icons (icon.icns, icon.png, etc.) | [`src-tauri/icons/`](src-tauri/icons/) |
| Rust entry + invoke_handler registration | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) |
| Tauri commands — settings read/write | [`src-tauri/src/commands/settings.rs`](src-tauri/src/commands/settings.rs) |
| Tauri commands — voice (TTS models) | [`src-tauri/src/commands/voice.rs`](src-tauri/src/commands/voice.rs) |
| Tauri commands — STT models | [`src-tauri/src/commands/stt.rs`](src-tauri/src/commands/stt.rs) |
| Tauri commands — summarizer | [`src-tauri/src/commands/summarizer.rs`](src-tauri/src/commands/summarizer.rs) |
| Tauri commands — misc (play_sound, scan_folder, download_all_models) | [`src-tauri/src/commands/misc.rs`](src-tauri/src/commands/misc.rs) |
| Settings struct + persistence | [`src-tauri/src/settings.rs`](src-tauri/src/settings.rs) |
| System tray menu + switch screen | [`src-tauri/src/tray.rs`](src-tauri/src/tray.rs) |
| Window transparency, click-through gating, proximity poll | [`src-tauri/src/window_setup.rs`](src-tauri/src/window_setup.rs) |
| TTS engine (Piper/sherpa-rs/VITS) | [`src-tauri/src/tts.rs`](src-tauri/src/tts.rs) *(via voice-core)* |
| TTS voice model list | [`voice-core/src/tts.rs`](voice-core/src/tts.rs) → `default_voice_specs()` |
| STT engine (Zipformer) | [`src-tauri/src/stt.rs`](src-tauri/src/stt.rs) |
| HTTP speak server (:9877 /speak /sound /summarize) | [`src-tauri/src/speak_server.rs`](src-tauri/src/speak_server.rs) |
| Global hotkeys (CGEvent tap, Page Up/Down) | [`src-tauri/src/hotkeys.rs`](src-tauri/src/hotkeys.rs) |
| Creature Rust runtime (RPC to JS) | [`src-tauri/src/creature_runtime.rs`](src-tauri/src/creature_runtime.rs) |
| SolidJS app root + event wiring | [`src/App.tsx`](src/App.tsx) |
| Settings panel (full UI) | [`src/SettingsPanel/index.tsx`](src/SettingsPanel/index.tsx) |
| Settings panel topic map | [`src/SettingsPanel/INDEX.md`](src/SettingsPanel/INDEX.md) |
| Theme tokens (CSS vars, dark/aluminum) | [`src/SettingsPanel/theme.ts`](src/SettingsPanel/theme.ts) |
| Global CSS (transparent background) | [`src/App.css`](src/App.css) |
| Feature folder topic map | [`src/features/INDEX.md`](src/features/INDEX.md) |
| **Voice anchor** (drag, mode cycle, particles) | **`../companion/creature/src/voice-anchor.ts`** |
| Creature choreography + orchestrator | `../companion/creature/src/` |
| Sound effects (Howler.js) | [`src/sounds.ts`](src/sounds.ts) |
| SFX assets | [`public/assets/sfx/`](public/assets/sfx/) |
| Tink sprite image | [`public/assets/tink-plain.png`](public/assets/tink-plain.png) |

## Key Architecture Points

### Click-through gating
The overlay window uses `set_ignore_cursor_events(true)` globally. Clicks only reach the webview when the mouse is within 48 logical-pixel radius of the saved anchor position (proximity poll in `window_setup.rs`) OR while `anchor_dragging = true` (set on every `mousedown` on the anchor).

**Important:** `set_anchor_dragging(true)` is invoked on `mousedown` (not after the 5 px drag threshold). This prevents a race where the proximity poll flips the window back to click-through before the drag starts.

### Anchor drag
Lives in `../companion/creature/src/voice-anchor.ts` (part of the `@jjwallace/creature` package). After editing it, run `cd ../companion/creature && bun run build` to update the dist that `tink` imports via `"@jjwallace/creature": "link:@jjwallace/creature"`.

### Switch Screen
`tray.rs` → `switch_to_next_screen`. Menu events run on a background thread; NSWindow ops must be on the main thread. Fixed via `app.run_on_main_thread(...)`.

### Settings keys
Defined in three places — miss one → silent failure:
1. `src-tauri/src/settings.rs` — Rust struct field
2. `src-tauri/src/commands/settings.rs` — `update_setting` match arm + `get_all_settings` JSON key
3. `src/SettingsPanel/types.ts` — `AllSettings` TypeScript interface

### Voice models
Only Alba is bundled. `default_voice_specs()` in `voice-core/src/tts.rs` returns `["en_GB-alba-medium"]`. The `download_all_models` command in `misc.rs` mirrors this. To add more voices, edit `default_voice_specs()` and `misc.rs` together.

### Gotchas
See the full gotcha list in this file's parent README or the nest/native CLAUDE.md — the patterns are identical (same codebase lineage).
- Rust changes require full process restart (`bun run tauri dev`)
- `tts_enabled` persists as a boolean but IPC sends `"true"/"false"` strings
- Window level 25 (above most apps); proximity poll every 60 ms
