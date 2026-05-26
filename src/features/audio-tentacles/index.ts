/**
 * AudioTentacles — two ribbons that flank the voice anchor while the
 * push-to-talk key is held. Each tentacle is drawn as a sine-modulated
 * polyline from just outside the orb outward; the wave phase travels
 * from TIP → BASE so motion reads as "receiving," like sonar chirps
 * funnelling into the orb.
 *
 * Three states, driven by the parent's STT event stream:
 *
 *   "off"        — invisible, retracted into the anchor.
 *   "listening"  — TWO-PHASE entry. First the tentacles fade in and
 *                  extend out straight (amplitude held at 0), THEN after
 *                  a brief delay the sine motion starts. Reads as "arms
 *                  reach out, then pick up the signal." Amplitude from
 *                  stt-amplitude drives wave height once the emerge
 *                  phase completes.
 *   "flat"       — released but decode still running. Sine motion fades
 *                  to zero (tentacles go flat), but they stay extended
 *                  and fully visible. Retracts happens in the next
 *                  state, not here.
 *
 * The state transitions are fast (~200 ms) so the feedback feels
 * immediate on press/release, rather than delayed until the decode loop
 * resolves.
 *
 * Per-tentacle extension state (rather than a shared scalar) lets the
 * ribbons stagger their emergence — each tentacle fires with a small
 * random delay + overshoot ease ("back.out"), giving the pair a slight
 * asymmetric pulse-out feel rather than a mirror-perfect fan.
 *
 * Architectural siblings:
 *   - [sine-waves.ts] — the inspiration (fullscreen canvas + GSAP-tweened
 *     scalars driving the render loop).
 *   - [voice-anchor/index.ts] — owns the (fx, fy) position we track, plus
 *     the optional idle bob that we follow via `anchorPosProvider`.
 */
import gsap from "gsap";

export type TentacleState = "off" | "flat" | "listening";

// Delay between extension starting and sine motion kicking in, in ms.
// The tentacles reach out STRAIGHT for this long, then begin squiggling.
// `setAmplitude` calls that arrive inside this window are ignored so an
// early stt-amplitude event can't short-circuit the emerge-flat phase.
// Window after setState("listening") during which incoming stt-amplitude
// events are ignored — protects the emerge animation from being snapped
// out of phase by a plosive on the user's first word (the click/thump of
// pressing the push-to-talk key usually registers as a spike). Also
// governs the delay before the built-in squiggle tween starts. Kept
// short so the tentacles feel alive within a single frame of the press.
const EMERGE_SILENCE_MS = 60;

interface TentacleDef {
  /** Radial direction from anchor (rad). */
  angle: number;
  /** How many full sine cycles fit along the tentacle length. */
  waveFreq: number;
  /** Phase-propagation rate (radians per tick). */
  waveSpeed: number;
  /** Random starting phase so tentacles don't move in lockstep. */
  phaseOffset: number;
  /** Per-tentacle length multiplier (0.8–1.2) for organic variance. */
  lengthFactor: number;
  /** Per-tentacle extension scalar — GSAP-tweened on setState. */
  extension: number;
}

export interface AudioTentaclesConfig {
  count: number;
  /** Px gap from anchor centre to the BASE of each tentacle. */
  baseRadius: number;
  length: number;
  waveHeight: number;
  lineWidth: number;
  colorBase: string;
  colorMid: string;
  colorTip: string;
  zIndex: number;
}

const DEFAULTS: AudioTentaclesConfig = {
  // Two tentacles — one on each side of the anchor, left + right.
  count: 2,
  // Base radius is INSIDE the orb's visible footprint (~27 px). The orb
  // sits on z-index 99998 and the tentacle canvas on 99996, so the inner
  // segment is occluded by the orb — visually the tentacles emerge from
  // behind/inside the orb rather than from a gap next to it. Length is
  // increased to compensate for the now-hidden inner portion.
  baseRadius: 16,
  length: 80,
  waveHeight: 22,
  lineWidth: 2.2,
  colorBase: "rgba(195, 165, 255, 0.75)",
  colorMid:  "rgba(140, 180, 255, 0.55)",
  colorTip:  "rgba(160, 230, 255, 0.00)",
  zIndex: 99996,
};

// Per-state targets for opacity + extension. Squiggle is handled
// separately (via `amplitude`) so a state can be "extended + flat" —
// fully out but with no sine motion.
const STATE_TARGETS: Record<TentacleState, { opacity: number; extensionTarget: number }> = {
  off:       { opacity: 0, extensionTarget: 0 },
  flat:      { opacity: 1, extensionTarget: 1 },
  listening: { opacity: 1, extensionTarget: 1 },
};

