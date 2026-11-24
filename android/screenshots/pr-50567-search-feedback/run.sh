#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-waiting-phone.png \
  search-partial-loading-wide.png \
  search-local-empty-phone.png search-local-empty-wide.png \
  search-local-matches-phone.png search-local-matches-wide.png \
  search-partial-phone.png search-partial-wide.png
