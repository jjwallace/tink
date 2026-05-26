//! Process-wide app state — Tauri-managed structs (engine holders) and
//! the lock-free atomics that gate hot paths (event tap, TTS dispatch,
//! tray menu).
//!
//! Why one module: every other module in this crate touches at least
//! one of these. Centralising lets you grep a single file to see the
//! complete state surface, including who can write each atomic and
//! the ordering constraints between them.
//!
//! Convention: structs at the top, atomics + mutexes at the bottom.
//! Atomic names are SCREAMING_SNAKE; expose them as `pub static` so
//! consumers go through `state::PAUSED` rather than re-defining.
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::Mutex;

use voice_core::{stt::SttEngine, summarizer::Summarizer, tts::TtsEngine};

use crate::settings::Settings;

// ── Tauri-managed engine holders ───────────────────────────────────

pub struct TtsState(pub Mutex<TtsEngine>);
pub struct SttState(pub Mutex<SttEngine>);
pub struct SummarizerState(pub Mutex<Summarizer>);
pub struct SfxDir(pub std::path::PathBuf);

pub struct AppSettings {
    pub settings: Mutex<Settings>,
    pub data_dir: std::path::PathBuf,
}

/// Tracks reasons the window wants cursor events (not click-through).
/// When any reason is true the window is interactive; when all are
/// false, the overlay goes click-through so mouse events pass to apps
/// behind. Managed via `Arc<CursorCtl>` so multiple modules can mutate
/// without owning the value.
#[derive(Default)]
pub struct CursorCtl {
    pub settings_open: AtomicBool,
    pub anchor_hover: AtomicBool,
    /// True while the user is actively dragging the anchor. Without
    /// this the cursor would leave the anchor's hover radius mid-drag
    /// (the saved anchor position doesn't update until mouseup), the
    /// proximity poll would flip the window back to click-through, and
    /// `document.mousemove` / `mouseup` would never reach the webview
    /// — so the drag would just die. Set from JS via
    /// `set_anchor_dragging`.
    pub anchor_dragging: AtomicBool,
}

impl CursorCtl {
    pub fn is_interactive(&self) -> bool {
        self.settings_open.load(Ordering::Relaxed)
            || self.anchor_hover.load(Ordering::Relaxed)
            || self.anchor_dragging.load(Ordering::Relaxed)
    }
}

// ── Hotkey codes (live, mutable from settings) ─────────────────────

/// Live STT hotkey keycode — read by the event-tap callback on every
/// key event, updated whenever the user changes their shortcut.
/// Defaults to PageDown to match `Settings::default()`; corrected once
/// settings load.
pub static STT_HOTKEY_KEYCODE: AtomicU16 = AtomicU16::new(121);

/// Modifier flag mask required alongside the STT keycode. CGEvent flag
/// bits OR'd together (Cmd / Ctrl / Alt / Shift). 0 = bare key, no
/// modifiers expected. Read on every key-down by the event-tap callback.
pub static STT_HOTKEY_MODIFIERS: AtomicU64 = AtomicU64::new(0);

/// Speak-selection hotkey + gates. Read by the event-tap callback on
/// every middle-click and key-down. Defaults mirror `Settings::default()`
/// (PageUp = 116, all gates on) and are refreshed when settings load
/// or change via `update_setting`.
pub static SPEAK_SEL_HOTKEY_KEYCODE: AtomicU16 = AtomicU16::new(116);

/// Modifier flag mask required alongside the speak-selection keycode.
/// See `STT_HOTKEY_MODIFIERS` for format.
pub static SPEAK_SEL_HOTKEY_MODIFIERS: AtomicU64 = AtomicU64::new(0);

// ── Speech-pipeline gates ──────────────────────────────────────────

/// True while the user is holding push-to-talk (from key-down to after
/// the final decode + paste + personality reply complete). All TTS
/// paths check this and short-circuit — otherwise narrator ticks or
/// hook-driven speech would talk over the user.
pub static USER_SPEAKING: AtomicBool = AtomicBool::new(false);

/// Guards against the STT key-up handler firing more than once per
/// release. Set true atomically on entry to the stop-and-paste worker
/// thread; if another key-up arrives while it's still set we drop
/// that event. Cleared after the paste + personality reply complete.
/// Without this, spurious double-fires of the CGEventTap key-up (or
/// synthetic events from our own osascript keystroke) could paste the
/// same transcript twice.
pub static STT_STOPPING: AtomicBool = AtomicBool::new(false);

pub static SPEAK_SEL_ENABLED: AtomicBool = AtomicBool::new(true);
pub static SPEAK_SEL_MIDDLE_CLICK: AtomicBool = AtomicBool::new(true);
/// true = route through summarizer before TTS; false = read verbatim.
pub static SPEAK_SEL_SUMMARIZE: AtomicBool = AtomicBool::new(true);

/// Toggled from the tray menu's "Pause" item. While true, the speak
/// command, summarize command, and STT decode loop early-return
/// without touching their underlying engines. The engines stay loaded
/// in memory — this is a "stop dispatch" pause, not a "free models"
/// unload.
pub static PAUSED: AtomicBool = AtomicBool::new(false);

// ── Mouse / event-tap state ────────────────────────────────────────

/// Process-wide handle the CGEventTap callback uses to dispatch back
/// into Tauri. Set once during setup; never reassigned.
pub static GLOBAL_APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// Time of last middle-click — used to debounce the trackpad's tendency
/// to fire two events per click on some machines.
pub static LAST_MIDDLE_CLICK: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Set by the anchor's drag start, cleared on drop. The event-tap
/// callback reads this to suppress speak-selection on drag-end (the
/// release click that ends a drag shouldn't also trigger TTS).
pub static WAS_DRAGGING: AtomicBool = AtomicBool::new(false);
