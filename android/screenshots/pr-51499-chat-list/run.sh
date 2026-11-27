#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone-stale-refresh.png 02-phone-refresh-complete.png \
  03-wide-inbox-quiet.png 04-wide-unread-refresh.png 05-wide-large-text.png
