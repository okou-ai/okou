#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-before-ime.png phone-ime-open.png phone-after-ime.png \
  wide-before-ime.png wide-ime-open.png wide-after-ime.png
