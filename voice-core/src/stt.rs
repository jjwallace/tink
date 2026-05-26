use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use sherpa_rs::moonshine::{MoonshineConfig, MoonshineRecognizer};
use sherpa_rs::transducer::{TransducerConfig, TransducerRecognizer};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::EventSink;

const SAMPLE_RATE: u32 = 16000;
// How often the streaming decoder runs a partial pass while the user is
// holding push-to-talk. Lower = words appear sooner after being spoken,
// at the cost of more CPU. 250 ms gives a ~2× responsiveness boost over
// the original 600 ms without meaningful CPU impact on a dev machine.
const DECODE_INTERVAL_MS: u64 = 250;

// ── STT Model Catalog ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SttModel {
    MoonshineTiny,
    MoonshineBase,
    Parakeet06b,
}

impl SttModel {
    pub fn all() -> &'static [SttModel] {
        &[SttModel::MoonshineTiny, SttModel::MoonshineBase, SttModel::Parakeet06b]
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::MoonshineTiny => "moonshine-tiny",
            Self::MoonshineBase => "moonshine-base",
            Self::Parakeet06b => "parakeet-0.6b",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::MoonshineTiny => "Moonshine Tiny",
            Self::MoonshineBase => "Moonshine Base",
            Self::Parakeet06b => "Parakeet 0.6B",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Self::MoonshineTiny => "108 MB — Lowest latency, on-device voice commands",
            Self::MoonshineBase => "207 MB — Higher accuracy, still fast",
            Self::Parakeet06b => "670 MB — Backup, accurate long-form, punctuation",
        }
    }

    pub fn dir_name(&self) -> &'static str {
        match self {
            Self::MoonshineTiny => "sherpa-onnx-moonshine-tiny-en-int8",
            Self::MoonshineBase => "sherpa-onnx-moonshine-base-en-int8",
            Self::Parakeet06b => "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        }
    }

    fn download_url(&self) -> &'static str {
        match self {
            Self::MoonshineTiny => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2",
            Self::MoonshineBase => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-base-en-int8.tar.bz2",
            Self::Parakeet06b => "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::all().iter().find(|m| m.id() == id).copied()
    }
}

// ── Events ──

