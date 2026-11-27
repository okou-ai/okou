#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-rename.png phone-connector-rename-restored.png wide-connector-rename.png \
  wide-connector-account-confirmed.png short-connector-rename-validation.png
