//! macOS CGEvent tap — the canonical listener for global hotkeys
//! (push-to-talk, speak-selection) and middle-click. Why CGEvent tap
//! rather than Tauri's global_shortcut plugin: the plugin registered
//! for the same key first and consumed events before our tap could
//! see them, so the listening indicator never lit up. The tap also
//! lets us suppress the pass-through (so PageUp doesn't scroll the
//! caret while it's bound to STT).
//!
//! `mouse_event_callback` runs on the CGEvent tap thread. macOS will
//! disable the tap if callbacks take too long, so the callback only
//! flips atomics + dispatches worker threads — no engine locks, no
//! synchronous I/O.
//!
//! `install_event_tap` builds the tap, attaches it to a run loop on a
//! detached thread, and runs that loop forever. Called once during
//! tauri::Builder::setup; after that the OS owns the lifecycle.

use tauri::{Emitter, Manager};
use voice_core::stt;

use crate::event_sink::TauriSink;
use crate::speak;
use crate::state::{
    AppSettings, SttState, SummarizerState, TtsState, GLOBAL_APP_HANDLE, LAST_MIDDLE_CLICK,
    PAUSED, SPEAK_SEL_ENABLED, SPEAK_SEL_HOTKEY_KEYCODE, SPEAK_SEL_HOTKEY_MODIFIERS,
    SPEAK_SEL_MIDDLE_CLICK, STT_HOTKEY_KEYCODE, STT_HOTKEY_MODIFIERS, STT_STOPPING,
    USER_SPEAKING, WAS_DRAGGING,
};

// ── FFI ────────────────────────────────────────────────────────────

#[repr(C)]
#[derive(Copy, Clone)]
pub struct CGPoint {
    pub x: f64,
    pub y: f64,
}

extern "C" {
    fn CGEventCreate(source: *const std::ffi::c_void) -> *const std::ffi::c_void;
    fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    fn CGEventGetFlags(event: *const std::ffi::c_void) -> u64;
    fn CGEventGetIntegerValueField(event: *const std::ffi::c_void, field: u32) -> i64;
    fn CFRelease(cf: *const std::ffi::c_void);

    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(
            proxy: *const std::ffi::c_void,
            event_type: u32,
            event: *const std::ffi::c_void,
            user_info: *mut std::ffi::c_void,
        ) -> *const std::ffi::c_void,
        user_info: *mut std::ffi::c_void,
    ) -> *const std::ffi::c_void;

    fn CFMachPortCreateRunLoopSource(
        allocator: *const std::ffi::c_void,
        port: *const std::ffi::c_void,
        order: i64,
    ) -> *const std::ffi::c_void;

    fn CFRunLoopGetCurrent() -> *const std::ffi::c_void;
    fn CFRunLoopAddSource(
        rl: *const std::ffi::c_void,
        source: *const std::ffi::c_void,
        mode: *const std::ffi::c_void,
    );
    fn CFRunLoopRun();
    fn CGEventTapEnable(tap: *const std::ffi::c_void, enable: bool);

    static kCFRunLoopCommonModes: *const std::ffi::c_void;
}

// CGEvent constants
const K_CG_HID_EVENT_TAP: u32 = 0;
const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
const K_CG_EVENT_OTHER_MOUSE_DOWN: u32 = 25;
const K_CG_EVENT_LEFT_MOUSE_UP: u32 = 2;
const K_CG_EVENT_LEFT_MOUSE_DRAGGED: u32 = 6;
const K_CG_EVENT_KEY_DOWN: u32 = 10;
const K_CG_EVENT_KEY_UP: u32 = 11;
const K_VK_ESCAPE: u16 = 53;
const K_CG_EVENT_FLAG_MASK_SHIFT: u64 = 0x00020000;
pub const K_CG_EVENT_FLAG_MASK_CONTROL: u64 = 0x00040000;
pub const K_CG_EVENT_FLAG_MASK_ALTERNATE: u64 = 0x00080000; // Option
pub const K_CG_EVENT_FLAG_MASK_COMMAND: u64 = 0x00100000;
/// All modifier bits we care about for hotkey matching. Excludes
/// CapsLock / NumPad / Help so an accidentally-stuck CapsLock doesn't
/// break a bare-key binding.
pub const MODIFIER_MASK: u64 = K_CG_EVENT_FLAG_MASK_SHIFT
    | K_CG_EVENT_FLAG_MASK_CONTROL
    | K_CG_EVENT_FLAG_MASK_ALTERNATE
    | K_CG_EVENT_FLAG_MASK_COMMAND;

