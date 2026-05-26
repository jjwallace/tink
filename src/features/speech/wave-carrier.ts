import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";
import { createNoise2D } from "simplex-noise";

interface WaveConfig {
  amplitude: number;
  wavelength: number;
  lineWidth: number;
  timeModifier: number;
  segmentLength: number;
  // Per-layer sensitivity to voice modulation. This is what makes
  // the carrier+shimmer visually do different jobs: the carrier
  // sits at low values (mostly steady), the shimmer at high values
  // (very reactive). 1.0 = fully responds to ampScale/freqScale,
  // 0.0 = ignores it entirely.
  ampResponse: number;
  freqResponse: number;
}

export interface WaveCarrierConfig {
  enabled: boolean;
  speed: number;
  waves: WaveConfig[];
  color: string;    // base color for gradient
  yRatio: number;   // vertical position 0-1
  // Subtle noise perturbation retained from wave-dancer for
  // per-cycle variation. Low default so the carrier/shimmer
  // structure reads clearly without being masked.
  noiseStrength: number;
  noiseSpatialScale: number;
  noiseTemporalScale: number;
  // ── Traveling compression zones ──────────────────────────────────
  // A sinusoidal phase-modulation field that rolls rightward at its
  // own speed — independent of the wave's horizontal travel. Creates
  // alternating zones along x where the wave is locally compressed
  // (tight) and relaxed (wavy). As time advances, those zones slide
  // across the patch, so the wave reads as "regions of frequency
  // rippling from left to right."
  //
  //   `compressFlowStrength`     Phase-modulation amplitude in radians.
  //                              Per-layer scaled by the layer's
  //                              freqResponse, so shimmer gets hit
  //                              hard and carrier barely notices.
  //   `compressFlowSpatialScale` How many compression zones fit in
  //                              the patch. 0.03 ≈ one zone per 200 px.
  //   `compressFlowSpeed`        Rightward travel rate (rad/sec).
  compressFlowStrength: number;
  compressFlowSpatialScale: number;
  compressFlowSpeed: number;
}

export const defaultWaveCarrierConfig: WaveCarrierConfig = {
  enabled: true,
  // Base horizontal travel speed. Constant during speech — no longer
  // modulated by voice. Voice reactivity goes through `freqScale` and
  // `ampScale` instead, so the wave always flows rightward at the
  // same pace while compressing/expanding based on vocal energy.
  speed: 18,
  color: "rgba(220, 200, 255, 0.9)",
  yRatio: 0.5,
  // Pitched carrier + consonant shimmer preset. Two waves doing
  // visibly different jobs:
  //
  //   carrier  — big, slow, wide wavelength, nearly steady amp, very
  //              low freq response. Reads as "vocal pitch."
  //   shimmer  — small, tight wavelength, highly reactive amp AND
  //              freq. Reads as "consonant energy" that spikes on
  //              emphasis.
  //
  // The large disparity in wavelength (180 vs 16) + the wildly
  // different ampResponse values (0.25 vs 1.0) mean you can clearly
  // see each layer's role at a glance.
  waves: [
    {
      amplitude: 160, wavelength: 180, lineWidth: 2.8,
      timeModifier: 0.55, segmentLength: 12,
      ampResponse: 0.25, freqResponse: 0.15,
    },
    {
      amplitude: -115, wavelength: 14,  lineWidth: 1.1,
      timeModifier: 2.6, segmentLength: 3,
      ampResponse: 1.0, freqResponse: 0.85,
    },
  ],
  // Low noise — the two-layer structure carries the visual character,
  // don't want to muddy it with jitter.
  noiseStrength: 0.08,
  noiseSpatialScale: 0.006,
  noiseTemporalScale: 0.8,
  // Traveling compression zones — default tuned so shimmer visibly
  // has compressed bursts rolling across, carrier stays mostly
  // undisturbed.
  compressFlowStrength: 2.8,
  compressFlowSpatialScale: 0.03,
  compressFlowSpeed: 1.8,
};

const PI2 = Math.PI * 2;
const HALFPI = Math.PI / 2;

