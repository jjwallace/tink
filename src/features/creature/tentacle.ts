/** Tentacle physics — inverse-kinematics chain */

import { S } from "./store";

const PI = Math.PI;
const HP = PI * 0.5;
const cos = Math.cos;
const sin = Math.sin;

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class Node {
  x: number;
  y: number;
  ox: number;
  oy: number;
  vx = 0;
  vy = 0;

  constructor(x = 0, y = 0) {
    this.x = this.ox = x;
    this.y = this.oy = y;
  }
}

export interface Point {
  x: number;
  y: number;
}

export class Tentacle {
  len: number;
  private bR: number;
  private bS: number;
  private fric: number;
  shade: number;
  scale: number;
  nodes: Node[];
  outer: Point[] = [];
  inner: Point[] = [];

  constructor(o: { length?: number; radius?: number; spacing?: number; friction?: number; scale?: number }) {
    this.len = o.length ?? 10;
    this.bR = o.radius ?? 0.5;
    this.bS = o.spacing ?? 0.5;
    this.fric = o.friction ?? 0.8;
    this.scale = o.scale ?? 1;
    this.shade = rnd(0.88, 1.12);
    this.nodes = [];
    for (let i = 0; i < this.len; i++) this.nodes.push(new Node());
  }

  get radius(): number {
    return S.uniform ? S.uniformRadius : this.bR;
  }
  get spacing(): number {
    return S.uniform ? S.uniformSpacing : this.bS;
  }

  move(x: number, y: number, snap = false): void {
    this.nodes[0].x = x;
    this.nodes[0].y = y;
    if (snap) {
      for (let i = 1; i < this.len; i++) {
        this.nodes[i].x = x;
        this.nodes[i].y = y;
      }
    }
  }

  update(): void {
    let prev = this.nodes[0];
    let r = this.radius * S.thickness * this.scale;
    const step = r / this.len;

    for (let i = 1, j = 0; i < this.len; i++, j++) {
      const n = this.nodes[i];
      n.x += n.vx;
      n.y += n.vy;

      const dx = prev.x - n.x;
      const dy = prev.y - n.y;
      const da = Math.atan2(dy, dx);

      const qx = n.x + cos(da) * this.spacing * S.length * this.scale;
      const qy = n.y + sin(da) * this.spacing * S.length * this.scale;
      n.x = prev.x - (qx - n.x);
      n.y = prev.y - (qy - n.y);

      n.vx = (n.x - n.ox) * this.fric * (1 - S.friction) + S.wind;
      n.vy = (n.y - n.oy) * this.fric * (1 - S.friction) + S.gravity;
      n.ox = n.x;
      n.oy = n.y;

      const s = sin(da + HP);
      const c = cos(da + HP);
      this.outer[j] = { x: prev.x + c * r, y: prev.y + s * r };
      this.inner[j] = { x: prev.x - c * r, y: prev.y - s * r };

      r -= step;
      prev = n;
    }
  }
}

/** Build a tentacle array. Scale multiplies physical size (thickness/length). */
export function createTentacles(cx: number, cy: number, count = 100, scale = 1): Tentacle[] {
  const arr: Tentacle[] = [];
  for (let i = 0; i < count; i++) {
    const t = new Tentacle({
      length: Math.floor(rnd(10, 20)),
      radius: rnd(0.05, 1),
      spacing: rnd(0.2, 1),
      friction: rnd(0.7, 0.88),
      scale,
    });
    t.move(cx, cy, true);
    arr.push(t);
  }
  return arr;
}
