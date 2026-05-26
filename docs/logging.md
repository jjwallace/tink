# Logging — current state, gaps, and a proposal

_Spawned from the "we just cut off what happened, do we have logs?" moment — the TTS voice chopped mid-phrase and we had no easy way to reconstruct why._

## Current state

The app emits telemetry from four sources today, none of which talk to each other:

| Source | Sink | Format | Retention |
|---|---|---|---|
| Rust (`eprintln!`) | stderr of `tauri dev` | free text, no timestamps | until terminal closes |
| Frontend (`console.log`) | WebView DevTools | free text | until webview reload |
| `speak-narrator.sh` | `/tmp/speak-hook.log` | `[narrator EVENT] text` | until `/tmp` wipe (boot) |
| `guardrails.sh` | `/tmp/guardrails-violations.log` | `ISO8601 \| rule \| text` | until `/tmp` wipe |

Problem scenarios we can't diagnose today:

1. **"The voice just cut off"** — we don't log when `start_session()` cancels a prior session, or what triggered the new session. A new `/speak` POST, a middle-click, an ESC, a mode change → all can cut in.
2. **"Why did the narrator say that weird thing"** — the raw input to the summarizer isn't captured, only the guardrail output. If the summarizer produced garbage that guardrails cleaned up, we see only the fallback; if guardrails didn't catch it, we hear it but can't replay.
3. **"The sine wave never showed"** — paragraph-reader, sine-waves, flow-particles all listen for `tts-open`. No way to confirm the event fired without popping devtools.
4. **"Settings panel got stuck"** — hot-reload can leave Rust/frontend state out of sync with no paper trail.

## Why unified logging

A single chronological stream lets us answer "what happened around time T" without inspecting four places. The target user is **you, debugging your own behavior five minutes ago**, not a logs-aggregation platform. That reframes the design:

- No ingestion pipeline. Just files.
- JSONL format — one event per line, greppable with `jq`.
- Cheap to write (no fsync, no locking concerns at our traffic levels).
- Audit via a tiny shell script, not a dashboard.

## Proposed design

### Single stream, multiple writers

```
~/.claude/hooks/.logs/app-YYYY-MM-DD.jsonl
```

One file per local day. Writers:

- **Rust** — `log_event!(event_name, payload_json)` macro that writes JSONL + mirrors to stderr in dev. Replaces scattered `eprintln!` calls.
- **Frontend** — `log(event, payload)` helper invoking a new `log_event` Tauri command that forwards to the same file.
- **Hooks** (`speak-narrator.sh`, `guardrails.sh`, `plan-update.sh`) — use `jq -c` to emit JSONL, `>>` to the same file.

### Event schema

```jsonc
{
  "ts": "2026-04-22T04:55:42.123Z",
  "src": "rust" | "frontend" | "hook",
  "event": "tts.start",
  "session_id": "abc123",       // optional — links start/cut/end
  "payload": { /* event-specific */ }
}
```

### Event catalog (proposed)

The catalog should be **small enough to memorize**. Start with these; resist growing without a reason.

| Event | Source | Payload |
|---|---|---|
| `tts.start` | rust | `{text_preview, voice, sentence_count, total_duration, session_id}` |
| `tts.sentence` | rust | `{session_id, idx, level, duration}` |
| `tts.cut` | rust | `{session_id, reason: "new-session"\|"esc"\|"muted"\|"stop-cmd"\|"drop", elapsed_ms}` |
| `tts.end` | rust | `{session_id, reason: "completed"\|"cancelled"\|"error"}` |
| `stt.start` / `stt.end` | rust | `{duration_ms, text_preview}` |
| `mode.change` | frontend | `{from, to, source: "click"\|"tray"\|"settings"}` |
| `guardrail.trip` | hook | `{rule, raw, replacement}` |
| `narrator.speak` | hook | `{event_name: "PreToolUse"\|…, summary, personality}` |
| `hook.fire` | rust | `{event_name}` — when we emit to frontend |
| `setting.change` | frontend | `{key, from, to}` |
| `error` | any | `{where, msg, stack?}` |

`tts.cut` with `reason` is the event that would have answered the user's original question. Every `start_session()` call is the direct trigger, and we can capture the caller's intent before calling it.

### Correlation via session_id

