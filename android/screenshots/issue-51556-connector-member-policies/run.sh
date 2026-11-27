#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" \
  phone-member-policy-menu.png phone-member-policy-confirmed.png \
  wide-member-policy-reused.png short-member-policy-expired.png
