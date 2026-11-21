#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-settings.png 02-display-mode.png 03-color-theme.png 04-language.png \
  05-workspace.png 06-instructions.png 07-sign-out.png 08-update.png \
  09-update-progress.png 10-wide-palette.png 11-large-type-palette.png