// ── Public mouse helpers ───────────────────────────────────────────

/// Get the current mouse position (screen coords).
pub fn current_mouse_pos() -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            let point = CGEventGetLocation(event);
            CFRelease(event);
            (point.x, point.y)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        (0.0, 0.0)
    }
}

#[tauri::command]
pub fn get_mouse_position(window: tauri::WebviewWindow) -> (f64, f64, f64, f64, bool) {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let event = CGEventCreate(std::ptr::null());
            let point = CGEventGetLocation(event);
            let flags = CGEventGetFlags(event);
            CFRelease(event);
            let shift = (flags & K_CG_EVENT_FLAG_MASK_SHIFT) != 0;
            let pos = window.outer_position().unwrap_or_default();
            let scale = window.scale_factor().unwrap_or(1.0);
            let wx = pos.x as f64 / scale;
            let wy = pos.y as f64 / scale;
            (point.x, point.y, wx, wy, shift)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        (0.0, 0.0, 0.0, 0.0, false)
    }
}

/// Translate a shortcut settings string into the macOS virtual keycode
/// (CGEvent field 9) plus the modifier flag mask that must also be
/// held. Mirrors the parser on the JS side in
/// `SettingsPanel/components/HotkeyCaptureRow.tsx`; keep them in sync.
///
/// Accepted forms:
/// - Bare key: `"PageDown"`, `"F1"`, `"Home"` — returns `(code, 0)`
/// - Chord:   `"Cmd+Shift+A"`, `"Ctrl+Alt+1"` — returns `(code, mask)`
///
/// Modifier tokens are case-insensitive and order-independent: `cmd`,
/// `ctrl`/`control`, `alt`/`opt`/`option`, `shift`. The final `+`-
/// separated token is the key name.
pub fn parse_shortcut(s: &str) -> Option<(u16, u64)> {
    let mut modifiers: u64 = 0;
    let mut key_part: Option<&str> = None;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Split by '+'. The LAST non-empty segment is the key; everything
    // else is a modifier name. Lower-case for case-insensitive match.
    let segments: Vec<&str> = trimmed.split('+').map(|seg| seg.trim()).collect();
    let last_idx = segments.len() - 1;
    for (i, seg) in segments.iter().enumerate() {
        if i == last_idx {
            if seg.is_empty() {
                return None;
            }
            key_part = Some(*seg);
        } else {
            match seg.to_ascii_lowercase().as_str() {
                "cmd" | "command" | "meta" | "super" => modifiers |= K_CG_EVENT_FLAG_MASK_COMMAND,
                "ctrl" | "control" => modifiers |= K_CG_EVENT_FLAG_MASK_CONTROL,
                "alt" | "opt" | "option" => modifiers |= K_CG_EVENT_FLAG_MASK_ALTERNATE,
                "shift" => modifiers |= K_CG_EVENT_FLAG_MASK_SHIFT,
                _ => return None, // unknown modifier name
            }
        }
    }

    let key = key_part?;
    let code = key_to_keycode(key)?;

    // Safety: letters/digits require at least one modifier to avoid
    // firing on every normal keystroke. Bare nav/function keys are
    // fine because they don't appear in typical typing.
    let is_letter_or_digit = key.len() == 1
        && key
            .chars()
            .next()
            .map(|c| c.is_ascii_alphanumeric())
            .unwrap_or(false);
    if is_letter_or_digit && modifiers == 0 {
        return None;
    }

    Some((code, modifiers))
}

