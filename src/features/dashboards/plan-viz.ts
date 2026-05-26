import gsap from "gsap";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Application } from "pixi.js";
import { getPixiApp } from "../../pixi-app";
import { PlanVizForceGraph, type NodeState, type StepDef } from "./plan-viz-pixi";
import { AchievementManager } from "./plan-viz-achievement";

// ─── Event payload interfaces ───

interface PlanVizCreateEvent {
  steps: Array<{ label: string; category?: string; deps?: number[] }>;
  title: string;
}

interface PlanVizStepStartEvent {
  index: number;
  label: string;
}

interface PlanVizStepDoneEvent {
  index: number;
  summary: string;
  category: string;
  files?: string[];
}

// Live todo list from speak server (matches TodoWrite shape)
interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface PlanVizUpdateEvent {
  todos: TodoItem[];
}

// ─── Demo data ───

const DEMO_STEPS: Array<StepDef & { category: string; summary: string }> = [
  { label: "Scaffold project", category: "file-created", summary: "Created project structure with 8 files", deps: [] },
  { label: "Create components", category: "file-created", summary: "Built 3 UI components", deps: [0] },
  { label: "Write styles", category: "file-modified", summary: "Added theme tokens + component CSS", deps: [0] },
  { label: "Add business logic", category: "file-modified", summary: "Wired up state management", deps: [1] },
  { label: "Write tests", category: "test-passed", summary: "12 tests passing across 3 suites", deps: [1, 2] },
  { label: "Build & verify", category: "build", summary: "Production build succeeded — 142kb gzipped", deps: [3, 4] },
];

const DEMO_STEP_DELAY = 2000;

// ─── State mapping ───

function todoStatusToNodeState(status: string): NodeState {
  switch (status) {
    case "in_progress": return "active";
    case "completed": return "completed";
    default: return "pending";
  }
}

// ─── Main orchestrator ───

export class PlanViz {
  private parent: HTMLElement;
  private app: Application | null = null;
  private graph: PlanVizForceGraph | null = null;
  private achievements: AchievementManager;
  private unlisteners: UnlistenFn[] = [];

  // State
  private steps: StepDef[] = [];
  private categories: string[] = [];
  private states: NodeState[] = [];
  private active = false;

  // Previous todo snapshot for diffing
  private prevTodos: TodoItem[] = [];

  // Demo
  private demoTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(parent: HTMLElement) {
    this.parent = parent;
    this.achievements = new AchievementManager(parent);
  }

  async init() {
    this.unlisteners.push(
      await listen<PlanVizCreateEvent>("plan-viz-create", (e) => this.onCreate(e.payload)),
      await listen<PlanVizStepStartEvent>("plan-viz-step-start", (e) => this.onStepStart(e.payload)),
      await listen<PlanVizStepDoneEvent>("plan-viz-step-done", (e) => this.onStepDone(e.payload)),
      await listen<PlanVizUpdateEvent>("plan-viz-update", (e) => this.onTodoUpdate(e.payload)),
      await listen("plan-viz-demo", () => this.demo()),
    );
  }

  // ── Live todo list integration ──

  private async onTodoUpdate(payload: PlanVizUpdateEvent) {
    const todos = payload.todos;
    if (!todos || todos.length === 0) return;

    // If graph doesn't exist yet or step count changed, create fresh
    if (!this.active || this.steps.length !== todos.length) {
      await this.onCreate({
        title: "Plan",
        steps: todos.map((t) => ({
          label: t.content,
          category: "milestone",
        })),
      });
      // Apply current states
      for (let i = 0; i < todos.length; i++) {
        const state = todoStatusToNodeState(todos[i].status);
        if (state !== "pending") {
          this.states[i] = state;
          this.graph?.setNodeState(i, state);
        }
      }
      this.prevTodos = [...todos];
      return;
    }

    // Diff: detect state changes
    for (let i = 0; i < todos.length; i++) {
      const newState = todoStatusToNodeState(todos[i].status);
      const prevState = i < this.prevTodos.length
        ? todoStatusToNodeState(this.prevTodos[i].status)
        : "pending";

      if (newState !== prevState) {
        this.states[i] = newState;
        this.graph?.setNodeState(i, newState);

        // Spawn achievement when a step completes
        if (newState === "completed" && this.graph) {
          const pos = this.graph.getNodePosition(i);
          const summary = todos[i].activeForm || todos[i].content;
          this.achievements.spawn(summary, "milestone", pos.x, pos.y);
        }
      }
    }

    this.prevTodos = [...todos];
  }

  // ── Event handlers ──

  private async onCreate(payload: PlanVizCreateEvent) {
    this.teardownCurrent();

    this.steps = payload.steps.map((s) => ({
      label: s.label,
      deps: s.deps,
    }));
    this.categories = payload.steps.map((s) => s.category || "milestone");
    this.states = payload.steps.map(() => "pending" as NodeState);
    this.active = true;

    this.achievements.resetZones();

    if (!this.app) {
      this.app = await getPixiApp(this.parent);
    }
    this.graph = new PlanVizForceGraph(this.app);
    this.graph.createPlan(this.steps);
  }

  private onStepStart(payload: PlanVizStepStartEvent) {
    if (!this.active || !this.graph) return;
    const i = payload.index;
    if (i < 0 || i >= this.states.length) return;

    this.states[i] = "active";
    this.graph.setNodeState(i, "active");
  }

  private onStepDone(payload: PlanVizStepDoneEvent) {
    if (!this.active || !this.graph) return;
    const i = payload.index;
    if (i < 0 || i >= this.states.length) return;

    this.states[i] = "completed";
    this.graph.setNodeState(i, "completed");

    const pos = this.graph.getNodePosition(i);
    this.achievements.spawn(
      payload.summary,
      payload.category || this.categories[i],
      pos.x,
      pos.y,
    );
  }

  // ── Demo ──

  demo() {
    for (const t of this.demoTimers) clearTimeout(t);
    this.demoTimers = [];

    this.onCreate({
      title: "Demo Plan",
      steps: DEMO_STEPS.map((s) => ({
        label: s.label,
        category: s.category,
        deps: s.deps,
      })),
    });

    let delay = 1200;
    for (let i = 0; i < DEMO_STEPS.length; i++) {
      this.demoTimers.push(
        setTimeout(() => {
          this.onStepStart({ index: i, label: DEMO_STEPS[i].label });
        }, delay),
      );
      delay += DEMO_STEP_DELAY;
      this.demoTimers.push(
        setTimeout(() => {
          this.onStepDone({
            index: i,
            summary: DEMO_STEPS[i].summary,
            category: DEMO_STEPS[i].category,
          });
        }, delay),
      );
      delay += 400;
    }
    // No end celebration — nodes just stay completed
  }

  // ── Internal ──

  private teardownCurrent() {
    this.active = false;
    this.graph?.clear();
    this.graph = null;
    this.achievements.destroy();
    this.steps = [];
    this.categories = [];
    this.states = [];
    this.prevTodos = [];
  }

  async destroy() {
    for (const t of this.demoTimers) clearTimeout(t);
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.teardownCurrent();
  }
}
