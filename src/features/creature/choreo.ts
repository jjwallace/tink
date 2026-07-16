/**
 * Choreography engine — composable task system for creature behaviors.
 *
 * Lifecycle:
 *   TRANSIT → PERFORM → COMPLETE (one-shot) or loops until stop()
 *
 * Idle tasks (circle, figure-8) skip transit and blend in from current position.
 * Leave-screen starts from current position with no transit.
 */

const { PI, cos, sin, hypot, min, max, floor, atan2 } = Math;
const TWO_PI = PI * 2;
const HP = PI * 0.5;
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function eO(t: number) { return 1 - (1 - t) * (1 - t); }
function eIO(t: number) { return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; }

// ── Types ───────────────────────────────────────────────────

export type TaskType =
  | "idle-circle"
  | "idle-figure8"
  | "text-reveal"
  | "celebration"
  | "leave-screen"
  | "notify"
  | "dance"
  // Drawing choreographies — used by the viz coordinator.
  | "draw-arc"
  | "draw-sweep"
  | "draw-path"
  // Pure transit arc — arrive and complete. Used to arch back to a point.
  | "glide-to"
  // Enter a holding pattern: arc onto a big orbit around the target,
  // spiral inward over N decaying loops, then orbit steadily forever.
  | "holding-pattern";

export interface TaskConfig {
  type: TaskType;
  target: { x: number; y: number };
  speed?: number;
  radius?: number;                               // width of pattern
  heightRatio?: number;                           // figure-8 height as ratio of radius (default 0.4)
  direction?: "left" | "right" | "up" | "down";
  // Text reveal (populated by renderer)
  text?: string;
  textLeft?: number;
  textRight?: number;
  textY?: number;
  wordCenters?: number[];
  // draw-arc: sweep `revolutions` full rotations around `target` at `radius`
  revolutions?: number;
  arcDir?: 1 | -1;
  // draw-arc exit: after revolutions, spiral outward for this duration before completing
  exitMs?: number;
  exitRadiusMult?: number;
  // holding-pattern: N decaying loops from entryRadius down to radius, then steady.
  entryRadius?: number;
  entryLoops?: number;
  // draw-sweep: fly from `target - (sweepLength/2, 0)` to `target + (sweepLength/2, 0)`
  //   with a vertical wave of amplitude `sweepHeight`
  sweepLength?: number;
  sweepHeight?: number;
  // draw-path: visit each point in `path` in order, pause `pauseMs` at each
  path?: { x: number; y: number }[];
  arcHeight?: number;
  pauseMs?: number;
}

export type Phase = "idle" | "transit" | "perform" | "complete";

export type TextSubPhase = "sweep" | "arc-return" | "loop" | "bounce" | "arc-back" | "drift-out";

export interface TickResult {
  x: number;
  y: number;
  phase: Phase;
  arrived?: boolean;
  textSubPhase?: TextSubPhase;
  revealX?: number;
  bounceWordIdx?: number;
  flashWordIdx?: number;
}

// ── Internal state ──────────────────────────────────────────

interface State {
  task: TaskConfig | null;
  phase: Phase;
  elapsed: number;
  anchor: { x: number; y: number };
  // Steering (arcing transit + leave-screen)
  heading: number;     // current heading in radians
  speed: number;       // current speed (px/frame at 60fps)
  // Blend-in for smooth merging (idle tasks)
  blendOffset: { x: number; y: number } | null;
  blendDur: number;
  blendElapsed: number;
  // Text reveal
  textPhase: TextSubPhase;
  textElapsed: number;
  bounceIdx: number;
  lastFlash: number;
  // Drawing tasks
  transitOverride: { x: number; y: number } | null; // custom transit target (e.g. tangent entry)
  drawArcSwept: number;                             // radians swept in draw-arc
  drawArcStartAngle: number;
  drawPathIdx: number;
  drawPauseUntil: number;
}

const ARRIVE_DIST = 15;

// ── Factory ─────────────────────────────────────────────────

