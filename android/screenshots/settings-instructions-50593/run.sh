#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-cold-loading.png 02-warm-refresh.png 03-edit-after-background-update.png \
  04-discard-confirmation.png 05-latest-after-discard.png 06-saving.png 07-short-window-editor.png \
  08-save-rejected.png 09-checking-saved-version.png
