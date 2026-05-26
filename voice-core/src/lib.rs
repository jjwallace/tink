//! voice-core — shared TTS / STT / LLM engine.
//!
//! Hosts the platform-agnostic voice machinery that both `native` (the
//! editor narrator) and `companion` (the conversational AI) link to.
//! Currently empty; modules are extracted incrementally from
//! `native/src-tauri/src/` to keep the migration safe.
//!
//! Migration status:
//! - [x] summarizer (LLM via llama-cpp-2)
//! - [x] stt (sherpa-rs Zipformer + cpal mic) — uses EventSink
//! - [x] tts (sherpa-rs VITS + rodio) — uses EventSink for amplitude emitter
//!
//! Tauri-specific event emission stays in each app's shell; voice-core
//! takes an `EventSink` trait so it can be driven without depending on
//! Tauri directly.

pub mod conversation;
pub mod stt;
pub mod summarizer;
pub mod tts;
pub mod wake_word;

/// Sink for runtime events that voice-core needs to publish to the host
/// app (e.g. `tts-amplitude` per-window peaks during playback, STT
/// partial transcripts, etc.). Each app provides an impl that wraps
/// its own event system — Tauri `AppHandle.emit()` for the desktop
/// apps, NotificationCenter or similar on other platforms.
pub trait EventSink: Send + Sync {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

/// No-op sink for tests and headless contexts.
pub struct NoopSink;

impl EventSink for NoopSink {
    fn emit_json(&self, _event: &str, _payload: serde_json::Value) {}
}
