#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  restoring-brand.png sign-in.png preparing.png preparing-reduced-motion.png choose-workspace.png no-workspace.png \
  access-removed.png checking.png browser-unavailable.png check-failed.png selection-failed.png unavailable.png \
  sign-out-after-check-failure.png sign-out-confirmation.png signing-out.png compact-dark-top.png compact-dark.png \
  workspace-picker-keyboard.png setup-keyboard.png check-keyboard-pending.png check-keyboard-failed.png access-keyboard-pending.png \
  sign-out-cancel-focused.png sign-out-confirm-focused.png wide-sign-in.png wide-workspace-picker.png compact-clerk.png \
  required-update.png compact-required-update.png \
  phone-before-ime.png phone-ime-open.png phone-after-ime.png \
  wide-before-ime.png wide-ime-open.png wide-after-ime.png
