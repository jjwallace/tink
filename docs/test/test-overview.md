# Plan Visualizer Test Documents

These docs exist to test the PixiJS force graph plan visualizer. Each document was created as a step in a TodoWrite plan, which fires a PreToolUse hook that forwards the todo list to the speak server's `/plan` endpoint, which emits a `plan-viz-update` Tauri event, which the PlanViz orchestrator picks up and renders as a live force-directed graph.

## What to look for

- Nodes fly in from the right side, staggered
- Gravity pulls them to bottom-center (75% down screen)
- Springs keep connected nodes at ~130px distance
- Repulsion prevents overlap
- Active node (in_progress) pulses gold
- Completed nodes turn green with a checkmark
- Achievement cards appear near the graph when steps complete
- A localized dark shadow sits behind the node cluster for readability
