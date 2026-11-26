#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  search-waiting-for-chat-phone.png search-message-result-phone.png \
  search-waiting-for-chat-wide.png search-message-result-wide.png \
  search-partial-failure-phone.png search-partial-failure-wide.png \
  search-unavailable-phone.png search-unavailable-wide.png \
  search-unavailable-short-200-percent.png search-empty-phone.png
