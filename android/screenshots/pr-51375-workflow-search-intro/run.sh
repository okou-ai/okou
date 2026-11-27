#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflow-search-phone.png workflow-intro-phone.png workflow-return-phone.png \
  workflow-search-wide.png workflow-intro-wide.png workflow-return-wide.png
