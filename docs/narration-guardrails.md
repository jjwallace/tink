# Narration Guardrails — catalog, rationale, and case studies

How the narrator avoids saying embarrassing things. Catalog of the rules, why each exists, and what to reach for when you notice a new kind of bad output.

Implementation: [`~/.claude/hooks/guardrails.sh`](../../../.claude/hooks/guardrails.sh) (library) + [`~/.claude/hooks/guardrails-audit.sh`](../../../.claude/hooks/guardrails-audit.sh) (audit CLI) + inline prompt sections in [`~/.claude/hooks/speak-narrator.sh`](../../../.claude/hooks/speak-narrator.sh).

## Two layers

Guardrails run in two places:

1. **Prompt-side** — text inside the system prompt that tells the model what NOT to say. First line of defense. Lives in `sys_prompt()` (global suffix) and per-event `SYS=...` strings in speak-narrator.sh.
2. **Filter-side** — regex checks after the model generates output. Replaces bad output with a neutral fallback (blocking rules) or logs a warning but keeps the phrase (warn-only rules). Lives in `guardrails.sh` `guardrails_check` / `guardrails_warn_check`.

Prompt-side catches most things. Filter-side is the safety net when the model ignores instructions.

## Rule catalog

### Blocking (filter replaces text with fallback)

| Rule | Trips on | Reason |
|---|---|---|
| `backslash_run` | `\\` (2+ consecutive backslashes) | Windows paths / escape-sequence hallucination read as gibberish |
| `escape_seq` | literal `\n` `\r` `\t` | Raw escape sequences in the LLM output — never meant to be spoken |
| `path_spam` | 2+ forward slashes | Unix path fragment — cannot be read aloud usefully |
| `url` | `http://` or `https://` | URLs read as gibberish; paraphrase as "the address" |
| `long_token` | word >40 chars | Identifiers, hashes, base64 — cannot be spoken |
| `caps_shout` | `[A-Z_]{15,}` | `CONSTANT_CASE_NAMES` read as yelling |
| `extension_spam` | 2+ file extensions in one line | Phrases like "foo.ts bar.rs baz.py" read as noise |
| `special_density` | >40 % non-alphanumeric chars | Code fragments the LLM forgot to paraphrase |

### Warn-only (filter logs but keeps the text)

| Rule | Trips on | Reason |
|---|---|---|
| `incomplete_summary` | phrase doesn't end with `. ! ? "` | Narrator got cut off / didn't cover the ending |

Why warn-only for incomplete summaries: a partial summary is still more informative than the generic "skipping a noisy detail" fallback. Better to let it through and surface the incident in the audit log so the user can choose to request a retry.

### Prompt-side rules

Applied via `guardrails_prompt_suffix()` (appended to every personality) plus event-specific `SYS=...` strings.

**Global (guardrails_prompt_suffix):**

- Never read file paths, URLs, long identifiers — paraphrase them
- Never spell out backslashes / escape sequences
- Never read CONSTANT_CASE names
- Never read multiple file extensions in one sentence
- ONE sentence, under 14 words
- ALWAYS finish your sentence (no mid-clause trails)
- If the input is long, MUST mention what happened at the END, not just start/middle

**Event-specific (speak-narrator.sh per-event blocks):**

| Event | Stance | Vocabulary |
|---|---|---|
| `UserPromptSubmit` | action IS STARTING — not done yet | starting, beginning, kicking off, firing up, diving into, looking into, reaching for, spinning up, queueing, scheduling, initiating, taking a look, setting about, opening, launching, getting on it, lining up, picking up |
| `PreToolUse` | tool ABOUT TO RUN — not finished | about to, running, starting, firing, kicking off, queueing, opening, reaching for, diving into, looking into, setting up, lining up |
| `PostToolUse` | tool JUST RAN — report what happened | past tense acceptable here |
| `Stop` | session wrap-up summary | any tense, focus on what got done |

## Case studies

### Case 1 — "already done" on start events

**Symptom**: user submits a prompt, narrator immediately announces `"Fixed the config."` before any work has been done. Feels like the narrator is faking completion.

**Root cause**: the UserPromptSubmit / PreToolUse prompts used mild framings like `"Acknowledge a developer's request"` that let the model drift into past tense. The personality prompts (especially gossipy-bestie with `"files saved, I am LOSING it"`) biased toward celebration-of-completion language.

