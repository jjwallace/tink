//! Settings Tauri commands — fetch the full panel state in one shot,
//! and write back individual keys with their per-key side effects.
//!
//! `update_setting` is the multi-key dispatcher the SettingsPanel calls
//! on every form change. New settings need an entry here that:
//!   1. mutates the corresponding `Settings` field
//!   2. mirrors the value to its live atomic / Tauri event sink (if any)
//!
//! `get_all_settings` flattens the engines' downloaded-model state into
//! the same JSON object so the panel can render every section in a
//! single round-trip.

use tauri::{Emitter, Manager};
use voice_core::{stt, summarizer};

use crate::hotkeys::parse_shortcut;
use crate::state::{
    AppSettings, SttState, SummarizerState, TtsState, SPEAK_SEL_ENABLED,
    SPEAK_SEL_HOTKEY_KEYCODE, SPEAK_SEL_HOTKEY_MODIFIERS, SPEAK_SEL_MIDDLE_CLICK,
    SPEAK_SEL_SUMMARIZE, STT_HOTKEY_KEYCODE, STT_HOTKEY_MODIFIERS,
};

#[tauri::command]
pub fn get_all_settings(
    cfg: tauri::State<AppSettings>,
    tts_state: tauri::State<TtsState>,
    stt_state: tauri::State<SttState>,
    sum_state: tauri::State<SummarizerState>,
) -> Result<serde_json::Value, String> {
    let s = cfg.settings.lock().map_err(|e| e.to_string())?;
    let tts = tts_state.0.lock().map_err(|e| e.to_string())?;
    let stt = stt_state.0.lock().map_err(|e| e.to_string())?;
    let sum = sum_state.0.lock().map_err(|e| e.to_string())?;
    let summarizer_models: Vec<serde_json::Value> = summarizer::SummarizerModel::all()
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id(),
                "label": m.label(),
                "description": m.description(),
                "downloaded": sum.is_downloaded(*m),
            })
        })
        .collect();
    let tts_models: serde_json::Value = {
        let mut map = serde_json::Map::new();
        for spec in tts.voice_specs() {
            map.insert(
                spec.id.clone(),
                serde_json::Value::Bool(tts.is_model_downloaded(&spec.id)),
            );
        }
        serde_json::Value::Object(map)
    };
    let tts_voices: Vec<voice_core::tts::VoiceSpec> =
        tts.voice_specs().into_iter().cloned().collect();
    Ok(serde_json::json!({
        "shortcut": s.shortcut,
        "voice": s.voice,
        "display": s.display,
        "auto_speak": s.auto_speak,
        "sound_mode": s.sound_mode,
        "start_enabled": s.start_enabled,
        "milestone_enabled": s.milestone_enabled,
        "complete_enabled": s.complete_enabled,
        "stt_enabled": s.stt_enabled,
        "tts_enabled": s.tts_enabled,
        "work_mode": s.work_mode,
        "personality": s.personality,
        "start_sound": s.start_sound,
        "complete_sound": s.complete_sound,
        "milestone_sound": s.milestone_sound,
        "vfx_enabled": s.vfx_enabled,
        "vfx_color": s.vfx_color,
        "voice_anchor_x": s.voice_anchor_x,
        "voice_anchor_y": s.voice_anchor_y,
        "anchor_bob": s.anchor_bob,
        "speak_selection_enabled": s.speak_selection_enabled,
        "speak_selection_shortcut": s.speak_selection_shortcut,
        "speak_selection_middle_click": s.speak_selection_middle_click,
        "speak_selection_mode": s.speak_selection_mode,
        "creature_enabled": s.creature_enabled,
        "stt_sounds_enabled": s.stt_sounds_enabled,
        "stt_on_sound": s.stt_on_sound,
        "stt_off_sound": s.stt_off_sound,
        "stt_text_display_enabled": s.stt_text_display_enabled,
        "tts_models": tts_models,
        "tts_voices": tts_voices,
        "tts_current_voice": tts.current_voice(),
        "stt": {
            "active": stt.active_model().id(),
            "models": stt::SttModel::all().iter().map(|m| serde_json::json!({
                "id": m.id(),
                "label": m.label(),
                "description": m.description(),
                "downloaded": stt.is_downloaded(*m),
            })).collect::<Vec<_>>(),
        },
        "summarizer": {
            "active": sum.active_model().id(),
            "models": summarizer_models,
        }
    }))
}

