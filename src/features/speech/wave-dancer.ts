import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";
import { createNoise2D } from "simplex-noise";

interface WaveConfig {
  amplitude: number;
  wavelength: number;
  lineWidth: number;
  timeModifier: number;
  segmentLength: number;
}

export interface WaveDancerConfig {
  enabled: boolean;
  speed: number;
  waves: WaveConfig[];
  color: string;    // base color for gradient
  yRatio: number;   // vertical position 0-1
  // ── D: noise perturbation ────────────────────────────────────────
  // 0 = pure sine (identical to sine-waves). 1 = visibly noisy.
  // Sweet spot 0.3-0.5 — the wave looks "breathed" rather than
  // machined. Applied as both phase jitter (off-centers peaks) and
  // amplitude jitter (varies peak heights per cycle).
  noiseStrength: number;
  noiseSpatialScale: number;   // how much neighboring points correlate
  noiseTemporalScale: number;  // how fast the irregularities evolve
  // ── F: particle stream ───────────────────────────────────────────
  // Particles ride along the sine curve flowing rightward. Count
  // controls density; size scales with amplitude so loud syllables
  // throw off bigger glints.
  particleCount: number;
  particleSize: number;
}

export const defaultWaveDancerConfig: WaveDancerConfig = {
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
    { amplitude:  110, wavelength:  80, lineWidth: 2.5, timeModifier: 1.4, segmentLength: 10 }, // main
    { amplitude: -110, wavelength:  40, lineWidth: 1.5, timeModifier: 2.4, segmentLength: 8  }, // tight top
  ],
  // Higher noise strength than before — more per-cycle variety in
  // peak height and phase, so adjacent cycles of the same wave don't
  // look identical. Reads as "alive."
  noiseStrength: 0.6,
  noiseSpatialScale: 0.02,
  noiseTemporalScale: 0.8,
  // Particles turned off by default — the sine + noise alone is
  // enough visually, and the particles cluttered the composition.
  // Kept configurable for easy re-enable.
  particleCount: 0,
  particleSize: 2.2,
};

const PI2 = Math.PI * 2;
const HALFPI = Math.PI / 2;