export function createChoreographer() {
  const s: State = {
    task: null,
    phase: "idle",
    elapsed: 0,
    anchor: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    blendOffset: null,
    blendDur: 600,
    blendElapsed: 0,
    textPhase: "sweep",
    textElapsed: 0,
    bounceIdx: 0,
    lastFlash: -1,
    transitOverride: null,
    drawArcSwept: 0,
    drawArcStartAngle: 0,
    drawPathIdx: 0,
    drawPauseUntil: 0,
  };

  /**
   * Dispatch a task. Pass currentPos for smooth blend-in on idle tasks
   * and correct anchor for leave-screen. Pass prevPos (position last frame)
   * to infer current heading for arcing turns.
   */
  function dispatch(
    config: TaskConfig,
    currentPos?: { x: number; y: number },
    prevPos?: { x: number; y: number },
  ) {
    s.task = config;
    s.elapsed = 0;
    s.textPhase = "sweep";
    s.textElapsed = 0;
    s.bounceIdx = 0;
    s.lastFlash = -1;
    s.blendOffset = null;
    s.transitOverride = null;
    s.drawArcSwept = 0;
    s.drawPathIdx = 0;
    s.drawPauseUntil = 0;

    // Infer heading from recent movement
    if (currentPos && prevPos) {
      const dx = currentPos.x - prevPos.x;
      const dy = currentPos.y - prevPos.y;
      if (hypot(dx, dy) > 0.5) {
        s.heading = atan2(dy, dx);
        s.speed = hypot(dx, dy);
      }
    }

    const blendsIn = config.type === "idle-circle" || config.type === "idle-figure8"
      || config.type === "dance" || config.type === "notify";

    if (blendsIn && currentPos) {
      // Skip transit — blend from current position into the pattern.
      // Tuning history:
      //   1400 ms → felt like "pull-back" hesitation on every dispatch
      //   220 ms  → too abrupt, the creature "frosted"/glitched as the
      //             velocity snapped
      //   600 ms  → sweet spot: quick enough that it doesn't read as
      //             hesitation, long enough that the velocity delta is
      //             masked by the position ease.
      s.phase = "perform";
      s.anchor = { ...config.target };
      const ideal = idlePositionAt0(config);
      s.blendOffset = { x: currentPos.x - ideal.x, y: currentPos.y - ideal.y };
      s.blendElapsed = 0;
      s.blendDur = 600;
    } else if (config.type === "leave-screen" && currentPos) {
      s.phase = "perform";
      s.anchor = { ...currentPos };
      // Set initial heading toward the exit edge
      const dir = config.direction ?? "right";
      const targetAngle = dir === "right" ? 0 : dir === "left" ? PI : dir === "down" ? HP : -HP;
      // Don't snap — heading is already set from movement, speed ramps in tick
      s.speed = max(s.speed, 2);
      // Store target angle in anchor.y reuse (not ideal but avoids new field)
      // Actually, we'll just steer in corioLeaveScreen
    } else if (config.type === "draw-arc") {
      // Transit aims at the entry point on the orbital circle closest to the
      // creature's current position — avoids flying through the center.
      const r = config.radius ?? 60;
      if (currentPos) {
        const dx = currentPos.x - config.target.x;
        const dy = currentPos.y - config.target.y;
        const a = atan2(dy, dx);
        s.transitOverride = {
          x: config.target.x + cos(a) * r,
          y: config.target.y + sin(a) * r,
        };
      }
      s.phase = "transit";
      if (currentPos) s.speed = max(s.speed, 1.5);
    } else if (config.type === "holding-pattern") {
      // Enter on the outer-circle tangent nearest current position.
      const entryR = config.entryRadius ?? (config.radius ?? 140) * 2.5;
      if (currentPos) {
        const dx = currentPos.x - config.target.x;
        const dy = currentPos.y - config.target.y;
        const a = atan2(dy, dx);
        s.transitOverride = {
          x: config.target.x + cos(a) * entryR,
          y: config.target.y + sin(a) * entryR,
        };
      }
      s.phase = "transit";
      if (currentPos) s.speed = max(s.speed, 1.5);
    } else if (config.type === "draw-sweep") {
      // Transit to the left endpoint of the sweep line.
      const len = config.sweepLength ?? 160;
      s.transitOverride = {
        x: config.target.x - len / 2,
        y: config.target.y,
      };
      s.phase = "transit";
      if (currentPos) s.speed = max(s.speed, 1.5);
    } else if (config.type === "draw-path") {
      const path = config.path ?? [];
      if (path.length > 0) {
        s.transitOverride = { ...path[0] };
      }
      s.phase = "transit";
      if (currentPos) s.speed = max(s.speed, 1.5);
    } else {
      s.phase = "transit";
      if (currentPos) s.speed = max(s.speed, 1.5);
    }
  }

  function stop() {
    s.task = null;
    s.phase = "idle";
    s.elapsed = 0;
    s.blendOffset = null;
  }

  function tick(
    dt: number,
    current: { x: number; y: number },
    screen: { w: number; h: number },
  ): TickResult {
    if (!s.task || s.phase === "idle" || s.phase === "complete") {
      return { x: current.x, y: current.y, phase: s.phase };
    }

    s.elapsed += dt;
    const task = s.task;

    // ── Transit (arcing steering + swooping wave) ─────────
    if (s.phase === "transit") {
      // Draw tasks override the transit target so we approach the entry
      // point of the drawing path rather than the viz center.
      const transitTarget = s.transitOverride ?? task.target;
      const dx = transitTarget.x - current.x;
      const dy = transitTarget.y - current.y;
      const dist = hypot(dx, dy);

      if (dist < ARRIVE_DIST) {
        // glide-to is a pure-transit task: arrival IS completion.
        if (task.type === "glide-to") {
          s.phase = "complete";
          return { x: transitTarget.x, y: transitTarget.y, phase: "complete", arrived: true };
        }
        s.phase = "perform";
        s.elapsed = 0;
        // For draw-arc the anchor is the orbit CENTER (task.target), while
        // the creature is at the entry point (transitTarget). For other
        // draw tasks, anchor = where we arrived.
        if (task.type === "draw-arc") {
          s.anchor = { ...task.target };
          const dax = transitTarget.x - task.target.x;
          const day = transitTarget.y - task.target.y;
          s.drawArcStartAngle = atan2(day, dax);
          s.drawArcSwept = 0;
        } else if (task.type === "holding-pattern") {
          s.anchor = { ...task.target };
          const dax = transitTarget.x - task.target.x;
          const day = transitTarget.y - task.target.y;
          s.drawArcStartAngle = atan2(day, dax);
          s.drawArcSwept = 0;
        } else if (task.type === "draw-sweep") {
          s.anchor = { ...transitTarget };
        } else if (task.type === "draw-path") {
          s.anchor = { ...transitTarget };
          s.drawPathIdx = 1; // already at index 0; head for index 1 next
          s.drawPauseUntil = performance.now() + (task.pauseMs ?? 150);
        } else {
          s.anchor = { ...task.target };
        }
        return { x: transitTarget.x, y: transitTarget.y, phase: "perform", arrived: true };
      }

      // Desired heading toward target
      const desired = atan2(dy, dx);
      const turnRate = 0.08;
      let diff = desired - s.heading;
      while (diff > PI) diff -= TWO_PI;
      while (diff < -PI) diff += TWO_PI;
      s.heading += diff * turnRate;

      // Ramp speed
      const cruise = max(3, min(12, dist * 0.04));
      s.speed += (cruise - s.speed) * 0.06;

      // Swooping wave perpendicular to heading — amplitude fades as we approach
      const tSec = s.elapsed * 0.001;
      const waveAmp = min(35, dist * 0.08); // stronger when far, fades near target
      const wave = sin(tSec * 4.5) * waveAmp;
      const perpX = -sin(s.heading) * wave;
      const perpY = cos(s.heading) * wave;

      const nx = current.x + cos(s.heading) * s.speed + perpX * 0.06;
      const ny = current.y + sin(s.heading) * s.speed + perpY * 0.06;
      return { x: nx, y: ny, phase: "transit" };
    }

    // ── Perform ──────────────────────────────────────────
    const speed = task.speed ?? 1;
    const t = s.elapsed * 0.001 * speed;
    let result: TickResult;

    switch (task.type) {
      case "idle-circle":
        result = corioIdleCircle(s, t, task);
        break;
      case "idle-figure8":
        result = corioIdleFigure8(s, t, task);
        break;
      case "celebration":
        result = corioCelebration(s, task);
        break;
      case "leave-screen":
        result = corioLeaveScreen(s, task, screen);
        break;
      case "notify":
        result = corioNotify(s, t, task, screen);
        break;
      case "dance":
        result = corioDance(s, t, task, screen);
        break;
      case "text-reveal":
        result = corioTextReveal(s, dt, screen);
        break;
      case "draw-arc":
        result = corioDrawArc(s, dt, task);
        break;
      case "draw-sweep":
        result = corioDrawSweep(s, task);
        break;
      case "draw-path":
        result = corioDrawPath(s, current, task);
        break;
      case "holding-pattern":
        result = corioHoldingPattern(s, dt, task);
        break;
      default:
        result = { x: current.x, y: current.y, phase: s.phase };
    }

    // ── Apply blend offset (decays over blendDur) ────────
    // Use ease-in-out (eIO) rather than ease-out (eO): decay stays near 1
    // for the first ~300 ms so the creature keeps riding its old trajectory
    // briefly, then accelerates through the middle of the transition, then
    // eases into the new pattern. Prevents the abrupt "snap onto new
    // pattern" look that was making the creature look startled.
    if (s.blendOffset) {
      s.blendElapsed += dt;
      const decay = max(0, 1 - eIO(min(1, s.blendElapsed / s.blendDur)));
      result.x += s.blendOffset.x * decay;
      result.y += s.blendOffset.y * decay;
      if (s.blendElapsed >= s.blendDur) s.blendOffset = null;
    }

    return result;
  }

  /**
   * Update the current task's anchor in-place without re-dispatching.
   * Used for "follow" behaviors — e.g. creature orbiting a live-dragged
   * anchor. Does not reset blendOffset or elapsed time.
   */
  function setAnchor(x: number, y: number) {
    s.anchor.x = x;
    s.anchor.y = y;
    if (s.task) {
      s.task.target = { x, y };
    }
  }

  return {
    dispatch,
    stop,
    tick,
    setAnchor,
    get phase() { return s.phase; },
    get task() { return s.task; },
    get active() { return s.phase === "transit" || s.phase === "perform"; },
  };
}

