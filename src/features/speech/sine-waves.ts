import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import gsap from "gsap";
import { emit as emitParticle } from "../ambient-vfx/particles";

interface WaveConfig {
  amplitude: number;
  wavelength: number;
  lineWidth: number;
  timeModifier: number;
  segmentLength: number;
  // Optional per-layer opacity multiplier (0..1). Combined with the
  // global `opacity` from tts-open/done tweens via globalAlpha. Lets
  // individual layers recede visually without affecting the others.
  alpha?: number;
  // Optional per-layer stroke color. Falls back to config.color. Used
  // so the tight (high-frequency) top wave can stroke in a whiter
  // hue while slower layers stroke in a pinker hue — the glow color
  // (ctx.shadowColor) stays pink-purple regardless.
  strokeColor?: string;
}

export interface SineWaveConfig {
  enabled: boolean;
  speed: number;
  waves: WaveConfig[];
  color: string;    // base color for gradient
  yRatio: number;   // vertical position 0-1
}

export const defaultSineConfig: SineWaveConfig = {
  enabled: true,
  // Base horizontal travel speed. Constant during speech — no longer
  // modulated by voice. Voice reactivity goes through `freqScale` and
  // `ampScale` instead, so the wave always flows rightward at the
  // same pace while compressing/expanding based on vocal energy.
  speed: 12,
  // Pink-purple palette — warmer than the old cool lavender, with
  // enough magenta in it to read as a vocal feedback glow.
  color: "rgba(235, 150, 255, 0.95)",
  yRatio: 0.5,
  // Three layered waves at 1× / 1.8× / 3× time modifiers. The original
  // look — a slow wide carrier, a middle harmonic, and a tight top
  // that flickers on emphasis. Restored after a long detour through
  // alternate variants (wave-watcher / ribbon / dancer / shaper /
  // carrier, all parked alongside).
  waves: [
    // Per-layer stroke colors: pink-purple on the slow carrier (reads
    // as the mood base), softer pink in the middle, nearly white on
    // the tight top (reads as crisp, detailed line work). The shadow
    // glow color stays pink-purple across all layers — that's what
    // gives the wave its halo.
    // Slow carrier — 25 % opacity pink-purple background wash.
    {
      amplitude: 100, wavelength: 200, lineWidth: 4.5,
      timeModifier: 1, segmentLength: 20,
      alpha: 0.25, strokeColor: "rgba(230, 170, 255, 0.95)",
    },
    // Middle harmonic — half opacity, soft pink.
    {
      amplitude: 100, wavelength: 100, lineWidth: 3.2,
      timeModifier: 1.8, segmentLength: 10,
      alpha: 0.5, strokeColor: "rgba(250, 210, 255, 0.95)",
    },
    // Tight top — nearly white, pink tint. Full opacity so the
    // crispness reads clearly against the darker-pink lower layers.
    {
      amplitude: -100, wavelength: 50, lineWidth: 2.4,
      timeModifier: 3, segmentLength: 10,
      strokeColor: "rgba(255, 240, 252, 0.98)",
    },
  ],
};

const PI2 = Math.PI * 2;
const HALFPI = Math.PI / 2;

export class SineWaves {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: SineWaveConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
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