export class WaveDancer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: WaveDancerConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
  // Noise field for D — 2D simplex so neighboring samples in both
  // space and time vary smoothly (no hard jitter). Sampled per point
  // in drawWave to perturb phase + amplitude.
  private noise = createNoise2D();
  // Particle state for F — each particle flows rightward along the
  // current sine curve. xFrac is its position in the wave patch [0..1].
  // When xFrac > 1 it wraps and respawns at a new seedY/phase.
  private particleX = new Float32Array(0);     // sized on init from config.particleCount
  private particlePhase = new Float32Array(0); // per-particle spatial offset for y sampling
  private particleSpeed = new Float32Array(0); // per-particle speed multiplier 0.7..1.3
  private particleLife = new Float32Array(0);  // remaining life 0..1
  private particlesInitialized = false;
  private time = 0;
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

  constructor(container: HTMLElement, config?: Partial<WaveDancerConfig>) {
    this.config = { ...defaultWaveDancerConfig, ...config };
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
    ctx.moveTo(0, this.yAxis + bobY);
    ctx.lineTo(this.waveLeft, this.yAxis + bobY);

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
    // D: noise perturbation params pulled from config so they can be
    // tuned per session without touching drawWave internals.
    const nStr = this.config.noiseStrength;
    const nSpace = this.config.noiseSpatialScale;
    const nTime = this.config.noiseTemporalScale;
    for (let i = 0; i < this.waveWidth; i += segmentLength) {
      // D: sample 2D simplex noise for phase + amplitude jitter. The
      // spatial axis gives the wave local irregularity; the time axis
      // makes those irregularities evolve instead of freezing a
      // fixed "noisy sine" shape. Both scaled by noiseStrength so the
      // whole effect cleanly disables at 0.
      const noisePhase = this.noise(i * nSpace, time * nTime) * 0.45 * nStr;
      const noiseAmp = 1 + this.noise(i * nSpace * 0.7, time * nTime * 0.6) * 0.25 * nStr;
      // Direction-invariant preserved: Math.abs on speed, leading
      // minus on the temporal term, monotonic this.time.
      const x = -(time * positiveSpeed) + (i - midI) * freq / wavelength + noisePhase;
      const y = Math.sin(x);
      const amp = this.ease(i / this.waveWidth, amplitude) * this.ampScale * noiseAmp;
      ctx.lineTo(i + this.waveLeft, amp * y + this.yAxis + bobY);
    }

    ctx.lineTo(this.width, this.yAxis + bobY);
    ctx.stroke();
  }

  /** F: initialise (or re-initialise) the particle pool. Called on
   *  first render so sizes respect the resolved config. */
  private initParticles() {
    const n = this.config.particleCount;
    this.particleX = new Float32Array(n);
    this.particlePhase = new Float32Array(n);
    this.particleSpeed = new Float32Array(n);
    this.particleLife = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.particleX[i] = Math.random();         // 0..1 across patch
      this.particlePhase[i] = Math.random() * Math.PI * 2;
      this.particleSpeed[i] = 0.7 + Math.random() * 0.6; // 0.7..1.3×
      this.particleLife[i] = Math.random();
    }
    this.particlesInitialized = true;
  }

  /** F: advance and draw particles riding along the primary wave.
   *  Each particle flows rightward; its y is sampled from the primary
   *  wave's sine curve at its current x, perturbed by its own phase
   *  offset so they're not all stacked on the same line. Size and
   *  brightness scale with the current ampScale (loud syllables
   *  throw bigger, brighter glints). */
  private drawParticles(bobY: number) {
    if (this.config.particleCount <= 0) return;
    if (!this.particlesInitialized) this.initParticles();
    const ctx = this.ctx;
    const cy = this.yAxis + bobY;
    const primary = this.config.waves[0];
    if (!primary) return;
    const amplitude = primary.amplitude * (this.waveWidth / (this.width * 0.7)) * 2;
    const positiveSpeed = Math.abs(this.config.speed);
    const freq = this.freqScale;
    const midI = this.waveWidth / 2;
    const time = (performance.now() * 0.001) * positiveSpeed * 0.5;

    // Size pulses with amplitude — loud voice throws fatter dots.
    const ampBoost = Math.max(0.3, Math.min(2.2, this.ampScale));
    const baseSize = this.config.particleSize * this.dpr * ampBoost;

    const travelPerFrame = positiveSpeed / this.waveWidth; // normalized
    for (let i = 0; i < this.particleX.length; i++) {
      this.particleX[i] += travelPerFrame * this.particleSpeed[i];
      if (this.particleX[i] > 1) {
        // Recycle at left edge with fresh phase.
        this.particleX[i] = 0;
        this.particlePhase[i] = Math.random() * Math.PI * 2;
        this.particleSpeed[i] = 0.7 + Math.random() * 0.6;
      }
      const xFrac = this.particleX[i];
      const px = this.waveLeft + xFrac * this.waveWidth;
      // Sample wave-ish y using the same phase math plus a per-particle
      // offset so particles cluster along the general wave shape but
      // don't all ride identical y's.
      const phaseX = -time + (xFrac * this.waveWidth - midI) * freq / primary.wavelength
                   + this.particlePhase[i] * 0.3;
      const amp = this.ease(xFrac, amplitude) * this.ampScale;
      const py = cy + amp * Math.sin(phaseX) * 0.85;

      // Fade near horizontal edges so they don't pop in/out hard.
      const edgeFade = Math.min(xFrac * 3, (1 - xFrac) * 3, 1);
      ctx.globalAlpha = this.opacity * edgeFade;
      ctx.fillStyle = this.config.color;
      ctx.beginPath();
      ctx.arc(px, py, baseSize, 0, Math.PI * 2);
      ctx.fill();
    }
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
        const freqTarget = 1.0 + shaped * 4.0;
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

        // F: particles ride along the primary wave. Advanced every
        // frame; fade is handled via globalAlpha inside drawParticles.
        this.drawParticles(bobY);

        this.ctx.globalAlpha = 1;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  updateConfig(partial: Partial<WaveDancerConfig>) {
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
