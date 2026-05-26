# Feasibility: Local Always-On Conversational AI Companion

## TL;DR

Yes, this is feasible — most components already exist in `native` and just need rewiring. A reasonable target is **wake-word → speak → ~1s response** end-to-end on M-series hardware, fully offline, with conversation memory persisting across turns. The harder problems are echo handling, picking the right LLM (small enough to stream fast, "personality enough" not to feel robotic), and the always-on listening UX.

This doc lays out the architecture, the parts we already have, the parts we'd need to build, and the open decisions.

---

## What we already have in `native`

| Capability | Module | Notes |
|---|---|---|
| **STT** | `src-tauri/src/stt.rs` | sherpa-rs / Zipformer, ~300-500 ms decode for short utterances. Currently push-to-talk; would need VAD gating for always-on. |
| **TTS** | `src-tauri/src/tts.rs` | sherpa-rs / VITS, 4 voice models. Sentence-streamed playback already works. ~200-500 ms first-audio latency. |
| **Local LLM runtime** | `src-tauri/src/summarizer.rs` | llama-cpp-2 wrapper, currently runs SmolLM2 / Qwen2.5 0.5B for one-shot summarization. Same machinery can host any GGUF model. |
| **Audio pipeline** | `cpal` for input, `rodio` for output | Working; mic→buffer→decode and TTS samples→sink. |
| **Session lifecycle** | `TtsSessionGuard`, `STT_STOPPING`, fade-out, atomic claim | All the coordination machinery (interrupt TTS, prevent re-entry, fade audio rather than click-cut) is built. |
| **Personality system** | `summarizer.rs` palette + `~/.claude/hooks/speak-narrator.sh` | The "voice character" abstraction is real. Could be reused. |
| **UI overlay** | Tauri 2 + SolidJS, transparent fullscreen | Reactive visualizations (sine wave, particles, creature) already drive off TTS amplitude. |
| **Settings persistence** | `settings.rs` JSON | Voice / personality / hotkey config pattern. |

So roughly **70 % of the new app already exists in the parts of native we'd reuse.**

## What's new

| New component | What it does | Effort |
|---|---|---|
| **Wake word detection** | Listens at low CPU for a hail phrase, fires when matched | 1-2 days |
| **VAD-gated STT** | Voice Activity Detection so STT only runs when speech is detected (not push-to-talk) | 1 day (Silero VAD) |
| **Conversation state** | Rolling buffer of recent turns, system prompt, context-window management | 1-2 days |
| **Turn-taking / barge-in** | User speaks → TTS stops → mic re-engages | 1 day (the interrupt machinery exists) |
| **Streaming LLM → TTS** | Stream LLM tokens, split into sentences, hand each to TTS | 2 days |
| **Echo gating** | Don't let our own TTS retrigger the wake word / VAD | 0.5 day (gate during playback) |
| **Persistent memory (optional)** | Long-term recall across sessions | 1-3 days depending on depth |
| **Companion UI** | Different from the editor overlay — needs an "always listening" indicator + transcript history view | 2-3 days |

## Architecture sketch

```
┌─────────────────────────────────────────────────────────┐
│                 Always-On Mic Loop                      │
│                                                         │
│   cpal stream → ring buffer                             │
│        │                                                │
│        ├─► Wake word detector (low-CPU, ~1ms/frame)     │
│        │                                                │
│        ├─► VAD (Silero / WebRTC)                        │
│        │                                                │
│        └─► STT (gated: only after wake + VAD-on)        │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼  (final transcript)
┌─────────────────────────────────────────────────────────┐
│              Conversation Orchestrator                  │
│                                                         │
│   1. Append user turn to context                        │
│   2. Stream LLM completion via llama-cpp-2              │
│   3. Sentence-segment streaming output                  │
│   4. Push each sentence to TTS pipeline                 │
│   5. Append assistant turn to context                   │
│   6. Trim oldest turns when context window fills        │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  TTS Streaming                          │
│                                                         │
│   For each sentence (back-pressured):                   │
│     - VITS generate → samples                           │
│     - rodio play → emit amplitude events                │
│     - Wait for sink empty                               │
│   On user speech detected mid-playback:                 │
│     - Cancel TTS, fade out                              │
│     - Re-engage STT                                     │
└─────────────────────────────────────────────────────────┘
```

## Wake word options

The "always listening but not really" trick is a wake word — a small NN that runs on every audio frame with very low CPU cost and only fires the heavy STT when a specific phrase is recognized.

