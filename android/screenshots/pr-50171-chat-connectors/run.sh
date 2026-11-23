#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-chat-options.png phone-connector-inherited.png phone-connector-override.png \
  phone-exact-account.png phone-directory.png wide-connector-save-failed.png \
  short-connector-picker.png phone-connector-initial-error.png
