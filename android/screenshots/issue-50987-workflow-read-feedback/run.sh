#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-catalog-failure-light.png phone-history-failure-light.png \
  phone-detail-failure-dark.png wide-cached-detail-dark.png compact-catalog-failure-light.png
