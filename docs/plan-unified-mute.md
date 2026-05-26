# Plan: Unified mute across SFX, TTS, and all audio surfaces

## Problem

Mute state is fragmented across two settings with non-overlapping semantics:

- `sound_mode` (`both | start | complete | off`) — gates SFX only, checked in [sounds.ts](../src/sounds.ts).
- `work_mode` (`iterate | focus | muted`) — `"muted"` is a label with no enforcement.

TTS playback ([`do_speak_text`](../src-tauri/src/lib.rs), `speak_brief`) does not consult either setting, so spoken output plays regardless.

Observed leak: with `work_mode="muted"` and `sound_mode="both"`, the completion sound still fires on a Stop hook. The hook posts `/sound`, speak_server emits `play-complete-sound`, sounds.ts checks `sound_mode` (not `work_mode`), and plays.

## Target architecture

One boolean `is_muted` is the single source of truth for "should any audio-producing surface emit right now." It gates every audio path — SFX, TTS, brief speech, and any future audio — before the first byte of output.

```
┌──────────────────────────────────────────────────┐
│ Settings (Rust)                                   │
│   is_muted: bool                                  │
│   sound_mode: SoundMode   (which SFX to play      │
│                            when not muted)        │
│   voice_enabled: bool     (TTS on/off independent │
│                            of mute, for "no voice │
│                            but keep SFX" cases)   │
└──────────────────────────────────────────────────┘
         │
         ▼  checked at every audio entry point
┌──────────────────┬────────────────┬──────────────┐
│ SFX (/sound)     │ TTS (/speak)   │ speak_brief  │
│ speak_server.rs  │ lib.rs         │ lib.rs       │
│   → if muted:    │   → if muted:  │  → if muted: │
│     drop, 200 OK │     drop,      │    return    │
│                  │     200 OK     │              │
└──────────────────┴────────────────┴──────────────┘
```

Gate at the **server side**, not the frontend listener. Reasons:

- Frontend-only gating fires the Tauri event, spins up reposition, and wakes the renderer before the listener decides to no-op. Server-side drop is cheaper and uniform.
- TTS synthesis starts in Rust; gating at the HTTP endpoint prevents the whole sherpa-rs pipeline from running when muted.
- One place to read the setting (Rust `AppSettings` state) instead of two (Rust + invoke from JS).

## Semantics

| Setting | Type | Meaning |
|---|---|---|
| `is_muted` | `bool` | Master mute. When `true`, no audio surface emits. Default `false`. |
| `sound_mode` | `both \| start \| complete \| off` | **Which** SFX play when not muted. Unchanged. |
| `voice_enabled` | `bool` | Whether TTS plays when not muted. Default `true`. Lets you keep SFX but silence voice without flipping the master mute. |

`work_mode` loses its `"muted"` value — it becomes `iterate | focus` only, purely about narration behavior (per existing memory: iterate = constant narration, focus = silent until done + SFX). Mute is now a separate axis.

### Decision table

| `is_muted` | `sound_mode` | `voice_enabled` | SFX | TTS |
|---|---|---|---|---|
| `true` | any | any | ✗ | ✗ |
| `false` | `off` | `true` | ✗ | ✓ |
| `false` | `both` | `false` | ✓ | ✗ |
| `false` | `complete` | `true` | complete only | ✓ |

## Implementation

### 1. Settings schema — [settings.rs](../src-tauri/src/settings.rs)

Add:

```rust
#[serde(default)]
pub is_muted: bool,
#[serde(default = "default_true")]
pub voice_enabled: bool,
```

Migrate `work_mode`: on load, if the persisted value is `"muted"`, set `is_muted = true` and rewrite `work_mode` to `"focus"`. One-shot migration in `Settings::load` — no version field needed, the presence of `"muted"` is the tell. Save back immediately so the migration only fires once.

Remove `"muted"` from the `work_mode` allowed values in the UI.

Helper:

```rust
impl Settings {
    pub fn audio_allowed(&self, kind: AudioKind) -> bool {
        if self.is_muted { return false; }
        match kind {
            AudioKind::Sfx(sfx) => sfx_allowed_by_mode(sfx, &self.sound_mode),
            AudioKind::Voice => self.voice_enabled,
        }
    }
}
```

### 2. SFX gate — [speak_server.rs:89-106](../src-tauri/src/speak_server.rs#L89-L106)

Before the `match which.as_str()`:

```rust
let allowed = {
    let cfg = handle.state::<super::AppSettings>();
    let s = cfg.settings.lock().unwrap_or_else(|e| e.into_inner());
    let sfx_kind = match which.as_str() {
        "start" => Some(SfxKind::Start),
        "complete" => Some(SfxKind::Complete),
        "milestone" => Some(SfxKind::Milestone),
        _ => None,
    };
    sfx_kind.map(|k| s.audio_allowed(AudioKind::Sfx(k))).unwrap_or(false)
};
if !allowed {
    // Return 200 so hooks don't retry; drop silently.
    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 22\r\nAccess-Control-Allow-Origin: *\r\n\r\n{\"status\":\"muted\"}\r\n";
    let _ = (&stream).write_all(resp.as_bytes());
    continue;
}
```

Remove the duplicate `sound_mode` check from [sounds.ts:36,49,62](../src/sounds.ts#L36-L62) — the listener becomes a pure player. Frontend keeps the selected-sound lookup (`settings.start_sound`, `settings.complete_sound`, `settings.milestone_sound`) since the server doesn't own asset names.

### 3. TTS gate — [lib.rs:981](../src-tauri/src/lib.rs#L981) (`do_speak_text`), [lib.rs:815](../src-tauri/src/lib.rs#L815) (`do_speak_selection`), [lib.rs:1109](../src-tauri/src/lib.rs#L1109) (`speak_brief`)

Top of each function, before any text stripping / event emission / synthesis:

```rust
{
    let cfg = handle.state::<AppSettings>();
    let s = cfg.settings.lock().unwrap_or_else(|e| e.into_inner());
    if !s.audio_allowed(AudioKind::Voice) {
        return;
    }
}
```

For `/speak` HTTP, gate at the endpoint in [speak_server.rs](../src-tauri/src/speak_server.rs) before `tx.send(text)` so the worker thread never sees muted input.

### 4. UI — [SettingsPanel.tsx](../src/SettingsPanel.tsx)

- Add master mute toggle at the top of the panel (prominent pill or speaker-slash icon). Bind to `is_muted`.
- Add "Voice" toggle under the TTS/voice section, bind to `voice_enabled`.
- Remove `"muted"` from the `work_mode` options. (If the persisted value is still `"muted"` on first render, `get_all_settings` has already migrated it per step 1.)
- Optional: keyboard shortcut to toggle mute (e.g. `Cmd+Shift+M`) via `register_shortcut` in [lib.rs](../src-tauri/src/lib.rs).

### 5. Status endpoint — [speak_server.rs:107-120](../src-tauri/src/speak_server.rs#L107-L120)

Include `is_muted` in the `/status` response so external tooling (hooks, status line) can read it without invoking a Tauri command.

## Migration

One-shot, on `Settings::load`:

```rust
if loaded.work_mode == "muted" {
    loaded.is_muted = true;
    loaded.work_mode = "focus".into();
    loaded.save(app_data_dir); // persist immediately
}
```

No version field. Idempotent — after first run, `work_mode` no longer holds `"muted"`.

## Test plan

- Unmuted + `sound_mode=both` + `voice_enabled=true` → start, milestone, complete all play; `/speak` speaks.
- Unmuted + `sound_mode=off` + `voice_enabled=true` → no SFX; `/speak` speaks.
- Unmuted + `sound_mode=both` + `voice_enabled=false` → SFX play; `/speak` silent.
- **Muted + anything** → no SFX, no TTS, no synthesis wakeup. Verify sherpa-rs is not called (check for CPU/log evidence).
- Pre-existing settings.json with `work_mode="muted"` → first launch migrates to `is_muted=true`, `work_mode="focus"`, and the file on disk reflects the rewrite.
- Hook flow: `speak.sh "hello"` while muted → no bubble, no audio, no event emissions in devtools.

## Out of scope

- Per-sound volume controls (already exist via Howler in `getSound`).
- Ducking / crossfading between SFX and TTS.
- Scheduled / time-based mute ("quiet hours").
- STT input muting — STT is a separate axis (`stt_enabled`) and is unrelated to output.

## Rollout order

1. Settings schema + migration + `audio_allowed` helper. No behavior change yet.
2. SFX server-side gate. Remove frontend duplicate check.
3. TTS gates in all three entry points.
4. UI: master mute toggle, voice toggle, drop `"muted"` from work_mode.
5. `/status` field.
6. Manual test matrix above.