| Option | Pros | Cons |
|---|---|---|
| **Picovoice Porcupine** | Best accuracy, ~1 ms/frame, supports custom wake words, mature SDK | Free for personal use up to 3 keywords; commercial use paid. Closed source. |
| **openWakeWord** | Fully open source (Apache-2), runs ONNX models on CPU, custom training | Python-first; would need ONNX Runtime in Rust (manageable) or wrap via FFI |
| **Snowboy** | Was the standard, free | Deprecated since 2020, models stale |
| **Custom NN** | Total control | Weeks of work to train, label, tune. Not worth it. |
| **"Always-on STT"** | No new component | STT running 24/7 = significant battery cost on laptop, false-positive flood |

**Recommendation: openWakeWord.** Open source, ONNX models we can ship, and ports of it into Rust+ONNX-Runtime exist. Picovoice is technically nicer but the licensing is a commitment we don't need.

The hail phrase ("Hey Pookie" / "Hey Skipper" / whatever) is part of the personality config.

## VAD (voice activity detection)

Once the wake word fires, we still need to know when the user STOPS talking so we can hand the buffer to STT. That's VAD's job.

- **Silero VAD** — small ONNX model (~3 MB), <1 ms inference per frame, works very well. Recommended.
- **WebRTC VAD** — older, simpler. Tighter integration with audio crates but lower accuracy.

VAD fires a "speech started" event on first detected voiced frame, "speech ended" event after ~500 ms of silence. STT gets the buffer between those two events.

## LLM choice — "less logical, more chatty"

The user explicitly asked for not-too-logical. That maps to: **smaller models with good dialogue training, not reasoning-tuned models**.

| Model | Size (Q4) | First-token | Token rate (M2 Pro) | Dialogue feel |
|---|---|---|---|---|
| **SmolLM2 1.7B Instruct** | 1 GB | 100-200 ms | 50-70 tok/s | Casual, sometimes confidently wrong. Dialogue-trained. Good fit. |
| **Llama 3.2 1B Instruct** | 700 MB | 80-150 ms | 60-80 tok/s | More on-rails; safety-tuned; tries to be helpful. |
| **Llama 3.2 3B Instruct** | 1.8 GB | 200-400 ms | 30-40 tok/s | Stronger reasoning; might feel too "smart" for a chat companion. |
| **Qwen 2.5 0.5B Instruct** | 400 MB | 50-100 ms | 80-100 tok/s | Surprisingly competent for size; brevity-leaning. |
| **Phi-3 mini 3.8B** | 2.3 GB | 300-500 ms | 25-35 tok/s | **Very logical** — Microsoft tuned it on MMLU. Skip per requirement. |
| **Hermes 3 Llama 3.2 3B** | 1.8 GB | 200-400 ms | 30-40 tok/s | Conversational fine-tune. Less guarded, more "friendly." |
| **Gemma 2 2B IT** | 1.6 GB | 200-300 ms | 35-50 tok/s | Generally chatty, well-tuned. |

**My pick for the user's request: SmolLM2 1.7B Instruct or Hermes 3 Llama 3.2 3B**. SmolLM2 is the lightest and we already have llama-cpp-2 wired for it. Hermes 3 is a step up if 1.7B feels too thin on memory or coherence.

For "personality" the system prompt does most of the work. The model just needs to follow the prompt — none of these are too rigid for that.

## Latency budget (target: ≤ 1.2 s perceived)

```
Wake word fire        ~ 0 ms (continuously running)
VAD speech-end        +0 ms (buffer already includes utterance)
STT decode            +250 ms (Zipformer, ~5s utterance)
LLM first token       +150 ms (1.7B, M2 Pro)
LLM first sentence    +400 ms (~30 tokens of completion)
TTS first audio       +250 ms (VITS, lessac-fast)
                      ─────────
                      ≈ 1.05 s before user hears response begin
```

The trick is **streaming** — LLM tokens hand off to TTS sentence-by-sentence, so the user hears the first sentence while the model is still generating the second. Total latency feels like ~1 s; full reply duration is whatever the spoken response would naturally take.

## Echo / self-hearing problem

The mic picks up the speaker. If TTS is playing while mic is open, the system can:
- Re-trigger the wake word on its own voice
- VAD trigger on its own voice → STT → "talked over self" loop

**Solutions, in order of complexity:**

1. **Gate STT/wake word during TTS playback** (cheapest) — disable both while a TTS sink has samples queued. Re-enable when sink empties + 200 ms guard. Loses barge-in.
2. **Gate wake word + keep VAD enabled with a higher threshold** — so user can interrupt by speaking loudly, but TTS doesn't re-trigger.
3. **Acoustic echo cancellation** — speex/AEC3 / WebRTC AEC ported to Rust. Real fix; complex to wire (requires reference signal — what we sent to speakers — synced with mic input). Worth it for headphones-off use.
4. **Force headphones** — physical isolation. Punts the problem to hardware.

**Recommended starting point: option 1** (gate during TTS) for v0, upgrade to option 3 (real AEC) if open-air use becomes the main target.

## UX nuances

