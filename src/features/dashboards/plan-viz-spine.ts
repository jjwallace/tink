import * as d3 from "d3";
import gsap from "gsap";

// ─── Types ───

export type SpineMode =
  | "horizontal"
  | "vertical"
  | "orbital"
  | "dag"
  | "minimal";

export type NodeState = "pending" | "active" | "completed" | "failed";

export interface NodePosition {
  x: number;
  y: number;
}

export interface StepDef {
  label: string;
  deps?: number[];
}

export interface SpineLayout {
  render(svg: SVGSVGElement, steps: StepDef[], states: NodeState[]): void;
  getNodePosition(index: number): NodePosition;
  setNodeState(index: number, state: NodeState): void;
  updateProgress(completed: number, total: number): void;
  collapse(cx: number, cy: number): Promise<void>;
  destroy(): void;
}

// ─── Shared constants ───

const NODE_R = 12;
const NODE_INNER_R = 8;
const PENDING_STROKE = "rgba(255,255,255,0.15)";
const ACTIVE_STROKE = "#fbbf24";
const COMPLETE_FILL = "#6ee7a0";
const FAIL_FILL = "#ef4444";
const LABEL_DIM = "rgba(255,255,255,0.4)";
const LABEL_BRIGHT = "rgba(255,255,255,0.9)";
const SPINE_BG = "rgba(255,255,255,0.06)";
const SPINE_GLOW = "#fbbf24";

const NS = "http://www.w3.org/2000/svg";

// ─── Helpers ───

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs))
    el.setAttribute(k, String(v));
  return el;
}

function addDefs(svg: SVGSVGElement) {
  if (svg.querySelector("defs#pv-defs")) return;
  const defs = svgEl("defs", { id: "pv-defs" });

  // Glow filter for progress path
  const glow = svgEl("filter", {
    id: "pv-glow",
    x: "-50%",
    y: "-50%",
    width: "200%",
    height: "200%",
  });
  const blur = svgEl("feGaussianBlur", {
    in: "SourceGraphic",
    stdDeviation: "4",
    result: "blur",
  });
  const merge = svgEl("feMerge");
  merge.appendChild(svgEl("feMergeNode", { in: "blur" }));
  merge.appendChild(svgEl("feMergeNode", { in: "SourceGraphic" }));
  glow.appendChild(blur);
  glow.appendChild(merge);
  defs.appendChild(glow);

  // Text background filter
  const textBg = svgEl("filter", {
    id: "pv-text-bg",
    x: "-20%",
    y: "-20%",
    width: "140%",
    height: "140%",
  });
  const flood = svgEl("feFlood", {
    "flood-color": "black",
    "flood-opacity": "0.85",
    result: "bg",
  });
  const comp = svgEl("feComposite", {
    in: "bg",
    in2: "SourceGraphic",
    operator: "in",
    result: "bg-clip",
  });
  const tBlur = svgEl("feGaussianBlur", {
    in: "bg-clip",
    stdDeviation: "3",
    result: "bg-blur",
  });
  const tMerge = svgEl("feMerge");
  tMerge.appendChild(svgEl("feMergeNode", { in: "bg-blur" }));
  tMerge.appendChild(svgEl("feMergeNode", { in: "SourceGraphic" }));
  textBg.appendChild(flood);
  textBg.appendChild(comp);
  textBg.appendChild(tBlur);
  textBg.appendChild(tMerge);
  defs.appendChild(textBg);

  svg.insertBefore(defs, svg.firstChild);
}

