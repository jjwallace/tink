<div align="center">

<img src="assets/tink-zoomed-polished.png" alt="Tink" width="320" />

# Tink

### A voice + overlay companion for Claude Code.

Transparent desktop overlay. Reacts to your AI coding session — speaks responses aloud,
visualizes activity, and acts as a companion at the edge of your screen.

<br/>

[![Download for macOS](https://img.shields.io/badge/Download-macOS%20DMG-blue?style=for-the-badge&logo=apple)](https://github.com/jjwallace/tink/releases/latest)
[![Visit Site](https://img.shields.io/badge/Site-jjwallace.github.io%2Ftink--site-purple?style=for-the-badge)](https://jjwallace.github.io/tink-site/)
[![Release](https://img.shields.io/github/v/release/jjwallace/tink?style=for-the-badge)](https://github.com/jjwallace/tink/releases/latest)

<br/>

<table>
  <tr>
    <td align="center"><img src="assets/tink-plain.png" width="220" alt="Idle" /><br/><sub><b>Idle</b></sub></td>
    <td align="center"><img src="assets/tink-zoomed.png" width="220" alt="Focused" /><br/><sub><b>Focused</b></sub></td>
    <td align="center"><img src="assets/tink-falling.png" width="220" alt="Reactive" /><br/><sub><b>Reactive</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/tink-concept-too-shiney.png" width="220" alt="Concept" /><br/><sub><b>Concept</b></sub></td>
    <td align="center"><img src="assets/tink-crashed.png" width="220" alt="On error" /><br/><sub><b>On error</b></sub></td>
    <td align="center"><img src="assets/tink-concept-steal-bras.png" width="220" alt="Off-task" /><br/><sub><b>Off-task</b></sub></td>
  </tr>
</table>

<br/>

</div>

---

## What it does

- **Speaks** responses aloud via local TTS (sherpa-onnx + Piper voices)
- **Listens** for push-to-talk dictation via local STT (sherpa-onnx)
- **Reacts** with a Pixi-rendered creature that responds to your AI's lifecycle
- **Anchors** itself wherever you drop it — drag the voice anchor around your screen
- **Summarizes** long responses with an embedded SmolLM2 model
- Integrates with Claude Code via lifecycle hooks (`UserPromptSubmit`, `Stop`, etc.)

## Install (recommended)

1. Download the [latest DMG](https://github.com/jjwallace/tink/releases/latest/download/Tink.dmg)
2. Drag **Tink** to your Applications folder
3. First launch: grant **Accessibility** and **Microphone** permissions when prompted
   (System Settings → Privacy & Security)

That's it. The app downloads voice models on first run (~600 MB) to
`~/Library/Application Support/com.wolfgames.native/models/`.

## Build from source

```bash
git clone https://github.com/jjwallace/tink
cd tink
./setup.sh                  # downloads voice models, installs deps
bun run tauri dev
```

Requires: [Bun](https://bun.sh), [Rust](https://rustup.rs).

No special access needed — the creature logic ships as a prebuilt
static library in `src-tauri/vendor/<target>/libcreature_core.a`.

## What's inside

| Folder | What it is |
|---|---|
| [`src/`](src/) | SolidJS frontend — overlay UI, settings panel, dashboards |
| [`src-tauri/`](src-tauri/) | Rust backend — TTS, STT, summarizer, hooks integration |
| [`voice-core/`](voice-core/) | Shared Rust crate — STT/TTS engines + EventSink |
| [`src-tauri/vendor/`](src-tauri/vendor/) | Prebuilt `libcreature_core.a` per target |
| [`docs/`](docs/) | Architecture and design notes |

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Tauri Window (transparent, fullscreen overlay)  │
│                                                 │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ SolidJS UI   │  │ Pixi + Canvas 2D layers │  │
│  │ - Settings   │  │ - Creature              │  │
│  │ - Speech UI  │  │ - Sine waves            │  │
│  │ - Voice Anchr│  │ - Particles, VFX        │  │
│  └──────────────┘  └─────────────────────────┘  │
│                                                 │
│  ┌─────────────────────────────────────────┐    │
│  │ Rust Backend                            │    │
│  │ - TTS (sherpa-rs/VITS)                  │    │
│  │ - STT (sherpa-rs/Zipformer)             │    │
│  │ - Summarizer (llama-cpp-2/SmolLM2)      │    │
│  │ - Creature runtime (linked from .a)     │    │
│  │ - macOS event tap (global hotkeys)      │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Hooks

Tink integrates with Claude Code via shell hooks at `~/.claude/hooks/`.
The narrator hook converts assistant responses → TTS; the start-sound
hook fires on prompt submit. See [docs/](docs/) for the full hook map.

## License

MIT for the source in this repo. The `@jjwallace/creature` npm
package and the `libcreature_core.a` static library consumed at build
time are proprietary and distributed as built artifacts only.
