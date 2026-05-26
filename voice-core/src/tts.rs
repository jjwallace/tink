use rodio::Sink;
use serde::{Deserialize, Serialize};
use sherpa_rs::tts::{VitsTts, VitsTtsConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Emit windowed RMS amplitude for a sentence's samples as a stream
/// of `tts-amplitude` events timed to match real-time playback. The
/// frontend sine-wave listens to these and drives its own amplitude
/// in lockstep with the voice, so the wave visibly pulses on
/// syllables instead of sitting at the sentence-level average.
///
/// Runs on its own thread. Honors `cancel` so a mid-sentence stop
/// doesn't leave a phantom pulse train running. Window size ~50 ms at
/// the source sample rate — a good compromise between latency and
/// per-syllable resolution.
pub fn spawn_amplitude_emitter(
    sink: Arc<dyn crate::EventSink>,
    samples: Arc<Vec<f32>>,
    sample_rate: u32,
    cancel: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        const WINDOW_MS: u64 = 50;
        let window_size = ((sample_rate as u64 * WINDOW_MS) / 1000) as usize;
        if window_size == 0 { return; }
        let total_windows = (samples.len() + window_size - 1) / window_size;

        // First pass — compute the sentence peak so we can normalize
        // each window relative to it. Without normalization, speech RMS
        // sits in a narrow 0.05..0.25 band for most of a sentence, which
        // makes the downstream wave modulation feel near-flat.
        let sentence_peak = samples
            .iter()
            .map(|s| s.abs())
            .fold(0.0f32, f32::max)
            .max(0.01);

        for w in 0..total_windows {
            if cancel.load(Ordering::SeqCst) { return; }
            let start = w * window_size;
            let end = (start + window_size).min(samples.len());
            if start >= end { break; }
            // Peak in the window — captures syllable transients better
            // than RMS for driving a visually-reactive waveform.
            let mut win_peak = 0.0f32;
            for s in &samples[start..end] {
                let a = s.abs();
                if a > win_peak { win_peak = a; }
            }
            // Normalize to the sentence peak so a quiet sentence still
            // visibly pulses (otherwise loud sentences would dominate
            // and quiet ones would look dead).
            let level = (win_peak / sentence_peak).min(1.0);
            sink.emit_json("tts-amplitude", serde_json::json!({ "level": level }));
            std::thread::sleep(std::time::Duration::from_millis(WINDOW_MS));
        }
    });
}

/// Fade a sink's volume to 0 over ~120 ms on a detached thread, then
/// stop it. Replaces bare `sink.stop()` on cancellation paths so we
/// don't get an audible click when TTS cuts off mid-sentence (e.g. on
/// STT key-down, ESC, or when a new speak session pre-empts an
/// in-flight one). The caller gives up ownership of the sink; the
/// fade thread drops it when the ramp completes.
pub fn spawn_fade_out(sink: Sink) {
    std::thread::spawn(move || {
        const STEPS: u64 = 10;
        const STEP_MS: u64 = 12; // 10 × 12 = 120 ms total
        for i in 1..=STEPS {
            let v = (STEPS - i) as f32 / STEPS as f32;
            sink.set_volume(v);
            std::thread::sleep(std::time::Duration::from_millis(STEP_MS));
        }
        sink.stop();
    });
}

/// A single TTS voice. Identified by its Piper ID (e.g.
/// "en_US-ryan-high"); other fields are derived from the ID via
/// `from_piper_id` unless overridden for built-ins with custom labels.
///
/// Voices live in a `HashMap<id, VoiceSpec>` on `TtsEngine`, registered
/// at startup from `default_voice_specs()` plus any custom voices the
/// user has added through the UI. Adding a voice means appending a
/// VoiceSpec — no enum surgery, no match-arm sweep across files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceSpec {
    /// Piper voice ID, e.g. "en_US-ryan-high" or "en_GB-cori-high".
    pub id: String,
    /// Human label shown in UI.
    pub label: String,
    /// Model directory under `models_dir`, e.g. "vits-piper-en_US-ryan-high".
    pub dir_name: String,
    /// `.onnx` filename inside dir, e.g. "en_US-ryan-high.onnx".
    pub model_file: String,
    /// Full HTTPS URL to the `.tar.bz2` archive.
    pub download_url: String,
    /// Approximate download size in megabytes (optional, for UI hints).
    #[serde(default)]
    pub size_mb: Option<u32>,
    /// VITS speaker index for multi-speaker models. Single-speaker = 0.
    #[serde(default)]
    pub speaker_id: i32,
}

