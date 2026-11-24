#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" catalog-phone.png empty-search-phone.png empty-filter-phone.png filter-focus-wide.png selected-preview-wide.png
