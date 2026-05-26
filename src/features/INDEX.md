# Native — Feature Index

Fast map from topic → file. Prefer this over a semantic query when you already know the concept; fall back to `bun run query "..."` (workspace root) for exploratory searches.

## Creature — [src/features/creature/](.)

Pixi tentacle character with choreographed movement, companion tinks, and event reactions.

| Topic | File |
|---|---|
| Public API (start/stop/react/dispatch/spawnTink) | [creature/index.ts](creature/index.ts) |
| Choreography state machine, task list, blending | [creature/choreo.ts](creature/choreo.ts) |
| Pixi scene, frame loop, companion counting | [creature/renderer.ts](creature/renderer.ts) |
| Tentacle physics (verlet chain) | [creature/tentacle.ts](creature/tentacle.ts) |
| Particle trail per tentacle | [creature/particles.ts](creature/particles.ts) |
| Companion tinks (boids, progressive reveal) | [creature/companions.ts](creature/companions.ts) |
| Tunables (companionCount, tentacles, glow, etc.) | [creature/store.ts](creature/store.ts) |

**Key behaviors:**
- `leave-screen` dispatched in `start()` so creature boots offstage
- `claude-start` → `idle-figure8` ("writing" mode)
- `tts-open` → `idle-circle` at anchor ("reading" mode)
- `claude-stop` → short celebration (~900ms, 1.5 spins) → fly off on `tts-done` or 1.6s fallback
- `spawnTink()` reveals one companion, seeded at mother's current position

## Voice Anchor — [src/features/voice-anchor/](voice-anchor/)

Draggable on-screen button that marks the speaking position.

| Topic | File |
|---|---|
| Full component (icon + arrows + core + particles + drag) | [voice-anchor/index.ts](voice-anchor/index.ts) |

**Key behaviors:**
- Hover fades in core ring + GSAP-tweens arrows out; unhover tucks them back
- Click cycles mode: iterate → muted (solid red) → focus (dashed red) → iterate
- Drag emits `onDragStart`/`onChange`/`onDragEnd` — App.tsx lerps creature toward live anchor so boids don't glitch
- Pulls `ParticlePool` from `../ambient-vfx/particle-pool`
- Position persists via `voice_anchor_x`/`voice_anchor_y` in Rust settings (+ localStorage backup)

## Speech — [src/features/speech/](speech/)

TTS/STT-coupled UI.

| Topic | File |
|---|---|
| TTS paragraph/scroll/bubble display (word-timed) | [speech/paragraph-reader.ts](speech/paragraph-reader.ts) |
| Speak-selection hint bubble | [speech/selection-hint.ts](speech/selection-hint.ts) |
| STT flying-words display | [speech/stt-display.ts](speech/stt-display.ts) |
| Sine-wave visualizer (tts-open/tts-done, follows anchor) | [speech/sine-waves.ts](speech/sine-waves.ts) |

## Ambient VFX — [src/features/ambient-vfx/](ambient-vfx/)

Canvas effects that aren't tied to a specific feature.

| Topic | File |
|---|---|
| Triangle flow-particles (burstToAnchor on start/complete) | [ambient-vfx/flow-particles.ts](ambient-vfx/flow-particles.ts) |
| Edge glow (CSS box-shadow flash) | [ambient-vfx/edge-flash.ts](ambient-vfx/edge-flash.ts) |
| Shared typed-array particle pool | [ambient-vfx/particle-pool.ts](ambient-vfx/particle-pool.ts) |
| Pop-bubbles feature (trail + toggle + completion burst) | [ambient-vfx/bubbles/](ambient-vfx/bubbles/) |
| → sprite-sheet bubble effect | [ambient-vfx/bubbles/bubbles.ts](ambient-vfx/bubbles/bubbles.ts) |
| → shift-hold mouse trail | [ambient-vfx/bubbles/bubble-trail.ts](ambient-vfx/bubbles/bubble-trail.ts) |
| Legacy pixel-particles (unused) | [ambient-vfx/pixel-particles.ts](ambient-vfx/pixel-particles.ts) |

## Dashboards — [src/features/dashboards/](dashboards/)

Data-viz panels.