- **Always-on indicator.** macOS shows the orange mic dot in the menu bar; user knows. App should also have its own visible "I'm listening" affordance — pulsing orb, color-coded states (idle / heard wake word / speaking back).
- **Conversation history.** Worth surfacing somewhere? Scrollback panel? Or pure ephemeral?
- **End-of-conversation reset.** After 60 s of no input, clear context window. Or keep going forever — conversation memory.
- **Push-to-talk fallback.** Even with wake word, manual STT trigger (PageUp) should still work for noisy environments.
- **Mute toggle.** Tray menu item or hotkey. Hard kill of mic input.
- **Privacy mode.** "Don't record / don't remember this exchange." Useful for sensitive content. Requires explicit memory architecture.

## Build approach

Three options:

### A. Feature flag inside `native`

Add a `mode: "editor" | "companion"` setting. Same Tauri app, same window, different orchestration based on mode.

- **Pros**: Reuse 100 % of existing code. One binary. Settings live in one place.
- **Cons**: Cognitive load — every feature has to think about both modes. Settings panel grows. Deciding which UI surfaces apply per mode is constant friction.

### B. Sibling app in `Lattice/repos/companion/`

New Tauri app, shares `repos/native/src-tauri/src/{tts,stt,summarizer,settings,sfx}.rs` via Cargo path dependencies (workspace). UI is its own crate.

- **Pros**: Clean separation. Different visual / interaction language. Independent deploys.
- **Cons**: Two binaries to maintain. Some duplication of glue code. Cross-repo sharing requires turning native's `src-tauri` into a Cargo workspace.

### C. Fork

Copy `native/` to `companion/` and let them diverge.

- **Pros**: Zero coupling.
- **Cons**: Bug fixes have to be ported manually. Diverges fast.

**Recommendation: B.** Clean separation but real reuse. Convert native's TTS/STT/summarizer modules into a `wolf-voice-core` library crate; both apps depend on it.

## Open decisions / questions

1. **Wake word phrase.** "Hey [name]" — what name? Tied to the personality config. Could be configurable.
2. **Hail-or-always-listen mode.** Wake-word required vs always-on STT? Wake-word is the only sane default for laptop battery.
3. **Conversation persistence.** Forever-memory vs session-only?
4. **Personality.** Reuse existing palette personalities (ship-computer / drunken-sailor / etc.) or build a dedicated companion personality? A "friend" wants warmer than ship-computer, less profane than drunken-sailor.
5. **Streaming sentence segmentation.** Naive `split on . / ! / ?` works for most cases but breaks on abbreviations / decimals. Use a real sentence segmenter (rule-based; ~50 lines).
6. **Distribution / first-launch.** ~3 GB of model files (LLM + STT + TTS + wake word + VAD). Download on first launch with progress UI? Bundle into installer?
7. **Audio device handling.** Default input/output devices change (AirPods connect/disconnect). Detect and reconfigure cpal stream gracefully.
8. **What does the companion DO besides chat?** Tools? File access? Memory queries? Or pure conversation?

## Risks

- **LLM "small enough to be fast" vs "smart enough to be a friend"** — 1.7B is the boundary; smaller and the conversation gets shallow, larger and latency creeps over 1 s. Test carefully.
- **False wake-word triggers** — anything that sounds like the hail phrase fires the STT pipeline. Tune threshold; ship with confidence floor.
- **Hot kitchen / open speakers** — without AEC, the bot will hear itself. Ship gated v0; user feedback dictates whether AEC is worth building.
- **macOS mic permission UX** — first launch needs explicit permission grant; if denied, app must surface a clear "go to Settings → Privacy → Microphone" message instead of silently failing.
- **Battery on laptop** — wake word + VAD always running is real CPU. Measure on M-series; consider auto-pause when on battery + lid closed / display sleep.

## Suggested v0 scope

1. Picovoice/openWakeWord with ONE configurable hail phrase.
2. Silero VAD gating STT.
3. SmolLM2 1.7B with simple system prompt + last 10-turn context.
4. Streaming LLM → sentence-split → TTS pipeline.
5. Gate-during-TTS echo solution (no real AEC).
6. Tray UI: mic indicator + mute + transcript scrollback + quit.
7. NO persistent memory; context resets every 60 s of silence.

Build that, prove the loop closes at <1.2 s perceived latency, then iterate on personality, memory, AEC, and UX details.

## Related

- [`docs/05-architecture.md`](05-architecture.md) — how the existing native app is structured
- [`docs/01-tts-overview.md`](01-tts-overview.md) — TTS pipeline details
- [`docs/12-stt-personality-replies.md`](12-stt-personality-replies.md) — reply / personality machinery
- [`src-tauri/src/summarizer.rs`](../src-tauri/src/summarizer.rs) — llama-cpp-2 wrapper that any new model would hook into
