//! Creature runtime — drives the prebuilt creature-core static lib
//! from the Tauri main loop.
//!
//! The IP (choreography + orchestrator) lives as a stripped static
//! library at `src-tauri/vendor/<target>/libcreature_core.a`, built
//! from the private `companion/creature-core` repo and committed here
//! so anyone can `cargo build` tink without companion access.
//!
//! This module:
//!   - Declares the C ABI exposed by libcreature_core.
//!   - Wraps it in safe Rust handles (`Choreo`, `Orch`) with Drop.
//!   - Spawns a 60Hz tick thread that calls into the lib and emits
//!     `creature-frame` events to the JS renderer.
//!   - Exposes Tauri commands the JS side calls for non-event input.

use std::ffi::{c_char, CStr, CString};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const TICK_HZ: u64 = 60;

// ── FFI declarations (matches ffi.rs in creature-core) ─────────

#[link(name = "creature_core", kind = "static")]
extern "C" {
    fn creature_choreo_new() -> *mut std::ffi::c_void;
    fn creature_choreo_free(h: *mut std::ffi::c_void);
    fn creature_choreo_dispatch(
        h: *mut std::ffi::c_void,
        config_json: *const c_char,
        cur_x: f32,
        cur_y: f32,
        prev_x: f32,
        prev_y: f32,
    ) -> i32;
    fn creature_choreo_tick(
        h: *mut std::ffi::c_void,
        dt: f32,
        cur_x: f32,
        cur_y: f32,
        screen_w: f32,
        screen_h: f32,
    ) -> *mut c_char;
    fn creature_choreo_stop(h: *mut std::ffi::c_void);
    fn creature_choreo_set_anchor(h: *mut std::ffi::c_void, x: f32, y: f32);

    fn creature_orch_new() -> *mut std::ffi::c_void;
    fn creature_orch_free(h: *mut std::ffi::c_void);
    fn creature_orch_handle(
        h: *mut std::ffi::c_void,
        event_kind: i32,
        anchor_x: f32,
        anchor_y: f32,
        screen_w: f32,
        screen_h: f32,
    ) -> *mut c_char;
    fn creature_orch_tick(
        h: *mut std::ffi::c_void,
        dt: f32,
        anchor_x: f32,
        anchor_y: f32,
        screen_w: f32,
        screen_h: f32,
    ) -> *mut c_char;

    fn creature_string_free(s: *mut c_char);
}

// ── Safe Rust handles ──────────────────────────────────────────

struct Choreo(*mut std::ffi::c_void);
unsafe impl Send for Choreo {}
unsafe impl Sync for Choreo {}
impl Choreo {
    fn new() -> Self {
        Self(unsafe { creature_choreo_new() })
    }
    fn dispatch(&self, config_json: &str, cur: (f32, f32), prev: (f32, f32)) -> i32 {
        let c = CString::new(config_json).unwrap_or_default();
        unsafe { creature_choreo_dispatch(self.0, c.as_ptr(), cur.0, cur.1, prev.0, prev.1) }
    }
    fn tick(&self, dt: f32, cur: (f32, f32), screen: (f32, f32)) -> Option<TickResult> {
        let raw = unsafe { creature_choreo_tick(self.0, dt, cur.0, cur.1, screen.0, screen.1) };
        if raw.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { creature_string_free(raw) };
        serde_json::from_str(&s).ok()
    }
    fn stop(&self) {
        unsafe { creature_choreo_stop(self.0) };
    }
    fn set_anchor(&self, x: f32, y: f32) {
        unsafe { creature_choreo_set_anchor(self.0, x, y) };
    }
}
impl Drop for Choreo {
    fn drop(&mut self) {
        unsafe { creature_choreo_free(self.0) };
    }
}

struct Orch(*mut std::ffi::c_void);
unsafe impl Send for Orch {}
unsafe impl Sync for Orch {}
impl Orch {
    fn new() -> Self {
        Self(unsafe { creature_orch_new() })
    }
    fn handle(&self, kind: i32, anchor: (f32, f32), screen: (f32, f32)) -> Option<OrchOutput> {
        let raw = unsafe { creature_orch_handle(self.0, kind, anchor.0, anchor.1, screen.0, screen.1) };
        if raw.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { creature_string_free(raw) };
        serde_json::from_str(&s).ok()
    }
    fn tick(&self, dt: f32, anchor: (f32, f32), screen: (f32, f32)) -> Option<OrchOutput> {
        let raw = unsafe { creature_orch_tick(self.0, dt, anchor.0, anchor.1, screen.0, screen.1) };
        if raw.is_null() {
            return None;
        }
        let s = unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned();
        unsafe { creature_string_free(raw) };
        serde_json::from_str(&s).ok()
    }
}
impl Drop for Orch {
    fn drop(&mut self) {
        unsafe { creature_orch_free(self.0) };
    }
}

// ── Serde types matching protocol.rs in creature-core ──────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TickResult {
    x: f32,
    y: f32,
    phase: String,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct OrchOutput {
    #[serde(default)]
    dispatch: Option<serde_json::Value>,
    #[serde(default)]
    side_effects: Vec<String>,
}

