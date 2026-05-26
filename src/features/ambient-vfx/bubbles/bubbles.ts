const { random } = Math;
const randIn = (min: number, max: number) => random() * (max - min) + min;

interface AtlasMeta {
  frames: number;
  cols: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}

interface BubbleInstance {
  x: number;
  y: number;
  scale: number;
  frame: number;
  atlas: number; // 0 or 1
  speed: number; // frames per tick
  accum: number; // fractional frame accumulator
  done: boolean;
}

export interface BubbleConfig {
  spawnInterval: number;
  maxBubbles: number;
  scaleMin: number;
  scaleMax: number;
  fps: number; // playback speed in frames per second
}

export const defaultBubbleConfig: BubbleConfig = {
  spawnInterval: 80,
  maxBubbles: 60,
  scaleMin: 0.4,
  scaleMax: 1.0,
  fps: 30,
};

export class BubbleEffect {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: BubbleConfig;
  private bubbles: BubbleInstance[] = [];
  private animId = 0;
  private spawnTimer = 0;
  private running = false;
  private atlasImages: HTMLImageElement[] = [];
  private atlasMeta: AtlasMeta[] = [];
  private loaded = false;
  private lastTime = 0;

  constructor(container: HTMLElement, config: BubbleConfig) {
    this.config = config;

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", this.resize);

    this.loadAtlases();
  }

  private async loadAtlases() {
    const paths = [
      { json: "/assets/vfx/vfx-popping_bubbles_07.json", png: "/assets/vfx/vfx-popping_bubbles_07.png" },
      { json: "/assets/vfx/vfx-popping_bubbles_08.json", png: "/assets/vfx/vfx-popping_bubbles_08.png" },
    ];

    for (const p of paths) {
      const res = await fetch(p.json);
      const meta: AtlasMeta = await res.json();
      this.atlasMeta.push(meta);

      const img = new Image();
      img.src = p.png;
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
      });
      this.atlasImages.push(img);
    }

    this.loaded = true;
  }

  private resize = () => {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  };

  private spawnBubble() {
    if (!this.loaded || this.bubbles.length >= this.config.maxBubbles) return;

    const atlas = Math.floor(random() * this.atlasMeta.length);
    const meta = this.atlasMeta[atlas];
    const scale = randIn(this.config.scaleMin, this.config.scaleMax);
    const w = meta.frameWidth * scale;
    const h = meta.frameHeight * scale;

    this.bubbles.push({
      x: randIn(w, this.canvas.width - w),
      y: randIn(h, this.canvas.height - h),
      scale,
      frame: 0,
      atlas,
      speed: this.config.fps / 60, // frames to advance per tick at 60fps
      accum: 0,
      done: false,
    });
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();

    this.spawnTimer = window.setInterval(() => {
      if (this.running) this.spawnBubble();
    }, this.config.spawnInterval);

    const loop = (now: number) => {
      if (!this.running) return;

      const dt = (now - this.lastTime) / 1000; // seconds
      this.lastTime = now;

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (!this.loaded) {
        this.animId = requestAnimationFrame(loop);
        return;
      }

      for (const b of this.bubbles) {
        const meta = this.atlasMeta[b.atlas];
        const img = this.atlasImages[b.atlas];

        // Advance frame based on configured fps
        b.accum += this.config.fps * dt;
        const framesToAdvance = Math.floor(b.accum);
        b.accum -= framesToAdvance;
        b.frame += framesToAdvance;

        if (b.frame >= meta.frames) {
          b.done = true;
          continue;
        }

        const col = b.frame % meta.cols;
        const row = Math.floor(b.frame / meta.cols);
        const sx = col * meta.frameWidth;
        const sy = row * meta.frameHeight;
        const dw = meta.frameWidth * b.scale;
        const dh = meta.frameHeight * b.scale;

        this.ctx.drawImage(
          img,
          sx, sy, meta.frameWidth, meta.frameHeight,
          b.x - dw / 2, b.y - dh / 2, dw, dh
        );
      }

      this.bubbles = this.bubbles.filter((b) => !b.done);
      this.animId = requestAnimationFrame(loop);
    };

    this.animId = requestAnimationFrame(loop);
  }

  /** Burst spawn N bubbles instantly scattered across screen. */
  burst(count: number = 20) {
    if (!this.loaded) return;
    for (let i = 0; i < count; i++) {
      const atlas = Math.floor(random() * this.atlasMeta.length);
      const meta = this.atlasMeta[atlas];
      const scale = randIn(this.config.scaleMin, this.config.scaleMax);
      const w = meta.frameWidth * scale;
      const h = meta.frameHeight * scale;

      this.bubbles.push({
        x: randIn(w, this.canvas.width - w),
        y: randIn(h, this.canvas.height - h),
        scale,
        frame: Math.floor(randIn(0, 5)), // stagger start frames so they don't all pop in sync
        atlas,
        speed: this.config.fps / 60,
        accum: 0,
        done: false,
      });
    }

    // Make sure the render loop is running
    if (!this.running) {
      this.running = true;
      this.lastTime = performance.now();
      const loop = (now: number) => {
        if (!this.running) return;
        const dt = (now - this.lastTime) / 1000;
        this.lastTime = now;
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (!this.loaded) { this.animId = requestAnimationFrame(loop); return; }
        for (const b of this.bubbles) {
          const meta = this.atlasMeta[b.atlas];
          const img = this.atlasImages[b.atlas];
          b.accum += this.config.fps * dt;
          const framesToAdvance = Math.floor(b.accum);
          b.accum -= framesToAdvance;
          b.frame += framesToAdvance;
          if (b.frame >= meta.frames) { b.done = true; continue; }
          const col = b.frame % meta.cols;
          const row = Math.floor(b.frame / meta.cols);
          const sx = col * meta.frameWidth;
          const sy = row * meta.frameHeight;
          const dw = meta.frameWidth * b.scale;
          const dh = meta.frameHeight * b.scale;
          this.ctx.drawImage(img, sx, sy, meta.frameWidth, meta.frameHeight, b.x - dw / 2, b.y - dh / 2, dw, dh);
        }
        this.bubbles = this.bubbles.filter((b) => !b.done);
        if (this.bubbles.length === 0) { this.running = false; return; }
        this.animId = requestAnimationFrame(loop);
      };
      this.animId = requestAnimationFrame(loop);
    }
  }

  // Stop spawning but let existing bubbles finish
  stopSpawning() {
    clearInterval(this.spawnTimer);
    this.spawnTimer = 0;
  }

  // Hard stop — clears everything immediately
  stop() {
    this.running = false;
    clearInterval(this.spawnTimer);
    cancelAnimationFrame(this.animId);
    this.bubbles = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
  }
}
