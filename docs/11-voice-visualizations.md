# Voice Visualizations (wave-* variants)

The active TTS sine-wave visualization is a single swappable class behind an alias import. Several alternate aesthetics are parked alongside the active one — swap by changing one line in [`src/App.tsx`](../src/App.tsx).

## The family

| File | Class | Approach |
|---|---|---|
| `sine-waves.ts` | `SineWaves` | Pure sine w/ freq/amp voice modulation. **Currently active.** |
| `wave-watcher.ts` | `WaveWatcher` | Amplitude-history ring buffer, drawn as two mirrored polylines. |
| `wave-ribbon.ts` | `WaveRibbon` | Same data as wave-watcher, rendered as a Bezier-smoothed filled ribbon. |
| `wave-dancer.ts` | `WaveDancer` | Sine + simplex-noise phase/amp jitter, with optional particle stream. |
| `wave-shaper.ts` | `WaveShaper` | Sine run through a tanh waveshaper + asymmetry bias. |
| `wave-carrier.ts` | `WaveCarrier` | Two layers with per-layer `ampResponse`/`freqResponse` (pitched carrier + consonant shimmer). Also supports a traveling-compression-zone phase field. |

All variants expose the same public surface (`init`, `setAnchor`, `setAnchorPosProvider`, `destroy`) so swapping is a one-line import change.

## Swapping

[`src/App.tsx`](../src/App.tsx#L12) aliases on import so the rest of the file doesn't need to change:

```ts
// Current (active):
import { SineWaves } from "./features/speech/sine-waves";

// Swap example:
import { WaveRibbon as SineWaves } from "./features/speech/wave-ribbon";
```

## How voice reactivity works (shared pipeline)

Regardless of which variant is active, the reactivity pipeline is:

1. **Rust emits `tts-amplitude`** every ~50ms during playback with the per-window peak normalized to the sentence peak (0..1). See [`tts.rs::spawn_amplitude_emitter`](../src-tauri/src/tts.rs).
2. **Frontend listener** in each variant maps `level` → internal modulation state (`ampScale` / `freqScale` in the sine variants, or a target amplitude value in the history variants).
3. Each variant's render loop uses that state when drawing per frame.

`tts-amplitude` fires only for narrator TTS (`do_speak_text`, `do_speak_selection`). `speak_brief` (ship-computer / drunken-sailor acks) deliberately does NOT emit it — those short chirps stay silent event-wise so the wave doesn't pulse for them.

## Event contract

Every variant listens to the same four events:

- `tts-open` → fade in, reset internal modulation state
- `tts-amplitude` → per-frame modulation updates
- `tts-done` → staged fade out
- `tts-escape` → immediate collapse (STT key-down, ESC)
- `stt-active` (payload `{active: boolean}`) → when `active: true`, same as `tts-escape`

## Shared features

All variants support:

- **Anchor position provider** via `setAnchorPosProvider(fn)` — sine/history position tracks the live anchor (drag, throw, bob). Wired in [App.tsx](../src/App.tsx) via `voiceAnchor.renderedCenter()`.
- **Per-wave `alpha`** (sine variants only) — optional opacity multiplier on each `WaveConfig` entry. Faint background layers without affecting other layers' opacity.
- **Per-wave `strokeColor`** (sine variants only) — optional CSS color string. Falls back to `config.color` if unset. Used so the tight top wave can stroke in a whiter hue while slower layers stroke pinker; the shadow glow stays unified.

## Adding a new variant

1. Copy the variant closest to what you want (`cp wave-dancer.ts wave-mything.ts`)
2. Rename the class + config types (`sed -i '' 's/WaveDancer/WaveMything/g; s/WaveDancerConfig/WaveMythingConfig/g; s/defaultWaveDancerConfig/defaultWaveMythingConfig/g' wave-mything.ts`)
3. Modify `drawWave` / `drawAmplitudeHistory` / etc. as needed
4. Keep the event listeners (`tts-open`, `tts-amplitude`, `tts-done`, `tts-escape`, `stt-active`) so interrupt handling stays consistent
5. Swap the import in App.tsx to test

## Direction invariant (sine variants)

Three stacked guards prevent the wave from ever traveling leftward:
1. `Math.abs(speed)` in drawWave
2. Leading minus on `(time * speed)` phase term
3. `this.time += 0.008` monotonic in render loop

All three must stay. See [`sine-waves.ts` drawWave comment](../src/features/speech/sine-waves.ts) for the full rationale.

## Common tuning knobs

For any sine-based variant (sine-waves, wave-dancer, wave-shaper, wave-carrier):

- **`speed`** (in default config) — horizontal travel rate
- **`waves[i].amplitude`** — per-layer base height
- **`waves[i].wavelength`** — per-layer spatial period
- **`ampTarget` formula in tts-amplitude listener** — how voice amplitude maps to wave height
- **`freqTarget` formula in tts-amplitude listener** — how voice maps to frequency compression
- **Tween durations** (0.45s sine.inOut is the current default) — responsiveness

For history-based variants (wave-watcher, wave-ribbon):

- **`HIST_SIZE`** — how many frames of amplitude history are displayed
- **Alpha smoothing coefficients** (rising / falling alpha in render loop) — mic-meter envelope

## Related

- [`src/features/ambient-vfx/particles.ts`](../src/features/ambient-vfx/particles.ts) — shared pool that `sine-waves` (and `wave-dancer`) emit into for the sparkly pixel glints
- [`src/features/speech/paragraph-reader.ts`](../src/features/speech/paragraph-reader.ts) — another TTS listener, word-timing display
- [`src/App.tsx`](../src/App.tsx) — all event-wiring between variants, anchor, creature lives here
