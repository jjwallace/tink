//! Tauri command modules — one file per domain.
//!
//! Each command file contains only `#[tauri::command]` functions plus
//! the helpers they need. Cross-domain logic (the speak pipeline, the
//! event tap, window management) lives in dedicated top-level modules,
//! not here. Adding a new command: pick the matching file, add the fn,
//! then register it in `lib.rs`'s `tauri::generate_handler!` list.

pub mod misc;
pub mod settings;
pub mod stt;
pub mod summarizer;
pub mod voice;
