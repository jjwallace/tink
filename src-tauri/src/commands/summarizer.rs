//! Summarizer (LLM) Tauri commands — list/select/download SmolLM2
//! GGUF model variants. Used by the Settings panel; the actual
//! summarize/respond_to_stt calls happen in the speak pipeline.

use tauri::{Emitter, Manager};
use voice_core::summarizer;

use crate::state::{AppSettings, SummarizerState};

#[tauri::command]
pub fn summarizer_status(
    state: tauri::State<SummarizerState>,
) -> Result<serde_json::Value, String> {
    let engine = state.0.lock().map_err(|e| e.to_string())?;
    let models: Vec<serde_json::Value> = summarizer::SummarizerModel::all()
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
pub fn set_summarizer_model(
    model_id: String,
    state: tauri::State<SummarizerState>,
    cfg: tauri::State<AppSettings>,
) -> Result<(), String> {
    let model = summarizer::SummarizerModel::from_id(&model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;
    let mut engine = state.0.lock().map_err(|e| e.to_string())?;
    engine.set_active_model(model);
    let mut s = cfg.settings.lock().map_err(|e| e.to_string())?;
    s.summary_model = model_id;
    s.save(&cfg.data_dir);
    Ok(())
}

#[tauri::command]
pub fn download_summarizer_model(
    model_id: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let model = summarizer::SummarizerModel::from_id(&model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let handle = app.clone();
    std::thread::spawn(move || {
        let _ = handle.emit(
            "summarizer-download-progress",
            serde_json::json!({
                "model": model.id(), "status": "downloading"
            }),
        );

        let result = {
            let engine = handle.state::<SummarizerState>();
            let s = engine.0.lock().expect("summarizer lock");
            s.download_model(model)
        };

        match result {
            Ok(()) => {
                let _ = handle.emit(
                    "summarizer-download-progress",
                    serde_json::json!({
                        "model": model.id(), "status": "done"
                    }),
                );
            }
            Err(e) => {
                let _ = handle.emit(
                    "summarizer-download-progress",
                    serde_json::json!({
                        "model": model.id(), "status": "error", "error": e
                    }),
                );
            }
        }
    });
    Ok(())
}
