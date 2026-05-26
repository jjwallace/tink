# Claude Code Auto-Speak Hook

Native can automatically speak Claude Code's responses using the hooks system.

## How It Works

1. Claude Code fires a `Stop` hook after each assistant response
2. The hook script at `~/.claude/hooks/speak-response.sh` runs
3. It reads the transcript file to extract the last assistant message
4. If an Anthropic API key is available, it sends the text to Haiku for a 1-2 sentence summary
5. If no API key, it falls back to extracting the first 2 sentences
6. The summary is POSTed to `http://127.0.0.1:9876/speak`
7. Native's TTS server receives it and speaks it aloud

## Configuration

### Enable Auto-Speak
Toggle from the tray menu: **Auto-Speak (Claude)**

### API Key for Summarization
Store your Anthropic API key in `~/.claude/hooks/.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```

Without the key, responses are spoken verbatim (first 2 sentences).

### Hook Registration
The hook is configured in `~/.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "~/.claude/hooks/speak-response.sh",
        "timeout": 10
      }]
    }]
  }
}
```

## HTTP Server API

- `POST /speak` — Send text to be spoken (plain text body)
- `GET /status` — Returns `{"auto_speak": true/false}`

The server runs on `127.0.0.1:9876` and only accepts connections from localhost.
