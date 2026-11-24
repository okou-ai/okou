#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" search-artifact-paging-phone.png search-artifact-settled-phone.png search-artifact-paging-wide.png search-artifact-settled-wide.png
