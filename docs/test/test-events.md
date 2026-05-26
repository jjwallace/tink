# Event Flow: TodoWrite → PixiJS Force Graph

Complete data flow from Claude Code plan creation to visual output.

## Sequence

```
Claude Code: TodoWrite({todos: [...]})
  ↓ PreToolUse hook fires
~/.claude/hooks/plan-update.sh
  ↓ jq extracts tool_input, POSTs to speak server
curl POST http://127.0.0.1:9877/plan {todos: [...]}
  ↓ Rust speak_server.rs parses JSON
handle.emit("plan-viz-update", payload)
  ↓ Tauri event broadcast to frontend
PlanViz.onTodoUpdate(payload)
  ↓ Diff against previous state
  ↓ First time: PlanVizForceGraph.createPlan(steps)
  ↓   → Nodes spawn at right edge with leftward velocity
  ↓   → Physics tick starts: springs + repulsion + gravity
  ↓ Subsequent: setNodeState() for changed items
  ↓   → pending→active: gold ring pulse
  ↓   → active→completed: green fill + checkmark + bounce
  ↓   → AchievementManager.spawn() for completed items
```

## Event Names

| Event | Direction | Payload |
|-------|-----------|---------|
| `plan-viz-update` | Tauri → frontend | `{todos: [{content, status, activeForm}]}` |
| `plan-viz-create` | Tauri → frontend | `{steps: [{label, deps?}], title}` |
| `plan-viz-step-start` | Tauri → frontend | `{index, label}` |
| `plan-viz-step-done` | Tauri → frontend | `{index, summary, category}` |
| `plan-viz-demo` | Tauri → frontend | `()` |
