# Audio Timeline — What Happens Per Prompt

## Example: "Add accordion sections to the settings panel"
A medium task — ~5 tool calls over ~45 seconds.

### ITERATE Mode (speaks everything)
```
TIME   EVENT              SOUND/SPEECH
─────────────────────────────────────────────────────────────
0s     User hits Enter
0.1s   PreToolUse (Read)  🔊 START CHIME
0.3s   PostToolUse        🗣️ "Reading the settings panel file."
8s     PreToolUse (Edit)  🔔 milestone (quiet bell)
8.3s   PostToolUse        🗣️ "Updated the section header component."
16s    PreToolUse (Edit)  🔔 milestone
16.3s  PostToolUse        🗣️ "Replaced the flat list with accordion wrappers."
24s    PreToolUse (Edit)  🔔 milestone
24.3s  PostToolUse        🗣️ "Added expand and collapse animations."
32s    PreToolUse (Bash)  🔔 milestone
32.3s  PostToolUse        🗣️ "Compilation check passed."
40s    Stop               🗣️ "The settings panel now uses accordion sections. Speech opens by default, everything else collapsed."
42s    Stop (cont.)       🔊 COMPLETE CHIME

Total sounds: 1 start + 4 milestones + 1 complete = 6 sounds
Total speech: 5 tool narrations + 1 final summary = 6 speeches
```

### FOCUS Mode (start + end only, clean)
```
TIME   EVENT              SOUND/SPEECH
─────────────────────────────────────────────────────────────
0s     User hits Enter
0.1s   PreToolUse (Read)  🔊 START CHIME
8s     PreToolUse (Edit)  (silence)
16s    PreToolUse (Edit)  (silence)
24s    PreToolUse (Edit)  (silence)
32s    PreToolUse (Bash)  (silence)
40s    Stop               🗣️ "The settings panel now uses accordion sections."
42s    Stop (cont.)       🔊 COMPLETE CHIME

Total sounds: 1 start + 1 complete = 2 sounds
Total speech: 1 final summary only
```

### MUTED Mode (no speech)
```
TIME   EVENT              SOUND/SPEECH
─────────────────────────────────────────────────────────────
0s     User hits Enter
       (silence throughout)
40s    Stop               🔊 COMPLETE CHIME

Total sounds: 1 complete chime only
Total speech: 0
```

---

## Session Stats (this session, ~4 hours)

| Metric | Count |
|--------|-------|
| Hook fires (Stop) | 123 |
| Speeches delivered | 63 |
| Silent exits (too short, muted, no response) | 18 |
| Speech success rate | 51% of fires → speech |

## Sound Frequency by Mode

| Mode | Sounds per minute (active work) | Speech per minute |
|------|--------------------------------|-------------------|
| Iterate | ~4 (1 start, milestones every 15s) | ~4 (every tool + final) |
| Focus | ~3 (1 start, milestones every 15s) | ~0.5 (final only) |
| Muted | ~0.1 (complete chime only) | 0 |

## Debounce Timers

| Event | Cooldown | Purpose |
|-------|----------|---------|
| Start sound | 60s | One per turn |
| Milestone sound | 15s | Prevent spam from rapid tool calls / agents |
| Tool narration (iterate) | 8s | Prevent speech overlap |
| Turn detection | 60s gap = new turn | Reset start sound |
