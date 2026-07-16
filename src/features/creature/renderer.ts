/**
 * PixiJS renderer — main loop, tentacle drawing, particles, head/eyes.
 * Movement driven by choreographer + mouse interaction system.
 */

import { Application, Graphics, Container, Text, TextStyle, BlurFilter } from "pixi.js";

// HMR cleanup removed — native manages lifecycle via Creature.stop() in onCleanup.
// Stub the register hooks so the original call sites still compile.
function registerApp(_app: Application) { /* noop in native */ }
function unregisterApp(_app: Application) { /* noop in native */ }
import { S, save } from "./store";
import { Tentacle, createTentacles, type Point } from "./tentacle";
import { emit, forEachLive, setField } from "../ambient-vfx/particles";
import { createChoreographer, type TaskConfig, type TickResult } from "./choreo";
import {
  createCompanions,
  tickCompanion,
  updateCompanionTentacles,
  emitCompanionParticles,
  type Companion,
} from "./companions";

// ── Math helpers ────────────────────────────────────────────
const PI = Math.PI;
const TWO_PI = PI * 2;
const HP = PI * 0.5;
const cos = Math.cos;
const sin = Math.sin;
const { hypot, atan2 } = Math;
function rnd(a: number, b: number) { return a + Math.random() * (b - a); }

/** HSL (h 0-360, s 0-1, l 0-1) → 0xRRGGBB */
function hsl(h: number, s: number, l: number): number {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return (Math.round((r + m) * 255) << 16)
       | (Math.round((g + m) * 255) << 8)
       |  Math.round((b + m) * 255);
}

// ── Scene interface ─────────────────────────────────────────

export interface Scene {
  app: Application;
  choreo: ReturnType<typeof createChoreographer>;
  dispatch(config: TaskConfig): void;
  spawnTink(): number; // returns new companion count (capped at 3)
  /** Current mother head position in screen pixels + current hue for
   *  color-matching effects (e.g. the voice-anchor glint). Returns null
   *  while she's parked off-screen (pre-start or post-exit). */
  getMotherPos(): { x: number; y: number; hue: number } | null;
  stop(): void;
  destroy(): void;
}

// ── Scene factory ───────────────────────────────────────────