  constructor(container: HTMLElement, config?: Partial<SineWaveConfig>) {
    this.config = { ...defaultSineConfig, ...config };
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
    // Stroke color can be overridden per-wave. If overridden we build
    // a fresh horizontal gradient (same fade-shape as the shared
    // gradient) using the layer's color. Otherwise fall back to the
    // cached shared gradient.
    if (wave.strokeColor) {
      const g = this.ctx.createLinearGradient(
        this.waveLeft, 0, this.waveLeft + this.waveWidth, 0,
      );
      g.addColorStop(0, "rgba(0, 0, 0, 0)");
      g.addColorStop(0.2, "rgba(0, 0, 0, 0)");
      g.addColorStop(0.4, wave.strokeColor);
      g.addColorStop(0.5, wave.strokeColor);
      g.addColorStop(0.6, wave.strokeColor);
      g.addColorStop(0.8, "rgba(0, 0, 0, 0)");
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.strokeStyle = g;
    } else {
      ctx.strokeStyle = this.gradient!;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Pink-purple glow around each stroke — always uses config.color
    // regardless of per-wave stroke hue, so all layers cast a
    // unified halo.
    ctx.shadowBlur = 14 * this.dpr;
    ctx.shadowColor = this.config.color;
    // Per-wave alpha multiplier. Apply on top of the render loop's
    // globalAlpha (which already carries the fade-in/out opacity)
    // and restore after stroking so later layers get their own scale.
    const priorAlpha = ctx.globalAlpha;
    const layerAlpha = wave.alpha ?? 1;
    ctx.globalAlpha = priorAlpha * layerAlpha;
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
    for (let i = 0; i < this.waveWidth; i += segmentLength) {
      // Direction-invariant preserved: Math.abs on speed, leading
      // minus on the temporal term, monotonic this.time.
      const x = -(time * positiveSpeed) + (i - midI) * freq / wavelength;
      const y = Math.sin(x);
      const amp = this.ease(i / this.waveWidth, amplitude) * this.ampScale;
      ctx.lineTo(i + this.waveLeft, amp * y + this.yAxis + bobY);
    }

    ctx.lineTo(this.width, this.yAxis + bobY);
    ctx.stroke();
    ctx.globalAlpha = priorAlpha;
    // Reset shadow so downstream draws (e.g. other features sharing
    // the context in future) aren't polluted.
    ctx.shadowBlur = 0;
  }

  /** Emit a handful of pixel particles per frame along a straight
   *  horizontal line through the center of the wave patch (not
   *  riding the sine curves). They go into the shared ambient-vfx
   *  pool, which the creature's Pixi renderer draws as single-pixel
   *  points — so they show up as a sparkly stream flowing along the
   *  wave's baseline. Count scales with ampScale so louder moments
   *  throw more sparks. Coordinates are SCREEN pixels. */
  private emitParticlesAlongWave(bobYScreen: number) {
    if (this.targetOpacity < 0.5) return;
    // Probabilistic emission — chance per frame scales with ampScale.
    // At ampScale≈1 (idle speech) we spawn ~12 % of frames; at peak
    // amp we spawn every couple of frames. No busy stream of sparks.
    const spawnChance = 0.06 * this.ampScale;
    if (Math.random() > spawnChance) return;
    const count = 1;
    const patchLeftScreen = this.waveLeft / this.dpr;
    const patchWidthScreen = this.waveWidth / this.dpr;
    const centerYScreen = this.yAxis / this.dpr + bobYScreen;

    for (let k = 0; k < count; k++) {
      // Random position in the bright center 60 % of the patch.
      const u = 0.2 + Math.random() * 0.6;
      const px = patchLeftScreen + u * patchWidthScreen;
      // Tiny vertical jitter so the particles form a soft band rather
      // than a razor-thin line.
      const py = centerYScreen + (Math.random() - 0.5) * 2;
      // Velocity — drift rightward at wave speed, minimal vertical.
      const vx = 0.6 + Math.random() * 0.4;
      const vy = (Math.random() - 0.5) * 0.15;
      emitParticle(px, py, vx, vy);
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
        // Two shaping curves — one for freq, one for amp. Freq keeps
        // the gentle expansive curve so mid-range voice still reacts
        // clearly. Amp uses a compressive curve (exponent > 1) so
        // low-to-mid levels stay SMALL, and only true peaks pump the
        // wave tall. Gives "quiet most of the time, big on emphasis."
        const shapedFreq = Math.pow(level, 0.7);
        const shapedAmp = Math.pow(level, 2.5);

        // Frequency — primary modulation. 1.0 baseline → 3.4 on peaks.
        const freqTarget = 1.0 + shapedFreq * 2.4;
        gsap.killTweensOf(this, "freqScale");
        gsap.to(this, { freqScale: freqTarget, duration: 0.45, ease: "sine.inOut" });

        // Amplitude — compressed curve with wide headroom and a very
        // low floor so silent gaps between words collapse the wave
        // nearly flat. Asymmetric tween: fast decay (170 ms) so
        // inter-word pauses show as clean drop-offs, slower rise
        // (400 ms) so syllable onsets flow in smoothly without
        // feeling snappy.
        const ampTarget = 0.05 + shapedAmp * 4.9;
        const isDrop = ampTarget < this.ampScale;
        gsap.killTweensOf(this, "ampScale");
        gsap.to(this, {
          ampScale: ampTarget,
          duration: isDrop ? 0.17 : 0.4,
          ease: "sine.inOut",
        });
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

        // Emit a few pixel particles along the primary (tight) wave
        // each frame into the shared ambient-vfx pool. The creature's
        // renderer iterates the same pool and draws them as single
        // pixels, so they appear as sparkly glints flowing along the
        // wave shape. Sampled at the live anchor-centered coords
        // (screen pixels, not canvas pixels) because that's what the
        // creature renderer expects.
        this.emitParticlesAlongWave(bobY / this.dpr);

        this.ctx.globalAlpha = 1;
      }

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  updateConfig(partial: Partial<SineWaveConfig>) {
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
