import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";

interface WaveConfig {
  amplitude: number;
  wavelength: number;
  lineWidth: number;
  timeModifier: number;
  segmentLength: number;
}

export interface WaveRibbonConfig {
  enabled: boolean;
  speed: number;
  waves: WaveConfig[];
  color: string;    // base color for gradient
  yRatio: number;   // vertical position 0-1
}

export const defaultWaveRibbonConfig: WaveRibbonConfig = {
  enabled: true,
  // Base horizontal travel speed. Constant during speech — no longer
  // modulated by voice. Voice reactivity goes through `freqScale` and
  // `ampScale` instead, so the wave always flows rightward at the
  // same pace while compressing/expanding based on vocal energy.
  speed: 18,
  color: "rgba(220, 200, 255, 0.9)",
  yRatio: 0.5,
  // Two layered waves. Kept the stack thin per user feedback — more
  // lines started to look busy. Dynamics come from the modulation
  // ranges (freqScale / ampScale), not layer count.
  waves: [
    { amplitude:  150, wavelength:  80, lineWidth: 2.5, timeModifier: 1.4, segmentLength: 10 }, // main
    { amplitude: -150, wavelength:  40, lineWidth: 1.5, timeModifier: 2.4, segmentLength: 8  }, // tight top
  ],
};

const PI2 = Math.PI * 2;
const HALFPI = Math.PI / 2;

export class WaveRibbon {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: WaveRibbonConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
  private opacity = 0;        // master opacity, animated
  private targetOpacity = 0;
  private gradient: CanvasGradient | null = null;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private waveWidth = 0;
  private waveLeft = 0;
  private yAxis = 0;

  // ── Amplitude-history mode (Option B) ─────────────────────────────
  // Each render frame pushes the smoothed current amplitude into a
  // ring buffer; render draws the buffer as a mirrored line from
  // oldest (left) to newest (right). Reads as a live microphone
  // waveform — pure time-series display, no sine wave math.
  private readonly HIST_SIZE = 240;
  private ampHistory = new Float32Array(this.HIST_SIZE);
  private histHead = 0; // index of newest sample
  private currentAmp = 0;
  private targetAmp = 0;

  constructor(container: HTMLElement, config?: Partial<WaveRibbonConfig>) {
    this.config = { ...defaultWaveRibbonConfig, ...config };
    // Default vertical anchor follows config.yRatio until setAnchor is called.
    this.anchorFy = this.config.yRatio;

    this.canvas = document.createElement("canvas");
    // z:99997 sits above flow-particles (99998)… wait no, above paragraph
    // reader (99999). The wave wants to be ABOVE flow-particles (99998) so
    // triangles don't mask it, but below the voice anchor (99998 too, but
    // the anchor DOM is small and transparent outside the icon). Using 99997
    // puts it just above the creature/canvas layer (99997 for creatureMount)
    // — sit between particles and UI.
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99997;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  // Fractional anchor position — 0.5/0.5 is screen center. Change via setAnchor().
  private anchorFx = 0.5;
  private anchorFy = 0.5;
  // Live provider — when set, the render loop pulls the anchor's live
  // screen-pixel position (bob + drag + throw) every frame instead of
  // relying on the per-drag `setAnchor` callback. This is what keeps
  // the sine wave's vertical center phase-locked with the anchor's
  // idle bob regardless of SIZE or GSAP timing drift.
  private anchorPosProvider: (() => { x: number; y: number } | null) | null = null;

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.width = window.innerWidth * this.dpr;
    this.height = window.innerHeight * this.dpr;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = window.innerWidth + "px";
    this.canvas.style.height = window.innerHeight + "px";
    this.recomputePosition();
    this.buildGradient();
  }

  private recomputePosition() {
    // Localized patch (~400px wide) centered on the voice anchor.
    this.waveWidth = 400 * this.dpr;
    this.waveLeft = this.anchorFx * this.width - this.waveWidth / 2;
    this.yAxis = this.anchorFy * this.height;
  }

  /** Reposition the wave patch to a new anchor. Fractions 0-1.
   *  Only used as a fallback when no live provider is attached. */
  setAnchor(fx: number, fy: number) {
    this.anchorFx = Math.max(0, Math.min(1, fx));
    this.anchorFy = Math.max(0, Math.min(1, fy));
    this.recomputePosition();
    this.buildGradient();
  }

  /** Live anchor position provider — returns pixel coords (including
   *  idle bob). When set, used every frame in place of the cached
   *  setAnchor() value. Pass null to disable and fall back to setAnchor. */
  setAnchorPosProvider(fn: (() => { x: number; y: number } | null) | null) {
    this.anchorPosProvider = fn;
  }