function createNodeGroup(
  parent: SVGElement,
  x: number,
  y: number,
  label: string,
  labelOffset: { dx: number; dy: number } = { dx: 0, dy: 28 },
): SVGGElement {
  const g = svgEl("g");
  g.setAttribute("transform", `translate(${x},${y})`);

  // Outer ring (state indicator)
  const ring = svgEl("circle", {
    r: NODE_R,
    fill: "none",
    stroke: PENDING_STROKE,
    "stroke-width": 1.5,
    class: "node-ring",
  });
  g.appendChild(ring);

  // Inner fill (hidden until completed)
  const fill = svgEl("circle", {
    r: 0,
    fill: COMPLETE_FILL,
    class: "node-fill",
  });
  g.appendChild(fill);

  // Pulse ring (hidden, used for active state)
  const pulse = svgEl("circle", {
    r: NODE_R,
    fill: "none",
    stroke: ACTIVE_STROKE,
    "stroke-width": 2,
    opacity: 0,
    class: "node-pulse",
  });
  g.appendChild(pulse);

  // Checkmark (hidden until completed)
  const check = svgEl("path", {
    d: "M-4,0 L-1,3 L4,-3",
    fill: "none",
    stroke: "rgba(0,0,0,0.7)",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    opacity: 0,
    class: "node-check",
  });
  g.appendChild(check);

  // Label
  const text = svgEl("text", {
    x: labelOffset.dx,
    y: labelOffset.dy,
    "text-anchor": "middle",
    fill: LABEL_DIM,
    "font-size": "11",
    "font-family": "'SF Pro Text', -apple-system, system-ui, sans-serif",
    "font-weight": "500",
    filter: "url(#pv-text-bg)",
    class: "node-label",
  });
  text.textContent = label;
  g.appendChild(text);

  parent.appendChild(g);
  return g;
}

function applyNodeState(g: SVGGElement, state: NodeState) {
  const ring = g.querySelector(".node-ring") as SVGCircleElement;
  const fill = g.querySelector(".node-fill") as SVGCircleElement;
  const pulse = g.querySelector(".node-pulse") as SVGCircleElement;
  const check = g.querySelector(".node-check") as SVGPathElement;
  const label = g.querySelector(".node-label") as SVGTextElement;

  // Kill any existing pulse animation
  gsap.killTweensOf(pulse);

  switch (state) {
    case "pending":
      gsap.to(ring, { attr: { stroke: PENDING_STROKE, "stroke-width": 1.5 }, duration: 0.3 });
      gsap.to(fill, { attr: { r: 0 }, duration: 0.3 });
      gsap.to(pulse, { opacity: 0, duration: 0.2 });
      gsap.to(check, { opacity: 0, duration: 0.2 });
      gsap.to(label, { attr: { fill: LABEL_DIM }, duration: 0.3 });
      break;

    case "active":
      gsap.to(ring, { attr: { stroke: ACTIVE_STROKE, "stroke-width": 2 }, duration: 0.3 });
      gsap.to(label, { attr: { fill: LABEL_BRIGHT }, duration: 0.3 });
      gsap.to(fill, { attr: { r: 0 }, duration: 0.2 });
      gsap.to(check, { opacity: 0, duration: 0.2 });
      // Start pulse
      gsap.set(pulse, { opacity: 0.7, attr: { r: NODE_R } });
      gsap.to(pulse, {
        attr: { r: NODE_R + 10 },
        opacity: 0,
        duration: 1.2,
        repeat: -1,
        ease: "power2.out",
      });
      break;

    case "completed":
      gsap.to(ring, { attr: { stroke: COMPLETE_FILL, "stroke-width": 2 }, duration: 0.3 });
      gsap.to(fill, { attr: { r: NODE_INNER_R }, duration: 0.4, ease: "back.out(2)" });
      gsap.to(pulse, { opacity: 0, duration: 0.2 });
      gsap.to(check, { opacity: 1, duration: 0.3, delay: 0.2 });
      gsap.to(label, { attr: { fill: LABEL_BRIGHT }, duration: 0.3 });
      // Brief scale pop
      gsap.fromTo(g, { scale: 1 }, { scale: 1.2, duration: 0.15, yoyo: true, repeat: 1, ease: "power2.out" });
      break;

    case "failed":
      gsap.to(ring, { attr: { stroke: FAIL_FILL, "stroke-width": 2.5 }, duration: 0.2 });
      gsap.to(fill, { attr: { r: NODE_INNER_R, fill: FAIL_FILL }, duration: 0.3 });
      gsap.to(pulse, { opacity: 0, duration: 0.2 });
      gsap.to(label, { attr: { fill: FAIL_FILL }, duration: 0.3 });
      // Shake
      gsap.fromTo(g, { x: -4 }, { x: 4, duration: 0.06, repeat: 5, yoyo: true, ease: "none" });
      break;
  }
}

// ═══════════════════════════════════════════════════
//  HORIZONTAL SPINE — S-curve across screen center
// ═══════════════════════════════════════════════════

