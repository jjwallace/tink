# Native

A transparent desktop overlay app with text-to-speech, D3 folder visualization, and VFX effects. Built with Tauri 2 + SolidJS + TypeScript.

Select text anywhere, hear it read aloud. Watch folder changes animate on screen. Get spoken summaries as you work.

## Get Started

```bash
./setup.sh
```

That's it. The script checks for prerequisites (Rust, Bun, Xcode CLT), installs anything missing, pulls project dependencies, and downloads the two default voice models (~75MB each):

- **VCTK** — British English
- **Lessac** — American English (high quality)

Then run the app:

```bash
bun run tauri dev
```

First build compiles Rust and takes a few minutes. After that, hot reload is fast.

### Grant Permissions

On first launch, grant macOS Accessibility permissions for global hotkeys and text selection:

**System Settings > Privacy & Security > Accessibility > enable Native**

### Try It

1. Select any text on your screen
2. Press **Page Down** (or middle-click)
3. Hear the text read aloud with animated word highlighting

<details>
<summary>Manual setup (if you prefer)</summary>

```bash
# 1. Prerequisites
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash

# 2. Dependencies
bun install

# 3. Voice models
./setup-models.sh

# 4. Run
bun run tauri dev
```

</details>

## Features

### Text-to-Speech

- **Offline TTS** using sherpa-onnx with Piper VITS voice models
- **Three display modes**: Bubbles (floating sentences), Scroll (teleprompter ribbon), Paragraph (dark panel)
- **Sentence pipelining**: first sentence plays immediately while later ones generate in background
- **Markdown stripping**: bold, code blocks, links, headings all cleaned before speaking
- **Escape to stop**: press Escape anywhere to cancel speech and close all UI

### Voice Input (Speech-to-Text)

- **Hold Page Up** to start voice input — speak and watch words fly onto the screen in real-time
- **Release Page Up** to stop — the transcribed text is automatically pasted into the focused text field
- Uses sherpa-onnx streaming Zipformer model (~12MB, fully offline)
- Words animate in from random off-screen positions and assemble into a sentence at the top of the viewport
- Waveform indicator pulses while you speak

### Triggers

| Trigger | Action |
|---------|--------|
| **Page Down** | Speak selected text (configurable hotkey) |
| **Page Up (hold)** | Voice input — speak to type |
| **Middle Click** | Speak selected text |
| **Tray > Speak Selection** | Speak selected text |
| **Selection hint** | A bubble appears near your cursor after selecting text showing the hotkey |

### Folder Visualization

- **D3-powered folder tree** overlaid on your screen
- **Git status coloring**: green (new), amber (modified), red (deleted)
- **Animated tree opening**: folders expand along the path to changed files
- **File flash**: new files slide in with a colored glow effect
- **Delete animation**: removed files show red strikethrough then collapse away
- **File watcher**: polls git status every 3 seconds, auto-shows viz when files change
- **Speech narration**: announces what changed

### Dashboard Charts

Four mini charts appear on the left side during active sessions:

1. **Plan Progress** (donut gauge) — tracks task completion percentage
2. **File Activity** (bar chart) — added/modified/deleted file counts
3. **Session Timeline** (sparkline) — activity density over time
4. **Speech Meter** (radial) — sentences spoken and word count

### Auto-Speak (Claude Code Integration)

When working with Claude Code, responses can be automatically summarized and spoken aloud.

1. Enable **Auto-Speak (Claude)** in the tray menu
2. Set your Anthropic API key in `~/.claude/hooks/.env` for AI summaries (optional)
3. Configure the hook in `~/.claude/settings.json` (see docs/03-claude-hooks.md)

The app runs an HTTP server on `localhost:9876`:
- `POST /speak` — send text to be spoken
- `POST /viz` — trigger folder visualization for a path
- `GET /status` — check if auto-speak is enabled

### VFX Overlay

- **Fire particles** — cursor-following fire effect
- **Bubble pops** — random or shift-triggered bubble animations
- **Bubble trail** — hold Shift to leave a trail of bubbles
- **Tweakpane** — live parameter tuning for all effects

## Tray Menu

| Item | Description |
|------|-------------|
| **Speak Selection** | Read selected text aloud |
| **Auto-Speak (Claude)** | Toggle automatic speech for Claude Code responses |
| **Settings > Voice** | Lessac (American) or VCTK (British) |
| **Settings > Shortcut** | Page Down, Cmd+Shift+R, F5, etc. |
| **Settings > Display** | Bubbles, Scroll, or Paragraph mode |
| **Toggle Fire / Bubbles** | VFX controls |
| **Tweak Controls** | Open parameter panel |
| **Show Folder Tree** | Visualize current directory |
| **Quit** | Exit the app |

## Architecture

| Rust Module | Purpose |
|-------------|---------|
| `lib.rs` | App setup, tray, commands, CGEvent tap, shortcuts |
| `tts.rs` | TTS engine, voices, sentence splitting, markdown strip |
| `settings.rs` | Persisted settings (voice, shortcut, display, auto-speak) |
| `speak_server.rs` | HTTP server on :9876 |
| `file_watcher.rs` | Git status polling, change detection |
| `folder_viz.rs` | Directory scanner with git status |

| Frontend | Purpose |
|----------|---------|
| `paragraph-reader.ts` | All 3 TTS display modes |
| `folder-viz.ts` | D3 animated folder tree |
| `chart-column.ts` | Dashboard mini charts |
| `selection-hint.ts` | Hotkey hint bubble |
| `word-scroller.ts` | Original arched scroller (preserved) |

## Build for Distribution

```bash
bun run tauri build
```

Produces a `.dmg` / `.app` in `src-tauri/target/release/bundle/`.

## Settings

Stored at `~/Library/Application Support/com.wolfgames.native/settings.json`:

```json
{
  "shortcut": "PageDown",
  "voice": "lessac-fast",
  "display": "bubbles",
  "auto_speak": false
}
```

Voice models stored in the same directory under `models/`.
