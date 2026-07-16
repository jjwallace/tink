/**
 * Voice anchor — draggable button that marks the speaking position.
 *
 * DOM stack (bottom → top):
 *   particleCanvas (z:0)   — creature-style pixel particles (edge drizzle + click bursts)
 *   icon (z:1)             — static creature sprite
 *   arrows (z:2)           — 4 blocky SVG arrows; hidden behind icon, GSAP-tween out on hover
 *   core (z:3)             — border ring; invisible by default, visible on hover; red when muted
 *
 * Interactions:
 *   hover       → core fades in; arrows slide out from center to cardinal edges
 *   unhover     → arrows slide back behind icon; core fades out (unless muted)
 *   quick click → toggle mute (work_mode: muted ↔ iterate) + burst
 *   press+drag  → move anchor, persist to settings, emit live updates
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import gsap from "gsap";
import { emit as emitParticle, forEachLive as forEachParticle } from "../ambient-vfx/particles";
import { playSfx, startLoopSfx, stopLoopSfx, setMuted } from "../../sounds";

export interface AnchorPos {
  fx: number;
  fy: number;
  x: number;
  y: number;
}

const CLICK_DRAG_THRESHOLD_PX = 5;
const CLICK_DRAG_THRESHOLD_MS = 200;
// Hit zone is deliberately much larger than the visible orb — pointer
// events land anywhere within `SIZE` × `SIZE` but only `SIZE - 2·CORE_INSET`
// is painted. Visible orb (disc) stays 54 px; hit zone expanded for easy
// grabbing without enlarging the button visually.
const SIZE = 170;
const CORE_INSET = 50;
const EDGE_SPAWN_MIN = 30;       // particles spawn just inside/on the ring
const EDGE_SPAWN_MAX = 42;
const PARTICLE_SIZE = 1.8;
const ARROW_EXPAND_DIST = 80;

// ── Mother glint — specular highlight pointing at the creature ──
// Visible orb disc is 54 px (27 px radius). The glint sits just inside that
// radius on the angle from anchor→mother and softly fades across the orb
// boundary: fully visible outside, fully hidden when she's deep inside the
// footprint ("behind" the orb). Colour is tinted by the mother's hue so
// the reflection picks up a hint of her rather than reading as pure white.
const ORB_RADIUS = 27;                    // visible disc half-size
const GLINT_RADIUS = ORB_RADIUS * 0.78;   // where the glint sits on the orb surface
const OCCLUSION_INNER = ORB_RADIUS * 0.55; // below this distance: fully hidden
const OCCLUSION_OUTER = ORB_RADIUS * 1.05; // at/above this distance: no occlusion
const GLINT_FULL_BRIGHT_DIST = 70;        // outer-distance (from orb edge) at which brightness caps
const GLINT_FADE_DIST = 320;              // beyond this outer-distance, glint is invisible
const GLINT_PEAK_OPACITY = 0.95;

const ARROW_SVG = `
  <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2 L22 12 L17 12 L17 22 L7 22 L7 12 L2 12 Z"
          fill="rgba(255,255,255,0.95)"
          stroke="rgba(0,0,0,0.35)" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>`;

// Four cardinal offsets (x, y) and css rotations.
const ARROW_PLACEMENTS = [
  { dx:  0, dy: -ARROW_EXPAND_DIST, rot:   0 },  // up
  { dx:  0, dy:  ARROW_EXPAND_DIST, rot: 180 },  // down
  { dx: -ARROW_EXPAND_DIST, dy:  0, rot: 270 },  // left
  { dx:  ARROW_EXPAND_DIST, dy:  0, rot:  90 },  // right
];

// During drag the 4 arrows orbit as a rigid quartet around the anchor
// center. Index 0 (the "up" arrow at rest) always lands aligned with
// the drag direction after the orbit, so it's the primary pointer at
// full opacity. The other three dim to a faint ghost so the direction
// indicator dominates visually — they're still there as a hint that
// you're free to move in any of the four cardinal directions, but
// barely perceptible compared to the active pointer.
const DRAG_ARROW_OPACITY = [1.0, 0.05, 0.08, 0.08];

export class VoiceAnchor {
  private container: HTMLElement;
  private root: HTMLDivElement;
  private core: HTMLDivElement;
  // Floating label that pops up above the anchor on mode-cycle (MUTED /
  // FOCUS / ITERATE). Fades in on click, holds briefly, fades out.
  private modeLabel: HTMLDivElement;
  private arrowEls: HTMLDivElement[] = [];
  // Particles live on the shared ambient-vfx pool (one engine for the
  // whole app). Physics ticks in that module; we just emit from the
  // edge-drizzle spawner and read via forEachParticle for our local
  // canvas draw.
  private rafId = 0;
  private lastSpawn = 0;
  private fx: number;
  private fy: number;
  private hovering = false;
  private dragging = false;
  private didDrag = false;
  // True between mousedown and mouseup. Guards onHoverLeave so a click
  // that moves the cursor slightly outside the DOM hit zone before mouseup
  // doesn't prematurely release the interactive pin — which would send the
  // window back to click-through and lose the mouseup event entirely.
  private pressing = false;
  // ── Inertia / throw-physics state ────────────────────────────────
  // When the user releases mid-drag, we keep the anchor drifting with
  // exponential damping + wall bouncing ("throw to move"). Velocity is
  // stored in fraction-of-screen per second so the feel is consistent
  // across resolutions. inertiaRaf tracks the active physics loop so
  // a new mousedown can cancel it.
  private inertiaRaf = 0;
  private velX = 0;
  private velY = 0;
  private mode: "iterate" | "focus" | "muted" = "iterate";
  // Tween that pulses the iterate-mode bright-green border. Killed
  // and recreated when entering iterate mode; nulled out when
  // leaving (focus / muted shouldn't pulse green).
  private iteratePulseTween: gsap.core.Tween | null = null;
  // SVG ring + tween for focus mode's marching-ants effect. CSS
  // borders can't animate dash offset, so we overlay an SVG circle
  // and animate stroke-dashoffset directly.
  private focusRing: SVGSVGElement | null = null;
  private focusRingCircle: SVGCircleElement | null = null;
  private focusMarchTween: gsap.core.Tween | null = null;
  private listeners: ((pos: AnchorPos) => void)[] = [];
  private dragStartListeners: ((pos: AnchorPos) => void)[] = [];
  private dragEndListeners: ((pos: AnchorPos) => void)[] = [];
  // Glint — a tiny "specular reflection" dot that tracks the mother's
  // position. Provider is pull-based so the anchor can poll per-frame from
  // its existing RAF loop without any subscription plumbing.
  private glint: HTMLDivElement;
  private glintOpacity = 0;      // current (smoothed toward target each tick)
  private targetGlintOpacity = 0;
  private motherPosProvider:
    | (() => { x: number; y: number; hue?: number } | null)
    | null = null;
  private glintHue = -1; // cached last-applied hue — rebuild gradient only on change
  // Last observed `occlusion` scalar (0..1) from updateGlint(). Kept so
  // the transition-edge logic below reads cleanly even though the flare
  // that used to react to it has been removed.
  private prevOcclusion = 1;
  // Disabled state — when `true` the anchor is docked at the corner as
  // a small pip; the next click re-enables instead of toggling mute.
  private disabled = false;
  private disabledRestore: { fx: number; fy: number } | null = null;

  constructor(container: HTMLElement, initial: { fx: number; fy: number }) {
    this.container = container;
    // Prefer localStorage for instant recall (before settings invoke returns),
    // fall back to the Rust-provided initial if localStorage is empty or stale.
    const ls = readLocalAnchor();
    this.fx = ls?.fx ?? initial.fx;
    this.fy = ls?.fy ?? initial.fy;

    // If localStorage supplied the position, write it back to Rust settings
    // immediately. The proximity poll reads voice_anchor_x/y from Rust settings
    // to decide when to enable cursor events — if localStorage and Rust settings
    // diverged (e.g. process killed mid-drag-save), the poll looks in the wrong
    // spot and the window stays click-through, breaking all mouse interaction.
    if (ls && (Math.abs(ls.fx - initial.fx) > 0.001 || Math.abs(ls.fy - initial.fy) > 0.001)) {
      invoke("update_setting", { key: "voice_anchor_x", value: this.fx.toFixed(4) }).catch(() => {});
      invoke("update_setting", { key: "voice_anchor_y", value: this.fy.toFixed(4) }).catch(() => {});
    }

    this.root = document.createElement("div");
    Object.assign(this.root.style, {
      position: "absolute",
      width: `${SIZE}px`,
      height: `${SIZE}px`,
      "pointer-events": "auto",
      cursor: "grab",
      "z-index": "99998",
      "user-select": "none",
    } as Partial<CSSStyleDeclaration>);
    container.appendChild(this.root);
    // Center the element on its (left, top) anchor point using GSAP so
    // subsequent y/x animations don't fight with a raw translate(-50%, -50%).
    gsap.set(this.root, { xPercent: -50, yPercent: -50 });

    // Particles used to live on a local Canvas2D here; migrated to the
    // shared ambient-vfx pool (rendered by creature's Pixi stage).
    // spawnEdgeParticle + burst emit into that shared pool instead.

    // Opaque disc BEHIND the icon so the PNG's transparent areas don't look
    // see-through against the Tauri transparent window.
    const disc = document.createElement("div");
    Object.assign(disc.style, {
      position: "absolute",
      width: "54px",
      height: "54px",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      "border-radius": "50%",
      background: "radial-gradient(circle at 40% 40%, rgba(50,30,80,1), rgba(18,10,30,1) 100%)",
      "z-index": "1",
      "pointer-events": "none",
      "box-shadow": "inset 0 0 10px rgba(0,0,0,0.6)",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(disc);

    // Icon sprite — static, centered, above the disc
    const icon = document.createElement("img");
    icon.src = "/assets/tink-plain.png";
    icon.draggable = false;
    Object.assign(icon.style, {
      position: "absolute",
      width: "54px",
      height: "54px",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      "border-radius": "50%",
      "object-fit": "cover",
      "z-index": "2",
      "pointer-events": "none",
      opacity: "1",
      filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(icon);

    // Arrows — 4 blocky SVGs, tucked BEHIND the icon/disc at z:0 so they peek
    // out from behind as they GSAP-expand outward on hover instead of popping
    // in front. Particle canvas is also z:0 but sits on root, not the disc —
    // they don't visually stack.
    for (const p of ARROW_PLACEMENTS) {
      const el = document.createElement("div");
      el.innerHTML = ARROW_SVG;
      Object.assign(el.style, {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "22px",
        height: "22px",
        opacity: "0",
        "pointer-events": "none",
        "z-index": "0",
      } as Partial<CSSStyleDeclaration>);
      this.root.appendChild(el);
      // Register the centering offset + base rotation/scale with GSAP
      // up front, so subsequent x/y/rotation/scale tweens compose with
      // a consistent transform pipeline. Using an inline CSS transform
      // here causes GSAP to drop the -50%/-50% centering when it
      // parses the initial state, which is why drag rotations looked
      // offset from the true centre.
      gsap.set(el, {
        xPercent: -50,
        yPercent: -50,
        x: 0,
        y: 0,
        rotation: p.rot,
        scale: 0.5,
      });
      this.arrowEls.push(el);
    }

    // Core circle — tight border ring around the icon. Invisible by default,
    // fades in on hover. When muted: always visible with a thick red border.
    this.core = document.createElement("div");
    Object.assign(this.core.style, {
      position: "absolute",
      inset: `${CORE_INSET}px`,
      "border-radius": "50%",
      border: "1.8px solid rgba(255,255,255,0.7)",
      "box-shadow": "0 0 22px rgba(167,139,250,0.55), inset 0 0 12px rgba(255,255,255,0.14)",
      opacity: "0",
      "z-index": "4",
      "pointer-events": "none",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.core);

    // SVG marching-ants ring used by focus mode. Always present in the
    // DOM but hidden until focus is active. GSAP rotates it slowly
    // clockwise so the dash pattern reads as marching ants. Sized to
    // match the core element so the dashes sit on the orb's edge.
    {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 100 100");
      Object.assign(svg.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        display: "none",
        "pointer-events": "none",
        // Rotation pivot at the center so GSAP rotation looks balanced.
        "transform-origin": "50% 50%",
      } as Partial<CSSStyleDeclaration>);
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "50");
      circle.setAttribute("cy", "50");
      circle.setAttribute("r", "48"); // slight inset so stroke doesn't clip
      circle.setAttribute("fill", "none");
      circle.setAttribute("stroke", "rgba(255, 70, 70, 0.9)");
      circle.setAttribute("stroke-width", "3.5");
      // pathLength=100 lets us spec dash pattern in percentages of the
      // circumference. With "4 6" (4% dash, 6% gap), 10 evenly-spaced
      // dashes fit perfectly (10 × 10% = 100). Without pathLength the
      // raw 301px circumference doesn't divide cleanly into any 24-ish
      // pattern, so the last dash gets visually squeezed.
      circle.setAttribute("pathLength", "100");
      circle.setAttribute("stroke-dasharray", "4 6");
      circle.setAttribute("stroke-linecap", "butt");
      svg.appendChild(circle);
      this.core.appendChild(svg);
      this.focusRing = svg;
      this.focusRingCircle = circle;
    }

    // Mother glint — 10 px dot with a tinted specular radial gradient.
    // Sits above everything (z:5) so it reads as a reflection on the
    // orb's surface; screen-blend makes it read as light rather than
    // paint. Gradient colour is rebuilt when the mother's hue changes.
    this.glint = document.createElement("div");
    Object.assign(this.glint.style, {
      position: "absolute",
      width: "5px",
      height: "5px",
      left: "50%",
      top: "50%",
      "border-radius": "50%",
      transform: "translate(-50%, -50%)",
      opacity: "0",
      "pointer-events": "none",
      "mix-blend-mode": "screen",
      "z-index": "5",
      "will-change": "transform, opacity",
    } as Partial<CSSStyleDeclaration>);
    this.applyGlintGradient(320); // warm pink default until the provider speaks up
    this.root.appendChild(this.glint);

    // Mode label — sits above the icon, only visible briefly after a click.
    // Short all-caps strip ("MUTED" / "FOCUS" / "ITERATE") so the current mode
    // is always confirmable without opening settings.
    this.modeLabel = document.createElement("div");
    Object.assign(this.modeLabel.style, {
      position: "absolute",
      top: "-24px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "2px 8px",
      "border-radius": "4px",
      background: "rgba(10,10,20,0.88)",
      border: "1px solid rgba(255,255,255,0.18)",
      color: "rgba(255,255,255,0.92)",
      "font-family": "'SF Pro Display', -apple-system, system-ui, sans-serif",
      "font-size": "10px",
      "font-weight": "700",
      "letter-spacing": "1.5px",
      "white-space": "nowrap",
      "pointer-events": "none",
      "z-index": "5",
      opacity: "0",
      "text-transform": "uppercase",
    } as Partial<CSSStyleDeclaration>);
    this.root.appendChild(this.modeLabel);

    this.reposition();
    this.root.addEventListener("mouseenter", () => this.onHoverEnter());
    this.root.addEventListener("mouseleave", () => this.onHoverLeave());
    this.root.addEventListener("mousedown", (e) => this.onPressStart(e));
    // Right-click → pop the tray menu at the cursor (same items as the
    // system-tray icon, so users don't have to chase the menu bar).
    this.root.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      invoke("show_anchor_context_menu").catch((err) =>
        console.error("[voice-anchor] context menu invoke failed", err),
      );
    });
    window.addEventListener("resize", () => this.reposition());

    this.refreshMuteStateFromSettings();
    this.startAnim();

    // Live-react to settings panel toggles — the panel dispatches a
    // `setting-updated` window event after each invoke("update_setting").
    // Only anchor_bob concerns us today; extend the if-chain if more land.
    window.addEventListener("setting-updated", (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { key: string; value: unknown };
      if (detail?.key === "anchor_bob") this.setBobbing(!!detail.value);
    });

    // Enabled/disabled state from the tray menu (or anchor pip). Tauri
    // emits `enabled-changed` with the boolean *enabled* value.
    listen<boolean>("enabled-changed", (ev) => {
      this.applyEnabled(ev.payload);
    }).catch((err) => console.error("[voice-anchor] listen enabled-changed failed", err));

    // Startup — glide down from above, clean ease in/out, no overshoot.
    gsap.from(this.root, {
      y: -window.innerHeight * 0.7,
      opacity: 0,
      scale: 0.8,
      duration: 0.9,
      ease: "power2.inOut",
      delay: 0.3,
    });
  }

  current(): AnchorPos {
    return { fx: this.fx, fy: this.fy, x: this.fx * window.innerWidth, y: this.fy * window.innerHeight };
  }

  /**
   * Move the anchor to a new fractional screen position. Used by
   * external drag surfaces (e.g. AnchorHandle) to reposition the
   * visual orb in real time without going through the anchor's own
   * mousedown → drag path. Reposition the root DOM, fire onChange
   * listeners so dependents (sine-waves, tentacles, creature) track,
   * and persist localStorage so the position survives a reload even
   * before the Rust setting write completes.
   */
  setPosition(fx: number, fy: number) {
    this.fx = Math.max(0.02, Math.min(0.98, fx));
    this.fy = Math.max(0.02, Math.min(0.98, fy));
    this.reposition();
    writeLocalAnchor(this.fx, this.fy);
    const pos = this.current();
    for (const fn of this.listeners) fn(pos);
  }

  /**
   * Rendered anchor centre in screen pixels — includes the idle bob
   * offset when bobbing is enabled, so effects that want to sit visually
   * on the orb (tentacles, glint-parented elements, etc.) track it in
   * real time. Falls back to `current()` when bobbing is off.
   *
   * The bob formula mirrors `setBobbing()` — any change there must be
   * reflected here. See [CLAUDE.md] gotcha #5.
   */
  renderedCenter(): { x: number; y: number } {
    const cx = this.fx * window.innerWidth;
    const cy = this.fy * window.innerHeight;
    if (!this.bobRaf) return { x: cx, y: cy };
    // yPercent(t) = -56 + 6·cos(2π·t/5.6); baseline is -50 (no bob).
    // Extra translation vs baseline = (-6 + 6·cos) % of SIZE in px.
    const phase = (performance.now() * 0.001 * Math.PI * 2) / 5.6;
    const extraPct = -6 + 6 * Math.cos(phase);
    return { x: cx, y: cy + (extraPct / 100) * SIZE };
  }

  onChange(fn: (pos: AnchorPos) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  onDragStart(fn: (pos: AnchorPos) => void): () => void {
    this.dragStartListeners.push(fn);
    return () => {
      const i = this.dragStartListeners.indexOf(fn);
      if (i >= 0) this.dragStartListeners.splice(i, 1);
    };
  }

  onDragEnd(fn: (pos: AnchorPos) => void): () => void {
    this.dragEndListeners.push(fn);
    return () => {
      const i = this.dragEndListeners.indexOf(fn);
      if (i >= 0) this.dragEndListeners.splice(i, 1);
    };
  }

  /** Supply a function that returns the mother's current screen-pixel
   *  position, or null when she's absent/off-screen. The anchor polls it
   *  each tick to update the glint; pass `null` to disable. */
  setMotherPosProvider(fn: (() => { x: number; y: number } | null) | null) {
    this.motherPosProvider = fn;
    if (!fn) {
      this.targetGlintOpacity = 0;
    }
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    if (this.bobRaf) { cancelAnimationFrame(this.bobRaf); this.bobRaf = 0; }
    if (this.iteratePulseTween) {
      this.iteratePulseTween.kill();
      this.iteratePulseTween = null;
    }
    if (this.focusMarchTween) {
      this.focusMarchTween.kill();
      this.focusMarchTween = null;
    }
    // Release the interactive pin so a HMR reload never leaves Rust in a
    // permanently-interactive state (which would steal clicks from apps behind).
    invoke("set_anchor_dragging", { active: false }).catch(() => {});
    this.root.remove();
    this.listeners.length = 0;
  }

  // ── Animation loop (particles) ─────────────────────────

  private startAnim() {
    const tick = (t: number) => {
      this.rafId = requestAnimationFrame(tick);

      // Steady edge drizzle — emit into the shared pool; creature's
      // renderer picks it up alongside mother/companion/STT particles.
      if (t - this.lastSpawn > 70) {
        this.lastSpawn = t;
        this.spawnEdgeParticle();
      }

      this.updateGlint();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /**
   * Per-frame glint update — computes target opacity + position from the
   * mother's screen coordinates, then eases `glintOpacity` toward target
   * (~180 ms settle) so visibility transitions feel like a reflection
   * catching the light rather than a binary pop.
   *
   * Occlusion ("behind") is a soft spatial fade: a smoothstep from 0 at
   * OCCLUSION_INNER (deep inside the orb's footprint) to 1 at
   * OCCLUSION_OUTER (just beyond the visible edge). That way the glint
   * fades as she passes behind the orb rather than snapping off at the
   * boundary. Position is still updated while occluded so the glint
   * re-emerges from the correct angle once she's out the other side.
   */
  private updateGlint() {
    const mother = this.motherPosProvider?.() ?? null;
    if (mother) {
      const anchor = this.current();
      const dx = mother.x - anchor.x;
      const dy = mother.y - anchor.y;
      const d = Math.hypot(dx, dy);

      // Soft occlusion through the orb boundary — smoothstep(inner, outer, d).
      const occlusion = smoothstep(OCCLUSION_INNER, OCCLUSION_OUTER, d);
      // Outer-distance brightness: peaks just outside the orb, linearly
      // fades to zero by GLINT_FADE_DIST. Uses distance-from-edge so the
      // "peak" band sits right where she's closest to touching the orb.
      const outer = Math.max(0, d - ORB_RADIUS);
      const closeness =
        outer <= GLINT_FULL_BRIGHT_DIST
          ? 1
          : Math.max(0, 1 - (outer - GLINT_FULL_BRIGHT_DIST) / GLINT_FADE_DIST);

      // Close-range super-bright boost — within the full-bright band, ramp
      // UP further as she approaches the edge so the reflection blooms on
      // approach instead of plateauing. 1× at the band's outer edge → ~1.6×
      // right at the orb. Clamped by CSS opacity cap on the way out.
      const nearBoost =
        outer < GLINT_FULL_BRIGHT_DIST
          ? 1 + 0.6 * (1 - outer / GLINT_FULL_BRIGHT_DIST)
          : 1;

      this.targetGlintOpacity = occlusion * closeness * nearBoost * GLINT_PEAK_OPACITY;

      // Lens flares — edge-triggered POPS at the occlusion boundary.
      // Not a continuous glow: we fire a brief flash when the mother
      // crosses INTO the occluded zone (entering behind the orb) and a
      // second when she crosses OUT (emerging from the other side).
      this.prevOcclusion = occlusion;

      // Proximity scale — the glint swells right before she passes behind.
      // 1.0 × at max distance, peak ~2.3 × right at the orb edge, then
      // multiplied by `occlusion` so it shrinks back down as she sinks
      // into the footprint. Curve is `closeness^0.5` to ramp fast and
      // plateau, so the "big reflection" moment lasts on approach.
      const scale = 1 + 1.3 * Math.sqrt(closeness) * occlusion;

      // Position on the orb surface at the angle toward mother.
      // translate(-50%) centers the dot on (left:50%, top:50%); we add
      // the on-orb offset via calc(). Keep updating even while occluded
      // so she emerges from the right spot on the other side. Scale is
      // applied after translate so it grows around the current centre.
      const angle = Math.atan2(dy, dx);
      const ox = Math.cos(angle) * GLINT_RADIUS;
      const oy = Math.sin(angle) * GLINT_RADIUS;
      this.glint.style.transform =
        `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px)) scale(${scale.toFixed(3)})`;

      // Colour-match to the mother — cheap hue-compare avoids rebuilding
      // the gradient string when nothing changed.
      if (typeof mother.hue === "number" && Math.abs(mother.hue - this.glintHue) > 0.5) {
        this.applyGlintGradient(mother.hue);
      }
    } else {
      this.targetGlintOpacity = 0;
    }

    // Asymmetric ease — slow rise reads as a reflection catching the
    // light, fast fall reads as the highlight snapping off when she
    // ducks behind the orb. 0.08 (~180 ms to 95 %) on rise, 0.32
    // (~40 ms to 95 %) on fall.
    const delta = this.targetGlintOpacity - this.glintOpacity;
    if (Math.abs(delta) > 0.001) {
      const ease = delta < 0 ? 0.32 : 0.08;
      this.glintOpacity += delta * ease;
      this.glint.style.opacity = this.glintOpacity.toFixed(3);
    }
  }

  /**
   * Rebuild the glint's radial-gradient background tinted by the mother's
   * hue. Hot centre stays near-white so the specular still reads as
   * "highlight", while the falloff carries the mother's colour — the
   * equivalent of a saturated specular lobe on a tinted surface.
   */
  private applyGlintGradient(hue: number) {
    this.glintHue = hue;
    const h = ((hue % 360) + 360) % 360;
    // Soft falloff — keep the hot core but fade hard toward the rim so
    // the dot has no visible edge. Alphas are low across the board; the
    // shape reads as a glimmer rather than a solid disc.
    const core = `hsla(${h}, 60%, 98%, 1.0)`;  // hot white core
    const mid  = `hsla(${h}, 90%, 78%, 0.6)`;  // tinted halo, stronger
    const rim  = `hsla(${h}, 90%, 65%, 0)`;    // transparent edge
    this.glint.style.background =
      `radial-gradient(circle at 40% 40%, ${core} 0%, ${mid} 35%, ${rim} 100%)`;
  }

  private spawnEdgeParticle() {
    // Emit into the shared ambient-vfx pool in GLOBAL screen coords —
    // the creature's renderer picks them up and draws them alongside
    // mother/tentacle/companion particles (single engine, single
    // render). `renderedCenter()` gives the anchor's live screen
    // position including the idle bob.
    const c = this.renderedCenter();
    const angle = Math.random() * Math.PI * 2;
    const r = EDGE_SPAWN_MIN + Math.random() * (EDGE_SPAWN_MAX - EDGE_SPAWN_MIN);
    const speed = 0.35 + Math.random() * 0.5;
    emitParticle(
      c.x + Math.cos(angle) * r, c.y + Math.sin(angle) * r,
      Math.cos(angle) * speed, Math.sin(angle) * speed,
    );
  }

  private burst(n: number) {
    const c = this.renderedCenter();
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 1.2 + Math.random() * 1.6;
      const r = EDGE_SPAWN_MIN + Math.random() * (EDGE_SPAWN_MAX - EDGE_SPAWN_MIN);
      emitParticle(
        c.x + Math.cos(angle) * r, c.y + Math.sin(angle) * r,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
      );
    }
  }

  // ── Hover animations via GSAP ───────────────────────────

  private onHoverEnter() {
    if (this.hovering) return; // mouseenter is single-fire, but guard against re-entry from drag-end → hover transitions
    this.hovering = true;
    // Pin the window interactive for the whole hover session. The Rust
    // proximity poll uses a 48 pt radius but the DOM hit zone extends
    // to 85 pt (arrow tips at ~80 pt). Without this pin, the cursor
    // drifting into the 48–85 pt annular band drops click-through back
    // on: mouseleave and mousedown are never delivered, hover effects
    // freeze permanently, and all clicks silently disappear.
    invoke("set_anchor_dragging", { active: true }).catch(() => {});
    playSfx("sfx-on", 0.3);
    // Ambient loop — sits underneath until hover-leave fades it out.
    // Idle hover sits at half volume; drag-start ramps it up.
    startLoopSfx("sfx-orb-hover", 0.4, 120);
    // Core fades in
    gsap.to(this.core, { opacity: 1, duration: 0.25, ease: "power2.out" });
    // Arrows tween out from center at full opacity. We used to decay
    // the peak opacity with drag count (learned-affordance fade), but
    // user feedback: hover should always show a crisp 4-direction hint.
    this.arrowEls.forEach((el, i) => {
      const p = ARROW_PLACEMENTS[i];
      gsap.killTweensOf(el);
      gsap.to(el, {
        x: p.dx,
        y: p.dy,
        // Rotation reset explicitly — otherwise a hover that fires
        // while the post-throw fan-out tween is still running would
        // kill the fan-out tween and leave rotation frozen at an
        // intermediate value (arrows land in cardinal positions but
        // stay tilted).
        rotation: p.rot,
        scale: 1,
        opacity: 1,
        duration: 0.32,
        ease: "back.out(1.8)",
        overwrite: true,
      });
    });
  }

  /**
   * Learned-affordance decay: the 4 directional arrows are a hint, not a
   * control. Fresh users see them at full opacity; after they've dragged
   * the anchor enough times the arrows fade to a near-invisible 10 %
   * reminder. Count is persisted in localStorage so it survives restarts.
   *
   *   drags 0-1 → 1.0  (full, drawing attention)
   *   drags 2-4 → linear fade 1.0 → 0.1
   *   drags 5+  → 0.1  (minimal, they know)
   */
  private arrowPeakOpacity(): number {
    const n = readDragCount();
    if (n <= 1) return 1.0;
    if (n >= 5) return 0.1;
    return 1.0 - ((n - 1) / 4) * 0.9;
  }

  private onHoverLeave() {
    if (!this.hovering) return;
    this.hovering = false;
    // Fade the ambient loop regardless of dragging — even mid-drag the
    // orb hum should die if the cursor exits the hit zone.
    stopLoopSfx("sfx-orb-hover", 120);
    // Hold the interactive pin while the button is held (pressing) or a
    // drag is in progress — if we release here, the window goes
    // click-through and the pending mouseup event is swallowed, leaving
    // the mode label never shown and hover effects permanently frozen.
    if (this.dragging || this.pressing) return;
    invoke("set_anchor_dragging", { active: false }).catch(() => {});
    playSfx("sfx-tape-sticky", 0.5);
    // Arrows retract behind the icon. Rotation reset too so a hover-
    // leave firing during a post-throw fan-out doesn't leave rotation
    // frozen mid-tween (arrows would re-appear tilted next hover).
    this.arrowEls.forEach((el, i) => {
      const p = ARROW_PLACEMENTS[i];
      gsap.killTweensOf(el);
      gsap.to(el, {
        x: 0,
        y: 0,
        rotation: p.rot,
        scale: 0.5,
        opacity: 0,
        duration: 0.22,
        ease: "power2.in",
        overwrite: true,
      });
    });
    // Core fades out — unless the mode has its own always-visible ring.
    if (this.mode === "iterate") {
      gsap.to(this.core, { opacity: 0, duration: 0.25, ease: "power2.in" });
    }
  }

  // ── Internals ────────────────────────────────────────────

  private reposition() {
    this.root.style.left = `${this.fx * 100}%`;
    this.root.style.top = `${this.fy * 100}%`;
  }

  private emit() {
    const pos = this.current();
    for (const fn of this.listeners) fn(pos);
  }

  /**
   * Animate the orb in/out based on enabled state. Disabled = scale to a
   * pip in the top-right corner so the user has a target to click back
   * on (and right-click still pops the tray menu). Enabled = restore
   * original position + scale.
   */
  private applyEnabled(enabled: boolean) {
    if (enabled === !this.disabled) return; // already in the right state
    this.disabled = !enabled;
    if (!enabled) {
      // Going to disabled — capture current pos for later restore.
      this.disabledRestore = { fx: this.fx, fy: this.fy };
      gsap.to(this.root, {
        left: `${window.innerWidth - 36}px`,
        top: "36px",
        scale: 0.35,
        duration: 0.7,
        ease: "power2.inOut",
        overwrite: "auto",
      });
    } else {
      // Going to enabled — restore previous fx/fy.
      const r = this.disabledRestore ?? { fx: this.fx, fy: this.fy };
      this.fx = r.fx;
      this.fy = r.fy;
      this.disabledRestore = null;
      gsap.to(this.root, {
        left: `${this.fx * 100}%`,
        top: `${this.fy * 100}%`,
        scale: 1,
        duration: 0.65,
        ease: "back.out(1.4)",
        overwrite: "auto",
      });
    }
  }

  private onPressStart(e: MouseEvent) {
    e.preventDefault();
    // While disabled, the orb is a pip — a click re-enables instead of
    // toggling mute or starting a drag.
    if (this.disabled) {
      invoke("set_enabled", { enabled: true }).catch((err) =>
        console.error("[voice-anchor] set_enabled failed", err),
      );
      return;
    }
    // Cancel any in-flight inertia throw — a new grab takes priority.
    if (this.inertiaRaf) {
      cancelAnimationFrame(this.inertiaRaf);
      this.inertiaRaf = 0;
      this.velX = 0;
      this.velY = 0;
    }
    const startX = e.clientX, startY = e.clientY;
    const startTime = performance.now();
    this.dragging = false;
    this.didDrag = false;
    this.pressing = true;
    this.burst(10);

    // Rolling velocity buffer — last ~120 ms of pointer samples.
    // On release we read the average velocity across these to avoid
    // one stray pixel at the very end dominating the throw direction.
    const samples: { t: number; x: number; y: number }[] = [];
    const pushSample = (t: number, x: number, y: number) => {
      samples.push({ t, x, y });
      const cutoff = t - 120;
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
    };
    pushSample(startTime, startX, startY);

    const move = (ev: MouseEvent) => {
      pushSample(performance.now(), ev.clientX, ev.clientY);
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!this.dragging && Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) {
        this.dragging = true;
        this.didDrag = true;
        this.root.style.cursor = "grabbing";
        this.burst(14);
        // Drag is the high-engagement moment — pump the orb hum up to
        // ~0.75 over a short fade. Idempotent; just retargets the
        // loop's existing volume tween.
        startLoopSfx("sfx-orb-hover", 0.75, 100);
        // Tell Rust to pin the overlay non-click-through for the whole
        // drag. The proximity poll only sees the SAVED anchor position,
        // not the live one, so once the cursor moves >hover radius
        // from the saved spot it would otherwise lose the events.
        invoke("set_anchor_dragging", { active: true }).catch((err) =>
          console.error("[voice-anchor] set_anchor_dragging(true) failed", err),
        );
        fireDragStart();
        // Drag commit — "orbit": the four arrows STAY at their radius
        // and orbit around the anchor center by the drag angle. Each
        // arrow's own rotation rotates by the same amount so it still
        // points radially outward from its new orbital position.
        //
        // i=0 (up-at-rest) is always the one aligned with the drag
        // direction after the orbit — full opacity. The other three
        // are at fixed 90°/180°/270° offsets from the drag direction
        // and dim down to hint they're not the primary pointer.
        // Release path tweens them back to cardinal positions (see
        // up() below).
        const initAngle = dragAngleDegrees(dx, dy);
        const initRad = (initAngle * Math.PI) / 180;
        const cos0 = Math.cos(initRad);
        const sin0 = Math.sin(initRad);
        this.arrowEls.forEach((el, i) => {
          const p = ARROW_PLACEMENTS[i];
          const targetOpacity = DRAG_ARROW_OPACITY[i];
          gsap.killTweensOf(el);
          gsap.to(el, {
            x: p.dx * cos0 - p.dy * sin0,
            y: p.dx * sin0 + p.dy * cos0,
            rotation: p.rot + initAngle,
            scale: 1,
            opacity: targetOpacity,
            duration: 0.22,
            ease: "power2.out",
            overwrite: "auto",
          });
        });
      }
      if (this.dragging) {
        const marginX = ORB_RADIUS / window.innerWidth;
        const marginY = ORB_RADIUS / window.innerHeight;
        this.fx = Math.max(marginX, Math.min(1 - marginX, ev.clientX / window.innerWidth));
        this.fy = Math.max(marginY, Math.min(1 - marginY, ev.clientY / window.innerHeight));
        this.reposition();
        this.emit();
        if (Math.random() < 0.35) this.spawnEdgeParticle();

        // Live orbit update — each arrow's position rotates around
        // the anchor center to track current motion heading, and each
        // arrow's own rotation rotates by the same angle so it keeps
        // pointing radially outward. Uses the trailing sample buffer
        // so a single noisy frame doesn't spin the whole arrangement.
        //
        // gsap.to with overwrite:"auto" gives a smoothing lag over
        // raw mousemove samples — each new target replaces the
        // in-flight tween so nothing queues, but motion is
        // interpolated instead of snapping per frame. Longer
        // duration = softer chase (arrows feel heavier / deliberate).
        if (samples.length >= 2) {
          const last = samples[samples.length - 1];
          const prev = samples[0];
          const vdx = last.x - prev.x;
          const vdy = last.y - prev.y;
          if (Math.hypot(vdx, vdy) > 0.5) {
            const angle = dragAngleDegrees(vdx, vdy);
            const rad = (angle * Math.PI) / 180;
            const cosA = Math.cos(rad);
            const sinA = Math.sin(rad);
            this.arrowEls.forEach((el, i) => {
              const p = ARROW_PLACEMENTS[i];
              gsap.to(el, {
                x: p.dx * cosA - p.dy * sinA,
                y: p.dx * sinA + p.dy * cosA,
                rotation: p.rot + angle,
                duration: 0.56,
                ease: "power2.out",
                overwrite: "auto",
              });
            });
          }
        }
      }
    };

    const fireDragStart = () => {
      const pos = this.current();
      for (const fn of this.dragStartListeners) fn(pos);
    };

    const up = async () => {
      this.pressing = false;
      const elapsed = performance.now() - startTime;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      this.root.style.cursor = "grab";

      if (this.didDrag) {
        this.dragging = false;
        incrementDragCount(); // fades the hover arrows over time
        // Drop the orb hum back down to the idle hover level if the
        // cursor is still over the anchor; if it's already left,
        // hover-leave will run stopLoopSfx separately and this just
        // gets overridden.
        if (this.hovering) startLoopSfx("sfx-orb-hover", 0.4, 150);

        // Fan arrows back out — "release" animation. During drag the
        // four arrows condensed to center, all rotated to the drag
        // heading. Now they tween outward to their cardinal positions
        // with each arrow rotating back to its original heading, so
        // the user sees "here are the four directions you can go."
        // Hover path uses peak opacity (always-visible hint); no-hover
        // path drops opacity to 0 (retracted).
        const arrowDur = 0.42;
        // Hover = full opacity (matches onHoverEnter); no-hover = off.
        const hoverPeak = this.hovering ? 1 : 0;
        this.arrowEls.forEach((el, i) => {
          const p = ARROW_PLACEMENTS[i];
          gsap.killTweensOf(el);
          gsap.to(el, {
            x: p.dx,
            y: p.dy,
            rotation: p.rot,
            scale: this.hovering ? 1 : 0.5,
            opacity: hoverPeak,
            duration: arrowDur,
            ease: "back.out(1.4)",
            overwrite: "auto",
          });
        });

        // Compute release velocity from the sample buffer and kick off
        // the throw if it exceeds a threshold. Below threshold = the
        // user is "placing" rather than "throwing", so we settle here
        // and persist immediately like before.
        const released = this.computeReleaseVelocity(samples);
        const speed = Math.hypot(released.vx, released.vy);
        const THROW_SPEED_MIN = 0.2; // screen-fractions per second

        if (speed > THROW_SPEED_MIN) {
          this.velX = released.vx;
          this.velY = released.vy;
          // Extra burst on throw — scales with speed so a hard fling
          // actually looks like one. Capped so we don't DoS the pool.
          const burstN = Math.min(48, Math.round(18 + speed * 14));
          this.burst(burstN);
          // Start physics. Persist + fireDragEnd happen when inertia
          // finally comes to rest, inside startInertia(). The
          // anchor_dragging flag stays true through the throw and is
          // cleared at inertia settle.
          this.startInertia();
          return;
        }

        // No throw — release the drag pin. If the cursor is still over the
        // anchor the hover pin keeps the window interactive; only clear
        // when the cursor has already left (hovering = false).
        if (!this.hovering) {
          invoke("set_anchor_dragging", { active: false }).catch((err) =>
            console.error("[voice-anchor] set_anchor_dragging(false) failed", err),
          );
        }
        writeLocalAnchor(this.fx, this.fy);
        const endPos = this.current();
        for (const fn of this.dragEndListeners) fn(endPos);
        try {
          await invoke("update_setting", { key: "voice_anchor_x", value: this.fx.toFixed(4) });
          await invoke("update_setting", { key: "voice_anchor_y", value: this.fy.toFixed(4) });
        } catch (err) {
          console.error("[voice-anchor] persist failed", err);
        }
        return;
      }
      if (elapsed < CLICK_DRAG_THRESHOLD_MS + 200) {
        await this.toggleMute();
      }
    };

    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  /**
   * Compute release velocity in fraction-of-screen per second from the
   * trailing sample buffer. Uses the first and last samples in the
   * buffer (spanning up to ~120 ms) so a noisy final pixel doesn't
   * dominate the throw direction.
   */
  private computeReleaseVelocity(
    samples: { t: number; x: number; y: number }[],
  ): { vx: number; vy: number } {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const last = samples[samples.length - 1];
    const first = samples[0];
    const dt = (last.t - first.t) / 1000;
    if (dt < 0.01) return { vx: 0, vy: 0 };
    const vxPx = (last.x - first.x) / dt;
    const vyPx = (last.y - first.y) / dt;
    return {
      vx: vxPx / window.innerWidth,
      vy: vyPx / window.innerHeight,
    };
  }

  /**
   * Inertia / throw physics loop. Each frame: advance fx/fy by
   * velocity × dt, apply exponential damping, bounce off screen
   * bounds with partial elasticity. Runs until speed falls below
   * STOP_SPEED, then fires dragEnd + persists position.
   */
  private startInertia() {
    // ~20 %/s retained → feels like a thrown object sliding on a
    // slightly sticky surface. Higher = longer float; lower = sharper
    // stop. 0.18 found by feel.
    const DAMP_PER_SEC = 0.18;
    // Fraction-per-second at which we consider the throw settled.
    // 0.01 ≈ 1 px-ish over a second at typical window sizes.
    const STOP_SPEED = 0.02;
    // Partial elasticity — a thrown anchor bounces but loses energy.
    const WALL_ELASTICITY = 0.55;
    // Keep clamps consistent with mousemove's clamp so we bounce at
    // the same edge the user can drag to. Computed from ORB_RADIUS so
    // the orb's visible disc kisses the viewport edge on bounce rather
    // than leaving a large empty gutter.
    const marginX = ORB_RADIUS / window.innerWidth;
    const marginY = ORB_RADIUS / window.innerHeight;
    const MIN_X = marginX, MAX_X = 1 - marginX;
    const MIN_Y = marginY, MAX_Y = 1 - marginY;

    let lastT = performance.now();
    let edgeParticleAccum = 0;

    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.06, (now - lastT) / 1000); // clamp dt for tab-switch sanity
      lastT = now;

      this.fx += this.velX * dt;
      this.fy += this.velY * dt;

      // Wall bounce with energy loss + position clamp.
      if (this.fx < MIN_X) { this.fx = MIN_X; this.velX = -this.velX * WALL_ELASTICITY; }
      else if (this.fx > MAX_X) { this.fx = MAX_X; this.velX = -this.velX * WALL_ELASTICITY; }
      if (this.fy < MIN_Y) { this.fy = MIN_Y; this.velY = -this.velY * WALL_ELASTICITY; }
      else if (this.fy > MAX_Y) { this.fy = MAX_Y; this.velY = -this.velY * WALL_ELASTICITY; }

      // Exponential damping — Math.pow(retention, dt) is the framerate-
      // independent equivalent of "multiply velocity by retention^dt".
      const damp = Math.pow(DAMP_PER_SEC, dt);
      this.velX *= damp;
      this.velY *= damp;

      this.reposition();
      this.emit();

      // Spawn edge particles on fast segments so the throw trails.
      edgeParticleAccum += dt * Math.hypot(this.velX, this.velY);
      if (edgeParticleAccum > 0.02) {
        this.spawnEdgeParticle();
        edgeParticleAccum = 0;
      }

      const speed = Math.hypot(this.velX, this.velY);
      if (speed > STOP_SPEED) {
        this.inertiaRaf = requestAnimationFrame(step);
        return;
      }

      // Settled — fire end listeners, release the drag pin, persist.
      this.inertiaRaf = 0;
      this.velX = 0;
      this.velY = 0;
      if (!this.hovering) {
        invoke("set_anchor_dragging", { active: false }).catch((err) =>
          console.error("[voice-anchor] set_anchor_dragging(false) failed", err),
        );
      }
      writeLocalAnchor(this.fx, this.fy);
      const endPos = this.current();
      for (const fn of this.dragEndListeners) fn(endPos);
      void (async () => {
        try {
          await invoke("update_setting", { key: "voice_anchor_x", value: this.fx.toFixed(4) });
          await invoke("update_setting", { key: "voice_anchor_y", value: this.fy.toFixed(4) });
        } catch (err) {
          console.error("[voice-anchor] persist failed", err);
        }
      })();
    };

    this.inertiaRaf = requestAnimationFrame(step);
  }

  /** Public entry point for external surfaces (e.g. AnchorHandle) to
   *  trigger the same mode-cycle the anchor's own click does. */
  cycleMode() {
    return this.toggleMute();
  }

  private async toggleMute() {
    // Cycle: iterate → muted (solid red) → focus (dashed red) → iterate
    this.mode = this.mode === "iterate" ? "muted"
              : this.mode === "muted"   ? "focus"
                                        : "iterate";
    this.applyMuteForMode();
    this.updateModeStyle();
    this.burst(18);
    // flashModeLabel fires `speak_brief("mute"|"focus mode"|"iterate mode")`,
    // which calls `start_session()` under the hood — that ALREADY cancels
    // any in-flight narrator TTS. So we don't need a separate stop_speaking
    // call on mute; doing so would cut off the "mute" chirp mid-word. The
    // chirp plays to completion, then silence.
    this.flashModeLabel(this.mode);

    try {
      await invoke("update_setting", { key: "work_mode", value: this.mode });
    } catch (err) {
      console.error("[voice-anchor] mode toggle failed", err);
    }
  }

  /** Flash the current mode name above the anchor for ~1.1s. */
  private flashModeLabel(mode: "iterate" | "focus" | "muted") {
    const text = mode === "muted" ? "MUTED"
               : mode === "focus" ? "FOCUS"
                                  : "ITERATE";
    const color = mode === "muted" ? "rgba(255,90,90,0.95)"
                : mode === "focus" ? "rgba(255,170,90,0.95)"
                                   : "rgba(167,139,250,0.95)";
    this.modeLabel.textContent = text;
    this.modeLabel.style.color = color;
    gsap.killTweensOf(this.modeLabel);
    gsap.fromTo(this.modeLabel,
      { opacity: 0, y: 4 },
      { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" }
    );
    gsap.to(this.modeLabel, {
      opacity: 0, y: -4, duration: 0.35, ease: "power2.in", delay: 1.1,
    });

    // Speak the mode name through the app's VITS voice via the dedicated
    // `speak_brief` Rust command. That path deliberately skips tts-open /
    // tts-sentence / tts-done emits, so sine waves + paragraph reader
    // stay quiet — same UX as the old Web Speech path but uniform voice
    // with the narrator.
    const phrase = mode === "muted" ? "mute"
                 : mode === "focus" ? "focus"
                                    : "iterate";
    invoke("speak_brief", { text: phrase }).catch((err) =>
      console.error("[voice-anchor] speak_brief failed", err)
    );

    // --- Fallback (kept for easy reversion) ---
    // Originally used the browser's SpeechSynthesis (macOS system voice).
    // To switch back: comment out the invoke above and uncomment this block.
    // if (typeof window !== "undefined" && "speechSynthesis" in window) {
    //   const u = new SpeechSynthesisUtterance(phrase);
    //   u.rate = 1.0; u.pitch = 1.0; u.volume = 0.6;
    //   window.speechSynthesis.cancel();
    //   window.speechSynthesis.speak(u);
    // }
  }

  /** Sync the audio bus to current mode and resume the orb hum if the
   *  user is still hovering. Called from every site that flips
   *  `this.mode`, so toggling mute via click-cycle, settings, or
   *  whatever else all keep the loop in lockstep with the visual
   *  state. Without the resume, un-muting while hovered would leave
   *  the hum silent until the user re-entered the anchor. */
  private applyMuteForMode() {
    const isMuted = this.mode === "muted";
    setMuted(isMuted);
    if (!isMuted && this.hovering) {
      // Restart at drag volume if mid-drag, otherwise idle hover vol.
      const target = this.dragging ? 0.75 : 0.4;
      startLoopSfx("sfx-orb-hover", target, 120);
    }
  }

  private updateModeStyle() {
    // Tear down running iterate pulse + focus-ring rotation. We'll
    // restart whichever applies below; non-applicable ones stay
    // killed.
    if (this.iteratePulseTween) {
      this.iteratePulseTween.kill();
      this.iteratePulseTween = null;
    }
    if (this.focusMarchTween) {
      this.focusMarchTween.kill();
      this.focusMarchTween = null;
    }
    if (this.focusRing) this.focusRing.style.display = "none";

    if (this.mode === "muted") {
      // Solid thick red ring — silent.
      this.core.style.border = "3.5px solid rgba(255,70,70,0.95)";
      this.core.style.boxShadow = "0 0 24px rgba(255,70,70,0.6), inset 0 0 12px rgba(255,80,80,0.25)";
      gsap.to(this.core, { opacity: 1, duration: 0.2 });
    } else if (this.mode === "focus") {
      // Marching-ants ring drawn in SVG, slowly rotating clockwise.
      // Hide the CSS dashed border; the SVG ring takes over.
      this.core.style.border = "none";
      this.core.style.boxShadow = "0 0 16px rgba(255,70,70,0.4), inset 0 0 8px rgba(255,80,80,0.15)";
      if (this.focusRing) {
        this.focusRing.style.display = "block";
        gsap.set(this.focusRing, { rotation: 0 });
        // Very slow rotation — 30 s per full revolution. ease: linear
        // so the march reads as continuous, not coast-and-restart.
        this.focusMarchTween = gsap.to(this.focusRing, {
          rotation: 360,
          duration: 30,
          ease: "linear",
          repeat: -1,
        });
      }
      gsap.to(this.core, { opacity: 1, duration: 0.2 });
    } else {
      // iterate — bright green ring that pulses. GSAP tweens a plain
      // `pulse.v` numeric, and onUpdate rewrites the border + glow
      // box-shadow so we get continuous interpolation rather than CSS
      // transition steps. yoyo + repeat -1 = infinite back-and-forth.
      gsap.to(this.core, { opacity: this.hovering ? 1 : 0, duration: 0.2 });
      const pulse = { v: 0.45 };
      const apply = () => {
        const v = pulse.v;
        this.core.style.border = `2px solid rgba(120, 240, 150, ${v})`;
        this.core.style.boxShadow =
          `0 0 ${18 + v * 22}px rgba(120, 240, 150, ${v * 0.7}),` +
          ` inset 0 0 10px rgba(120, 240, 150, ${v * 0.35})`;
      };
      apply();
      this.iteratePulseTween = gsap.to(pulse, {
        v: 1.0,
        duration: 1.1,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
        onUpdate: apply,
      });
    }
  }

  private async refreshMuteStateFromSettings() {
    try {
      const s = await invoke<{ work_mode?: string; anchor_bob?: boolean }>("get_all_settings");
      const m = s?.work_mode;
      this.mode = m === "muted" || m === "focus" ? m : "iterate";
      this.applyMuteForMode();
      this.updateModeStyle();
      // Start/stop the idle bob based on the setting. Called on mount
      // (with both fields present) and on-demand via setBobbing() from
      // SettingsPanel when the toggle changes.
      if (s?.anchor_bob !== undefined) this.setBobbing(!!s.anchor_bob);
    } catch { /* ignore */ }
  }

  private bobRaf = 0;

  /**
   * Enable or disable the idle up-and-down bob. Uses an RAF loop with a
   * cos-based curve driven by performance.now() — NOT a GSAP tween. This
   * matters because the sine-wave feature renders its own bob using the
   * same performance.now() + same formula, and identical time reference
   * + identical math = guaranteed phase lock. GSAP has its own ticker
   * which drifts relative to performance.now(), so the two previously
   * looked "almost synced" but wobbled out of phase over time.
   *
   *   period:    5.6 s (matches the old yoyo = 2.8 s forward + 2.8 s back)
   *   amplitude: yPercent -50 (base) to -62 (peak) = 12 % of SIZE (90 px)
   *              = 10.8 px swing upward
   *   formula:   yPercent(t) = -56 + 6·cos(2π·t / 5.6)
   */
  setBobbing(enabled: boolean) {
    if (this.bobRaf) { cancelAnimationFrame(this.bobRaf); this.bobRaf = 0; }
    if (!enabled) {
      gsap.set(this.root, { yPercent: -50 });
      return;
    }
    const tick = () => {
      const phase = (performance.now() * 0.001 * Math.PI * 2) / 5.6;
      const yPct = -56 + 6 * Math.cos(phase);
      gsap.set(this.root, { yPercent: yPct });
      this.bobRaf = requestAnimationFrame(tick);
    };
    this.bobRaf = requestAnimationFrame(tick);
  }
}

