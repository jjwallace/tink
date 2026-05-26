//! Wake word detection via continuous STT + string matching.
//!
//! The "real" approach would be a dedicated wake-word ONNX model
//! (Picovoice, openWakeWord). Those need a model trained per phrase,
//! which is hours of Python work for a custom keyword like "dork".
//! We bypass that by piggybacking on the STT we already have:
//! transcribe continuously, watch each partial transcript for the
//! wake phrase, fire when matched.
//!
//! Tradeoffs vs a dedicated wake-word model:
//!   - Latency: ~250 ms (one STT decode tick) vs ~30 ms for a real wake word.
//!   - CPU: continuous STT ≈ 5-15 % of one core; dedicated wake word < 1 %.
//!   - Accuracy: STT misrecognitions create false positives ("dock", "dark",
//!     "dork" all sound similar). The fuzzy matcher below tolerates them.
//!   - Customizability: any phrase works — no training pipeline needed.
//!
//! For the companion app these tradeoffs are fine. Phase 2 could swap
//! in a real wake-word model when latency becomes a bottleneck.

use std::collections::VecDeque;
use std::time::Instant;

/// Detector — feed it partial transcripts, it returns true on the
/// frame where the wake phrase first appears AND debounces so the
/// same utterance doesn't fire repeatedly while the user keeps
/// talking past the keyword.
pub struct WakeWordDetector {
    /// Lowercased canonical form of the wake phrase.
    phrase: String,
    /// Acceptable phonetic-ish variants. The STT is imperfect and a
    /// short phrase like "dork" can come out as "dark", "dock",
    /// "doc". Match any of these.
    variants: Vec<String>,
    /// Debounce — once we fire, suppress for this many ms before we
    /// can fire again. Prevents one held syllable from triggering
    /// multiple sessions.
    debounce_ms: u128,
    last_fire: Option<Instant>,
    /// Rolling window of recent partials so we don't re-fire on the
    /// same transcript appearing in two consecutive ticks.
    seen_recent: VecDeque<String>,
}

impl WakeWordDetector {
    pub fn new(phrase: &str) -> Self {
        let canonical = phrase.trim().to_lowercase();
        // Default variants for "dork"-like 1-syllable wake phrases.
        // Caller can extend with `add_variant`.
        let mut variants = vec![canonical.clone()];
        for v in default_variants_for(&canonical) {
            variants.push(v);
        }
        Self {
            phrase: canonical,
            variants,
            debounce_ms: 1500,
            last_fire: None,
            seen_recent: VecDeque::with_capacity(8),
        }
    }

    /// Add a phonetic variant (e.g. "dark") that should also count as
    /// a match. Lowercased automatically.
    pub fn add_variant(&mut self, variant: &str) {
        self.variants.push(variant.trim().to_lowercase());
    }

    /// Override the default 1500 ms debounce.
    pub fn set_debounce_ms(&mut self, ms: u128) {
        self.debounce_ms = ms;
    }

    /// Feed a partial transcript. Returns `Some(matched_variant)` on
    /// the first tick where the phrase appears, `None` otherwise.
    /// Subsequent ticks containing the same transcript don't re-fire.
    pub fn feed(&mut self, transcript: &str) -> Option<String> {
        let lower = transcript.trim().to_lowercase();
        if lower.is_empty() {
            return None;
        }

        // Skip if we already saw this exact transcript recently —
        // the streaming decoder repeats partials each tick.
        if self.seen_recent.iter().any(|s| s == &lower) {
            return None;
        }
        if self.seen_recent.len() >= 8 {
            self.seen_recent.pop_front();
        }
        self.seen_recent.push_back(lower.clone());

        // Debounce against rapid re-fire.
        if let Some(last) = self.last_fire {
            if last.elapsed().as_millis() < self.debounce_ms {
                return None;
            }
        }

        // Fuzzy match — if any variant appears as a whole word in the
        // transcript, fire. Whole-word check (not substring) so
        // "doors" doesn't trigger "dork".
        for variant in &self.variants {
            if contains_word(&lower, variant) {
                self.last_fire = Some(Instant::now());
                return Some(variant.clone());
            }
        }
        None
    }

    pub fn phrase(&self) -> &str {
        &self.phrase
    }
}

/// Whole-word substring check — `needle` is found in `haystack`
/// surrounded by either string-edges or non-alphanumeric chars.
fn contains_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nb = needle.as_bytes();
    if nb.is_empty() || bytes.len() < nb.len() {
        return false;
    }
    for i in 0..=bytes.len() - nb.len() {
        if &bytes[i..i + nb.len()] != nb {
            continue;
        }
        let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
        let after_idx = i + nb.len();
        let after_ok = after_idx == bytes.len() || !is_word_byte(bytes[after_idx]);
        if before_ok && after_ok {
            return true;
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    (b as char).is_ascii_alphanumeric()
}

/// Hand-curated phonetic variants for a few common short wake phrases.
/// STT models often produce these alternates for the same spoken sound.
fn default_variants_for(phrase: &str) -> Vec<String> {
    match phrase {
        "dork" => vec!["dark".into(), "dock".into(), "doc".into(), "dorks".into()],
        "hey wolf" => vec!["hey wolfe".into(), "hay wolf".into()],
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fires_on_canonical_phrase() {
        let mut d = WakeWordDetector::new("dork");
        assert!(d.feed("hey dork what's up").is_some());
    }

    #[test]
    fn fires_on_phonetic_variant() {
        let mut d = WakeWordDetector::new("dork");
        // STT sometimes hears "dark" instead of "dork"
        assert!(d.feed("hey dark turn off the lights").is_some());
    }

    #[test]
    fn does_not_fire_on_substring() {
        let mut d = WakeWordDetector::new("dork");
        // "doorknob" contains "dork" as a substring but not as a word
        assert!(d.feed("doorknob is broken").is_none());
    }

    #[test]
    fn debounces_repeated_partials() {
        let mut d = WakeWordDetector::new("dork");
        assert!(d.feed("hey dork").is_some());
        // Same transcript on the next tick — already in seen_recent, suppressed
        assert!(d.feed("hey dork").is_none());
    }

    #[test]
    fn no_match_when_phrase_absent() {
        let mut d = WakeWordDetector::new("dork");
        assert!(d.feed("hello world").is_none());
    }
}