export class WaveCarrier {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: WaveCarrierConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
  // Noise field for D — 2D simplex so neighboring samples in both
  // space and time vary smoothly (no hard jitter). Sampled per point
  // in drawWave to perturb phase + amplitude.
  private noise = createNoise2D();
  private time = 0;
  // Accumulated phase for the traveling-compression field. Advanced
  // each render frame by a rate that scales with the current
  // freqScale, so zones sweep faster when voice is compressing the
  // wave harder. Accumulating as state avoids phase jumps when the
  // speed factor changes mid-tween.
  private compressFlowPhase = 0;
  private lastFrameTime = 0;
  // Amplitude scale — multiplied into each wave's amplitude in drawWave.
  // 1.0 during active speech, tweened down to ~0.35 on tts-done so the
  // idle wave still breathes but visually recedes.
  private ampScale = 1;
  // Frequency scale — multiplies into the spatial-frequency term in
  // drawWave. 1.0 at baseline; voice emphasis tightens it (waves
  // compress horizontally) without changing the horizontal travel
  // speed. Primary modulation during speech.
  private freqScale = 1;
  private opacity = 0;        // master opacity, animated
  private targetOpacity = 0;
  private gradient: CanvasGradient | null = null;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private waveWidth = 0;
  private waveLeft = 0;
  private yAxis = 0;

  constructor(container: HTMLElement, config?: Partial<WaveCarrierConfig>) {
    this.config = { ...defaultWaveCarrierConfig, ...config };
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
    // Sharper center-focused envelope than the original cosine bump.
    // `sin(π·p)^1.9` peaks tall and narrow at p=0.5, falls off fast
    // at the patch edges — reads as "amplitude concentrated in the
    // center" per user feedback.
    const base = Math.sin(percent * Math.PI);
    return amplitude * Math.pow(base, 1.9);
  }

  private drawWave(time: number, wave: WaveConfig, bobY: number) {
    const ctx = this.ctx;
    const { wavelength, lineWidth, segmentLength } = wave;
    // Scale amplitude to match the narrow 200px patch — default config is
    // tuned to full-screen waves. 2× factor so the wave is visibly tall
    // without overpowering the button.
    const amplitude = wave.amplitude * (this.waveWidth / (this.width * 0.7)) * 2;

    ctx.lineWidth = lineWidth * this.dpr;
    ctx.strokeStyle = this.gradient!;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    // Initial position — left edge of canvas, on the center line.
    // `prevX/prevY` track the previously-plotted point so each new
    // segment's quadraticCurveTo can use it as a control point. The
    // curve anchor is the midpoint between prev and current, which
    // is the standard "smooth through midpoints" technique. Same
    // math as wave-ribbon's top/bottom edges.
    let prevX = 0;
    let prevY = this.yAxis + bobY;
    ctx.moveTo(prevX, prevY);
    // Straight segment from left edge to the patch — flat before the
    // wave starts. Keeps the curve anchored outside the visible patch.
    ctx.lineTo(this.waveLeft, this.yAxis + bobY);
    prevX = this.waveLeft;
    prevY = this.yAxis + bobY;

    // HARD DIRECTION INVARIANT. Three separate guards all enforce the
    // same rule: the wave only travels in ONE direction, never the other.
    //   1. Math.abs(speed)  — speed term never goes negative.
    //   2. sin(kx − ωt)      — the leading minus on (time * speed) is the
    //                          textbook rightward-traveling wave form.
    //   3. this.time += 0.008 in render loop — monotonic, never decreases.
    // Any single guard would suffice. All three together make it
    // impossible for the wave to reverse. Never remove any of them.
    const positiveSpeed = Math.abs(this.config.speed);
    const freq = this.freqScale;
    // Anchor the freq-scaled spatial term at the horizontal center of
    // the wave patch. When freqScale tweens, the wave now breathes
    // out/in from this point — no apparent left/right translation.
    // Previously this used `this.yAxis` (a VERTICAL coord, ~500 px)
    // as the phase reference, which put the breathing anchor
    // off-screen and made freq changes look like the wave was
    // travelling backward during the tween.
    const midI = this.waveWidth / 2;
    // Per-layer scaling of the global voice modulation. A wave with
    // ampResponse=0 ignores ampScale entirely (steady amplitude);
    // ampResponse=1 fully responds. Same for freq. This is what
    // makes the carrier stay calm while the shimmer spikes.
    const ampResp = wave.ampResponse;
    const freqResp = wave.freqResponse;
    const effectiveAmpScale = 1 + (this.ampScale - 1) * ampResp;
    const effectiveFreq = 1 + (freq - 1) * freqResp;
    // Subtle noise for per-cycle variation.
    const nStr = this.config.noiseStrength;
    const nSpace = this.config.noiseSpatialScale;
    const nTime = this.config.noiseTemporalScale;
    // Traveling compression — phase-modulation field that rolls
    // rightward. `compressPhase` is the temporal component; combined
    // with `i * compressFreq` below it creates sin(ω_s·i − ω_t·t)
    // zones that slide across the patch at ω_t/ω_s px per second.
    // Scaled by per-layer freqResp so shimmer gets the full effect
    // and carrier only a hint.
    const compressAmp = this.config.compressFlowStrength * freqResp;
    const compressFreq = this.config.compressFlowSpatialScale;
    // Phase is now state-accumulated in the render loop so speed can
    // scale with freqScale without causing discontinuities.
    const compressPhase = this.compressFlowPhase;
    for (let i = 0; i < this.waveWidth; i += segmentLength) {
      const noisePhase = this.noise(i * nSpace, time * nTime) * 0.4 * nStr;
      const noiseAmp = 1 + this.noise(i * nSpace * 0.7, time * nTime * 0.6) * 0.2 * nStr;
      // Traveling compression zone offset. Bounded by compressAmp so
      // local frequency stays positive (wave still flows rightward
      // everywhere; zones just look denser or more relaxed).
      const compressOffset = compressAmp * Math.sin(i * compressFreq - compressPhase);
      // Direction-invariant preserved: Math.abs on speed, leading
      // minus on the temporal term, monotonic this.time.
      const x = -(time * positiveSpeed)
        + (i - midI) * effectiveFreq / wavelength
        + compressOffset
        + noisePhase;
      const y = Math.sin(x);
      const amp = this.ease(i / this.waveWidth, amplitude) * effectiveAmpScale * noiseAmp;
      const px = i + this.waveLeft;
      const py = amp * y + this.yAxis + bobY;
      // Quadratic Bezier with the previous plotted point as control,
      // midpoint between prev and current as anchor. Smooths the
      // polyline kinks at high frequency compression.
      const mx = (prevX + px) / 2;
      const my = (prevY + py) / 2;
      ctx.quadraticCurveTo(prevX, prevY, mx, my);
      prevX = px;
      prevY = py;
    }
    ctx.lineTo(prevX, prevY);
    ctx.lineTo(this.width, this.yAxis + bobY);
    ctx.stroke();
  }