| Topic | File |
|---|---|
| Plan force-graph visualizer (WIP) | [dashboards/plan-viz.ts](dashboards/plan-viz.ts) |
| Plan Pixi force-layout | [dashboards/plan-viz-pixi.ts](dashboards/plan-viz-pixi.ts) |
| Plan achievement cards | [dashboards/plan-viz-achievement.ts](dashboards/plan-viz-achievement.ts) |
| Plan spine timeline | [dashboards/plan-viz-spine.ts](dashboards/plan-viz-spine.ts) |
| Folder tree viz | [dashboards/folder-viz.ts](dashboards/folder-viz.ts) |

## App Orchestration — [../App.tsx](../App.tsx)

All cross-feature coordination lives here. Key flags and flows:

| Concept | Lives in App.tsx |
|---|---|
| `pendingExit` + `flyOff()` | Armed by `play-complete-sound`, consumed by next `tts-done` or 1.6s fallback |
| `isReading` flag | Set on `tts-open`, cleared on `tts-done` — suppresses `tool-run`/`plan-update` reactions so the creature isn't yanked mid-orbit |
| `flewOffOnce` latch | Each fly-off → next `play-start-sound` consumes it to call `creature.spawnTink()` (cap 3) |
| Anchor-drag lerp chase | 12%/frame smoothing of `creature.followAnchor()` so boids track without jitter |

## Settings & Rust Backend — [../SettingsPanel/](../SettingsPanel/) + [../../src-tauri/src/](../../src-tauri/src/)

| Topic | File |
|---|---|
| Right-dock settings panel (folder; full topic map in [INDEX](../SettingsPanel/INDEX.md)) | [../SettingsPanel/index.tsx](../SettingsPanel/index.tsx) |
| Reusable row + dropdown + model-card components | [../SettingsPanel/components/](../SettingsPanel/components/) |
| Theme tokens (CSS vars, dark + aluminum) | [../SettingsPanel/theme.ts](../SettingsPanel/theme.ts) |
| Static config (hotkey allowlist, VFX rows, hidden personality data) | [../SettingsPanel/config.ts](../SettingsPanel/config.ts) |
| All Tauri commands, tray, window setup | [../../src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) |
| Settings struct + persistence | [../../src-tauri/src/settings.rs](../../src-tauri/src/settings.rs) |
| TTS (sherpa-rs / VITS) | [../../src-tauri/src/tts.rs](../../src-tauri/src/tts.rs) |
| STT (sherpa-rs / Zipformer) | [../../src-tauri/src/stt.rs](../../src-tauri/src/stt.rs) |
| Embedded SmolLM2 summarizer | [../../src-tauri/src/summarizer.rs](../../src-tauri/src/summarizer.rs) |
| HTTP speak server (:9877) | [../../src-tauri/src/speak_server.rs](../../src-tauri/src/speak_server.rs) |
| Cursor gating + anchor proximity poll | [../../src-tauri/src/lib.rs](../../src-tauri/src/lib.rs) (`CursorCtl`) |

## Entry Points — [../](../)

| Topic | File |
|---|---|
| SolidJS root render | [../index.tsx](../index.tsx) |
| Cross-feature orchestration + event wiring | [../App.tsx](../App.tsx) |
| Transparent background reset, global CSS | [../App.css](../App.css) |

## Sounds — [../sounds.ts](../sounds.ts)

Howler.js wrapper. Preloads WAV/MP3/AIFF from `public/assets/sfx/`, listens for `play-start-sound` / `play-milestone-sound` / `play-complete-sound` events from Rust, and routes to the active start/milestone/complete sound picked in Settings.

| Topic | File |
|---|---|
| Howler loader + event subscriptions | [../sounds.ts](../sounds.ts) |
| Rust-side legacy rodio playback (fallback) | [../../src-tauri/src/sfx.rs](../../src-tauri/src/sfx.rs) |
| SFX assets | [../../public/assets/sfx/](../../public/assets/sfx/) |

## Events Reference

All Tauri events that flow between Rust and the frontend. Emitted by Rust unless noted; listened in App.tsx / features.