// Event kind enum mirroring ffi.rs.
fn event_kind(name: &str) -> Option<i32> {
    Some(match name {
        "started" => 0,
        "stopped" => 1,
        "claude-start" => 2,
        "claude-stop" => 3,
        "tts-open" => 4,
        "tts-done" => 5,
        "tts-escape" => 6,
        "drag-start" => 7,
        "drag-end" => 8,
        "mouse-active" => 9,
        "mouse-idle" => 10,
        _ => return None,
    })
}

// ── Runtime ────────────────────────────────────────────────────

pub struct CreatureRuntime {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    choreo: Choreo,
    orch: Orch,
    anchor: (f32, f32),
    screen: (f32, f32),
    current: (f32, f32),
    prev: (f32, f32),
    running: bool,
}

impl CreatureRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                choreo: Choreo::new(),
                orch: Orch::new(),
                anchor: (960.0, 540.0),
                screen: (1920.0, 1080.0),
                current: (0.0, 0.0),
                prev: (0.0, 0.0),
                running: false,
            })),
        }
    }

    pub fn start(&self, app: AppHandle) {
        let inner = Arc::clone(&self.inner);
        {
            let mut g = inner.lock().unwrap();
            if g.running {
                return;
            }
            g.running = true;
            let anchor = g.anchor;
            let screen = g.screen;
            g.orch.handle(0, anchor, screen);
        }

        std::thread::Builder::new()
            .name("creature-tick".into())
            .spawn(move || {
                let tick = Duration::from_millis(1000 / TICK_HZ);
                let mut last = Instant::now();
                loop {
                    std::thread::sleep(tick);
                    let now = Instant::now();
                    let dt = (now - last).as_secs_f32() * 1000.0;
                    last = now;

                    let mut frame: Option<TickResult> = None;
                    let mut side_effects: Vec<String> = Vec::new();

                    {
                        let mut g = inner.lock().unwrap();
                        if !g.running {
                            break;
                        }
                        let anchor = g.anchor;
                        let screen = g.screen;

                        if let Some(out) = g.orch.tick(dt, anchor, screen) {
                            side_effects.extend(out.side_effects);
                            if let Some(cfg) = out.dispatch {
                                let json = cfg.to_string();
                                let prev = g.prev;
                                let cur = g.current;
                                g.choreo.dispatch(&json, cur, prev);
                            }
                        }

                        let cur = g.current;
                        let tick_result = g.choreo.tick(dt, cur, screen);
                        if let Some(r) = tick_result {
                            g.prev = cur;
                            g.current = (r.x, r.y);
                            frame = Some(r);
                        }
                    }

                    if let Some(f) = frame {
                        let _ = app.emit("creature-frame", &f);
                    }
                    for sx in side_effects {
                        let _ = app.emit("creature-side-effect", &sx);
                    }
                }
            })
            .expect("failed to spawn creature-tick thread");
    }

    pub fn stop(&self) {
        let mut g = self.inner.lock().unwrap();
        g.running = false;
        let anchor = g.anchor;
        let screen = g.screen;
        g.orch.handle(1, anchor, screen);
        g.choreo.stop();
    }
}

impl Default for CreatureRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ─────────────────────────────────────────────

#[derive(Serialize)]
pub struct CreatureStatus {
    pub running: bool,
    pub x: f32,
    pub y: f32,
}

#[tauri::command]
pub fn creature_start(app: AppHandle, runtime: State<'_, CreatureRuntime>) {
    runtime.start(app);
}

#[tauri::command]
pub fn creature_stop(runtime: State<'_, CreatureRuntime>) {
    runtime.stop();
}

#[tauri::command]
pub fn creature_set_anchor(x: f32, y: f32, runtime: State<'_, CreatureRuntime>) {
    let mut g = runtime.inner.lock().unwrap();
    g.anchor = (x, y);
    g.choreo.set_anchor(x, y);
}

#[tauri::command]
pub fn creature_set_screen(w: f32, h: f32, runtime: State<'_, CreatureRuntime>) {
    let mut g = runtime.inner.lock().unwrap();
    g.screen = (w, h);
}

#[tauri::command]
pub fn creature_event(name: String, runtime: State<'_, CreatureRuntime>) {
    let Some(kind) = event_kind(&name) else {
        return;
    };
    let mut g = runtime.inner.lock().unwrap();
    let anchor = g.anchor;
    let screen = g.screen;
    if let Some(out) = g.orch.handle(kind, anchor, screen) {
        if let Some(cfg) = out.dispatch {
            let json = cfg.to_string();
            let cur = g.current;
            let prev = g.prev;
            g.choreo.dispatch(&json, cur, prev);
        }
    }
}

#[tauri::command]
pub fn creature_dispatch(config: serde_json::Value, runtime: State<'_, CreatureRuntime>) {
    let json = config.to_string();
    let g = runtime.inner.lock().unwrap();
    let cur = g.current;
    let prev = g.prev;
    g.choreo.dispatch(&json, cur, prev);
}

#[tauri::command]
pub fn creature_status(runtime: State<'_, CreatureRuntime>) -> CreatureStatus {
    let g = runtime.inner.lock().unwrap();
    CreatureStatus {
        running: g.running,
        x: g.current.0,
        y: g.current.1,
    }
}

pub fn register<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(CreatureRuntime::new());
}
