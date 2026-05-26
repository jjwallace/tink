const { PI, cos, sin, abs, sqrt, pow, random, atan2 } = Math;
const HALF_PI = 0.5 * PI;

const rand = (n: number) => n * random();
const randIn = (min: number, max: number) => rand(max - min) + min;
const fadeInOut = (t: number, m: number) => {
  const hm = 0.5 * m;
  return abs(((t + hm) % m) - hm) / hm;
};
const dist = (x1: number, y1: number, x2: number, y2: number) =>
  sqrt(pow(x2 - x1, 2) + pow(y2 - y1, 2));
const fadeIn = (t: number, m: number) => t / m;
const lerp = (n1: number, n2: number, speed: number) =>
  (1 - speed) * n1 + speed * n2;

export interface FireConfig {
  particleCount: number;
  speedMin: number;
  speedMax: number;
  sizeMin: number;
  sizeMax: number;
  hueMin: number;
  hueMax: number;
  spawnWidth: number;
  spawnHeight: number;
  velocityMultiplier: number;
  blurAmount: number;
  glowLayers: number;
  contrast: number;
  windForce: number;
  windSensitivity: number;
  windDamping: number;
  wiggle: number;
}

export const defaultConfig: FireConfig = {
  particleCount: 115,
  speedMin: 0.5,
  speedMax: 1.25,
  sizeMin: 0.4,
  sizeMax: 2.7,
  hueMin: 0,
  hueMax: 50,
  spawnWidth: 25,
  spawnHeight: 6,
  velocityMultiplier: 1.037,
  blurAmount: 9,
  glowLayers: 4,
  contrast: 0,
  windForce: 0,
  windSensitivity: 0.1,
  windDamping: 0.8,
  wiggle: 0.05,
};

class Particle {
  center: [number, number];
  canvasWidth: number;
  canvasHeight: number;
  config: FireConfig;
  life = 0;
  ttl = 0;
  speed = 0;
  size = 0;
  initialSize = 0;
  position: [number, number] = [0, 0];
  velocity: [number, number] = [0, 0];
  hue = 0;
  wiggleOffset = random() * PI * 2;
  wigglePhase = 0;

  constructor(
    center: [number, number],
    canvasWidth: number,
    canvasHeight: number,
    config: FireConfig
  ) {
    this.center = center;
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.config = config;
    this.init();
  }

  get color(): string {
    const opacity = fadeInOut(this.life, this.ttl);
    const contrastBoost = this.config.contrast;
    const adjustedOpacity =
      contrastBoost > 0 ? Math.pow(opacity, 1 / contrastBoost) : opacity;
    const lightness = 50 + adjustedOpacity * 30;
    return `hsla(${this.hue}, 100%, ${lightness}%, ${adjustedOpacity})`;
  }

  init() {
    this.life = 0;
    this.ttl = randIn(10, 30);
    this.speed = randIn(this.config.speedMin, this.config.speedMax);
    this.initialSize =
      randIn(this.config.sizeMin, this.config.sizeMax) * 3;
    this.size = this.initialSize;
    this.position = [
      this.center[0] +
        randIn(-this.config.spawnWidth / 2, this.config.spawnWidth / 2),
      this.center[1] + randIn(-this.config.spawnHeight, -10),
    ];
    const direction = atan2(
      this.position[1] - this.center[1],
      this.position[0] - this.center[0]
    );
    this.velocity = [
      cos(direction) * this.speed,
      sin(direction) * this.speed * 2,
    ];
    this.hue = randIn(this.config.hueMin, this.config.hueMax);
  }

  update() {
    this.speed =
      fadeIn(
        dist(
          this.center[0],
          this.center[1],
          this.position[0],
          this.position[1]
        ),
        0.5 * this.canvasHeight
      ) * 20;

    this.velocity[0] = lerp(
      this.velocity[0],
      cos(-HALF_PI) * this.speed,
      0.1
    );
    this.velocity[1] *= this.config.velocityMultiplier;

    this.wigglePhase += 0.05;
    const wiggle =
      sin(this.wigglePhase + this.wiggleOffset) * this.config.wiggle;
    this.velocity[0] += wiggle;
    this.velocity[0] += this.config.windForce;

    this.position[0] += this.velocity[0];
    this.position[1] += this.velocity[1];

    const ageRatio = this.life / this.ttl;
    this.size = this.initialSize * (1 - ageRatio * 0.66);

    const [x, y] = this.position;
    if (
      x > this.canvasWidth ||
      x < 0 ||
      y > this.canvasHeight ||
      y < 0 ||
      this.life++ > this.ttl
    ) {
      this.init();
    }
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(
      this.position[0],
      this.position[1],
      Math.max(0.1, this.size),
      0,
      PI * 2
    );
    ctx.fill();
  }
}

