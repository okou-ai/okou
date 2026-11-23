#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" search-partial-phone.png workflow-cached-phone.png search-partial-wide.png search-recovered-wide.png
