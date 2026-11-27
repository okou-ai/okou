#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  message-search-phone.png message-search-wide.png message-search-image.png message-search-table.png \
  message-target-phone.png message-target-wide.png message-image-wide.png message-table-phone.png \
  message-return-phone.png
