# Native — Size & Components Report (2026-04-20)

Snapshot of the native app's disk footprint, shipped artifacts, and component inventory.

## Total sizes

**Shipped app (estimated DMG)**: ~40–60 MB
- Debug binary at time of snapshot: 34 MB (release expected similar or smaller)
- Frontend dist: 9.4 MB
- Bundled sfx + vfx assets: 9 MB

**After first run, on user's disk**: ~1.3–1.4 GB
- App itself: ~50 MB
- Models downloaded to `~/Library/Application Support/com.wolfgames.native/models/`: **1.3 GB** (7 models: 3 TTS voices + 2 STT + 2 summarizer LLMs)

**Max possible model footprint** (all summarizer options incl. SmolLM2-1.7B + Qwen-0.5B): ~2.9 GB

**First-party source code**: ~10,600 LOC (3,158 Rust + 7,463 TS/TSX)

**Dev machine total** (including build artifacts): ~9 GB — mostly `target/debug` scratch (7.7 GB), not shipped.

## Compiled binary / bundle

| Artifact | Size | Notes |
|---|---|---|
| Debug binary (`target/debug/native`) | 34 MB | Unoptimized, with debuginfo |
| Release binary | (not built at snapshot) | Typically 20–40 MB |
| Frontend dist | 9.4 MB | SolidJS + Pixi bundle |
| Public assets (sfx + vfx) | 9.0 MB | Bundled into the app |
| `target/debug` scratch | 7.7 GB | Build artifacts only |
| `target/release` scratch | 1.3 GB | Build artifacts only (no binary) |

Models are **not** bundled — they download at first use.

## AI models (runtime download → `~/Library/Application Support/com.wolfgames.native/models/`)

| Model | Role | Size |
|---|---|---|
| vits-piper-lessac-low | TTS (fast) | 78 MB |
| vits-piper-lessac-high | TTS (hi-fi) | 127 MB |
| vits-piper-vctk-medium | TTS (British) | 92 MB |
| sherpa-onnx-zipformer-en | STT | 319 MB |
| sherpa-onnx-streaming-zipformer-en | STT (streaming) | 320 MB |
| SmolLM2-135M Q4 | Summarizer (smallest) | 101 MB |
| SmolLM2-360M Q4 | Summarizer (default) | 258 MB |
| SmolLM2-1.7B Q4 | Summarizer (strongest) | ~1.1 GB if downloaded |
| Qwen2.5-0.5B Q4 | Summarizer (alt) | ~491 MB if downloaded |
| **Total on disk at snapshot** | | **1.3 GB** |

## Source codebase

| Layer | Files | LOC |
|---|---|---|
| Rust (`src-tauri/src`) | 10 | 3,158 |
| TS / TSX (`src`) | ~24 | 7,463 |
| **Total first-party code** | | **~10,600** |
| `node_modules` | — | 187 MB |

### Rust modules (src-tauri/src)
- `lib.rs` — 1,277 LOC — window setup, tray, shortcuts, all Tauri commands, TTS pipeline
- `tts.rs` — 496 LOC — VITS (sherpa-rs) w/ word timing
- `stt.rs` — 380 LOC — Zipformer / Parakeet offline ASR
- `summarizer.rs` — 272 LOC — llama-cpp-2 + SmolLM2 / Qwen
- `speak_server.rs` — 216 LOC — HTTP server on :9877
- `folder_viz.rs` — 197 LOC
- `settings.rs` — 159 LOC — persisted settings
- `file_watcher.rs` — 112 LOC
- `sfx.rs` — 43 LOC — rodio (legacy)
- `main.rs` — 6 LOC

### Frontend (src)
- `SettingsPanel.tsx` — 1,157 LOC
- `App.tsx` — wiring
- `chart-column.ts` — 636 LOC
- `folder-viz.ts` — 398 LOC
- `fire.ts` — 306 LOC
- `bubbles.ts` — 248 LOC
- `vfx/flow-particles.ts`, `vfx/pixel-particles.ts`, `vfx/sine-waves.ts`, `vfx/edge-flash.ts` — ~900 LOC combined
- Plus: `sounds.ts`, `paragraph-reader.ts`, `stt-display.ts`, `plan-viz.ts`, `bubble-trail.ts`, `pixi-app.ts`, `selection-hint.ts`

### Rust dependency highlights
- **tauri 2** + tray-icon, macos-private-api
- **sherpa-rs 0.6** (TTS + STT) → bundles sherpa-onnx native lib
- **llama-cpp-2 0.1** (LLM inference)
- **rodio 0.19** + **cpal 0.15** (audio)
- **objc2** / **objc2-app-kit** / **objc2-foundation** (NSWindow, multi-screen)
- **tauri-plugin-global-shortcut** (PageDown push-to-talk)

### Frontend dependency highlights
- **pixi.js** (76 MB in node_modules — largest dep)
- **SolidJS** + Vite
- **Howler.js** (sound playback)
- **gsap** (animations)
