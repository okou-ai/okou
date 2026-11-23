#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  01-cold-credit.png 02-stale-accounts.png 03-stale-credit.png \
  04-fresh-credit.png 05-credit-refresh-failed.png 06-cold-credit-error.png
