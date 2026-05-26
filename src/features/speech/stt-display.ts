import gsap from "gsap";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Application, Container, Text, TextStyle } from "pixi.js";

interface SttPartialEvent {
  text: string;
  new_words: string[];
}

interface SttDoneEvent {
  text: string;
}

interface SttActiveEvent {
  active: boolean;
}

// (Amplitude events are consumed by AudioTentacles; no longer needed here.)

/**
 * STT Display — each transcribed word enters from off-screen RIGHT and
 * glides along a straight line into the voice anchor, lightly shrinking
 * and fading as it's absorbed. The word is rotated to match its travel
 * angle so off-axis entries (when the anchor is high/low) read as diagonal
 * swoops rather than horizontal slides.
 *
 * Depends on an anchor-position provider supplied by the caller so we can
 * recompute targets on every word — the anchor bobs and can be dragged.
 */
// Milliseconds between consecutive word spawns. Rust delivers
// `stt-partial` events in bursts (whole phrases arriving at once), so
// without staggering every word in a burst fires at the same instant and
// flies in as a pack. With the word-cloud effect, a tight stagger lets
// multiple words sit on screen at once (scattered around the anchor)
// without bunching, while keeping the spoken→visible gap short.
const WORD_SPAWN_GAP_MS = 120;

export class SttDisplay {
  private parent: HTMLDivElement;
  private unlisteners: UnlistenFn[] = [];
  private active = false;
  // User-controlled master toggle for the word-cloud visual. When off,
  // partials are dropped instead of scheduled. Updated via the
  // `stt-text-display-enabled` Tauri event; Rust emits it on every
  // setting change.
  private textDisplayEnabled = true;
  private anchorPosProvider:
    | (() => { x: number; y: number } | null)
    | null = null;
  // Monotonic schedule for staggered spawns. Each new word reserves the
  // next available slot; once it passes, subsequent words anchor to
  // `performance.now()` again so the stream keeps flowing.
  private nextSpawnAt = 0;
  // Pending spawn timers — cleared on hide/escape so we don't emit words
  // after the recording has ended.
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];
  // Most recent flyInWord time — drives the dynamic fade duration so
  // fast-speech words fade quicker than slow-speech words.
  private lastFlyTime = -Infinity;
  // Dedicated Pixi Application for the word cloud — own canvas, own
  // ticker. Avoids any singleton / shared-stage entanglement with the
  // rest of the Pixi-using features (each one that needs its own
  // canvas creates its own Application, see creature/renderer.ts).
  private app: Application | null = null;
  private layer: Container | null = null;
  // Particles are no longer owned here. STT emits into the shared
  // ambient-vfx pool and the creature's renderer draws them alongside
  // mother/companion/anchor particles. One engine, one render.

  constructor(parent: HTMLDivElement) {
    this.parent = parent;
  }

  /** Inject a function that returns the current anchor position in screen
   *  pixels. Words use it to pick their target per-spawn so the flow
   *  follows a dragged (and bobbing) anchor. */
  setAnchorPosProvider(fn: (() => { x: number; y: number } | null) | null) {
    this.anchorPosProvider = fn;
  }

  async init() {
    // Initial text-display gate — settle before the first key press so
    // there's no flash of unwanted words if the user left the toggle off
    // in a previous session.
    try {
      const s = await invoke<{ stt_text_display_enabled?: boolean }>("get_all_settings");
      if (typeof s?.stt_text_display_enabled === "boolean") {
        this.textDisplayEnabled = s.stt_text_display_enabled;
      }
    } catch { /* default true; harmless */ }

    // Dedicated Pixi Application for the word cloud. The canvas must
    // be click-through so the voice anchor (z-index 99998) stays
    // draggable. Following the pattern in pixi-app.ts (which was known
    // to coexist correctly with the anchor): pre-create the canvas
    // with pointer-events:none + position:fixed styling BEFORE passing
    // it to Application.init, so Pixi never has a chance to create
    // its own canvas with default hit-target styles.
    try {
      const canvas = document.createElement("canvas");
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.cssText =
        "position:fixed;top:0;left:0;width:100vw;height:100vh;" +
        "pointer-events:none;z-index:99996;";
      // Belt + braces: also set pointer-events as an !important rule
      // so nothing Pixi inlines during resize can override it.
      canvas.style.setProperty("pointer-events", "none", "important");
      this.parent.appendChild(canvas);

      this.app = new Application();
      await this.app.init({
        canvas,
        backgroundAlpha: 0,
        resizeTo: window,
        antialias: true,
        autoDensity: false,
        resolution: 1,
      });
      // Disable Pixi's interaction system — one more layer of safety
      // so it can't touch the canvas's event-target behaviour.
      this.app.stage.eventMode = "none";

      this.layer = new Container();
      this.layer.label = "stt-word-cloud";
      this.app.stage.addChild(this.layer);
    } catch (err) {
      console.error("[stt-display] pixi init failed", err);
    }

    this.unlisteners.push(
      await listen<boolean>("stt-text-display-enabled", (e) => {
        this.textDisplayEnabled = !!e.payload;
        if (!this.textDisplayEnabled) this.clearPendingSpawns();
      }),
    );

    this.unlisteners.push(
      await listen<SttActiveEvent>("stt-active", (e) => {
        this.active = !!e.payload.active;
        // Intentionally DON'T clearPendingSpawns on key-up. The final
        // decoded words are already scheduled; we want them to finish
        // their fly-in even after the user releases the button. The
        // `active` flag still blocks brand-new partials (none should
        // arrive once Rust cancels the decode loop anyway). Pending
        // spawns are cleared on stt-done and tts-escape below.
      }),
    );

    this.unlisteners.push(
      await listen<SttPartialEvent>("stt-partial", (e) => {
        if (!this.active) return;
        if (!this.textDisplayEnabled) return;
        for (const word of e.payload.new_words) this.scheduleSpawn(word);
      }),
    );

    this.unlisteners.push(
      await listen<SttDoneEvent>("stt-done", () => {
        this.active = false;
        // Let words already in flight finish their absorb animation, but
        // drop anything still queued — no point spawning words after the
        // session ended.
        this.clearPendingSpawns();
      }),
    );

    this.unlisteners.push(
      await listen("tts-escape", () => {
        this.active = false;
        this.clearPendingSpawns();
      }),
    );
  }

  // ── Spawn scheduling ─────────────────────────────────────────────────

  /**
   * Queue a word to fly in, staggered against the previous scheduled
   * spawn by WORD_SPAWN_GAP_MS. Words arrive from Rust in bursts; this
   * spreads them into a steady stream without changing the upstream
   * cadence.
   */
  private scheduleSpawn(text: string) {
    const now = performance.now();
    const at = Math.max(now, this.nextSpawnAt);
    this.nextSpawnAt = at + WORD_SPAWN_GAP_MS;
    const delay = at - now;
    if (delay <= 0) {
      this.flyInWord(text);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimers = this.pendingTimers.filter((t) => t !== timer);
      // No `!active` gate — if a spawn was scheduled while listening,
      // let it fly even after key-up so the last words aren't cut off.
      // Explicit aborts (stt-done / tts-escape) clear pendingTimers.
      this.flyInWord(text);
    }, delay);
    this.pendingTimers.push(timer);
  }

  private clearPendingSpawns() {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers = [];
    this.nextSpawnAt = 0;
  }

  // ── Word fly-in ──────────────────────────────────────────────────────

  /**
   * Word-cloud spawn (Pixi). Word flashes in REALLY big at a random
   * spot around the anchor, then simultaneously shrinks, drifts into
   * the anchor, and fades. Scale passes through ~1.0 mid-absorb so the
   * word is briefly readable at normal size on its way in.
   *
   * Phases:
   *   1. Pop (≈120 ms) — alpha 0→1, scale 0.55→1.6
   *   2. Absorb (≈1000 ms) — scale 1.6→0.3, position→anchor, alpha→0
   *      all concurrent; alpha back-loaded so the word stays legible
   *      until it's near the anchor.
   */
  private flyInWord(text: string) {
    const anchor = this.anchorPosProvider?.() ?? null;
    if (!anchor || !this.layer) return;

    // Random position in an annulus around the anchor. Inner bound
    // keeps words off the orb itself; outer bound keeps the cloud
    // readable as a clustered group.
    const INNER = 200;
    const OUTER = 300;
    const angle = Math.random() * Math.PI * 2;
    const radius = INNER + Math.random() * (OUTER - INNER);
    const startX = anchor.x + Math.cos(angle) * radius;
    const startY = anchor.y + Math.sin(angle) * radius;

    // Glow via TextStyle.dropShadow — Pixi rasterises this into the
    // text's texture ONCE at spawn, so there's zero per-frame shader
    // cost. distance:0 + blur makes the shadow read as a halo around
    // every glyph. `padding` extends the rendered texture past the
    // glyph bounds so the blurred halo isn't clipped at the edges —
    // without this, the shadow visibly disappears where the text
    // rectangle ends.
    const style = new TextStyle({
      fontFamily: "'SF Pro Display', -apple-system, system-ui, sans-serif",
      fontSize: 28,
      fontWeight: "400",
      fill: 0xffffff,
      letterSpacing: 0.3,
      padding: 16,
      dropShadow: {
        color: 0xffffff,
        alpha: 0.9,
        blur: 12,
        distance: 0,
        angle: 0,
      },
    });

    const node = new Text({ text, style });
    node.anchor.set(0.5);
    node.position.set(startX, startY);
    node.alpha = 0;
    // Start small so the back.out overshoot has real distance to
    // travel; feels like the word is popping INTO existence.
    node.scale.set(0.55);

    this.layer.addChild(node);

    const cleanup = () => {
      if (this.layer && node.parent === this.layer) {
        this.layer.removeChild(node);
      }
      node.destroy({ children: true });
    };

    const tl = gsap.timeline({ onComplete: cleanup });

    // Phase 1: POP — quick flash-in, scale goes BIG. No settle-back.
    const popDur = 0.12;
    tl.to(node, { alpha: 1, duration: popDur, ease: "power2.out" }, 0);
    tl.to(node.scale, { x: 1.6, y: 1.6, duration: popDur, ease: "power2.out" }, 0);

    // Phase 2: ABSORB — concurrent shrink + drift + fade. Scale passes
    // through 1.0 mid-tween so the word reads at "normal size" for a
    // beat on its way toward the anchor. Alpha fade is back-loaded so
    // the word stays legible until it's close to the anchor.
    const absorbDur = 1.0;
    tl.to(node.position, { x: anchor.x, y: anchor.y, duration: absorbDur, ease: "power2.in" });
    tl.to(node.scale, { x: 0.3, y: 0.3, duration: absorbDur, ease: "power2.in" }, "<");
    tl.to(node, {
      alpha: 0,
      duration: absorbDur * 0.4,
      delay: absorbDur * 0.6,
      ease: "power2.in",
    }, "<");
  }

  destroy() {
    this.active = false;
    this.clearPendingSpawns();
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    if (this.layer) {
      for (const child of [...this.layer.children]) {
        gsap.killTweensOf(child);
      }
      this.layer = null;
    }
    if (this.app) {
      // app.destroy(true, ...) removes the canvas from the DOM too.
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
  }
}
