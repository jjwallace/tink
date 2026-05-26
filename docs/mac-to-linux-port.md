# Native Overlay App: macOS to Linux Porting Report

## Current State: macOS-Only

The app is deeply macOS-specific. The audio/ML stack would likely compile on Linux, but the window management and input capture layers are entirely Apple APIs.

## Onboarding (macOS)

One command: `bun run setup` installs Rust, Bun, Xcode CLT, and downloads ~1-2GB of voice/STT/LLM models. Then `bun run tauri dev` to run.

## What Needs Porting

### 1. Window Overlay (Hard)

**Current:** NSWindow via objc2 — transparent fullscreen overlay at z-level 25, covers menu bar, `CanJoinAllSpaces`, `IgnoresCycle`, click-through via `setIgnoreCursorEvents`.

**File:** `src-tauri/src/lib.rs` lines 1024-1073

**Linux equivalent:**
- X11: `_NET_WM_WINDOW_TYPE_DOCK` or `_NET_WM_STATE_ABOVE` + `XShapeCombineRectangles` for input passthrough
- Wayland: Layer shell protocol (`zwlr_layer_shell_v1`) — not all compositors support it
- Likely need both X11 and Wayland paths, or use gtk-layer-shell

### 2. Global Input Capture (Hard)

**Current:** `CGEventTapCreate` captures middle-click, drag, shift taps, and keyboard events globally even when app is not focused.

**File:** `src-tauri/src/lib.rs` lines 87-227 (callback), 1150-1181 (setup)

**Linux equivalent:**
- X11: `XGrabKey` / `XRecord` extension — fragile, breaks in Wayland
- Wayland: No standard protocol for global input capture (security model forbids it)
- evdev: `/dev/input/event*` — works but requires input group permissions
- libinput: Higher-level, but still needs elevated permissions
- Best bet: evdev with a polkit helper or input group membership

### 3. Mouse Position (Medium)

**Current:** `CGEventCreate` + `CGEventGetLocation` for absolute mouse coordinates.

**File:** `src-tauri/src/lib.rs` lines 664-677

**Linux equivalent:**
- X11: `XQueryPointer`
- Wayland: No standard API (compositor-specific)
- Could use `ydotool` or read from evdev

### 4. Multi-Screen Positioning (Medium)

**Current:** Enumerates `NSScreen::screens()` to find which display has the mouse, then `setFrame_display` to cover that screen.

**File:** `src-tauri/src/lib.rs` lines 1037-1053

**Linux equivalent:**
- X11: `XRRGetScreenResources` / Xinerama
- Wayland: `wl_output` events give monitor geometry
- Tauri 2 may abstract some of this

### 5. Audio Stack (Easy)

**Current:** rodio (playback), cpal (capture) — both cross-platform.

**Status:** Should compile on Linux with ALSA/PulseAudio/PipeWire. May need `libasound2-dev` or `libpulse-dev` packages.

### 6. ML Models (Easy)

**Current:** sherpa-rs (TTS/STT via ONNX Runtime), llama-cpp-2 (LLM via llama.cpp).

**Status:** Both support Linux. sherpa-rs needs ONNX Runtime (ships prebuilt). llama-cpp-2 needs cmake + a C++ compiler. GPU acceleration via CUDA instead of Metal.

### 7. Build System (Easy)

**Current:** Bun + Cargo + Tauri CLI.

**Status:** All work on Linux. Replace `setup.sh` macOS checks (Xcode CLT) with Linux equivalents (`build-essential`, `libwebkit2gtk-4.1-dev`, `libssl-dev`, etc.).

## What Works As-Is

| Component | Cross-platform? |
|-----------|----------------|
| SolidJS frontend | Yes |
| Pixi.js / Canvas VFX | Yes |
| GSAP animations | Yes |
| D3 charts | Yes |
| Howler.js audio | Yes |
| Tauri IPC / events | Yes |
| rodio / cpal audio | Yes (needs ALSA/Pulse) |
| sherpa-rs TTS/STT | Yes (ONNX Runtime) |
| llama-cpp-2 LLM | Yes (cmake needed) |
| Settings persistence | Yes (serde_json) |
| HTTP speak server | Yes (TCP) |

## What Doesn't

| Component | macOS API | Linux Replacement | Effort |
|-----------|-----------|-------------------|--------|
| Transparent overlay | NSWindow + objc2 | X11/Wayland layer shell | High |
| Click-through | `setIgnoreCursorEvents` | X11 shape extension / Wayland input region | High |
| Global hotkeys | CGEventTap | evdev / XGrabKey | Medium-High |
| Mouse position | CGEvent | XQueryPointer / evdev | Medium |
| Multi-screen | NSScreen | XRandR / wl_output | Medium |
| Menu bar tray | Tauri tray (works) | Tauri tray (works) | Low |
| GPU particles | Metal (via Pixi WebGL) | WebGL (works) | None |

## Estimated Effort

**~2-3 weeks** for a Linux port by someone familiar with X11/Wayland:
- Week 1: Window overlay + click-through on X11
- Week 2: Global input capture via evdev, mouse tracking, multi-screen
- Week 3: Testing, Wayland path, packaging (AppImage/Flatpak)

## Runtime Downloads

| Asset | Size | Downloaded |
|-------|------|-----------|
| TTS voices (Lessac, VCTK) | ~300MB each | setup script |
| STT (Zipformer/Parakeet) | 340MB-1.2GB | setup script / in-app |
| LLM summarizer (SmolLM2) | 105MB-1GB | first launch |

## Release Build

```bash
# macOS
bun run tauri build    # produces .app in target/release/bundle/macos/

# Linux (once ported)
bun run tauri build    # would produce .deb/.AppImage in target/release/bundle/
```

No CI/CD pipeline exists — releases are manual. No code signing configured.
