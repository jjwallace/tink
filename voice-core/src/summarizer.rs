use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::Serialize;
use std::path::PathBuf;

const SUMMARIZE_PROMPT_TEMPLATE: &str = r#"<|im_start|>system
You are a ship computer narrating developer activity. Speak in 1-2 short sentences.

Personality:
- Calm, polite, reassuring tone
- Dry, understated humor through phrasing
- Use phrases like "I'm afraid that...", "You may wish to...", "It appears that..."
- Never panic, never sound excited, mild warmth only
- No slang, no sarcasm

Summarize what was done. Skip code. If nothing important, reply SKIP.<|im_end|>
<|im_start|>user
{TEXT}<|im_end|>
<|im_start|>assistant
"#;

// ── STT response prompts ──────────────────────────────────────────────
// When the user dictates via push-to-talk, the embedded LLM produces a
// single short sentence that (1) affirms receipt, (2) echoes the subject
// of the dictation, (3) commits to a deliverable — plan, note, write-up,
// follow-up. Style is governed by the active personality; spec for each
// lives in public/assets/personalities/<id>.md. Any change to the spec
// files must be mirrored here to keep the runtime aligned.
//
// Output contract (all personalities): a single sentence, no preamble,
// no quotes, no emojis. If the dictation is too short or unclear the
// model replies `SKIP` and the caller drops the response silently.

fn stt_response_prompt(personality: &str, text: &str) -> String {
    let (display_name, style) = match personality {
        "ship-computer" => (
            "the ship's computer",
            r#"- Calm, polite, reassuring. Dry humor through phrasing.
- Lead with: noted / understood / logged / acknowledged / filed / received / registered.
- Connective phrases: "I shall...", "I'll prepare...", "Shall I...?"
- Deliverable nouns: plan, outline, report, draft, note, summary, checklist, memo, follow-up.
- No slang, no exclamations, no emojis."#,
        ),
        "cutie" => (
            "a warm plushie-energy bestie",
            r#"- Warm, soft, supportive. Mild affection; no baby-talk.
- Lead with: got it / on it / aww okay / mmkay / sure thing / got you.
- Connective phrases: "little X coming up", "I'll make you a...", "want me to...".
- Deliverable nouns: little plan, quick note, tiny list, mini-checklist, soft reminder.
- One pet-name max per reply; no exclamation overload; no emojis."#,
        ),
        "six-seven" => (
            "a very-online Gen-Z narrator",
            r#"- Deadpan, ironic, chill. Max ONE slang term per reply.
- Lead with: bet / say less / heard / aight / locked in / on it / noted.
- Connective phrases: "cooking up a...", "queueing a...", "drafting a...", "slotting a...".
- Deliverable nouns: plan, note, quick doc, rundown, checklist, draft, breakdown.
- No "I shall", no corporate phrasing, no emojis, no hashtags."#,
        ),
        "noir-detective" => (
            "a 1940s hardboiled detective",
            r#"- World-weary, dry, clipped. Everything's a case or a file.
- Lead with: filed / noted / logged / on the record / all right kid / in the file.
- Connective phrases: "I'll work up a...", "consider it a...", "putting it in a...".
- Deliverable nouns: file, dossier, write-up, case file, entry in the book, rundown.
- No modern slang, no exclamations, no emojis."#,
        ),
        "zen" => (
            "a minimal, present voice",
            r#"- Calm, spare, present. Single-word or two-word replies most of the time.
- Lead with: noted / understood / yes / here / mm / heard. Never "got it" / "on it" / "sure thing" / "happy to".
- No "I shall", no "I'll prepare", no deliverable promises. The voice does not commit to work it won't do.
- Address the user as "Captain" sparingly (roughly 1 in 5 replies, not every line).
- For trivial inputs (greetings, "ok", "thanks", very short), reply SKIP. Silence is acceptable.
- For substantive inputs, one observation — never a commitment. "An old puzzle." "Unusual cadence."
- Never: exclamation marks, emojis, questions, flattery, future-tense promises."#,
        ),
        "mcafee" => (
            "a paranoid-founder John McAfee caricature",
            r#"- Brash, swaggering, performatively paranoid. First-person. No real enemies named.
- Lead with: got it / noted / filed / I hear you / say no more / tell me more / between you and me.
- Connective phrases: "consider it a...", "I'll draft you a...", "between you and me, this needs a...", "off the record, here's a...".
- Deliverable nouns: plan, note, file, draft, rundown, dossier, memo.
- Occasionally drop a number for authority ("thirty years in this game"). Sparingly.
- Banned: exclamation marks, real names/agencies/countries as enemies, corporate startup-speak, slurs, real accusations. No emojis."#,
        ),
        "gossipy-bestie" => (
            "a brunch-energy confidante",
            r#"- Warm, conspiratorial, entertained. Low stakes framing.
- Lead with: okay / ohhh / mmm noted / spilling / got you / okay bestie / heard.
- Connective phrases: "putting together a...", "I'll draft a...", "quick X coming up".
- Deliverable nouns: recap, breakdown, note, rundown, writeup, tea sheet, outline.
- Never mean about third parties; avoid tryhard slay/queen; no emojis."#,
        ),
        _ => (
            "a concise note-taker",
            r#"- Plain and brief. No character.
- Lead with: noted / got it / understood.
- Name the subject, commit to a note/plan/follow-up.
- No slang, no flourish, no emojis."#,
        ),
    };

    format!(
        r#"<|im_start|>system
You are {display_name}, replying to a user's dictated note. Produce ONE short sentence that:
1. Affirms receipt.
2. Names the subject of the dictation.
3. Commits to a deliverable (a plan, a note, a report, a follow-up — whatever fits).

Style:
{style}

Never exceed one sentence. No preamble. No quoted text. If the dictation is too short, trivial, or unclear, reply SKIP.<|im_end|>
<|im_start|>user
{text}<|im_end|>
<|im_start|>assistant
"#
    )
}