  private buildGradient() {
    // Gradient fade — symmetric, with a longer transparent tail at each end
    // so the wave visibly emerges and vanishes smoothly rather than cutting
    // at a hard boundary. Stops 0.0/0.4 and 0.6/1.0 create a soft ramp; the
    // middle 20 % is full color.
    const grad = this.ctx.createLinearGradient(this.waveLeft, 0, this.waveLeft + this.waveWidth, 0);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(0.2, "rgba(0, 0, 0, 0)");
    grad.addColorStop(0.4, this.config.color);
    grad.addColorStop(0.5, this.config.color);
    grad.addColorStop(0.6, this.config.color);
    grad.addColorStop(0.8, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0)");
    this.gradient = grad;
  }

  private ease(percent: number, amplitude: number): number {
    return amplitude * (Math.sin(percent * PI2 - HALFPI) + 1) * 0.5;
  }

  /** Draw the amplitude ring buffer as a single closed ribbon: top
   *  edge (left → right) + bottom edge (right → left), connected at
   *  both ends and filled as one shape. Bezier interpolation (via
   *  quadraticCurveTo through midpoints) smooths the path so it reads
   *  as a flowing liquid trace rather than a polyline chart.
   *
   *  Oldest samples on the LEFT (about to leave the view), newest on
   *  the RIGHT (fresh voice entering). The whole ribbon scrolls
   *  left at a constant rate as rAF pushes new samples into the
   *  ring buffer each frame. */
  private drawAmplitudeHistory(bobY: number) {
    const ctx = this.ctx;
    const cy = this.yAxis + bobY;
    const peakAmp = 150 * this.dpr; // pixel height of a full-level sample

    const N = this.HIST_SIZE;
    const step = this.waveWidth / (N - 1);

    // Pre-compute top-edge coordinates once. We'll traverse forward for
    // the top and backward for the bottom (mirrored).
    const topX = new Float32Array(N);
    const topY = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const bufIdx = (this.histHead + 1 + i) % N; // oldest → newest
      const v = this.ampHistory[bufIdx];
      topX[i] = this.waveLeft + i * step;
      topY[i] = cy - v * peakAmp;
    }

    // Build a single closed path: top edge forward, then bottom edge
    // backward. quadraticCurveTo through midpoints gives a smooth
    // curve that passes through (or very near) every sample without
    // the sample-boundary kinks of a polyline.
    ctx.beginPath();
    ctx.moveTo(topX[0], topY[0]);
    for (let i = 0; i < N - 1; i++) {
      const mx = (topX[i] + topX[i + 1]) / 2;
      const my = (topY[i] + topY[i + 1]) / 2;
      ctx.quadraticCurveTo(topX[i], topY[i], mx, my);
    }
    ctx.lineTo(topX[N - 1], topY[N - 1]);

    // Bottom edge — mirror around cy, traversed right-to-left so the
    // path stays closed without ctx.closePath() handling the seam.
    for (let i = N - 1; i >= 0; i--) {
      const by = 2 * cy - topY[i]; // mirror top around cy
      if (i === N - 1) ctx.lineTo(topX[i], by);
      else if (i > 0) {
        const mx = (topX[i] + topX[i - 1]) / 2;
        const my = (by + (2 * cy - topY[i - 1])) / 2;
        ctx.quadraticCurveTo(topX[i], by, mx, my);
      } else {
        ctx.lineTo(topX[0], 2 * cy - topY[0]);
      }
    }
    ctx.closePath();

    // Vertical gradient fill — strongest at the center line, fading
    // to transparent at the ribbon's top and bottom edges. Gives a
    // soft airbrushed look rather than a hard-edged filled shape.
    const maxReach = peakAmp; // outer extent of any possible sample
    const vgrad = ctx.createLinearGradient(0, cy - maxReach, 0, cy + maxReach);
    vgrad.addColorStop(0, "rgba(0, 0, 0, 0)");
    vgrad.addColorStop(0.25, this.config.color);
    vgrad.addColorStop(0.5, this.config.color);
    vgrad.addColorStop(0.75, this.config.color);
    vgrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = vgrad;
    ctx.fill();