// ── Idle position at t=0 (for blend offset calc) ────────────

function idlePositionAt0(config: TaskConfig): { x: number; y: number } {
  const ax = config.target.x, ay = config.target.y;
  if (config.type === "idle-circle") {
    const r = config.radius ?? 60;
    return { x: ax + r, y: ay }; // cos(0)=1, sin(0)=0
  }
  // figure-8: sin(0)=0 for both components
  return { x: ax, y: ay };
}

// ── Idle: circle (fast — ~2s per revolution) ────────────────

function corioIdleCircle(s: State, t: number, task: TaskConfig): TickResult {
  const r = task.radius ?? 60;
  return {
    x: s.anchor.x + cos(t * 3.0) * r,
    y: s.anchor.y + sin(t * 3.0) * r,
    phase: "perform",
  };
}

// ── Idle: figure-8 (fast, variable size) ────────────────────

function corioIdleFigure8(s: State, t: number, task: TaskConfig): TickResult {
  const hw = (task.radius ?? 200) / 2;
  const hh = hw * (task.heightRatio ?? 0.4);
  // `speed` scales the temporal frequency — defaults to 1.0 (original cadence
  // ~2.2/4.4 rad/s). Lower values produce "cruising" — wide slow arcs, used
  // by the thinking state (claude-start). The y-axis harmonic stays at 2x
  // the x-axis frequency to preserve the figure-8 shape.
  const sp = task.speed ?? 1.0;
  return {
    x: s.anchor.x + sin(t * 2.2 * sp) * hw,
    y: s.anchor.y + sin(t * 4.4 * sp) * hh,
    phase: "perform",
  };
}

