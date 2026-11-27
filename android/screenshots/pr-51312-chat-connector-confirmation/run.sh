#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-overview.png phone-connector-replacement.png \
  wide-connector-overview.png wide-connector-replacement.png \
  short-connector-overview.png short-connector-replacement.png
