#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-first-read-retrying.png 02-cached-read-retrying.png 03-history-recovered.png \
  04-wide-conversation-progress.png 05-conversation-unavailable.png
