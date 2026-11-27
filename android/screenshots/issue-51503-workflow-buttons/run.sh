#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  original-window-detail.png phone-directory.png phone-detail.png phone-detail-focused.png \
  phone-automations.png phone-editor.png phone-editor-saving.png \
  wide-detail.png wide-editor.png wide-editor-saving.png
