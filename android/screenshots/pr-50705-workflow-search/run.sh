#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflow-search-refresh-phone.png workflow-search-skeleton-phone.png \
  workflow-search-empty-phone.png workflow-search-fallback-phone.png \
  workflow-search-refresh-wide.png workflow-search-skeleton-wide.png \
  workflow-search-empty-wide.png workflow-search-fallback-wide.png
