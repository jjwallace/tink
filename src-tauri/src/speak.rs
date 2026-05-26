//! TTS dispatch pipeline — every path that ends with audio coming
//! out of the speaker lives here.
//!
//! Two main flows:
//!
//! - **`do_speak_text`** (auto-speak / hooks): full narrator pipeline
//!   that emits `tts-open`, `tts-sentence`, `tts-done` so the sine
//!   wave + paragraph reader + flow particles all light up.
//! - **`do_speak_selection`** (middle-click / PageUp hotkey): same
//!   shape as do_speak_text but starts from the active selection,
//!   optionally routed through the summarizer first.
//!
//! Plus two short paths:
//! - **`speak_brief`** Tauri command: brief one-shot ack used for
//!   mode-change chirps, anchor labels, etc. Skips all UI events
//!   (no `tts-open` / `tts-done`) so visualisations stay quiet.
//! - **`stop_speaking`** Tauri command: instant cancel of the active
//!   session via `engine.stop()`.
//!
//! Common machinery: `TtsSessionGuard` (RAII guard around session_active
//! that runs `end_session()` on any exit path so a panic / early-return
//! doesn't leak the active flag and stick the next caller for 60 s),
//! `tts_enabled`, `is_muted`, `user_speaking`.
//!
//! `dispatch_speak_selection` reads SPEAK_SEL_SUMMARIZE atomically once
//! and routes to do_speak_selection — called from the CGEvent tap, so
//! it must NOT touch the SttState mutex on the tap thread.

use tauri::{Emitter, Manager};
use voice_core::tts;

use crate::state::{
    AppSettings, SummarizerState, TtsState, PAUSED, SPEAK_SEL_SUMMARIZE, USER_SPEAKING,
};
use crate::hotkeys::current_mouse_pos;
use crate::window_setup::reposition_to_mouse_screen;
use crate::TauriSink;

#[tauri::command]
pub fn stop_speaking(state: tauri::State<TtsState>) {
    let mut engine = state.0.lock().expect("tts lock");
    engine.stop();
}

pub fn tts_enabled(handle: &tauri::AppHandle) -> bool {
    let state = handle.state::<AppSettings>();
    let s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    s.tts_enabled
}

/// True when the user has put the anchor in "muted" mode (the
/// solid-red ring on the voice anchor). Used to silence TTS narration
/// and SFX. UI feedback chirps (e.g. the mode-change announcement in
/// speak_brief) deliberately bypass this so the user still gets
/// confirmation when toggling modes.
pub fn is_muted(handle: &tauri::AppHandle) -> bool {
    let state = handle.state::<AppSettings>();
    let s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
    s.work_mode == "muted"
}

/// True while the user is holding push-to-talk. All TTS paths check
/// this and early-return, so the narrator / auto-speak / speak-selection
/// can't talk over the user. Cleared after final decode + paste +
/// personality reply are done.
pub fn user_speaking() -> bool {
    USER_SPEAKING.load(std::sync::atomic::Ordering::Relaxed)
}

/// Entry point called by middle-click and the speak-selection hotkey.
/// Reads the current `SPEAK_SEL_SUMMARIZE` flag and routes to the
/// appropriate path so the atomic is consulted exactly once per press.
pub fn dispatch_speak_selection(handle: tauri::AppHandle) {
    let summarize = SPEAK_SEL_SUMMARIZE.load(std::sync::atomic::Ordering::Relaxed);
    do_speak_selection(handle, summarize);
}

// ── Session guard ──────────────────────────────────────────────────

/// RAII guard that ensures `end_session()` runs and `tts-done` is
/// emitted on EVERY exit path from a TTS playback scope — including
/// panic or early return. Without this, any path that bails without
/// calling `end_session()` leaks `session_active`, and the next speak
/// request's `is_playing()` wait-loop spins for 60 s (CLAUDE.md #3).
///
/// Construct AFTER `start_session()` has fired. Call `release()` at
/// the normal end of the function to run cleanup once; on any other
/// exit path (panic, ? early-return) Drop runs it.
struct TtsSessionGuard {
    handle: tauri::AppHandle,
    emit_done: bool,
    released: bool,
}

impl TtsSessionGuard {
    /// For full narrator paths (do_speak_text, do_speak_selection)
    /// that expect tts-open / tts-done to bookend their playback.
    fn new(handle: tauri::AppHandle) -> Self {
        Self { handle, emit_done: true, released: false }
    }

