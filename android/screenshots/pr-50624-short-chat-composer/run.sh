#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-regular-draft.png 02-short-draft.png 03-text-actions-idle.png \
  04-summary-pressed.png 05-suggestion-pressed.png 06-summary-expanded.png
