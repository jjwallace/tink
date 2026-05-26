//! Adapter that lets voice-core code emit through Tauri's event bus
//! without depending on Tauri itself.
//!
//! voice-core (the shared sibling crate) defines `EventSink` as a
//! trait with a single `emit_json(event, payload)` method. Native
//! wraps a `tauri::AppHandle` in this struct and implements the
//! trait so the engines (STT decode loop, TTS amplitude emitter,
//! summariser streaming) can fire frontend events without learning
//! about Tauri.
//!
//! Cheap to construct (clones an Arc internally), so callers that
//! need a sink can `Arc::new(TauriSink(handle.clone()))` at the
//! spawn site.

use tauri::Emitter;
use voice_core::EventSink;

pub struct TauriSink(pub tauri::AppHandle);

impl EventSink for TauriSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.emit(event, payload);
    }
}