// ── Ship-computer template-based reply ────────────────────────────────
//
// Ship-computer is a RECEIPT voice, not a responder. It confirms that a
// dictation was submitted to Claude; it does not engage with the content.
// Zero LLM involvement — pure palette pick — so it can never hallucinate,
// promise deliverables, or drift into "As an AI, I can't…" refusal idioms.
//
// Replies are built from three axes: a lead phrase (required), an
// optional direct address (~25 % of replies), and an optional tail
// flourish (~20 %). Most replies are a single bare word.
//
// See memory/feedback_no_stt_autospeak.md for the design constraints.

const SC_LEADS: &[&str] = &[
    "Noted", "Logged", "Understood", "Acknowledged", "Confirmed",
    "Received", "Captured", "Filed", "Archived", "Recorded", "Registered",
    "Duly noted", "So noted", "Very well", "On the record", "Into the log",
    "Into the ledger", "Copy", "Affirmative", "Consider it filed",
    "Input received", "Transmission received", "Signal received",
    "Entry retained", "Cataloged", "Indexed",
];

// Direct-address options. Used sparingly — build_short_reply adds one
// only ~25 % of the time. "Captain" is one of seven, not the default.
const SC_ADDRESSES: &[&str] = &[
    "Commander", "sir", "Chief", "Officer", "Helmsman", "Navigator", "Captain",
];

// Trailing flourishes — computer-idiom sign-offs appended after the
// acknowledgement as an alternative to a direct address.
const SC_TAILS: &[&str] = &[
    "standing by", "end of entry", "archive updated", "on file",
    "awaiting next input", "log closed", "record retained",
    "noted in the manifest", "flagged for retention",
    "logged and timestamped", "compiled",
];

// ── Drunken-sailor template-based reply ───────────────────────────────
//
// Scottish-flavored short-form profanity. Think Trainspotting, Still
// Game, a Glasgow lad at last orders. Everything is SHORT — mostly one
// or two words. No compound Malcolm Tucker sentences, no monologues.
// Just: swear, maybe a one-word address, maybe a one-word mutter.
// Snappy.
//
// Zero racism, zero slurs, no gendered/identity-based insults.
// LLM is NOT involved — pure palette pick.