export class FireEffect {
  private canvasA: HTMLCanvasElement;
  private canvasB: HTMLCanvasElement;
  private ctxA: CanvasRenderingContext2D;
  private ctxB: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private config: FireConfig;
  private center: [number, number] = [0, 0];
  private prevMouse: [number, number] = [0, 0];
  private windForce = 0;
  private animId = 0;
  private getMousePosition: () => Promise<[number, number]>;

  constructor(
    container: HTMLElement,
    config: FireConfig,
    getMousePosition: () => Promise<[number, number]>
  ) {
    this.config = config;
    this.getMousePosition = getMousePosition;

    this.canvasA = document.createElement("canvas");
    this.canvasB = document.createElement("canvas");
    this.canvasA.style.display = "none";
    this.canvasB.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;";

    container.appendChild(this.canvasA);
    container.appendChild(this.canvasB);

    this.ctxA = this.canvasA.getContext("2d")!;
    this.ctxB = this.canvasB.getContext("2d")!;

    this.resize();
    window.addEventListener("resize", this.resize);
  }

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvasA.width = this.canvasB.width = w;
    this.canvasA.height = this.canvasB.height = h;
    this.center = [w / 2, h / 2];
    this.prevMouse = [...this.center];
    this.createParticles();
  };

  private createParticles() {
    this.particles = [];
    for (let i = 0; i < this.config.particleCount; i++) {
      this.particles.push(
        new Particle(
          this.center,
          this.canvasA.width,
          this.canvasA.height,
          this.config
        )
      );
    }
  }

  private renderGlow() {
    const blur = this.config.blurAmount;
    const layers = this.config.glowLayers;

    this.ctxB.save();
    this.ctxB.filter = `blur(${blur}px)`;
    this.ctxB.globalCompositeOperation = "lighter";
    this.ctxB.drawImage(this.canvasA, 0, 0);
    this.ctxB.restore();

    for (let i = 1; i <= layers; i++) {
      this.ctxB.save();
      this.ctxB.filter = `blur(${blur * (1 + i * 0.5)}px)`;
      this.ctxB.globalCompositeOperation = "screen";
      this.ctxB.globalAlpha = 0.7 / i;
      this.ctxB.drawImage(this.canvasA, 0, 0);
      this.ctxB.restore();
    }

    this.ctxB.save();
    this.ctxB.filter = `blur(${blur / 3}px)`;
    this.ctxB.globalCompositeOperation = "lighter";
    this.ctxB.globalAlpha = 0.9;
    this.ctxB.drawImage(this.canvasA, 0, 0);
    this.ctxB.restore();
  }

  start() {
    const loop = async () => {
      const w = this.canvasA.width;
      const h = this.canvasA.height;
      if (w === 0 || h === 0) {
        this.animId = requestAnimationFrame(loop);
        return;
      }

      // Get mouse position directly from OS — no delay
      const mouse = await this.getMousePosition();

      this.ctxA.clearRect(0, 0, w, h);
      // Transparent fade — clear fully for transparent background
      this.ctxB.clearRect(0, 0, w, h);

      // Wind from mouse velocity
      const mouseVelocityX = mouse[0] - this.prevMouse[0];
      const targetWind = -mouseVelocityX * this.config.windSensitivity;
      this.windForce = lerp(this.windForce, targetWind, 0.15);
      this.windForce *= this.config.windDamping;
      this.prevMouse = [...mouse];
      this.config.windForce = this.windForce;

      // Instant follow — no lerp
      this.center = mouse;

      for (const p of this.particles) {
        p.center = this.center;
        p.draw(this.ctxA);
        p.update();
      }

      this.renderGlow();
      this.animId = requestAnimationFrame(loop);
    };

    this.animId = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.animId);
    window.removeEventListener("resize", this.resize);
  }
}