// ── Celebration (spiral burst → settle) ─────────────────────

function corioCelebration(s: State, task: TaskConfig): TickResult {
  const dur = 900;
  const p = min(1, s.elapsed / dur);
  const decay = 1 - p * p;
  const spiralR = 80 * decay;
  const angle = p * PI * 3;
  const result: TickResult = {
    x: s.anchor.x + cos(angle) * spiralR,
    y: s.anchor.y + sin(angle) * spiralR,
    phase: "perform",
  };
  if (p >= 1) { s.phase = "complete"; result.phase = "complete"; }
  return result;
}

// ── Leave screen (arc toward exit edge, accelerate out) ─────

function corioLeaveScreen(s: State, task: TaskConfig, screen: { w: number; h: number }): TickResult {
  const dir = task.direction ?? "right";
  const targetAngle = dir === "right" ? 0 : dir === "left" ? PI : dir === "down" ? HP : -HP;

  // Steer heading toward exit edge (arcing turn)
  let diff = targetAngle - s.heading;
  while (diff > PI) diff -= TWO_PI;
  while (diff < -PI) diff += TWO_PI;
  s.heading += diff * 0.07;

  // Accelerate
  s.speed = min(s.speed + 0.6, 35);

  const nx = s.anchor.x + cos(s.heading) * s.speed;
  const ny = s.anchor.y + sin(s.heading) * s.speed;
  // Update anchor to track cumulative position
  s.anchor.x = nx;
  s.anchor.y = ny;

  const off = nx < -200 || nx > screen.w + 200 || ny < -200 || ny > screen.h + 200;
  if (off) s.phase = "complete";
  return { x: nx, y: ny, phase: off ? "complete" : "perform" };
}