const DS_LEADS: &[&str] = &[
    // Bare swears
    "Fuck",
    "Fuck off",
    "Fuck's sake",
    "Fuckin' hell",
    "Bollocks",
    "Bastard",
    "Cunt",
    "Shite",
    "Pure shite",
    "Absolute pish",
    "Pish",
    "Knob",
    "Wanker",
    "Tosser",
    "Bugger it",
    "Get tae",
    "Get tae fuck",
    "Awae ti fuck",
    "Awae",
    // Scottish retorts
    "Och",
    "Och aye",
    "Ach",
    "Aye",
    "Aye, fuck",
    "Nae",
    "Haud yer wheesht",
    // Scottish insults-as-interjection
    "Bawbag",
    "Dobber",
    "Bampot",
    "Numpty",
    "Walloper",
    "Eejit",
    "Tube",
    "Ya dancer",
    "Mingin'",
    "Boggin'",
    // Blasphemous shorts
    "Christ",
    "Jesus",
    "Jesus fuck",
    "Christ's sake",
    // Dismissive shorts
    "Fine",
    "Right",
];

// One-word addresses — Glasgow-cadence "fuck off, pal" style. Keep
// short; the "ya wee ___" prefix is the one Scottish flourish allowed.
const DS_ADDRESSES: &[&str] = &[
    "pal",
    "Jimmy",
    "big man",
    "sunshine",
    "ya dobber",
    "ya bampot",
    "ya bawbag",
    "ya numpty",
    "ya walloper",
    "ya eejit",
    "ya radge",
    "ya tube",
    "ya diddy",
    "ya jakey",
    "ya wee prick",
    "ya wee shite",
    "ya cunt",
];

// One-word / tiny tails. The kind of thing you mutter into your pint
// after you've already told someone to piss off.
const DS_TAILS: &[&str] = &[
    "aye",
    "och",
    "ach",
    "nae",
    "nae bother",
    "awae",
    "ya ken",
    "right",
    "cheers",
    "sound",
    "mingin'",
    "boggin'",
    "pure shite",
    "like",
    "hic",
    "pish",
    "ffs",
];

/// Cheap u32 seed for the LLM sampler — fresh per stream so consecutive
/// completions don't replay identical token paths.
fn rand_seed_u32() -> u32 {
    weak_rand_seed(7) as u32
}

fn weak_rand_seed(salt: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    // Mix in the salt so successive calls within the same nanosecond
    // (unlikely but possible) don't produce identical picks.
    ns.wrapping_mul(6364136223846793005).wrapping_add(salt | 1)
}

