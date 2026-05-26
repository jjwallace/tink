# Text-to-Speech Overview

Native uses sherpa-onnx with Piper VITS models to provide offline text-to-speech.

## How It Works

1. User selects text in any application
2. Presses PageDown (configurable hotkey) or middle-clicks
3. Native captures the selection by simulating Cmd+C
4. Text is stripped of markdown syntax and split into sentences
5. Each sentence is fed to sherpa-onnx which generates audio samples
6. Audio plays via rodio while word timings are estimated and sent to the frontend
7. The frontend renders the text with word-by-word highlighting

## Voice Models

Two Piper voices are available, selectable from the tray menu:

- **Lessac (American)** — en_US-lessac-low, fast generation, good quality
- **VCTK (British)** — en_GB-vctk-medium, multi-speaker British English

Models are downloaded on first use (~15-75MB each) and stored in the app data directory.

## Sentence Pipeline

Text is processed sentence-by-sentence rather than all at once. This means:

- The first sentence starts playing quickly while later sentences generate in the background
- Each sentence emits a `tts-sentence` event with word timings
- A 300ms pause is inserted between sentences for natural pacing
- The cancel flag is checked between sentences so Escape stops immediately
