import { createNoise3D } from "simplex-noise";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ── Entity Pool — Square Pixels ──

interface Pixel {
  x: number; y: number;
  vx: number; vy: number;
  tx: number; ty: number;  // target
  size: number;
  alpha: number;
  alive: boolean;
  r: number; g: number; b: number;
  phase: "zoom-in" | "swirl" | "fade";
  life: number;
}

class PixelPool {
  private pool: Pixel[] = [];
  private nextIdx = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0,
        size: 2, alpha: 0, alive: false,
        r: 0, g: 0, b: 0,
        phase: "zoom-in", life: 0,
      });
    }
  }

  spawn(x: number, y: number, tx: number, ty: number, r: number, g: number, b: number, size: number): Pixel {
    const p = this.pool[this.nextIdx];
    this.nextIdx = (this.nextIdx + 1) % this.pool.length;
    p.x = x; p.y = y; p.tx = tx; p.ty = ty;
    p.vx = 0; p.vy = 0;
    p.size = size; p.alpha = 0.9; p.alive = true;
    p.r = r; p.g = g; p.b = b;
    p.phase = "zoom-in"; p.life = 0;
    return p;
  }

  getAll(): Pixel[] { return this.pool; }
}

// ── Flow Field (same as triangle particles) ──

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

// ── Color palette from the Three.js cosmic theme ──

function cosmicColor(dist: number): [number, number, number] {
  // Blend between deep purple → cyan → blue-green based on distance
  const t = Math.min(dist, 1);
  if (t < 0.33) {
    // Deep purple to violet
    const s = t / 0.33;
    return [
      Math.floor(120 + s * 80),   // r: 120→200
      Math.floor(50 + s * 30),    // g: 50→80
      Math.floor(255 - s * 30),   // b: 255→225
    ];
  } else if (t < 0.66) {
    // Violet to cyan
    const s = (t - 0.33) / 0.33;
    return [
      Math.floor(200 - s * 140),  // r: 200→60
      Math.floor(80 + s * 140),   // g: 80→220
      Math.floor(225 + s * 30),   // b: 225→255
    ];
  } else {
    // Cyan to blue-green
    const s = (t - 0.66) / 0.34;
    return [
      Math.floor(60 - s * 30),    // r: 60→30
      Math.floor(220 - s * 60),   // g: 220→160
      Math.floor(255 - s * 55),   // b: 255→200
    ];
  }
}

// ── Config ──

export interface PixelParticleConfig {
  enabled: boolean;
  poolSize: number;
  burstCount: number;
  pixelSize: number; // base size in px
}

export const defaultPixelConfig: PixelParticleConfig = {
  enabled: true,
  poolSize: 5000,
  burstCount: 2000,
  pixelSize: 3,
};

// ── Main Effect ──

export class PixelParticles {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pool: PixelPool;
  private field: FlowField;
  private config: PixelParticleConfig;
  private unlisteners: UnlistenFn[] = [];
  private running = false;
  private startTime = 0;
  private cx = 0;
  private cy = 0;
  private active = false;

  constructor(container: HTMLElement, config?: Partial<PixelParticleConfig>) {
    this.config = { ...defaultPixelConfig, ...config };

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99997;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", () => this.resize());

    this.pool = new PixelPool(this.config.poolSize);
    this.field = new FlowField();
    this.field.resize(this.canvas.width, this.canvas.height);
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.field?.resize(this.canvas.width, this.canvas.height);
  }

  async init() {
    // Burst on speech open
    this.unlisteners.push(
      await listen<{ mouseX: number; mouseY: number }>("tts-open", (e) => {
        if (!this.config.enabled) return;
        this.cx = this.canvas.width * 0.5;
        this.cy = e.payload.mouseY > 0 ? e.payload.mouseY : this.canvas.height * 0.5;
        this.active = true;
        this.burstFromEdges(this.config.burstCount);
      })
    );

    // Burst on start sound
    this.unlisteners.push(
      await listen("play-start-sound", () => {
        if (!this.config.enabled) return;
        this.cx = this.canvas.width * 0.5;
        this.cy = this.canvas.height * 0.5;
        this.active = true;
        this.burstFromEdges(this.config.burstCount);
      })
    );

    // Burst on external trigger
    this.unlisteners.push(
      await listen<{ x: number; y: number; count: number }>("particles-burst", (e) => {
        if (!this.config.enabled) return;
        this.cx = e.payload.x || this.canvas.width * 0.5;
        this.cy = e.payload.y || this.canvas.height * 0.5;
        this.active = true;
        this.burstFromEdges(e.payload.count || this.config.burstCount);
        setTimeout(() => { this.active = false; }, 4000);
      })
    );

    // Fade on speech end
    this.unlisteners.push(
      await listen("tts-done", () => { this.active = false; })
    );

    this.start();
  }

  burstFromEdges(count: number) {
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let i = 0; i < count; i++) {
      // Random edge position
      let sx: number, sy: number;
      const edge = Math.floor(Math.random() * 4);
      const margin = 80;
      switch (edge) {
        case 0: sx = Math.random() * w; sy = -margin; break;
        case 1: sx = Math.random() * w; sy = h + margin; break;
        case 2: sx = -margin; sy = Math.random() * h; break;
        default: sx = w + margin; sy = Math.random() * h; break;
      }

      // Color based on distance from center (0→1)
      const distNorm = Math.random();
      const [r, g, b] = cosmicColor(distNorm);

      // Vary pixel sizes: mostly small, some larger
      const sizeRoll = Math.random();
      let size = this.config.pixelSize;
      if (sizeRoll > 0.95) size = 5 + Math.random() * 4;      // 5% large
      else if (sizeRoll > 0.8) size = 3 + Math.random() * 2;  // 15% medium
      else size = 1 + Math.random() * 2;                       // 80% small

      this.pool.spawn(
        sx, sy,
        this.cx + (Math.random() - 0.5) * 300,
        this.cy + (Math.random() - 0.5) * 200,
        r, g, b, size
      );
    }
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
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

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
            p.vx += dx * 0.002;
            p.vy += dy * 0.002;
          }
        }

        if (p.phase === "swirl") {
          // Flow field force
          const force = this.field.getForce(p.x, p.y);
          if (force) { p.vx += force.x; p.vy += force.y; }

          // Weak attraction to center
          if (this.active) {
            const dx = this.cx - p.x;
            const dy = this.cy - p.y;
            p.vx += dx * 0.0003;
            p.vy += dy * 0.0003;
          }

          if (p.life > 0.7) p.phase = "fade";
        }

        if (p.phase === "fade") p.alpha -= 0.015;
        else if (!this.active) p.alpha -= 0.005;
        else p.alpha -= 0.002;

        if (p.alpha <= 0) { p.alive = false; continue; }

        // Damping + velocity
        p.vx *= 0.98;
        p.vy *= 0.98;
        p.x += p.vx;
        p.y += p.vy;

        // Draw square pixel
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
        ctx.fillRect(
          Math.round(p.x - p.size * 0.5),
          Math.round(p.y - p.size * 0.5),
          p.size, p.size
        );
      }

      ctx.globalAlpha = 1;
      requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
  }

  updateConfig(partial: Partial<PixelParticleConfig>) {
    Object.assign(this.config, partial);
  }

  destroy() {
    this.running = false;
    for (const u of this.unlisteners) u();
    this.canvas.remove();
  }
}
