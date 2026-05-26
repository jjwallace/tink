# Creature Choreography — events, states, transitions

Every behavior change the mother creature performs goes through a single state machine: [`features/creature/orchestrator.ts::CreatureOrchestrator`](../src/features/creature/orchestrator.ts). This doc maps every event the system emits to what the creature does in response, so you can predict (and verify) her behavior end-to-end.

The orchestrator is the **only** caller of `creature.dispatch()`. Anywhere else in the codebase that wants to influence behavior calls one of the orchestrator's `on*()` methods. This rule eliminated a class of bugs where six different sites raced each other.

## Architecture quick reference

There are two parallel APIs the creature exposes:

- **`creature.dispatch(TaskConfig)`** — long-running movement choreography (idle-circle, figure-8, dance, leave-screen, etc.). Goes through the orchestrator.
- **`creature.react(ReactionKind, payload)`** — one-shot brief reactions (a flicker on tool-run, a small bounce on plan-update, etc.). Bypasses the orchestrator; called directly from event listeners. Reactions don't change state — they're animation cues layered on top of whatever choreography is currently running.

This doc is mostly about the dispatch path (orchestrated state machine), with a section at the end on the react path.

---

## Choreography states

These are the orchestrator's named states. At any moment the creature is in exactly one. State name → movement pattern dispatched to the creature:

| State | Movement | Params | Read it as |
|---|---|---|---|
| `hidden` | none | — | not started yet |
| `thinking` | `idle-figure8` | radius 220, speed 1 | claude is working ("∞" around anchor) |
| `reading` | `idle-circle` | radius 180, speed 1.1 | TTS is speaking (tight orbit) |
| `celebrating` | (none — celebration is fired via `react`, not a state choreography) | — | brief celebration before fly-off |
| `offscreen` | `leave-screen` (dispatched on entry) | — | flew off, waiting on `returnTimer` |
| `orbiting` | `idle-circle` | radius 160, speed 0.8 | post-return ambient orbit |
| `dancing` | `dance` | screen center | long-idle free pattern across the screen |
| `parkedTight` | `idle-circle` | radius 140, speed 0.6 | mouse active, ambient docked orbit |
| `parkedWide` | `idle-figure8` | radius 220, speed 1 | mouse idle (30s+), ambient figure-8 |
| `dragOrbit` | `idle-circle` | radius 160, speed 1.3 | user is dragging the voice anchor |

Internal timers, owned by the orchestrator:

- **`celebrationTimer`** — 1600 ms — fires `flyOff()` after `onClaudeStop()` if not cancelled
- **`returnTimer`** — 10000 ms — fires `transitionTo("orbiting")` after `flyOff()`
- **`danceTimer`** — 60000 ms — fires `transitionTo("dancing")` after `orbiting`

---

## The full event table

Every event in the system that influences creature behavior. Source = where it originates, handler = which orchestrator method, effect = the resulting state transition.

### From the Rust hooks (Claude lifecycle)

| Event | Source | Handler | Effect |
|---|---|---|---|
| `play-start-sound` | `~/.claude/hooks/play-start-sound.sh` (UserPromptSubmit) | `onClaudeStart()` | any state → **thinking** (figure-8). Cancels all timers. Tink-spawn check beforehand awards a companion if `flewOffOnce` is set. |
| `play-complete-sound` | hook (Stop event after task finishes) | `onClaudeStop()` | sets `pendingExit = true`, arms 1.6s `celebrationTimer`. State unchanged immediately; flyOff fires on the timer OR earlier if `tts-done` arrives first. |
| `play-milestone-sound` | hook (mid-task milestone) | `creature.react("tool-run")` | Small one-shot animation. **Suppressed while reading**. No state change. |

### From the TTS lifecycle

| Event | Source | Handler | Effect |
|---|---|---|---|
| `tts-open` | Rust TTS engine when narrator starts speaking | `onTtsOpen()` | any state except offscreen → **reading** (idle-circle tight). Cancels all timers. While in offscreen the event is ignored — once flown off, trailing summary TTS doesn't bring her back. |
| `tts-sentence` | Rust TTS, per sentence | (no orchestrator handler) | Drives sine-wave / paragraph-reader UI. No creature state change. |
| `tts-done` | Rust TTS at end of playback | `onTtsDone()` | If `pendingExit` is true → **flyOff** (claude-stop already fired). Else if state is `reading` → **parkedTight** or **parkedWide** based on mouse. |
| `tts-escape` | ESC key OR STT key-down | `onTtsEscape()` | Clears pendingExit. If state is `reading` → **parkedTight/Wide**. Otherwise no change. |
| `tts-amplitude` | Rust TTS, every 50ms during playback | (none, UI-only) | Drives sine-wave reactivity. No creature state change. |

