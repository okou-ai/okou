#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-reading-phone.png search-grouped-phone.png \
  search-reading-wide.png search-grouped-wide.png
