//! Voice (TTS) Tauri commands — pick a voice, list registered voices,
//! download model files, register custom Piper voices.
//!
//! Download lifecycle (emitted as global Tauri events for the UI):
//!   - `voice-download-start`    `{ id }`
//!   - `voice-download-progress` `{ id, done, total, percent }`
//!   - `voice-download-complete` `{ id }`
//!   - `voice-download-error`    `{ id, error }`
//!
//! `total` is 0 if the server doesn't return Content-Length; the UI
//! should fall back to indeterminate rendering when that happens.

use tauri::Emitter;
use voice_core::tts::{TtsEngine, VoiceSpec};

use crate::state::{AppSettings, TtsState};

#[tauri::command]
pub fn set_voice(
    voice: String,
    state: tauri::State<TtsState>,
    cfg: tauri::State<AppSettings>,
) -> Result<(), String> {
    let mut engine = state.0.lock().map_err(|e| e.to_string())?;
    engine.set_voice(&voice);
    let canonical = engine.current_voice().to_string();
    let mut s = cfg.settings.lock().map_err(|e| e.to_string())?;
    s.voice = canonical;
    s.save(&cfg.data_dir);
    Ok(())
}

#[tauri::command]
pub fn get_voice(state: tauri::State<TtsState>) -> Result<String, String> {
    let engine = state.0.lock().map_err(|e| e.to_string())?;
    Ok(engine.current_voice().to_string())
}

#[tauri::command]
pub fn download_voice_model(
    voice: String,
    state: tauri::State<TtsState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (models_dir, already_done, spec) = {
        let engine = state.0.lock().map_err(|e| e.to_string())?;
        let spec = engine
            .spec(&voice)
            .ok_or_else(|| format!("Unknown voice: {}", voice))?
            .clone();
        (
            engine.models_root(),
            engine.is_model_downloaded(&voice),
            spec,
        )
    };
    let id = spec.id.clone();
    if already_done {
        let _ = app.emit("voice-download-complete", serde_json::json!({ "id": id }));
        return Ok(());
    }
    let _ = app.emit("voice-download-start", serde_json::json!({ "id": id }));

    let app2 = app.clone();
    let id_for_thread = id.clone();
    std::thread::spawn(move || {
        // Build a throwaway engine just to reuse `download_with_progress`.
        // The engine's voices map needs the spec we want to download.
        let mut tmp = TtsEngine::new(models_dir);
        tmp.register(spec);
        let result = tmp.download_with_progress(&id_for_thread, |done, total| {
            let percent = if total > 0 {
                (done as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let _ = app2.emit(
                "voice-download-progress",
                serde_json::json!({
                    "id": id_for_thread,
                    "done": done,
                    "total": total,
                    "percent": percent,
                }),
            );
        });
        match result {
            Ok(()) => {
                let _ = app2.emit(
                    "voice-download-complete",
                    serde_json::json!({ "id": id_for_thread }),
                );
            }
            Err(e) => {
                let _ = app2.emit(
                    "voice-download-error",
                    serde_json::json!({ "id": id_for_thread, "error": e }),
                );
            }
        }
    });
    Ok(())
}

/// Register and persist a custom Piper voice. The frontend calls this
/// after the user pastes a Piper voice ID into the "+ Add voice" form.
/// Returns the new VoiceSpec on success so the UI can render it
/// immediately. Persisted in `Settings::custom_voices` so it survives
/// restarts.
#[tauri::command]
pub fn add_custom_voice(
    piper_id: String,
    state: tauri::State<TtsState>,
    cfg: tauri::State<AppSettings>,
) -> Result<VoiceSpec, String> {
    let id = piper_id.trim().to_string();
    if id.is_empty() {
        return Err("Voice ID cannot be empty".into());
    }
    let spec = VoiceSpec::from_piper_id(&id);
    {
        let mut engine = state.0.lock().map_err(|e| e.to_string())?;
        engine.register(spec.clone());
    }
    {
        let mut s = cfg.settings.lock().map_err(|e| e.to_string())?;
        // De-dupe by id — re-adding overwrites.
        s.custom_voices.retain(|v| v.id != spec.id);
        s.custom_voices.push(spec.clone());
        s.save(&cfg.data_dir);
    }
    Ok(spec)
}

#[tauri::command]
pub fn list_voices(state: tauri::State<TtsState>) -> Result<Vec<VoiceSpec>, String> {
    let engine = state.0.lock().map_err(|e| e.to_string())?;
    Ok(engine.voice_specs().into_iter().cloned().collect())
}

#[tauri::command]
pub fn get_model_status(state: tauri::State<TtsState>) -> Result<serde_json::Value, String> {
    let engine = state.0.lock().map_err(|e| e.to_string())?;
    let mut map = serde_json::Map::new();
    for spec in engine.voice_specs() {
        map.insert(
            spec.id.clone(),
            serde_json::Value::Bool(engine.is_model_downloaded(&spec.id)),
        );
    }
    Ok(serde_json::Value::Object(map))
}
