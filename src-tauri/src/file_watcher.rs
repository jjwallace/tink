use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

/// Polls git status and emits events for added/removed files with details.
pub fn start(handle: tauri::AppHandle, watch_dir: String, enabled: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut last_status = get_git_status(&watch_dir);
        eprintln!("File watcher started for: {}", watch_dir);

        loop {
            std::thread::sleep(std::time::Duration::from_secs(3));

            if !enabled.load(Ordering::Relaxed) {
                continue;
            }

            let current = get_git_status(&watch_dir);
            if current == last_status {
                continue;
            }

            let added: Vec<_> = current.difference(&last_status).cloned().collect();
            let removed: Vec<_> = last_status.difference(&current).cloned().collect();

            if added.is_empty() && removed.is_empty() {
                last_status = current;
                continue;
            }

            // Extract file names from git status lines (format: "XY path")
            let extract_name = |s: &str| -> String {
                let path_str = if s.len() > 3 { s[3..].trim().trim_matches('"') } else { s };
                Path::new(path_str)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.to_string())
            };

            let extract_path = |s: &str| -> String {
                if s.len() > 3 { s[3..].trim().trim_matches('"').to_string() } else { s.to_string() }
            };

            let added_names: Vec<_> = added.iter().map(|s| extract_name(s)).collect();
            let added_paths: Vec<_> = added.iter().map(|s| extract_path(s)).collect();
            let removed_names: Vec<_> = removed.iter().map(|s| extract_name(s)).collect();
            let removed_paths: Vec<_> = removed.iter().map(|s| extract_path(s)).collect();

            // Speech
            let mut speech_parts = Vec::new();
            if !added_names.is_empty() {
                if added_names.len() <= 3 {
                    speech_parts.push(format!("Added: {}", added_names.join(", ")));
                } else {
                    speech_parts.push(format!("{} files added", added_names.len()));
                }
            }
            if !removed_names.is_empty() {
                if removed_names.len() <= 3 {
                    speech_parts.push(format!("Removed: {}", removed_names.join(", ")));
                } else {
                    speech_parts.push(format!("{} files removed", removed_names.len()));
                }
            }
            let speech = speech_parts.join(". ");

            // Emit viz and chart events
            let _ = handle.emit(
                "folder-viz-show",
                serde_json::json!({
                    "path": watch_dir,
                    "max_depth": 3,
                    "speak": speech,
                    "added_files": added_paths,
                    "removed_files": removed_paths,
                }),
            );

            last_status = current;
        }
    });
}

fn get_git_status(dir: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain", "-u"])
        .current_dir(dir)
        .output();

    if let Ok(out) = output {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.len() >= 3 {
                set.insert(line.to_string());
            }
        }
    }
    set
}