impl VoiceSpec {
    /// Derive a VoiceSpec from a Piper voice ID using sherpa-onnx's
    /// release naming convention. Works for any Piper voice published to
    /// the k2-fsa/sherpa-onnx tts-models release tag.
    pub fn from_piper_id(id: &str) -> Self {
        let dir_name = format!("vits-piper-{}", id);
        Self {
            id: id.to_string(),
            label: humanize_piper_id(id),
            model_file: format!("{}.onnx", id),
            download_url: format!(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{}.tar.bz2",
                dir_name
            ),
            dir_name,
            size_mb: None,
            speaker_id: 0,
        }
    }
}

/// "en_US-ryan-high" → "Ryan (en_US, high)". Best-effort prettification
/// for user-added voices that don't have a hand-written label.
fn humanize_piper_id(id: &str) -> String {
    // Format is "<lang>-<name>-<quality>" with name possibly using
    // underscores. Split lang prefix, then last "-quality", and treat
    // the middle as the voice name.
    let parts: Vec<&str> = id.splitn(2, '-').collect();
    if parts.len() != 2 {
        return id.to_string();
    }
    let (lang, rest) = (parts[0], parts[1]);
    let last_dash = rest.rfind('-');
    let (name, quality) = match last_dash {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let name_pretty = name.replace('_', " ");
    let name_titled = name_pretty
        .split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if quality.is_empty() {
        format!("{} ({})", name_titled, lang)
    } else {
        format!("{} ({}, {})", name_titled, lang, quality)
    }
}

/// Default voice specs registered at startup. These are the curated
/// built-ins; adding to this list is fine but not required — users can
/// add any Piper voice through the UI's "+ Add voice" flow.
pub fn default_voice_specs() -> Vec<VoiceSpec> {
    // Older code used short IDs like "lessac-fast" / "lessac" / "vctk" /
    // "alba"; settings on disk may still hold those. To keep them working
    // without a migration we don't change the canonical IDs here —
    // legacy_id_to_piper handles the mapping in TtsEngine::set_voice.
    vec![
        spec_with_label("en_GB-vctk-medium", "VCTK (British)", Some(92)),
        spec_with_label("en_US-lessac-high", "Lessac (High Quality)", Some(127)),
        spec_with_label("en_US-lessac-low", "Lessac (Fast)", Some(78)),
        spec_with_label("en_GB-alba-medium", "Alba (Scottish female)", Some(80)),
        spec_with_label("en_US-ryan-high", "Ryan (US male, bright)", Some(110)),
    ]
}

fn spec_with_label(id: &str, label: &str, size_mb: Option<u32>) -> VoiceSpec {
    let mut spec = VoiceSpec::from_piper_id(id);
    spec.label = label.to_string();
    spec.size_mb = size_mb;
    spec
}

/// Best-effort `Content-Length` lookup via curl HEAD. Returns 0 if the
/// server doesn't supply a usable length, which lets the progress UI
/// fall back to indeterminate rendering. Synchronous; intended to be
/// called once at the start of a download.
fn head_content_length(url: &str) -> Option<u64> {
    let out = std::process::Command::new("curl")
        .args(["-sIL", url])
        .output()
        .ok()?;
    let body = String::from_utf8_lossy(&out.stdout);
    // GitHub releases redirect (302) to S3-style hosts that DO return
    // Content-Length. -L follows the redirect; we want the LAST header
    // block's content-length, so scan from the bottom.
    body.lines()
        .rev()
        .find_map(|line| {
            let lower = line.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|rest| rest.trim().parse::<u64>().ok())
        })
}

