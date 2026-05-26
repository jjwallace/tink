# Hook Wiring

The plan visualizer connects to Claude Code via the hook system.

## Flow

1. Claude Code calls `TodoWrite` tool
2. `PreToolUse` hook fires — `plan-update.sh` runs
3. Hook extracts `tool_input` JSON containing the todos array
4. Hook POSTs to `http://127.0.0.1:9877/plan`
5. Speak server (`speak_server.rs`) emits `plan-viz-update` Tauri event
6. Frontend `PlanViz` class receives event, diffs against previous state
7. New plans create the force graph; state changes update node visuals

## Hook Script

`~/.claude/hooks/plan-update.sh` — fires on every PreToolUse, exits early unless `tool_name` is `TodoWrite`.

## Speak Server Endpoint

`POST /plan` — accepts `{todos: [{content, status, activeForm}]}` JSON, emits raw to frontend via Tauri event system.