    /// For speak_brief: ends the session flag on drop but does NOT
    /// emit tts-done. The brief-ack path deliberately skips
    /// tts-open / tts-done so sine-waves / paragraph-reader /
    /// flow-particles stay dormant for mode chirps and STT
    /// acknowledgements.
    fn new_silent(handle: tauri::AppHandle) -> Self {
        Self { handle, emit_done: false, released: false }
    }

    fn release(mut self) {
        self.cleanup();
        self.released = true;
    }

    fn cleanup(&self) {
        let state = self.handle.state::<TtsState>();
        let engine = state.0.lock().expect("tts lock");
        engine.end_session();
        drop(engine);
        if self.emit_done {
            let _ = self.handle.emit("tts-done", ());
        }
    }
}

impl Drop for TtsSessionGuard {
    fn drop(&mut self) {
        if !self.released {
            eprintln!("[tts] session guard: Drop fired without explicit release — running cleanup");
            self.cleanup();
        }
    }
}

// ── Pipelines ──────────────────────────────────────────────────────

/// Speak-selection: sentence-by-sentence pipeline.
/// 1. Grab text; optionally run through summarizer
/// 2. Split into sentences
/// 3. Emit tts-open (shows panel with spinner)
/// 4. For each sentence: generate TTS, emit tts-sentence, play, wait
/// 5. Emit tts-done when finished
pub fn do_speak_selection(handle: tauri::AppHandle, summarize: bool) {
    if !tts_enabled(&handle) || is_muted(&handle) || user_speaking() { return; }
    reposition_to_mouse_screen(&handle);
    std::thread::spawn(move || {
        let (mouse_x, mouse_y) = current_mouse_pos();
        let raw = match tts::grab_selected_text() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("grab_selected_text: {}", e);
                return;
            }
        };

        // Summarize path: route the raw selection through SmolLM2
        // before TTS. On "SKIP" or error we fall back to verbatim text
        // so the user still hears something — matches the narrator flow.
        let text = if summarize {
            let sum_state = handle.state::<SummarizerState>();
            let mut engine = sum_state.0.lock().expect("summarizer lock");
            match engine.summarize(&raw) {
                Ok(s) if !s.is_empty() && s.trim() != "SKIP" => s,
                Ok(_) => {
                    eprintln!("summarize: SKIP, falling back to verbatim");
                    tts::strip_markdown(&raw)
                }
                Err(e) => {
                    eprintln!("summarize error: {}, falling back to verbatim", e);
                    tts::strip_markdown(&raw)
                }
            }
        } else {
            tts::strip_markdown(&raw)
        };
        let sentences = tts::split_sentences(&text);
        if sentences.is_empty() {
            return;
        }

        // Wait for any currently playing speech to finish before
        // cutting in, then atomically claim the session via
        // try_start_session() — check + start live inside the same
        // mutex acquisition so two racing threads can't both see idle
        // and both call start_session.
        let wait_start = std::time::Instant::now();
        let max_wait = std::time::Duration::from_secs(60);
        let (cancel, sink_holder) = loop {
            let state = handle.state::<TtsState>();
            let mut engine = state.0.lock().expect("tts lock");
            if let Some(session) = engine.try_start_session() {
                break session;
            }
            drop(engine);
            if wait_start.elapsed() > max_wait {
                eprintln!("do_speak_selection: is_playing stuck for >60s, starting anyway");
                let state = handle.state::<TtsState>();
                let mut engine = state.0.lock().expect("tts lock");
                break engine.start_session();
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };

        // Session now active — guard cleans up on ANY exit (panic,
        // early return, natural end). Must be constructed AFTER
        // start_session so an unused guard doesn't prematurely end a
        // session that hasn't begun.
        let session_guard = TtsSessionGuard::new(handle.clone());

        let display = {
            let cfg = handle.state::<AppSettings>();
            let s = cfg.settings.lock().expect("settings");
            s.display.clone()
        };

        let _ = handle.emit("tts-hint-hide", ());
        let _ = handle.emit("tts-open", &tts::OpenEvent {
            sentences: sentences.clone(),
            display,
            mouse_x,
            mouse_y,
        });

        eprintln!("TTS: {} sentences to process", sentences.len());
        for (i, sentence) in sentences.iter().enumerate() {
            eprintln!("TTS sentence {}/{}: {} chars", i + 1, sentences.len(), sentence.len());
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }

            let gen_result = {
                let state = handle.state::<TtsState>();
                let mut engine = state.0.lock().expect("tts lock");
                engine.generate_sentence(sentence)
            };

            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }

            match gen_result {
                Ok((timings, samples, sample_rate)) => {
                    let duration = samples.len() as f64 / sample_rate as f64;

                    // Peak amplitude — one pass, normalized assuming
                    // sherpa outputs roughly ±1.0 floats. Clamp to 0..1
                    // so the frontend doesn't have to guess a range.
                    let peak = samples
                        .iter()
                        .map(|s| s.abs())
                        .fold(0.0f32, f32::max)
                        .min(1.0);

                    let _ = handle.emit("tts-sentence", &tts::SentenceEvent {
                        index: i,
                        words: timings,
                        duration,
                        level: peak,
                    });

                    if let Ok((_stream, stream_handle)) = rodio::OutputStream::try_default() {
                        if let Ok(sink) = rodio::Sink::try_new(&stream_handle) {
                            let samples_arc = std::sync::Arc::new(samples);
                            let source = rodio::buffer::SamplesBuffer::new(
                                1, sample_rate, (*samples_arc).clone(),
                            );
                            sink.append(source);
                            tts::spawn_amplitude_emitter(
                                std::sync::Arc::new(TauriSink(handle.clone())),
                                samples_arc,
                                sample_rate,
                                cancel.clone(),
                            );

                            if let Ok(mut s) = sink_holder.lock() {
                                *s = Some(sink);
                            }

                            loop {
                                if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                                    let taken = sink_holder.lock().ok().and_then(|mut s| s.take());
                                    if let Some(sink) = taken {
                                        tts::spawn_fade_out(sink);
                                    }
                                    break;
                                }
                                if let Ok(s) = sink_holder.lock() {
                                    if let Some(ref sink) = *s {
                                        if sink.empty() {
                                            break;
                                        }
                                    } else {
                                        break;
                                    }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(30));
                            }

                            if !cancel.load(std::sync::atomic::Ordering::SeqCst)
                                && i + 1 < sentences.len()
                            {
                                std::thread::sleep(std::time::Duration::from_millis(300));
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("TTS error for sentence {}: {}", i, e);
                }
            }
        }

        session_guard.release();
    });
}

