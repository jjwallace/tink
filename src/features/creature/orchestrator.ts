/**
 * Creature orchestrator — single state machine that owns all
 * choreography decisions.
 *
 * Before this, six different places in App.tsx called creature.dispatch()
 * directly (TTS handlers, anchor drag handlers, mouse-idle poll, fly-off
 * flow, return-from-offscreen timer, etc.) and they fought each other —
 * the mouse-idle poll could overwrite a fresh idle-circle two seconds
 * after the return-timer dispatched it, so the dance state was never
 * visible.
 *
 * Now: every event goes through this orchestrator. The orchestrator
 * tracks one canonical state, runs timers internally, and is the only
 * caller of `creature.dispatch()`. Adding a new state or a new transition
 * happens in this one file.
 *
 * State diagram (textual):
 *
 *   thinking ─── claude-start
 *      │
 *      ↓ tts-open
 *   reading ─── tts-open
 *      │
 *      ↓ tts-done (pending exit)
 *   celebrating
 *      │
 *      ↓ exit timeout
 *   offscreen ─── flew off
 *      │
 *      ↓ +10 s
 *   orbiting (idle-circle around anchor)
 *      │
 *      ↓ +60 s
 *   dancing (free pattern across screen)
 *
 *   parkedTight (mouse active idle-circle) ⇄ parkedWide (mouse idle figure-8)
 *
 *   Any state ←── claudeStart → thinking
 *   Any state except offscreen ←── ttsOpen → reading
 *   Drag ⇄ dragOrbit (mother orbits live anchor); drop → orbiting at new pos
 */

import type { Creature } from "./index";
import type { TaskConfig } from "./choreo";

export type CreatureState =
  | "hidden"        // engine not running yet, or stopped
  | "thinking"      // claude is working (figure-8 around anchor)
  | "reading"       // TTS speaking (tight idle-circle around anchor)
  | "celebrating"   // brief celebration before fly-off
  | "offscreen"     // flew off, waiting on returnTimer
  | "orbiting"      // returned from offscreen, ambient idle-circle
  | "dancing"       // 60 s of orbiting elapsed, dance pattern
  | "parkedTight"   // ambient idle-circle docked (post-TTS, post-drag)
  | "dragOrbit";    // user dragging anchor, tight orbit follows live pos

export interface OrchestratorDeps {
  creature: () => Creature | undefined;
  anchor: () => { x: number; y: number };
  screen: () => { w: number; h: number };
  /** Notify-style callback: orchestrator fires this when it transitions
   *  to `offscreen` so App.tsx can run side effects (tink spawning,
   *  particle bursts) that aren't choreography per se. */
  onFlewOff?: () => void;
}

const RETURN_AFTER_FLYOFF_MS = 10_000;
const ORBIT_TO_DANCE_MS = 60_000;
const CELEBRATION_TO_FLYOFF_MS = 1600;
const POST_TTS_GUARD_MS = 200;

export class CreatureOrchestrator {
  private state: CreatureState = "hidden";
  private deps: OrchestratorDeps;

  // Timers — only one of these is ever active at a time.
  private returnTimer: number = 0;
  private danceTimer: number = 0;
  private celebrationTimer: number = 0;

  // Flags read from outside (App.tsx still queries these for tink-spawn
  // and similar side-effects).
  public flewOffOnce = false;
  public pendingExit = false;


  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  current(): CreatureState {
    return this.state;
  }

  // ── Public events ──────────────────────────────────────────

  onCreatureStarted() {
    if (this.state === "hidden") this.transitionTo("parkedTight");
  }

  onCreatureStopped() {
    this.cancelAllTimers();
    this.state = "hidden";
  }

  /** play-start-sound — claude is about to / just started a turn. */
  onClaudeStart() {
    this.cancelAllTimers();
    this.pendingExit = false;
    this.transitionTo("thinking");
  }

  /** play-complete-sound — claude finished its work. Arms an exit;
   *  the actual fly-off happens on the next tts-done OR after a
   *  fallback timeout. */
  onClaudeStop() {
    this.pendingExit = true;
    if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
    this.celebrationTimer = setTimeout(() => {
      this.celebrationTimer = 0;
      if (this.pendingExit) this.flyOff();
    }, CELEBRATION_TO_FLYOFF_MS) as unknown as number;
  }

  onTtsOpen() {
    // Once we've flown off for a session, the trailing summary TTS
    // shouldn't bring the mother back.
    if (this.state === "offscreen") return;
    this.cancelAllTimers();
    this.transitionTo("reading");
  }