export async function createScene(container: HTMLElement): Promise<Scene> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  container.appendChild(app.canvas);
  registerApp(app);

  // ── Graphics layers ───────────────────────────────────
  const particleGfx = new Graphics();
  const tentacleGfx = new Graphics();
  const headGfx = new Graphics();
  const textContainer = new Container();

  const mainContainer = new Container();
  const glowContainer = new Container();
  const glowTentacleGfx = new Graphics();
  const glowHeadGfx = new Graphics();

  glowContainer.addChild(glowTentacleGfx, glowHeadGfx);
  glowContainer.filters = [new BlurFilter({ strength: 6, quality: 2 })];
  glowContainer.alpha = 0.35;

  mainContainer.addChild(particleGfx, tentacleGfx, headGfx);
  app.stage.addChild(glowContainer, mainContainer, textContainer);

  // ── State ─────────────────────────────────────────────
  // Seed the creature OFF-SCREEN above the notification edge so the initial
  // render is blank. `start()` then dispatches leave-screen as a no-op — the
  // creature stays tucked until a real event (claude-start / tts-open) brings
  // it on. Without this offset the tentacles would pop in at screen-center
  // for a frame before animating out.
  const OFFSCREEN_Y = -300;
  const center = { x: app.screen.width / 2, y: OFFSCREEN_Y };
  const prevCenter = { x: center.x, y: center.y };
  let smx = center.x, smy = center.y;
  const mouse = { x: app.screen.width / 2, y: app.screen.height / 2 };
  let demo = true;
  const t0 = performance.now();
  const tentacles = createTentacles(center.x, center.y);
  const companions: Companion[] = createCompanions(center.x, center.y);

  // ── Mouse interaction state ───────────────────────────
  type MouseMode = "none" | "watching" | "approaching" | "orbiting" | "dancing";
  let mouseMode: MouseMode = "none";
  let mouseElapsed = 0;
  let mouseOrbitAngle = 0;

  // Track if creature has exited — stays off-screen until a new task.
  // Starts true: the seeded position is already offscreen (center.y = -300),
  // so the first-frame render should skip animation and hold position.
  let offScreen = true;

  // ── Animation polish state ────────────────────────────
  // Anticipation: short reverse motion before a task's transit begins.
  let anticipationMs = 0;
  let anticipationDir = { x: 0, y: 0 };
  let anticipationPending: TaskConfig | null = null;

  // ── Gesture chunking: enforce a rest-beat between tasks ──
  let taskLockUntil = 0;

  // ── Choreographer ─────────────────────────────────────
  const choreo = createChoreographer();

  // ── Text reveal objects ───────────────────────────────
  let tcWordContainer: Container | null = null;
  let tcMask: Graphics | null = null;
  let tcWordTexts: Text[] = [];

  function textColor() {
    return hsl(S.hue, Math.max(0.3, S.saturation), Math.max(0.5, S.lightness));
  }

  function cleanupText() {
    if (tcWordContainer) {
      tcWordContainer.mask = null;
      tcWordContainer.destroy({ children: true });
      tcWordContainer = null;
    }
    if (tcMask) {
      tcMask.destroy();
      tcMask = null;
    }
    tcWordTexts = [];
  }

  function prepareTextReveal(config: TaskConfig) {
    cleanupText();

    const text = config.text ?? "I HAVE ALWAYS EXISTED AND THE SIMULATION NEVER ENDS";
    const cw = app.screen.width, ch = app.screen.height;
    const fontSize = Math.max(14, ch * 0.03) | 0;
    const style = new TextStyle({
      fontFamily: "monospace", fontSize,
      fill: textColor(), letterSpacing: 3,
    });

    const spaceT = new Text({ text: " ", style });
    const spaceW = spaceT.width;
    spaceT.destroy();

    const words = text.split(" ");
    const tmpTexts: Text[] = [];
    let totalW = 0;
    for (const word of words) {
      const txt = new Text({ text: word, style: style.clone() });
      txt.anchor.set(0, 0.5);
      tmpTexts.push(txt);
      totalW += txt.width;
    }
    totalW += spaceW * (words.length - 1);

    const textLeft = (cw - totalW) / 2;
    const textRight = textLeft + totalW;
    const textY = ch * 0.45;

    tcWordContainer = new Container();
    tcMask = new Graphics();
    tcMask.rect(0, 0, 0, ch);
    tcMask.fill(0xffffff);
    textContainer.addChild(tcWordContainer);
    // Mask must be in scene graph for PixiJS but we keep it hidden
    app.stage.addChild(tcMask);
    tcMask.renderable = false;
    tcWordContainer.mask = tcMask;

    const wordCenters: number[] = [];
    let cursor = textLeft;
    for (let i = 0; i < tmpTexts.length; i++) {
      tmpTexts[i].position.set(cursor, textY);
      tmpTexts[i].alpha = 0.85;
      tcWordContainer.addChild(tmpTexts[i]);
      wordCenters.push(cursor + tmpTexts[i].width / 2);
      cursor += tmpTexts[i].width + spaceW;
    }
    tcWordTexts = tmpTexts;

    config.text = text;
    config.textLeft = textLeft;
    config.textRight = textRight;
    config.textY = textY;
    config.wordCenters = wordCenters;
    config.target = { x: textLeft - 30, y: textY };
    // No hard snap — arc transit steers creature to start position
  }

  function updateTextReveal(r: TickResult) {
    if (!tcWordContainer) return;

    switch (r.textSubPhase) {
      case "sweep": {
        if (tcMask) {
          tcMask.renderable = true;
          tcMask.clear();
          tcMask.rect(0, 0, r.revealX ?? 0, app.screen.height);
          tcMask.fill(0xffffff);
        }
        break;
      }

      case "arc-return":
      case "loop": {
        // Text fully revealed — remove mask
        if (tcWordContainer.mask) {
          tcWordContainer.mask = null;
          if (tcMask) { tcMask.renderable = false; }
        }
        break;
      }

      case "bounce": {
        const normal = textColor();
        for (let i = 0; i < tcWordTexts.length; i++) {
          const txt = tcWordTexts[i];
          txt.style.fill = normal;
          if (i === r.flashWordIdx) {
            txt.scale.set(1.05);
            txt.alpha = 1;
          } else {
            txt.scale.set(1);
            txt.alpha = i <= (r.bounceWordIdx ?? 0) ? 0.85 : 0.55;
          }
        }
        break;
      }

      case "arc-back": {
        // Text stays visible, settle all words to uniform style
        const normal = textColor();
        for (let i = 0; i < tcWordTexts.length; i++) {
          tcWordTexts[i].style.fill = normal;
          tcWordTexts[i].scale.set(1);
          tcWordTexts[i].alpha = 0.8;
        }
        break;
      }

      case "drift-out": {
        // Text fades out gently
        for (const t of tcWordTexts) {
          t.alpha = Math.max(0, t.alpha - 0.012);
        }
        break;
      }
    }
  }

  // ── Auto-detect nearest screen edge ───────────────────
  function nearestEdge(pos: { x: number; y: number }): "left" | "right" | "up" | "down" {
    const cw = app.screen.width, ch = app.screen.height;
    const d = { left: pos.x, right: cw - pos.x, up: pos.y, down: ch - pos.y };
    let best: "left" | "right" | "up" | "down" = "right";
    let bestD = Infinity;
    for (const [dir, dist] of Object.entries(d) as ["left"|"right"|"up"|"down", number][]) {
      if (dist < bestD) { bestD = dist; best = dir; }
    }
    return best;
  }

  // ── Public dispatch / stop ────────────────────────────
  // All dispatch paths funnel into `executeDispatch` so anticipation can
  // wrap them uniformly — we flick away from the target for ~200ms, then
  // kick off the real choreo dispatch.
  function executeDispatch(config: TaskConfig) {
    if (config.type === "text-reveal") {
      prepareTextReveal(config);
    } else if (config.type === "leave-screen") {
      if (!config.direction) config.direction = S.notifyEdge;
    } else if (config.type === "notify") {
      const edge = config.direction ?? S.notifyEdge;
      config.direction = edge;
      const cw = app.screen.width, ch = app.screen.height;
      const margin = 70;
      if (edge === "right")     config.target = { x: cw - margin, y: ch / 2 };
      else if (edge === "left") config.target = { x: margin, y: ch / 2 };
      else if (edge === "up")   config.target = { x: cw / 2, y: margin };
      else                      config.target = { x: cw / 2, y: ch - margin };
    }
    choreo.dispatch(config, { ...center }, { ...prevCenter });
  }

  function dispatch(config: TaskConfig) {
    // Gesture chunking: refuse dispatch during rest-beat.
    if (S.gestureChunking && performance.now() < taskLockUntil) return;

    cleanupText();
    mouseMode = "none";
    offScreen = false;
    // Cancel any in-progress anticipation from a previous task.
    anticipationMs = 0;

    // Anticipation: crouch away from the target for 200ms before dispatching.
    // Only meaningful when there's a target far enough to define a direction.
    if (S.anticipation && config.target) {
      const dx = config.target.x - center.x;
      const dy = config.target.y - center.y;
      const d = Math.hypot(dx, dy);
      if (d > 40) {
        anticipationDir.x = -dx / d;
        anticipationDir.y = -dy / d;
        anticipationMs = 200;
        anticipationPending = config;
        return;
      }
    }

    executeDispatch(config);
  }

  function stop() {
    choreo.stop();
    cleanupText();
    anticipationMs = 0;
    anticipationPending = null;
  }

  // ── Curve drawing ─────────────────────────────────────
  function drawCurve(g: Graphics, pts: Point[]) {
    for (let i = 1; i < pts.length - 2; i++) {
      const a = pts[i], b = pts[i + 1];
      g.quadraticCurveTo(a.x, a.y, (a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
    }
    const i = pts.length - 2;
    const a = pts[i], b = pts[i + 1];
    if (a && b) g.quadraticCurveTo(a.x, a.y, b.x, b.y);
  }

  // Draw a creature's head + eyes at (x,y) with size multiplier `scale`.
  // Eyes track `lookAt`. If `gGlow` is non-null, a matching shape is
  // painted into the glow layer.
  function drawHead(
    g: Graphics,
    gGlow: Graphics | null,
    x: number,
    y: number,
    scale: number,
    lookAt: { x: number; y: number },
  ) {
    const headColor = hsl(S.hue, S.saturation, S.lightness);
    const headR = (S.headRadius + S.thickness) * scale;

    g.circle(x, y, headR);
    g.fill({ color: headColor });
    if (gGlow && S.glowAmount > 0) {
      gGlow.circle(x, y, headR);
      gGlow.fill({ color: headColor });
    }

    const eR = Math.max(0.5, S.headRadius * 0.22 * scale);
    const eOff = S.headRadius * 0.34 * scale;
    const ea = atan2(lookAt.y - y, lookAt.x - x);
    const eyeColor = hsl(S.hue, 0.9, 0.75);

    for (const angle of [ea + 0.45, ea - 0.45]) {
      const ex = x + cos(angle) * eOff;
      const ey = y + sin(angle) * eOff;

      g.circle(ex, ey, eR * 3);
      g.fill({ color: eyeColor, alpha: 0.3 });
      g.circle(ex, ey, eR * 1.5);
      g.fill({ color: eyeColor, alpha: 0.7 });
      g.circle(ex, ey, eR);
      g.fill({ color: 0xffffff });

      if (gGlow && S.glowAmount > 0) {
        gGlow.circle(ex, ey, eR * 3);
        gGlow.fill({ color: eyeColor, alpha: 0.6 });
      }
    }
  }

  function drawTentacle(g: Graphics, t: Tentacle) {
    if (t.outer.length < 2) return;
    const s = t.outer[0], e = t.inner[0];
    const h = S.hue * t.shade;
    const sat = S.saturation * t.shade;
    const v = S.lightness * t.shade;
    const fillColor = hsl(h, Math.min(1, sat), Math.min(1, v));

    g.moveTo(s.x, s.y);
    drawCurve(g, t.outer);
    drawCurve(g, [...t.inner].reverse());
    g.lineTo(e.x, e.y);
    g.closePath();
    g.fill({ color: fillColor });

    if (S.thickness > 1) {
      const strokeColor = hsl(h, Math.min(1, sat), Math.max(0, Math.min(1, v - 0.12)));
      g.stroke({ width: 0.4, color: strokeColor });
    }
  }

  // ── Input ─────────────────────────────────────────────
  app.canvas.addEventListener("mousemove", (e: MouseEvent) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  // Follow-mouse is toggled via the GUI, not by clicking the canvas

  // ── Mouse interaction system ──────────────────────────
  function tickMouse(dt: number) {
    if (choreo.active) { mouseMode = "none"; return; }

    const md = hypot(center.x - mouse.x, center.y - mouse.y);

    switch (mouseMode) {
      case "none":
        if (md < 200) { mouseMode = "watching"; mouseElapsed = 0; }
        break;

      case "watching": {
        if (md > 280) { mouseMode = "none"; break; }
        // Lean gently toward mouse
        const pull = (200 - Math.min(md, 200)) / 200 * 0.012;
        center.x += (mouse.x - center.x) * pull;
        center.y += (mouse.y - center.y) * pull;
        if (md < 80) { mouseMode = "approaching"; mouseElapsed = 0; }
        break;
      }

      case "approaching": {
        if (md > 300) { mouseMode = "none"; break; }
        center.x += (mouse.x - center.x) * 0.045;
        center.y += (mouse.y - center.y) * 0.045;
        if (md < 30) {
          mouseMode = "orbiting";
          mouseElapsed = 0;
          mouseOrbitAngle = atan2(center.y - mouse.y, center.x - mouse.x);
        }
        break;
      }

      case "orbiting": {
        if (md > 350) { mouseMode = "none"; break; }
        mouseElapsed += dt;
        mouseOrbitAngle += dt * 0.004;
        const orbitR = 45;
        const tx = mouse.x + cos(mouseOrbitAngle) * orbitR;
        const ty = mouse.y + sin(mouseOrbitAngle) * orbitR;
        center.x += (tx - center.x) * 0.09;
        center.y += (ty - center.y) * 0.09;
        if (mouseElapsed > 3000) { mouseMode = "dancing"; mouseElapsed = 0; }
        break;
      }

      case "dancing": {
        if (md > 400) { mouseMode = "none"; break; }
        mouseElapsed += dt;
        const dp = mouseElapsed * 0.001;
        // Zigzag + tightening spiral
        const danceR = 55 * Math.max(0, 1 - dp / 2.5);
        const danceA = dp * PI * 7;
        const tx = mouse.x + cos(danceA) * danceR;
        const ty = mouse.y + sin(danceA) * danceR * 0.6;
        center.x += (tx - center.x) * 0.11;
        center.y += (ty - center.y) * 0.11;
        if (mouseElapsed > 2500) { mouseMode = "orbiting"; mouseElapsed = 0; }
        break;
      }
    }
  }

  // ── Main tick ─────────────────────────────────────────
  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS;
    const t = performance.now() - t0;
    const cw = app.screen.width, ch = app.screen.height;

    // Snapshot position before movement for heading inference
    prevCenter.x = center.x;
    prevCenter.y = center.y;

    // ── Anticipation: brief reverse motion before a task begins.
    // While the timer is running we take exclusive control of `center` so
    // the previous task's choreo.tick doesn't overwrite the back-step.
    if (anticipationMs > 0) {
      anticipationMs -= dt;
      center.x += anticipationDir.x * 1.8;
      center.y += anticipationDir.y * 1.8;
      if (anticipationMs <= 0 && anticipationPending) {
        executeDispatch(anticipationPending);
        anticipationPending = null;
      }
    } else

    // ── Movement ────────────────────────────────────────
    if (choreo.active) {
      const r = choreo.tick(dt, center, { w: cw, h: ch });

      // Transit + leave-screen use direct positions (they do their own steering);
      // other perform tasks use light smoothing so tentacles trail nicely
      const direct = r.phase === "transit" || choreo.task?.type === "leave-screen";
      if (direct) {
        center.x = r.x;
        center.y = r.y;
      } else {
        center.x += (r.x - center.x) * 0.18;
        center.y += (r.y - center.y) * 0.18;
      }

      if (choreo.task?.type === "text-reveal") {
        updateTextReveal(r);
      }

      // Mouse hover near tink during notify → trigger text reveal
      if (choreo.task?.type === "notify") {
        const md = hypot(center.x - mouse.x, center.y - mouse.y);
        if (md < 120) {
          dispatch({ type: "text-reveal", target: { x: 0, y: 0 }, text: "I HAVE ALWAYS EXISTED AND THE SIMULATION NEVER ENDS" });
          return;
        }
      }

      // Mouse hover near tink during drift → exit off screen
      if (choreo.task?.type === "idle-figure8") {
        const md = hypot(center.x - mouse.x, center.y - mouse.y);
        if (md < 120) {
          dispatch({ type: "leave-screen", target: { x: 0, y: 0 } });
          return;
        }
      }

      if (r.phase === "complete") {
        const taskType = choreo.task?.type;
        if (taskType === "leave-screen") {
          offScreen = true;
        }
        cleanupText();

        // After text-reveal, auto-start a drift from current position
        if (taskType === "text-reveal") {
          dispatch({ type: "idle-figure8", target: { x: center.x, y: center.y }, radius: 200 });
        }
      }
    } else if (offScreen) {
      // Creature is off-screen after EXIT — hold position, do nothing
    } else if (S.interactive) {
      smx += (mouse.x - smx) * 0.12;
      smy += (mouse.y - smy) * 0.12;
      center.x += (smx - center.x) * 0.055;
      center.y += (smy - center.y) * 0.055;
      // Mouse proximity still applies on top
      tickMouse(dt);
    } else {
      // Idle — hold position, respond to mouse proximity
      tickMouse(dt);
    }

    // ── Update tentacles ────────────────────────────────
    const step = TWO_PI / S.tentacles;
    for (let i = 0; i < S.tentacles; i++) {
      const tnt = tentacles[i];
      if (!tnt) continue;
      const th = i * step;
      tnt.move(center.x + cos(th) * S.headRadius, center.y + sin(th) * S.headRadius);
      tnt.update();
    }

    // ── Emit particles ──────────────────────────────────
    const rate = Math.ceil(S.particleRate);
    for (let e = 0; e < rate; e++) {
      const ti = Math.floor(Math.random() * S.tentacles);
      const tnt = tentacles[ti];
      if (!tnt || tnt.nodes.length < 2) continue;
      const ni = Math.min(Math.floor(tnt.len * 0.5 + Math.random() * tnt.len * 0.5), tnt.len - 1);
      const nd = tnt.nodes[ni];
      emit(nd.x, nd.y, nd.vx, nd.vy);
    }

    // ── Companions: physics + emission ──────────────────
    // (Drawn later, after parent — but emission must run before
    // tickParticles() so companion sparkles show up this frame.)
    if (S.companions) {
      const parentVx = center.x - prevCenter.x;
      const parentVy = center.y - prevCenter.y;
      const parentState = { x: center.x, y: center.y, vx: parentVx, vy: parentVy };
      const nowMs = performance.now();
      const visible = Math.min(S.companionCount, companions.length);
      for (let i = 0; i < visible; i++) {
        const c = companions[i];
        tickCompanion(c, parentState, companions.slice(0, visible), dt, nowMs);
        updateCompanionTentacles(c);
        emitCompanionParticles(c);
      }
    }

    // ── Draw particles ──────────────────────────────────
    // Physics ticks on the shared pool's own rAF loop (ambient-vfx/
    // particles.ts). We only need to push the creature's live
    // wind/gravity into the shared module and then iterate live
    // particles for drawing. All emission sources (tentacle tips,
    // companions, voice anchor, STT word cloud) feed the same pool,
    // so a single pass here renders the whole system.
    setField(S.wind, S.gravity);
    particleGfx.clear();
    const sz = Math.max(1, Math.round(S.particleSize));
    const halfSz = sz >> 1;
    const pColor = hsl(S.hue, S.saturation, S.lightness);
    forEachLive((x, y, alpha) => {
      if (alpha < 0.03) return; // skip near-invisible particles
      const px = Math.round(x) - halfSz;
      const py = Math.round(y) - halfSz;
      particleGfx.rect(px, py, sz, sz);
      particleGfx.fill({ color: pColor, alpha });
    });

    // ── Draw tentacles ──────────────────────────────────
    tentacleGfx.clear();
    glowTentacleGfx.clear();
    for (let i = 0; i < S.tentacles; i++) {
      const tnt = tentacles[i];
      if (!tnt) continue;
      drawTentacle(tentacleGfx, tnt);
      if (S.glowAmount > 0) drawTentacle(glowTentacleGfx, tnt);
    }

    // ── Draw parent head + eyes (eyes track mouse when nearby) ─
    headGfx.clear();
    glowHeadGfx.clear();
    const mouseDist = hypot(center.x - mouse.x, center.y - mouse.y);
    const eyeLookAt = mouseDist < 500
      ? { x: mouse.x, y: mouse.y }
      : { x: cw / 2, y: ch / 2 };

    drawHead(headGfx, glowHeadGfx, center.x, center.y, 1, eyeLookAt);

    // ── Companions: draw tentacles + heads ──────────────
    if (S.companions) {
      const visible = Math.min(S.companionCount, companions.length);
      for (let i = 0; i < visible; i++) {
        const c = companions[i];
        const count = Math.min(S.tentacles, c.tentacles.length);
        for (let j = 0; j < count; j++) {
          drawTentacle(tentacleGfx, c.tentacles[j]);
          if (S.glowAmount > 0) drawTentacle(glowTentacleGfx, c.tentacles[j]);
        }
        // Companions gaze at the parent — reinforces "following" feel
        drawHead(headGfx, glowHeadGfx, c.x, c.y, c.scale, center);
      }
    }

    // ── Glow strength ───────────────────────────────────
    const blur = glowContainer.filters?.[0] as BlurFilter | undefined;
    if (blur) blur.strength = Math.max(1, S.glowAmount * 0.25);
    glowContainer.alpha = S.glowAmount > 0 ? Math.min(0.6, S.glowAmount * 0.015) : 0;
  });

  function spawnTink(): number {
    const cap = Math.min(3, companions.length);
    if (S.companionCount >= cap) return S.companionCount;
    const idx = S.companionCount;
    const c = companions[idx];
    // Seed the new tink at the parent's current position so it reads as
    // emerging from mother rather than teleporting in from stale coords.
    c.x = center.x;
    c.y = center.y;
    c.vx = 0;
    c.vy = 0;
    c.loopCenter.x = center.x;
    c.loopCenter.y = center.y;
    S.companionCount = idx + 1;
    return S.companionCount;
  }

  return {
    app, choreo, dispatch, spawnTink, stop,
    getMotherPos: () => (offScreen ? null : { x: center.x, y: center.y, hue: S.hue }),
    destroy: () => {
      cleanupText();
      unregisterApp(app);
      app.destroy(true, { children: true });
    },
  };
}
