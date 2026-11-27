#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-email-off.png 02-email-on.png 03-email-large-loading.png 04-email-large-ready.png \
  05-email-large-saving.png 06-email-large-rejected.png 07-email-settings-snackbar.png