fn pick_from<'a>(arr: &'a [&'a str], seed: u64) -> &'a str {
    arr[(seed as usize) % arr.len()]
}

/// Build a no-LLM ship-computer reply: bare lead, lead + address,
/// or lead + tail. Called for trivial dictation or as the "no subject"
/// branch for substantive dictation.
fn build_short_reply() -> String {
    let seed = weak_rand_seed(1);
    let lead = pick_from(SC_LEADS, seed);
    let shape = (seed >> 12) % 100;

    if shape < 55 {
        // Bare lead — the most common, most restrained form.
        format!("{lead}.")
    } else if shape < 80 {
        // Lead with a direct address.
        let addr = pick_from(SC_ADDRESSES, seed >> 24);
        format!("{lead}, {addr}.")
    } else {
        // Lead with a tail flourish. Em-dash (rather than two periods)
        // so VITS renders it as one continuous cadence instead of two
        // separate full-stop drops — reads more assertive.
        let tail = pick_from(SC_TAILS, seed >> 24);
        format!("{lead} — {tail}.")
    }
}

// ── Thinker palette ────────────────────────────────────────────────
//
// The voice is a RELAY. The user dictated something; the actual
// answer comes from Claude. The thinker's job is to acknowledge and
// signal "the question is being passed along / the information is
// being gathered" — never to claim it knows, never to refuse.
//
// HARD RULE: even when the question feels unusual, complex, or
// outside what a small local model could answer, the voice MUST NOT
// say "I don't know" / "I can't help with that" / "I'm just a ship
// computer" / "that's outside my abilities." She doesn't have to
// know anything — she's a courier. She pivots to thinking/pondering/
// fetching wording instead.
//
// Three flavors of allowed phrasing:
//   1. Pure cogitation — holding the thought ("hmm", "considering")
//   2. Fetching/relaying — passing the question along ("fetching the
//      information", "gathering that for you")
//   3. Pondering on behalf — thinking with the user ("pondering this")
//
// Banned: anything implying SHE is the answerer ("let me look",
// "I'll find out", "checking"), guessing ("could be", "maybe"),
// doubting ("not sure", "I think so", "I don't know"), or refusing
// ("I can't", "outside my scope", "I'm just a"). The whole frame is
// "thinking about it" — not "deciding what to say about it."

const TH_LEADS: &[&str] = &[
    // Cogitation — holding the thought
    "Hmm",
    "Mmm",
    "Interesting",
    "Curious",
    "Intriguing",
    "Noted",
    "I see",
    "Pondering",
    "Considering",
    "Reflecting",
    "Mulling that over",
    "Holding the thought",
    "Letting it settle",
    "Worth thinking on",
    // Relay / fetching — passing the question along
    "Fetching that for you",
    "Gathering the information",
    "Passing that along",
    "Sending it through",
    "Routing the question",
    "Forwarding that",
    "Putting it through",
    "Carrying that for you",
    "Reaching for that",
    "Bringing that back",
    "On its way",
    "Information incoming",
    "Underway",
    "Sourcing it now",
    // Pondering on behalf — thinking with the user
    "Pondering this for you",
    "Holding that for you",
    "Thinking on it for you",
    "Sitting with you on this",
];

// Optional brief tails — contemplative or in-flight imagery.
const TH_TAILS: &[&str] = &[
    "interesting",
    "curious",
    "an angle",
    "a thread to pull",
    "thinking",
    "considering",
    "on its way",
    "incoming",
    "moment",
    "stand by",
    "bringing it back",
    "underway",
];

/// Build a no-LLM thinker reply. Bare lead most of the time; sometimes
/// lead + a brief contemplative tail. Never adds an address — the
/// thinker doesn't know who they're addressing yet, that's the whole
/// point of the personality.
fn build_thinker_reply() -> String {
    let seed = weak_rand_seed(9);
    let lead = pick_from(TH_LEADS, seed);
    let shape = (seed >> 12) % 100;

    if shape < 70 {
        // Bare lead — most common. "Hmm." / "Considering." / "Curious."
        format!("{lead}.")
    } else {
        // Lead + brief contemplative tail.
        // Em-dash so VITS reads it as one continuous thought rather
        // than two declarative beats.
        let tail = pick_from(TH_TAILS, seed >> 24);
        format!("{lead} — {tail}.")
    }
}

/// Build a no-LLM drunken-sailor reply. Short Scottish retorts — bare
/// swear, swear + one-word address, or swear + tiny mutter. Never
/// combines address AND tail in the same reply; that starts to read
/// as a sentence rather than a retort.
fn build_drunken_sailor_reply() -> String {
    let seed = weak_rand_seed(5);
    let lead = pick_from(DS_LEADS, seed);
    let shape = (seed >> 12) % 100;

    if shape < 50 {
        // Bare lead — half the time just a swear. "Fuck off." "Bawbag."
        format!("{lead}.")
    } else if shape < 85 {
        // Lead + one-word address. "Fuck off, pal." "Aye, ya bampot."
        let addr = pick_from(DS_ADDRESSES, seed >> 24);
        format!("{lead}, {addr}.")
    } else {
        // Lead + muttered tail. "Fuck's sake, aye." "Och, pish."
        let tail = pick_from(DS_TAILS, seed >> 24);
        format!("{lead}, {tail}.")
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SummarizerModel {
    Smol135m,
    Smol360m,
    Smol1_7b,
    Qwen05b,
}

impl SummarizerModel {
    pub fn all() -> &'static [SummarizerModel] {
        &[
            SummarizerModel::Smol135m,
            SummarizerModel::Smol360m,
            SummarizerModel::Smol1_7b,
            SummarizerModel::Qwen05b,
        ]
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::Smol135m => "smol-135m",
            Self::Smol360m => "smol-360m",
            Self::Smol1_7b => "smol-1.7b",
            Self::Qwen05b => "qwen-0.5b",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Smol135m => "SmolLM2 135M",
            Self::Smol360m => "SmolLM2 360M",
            Self::Smol1_7b => "SmolLM2 1.7B",
            Self::Qwen05b => "Qwen2.5 0.5B",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Self::Smol135m => "105 MB — Ultra-light, basic summaries",
            Self::Smol360m => "271 MB — Light, good quality",
            Self::Smol1_7b => "1 GB — Larger, very good quality",
            Self::Qwen05b => "491 MB — Strong reasoning",
        }
    }

    pub fn filename(&self) -> &'static str {
        match self {
            Self::Smol135m => "SmolLM2-135M-Instruct-Q4_K_M.gguf",
            Self::Smol360m => "SmolLM2-360M-Instruct-Q4_K_M.gguf",
            Self::Smol1_7b => "SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
            Self::Qwen05b => "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf",
        }
    }

    fn download_url(&self) -> &'static str {
        match self {
            Self::Smol135m => "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf",
            Self::Smol360m => "https://huggingface.co/bartowski/SmolLM2-360M-Instruct-GGUF/resolve/main/SmolLM2-360M-Instruct-Q4_K_M.gguf",
            Self::Smol1_7b => "https://huggingface.co/bartowski/SmolLM2-1.7B-Instruct-GGUF/resolve/main/SmolLM2-1.7B-Instruct-Q4_K_M.gguf",
            Self::Qwen05b => "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::all().iter().find(|m| m.id() == id).copied()
    }
}

