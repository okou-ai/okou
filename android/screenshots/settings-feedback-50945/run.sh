#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-model-quotas.png 02-credit-refresh-failed.png 03-email-idle.png \
  04-email-pressed.png 05-email-updating.png 06-email-rejected-inline.png \
  07-email-rejected-settings.png
