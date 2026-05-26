# STT Personality Replies

After the user releases the push-to-talk key, the app speaks a brief acknowledgement in the configured personality voice. This is the path that handles that.

## Flow

1. User releases the STT hotkey (default PageUp). [`lib.rs` CGEventTap KEY_UP](../src-tauri/src/lib.rs) handler runs.
2. Atomic `STT_STOPPING` guard ensures only one stop-and-paste worker runs per release (prevents double-paste from repeat events).
3. Worker thread:
   - `snapshot_and_stop()` — grabs audio buffer, releases lock
   - `decode_offline()` — blocking STT decode (~300-500ms)
   - `emit("stt-done")` with final text
   - If non-empty: paste via `osascript` (clipboard + Cmd-V)
   - Call `summarizer.respond_to_stt(final_text, personality)` → reply string
   - Call `speak_brief(reply)` to speak it via VITS TTS

## The reply generation

Lives in [`summarizer.rs::respond_to_stt`](../src-tauri/src/summarizer.rs). For most personalities, it runs through SmolLM2 with a personality-specific prompt. For `ship-computer` and `drunken-sailor`, it branches to pure template-based generation — no LLM involved.

### Why template-based for some personalities

An earlier attempt let the local LLM write full replies for every personality. Problems:
- Small model frequently promised deliverables ("I'll prepare a plan") that weren't requested
- Grammar glitches on short dictations
- Sometimes drifted into "As an AI, I can't..." refusal idioms

Ship-computer and drunken-sailor were moved to palette-based generation: pick from pre-written phrase lists, compose with simple template shapes, speak. Zero hallucination risk, zero latency, fully deterministic voice.

See also [`memory/feedback_no_stt_autospeak.md`](../../../.claude/projects/-Users-dork-repos-wolf-Lattice/memory/feedback_no_stt_autospeak.md) for the constraints.

## Palette architecture

Each template-based personality has three arrays in `summarizer.rs`:

- **`*_LEADS`** — the required first part ("Noted", "Fuck off", "Acknowledged", "Bawbag", etc.)
- **`*_ADDRESSES`** — optional direct address ("Commander", "ya cunt", "pal", "sir"). Used ~25% of replies.
- **`*_TAILS`** — optional mutter / sign-off ("standing by", "now piss off", "archive updated"). Used ~20% of replies.

A `build_*_reply()` function composes:
- ~55% bare lead: `"Noted."`
- ~25% lead + address: `"Filed, Commander."`
- ~20% lead + tail: `"Acknowledged — archive updated."`

Drunken-sailor uses different weights and adds a fourth shape (lead + address + tail) because the character insults the user more often.

### Ship-computer defaults

- 25+ leads (clerical / receipt-forward / computer-idiom)
- 7 addresses (Commander, sir, Chief, Officer, Helmsman, Navigator, Captain)
- 11 tails (standing by, end of entry, archive updated, etc.)

### Drunken-sailor defaults

Scottish-flavored, short retorts. Heavy profanity, zero racism, zero slurs, no gendered insults.

- 45+ leads (bare swears + Scottish interjections like "Och aye", "Haud yer wheesht", "Awae ti fuck")
- 17 addresses (pal, Jimmy, big man, ya bampot, ya wee shite, etc.)
- 17 tails (aye, och, ach, nae bother, ya ken, pish, etc.)

See [`memory/feedback_no_stt_autospeak.md`](../../../.claude/projects/-Users-dork-repos-wolf-Lattice/memory/feedback_no_stt_autospeak.md) for the design constraints and banned categories.

## TTS playback for replies

Replies go through [`speak_brief`](../src-tauri/src/lib.rs) rather than the main narrator path. Differences:

- `speak_brief` deliberately does NOT emit `tts-open` / `tts-sentence` / `tts-done` — so the sine wave, paragraph reader, and flow particles stay dormant for these short chirps.
- Uses `generate_sentence_with_speed(sentence, 1.18)` — 18% faster than normal narration so brief acks feel clipped and assertive rather than drawn out.
- Always calls `start_session` on entry (cuts in on any prior narration) and `end_session` on exit (via `TtsSessionGuard::new_silent` RAII).

## Adding a new template-based personality

1. Add `*_LEADS`, `*_ADDRESSES`, `*_TAILS` arrays in `summarizer.rs` near the others
2. Write a `build_*_reply()` function choosing shape weights
3. Write a `respond_as_*()` method on `Summarizer`
4. Add a branch in `respond_to_stt()` at the top:
   ```rust
   if personality == "your-id" {
       return self.respond_as_your_id(text);
   }
   ```
5. Add the personality to the dropdown in [`SettingsPanel.tsx`](../src/SettingsPanel.tsx)

Optional but recommended: also add a case in [`~/.claude/hooks/speak-narrator.sh`](../../.claude/hooks/speak-narrator.sh) if you want the same personality driving the main narrator voice (tool calls, completion summaries). Otherwise the narrator falls back to default behavior when the personality isn't recognized.

## Gotchas

- **Rust rebuilds don't hot-reload.** Any change to a palette or reply function requires killing and restarting `bun run tauri dev`. See [CLAUDE.md](../CLAUDE.md) gotcha #1.
- **Settings save requires the personality string.** `personality` is a free-form String in [`settings.rs`](../src-tauri/src/settings.rs) — no enum validation. Typo in SettingsPanel dropdown = silent fallback to default.
- **Double-paste guard** (`STT_STOPPING` atomic in `lib.rs`) is load-bearing. If you see STT pasting twice, check that TWO processes aren't running (each intercepts key events via CGEventTap).

## Related

- [`summarizer.rs`](../src-tauri/src/summarizer.rs) — palette definitions + LLM-based paths
- [`lib.rs`](../src-tauri/src/lib.rs) — STT key-up handler, `speak_brief`, `TtsSessionGuard`
- [`tts.rs`](../src-tauri/src/tts.rs) — `generate_sentence_with_speed`, session management
- [`docs/03-claude-hooks.md`](03-claude-hooks.md) — how the narrator personality interacts with the hook scripts
