#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  instructions-editor.png saving-editor.png failed-save-editor.png wide-automation-editor.png \
  saving-automation-editor.png \
  short-editor-fields.png short-editor-actions.png short-editor-feedback.png ime-editor.png
