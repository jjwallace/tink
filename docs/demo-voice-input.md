# Demo Script — Voice Input (Speech-to-Text)

Showcases the push-to-talk voice input feature: hold Page Up, speak, watch words fly onto screen, release to paste.

## Pre-Flight

1. Restart Native app (`bun run tauri dev`)
2. Ensure STT model is downloaded (tray > Download Voice Models, or `./setup.sh`)
3. Open a text editor (Notes, VS Code, any text field) alongside the overlay
4. Verify mic access: System Settings > Privacy & Security > Microphone > enable Native

## Phase 1 — First Words

Open a blank text file. Click into it so it has focus.

**Hold Page Up**, say: *"Hello world"*

- Waveform indicator appears at top of screen (red pulsing bars)
- After ~600ms, "Hello" flies in from a random edge of the screen
- "world" follows, landing next to it — forming the sentence at top center
- Words flash cyan on landing

**Release Page Up**

- Final transcription pastes into the text field
- Sentence on screen flashes bright, then fades out after 1.5s

Speech: "Voice input captured two words and pasted them into the editor."

## Phase 2 — Longer Dictation

Click into the text field again.

**Hold Page Up**, say: *"The quick brown fox jumps over the lazy dog"*

- Words appear progressively every ~600ms as the recognizer decodes
- Each word flies in from a different random edge (top, right, bottom, left)
- The sentence row at top wraps if it gets wide
- Waveform bars pulse higher on louder syllables

**Release Page Up**

- Full sentence pasted
- Overlay fades

Speech: "Nine words transcribed in real time."

## Phase 3 — Quick Burst

Short utterance to show low-latency response.

**Hold Page Up**, say: *"Yes"*

**Release Page Up** quickly (< 2 seconds total)

- Single word flies in and pastes
- Shows that even very short push-to-talk works

Speech: "Even a single word works."

## Phase 4 — Cancel with Escape

**Hold Page Up**, start speaking: *"This sentence will never..."*

**Press Escape** (while still holding Page Up)

- STT stops immediately
- Words on screen fade out
- Nothing is pasted

Speech: "Escape cancels voice input. Nothing was pasted."

## Phase 5 — Back-to-Back

Demonstrate rapid consecutive inputs.

**Hold Page Up**, say: *"First sentence"*, **release**
Wait 2 seconds.
**Hold Page Up**, say: *"Second sentence"*, **release**

- Each input cycle is independent
- First result pastes, then second result pastes on the next line
- No state bleeds between sessions

Speech: "Back-to-back voice inputs work cleanly."

## Phase 6 — With TTS (Full Loop)

Show voice input and voice output working together.

1. **Hold Page Up**, say: *"Read this back to me"*, **release** — text pastes
2. Select the pasted text
3. **Press Page Down** — TTS reads it aloud with bubble display

Speech: "Full loop: spoke it in, pasted it, then had it read back. Voice in, voice out."

---

## Timing Notes

- Partial results appear every ~600ms (decode interval)
- Longer utterances take proportionally longer to decode on each cycle
- Sweet spot is 3-15 seconds of speech per push-to-talk
- Very long recordings (>30s) will have increasing decode latency
- Total demo duration: approximately 60 seconds

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "STT model not downloaded" | Run `./setup.sh` or tray > Download Voice Models |
| No mic input | System Settings > Privacy & Security > Microphone > enable Native |
| Words don't appear | Check console for decode errors; ensure offline model is installed |
| Nothing pastes | Ensure a text field has focus before releasing Page Up |
| Escape doesn't cancel | Grant Accessibility permissions for the global event tap |
