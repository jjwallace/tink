#!/usr/bin/env bash
# Native — one-command setup
# Checks prerequisites, installs dependencies, downloads voice models.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

MODELS_DIR="${HOME}/Library/Application Support/com.wolfgames.native/models"
TTS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"
ASR_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

# Default voice models (TTS)
TTS_MODELS=(
  "vits-piper-en_GB-vctk-medium"
  "vits-piper-en_US-lessac-high"
  "vits-piper-en_US-ryan-high"
)

# Speech-to-text model (STT)
STT_MODELS=(
  "sherpa-onnx-zipformer-en-2023-06-26"
)

step=0
total=4

progress() {
  step=$((step + 1))
  echo ""
  echo -e "${CYAN}[$step/$total]${NC} ${BOLD}$1${NC}"
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
skip() { echo -e "  ${DIM}· $1 (already installed)${NC}"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${BOLD}Native Setup${NC}"
echo -e "${DIM}Transparent overlay with offline text-to-speech${NC}"

# ── 1. Prerequisites ──────────────────────────────────────────────

progress "Checking prerequisites"

# Xcode Command Line Tools
if xcode-select -p &>/dev/null; then
  skip "Xcode Command Line Tools"
else
  echo -e "  Installing Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo -e "  ${YELLOW}!${NC} Complete the Xcode install dialog, then re-run this script."
  exit 0
fi

# Rust
if command -v rustc &>/dev/null; then
  skip "Rust $(rustc --version | awk '{print $2}')"
else
  echo -e "  Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
  ok "Rust installed"
fi

# Bun
if command -v bun &>/dev/null; then
  skip "Bun $(bun --version)"
else
  echo -e "  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  ok "Bun installed"
fi

# ── 2. Project dependencies ───────────────────────────────────────

progress "Installing project dependencies"

bun install --silent
ok "Node dependencies"

# ── 3. Voice models ───────────────────────────────────────────────

progress "Downloading voice models"

mkdir -p "${MODELS_DIR}"

for model in "${TTS_MODELS[@]}"; do
  if [ -d "${MODELS_DIR}/${model}" ]; then
    skip "${model}"
  else
    echo -e "  Downloading ${model}..."
    curl -L --fail --progress-bar "${TTS_URL}/${model}.tar.bz2" | tar -xjf - -C "${MODELS_DIR}"
    ok "${model}"
  fi
done

for model in "${STT_MODELS[@]}"; do
  if [ -d "${MODELS_DIR}/${model}" ]; then
    skip "${model}"
  else
    echo -e "  Downloading ${model}..."
    curl -L --fail --progress-bar "${ASR_URL}/${model}.tar.bz2" | tar -xjf - -C "${MODELS_DIR}"
    ok "${model}"
  fi
done

# Show sizes
echo ""
echo -e "  ${DIM}Models installed at: ${MODELS_DIR}${NC}"
for model in "${TTS_MODELS[@]}" "${STT_MODELS[@]}"; do
  size=$(du -sh "${MODELS_DIR}/${model}" 2>/dev/null | cut -f1 | xargs)
  echo -e "  ${DIM}  ${model}  ${size}${NC}"
done

# ── 4. Done ───────────────────────────────────────────────────────

progress "Ready"

echo ""
echo -e "  ${GREEN}Run the app:${NC}"
echo -e "    ${BOLD}bun run tauri dev${NC}"
echo ""
echo -e "  ${YELLOW}First launch:${NC} Grant Accessibility permissions when prompted"
echo -e "    System Settings > Privacy & Security > Accessibility > enable Native"
echo ""
echo -e "  ${DIM}First build compiles Rust — takes a few minutes. After that, hot reload is fast.${NC}"
echo ""
