import { createNoise3D } from "simplex-noise";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Entity Pool ──

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  ax: number; ay: number;
  // Target to attract toward (speech bubble center)
  tx: number; ty: number;
  alpha: number;
  alive: boolean;
  hue: number;
  size: number;
  phase: "zoom-in" | "swirl" | "fade-out";
  life: number; // 0→1 progress
  p0x: number; p0y: number;
  p1x: number; p1y: number;
  p2x: number; p2y: number;
}

class ParticlePool {
  private pool: Particle[] = [];
  private nextIdx = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
        tx: 0, ty: 0,
        alpha: 0, alive: false, hue: 0, size: 1,
        phase: "zoom-in", life: 0,
        p0x: -6 + Math.random() * 12, p0y: -6 + Math.random() * 12,
        p1x: -6 + Math.random() * 12, p1y: -6 + Math.random() * 12,
        p2x: -6 + Math.random() * 12, p2y: -6 + Math.random() * 12,
      });
    }
  }

  spawn(x: number, y: number, tx: number, ty: number, vx: number, vy: number, hue: number, size: number): Particle {
    const p = this.pool[this.nextIdx];
    this.nextIdx = (this.nextIdx + 1) % this.pool.length;
    p.x = x; p.y = y; p.tx = tx; p.ty = ty;
    p.vx = vx; p.vy = vy; p.ax = 0; p.ay = 0;
    p.alpha = 0.8; p.alive = true; p.hue = hue; p.size = size;
    p.phase = "zoom-in"; p.life = 0;
    return p;
  }

  getAll(): Particle[] { return this.pool; }
}

// ── Flow Field ──

const CELL_SIZE = 20;

class FlowField {
  private noise3D = createNoise3D();
  private cols = 0;
  private rows = 0;
  private forces: { x: number; y: number }[] = [];

  resize(w: number, h: number) {
    this.cols = Math.ceil(w / CELL_SIZE);
    this.rows = Math.ceil(h / CELL_SIZE);
    while (this.forces.length < this.cols * this.rows) this.forces.push({ x: 0, y: 0 });
  }

  update(t: number) {
    let i = 0, xOff = 0;
    for (let x = 0; x < this.cols; x++) {
      xOff += 0.1;
      let yOff = 0;
      for (let y = 0; y < this.rows; y++) {
        yOff += 0.1;
        const a = this.noise3D(xOff, yOff, t * 0.00005) * Math.PI * 4;
        if (this.forces[i]) { this.forces[i].x = Math.cos(a) * 0.08; this.forces[i].y = Math.sin(a) * 0.08; }
        i++;
      }
    }
  }

  getForce(px: number, py: number): { x: number; y: number } | null {
    const col = Math.floor(px / CELL_SIZE);
    const row = Math.floor(py / CELL_SIZE);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
    return this.forces[col * this.rows + row] ?? null;
  }
}

// ── Config ──

export interface FlowParticleConfig {
  enabled: boolean;
  poolSize: number;
  particlesPerWord: number;
  burstOnOpen: number;
  hue: number;
  hueRange: number;
}

export const defaultFlowConfig: FlowParticleConfig = {
  enabled: true,
  poolSize: 1000,
  particlesPerWord: 4,
  burstOnOpen: 200,
  hue: 270,
  hueRange: 40,
};

// ── Main Effect ──

