#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-phone-preview.png 02-phone-full-code.png \
  03-wide-code-pane.png 04-short-large-text-code.png
