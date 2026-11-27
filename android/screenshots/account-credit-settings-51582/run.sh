#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
    01-model-accounts.png \
    02-model-account-switch-failed.png \
    03-model-accounts-empty.png \
    04-credit-balance.png
