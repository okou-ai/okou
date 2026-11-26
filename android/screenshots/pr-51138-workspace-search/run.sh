#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    search-focused-phone.png search-focused-wide.png search-pagination-failed-phone.png \
    search-preview-return-phone.png search-preview-return-wide.png
