use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Minimal HTTP server on localhost:9877.
/// POST /speak with body text → queues TTS (plays in order).
/// GET /status → returns whether auto-speak is enabled.
pub fn start(
    handle: tauri::AppHandle,
    enabled: Arc<AtomicBool>,
) {
    // Speech queue — single worker processes in order
    let (tx, rx) = mpsc::channel::<String>();
    let speak_handle = handle.clone();
    std::thread::spawn(move || {
        for text in rx {
            super::speak::do_speak_text(speak_handle.clone(), text);
            // Brief pause between queued items so they don't blur together
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    });

    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:9877") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Speak server: failed to bind :9877 — {}", e);
                return;
            }
        };
        eprintln!("Speak server listening on http://127.0.0.1:9877");

        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(&stream);
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).is_err() {
                continue;
            }

            // Parse method and path
            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            let method = parts[0];
            let path = parts[1];

            // Read headers to find Content-Length
            let mut content_length: usize = 0;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                    break;
                }
                if let Some(val) = header.strip_prefix("Content-Length:") {
                    content_length = val.trim().parse().unwrap_or(0);
                }
                if let Some(val) = header.strip_prefix("content-length:") {
                    content_length = val.trim().parse().unwrap_or(0);
                }
            }

            match (method, path) {
                ("POST", "/speak") => {
                    if !enabled.load(Ordering::Relaxed) {
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 24\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"disabled\"}\r\n";
                        let _ = (&stream).write_all(resp.as_bytes());
                        continue;
                    }

                    // Read body
                    let mut body = vec![0u8; content_length];
                    if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&body).trim().to_string();

                    if !text.is_empty() {
                        // Queue for ordered playback
                        let _ = tx.send(text);
                    }

                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/sound") => {
                    // Play a sound effect via the frontend (Howler.js).
                    // Gated on the "muted" work_mode so the user's mute
                    // toggle affects SFX as well as TTS — hooks that post
                    // start/complete/milestone during muted mode get a
                    // 200 back but no sound fires.
                    let mut body = vec![0u8; content_length];
                    if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                        continue;
                    }
                    let which = String::from_utf8_lossy(&body).trim().to_string();
                    if !super::speak::is_muted(&handle) {
                        // Reposition overlay to mouse screen before playing
                        super::window_setup::reposition_to_mouse_screen(&handle);
                        match which.as_str() {
                            "start" => { let _ = handle.emit("play-start-sound", ()); }
                            "complete" => { let _ = handle.emit("play-complete-sound", ()); }
                            "milestone" => { let _ = handle.emit("play-milestone-sound", ()); }
                            _ => {}
                        }
                    }
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("GET", "/status") => {
                    let on = enabled.load(Ordering::Relaxed);
                    let (personality, work_mode) = {
                        let cfg = handle.state::<super::AppSettings>();
                        let s = cfg.settings.lock().unwrap_or_else(|e: std::sync::PoisonError<_>| e.into_inner());
                        (s.personality.clone(), s.work_mode.clone())
                    };
                    let body = format!(
                        "{{\"auto_speak\":{},\"personality\":\"{}\",\"work_mode\":\"{}\"}}",
                        on,
                        personality.replace('"', "\\\""),
                        work_mode.replace('"', "\\\"")
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/summarize") => {
                    // Summarize text using embedded LLM
                    let mut body = vec![0u8; content_length];
                    if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&body).trim().to_string();

                    if text.is_empty() {
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"summary\":\"SKIP\"}\r\n";
                        let _ = (&stream).write_all(resp.as_bytes());
                        continue;
                    }

                    // Honour the tray Pause toggle — return a SKIP so
                    // the caller (hooks) doesn't think the request
                    // failed; auto-speak just goes silent.
                    if super::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"summary\":\"SKIP\"}\r\n";
                        let _ = (&stream).write_all(resp.as_bytes());
                        continue;
                    }

                    let summary = {
                        let state = handle.state::<super::SummarizerState>();
                        let mut engine = state.0.lock().unwrap_or_else(|e| e.into_inner());
                        match engine.summarize(&text) {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("Summarizer error: {}", e);
                                "SKIP".to_string()
                            }
                        }
                    };

                    let body_json = serde_json::json!({ "summary": summary }).to_string();
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}",
                        body_json.len(),
                        body_json
                    );
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/particles") => {
                    // Trigger particle burst at screen center
                    let _ = handle.emit("particles-burst", serde_json::json!({
                        "x": 0, "y": 0, "count": 100
                    }));
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/reposition") | ("GET", "/reposition") => {
                    // Force reposition overlay to current mouse screen
                    super::window_setup::reposition_to_mouse_screen(&handle);
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/settings") | ("GET", "/settings") => {
                    let _ = handle.emit("open-settings", ());
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/plan") => {
                    // Accept todo list JSON, emit as plan-viz-update event
                    let mut body = vec![0u8; content_length];
                    if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                        continue;
                    }
                    let json_str = String::from_utf8_lossy(&body).to_string();
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        let _ = handle.emit("plan-viz-update", &val);
                    }
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                ("POST", "/viz") => {
                    // Trigger folder viz for a given path
                    let mut body = vec![0u8; content_length];
                    if std::io::Read::read_exact(&mut reader, &mut body).is_err() {
                        continue;
                    }
                    let path = String::from_utf8_lossy(&body).trim().to_string();
                    if !path.is_empty() {
                        let _ = handle.emit("folder-viz-show", serde_json::json!({
                            "path": path,
                            "max_depth": 4,
                        }));
                    }
                    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 16\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"ok\"}\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
                _ => {
                    let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                    let _ = (&stream).write_all(resp.as_bytes());
                }
            }
        }
    });
}
