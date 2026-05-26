import {
  Container,
  Graphics,
  Text,
  type Application,
  type Ticker,
} from "pixi.js";
import gsap from "gsap";

// ─── Types ───

export type NodeState = "pending" | "active" | "completed" | "failed";

export interface StepDef {
  label: string;
  deps?: number[];
}

// ─── Physics tuning ───

const SPRING_K = 0.002;
const SPRING_LEN = 200;
const REPULSION = 12000;
const DAMPING = 0.90;
const GRAVITY = 0.0004;
const MAX_VEL = 8;
const NODE_R = 14;
const STAGGER_MS = 150;

// ─── Colors ───

const COL_PENDING = 0x444466;
const COL_PENDING_GLOW = 0x333355;
const COL_ACTIVE = 0xfbbf24;
const COL_COMPLETE = 0x6ee7a0;
const COL_FAIL = 0xef4444;
const COL_EDGE_DIM = 0x333355;
const COL_EDGE_LIT = 0x6ee7a0;

// ─── Force node ───

interface PhysNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: NodeState;
  label: string;
  deps: number[];
  container: Container;
  circle: Graphics;
  glow: Graphics;
  pulse: Graphics;
  check: Graphics;
  text: Text;
  pulsePhase: number;
  born: number;
}

// ─── Force graph renderer ───

export class PlanVizForceGraph {
  private app: Application;
  private layer: Container;
  private shadowGfx: Graphics;
  private edgeGfx: Graphics;
  private nodes: PhysNode[] = [];
  private running = false;
  private gravityX: number;
  private gravityY: number;
  private tickFn: ((ticker: Ticker) => void) | null = null;

  constructor(app: Application) {
    this.app = app;
    this.layer = new Container();
    this.layer.label = "plan-viz-force";

    // Localized dark shadow behind the graph area
    this.shadowGfx = new Graphics();
    this.layer.addChild(this.shadowGfx);

    this.edgeGfx = new Graphics();
    this.layer.addChild(this.edgeGfx);

    app.stage.addChild(this.layer);

    this.gravityX = app.screen.width * 0.5;
    this.gravityY = app.screen.height * 0.75;
  }

  // ── Public API ──

  createPlan(steps: StepDef[]) {
    this.clear();

    const spawnX = this.app.screen.width + 80;
    const now = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const container = new Container();

      const glow = new Graphics();
      container.addChild(glow);

      const circle = new Graphics();
      container.addChild(circle);

      const pulse = new Graphics();
      container.addChild(pulse);

      const check = new Graphics();
      check.alpha = 0;
      container.addChild(check);

      const text = new Text({
        text: steps[i].label,
        style: {
          fontSize: 11,
          fontFamily: "'SF Pro Text', -apple-system, system-ui, sans-serif",
          fontWeight: "500",
          fill: 0x666688,
          dropShadow: {
            alpha: 0.9,
            blur: 6,
            color: 0x000000,
            distance: 0,
          },
        },
      });
      text.anchor.set(0.5, 0);
      text.y = NODE_R + 8;
      container.addChild(text);

      const node: PhysNode = {
        x: spawnX + i * 40,
        y: this.gravityY + (Math.random() - 0.5) * 60,
        vx: -3 - Math.random() * 2,
        vy: (Math.random() - 0.5) * 1.5,
        state: "pending",
        label: steps[i].label,
        deps: steps[i].deps ?? (i > 0 ? [i - 1] : []),
        container,
        circle,
        glow,
        pulse,
        check,
        text,
        pulsePhase: Math.random() * Math.PI * 2,
        born: now + i * STAGGER_MS,
      };

      this.drawNodeVisual(node);
      this.layer.addChild(container);
      container.alpha = 0;
      this.nodes.push(node);
    }