class HorizontalSpine implements SpineLayout {
  private nodes: SVGGElement[] = [];
  private positions: NodePosition[] = [];
  private bgPath: SVGPathElement | null = null;
  private progressPath: SVGPathElement | null = null;
  private pathLength = 0;
  private group: SVGGElement | null = null;

  render(svg: SVGSVGElement, steps: StepDef[], states: NodeState[]) {
    addDefs(svg);
    this.group = svgEl("g", { class: "spine-horizontal" });
    svg.appendChild(this.group);

    const w = svg.viewBox.baseVal.width || window.innerWidth;
    const h = svg.viewBox.baseVal.height || window.innerHeight;
    const mx = w * 0.1;
    const cy = h * 0.5;
    const amp = h * 0.06;

    // S-curve control points
    const pts: [number, number][] = [
      [mx, cy],
      [w * 0.25, cy - amp],
      [w * 0.5, cy + amp * 0.3],
      [w * 0.75, cy + amp],
      [w - mx, cy],
    ];
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    const d = lineGen(pts)!;

    // Background path
    this.bgPath = svgEl("path", {
      d,
      fill: "none",
      stroke: SPINE_BG,
      "stroke-width": 2,
      "stroke-linecap": "round",
    });
    this.group.appendChild(this.bgPath);

    // Progress path (glow)
    this.progressPath = svgEl("path", {
      d,
      fill: "none",
      stroke: SPINE_GLOW,
      "stroke-width": 3,
      "stroke-linecap": "round",
      filter: "url(#pv-glow)",
      opacity: 0.9,
    });
    this.group.appendChild(this.progressPath);
    this.pathLength = this.progressPath.getTotalLength();
    this.progressPath.style.strokeDasharray = `${this.pathLength}`;
    this.progressPath.style.strokeDashoffset = `${this.pathLength}`;

    // Place nodes along path
    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const frac = n > 1 ? i / (n - 1) : 0.5;
      const pt = this.progressPath.getPointAtLength(frac * this.pathLength);
      this.positions.push({ x: pt.x, y: pt.y });
      const g = createNodeGroup(this.group, pt.x, pt.y, steps[i].label);

      // Staggered entrance
      gsap.set(g, { opacity: 0, scale: 0 });
      gsap.to(g, { opacity: 1, scale: 1, duration: 0.4, delay: i * 0.08, ease: "back.out(1.5)" });

      this.nodes.push(g);
      if (states[i] !== "pending") applyNodeState(g, states[i]);
    }
  }

  getNodePosition(i: number): NodePosition {
    return this.positions[i] || { x: 0, y: 0 };
  }

  setNodeState(i: number, state: NodeState) {
    if (this.nodes[i]) applyNodeState(this.nodes[i], state);
  }

  updateProgress(completed: number, total: number) {
    if (!this.progressPath) return;
    const frac = total > 0 ? completed / total : 0;
    const offset = this.pathLength * (1 - frac);
    gsap.to(this.progressPath.style, {
      strokeDashoffset: offset,
      duration: 0.8,
      ease: "power2.out",
    });
  }

  async collapse(cx: number, cy: number) {
    const promises: Promise<void>[] = [];
    for (const g of this.nodes) {
      promises.push(
        new Promise((resolve) => {
          gsap.to(g, {
            attr: { transform: `translate(${cx},${cy})` },
            opacity: 0,
            scale: 0.3,
            duration: 0.6,
            ease: "power2.in",
            onComplete: resolve,
          });
        }),
      );
    }
    if (this.bgPath) gsap.to(this.bgPath, { opacity: 0, duration: 0.5 });
    if (this.progressPath) gsap.to(this.progressPath, { opacity: 0, duration: 0.5 });
    await Promise.all(promises);
  }

  destroy() {
    for (const g of this.nodes) gsap.killTweensOf(g);
    if (this.progressPath) gsap.killTweensOf(this.progressPath.style);
    this.group?.remove();
    this.nodes = [];
    this.positions = [];
  }
}

// ═══════════════════════════════════════════════════
//  VERTICAL SPINE — top-to-bottom on left side
// ═══════════════════════════════════════════════════

