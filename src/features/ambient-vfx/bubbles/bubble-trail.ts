const { random } = Math;
const randIn = (min: number, max: number) => random() * (max - min) + min;

interface AtlasMeta {
  frames: number;
  cols: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
}

interface TrailBubble {
  x: number;
  y: number;
  scale: number;
  frame: number;
  atlas: number;
  accum: number;
  done: boolean;
}

export interface BubbleTrailConfig {
  spawnDistance: number; // min pixels moved before spawning a new bubble
  scaleMin: number;
  scaleMax: number;
  fps: number;
  maxBubbles: number;
}

export const defaultBubbleTrailConfig: BubbleTrailConfig = {
  spawnDistance: 20,
  scaleMin: 0.2,
  scaleMax: 0.5,
  fps: 30,
  maxBubbles: 200,
};

export class BubbleTrailEffect {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: BubbleTrailConfig;
  private bubbles: TrailBubble[] = [];
  private animId = 0;
  private running = false;
  private atlasImages: HTMLImageElement[] = [];
  private atlasMeta: AtlasMeta[] = [];
  private loaded = false;
  private lastTime = 0;
  private lastSpawnPos: [number, number] = [0, 0];
  private getMousePosition: () => Promise<[number, number]>;

  private shouldSpawn: () => boolean;

  constructor(
    container: HTMLElement,
    config: BubbleTrailConfig,
    getMousePosition: () => Promise<[number, number]>,
    shouldSpawn: () => boolean
  ) {
    this.config = config;
    this.getMousePosition = getMousePosition;
    this.shouldSpawn = shouldSpawn;

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

  private spawnAt(x: number, y: number) {
    if (this.bubbles.length >= this.config.maxBubbles) return;

    const atlas = Math.floor(random() * this.atlasMeta.length);
    const scale = randIn(this.config.scaleMin, this.config.scaleMax);
    // Offset slightly from cursor so they scatter
    const ox = randIn(-15, 15);
    const oy = randIn(-15, 15);

    this.bubbles.push({
      x: x + ox,
      y: y + oy,
      scale,
      frame: 0,
      atlas,
      accum: 0,
      done: false,
    });
  }

  start() {
    this.running = true;
    this.lastTime = performance.now();

    const loop = async (now: number) => {
      if (!this.running) return;

      const dt = (now - this.lastTime) / 1000;
      this.lastTime = now;

      const mouse = await this.getMousePosition();

      // Spawn bubble if shift held and mouse moved enough
      if (this.loaded && this.shouldSpawn()) {
        const dx = mouse[0] - this.lastSpawnPos[0];
        const dy = mouse[1] - this.lastSpawnPos[1];
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= this.config.spawnDistance) {
          this.spawnAt(mouse[0], mouse[1]);
          this.lastSpawnPos = [...mouse];
        }
      }

      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (this.loaded) {
        for (const b of this.bubbles) {
          const meta = this.atlasMeta[b.atlas];
          const img = this.atlasImages[b.atlas];

          b.accum += this.config.fps * dt;
          const advance = Math.floor(b.accum);
          b.accum -= advance;
          b.frame += advance;

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
      }

      this.animId = requestAnimationFrame(loop);
    };

    this.animId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
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