  async init() {
    // Snapshot baseSpeed once at init — tts-sentence tweens mutate
    // config.speed live, so we need a stable reference for all three
    // listeners (open / sentence / done) to compute their targets.
    const baseSpeed = this.config.speed;

    // Speech starts — lock the travel speed at baseSpeed (stays
    // constant for the whole session), set full baseline amplitude,
    // and set freqScale to 1.0. Voice reactivity below then tightens
    // freqScale + nudges ampScale on emphasis; speed is never touched.
    this.unlisteners.push(
      await listen("tts-open", () => {
        if (!this.config.enabled) return;
        this.targetOpacity = 1;
        gsap.killTweensOf(this, "opacity");
        gsap.to(this, { opacity: 1, duration: 0.12, ease: "power2.out" });
        gsap.killTweensOf(this, "ampScale");
        gsap.to(this, { ampScale: 1.0, duration: 0.25, ease: "power2.out" });
        gsap.killTweensOf(this, "freqScale");
        gsap.to(this, { freqScale: 1.0, duration: 0.25, ease: "power2.out" });
        gsap.killTweensOf(this.config, "speed");
        gsap.to(this.config, { speed: baseSpeed, duration: 0.2, ease: "power2.out" });
      })
    );

    // tts-sentence is now a no-op — live tts-amplitude drives everything.
    // Kept as a listener for parity / future per-sentence signalling.
    this.unlisteners.push(
      await listen<{ level?: number; duration?: number }>("tts-sentence", () => {})
    );

    // Speech ends — fade everything down together quickly so the wave
    // disappears when the voice stops, not a second and a half later.
    // Kill all three in-flight tweens first (opacity especially — if
    // tts-open was still ramping up, its tween would fight the ramp-
    // down and produce the "speeds up and goes crazy" artifact).
    this.unlisteners.push(
      await listen("tts-done", () => {
        gsap.killTweensOf(this, "opacity");
        gsap.killTweensOf(this, "ampScale");
        gsap.killTweensOf(this, "freqScale");
        gsap.killTweensOf(this.config, "speed");
        this.targetOpacity = 0;
        gsap.to(this, { opacity: 0, duration: 0.35, ease: "power2.out" });
        gsap.to(this, { ampScale: 0, duration: 0.35, ease: "power2.out" });
        gsap.to(this, { freqScale: 1.0, duration: 0.35, ease: "power2.out" });
        gsap.to(this.config, { speed: baseSpeed * 0.25, duration: 0.35, ease: "power2.out" });
      })
    );

    // Live amplitude — Rust emits `tts-amplitude` every ~50 ms with
    // the per-window peak normalized to the sentence peak (0..1).
    //
    // Horizontal travel speed is LOCKED at baseSpeed — we don't touch
    // config.speed here. Voice reactivity compresses the wave's
    // spatial frequency (freqScale) and, more subtly, scales amplitude.
    // 320 ms sine.inOut tweens give a flowy, chasing response.
    this.unlisteners.push(
      await listen<{ level?: number }>("tts-amplitude", (ev) => {
        if (this.targetOpacity < 0.5) return;
        const level = Math.max(0, Math.min(1, ev.payload?.level ?? 0));
        // Gentle power curve — mid-range voice still reacts clearly.
        const shaped = Math.pow(level, 0.7);

        // Frequency — primary modulation. 1.0 baseline → 5.0 on peaks.
        // Loud syllables now compress wavelengths 5× tighter so spikes
        // read as very dense, high-frequency bursts — proper "voice
        // detected" energy.
        const freqTarget = 1.4 + shaped * 12.5;
        gsap.killTweensOf(this, "freqScale");
        gsap.to(this, { freqScale: freqTarget, duration: 0.26, ease: "sine.inOut" });

        // Amplitude — narrower swing than before so the wave stays a
        // more moderate height overall. 0.25 (whisper) → 1.75 (loud).
        // Combined with lower base wave amplitudes, the wave no
        // longer overpowers the anchor on emphasis.
        const ampTarget = 0.25 + shaped * 1.5;
        gsap.killTweensOf(this, "ampScale");
        gsap.to(this, { ampScale: ampTarget, duration: 0.26, ease: "sine.inOut" });
      })
    );

    // Abort paths — both ESC and STT key-down cut TTS mid-word; the
    // wave should disappear immediately rather than play its staged
    // fade (which is for natural end-of-speech). Kill all in-flight
    // tweens so any prior staged fade doesn't override this one.
    const abortCollapse = () => {
      gsap.killTweensOf(this.config, "speed");
      gsap.killTweensOf(this, "ampScale");
      gsap.killTweensOf(this, "freqScale");
      gsap.killTweensOf(this, "opacity");
      this.targetOpacity = 0;
      gsap.to(this, { opacity: 0, duration: 0.18, ease: "power2.out" });
      gsap.to(this, { ampScale: 0, duration: 0.18, ease: "power2.out" });
      gsap.to(this, { freqScale: 1.0, duration: 0.18, ease: "power2.out" });
      gsap.to(this.config, { speed: baseSpeed * 0.08, duration: 0.2, ease: "power2.out" });
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

      if (this.opacity > 0.01) {
        // Monotonic time — only INCREASES. Paired with Math.abs(speed) in
        // drawWave and the leading minus on the phase, this makes reverse
        // travel mathematically impossible.
        this.time += 0.008;

        // Advance the traveling-compression phase. Rate scales with
        // current freqScale — when voice is compressing the wave,
        // the compression zones sweep faster. Log2 scaling keeps the
        // multiplier reasonable across the wide freqScale range
        // (1..~14): at rest ~1.0×, at mid-voice ~1.7×, at peak ~2.9×.
        const freqSpeedMult = 1.0 + Math.max(0, Math.log2(Math.max(1, this.freqScale))) * 0.55;
        this.compressFlowPhase += 0.008 * this.config.compressFlowSpeed * freqSpeedMult;

        this.ctx.globalAlpha = this.opacity;

        // Pull live anchor position each frame — includes the idle bob
        // AND any in-flight drag/throw. This replaces the old
        // hardcoded cos bob formula, which was tuned for a SIZE=90
        // anchor and drifted out of sync when SIZE changed. The
        // provider is the single source of truth now.
        let bobY = 0;
        const livePos = this.anchorPosProvider?.() ?? null;
        if (livePos) {
          const liveX = livePos.x * this.dpr;
          const liveY = livePos.y * this.dpr;
          const newLeft = liveX - this.waveWidth / 2;
          // Rebuild gradient when horizontal position changes — the
          // fade stops are absolute-x-positioned and would otherwise
          // stay pinned to the original waveLeft, leaving a visible
          // hard edge when the wave tracks a dragged anchor.
          if (Math.abs(newLeft - this.waveLeft) > 0.5) {
            this.waveLeft = newLeft;
            this.buildGradient();
          }
          bobY = liveY - this.yAxis;
        }

        for (const wave of this.config.waves) {
          this.drawWave(this.time * wave.timeModifier, wave, bobY);
        }

        this.ctx.globalAlpha = 1;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  updateConfig(partial: Partial<WaveCarrierConfig>) {
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