class VerticalSpine implements SpineLayout {
  private nodes: SVGGElement[] = [];
  private positions: NodePosition[] = [];
  private bgPath: SVGPathElement | null = null;
  private progressPath: SVGPathElement | null = null;
  private pathLength = 0;
  private group: SVGGElement | null = null;

  render(svg: SVGSVGElement, steps: StepDef[], states: NodeState[]) {
    addDefs(svg);
    this.group = svgEl("g", { class: "spine-vertical" });
    svg.appendChild(this.group);

    const h = svg.viewBox.baseVal.height || window.innerHeight;
    const x = 80;
    const topM = h * 0.08;
    const botM = h * 0.08;
    const amp = 18;

    const pts: [number, number][] = [
      [x, topM],
      [x + amp, h * 0.3],
      [x - amp * 0.5, h * 0.5],
      [x + amp, h * 0.7],
      [x, h - botM],
    ];
    const lineGen = d3.line<[number, number]>().curve(d3.curveBasis);
    const d = lineGen(pts)!;

    this.bgPath = svgEl("path", {
      d, fill: "none", stroke: SPINE_BG, "stroke-width": 2, "stroke-linecap": "round",
    });
    this.group.appendChild(this.bgPath);

    this.progressPath = svgEl("path", {
      d, fill: "none", stroke: SPINE_GLOW, "stroke-width": 3,
      "stroke-linecap": "round", filter: "url(#pv-glow)", opacity: 0.9,
    });
    this.group.appendChild(this.progressPath);
    this.pathLength = this.progressPath.getTotalLength();
    this.progressPath.style.strokeDasharray = `${this.pathLength}`;
    this.progressPath.style.strokeDashoffset = `${this.pathLength}`;

    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const frac = n > 1 ? i / (n - 1) : 0.5;
      const pt = this.progressPath.getPointAtLength(frac * this.pathLength);
      this.positions.push({ x: pt.x, y: pt.y });
      // Label to the right
      const g = createNodeGroup(this.group, pt.x, pt.y, steps[i].label, { dx: 60, dy: 4 });
      const lbl = g.querySelector(".node-label") as SVGTextElement;
      if (lbl) lbl.setAttribute("text-anchor", "start");

      gsap.set(g, { opacity: 0, scale: 0 });
      gsap.to(g, { opacity: 1, scale: 1, duration: 0.4, delay: i * 0.08, ease: "back.out(1.5)" });
      this.nodes.push(g);
      if (states[i] !== "pending") applyNodeState(g, states[i]);
    }
  }

  getNodePosition(i: number): NodePosition {
    return this.positions[i] || { x: 0, y: 0 };
  }
  setNodeState(i: number, state: NodeState) {
    if (this.nodes[i]) applyNodeState(this.nodes[i], state);
  }
  updateProgress(completed: number, total: number) {
    if (!this.progressPath) return;
    const frac = total > 0 ? completed / total : 0;
    gsap.to(this.progressPath.style, {
      strokeDashoffset: this.pathLength * (1 - frac),
      duration: 0.8,
      ease: "power2.out",
    });
  }
  async collapse(cx: number, cy: number) {
    const ps = this.nodes.map(
      (g) =>
        new Promise<void>((resolve) =>
          gsap.to(g, {
            attr: { transform: `translate(${cx},${cy})` },
            opacity: 0, scale: 0.3, duration: 0.6, ease: "power2.in", onComplete: resolve,
          }),
        ),
    );
    if (this.bgPath) gsap.to(this.bgPath, { opacity: 0, duration: 0.5 });
    if (this.progressPath) gsap.to(this.progressPath, { opacity: 0, duration: 0.5 });
    await Promise.all(ps);
  }
  destroy() {
    for (const g of this.nodes) gsap.killTweensOf(g);
    if (this.progressPath) gsap.killTweensOf(this.progressPath.style);
    this.group?.remove();
    this.nodes = [];
    this.positions = [];
  }
}

// ═══════════════════════════════════════════════════
//  ORBITAL SPINE — nodes on a circle, progress arc
// ═══════════════════════════════════════════════════

class OrbitalSpine implements SpineLayout {
  private nodes: SVGGElement[] = [];
  private positions: NodePosition[] = [];
  private bgCircle: SVGCircleElement | null = null;
  private progressArc: SVGPathElement | null = null;
  private group: SVGGElement | null = null;
  private cx = 0;
  private cy = 0;
  private radius = 0;

