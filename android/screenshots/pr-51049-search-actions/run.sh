#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-empty-phone.png search-results-phone.png search-workflow-intro-phone.png \
  search-workflow-opening-phone.png search-workflow-failure-phone.png \
  search-results-wide.png search-workflow-intro-wide.png search-workflow-short-200-percent.png
