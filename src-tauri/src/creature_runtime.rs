//! Creature runtime — drives `creature-core` from the Tauri main loop.
//!
//! Responsibilities:
//!  - Hold the singleton `Choreographer` + `Orchestrator` for the window's
//!    lifetime, behind a single `Mutex` (low contention; we tick at 60Hz
//!    on one thread and only the command handlers borrow for writes).
//!  - Translate the host's existing Tauri events
//!    (`play-start-sound`, `tts-open`, etc.) into `OrchestratorEvent`s.
//!  - Tick at ~60 Hz on a dedicated thread and emit `creature-frame`
//!    events with the current `TickResult` for the JS renderer.
//!  - Expose Tauri commands the JS side calls for non-event input
//!    (anchor drag, screen resize, direct dispatch).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use creature_core::{
    Choreographer, CreatureOrchestrator, OrchestratorEvent, Phase, Pt, Screen, TaskConfig,
    TickResult,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const TICK_HZ: u64 = 60;
const TICK_MS: f32 = 1000.0 / TICK_HZ as f32;

pub struct CreatureRuntime {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    choreo: Choreographer,
    orch: CreatureOrchestrator,
    anchor: Pt,
    screen: Screen,
    current: Pt,
    prev: Pt,
    running: bool,
}

impl CreatureRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                choreo: Choreographer::new(),
                orch: CreatureOrchestrator::new(),
                anchor: Pt::new(960.0, 540.0),
                screen: Screen {
                    w: 1920.0,
                    h: 1080.0,
                },
                current: Pt::default(),
                prev: Pt::default(),
                running: false,
            })),
        }
    }

    /// Start the 60Hz tick thread. Safe to call multiple times — second
    /// call is a no-op.
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
            g.orch.handle(OrchestratorEvent::Started, anchor, screen);
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

                    let frame: TickResult;
                    let mut dispatch_after_tick: Option<TaskConfig> = None;
                    let mut side_effects = Vec::new();

                    {
                        let mut g = inner.lock().unwrap();
                        if !g.running {
                            break;
                        }
                        let anchor = g.anchor;
                        let screen = g.screen;

                        // Orchestrator timer ticks may produce a dispatch.
                        let out = g.orch.tick(dt, anchor, screen);
                        if let Some(cfg) = out.dispatch {
                            dispatch_after_tick = Some(cfg);
                        }
                        side_effects.extend(out.side_effects);

                        // Choreographer tick uses the *current* position.
                        let cur = g.current;
                        frame = g.choreo.tick(dt, cur, screen);
                        g.prev = cur;
                        g.current = Pt::new(frame.x, frame.y);

                        if let Some(cfg) = dispatch_after_tick.take() {
                            let prev = g.prev;
                            let cur = g.current;
                            g.choreo.dispatch(cfg, Some(cur), Some(prev));
                        }
                    }

                    // Emit outside the lock — avoid holding it across IPC.
                    let _ = app.emit("creature-frame", &frame);
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
        g.orch.handle(OrchestratorEvent::Stopped, anchor, screen);
        g.choreo.stop();
    }
}

impl Default for CreatureRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tauri commands ────────────────────────────────────────────

#[derive(Serialize)]
pub struct CreatureStatus {
    pub running: bool,
    pub phase: Phase,
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
    g.anchor = Pt::new(x, y);
    g.choreo.set_anchor(x, y);
}

#[tauri::command]
pub fn creature_set_screen(w: f32, h: f32, runtime: State<'_, CreatureRuntime>) {
    let mut g = runtime.inner.lock().unwrap();
    g.screen = Screen { w, h };
}

#[tauri::command]
pub fn creature_event(name: String, runtime: State<'_, CreatureRuntime>) {
    let event = match name.as_str() {
        "claude-start" => OrchestratorEvent::ClaudeStart,
        "claude-stop" => OrchestratorEvent::ClaudeStop,
        "tts-open" => OrchestratorEvent::TtsOpen,
        "tts-done" => OrchestratorEvent::TtsDone,
        "tts-escape" => OrchestratorEvent::TtsEscape,
        "drag-start" => OrchestratorEvent::DragStart,
        "drag-end" => OrchestratorEvent::DragEnd,
        "mouse-active" => OrchestratorEvent::MouseIdle(false),
        "mouse-idle" => OrchestratorEvent::MouseIdle(true),
        _ => return,
    };
    let mut g = runtime.inner.lock().unwrap();
    let anchor = g.anchor;
    let screen = g.screen;
    let out = g.orch.handle(event, anchor, screen);
    if let Some(cfg) = out.dispatch {
        let cur = g.current;
        let prev = g.prev;
        g.choreo.dispatch(cfg, Some(cur), Some(prev));
    }
}

#[tauri::command]
pub fn creature_dispatch(config: serde_json::Value, runtime: State<'_, CreatureRuntime>) {
    let cfg: TaskConfig = match serde_json::from_value(config) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut g = runtime.inner.lock().unwrap();
    let cur = g.current;
    let prev = g.prev;
    g.choreo.dispatch(cfg, Some(cur), Some(prev));
}

#[tauri::command]
pub fn creature_status(runtime: State<'_, CreatureRuntime>) -> CreatureStatus {
    let g = runtime.inner.lock().unwrap();
    CreatureStatus {
        running: g.running,
        phase: g.choreo.phase(),
        x: g.current.x,
        y: g.current.y,
    }
}

/// Convenience: register the runtime + commands in one place. Call from
/// `setup` in `lib.rs`.
pub fn register<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(CreatureRuntime::new());
}