| Event | Fired by | Handled by |
|---|---|---|
| `play-start-sound` | Rust hook `/sound` | `sounds.ts`, App.tsx (anchor burst, tink spawn) |
| `play-milestone-sound` | Rust | `sounds.ts` |
| `play-complete-sound` | Rust | `sounds.ts`, App.tsx (anchor burst, arm creature flyoff) |
| `tts-open` | Rust TTS start | `paragraph-reader`, `sine-waves`, App.tsx (`isReading=true`) |
| `tts-sentence` | Rust TTS (per word/sentence) | `paragraph-reader` |
| `tts-done` | Rust TTS end | `paragraph-reader`, `sine-waves`, App.tsx (consume pending flyoff) |
| `tts-escape` | Rust (ESC key) | All TTS UI (abort) |
| `tts-hint-hide` | Rust (speak-selection path — hotkey or middle-click) | `selection-hint` |
| `tts-display-mode` | Settings change | `paragraph-reader` |
| `stt-active` | Rust (Page Up down/up) | `stt-display`, App.tsx (show mic UI) |
| `stt-amplitude` | Rust mic loop | `stt-display` (bar pulse) |
| `stt-partial` | Rust STT decoder | `stt-display` |
| `stt-done` | Rust STT end | `stt-display`, paste step |
| `stt-download-progress` | Rust model download | `SettingsPanel` |
| `voice-download-start` / `…-complete` / `…-error` | Rust TTS model download | `SettingsPanel` |
| `model-download-progress` / `…-complete` / `models-missing` | Rust generic model events | `SettingsPanel` |
| `summarizer-download-progress` | Rust summarizer model download | `SettingsPanel` |
| `edge-flash` | Rust (completion) | `edge-flash.ts` |
| `particles-burst` | Rust speak server `/particles` | `flow-particles` |
| `plan-viz-update` / `plan-viz-demo` | plan-update hook | `dashboards/plan-viz*` |
| `folder-viz-show` | Rust file watcher | `folder-viz` |
| `toggle-bubbles` | Shift×3 (App.tsx local) | App.tsx (bubbles on/off) |
| `toggle-fire` / `toggle-tweakpane` | tray menu | legacy / dev |
| `open-settings` | tray menu + tooling | `SettingsPanel` |

## Tauri Commands — [../../src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)

Invoked from frontend via `invoke(...)`.

| Command | Purpose |
|---|---|
| `get_all_settings` / `update_setting` | Read/write the full settings blob |
| `set_settings_open` | Panel open/closed → gates cursor click-through via `CursorCtl` |
| `get_mouse_position` | Global mouse (for bubble trail, drag) |
| `stop_speaking` | Abort TTS (ESC / paragraph-reader close) |
| `speak_brief` | Short UI-chirp TTS via VITS — does NOT emit tts-open / tts-sentence / tts-done. Used by voice-anchor mode-flash ("mute" / "focus" / "iterate") |
| `set_voice` / `get_voice` / `download_voice_model` / `get_model_status` | TTS voice mgmt |
| `get_stt_models` / `set_stt_model` / `download_stt_model` | STT model mgmt |
| `summarizer_status` / `set_summarizer_model` / `download_summarizer_model` | Summarizer mgmt |
| `download_all_models` | Bulk prefetch |
| `play_sound` | Rust-side SFX (legacy; Howler is primary) |
| `scan_folder` | Folder-viz summary |

## Settings Fields — [../../src-tauri/src/settings.rs](../../src-tauri/src/settings.rs)

All persisted keys. UI for each lives in [../SettingsPanel.tsx](../SettingsPanel.tsx).

| Key | Options | Default |
|---|---|---|
| `work_mode` | `iterate`, `focus`, `muted` | `focus` |
| `auto_speak` | `true`, `false` | `false` |
| `personality` | `none`, `cutie`, `ship-computer`, `six-seven`, `noir-detective`, `sports-commentator`, `gossipy-bestie` | `none` |
| `voice` | `lessac-fast`, `vctk`, `lessac`, `alba` | `lessac-fast` |
| `display` | `bubbles`, `scroll`, `paragraph`, `creature` | `bubbles` |
| `sound_mode` | `both`, `start`, `complete`, `off` | `both` |
| `start_sound` | `start-quite`, `start-mystery` | `start-quite` |
| `milestone_sound` | `complete-bell`, `complete-sad`, `start-quite` | `complete-bell` |
| `complete_sound` | `complete-accomplish`, `complete-bell`, `complete-explode`, `complete-sad` | `complete-accomplish` |
| `vfx_enabled` | `true`, `false` | `true` |
| `vfx_color` | 6 named hex values | `#a78bfa` |
| `stt_enabled` | `true`, `false` | `true` |
| `summary_model` | `smol-135m`, `smol-360m`, `smol-1.7b`, `qwen-0.5b` | `smol-360m` |
| `voice_anchor_x` / `voice_anchor_y` | 0–1 floats | `0.8` / `0.5` |
| `anchor_bob` | `true`, `false` | `true` — idle vertical bob on the voice anchor (2.8 s period, 10.8 px swing). Phase-locked with the sine wave bob via shared `performance.now()` + cos formula. |
| `speak_selection_enabled` | `true`, `false` | `true` — master gate for the speak-selection feature (both hotkey and middle-click). |
| `speak_selection_shortcut` | Same set as `shortcut` | `PageUp` — key that triggers speak-selection when pressed. |
| `speak_selection_middle_click` | `true`, `false` | `true` — whether middle-mouse-button click also triggers speak-selection. |
| `speak_selection_mode` | `summarize`, `verbose` | `summarize` — route selection through SmolLM2 before TTS (vs. read verbatim). |