/// Speak arbitrary text (used by the HTTP server for auto-speak).
/// Called sequentially from the audio queue worker thread.
pub fn do_speak_text(handle: tauri::AppHandle, raw_text: String) {
    if PAUSED.load(std::sync::atomic::Ordering::Relaxed) { return; }
    if !tts_enabled(&handle) || is_muted(&handle) || user_speaking() { return; }
    reposition_to_mouse_screen(&handle);
    let text = tts::strip_markdown(&raw_text);
    let sentences = tts::split_sentences(&text);
    if sentences.is_empty() {
        return;
    }

    let wait_start = std::time::Instant::now();
    let max_wait = std::time::Duration::from_secs(60);
    let (cancel, sink_holder) = loop {
        let state = handle.state::<TtsState>();
        let mut engine = state.0.lock().expect("tts lock");
        if let Some(session) = engine.try_start_session() {
            break session;
        }
        drop(engine);
        if wait_start.elapsed() > max_wait {
            eprintln!("do_speak_text: is_playing stuck for >60s, starting anyway");
            let state = handle.state::<TtsState>();
            let mut engine = state.0.lock().expect("tts lock");
            break engine.start_session();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };

    let session_guard = TtsSessionGuard::new(handle.clone());

    let display = {
        let cfg = handle.state::<AppSettings>();
        let s = cfg.settings.lock().expect("settings");
        s.display.clone()
    };

    let _ = handle.emit("tts-hint-hide", ());
    let _ = handle.emit("tts-open", &tts::OpenEvent {
        sentences: sentences.clone(),
        display,
        mouse_x: 0.0,
        mouse_y: 0.0,
    });

    eprintln!("TTS (auto): {} sentences", sentences.len());
    for (i, sentence) in sentences.iter().enumerate() {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        let gen_result = {
            let state = handle.state::<TtsState>();
            let mut engine = state.0.lock().expect("tts lock");
            engine.generate_sentence(sentence)
        };

        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        match gen_result {
            Ok((timings, samples, sample_rate)) => {
                let duration = samples.len() as f64 / sample_rate as f64;
                let peak = samples
                    .iter()
                    .map(|s| s.abs())
                    .fold(0.0f32, f32::max)
                    .min(1.0);
                let _ = handle.emit("tts-sentence", &tts::SentenceEvent {
                    index: i,
                    words: timings,
                    duration,
                    level: peak,
                });

                if let Ok((_stream, stream_handle)) = rodio::OutputStream::try_default() {
                    if let Ok(sink) = rodio::Sink::try_new(&stream_handle) {
                        let samples_arc = std::sync::Arc::new(samples);
                        let source = rodio::buffer::SamplesBuffer::new(
                            1, sample_rate, (*samples_arc).clone(),
                        );
                        sink.append(source);
                        tts::spawn_amplitude_emitter(
                            std::sync::Arc::new(TauriSink(handle.clone())),
                            samples_arc,
                            sample_rate,
                            cancel.clone(),
                        );
                        if let Ok(mut s) = sink_holder.lock() {
                            *s = Some(sink);
                        }
                        loop {
                            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                                let taken = sink_holder.lock().ok().and_then(|mut s| s.take());
                                if let Some(sink) = taken {
                                    tts::spawn_fade_out(sink);
                                }
                                break;
                            }
                            if let Ok(s) = sink_holder.lock() {
                                if let Some(ref sink) = *s {
                                    if sink.empty() { break; }
                                } else {
                                    break;
                                }
                            }
                            std::thread::sleep(std::time::Duration::from_millis(30));
                        }
                        if !cancel.load(std::sync::atomic::Ordering::SeqCst) && i + 1 < sentences.len() {
                            std::thread::sleep(std::time::Duration::from_millis(300));
                        }
                    }
                }
            }
            Err(e) => eprintln!("TTS error: {}", e),
        }
    }

    session_guard.release();
}

