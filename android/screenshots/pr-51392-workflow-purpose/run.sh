#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workspace-search-phone.png workspace-search-wide.png \
  workflow-purpose-phone.png workflow-purpose-wide.png
