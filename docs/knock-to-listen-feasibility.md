# Knock-to-Listen Feasibility

**Question:** Can we use a "knock sensor" on a Mac — physically tapping/knocking the laptop
body — to trigger an action (start voice listening) in Tink, instead of (or alongside) the
existing push-to-talk global hotkey?

**Short answer:** **Yes.** Two independent, real paths exist on modern Apple Silicon MacBooks:

1. **The hidden SPU accelerometer** (`AppleSPUHIDDevice`, IOKit HID) — the genuine "knock
   sensor." Confirmed present on the dev machine. This is what the shipping app **Knock**
   (tryknock.app) and the open-source **nocnoc** already use for exactly this feature.
2. **Microphone-based transient/impact detection** — no special sensor, works on any Mac,
   reuses the audio stack Tink already has (`cpal`).

The classic **Sudden Motion Sensor is gone**, Core Motion **does not work on Mac**, and
Force Touch **cannot sense a chassis knock**. Details and a recommendation below.

> Verified on the dev machine (`MacBookPro18,1`, Apple M1 Pro, Darwin 24.6 / macOS 15):
> legacy accelerometer IOKit classes return **0 matches**; `AppleSPUHIDDevice` at usage
> page `0xFF00`, usage `3` (accel) and usage `9` (gyro) is **present, matched, active**
> (VendorID 1452 = Apple, ProductID 33028).

---

## 1. Sudden Motion Sensor (SMS) — DEPRECATED / GONE

| | |
|---|---|
| **Available?** | **No** (as the classic SMS). The IOKit classes are retired. |
| **API/framework** | Legacy `SMCMotionSensor` / `AppleSMCMotionSensor` via `AppleSMC` (used by `SMSLib`, `unimotion`, `AMSSMotionSensor`) |
| **Apple Silicon** | Classes do not exist. See below for the *replacement*. |

The Sudden Motion Sensor existed to park spinning-HDD heads on impact. The last MacBook with
an HDD shipped in 2012; once notebooks went all-SSD the purpose vanished and the classic SMS
interface went with it.

Probing this exact dev machine confirms it:

```
SMCMotionSensor: 0   AppleSMCMotionSensor: 0   IOAccelerometer: 0   AppleAccelerometer: 0
```

Any code querying those classes on Apple Silicon will correctly report "not present." **But
the hardware IMU did not disappear** — it moved (see §1b).

### 1b. The replacement: the hidden SPU accelerometer — AVAILABLE ✅

Apple Silicon MacBooks still contain a physical MEMS IMU (accelerometer + gyroscope,
believed Bosch BMI286), now managed by the **Sensor Processing Unit (SPU)** and exposed
through **IOKit HID** — not SMC, not Core Motion. This was reverse-engineered publicly in
2024–2025 (`olvvier/apple-silicon-accelerometer`, the `macimu` Python package).

| | |
|---|---|
| **Available?** | **Yes** on this class of machine (confirmed on the dev Mac) |
| **API/framework** | IOKit HID (`IOHIDManager`/`IOHIDDevice`) matching `AppleSPUHIDDevice` |
| **Matching keys** | `PrimaryUsagePage = 0xFF00` (65280), `PrimaryUsage = 3` for accelerometer (`9` = gyro) |
| **Data format** | 22-byte HID input reports; X/Y/Z as **int32 LE at byte offsets 6, 10, 14**; value ÷ 65536 → g |
| **Sample rate** | ~800 Hz native, commonly decimated to ~100 Hz (plenty for knock detection) |
| **Apple Silicon** | M1 Pro/Max (14"/16", `MacBookPro18,x`), M2/M3/M4 MacBook Pro & Air. **The 2-port M1 13" (`MacBookPro17,1`) reportedly lacks it**; some Mac Studio/desktop variants differ. Always probe at runtime. |
| **Privileges** | Nuanced — see below |
| **Difficulty / reliability** | Medium to build, **high reliability** once tuned (this is a purpose-built motion sensor) |

**Privilege caveat (important, and slightly contradictory in the wild):** the `macimu`
Python project states it needs **root/`sudo`** to open the device. Yet the shipping **Knock**
app and open-source **nocnoc** (Swift) run as normal user apps, asking only for Accessibility
permission (to *synthesize* the resulting keystroke, not to read the sensor). The likely
distinction: opening the HID device *seized/exclusively* needs elevated rights, whereas
registering an **input-report callback** in shared/non-exclusive mode can work unprivileged.
This must be validated on our target OS during a spike — it is the single biggest open risk
for a notarized, sandbox-friendly distribution.

