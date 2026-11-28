#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-partial-phone.png search-unavailable-phone.png search-empty-phone.png \
  search-loading-wide.png search-partial-wide.png search-unavailable-wide.png \
  search-unavailable-short-200-percent.png