fn key_to_keycode(s: &str) -> Option<u16> {
    // Single-char letter or digit. Letters use kVK_ANSI_*; digits use
    // the top-row number keys (not numpad).
    if s.len() == 1 {
        if let Some(c) = s.chars().next() {
            if c.is_ascii_alphabetic() {
                return letter_keycode(c.to_ascii_uppercase());
            }
            if c.is_ascii_digit() {
                return digit_keycode(c);
            }
        }
    }
    Some(match s {
        "PageUp" => 116,
        "PageDown" => 121,
        "Home" => 115,
        "End" => 119,
        "Insert" => 114,
        "Delete" => 117, // forward-delete; Backspace is 51, skipped on purpose
        "F1" => 122,
        "F2" => 120,
        "F3" => 99,
        "F4" => 118,
        "F5" => 96,
        "F6" => 97,
        "F7" => 98,
        "F8" => 100,
        "F9" => 101,
        "F10" => 109,
        "F11" => 103,
        "F12" => 111,
        "F13" => 105,
        "F14" => 107,
        "F15" => 113,
        "F16" => 106,
        "F17" => 64,
        "F18" => 79,
        "F19" => 80,
        "F20" => 90,
        _ => return None,
    })
}

fn letter_keycode(c: char) -> Option<u16> {
    Some(match c {
        'A' => 0, 'S' => 1, 'D' => 2, 'F' => 3, 'H' => 4, 'G' => 5,
        'Z' => 6, 'X' => 7, 'C' => 8, 'V' => 9, 'B' => 11, 'Q' => 12,
        'W' => 13, 'E' => 14, 'R' => 15, 'Y' => 16, 'T' => 17,
        'U' => 32, 'I' => 34, 'O' => 31, 'P' => 35, 'L' => 37,
        'J' => 38, 'K' => 40, 'N' => 45, 'M' => 46,
        _ => return None,
    })
}

fn digit_keycode(c: char) -> Option<u16> {
    Some(match c {
        '0' => 29, '1' => 18, '2' => 19, '3' => 20, '4' => 21,
        '5' => 23, '6' => 22, '7' => 26, '8' => 28, '9' => 25,
        _ => return None,
    })
}

/// Backwards-compat shim. Old call sites only wanted the keycode; new
/// call sites should use [`parse_shortcut`] and store the modifier mask.
#[allow(dead_code)]
pub fn shortcut_to_keycode(s: &str) -> Option<u16> {
    parse_shortcut(s).map(|(code, _)| code)
}

// ── Event-tap callback ─────────────────────────────────────────────