export class AudioTentacles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cfg: AudioTentaclesConfig;
  private tentacles: TentacleDef[] = [];
  private rafId = 0;

  // Master opacity — GSAP-tweened on setState(). Each tentacle also has
  // its own `extension` (per-member) that gets staggered.
  private opacity = 0;
  // Starts at 0 so the emerge phase begins truly flat; ramps up via the
  // delayed tween in setState("listening"). stt-amplitude events after
  // the emerge window override this via setAmplitude().
  private amplitude = 0;
  private state: TentacleState = "off";
  /** When setState("listening") last fired. `setAmplitude` ignores
   *  anything within EMERGE_SILENCE_MS of this so an early stt-amplitude
   *  event can't skip the flat-emerge phase. */
  private listeningStartedAt = 0;

  // Phase accumulator — shared across all tentacles so they feel like one
  // gesture. Wave direction is inward (`sin(k·u − ω·time)`).
  private time = 0;

  // Fallback fractional anchor — used only if no provider is supplied.
  private anchorFx = 0.5;
  private anchorFy = 0.5;
  private anchorPosProvider: (() => { x: number; y: number } | null) | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(container: HTMLElement, config: Partial<AudioTentaclesConfig> = {}) {
    this.cfg = { ...DEFAULTS, ...config };

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      `position:fixed;top:0;left:0;width:100vw;height:100vh;` +
      `pointer-events:none;z-index:${this.cfg.zIndex};`;
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    // Fixed left + right angles — 0 (right) and π (left). The previous
    // full-circle distribution looked like a sea anemone; two flanking
    // tentacles read as bilateral "ears." When `count` is configured to
    // something other than 2 we fall back to the old even-radial
    // distribution so the component stays flexible.
    const angles: number[] =
      this.cfg.count === 2
        ? [0, Math.PI]
        : Array.from({ length: this.cfg.count }, (_, i) => (i / this.cfg.count) * Math.PI * 2);

    for (let i = 0; i < this.cfg.count; i++) {
      this.tentacles.push({
        angle: angles[i] + (Math.random() - 0.5) * 0.08,
        waveFreq: 2.6 + Math.random() * 0.9,
        waveSpeed: 0.20 + Math.random() * 0.08,
        phaseOffset: Math.random() * Math.PI * 2,
        lengthFactor: 0.82 + Math.random() * 0.36,
        extension: 0,
      });
    }

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  async init(): Promise<void> {
    this.start();
  }

  /** Fallback when no provider is set — fractional coords only, no bob. */
  setAnchor(fx: number, fy: number) {
    this.anchorFx = fx;
    this.anchorFy = fy;
  }

  /** Preferred live-position source — returns the anchor's rendered
   *  centre (includes idle bob). Polled every frame in render(). */
  setAnchorPosProvider(fn: (() => { x: number; y: number } | null) | null) {
    this.anchorPosProvider = fn;
  }

  /**
   * Choreography by target state. Fast transitions (~200 ms) so button
   * press/release feels immediate.
   *
   *   off       — retract extension + fade out. Sine motion also fades
   *               down in parallel so the last visible frame is flat.
   *   listening — TWO-PHASE entry. Extension + opacity ramp in straight
   *               first; a delayed amplitude tween kicks in the sine
   *               motion once the tentacles are out. stt-amplitude
   *               events that arrive inside EMERGE_SILENCE_MS are
   *               ignored so the "reach-out-then-squiggle" phasing
   *               can't be short-circuited.
   *   flat      — released but decode still running. Tentacles stay
   *               extended + opaque but amplitude tweens to 0 so they
   *               stop squiggling — "went quiet." Retract happens on
   *               the next state transition ("off"), not here.
   */
  setState(state: TentacleState) {
    if (state === this.state) return;
    this.state = state;
    const target = STATE_TARGETS[state];

    gsap.killTweensOf(this, "opacity");
    gsap.killTweensOf(this, "amplitude");
    for (const t of this.tentacles) gsap.killTweensOf(t, "extension");

    if (state === "off") {
      gsap.to(this, { opacity: 0, duration: 0.32, ease: "power2.in" });
      gsap.to(this, { amplitude: 0, duration: 0.32, ease: "power2.in" });
      for (const t of this.tentacles) {
        gsap.to(t, { extension: 0, duration: 0.35, ease: "power2.in" });
      }
      return;
    }

    if (state === "listening") {
      // Phase 1 — reach out straight. Snap amplitude to 0 immediately so
      // any residual motion from a prior "listening" session dies
      // instantly; the visual starts flat.
      //
      // Extension + opacity tweens are short (~100 ms) and have NO per-
      // tentacle stagger, so the response to a keypress reads as
      // instantaneous rather than "animated in." Stagger/back.out was
      // making the emerge feel playful; the user wants snappy.
      this.listeningStartedAt = performance.now();
      this.amplitude = 0;

      gsap.to(this, { opacity: target.opacity, duration: 0.1, ease: "power2.out" });
      for (const t of this.tentacles) {
        gsap.to(t, {
          extension: target.extensionTarget,
          duration: 0.1,
          ease: "power2.out",
        });
      }

      // Phase 2 — after the reach completes, start squiggling. stt-amplitude
      // events arriving after EMERGE_SILENCE_MS will take over this tween
      // via setAmplitude().
      gsap.to(this, {
        amplitude: 1.1,
        duration: 0.5,
        delay: EMERGE_SILENCE_MS / 1000,
        ease: "sine.out",
      });
      return;
    }

    // "flat" — released, still visible, no squiggle. Hold extension at 1
    // (retweening explicitly in case a previous listening tween left it
    // mid-flight) and flatten amplitude.
    gsap.to(this, { opacity: target.opacity, duration: 0.2, ease: "power2.out" });
    gsap.to(this, { amplitude: 0, duration: 0.4, ease: "power2.out" });
    for (const t of this.tentacles) {
      gsap.to(t, { extension: target.extensionTarget, duration: 0.22, ease: "power2.out" });
    }
  }

  /**
   * Drive wave height from the STT amplitude event. Only applies during
   * "listening" state AND only after the emerge-flat window has passed —
   * otherwise the phased entry visual would be skipped the instant the
   * first stt-amplitude arrived. GSAP-smoothed because stt-amplitude
   * fires on a coarse cadence (~600 ms) and the raw values step visibly.
   */
  setAmplitude(amp: number) {
    if (this.state !== "listening") return;
    if (performance.now() - this.listeningStartedAt < EMERGE_SILENCE_MS) return;
    const clamped = Math.max(0, Math.min(1, amp));
    const shaped = Math.pow(clamped, 0.75);
    const target = 0.28 + shaped * 1.9;
    gsap.killTweensOf(this, "amplitude");
    gsap.to(this, { amplitude: target, duration: 0.18, ease: "sine.out" });
  }

  destroy() {
    this.stop();
    this.canvas.remove();
  }

  // ── Internals ────────────────────────────────────────────────────────

  private start() {
    if (this.rafId) return;
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.time += 1;
      this.render();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * this.dpr;
    this.canvas.height = this.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private render() {
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (this.opacity <= 0.001) return;

    // Prefer the provider so we pick up the anchor's idle bob each frame.
    // Falls back to the fractional anchor if no provider is registered.
    const pos = this.anchorPosProvider?.() ?? null;
    const ax = pos ? pos.x : this.anchorFx * this.width;
    const ay = pos ? pos.y : this.anchorFy * this.height;

    for (const t of this.tentacles) this.drawTentacle(t, ax, ay);
  }

  private drawTentacle(t: TentacleDef, ax: number, ay: number) {
    const L = this.cfg.length * t.lengthFactor * t.extension;
    if (L < 0.5) return;

    const ctx = this.ctx;
    const cosA = Math.cos(t.angle);
    const sinA = Math.sin(t.angle);
    const perpX = -sinA;
    const perpY = cosA;
    const ampPx = this.cfg.waveHeight * this.amplitude;

    const STEPS = 28;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const u = i / STEPS; // 0 at base, 1 at tip
      const along = this.cfg.baseRadius + u * L;

      // Taper: pinned at base, bulges through the middle, fades at tip.
      // Skewed slightly toward the outer half for a forward-heavy reach.
      const taper = Math.sin(u * Math.PI) * (0.55 + 0.45 * u);

      // Inward-travelling wave (tip → base) with per-tentacle phase.
      const phase = u * t.waveFreq * Math.PI * 2 - this.time * t.waveSpeed + t.phaseOffset;
      const wave = Math.sin(phase) * ampPx * taper;

      const x = ax + cosA * along + perpX * wave;
      const y = ay + sinA * along + perpY * wave;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    const grad = ctx.createLinearGradient(
      ax + cosA * this.cfg.baseRadius,
      ay + sinA * this.cfg.baseRadius,
      ax + cosA * (this.cfg.baseRadius + L),
      ay + sinA * (this.cfg.baseRadius + L),
    );
    grad.addColorStop(0, withAlpha(this.cfg.colorBase, this.opacity));
    grad.addColorStop(0.55, withAlpha(this.cfg.colorMid, this.opacity));
    grad.addColorStop(1, this.cfg.colorTip);

    ctx.strokeStyle = grad;
    ctx.lineWidth = this.cfg.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

/** Multiply the alpha of an rgba()/hsla() string by `mult`. */
function withAlpha(rgba: string, mult: number): string {
  const m = rgba.match(/(rgba?|hsla?)\(([^)]+)\)/);
  if (!m) return rgba;
  const parts = m[2].split(",").map((s) => s.trim());
  if (parts.length < 4) return rgba;
  const a = parseFloat(parts[3]) * mult;
  return `${m[1]}(${parts[0]}, ${parts[1]}, ${parts[2]}, ${a.toFixed(3)})`;
}