Every `tts.start` generates a short random id (4-6 chars — collisions are fine, we're only looking at a few minutes of logs at a time). `tts.sentence` / `tts.cut` / `tts.end` carry the same id. Grep by id to see a session's full lifecycle.

```
$ logs-audit.sh --session abc123
tts.start    { voice: lessac-fast, sentences: 3, duration: 4.2 }
tts.sentence { idx: 0, level: 0.74 }
tts.cut      { reason: new-session, elapsed_ms: 1100 }
```

### Rotation & retention

- One file per day: `app-2026-04-22.jsonl`
- Keep 7 days, delete older (cron or startup sweep)
- If a day's file hits 10 MB, add `-01`, `-02` suffixes
- Throughput estimate: ~300 events/min during active use × 200 bytes/event → ~60 KB/min → well under 10 MB/day for normal sessions

### Audit CLI: `logs-audit.sh`

Lives at `~/.claude/hooks/logs-audit.sh`. Mirrors guardrails-audit.sh style.

```bash
logs-audit.sh                     # last 50 lines, pretty-printed
logs-audit.sh --tail 200          # last N
logs-audit.sh --since 5m          # last 5 minutes
logs-audit.sh --grep tts.cut      # filter by event
logs-audit.sh --session abc123    # trace one session
logs-audit.sh --watch             # tail -f equivalent
logs-audit.sh --clear             # truncate today's file
```

Implementation is 30 lines of `jq` + `awk`. No extra deps.

## Tradeoffs

- **Perf**: one write per event, non-blocking append. At 300/min that's ~5 writes/sec — noise.
- **Privacy**: narration summaries, user prompts, and selection text all pass through the narrator. The log *will* contain those. Options: truncate `text_preview` to 80 chars (current `/tmp/speak-hook.log` already does this); refuse to log text if a new `LOG_SECRETS=0` env var is set; don't log at all in prod builds. Recommendation: **truncate to 80 chars for text fields, full payload for everything else.**
- **Disk**: 10 MB × 7 days = 70 MB ceiling. Fine.
- **Complexity**: touches Rust, frontend, hooks, and adds one CLI. About a day's work to land cleanly.

## Rollout phases

### Phase 1 — "what just cut off" (1-2 hours)

Narrowly target the immediate pain. Add just two log points:

- Rust: log `tts.cut` inside `start_session()` with the reason (pass a `&'static str` arg: `"new-session"`, `"stop-cmd"`, etc.)
- Rust: log `tts.start` in both `do_speak_text` / `do_speak_selection` / `speak_brief` with text preview + caller

Write to a single hard-coded file `~/.claude/hooks/.logs/tts.jsonl`. No rotation, no schema, no audit CLI. Just enough to `tail -20 ~/.claude/hooks/.logs/tts.jsonl | jq` and see the last few sessions.

This answers the user's original question in under an hour.

### Phase 2 — unified log + audit CLI

Promote the file location, add the schema from above, port `speak-narrator.sh` and `guardrails.sh` to emit into it, and ship `logs-audit.sh`.

### Phase 3 — frontend + mode changes

Add the frontend `log()` helper and the `log_event` Tauri command. Capture `mode.change`, `setting.change`, frontend errors.

### Phase 4 — rotation + retention

Daily file split, 7-day sweep. Can skip until disk pressure is felt.

## Open questions

- Do we also want to capture the **raw narrator input** (the full PROMPT text before summarization) so we can replay bad summaries? Argues yes — answers most "why did it say that" questions. Argues no — biggest text field, most privacy exposure. Leaning **yes with 500-char cap**.
- Should hook scripts `source` a `log_utils.sh` with a shared `log_event()` bash function, or re-implement per script? Shared is DRY; per-script is one fewer thing to go wrong. Leaning **shared**.
- Do we want Sentry or similar for crash-class errors? Probably not — we're a local tool, crashes are loud enough in dev.

## Summary

We have fragments of telemetry in four places and no way to tie them together. A single `~/.claude/hooks/.logs/app-*.jsonl` file with a 10-event catalog, written from Rust + frontend + hooks, tied by `session_id`, audited via a small shell script, solves "what just cut off" and the next dozen debugging questions without becoming an observability project.

**Recommended first move: Phase 1 only.** Two log points, one file, no schema ceremony. If it proves useful we expand; if it doesn't, two points are cheap to delete.
