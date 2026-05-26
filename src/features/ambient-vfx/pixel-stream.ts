/**
 * Pixel Stream — tiny dedicated effect that escorts the STT transcript
 * from the voice anchor to the paste site. Renders uniform 2×2 square
 * pixels (integer-snapped, no anti-aliasing) so the stream reads as a
 * shower of crisp dots rather than the soft triangles used elsewhere.
 *
 * Self-contained: own canvas, own pool, own rAF loop. The loop only
 * runs while particles are alive, so there's no idle frame cost.
 */
export class PixelStream {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private running = false;
  private aliveCount = 0;

  // Ring-buffer pool. Fixed size keeps per-spawn cost O(1).
  private readonly MAX = 400;
  private x = new Float32Array(this.MAX);
  private y = new Float32Array(this.MAX);
  private vx = new Float32Array(this.MAX);
  private vy = new Float32Array(this.MAX);
  private tx = new Float32Array(this.MAX);
  private ty = new Float32Array(this.MAX);
  // Frames since spawn; used to drive fade-out near end of life.
  private age = new Float32Array(this.MAX);
  // Total frames the particle is allowed to live.
  private lifespan = new Float32Array(this.MAX);
  // Per-particle sinusoidal wander — phase (random seed) + amplitude
  // (how far they drift off the ballistic path as they age). Applied
  // perpendicular to the stream direction so the cloud diffuses across
  // the paste region rather than orbiting any single point.
  private wanderPhase = new Float32Array(this.MAX);
  private wanderAmp = new Float32Array(this.MAX);
  private perpX = new Float32Array(this.MAX);
  private perpY = new Float32Array(this.MAX);
  private alive = new Uint8Array(this.MAX);
  private head = 0;

  // Pending spawn timers so we can cancel a stream mid-flight if needed.
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;" +
      "pointer-events:none;z-index:99997;";
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("pixel-stream: 2d context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.resize();
    window.addEventListener("resize", this.resize);
  }

  private resize = () => {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.ctx.imageSmoothingEnabled = false;
  };

  /**
   * Stream `count` pixels from (sourceX, sourceY) toward (targetX, targetY)
   * over `staggerMs`. Coordinates are window-local CSS pixels; the DPR
   * conversion happens here so callers don't have to think about it.
   */
  streamToPoint(
    sourceX: number,
    sourceY: number,
    targetX: number,
    targetY: number,
    count: number = 60,
    staggerMs: number = 300,
  ) {
    const dpr = window.devicePixelRatio || 1;
    const fromX = sourceX * dpr;
    const fromY = sourceY * dpr;
    const toX = targetX * dpr;
    const toY = targetY * dpr;

    const dx = toX - fromX;
    const dy = toY - fromY;
    const travelAngle = Math.atan2(dy, dx);
    const perpX = Math.cos(travelAngle + Math.PI / 2);
    const perpY = Math.sin(travelAngle + Math.PI / 2);

    // Direction-aligned unit vector — used to spread targets along the
    // motion axis as well as across it, so the landing zone is a box
    // rather than a line.
    const alongX = Math.cos(travelAngle);
    const alongY = Math.sin(travelAngle);

    for (let i = 0; i < count; i++) {
      const delay = count > 1 ? (i / (count - 1)) * staggerMs : 0;
      const timer = setTimeout(() => {
        this.pendingTimers = this.pendingTimers.filter((t) => t !== timer);

        const spawnPerp = (Math.random() - 0.5) * 30 * dpr;
        const sx = fromX + perpX * spawnPerp;
        const sy = fromY + perpY * spawnPerp;

        // Each particle picks its own landing zone inside a wide box
        // around the paste site. The box is larger perpendicular to
        // motion (≈300 px total) than along it (≈150 px) so the cloud
        // reads as a horizontal drift rather than a point convergence.
        const targetPerp = (Math.random() - 0.5) * 300 * dpr;
        const targetAlong = (Math.random() - 0.5) * 150 * dpr;
        const tx = toX + perpX * targetPerp + alongX * targetAlong;
        const ty = toY + perpY * targetPerp + alongY * targetAlong;

        const angle = Math.atan2(ty - sy, tx - sx);
        const speed = (4 + Math.random() * 2) * dpr;

        // Per-particle wander seed + amplitude — each particle drifts a
        // little off its ballistic path as it ages, so the cloud reads
        // as diffusing rather than laser-tracking.
        const wanderPhase = Math.random() * Math.PI * 2;
        const wanderAmp = (0.4 + Math.random() * 0.6) * dpr;

        this.spawn(
          sx, sy,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          tx, ty,
          60 + Math.floor(Math.random() * 30), // lifespan frames (~1.0–1.5 s)
          wanderPhase,
          wanderAmp,
          perpX, perpY,
        );
      }, delay);
      this.pendingTimers.push(timer);
    }
  }