/// Speak a short UI confirmation phrase through the app's VITS voice
/// WITHOUT emitting `tts-open`, `tts-sentence`, `tts-done`, or any
/// display events — so sine waves, paragraph reader, flow particles
/// stay dormant. Cuts in on any currently-playing speech because the
/// caller (anchor mode click) is a deliberate user action that
/// expects instant feedback.
#[tauri::command]
pub fn speak_brief(text: String, handle: tauri::AppHandle) {
    if PAUSED.load(std::sync::atomic::Ordering::Relaxed) { return; }
    if !tts_enabled(&handle) { return; }
    std::thread::spawn(move || {
        let stripped = tts::strip_markdown(&text);
        let sentences = tts::split_sentences(&stripped);
        if sentences.is_empty() {
            return;
        }

        // start_session cancels any prior session. Brief cut-in is
        // the desired behavior here — user just changed modes and
        // wants the new mode announced immediately.
        let (cancel, sink_holder) = {
            let state = handle.state::<TtsState>();
            let mut engine = state.0.lock().expect("tts lock");
            engine.start_session()
        };

        // Silent guard — always ends the session flag on exit (incl.
        // panic) but does NOT emit tts-done, matching this path's
        // "invisible" contract with the rest of the UI.
        let session_guard = TtsSessionGuard::new_silent(handle.clone());

        for sentence in sentences.iter() {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let gen_result = {
                let state = handle.state::<TtsState>();
                let mut engine = state.0.lock().expect("tts lock");
                // Faster rate than normal narration — brief acks
                // should land snappily. VITS flattens inflection on
                // short phrases at 1.0× speed, which sounded passive
                // ("Noted." with a long trailing pause). 1.18× feels
                // assertive and clipped without sounding rushed.
                engine.generate_sentence_with_speed(sentence, 1.18)
            };
            match gen_result {
                Ok((_timings, samples, sample_rate)) => {
                    if let Ok((_stream, stream_handle)) = rodio::OutputStream::try_default() {
                        if let Ok(sink) = rodio::Sink::try_new(&stream_handle) {
                            let source = rodio::buffer::SamplesBuffer::new(
                                1, sample_rate, samples,
                            );
                            sink.append(source);
                            if let Ok(mut s) = sink_holder.lock() {
                                *s = Some(sink);
                            }
                            loop {
                                if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                                    let taken = sink_holder.lock().ok().and_then(|mut s| s.take());
                                    if let Some(sink) = taken {
                                        tts::spawn_fade_out(sink);
                                    }
                                    break;
                                }
                                if let Ok(s) = sink_holder.lock() {
                                    if let Some(ref sink) = *s {
                                        if sink.empty() { break; }
                                    } else {
                                        break;
                                    }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(30));
                            }
                        }
                    }
                }
                Err(e) => eprintln!("[speak_brief] TTS error: {}", e),
            }
        }
        session_guard.release();
    });
}
