#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-initial-unread.png phone-cached-inbox.png phone-retrying-unread.png \
  phone-archived-quiet.png phone-settled-unread.png wide-stale-unread.png
