#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  15-workflow-editor.png 16-automation-editor.png 17-system-time-picker.png \
  18-workflow-save-conflict.png
