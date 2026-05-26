# D3 Folder Visualization

Native renders interactive folder tree visualizations as an overlay using D3.js.

## Features

- **D3 tidy tree layout** showing the file hierarchy
- **Git status coloring**: green (added/new), amber (modified), red (deleted), dim (clean)
- **Multi-corner placement**: up to 4 viz cards on screen simultaneously, each in a different corner
- **Auto-trigger**: a file watcher polls `git status` every 3 seconds and pops a viz when changes are detected
- **Speech narration**: each viz speaks a summary like "3 new files, 2 modified"
- **GSAP animations**: cards fly from center to their corner, fade out after 10 seconds

## How It Renders

1. Rust `scan_folder` command walks the directory tree (max depth configurable)
2. Skips hidden dirs, node_modules, target, dist
3. Cross-references each file against `git status --porcelain`
4. Returns a `FolderSummary` with the tree and change counts
5. Frontend builds a D3 hierarchy and renders with staggered node entrance animations
6. Stats bar shows colored change counts
7. Card flies to an available corner via GSAP

## File Watcher

The Rust file watcher runs on a background thread:

- Polls `git status --porcelain -u` every 3 seconds
- Compares current status set against previous
- On change, emits `folder-viz-show` event with a speech description
- Only active when Auto-Speak is toggled on in the tray menu
- Describes changes naturally: "Changed: lib.rs, tts.rs" or "5 files changed"

## Triggering Manually

Click tray menu > **Show Folder Tree** to visualize the current working directory on demand.
