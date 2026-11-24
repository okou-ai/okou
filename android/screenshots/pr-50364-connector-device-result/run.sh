#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-device-code.png phone-connector-device-expired.png \
  wide-connector-device-waiting.png wide-connector-device-denied.png
