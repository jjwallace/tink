#!/usr/bin/env bash
# Downloads Piper TTS voice models for sherpa-onnx
# Models are stored in ~/Library/Application Support/com.wolfgames.native/models/
set -euo pipefail

MODELS_DIR="${HOME}/Library/Application Support/com.wolfgames.native/models"
BASE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

MODELS=(
  "vits-piper-en_GB-vctk-medium"
  "vits-piper-en_US-lessac-high"
)

mkdir -p "${MODELS_DIR}"

for model in "${MODELS[@]}"; do
  if [ -d "${MODELS_DIR}/${model}" ]; then
    echo "[ok] ${model} already downloaded"
  else
    echo "[dl] Downloading ${model}..."
    curl -L --fail "${BASE_URL}/${model}.tar.bz2" | tar -xjf - -C "${MODELS_DIR}"
    echo "[ok] ${model} ready"
  fi
done

echo ""
echo "Models installed at: ${MODELS_DIR}"
echo "  VCTK (British):    $(du -sh "${MODELS_DIR}/vits-piper-en_GB-vctk-medium" 2>/dev/null | cut -f1)"
echo "  Lessac (American): $(du -sh "${MODELS_DIR}/vits-piper-en_US-lessac-high" 2>/dev/null | cut -f1)"