// Hermite smoothstep — 0 below edge0, 1 above edge1, smooth cubic in between.
// Used for the glint's occlusion ramp so the fade through the orb boundary
// has no visible seam.
/**
 * Drag-direction angle (degrees) given motion vector (dx, dy) in screen
 * coords. Zero = up (arrow's native heading). 90 = right, 180 = down,
 * 270 = left. CSS rotations are clockwise in screen space, so we use
 * `atan2(dx, -dy)` to get the clockwise angle from the up-axis.
 */
function dragAngleDegrees(dx: number, dy: number): number {
  return Math.atan2(dx, -dy) * 180 / Math.PI;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ── localStorage helpers (frontend-side backup of anchor position) ──

const LS_KEY = "voice-anchor-pos";

function readLocalAnchor(): { fx: number; fy: number } | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.fx !== "number" || typeof p?.fy !== "number") return null;
    return { fx: p.fx, fy: p.fy };
  } catch {
    return null;
  }
}

function writeLocalAnchor(fx: number, fy: number) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ fx, fy })); } catch { /* quota */ }
}

// ── Drag-count helpers (learned-affordance decay for hover arrows) ──

const DRAG_COUNT_KEY = "voice-anchor-drag-count";

function readDragCount(): number {
  try {
    const raw = localStorage.getItem(DRAG_COUNT_KEY);
    const n = parseInt(raw ?? "0", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function incrementDragCount() {
  try {
    const next = readDragCount() + 1;
    localStorage.setItem(DRAG_COUNT_KEY, String(next));
  } catch { /* quota */ }
}

