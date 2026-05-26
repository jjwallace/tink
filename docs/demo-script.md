# Demo Script — Visualization Feature Showcase

This script demonstrates all overlay features: folder viz, chart column, TTS speech, and plan progress. Each phase is timed to let animations complete before the next step.

## Pre-Flight

1. Restart Native app (`bun run tauri dev`)
2. Ensure Auto-Speak is ON in tray menu
3. Clean slate: delete any leftover test files
4. Display mode: Bubbles

## Phase 1 — Plan Initialization (shows plan gauge)

Emit a plan with 8 tasks. The donut gauge appears at 0%.
Speech: "Starting demo. Eight tasks planned."

## Phase 2 — Create Base Structure (shows folder viz + file bars)

Create `docs/reports/` with 3 files:
- `alpha.md` — "Alpha report: TTS pipeline overview"
- `bravo.md` — "Bravo report: display mode comparison"
- `charlie.md` — "Charlie report: voice model benchmarks"

Trigger viz after each file. File activity bars update (green +3).
Speech announces each file.
Mark task 1 complete → gauge moves to 12%.

## Phase 3 — Create Nested Branches (shows tree drilling down)

Create subfolders with files:
- `docs/reports/delta/` → `delta-one.md`, `delta-two.md`
- `docs/reports/echo/` → `echo-main.md`

Folder viz animates: reports → delta → files appearing.
Then reports → echo → file appearing.
Mark task 2 complete → gauge at 25%.
Speech: "Nested folders created. Delta has two files, Echo has one."

## Phase 4 — Deep Nesting (shows multi-level drill)

Create:
- `docs/reports/echo/foxtrot/` → `foxtrot-one.md`, `foxtrot-two.md`

Viz drills: reports → echo → foxtrot → files flash in.
Mark task 3 complete → gauge at 37%.
Speech: "Deep nesting added. Foxtrot folder inside Echo."

## Phase 5 — Delete Alpha (shows red strikethrough collapse)

Delete `alpha.md`.
Viz shows alpha with red strikethrough, collapses away.
File activity bars: red deleted count goes to 1.
Mark task 4 complete → gauge at 50%.
Speech: "Alpha deleted."

## Phase 6 — Delete Bravo and Charlie (batch delete animation)

Delete `bravo.md` and `charlie.md` together.
Both show red strikethrough, collapse.
Deleted bar jumps to 3.
Mark task 5 complete → gauge at 62%.
Speech: "Bravo and Charlie removed. Three files deleted total."

## Phase 7 — Reorganize (create replacements)

Create new files in delta:
- `delta/summary.md` — "Consolidated summary of all reports"
- `delta/changelog.md` — "Version history and changes"

Viz shows delta folder opening, new files flash green.
Added bar updates.
Mark task 6 complete → gauge at 75%.
Speech: "Reorganized. Summary and changelog added to delta."

## Phase 8 — Final Documentation

Create `docs/reports/README.md` — overview file at the reports root.
Viz shows it appearing at the top level.
Mark task 7 complete → gauge at 87%.
Speech: "README added to reports."

## Phase 9 — Completion

Mark task 8 complete → gauge hits 100%, turns green.
All charts visible for a moment.
Speech: "Demo complete. All eight tasks finished. The plan progress gauge shows one hundred percent."

## Phase 10 — Cleanup Fade

Everything auto-hides. Charts fade out after 5s, viz after 4s.
Final speech: "All visualizations have faded. Demo finished."

---

## Timing Notes

- Each phase waits 5-6 seconds for the previous animations to complete
- Folder viz auto-hides in 4s, so back-to-back phases work cleanly
- Chart column persists as long as events keep firing, hides 5s after last
- Speech sentences take ~2-3s each with lessac-fast voice
- Total demo duration: approximately 90 seconds

## Commands Reference

All triggered via curl to localhost:9876:
- `POST /speak` — narrate text
- `POST /viz` — show folder tree
- Tauri events emitted from Rust for charts