extern "C" fn mouse_event_callback(
    _proxy: *const std::ffi::c_void,
    event_type: u32,
    event: *const std::ffi::c_void,
    _user_info: *mut std::ffi::c_void,
) -> *const std::ffi::c_void {
    match event_type {
        K_CG_EVENT_OTHER_MOUSE_DOWN => {
            // Middle click → speak selection. Gated by both the master
            // speak-selection enable and the middle-click sub-toggle so
            // users can keep the hotkey while opting out of middle-click.
            if !SPEAK_SEL_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
                || !SPEAK_SEL_MIDDLE_CLICK.load(std::sync::atomic::Ordering::Relaxed)
            {
                return event;
            }
            if let Ok(mut last) = LAST_MIDDLE_CLICK.lock() {
                let now = std::time::Instant::now();
                if let Some(prev) = *last {
                    if now.duration_since(prev).as_millis() < 1000 {
                        return event;
                    }
                }
                *last = Some(now);
            }
            if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                if let Some(handle) = guard.as_ref() {
                    let handle = handle.clone();
                    std::thread::spawn(move || {
                        speak::dispatch_speak_selection(handle);
                    });
                }
            }
        }
        K_CG_EVENT_LEFT_MOUSE_DRAGGED => {
            // Track that a drag happened (likely text selection)
            WAS_DRAGGING.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        K_CG_EVENT_KEY_DOWN => {
            let keycode = unsafe { CGEventGetIntegerValueField(event, 9) } as u16;
            // CGEvent flags carry the current modifier state. Mask to
            // just the four we recognise so an accidentally-stuck
            // CapsLock / NumLock / Help bit doesn't blow up matching.
            let flags = unsafe { CGEventGetFlags(event) } & MODIFIER_MASK;
            if keycode == K_VK_ESCAPE {
                if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                    if let Some(handle) = guard.as_ref() {
                        // Stop TTS
                        let state = handle.state::<TtsState>();
                        let mut engine = state.0.lock().expect("tts lock");
                        engine.stop();
                        drop(engine);
                        // Stop STT if active
                        let stt_state = handle.state::<SttState>();
                        let mut stt = stt_state.0.lock().expect("stt lock");
                        if stt.is_listening() {
                            stt.stop_listening();
                            let _ = handle.emit(
                                "stt-done",
                                stt::SttDoneEvent { text: String::new() },
                            );
                        }
                        drop(stt);
                        let _ = handle.emit("tts-escape", ());
                    }
                }
            } else if SPEAK_SEL_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
                && keycode == SPEAK_SEL_HOTKEY_KEYCODE.load(std::sync::atomic::Ordering::Relaxed)
                && flags == SPEAK_SEL_HOTKEY_MODIFIERS.load(std::sync::atomic::Ordering::Relaxed)
            {
                // Bound speak-selection key down → grab selection, run
                // it through summarizer (if enabled) then TTS. Key-up
                // is ignored for this binding; one press, one read.
                if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                    if let Some(handle) = guard.as_ref() {
                        let handle = handle.clone();
                        std::thread::spawn(move || {
                            speak::dispatch_speak_selection(handle);
                        });
                    }
                }
                // Consume the event so the underlying app doesn't also
                // see the keypress. Without this, a hotkey like PageUp
                // scrolls the focused text field to the top AND
                // triggers our feature — the user sees their caret jump.
                return std::ptr::null();
            } else if keycode == STT_HOTKEY_KEYCODE.load(std::sync::atomic::Ordering::Relaxed)
                && flags == STT_HOTKEY_MODIFIERS.load(std::sync::atomic::Ordering::Relaxed)
            {
                // Bound push-to-talk key down → start voice input.
                //
                // The event-tap callback runs on the CGEvent tap thread;
                // returning fast is critical because macOS will disable
                // the tap if callbacks take too long. We also don't want
                // to hold the SttState mutex on this thread — a mic /
                // cpal init that takes 50-200 ms would stall any JS
                // `get_all_settings` (which also locks SttState) for the
                // same window. Spawning a worker thread fixes both.
                if PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
                    return std::ptr::null();
                }
                if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                    if let Some(handle) = guard.as_ref() {
                        let handle = handle.clone();
                        std::thread::spawn(move || {
                            let already_listening = {
                                let stt_state = handle.state::<SttState>();
                                let stt = stt_state.0.lock().expect("stt lock");
                                stt.is_listening()
                            };
                            if already_listening { return; }

                            // Flip the USER_SPEAKING flag FIRST so any
                            // TTS path that's about to start short-
                            // circuits (do_speak_text, do_speak_selection).
                            // Stays true until the post-STT reply
                            // finishes (or the paste path decides
                            // there's nothing to say) — see KEY_UP below.
                            USER_SPEAKING
                                .store(true, std::sync::atomic::Ordering::Relaxed);

                            // Stop any in-flight TTS first so the mic
                            // doesn't compete with narration. Separate
                            // mutex, not on SttState's critical path.
                            {
                                let tts_state = handle.state::<TtsState>();
                                let mut engine = tts_state.0.lock().expect("tts lock");
                                engine.stop();
                            }
                            let _ = handle.emit("tts-escape", ());
                            // Emit UI-ready event BEFORE the cpal init
                            // so tentacles/sounds react at keypress speed.
                            let _ = handle.emit(
                                "stt-active",
                                serde_json::json!({ "active": true }),
                            );

                            let stt_state = handle.state::<SttState>();
                            let mut stt = stt_state.0.lock().expect("stt lock");
                            match stt.start_listening() {
                                Ok(()) => {
                                    stt.spawn_decode_loop(std::sync::Arc::new(
                                        TauriSink(handle.clone()),
                                    ));
                                }
                                Err(e) => {
                                    eprintln!("STT start error: {}", e);
                                    let _ = handle.emit(
                                        "stt-active",
                                        serde_json::json!({ "active": false }),
                                    );
                                }
                            }
                        });
                    }
                }
                // Consume the event — see speak-sel branch above for why.
                return std::ptr::null();
            }
        }
        K_CG_EVENT_KEY_UP => {
            let keycode = unsafe { CGEventGetIntegerValueField(event, 9) } as u16;
            if keycode == STT_HOTKEY_KEYCODE.load(std::sync::atomic::Ordering::Relaxed) {
                // Bound push-to-talk key up → stop voice input, paste result.
                //
                // Atomic swap guard — if another key-up fires while the
                // prior stop+paste worker is still running, drop this
                // event. compare_exchange-style swap(true) returns the
                // PREVIOUS value; if it was already true, someone else
                // is mid-paste and we bail. Cleared at the end of the
                // worker thread.
                if STT_STOPPING.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    eprintln!("[stt] key-up ignored — prior stop still in flight");
                    return std::ptr::null();
                }
                // We emit `stt-active: false` SYNCHRONOUSLY here (before
                // the worker thread starts) so the UI can react to
                // release the instant the key goes up — not after
                // `stop_listening()` has blocked on the decode loop
                // (which can take ~500 ms). The worker thread still
                // owns the blocking decode + subsequent `stt-done`
                // emission so the final text is available when callers
                // need it.
                if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                    if let Some(handle) = guard.as_ref() {
                        let _ = handle.emit(
                            "stt-active",
                            serde_json::json!({ "active": false }),
                        );
                        let handle = handle.clone();
                        std::thread::spawn(move || {
                            // Fast-path stop: lock only long enough to
                            // flip flags, drop the stream, and snapshot
                            // the audio buffer (~1 ms). The decode runs
                            // OUTSIDE the lock so concurrent JS IPC
                            // (e.g. get_all_settings, which also locks
                            // SttState) doesn't stall for the 300-500 ms
                            // final decode — this is what was freezing
                            // UI animations on release.
                            let snap = {
                                let stt_state = handle.state::<SttState>();
                                let mut stt = stt_state.0.lock().expect("stt lock");
                                stt.snapshot_and_stop()
                            };
                            let final_text = stt::decode_offline(
                                &snap.samples,
                                snap.model,
                                &snap.models_dir,
                            );
                            let _ = handle.emit(
                                "stt-done",
                                stt::SttDoneEvent { text: final_text.clone() },
                            );

                            if !final_text.is_empty() {
                                // Copy to clipboard and paste
                                let _ = std::process::Command::new("osascript")
                                    .args([
                                        "-e",
                                        &format!(
                                            r#"set the clipboard to "{}""#,
                                            final_text.replace('"', "\\\"")
                                        ),
                                    ])
                                    .status();

                                std::thread::sleep(std::time::Duration::from_millis(50));

                                let _ = std::process::Command::new("osascript")
                                    .args([
                                        "-e",
                                        r#"tell application "System Events" to keystroke "v" using command down"#,
                                    ])
                                    .status();

                                // Post-STT personality reply — runs
                                // final_text through the on-device
                                // summariser with the active personality's
                                // reply template, then speaks the one-
                                // sentence result. speak_brief bypasses
                                // USER_SPEAKING gating (it's not a
                                // narrator voice), so we clear the flag
                                // just before calling it so the reply
                                // isn't blocked by its own gate down
                                // the chain.
                                let personality = {
                                    let cfg = handle.state::<AppSettings>();
                                    let s = cfg.settings.lock().expect("settings");
                                    s.personality.clone()
                                };
                                let reply = if personality == "none" {
                                    String::new()
                                } else {
                                    let sum_state = handle.state::<SummarizerState>();
                                    let mut sum = sum_state.0.lock().expect("summarizer lock");
                                    match sum.respond_to_stt(&final_text, &personality) {
                                        Ok(r) => r,
                                        Err(e) => {
                                            eprintln!("[stt-reply] summariser error: {}", e);
                                            String::new()
                                        }
                                    }
                                };
                                USER_SPEAKING
                                    .store(false, std::sync::atomic::Ordering::Relaxed);
                                let trimmed = reply.trim();
                                if !trimmed.is_empty() && trimmed != "SKIP" {
                                    speak::speak_brief(trimmed.to_string(), handle.clone());
                                }
                            } else {
                                // Empty transcript — nothing to paste
                                // or reply to, just clear the flag so
                                // ambient TTS can resume.
                                USER_SPEAKING
                                    .store(false, std::sync::atomic::Ordering::Relaxed);
                            }
                            // Clear the stop-guard at the VERY end so a
                            // new PageUp press can start a fresh
                            // session. Any key-up arriving before this
                            // ran was already dropped by the guard at
                            // the top.
                            STT_STOPPING.store(false, std::sync::atomic::Ordering::Release);
                        });
                    } else {
                        // Guard was claimed but we couldn't access the
                        // app handle — release so future events aren't
                        // permanently blocked.
                        STT_STOPPING.store(false, std::sync::atomic::Ordering::Release);
                    }
                } else {
                    STT_STOPPING.store(false, std::sync::atomic::Ordering::Release);
                }
                // Consume the key-up so the underlying app doesn't see
                // PageUp/Home and jump the caret on release either.
                return std::ptr::null();
            }
        }
        K_CG_EVENT_LEFT_MOUSE_UP => {
            if WAS_DRAGGING.swap(false, std::sync::atomic::Ordering::Relaxed) {
                if let Ok(guard) = GLOBAL_APP_HANDLE.lock() {
                    if let Some(handle) = guard.as_ref() {
                        let handle = handle.clone();
                        // Get mouse position and current shortcut
                        let (mx, my) = current_mouse_pos();
                        let shortcut = {
                            let cfg = handle.state::<AppSettings>();
                            let s = cfg.settings.lock().expect("settings");
                            s.shortcut.clone()
                        };
                        let _ = handle.emit(
                            "tts-hint-show",
                            serde_json::json!({
                                "x": mx,
                                "y": my,
                                "shortcut": shortcut,
                            }),
                        );
                    }
                }
            }
        }
        _ => {}
    }
    event
}