// ── Notify (fly in → swim along edge, loops until stopped) ──

function corioNotify(s: State, t: number, task: TaskConfig, screen: { w: number; h: number }): TickResult {
  const edgeIsHorizontal = task.direction === "up" || task.direction === "down";
  // Sweep ~40% of screen along the notification edge
  const span = (edgeIsHorizontal ? screen.w : screen.h) * 0.35;
  const wobble = 8;

  const result: TickResult = { x: s.anchor.x, y: s.anchor.y, phase: "perform" };

  if (edgeIsHorizontal) {
    result.x = s.anchor.x + sin(t * 1.4) * span;
    result.y = s.anchor.y + sin(t * 2.8) * wobble;
  } else {
    result.x = s.anchor.x + sin(t * 2.8) * wobble;
    result.y = s.anchor.y + sin(t * 1.4) * span;
  }

  // Loops continuously — stop() to end
  return result;
}

// ── Dance (wide, wandering screen-filling pattern) ──────────

function corioDance(s: State, t: number, _task: TaskConfig, screen: { w: number; h: number }): TickResult {
  const hw = screen.w * 0.45;
  const hh = screen.h * 0.38;
  const cx = screen.w / 2;
  const cy = screen.h / 2;
  return {
    x: cx + sin(t * 0.7) * cos(t * 0.15) * hw,
    y: cy + sin(t * 1.05) * Math.tanh(sin(t * 0.1) * 1.15) * hh,
    phase: "perform",
  };
}

// ── Text reveal sub-phases ──────────────────────────────────

