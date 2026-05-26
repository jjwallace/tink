# Personalities

One file per personality. Each personality defines how the Ship Computer–
style narrator speaks: its tone, speech patterns, and — critically — its
response style when the user dictates via push-to-talk.

## Active personalities

| id                    | file                      | dropdown label     | flavour                                                    |
|-----------------------|---------------------------|--------------------|------------------------------------------------------------|
| `none`                | *(no file — passthrough)* | None               | Plain narration, no character.                             |
| `ship-computer`       | `ship-computer.md`        | Ship Computer      | Dry, Hitchhiker's-Guide-flavored, 8 voice registers.       |
| `cutie`               | `cutie.md`                | Cutie              | Warm plushie / cottagecore, 8 registers + imagery palette. |
| `six-seven`           | `six-seven.md`            | 6-7 / Brainrot     | Gen Z brainrot slang.                                      |
| `noir-detective`      | `noir-detective.md`       | Detective          | 1940s first-person hardboiled PI, 8 registers.             |
| `gossipy-bestie`      | `gossipy-bestie.md`       | Gossipy Bestie     | Brunch-gossip confidante.                                  |
| `mcafee`              | `mcafee.md`               | John McAfee        | Paranoid-founder gonzo caricature, 8 registers.            |
| `zen`                 | `zen.md`                  | Zen                | Minimal / spare / present; short replies; SKIPs liberally. |

The setting key is `personality` (see [settings.rs](../../../src-tauri/src/settings.rs)).
The dropdown in the Settings panel maps 1:1 to the `id` column.

## File structure

Every personality file has the same sections — consumers rely on the
structure being consistent so they can diff one personality against
another without re-reading prose.

```
# {Display Name}

## Tone
## Humor Style
## Speaking Patterns
## Emotional Rules

## Responses to Speech Input
### Style constraints
### Affirmation verbs
### Deliverable nouns
### Connective phrases
### Response templates
### Worked examples
### What NOT to say
### Failure modes
```

`## Responses to Speech Input` is the section consumed by the STT
post-release pipeline: after the user releases the push-to-talk hotkey
and the text is pasted, the embedded summariser produces a one-sentence
reply in this voice (see [summarizer.rs](../../../src-tauri/src/summarizer.rs),
`respond_to_stt`). Everything above that section governs how the
personality narrates *Claude's* activity via the summariser hook.

## Enriching an existing personality

See [enrichment-guide.md](enrichment-guide.md) for the voice-register + flavor-rotation pattern used to upgrade `ship-computer` from a flat phrase-pool voice to a Hitchhiker's-Guide-flavored rotating one. Apply the same recipe to the remaining personalities as needed.

## Adding a new personality

1. Create a new `.md` file in this directory — copy an existing one as
   a template; keep the section headings identical.
2. Add an entry to the `personality` dropdown in
   [SettingsPanel.tsx](../../../src/SettingsPanel.tsx) — same `id`
   string you used in the filename.
3. Add a match arm to `stt_response_prompt()` in
   [summarizer.rs](../../../src-tauri/src/summarizer.rs) that injects
   the personality-specific snippet into the STT response prompt.
4. Optional: add the same personality's narration snippet to
   `SUMMARIZE_PROMPT_TEMPLATE` in the same file.

The personality files are canonical spec. Rust implements them. When
you change a file, you also update the matching match arm in
`summarizer.rs` to keep the runtime in sync. Future iteration may load
these files at runtime instead of hardcoding — doing so is a larger
change (resource-dir plumbing, hot reload, model-prompt shape), so for
now we treat the MDs as design documents and mirror them in code.

## How STT response works end-to-end

1. User holds the push-to-talk hotkey → `stt-active: true` emitted,
   tentacles emerge, words stream in.
2. User releases → Rust pastes the transcript into the focused app.
3. Rust calls `summarizer.respond_to_stt(&final_text, &personality)`
   — that method picks the right prompt template based on
   `personality`, runs SmolLM2 / Qwen inference, returns one short
   sentence in-style.
4. Rust calls `speak_brief(reply)` — the Ship-Computer-style TTS fires,
   bypassing the normal `tts-open` / paragraph-reader visuals (this is
   a cut-in, not a narrated response). Muted work_mode still applies to
   `do_speak_*` but `speak_brief` deliberately speaks so the
   confirmation arrives.

Failure modes: if the text is too short, the model returns `SKIP`
and nothing is spoken. If inference errors, we log and skip — the paste
still succeeded, so the user isn't blocked.
