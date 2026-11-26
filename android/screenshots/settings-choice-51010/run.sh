#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-language-selected.png 02-timezone-selected.png 03-palette-two-columns.png \
  04-palette-large-text.png 05-display-mode.png 06-image-model.png
