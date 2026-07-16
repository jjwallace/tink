/**
 * Companion creatures — three half-scale kin that flock behind the parent.
 *
 * Each companion is a full muscular-hydrostat creature (head + tentacles +
 * particles) identical to the parent but scaled down. Movement is a boids
 * flock: cohesion toward a "slot" trailing the parent, separation from
 * siblings, alignment to parent velocity, a continuous Perlin-ish wander,
 * and occasional barrel-roll "loopsies" triggered on a random timer.
 *
 * The module owns physics + emission; the renderer is responsible for
 * drawing (it already knows how to draw a scaled creature).
 */

import { Tentacle, createTentacles } from "./tentacle";
import { emit } from "../ambient-vfx/particles";
import { S } from "./store";

const PI = Math.PI;
const TWO_PI = PI * 2;
const { cos, sin, hypot, atan2, min, max, floor, random } = Math;

function rnd(a: number, b: number): number {
  return a + random() * (b - a);
}

// ── Tunables ────────────────────────────────────────────────
export const COMPANION_COUNT = 3;
// A quarter of the parent's size — small enough to read as "children".
export const COMPANION_SCALE = 0.25;

const TENTACLES_PER_COMPANION = 100;
const FOLLOW_DIST = 110;        // trailing distance behind parent, px
const FOLLOW_DIST_JITTER = 18;  // per-companion stagger so they don't stack
const SEPARATE_R = 42;          // tighter spacing since they're smaller
const DAMPING = 0.93;

// Separation is independent of urgency — siblings always give each other room.
const W_SEPARATE = 0.14;

// ── Urgency-driven tunables ────────────────────────────────
// A single scalar — `urgency` in [0..1] — modulates everything else.
// It's derived from the mother's current speed, smoothed per-companion so
// transitions feel organic (no sudden mode-flips).
//
// Low urgency (mother idling, orbit, figure-8):  mellow drift, lots of wander
// High urgency (mother traversing, exiting):     burst-mode catch-up, laser focus
const MOTHER_CALM_SPEED = 3;   // px/frame at 60fps — below this, fully mellow
const MOTHER_BURST_SPEED = 12; // px/frame — above this, fully urgent

// Tunable ranges — first value is calm, second is burst
const MAX_SPEED_RANGE = [3.5, 18] as const;
const W_COHESION_RANGE = [0.012, 0.045] as const;
const W_ALIGN_RANGE = [0.02, 0.08] as const;
const W_WANDER_RANGE = [0.14, 0.04] as const; // inverted: less wander when urgent

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ── State ───────────────────────────────────────────────────
export interface Parent {
  x: number; y: number;
  vx: number; vy: number;
}

export interface Companion {
  x: number; y: number;
  vx: number; vy: number;

  scale: number;
  tentacles: Tentacle[];

  // Formation: angular offset relative to directly-behind-parent, and a
  // per-companion trailing distance so they fan out instead of stacking.
  slotOffsetA: number;
  slotDist: number;

  // Wander: heading integrates a random walk.
  wanderAngle: number;

  // Smoothed [0..1] — how urgent this child feels based on mother's speed.
  // Drives MAX_SPEED, cohesion, alignment, and wander amount each tick.
  urgency: number;

  // Loopsie state — a short circular flourish.
  loopActive: boolean;
  loopT: number;
  loopDur: number;
  loopDir: 1 | -1;
  loopCenter: { x: number; y: number };
  loopRadius: number;
  nextLoopAt: number; // ms timestamp (performance.now scale)
}

// ── Factory ─────────────────────────────────────────────────
export function createCompanions(cx: number, cy: number, count = COMPANION_COUNT): Companion[] {
  const list: Companion[] = [];
  const now = performance.now();
  for (let i = 0; i < count; i++) {
    const tents = createTentacles(cx, cy, TENTACLES_PER_COMPANION, COMPANION_SCALE);
    // Fan out: first companion trails center, others offset ±
    const slotOffsetA = (i - (count - 1) / 2) * 0.42;
    list.push({
      x: cx + rnd(-60, 60),
      y: cy + rnd(-60, 60),
      vx: 0, vy: 0,
      scale: COMPANION_SCALE,
      tentacles: tents,
      slotOffsetA,
      slotDist: FOLLOW_DIST + i * FOLLOW_DIST_JITTER,
      wanderAngle: random() * TWO_PI,
      urgency: 0,
      loopActive: false,
      loopT: 0,
      loopDur: 900,
      loopDir: random() < 0.5 ? 1 : -1,
      loopCenter: { x: cx, y: cy },
      loopRadius: 40,
      nextLoopAt: now + rnd(3500, 9000),
    });
  }
  return list;
}

// ── Boids step ──────────────────────────────────────────────
/**
 * Advance a single companion one tick.
 * `siblings` is the full companion array (including self — self is skipped).
 */
