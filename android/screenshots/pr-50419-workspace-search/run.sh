#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-recent-phone.png search-grouped-phone.png search-artifacts-phone.png search-empty-phone.png \
  search-grouped-wide.png search-artifacts-wide.png search-loading-phone.png search-loading-wide.png \
  search-partial-phone.png
