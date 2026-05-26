# SettingsPanel — Topic Index

Settings overlay UI: a draggable, themable panel with sections of typed
rows, model pickers (TTS/STT/summarizer), and a theme switcher. The
shell lives in [index.tsx](index.tsx); leaf UI is in [components/](components),
shared types in [types.ts](types.ts), CSS-var theming in [theme.ts](theme.ts),
and static row definitions in [config.ts](config.ts).

## Files

| File | Lines | What it owns |
|---|---|---|
| [index.tsx](index.tsx) | ~870 | Panel shell: open/close, drag-to-position, Tauri event listeners, `fetchSettings`/`updateSetting`, JSX composition of all sections |
| [types.ts](types.ts) | ~95 | `AllSettings`, `VoiceSpec`, `SttModelInfo`, `SummarizerModelInfo`, `ModelProgressEvent`, `SettingRowDef`, `SettingsSection` |
| [theme.ts](theme.ts) | ~115 | `ThemeMode`, `ThemeVars`, `THEMES` map, `themeVars()` CSS-var builder, `loadTheme()`/`saveTheme()` localStorage helpers, `FONT`, `PURPLE`, `GREEN`, `RED`, `ACTIVE_COLOR` |
| [config.ts](config.ts) | ~95 | `SUPPORTED_HOTKEYS` allowlist, `HOTKEY_LABEL` map, `SECTIONS` (personality picker data — currently hidden), `VFX_ROWS` |

## Components ([components/](components))

| Component | Used by | Purpose |
|---|---|---|
| [Tooltip](components/Tooltip.tsx) | `RowShell` | Hover-help "?" badge next to row labels |
| [SectionBox](components/SectionBox.tsx) | `index.tsx` | Collapsible accordion with localStorage-persisted state, optional red `alertOpen` for missing-model nags |
| [RowShell](components/RowShell.tsx) | All `*Row` components | Label + `Tooltip` on the left, control slot on the right |
| [Dropdown](components/Dropdown.tsx) | `SelectRow`, `SoundSubRow` | Custom dropdown (avoids macOS NSMenu font mismatch); fixed-position popover that closes on click-outside / scroll / resize / Escape |
| [SelectRow](components/SelectRow.tsx) | `Row` (3+ option case) | Wraps `Dropdown` in a labeled row |
| [ToggleRow](components/ToggleRow.tsx) | `Row` (2-option case) | iOS-style switch; detects ON/OFF by value not position |
| [SwatchRow](components/SwatchRow.tsx) | `Row` (`vfx_color`) | Round color swatches with active ring |
| [SoundSubRow](components/SoundSubRow.tsx) | Sounds section | Inline toggle + sound-picker dropdown on one line |
| [Row](components/Row.tsx) | Section render loops | Dispatches a `SettingRowDef` to `SwatchRow` / `ToggleRow` / `SelectRow` based on key + option count |
| [HotkeyCaptureRow](components/HotkeyCaptureRow.tsx) | STT / Speak-Selection | Click-to-capture hotkey binder; only accepts keys in `SUPPORTED_HOTKEYS` |
| [HotkeyTestIndicator](components/HotkeyTestIndicator.tsx) | STT section | "Hold to test" dot that lights up while the bound hotkey is pressed (driven by Rust `stt-active` event) |
| [Spinner](components/Spinner.tsx) | `ModelCard` | Tiny GSAP-rotated circle for download buttons |
| [ModelCard](components/ModelCard.tsx) | TTS / STT / summarizer pickers | Card row with progress-fill background + GSAP-pulsed border while downloading; click to activate |
| [AddVoiceRow](components/AddVoiceRow.tsx) | TTS section | Inline "+ Add voice from Piper catalog" form; collapsed → button, expanded → ID input + external sample-browser link |

## Common workflows

### Adding a new top-level setting
1. Add the field to the Rust `Settings` struct in [src-tauri/src/settings.rs](../../src-tauri/src/settings.rs) with a `#[serde(default = ...)]`.
2. Wire it through `get_all_settings` and `update_setting` in [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs).
3. Add the field to [types.ts](types.ts) `AllSettings`.
4. Either add a `SettingRowDef` to a section in [config.ts](config.ts) (auto-renders via `Row`), or hand-render a custom row in [index.tsx](index.tsx).

### Adding a new section
1. Add a `SettingsSection` to `SECTIONS` in [config.ts](config.ts), or add a hand-coded `<SectionBox>` block in [index.tsx](index.tsx).
2. Sections rendered via `SECTIONS` use `Row` for dispatch; hand-coded ones can mix any row component.

### Adding a new model picker
Reuse [`ModelCard`](components/ModelCard.tsx) — pass `{ model, isActive, downloadStatus, downloadProgress, onUse, onDownload }`. Rust side needs to emit `<feature>-download-{start,progress,complete,error}` events with `{ id, percent, ... }` payloads; the panel shell wires those into `*Downloads` and `*Progress` signals.

### Adding a new theme
Add a key to `ThemeMode` and an entry in `THEMES` in [theme.ts](theme.ts). All components read theme via CSS vars (`var(--text-primary)` etc.), so no per-component edits needed. Toggle via `loadTheme()` / `saveTheme()` (already wired into the panel header).

### Adding a Tauri event listener
In [index.tsx](index.tsx) `onMount`, add an `await listen<Payload>("event-name", …)` and push the unlisten function to `unlisteners[]`. Cleanup is automatic via `onCleanup`.

## Conventions

- **CSS vars > color literals**: every component reads colors from `var(--text-primary)`, `var(--control-bg)`, etc. Theme swaps happen by reapplying the style object on the panel root. Only accent colors (`PURPLE`, `GREEN`, `RED`, `ACTIVE_COLOR`) are hard-coded and theme-invariant.
- **GSAP for animation**: row hover scale, downloading-border pulse, spinner — all GSAP. Avoids CSS keyframe leakage between SolidJS reactivity passes.
- **Click-outside closes**: any popover / floating UI must listen on `document.mousedown` and `keydown` (Escape) and call its own `setOpen(false)`. See [Dropdown.tsx](components/Dropdown.tsx) for the canonical pattern.
- **Show-fallback for transient state**: download spinners, error retries, and recording chiclets all use `<Show fallback={…}>` rather than separate components. Keeps state transitions in one place.

## Backend touchpoints

The panel reads from / writes to these Rust commands (defined in [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)):

- `get_all_settings` → returns `AllSettings` JSON (whole panel state)
- `update_setting(key, value)` → coarse setter; Rust dispatches per-key side effects (model swap, hotkey rebind, etc.)
- `set_voice(voice)`, `download_voice_model(voice)` — voice picker
- `add_custom_voice(piperId)`, `list_voices()` — user-added Piper voices
- `set_stt_model(id)`, `download_stt_model(id)` — STT picker
- `set_summarizer_model(id)`, `download_summarizer_model(id)` — summarizer picker
- `download_all_models()` — bulk download for first-launch nag
- `play_sound(name)` — preview button in Sounds section
- `set_settings_open(bool)` — tells Rust to grant cursor events to the overlay window

Events emitted by Rust that the panel listens to:
- `voice-download-{start,progress,complete,error}` `{ id, percent? }`
- `stt-download-progress` `{ model, status }`
- `summarizer-download-progress` `{ model, status }`
- `model-download-progress` `{ model, status }` (from `download_all_models`)
- `stt-active` `{ active }` — push-to-talk hotkey held/released
- `tts-escape` — closes the panel (mirrors the global ESC handler)
