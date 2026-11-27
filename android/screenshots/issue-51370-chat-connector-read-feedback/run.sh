#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" phone-cold-overview.png phone-cold-accounts.png phone-refresh.png wide-cold-overview.png wide-cold-accounts.png wide-refresh.png short-cold-overview.png short-cold-accounts.png short-refresh.png
