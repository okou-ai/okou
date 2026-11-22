#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone-menu.png 02-phone-results-with-keyboard.png 03-phone-folded-hit.png \
  04-phone-browse-turns.png 05-wide-results.png 06-wide-reopened-chat.png
