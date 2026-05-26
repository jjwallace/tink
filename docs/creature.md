# Creature — mother tentacle, tinks, and choreography

The tentacled figure that appears around the voice anchor during Claude sessions. One "mother" + up to three "tinks" (companions) that spawn progressively as the user completes request/response cycles.

Code: [`src/features/creature/`](../src/features/creature/)

## Files at a glance

| File | Role |
|---|---|
| [`index.ts`](../src/features/creature/index.ts) | Public API — `start()`, `stop()`, `react(event)`, `dispatch(task)`, `spawnTink()`, `followAnchor(pos)` |
| [`renderer.ts`](../src/features/creature/renderer.ts) | Pixi scene, frame loop, camera, companion coordination |
| [`tentacle.ts`](../src/features/creature/tentacle.ts) | Verlet-chain physics for each tentacle |
| [`particles.ts`](../src/features/creature/particles.ts) | Per-tentacle particle trail |
| [`companions.ts`](../src/features/creature/companions.ts) | Tinks — boid flock with progressive reveal |
| [`choreo.ts`](../src/features/creature/choreo.ts) | State machine: task types, transitions, blending |
| [`store.ts`](../src/features/creature/store.ts) | Module-level tunables (`S` singleton) |

## Lifecycle

```
start(container)
  │ offscreen seed: center.y = -300
  │ offScreen = true (holds position, no render activity)
  │
  ▼
react("claude-start")  ──►  idle-figure8 at screen center     ("writing" mode)
  │                         creature is on-screen
  ▼
react("tts-open")      ──►  idle-circle at voice anchor       ("reading" mode)
  │                         tight orbit around the speaking anchor
  ▼
react("claude-stop")   ──►  celebration (~900 ms spiral)
  │                         + PENDING_EXIT armed
  ▼
tts-done              ──►  leave-screen                       (fly off)
  │                         flewOffOnce = true
  ▼
react("claude-start") ──►  idle-figure8 + spawnTink()         (companion appears)
  │                         flewOffOnce resets, one more tink per cycle (cap 3)
  ▼
stop()                 ──►  scene destroyed, container cleared
```

## Task types (`choreo.ts`)

| Task | Pattern | Notes |
|---|---|---|
| `idle-figure8` | sin(2.2·sp·t)·hw × sin(4.4·sp·t)·hh | "thinking/cruising" loop. `speed` task param scales temporal freq (default 1.0, claude-start uses 0.4 for wide slow arcs) |
| `idle-circle` | cos/sin(3·t)·r | tight orbit — "reading" the anchor |
| `celebration` | spiral burst over 900 ms, decaying radius | fired on claude-stop |
| `dance` | brief flourish | on tool-run / plan-update |
| `notify` | short directional flourish | file-saved, notify events |
| `leave-screen` | accelerating exit toward edge | hides the creature offstage |
| `draw-arc` / `draw-sweep` / `draw-path` | drawing-mode choreographies | used by viz coordinator |
| `holding-pattern` | outer orbit at entryRadius | standby between tasks |

Every task has a `target: { x, y }` anchor. Transitions happen via `dispatch(newTask)`.

## Transitions — the blend

When `dispatch()` sets a new task, the creature doesn't teleport. Instead:

1. Current position is captured as `currentPos`
2. New task's ideal position at t=0 is computed (`idlePositionAt0`)
3. `blendOffset = currentPos − ideal_t0` is stored
4. Each frame, `result.x += blendOffset.x · decay(elapsed/blendDur)`

### Decay curve — why ease-in-out

```
decay = 1 − eIO(min(1, blendElapsed / blendDur))
blendDur = 1400 ms
eIO(t) = t < 0.5 ? 2t² : 1 − (−2t+2)²/2      (cubic ease-in-out)
```

The curve matters a lot. Previously this was `eO` (ease-out): decay dropped fast in the first 200 ms, so the creature snapped onto the new pattern's trajectory almost immediately — that's the "scared glitch" users saw during idle-circle ↔ idle-figure8 swaps. The new pattern's velocity at t=0 often doesn't match the old pattern's current velocity; snapping positions without matching velocities = visible jerk.

**Ease-in-out fixes this**: decay stays near 1.0 for the first ~300 ms, so the creature keeps riding its old trajectory briefly. The hand-off happens through the middle third, and lands softly in the final third. Visual velocity has time to adjust.

**Longer `blendDur` (1400 ms)** — the old 900 ms was barely long enough to hide the velocity mismatch even with a better curve. Longer blend gives the new pattern's velocity time to establish without fighting the old trajectory.

### When blending applies

Set in `dispatch()` at line ~170:

```ts
const blendsIn = config.type === "idle-circle" || config.type === "idle-figure8"
  || config.type === "dance" || config.type === "notify";
```

Drawing tasks (`draw-arc`, `draw-sweep`, `draw-path`) and `holding-pattern` skip the blend and use a **transit phase** instead: arc to an entry point, then start performing. Those have distinct start positions (path endpoints, circle tangents) that shouldn't blend — the creature should physically move to them.

