#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-settings-account.png 02-email-loading.png 03-email-confirmed.png \
  04-email-stale-refresh.png 05-email-write-rejected.png 06-email-unavailable.png \
  07-model-account-write-rejected.png
