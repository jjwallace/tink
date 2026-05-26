//! Tauri commands that don't fit a single domain — sound playback,
//! "Download all" first-launch helper, folder scanner. Each is small;
//! a domain-specific module would be premature.

use tauri::menu::ContextMenu;
use tauri::{Emitter, Manager};

use crate::folder_viz;
use crate::sfx;
use crate::state::{AppSettings, SfxDir, SttState, TtsState};
use crate::tray;

/// Pop up the main tray menu wherever the user invoked it (the anchor's
/// right-click). Uses the same menu definition the tray icon uses — items
/// route through `tray::handle_menu_event`.
#[tauri::command]
pub fn show_anchor_context_menu(
    app: tauri::AppHandle,
    window: tauri::Window,
) -> Result<(), String> {
    let (menu, _toggle) = tray::build_main_menu(&app).map_err(|e| e.to_string())?;
    // ContextMenu::popup shows at the current cursor — no need to pass coords.
    menu.popup(window).map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle the running state. Frontend invokes this when the anchor pip
/// is clicked. Routes through `tray::set_paused` so tray menu + emitted
/// event stay coherent.
#[tauri::command]
pub fn set_enabled(app: tauri::AppHandle, enabled: bool) {
    tray::set_paused(&app, !enabled);
}

#[tauri::command]
pub fn play_sound(
    name: String,
    sfx_dir: tauri::State<SfxDir>,
    cfg: tauri::State<AppSettings>,
) {
    let s = cfg.settings.lock().unwrap_or_else(|e| e.into_inner());
    // Per-sound toggles are the source of truth. sound_mode is
    // retained as a legacy field but no longer consulted here — the
    // frontend edits start_enabled / milestone_enabled / complete_enabled
    // directly.
    let should_play = match name.as_str() {
        "start" => s.start_enabled,
        "milestone" => s.milestone_enabled,
        "complete" => s.complete_enabled,
        _ => false,
    };
    if should_play {
        sfx::play(&name, &sfx_dir.0);
    }
}

#[tauri::command]
pub fn scan_folder(
    path: String,
    max_depth: Option<usize>,
) -> Result<folder_viz::FolderSummary, String> {
    folder_viz::scan(&path, max_depth.unwrap_or(5))
}

/// First-launch helper. Sweeps a curated set of baseline TTS voices and
/// the active STT model, downloading anything missing. Emits per-model
/// `model-download-progress` events as it goes; `model-download-complete`
/// fires once when the whole sweep finishes.
#[tauri::command]
pub fn download_all_models(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    std::thread::spawn(move || {
        let tts = handle.state::<TtsState>();
        let engine = tts.0.lock().expect("tts lock");
        let baseline = ["en_US-lessac-low", "en_US-lessac-high", "en_GB-vctk-medium"];
        for id in baseline {
            let label = engine
                .spec(id)
                .map(|s| s.label.clone())
                .unwrap_or_else(|| id.to_string());
            if !engine.is_model_downloaded(id) {
                let _ = handle.emit(
                    "model-download-progress",
                    serde_json::json!({
                        "model": label, "status": "downloading"
                    }),
                );
                match engine.download_model(id) {
                    Ok(()) => {
                        let _ = handle.emit(
                            "model-download-progress",
                            serde_json::json!({
                                "model": label, "status": "done"
                            }),
                        );
                    }
                    Err(e) => {
                        let _ = handle.emit(
                            "model-download-progress",
                            serde_json::json!({
                                "model": label, "status": "error", "error": e
                            }),
                        );
                    }
                }
            }
        }
        drop(engine);

        let stt = handle.state::<SttState>();
        let stt_engine = stt.0.lock().expect("stt lock");
        if !stt_engine.is_active_ready() {
            let _ = handle.emit(
                "model-download-progress",
                serde_json::json!({
                    "model": "Speech-to-Text", "status": "downloading"
                }),
            );
            match stt_engine.download_model(stt_engine.active_model()) {
                Ok(()) => {
                    let _ = handle.emit(
                        "model-download-progress",
                        serde_json::json!({
                            "model": "Speech-to-Text", "status": "done"
                        }),
                    );
                }
                Err(e) => {
                    let _ = handle.emit(
                        "model-download-progress",
                        serde_json::json!({
                            "model": "Speech-to-Text", "status": "error", "error": e
                        }),
                    );
                }
            }
        }

        let _ = handle.emit("model-download-complete", ());
    });
    Ok(())
}