function corioTextReveal(
  s: State,
  dt: number,
  screen: { w: number; h: number },
): TickResult {
  const task = s.task!;
  const left = task.textLeft!;
  const right = task.textRight!;
  const textY = task.textY!;
  const wc = task.wordCenters!;
  const speed = task.speed ?? 1;

  s.textElapsed += dt;
  const te = s.textElapsed;

  const out: TickResult = {
    x: s.anchor.x,
    y: s.anchor.y,
    phase: "perform",
    textSubPhase: s.textPhase,
    flashWordIdx: -1,
  };

  switch (s.textPhase) {
    // ── 1. Sweep: reveal text left → right ────────────────
    case "sweep": {
      const dur = 2200 / speed;
      const p = min(1, te / dur);
      const ep = eIO(p);

      out.x = lerp(left - 20, right + 30, ep);
      out.y = textY + sin(p * PI * 10) * 3;
      out.revealX = out.x + 10;

      if (p >= 1) { s.textPhase = "arc-return"; s.textElapsed = 0; }
      break;
    }

    // ── 2. Arc: overshoot right, big arc back to start ────
    case "arc-return": {
      const dur = 2200 / speed;
      const p = min(1, te / dur);

      const startX = right + 30;
      const endX = left - 20;
      const overshoot = 100;
      const arcH = screen.h * 0.28;

      if (p < 0.2) {
        // Continue right with upward arch
        const lp = p / 0.2;
        out.x = lerp(startX, startX + overshoot, eO(lp));
        out.y = textY - sin(lp * HP) * arcH * 0.35;
      } else {
        // Big sweeping arc back to beginning
        const lp = (p - 0.2) / 0.8;
        const ep = eIO(lp);
        out.x = lerp(startX + overshoot, endX, ep);
        out.y = textY - sin(lp * PI) * arcH;
      }

      if (p >= 1) { s.textPhase = "loop"; s.textElapsed = 0; }
      break;
    }

    // ── 3. Loop-de-loop at the beginning ──────────────────
    case "loop": {
      const dur = 650 / speed;
      const p = min(1, te / dur);

      const loopR = 32;
      const cx = left - 20;
      const cy = textY - loopR - 8;
      // Start from bottom, go clockwise
      const angle = -HP + p * TWO_PI;
      out.x = cx + cos(angle) * loopR;
      out.y = cy + sin(angle) * loopR;

      if (p >= 1) {
        s.textPhase = "bounce";
        s.textElapsed = 0;
        s.bounceIdx = 0;
        s.lastFlash = -1;
      }
      break;
    }

    // ── 4. Bounce: hop word-by-word, flash each ───────────
    case "bounce": {
      const msPerWord = 340 / speed;
      const totalDur = wc.length * msPerWord;
      const p = min(1, te / totalDur);

      const wp = p * wc.length;
      const idx = min(floor(wp), wc.length - 1);
      const within = wp - idx;

      const currX = wc[idx];
      const nextX = wc[min(idx + 1, wc.length - 1)];

      const bounceH = 40;
      const rest = 26;

      out.x = idx < wc.length - 1 ? lerp(currX, nextX, within) : currX;
      out.y = textY - rest - bounceH * sin(within * PI);
      out.bounceWordIdx = idx;

      if (idx !== s.lastFlash && within < 0.13) {
        s.lastFlash = idx;
      }
      out.flashWordIdx = s.lastFlash;

      if (p >= 1) { s.textPhase = "arc-back"; s.textElapsed = 0; }
      break;
    }

    // ── 5. Arc-back: arch over the text back to beginning ─
    case "arc-back": {
      const dur = 1800 / speed;
      const p = min(1, te / dur);

      const lastWx = wc[wc.length - 1] ?? right;
      const startX = lastWx;
      const endX = left - 20;
      const arcH = screen.h * 0.22;

      const ep = eIO(p);
      out.x = lerp(startX, endX, ep);
      out.y = textY - 26 - sin(p * PI) * arcH;
      out.textSubPhase = "arc-back";

      if (p >= 1) { s.textPhase = "drift-out"; s.textElapsed = 0; }
      break;
    }

    // ── 6. Drift-out: text fades, creature drifts gently ──
    case "drift-out": {
      const dur = 2000 / speed;
      const p = min(1, te / dur);

      // Gentle figure-8 drift while text fades
      const driftT = te * 0.001;
      const cx = screen.w * 0.3;
      const cy = screen.h * 0.45;
      out.x = lerp(left - 20, cx, eO(min(1, p * 1.5))) + sin(driftT * 2.0) * 30;
      out.y = lerp(textY - 26, cy, eO(min(1, p * 1.5))) + sin(driftT * 4.0) * 12;
      out.textSubPhase = "drift-out";

      if (p >= 1) { s.phase = "complete"; out.phase = "complete"; }
      break;
    }
  }

  return out;
}

