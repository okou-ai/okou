#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  workflow-history-phone-loading.png workflow-history-phone.png \
  workflow-history-phone-large-text.png workflow-history-wide.png workflow-history-wide-empty.png