#[derive(Serialize, Clone, Debug)]
pub struct SttPartialEvent {
    pub text: String,
    pub new_words: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SttDoneEvent {
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SttAmplitudeEvent {
    pub amplitude: f32,
}

/// Snapshot returned by `snapshot_and_stop` so the caller can run the
/// final decode without holding the SttEngine mutex.
pub struct StopSnapshot {
    pub samples: Vec<f32>,
    pub model: SttModel,
    pub models_dir: PathBuf,
}

/// Free-function final decode — does not need a live SttEngine or its
/// mutex. Takes a samples buffer and model spec and produces text.
/// Intended for the release path where we want the SttState lock
/// released before we spend hundreds of ms decoding.
pub fn decode_offline(samples: &[f32], model: SttModel, models_dir: &std::path::Path) -> String {
    if samples.is_empty() {
        return String::new();
    }
    eprintln!(
        "STT: offline final decode of {} samples ({:.1}s)",
        samples.len(),
        samples.len() as f64 / SAMPLE_RATE as f64,
    );
    let dir = models_dir.join(model.dir_name());
    let result = match model {
        SttModel::MoonshineTiny | SttModel::MoonshineBase => {
            let config = MoonshineConfig {
                preprocessor: dir.join("preprocess.onnx").to_string_lossy().into(),
                encoder: dir.join("encode.int8.onnx").to_string_lossy().into(),
                uncached_decoder: dir.join("uncached_decode.int8.onnx").to_string_lossy().into(),
                cached_decoder: dir.join("cached_decode.int8.onnx").to_string_lossy().into(),
                tokens: dir.join("tokens.txt").to_string_lossy().into(),
                num_threads: Some(2),
                ..Default::default()
            };
            MoonshineRecognizer::new(config)
                .map_err(|e| format!("Moonshine init: {}", e))
                .map(|mut r| r.transcribe(SAMPLE_RATE, samples).text.trim().to_string())
        }
        SttModel::Parakeet06b => {
            let config = TransducerConfig {
                encoder: dir.join("model.int8.onnx").to_string_lossy().into(),
                decoder: dir.join("decoder.onnx").to_string_lossy().into(),
                joiner: dir.join("joiner.onnx").to_string_lossy().into(),
                tokens: dir.join("tokens.txt").to_string_lossy().into(),
                num_threads: 4,
                sample_rate: SAMPLE_RATE as i32,
                feature_dim: 80,
                decoding_method: "greedy_search".into(),
                ..Default::default()
            };
            TransducerRecognizer::new(config)
                .map_err(|e| format!("Parakeet init: {}", e))
                .map(|mut r| r.transcribe(SAMPLE_RATE, samples).trim().to_string())
        }
    };
    match result {
        Ok(text) => text,
        Err(e) => {
            eprintln!("STT decode_offline error: {}", e);
            String::new()
        }
    }
}

// ── Engine ──

pub struct SttEngine {
    models_dir: PathBuf,
    active_model: SttModel,
    is_listening: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
    _stream: Option<cpal::Stream>,
}

unsafe impl Send for SttEngine {}
unsafe impl Sync for SttEngine {}

impl SttEngine {
    pub fn new(models_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&models_dir).ok();
        Self {
            models_dir,
            active_model: SttModel::MoonshineTiny,
            is_listening: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
            audio_buffer: Arc::new(Mutex::new(Vec::new())),
            _stream: None,
        }
    }

    pub fn active_model(&self) -> SttModel {
        self.active_model
    }

    pub fn set_active_model(&mut self, model: SttModel) {
        self.active_model = model;
        eprintln!("STT: switched to {}", model.label());
    }

    pub fn model_dir_for(&self, model: SttModel) -> PathBuf {
        self.models_dir.join(model.dir_name())
    }

    pub fn is_downloaded(&self, model: SttModel) -> bool {
        let dir = self.model_dir_for(model);
        match model {
            SttModel::MoonshineTiny | SttModel::MoonshineBase => {
                dir.join("preprocess.onnx").exists()
                    && dir.join("encode.int8.onnx").exists()
                    && dir.join("uncached_decode.int8.onnx").exists()
                    && dir.join("cached_decode.int8.onnx").exists()
                    && dir.join("tokens.txt").exists()
            }
            SttModel::Parakeet06b => {
                dir.join("model.int8.onnx").exists() && dir.join("tokens.txt").exists()
            }
        }
    }

    /// Returns true if the active model is downloaded and ready.
    pub fn is_active_ready(&self) -> bool {
        self.is_downloaded(self.active_model)
    }

    pub fn download_model(&self, model: SttModel) -> Result<(), String> {
        if self.is_downloaded(model) {
            return Ok(());
        }
        std::fs::create_dir_all(&self.models_dir).map_err(|e| e.to_string())?;

        eprintln!("STT: downloading {}...", model.label());
        let curl = std::process::Command::new("curl")
            .args(["-L", "--fail", "-o", "-", model.download_url()])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start curl: {}", e))?;

        let status = std::process::Command::new("tar")
            .args(["-xjf", "-", "-C"])
            .arg(&self.models_dir)
            .stdin(curl.stdout.ok_or("Failed to pipe curl output")?)
            .status()
            .map_err(|e| format!("Failed to extract: {}", e))?;

        if !status.success() {
            return Err(format!("Download failed for {}", model.label()));
        }
        eprintln!("STT: {} downloaded", model.label());
        Ok(())
    }

    pub fn is_listening(&self) -> bool {
        self.is_listening.load(Ordering::SeqCst)
    }

    pub fn start_listening(&mut self) -> Result<(), String> {
        if self.is_listening() {
            return Ok(());
        }
        if !self.is_active_ready() {
            return Err(format!("{} not downloaded", self.active_model.label()));
        }

        if let Ok(mut buf) = self.audio_buffer.lock() {
            buf.clear();
        }

        self.cancel.store(false, Ordering::SeqCst);
        self.is_listening.store(true, Ordering::SeqCst);

        let host = cpal::default_host();
        let device = host.default_input_device().ok_or("No input device found")?;
        eprintln!("STT: using input device: {:?}", device.name());

        let default_config = device.default_input_config().map_err(|e| format!("No default input config: {}", e))?;
        let device_rate = default_config.sample_rate().0;
        let device_channels = default_config.channels() as usize;

        let config = cpal::StreamConfig {
            channels: default_config.channels(),
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };

        let buffer = Arc::clone(&self.audio_buffer);
        let is_listening = Arc::clone(&self.is_listening);

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !is_listening.load(Ordering::SeqCst) { return; }
                    let mono: Vec<f32> = if device_channels > 1 {
                        data.chunks(device_channels).map(|f| f.iter().sum::<f32>() / device_channels as f32).collect()
                    } else {
                        data.to_vec()
                    };
                    let resampled = if device_rate != SAMPLE_RATE {
                        let ratio = SAMPLE_RATE as f64 / device_rate as f64;
                        let out_len = (mono.len() as f64 * ratio).ceil() as usize;
                        (0..out_len).map(|i| {
                            let src = i as f64 / ratio;
                            let idx = src as usize;
                            let frac = src - idx as f64;
                            if idx + 1 < mono.len() {
                                mono[idx] * (1.0 - frac as f32) + mono[idx + 1] * frac as f32
                            } else if idx < mono.len() { mono[idx] } else { 0.0 }
                        }).collect()
                    } else { mono };
                    if let Ok(mut buf) = buffer.lock() { buf.extend_from_slice(&resampled); }
                },
                |err| { eprintln!("STT mic error: {}", err); },
                None,
            )
            .map_err(|e| format!("Failed to build input stream: {}", e))?;