    // Thin stroke on top using the existing horizontal gradient — adds
    // definition to the ribbon's top+bottom edges without dominating.
    ctx.strokeStyle = this.gradient!;
    ctx.lineWidth = 1.2 * this.dpr;
    ctx.lineJoin = "round";
    ctx.stroke();
  }


  async init() {
    // Speech starts — fade in fast.
    this.unlisteners.push(
      await listen("tts-open", () => {
        if (!this.config.enabled) return;
        this.targetOpacity = 1;
        gsap.killTweensOf(this, "opacity");
        gsap.to(this, { opacity: 1, duration: 0.12, ease: "power2.out" });
      })
    );

    // tts-sentence — no-op in amplitude-history mode; kept as a
    // listener hook for future per-sentence signalling.
    this.unlisteners.push(
      await listen<{ level?: number; duration?: number }>("tts-sentence", () => {})
    );

    // Speech ends — targetAmp drains to zero so the tail empties out
    // of the ring buffer over the next ~1 second; opacity fades.
    this.unlisteners.push(
      await listen("tts-done", () => {
        this.targetAmp = 0;
        gsap.killTweensOf(this, "opacity");
        this.targetOpacity = 0;
        gsap.to(this, { opacity: 0, duration: 0.45, delay: 0.3, ease: "power2.out" });
      })
    );

    // Live amplitude — Rust emits `tts-amplitude` every ~50 ms with
    // the per-window peak normalized to the sentence peak (0..1).
    // Store it as the target; the render loop interpolates currentAmp
    // toward it per frame (with asymmetric attack/release smoothing).
    this.unlisteners.push(
      await listen<{ level?: number }>("tts-amplitude", (ev) => {
        if (this.targetOpacity < 0.5) return;
        const level = Math.max(0, Math.min(1, ev.payload?.level ?? 0));
        this.targetAmp = Math.pow(level, 0.7);
      })
    );

    // Abort paths — ESC or STT key-down collapses the waveform and
    // hides the canvas immediately.
    const abortCollapse = () => {
      this.targetAmp = 0;
      gsap.killTweensOf(this, "opacity");
      this.targetOpacity = 0;
      gsap.to(this, { opacity: 0, duration: 0.18, ease: "power2.out" });
    };
    this.unlisteners.push(await listen("tts-escape", abortCollapse));
    this.unlisteners.push(
      await listen<{ active: boolean }>("stt-active", (e) => {
        if (e.payload?.active) abortCollapse();
      })
    );

    this.start();
  }

  /** Manually show/hide */
  show() {
    this.targetOpacity = 1;
    gsap.to(this, { opacity: 1, duration: 0.6, ease: "power2.out" });
  }

  hide() {
    this.targetOpacity = 0;
    gsap.to(this, { opacity: 0, duration: 1.5, ease: "power2.in" });
  }

  private start() {
    if (this.running) return;
    this.running = true;

    const loop = () => {
      if (!this.running) return;

      this.ctx.clearRect(0, 0, this.width, this.height);

      // Advance amplitude history EVERY frame — even when opacity is
      // zero — so the ring buffer scrolls continuously at a steady
      // 60 Hz rate regardless of when it becomes visible.
      // Asymmetric smoothing: fast rise on voice onset (alpha 0.35),
      // slow decay when voice drops (alpha 0.06). Mic-meter envelope.
      const rising = this.targetAmp > this.currentAmp;
      const alpha = rising ? 0.35 : 0.06;
      this.currentAmp += (this.targetAmp - this.currentAmp) * alpha;
      this.histHead = (this.histHead + 1) % this.HIST_SIZE;
      this.ampHistory[this.histHead] = this.currentAmp;

      if (this.opacity > 0.01) {
        this.ctx.globalAlpha = this.opacity;

        // Pull live anchor position each frame — includes the idle bob
        // AND any in-flight drag/throw.
        let bobY = 0;
        const livePos = this.anchorPosProvider?.() ?? null;
        if (livePos) {
          const liveX = livePos.x * this.dpr;
          const liveY = livePos.y * this.dpr;
          const newLeft = liveX - this.waveWidth / 2;
          if (Math.abs(newLeft - this.waveLeft) > 0.5) {
            this.waveLeft = newLeft;
            this.buildGradient();
          }
          bobY = liveY - this.yAxis;
        }

        this.drawAmplitudeHistory(bobY);

        this.ctx.globalAlpha = 1;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  updateConfig(partial: Partial<WaveRibbonConfig>) {
    Object.assign(this.config, partial);
    this.yAxis = this.height * this.config.yRatio;
    this.buildGradient();
  }

  destroy() {
    this.running = false;
    gsap.killTweensOf(this);
    for (const u of this.unlisteners) u();
    this.canvas.remove();
  }
}
