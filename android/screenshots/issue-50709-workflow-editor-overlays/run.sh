#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-frequency-menu.png phone-event-source-menu.png phone-automation-discard.png \
  wide-instructions-source.png wide-instructions-discard.png