    this.running = true;
    this.tickFn = (ticker: Ticker) => this.tick(ticker.deltaTime);
    this.app.ticker.add(this.tickFn);
  }

  setNodeState(index: number, state: NodeState) {
    const node = this.nodes[index];
    if (!node) return;
    node.state = state;

    const { circle, glow, pulse, check, text } = node;

    switch (state) {
      case "pending":
        this.drawPending(glow, circle, pulse, check);
        text.style.fill = 0x666688;
        break;

      case "active":
        glow.clear();
        glow.circle(0, 0, NODE_R + 10);
        glow.fill({ color: COL_ACTIVE, alpha: 0.15 });
        glow.circle(0, 0, NODE_R + 5);
        glow.fill({ color: COL_ACTIVE, alpha: 0.1 });
        circle.clear();
        circle.circle(0, 0, NODE_R);
        circle.stroke({ color: COL_ACTIVE, width: 2, alpha: 1 });
        pulse.clear();
        check.alpha = 0;
        text.style.fill = 0xffffff;
        node.pulsePhase = 0;
        break;

      case "completed":
        glow.clear();
        glow.circle(0, 0, NODE_R + 14);
        glow.fill({ color: COL_COMPLETE, alpha: 0.12 });
        glow.circle(0, 0, NODE_R + 8);
        glow.fill({ color: COL_COMPLETE, alpha: 0.18 });
        circle.clear();
        circle.circle(0, 0, NODE_R);
        circle.fill({ color: COL_COMPLETE, alpha: 0.85 });
        circle.stroke({ color: COL_COMPLETE, width: 2, alpha: 1 });
        pulse.clear();
        check.alpha = 1;
        text.style.fill = 0xffffff;
        // Physics kick — little bounce
        node.vx += (Math.random() - 0.5) * 4;
        node.vy -= 1.5 + Math.random();
        break;

      case "failed":
        glow.clear();
        glow.circle(0, 0, NODE_R + 10);
        glow.fill({ color: COL_FAIL, alpha: 0.2 });
        circle.clear();
        circle.circle(0, 0, NODE_R);
        circle.fill({ color: COL_FAIL, alpha: 0.8 });
        circle.stroke({ color: COL_FAIL, width: 2.5, alpha: 1 });
        pulse.clear();
        check.alpha = 0;
        text.style.fill = COL_FAIL;
        // Shake via velocity
        node.vx += 10;
        setTimeout(() => { if (node) node.vx -= 20; }, 40);
        setTimeout(() => { if (node) node.vx += 10; }, 80);
        break;
    }
  }

  getNodePosition(index: number): { x: number; y: number } {
    const n = this.nodes[index];
    return n ? { x: n.x, y: n.y } : { x: this.gravityX, y: this.gravityY };
  }

  async collapse(cx: number, cy: number): Promise<void> {
    this.running = false;

    const promises = this.nodes.map(
      (node) =>
        new Promise<void>((resolve) =>
          gsap.to(node, {
            x: cx,
            y: cy,
            duration: 0.6,
            ease: "power2.in",
            onUpdate: () => {
              node.container.x = node.x;
              node.container.y = node.y;
            },
            onComplete: () => {
              node.container.alpha = 0;
              resolve();
            },
          }),
        ),
    );

    gsap.to(this.edgeGfx, { alpha: 0, pixi: { alpha: 0 }, duration: 0.4 });
    await Promise.all(promises);
  }

  clear() {
    this.running = false;
    if (this.tickFn) {
      this.app.ticker.remove(this.tickFn);
      this.tickFn = null;
    }
    for (const node of this.nodes) {
      gsap.killTweensOf(node);
      node.container.destroy({ children: true });
    }
    this.shadowGfx.clear();
    this.edgeGfx.clear();
    this.edgeGfx.alpha = 1;
    this.nodes = [];
  }

  destroy() {
    this.clear();
    if (this.layer.parent) {
      this.layer.parent.removeChild(this.layer);
    }
    this.layer.destroy({ children: true });
  }

  // ── Physics tick ──

  private tick(dt: number) {
    if (!this.running) return;
    const now = Date.now();

    for (const node of this.nodes) {
      if (now < node.born) continue;

      // Gravity toward center
      const gx = this.gravityX - node.x;
      const gy = this.gravityY - node.y;
      node.vx += gx * GRAVITY * dt;
      node.vy += gy * GRAVITY * dt;

      // Repulsion from every other node
      for (const other of this.nodes) {
        if (other === node || now < other.born) continue;
        const dx = node.x - other.x;
        const dy = node.y - other.y;
        const distSq = dx * dx + dy * dy + 1;
        const dist = Math.sqrt(distSq);
        const force = (REPULSION / distSq) * dt * 0.016;
        node.vx += (dx / dist) * force;
        node.vy += (dy / dist) * force;
      }

      // Spring forces along edges
      for (const depIdx of node.deps) {
        const dep = this.nodes[depIdx];
        if (!dep || now < dep.born) continue;
        const dx = dep.x - node.x;
        const dy = dep.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const displacement = dist - SPRING_LEN;
        const fx = (dx / dist) * displacement * SPRING_K * dt;
        const fy = (dy / dist) * displacement * SPRING_K * dt;
        node.vx += fx;
        node.vy += fy;
        dep.vx -= fx;
        dep.vy -= fy;
      }

      // Damping
      node.vx *= Math.pow(DAMPING, dt);
      node.vy *= Math.pow(DAMPING, dt);

      // Clamp velocity
      const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
      if (speed > MAX_VEL) {
        node.vx = (node.vx / speed) * MAX_VEL;
        node.vy = (node.vy / speed) * MAX_VEL;
      }

      // Integrate position
      node.x += node.vx * dt;
      node.y += node.vy * dt;

      // Soft boundary
      const m = 60;
      const w = this.app.screen.width;
      const h = this.app.screen.height;
      if (node.x < m) { node.x = m; node.vx *= -0.5; }
      if (node.x > w - m) { node.x = w - m; node.vx *= -0.5; }
      if (node.y < m) { node.y = m; node.vy *= -0.5; }
      if (node.y > h - m) { node.y = h - m; node.vy *= -0.5; }
    }

    // Update pixi positions + active pulse
    for (const node of this.nodes) {
      if (now < node.born) {
        node.container.alpha = 0;
        continue;
      }
      // Fade in on spawn
      if (node.container.alpha < 1) {
        node.container.alpha = Math.min(node.container.alpha + 0.08 * dt, 1);
      }
      node.container.x = node.x;
      node.container.y = node.y;

      // Active node pulse ring
      if (node.state === "active") {
        node.pulsePhase += dt * 0.06;
        const r = NODE_R + 4 + Math.sin(node.pulsePhase) * 8;
        const a = 0.25 + Math.sin(node.pulsePhase) * 0.15;
        node.pulse.clear();
        node.pulse.circle(0, 0, r);
        node.pulse.stroke({ color: COL_ACTIVE, width: 1.5, alpha: a });
      }
    }

    // Redraw shadow + edges
    this.drawShadow(now);
    this.drawEdges(now);
  }

  private drawShadow(now: number) {
    this.shadowGfx.clear();
    // Find bounding box of visible nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    for (const node of this.nodes) {
      if (now < node.born || node.container.alpha < 0.1) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
      count++;
    }
    if (count === 0) return;

    // Padded center of the node cluster
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 + 120; // padding
    const ry = (maxY - minY) / 2 + 100;
    const r = Math.max(rx, ry, 140);

    // Soft radial shadow — dark at center, transparent at edges
    this.shadowGfx.circle(cx, cy, r);
    this.shadowGfx.fill({ color: 0x060610, alpha: 0.7 });
    // Outer softer ring
    this.shadowGfx.circle(cx, cy, r * 1.4);
    this.shadowGfx.fill({ color: 0x060610, alpha: 0.3 });
  }

  private drawEdges(now: number) {
    this.edgeGfx.clear();
    for (const node of this.nodes) {
      if (now < node.born) continue;
      for (const depIdx of node.deps) {
        const dep = this.nodes[depIdx];
        if (!dep || now < dep.born) continue;

        const resolved = dep.state === "completed";
        const active =
          node.state === "active" || node.state === "completed";
        const lit = resolved && active;

        const color = lit ? COL_EDGE_LIT : COL_EDGE_DIM;
        const alpha = lit ? 0.6 : 0.25;
        const width = lit ? 2.5 : 1.5;

        this.edgeGfx.moveTo(dep.x, dep.y);
        this.edgeGfx.lineTo(node.x, node.y);
        this.edgeGfx.stroke({ color, width, alpha });

        // Glow pass for resolved edges
        if (lit) {
          this.edgeGfx.moveTo(dep.x, dep.y);
          this.edgeGfx.lineTo(node.x, node.y);
          this.edgeGfx.stroke({ color: COL_EDGE_LIT, width: 6, alpha: 0.1 });
        }
      }
    }
  }

  // ── Drawing helpers ──

  private drawNodeVisual(node: PhysNode) {
    this.drawPending(node.glow, node.circle, node.pulse, node.check);
    // Pre-draw checkmark
    node.check.clear();
    node.check.moveTo(-4, 0);
    node.check.lineTo(-1, 3);
    node.check.lineTo(5, -4);
    node.check.stroke({ color: 0x000000, width: 2.5, alpha: 0.7 });
  }

  private drawPending(
    glow: Graphics,
    circle: Graphics,
    pulse: Graphics,
    check: Graphics,
  ) {
    glow.clear();
    glow.circle(0, 0, NODE_R + 6);
    glow.fill({ color: COL_PENDING_GLOW, alpha: 0.12 });

    circle.clear();
    circle.circle(0, 0, NODE_R);
    circle.stroke({ color: COL_PENDING, width: 1.5, alpha: 1 });

    pulse.clear();
    check.alpha = 0;
  }
}