export function tickCompanion(
  c: Companion,
  parent: Parent,
  siblings: Companion[],
  dt: number,
  now: number,
): void {
  // ── Urgency from mother's speed ───────────────────────────
  // Map parent speed → [0..1] linearly between calm and burst thresholds,
  // then ease toward that target so the transition is smooth (no twitchy
  // mode-flipping when the mother briefly slows mid-maneuver).
  const parentSpeed = hypot(parent.vx, parent.vy);
  const targetUrgency = clamp01(
    (parentSpeed - MOTHER_CALM_SPEED) / (MOTHER_BURST_SPEED - MOTHER_CALM_SPEED),
  );
  c.urgency += (targetUrgency - c.urgency) * 0.08;

  const maxSpeed = lerp(MAX_SPEED_RANGE[0], MAX_SPEED_RANGE[1], c.urgency);
  const wCohesion = lerp(W_COHESION_RANGE[0], W_COHESION_RANGE[1], c.urgency);
  const wAlign = lerp(W_ALIGN_RANGE[0], W_ALIGN_RANGE[1], c.urgency);
  const wWander = lerp(W_WANDER_RANGE[0], W_WANDER_RANGE[1], c.urgency);

  // ── Loopsie: hijacks steering for its duration ────────────
  if (c.loopActive) {
    c.loopT += dt;
    const p = c.loopT / c.loopDur;
    if (p >= 1) {
      c.loopActive = false;
      c.nextLoopAt = now + rnd(5000, 12000);
    } else {
      // Drift the loop center forward with parent so loops trail properly
      c.loopCenter.x += parent.vx * 0.4;
      c.loopCenter.y += parent.vy * 0.4;
      // Sweep a circle around the drifting center
      const angle = -PI / 2 + p * TWO_PI * c.loopDir;
      const tx = c.loopCenter.x + cos(angle) * c.loopRadius;
      const ty = c.loopCenter.y + sin(angle) * c.loopRadius;
      c.vx += (tx - c.x) * 0.14;
      c.vy += (ty - c.y) * 0.14;
    }
  } else {
    // ── Trigger next loopsie probabilistically ──────────────
    if (now >= c.nextLoopAt && random() < 0.02) {
      c.loopActive = true;
      c.loopT = 0;
      c.loopDur = rnd(700, 1400);
      c.loopRadius = rnd(30, 55);
      c.loopDir = random() < 0.5 ? 1 : -1;
      c.loopCenter = { x: c.x, y: c.y };
    }

    // ── Compute slot: trailing position behind parent ───────
    // Pursuit: aim for the parent's *predicted future* position so tinks
    // cut inside her arcs instead of chasing where she used to be.
    const lookahead = S.pursuit ? 8 : 0;
    const refX = parent.x + parent.vx * lookahead;
    const refY = parent.y + parent.vy * lookahead;
    const moving = parentSpeed > 0.15;
    // If parent stopped, use the companion's own slot offset angle so
    // siblings orbit rather than collapse onto a single point.
    const behindA = moving
      ? atan2(parent.vy, parent.vx) + PI + c.slotOffsetA
      : c.slotOffsetA * 2;
    const targetX = refX + cos(behindA) * c.slotDist;
    const targetY = refY + sin(behindA) * c.slotDist;

    // ── Cohesion: pull toward slot (stronger when far + urgent) ──
    const dx = targetX - c.x;
    const dy = targetY - c.y;
    const dist = hypot(dx, dy);
    // Cap scales with urgency so burst-mode catch-up isn't clamped away.
    const pullCap = lerp(0.06, 0.15, c.urgency);
    const pull = min(pullCap, wCohesion + dist * 0.00018);
    c.vx += dx * pull;
    c.vy += dy * pull;

    // ── Alignment: match parent velocity (stronger when urgent) ──
    c.vx += parent.vx * wAlign;
    c.vy += parent.vy * wAlign;

    // ── Separation: shove away from close siblings ──────────
    for (const o of siblings) {
      if (o === c) continue;
      const ox = c.x - o.x;
      const oy = c.y - o.y;
      const od = hypot(ox, oy);
      if (od > 0.001 && od < SEPARATE_R) {
        const f = ((SEPARATE_R - od) / SEPARATE_R) * W_SEPARATE;
        c.vx += (ox / od) * f * SEPARATE_R * 0.3;
        c.vy += (oy / od) * f * SEPARATE_R * 0.3;
      }
    }

    // ── Wander: gentle drift (fades out when urgent) ────────
    c.wanderAngle += rnd(-0.03, 0.03);
    c.vx += cos(c.wanderAngle) * wWander;
    c.vy += sin(c.wanderAngle) * wWander;
  }

  // ── Damping + urgency-scaled speed cap + integrate ───────
  c.vx *= DAMPING;
  c.vy *= DAMPING;
  const sp = hypot(c.vx, c.vy);
  if (sp > maxSpeed) {
    c.vx = (c.vx / sp) * maxSpeed;
    c.vy = (c.vy / sp) * maxSpeed;
  }
  c.x += c.vx;
  c.y += c.vy;
}

// ── Tentacle chain update for one companion ─────────────────
export function updateCompanionTentacles(c: Companion): void {
  const count = min(S.tentacles, c.tentacles.length);
  const step = TWO_PI / count;
  const headR = S.headRadius * c.scale;
  for (let i = 0; i < count; i++) {
    const t = c.tentacles[i];
    const th = i * step;
    t.move(c.x + cos(th) * headR, c.y + sin(th) * headR);
    t.update();
  }
}

// ── Particle emission proportional to companion size ────────
export function emitCompanionParticles(c: Companion): void {
  const count = min(S.tentacles, c.tentacles.length);
  // Smaller creature → emit proportionally less
  const rate = max(1, floor(S.particleRate * c.scale));
  for (let e = 0; e < rate; e++) {
    const ti = floor(random() * count);
    const t = c.tentacles[ti];
    if (!t || t.nodes.length < 2) continue;
    const ni = min(floor(t.len * 0.5 + random() * t.len * 0.5), t.len - 1);
    const nd = t.nodes[ni];
    emit(nd.x, nd.y, nd.vx, nd.vy);
  }
}
