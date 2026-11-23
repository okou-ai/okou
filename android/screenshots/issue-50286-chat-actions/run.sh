#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    00-stop-inline.png 01-stop-pending.png 02-stop-background-retry.png 03-stop-failure-snackbar.png \
    04-stop-confirmed.png 05-withdraw-hidden.png 06-withdraw-restored.png \
    07-skip-hidden.png 08-short-toolbar-stop.png 09-short-stop-hidden.png 10-history-loading.png