// ── draw-arc: orbit the target for N revs, then spiral out to exit ──
function corioDrawArc(s: State, dt: number, task: TaskConfig): TickResult {
  const r0 = task.radius ?? 60;
  const dir = task.arcDir ?? 1;
  const revolutions = task.revolutions ?? 1;
  const exitMs = task.exitMs ?? 600;
  const exitRadiusMult = task.exitRadiusMult ?? 2.5;
  const speed = task.speed ?? 1;
  const omega = 0.0035 * speed * dir; // radians per ms

  s.drawArcSwept += Math.abs(omega) * dt;
  const angle = s.drawArcStartAngle + omega * s.elapsed;
  const targetSwept = revolutions * TWO_PI;

  // After N revolutions, grow radius outward — creature spirals off the viz.
  let r = r0;
  if (s.drawArcSwept > targetSwept) {
    const tAtTarget = targetSwept / Math.abs(omega);
    const exitElapsed = s.elapsed - tAtTarget;
    const ep = min(1, exitElapsed / exitMs);
    r = r0 * (1 + ep * (exitRadiusMult - 1));
    if (ep >= 1) {
      s.phase = "complete";
      return {
        x: s.anchor.x + cos(angle) * r,
        y: s.anchor.y + sin(angle) * r,
        phase: "complete",
      };
    }
  }

  return {
    x: s.anchor.x + cos(angle) * r,
    y: s.anchor.y + sin(angle) * r,
    phase: "perform",
  };
}

// ── draw-sweep: fly left→right with a wave, then continue off-right ──
function corioDrawSweep(s: State, task: TaskConfig): TickResult {
  const len = task.sweepLength ?? 160;
  const h = task.sweepHeight ?? 24;
  const exitMs = task.exitMs ?? 500;
  const speed = task.speed ?? 1;
  const dur = 1400 / speed;
  const target = task.target;

  const startX = s.anchor.x;
  const endX = target.x + len / 2;

  if (s.elapsed <= dur) {
    // Main sweep — left to right with a small overhead arch.
    const p = s.elapsed / dur;
    const ep = eIO(p);
    return {
      x: lerp(startX, endX, ep),
      y: target.y - sin(p * PI) * h,
      phase: "perform",
    };
  }

  // Exit — keep drifting right with a gentle upward curl.
  const exitElapsed = s.elapsed - dur;
  const ep = min(1, exitElapsed / exitMs);
  const out: TickResult = {
    x: endX + ep * 140,
    y: target.y - h * 0.5 - ep * 40,
    phase: "perform",
  };
  if (ep >= 1) {
    s.phase = "complete";
    out.phase = "complete";
  }
  return out;
}