        stream.play().map_err(|e| format!("Failed to start mic: {}", e))?;
        self._stream = Some(stream);
        eprintln!("STT: listening started ({})", self.active_model.label());
        Ok(())
    }

    pub fn stop_listening(&mut self) -> String {
        // Kept for any callers that still want the all-in-one version.
        // Prefer `snapshot_and_stop` + `decode_offline` on hot paths so
        // the SttState mutex isn't held across the ~300-500 ms decode.
        let snap = self.snapshot_and_stop();
        if snap.samples.is_empty() { return String::new(); }
        decode_offline(&snap.samples, snap.model, &snap.models_dir)
    }

    /// Fast-path stop: flips the stop flags, drops the cpal stream,
    /// and returns a snapshot of the audio buffer plus what the caller
    /// needs to run the decode themselves (model + models_dir). Holds
    /// the mutex only long enough to copy samples (~1 ms), not across
    /// the 300-500 ms final decode.
    pub fn snapshot_and_stop(&mut self) -> StopSnapshot {
        self.is_listening.store(false, Ordering::SeqCst);
        self.cancel.store(true, Ordering::SeqCst);
        self._stream = None;
        let samples = if let Ok(buf) = self.audio_buffer.lock() {
            buf.clone()
        } else {
            Vec::new()
        };
        StopSnapshot {
            samples,
            model: self.active_model,
            models_dir: self.models_dir.clone(),
        }
    }

    pub fn spawn_decode_loop(&self, sink: Arc<dyn EventSink>) {
        let buffer = Arc::clone(&self.audio_buffer);
        let is_listening = Arc::clone(&self.is_listening);
        let cancel = Arc::clone(&self.cancel);
        let models_dir = self.models_dir.clone();
        let active_model = self.active_model;

        std::thread::spawn(move || {
            let mut last_text = String::new();
            // Stable-word filter state. We only emit a word once it
            // has appeared in TWO consecutive decodes at the same
            // position — the streaming decoder sometimes hallucinates
            // a word in one tick and drops it the next, and without
            // this filter those transients reached the UI as "random
            // interjected words". Trade-off: each real word is
            // delayed ~one decode tick (250 ms) before display.
            let mut last_words: Vec<String> = Vec::new();
            let mut emitted_count: usize = 0;

            // Build the recognizer ONCE before the loop. Previous
            // implementation rebuilt it every iteration (each 600 ms),
            // which reloaded ~4 ONNX models per cycle — 100-300 ms of
            // wasted work per tick AND a large chunk of the visible
            // press-to-first-word latency. Holding a single recognizer
            // for the lifetime of the listening session cuts first-word
            // latency dramatically.
            //
            // The two model families have different recognizer types
            // (sherpa-rs doesn't share a trait), so we build a local
            // enum to keep the rest of the loop polymorphic.
            enum Rec {
                Moonshine(MoonshineRecognizer),
                Transducer(TransducerRecognizer),
            }

            let dir = models_dir.join(active_model.dir_name());
            let recognizer = match active_model {
                SttModel::MoonshineTiny | SttModel::MoonshineBase => {
                    let config = MoonshineConfig {
                        preprocessor: dir.join("preprocess.onnx").to_string_lossy().into(),
                        encoder: dir.join("encode.int8.onnx").to_string_lossy().into(),
                        uncached_decoder: dir.join("uncached_decode.int8.onnx").to_string_lossy().into(),
                        cached_decoder: dir.join("cached_decode.int8.onnx").to_string_lossy().into(),
                        tokens: dir.join("tokens.txt").to_string_lossy().into(),
                        num_threads: Some(2),
                        ..Default::default()
                    };
                    MoonshineRecognizer::new(config).ok().map(Rec::Moonshine)
                }
                SttModel::Parakeet06b => {
                    let config = TransducerConfig {
                        encoder: dir.join("model.int8.onnx").to_string_lossy().into(),
                        decoder: dir.join("decoder.onnx").to_string_lossy().into(),
                        joiner: dir.join("joiner.onnx").to_string_lossy().into(),
                        tokens: dir.join("tokens.txt").to_string_lossy().into(),
                        num_threads: 4,
                        sample_rate: SAMPLE_RATE as i32,
                        feature_dim: 80,
                        decoding_method: "greedy_search".into(),
                        ..Default::default()
                    };
                    TransducerRecognizer::new(config).ok().map(Rec::Transducer)
                }
            };
            let mut recognizer = match recognizer {
                Some(r) => r,
                None => {
                    eprintln!("STT: failed to build recognizer for {}", active_model.label());
                    return;
                }
            };

            // Much shorter initial wait — the loop below already
            // skips decode until the buffer reaches 0.5 s of audio,
            // so there's no benefit to idling a full DECODE_INTERVAL
            // before the first check. 100 ms is enough to let the
            // mic stream fill its first few buffers.
            std::thread::sleep(std::time::Duration::from_millis(100));

            while is_listening.load(Ordering::SeqCst) && !cancel.load(Ordering::SeqCst) {
                let samples = if let Ok(buf) = buffer.lock() { buf.clone() } else { continue };

                // Emit amplitude
                if samples.len() >= 800 {
                    let tail = &samples[samples.len().saturating_sub(800)..];
                    let sum: f32 = tail.iter().map(|s| s * s).sum();
                    let amp = (sum / tail.len() as f32).sqrt().min(1.0);
                    sink.emit_json(
                        "stt-amplitude",
                        serde_json::to_value(SttAmplitudeEvent { amplitude: amp })
                            .unwrap_or(serde_json::Value::Null),
                    );
                }

                if samples.len() < (SAMPLE_RATE as usize / 2) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    continue;
                }

                let text = match &mut recognizer {
                    Rec::Moonshine(r) => r.transcribe(SAMPLE_RATE, &samples).text.trim().to_string(),
                    Rec::Transducer(r) => r.transcribe(SAMPLE_RATE, &samples).trim().to_string(),
                };

                if !text.is_empty() && text != last_text {
                    let words: Vec<String> = text
                        .split_whitespace()
                        .map(|w| w.to_string())
                        .collect();
                    // Stable prefix: the longest run where this decode
                    // agrees with the previous one word-for-word. Only
                    // words in the stable prefix are safe to emit —
                    // anything beyond may still be hallucinated and
                    // dropped next tick.
                    let common_len = words
                        .iter()
                        .zip(last_words.iter())
                        .take_while(|(a, b)| a == b)
                        .count();
                    if common_len > emitted_count {
                        let new_words: Vec<String> =
                            words[emitted_count..common_len].to_vec();
                        let stable_text = words[..common_len].join(" ");
                        sink.emit_json(
                            "stt-partial",
                            serde_json::to_value(SttPartialEvent {
                                text: stable_text,
                                new_words,
                            })
                            .unwrap_or(serde_json::Value::Null),
                        );
                        emitted_count = common_len;
                    }
                    last_words = words;
                    last_text = text.clone();
                }

                std::thread::sleep(std::time::Duration::from_millis(DECODE_INTERVAL_MS));
            }
            eprintln!("STT: decode loop ended");
        });
    }
}
