#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-keyboard-phone.png workflow-intro-phone.png workflow-reset-phone.png \
  search-keyboard-wide.png workflow-intro-wide.png workflow-reset-wide.png