// ── draw-path: visit each point, then continue past the last one ──
function corioDrawPath(s: State, current: { x: number; y: number }, task: TaskConfig): TickResult {
  const path = task.path ?? [];
  const arcH = task.arcHeight ?? 20;
  const pauseMs = task.pauseMs ?? 150;
  const exitMs = task.exitMs ?? 450;
  const speed = task.speed ?? 1;

  const out: TickResult = { x: current.x, y: current.y, phase: "perform" };

  // Past the last node — continue on current heading, then complete.
  if (s.drawPathIdx >= path.length) {
    // Use drawPauseUntil as our exit timer start marker
    if (s.drawPauseUntil === 0) s.drawPauseUntil = performance.now();
    const exitElapsed = performance.now() - s.drawPauseUntil;
    const ep = min(1, exitElapsed / exitMs);
    const last = path[path.length - 1];
    const prev = path[path.length - 2] ?? last;
    const dx = last.x - prev.x;
    const dy = last.y - prev.y;
    const d = hypot(dx, dy) || 1;
    out.x = last.x + (dx / d) * ep * 120;
    out.y = last.y + (dy / d) * ep * 120 - ep * 30;
    if (ep >= 1) {
      s.phase = "complete";
      out.phase = "complete";
    }
    return out;
  }

  const now = performance.now();
  if (now < s.drawPauseUntil) {
    const cur = path[s.drawPathIdx - 1] ?? path[0];
    out.x = cur.x;
    out.y = cur.y;
    return out;
  }

  const target = path[s.drawPathIdx];
  const prev = path[s.drawPathIdx - 1] ?? path[0];
  const dx = target.x - prev.x;
  const dy = target.y - prev.y;
  const segLen = hypot(dx, dy);
  const stepSpeed = 6 * speed;
  const cd = hypot(target.x - current.x, target.y - current.y);

  if (cd < 6) {
    // Arrived at this path node — pause, advance index
    s.drawPauseUntil = now + pauseMs;
    s.drawPathIdx++;
    out.x = target.x;
    out.y = target.y;
    if (s.drawPathIdx >= path.length) {
      // Reset to 0 so the exit block can mark its start time.
      s.drawPauseUntil = 0;
    }
    return out;
  }

  // Move along arc toward target — lift vertically at midpoint for arc effect
  const traveled = max(0, segLen - cd);
  const segP = segLen > 0 ? traveled / segLen : 0;
  const liftBias = sin(segP * PI) * arcH;

  const nx = current.x + (target.x - current.x) / max(1, cd) * stepSpeed;
  const ny = current.y + (target.y - current.y) / max(1, cd) * stepSpeed - liftBias * 0.08;
  out.x = nx;
  out.y = ny;
  return out;
}

// ── holding-pattern: fast spiral-in, brake into slow figure-8, hold forever ──
// Never completes — subsequent dispatches interrupt it.
function corioHoldingPattern(s: State, dt: number, task: TaskConfig): TickResult {
  const r0 = task.radius ?? 160;
  const entryR = task.entryRadius ?? r0 * 2;
  const entryLoops = task.entryLoops ?? 0.75;
  const dir = task.arcDir ?? 1;
  const speed = task.speed ?? 1;
  const omegaSpiral = 0.0055 * speed;  // fast spiral
  const omegaHold = 0.0012;            // slow after arrival
  const blendMs = 1000;                 // circle → figure-8 morph
  const figureSpeed = 0.3;              // slow lemniscate

  s.drawArcSwept += omegaSpiral * dt;
  const sweepLimit = entryLoops * TWO_PI;

  // ── Phase 1: spiral-in (fast, shrinking radius) ──────────
  if (s.drawArcSwept < sweepLimit) {
    const p = s.drawArcSwept / sweepLimit;
    const r = lerp(entryR, r0, eIO(p));
    const angle = s.drawArcStartAngle + s.drawArcSwept * dir;
    return {
      x: s.anchor.x + cos(angle) * r,
      y: s.anchor.y + sin(angle) * r,
      phase: "perform",
    };
  }

  // Time past the spiral phase
  const spiralEndMs = sweepLimit / omegaSpiral;
  const pastSpiralMs = s.elapsed - spiralEndMs;

  // Circle angle continues from spiral end, but at the slow hold rate.
  const lastSpiralAngle = s.drawArcStartAngle + sweepLimit * dir;
  const holdAngle = lastSpiralAngle + omegaHold * dir * pastSpiralMs;

  // Figure-8 (lemniscate) at slow speed.
  const hw = r0;
  const hh = hw * 0.4;
  const figT = pastSpiralMs * 0.001 * figureSpeed;
  const f8x = s.anchor.x + sin(figT * 2.2) * hw;
  const f8y = s.anchor.y + sin(figT * 4.4) * hh;

  // ── Phase 2: brake + morph circle → figure-8 ────────────
  if (pastSpiralMs < blendMs) {
    const blendP = eIO(pastSpiralMs / blendMs);
    const cx = s.anchor.x + cos(holdAngle) * r0;
    const cy = s.anchor.y + sin(holdAngle) * r0;
    return {
      x: lerp(cx, f8x, blendP),
      y: lerp(cy, f8y, blendP),
      phase: "perform",
    };
  }

  // ── Phase 3: pure slow figure-8 forever ─────────────────
  return { x: f8x, y: f8y, phase: "perform" };
}
