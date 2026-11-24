#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-connector-directory-return.png wide-connector-selected-while-filtering.png \
  wide-connector-details.png phone-connector-account-return.png \
  wide-connector-keyboard-selection.png