  render(svg: SVGSVGElement, steps: StepDef[], states: NodeState[]) {
    addDefs(svg);
    this.group = svgEl("g", { class: "spine-orbital" });
    svg.appendChild(this.group);

    const w = svg.viewBox.baseVal.width || window.innerWidth;
    const h = svg.viewBox.baseVal.height || window.innerHeight;
    this.cx = w * 0.5;
    this.cy = h * 0.5;
    this.radius = Math.min(w, h) * 0.22;

    // Background circle
    this.bgCircle = svgEl("circle", {
      cx: this.cx, cy: this.cy, r: this.radius,
      fill: "none", stroke: SPINE_BG, "stroke-width": 2,
    });
    this.group.appendChild(this.bgCircle);

    // Progress arc (rendered via d3.arc, updated on progress)
    this.progressArc = svgEl("path", {
      fill: "none", stroke: SPINE_GLOW, "stroke-width": 3,
      "stroke-linecap": "round", filter: "url(#pv-glow)", opacity: 0.9,
    });
    this.group.appendChild(this.progressArc);

    const n = steps.length;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2; // start at top
      const nx = this.cx + Math.cos(angle) * this.radius;
      const ny = this.cy + Math.sin(angle) * this.radius;
      this.positions.push({ x: nx, y: ny });

      // Label outside the ring
      const labelAngle = angle;
      const lx = Math.cos(labelAngle) * 28;
      const ly = Math.sin(labelAngle) * 28;
      const g = createNodeGroup(this.group, nx, ny, steps[i].label, { dx: lx, dy: ly });
      const lbl = g.querySelector(".node-label") as SVGTextElement;
      if (lbl) {
        // Anchor based on position: left half → end, right half → start
        lbl.setAttribute("text-anchor", Math.cos(labelAngle) < -0.1 ? "end" : Math.cos(labelAngle) > 0.1 ? "start" : "middle");
      }

      gsap.set(g, { opacity: 0, scale: 0 });
      gsap.to(g, { opacity: 1, scale: 1, duration: 0.4, delay: i * 0.06, ease: "back.out(1.5)" });
      this.nodes.push(g);
      if (states[i] !== "pending") applyNodeState(g, states[i]);
    }
  }

  getNodePosition(i: number): NodePosition {
    return this.positions[i] || { x: 0, y: 0 };
  }
  setNodeState(i: number, state: NodeState) {
    if (this.nodes[i]) applyNodeState(this.nodes[i], state);
  }

  updateProgress(completed: number, total: number) {
    if (!this.progressArc) return;
    const frac = total > 0 ? completed / total : 0;
    if (frac <= 0) {
      this.progressArc.setAttribute("d", "");
      return;
    }

    const arcGen = d3.arc<any>()
      .innerRadius(this.radius - 1.5)
      .outerRadius(this.radius + 1.5)
      .startAngle(0)
      .cornerRadius(2);

    const endAngle = frac * Math.PI * 2;
    // We need to translate the arc to center
    this.progressArc.setAttribute("d", arcGen({ endAngle }) || "");
    this.progressArc.setAttribute(
      "transform",
      `translate(${this.cx},${this.cy})`,
    );
    // Switch from stroke to fill for arc
    this.progressArc.setAttribute("fill", SPINE_GLOW);
    this.progressArc.setAttribute("stroke", "none");
    this.progressArc.setAttribute("opacity", "0.7");
  }

  async collapse(cx: number, cy: number) {
    const ps = this.nodes.map(
      (g) =>
        new Promise<void>((resolve) =>
          gsap.to(g, {
            attr: { transform: `translate(${cx},${cy})` },
            opacity: 0, scale: 0.3, duration: 0.6, ease: "power2.in", onComplete: resolve,
          }),
        ),
    );
    if (this.bgCircle) gsap.to(this.bgCircle, { opacity: 0, duration: 0.5 });
    if (this.progressArc) gsap.to(this.progressArc, { opacity: 0, duration: 0.5 });
    await Promise.all(ps);
  }

  destroy() {
    for (const g of this.nodes) gsap.killTweensOf(g);
    this.group?.remove();
    this.nodes = [];
    this.positions = [];
  }
}

