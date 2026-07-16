# Native — Desktop Overlay & Voice Assistant

Tauri 2 desktop app: transparent fullscreen overlay with TTS, STT, VFX, sound effects, and an embedded LLM summarizer. Runs as a system tray app on macOS.

**→ For a fast topic → file map of the feature folders, read [src/features/INDEX.md](src/features/INDEX.md) first.**

## Quick Start

```bash
cd repos/nest/native
bun install
bun run tauri dev
```

- **Frontend**: SolidJS + Vite on port 1420
- **Backend**: Rust (Tauri) with speak server on port 9877
- **Build tool**: Bun (frontend), Cargo (backend)

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Tauri Window (transparent, fullscreen, overlay) │
│                                                 │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ SolidJS App  │  │ Canvas 2D + Pixi layers │  │
│  │ (DOM)        │  │ - Creature (Pixi)       │  │
│  │ - Settings   │  │ - Sine waves            │  │
│  │ - Paragraph  │  │ - Flow-particle         │  │
│  │ - STT words  │  │ - Bubbles               │  │
│  │ - VoiceAnchor│  │ - Edge flash (CSS)      │  │
│  └──────────────┘  └─────────────────────────┘  │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ Rust Backend                            │    │
│  │ - TTS (sherpa-rs/VITS)                  │    │
│  │ - STT (sherpa-rs/Zipformer)             │    │
│  │ - Summarizer (llama-cpp-2/SmolLM2)      │    │
│  │ - HTTP speak server (:9877)             │    │
│  │ - macOS event tap (global hotkeys)      │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Progressive discovery

Do NOT open every file at once. Drill in this order:

1. **[src/features/INDEX.md](src/features/INDEX.md)** — topic/event/command → file map. Everything is linked from here.
2. **[docs/speech-calibration.md](docs/speech-calibration.md)** — sine-wave + voice-level + direction invariant math
3. **[docs/creature.md](docs/creature.md)** — mother + tinks state machine, blend curves, tunables
4. **[docs/narration-guardrails.md](docs/narration-guardrails.md)** — narrator personality rules + guardrails filter + case studies
5. **[docs/logging.md](docs/logging.md)** — current log sinks + proposed unified JSONL design
6. Only then drill into `src/` or `src-tauri/src/`

## Gotchas — things that bit us

Ordered by how many hours they each cost. **Read before debugging audio / creature / sine wave issues.**

### 1. Rust changes require a full process restart

`tauri dev` does **NOT** hot-reload Rust code. Editing `.rs` files + running `cargo build` rebuilds the binary on disk, but the **running process keeps the OLD code loaded in memory**. A session-cancellation bug in `tts.rs` was "fixed" multiple times before we realized the fix never took effect.

**Always:**
```bash
kill <tauri-native-pid>    # find via ps aux | grep target/debug/native
bun run tauri dev          # relaunch
```

Or equivalently kill the running Tauri window and start over. After editing any `.rs`, assume your changes aren't live until you restart.

### 2. speak-response.sh uses `tail -40` → drops long-turn responses

`~/.claude/hooks/speak-response.sh` reads the last 40 lines of the JSONL transcript to find the assistant's text. A turn with many tool calls (Read / Edit / Bash ×N) can push the response past that window, causing the hook to log `EXIT: no assistant response found` and skip the summary entirely.

Workaround: bumping to `tail -500` works but has side effects (too-wide window can pick up stale text). See commit history for the attempted fix that was reverted. **If a completion skips summarization, check `tail /tmp/speak-hook.log` for `no assistant response found`** — that's this bug, not a real "nothing to say" situation.

### 3. TTS session_active flag is load-bearing

[tts.rs](src-tauri/src/tts.rs) has `session_active: AtomicBool`. Paired with `start_session()` / `end_session()`. If you add a new speak path (like `speak_brief`), you **MUST call `end_session()` before emitting `tts-done`** or the next queued speak will block for 60 s until the wait-loop times out.

The reason: `is_playing()` returns `session_active || !sink.empty()`. Without `end_session()`, `session_active` stays `true` forever and every new speak waits.

### 4. Sine-wave direction is protected by THREE redundant guards

[sine-waves.ts](src/features/speech/sine-waves.ts) enforces rightward travel via:
1. `Math.abs(this.config.speed)` in drawWave
2. Leading minus sign on the `(time * speed)` phase term
3. Monotonic `this.time += 0.008` in render loop (never `-=`)

All three must stay. Any single change flips direction. This was the cause of a long debugging cycle where the user reported leftward drift and my math said rightward — ultimately it was HMR caching the old module, but the guards are there now so a real regression can't slip through.

### 5. Anchor ↔ sine-wave bob sync needs IDENTICAL time source + formula

Both use `performance.now() * 0.001` as the clock and `-A + A·cos(2π·t/5.6)` as the offset formula. GSAP's tween ticker drifts relative to `performance.now()`, so the old GSAP-yoyo anchor bob and the sine-wave cos bob looked "almost synced" but wobbled apart.

If you change one, change the other.

### 6. Project-level settings override user-level for hooks

`/Users/dork/repos/wolf/Lattice/.claude/settings.local.json` wires Stop → `speak-response.sh`, which **overrides** the user-level `~/.claude/settings.json` wiring to `speak-narrator.sh`. Both may exist; the project-level one wins in this workspace.

If narration behavior differs between projects, check both settings files.

### 7. Cross-feature state coordination is by convention, not enforcement

`pendingExit`, `flewOffOnce`, `sessionClosing`, `isReading`, `speaking`, `ampScale` — these cooperate loosely across [App.tsx](src/App.tsx) and feature modules via window events and timers. Adding a new feature that interacts with session lifecycle → check the docs before introducing another flag. The session-state-machine refactor proposed in [docs/logging.md](docs/logging.md) would consolidate these.

## Key conventions

- All frontend features live under [src/features/](src/features/) — never add top-level `src/*.ts` feature files anymore; the pre-refactor layout was moved during this restructure
- Rust commands are registered in `lib.rs` `invoke_handler!` — don't forget to add new ones there
- Settings keys are mirrored three places: [settings.rs](src-tauri/src/settings.rs) struct, [lib.rs](src-tauri/src/lib.rs) get_all_settings, [SettingsPanel/types.ts](src/SettingsPanel/types.ts) AllSettings interface. Miss one → silent failure. TS type-check catches the third. See [SettingsPanel/INDEX.md](src/SettingsPanel/INDEX.md) for the panel's full topic map
- Hook scripts at `~/.claude/hooks/` source shared libraries (`guardrails.sh`) — keep that dir in version control separately from the app

## Quick debug cheatsheet

| Symptom | First place to look |
|---|---|
| Voice cut off mid-word | `tail /tmp/speak-hook.log` — if "EXIT: no assistant response found", see Gotcha #2; if new speak enqueued during prior, see Gotcha #1 (restart) |
| Narrator says something weird | `~/.claude/hooks/guardrails-audit.sh` |
| Creature behaves strangely | Check `display` setting is "creature"; check App.tsx `isReading` / `sessionClosing` state |
| Wave goes wrong direction | Don't touch the signs — it's HMR cache; restart the dev server |
| Setting not persisting | Verify it's in all 3 mirrored places (Gotcha above) |
| Mode chirp not playing in VITS voice | speak_brief command registered? end_session being called? |

## Port reference

| Port | Service |
|---|---|
| 1420 | Vite dev server (frontend) |
| 9877 | Rust speak server — `/speak` `/sound` `/summarize` `/status` `/reposition` `/particles` |
