mod commands;
mod creature_runtime;
mod event_sink;
mod file_watcher;
mod folder_viz;
mod hotkeys;
mod settings;
mod sfx;
mod speak;
mod speak_server;
mod state;
mod tray;
mod window_setup;

pub use event_sink::TauriSink;

// Re-export everything from state so existing call sites that use
// bare names (PAUSED, USER_SPEAKING, AppSettings, etc.) keep working
// without a module-prefix sweep. Once every module is split out and
// imports go through `crate::state::*` directly, this can drop.
pub use state::{
    AppSettings, CursorCtl, SfxDir, SttState, SummarizerState, TtsState, GLOBAL_APP_HANDLE,
    LAST_MIDDLE_CLICK, PAUSED, SPEAK_SEL_ENABLED, SPEAK_SEL_HOTKEY_KEYCODE,
    SPEAK_SEL_HOTKEY_MODIFIERS, SPEAK_SEL_MIDDLE_CLICK, SPEAK_SEL_SUMMARIZE,
    STT_HOTKEY_KEYCODE, STT_HOTKEY_MODIFIERS, STT_STOPPING,
    USER_SPEAKING, WAS_DRAGGING,
};

// Voice-core hosts the platform-agnostic engines. Local aliases keep
// existing call sites (`stt::SttModel::all()`, `tts::strip_markdown(...)`,
// `summarizer::Summarizer::new(...)`) working unchanged.
use voice_core::stt;
use voice_core::summarizer;
use voice_core::tts;

// TauriSink moved to event_sink.rs (re-exported above).
// CursorCtl moved to state.rs; cursor helpers + window setup in window_setup.rs.
// FFI types, event tap, hotkey codes in hotkeys.rs.

use std::sync::Mutex;
use tauri::{Emitter, Manager};

use stt::SttEngine;
use tts::TtsEngine;
use settings::Settings;


// State holders moved to state.rs; re-exported at the top of this file.


