# HTTP Speak Server

Native runs a minimal HTTP server on localhost:9876 that accepts text for TTS playback from external tools.

## Endpoints

### POST /speak
Send plain text to be spoken aloud.

```bash
curl -X POST http://127.0.0.1:9876/speak -d "Hello world"
```

Returns `{"status":"ok"}` if accepted, `{"status":"disabled"}` if auto-speak is off.

### GET /status
Check if auto-speak is enabled.

```bash
curl http://127.0.0.1:9876/status
```

Returns `{"auto_speak": true}` or `{"auto_speak": false}`.

### POST /viz
Trigger a D3 folder visualization for a given path.

```bash
curl -X POST http://127.0.0.1:9876/viz -d "/path/to/folder"
```

## Implementation

The server is a raw TCP listener using `std::net::TcpListener` — no external HTTP crate needed. It parses HTTP requests manually, reads Content-Length headers, and routes to the appropriate handler.

Each `/speak` request spawns a new thread that runs the full TTS pipeline (markdown strip, sentence split, generate, play). The server thread itself never blocks on TTS.

## Security

- Binds to `127.0.0.1` only (localhost, not network-accessible)
- No authentication (trusted local environment)
- CORS headers included for browser-based tools
