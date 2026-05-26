// Type interfaces for the SettingsPanel. Backend shapes (AllSettings,
// VoiceSpec, *ModelInfo, *Event) mirror what `get_all_settings` and the
// download lifecycle events return from src-tauri/src/lib.rs — keep
// these in sync when adding fields on the Rust side.

export interface SttModelInfo {
  id: string;
  label: string;
  description: string;
  downloaded: boolean;
}

export interface SummarizerModelInfo {
  id: string;
  label: string;
  description: string;
  downloaded: boolean;
}

export interface VoiceSpec {
  id: string;
  label: string;
  dir_name: string;
  model_file: string;
  download_url: string;
  size_mb?: number | null;
  speaker_id?: number;
}

export interface AllSettings {
  shortcut: string;
  voice: string;
  display: string;
  auto_speak: boolean;
  sound_mode: string;
  stt_enabled: boolean;
  tts_enabled: boolean;
  work_mode: string;
  personality: string;
  start_sound: string;
  complete_sound: string;
  milestone_sound: string;
  vfx_enabled: boolean;
  vfx_color: string;
  anchor_bob: boolean;
  speak_selection_enabled: boolean;
  speak_selection_shortcut: string;
  speak_selection_middle_click: boolean;
  speak_selection_mode: string;
  start_enabled: boolean;
  milestone_enabled: boolean;
  complete_enabled: boolean;
  creature_enabled: boolean;
  stt_sounds_enabled: boolean;
  stt_on_sound: string;
  stt_off_sound: string;
  stt_text_display_enabled: boolean;
  // Map of voice ID → downloaded status. Keys are Piper IDs (e.g.
  // "en_US-ryan-high") for newly registered voices and short legacy IDs
  // ("ryan") for ones still using the old key. The picker renders from
  // tts_voices instead and indexes into this for the badge.
  tts_models: Record<string, boolean>;
  // Full list of registered voice specs (built-ins + user-added).
  tts_voices: VoiceSpec[];
  // Currently active voice (canonical Piper ID).
  tts_current_voice: string;
  stt: {
    active: string;
    models: SttModelInfo[];
  };
  summarizer: {
    active: string;
    models: SummarizerModelInfo[];
  };
}

export interface ModelProgressEvent {
  model: string;
  status: "downloading" | "done" | "error";
  error?: string;
}

export interface SummarizerDownloadEvent {
  model: string;
  status: "downloading" | "done" | "error";
  error?: string;
}

export interface SettingRowDef {
  label: string;
  key: string;
  hint: string;
  options: readonly { value: string; label: string }[];
}

export interface SettingsSection {
  title: string;
  rows: SettingRowDef[];
}
