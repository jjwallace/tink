use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub shortcut: String,
    pub voice: String,
    #[serde(default = "default_display")]
    pub display: String,
    #[serde(default)]
    pub auto_speak: bool,
    // Legacy combined mode (both/start/complete/off). Kept for backward
    // compat with older settings.json files; the UI now edits
    // start_enabled / milestone_enabled / complete_enabled directly.
    #[serde(default = "default_sound_mode")]
    pub sound_mode: String,
    #[serde(default = "default_true")]
    pub start_enabled: bool,
    #[serde(default = "default_true")]
    pub milestone_enabled: bool,
    #[serde(default = "default_true")]
    pub complete_enabled: bool,
    #[serde(default = "default_true")]
    pub stt_enabled: bool,
    // Master TTS gate. When false, all TTS paths (do_speak_text,
    // speak_brief, /speak HTTP) short-circuit instead of synthesising.
    // Default true so existing installs keep their current behaviour.
    #[serde(default = "default_true")]
    pub tts_enabled: bool,
    #[serde(default = "default_work_mode")]
    pub work_mode: String,
    #[serde(default = "default_summary_model")]
    pub summary_model: String,
    #[serde(default = "default_personality")]
    pub personality: String,
    #[serde(default = "default_start_sound")]
    pub start_sound: String,
    #[serde(default = "default_complete_sound")]
    pub complete_sound: String,
    #[serde(default = "default_milestone_sound")]
    pub milestone_sound: String,
    #[serde(default = "default_stt_model")]
    pub stt_model: String,
    #[serde(default = "default_true")]
    pub vfx_enabled: bool,
    #[serde(default = "default_vfx_color")]
    pub vfx_color: String,
    // Voice anchor — draggable screen position (fraction 0-1) used for
    // the sine-wave VFX and the creature's figure-8 during TTS.
    #[serde(default = "default_voice_anchor_x")]
    pub voice_anchor_x: f32,
    #[serde(default = "default_voice_anchor_y")]
    pub voice_anchor_y: f32,
    // Tiny idle bob animation on the anchor — 2-3px up/down drift at
    // ~0.4 Hz. Purely cosmetic; off by default to keep the UI stable.
    #[serde(default = "default_true")]
    pub anchor_bob: bool,
    // Speak-selection: read highlighted text aloud. Off disables both
    // hotkey and middle-click triggers; middle_click is a sub-gate.
    #[serde(default = "default_true")]
    pub speak_selection_enabled: bool,
    #[serde(default = "default_speak_selection_shortcut")]
    pub speak_selection_shortcut: String,
    #[serde(default = "default_true")]
    pub speak_selection_middle_click: bool,
    // "summarize" routes selection through SmolLM2 before TTS;
    // "verbose" reads the selection verbatim.
    #[serde(default = "default_speak_selection_mode")]
    pub speak_selection_mode: String,
    // Master gate for the Pixi creature. Some users find the tentacle
    // character distracting; defaults on for continuity with existing
    // installs. Toggled from the VFX section.
    #[serde(default = "default_true")]
    pub creature_enabled: bool,
    // Record on/off SFX for push-to-talk. stt_sounds_enabled is the
    // master toggle; the two _sound fields pick which file plays on
    // press (on) and release (off). Files live in public/assets/sfx/.
    #[serde(default = "default_true")]
    pub stt_sounds_enabled: bool,
    #[serde(default = "default_stt_on_sound")]
    pub stt_on_sound: String,
    #[serde(default = "default_stt_off_sound")]
    pub stt_off_sound: String,
    // When false, suppresses the flashing word-cloud visual that
    // spawns around the anchor as STT partials arrive. The tentacles
    // and sounds still respond; only the text animation is gated.
    #[serde(default = "default_true")]
    pub stt_text_display_enabled: bool,
    // User-added Piper voices beyond the built-in defaults. Persisted
    // here so they survive restarts; registered into TtsEngine on app
    // start (see lib.rs setup). Empty for fresh installs.
    #[serde(default)]
    pub custom_voices: Vec<voice_core::tts::VoiceSpec>,
}

fn default_voice_anchor_x() -> f32 { 0.8 }
fn default_voice_anchor_y() -> f32 { 0.5 }

fn default_stt_model() -> String {
    "moonshine-tiny".into()
}

fn default_vfx_color() -> String {
    "#a78bfa".into()
}

fn default_milestone_sound() -> String {
    "complete-bell".into()
}

fn default_summary_model() -> String {
    "smol-360m".into()
}

fn default_display() -> String {
    "creature".into()
}

fn default_sound_mode() -> String {
    "both".into()
}

fn default_true() -> bool {
    true
}

fn default_work_mode() -> String {
    "iterate".into()
}

fn default_personality() -> String {
    // Picker is hidden in SettingsPanel; ship-computer is the only
    // active personality. When the picker is reintroduced this default
    // can move back to "none".
    "ship-computer".into()
}

fn default_start_sound() -> String {
    "start-quite".into()
}

fn default_complete_sound() -> String {
    "complete-accomplish".into()
}

fn default_speak_selection_shortcut() -> String {
    "PageUp".into()
}

fn default_speak_selection_mode() -> String {
    "summarize".into()
}

fn default_stt_on_sound() -> String {
    "record-on-crt".into()
}

fn default_stt_off_sound() -> String {
    "record-off-crt".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: "PageDown".into(),
            voice: "lessac-fast".into(),
            display: "creature".into(),
            auto_speak: false,
            sound_mode: "both".into(),
            start_enabled: true,
            milestone_enabled: true,
            complete_enabled: true,
            stt_enabled: true,
            tts_enabled: true,
            work_mode: "iterate".into(),
            summary_model: "smol-360m".into(),
            personality: "ship-computer".into(),
            start_sound: "start-quite".into(),
            complete_sound: "complete-accomplish".into(),
            milestone_sound: "complete-bell".into(),
            stt_model: "moonshine-tiny".into(),
            vfx_enabled: true,
            vfx_color: "#a78bfa".into(),
            voice_anchor_x: 0.8,
            voice_anchor_y: 0.5,
            anchor_bob: true,
            speak_selection_enabled: true,
            speak_selection_shortcut: "PageUp".into(),
            speak_selection_middle_click: true,
            speak_selection_mode: "summarize".into(),
            creature_enabled: true,
            stt_sounds_enabled: true,
            stt_on_sound: "record-on-crt".into(),
            stt_off_sound: "record-off-crt".into(),
            stt_text_display_enabled: true,
            custom_voices: Vec::new(),
        }
    }
}

impl Settings {
    fn path(app_data_dir: &std::path::Path) -> PathBuf {
        app_data_dir.join("settings.json")
    }

    pub fn load(app_data_dir: &std::path::Path) -> Self {
        let path = Self::path(app_data_dir);
        let mut settings: Self = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Picker is hidden — migrate any saved "none" so the rest of the
        // app (hooks reading /status, future code paths) sees the active
        // personality. Drop this line when the picker is reintroduced.
        if settings.personality == "none" {
            settings.personality = "ship-computer".into();
        }
        settings
    }

    pub fn save(&self, app_data_dir: &std::path::Path) {
        let path = Self::path(app_data_dir);
        std::fs::create_dir_all(app_data_dir).ok();
        if let Ok(json) = serde_json::to_string_pretty(self) {
            std::fs::write(path, json).ok();
        }
    }
}