  private spawn(
    x: number, y: number,
    vx: number, vy: number,
    tx: number, ty: number,
    lifespan: number,
    wanderPhase: number,
    wanderAmp: number,
    perpX: number, perpY: number,
  ) {
    const i = this.head % this.MAX;
    this.head++;
    if (!this.alive[i]) this.aliveCount++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.tx[i] = tx;
    this.ty[i] = ty;
    this.age[i] = 0;
    this.lifespan[i] = lifespan;
    this.wanderPhase[i] = wanderPhase;
    this.wanderAmp[i] = wanderAmp;
    this.perpX[i] = perpX;
    this.perpY[i] = perpY;
    this.alive[i] = 1;
    if (!this.running) this.start();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  private loop = () => {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let i = 0; i < this.MAX; i++) {
      if (!this.alive[i]) continue;

      const life = this.age[i] / this.lifespan[i];

      // Soft target attraction — weaker than before so particles don't
      // funnel into a single point, and it decays as they approach the
      // end of life so they drift past their target rather than stall
      // on it.
      const attraction = 0.0015 * (1 - life * 0.7);
      const dxT = this.tx[i] - this.x[i];
      const dyT = this.ty[i] - this.y[i];
      this.vx[i] += dxT * attraction;
      this.vy[i] += dyT * attraction;

      // Perpendicular wander — sinusoidal drift across the stream
      // direction that ramps up with age. Early in life particles track
      // their target; late in life they scatter sideways so the cloud
      // diffuses across the paste region.
      const wanderMag = this.wanderAmp[i] * life * life;
      const wanderOsc = Math.sin(this.age[i] * 0.15 + this.wanderPhase[i]);
      this.vx[i] += this.perpX[i] * wanderOsc * wanderMag;
      this.vy[i] += this.perpY[i] * wanderOsc * wanderMag;

      this.vx[i] *= 0.96;
      this.vy[i] *= 0.96;
      this.x[i] += this.vx[i];
      this.y[i] += this.vy[i];
      this.age[i] += 1;

      if (life >= 1) {
        this.alive[i] = 0;
        this.aliveCount--;
        continue;
      }

      // Alpha: full for first 50%, linear fade to 0 over remaining 50%
      // so the diffusion is visible during the fade-out.
      const alpha = life < 0.5 ? 1 : 1 - (life - 0.5) / 0.5;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(
        Math.round(this.x[i]),
        Math.round(this.y[i]),
        2, 2,
      );
    }
    ctx.globalAlpha = 1;

    if (this.aliveCount > 0 || this.pendingTimers.length > 0) {
      requestAnimationFrame(this.loop);
    } else {
      this.running = false;
    }
  };

  /** Cancel any pending staggered spawns AND clear any live particles
   *  mid-flight. Called when a new STT session starts so a rapid
   *  release-then-press doesn't overlap the previous stream's tail with
   *  the new session's UI.
   *
   *  Safe to call when idle — no-op if nothing is in flight.
   */
  cancel() {
    for (const t of this.pendingTimers) clearTimeout(t);
    this.pendingTimers = [];
    // Kill live particles by zeroing their alive flags. The loop exits
    // itself next frame once aliveCount drops and no timers are pending.
    for (let i = 0; i < this.MAX; i++) {
      if (this.alive[i]) {
        this.alive[i] = 0;
        this.aliveCount--;
      }
    }
  }

  destroy() {
    this.cancel();
    this.running = false;
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
  }
}