### From the STT lifecycle

| Event | Source | Handler | Effect |
|---|---|---|---|
| `stt-active` (true / false) | Rust on PageUp down/up | (no orchestrator handler — UI only) | Sine wave hides, audio tentacles extend. Wake-word loop in companion uses this for echo gating. No creature state change. |
| `stt-partial` | Rust streaming STT decoder | (none in orchestrator) | Used by stt-display word cloud + companion's wake-word loop. No creature state change. |
| `stt-start` | (legacy) | `creature.react("return")` | One-shot. No state change. |
| `stt-amplitude` | Rust mic loop | (none in orchestrator) | Audio-tentacles bar pulse. No creature state change. |

### From the voice anchor

| Event | Source | Handler | Effect |
|---|---|---|---|
| anchor `onDragStart` | user mouses-down on voice anchor | `onDragStart()` | any state → **dragOrbit** (idle-circle around live anchor pos at radius 160, speed 1.3) |
| anchor `onDragEnd` | user releases | `onDragEnd()` | dispatches `idle-figure8` at the new anchor pos, then state goes to **parkedTight** or **parkedWide** based on mouse |

### From the mouse-idle poll

| Event | Source | Handler | Effect |
|---|---|---|---|
| poll fires `setMouseIdle(true)` | global mouse not moved for 30s | `setMouseIdle(true)` | If state is parkedTight → **parkedWide**. Otherwise no change. (Doesn't break out of dancing/orbiting/thinking/reading.) |
| poll fires `setMouseIdle(false)` | mouse moved | `setMouseIdle(false)` | If state is parkedWide → **parkedTight**. **If state is `dancing` → `orbiting`** (the user came back). |

### Internal (timer-driven) transitions

| When | Effect |
|---|---|
| `celebrationTimer` fires (1.6s after `onClaudeStop`) | `flyOff()` if `pendingExit` still true → **offscreen** |
| `returnTimer` fires (10s after `flyOff`) | **orbiting** |
| `danceTimer` fires (60s after entering `orbiting`) | **dancing** |

### Idle safety net (App.tsx)

A 6-second safety net resets every time *any* of the listed events fires (`play-start-sound`, `play-complete-sound`, `tts-open`, `tts-done`, `stt-active`). If 6 seconds elapse with no events AND the state is `thinking` or `reading`, it synthesizes `onClaudeStop()` to recover from a dropped `play-complete-sound`. Doesn't fire in idle states (orbiting / dancing / parked*) so legitimate steady states aren't disrupted.

---

## Common flow walkthroughs

### Normal task

```
[user types prompt]
    │
    ▼
play-start-sound  →  onClaudeStart()  →  state: thinking (figure-8)
    │
    │ [claude works, tools fire — react("tool-run"), no state change]
    │
    ▼
narrator begins speaking
    │
    ▼
tts-open  →  onTtsOpen()  →  state: reading (idle-circle tight)
    │
    │ [narrator reads, sentences emit tts-sentence + tts-amplitude
    │  for the sine wave; creature stays in reading]
    │
    ▼
narrator finishes
    │
    ▼
tts-done  →  onTtsDone()  →  state: parkedTight (or parkedWide) — no pendingExit
```

State path: `parkedTight` (initial) → `thinking` → `reading` → `parkedTight`.

### Task that emits a completion sound

```
play-start-sound        →  thinking
[claude works]
[tts-open + tts-done    →  reading → parkedTight]
play-complete-sound     →  pendingExit = true, 1.6s celebrationTimer armed
[trailing summary TTS:]
  tts-open              →  reading
  tts-done              →  pendingExit fires flyOff → offscreen
[returnTimer = 10s]
returnTimer fires       →  orbiting (idle-circle, danceTimer = 60s armed)
[user idle 60s]
danceTimer fires        →  dancing
[user moves mouse]
setMouseIdle(false)     →  orbiting (and danceTimer re-arms)
[user idle another 60s]
                        →  dancing
[user types a new prompt]
play-start-sound        →  cancels all timers → thinking
```

### User interrupts mid-narration with PageUp (STT)

```
state: reading
[user holds PageUp]
tts-escape              →  onTtsEscape() → state: parkedTight (TTS aborted)
stt-active(true)        →  (no orchestrator effect; sine wave hides via its own listener)
[user speaks, releases]
stt-active(false)
stt-done                →  (no orchestrator effect)
[transcript pastes elsewhere]
```

### Drag the voice anchor

```
state: parkedTight
[user mouses-down on anchor and drags]
onDragStart()           →  dragOrbit (idle-circle at the live anchor position)
[during drag — anchor moves, dragOrbit follows because the orchestrator
 reads anchor() each transition... but this state was dispatched once.
 Live tracking happens because the choreo system polls the anchor
 position via setAnchorPosProvider in Creature itself.]
[user drops]
onDragEnd()             →  dispatches idle-figure8 at new anchor pos,
                            state goes to parkedTight (or parkedWide)
```

### After-task idle (the new flow)

```
flyOff()                →  state: offscreen
                            returnTimer = 10s
[10s later]
returnTimer fires       →  orbiting (idle-circle around anchor, radius 160)
                            danceTimer = 60s
[60s later, no events]
danceTimer fires        →  dancing (free movement around screen center)
[user moves mouse]
setMouseIdle(false)     →  orbiting (danceTimer re-arms)
[user types new prompt]
play-start-sound        →  cancels timers → thinking (figure-8)
```

---

## The `react` API (one-shot reactions)

Separate from the dispatch / state machine. `Creature.react(kind, payload)` is called directly from event listeners in App.tsx and triggers a small momentary animation overlay — e.g., a quick flash, a tentacle wiggle. It doesn't change state.

| Event | React kind | Suppressed during reading? |
|---|---|---|
| `play-start-sound` | `claude-start` | no |
| `play-complete-sound` | `claude-stop` | no |
| `stt-start` | `return` | no |
| `play-milestone-sound` | `tool-run` | **yes** |
| `particles-burst` | `tool-run` | **yes** |
| `plan-viz-update` | `plan-update` | **yes** |

Reactions during `reading` are suppressed for the punctuation events (tool-run, plan-update) so the reading orbit doesn't get yanked off-rhythm by every Claude tool call.

---

## How to verify behavior end-to-end

If you want to manually exercise every transition:

1. **Start the app** — state should immediately be `parkedTight` (mouse-active orbit)
2. **Don't move mouse for 30s** — should switch to `parkedWide` (figure-8 ambient)
3. **Move mouse** — back to `parkedTight`
4. **Drag the voice anchor** — `dragOrbit` while held, back to `parkedTight` on release
5. **Submit a prompt** — `thinking` (figure-8)
6. **Wait for narrator** — `reading` (tight orbit)
7. **Let the response finish** — `play-complete-sound` arms exit; `tts-done` fires `flyOff` → `offscreen`
8. **Wait 10s** — `orbiting`
9. **Wait another 60s without doing anything** — `dancing`
10. **Move mouse** — back to `orbiting`
11. **Wait another 60s** — `dancing` again
12. **Submit new prompt** — `thinking` (timers cancelled)

To enable verbose state logging, uncomment the `console.log` line at the bottom of `transitionTo()` in `orchestrator.ts`.

---

## Adding a new state or transition

To wire a new event:

1. Add a method on the orchestrator (`onMyNewEvent()`) that calls `transitionTo(...)` or otherwise updates state
2. Add a `case` in `transitionTo()` if introducing a new state
3. Call the method from the event listener in App.tsx

Don't add a `creature.dispatch()` call anywhere outside `orchestrator.ts::dispatch()` — that's the rule that keeps coordination clean.

---

## Related

- [`features/creature/orchestrator.ts`](../src/features/creature/orchestrator.ts) — the state machine
- [`features/creature/choreo.ts`](../src/features/creature/choreo.ts) — the actual movement implementations (`corioDance`, `corioIdleCircle`, etc.)
- [`features/creature/index.ts`](../src/features/creature/index.ts) — the `Creature` class with `dispatch` / `react` / `spawnTink`
- [`docs/13-animation-guardrails.md`](13-animation-guardrails.md) — GSAP / Pixi patterns the choreography relies on