// ═══════════════════════════════════════════════════
//  DAG SPINE — force-directed dependency graph
// ═══════════════════════════════════════════════════

interface SimNode extends d3.SimulationNodeDatum {
  id: number;
  label: string;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  sourceIdx: number;
  targetIdx: number;
}

class DagSpine implements SpineLayout {
  private nodes: SVGGElement[] = [];
  private positions: NodePosition[] = [];
  private edges: SVGLineElement[] = [];
  private edgeDefs: SimLink[] = [];
  private group: SVGGElement | null = null;
  private stateCache: NodeState[] = [];

  render(svg: SVGSVGElement, steps: StepDef[], states: NodeState[]) {
    addDefs(svg);
    this.group = svgEl("g", { class: "spine-dag" });
    svg.appendChild(this.group);
    this.stateCache = [...states];

    const w = svg.viewBox.baseVal.width || window.innerWidth;
    const h = svg.viewBox.baseVal.height || window.innerHeight;

    // Build simulation nodes and links
    const simNodes: SimNode[] = steps.map((s, i) => ({
      id: i,
      label: s.label,
    }));

    const simLinks: SimLink[] = [];
    for (let i = 0; i < steps.length; i++) {
      const deps = steps[i].deps || (i > 0 ? [i - 1] : []);
      for (const dep of deps) {
        simLinks.push({
          source: simNodes[dep],
          target: simNodes[i],
          sourceIdx: dep,
          targetIdx: i,
        });
      }
    }
    this.edgeDefs = simLinks;

    // Run simulation to completion synchronously
    const sim = d3
      .forceSimulation(simNodes)
      .force("link", d3.forceLink<SimNode, SimLink>(simLinks).distance(140).strength(1))
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(w * 0.5, h * 0.5))
      .force("x", d3.forceX(w * 0.5).strength(0.05))
      .force("y", d3.forceY(h * 0.5).strength(0.05))
      .stop();

    // Tick synchronously
    for (let i = 0; i < 300; i++) sim.tick();

    // Store positions
    for (const n of simNodes) {
      this.positions.push({ x: n.x!, y: n.y! });
    }

    // Draw edges first (below nodes)
    const edgeGroup = svgEl("g", { class: "dag-edges" });
    this.group.appendChild(edgeGroup);
    for (const link of simLinks) {
      const src = link.source as SimNode;
      const tgt = link.target as SimNode;
      const line = svgEl("line", {
        x1: src.x!,
        y1: src.y!,
        x2: tgt.x!,
        y2: tgt.y!,
        stroke: SPINE_BG,
        "stroke-width": 2,
        "stroke-linecap": "round",
      });
      edgeGroup.appendChild(line);
      this.edges.push(line);
    }

    // Draw nodes
    for (let i = 0; i < simNodes.length; i++) {
      const n = simNodes[i];
      const g = createNodeGroup(this.group, n.x!, n.y!, n.label, { dx: 0, dy: 28 });
      gsap.set(g, { opacity: 0, scale: 0 });
      gsap.to(g, { opacity: 1, scale: 1, duration: 0.5, delay: i * 0.1, ease: "back.out(1.5)" });
      this.nodes.push(g);
      if (states[i] !== "pending") applyNodeState(g, states[i]);
    }

