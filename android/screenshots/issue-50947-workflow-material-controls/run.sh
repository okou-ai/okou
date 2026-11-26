#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-instructions.png phone-tab-hover.png phone-tab-press.png phone-automations.png \
  phone-history-sticky.png phone-instructions-editor.png phone-instructions-error.png \
  wide-history-keyboard.png wide-schedule-editor.png wide-native-time-picker.png \
  narrow-wrapped-validation.png