  onTtsDone() {
    // If a fly-off was armed by claude-stop, this is when it fires.
    if (this.pendingExit) {
      this.flyOff();
      return;
    }
    if (this.state === "reading") {
      this.transitionTo("parkedTight");
    }
  }

  onTtsEscape() {
    this.pendingExit = false;
    if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
    this.celebrationTimer = 0;
    if (this.state === "reading") {
      this.transitionTo("parkedTight");
    }
  }

  onDragStart() {
    this.transitionTo("dragOrbit");
  }

  onDragEnd() {
    // Settle to orbit at the new anchor position. Drag-end has its own
    // visual rule (fan back to figure-8) so we dispatch directly and
    // set state without going through transitionTo.
    this.dispatch({
      type: "idle-figure8",
      target: this.deps.anchor(),
      radius: 220,
      speed: 1,
    });
    this.state = "parkedTight";
  }

  /** Mouse-activity poll feeds this. The only effect is reacting
   *  when the user comes back during dance mode: she "flies off
   *  embarrassed" rather than staying out — the existing 10 s
   *  return timer brings her back to orbiting around the anchor.
   *  After another 60 s of inactivity she re-enters dance, so the
   *  cycle repeats naturally. */
  setMouseIdle(idle: boolean) {
    if (!idle && this.state === "dancing") {
      this.flyOff();
    }
  }

  // ── Internals ──────────────────────────────────────────────

  private flyOff() {
    this.cancelAllTimers();
    this.pendingExit = false;
    this.flewOffOnce = true;
    this.dispatch({ type: "leave-screen", target: { x: 0, y: 0 } });
    this.state = "offscreen";
    if (this.deps.onFlewOff) this.deps.onFlewOff();
    // Schedule auto-return.
    this.returnTimer = setTimeout(() => {
      this.returnTimer = 0;
      this.transitionTo("orbiting");
    }, RETURN_AFTER_FLYOFF_MS) as unknown as number;
  }

  private transitionTo(next: CreatureState) {
    this.state = next;
    const a = this.deps.anchor();
    const sc = this.deps.screen();
    switch (next) {
      case "thinking":
        this.dispatch({ type: "idle-figure8", target: a, radius: 220, speed: 1 });
        break;
      case "reading":
        this.dispatch({ type: "idle-circle", target: a, radius: 180, speed: 1.1 });
        break;
      case "orbiting":
        this.dispatch({ type: "idle-circle", target: a, radius: 160, speed: 0.8 });
        // Once orbit has been running for a minute, switch to dance.
        if (this.danceTimer) clearTimeout(this.danceTimer);
        this.danceTimer = setTimeout(() => {
          this.danceTimer = 0;
          if (this.state === "orbiting") this.transitionTo("dancing");
        }, ORBIT_TO_DANCE_MS) as unknown as number;
        break;
      case "dancing":
        this.dispatch({
          type: "dance",
          target: { x: sc.w / 2, y: sc.h / 2 },
        });
        break;
      case "parkedTight":
        this.dispatch({ type: "idle-circle", target: a, radius: 140, speed: 0.6 });
        break;
      case "dragOrbit":
        this.dispatch({ type: "idle-circle", target: a, radius: 160, speed: 1.3 });
        break;
      // hidden / celebrating / offscreen — set state without dispatching.
      // celebrating doesn't have a dedicated movement; the existing
      // celebration choreography fires elsewhere (creature.react).
      case "hidden":
      case "celebrating":
      case "offscreen":
        break;
    }
    // Optional: emit a debug log for state changes — uncomment when tracing.
    // console.log(`[orchestrator] → ${next}`);
  }

  private dispatch(task: TaskConfig) {
    const c = this.deps.creature();
    if (!c) return;
    c.dispatch(task);
  }

  private cancelAllTimers() {
    if (this.returnTimer) { clearTimeout(this.returnTimer); this.returnTimer = 0; }
    if (this.danceTimer) { clearTimeout(this.danceTimer); this.danceTimer = 0; }
    if (this.celebrationTimer) { clearTimeout(this.celebrationTimer); this.celebrationTimer = 0; }
  }

  /** Cleanup hook for App.tsx onCleanup. */
  destroy() {
    this.cancelAllTimers();
    this.state = "hidden";
  }
}

export const CREATURE_ORCHESTRATOR_GUARD_MS = POST_TTS_GUARD_MS;
