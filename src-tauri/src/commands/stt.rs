//! Speech-to-text Tauri commands — list/select/download Sherpa STT
//! models. The model registry lives in `voice_core::stt`; these
//! commands just thread it through to the frontend.

use tauri::{Emitter, Manager};
use voice_core::stt;

use crate::state::{AppSettings, SttState};

#[tauri::command]
pub fn get_stt_models(state: tauri::State<SttState>) -> Result<serde_json::Value, String> {
    let engine = state.0.lock().map_err(|e| e.to_string())?;
    let models: Vec<serde_json::Value> = stt::SttModel::all()
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id(),
                "label": m.label(),
                "description": m.description(),
                "downloaded": engine.is_downloaded(*m),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "active": engine.active_model().id(),
        "models": models,
    }))
}

#[tauri::command]
pub fn set_stt_model(
    model_id: String,
    state: tauri::State<SttState>,
    cfg: tauri::State<AppSettings>,
) -> Result<(), String> {
    let model = stt::SttModel::from_id(&model_id)
        .ok_or_else(|| format!("Unknown STT model: {}", model_id))?;
    let mut engine = state.0.lock().map_err(|e| e.to_string())?;
    engine.set_active_model(model);
    let mut s = cfg.settings.lock().map_err(|e| e.to_string())?;
    s.stt_model = model_id;
    s.save(&cfg.data_dir);
    Ok(())
}

#[tauri::command]
pub fn download_stt_model(model_id: String, app: tauri::AppHandle) -> Result<(), String> {
    let model = stt::SttModel::from_id(&model_id)
        .ok_or_else(|| format!("Unknown STT model: {}", model_id))?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = handle.emit(
            "stt-download-progress",
            serde_json::json!({
                "model": model.id(), "status": "downloading"
            }),
        );
        let result = {
            let state = handle.state::<SttState>();
            let engine = state.0.lock().expect("stt lock");
            engine.download_model(model)
        };
        match result {
            Ok(()) => {
                let _ = handle.emit(
                    "stt-download-progress",
                    serde_json::json!({
                        "model": model.id(), "status": "done"
                    }),
                );
            }
            Err(e) => {
                let _ = handle.emit(
                    "stt-download-progress",
                    serde_json::json!({
                        "model": model.id(), "status": "error", "error": e
                    }),
                );
            }
        }
    });
    Ok(())
}
