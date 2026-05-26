# Speech & Sine Wave Calibration

How the voice pipeline drives the visible sine wave — tunables, signs, what controls what. Read this before changing numbers in [`src/features/speech/sine-waves.ts`](../src/features/speech/sine-waves.ts).

## Pipeline

```
User action / /speak HTTP / auto-speak queue
        │
        ▼
Rust  do_speak_text / do_speak_selection / speak_brief
        │ generate_sentence(text) → (timings, samples, sample_rate)
        │
        │ per-sentence PEAK AMPLITUDE computed in-place:
        │   peak = samples.iter().map(|s| s.abs()).fold(0.0, f32::max).min(1.0)
        │
        ├─► emit "tts-open"        (except speak_brief — deliberately silent)
        ├─► emit "tts-sentence"    { index, words, duration, level }
        │       ▲
        │       └── sine-waves.ts listens here
        │
        ├─► rodio::Sink plays audio
        └─► emit "tts-done"

Frontend sine-waves.ts
  tts-open   → gsap fade opacity 0→1 over 600 ms
  tts-sentence → tween config.speed to target(level), hold until next
  tts-done   → reset speed to base, fade opacity 1→0 over 1.5 s
```

`speak_brief` (anchor mode chirp) skips the `tts-open` / `tts-sentence` / `tts-done` emits entirely, so the sine wave stays dormant for UI confirmation chirps.

## Direction invariant — ALWAYS RIGHTWARD

The wave pattern travels **left → right** (reading direction). Two signs are paired to produce this:

| Place | Sign |
|---|---|
| Render loop | `this.time += 0.008` (positive delta) |
| `drawWave` phase | `-(time * speed) + (i - yAxis) / wavelength` (leading minus on time term) |

**Math proof**: given phase `φ = -(t·s) + (i - y₀)/w`, hold φ constant to track a fixed peak:

```
i = y₀ + (φ + t·s) · w
dI/dt = +s·w
```

`s` and `w` are both always positive → `dI/dt > 0` → peaks march rightward.

**Do not change either sign independently.** Flipping one reverses the direction. If you want to slow the wave, reduce the `+= 0.008` magnitude; don't flip its sign.

## Config: 3 waves, 1× / 1.8× / 3× tempo

```ts
waves: [
  { amplitude:  150, wavelength: 200, lineWidth: 3,   timeModifier: 1,   segmentLength: 20 }, // slow carrier
  { amplitude:  150, wavelength: 100, lineWidth: 2,   timeModifier: 1.8, segmentLength: 10 }, // middle harmonic
  { amplitude: -150, wavelength:  50, lineWidth: 1.5, timeModifier: 3,   segmentLength: 10 }, // tight top
]
```

**`timeModifier`** multiplies the `time` argument passed to each `drawWave` call, so waves with higher modifiers oscillate more cycles per unit time — "octaves," loosely. Full musical octaves (1 / 2 / 4 / 8) read as frantic; 1 / 1.8 / 3 is a gentler ratio that still reads as layered.

**`wavelength`** controls spatial density (cycles per pixel). Smaller = tighter waves. The 50-wavelength top is the most visually "wavy."

**`amplitude`** is in pixels but scaled down by the patch width in `drawWave`. Negative amplitudes just flip vertically — no effect on travel direction.

**`lineWidth`** is in pixels × `dpr`. The carrier (1×) is thickest; the top (3×) is thinnest. Matches how perceived "volume" of a visual layer drops as its frequency rises.

## Speed modulation — mapping voice level to wave tempo

```ts
const shaped = Math.pow(level, 1.35);
const target = baseSpeed * (0.35 + shaped * 0.9);
```

Range: **0.35× ↔ 1.25×** the base speed (18).

| `level` | `shaped` | target × base | behavior |
|---|---|---|---|
| 0.0 | 0.00 | 0.35× | near-idle drift — whispered sentence |
| 0.3 | 0.20 | 0.53× | slow but moving |
| 0.5 | 0.39 | 0.70× | mid-tempo |
| 0.7 | 0.63 | 0.92× | approaching base |
| 1.0 | 1.00 | 1.25× | peak, a bit faster than base |

**Why the power curve (exponent 1.35)** — linear mapping put most observed sentences near the fast end (VITS output tends to peak 0.7-0.9). The `^1.35` curve compresses the low end so more sentences land in the slow half, giving real variety instead of everything being "a little faster than base."

**Hold-don't-pulse** — the speed is tweened toward the target over 0.4 s (sine ease) and HELD there until the next `tts-sentence` arrives. Between sentences the speed doesn't decay back to base — quiet paragraphs stay quiet throughout. Only `tts-done` resets it.

## Anchor-locked patch

The wave draws in a 400 px-wide patch centered on the voice anchor position ([`voice-anchor`](../src/features/voice-anchor/index.ts)). `setAnchor(fx, fy)` (fractions 0-1) slides the patch:

```ts
this.waveWidth = 400 * dpr;
this.waveLeft  = fx * width - waveWidth / 2;
this.yAxis     = fy * height;
```

Outside the patch, the line runs flat at `yAxis`. The gradient (built in `buildGradient`) fades both sides to alpha 0 over the outer 30% of the patch so the wave blends into the flat line cleanly.

## z-index stack

Frontend overlay layers from back to front:

| z | feature |
|---|---|
| 99996 | *nothing now — freed by the sine-wave move* |
| 99997 | **sine-waves** canvas, creature (pixi) |
| 99998 | flow-particles canvas, voice-anchor root |
| 99999 | paragraph-reader, edge-flash |
| 100000 | stt-display |
| 100001 | settings overlay |

The wave sits above flow-particles so triangles don't mask it, below paragraph-reader so text stays readable.

## Tunables quick reference

| What to change | Where |
|---|---|
| Base wave tempo | `config.speed` (default 18) + the `+= 0.008` delta |
| Travel direction | **don't** — locked by the sign invariant (see above) |
| How much volume affects tempo | `0.35 + shaped * 0.9` in the `tts-sentence` listener — widen or narrow this range |
| How quickly tempo reacts | `duration: 0.4` on the gsap tween |
| Number of waves / their ratios | `defaultSineConfig.waves[]` |
| Width of the visible patch | `this.waveWidth = 400 * dpr` in `recomputePosition` |
| Fade-in / fade-out on TTS | `tts-open` and `tts-done` listeners — gsap.to(this, {opacity, duration}) |
| Peak amplitude computation | Rust: `samples.iter().map(abs).fold(max).min(1.0)` in lib.rs |

## Known limitations

- The voice level is a **single peak per sentence**, not a per-sample envelope. Speed jumps between sentences, not within one. A true envelope would need Rust to emit a downsampled amplitude array (~20 points per sentence) which the frontend would interpolate during playback — maybe 50 lines, not done.
- The speed tween `killTweensOf(config, "speed")` wipes the in-flight tween on every new sentence, so rapid-fire sentences can feel jittery for a frame. Fine in practice; only noticeable with unrealistic back-to-back emits.
- `speak_brief` (mode chirp) doesn't emit `tts-sentence` either, so even though it plays through the VITS pipeline, the wave doesn't pulse for it. Intentional — chirps shouldn't kick off a wave show.