#[tauri::command]
pub fn update_setting(
    key: String,
    value: String,
    cfg: tauri::State<AppSettings>,
    tts_state: tauri::State<TtsState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut s = cfg.settings.lock().map_err(|e| e.to_string())?;
    match key.as_str() {
        "voice" => {
            // value is a Piper ID ("en_US-ryan-high") OR a legacy short
            // ID ("ryan"); set_voice canonicalizes either to the Piper
            // ID and ignores unknown ones (no-op).
            if let Ok(mut engine) = tts_state.0.try_lock() {
                engine.set_voice(&value);
                s.voice = engine.current_voice().to_string();
            } else {
                s.voice = value.clone();
            }
            // Demo-on-select removed — its spawned do_speak_text threads
            // were the trigger for a cascade of TTS-lock contention and
            // occasional full-UI freezes. The user can hear the voice
            // by triggering any hook event.
        }
        "display" => {
            s.display = value.clone();
            let _ = app.emit("tts-display-mode", &value);
        }
        "shortcut" => {
            s.shortcut = value.clone();
            // Refresh the live keycode read by the CGEvent tap. Unknown
            // strings leave the previous binding intact instead of
            // silently disabling the hotkey — protects against a bad
            // write from the frontend.
            if let Some((code, mods)) = parse_shortcut(&value) {
                STT_HOTKEY_KEYCODE.store(code, std::sync::atomic::Ordering::Relaxed);
                STT_HOTKEY_MODIFIERS.store(mods, std::sync::atomic::Ordering::Relaxed);
            } else {
                eprintln!("[shortcut] unknown binding '{}', keeping previous", value);
            }
        }
        "sound_mode" => s.sound_mode = value,
        "start_enabled" => s.start_enabled = value == "true",
        "milestone_enabled" => s.milestone_enabled = value == "true",
        "complete_enabled" => s.complete_enabled = value == "true",
        "stt_enabled" => s.stt_enabled = value == "true",
        "tts_enabled" => s.tts_enabled = value == "true",
        "stt_model" => s.stt_model = value,
        "work_mode" => s.work_mode = value,
        "personality" => s.personality = value,
        "start_sound" => s.start_sound = value,
        "complete_sound" => s.complete_sound = value,
        "milestone_sound" => s.milestone_sound = value,
        "vfx_enabled" => s.vfx_enabled = value == "true",
        "vfx_color" => s.vfx_color = value,
        "voice_anchor_x" => s.voice_anchor_x = value.parse().unwrap_or(0.8),
        "voice_anchor_y" => s.voice_anchor_y = value.parse().unwrap_or(0.5),
        "anchor_bob" => s.anchor_bob = value == "true",
        "auto_speak" => {
            let enabled = value == "true";
            s.auto_speak = enabled;
            let auto = app.state::<std::sync::Arc<std::sync::atomic::AtomicBool>>();
            auto.store(enabled, std::sync::atomic::Ordering::Relaxed);
        }
        "speak_selection_enabled" => {
            s.speak_selection_enabled = value == "true";
            SPEAK_SEL_ENABLED.store(
                s.speak_selection_enabled,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        "speak_selection_middle_click" => {
            s.speak_selection_middle_click = value == "true";
            SPEAK_SEL_MIDDLE_CLICK.store(
                s.speak_selection_middle_click,
                std::sync::atomic::Ordering::Relaxed,
            );
        }
        "speak_selection_shortcut" => {
            s.speak_selection_shortcut = value.clone();
            if let Some((code, mods)) = parse_shortcut(&value) {
                SPEAK_SEL_HOTKEY_KEYCODE
                    .store(code, std::sync::atomic::Ordering::Relaxed);
                SPEAK_SEL_HOTKEY_MODIFIERS
                    .store(mods, std::sync::atomic::Ordering::Relaxed);
            } else {
                eprintln!(
                    "[speak_selection_shortcut] unknown binding '{}', keeping previous",
                    value
                );
            }
        }
        "speak_selection_mode" => {
            s.speak_selection_mode = value.clone();
            SPEAK_SEL_SUMMARIZE
                .store(value == "summarize", std::sync::atomic::Ordering::Relaxed);
        }
        "creature_enabled" => {
            s.creature_enabled = value == "true";
            let _ = app.emit("creature-enabled", &s.creature_enabled);
        }
        "stt_sounds_enabled" => s.stt_sounds_enabled = value == "true",
        "stt_on_sound" => s.stt_on_sound = value,
        "stt_off_sound" => s.stt_off_sound = value,
        "stt_text_display_enabled" => {
            s.stt_text_display_enabled = value == "true";
            let _ = app.emit("stt-text-display-enabled", &s.stt_text_display_enabled);
        }
        _ => return Err(format!("Unknown setting: {}", key)),
    }
    s.save(&cfg.data_dir);
    Ok(())
}
