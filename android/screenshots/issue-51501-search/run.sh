#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" search-recent-phone.png search-grouped-phone.png search-loading-phone.png search-empty-phone.png search-failed-phone.png search-recent-wide.png search-grouped-wide.png search-loading-wide.png search-empty-wide.png search-failed-wide.png
