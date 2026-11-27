#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-check.png phone-connector-checking.png phone-connector-unavailable.png \
  wide-connector-check.png wide-connector-checking.png wide-connector-unavailable.png \
  short-connector-check.png short-connector-checking.png short-connector-unavailable.png
