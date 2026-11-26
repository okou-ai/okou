#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-directory.png phone-detail.png wide-automation-editor-dark.png \
  wide-frequency-menu-dark.png compact-automations.png
