# Architecture

Native is a Tauri 2 + SolidJS desktop overlay app with TTS, visualization, and VFX capabilities.

## Stack

- **Backend**: Rust (Tauri 2) with sherpa-onnx for TTS, rodio for audio, objc2 for macOS APIs
- **Frontend**: SolidJS + TypeScript + GSAP + D3.js
- **Build**: Vite (frontend), Cargo (Rust)

## Rust Modules

| Module | Purpose |
|--------|---------|
| `lib.rs` | App setup, tray menu, commands, CGEvent tap, global shortcuts |
| `tts.rs` | TTS engine, voice management, model download, sentence splitting, markdown stripping |
| `settings.rs` | Persisted settings (voice, shortcut, display mode, auto-speak) |
| `speak_server.rs` | HTTP server on :9876 for receiving text to speak |
| `file_watcher.rs` | Polls git status, emits viz events on changes |
| `folder_viz.rs` | Directory scanner with git status, returns tree for D3 |

## Frontend Components

| File | Purpose |
|------|---------|
| `App.tsx` | Root component, wires all systems together |
| `paragraph-reader.ts` | Unified TTS display (bubbles, scroll, paragraph modes) |
| `word-scroller.ts` | Original arched word scroller (preserved, not active) |
| `selection-hint.ts` | "Press PageDown to dictate" bubble on text selection |
| `folder-viz.ts` | D3 folder tree cards with corner placement |
| `fire.ts`, `bubbles.ts`, `bubble-trail.ts` | VFX overlay effects |

## Event Flow

```
User action (hotkey/middle-click/tray)
    → Rust: grab text, strip markdown, split sentences
    → Emit tts-open (frontend shows UI immediately)
    → For each sentence:
        → Rust: generate TTS audio
        → Emit tts-sentence (frontend animates words)
        → Play audio via rodio
        → Wait for completion, check cancel flag
    → Emit tts-done
```

## Global Input Handling

A CGEvent tap monitors system-wide:
- **Middle mouse click** → speak selection
- **Left mouse drag + release** → show selection hint
- **Escape key** → stop TTS, close all UI

## Settings Persistence

All settings stored in `~/Library/Application Support/com.wolfgames.native/settings.json`:
- `shortcut`: hotkey string (e.g. "PageDown")
- `voice`: "lessac-fast" or "vctk"
- `display`: "bubbles", "scroll", or "paragraph"
- `auto_speak`: boolean for Claude auto-speak and file watcher