**Rust integration:** IOKit HID is C FFI. Options, easiest first:
- **`hidapi`** crate — enumerate `device_list()`, filter VID/usage, `open()`, `read_timeout()`. Handles the run-loop threading internally. Note it may not expose the SPU device's non-USB transport cleanly; test.
- **`iohidmanager`** crate — safe IOKit HID bindings with async input-report streams (spawns its own `CFRunLoop` thread). Best fit for matching on usage page `0xFF00`/usage `3` and taking input-report callbacks.
- **`io-kit-sys`** — raw FFI; full control, most work. Tink already hand-writes CoreFoundation/CGEvent FFI in `hotkeys.rs`, so this is within the codebase's established style if the wrapper crates fall short.

The run-loop model matches what `hotkeys.rs` already does for the CGEvent tap: a dedicated
detached thread runs a `CFRunLoop`, IOKit delivers 22-byte reports to a callback on that
thread, the callback does cheap math + atomics only.

---

## 2. CMMotionManager / Core Motion — NOT USABLE on Mac

| | |
|---|---|
| **Available?** | **No** at runtime on Mac (compiles, returns nothing) |
| **API/framework** | Core Motion `CMMotionManager` |
| **Apple Silicon** | Framework present in SDK for Mac Catalyst; hardware not wired to it |

Core Motion's platform badge lists macOS/Mac Catalyst, but Apple's own docs describe it as
reading hardware only on **iOS/iPadOS/watchOS/visionOS** — macOS is conspicuously absent from
that list. On a Mac, `isAccelerometerAvailable` returns **false** and the useful APIs are
`API_UNAVAILABLE` or return nothing. The compile-time availability exists purely to let Mac
Catalyst apps build. This is *not* a path to the SPU IMU — that only comes via IOKit HID (§1b).

The common "Core Motion on Mac" pattern is a **companion iPhone streaming its sensor over
UDP/BLE** — irrelevant here since we want the Mac's own body.

---

## 3. Microphone-based knock detection — VIABLE, no special sensor

| | |
|---|---|
| **Available?** | **Yes**, on any Mac with a mic |
| **API/framework** | `AVAudioEngine` (Swift) or **`cpal`** (Rust — already a Tink dependency) |
| **Apple Silicon** | Full support |
| **Privileges** | Microphone permission (Tink already holds this for STT) |
| **Difficulty / reliability** | Low-medium to build; **medium reliability** — tunable, but false-positive prone without care |

A knock/tap is a textbook **acoustic transient**: short duration, high amplitude, fast attack,
broadband spectrum. The built-in mic picks up both the airborne sound and vibration conducted
through the chassis/desk. Detection recipe:

1. **Envelope** — max/RMS amplitude over ~10–12 ms windows on the input stream.
2. **Sharp-rise test** — flag a candidate when a peak exceeds the preceding valley by a
   tunable ratio (≈1.5×). A fast **attack/rise time** is the strongest discriminator between
   a knock and loud-but-slow sounds (speech, music).
3. **Refractory/debounce** — ignore new detections for ~150–300 ms after one fires; count
   knocks within a grouping window to support single/double/triple patterns.
4. **Speech/typing rejection** — optional spectral secondary check (broadband + rapid
   spectral change), plus a **keystroke suppression window** (Knock uses ~500 ms after the
   last keypress). Tink already sees key events in `hotkeys.rs`, so wiring a "recently typed"
   gate is trivial.

**False-positive risks:** a loud clap, a slammed desk, music with strong percussive
transients, or the app's *own* TTS playback (Tink speaks — must gate detection during
playback, which the codebase can already track). Two-knock patterns cut false triggers sharply.

**Integration:** cleanest as an analysis tap on a `cpal` input stream in `voice-core` (or a
small `src-tauri` module), emitting a `knock-detected` event through the same path the hotkey
uses to start listening. No new frameworks, no new permissions.

---

## 4. Trackpad Force Touch / pressure sensor — NOT a knock sensor

| | |
|---|---|
| **Available?** | Pressure API yes; **chassis-knock sensing no** |
| **API/framework** | `NSEventTypePressure` / `NSEventMaskPressure`, `pressureChangeWithEvent:` |
| **Apple Silicon** | Supported |
| **Difficulty / reliability** | Low to read pressure; **does not solve the stated problem** |

Force Touch reports **how hard a finger presses on the trackpad surface** (a Began→Changed→
Ended gesture, force 0–1), and only while a touch is on the trackpad. It cannot detect a tap
or knock on the **body/lid/chassis**, and it requires a finger already on the pad — so it is
not a hands-free "knock the laptop" trigger. Private IOKit keys (`ForceSupported`,
`DefaultMultitouchProperties`) only detect *whether* a Force Touch pad exists; they don't
give impact-on-body events.