**Fix** (2026-04-22): explicit starting-verb vocabulary list + forbidden past-tense words in both start-event prompts. The prompt now carries 15+ starting synonyms so the model has variety, and an explicit forbidden list covering done/finished/completed/already/etc.

**Prevention going forward**: any new event type that represents a NOT-YET-HAPPENED action needs the same starting-vocabulary treatment. Don't trust the model to infer tense from ambient context.

### Case 2 — summaries that drop the ending

**Symptom**: user asked for a multi-step task, narrator's Stop-event summary covered the first few steps but never mentioned the final action.

**Root cause**: the Stop-event prompt said `"Summarize this developer response in 1-2 short spoken sentences"` — no explicit instruction to cover the end. For long inputs, the model tends to summarize the opening paragraph.

**Fix** (2026-04-22): added `"If the input is long, your summary MUST mention what happened at the END"` to the global guardrails suffix. Also added `incomplete_summary` warn-only filter rule that catches phrases ending without terminal punctuation — if the model WAS cut off mid-thought, we surface it in the audit log.

### Case 3 — Rust struct field drift (schema-side guardrail)

**Symptom**: added `level: f32` to `SentenceEvent` in `tts.rs`. Rust compile failed:

```
error[E0063]: missing field `level` in initializer of `SentenceEvent`
   --> src/lib.rs:903  and  --> src/lib.rs:1031
```

Two separate call sites constructed the struct; adding the field broke both.

**Root cause**: multiple call sites construct the same event struct directly. Adding any non-default field is a breaking change to every caller. `#[serde(default)]` handles the deserialization side (old JSON without the field won't fail to deserialize) but does NOT make Rust struct initializers optional.

**Fix**: explicitly populated `level: peak` at both call sites after computing `peak` from the sample buffer.

**Prevention going forward**:

- **For additive fields**: prefer `#[derive(Default)]` on the struct + `..Default::default()` in all initializers. Then new fields auto-fill with their type's default and old call sites keep compiling. Trade-off: requires a default for every field.
- **Or**: funnel all struct construction through a single factory function. Adding a field updates one place.
- **Either way**: grep for every call site before changing a shared event struct. `grep -n "SentenceEvent {"` or equivalent.

This is a "guardrail" in the defensive-coding sense — same philosophy as the narration guardrails: invariants that prevent you from shipping something you don't want shipped. Different mechanism (compiler vs regex), same intent.

## Audit

```bash
~/.claude/hooks/guardrails-audit.sh          # last 20 + all-time rule tally
~/.claude/hooks/guardrails-audit.sh --watch  # live tail
~/.claude/hooks/guardrails-audit.sh 100      # last 100
~/.claude/hooks/guardrails-audit.sh --clear  # reset
```

Log format: `ISO8601 | rule_name | offending_text` (text truncated to 300 chars). Rules from both `guardrails_check` (blocking) and `guardrails_warn_check` (warn-only) land in the same log — they're distinguished only by rule name, not severity.

## Adding a new rule

Decide first: is this a **content-quality** issue (rule should log but keep the output) or a **content-danger** issue (replace with fallback)? Most issues are warn-only — don't reach for fallback unless the raw output is literally unspeakable.

Then:

1. Add the regex to `guardrails_check` (blocking) or `guardrails_warn_check` (warn-only) in guardrails.sh
2. Pick a short snake_case rule name — shows up in the audit log
3. Add a row to the catalog table in this doc
4. If there's a prompt-side fix too, mention it in `guardrails_prompt_suffix()` or the relevant event block

## Known limitations

- **No context awareness in regex rules**. `guardrails_check` doesn't know whether it's filtering a Stop-event summary vs a UserPromptSubmit acknowledgement, so we can't enforce "start events must use starting language" at the filter level — only prompt-side. A future version could accept an `EVENT_TYPE` param.
- **No semantic check for "covered the ending"**. The `incomplete_summary` rule catches syntactic truncation (no period) but can't detect a summary that IS complete yet ignores the last paragraph. That'd need a second LLM pass to compare input coverage. Out of scope for a regex-based guardrail system.
- **Personality prompts can fight global rules**. If a personality says "use AUDACITY in caps" and the guardrail forbids long caps strings, the personality wins prompt-side; then the filter trips. Current behavior is acceptable — rare personalities should feel distinctive even at the cost of occasional filter hits.