## Tinks — companions

Small circular sprites that orbit the mother as a boid flock. Behavior in [`companions.ts`](../src/features/creature/companions.ts).

### Progressive reveal

```ts
S.companionCount = 0   // starts with no tinks visible
```

On each fly-off → return cycle:

```ts
if (flewOffOnce && creature) {
  creature.spawnTink();   // increments companionCount, up to 3
  flewOffOnce = false;
}
```

So:
- **First prompt**: mother only
- **After 1 completion cycle**: 1 tink appears
- **After 2 cycles**: 2 tinks
- **After 3 cycles**: 3 tinks (cap)

Each new tink seeds at the mother's current position so it reads as "spawned from her" rather than materializing from nowhere.

### Boid behavior

Standard three rules (separation / alignment / cohesion) steering the tinks around the mother. The mother acts as a heavier attractor — tinks are pulled toward her but maintain spacing among themselves.

## Store (`store.ts`) — tunables

| Field | Default | What it does |
|---|---|---|
| `headRadius` | 3.64 | mother's head sphere |
| `tentacles` | 12 | count of tentacles |
| `thickness` | 2.37 | tentacle line width |
| `length` | 12.29 | tentacle reach |
| `gravity` | 0 | y-axis force |
| `wind` | 0 | x-axis force |
| `friction` | 0.181 | drag on verlet integration |
| `hue` / `saturation` / `lightness` | 360 / 1 / 1 | HSL color |
| `glowAmount` | 0 | additive bloom |
| `particleSize` | 1 | trail dot size |
| `particlePool` | 300 | max trail dots across all tentacles |
| `particleRate` | 5 | spawn cadence |
| `interactive` | false | mouse affects tentacles directly |
| `companions` | true | tinks enabled (master switch) |
| `companionCount` | 0 | live count (0-3, mutated by spawnTink) |
| `anticipation` | true | short reverse-motion before a transit |
| `pursuit` | true | mouse-chase mode |
| `gestureChunking` | true | rest beat between tasks |

**No persistence** — settings are module-level singletons, reset on app restart. Mutate `S.field` directly to tune. No GUI panel for creature settings today.

## Key app.tsx orchestrations

All cross-feature glue lives in [`src/App.tsx`](../src/App.tsx):

| Signal | Triggered by | Effect |
|---|---|---|
| `pendingExit` | `play-complete-sound` | Arms a fly-off timer. The NEXT `tts-done` (completion-summary) triggers `leave-screen`. 1600 ms fallback handles the "no TTS" case |
| `isReading` | `tts-open` → true / `tts-done` → false | Suppresses tool-run/plan-update reactions while reading — creature isn't yanked mid-orbit |
| `flewOffOnce` | Set in `flyOff()` | Consumed by next `play-start-sound` to call `spawnTink()` |
| Anchor-drag lerp | `voice-anchor.onChange` | Smooths creature's follow of a live-dragged anchor (12 %→4 %/frame lerp) so it doesn't snap |

## Why the creature looks "scared" less now (2026-04 fix)

Summary of the transition glitch resolution:

1. **Was**: 900 ms ease-OUT blend between idle tasks. Decay dropped fast (100 %→50 % in the first 300 ms), so the creature visually snapped onto the new pattern while the blend offset still had ~50 % weight — resulting in a pulled/jerked look the author characterized as "scared."
2. **Now**: 1400 ms ease-IN-OUT blend. First 300 ms keeps decay near 1.0 (creature stays on old trajectory); middle 800 ms does the transition smoothly; last 300 ms eases into the new pattern.

**Not addressed yet**: velocity matching. The new idle pattern's velocity at t=0 still doesn't match the old pattern's current velocity; the blend hides this via smoothness, not correctness. A proper fix would search for a phase offset `t₀` in the new pattern where position AND velocity both approximately match the creature's current state, and start the task at `s.elapsed = t₀` instead of 0. Maybe 30 lines in `idlePositionAt0`-analog for velocities. Worth revisiting if the softened blend still shows artifacts.

## Debugging a stuck creature

If the creature appears offscreen and won't return:

- Check `offScreen` flag in `renderer.ts` — it's set to `true` on start and only cleared when a non-leave task dispatches
- Check that `claude-start` / `tts-open` events are actually firing — put a `console.log` in App.tsx's `react()` calls
- `pendingExit` stuck true? A completion-summary TTS might be pending without ever resolving; force by emitting `tts-done` once via devtools

If the creature shows up dead-center at boot:

- The offscreen seed (`center.y = -300`) should prevent this. Verify `renderer.ts` still has that constant and `offScreen = true` on init
- Pixi resize may have clamped the initial Y — check `center = { x: screen.w/2, y: -300 }` not `y: screen.h/2`

If tinks never appear:

- Ensure `play-start-sound` actually fires before/during a second prompt — hook script at `~/.claude/hooks/play-start-sound.sh`
- `flewOffOnce` never latches to true unless `flyOff()` runs — confirm either `play-complete-sound → tts-done` chain or the 1600 ms fallback fired