A **"tap a pattern on the trackpad"** feature (like MacID's unlock) is possible via normal
trackpad/multitouch events and is Knock's fallback "Trackpad Tap Mode" for machines lacking
the SPU sensor — but it's a fingers-on-trackpad gesture, not a knock on the body. Not
recommended as the primary mechanism for Tink.

---

## 5. Prior art — real apps that already do this

| Project | What it does | Sensor / method | Notes |
|---|---|---|---|
| **Knock** (tryknock.app) | Single/double/triple **knock on the MacBook (or surrounding desk)** → run shortcuts, mute, lock, launch apps, Apple Shortcuts, terminal cmds | **`AppleSPUHIDDevice`** IOKit HID accelerometer (M2+ native tapping); Trackpad Tap Mode + iPhone companion as fallbacks | **Direct precedent for Tink's feature.** Filters to short knock-timed spikes; 500 ms typing-suppression; live waveform "Knock Test" for calibration. |
| **nocnoc** (github.com/shaircast/nocnoc) | Open-source "knock on your MacBook to trigger action" | Same `AppleSPUHIDDevice` IOKit HID path, **Swift 6 / SwiftUI** | M1–M4, macOS 15+. Adjustable threshold, grouping window, cooldown, waveform gain; calibration wizard. Asks Accessibility (for synthesizing keys), **not** documented as needing sudo. |
| **Haptyk** (haptyk.com) | Velocity-sensitive mechanical keyboard sounds from typing force | Same hidden SPU accelerometer | Proves the sensor is sensitive/fast enough for per-keystroke impacts. |
| **macimu / apple-silicon-accelerometer** | Python library exposing accel+gyro | `AppleSPUHIDDevice` IOKit HID | Documents the exact byte layout; states **root required** (contrast with Knock/nocnoc). |
| **Knock (old, 2013) / MacID** | Unlock Mac by **knocking on the iPhone** / tapping a trackpad pattern | **BLE from the phone**, or trackpad multitouch — **NOT the Mac's own sensor** | **Distinction clarified:** the famous "Knock to unlock" relays a tap on the *phone* over Bluetooth. It is unrelated to sensing a knock on the Mac's body. Proximity unlockers (BLEUnlock, Near Lock, ProximityLock) use BLE RSSI, also unrelated. |

The key clarification the question asked for: **"knock to unlock" (2013, BLE) senses the tap
on the iPhone and relays it over Bluetooth — it never read a Mac sensor.** The *new* Knock
(tryknock.app) is the one that genuinely reads the Mac's own accelerometer, and it's the model
to follow.

---

## Comparison summary

| Avenue | Available on Apple Silicon | Reads a real body-knock? | Rust integration | Reliability | Verdict |
|---|---|---|---|---|---|
| 1. Classic SMS | No (retired) | — | — | — | Dead |
| 1b. SPU accelerometer (IOKit HID) | **Yes** (confirmed on dev Mac) | **Yes** | `hidapi` / `iohidmanager` / `io-kit-sys` FFI | High | **Best "true knock"** |
| 2. Core Motion | No (runtime) | No | n/a | — | Not usable |
| 3. Microphone transient | Yes (any Mac) | Yes (acoustically) | `cpal` (already a dep) | Medium (tunable) | **Best portability / lowest effort** |
| 4. Force Touch | Pressure only | No | `objc2` NSEvent | n/a | Wrong tool |
| 5. Prior art | Knock, nocnoc, Haptyk | — | — | — | Proven feasible |

---

## RECOMMENDATION

**Primary: read the SPU accelerometer via IOKit HID (`AppleSPUHIDDevice`, usage page
`0xFF00`, usage `3`).** It is the genuine hardware knock sensor, it is confirmed present and
active on the target dev machine, it has direct precedent in two shipping/open apps doing
*exactly* this feature, and it is a far cleaner signal than audio (no confusion with speech,
music, or Tink's own TTS). It slots naturally into Tink's existing architecture: a dedicated
run-loop thread (mirroring the CGEvent tap in `hotkeys.rs`) reads reports and, on a detected
knock, fires the same "start listening" path the hotkey already triggers.

**Because two OS/hardware risks exist** — (a) does unprivileged input-report reading work
without sudo on our target OS, and (b) some Apple Silicon models lack the device — **the
robust product design is Knock's**: try the SPU sensor first, **fall back to microphone
transient detection** (§3) when the device is absent or can't be opened. The mic path reuses
`cpal`, needs no new permission, and works on every Mac. Shipping both gives universal
coverage; shipping only the mic path is the fastest route to *something* working.

**Do NOT pursue** Core Motion (dead on Mac) or Force Touch (can't sense a body knock).

### Implementation sketch (Rust, in `src-tauri`)

Model it on `hotkeys.rs`: an install-once function spawns a detached thread running a
`CFRunLoop`; the input-report callback stays cheap (math + atomics + thread dispatch) and
routes into the *same* listening-start entry point the STT hotkey uses.

```rust
// src-tauri/src/knock.rs  (feature-gated: cfg(target_os = "macos"))
//
// 1. Probe: enumerate IOHIDManager for AppleSPUHIDDevice matching
//    { PrimaryUsagePage: 0xFF00, PrimaryUsage: 3 }. If none, return
//    Unsupported -> caller enables the mic fallback instead.
//
// 2. Open the accelerometer device (start non-exclusive; if that needs
//    elevation on the target OS, that's the spike's key finding).
//
// 3. Register an input-report callback on a dedicated CFRunLoop thread
//    (same pattern as install_event_tap). Each report is 22 bytes:
//       let x = i32::from_le_bytes(buf[6..10])  as f32 / 65536.0;
//       let y = i32::from_le_bytes(buf[10..14]) as f32 / 65536.0;
//       let z = i32::from_le_bytes(buf[14..18]) as f32 / 65536.0;
//
// 4. Knock detector (pure, cheap, runs in the callback):
//    - magnitude = sqrt(x*x + y*y + z*z); high-pass to drop the ~1g rest bias
//    - candidate when |delta| exceeds a calibrated threshold with a fast rise
//    - refractory window (~200 ms) to debounce; grouping window for double/triple
//    - suppress while recently typing (reuse key events already seen in hotkeys.rs)
//      and while Tink's TTS is playing (state Tink already tracks)
//
// 5. On a confirmed knock -> the SAME action as the push-to-talk hotkey:
//    flip the listening atomic / emit the event that starts STT capture.
```

Fallback path (`src-tauri` or `voice-core`): a `cpal` input stream with the envelope +
sharp-rise + debounce detector from §3, gated identically (recently-typed, TTS-playing),
firing the same listening-start action. Selected automatically when step 1 reports Unsupported.

Expose sensitivity/threshold, grouping window, and cooldown as settings (Tink already has a
settings system), and consider a small "knock test" waveform view for calibration — both
Knock and nocnoc found this necessary in practice.

**Suggested first step:** a throwaway Rust spike that opens `AppleSPUHIDDevice` usage 3 and
prints report magnitudes while you tap the case — this immediately answers the sudo question
and confirms the signal quality before any product wiring.

---

## Sources

- [olvvier/apple-silicon-accelerometer (GitHub)](https://github.com/olvvier/apple-silicon-accelerometer) and its [README](https://github.com/olvvier/apple-silicon-accelerometer/blob/main/README.md)
- [Reading the undocumented MEMS accelerometer on Apple Silicon — Hacker News](https://news.ycombinator.com/item?id=47084000)
- [Accessing the MEMS Accelerometer on Apple Silicon — Sesame Disk](https://sesamedisk.com/access-mems-accelerometer-apple-silicon/)
- [Sudden Motion Sensor — Wikipedia](https://en.wikipedia.org/wiki/Sudden_Motion_Sensor)
- [Core Motion — Apple Developer Documentation](https://developer.apple.com/documentation/coremotion) · [Core Motion on macOS — Apple Developer Forums](https://developer.apple.com/forums/thread/129351) · [isAccelerometerAvailable](https://developer.apple.com/documentation/coremotion/cmmotionmanager/isaccelerometeravailable)
- [Knock — Control your Mac with taps (tryknock.app)](https://www.tryknock.app/) · [Knock on Product Hunt](https://www.producthunt.com/products/knock-7)
- [shaircast/nocnoc — Knock on your MacBook to trigger action (GitHub)](https://github.com/shaircast/nocnoc)
- [Haptyk — mechanical keyboard sounds using the accelerometer](https://www.haptyk.com/)
- [AudioLib transient detection docs](https://github.com/tmdarwen/AudioLib/blob/master/Documentation/TransientDetection.md) · [IRCAM AudioSculpt transient method](https://support.ircam.fr/docs/AudioSculpt/3.0/co/Transients%20Method.html)
- [WWDC 2015 Session 217 — Adopting New Trackpad Features (Force Touch / NSEventTypePressure)](https://asciiwwdc.com/2015/sessions/217) · [Receiving Force Touch events — Eternal Storms](https://eternalstorms.wordpress.com/2015/10/24/how-to-receive-force-touch-events-from-an-nstableview/)
- Rust IOKit HID crates: [hidapi](https://docs.rs/hidapi) · [iohidmanager](https://docs.rs/iohidmanager/latest/iohidmanager/) · [io-kit-sys](https://lib.rs/crates/io-kit-sys)
- [BLEUnlock (GitHub)](https://github.com/ts1/BLEUnlock) and the original BLE "Knock to unlock" — distinct from Mac-sensor knocking
- Local verification: `ioreg -r -c AppleSPUHIDDevice` and legacy-class probes on `MacBookPro18,1` (M1 Pro, Darwin 24.6)
