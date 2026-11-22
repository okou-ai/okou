#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-settings.png 02-model-accounts.png 03-credit-balance.png 04-account-security.png \
  05-wide-model-accounts.png 06-large-type-model-accounts.png 07-sign-out.png \
  08-settings-lower.png