## Hooks (Claude Code integration)

Lives outside the repo at `~/.claude/hooks/`. Triggered from `~/.claude/settings.json`:

| Hook | Script | Notes |
|---|---|---|
| Notification / PreToolUse | `~/.claude/hooks/play-start-sound.sh` | Plays start SFX via `/sound` |
| UserPromptSubmit + PreToolUse + PostToolUse + Stop | `~/.claude/hooks/speak-narrator.sh` | Unified narrator. Gates on `work_mode`; routes through Haiku (if `ANTHROPIC_API_KEY` set) → embedded SmolLM2 → raw fallback; applies `personality` system prompt |
| PreToolUse | `~/.claude/hooks/plan-update.sh` | Forwards TodoWrite state to `plan-viz-update` / chart events |
| PostToolUse | `~/.claude/hooks/speak-tool-result.sh` | Legacy, still resident — narrator supersedes for most cases |
| Stop | `~/.claude/hooks/speak-response.sh` | Legacy completion narrator |
| Helper | `~/.claude/hooks/speak.sh` | CLI helper — `speak.sh "text"` |

Personalities are applied inside `speak-narrator.sh` (`sys_prompt()` case statement) and must match the Settings panel dropdown exactly.

## Ports

| Port | Service |
|---|---|
| 1420 | Vite dev server (frontend) |
| 9877 | Rust speak server (`/speak`, `/sound`, `/summarize`, `/status`, `/reposition`, `/particles`) |

## Docs — [../../docs/](../../docs/)

Prose design docs. Read these for *why*, not *what*.

| Doc | Topic |
|---|---|
| `01-tts-overview.md` | TTS pipeline end-to-end |
| `02-display-modes.md` | bubbles / scroll / paragraph / creature |
| `03-claude-hooks.md` | Hook wiring philosophy |
| `04-folder-visualization.md` | Folder-viz feature |
| `05-architecture.md` | Tauri + SolidJS layering |
| `06-selection-hint.md` | Speak-selection UX |
| `07-global-input.md` | CGEventTap middle-click + Page Up |
| `08-markdown-stripping.md` | Pre-TTS text sanitization |
| `09-settings-system.md` | Settings struct ↔ panel wiring |
| `10-http-speak-server.md` | `/speak` server endpoints |
| `audio-timeline.md` | Sound/speech cadence per mode |
| `status-report.md` | Last known state, broken things |
| `next-session-priorities.md` | Planned work queue |
| `idea-plan-visualizer.md` | Plan viz + achievement design |
| `speech-calibration.md` | Sine wave calibration: signs, curves, voice-level mapping, direction invariant |
| `creature.md` | Mother + tinks: states, transitions, blend curve, tunables, debugging |
| `logging.md` | Logging gaps + proposed unified JSONL stream with audit CLI |

## Legacy / Unused

Files that remain in the tree but aren't wired into `App.tsx` today. Kept for reference / revival:

| File | Status |
|---|---|
| [../fire.ts](../fire.ts) | Canvas 2D fire effect, not mounted |
| [../pixi-app.ts](../pixi-app.ts) | Shared Pixi renderer — creature uses its own renderer now |
| [../word-scroller.ts](../word-scroller.ts) | Older scrolling-word effect, superseded by paragraph-reader |
| [ambient-vfx/pixel-particles.ts](ambient-vfx/pixel-particles.ts) | Pixel square particles, commented out in App.tsx |