// ── Main ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Global menu-event handler — fires for any menu (tray AND
        // popped-up context menus, e.g. anchor right-click). The tray
        // also has its own per-tray handler; in Tauri 2 the per-tray
        // handler takes precedence for tray events, so this is purely
        // the catch-all for popups.
        .on_menu_event(tray::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            // hotkeys.rs / window_setup.rs surfaces
            hotkeys::get_mouse_position,
            window_setup::set_settings_open,
            window_setup::set_anchor_dragging,
            // speak.rs
            speak::stop_speaking,
            speak::speak_brief,
            // commands::voice
            commands::voice::set_voice,
            commands::voice::get_voice,
            commands::voice::download_voice_model,
            commands::voice::add_custom_voice,
            commands::voice::list_voices,
            commands::voice::get_model_status,
            // commands::stt
            commands::stt::get_stt_models,
            commands::stt::set_stt_model,
            commands::stt::download_stt_model,
            // commands::settings
            commands::settings::get_all_settings,
            commands::settings::update_setting,
            // commands::misc
            commands::misc::play_sound,
            commands::misc::download_all_models,
            commands::misc::scan_folder,
            commands::misc::show_anchor_context_menu,
            commands::misc::set_enabled,
            // commands::summarizer
            commands::summarizer::summarizer_status,
            commands::summarizer::set_summarizer_model,
            commands::summarizer::download_summarizer_model,
            // creature_runtime
            creature_runtime::creature_start,
            creature_runtime::creature_stop,
            creature_runtime::creature_set_anchor,
            creature_runtime::creature_set_screen,
            creature_runtime::creature_event,
            creature_runtime::creature_dispatch,
            creature_runtime::creature_status,
        ])
        .setup(|app| {
            // --- Data dir & settings ---
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let settings = Settings::load(&data_dir);

            // --- TTS State (restore saved voice + custom voices) ---
            let models_dir = data_dir.join("models");
            let mut engine = TtsEngine::new(models_dir);
            // Register any user-added voices from settings before
            // honoring the saved voice ID, so set_voice can find them.
            for spec in &settings.custom_voices {
                engine.register(spec.clone());
            }
            // Accepts both Piper IDs and legacy short IDs; falls back to
            // engine's default if the saved value is unknown.
            engine.set_voice(&settings.voice);
            app.manage(TtsState(Mutex::new(engine)));

            // --- STT State ---
            let mut stt_engine = SttEngine::new(data_dir.join("models"));
            if let Some(model) = stt::SttModel::from_id(&settings.stt_model) {
                stt_engine.set_active_model(model);
            }
            app.manage(SttState(Mutex::new(stt_engine)));

            // --- Summarizer State ---
            let mut summarizer_engine = summarizer::Summarizer::new(data_dir.join("models"));
            if let Some(model) = summarizer::SummarizerModel::from_id(&settings.summary_model) {
                summarizer_engine.set_active_model(model);
            }
            app.manage(SummarizerState(Mutex::new(summarizer_engine)));

            // --- Creature runtime (choreo + orchestrator) ---
            creature_runtime::register(app);

            // --- SFX directory ---
            // In dev, assets are served from public/; resolve relative to manifest dir
            let sfx_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("public/assets/sfx");
            app.manage(SfxDir(sfx_dir));

            // Preload the current voice model in background so first speak is fast
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let state = handle.state::<TtsState>();
                    let mut engine = state.0.lock().expect("tts lock");
                    // Generate a tiny string to force model load
                    let _ = engine.generate_sentence(".");
                    eprintln!("TTS model preloaded");
                });
            }

            let saved_shortcut = settings.shortcut.clone();
            let settings_auto_speak = settings.auto_speak;
            app.manage(AppSettings {
                settings: Mutex::new(settings),
                data_dir: data_dir.clone(),
            });

            // --- Cursor control: lets the voice anchor be interactive
            //    even when click-through is on globally. Both the anchor
            //    proximity poll and the settings panel contribute to the
            //    "interactive?" decision.
            let cursor_ctl = std::sync::Arc::new(CursorCtl::default());
            app.manage(cursor_ctl.clone());
            window_setup::start_anchor_proximity_poll(app.handle().clone());

            // --- Window setup (transparency, level, collection behavior) ---
            window_setup::configure_main_window(app);

            // --- Push-to-talk & speak-selection keycodes ---
            // The CGEvent tap is the canonical listener for both hotkeys;
            // we deliberately DON'T call `register_shortcut(...)` because
            // Tauri's global_shortcut plugin would consume the event
            // before the tap sees it, so the indicator never lit up.
            if let Some((code, mods)) = hotkeys::parse_shortcut(&saved_shortcut) {
                STT_HOTKEY_KEYCODE.store(code, std::sync::atomic::Ordering::Relaxed);
                STT_HOTKEY_MODIFIERS.store(mods, std::sync::atomic::Ordering::Relaxed);
            }
            {
                let cfg = app.state::<AppSettings>();
                let s = cfg.settings.lock().expect("settings lock");
                if let Some((code, mods)) = hotkeys::parse_shortcut(&s.speak_selection_shortcut) {
                    SPEAK_SEL_HOTKEY_KEYCODE.store(code, std::sync::atomic::Ordering::Relaxed);
                    SPEAK_SEL_HOTKEY_MODIFIERS
                        .store(mods, std::sync::atomic::Ordering::Relaxed);
                }
                SPEAK_SEL_ENABLED.store(s.speak_selection_enabled, std::sync::atomic::Ordering::Relaxed);
                SPEAK_SEL_MIDDLE_CLICK.store(s.speak_selection_middle_click, std::sync::atomic::Ordering::Relaxed);
                SPEAK_SEL_SUMMARIZE.store(s.speak_selection_mode == "summarize", std::sync::atomic::Ordering::Relaxed);
            }

            // --- Auto-speak HTTP server ---
            let auto_speak_enabled = std::sync::Arc::new(
                std::sync::atomic::AtomicBool::new(settings_auto_speak),
            );
            app.manage(auto_speak_enabled.clone());
            speak_server::start(app.handle().clone(), auto_speak_enabled.clone());

            // --- File watcher (polls git status, triggers viz on changes) ---
            {
                let watch_dir = std::env::current_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from("."))
                    .to_string_lossy()
                    .to_string();
                file_watcher::start(
                    app.handle().clone(),
                    watch_dir,
                    auto_speak_enabled.clone(),
                );
            }

            // --- Event-driven reposition: sleep/wake + display hot-plug.
            window_setup::register_screen_event_observers(app.handle().clone());

            // --- Periodic screen check (safety net for any missed notifications).
            //    setFrame_display is a no-op when the frame already matches,
            //    so this is cheap. Runs every 5 s unconditionally — the old
            //    500 px mouse-delta gate was dropped because it could swallow
            //    legitimate wakes where the cursor hadn't moved.
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    window_setup::reposition_to_mouse_screen(&handle);
                });
            }

            // --- First-launch model check ---
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Wait for frontend to be ready
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let mut missing = Vec::new();
                    let tts = handle.state::<TtsState>();
                    let engine = tts.0.lock().expect("tts lock");
                    if !engine.is_model_downloaded("en_US-lessac-low") { missing.push("Lessac (American)"); }
                    if !engine.is_model_downloaded("en_GB-vctk-medium") { missing.push("VCTK (British)"); }
                    drop(engine);
                    let stt = handle.state::<SttState>();
                    let stt_engine = stt.0.lock().expect("stt lock");
                    if !stt_engine.is_active_ready() { missing.push("Speech-to-Text"); }
                    drop(stt_engine);

                    // Check summarizer model
                    let sum = handle.state::<SummarizerState>();
                    let sum_engine = sum.0.lock().expect("summarizer lock");
                    if !sum_engine.is_active_ready() { missing.push("Summarizer"); }
                    drop(sum_engine);

                    if !missing.is_empty() {
                        eprintln!("Missing models: {:?}", missing);
                        let _ = handle.emit("models-missing", serde_json::json!({
                            "missing": missing,
                        }));
                    }
                });
            }

            // --- CGEvent tap (push-to-talk, speak-selection, middle click) ---
            hotkeys::install_event_tap(app.handle().clone());

            // --- System tray ---
            tray::build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
