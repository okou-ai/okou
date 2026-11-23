#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-discover.png phone-calendar.png phone-missing-icon.png phone-updated-icon.png \
  wide-light.png wide-dark.png wide-connected.png