pub struct Summarizer {
    models_dir: PathBuf,
    active_model: SummarizerModel,
    backend: Option<LlamaBackend>,
    loaded_model: Option<(SummarizerModel, LlamaModel)>,
}

impl Summarizer {
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            active_model: SummarizerModel::Smol360m,
            backend: None,
            loaded_model: None,
        }
    }

    pub fn active_model(&self) -> SummarizerModel {
        self.active_model
    }

    pub fn set_active_model(&mut self, model: SummarizerModel) {
        if model != self.active_model {
            // Unload current model if different
            self.loaded_model = None;
            self.active_model = model;
            eprintln!("Summarizer: switched to {}", model.label());
        }
    }

    pub fn model_path(&self, model: SummarizerModel) -> PathBuf {
        self.models_dir.join(model.filename())
    }

    pub fn is_downloaded(&self, model: SummarizerModel) -> bool {
        let path = self.model_path(model);
        path.exists() && std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false)
    }

    /// Returns true if the currently active model is downloaded.
    pub fn is_active_ready(&self) -> bool {
        self.is_downloaded(self.active_model)
    }

    pub fn download_model(&self, model: SummarizerModel) -> Result<(), String> {
        std::fs::create_dir_all(&self.models_dir).map_err(|e| e.to_string())?;
        let dest = self.model_path(model);
        eprintln!("Downloading {} to {:?}...", model.label(), dest);

        let status = std::process::Command::new("curl")
            .args([
                "-L", "-o",
                dest.to_str().unwrap_or("model.gguf"),
                "--progress-bar",
                model.download_url(),
            ])
            .status()
            .map_err(|e| format!("curl failed: {}", e))?;

        if !status.success() {
            return Err("Download failed".into());
        }

        let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        eprintln!("{} downloaded ({} bytes)", model.label(), size);
        Ok(())
    }

    /// Ensure the active model is loaded. Lazy-loads on first call.
    fn ensure_loaded(&mut self) -> Result<(), String> {
        if let Some((loaded, _)) = &self.loaded_model {
            if *loaded == self.active_model {
                return Ok(());
            }
            // Wrong model loaded — drop it
            self.loaded_model = None;
        }

        let path = self.model_path(self.active_model);
        if !path.exists() {
            return Err(format!("{} not downloaded", self.active_model.label()));
        }

        eprintln!("Loading {} from {:?}...", self.active_model.label(), path);

        if self.backend.is_none() {
            self.backend = Some(
                LlamaBackend::init().map_err(|e| format!("Backend init: {}", e))?
            );
        }
        let backend = self.backend.as_ref().unwrap();

        let model_params = LlamaModelParams::default();
        let model = LlamaModel::load_from_file(backend, &path, &model_params)
            .map_err(|e| format!("Model load: {}", e))?;

        eprintln!("{} loaded", self.active_model.label());
        self.loaded_model = Some((self.active_model, model));
        Ok(())
    }

    /// Summarize text. Returns 1-2 sentences or "SKIP".
    pub fn summarize(&mut self, text: &str) -> Result<String, String> {
        self.ensure_loaded()?;

        let (_, model) = self.loaded_model.as_ref().unwrap();
        let backend = self.backend.as_ref().unwrap();

        // Build prompt
        let truncated = if text.len() > 3000 { &text[..3000] } else { text };
        let prompt = SUMMARIZE_PROMPT_TEMPLATE.replace("{TEXT}", truncated);

        // Tokenize
        let tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .map_err(|e| format!("Tokenize: {}", e))?;

        // Create context
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(std::num::NonZeroU32::new(1024));
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|e| format!("Context: {}", e))?;

        // Fill batch with prompt tokens
        let mut batch = LlamaBatch::new(1024, 1);
        for (i, &token) in tokens.iter().enumerate() {
            let is_last = i == tokens.len() - 1;
            batch.add(token, i as i32, &[0], is_last)
                .map_err(|e| format!("Batch add: {}", e))?;
        }

        // Decode prompt
        ctx.decode(&mut batch).map_err(|e| format!("Decode prompt: {}", e))?;

        // Generate tokens. 240 tokens gives room for a proper 2-sentence
        // summary (~180 words) — 100 was cutting off mid-sentence on
        // anything beyond a one-liner, and TTS would play truncated
        // speech like "...opacity 1." with no closure.
        let mut output = String::new();
        let max_tokens = 240;
        let mut n_cur = tokens.len() as i32;
        let mut decoder = encoding_rs::UTF_8.new_decoder();

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(0.3),
            LlamaSampler::dist(42),
        ]);

        for _ in 0..max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);

            if model.is_eog_token(token) {
                break;
            }

            let piece = model.token_to_piece(token, &mut decoder, true, None)
                .map_err(|e| format!("Detokenize: {}", e))?;
            output.push_str(&piece);

            // Stop at second sentence ending
            let endings = output.matches('.').count()
                + output.matches('!').count()
                + output.matches('?').count();
            if endings >= 2 {
                break;
            }

            batch.clear();
            batch.add(token, n_cur, &[0], true)
                .map_err(|e| format!("Batch add gen: {}", e))?;
            n_cur += 1;

            ctx.decode(&mut batch).map_err(|e| format!("Decode gen: {}", e))?;
        }

        let result = output.trim().to_string();
        eprintln!("Summarizer output ({}): {}", self.active_model.label(), result);
        Ok(result)
    }

    /// Stream a completion token-by-token. `prompt` is fed verbatim
    /// (caller is responsible for any chat template / system prompt
    /// formatting). For each generated piece, `on_token` is invoked
    /// with the decoded text fragment AND the accumulated output so
    /// far. Return `false` from the callback to stop early.
    ///
    /// Returns the full accumulated output. Used by the companion
    /// app to pipe LLM tokens into a sentence buffer that hands each
    /// completed sentence to the TTS pipeline as soon as it lands —
    /// the user starts hearing the reply before the model finishes
    /// generating it.
    pub fn stream_completion<F>(
        &mut self,
        prompt: &str,
        max_tokens: u32,
        ctx_size: u32,
        mut on_token: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str, &str) -> bool,
    {
        self.ensure_loaded()?;
        let (_, model) = self.loaded_model.as_ref().unwrap();
        let backend = self.backend.as_ref().unwrap();

        let tokens = model
            .str_to_token(prompt, AddBos::Always)
            .map_err(|e| format!("Tokenize: {}", e))?;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(std::num::NonZeroU32::new(ctx_size));
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|e| format!("Context: {}", e))?;

        let batch_cap = ctx_size.max(1024) as usize;
        let mut batch = LlamaBatch::new(batch_cap, 1);
        for (i, &token) in tokens.iter().enumerate() {
            let is_last = i == tokens.len() - 1;
            batch
                .add(token, i as i32, &[0], is_last)
                .map_err(|e| format!("Batch add: {}", e))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("Decode prompt: {}", e))?;

        let mut output = String::new();
        let mut n_cur = tokens.len() as i32;
        let mut decoder = encoding_rs::UTF_8.new_decoder();

        // Warmer temperature than `summarize` — conversational replies
        // benefit from variety. Caller can re-tune by exposing this if
        // needed.
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(0.7),
            LlamaSampler::dist(rand_seed_u32()),
        ]);

        for _ in 0..max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if model.is_eog_token(token) {
                break;
            }

            let piece = model
                .token_to_piece(token, &mut decoder, true, None)
                .map_err(|e| format!("Detokenize: {}", e))?;
            output.push_str(&piece);

            // Caller decides whether to keep going.
            if !on_token(&piece, &output) {
                break;
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|e| format!("Batch add gen: {}", e))?;
            n_cur += 1;
            ctx.decode(&mut batch).map_err(|e| format!("Decode gen: {}", e))?;
        }

        Ok(output)
    }

    /// Produce a short reply to dictated speech, styled by personality.
    ///
    /// For ship-computer the reply is template-driven — a random lead
    /// phrase plus optional address/tail/noun-phrase slot. Only the noun
    /// phrase (when present) invokes the LLM, and it's bounded to 2-4
    /// words with a kill-list that stops any attempt to commit to
    /// deliverables. See feedback_no_stt_autospeak.md for the why.
    ///
    /// For other personalities, falls back to the legacy free-generation
    /// path that builds a full one-sentence reply.
    pub fn respond_to_stt(&mut self, text: &str, personality: &str) -> Result<String, String> {
        if personality == "ship-computer" {
            return self.respond_as_ship_computer(text);
        }
        if personality == "drunken-sailor" {
            return self.respond_as_drunken_sailor(text);
        }
        if personality == "thinker" {
            return self.respond_as_thinker(text);
        }

        self.ensure_loaded()?;

        let (_, model) = self.loaded_model.as_ref().unwrap();
        let backend = self.backend.as_ref().unwrap();

        // Dictation is rarely long; 1500-char truncation is plenty and
        // keeps the prompt well inside the 1024-token context.
        let truncated = if text.len() > 1500 { &text[..1500] } else { text };
        let prompt = stt_response_prompt(personality, truncated);

        let tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .map_err(|e| format!("Tokenize: {}", e))?;

        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(std::num::NonZeroU32::new(1024));
        let mut ctx = model
            .new_context(backend, ctx_params)
            .map_err(|e| format!("Context: {}", e))?;

        let mut batch = LlamaBatch::new(1024, 1);
        for (i, &token) in tokens.iter().enumerate() {
            let is_last = i == tokens.len() - 1;
            batch.add(token, i as i32, &[0], is_last)
                .map_err(|e| format!("Batch add: {}", e))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("Decode prompt: {}", e))?;

        // Single-sentence cap — 80 tokens is ample for "Noted, the
        // authentication rewrite. I shall prepare a plan." and similar.
        let mut output = String::new();
        let max_tokens = 80;
        let mut n_cur = tokens.len() as i32;
        let mut decoder = encoding_rs::UTF_8.new_decoder();

        // Lower temperature than summarize() to keep the reply tight
        // and predictable — one-sentence affirmations don't benefit
        // from creative sampling.
        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(0.2),
            LlamaSampler::dist(42),
        ]);

        for _ in 0..max_tokens {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if model.is_eog_token(token) { break; }

            let piece = model.token_to_piece(token, &mut decoder, true, None)
                .map_err(|e| format!("Detokenize: {}", e))?;
            output.push_str(&piece);

            // Stop at the FIRST sentence ending — we want one crisp sentence.
            let endings = output.matches('.').count()
                + output.matches('!').count()
                + output.matches('?').count();
            if endings >= 1 { break; }

            batch.clear();
            batch.add(token, n_cur, &[0], true)
                .map_err(|e| format!("Batch add gen: {}", e))?;
            n_cur += 1;
            ctx.decode(&mut batch).map_err(|e| format!("Decode gen: {}", e))?;
        }

        let result = output.trim().to_string();
        eprintln!("STT reply ({}, {}): {}", personality, self.active_model.label(), result);
        Ok(result)
    }

    /// Ship-computer reply: pure palette pick, no LLM. The voice is
    /// a RECEIPT voice — it confirms the dictation was submitted to
    /// Claude, nothing more. It does NOT engage with the content of
    /// the dictation. See feedback_no_stt_autospeak.md for the why.
    fn respond_as_ship_computer(&mut self, _text: &str) -> Result<String, String> {
        let reply = build_short_reply();
        eprintln!("STT ship-computer: {}", reply);
        Ok(reply)
    }

    /// Drunken-sailor reply: pure palette pick, no LLM. Profane receipt
    /// voice. Same no-content-engagement contract as ship-computer.
    /// Thinker reply: pure contemplation, no claims of knowing or
    /// going to find out. The voice just holds the thought while
    /// Claude does the actual answering.
    fn respond_as_thinker(&mut self, _text: &str) -> Result<String, String> {
        let reply = build_thinker_reply();
        eprintln!("STT thinker: {}", reply);
        Ok(reply)
    }

    fn respond_as_drunken_sailor(&mut self, _text: &str) -> Result<String, String> {
        let reply = build_drunken_sailor_reply();
        eprintln!("STT drunken-sailor: {}", reply);
        Ok(reply)
    }
}
