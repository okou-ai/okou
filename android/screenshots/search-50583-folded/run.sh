#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  folded-search-phone.png folded-hit-phone.png folded-return-phone.png \
  folded-search-wide.png folded-hit-wide.png
