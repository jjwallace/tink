# PixiJS Force Graph

The plan visualizer renders a force-directed graph using PixiJS v8 on the shared WebGL canvas.

## Physics Model

- **Springs**: K=0.003, natural length 130px between connected nodes
- **Repulsion**: 5000 force constant between all node pairs
- **Gravity**: 0.001 pull toward center point (50% x, 75% y)
- **Damping**: 0.92 per tick — velocities decay to settle the layout
- **Max velocity**: 8px/tick cap prevents flyaways

## Rendering

Each node is a Container with:
- `glow` Graphics — soft outer halo (pending=dim, active=gold, complete=green)
- `circle` Graphics — main node body (stroke or fill depending on state)
- `pulse` Graphics — expanding ring for active state, redrawn each frame
- `check` Graphics — checkmark path, hidden until completed
- `text` Text — label below the node with drop shadow

Edges are drawn in a shared Graphics object, redrawn every frame from the physics positions. Resolved edges (source completed, target active/completed) glow green.

## Shadow

A localized dark radial fill tracks the bounding box of visible nodes, providing contrast without darkening the full screen.