/// Build the CGEvent tap, attach it to a fresh run loop on a detached
/// thread, and run that loop forever. Stashes `app_handle` in
/// `GLOBAL_APP_HANDLE` so the callback can find it without taking
/// arguments. Call once during `tauri::Builder::setup`.
#[cfg(target_os = "macos")]
pub fn install_event_tap(app_handle: tauri::AppHandle) {
    *GLOBAL_APP_HANDLE.lock().expect("global handle") = Some(app_handle);

    std::thread::spawn(|| unsafe {
        // Listen for middle click, left drag, left mouse-up, key down/up.
        let event_mask: u64 = (1 << K_CG_EVENT_OTHER_MOUSE_DOWN)
            | (1 << K_CG_EVENT_LEFT_MOUSE_UP)
            | (1 << K_CG_EVENT_LEFT_MOUSE_DRAGGED)
            | (1 << K_CG_EVENT_KEY_DOWN)
            | (1 << K_CG_EVENT_KEY_UP);
        let tap = CGEventTapCreate(
            K_CG_HID_EVENT_TAP,
            K_CG_HEAD_INSERT_EVENT_TAP,
            K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
            event_mask,
            mouse_event_callback,
            std::ptr::null_mut(),
        );
        if tap.is_null() {
            eprintln!("Failed to create event tap — grant Accessibility permissions");
            return;
        }
        CGEventTapEnable(tap, true);
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        let rl = CFRunLoopGetCurrent();
        CFRunLoopAddSource(rl, source, kCFRunLoopCommonModes);
        CFRunLoopRun(); // blocks forever
    });
}

#[cfg(not(target_os = "macos"))]
pub fn install_event_tap(_app_handle: tauri::AppHandle) {}
