# Idea: Plan Visualizer & Achievement System

## The Problem

Right now when a plan executes, progress is a checkbox list. Step 1 done, step 2 done... it's functional but forgettable. There's no sense of *momentum*, no reward signal, no spatial storytelling. You're watching a to-do list, not watching something get built.

## The Vision

A full-screen overlay system that turns plan execution into a visual narrative. Each step in the plan is a **node on a timeline** that animates through states — waiting, active, completed — with achievements that break free from the timeline and scatter across the screen like unlocked badges. The whole thing should feel like watching a build happen in real time, not reading a log.

## Core Concepts

### 1. The Spine — Linear Timeline

A horizontal or diagonal line that stretches across the screen. This is the plan's backbone.

- Appears when a plan is created, stretching from left to right
- Each step is a **node** on the spine — a circle or diamond shape
- Nodes are connected by the spine line, evenly spaced
- The spine can be straight, gently curved, or a slight S-curve for visual interest
- A **progress glow** travels along the spine as steps complete, like a signal racing down a wire

**Node states:**
| State | Visual |
|-------|--------|
| Pending | Dim outline, ghosted label |
| Active | Pulsing ring, bright label, particle emission |
| Completed | Solid fill, checkmark, brief burst animation |
| Failed | Red crack effect, shake |

### 2. Achievements — Breakaway Cards

When a step completes, it doesn't just check off. It **launches an achievement card** that flies to a random position on screen, lingers, then fades.

- Card contains: step name, a one-line summary of what was done, and an icon/emoji
- Cards animate out from the spine node: scale up from 0, drift to their landing spot with a slight overshoot bounce
- Each card lands in a different region of the screen (quadrant-based placement to avoid overlap)
- Cards have a frosted glass / translucent dark background with a colored left-border matching the step's category
- After 5-8 seconds, cards gracefully fade and drift upward (like they're floating away)
- If multiple achievements fire rapidly, they stagger with 0.3s delays

**Achievement categories (color-coded):**
| Category | Color | Icon ideas |
|----------|-------|------------|
| File created | Green #6ee7a0 | sparkle, new-file |
| File modified | Amber #fcd34d | pencil, wrench |
| Test passed | Blue #8bc4ff | checkmark-shield |
| Build succeeded | Purple #c4b5fd | rocket |
| Milestone | Gold #fbbf24 | trophy, star |

### 3. The Summary Moment

When the entire plan completes:

- All remaining achievement cards fade simultaneously
- The spine collapses inward to center screen
- A **completion card** appears: larger, centered, with total stats
  - "Plan complete: 8/8 steps"
  - "12 files created, 3 modified"
  - "Duration: 4m 32s"
  - Optional: confetti particle burst behind the card (using existing Pixi particle system)
- The completion card holds for 4 seconds, then fades

### 4. Step Detail Peek

While a step is active (pulsing on the spine), a **detail panel** appears near the node:

- Shows what's currently happening: "Creating component scaffold..." or "Running tests..."
- File names scroll through as they're touched
- Small progress bar if the step has measurable sub-progress
- This replaces the active node when the step completes

## Data Flow

```
Claude plan created
  → Emit plan-viz-create { steps: [...], title: string }
  → Spine renders, nodes appear with staggered entrance

Step begins
  → Emit plan-viz-step-start { index: number, label: string }
  → Node transitions to active state, detail panel appears

Step completes
  → Emit plan-viz-step-done { index: number, summary: string, category: string, files?: string[] }
  → Node transitions to completed, achievement card launches
  → Progress glow advances along spine

Plan completes
  → Emit plan-viz-complete { stats: { duration, files_created, files_modified, tests_passed } }
  → Summary moment plays
```

## Integration Points

- **Tauri events** from file_watcher.rs already emit file change data — merge this into step tracking
- **Plan tasks** already flow through `chart-plan-update` in chart-column.ts — same data source, new renderer
- **Pixi app** ([pixi-app.ts](../src/pixi-app.ts)) already exists for GPU particles — use for confetti burst and node particle effects
- **GSAP** handles all DOM animations (cards, spine, labels)
- **D3** for the spine layout and node positioning (d3.scaleLinear for spacing, d3.arc for node shapes)

## Implementation Sketch

### New files
- `src/plan-viz.ts` — main orchestrator class (like FolderViz/ChartColumn pattern)
- `src/plan-viz-spine.ts` — spine line + node rendering
- `src/plan-viz-achievement.ts` — achievement card spawning + placement

### Rendering approach
- Spine and nodes: **SVG via D3** (crisp lines, easy text, path animations)
- Achievement cards: **DOM + GSAP** (text-heavy, frosted glass CSS, complex layout)
- Particle effects: **Pixi** (existing GPU particle system for bursts)
- All layers use `pointer-events: none` and `position: fixed` like existing overlays

### Placement strategy for achievements
```
Screen divided into zones:

  [  TL  ] [  TC  ] [  TR  ]
  [  ML  ] [ SPINE ] [  MR  ]
  [  BL  ] [  BC  ] [  BR  ]

Cards avoid the spine's horizontal band.
Each card picks from available zones, cycling to prevent clustering.
Zone memory resets when all zones have been used.
```

## Variations to Explore

### A. Vertical Spine
Instead of horizontal, the spine runs top-to-bottom on the left edge. Achievements fly out to the right. This pairs naturally with scrolling — the spine can extend below the fold for long plans. More timeline-y, less dashboard-y.

### B. Orbital / Radial
Steps arranged in a circle. The active step is at the top, and the ring rotates as progress advances. Completed steps leave glowing arcs. Feels more like a loading ring / progress wheel. Compact. Good for plans with fewer steps.

### C. Node Graph
For plans with dependencies (step 3 depends on step 1 and 2), render as a DAG instead of a line. D3-force layout. Edges light up as dependencies resolve. More complex but more honest about how plans actually execute (especially with parallel subagents).

### D. Minimal / Ambient
No spine. Just the achievement cards popping in around the edges of the screen with a subtle ambient particle field behind them. The *absence* of a timeline makes each achievement feel like a standalone moment. Calmer, less "gamified."

## Open Questions

- Should the spine persist between plans or fade completely between sessions?
- How does this interact with the existing chart-column? Replace it? Coexist?
- For long plans (20+ steps), should the spine scroll/compress, or should we switch to the radial layout?
- Should achievements have sound effects? (A subtle chime per completion would pair well with the existing TTS system)
- Can we pull richer data from Claude's output to generate better achievement summaries, or do we just use the step label?

## Mood

Think: GitHub's contribution graph meets RPG quest tracker meets Apple's activity rings. Clean, dark, glowing edges, no clutter. Information through motion, not density.
