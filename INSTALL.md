# Installing Tink

macOS · Apple Silicon (M1 – M4). Full guide also at **[hellotink.com](https://hellotink.com/)**.

---

### 01 · Download

Grab the latest DMG:

**[github.com/jjwallace/tink/releases/latest](https://github.com/jjwallace/tink/releases/latest)** ↗

### 02 · Install

Open the DMG and drag **Tink** into Applications. Then remove the quarantine
flag — required because Tink isn't from the App Store:

```bash
xattr -cr /Applications/Tink.app
```

### 03 · Grant Accessibility

Launch Tink. It opens System Settings automatically. Find Tink in the list and
toggle it on. Required for the push-to-talk hotkey to work system-wide.

```
System Settings → Privacy & Security → Accessibility
```

### 04 · Wait for models

On first launch Tink downloads three local AI models (~200 MB total):

- **Alba** — Scottish voice (TTS)
- **Moonshine Tiny** — speech recognition (STT)
- **SmolLM2 360M** — narration summarizer

Open Settings from the tray icon to watch progress. Once downloaded, they live
offline in `~/Library/Application Support/com.wolfgames.tink/`.

### 05 · Set your hotkey

Open Settings → Text to Speech → click the hotkey chiclet and press your chosen
key. F-keys and arrow keys work bare; letters/digits need a modifier
(e.g. Cmd+Shift+Space). Hold to speak, release to paste the transcription.

> **Microphone permission:** macOS will prompt the first time you press the push-to-talk key.