    // Animate edges in
    for (let i = 0; i < this.edges.length; i++) {
      gsap.set(this.edges[i], { opacity: 0 });
      gsap.to(this.edges[i], { opacity: 1, duration: 0.4, delay: 0.2 + i * 0.05 });
    }
  }

  getNodePosition(i: number): NodePosition {
    return this.positions[i] || { x: 0, y: 0 };
  }

  setNodeState(i: number, state: NodeState) {
    this.stateCache[i] = state;
    if (this.nodes[i]) applyNodeState(this.nodes[i], state);
    // Light up edges whose dependencies are now resolved
    this.updateEdgeGlow();
  }

  private updateEdgeGlow() {
    for (let i = 0; i < this.edgeDefs.length; i++) {
      const link = this.edgeDefs[i];
      const srcDone = this.stateCache[link.sourceIdx] === "completed";
      const tgtActive =
        this.stateCache[link.targetIdx] === "active" ||
        this.stateCache[link.targetIdx] === "completed";

      if (srcDone && tgtActive) {
        gsap.to(this.edges[i], {
          attr: { stroke: COMPLETE_FILL, "stroke-width": 3 },
          duration: 0.5,
        });
        this.edges[i].setAttribute("filter", "url(#pv-glow)");
      }
    }
  }

  updateProgress(_completed: number, _total: number) {
    // Progress is shown via edge glow, handled in setNodeState
  }

  async collapse(cx: number, cy: number) {
    const ps = this.nodes.map(
      (g) =>
        new Promise<void>((resolve) =>
          gsap.to(g, {
            attr: { transform: `translate(${cx},${cy})` },
            opacity: 0, scale: 0.3, duration: 0.6, ease: "power2.in", onComplete: resolve,
          }),
        ),
    );
    for (const e of this.edges) gsap.to(e, { opacity: 0, duration: 0.4 });
    await Promise.all(ps);
  }

  destroy() {
    for (const g of this.nodes) gsap.killTweensOf(g);
    for (const e of this.edges) gsap.killTweensOf(e);
    this.group?.remove();
    this.nodes = [];
    this.positions = [];
    this.edges = [];
  }
}

// ═══════════════════════════════════════════════════
//  MINIMAL SPINE — ambient, no visible spine
// ═══════════════════════════════════════════════════

class MinimalSpine implements SpineLayout {
  private positions: NodePosition[] = [];
  private group: SVGGElement | null = null;
  private pulseCircle: SVGCircleElement | null = null;
  private cx = 0;
  private cy = 0;

  render(svg: SVGSVGElement, steps: StepDef[], _states: NodeState[]) {
    addDefs(svg);
    this.group = svgEl("g", { class: "spine-minimal" });
    svg.appendChild(this.group);

    const w = svg.viewBox.baseVal.width || window.innerWidth;
    const h = svg.viewBox.baseVal.height || window.innerHeight;
    this.cx = w * 0.5;
    this.cy = h * 0.5;

    // Subtle center pulse
    this.pulseCircle = svgEl("circle", {
      cx: this.cx,
      cy: this.cy,
      r: 20,
      fill: "none",
      stroke: "rgba(255,255,255,0.06)",
      "stroke-width": 1,
    });
    this.group.appendChild(this.pulseCircle);

    // Distribute positions around edges for achievement placement
    const n = steps.length;
    for (let i = 0; i < n; i++) {
      // Spread along bottom edge
      const x = w * (0.2 + (0.6 * i) / Math.max(n - 1, 1));
      const y = h * 0.85;
      this.positions.push({ x, y });
    }
  }

  getNodePosition(i: number): NodePosition {
    return this.positions[i] || { x: this.cx, y: this.cy };
  }

  setNodeState(_i: number, state: NodeState) {
    if (!this.pulseCircle) return;
    // Pulse on each state change
    const color =
      state === "completed"
        ? COMPLETE_FILL
        : state === "active"
          ? ACTIVE_STROKE
          : state === "failed"
            ? FAIL_FILL
            : "rgba(255,255,255,0.15)";

    // Create expanding ring
    if (this.group) {
      const ring = svgEl("circle", {
        cx: this.cx,
        cy: this.cy,
        r: 20,
        fill: "none",
        stroke: color,
        "stroke-width": 2,
        opacity: 0.6,
      });
      this.group.appendChild(ring);
      gsap.to(ring, {
        attr: { r: 80, "stroke-width": 0.5 },
        opacity: 0,
        duration: 1.5,
        ease: "power2.out",
        onComplete: () => ring.remove(),
      });
    }
  }

  updateProgress(_completed: number, _total: number) {
    // No visible progress bar in minimal mode
  }

  async collapse() {
    if (this.pulseCircle) {
      gsap.to(this.pulseCircle, { opacity: 0, duration: 0.5 });
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  destroy() {
    this.group?.remove();
    this.positions = [];
  }
}

// ─── Factory ───

export function createSpineLayout(mode: SpineMode): SpineLayout {
  switch (mode) {
    case "horizontal":
      return new HorizontalSpine();
    case "vertical":
      return new VerticalSpine();
    case "orbital":
      return new OrbitalSpine();
    case "dag":
      return new DagSpine();
    case "minimal":
      return new MinimalSpine();
  }
}
