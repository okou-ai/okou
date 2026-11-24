#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-more.png phone-update-more.png phone-name.png wide-creating.png wide-created.png short-name.png
