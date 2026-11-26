#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  conversation-model-entry.png conversation-model-picker.png conversation-model-fast-pressed.png \
  conversation-model-saving.png conversation-model-rejected.png send-retrying.png send-rejected.png