export class FlowParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pool: ParticlePool;
  private field: FlowField;
  private config: FlowParticleConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
  private startTime = 0;
  // Current speech bubble center
  private bubbleCx = 0;
  private bubbleCy = 0;
  private active = false; // true while speech is happening

  constructor(container: HTMLElement, config?: Partial<FlowParticleConfig>) {
    this.config = { ...defaultFlowConfig, ...config };

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99998;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    this.pool = new ParticlePool(this.config.poolSize);
    this.field = new FlowField();
    this.field.resize(this.canvas.width, this.canvas.height);
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.field?.resize(this.canvas.width, this.canvas.height);
  }

  async init() {
    // Only the explicit burstToAnchor calls from App.tsx produce particles now.
    // tts-done still clears the "active" flag so any in-flight particles fade
    // naturally — but no wide spawns on tts-open/tts-sentence/particles-burst.
    this.unlisteners.push(
      await listen("tts-done", () => {
        this.active = false;
      })
    );

    this.start();
  }

  /** Public: spawn a tight circular convergence onto a target position.
   *  Spawns from off-screen at all four edges, all particles target the
   *  same small circle around the anchor (no wide ellipse spread). */
  public burstToAnchor(targetX: number, targetY: number, count: number = 15) {
    const dpr = window.devicePixelRatio || 1;
    const tx = targetX * dpr;
    const ty = targetY * dpr;
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let i = 0; i < count; i++) {
      let sx: number, sy: number;
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0: sx = Math.random() * w; sy = -50; break;
        case 1: sx = Math.random() * w; sy = h + 50; break;
        case 2: sx = -50; sy = Math.random() * h; break;
        default: sx = w + 50; sy = Math.random() * h; break;
      }

      // Tight circular target around the anchor — ±15px only, not a wide ellipse.
      const ta = Math.random() * Math.PI * 2;
      const tr = Math.random() * 15 * dpr;
      const px = tx + Math.cos(ta) * tr;
      const py = ty + Math.sin(ta) * tr;

      const angle = Math.atan2(py - sy, px - sx);
      const speed = 3 + Math.random() * 4;
      const hue = this.config.hue + (Math.random() - 0.5) * this.config.hueRange;
      const size = 0.8 + Math.random() * 2.0;

      this.pool.spawn(sx, sy, px, py,
        Math.cos(angle) * speed, Math.sin(angle) * speed, hue, size);
    }
  }

  /** Legacy wide-ellipse burst (kept for callers that still want it). */
  public burstToward(targetX: number, targetY: number, count: number = 60) {
    const dpr = window.devicePixelRatio || 1;
    this.bubbleCx = targetX * dpr;
    this.bubbleCy = targetY * dpr;
    this.spawnFromEdges(count);
  }

  /** Spawn particles from random edge positions, targeting bubble center. */
  private spawnFromEdges(count: number) {
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let i = 0; i < count; i++) {
      // Pick a random edge
      let sx: number, sy: number;
      const edge = Math.floor(Math.random() * 4);
      switch (edge) {
        case 0: sx = Math.random() * w; sy = -50; break;        // top
        case 1: sx = Math.random() * w; sy = h + 50; break;     // bottom
        case 2: sx = -50; sy = Math.random() * h; break;        // left
        default: sx = w + 50; sy = Math.random() * h; break;    // right
      }

      // Velocity toward bubble center with spread
      const angle = Math.atan2(this.bubbleCy - sy, this.bubbleCx - sx);
      const speed = 3 + Math.random() * 5;
      const spread = (Math.random() - 0.5) * 0.8;

      const hue = this.config.hue + (Math.random() - 0.5) * this.config.hueRange;
      const size = 0.8 + Math.random() * 2.4;

      // Wide horizontal spread, tight vertical — match speech bubble shape
      this.pool.spawn(
        sx, sy,
        this.bubbleCx + (Math.random() - 0.5) * w * 0.4,
        this.bubbleCy + (Math.random() - 0.5) * 80,
        Math.cos(angle + spread) * speed,
        Math.sin(angle + spread) * speed,
        hue, size
      );
    }
  }

  /** Emit a burst at a specific position (for completion events etc). */
  burst(x: number, y: number, count: number = 30) {
    this.bubbleCx = x;
    this.bubbleCy = y;
    this.spawnFromEdges(count);
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();

    const loop = (now: number) => {
      if (!this.running) return;

      const t = now - this.startTime;
      this.field.update(t);

      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Update all particle physics first
      for (const p of this.pool.getAll()) {
        if (!p.alive) continue;

        p.life += 0.003;

        if (p.phase === "zoom-in") {
          const dx = p.tx - p.x;
          const dy = p.ty - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 60 || p.life > 0.3) {
            p.phase = "swirl";
            p.vx *= 0.3;
            p.vy *= 0.3;
          } else {
            p.ax += dx * 0.002;
            p.ay += dy * 0.002;
          }
        }

        if (p.phase === "swirl") {
          const force = this.field.getForce(p.x, p.y);
          if (force) { p.ax += force.x; p.ay += force.y; }
          if (this.active) {
            // Stronger vertical pull to keep in a horizontal band, weaker horizontal
            p.ax += (this.bubbleCx - p.x) * 0.0001;
            p.ay += (this.bubbleCy - p.y) * 0.0006;
          }
          if (p.life > 0.7) p.phase = "fade-out";
        }

        if (p.phase === "fade-out") p.alpha -= 0.015;
        else if (!this.active) p.alpha -= 0.005;
        else p.alpha -= 0.002;

        if (p.alpha <= 0) { p.alive = false; continue; }

        p.vx = p.vx * 0.98 + p.ax;
        p.vy = p.vy * 0.98 + p.ay;
        p.x += p.vx;
        p.y += p.vy;
        p.ax = 0; p.ay = 0;
      }

      // Pass 1: Draw density blobs (soft circles, behind everything)
      const baseHue = this.config.hue;
      ctx.globalCompositeOperation = "lighter";
      let i = 0;
      for (const p of this.pool.getAll()) {
        if (!p.alive) continue;
        i++;
        if (i % 4 !== 0) continue; // sample every 4th for performance

        const radius = 50 + p.size * 30;
        const a = p.alpha * 0.1;
        const hue = baseHue + (p.hue - baseHue) * 0.3;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
        grad.addColorStop(0, `hsla(${hue}, 60%, 50%, ${a})`);
        grad.addColorStop(0.5, `hsla(${hue}, 50%, 40%, ${a * 0.3})`);
        grad.addColorStop(1, `hsla(${hue}, 40%, 30%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // Pass 2: Draw triangles on top
      for (const p of this.pool.getAll()) {
        if (!p.alive) continue;

        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.moveTo(p.x + p.p0x * p.size, p.y + p.p0y * p.size);
        ctx.lineTo(p.x + p.p1x * p.size, p.y + p.p1y * p.size);
        ctx.lineTo(p.x + p.p2x * p.size, p.y + p.p2y * p.size);
        ctx.closePath();
        const l = 55 + Math.random() * 25;
        ctx.fillStyle = `hsl(${p.hue},50%,${l}%)`;
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }


  updateConfig(partial: Partial<FlowParticleConfig>) {
    Object.assign(this.config, partial);
  }

  destroy() {
    this.running = false;
    for (const u of this.unlisteners) u();
    this.canvas.remove();
  }
}
