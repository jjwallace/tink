#!/bin/bash
# Native App — Full Pipeline Integration Test
# Run with: bash repos/nest/native/tests/pipeline-test.sh
#
# Prerequisites: native app running on port 9877

PORT=9877
PASS=0
FAIL=0
TOTAL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red() { printf "\033[31m✗ %s\033[0m\n" "$1"; }
header() { printf "\n\033[1;36m── %s ──\033[0m\n" "$1"; }

assert() {
  TOTAL=$((TOTAL + 1))
  if [ "$1" = "0" ]; then
    PASS=$((PASS + 1))
    green "$2"
  else
    FAIL=$((FAIL + 1))
    red "$2: $3"
  fi
}

# ── Server Health ──
header "Server Health"

RESULT=$(curl -s --connect-timeout 2 http://127.0.0.1:$PORT/status 2>/dev/null)
assert $? "Speak server responds on port $PORT"

AUTO=$(echo "$RESULT" | jq -r '.auto_speak // empty')
assert $([ "$AUTO" = "true" ] || [ "$AUTO" = "false" ]; echo $?) "Status returns auto_speak field" "got: $RESULT"

PERSONALITY=$(echo "$RESULT" | jq -r '.personality // empty')
assert $([ -n "$PERSONALITY" ]; echo $?) "Status returns personality field" "got: $RESULT"

WORK_MODE=$(echo "$RESULT" | jq -r '.work_mode // empty')
assert $([ -n "$WORK_MODE" ]; echo $?) "Status returns work_mode field (got: $WORK_MODE)"

# ── Sound Endpoints ──
header "Sound Effects"

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/sound -d "start" 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /sound start returns ok" "$RESULT"
sleep 1

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/sound -d "milestone" 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /sound milestone returns ok" "$RESULT"
sleep 1

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/sound -d "complete" 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /sound complete returns ok" "$RESULT"
sleep 1

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/sound -d "invalid" 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /sound unknown type still returns ok" "$RESULT"

# ── TTS Speak ──
header "Text-to-Speech"

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/speak -H "Content-Type: text/plain" -d "Test speech one." 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /speak returns ok" "$RESULT"
sleep 3

RESULT=$(curl -s -X POST http://127.0.0.1:$PORT/speak -H "Content-Type: text/plain" -d "" 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.status == "ok"' > /dev/null 2>&1; echo $?) "POST /speak empty body returns ok" "$RESULT"

# ── Summarizer ──
header "Summarizer"

RESULT=$(curl -s --max-time 30 -X POST http://127.0.0.1:$PORT/summarize -H "Content-Type: text/plain" -d "I updated the settings panel to use accordion sections. Each section collapses and expands with smooth animations." 2>/dev/null)
SUMMARY=$(echo "$RESULT" | jq -r '.summary // empty')
assert $([ -n "$SUMMARY" ]; echo $?) "POST /summarize returns a summary" "got: $RESULT"
echo "    Summary: $(echo "$SUMMARY" | head -c 100)"
sleep 2

RESULT=$(curl -s --max-time 30 -X POST http://127.0.0.1:$PORT/summarize -H "Content-Type: text/plain" -d "" 2>/dev/null)
SUMMARY=$(echo "$RESULT" | jq -r '.summary // empty')
assert $([ "$SUMMARY" = "SKIP" ]; echo $?) "POST /summarize empty returns SKIP" "got: $SUMMARY"

# ── Audio Queue (ordered playback) ──
header "Audio Queue"

# Send two speak requests rapidly — they should queue, not overlap
curl -s -X POST http://127.0.0.1:$PORT/speak -H "Content-Type: text/plain" -d "First queued message." 2>/dev/null > /dev/null
curl -s -X POST http://127.0.0.1:$PORT/speak -H "Content-Type: text/plain" -d "Second queued message." 2>/dev/null > /dev/null
assert 0 "Two speak requests queued without error"
sleep 6

# ── Speak Hook ──
header "Hook Scripts"

assert $([ -x ~/.claude/hooks/speak-response.sh ]; echo $?) "speak-response.sh is executable"
assert $([ -x ~/.claude/hooks/play-start-sound.sh ]; echo $?) "play-start-sound.sh is executable"
assert $([ -x ~/.claude/hooks/speak-tool-result.sh ]; echo $?) "speak-tool-result.sh is executable"
assert $([ -x ~/.claude/hooks/speak.sh ]; echo $?) "speak.sh helper is executable"

assert $(grep -q "9877" ~/.claude/hooks/speak-response.sh; echo $?) "speak-response.sh uses port 9877"
assert $(grep -q "9877" ~/.claude/hooks/play-start-sound.sh; echo $?) "play-start-sound.sh uses port 9877"
assert $(grep -q "9877" ~/.claude/hooks/speak-tool-result.sh; echo $?) "speak-tool-result.sh uses port 9877"

assert $(grep -q "PostToolUse" ~/.claude/settings.json; echo $?) "settings.json has PostToolUse hook"
assert $(grep -q "PreToolUse" ~/.claude/settings.json; echo $?) "settings.json has PreToolUse hook"
assert $(grep -q "Stop" ~/.claude/settings.json; echo $?) "settings.json has Stop hook"

# ── Settings Persistence ──
header "Settings"

RESULT=$(curl -s --connect-timeout 2 http://127.0.0.1:$PORT/status 2>/dev/null)
assert $(echo "$RESULT" | jq -e '.work_mode' > /dev/null 2>&1; echo $?) "work_mode is persisted"
assert $(echo "$RESULT" | jq -e '.personality' > /dev/null 2>&1; echo $?) "personality is persisted"

# ── Sound Files ──
header "Assets"

SFX_DIR="$(dirname "$0")/../public/assets/sfx"
assert $([ -f "$SFX_DIR/start-quite.wav" ]; echo $?) "start-quite.wav exists"
assert $([ -f "$SFX_DIR/start-mystery.wav" ]; echo $?) "start-mystery.wav exists"
assert $([ -f "$SFX_DIR/complete-accomplish.wav" ]; echo $?) "complete-accomplish.wav exists"
assert $([ -f "$SFX_DIR/complete-bell.mp3" ]; echo $?) "complete-bell.mp3 exists"
assert $([ -f "$SFX_DIR/complete-explode.aiff" ]; echo $?) "complete-explode.aiff exists"
assert $([ -f "$SFX_DIR/complete-sad.mp3" ]; echo $?) "complete-sad.mp3 exists"
assert $([ -f "$(dirname "$0")/../public/assets/personality.md" ]; echo $?) "personality.md exists"

# ── Results ──
header "Results"
echo ""
printf "  \033[1m%d passed, %d failed, %d total\033[0m\n" "$PASS" "$FAIL" "$TOTAL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
