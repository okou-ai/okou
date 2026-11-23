#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-editor-blocked.png phone-gmail.png phone-editor-recovered.png \
  wide-calendar.png wide-editor-canceled.png
