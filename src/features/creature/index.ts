/**
 * Creature — a Pixi-based tentacled companion for the native overlay.
 *
 * Ported from the telemorph project. The renderer handles all rendering,
 * choreo, particles, and companions internally. This class is a thin
 * public API: start(container), stop(), react(event, payload).
 *
 * Usage:
 *   const creature = new Creature();
 *   await creature.start(mountNode);   // mounts Pixi canvas
 *   creature.react("claude-start", {}); // switch to think-orbit
 *   creature.stop();                    // tear down
 */
import { createScene, type Scene } from "./renderer";
import type { TaskConfig } from "./choreo";

export type CreatureEvent =
  | "claude-start"        // Claude begins streaming — switch to focused motion
  | "claude-stop"         // Claude finished — flourish + drift
  | "tool-run"            // A tool call fires — pulse
  | "confirm"             // User confirms an action — nod
  | "deny"                // User denies — shake and retreat
  | "file-saved"          // File written — tiny bounce
  | "test-pass"           // Tests went green — celebration
  | "test-fail"           // Tests failed — alert
  | "error"               // Error emitted — red flash + bounce
  | "idle"                // User idle for N seconds — preen
  | "return"              // User came back — peek
  | "plan-update"         // TodoWrite fired
  | "notify";             // Generic attention-grab

export class Creature {
  private scene: Scene | null = null;
  private container: HTMLElement | null = null;
  private started = false;
  private anchor: { x: number; y: number } | null = null;

  /** Update the voice anchor — the target point the creature flies to on
   *  TTS and settles its figure-8 pattern on. Called by VoiceAnchor drag. */
  setAnchor(pos: { x: number; y: number }) {
    this.anchor = { ...pos };
  }

  /** Live-update the current task's anchor in place — the creature follows
   *  a moving target without a re-dispatch. Used during anchor drag for a
   *  boid-like "swim with me" effect. */
  followAnchor(pos: { x: number; y: number }) {
    this.anchor = { ...pos };
    this.scene?.choreo.setAnchor(pos.x, pos.y);
  }

  async start(container: HTMLElement): Promise<void> {
    if (this.started) return;
    this.container = container;
    this.scene = await createScene(container);
    this.started = true;

    // Start off-screen — creature waits offstage until the user asks a
    // question (claude-start) or TTS opens. Prevents a cold-start flourish
    // when the overlay first mounts.
    this.scene.dispatch({ type: "leave-screen", target: { x: 0, y: 0 } });
  }

  stop(): void {
    if (!this.started) return;
    this.scene?.stop();
    this.scene?.destroy();
    this.scene = null;
    if (this.container) {
      // Clear any leftover canvas node
      this.container.innerHTML = "";
    }
    this.container = null;
    this.started = false;
  }

  /**
   * React to an event from the hook bus. Maps event types to choreo
   * dispatches. Unknown events are ignored.
   */
  react(event: CreatureEvent, _payload?: unknown): void {
    if (!this.scene) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    switch (event) {
      case "claude-start":
        // "Thinking" — wide figure-8 across the screen. Radius 300 covers
        // most of the area (was 220 — felt cramped; was 380 + 0.4× speed
        // — looked frozen). Speed 0.85× = lively motion, slightly calmer
        // than the original 1.0 so the creature reads as confident but
        // not frantic.
        this.scene.dispatch({ type: "idle-figure8", target: { x: cx, y: cy }, radius: 300, speed: 0.85 });
        break;

      case "claude-stop":
        // Celebrate; app-level orchestrator decides when to fly off
        // (after the completion-summary TTS finishes, or via fallback timer).
        this.scene.dispatch({ type: "celebration", target: { x: cx, y: cy } });
        break;

      case "tool-run":
      case "plan-update":
        // Quick flourish — dance briefly.
        this.scene.dispatch({ type: "dance", target: { x: cx, y: cy } });
        break;

      case "confirm":
      case "test-pass":
        this.scene.dispatch({ type: "celebration", target: { x: cx, y: cy } });
        break;

      case "deny":
      case "test-fail":
      case "error":
        // Exit screen briefly then come back to drift — reads as upset/retreat.
        this.scene.dispatch({ type: "leave-screen", target: { x: 0, y: 0 } });
        setTimeout(() => {
          this.scene?.dispatch({ type: "idle-figure8", target: { x: cx, y: cy }, radius: 240 });
        }, 1500);
        break;

      case "file-saved":
      case "notify":
        this.scene.dispatch({ type: "notify", target: { x: 0, y: 0 }, direction: "right" });
        break;

      case "idle":
      case "return":
        // Return to a gentle drift in the center.
        this.scene.dispatch({ type: "idle-figure8", target: { x: cx, y: cy }, radius: 260 });
        break;
    }
  }

  /** Escape hatch for custom tasks from app code. */
  dispatch(config: TaskConfig): void {
    this.scene?.dispatch(config);
  }

  /** Current mother head position in screen pixels + current hue, for
   *  callers that want to colour-match against her (e.g. the voice-anchor
   *  glint). Returns null when the creature isn't running or is parked
   *  off-screen. Safe to poll per-frame. */
  getMotherPos(): { x: number; y: number; hue: number } | null {
    return this.scene?.getMotherPos() ?? null;
  }

  /** Reveal one more companion tink (up to 3). Returns new count. */
  spawnTink(): number {
    return this.scene?.spawnTink() ?? 0;
  }
}