/// Translate the legacy short IDs ("lessac-fast", "vctk", "alba", "lessac",
/// "ryan") that older settings files persist into their canonical Piper
/// IDs. Returns `None` if `id` is already a Piper ID or unknown.
pub fn legacy_id_to_piper(id: &str) -> Option<&'static str> {
    match id {
        "vctk" => Some("en_GB-vctk-medium"),
        "lessac" => Some("en_US-lessac-high"),
        "lessac-fast" => Some("en_US-lessac-low"),
        "alba" => Some("en_GB-alba-medium"),
        "ryan" => Some("en_US-ryan-high"),
        _ => None,
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct WordTiming {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

/// Sent when a sentence is ready to play.
#[derive(Serialize, Clone, Debug)]
pub struct SentenceEvent {
    pub index: usize,
    pub words: Vec<WordTiming>,
    pub duration: f64,
    /// Peak sample amplitude in the generated audio buffer, normalized to
    /// roughly 0..1. Frontend uses this to pulse the sine-wave speed so
    /// louder sentences animate faster. Cheap to compute — one pass over
    /// the samples — so it's bundled here rather than a separate event.
    #[serde(default)]
    pub level: f32,
}

/// Sent at the start to open the panel.
#[derive(Serialize, Clone, Debug)]
pub struct OpenEvent {
    pub sentences: Vec<String>,
    pub display: String,
    #[serde(rename = "mouseX")]
    pub mouse_x: f64,
    #[serde(rename = "mouseY")]
    pub mouse_y: f64,
}

pub struct TtsEngine {
    models_dir: PathBuf,
    current_id: String,
    voices: HashMap<String, VoiceSpec>,
    loaded: HashMap<String, VitsTts>,
    cancel: Arc<AtomicBool>,
    current_sink: Option<Arc<std::sync::Mutex<Option<Sink>>>>,
    // True from start_session() until end_session(). Unlike sink.empty(),
    // this stays true across between-sentence gaps, so is_playing() doesn't
    // flicker false while a paragraph is mid-generation. The wait loops in
    // do_speak_text / do_speak_selection rely on this — without it they'd
    // race through a sentence-boundary gap and cancel the prior session.
    session_active: Arc<AtomicBool>,
}

unsafe impl Send for TtsEngine {}
unsafe impl Sync for TtsEngine {}

/// Strip markdown syntax so TTS reads clean text.
pub fn strip_markdown(text: &str) -> String {
    let mut out = text.to_string();

    // Remove code blocks (``` ... ```)
    while let Some(start) = out.find("```") {
        if let Some(end) = out[start + 3..].find("```") {
            out.replace_range(start..start + 3 + end + 3, " ");
        } else {
            out = out[..start].to_string();
            break;
        }
    }

    // Remove inline code (`...`)
    out = out.replace('`', "");

    // Remove images ![alt](url)
    while let Some(start) = out.find("![") {
        if let Some(end) = out[start..].find(')') {
            out.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }

    // Remove links [text](url) → keep text
    while let Some(start) = out.find("](") {
        if let Some(end) = out[start..].find(')') {
            out.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }
    out = out.replace('[', "").replace(']', "");

    // Remove bold/italic markers
    out = out.replace("***", "").replace("**", "").replace("__", "");
    out = out.replace('*', "").replace('_', " ");

    // Remove headings (# at start of line)
    out = out
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') {
                trimmed.trim_start_matches('#').trim()
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Remove horizontal rules (--- or ***)
    out = out
        .lines()
        .filter(|line| {
            let t = line.trim();
            !(t.chars().all(|c| c == '-' || c == ' ') && t.matches('-').count() >= 3)
                && !(t.chars().all(|c| c == '*' || c == ' ') && t.matches('*').count() >= 3)
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Remove HTML tags
    while let Some(start) = out.find('<') {
        if let Some(end) = out[start..].find('>') {
            out.replace_range(start..start + end + 1, "");
        } else {
            break;
        }
    }

    // Remove blockquote markers
    out = out
        .lines()
        .map(|line| line.trim_start().trim_start_matches('>').trim())
        .collect::<Vec<_>>()
        .join("\n");

    // Remove list markers (-, *, numbered)
    out = out
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed.starts_with("+ ")
            {
                &trimmed[2..]
            } else if trimmed.len() > 2
                && trimmed.as_bytes()[0].is_ascii_digit()
                && (trimmed.contains(". "))
            {
                if let Some(pos) = trimmed.find(". ") {
                    &trimmed[pos + 2..]
                } else {
                    trimmed
                }
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Collapse multiple spaces/newlines
    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    out.trim().to_string()
}

/// Split text into sentences by punctuation or newlines.
/// Long chunks without punctuation get split at commas or after ~150 chars at word boundaries.
pub fn split_sentences(text: &str) -> Vec<String> {
    let mut raw_sentences = Vec::new();
    let mut current = String::new();

    let chars: Vec<char> = text.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if ch == '\n' || ch == '\r' {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                raw_sentences.push(trimmed);
            }
            current.clear();
        } else {
            current.push(ch);
            let is_end = matches!(ch, '!' | '?' | ';')
                || (ch == '.' && {
                    // Don't split on dots inside filenames/abbreviations —
                    // only split when followed by whitespace or end of text.
                    let next = chars.get(i + 1);
                    next.is_none() || next.unwrap().is_whitespace()
                });
            if is_end {
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    raw_sentences.push(trimmed);
                }
                current.clear();
            }
        }
    }
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        raw_sentences.push(trimmed);
    }

    // Break up any sentences that are too long for TTS
    let max_chars = 150;
    let mut sentences = Vec::new();
    for s in raw_sentences {
        if s.len() <= max_chars {
            sentences.push(s);
        } else {
            // Try splitting at commas first, then at word boundaries
            let mut chunk = String::new();
            for word in s.split_whitespace() {
                if !chunk.is_empty() && chunk.len() + word.len() + 1 > max_chars {
                    // Check if we can split at a comma within the chunk
                    if let Some(comma_pos) = chunk.rfind(',') {
                        let (left, right) = chunk.split_at(comma_pos + 1);
                        sentences.push(left.trim().to_string());
                        chunk = right.trim().to_string();
                        if !chunk.is_empty() {
                            chunk.push(' ');
                        }
                        chunk.push_str(word);
                    } else {
                        sentences.push(chunk.trim().to_string());
                        chunk = word.to_string();
                    }
                } else {
                    if !chunk.is_empty() {
                        chunk.push(' ');
                    }
                    chunk.push_str(word);
                }
            }
            let trimmed = chunk.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
        }
    }

    sentences
}

impl TtsEngine {
    pub fn new(models_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&models_dir).ok();
        let mut voices = HashMap::new();
        for spec in default_voice_specs() {
            voices.insert(spec.id.clone(), spec);
        }
        // Default current_id = lessac-fast (the smallest US voice). The
        // host app overrides this via set_voice from persisted settings.
        Self {
            models_dir,
            current_id: "en_US-lessac-low".to_string(),
            voices,
            loaded: HashMap::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            current_sink: None,
            session_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Add a voice spec to the registry. Existing entries with the same
    /// ID are replaced. Use this to register custom voices added by the
    /// user through the UI.
    pub fn register(&mut self, spec: VoiceSpec) {
        self.voices.insert(spec.id.clone(), spec);
    }

    /// Set the active voice by ID. Accepts both Piper IDs (e.g.
    /// "en_US-ryan-high") and legacy short IDs ("ryan", "lessac-fast")
    /// from older settings files. No-op if the ID isn't registered.
    pub fn set_voice(&mut self, id: &str) {
        let canonical = legacy_id_to_piper(id).unwrap_or(id).to_string();
        if self.voices.contains_key(&canonical) {
            self.current_id = canonical;
        }
    }

    pub fn current_voice(&self) -> &str {
        &self.current_id
    }

    pub fn current_spec(&self) -> Option<&VoiceSpec> {
        self.voices.get(&self.current_id)
    }

    pub fn voice_specs(&self) -> Vec<&VoiceSpec> {
        let mut specs: Vec<&VoiceSpec> = self.voices.values().collect();
        // Sort by id for stable UI ordering.
        specs.sort_by(|a, b| a.id.cmp(&b.id));
        specs
    }

    pub fn spec(&self, id: &str) -> Option<&VoiceSpec> {
        let canonical = legacy_id_to_piper(id).unwrap_or(id);
        self.voices.get(canonical)
    }

    pub fn model_dir_for(&self, id: &str) -> Option<PathBuf> {
        self.spec(id).map(|s| self.models_dir.join(&s.dir_name))
    }

    pub fn models_root(&self) -> PathBuf {
        self.models_dir.clone()
    }

    pub fn is_model_downloaded(&self, id: &str) -> bool {
        let Some(spec) = self.spec(id) else { return false };
        let dir = self.models_dir.join(&spec.dir_name);
        dir.join(&spec.model_file).exists() && dir.join("tokens.txt").exists()
    }

    /// Synchronous download (curl|tar pipeline). For UI-friendly progress
    /// callbacks see `download_with_progress` below.
    pub fn download_model(&self, id: &str) -> Result<(), String> {
        self.download_with_progress(id, |_done, _total| {})
    }

    /// Download `id` and emit progress updates via `on_progress(bytes_done,
    /// bytes_total)` roughly every 250 ms. `bytes_total` is 0 if the
    /// server didn't supply Content-Length.
    ///
    /// Implementation: HEAD to learn size, then `curl -L -o tmp` in a
    /// child process while we poll `tmp`'s file size from this thread.
    /// On success, `tar -xjf` extracts then deletes the temp archive.
    pub fn download_with_progress<F: FnMut(u64, u64)>(
        &self,
        id: &str,
        mut on_progress: F,
    ) -> Result<(), String> {
        if self.is_model_downloaded(id) {
            on_progress(1, 1);
            return Ok(());
        }
        let spec = self
            .spec(id)
            .ok_or_else(|| format!("Unknown voice id: {}", id))?;
        std::fs::create_dir_all(&self.models_dir).map_err(|e| e.to_string())?;

        // Step 1 — discover size via HEAD. Failure here is non-fatal;
        // we just report total=0 and the UI shows indeterminate progress.
        let total = head_content_length(&spec.download_url).unwrap_or(0);

        // Step 2 — download to a temp path so we can poll its size.
        let tmp = self
            .models_dir
            .join(format!(".{}.tar.bz2.partial", spec.dir_name));
        let _ = std::fs::remove_file(&tmp);
        let mut curl = std::process::Command::new("curl")
            .args([
                "-L",
                "--fail",
                "--silent",
                "--show-error",
                "-o",
                tmp.to_str().ok_or("bad tmp path")?,
                &spec.download_url,
            ])
            .spawn()
            .map_err(|e| format!("Failed to start curl: {}", e))?;

        // Poll loop — emit on_progress until curl exits.
        loop {
            if let Some(status) = curl
                .try_wait()
                .map_err(|e| format!("curl wait failed: {}", e))?
            {
                if !status.success() {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(format!("curl exited with {}", status));
                }
                break;
            }
            let done = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
            on_progress(done, total);
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let final_size = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        on_progress(final_size, total.max(final_size));

        // Step 3 — extract.
        let status = std::process::Command::new("tar")
            .args(["-xjf"])
            .arg(&tmp)
            .args(["-C"])
            .arg(&self.models_dir)
            .status()
            .map_err(|e| format!("Failed to extract: {}", e))?;
        let _ = std::fs::remove_file(&tmp);
        if !status.success() {
            return Err(format!("tar extract failed for {}", spec.label));
        }
        Ok(())
    }

    fn ensure_loaded(&mut self, id: &str) -> Result<&mut VitsTts, String> {
        let canonical = legacy_id_to_piper(id).unwrap_or(id).to_string();
        if self.loaded.contains_key(&canonical) {
            return Ok(self.loaded.get_mut(&canonical).unwrap());
        }
        let spec = self
            .voices
            .get(&canonical)
            .ok_or_else(|| format!("Unknown voice: {}", canonical))?
            .clone();
        let dir = self.models_dir.join(&spec.dir_name);
        if !dir.exists() {
            return Err(format!("Model not found at {:?}. Download it first.", dir));
        }
        let config = VitsTtsConfig {
            model: dir.join(&spec.model_file).to_string_lossy().into(),
            tokens: dir.join("tokens.txt").to_string_lossy().into(),
            data_dir: dir.join("espeak-ng-data").to_string_lossy().into(),
            length_scale: 1.0,
            ..Default::default()
        };
        let tts = VitsTts::new(config);
        self.loaded.insert(canonical.clone(), tts);
        Ok(self.loaded.get_mut(&canonical).unwrap())
    }

    /// Generate TTS for a single sentence. Returns (word_timings, samples, sample_rate).
    pub fn generate_sentence(
        &mut self,
        text: &str,
    ) -> Result<(Vec<WordTiming>, Vec<f32>, u32), String> {
        self.generate_sentence_with_speed(text, 1.0)
    }

    /// Same as generate_sentence but with a configurable speech rate.
    /// `speed > 1.0` → faster delivery (clipped, more assertive).
    /// `speed < 1.0` → slower delivery (drawn out, softer).
    /// Used by speak_brief so ship-computer acknowledgements land with a
    /// snappier inflection than the regular narrator voice.
    pub fn generate_sentence_with_speed(
        &mut self,
        text: &str,
        speed: f32,
    ) -> Result<(Vec<WordTiming>, Vec<f32>, u32), String> {
        let id = self.current_id.clone();
        let sid = self.spec(&id).map(|s| s.speaker_id).unwrap_or(0);
        let tts = self.ensure_loaded(&id)?;
        let audio = tts
            .create(text, sid, speed)
            .map_err(|e| format!("TTS failed: {}", e))?;

        let sample_rate = audio.sample_rate as u32;
        let duration = audio.samples.len() as f64 / sample_rate as f64;

        let words: Vec<&str> = text.split_whitespace().collect();
        if words.is_empty() {
            return Ok((vec![], audio.samples, sample_rate));
        }

        let total_chars: usize = words.iter().map(|w| w.len()).sum();
        let mut timings = Vec::with_capacity(words.len());
        let mut cursor = 0.0;

        for word in &words {
            let fraction = word.len() as f64 / total_chars.max(1) as f64;
            let word_dur = duration * fraction;
            timings.push(WordTiming {
                text: word.to_string(),
                start: cursor,
                end: cursor + word_dur,
            });
            cursor += word_dur;
        }

        Ok((timings, audio.samples, sample_rate))
    }

    /// Get a cancel token and sink handle for the current session.
    /// Sets `session_active` so is_playing() reports "busy" through the
    /// entire paragraph, including between-sentence gaps. Callers MUST
    /// call end_session() when done or the flag will leak.
    pub fn start_session(&mut self) -> (Arc<AtomicBool>, Arc<std::sync::Mutex<Option<Sink>>>) {
        // Cancel any previous session. Fade-out rather than hard stop so
        // the pre-empted sink's tail dissolves cleanly instead of cutting
        // with a click.
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(ref sink_holder) = self.current_sink {
            if let Ok(mut s) = sink_holder.lock() {
                if let Some(sink) = s.take() {
                    spawn_fade_out(sink);
                }
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let sink_holder = Arc::new(std::sync::Mutex::new(None::<Sink>));
        self.cancel = cancel.clone();
        self.current_sink = Some(sink_holder.clone());
        self.session_active.store(true, Ordering::SeqCst);
        (cancel, sink_holder)
    }

    /// Mark the session done. Called by do_speak_text / do_speak_selection /
    /// speak_brief right before they return, so the NEXT is_playing() check
    /// can return false and let a queued speak start.
    pub fn end_session(&self) {
        self.session_active.store(false, Ordering::SeqCst);
    }

    /// Atomic "if idle, claim the session" helper — returns None when
    /// another session is still in flight. Because the engine Mutex is
    /// held for the full duration of this call, two racing callers
    /// can't both see idle and both call start_session (which would
    /// have each cancelled the other). Callers spin on None from a
    /// wait loop; speak_brief bypasses this and uses start_session
    /// directly to cut in.
    pub fn try_start_session(
        &mut self,
    ) -> Option<(Arc<AtomicBool>, Arc<std::sync::Mutex<Option<Sink>>>)> {
        if self.is_playing() {
            return None;
        }
        Some(self.start_session())
    }

    /// Check if speech is currently playing. Two sources:
    ///   1. sink.empty() — false while audio samples are queued
    ///   2. session_active — true for the full lifetime of a paragraph,
    ///      including the silent gaps between sentences
    /// OR'ing them covers both "actively playing audio" and "mid-paragraph
    /// but between sentences" so the wait loops don't race and cut in.
    pub fn is_playing(&self) -> bool {
        if self.session_active.load(Ordering::SeqCst) {
            return true;
        }
        if let Some(ref sink_holder) = self.current_sink {
            if let Ok(s) = sink_holder.lock() {
                if let Some(ref sink) = *s {
                    return !sink.empty();
                }
            }
        }
        false
    }

    /// Stop current playback with a short fade-out so audio doesn't
    /// click-cut. Used by STT key-down and ESC interrupts.
    pub fn stop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.session_active.store(false, Ordering::SeqCst);
        if let Some(ref sink_holder) = self.current_sink {
            if let Ok(mut s) = sink_holder.lock() {
                if let Some(sink) = s.take() {
                    spawn_fade_out(sink);
                }
            }
        }
    }
}

/// Grab the currently selected text by simulating Cmd+C and reading the clipboard.
#[cfg(target_os = "macos")]
pub fn grab_selected_text() -> Result<String, String> {
    let status = std::process::Command::new("osascript")
        .args([
            "-e",
            r#"tell application "System Events" to keystroke "c" using command down"#,
        ])
        .status()
        .map_err(|e| format!("Failed to simulate copy: {}", e))?;

    if !status.success() {
        return Err("osascript failed -- grant Accessibility permissions".into());
    }

    std::thread::sleep(std::time::Duration::from_millis(80));

    let output = std::process::Command::new("pbpaste")
        .output()
        .map_err(|e| format!("pbpaste failed: {}", e))?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if text.is_empty() {
        Err("No text selected".into())
    } else {
        Ok(text)
    }
}

#[cfg(not(target_os = "macos"))]
pub fn grab_selected_text() -> Result<String, String> {
    Err("Text selection capture is only supported on macOS".into())
}
